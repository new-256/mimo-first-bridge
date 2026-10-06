// tests/core.test.mjs — unit tests for core/mimo-core.mjs pure functions.
import assert from 'node:assert/strict'
import {
  clampInt,
  shortLabel,
  projectName,
  summarizeArgs,
  isLimited,
  fallbackResult,
  buildArgv,
  parseMimoJson,
  buildResult,
  createLineStream,
  createStatusEngine,
  foldStepUpdate,
  normalizeBackend,
  resolveBackend,
  parseSettingsJson,
  buildDesktopTurnBody,
  newDesktopSessionId,
  parseDesktopEvents,
  desktopResult,
  isSuccessStatus,
  BACKEND_MIMOCODE,
  BACKEND_DESKTOP,
  DEFAULT_BACKEND,
  LIMIT_RE
} from '../core/mimo-core.mjs'

let passed = 0
function ok(label, fn) {
  try { fn(); console.log('ok: ' + label); passed++ }
  catch (e) { console.error('FAIL: ' + label + ' — ' + e.message); process.exitCode = 1 }
}

ok('clampInt defaults and clamps', () => {
  assert.equal(clampInt(undefined, 600, 10, 3600), 600)
  assert.equal(clampInt(5, 600, 10, 3600), 10)
  assert.equal(clampInt(99999, 600, 10, 3600), 3600)
  assert.equal(clampInt('120', 600, 10, 3600), 120)
})

ok('shortLabel truncates', () => {
  assert.equal(shortLabel('a'.repeat(200)).length, 80)
  assert.equal(shortLabel('hi'), 'hi')
})

ok('projectName basename', () => {
  assert.equal(projectName('C:\\x\\y\\proj'), 'proj')
  assert.equal(projectName('/a/b/c'), 'c')
})

ok('summarizeArgs clamps strings', () => {
  const s = summarizeArgs({ a: 'x'.repeat(200), b: 1 })
  assert.equal(s.a.length, 121) // 120 + ellipsis
  assert.equal(s.b, 1)
})

ok('isLimited detects free-API / network / rate-limit', () => {
  assert.equal(isLimited({ ok: false, stderr: 'MiMo free API service has ended. Sign in or configure a third-party API.' }), true)
  assert.equal(isLimited({ ok: false, stderr: 'ETIMEDOUT' }), true)
  assert.equal(isLimited({ ok: false, stderr: 'rate limit exceeded' }), true)
  assert.equal(isLimited({ ok: false, status: 'SPAWN_ERROR' }), true)
  assert.equal(isLimited({ ok: true, stderr: 'rate limit' }), false)
  assert.equal(isLimited({ ok: false, stderr: 'syntax error in file' }), false)
})

ok('fallbackResult shape', () => {
  const r = fallbackResult({ status: 'ERROR', sessionId: 'ses_1', stderr: 'x' }, 'build')
  assert.equal(r.fallback, true)
  assert.equal(r.status, 'FALLBACK_TO_DSH')
  assert.equal(r.sessionId, 'ses_1')
})

ok('buildArgv maps mimo run CLI', () => {
  const b = buildArgv('mimo', {
    prompt: 'hello world',
    mode: 'plan',
    model: 'mimo/mimo',
    effort: 'low',
    cwd: 'C:\\proj',
    timeoutSec: 30
  }, false)
  assert.equal(b.argv[0], 'mimo')
  assert.equal(b.argv[1], 'run')
  assert.ok(b.argv.includes('hello world'))
  assert.ok(b.argv.includes('--format'))
  assert.ok(b.argv.includes('json'))
  assert.ok(b.argv.includes('--dangerously-skip-permissions'))
  assert.ok(b.argv.includes('--agent'))
  assert.ok(b.argv.includes('plan'))
  assert.ok(b.argv.includes('--model'))
  assert.ok(b.argv.includes('--variant'))
  assert.ok(b.argv.includes('minimal'))
  assert.ok(b.argv.includes('--dir'))
  assert.equal(b.timeoutSec, 30)
  assert.equal(b.mode, 'plan')
})

