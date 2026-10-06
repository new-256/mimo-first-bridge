#!/usr/bin/env node
// mimo-mcp-server — expose the local `mimo` CLI as MCP tools (stdio transport).
//
// Any MCP-capable host (Claude Code / Codex / Cherry Studio / any MCP client)
// can add this server; the agent then DISCOVERS the mimo tools itself and
// decides when to call them — even when the host is NOT running an
// "mimo-first" preset.
//
// Zero npm dependencies: implements the MCP stdio JSON-RPC surface directly
// (initialize, tools/list, tools/call, notifications). Protocol version
// negotiated with the client; tools mirror the DSH plugin:
//   - mimo_run       dispatch a task to the local mimo CLI
//   - mimo_continue  continue an existing mimo session
//   - mimo_status    live snapshot of what mimo is CURRENTLY doing
//
// DSH-style full control is kept: every invocation is non-interactive
// (--dangerously-skip-permissions), so mimo never prompts.
//
// Usage:
//   node mimo-mcp-server.mjs                # stdio MCP server
//   node mimo-mcp-server.mjs --check        # self-test (no MCP): lists tools, exits

import { spawn } from 'node:child_process'
import { dirname, join as joinPath } from 'node:path'
import { fileURLToPath } from 'node:url'
import { existsSync, writeFileSync, mkdirSync } from 'node:fs'

import {
  buildArgv,
  buildResult,
  parseMimoJson,
  createLineStream,
  createStatusEngine,
  isLimited,
  fallbackResult,
  shortLabel,
  desktopResult,
  BACKENDS,
  DEFAULT_BACKEND,
  BACKEND_DESKTOP,
  newDesktopSessionId,
  DEFAULT_TIMEOUT_SEC,
  HARD_TIMEOUT_GRACE_SEC
} from '../core/mimo-core.mjs'
import {
  loadRuntime,
  desktopHealth,
  desktopSendTurn,
  desktopReadEvents,
  loadSettingsFile,
  saveSettingsFile
} from '../core/runtime-settings.mjs'

const NAME = 'mimo-mcp-server'
const VERSION = '1.2.9'
const PROTOCOL = '2024-11-05'

// Home-light bridge: write mcp-live.json for the home indicator (no ctx).
//
// 【回归护栏】live 文件的定位必须与安装布局无关（姊妹包 agy-first-bridge v1.6.2
// 同款事故）：制品安装下本文件位于
//   <profile>/node_modules/mimo-first-bridge/mcp/mimo-mcp-server.mjs
// 用 import.meta.url 上溯两级会落到 <profile>/node_modules/plugins/... ——
// 而家级灯读的是 <DSH_HOME>/plugins/mimo-indicator/mcp-live.json，症状是
// 「MCP 写盘正常、灯恒 idle」。故按 DSH_HOME / APPDATA / HOME 分层锚定；
// MIMO_MCP_LIVE_FILE 显式覆盖仍最优先，旧的包内相对路径只作自定义布局末位兜底。
function resolveMcpLiveFile() {
  const rel = ['plugins', 'mimo-indicator', 'mcp-live.json']
  if (process.env.MIMO_MCP_LIVE_FILE) return process.env.MIMO_MCP_LIVE_FILE
  const anchored = []
  if (process.env.DSH_HOME) anchored.push(joinPath(process.env.DSH_HOME, ...rel))
  if (process.env.APPDATA) anchored.push(joinPath(process.env.APPDATA, 'DSH Desktop', 'dsh-home', ...rel))
  if (process.env.HOME) anchored.push(joinPath(process.env.HOME, '.dsh', ...rel))
  for (const c of anchored) {
    try { if (existsSync(dirname(c))) return c } catch (e) {}
  }
  // 父目录都还不存在（首次运行）：取第一个锚定候选，由 persistLive 的
  // mkdirSync 建出来 —— 绝不回落到包内 node_modules/plugins。
  if (anchored.length) return anchored[0]
  return joinPath(dirname(dirname(fileURLToPath(import.meta.url))), ...rel)
}
const MCP_LIVE_FILE = resolveMcpLiveFile()

const CWD_FALLBACK = process.env.MIMO_MCP_CWD
  || process.env.MIMO_BRIDGE_CWD
  || process.cwd()

function resolveMimoExe() {
  const candidates = []
  if (process.env.MIMO_BIN) candidates.push(process.env.MIMO_BIN)
  if (process.env.MIMO_CLI) candidates.push(process.env.MIMO_CLI)
  if (process.env.USERPROFILE) candidates.push(process.env.USERPROFILE + '\\.mimocode\\bin\\mimo.exe')
  if (process.env.HOME) {
    candidates.push(process.env.HOME + '\\.mimocode\\bin\\mimo.exe')
    candidates.push(process.env.HOME + '/.mimocode/bin/mimo')
  }
  for (const exe of candidates) {
    try { if (exe && existsSync(exe)) return exe } catch (e) {}
  }
  return 'mimo'
}

