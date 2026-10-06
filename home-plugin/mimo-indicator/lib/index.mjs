// mimo-indicator — host half.
//
// 收集各会话 mimo-first-bridge 插件（preset 或动态形态）推送的 mimo 运行快照，
// 维护一张按项目（工作目录 cwd）索引的全局表，并通过 webServer 注册
// GET /mimo-indicator/status 路由暴露给浏览器。
//
// 两个数据入口：
//   1. preset 形态（真 Node 模块）：apply 时 ctx.emit('mimo/mode', { active: true })
//      宣告 mimo 优先模式；每次状态变化 ctx.emit('mimo/status', { snapshot })。
//   2. 动态形态（沙箱无 ctx.emit）：通过 ctx.provide 的 mimoCollector 服务
//      调用 mergeSnapshot(snapshot) 推入。
//   3. MCP 子进程：写 <dsh-home>/plugins/mimo-indicator/mcp-live.json，本路由读盘合并。
//
// 路由返回 JSON：{ state, running, projects[], presetActive, lastModeAt }。

import { existsSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const name = 'mimo-indicator'
export const inject = []

function detectDshHome() {
  if (process.env.DSH_HOME) return process.env.DSH_HOME
  if (process.env.APPDATA) return join(process.env.APPDATA, 'DSH Desktop', 'dsh-home')
  if (process.env.HOME) return join(process.env.HOME, '.dsh')
  return join(process.cwd(), '.dsh')
}

const DSH_HOME = detectDshHome()
const MCP_LIVE_FILE = process.env.MIMO_MCP_LIVE_FILE
  || join(DSH_HOME, 'plugins', 'mimo-indicator', 'mcp-live.json')

const MAX_PROJECTS = 24
const MODE_TTL_MS = 75 * 1000
// 「陈旧记录」阈值：非 running 且超过此时长没有更新的项目，视为历史残留。
// 没有这道闸门时，一次早于 41 小时前的 MCP 派发会永久留在表里，令灯常亮不灭
// （实测症状：状态灯长时间不消失）。仅用于快照标注与可见性判定，不从表里删除，
// 详情面板仍可回看轨迹。
const PROJECT_TTL_MS = 10 * 60 * 1000
// mcp-live.json 整体陈旧阈值：文件由 MCP 子进程每次调用时重写，若 writtenAt 已经
// 过于久远，说明写入方早已退出，整份快照都不该再影响灯的颜色。
const MCP_LIVE_TTL_MS = 10 * 60 * 1000

// 与 core/mimo-core.mjs 的 SUCCESS_STATUSES 保持一致（本文件是自包含 host 半，
// 不 import core）。mimo-desktop 异步受理后回报 ACCEPTED（HTTP 202）——那是成功，
// 灯不能把健康派发画成红色。
const SUCCESS_STATUSES = ['SUCCESS', 'ACCEPTED']
function isSuccessStatus(status) {
  return !!status && SUCCESS_STATUSES.indexOf(String(status)) >= 0
}

export function apply(ctx) {
  const projects = Object.create(null)
  let lastModeAt = 0
  // 单调序号：墙钟毫秒会撞车，顶层聚合「谁最近」需要确定顺序
  let seqCounter = 0

  function ensure(cwd) {
    const key = String(cwd || '')
    let p = projects[key]
    if (!p) {
      const keys = Object.keys(projects)
      if (keys.length >= MAX_PROJECTS) {
        // 淘汰逻辑：宁可暂时超出上限，也绝不淘汰正在 running 的项目
        const idle = keys.filter((k) => !projects[k].running)
        if (idle.length) {
          const victim = idle.sort((a, b) => (projects[a].updatedAt || 0) - (projects[b].updatedAt || 0))[0]
          delete projects[victim]
        }
      }
      p = { cwd: key, name: '', state: 'idle', running: 0, current: null, trail: [], lastStatus: null, lastAt: 0, lastSessionId: null, fallbackActive: false, runs: 0, totalTokens: 0, updatedAt: 0, seq: ++seqCounter }
      projects[key] = p
    }
    return p
  }

  function mergeSnapshot(snap) {
    if (!snap) return
    const list = Array.isArray(snap.projects) ? snap.projects : (snap.cwd ? [snap] : [])
    for (const src of list) {
      if (!src || !src.cwd) continue
      const p = ensure(src.cwd)
      const srcAt = Number(src.updatedAt) || 0
      if (src.name) p.name = src.name
      if (typeof src.running === 'number') p.running = src.running
      if (src.current !== undefined) p.current = src.current
      if (Array.isArray(src.trail)) p.trail = src.trail.slice(-12)
      if (src.lastStatus) p.lastStatus = src.lastStatus
      if (src.lastAt) p.lastAt = Number(src.lastAt) || p.lastAt
      if (src.lastSessionId) p.lastSessionId = src.lastSessionId
      if (src.fallbackActive !== undefined) p.fallbackActive = !!src.fallbackActive
      if (typeof src.runs === 'number') p.runs = src.runs
      if (typeof src.totalTokens === 'number') p.totalTokens = src.totalTokens
      // `state` 是派生字段（可被 lastStatus/running/fallbackActive 重算）。对
      // 外部（MCP 子进程）快照只接受它作为「运行中」提示，其余一律本地重算，
      // 避免陈旧/不一致的 state 把灯画成错误颜色（ACCEPTED 被写成 failed 的坑）。
      if (src.state === 'running') p.state = 'running'
      else if (!p.running) p.state = isSuccessStatus(p.lastStatus) ? 'ok' : (p.fallbackActive ? 'fallback' : (p.lastStatus ? 'failed' : 'idle'))
      p.seq = ++seqCounter
      if (srcAt) p.updatedAt = srcAt
      else p.updatedAt = Date.now()
    }
  }

  function readMcpLive() {
    try {
      if (!existsSync(MCP_LIVE_FILE)) return
      const raw = readFileSync(MCP_LIVE_FILE, 'utf8')
      const data = JSON.parse(raw)
      // 整份文件陈旧（写入方早已退出）→ 不再并入。否则一次几十小时前的派发会
      // 永久把灯点亮（「状态灯长时间不消失」的直接来源）。
      const writtenAt = Number(data && data.writtenAt) || 0
      if (writtenAt && (Date.now() - writtenAt) > MCP_LIVE_TTL_MS) return
      if (data && Array.isArray(data.projects)) mergeSnapshot({ projects: data.projects })
    } catch (e) { /* ignore */ }
  }

  function snapshot() {
    readMcpLive()
    const list = Object.keys(projects).map((k) => projects[k]).sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))
    let running = 0, fallbackActive = false, lastStatus = null, lastAt = 0, lastSessionId = null
    for (const p of list) { running += p.running || 0 }
    // 顶层聚合只认同「最近一次活动」的那个项目 —— 不能用 OR 把任意历史项目的
    // fallbackActive 抬上来。否则一个早已回退的陈旧项目会永久把整盏灯涂成琥珀，
    // 即使当前项目刚刚成功（state=ok）也永远看不到绿色。
    // 排序必须确定：同一毫秒内两个项目都可能写入，故 updatedAt 为主键、
    // lastAt 为次键、cwd 为最终稳定 tie-break。
    let top = null
    for (const p of list) {
      if (!top) { top = p; continue }
      const sa = p.seq || 0, sb = top.seq || 0
      if (sa !== sb) { if (sa > sb) top = p; continue }
      const pa = p.updatedAt || 0, pb = top.updatedAt || 0
      if (pa !== pb) { if (pa > pb) top = p; continue }
      if (String(p.cwd) > String(top.cwd)) top = p
    }
    if (top) {
      lastAt = top.lastAt || 0
      lastStatus = top.lastStatus
      lastSessionId = top.lastSessionId
      fallbackActive = !!top.fallbackActive
    }
    const presetActive = (Date.now() - lastModeAt) < MODE_TTL_MS
    const state = running > 0 ? 'running' : (lastStatus ? (isSuccessStatus(lastStatus) ? 'ok' : (fallbackActive ? 'fallback' : 'failed')) : (fallbackActive ? 'fallback' : 'idle'))
    // 陈旧标记：非 running 且久未更新 → 客户端据此不再单独点亮状态灯。
    const nowMs = Date.now()
    const isStale = (p) => {
      if (p.running > 0) return false
      const at = Number(p.updatedAt) || Number(p.lastAt) || 0
      return !!at && (nowMs - at) > PROJECT_TTL_MS
    }
    return {
      state,
      running,
      lastStatus,
      lastAt,
      lastSessionId,
      fallbackActive,
      presetActive,
      lastModeAt,
      projects: list.map((p) => ({
        cwd: p.cwd,
        name: p.name || p.cwd.split(/[\\/]/).filter(Boolean).pop() || p.cwd,
        state: p.state,
        running: p.running,
        current: p.current,
        trail: p.trail,
        lastStatus: p.lastStatus,
        lastAt: p.lastAt,
        lastSessionId: p.lastSessionId,
        fallbackActive: p.fallbackActive,
        runs: p.runs,
        totalTokens: p.totalTokens,
        updatedAt: p.updatedAt,
        stale: isStale(p)
      }))
    }
  }

  // Event bus channel (preset form).
  try {
    ctx.on('mimo/status', (payload) => {
      if (payload && payload.snapshot) mergeSnapshot(payload.snapshot)
    })
  } catch (e) {}
  try {
    ctx.on('mimo/mode', () => { lastModeAt = Date.now() })
  } catch (e) {}

  // Service channel (dynamic sandbox form).
  try {
    ctx.provide('mimoCollector', {
      mergeSnapshot(snap) { mergeSnapshot(snap) },
      markMode() { lastModeAt = Date.now() }
    })
  } catch (e) { /* already registered in another realm — ignore */ }

  // HTTP route for the browser light.
  if (typeof ctx.inject === 'function') {
    ctx.inject(['webServer'], (webCtx) => {
      const ws = webCtx.get('webServer')
      if (!ws || typeof ws.register !== 'function') return
      webCtx.effect(() => ws.register({
        kind: 'exact',
        path: '/mimo-indicator/status',
        handler: async (req, res) => {
          try {
            const body = JSON.stringify(snapshot())
            res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
            res.end(body)
          } catch (e) {
            res.writeHead(500, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ ok: false, error: String(e && e.message || e) }))
          }
        }
      }), 'mimo-indicator: status route')
    })
  }

  // Optional: ensure plugins dir exists for MCP live file.
  try {
    const dir = dirname(MCP_LIVE_FILE)
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  } catch (e) {}
}