ok('buildArgv continue session', () => {
  const b = buildArgv('mimo', { prompt: 'next', sessionId: 'ses_abc', continueLatest: false }, false)
  assert.ok(b.argv.includes('--session'))
  assert.ok(b.argv.includes('ses_abc'))
  const b2 = buildArgv('mimo', { prompt: 'next', continueLatest: true }, false)
  assert.ok(b2.argv.includes('--continue'))
})

ok('buildArgv auto follows planActive', () => {
  const p = buildArgv('mimo', { prompt: 'x', mode: 'auto' }, true)
  assert.equal(p.mode, 'plan')
  const b = buildArgv('mimo', { prompt: 'x', mode: 'auto' }, false)
  assert.equal(b.mode, 'build')
})

ok('parseMimoJson extracts error events (free API ended)', () => {
  const out = [
    '{"type":"error","timestamp":1790189983335,"sessionID":"ses_-ffe5f305cc36cffe3DR7Ge0XJ","error":{"name":"UnknownError","data":{"message":"MiMo free API service has ended. Sign in or configure a third-party API."}}}'
  ].join('\n')
  const p = parseMimoJson(out)
  assert.equal(p.sessionId, 'ses_-ffe5f305cc36cffe3DR7Ge0XJ')
  assert.ok(p.error.includes('free API service has ended'))
  assert.equal(p.errorName, 'UnknownError')
})

ok('parseMimoJson extracts text + tool steps', () => {
  const out = [
    '{"type":"text","text":"Hello"}',
    '{"type":"tool","properties":{"tool":"bash","arguments":{"command":"ls"}}}',
    '{"type":"text","text":"World"}',
    'not-json-log-line'
  ].join('\n')
  const p = parseMimoJson(out)
  assert.equal(p.text, 'Hello\nWorld')
  assert.ok(p.steps.length >= 2)
})

ok('buildResult SUCCESS path', () => {
  const parsed = parseMimoJson('{"type":"text","text":"PONG","sessionID":"ses_x"}')
  const res = buildResult(parsed, { exitCode: 0 }, 'build', '', '')
  assert.equal(res.ok, true)
  assert.equal(res.status, 'SUCCESS')
  assert.equal(res.response, 'PONG')
  assert.equal(res.sessionId, 'ses_x')
})

ok('buildResult ERROR path folds stderr', () => {
  const parsed = parseMimoJson('{"type":"error","sessionID":"ses_e","error":{"name":"UnknownError","data":{"message":"boom"}}}')
  const res = buildResult(parsed, { exitCode: 1 }, 'build', 'log-line', '')
  assert.equal(res.ok, false)
  assert.ok(res.stderr.includes('boom'))
})

ok('createLineStream is half-line safe', () => {
  const s = createLineStream()
  assert.deepEqual(s.push('{"a":1'), [])
  assert.deepEqual(s.push('}\n{"b":2}\npar'), ['{"a":1}', '{"b":2}'])
  assert.deepEqual(s.flush(), ['par'])
})

ok('foldStepUpdate pushes trail', () => {
  const trail = []
  foldStepUpdate({ type: 'tool', properties: { tool: 'bash', arguments: { command: 'ls' } } }, trail)
  assert.equal(trail.length, 1)
  assert.ok(trail[0].label.includes('bash'))
})

ok('status engine begin/end/snapshot', () => {
  const eng = createStatusEngine({ cwdFallback: '/tmp' })
  eng.begin('/tmp/proj')
  let snap = eng.snapshot()
  assert.equal(snap.running, 1)
  assert.equal(snap.state, 'running')
  assert.equal(snap.projects[0].name, 'proj')
  eng.end({ ok: true, status: 'SUCCESS', sessionId: 'ses_1', totalTokens: 42 }, '/tmp/proj')
  snap = eng.snapshot()
  assert.equal(snap.running, 0)
  assert.equal(snap.state, 'ok')
  assert.equal(snap.lastSessionId, 'ses_1')
  assert.equal(snap.projects[0].runs, 1)
  assert.equal(snap.projects[0].totalTokens, 42)
})