const engine = createStatusEngine({ cwdFallback: CWD_FALLBACK })

function persistLive() {
  try {
    const snap = engine.snapshot()
    const dir = dirname(MCP_LIVE_FILE)
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    writeFileSync(MCP_LIVE_FILE, JSON.stringify({ from: 'mcp', writtenAt: Date.now(), projects: snap.projects }), 'utf8')
  } catch (e) { /* home-light bridge must not break mimo calls */ }
}
engine.onSnapshot(() => persistLive())

function runMimo(args) {
  return new Promise((resolve) => {
    const cwd = String(args.cwd || CWD_FALLBACK)
    const built = buildArgv(resolveMimoExe(), args, false)
    engine.begin(cwd)

    const child = spawn(built.argv[0], built.argv.slice(1), {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true
    })

    const stream = createLineStream()
    let stdoutText = '', stderrText = ''
    let settled = false
    const hardMs = (built.timeoutSec + HARD_TIMEOUT_GRACE_SEC) * 1000

    const timer = setTimeout(() => {
      try { child.kill('SIGTERM') } catch (e) {}
    }, hardMs)

    child.stdout.on('data', (chunk) => {
      const s = String(chunk)
      stdoutText += s
      for (const line of stream.push(s)) {
        try { engine.foldStep(cwd, JSON.parse(line)) } catch (e) {}
      }
    })
    child.stderr.on('data', (chunk) => { stderrText += String(chunk) })

    const finish = (exitCode) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      const parsed = parseMimoJson(stdoutText)
      const res = buildResult(parsed, { exitCode }, built.mode, stderrText, stdoutText)
      res.backend = 'mimocode'
      engine.end(res, cwd)
      resolve(res)
    }

    child.on('error', (err) => {
      const res = {
        ok: false,
        status: 'MIMO_UNAVAILABLE',
        response: '',
        sessionId: null,
        exitCode: null,
        mode: built.mode,
        backend: 'mimocode',
        stderr: String(err && err.message || err),
        errorMessage: String(err && err.message || err)
      }
      engine.end(res, cwd)
      if (!settled) { settled = true; clearTimeout(timer); resolve(res) }
    })
    child.on('close', (code) => finish(code == null ? -1 : code))
  })
}

async function runDesktop(args, runtime) {
  const cwd = String(args.cwd || CWD_FALLBACK)
  const sessionId = args.sessionId || newDesktopSessionId()
  engine.begin(cwd)
  try {
    const health = await desktopHealth(runtime)
    if (!health.ok) {
      const res = desktopResult(false, {
        status: 'DESKTOP_UNAVAILABLE',
        sessionId,
        stderr: String(health.error || 'not ready'),
        errorMessage: 'MiMo Desktop client unavailable. Start Xiaomi MiMo Desktop, or use backend=mimocode.'
      })
      engine.end(res, cwd)
      return res
    }
    const turn = await desktopSendTurn(runtime, sessionId, {
      prompt: args.prompt,
      model: args.model || runtime.desktopModel,
      directory: cwd
    })
    // 【实测事故】Desktop API 对任意 session id 都返回 202 {"ok":true}，不校验会话
    // 是否存在。必须以 turn.delivered（回读会话列表确认目标 id 存在）为准，
    // 否则会把"任务被静默丢弃"报告成 ACCEPTED，用户在 Desktop UI 里什么都看不到。
    const okTurn = turn.delivered === true
    let text = ''
    if (okTurn) {
      const ev = await desktopReadEvents(runtime, sessionId, cwd, 2500)
      text = ev.text || ''
    }
    const res = desktopResult(okTurn, {
      status: okTurn ? (text ? 'SUCCESS' : 'ACCEPTED') : 'DESKTOP_SESSION_NOT_CREATED',
      response: text || (okTurn ? '(Desktop turn accepted; see Desktop UI or call mimo_continue)' : ''),
      sessionId,
      accepted: okTurn,
      stderr: okTurn ? '' : 'Desktop API returned ' + turn.status + ' but session ' + turn.id + ' does not exist',
      errorMessage: okTurn ? '' : ('MiMo Desktop 未创建会话（API 返回 ' + turn.status +
        ' 但会话列表中不存在 ' + turn.id + '）。任务未执行。' +
        'MiMo Desktop API 无法创建会话，请在 Xiaomi MiMo Desktop 应用中新建（或选用现有）' +
        '会话，再把它的 id 传给 mimo_run 的 sessionId 参数。')
    })
    engine.end(res, cwd)
    return res
  } catch (e) {
    const res = desktopResult(false, {
      status: 'DESKTOP_ERROR',
      sessionId,
      stderr: String(e && e.message || e),
      errorMessage: String(e && e.message || e)
    })
    engine.end(res, cwd)
    return res
  }
}

