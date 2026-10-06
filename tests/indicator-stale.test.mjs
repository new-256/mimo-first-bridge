// tests/indicator-stale.test.mjs — 回归测试：状态灯「长时间不消失」修复。
//
// 背景（用户实测反馈，连续三次）：
//   面板关掉 MiMo 预设会话后，标题栏状态灯依然常亮不灭。
//
// 根因两处，本文件逐一锁死：
//   1) host 半：mcp-live.json 里几十小时前的历史记录被无条件并入，且快照不带
//      「陈旧」标记 → 客户端无从判断该不该继续点灯。
//   2) client 半：可见性只看 presetActive（**全局租约**，任何 mimo preset 会话
//      每 30s 心跳续期，TTL 75s）+ projects.length>0，没有「短时」约束，也没有
//      per-session preset 判定，于是普通会话被别的会话的租约永久点亮。

import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let passed = 0
function ok(label, fn) {
  try { fn(); console.log('ok: ' + label); passed++ }
  catch (e) { console.error('FAIL: ' + label + ' — ' + e.message); process.exitCode = 1 }
}
async function okAsync(label, fn) {
  try { await fn(); console.log('ok: ' + label); passed++ }
  catch (e) { console.error('FAIL: ' + label + ' — ' + e.message); process.exitCode = 1 }
}

// ── host 半：先把 MCP live 文件指到临时目录，再动态 import（模块在导入期锚定路径）
const dir = mkdtempSync(join(tmpdir(), 'mimo-ind-stale-'))
const liveFile = join(dir, 'mcp-live.json')
process.env.MIMO_MCP_LIVE_FILE = liveFile

const host = await import('../home-plugin/mimo-indicator/lib/index.mjs')

// 用最小 ctx 驱动 host 半，并抓取 /mimo-indicator/status 的处理函数。
function bootHost() {
  const handlers = {}
  const emitted = {}
  let routeHandler = null
  const ctx = {
    on(ch, fn) { emitted[ch] = fn },
    provide() { },
    inject(deps, fn) {
      fn({
        get: (n) => (n === 'webServer' ? {
          register(opts) { if (opts && opts.path === '/mimo-indicator/status') routeHandler = opts.handler }
        } : undefined),
        effect: (f) => f()
      })
    }
  }
  host.apply(ctx)
  assert.equal(typeof routeHandler, 'function', 'status route must be registered')
  return {
    emit: (ch, payload) => { if (emitted[ch]) emitted[ch](payload) },
    async status() {
      let body = ''
      await routeHandler({}, { writeHead() { }, end(b) { body = b } })
      return JSON.parse(body)
    }
  }
}

const HOUR = 3600 * 1000

await okAsync('host: 陈旧的 mcp-live.json（写入于 41 小时前）不再并入快照', async () => {
  const h = bootHost()
  writeFileSync(liveFile, JSON.stringify({
    from: 'mcp',
    writtenAt: Date.now() - 41 * HOUR,
    projects: [{ cwd: 'C:\\old\\stale-project', lastStatus: 'ACCEPTED', running: 0, updatedAt: Date.now() - 41 * HOUR }]
  }))
  const s = await h.status()
  // 两道闸门都必须生效，缺一不可：
  //   a) 整份文件陈旧 → 直接不并入（projects 里根本不该出现该项目）；
  //   b) 即便并入，也要被标记 stale=true，客户端据此不点灯。
  assert.equal(s.projects.length, 0, 'stale MCP file must not resurrect projects')
  assert.equal(s.projects.find((x) => x.cwd === 'C:\\old\\stale-project'), undefined,
    'the 41h-old MCP project must not appear in the snapshot at all')
})

await okAsync('host: 陈旧文件即使侥幸并入，也必带 stale=true（第二道闸门独立成立）', async () => {
  const h = bootHost()
  // 直接经事件入口塞入同一条 41 小时前的记录 —— 绕过「整份文件陈旧」闸门，
  // 单独验证「逐项目 stale 标记」这道闸门自己也必须起作用。
  writeFileSync(liveFile, JSON.stringify({ from: 'mcp', writtenAt: Date.now(), projects: [] }))
  h.emit('mimo/status', {
    snapshot: { projects: [{ cwd: 'C:\\old\\via-event', lastStatus: 'ACCEPTED', running: 0, updatedAt: Date.now() - 41 * HOUR }] }
  })
  const s = await h.status()
  const p = s.projects.find((x) => x.cwd === 'C:\\old\\via-event')
  assert.ok(p, 'event-injected project must be present')
  assert.equal(p.stale, true, 'per-project stale gate must fire independently of the file gate')
})