ok('status engine fallback state', () => {
  const eng = createStatusEngine({ cwdFallback: '/tmp' })
  eng.begin('/tmp')
  eng.end(fallbackResult({ status: 'ERROR' }, 'build'), '/tmp')
  assert.equal(eng.snapshot().state, 'fallback')
})

ok('isSuccessStatus treats ACCEPTED as success (desktop 202 must not paint red)', () => {
  assert.equal(isSuccessStatus('SUCCESS'), true)
  assert.equal(isSuccessStatus('ACCEPTED'), true)
  assert.equal(isSuccessStatus('ERROR'), false)
  assert.equal(isSuccessStatus('PARSE_ERROR'), false)
  assert.equal(isSuccessStatus(null), false)
})

ok('status engine reports ok for an ACCEPTED desktop dispatch', () => {
  const eng = createStatusEngine({ cwdFallback: '/tmp' })
  eng.begin('/tmp/proj')
  eng.end(desktopResult(true, { sessionId: 'ses_d', accepted: true, response: '' }), '/tmp/proj')
  const snap = eng.snapshot()
  assert.equal(snap.state, 'ok', 'ACCEPTED dispatch must be green, got ' + snap.state)
  assert.equal(snap.projects[0].state, 'ok')
  assert.equal(snap.lastStatus, 'ACCEPTED')
})

ok('LIMIT_RE matches Chinese and English', () => {
  assert.ok(LIMIT_RE.test('网络连接失败'))
  assert.ok(LIMIT_RE.test('rate limit'))
  assert.ok(!LIMIT_RE.test('TypeError: x is not a function'))
})

ok('normalizeBackend aliases', () => {
  assert.equal(normalizeBackend('mimocode'), BACKEND_MIMOCODE)
  assert.equal(normalizeBackend('CLI'), BACKEND_MIMOCODE)
  assert.equal(normalizeBackend('mimo-desktop'), BACKEND_DESKTOP)
  assert.equal(normalizeBackend('desktop'), BACKEND_DESKTOP)
  assert.equal(normalizeBackend('Xiaomi-MiMo'), BACKEND_DESKTOP)
  assert.equal(normalizeBackend('nope'), null)
  assert.equal(normalizeBackend(''), null)
})

ok('resolveBackend priority: arg > config > env > file > default', () => {
  assert.equal(resolveBackend({ argBackend: 'desktop', configBackend: 'mimocode', envBackend: 'mimocode', fileBackend: 'mimocode' }), BACKEND_DESKTOP)
  assert.equal(resolveBackend({ configBackend: 'mimo-desktop', envBackend: 'mimocode', fileBackend: 'mimocode' }), BACKEND_DESKTOP)
  assert.equal(resolveBackend({ envBackend: 'mimo-desktop', fileBackend: 'mimocode' }), BACKEND_DESKTOP)
  assert.equal(resolveBackend({ fileBackend: 'mimo-desktop' }), BACKEND_DESKTOP)
  assert.equal(resolveBackend({}), DEFAULT_BACKEND)
  assert.equal(resolveBackend({ argBackend: 'bogus', fileBackend: 'desktop' }), BACKEND_DESKTOP)
})

ok('parseSettingsJson tolerant', () => {
  assert.deepEqual(parseSettingsJson('{"backend":"mimo-desktop"}'), { backend: 'mimo-desktop' })
  assert.deepEqual(parseSettingsJson('not-json'), {})
  assert.deepEqual(parseSettingsJson(''), {})
})

ok('buildDesktopTurnBody requires message+model (verified contract)', () => {
  const b = buildDesktopTurnBody({ prompt: 'hello', model: 'mimo-pro', cwd: 'C:\\proj' })
  assert.equal(b.message, 'hello')
  assert.equal(b.model, 'mimo-pro')
  assert.equal(b.directory, 'C:\\proj')
  const b2 = buildDesktopTurnBody({ prompt: 'x' })
  assert.equal(b2.model, 'mimo-auto')
  assert.ok(b2.message)
})

