// tests/desktop-delivery.test.mjs
//
// 回归测试：desktopSendTurn 必须以「回读会话列表确认目标 id 存在」为成功判据，
// 不能拿 Desktop API 的 202 当成功 —— 实测 API 对任意 id 都返回 202 {"ok":true}，
// 自造 id 永远不会被创建，任务被静默丢弃。
//
// 变异验证：把 delivered 改回 `accepted` 后，本测试的 "self-invented id" 用例必 FAIL。
import assert from 'node:assert/strict'
import { desktopSendTurn } from '../core/runtime-settings.mjs'

let passed = 0
function ok(name, fn) {
  try { fn(); console.log('ok: ' + name); passed++ }
  catch (e) { console.log('FAIL: ' + name + ' — ' + e.message); process.exitCode = 1 }
}

// 造一个受控的 fake runtime + 拦截 globalThis.fetch。
// 注意 fn 必须是 async 且被 await —— 早先写成同步 fn 会让 try/finally 在
// promise 兑现前就还原 fetch，导致被测函数拿到真实网络层（verified=null）。
async function withFakeDesktop(handler, fn) {
  const orig = globalThis.fetch
  globalThis.fetch = async (url, init) => {
    const r = handler(String(url), init)
    return {
      status: r.status,
      ok: r.status >= 200 && r.status < 300,
      text: async () => (r.body == null ? '' : JSON.stringify(r.body))
    }
  }
  try { return await fn() } finally { globalThis.fetch = orig }
}

const RUNTIME = {
  desktop: { available: true, baseUrl: 'http://127.0.0.1:9', token: 't', model: 'mimo-auto' },
  desktopModel: 'mimo-auto'
}

// 场景 1：目标会话已存在（列表里有）→ delivered 必须为 true
await (async () => {
  const realId = 'ses_ffe5f3060103dffeAX924f5Vgc'
  const res = await withFakeDesktop((url, init) => {
    if (url.includes('/turns') && init.method === 'POST') return { status: 202, body: { ok: true } }
    if (url.includes('/v1/sessions')) return { status: 200, body: [{ id: realId, title: 'x' }] }
    return { status: 404, body: null }
  }, async () => desktopSendTurn(RUNTIME, realId, { prompt: 'hi' }))

  ok('desktopSendTurn marks delivered=true when the session really exists', () => {
    assert.equal(res.accepted, true, 'accepted should be true (202)')
    assert.equal(res.verified, true, 'verified should be true (found in list)')
    assert.equal(res.delivered, true, 'delivered must be true for a real session')
  })
})()

// 场景 2：自造 id（列表里没有）→ delivered 必须为 false（这是修复的核心）
await (async () => {
  const fakeId = 'ses_inventedbynobody9999'
  const res = await withFakeDesktop((url, init) => {
    if (url.includes('/turns') && init.method === 'POST') return { status: 202, body: { ok: true } }
    if (url.includes('/v1/sessions')) return { status: 200, body: [{ id: 'ses_someoneelse' }] }
    return { status: 404, body: null }
  }, async () => desktopSendTurn(RUNTIME, fakeId, { prompt: 'hi' }))

  ok('desktopSendTurn marks delivered=false for a self-invented session id', () => {
    assert.equal(res.accepted, true, 'API still says 202 (that is the trap)')
    assert.equal(res.verified, false, 'verified must be false — id absent from list')
    assert.equal(res.delivered, false, 'delivered MUST be false, otherwise we report ACCEPTED for a no-op')
  })
})()

// 场景 3：列表接口不可用 → 不据此误报失败（verified=null，delivered 跟随 accepted）
await (async () => {
  const res = await withFakeDesktop((url, init) => {
    if (url.includes('/turns') && init.method === 'POST') return { status: 202, body: { ok: true } }
    return { status: 500, body: { error: 'nope' } }
  }, async () => desktopSendTurn(RUNTIME, 'ses_whatever1234567890', { prompt: 'hi' }))

  ok('desktopSendTurn does not hard-fail when the session list is unavailable', () => {
    assert.equal(res.verified, null, 'verified should be null (undeterminable)')
    assert.equal(res.delivered, true, 'delivered follows accepted when we cannot verify')
  })
})()

// 场景 4：API 直接拒绝（非 2xx）→ delivered false
await (async () => {
  const res = await withFakeDesktop(() => ({ status: 400, body: { error: 'bad' } }),
    async () => desktopSendTurn(RUNTIME, 'ses_x1234567890abcdefg', { prompt: 'hi' }))

  ok('desktopSendTurn marks delivered=false when the API rejects the turn', () => {
    assert.equal(res.accepted, false)
    assert.equal(res.delivered, false)
  })
})()

console.log('\ndesktop-delivery tests passed: ' + passed)