async function handleTool(name, args) {
  const a = args || {}
  const runtime = loadRuntime({ argBackend: a.backend })

  if (name === 'mimo_settings') {
    const file = loadSettingsFile()
    const data = Object.assign({}, file.data || {})
    if (a.backend) data.backend = a.backend
    if (a.desktopModel) data.desktopModel = a.desktopModel
    if (a.backend || a.desktopModel) {
      try { saveSettingsFile(data) } catch (e) {
        return { ok: false, error: 'save failed: ' + String(e && e.message || e) }
      }
    }
    const rt = loadRuntime({})
    return {
      ok: true,
      settingsPath: rt.settingsPath,
      fileBackend: data.backend || null,
      envBackend: process.env.MIMO_BRIDGE_BACKEND || process.env.MIMO_BACKEND || null,
      effectiveBackend: rt.backend,
      desktopModel: rt.desktopModel,
      desktopAvailable: !!(rt.desktop && rt.desktop.available),
      desktopError: (rt.desktop && rt.desktop.error) || null,
      backends: BACKENDS
    }
  }

  if (name === 'mimo_run' || name === 'mimo_continue') {
    const mapped = {
      prompt: a.prompt,
      mode: a.mode,
      model: a.model,
      effort: a.effort,
      cwd: a.cwd,
      timeoutSec: a.timeoutSec,
      title: a.title,
      backend: a.backend,
      // 【关键】desktop 后端的 sessionId 必须转发。此处曾是白名单转发，漏了
      // sessionId（只在 mimo_continue 分支补），导致 mimo_run 传 sessionId 被
      // 静默丢弃 → 永远 newDesktopSessionId() 造新 id → 因 Desktop API 不能创建
      // 会话，mimo_run 在 desktop 后端下完全不可用。
      sessionId: a.sessionId
    }
    if (name === 'mimo_continue') {
      if (a.sessionId) mapped.sessionId = a.sessionId
      else mapped.continueLatest = true
    }
    const backend = runtime.backend
    let res
    if (backend === BACKEND_DESKTOP) res = await runDesktop(mapped, runtime)
    else res = await runMimo(mapped)
    if (!res.ok && isLimited(res)) {
      // runMimo / runDesktop 内部所有退出路径均已调用 engine.end。
      // 此处仅修改返回值对象，绝不二次调用 engine.end，避免 runs 虚标与 running 计数下溢。
      res = fallbackResult(res, res.mode)
      res.backend = backend
    }
    return res
  }
  if (name === 'mimo_status') {
    const snap = engine.snapshot()
    snap.defaultBackend = runtime.backend
    if (a.cwd) {
      snap.projects = (snap.projects || []).filter((p) => p.cwd === String(a.cwd))
    }
    return snap
  }
  return { ok: false, error: 'unknown tool: ' + name }
}

const TOOLS = [
  {
    name: 'mimo_run',
    description: 'Dispatch a coding/build/debug/investigation task to Xiaomi MiMo (mimocode CLI or mimo-desktop client — preselected in settings; `backend` overrides per call). DSH/host fully controls mimocode (--dangerously-skip-permissions). On rate-limit/network failure the result includes fallback guidance.',
    inputSchema: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: 'Task instruction. First dispatch on a topic: include a compact CONTEXT preamble pointing at paths (do not paste file contents).' },
        backend: { type: 'string', enum: BACKENDS, description: 'mimocode (default) | mimo-desktop. Prefer the preselected default.' },
        mode: { type: 'string', enum: ['auto', 'plan', 'build', 'compose', 'accept-edits'] },
        model: { type: 'string', description: 'provider/model id (mimocode) or desktop model id (mimo-desktop)' },
        effort: { type: 'string', enum: ['low', 'medium', 'high'] },
        cwd: { type: 'string' },
        // desktop 后端**不能创建会话**（API 对任意 id 都回 202 但不落库）。因此
        // 必须能显式指定一个**已存在**的 Desktop 会话 id，否则每次都生成一个自造 id
        // → 静默空操作。此前只有 mimo_continue 有 sessionId，mimo_run 缺声明，
        // 导致 mimo_run 在 desktop 后端下永远无法成功。
        sessionId: { type: 'string', description: 'mimo-desktop only: id of an ALREADY EXISTING MiMo Desktop session (see the Desktop app). Omit for mimocode.' },
        timeoutSec: { type: 'integer' },
        title: { type: 'string' }
      },
      required: ['prompt']
    }
  },
  {
    name: 'mimo_continue',
    description: 'Continue an existing mimo session (sessionId or latest=true). Backend routing: explicit backend wins, else settings default.',
    inputSchema: {
      type: 'object',
      properties: {
        prompt: { type: 'string' },
        sessionId: { type: 'string' },
        latest: { type: 'boolean' },
        backend: { type: 'string', enum: BACKENDS },
        mode: { type: 'string', enum: ['auto', 'plan', 'build', 'compose', 'accept-edits'] },
        model: { type: 'string' },
        effort: { type: 'string', enum: ['low', 'medium', 'high'] },
        cwd: { type: 'string' },
        timeoutSec: { type: 'integer' }
      },
      required: ['prompt']
    }
  },
  {
    name: 'mimo_status',
    description: 'Live snapshot of what mimo is currently doing (per-project current step + trail + last run + defaultBackend).',
    inputSchema: {
      type: 'object',
      properties: {
        cwd: { type: 'string' }
      }
    }
  },
  {
    name: 'mimo_settings',
    description: 'Read or change the preselected dispatch backend: mimocode (local mimo CLI / MiMoCode) or mimo-desktop (Xiaomi MiMo Desktop client). Persisted to the settings file.',
    inputSchema: {
      type: 'object',
      properties: {
        backend: { type: 'string', enum: BACKENDS, description: 'If set, save as default backend.' },
        desktopModel: { type: 'string', description: 'Desktop model id for mimo-desktop (e.g. mimo-auto).' }
      }
    }
  }
]