ok('newDesktopSessionId shape', () => {
  const id = newDesktopSessionId()
  assert.ok(/^ses_[a-z0-9]{10,}$/.test(id), id)
})

ok('parseDesktopEvents extracts text and errors', () => {
  const t = parseDesktopEvents('{"type":"text","text":"PONG"}')
  assert.equal(t.text, 'PONG')
  const e = parseDesktopEvents('{"type":"error","error":{"message":"boom"}}')
  assert.equal(e.error, 'boom')
  const arr = parseDesktopEvents('[{"text":"a"},{"text":"b"}]')
  assert.ok(arr.text.length >= 0)
})

ok('desktopResult marks backend mimo-desktop', () => {
  const r = desktopResult(true, { sessionId: 'ses_1', accepted: true, response: '' })
  assert.equal(r.backend, BACKEND_DESKTOP)
  assert.equal(r.ok, true)
  assert.equal(r.status, 'ACCEPTED')
})
ok('status engine never evicts running projects when full', () => {
  const eng = createStatusEngine({ cwdFallback: '/tmp' })
  // 必须真正越过 MAX_PROJECTS（24）才会进入淘汰分支——否则测试是空转的。
  const OVER = 30
  for (let i = 1; i <= OVER; i++) {
    eng.begin('/tmp/proj' + i)
  }
  const snap = eng.snapshot()
  // 全部 running 时绝不淘汰：数量不得被压回上限，且不得有项目丢失。
  assert.equal(snap.running, OVER, 'all running projects must survive, got running=' + snap.running)
  assert.equal(snap.projects.length, OVER, 'no running project may be evicted, got ' + snap.projects.length)
  for (const p of snap.projects) {
    assert.equal(p.running, 1, p.cwd + ' must still be running')
  }
})

ok('status engine still evicts idle projects when full', () => {
  const eng = createStatusEngine({ cwdFallback: '/tmp' })
  // 先制造一批 idle 项目，再压入 running 项目；idle 应被淘汰、running 必须全留。
  for (let i = 1; i <= 28; i++) eng.begin('/tmp/idle' + i) // 保持 running(不 end)
  for (let i = 1; i <= 28; i++) eng.end({ ok: true, status: 'SUCCESS' }, '/tmp/idle' + i) // 全部转 idle
  const before = eng.snapshot().projects.length
  assert.equal(before, 28, 'precondition: 28 idle projects')
  for (let i = 1; i <= 5; i++) eng.begin('/tmp/live' + i)
  const snap = eng.snapshot()
  const live = snap.projects.filter((p) => p.cwd.indexOf('live') >= 0)
  assert.equal(live.length, 5, 'all 5 running projects must survive eviction')
  assert.ok(snap.projects.length <= 28, 'idle projects must be evicted to respect the cap, got ' + snap.projects.length)
})

ok('mergeExternal recomputes derived state and handles ACCEPTED correctly', () => {
  const eng = createStatusEngine({ cwdFallback: '/tmp' })
  eng.mergeExternal([
    {
      cwd: '/tmp/remote-proj',
      state: 'failed',
      running: 0,
      lastStatus: 'ACCEPTED',
      updatedAt: Date.now()
    }
  ])
  const snap = eng.snapshot()
  const p = snap.projects.find((x) => x.cwd === '/tmp/remote-proj')
  assert.ok(p)
  assert.equal(p.state, 'ok', 'ACCEPTED lastStatus must yield ok state, got ' + p.state)
})