await okAsync('host: 新鲜的 mcp-live.json 正常并入，且项目不被标记 stale', async () => {
  const h = bootHost()
  writeFileSync(liveFile, JSON.stringify({
    from: 'mcp',
    writtenAt: Date.now(),
    projects: [{ cwd: 'C:\\fresh\\proj', lastStatus: 'ACCEPTED', running: 0, updatedAt: Date.now() }]
  }))
  const s = await h.status()
  assert.equal(s.projects.length, 1, 'fresh MCP file must be merged')
  assert.equal(s.projects[0].stale, false, 'fresh project must not be stale')
})

await okAsync('host: 41 小时前的项目被标记 stale=true（客户端据此不再单独点灯）', async () => {
  const h = bootHost()
  writeFileSync(liveFile, JSON.stringify({ from: 'mcp', writtenAt: Date.now(), projects: [] }))
  h.emit('mimo/status', {
    snapshot: { projects: [{ cwd: 'C:\\old\\proj', lastStatus: 'ACCEPTED', running: 0, updatedAt: Date.now() - 41 * HOUR }] }
  })
  const s = await h.status()
  const p = s.projects.find((x) => x.cwd === 'C:\\old\\proj')
  assert.ok(p, 'project must be present in snapshot (detail panel keeps history)')
  assert.equal(p.stale, true, 'old idle project must carry stale=true')
})

await okAsync('host: 正在 running 的项目永不标记 stale', async () => {
  const h = bootHost()
  writeFileSync(liveFile, JSON.stringify({ from: 'mcp', writtenAt: Date.now(), projects: [] }))
  h.emit('mimo/status', {
    snapshot: { projects: [{ cwd: 'C:\\busy\\proj', lastStatus: 'SUCCESS', running: 1, updatedAt: Date.now() - 41 * HOUR }] }
  })
  const s = await h.status()
  const p = s.projects.find((x) => x.cwd === 'C:\\busy\\proj')
  assert.ok(p, 'running project must be present')
  assert.equal(p.stale, false, 'a running project must never be considered stale')
  assert.equal(s.running, 1, 'top-level running must count it')
})

// ── client 半：捕获 __ModuleLoader__.load 的工厂，验证契约与 per-session 接线
let loaded = null
globalThis.window = { __ModuleLoader__: { load(spec) { loaded = spec } } }
await import('../home-plugin/mimo-indicator/lib/client.js')

ok('client: 模块 id 必须 === 包名 mimo-first-bridge（否则 combo 糊掉整屏插件页）', () => {
  assert.ok(loaded, 'client must call __ModuleLoader__.load')
  assert.equal(loaded.id, 'mimo-first-bridge')
})

ok('client: 工厂可构造，导出 apply/inject/name', () => {
  const reactStub = {
    createElement: () => null,
    Fragment: {},
    useState: (v) => [v, () => { }],
    useEffect: () => { },
    useRef: () => ({ current: null }),
    useSyncExternalStore: (_sub, get) => get()
  }
  const mod = loaded.factory((n) => (n === 'react' ? reactStub : {}))
  assert.equal(typeof mod.apply, 'function')
  assert.deepEqual(mod.inject, ['slots'])
  assert.equal(mod.name, 'mimo-first-bridge')
})

ok('client: slots.register 描述符经 inject() 透出 sessionsSvc（per-session preset 判定通道）', () => {
  const reactStub = {
    createElement: () => null, Fragment: {},
    useState: (v) => [v, () => { }], useEffect: () => { },
    useRef: () => ({ current: null }), useSyncExternalStore: (_s, get) => get()
  }
  const mod = loaded.factory((n) => (n === 'react' ? reactStub : {}))
  const sessionsStub = { list: { subscribe: () => () => { }, getSnapshot: () => ({ byId: {} }) } }
  let descriptor = null
  mod.apply({
    inject(_deps, fn) {
      const slotsSvc = {
        inject(_name, cb) { cb() },
        register(desc, _render) { descriptor = desc; return null }
      }
      fn({
        get: (n) => (n === 'slots' ? slotsSvc : (n === 'sessions' ? sessionsStub : undefined)),
        slots: slotsSvc
      })
    }
  })
  assert.ok(descriptor, 'register descriptor must be produced')
  assert.equal(descriptor.id, 'mimo-indicator-home')
  assert.equal(typeof descriptor.inject, 'function', 'descriptor must carry inject() for session context')
  const injected = descriptor.inject('ses_test')
  assert.equal(injected.injectedSessionId, 'ses_test')
  assert.equal(injected.sessionsSvc, sessionsStub, 'inject() must hand sessionsSvc to the component')
})

console.log('\nindicator-stale tests passed: ' + passed)