function renderResultText(res) {
  if (!res) return '(no result)'
  const b = res.backend ? ' backend=' + res.backend : ''
  if (res.fallback) {
    return 'status=FALLBACK_TO_DSH fallback=true' + b + '\n' + (res.reason ? 'reason=' + res.reason + '\n' : '') +
      'The user/host chose DSH-local. Finish with native tools and NEVER call mimo again for this task.'
  }
  if (res.ok === false && res.error) return 'mimo_settings/error' + b + ': ' + res.error
  if (!res.ok) {
    return 'mimo failed status=' + (res.status || 'ERROR') + b + '\n' + shortLabel(res.stderr || res.errorMessage || '')
  }
  return 'mimo ok status=' + res.status + b + (res.sessionId ? ' sessionId=' + res.sessionId : '') + '\n\n' + String(res.response || '')
}

// ── MCP stdio JSON-RPC ──────────────────────────────────────────────────────
function writeMsg(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n')
}

function handleRpc(msg) {
  const { id, method, params } = msg || {}
  if (method === 'initialize') {
    writeMsg({
      jsonrpc: '2.0',
      id,
      result: {
        protocolVersion: params && params.protocolVersion ? params.protocolVersion : PROTOCOL,
        capabilities: { tools: {} },
        serverInfo: { name: NAME, version: VERSION }
      }
    })
    return
  }
  if (method === 'notifications/initialized' || method === 'initialized') return
  if (method === 'tools/list') {
    writeMsg({ jsonrpc: '2.0', id, result: { tools: TOOLS } })
    return
  }
  if (method === 'tools/call') {
    const name = params && params.name
    const args = (params && params.arguments) || {}
    handleTool(name, args).then((result) => {
      let text
      if (name === 'mimo_status' || name === 'mimo_settings') text = JSON.stringify(result, null, 2)
      else text = renderResultText(result)
      writeMsg({
        jsonrpc: '2.0',
        id,
        result: { content: [{ type: 'text', text }], isError: !!(result && result.ok === false && !result.fallback) }
      })
    }).catch((err) => {
      writeMsg({
        jsonrpc: '2.0',
        id,
        result: { content: [{ type: 'text', text: 'mimo-mcp-server error: ' + String(err && err.message || err) }], isError: true }
      })
    })
    return
  }
  if (id !== undefined) {
    writeMsg({ jsonrpc: '2.0', id, error: { code: -32601, message: 'Method not found: ' + method } })
  }
}

function main() {
  const argv = process.argv.slice(2)
  if (argv.includes('--check')) {
    console.log(NAME + ' ' + VERSION + ' check ok')
    console.log('tools: ' + TOOLS.map((t) => t.name).join(', '))
    console.log('mimo exe: ' + resolveMimoExe())
    console.log('cwd fallback: ' + CWD_FALLBACK)
    process.exit(0)
  }
  if (argv.includes('--version') || argv.includes('-v')) {
    console.log(VERSION)
    process.exit(0)
  }

  let buf = ''
  process.stdin.setEncoding('utf8')
  process.stdin.on('data', (chunk) => {
    buf += chunk
    let idx
    while ((idx = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, idx).trim()
      buf = buf.slice(idx + 1)
      if (!line) continue
      try {
        handleRpc(JSON.parse(line))
      } catch (e) {
        // ignore malformed
      }
    }
  })
  process.stdin.on('end', () => process.exit(0))
}

main()