ok('status engine end() guards running state and fallbackActive under concurrency', () => {
  const eng = createStatusEngine({ cwdFallback: '/tmp' })
  eng.begin('/tmp/concurrent-proj')
  eng.begin('/tmp/concurrent-proj')
  let snap = eng.snapshot()
  assert.equal(snap.projects[0].running, 2)

  eng.end(fallbackResult({ status: 'ERROR' }, 'build'), '/tmp/concurrent-proj')
  snap = eng.snapshot()
  assert.equal(snap.projects[0].running, 1)
  assert.equal(snap.projects[0].state, 'running', 'state must stay running while running > 0')
  assert.equal(snap.projects[0].fallbackActive, true, 'fallbackActive must be preserved')

  eng.end({ ok: true, status: 'SUCCESS' }, '/tmp/concurrent-proj')
  snap = eng.snapshot()
  assert.equal(snap.projects[0].running, 0)
  assert.equal(snap.projects[0].fallbackActive, false, 'fallbackActive cleared when running is 0')
  assert.equal(snap.projects[0].state, 'ok')
})

ok('mergeExternal discards older external snapshots', () => {
  const eng = createStatusEngine({ cwdFallback: '/tmp' })
  eng.begin('/tmp/proj-g')
  eng.end({ ok: true, status: 'SUCCESS' }, '/tmp/proj-g')
  const localSnap = eng.snapshot()
  const localAt = localSnap.projects[0].updatedAt

  eng.mergeExternal([
    {
      cwd: '/tmp/proj-g',
      lastStatus: 'ERROR',
      updatedAt: localAt - 10000
    }
  ])
  const afterSnap = eng.snapshot()
  assert.equal(afterSnap.projects[0].lastStatus, 'SUCCESS', 'older external snapshot must not overwrite newer local status')
})

ok('status engine clearFallback clears fallbackActive and resets state', () => {
  const eng = createStatusEngine({ cwdFallback: '/tmp' })
  eng.begin('/tmp/fb-proj')
  eng.end(fallbackResult({ status: 'ERROR' }, 'build'), '/tmp/fb-proj')
  assert.equal(eng.snapshot().projects[0].state, 'fallback')
  assert.equal(eng.snapshot().projects[0].fallbackActive, true)

  eng.clearFallback()
  const snap = eng.snapshot()
  assert.equal(snap.projects[0].fallbackActive, false)
  assert.equal(snap.projects[0].state, 'idle')
})

ok('top-level fallbackActive tracks only the most recent project, not OR of all', () => {
  const eng = createStatusEngine({ cwdFallback: '/tmp' })
  // 项目 A 先回退（陈旧），项目 B 后成功（最新）。
  eng.begin('/tmp/proj-a')
  eng.end(fallbackResult({ status: 'ERROR' }, 'a'), '/tmp/proj-a')
  const tA = eng.snapshot().projects.find((p) => p.cwd === '/tmp/proj-a')
  assert.equal(tA.fallbackActive, true, 'proj-a should be fallback')

  eng.begin('/tmp/proj-b')
  eng.end({ ok: true, status: 'SUCCESS', text: 'done' }, '/tmp/proj-b')

  const snap = eng.snapshot()
  const b = snap.projects.find((p) => p.cwd === '/tmp/proj-b')
  assert.equal(b.fallbackActive, false, 'proj-b should not be fallback')
  assert.equal(b.state, 'ok', 'proj-b should be ok')

  // 关键断言：陈旧的 proj-a 不得把顶层状态拖成 fallback。
  assert.equal(snap.fallbackActive, false, 'stale project fallback must not leak to top-level')
  assert.equal(snap.state, 'ok', 'top-level state must follow the most recent project (ok), got ' + snap.state)
})

ok('top-level still reports fallback when the most recent project did fall back', () => {
  const eng = createStatusEngine({ cwdFallback: '/tmp' })
  eng.begin('/tmp/old-ok')
  eng.end({ ok: true, status: 'SUCCESS', text: 'x' }, '/tmp/old-ok')
  eng.begin('/tmp/new-fb')
  eng.end(fallbackResult({ status: 'ERROR' }, 'y'), '/tmp/new-fb')
  const snap = eng.snapshot()
  assert.equal(snap.fallbackActive, true)
  assert.equal(snap.state, 'fallback')
})

console.log('\ncore tests passed: ' + passed)
