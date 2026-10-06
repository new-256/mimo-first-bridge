// dynamic/host.js
//
// code.host body for the in-session (dynamic) Cordis plugin variant.
// Paste this verbatim into cordis_define({ code: { host: <this file> }, ... }).
//
// Self-contained (dynamic sandbox forbids import/require). Functionally
// equivalent to the persisted preset module in ../preset/mimo-first/.
//
// Registers mimo_run / mimo_continue / mimo_status model tools, the mimo-first
// prompt-policy section, the rate-limit/network fallback dialog
// (userQuestions.ask), and pushes status into the home mimoCollector service.

// ── 沙箱安全的运行时探测 ────────────────────────────────────────────────────
// dynamic 沙箱里 process 可能整体不存在，且禁止 import/require；因此这里只用
// 不抛错的 typeof 守卫读 env，绝不引入模块。探测链优先，最后的字面量仅作
// 【部署期默认值】兜底（分发到别的机器时改这两个常量，或设对应环境变量）。
const ENV = (typeof process !== 'undefined' && process && process.env) ? process.env : null
function envGet(k) { try { return ENV ? ENV[k] : undefined } catch (e) { return undefined } }

const MIMO_BIN = (function () {
  const cands = []
  const e1 = envGet('MIMO_BIN'); if (e1) cands.push(e1)
  const e2 = envGet('MIMO_CLI'); if (e2) cands.push(e2)
  const up = envGet('USERPROFILE')
  if (up) cands.push(up + '\\.mimocode\\bin\\mimo.exe')
  const hm = envGet('HOME')
  if (hm) { cands.push(hm + '\\.mimocode\\bin\\mimo.exe'); cands.push(hm + '/.mimocode/bin/mimo') }
  // 沙箱无 fs，无法 existsSync 校验；取第一个非空候选，否则交给 PATH 解析。
  return cands.length ? cands[0] : 'mimo'
})()

const CWD_FALLBACK = envGet('MIMO_MCP_CWD')
  || envGet('MIMO_BRIDGE_CWD')
  || envGet('USERPROFILE')
  || 'C:\\Users\\lcl\\Desktop\\DSH'
const FALLBACK_LABEL = '使用 DSH 本地 API 配置（回退）'
const RETRY_LABEL = '重试 mimo 一次'
const CANCEL_LABEL = '不回退（返回错误）'
const LIMIT_RE = /rate.?limit|ratelimit|429|too many|quota|insufficient|credit|balance|exhausted|exceed|network|offline|ENETUNREACH|ECONNREFUSED|ECONNRESET|ETIMEDOUT|EAI_AGAIN|ENOTFOUND|timeout|timed out|unavailable|503|502|500|401|403|unauthorized|invalid api|api key|connection|proxy|socket|tls|ssl|dns|free API service has ended|sign in|configure a third-party|网络|超时|限流|流量|受限|配额|金额|余额|额度|认证|连接|断开|登录|第三方/i
const MAX_TRAIL = 12
const MAX_ARG_LEN = 120
const MAX_PROJECTS = 12
const DEFAULT_TIMEOUT_SEC = 600
const HARD_TIMEOUT_GRACE_SEC = 60

function clampInt(v, def, min, max) { const n = Number(v); if (!Number.isFinite(n)) return def; const i = Math.floor(n); if (i < min) return min; if (i > max) return max; return i }
function shortLabel(p) { const s = String(p || '').replace(/\s+/g, ' ').trim(); return s.length > 80 ? s.slice(0, 77) + '...' : s }
function projectName(cwd) { const s = String(cwd || ''); const parts = s.split(/[\\/]/).filter(Boolean); return parts.length ? parts[parts.length - 1] : s }
function summarizeArgs(parameters) { if (!parameters || typeof parameters !== 'object') return undefined; const out = {}; for (const k of Object.keys(parameters)) { let v = parameters[k]; if (typeof v === 'string' && v.length > MAX_ARG_LEN) v = v.slice(0, MAX_ARG_LEN) + '…'; out[k] = v } return out }

// 与 core/mimo-core.mjs 的 SUCCESS_STATUSES 保持一致：ACCEPTED（异步受理）算成功。
const SUCCESS_STATUSES = ['SUCCESS', 'ACCEPTED']
function isSuccessStatus(status) { return !!status && SUCCESS_STATUSES.indexOf(String(status)) >= 0 }

function isLimited(res) {
  if (!res || res.ok) return false
  if (res.status === 'SPAWN_ERROR' || res.status === 'MIMO_UNAVAILABLE' || res.status === 'HUNG_TIMEOUT') return true
  const hay = String(res.stderr || '') + ' ' + String(res.response || '') + ' ' + String(res.status || '') + ' ' + String(res.errorMessage || '')
  return LIMIT_RE.test(hay)
}

function fallbackResult(res, mode) {
  return { ok: false, fallback: true, status: 'FALLBACK_TO_DSH', response: '', sessionId: (res && res.sessionId) || null, durationSeconds: null, numTurns: null, totalTokens: null, exitCode: res ? res.exitCode : null, mode: mode, stderr: res ? res.stderr : '', errorMessage: res ? res.errorMessage : '', reason: res ? res.status : 'unknown' }
}

function buildArgv(exe, args, planActive) {
  const timeoutSec = clampInt(args.timeoutSec, DEFAULT_TIMEOUT_SEC, 10, 3600)
  const argv = [exe, 'run']
  if (args.prompt != null && String(args.prompt).length) argv.push(String(args.prompt))
  argv.push('--format', 'json', '--dangerously-skip-permissions')
  let mode = args.mode || 'auto'
  if (mode === 'auto') mode = planActive ? 'plan' : 'build'
  if (mode === 'accept-edits') mode = 'build'
  const agent = args.agent || mode
  if (agent === 'plan' || agent === 'build' || agent === 'compose') argv.push('--agent', agent)
  if (args.model) argv.push('--model', String(args.model))
  let variant = args.variant || args.effort
  if (variant === 'low') variant = 'minimal'
  else if (variant === 'medium') variant = undefined
  if (variant) argv.push('--variant', String(variant))
  if (args.cwd) argv.push('--dir', String(args.cwd))
  if (args.sessionId) argv.push('--session', String(args.sessionId))
  else if (args.continueLatest) argv.push('--continue')
  if (args.title) argv.push('--title', String(args.title))
  return { argv, timeoutSec, mode: agent }
}

function parseMimoJson(stdoutText) {
  const trimmed = String(stdoutText || '').trim()
  if (!trimmed) return null
  const events = []
  const lines = trimmed.split(/\r?\n/)
  for (const raw of lines) {
    const ln = raw.trim()
    if (!ln.startsWith('{')) continue
    try { const obj = JSON.parse(ln); if (obj && typeof obj === 'object') events.push(obj) } catch (e) {}
  }
  if (!events.length) {
    try { const obj = JSON.parse(trimmed); if (obj && typeof obj === 'object') events.push(obj) }
    catch (e) { return { events: [], text: trimmed, sessionId: null, error: null, steps: [] } }
  }
  let sessionId = null
  let errorMessage = null
  let errorName = null
  let numTurns = 0
  let totalTokens = null
  const steps = []
  const textParts = []
  for (const ev of events) {
    if (ev.sessionID && typeof ev.sessionID === 'string') sessionId = ev.sessionID
    if (ev.sessionId && typeof ev.sessionId === 'string') sessionId = ev.sessionId
    if (ev.session && typeof ev.session === 'object' && ev.session.id) sessionId = ev.session.id
    const t = ev.type
    if (t === 'error') {
      const err = ev.error || ev.properties || {}
      errorMessage = (err.data && err.data.message) || err.message || err.name || 'error'
      errorName = err.name || 'Error'
    } else if (t === 'text' || t === 'message' || t === 'assistant' || t === 'output') {
      const p = ev.properties || ev
      const chunk = p.text || p.content || p.message || p.output || (typeof ev.text === 'string' ? ev.text : '')
      if (typeof chunk === 'string' && chunk) {
        textParts.push(chunk)
        steps.push({ at: Date.now(), kind: 'text', label: shortLabel(chunk) })
      }
    } else if (t === 'step-start' || t === 'step-finish' || t === 'step_update') {
      numTurns += 1
    } else if (t === 'tool' || t === 'tool-call' || t === 'tool_use') {
      const p = ev.properties || ev
      const name = p.tool || p.name || p.tool_name || 'tool'
      steps.push({ at: Date.now(), kind: 'tool', label: shortLabel(name + ' ' + JSON.stringify(summarizeArgs(p.arguments || p.args || p.input) || {})) })
    }
  }
  const text = textParts.length ? textParts.join('\n') : ''
  return { events, text, sessionId, error: errorMessage, errorName, numTurns, totalTokens, steps }
}

function buildResult(parsed, outcome, mode, stderrText, stdoutText) {
  const exitCode = outcome ? outcome.exitCode : null
  const errText = (parsed && parsed.error) ? String(parsed.error) : ''
  const stderr = (stderrText ? String(stderrText).slice(-2000) : '') + (errText ? (stderrText ? ' ' : '') + errText : '')
  const text = parsed && typeof parsed.text === 'string' ? parsed.text : ''
  const failed = exitCode !== 0 || !!(parsed && parsed.error)
  if (parsed) {
    return {
      ok: !failed && !!text,
      status: failed ? (parsed.errorName || 'ERROR') : (text ? 'SUCCESS' : 'EMPTY'),
      response: text,
      sessionId: parsed.sessionId || null,
      durationSeconds: null,
      numTurns: parsed.numTurns || null,
      totalTokens: parsed.totalTokens || null,
      exitCode,
      mode,
      stderr,
      errorMessage: parsed.error || '',
      steps: Array.isArray(parsed.steps) ? parsed.steps.slice(-MAX_TRAIL) : []
    }
  }
  return { ok: false, status: 'PARSE_ERROR', response: '', sessionId: null, durationSeconds: null, numTurns: null, totalTokens: null, exitCode, mode, stderr, errorMessage: '', rawStdout: String(stdoutText || '').slice(-2000) }
}

function foldStepUpdate(ev, trail) {
  if (!ev || typeof ev !== 'object') return
  const t = ev.type
  const p = ev.properties || ev
  let entry = null
  if (t === 'tool' || t === 'tool-call' || t === 'tool_use' || t === 'step_update') {
    const name = p.tool_name || p.tool || p.name
    if (name) entry = { at: Date.now(), kind: 'tool', label: shortLabel(name + ' ' + JSON.stringify(summarizeArgs(p.arguments || p.args || p.input) || {})), state: p.state || p.status || 'ACTIVE' }
  } else if (t === 'text' || t === 'message') {
    const chunk = p.text || p.content || ''
    if (typeof chunk === 'string' && chunk) entry = { at: Date.now(), kind: 'text', label: shortLabel(chunk) }
  } else if (t === 'error') {
    const err = p.error || p
    entry = { at: Date.now(), kind: 'error', label: shortLabel((err.data && err.data.message) || err.message || 'error') }
  }
  if (entry) { trail.push(entry); while (trail.length > MAX_TRAIL) trail.shift() }
}

function createLineStream() {
  let buf = ''
  return {
    push(chunk) {
      buf += String(chunk || '')
      const out = []
      let idx
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx).replace(/\r$/, '')
        buf = buf.slice(idx + 1)
        if (line.trim()) out.push(line)
      }
      return out
    },
    flush() { const line = buf.replace(/\r$/, ''); buf = ''; return line.trim() ? [line] : [] }
  }
}

return {
  inject: ['tools', 'subprocess', 'systemPrompt', 'timer'],
  apply(ctx) {
    const subprocess = ctx.subprocess
    const jobs = ctx.get('jobs')
    const planMode = ctx.get('planMode')
    const sandboxPolicy = ctx.get('sandboxPolicy')
    const userQuestions = ctx.get('userQuestions')
    const timer = ctx.timer

    const projects = Object.create(null)
    let seqCounter = 0 // 单调序号：墙钟毫秒撞车时用于判定「谁最近」
    const MAX_P = MAX_PROJECTS

    function ensureProject(cwd) {
      const key = String(cwd || CWD_FALLBACK)
      let p = projects[key]
      if (!p) {
        const keys = Object.keys(projects)
        if (keys.length >= MAX_P) {
          // 淘汰逻辑：宁可暂时超出上限，也绝不淘汰正在 running 的项目
          const idle = keys.filter((k) => projects[k].running === 0)
          if (idle.length) {
            const victim = idle.sort((a, b) => projects[a].updatedAt - projects[b].updatedAt)[0]
            delete projects[victim]
          }
        }
        p = { cwd: key, name: projectName(key), state: 'idle', running: 0, lastStatus: null, lastAt: 0, lastSessionId: null, fallbackActive: false, current: null, trail: [], runs: 0, totalTokens: 0, updatedAt: 0, seq: ++seqCounter }
        projects[key] = p
      }
      return p
    }

    function globalState() {
      const list = Object.keys(projects).map((k) => projects[k])
      let running = 0, lastStatus = null, lastAt = 0, lastSessionId = null, fallbackActive = false, current = null, trail = [], updatedAt = 0, runs = 0, totalTokens = 0
      for (const p of list) {
        running += p.running
        runs += p.runs
        totalTokens += p.totalTokens
        if (p.updatedAt > updatedAt) updatedAt = p.updatedAt
        if (p.running > 0) { if (!current && p.current) current = p.current }
        for (const e of p.trail) trail.push(e)
      }
      trail.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0))
      trail = trail.slice(-MAX_TRAIL)
      // 顶层聚合只认同「最近一次活动」的项目，不用 OR 聚合：一个陈旧回退项目会
      // 在当前项目成功时仍把整盏灯涂成琥珀。排序必须确定（updatedAt 主键、
      // lastAt 次键、cwd 稳定 tie-break），因为同毫秒可写入两个项目。
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
      const state = running > 0 ? 'running' : (lastStatus ? (isSuccessStatus(lastStatus) ? 'ok' : (fallbackActive ? 'fallback' : 'failed')) : (fallbackActive ? 'fallback' : 'idle'))
      return { state, running, lastStatus, lastAt, lastSessionId, fallbackActive, current, trail, updatedAt, runs, totalTokens }
    }

    function snapshot() {
      const g = globalState()
      const list = Object.keys(projects).map((k) => projects[k]).sort((a, b) => b.updatedAt - a.updatedAt)
      return {
        state: g.state, running: g.running, lastStatus: g.lastStatus, lastAt: g.lastAt, lastSessionId: g.lastSessionId, fallbackActive: g.fallbackActive, current: g.current, trail: g.trail, updatedAt: g.updatedAt, runs: g.runs, totalTokens: g.totalTokens,
        projects: list.map((p) => ({ cwd: p.cwd, name: p.name, state: p.state, running: p.running, current: p.current, trail: p.trail.slice(-MAX_TRAIL), lastStatus: p.lastStatus, lastAt: p.lastAt, lastSessionId: p.lastSessionId, fallbackActive: p.fallbackActive, runs: p.runs, totalTokens: p.totalTokens, updatedAt: p.updatedAt }))
      }
    }

    function publish() {
      try {
        const collector = ctx.get('mimoCollector')
        if (collector && typeof collector.mergeSnapshot === 'function') collector.mergeSnapshot(snapshot())
      } catch (e) {}
    }

    function begin(cwd) { const p = ensureProject(cwd); p.running += 1; p.state = 'running'; p.updatedAt = Date.now(); p.seq = ++seqCounter; publish() }
    function end(res, cwd) {
      const p = ensureProject(cwd)
      p.running = Math.max(0, p.running - 1)
      p.lastAt = Date.now(); p.seq = ++seqCounter
      p.lastStatus = res ? res.status : 'UNKNOWN'
      p.lastSessionId = res ? (res.sessionId || p.lastSessionId) : p.lastSessionId
      if (res && res.fallback) {
        p.fallbackActive = true
      } else if (p.running === 0) {
        p.fallbackActive = false
      }
      p.state = p.running > 0 ? 'running' : (p.fallbackActive ? 'fallback' : (isSuccessStatus(p.lastStatus) ? 'ok' : (p.lastStatus ? 'failed' : 'idle')))
      p.runs += 1
      if (res && typeof res.totalTokens === 'number') p.totalTokens += res.totalTokens
      p.updatedAt = Date.now(); p.seq = ++seqCounter
      publish()
    }
    function foldStep(cwd, ev) {
      const p = ensureProject(cwd)
      foldStepUpdate(ev, p.trail)
      if (ev && (ev.type === 'tool' || ev.type === 'step_update' || ev.type === 'text')) {
        const last = p.trail[p.trail.length - 1]
        p.current = last || p.current
      }
      p.updatedAt = Date.now(); p.seq = ++seqCounter
      publish()
    }

    function readStreams(handle) {
      let stdoutText = '', stderrText = ''
      try { stdoutText = handle && handle.stdout != null ? String(handle.stdout) : '' } catch (e) {}
      try { stderrText = handle && handle.stderr != null ? String(handle.stderr) : '' } catch (e) {}
      return { stdoutText, stderrText }
    }

    function startLiveParser(handle, cwd) {
      const stream = createLineStream()
      const drain = (chunk) => {
        const lines = stream.push(chunk)
        for (const line of lines) {
          try { const ev = JSON.parse(line); if (ev && typeof ev === 'object') foldStep(cwd, ev) } catch (e) {}
        }
      }
      try {
        if (handle && handle.stdout && typeof handle.stdout.on === 'function') handle.stdout.on('data', drain)
      } catch (e) {}
    }

    async function runSync(args, exec) {
      const cwd = String(args.cwd || (sandboxPolicy && sandboxPolicy.workspaceRoot) || CWD_FALLBACK)
      // 动态沙箱无 fs/import/fetch 之外的宿主能力，且 mimo-desktop 需要读
      // desktop-api.json（fs）——此形态下明确拒绝，而不是静默失败。
      if (String(args.backend || 'mimocode') === 'mimo-desktop') {
        const res = {
          ok: false,
          fallback: false,
          status: 'DESKTOP_UNSUPPORTED',
          response: '',
          sessionId: null,
          exitCode: null,
          mode: args.mode || 'auto',
          backend: 'mimo-desktop',
          stderr: 'mimo-desktop is unavailable in the dynamic Cordis form (sandbox has no fs/import).',
          errorMessage: 'mimo-desktop 需在 preset 或 MCP 形态使用（动态沙箱无 fs/import）。请改用 backend=mimocode，或安装 preset/家级形态后重试。'
        }
        begin(cwd)
        end(res, cwd)
        return res
      }
      const planActive = !!(planMode && (planMode.active || planMode.enabled))
      const built = buildArgv(MIMO_BIN, args, planActive)
      begin(cwd)
      let handle
      try {
        handle = subprocess.spawn({ argv: built.argv, cwd, stdio: [{ kind: 'null' }, { kind: 'pipe' }, { kind: 'pipe' }], graceMs: 5000 })
      } catch (e) {
        const res = { ok: false, status: 'SPAWN_ERROR', response: '', sessionId: null, exitCode: null, mode: built.mode, stderr: String(e && e.message || e), errorMessage: String(e && e.message || e) }
        end(res, cwd)
        return res
      }
      if (exec && exec.signal && handle && typeof handle.terminate === 'function') {
        try {
          if (typeof exec.signal.addEventListener === 'function') {
            exec.signal.addEventListener('abort', () => { try { handle.terminate() } catch (e) {} })
          }
        } catch (e) {}
      }
      const hardSec = built.timeoutSec + HARD_TIMEOUT_GRACE_SEC
      if (timer && typeof timer.timeout === 'function' && handle && typeof handle.terminate === 'function') {
        ctx.effect(() => timer.timeout(() => { try { handle.terminate() } catch (e) {} }, hardSec * 1000))
      }
      startLiveParser(handle, cwd)
      let outcome = null
      try { outcome = handle && handle.done ? await handle.done : null } catch (e) { outcome = { exitCode: -1, error: String(e && e.message || e) } }
      const { stdoutText, stderrText } = readStreams(handle)
      const parsed = parseMimoJson(stdoutText)
      const res = buildResult(parsed, outcome, built.mode, stderrText, stdoutText)
      end(res, cwd)
      return res
    }

    async function askFallback(agent, signal, res) {
      if (!userQuestions || typeof userQuestions.ask !== 'function') return 'error'
      try {
        const sel = await userQuestions.ask({
          id: 'mimo-fallback',
          title: 'mimo 受限 / 网络失败',
          question: 'mimo 调用失败（疑似限流/网络/认证）：\n' + shortLabel((res && (res.stderr || res.errorMessage || res.status)) || '') + '\n\n是否回退到 DSH 本地 API 配置继续完成本任务？',
          options: [
            { label: FALLBACK_LABEL, value: 'fallback' },
            { label: RETRY_LABEL, value: 'retry' },
            { label: CANCEL_LABEL, value: 'error' }
          ],
          agent, signal
        })
        const v = (sel && (sel.value || sel.label)) || sel
        if (String(v).indexOf(FALLBACK_LABEL) >= 0 || v === 'fallback') return 'fallback'
        if (String(v).indexOf(RETRY_LABEL) >= 0 || v === 'retry') return 'retry'
        return 'error'
      } catch (e) { return 'error' }
    }

    async function executeWithFallback(args, exec) {
      const cwd = String(args.cwd || (sandboxPolicy && sandboxPolicy.workspaceRoot) || CWD_FALLBACK)
      let res = await runSync(args, exec)
      let attempt = 1
      while (!res.ok && !res.fallback && isLimited(res) && attempt < 2) {
        const decision = await askFallback(exec ? exec.agent : undefined, exec ? exec.signal : undefined, res)
        if (decision === 'retry') { attempt += 1; res = await runSync(args, exec); continue }
        if (decision === 'fallback') { res = fallbackResult(res, res.mode); end(res, cwd); break }
        break
      }
      return res
    }

    async function coreExecute(args, exec) {
      const a = args || {}
      const background = a.background !== false && !!(jobs && typeof jobs.start === 'function')
      if (background) {
        const job = await jobs.start({
          kind: 'bash',
          owner: exec && exec.agent,
          run: async () => {
            let res
            try { res = await executeWithFallback(a, undefined) }
            catch (e) {
              res = { ok: false, status: 'ERROR', response: '', sessionId: null, stderr: String(e && e.message || e), errorMessage: String(e && e.message || e), mode: a.mode || 'auto' }
              end(res, a.cwd || CWD_FALLBACK)
            }
            return { cancel: () => {}, done: Promise.resolve(res) }
          }
        })
        const jobId = job && (job.id || job.jobId)
        return { ok: true, background: true, jobId: String(jobId), mode: a.mode || 'auto', note: 'mimo running in background; collect with job_output ' + String(jobId) + '.' }
      }
      return await executeWithFallback(a, exec)
    }

    function renderResult(args, v) {
      if (v && v.background) return [{ type: 'text', text: 'mimo dispatched in background (mode=' + v.mode + '). jobId=' + v.jobId + '. Collect with job_output.' }]
      if (v && v.fallback) return [{ type: 'text', text: 'status=FALLBACK_TO_DSH fallback=true\n' + (v.reason ? 'reason=' + v.reason + '\n' : '') + 'The user chose DSH-local. Finish with native tools and NEVER call mimo again for it.' }]
      if (!v || !v.ok) return [{ type: 'text', text: 'mimo_run failed: ' + shortLabel((v && (v.stderr || v.errorMessage || v.status)) || 'unknown') }]
      return [{ type: 'text', text: 'mimo ok status=' + v.status + (v.sessionId ? ' sessionId=' + v.sessionId : '') + '\n\n' + String(v.response || '') }]
    }

    function renderStatus(args, snap) {
      const s = snap || snapshot()
      const lines = ['mimo status: state=' + s.state + ' running=' + s.running + (s.lastStatus ? ' last=' + s.lastStatus : '') + (s.lastSessionId ? ' session=' + s.lastSessionId : '')]
      for (const p of (s.projects || [])) {
        lines.push('')
        lines.push('[' + p.name + '] ' + p.state + ' running=' + p.running + (p.lastStatus ? ' last=' + p.lastStatus : ''))
        if (p.current) lines.push('  current: ' + (p.current.label || ''))
        for (const e of (p.trail || []).slice(-5)) lines.push('  · ' + (e.label || ''))
      }
      return [{ type: 'text', text: lines.join('\n') }]
    }

    function renderSettings(args, v) {
      const s = v || {}
      const lines = [
        'mimo settings (dynamic sandbox)',
        '  settings file  : ' + (s.settingsPath || '(none — sandbox has no fs)'),
        '  file backend   : ' + (s.fileBackend || '(none)'),
        '  env backend    : ' + (s.envBackend || '(unset)'),
        '  effective      : ' + (s.effectiveBackend || '(unknown)'),
        '  desktop model  : ' + (s.desktopModel || '(default)'),
        '  desktop api    : unavailable (sandbox forbids fs/import)',
        '  backends       : ' + ((Array.isArray(s.backends) && s.backends.length ? s.backends.join(' | ') : 'mimocode | mimo-desktop'))
      ]
      if (s.note) lines.push('  note           : ' + s.note)
      return [{ type: 'text', text: lines.join('\n') }]
    }

    const OUT = { schema: { type: 'object', additionalProperties: true }, render: renderResult }
    const STATUS_OUT = { schema: { type: 'object', additionalProperties: true }, render: renderStatus }
    const SETTINGS_OUT = { schema: { type: 'object', additionalProperties: true }, render: renderSettings }

    harness.registerTool(ctx, harness.defineTool({
      name: 'mimo_run',
      description: 'Dispatch a coding/build/debug/investigation task to the local mimo agent CLI (Xiaomi MiMo Desktop / MiMoCode) and return its final answer. DSH fully controls mimo (--dangerously-skip-permissions; mimo never prompts). On rate-limit/network failure DSH pops a fallback dialog; fallback=true means finish with native tools. Runs in the background by default (returns a jobId immediately; collect with job_output); set background=false to block for the final answer. While it runs, call mimo_status to watch what mimo is doing live.',
      parameters: {
        prompt: { type: 'string', description: 'The task instruction for mimo. On first dispatch for a topic, include a compact CONTEXT preamble (goal, repo root, key paths, decisions/constraints; point at paths, do not paste file contents — mimo reads the repo itself). For follow-ups, use mimo_continue with latest=true or sessionId.', required: true },
        mode: { type: 'string', enum: ['auto', 'plan', 'build', 'compose', 'accept-edits'], description: 'auto follows DSH plan state; plan = read-only; build = full tools; compose = compose workflow.' },
        backend: { type: 'string', enum: ['mimocode', 'mimo-desktop'], description: 'mimocode (default) = local `mimo` CLI. mimo-desktop is NOT available in the dynamic Cordis form (sandbox has no fs/import) — it returns DESKTOP_UNSUPPORTED; use the preset or home-level form instead.' },
        model: { type: 'string', description: 'Optional mimo model id as provider/model.' },
        effort: { type: 'string', enum: ['low', 'medium', 'high'], description: 'Optional reasoning effort (mapped to --variant).' },
        cwd: { type: 'string', description: 'Working directory for mimo.' },
        timeoutSec: { type: 'integer', description: 'Hard timeout seconds (10-3600, default 600).' },
        background: { type: 'boolean', description: 'Defaults to true: dispatch returns a jobId immediately; collect with job_output. Set false to block.' },
        title: { type: 'string', description: 'Optional session title.' }
      },
      output: OUT,
      execute: function (args, exec) { return coreExecute(args || {}, exec) }
    }))

    harness.registerTool(ctx, harness.defineTool({
      name: 'mimo_continue',
      description: 'Continue an existing mimo session with a follow-up prompt. Pass sessionId or set latest=true. Same DSH-controlled, no-prompt execution and same fallback dialog as mimo_run.',
      parameters: {
        prompt: { type: 'string', description: 'Follow-up instruction. State only what is new; mimo preserves its conversation context.', required: true },
        sessionId: { type: 'string', description: 'mimo session id to resume.' },
        latest: { type: 'boolean', description: 'Continue the most recent mimo session.' },
        backend: { type: 'string', enum: ['mimocode', 'mimo-desktop'], description: 'mimocode (default). mimo-desktop is unavailable in the dynamic Cordis form (returns DESKTOP_UNSUPPORTED).' },
        mode: { type: 'string', enum: ['auto', 'plan', 'build', 'compose', 'accept-edits'] },
        model: { type: 'string' },
        effort: { type: 'string', enum: ['low', 'medium', 'high'] },
        cwd: { type: 'string' },
        timeoutSec: { type: 'integer' },
        background: { type: 'boolean' }
      },
      output: OUT,
      execute: function (args, exec) {
        const a = args || {}
        const mapped = { prompt: a.prompt, mode: a.mode, model: a.model, effort: a.effort, cwd: a.cwd, timeoutSec: a.timeoutSec, background: a.background, backend: a.backend }
        if (a.sessionId) mapped.sessionId = a.sessionId
        else if (a.latest) mapped.continueLatest = true
        return coreExecute(mapped, exec)
      }
    }))

    harness.registerTool(ctx, harness.defineTool({
      name: 'mimo_status',
      description: 'Read a live snapshot of what the local mimo agent is currently doing. Returns one section per project (working directory): running count, current step, recent step trail, last completed run status + session id. Call this to check on an in-flight mimo_run/mimo_continue without waiting for it to finish.',
      parameters: { cwd: { type: 'string', description: 'Optional: filter the snapshot to a single project.' } },
      output: STATUS_OUT,
      execute: function (args) {
        const a = args || {}
        const snap = snapshot()
        if (a.cwd) {
          const key = String(a.cwd)
          snap.projects = snap.projects.filter(function (p) { return p.cwd === key })
          const g = snap.projects[0]
          if (g) { snap.state = g.state; snap.running = g.running; snap.current = g.current; snap.trail = g.trail; snap.lastStatus = g.lastStatus; snap.lastAt = g.lastAt; snap.lastSessionId = g.lastSessionId; snap.fallbackActive = g.fallbackActive; snap.updatedAt = g.updatedAt }
        }
        return snap
      }
    }))

    harness.registerTool(ctx, harness.defineTool({
      name: 'mimo_settings',
      description: 'Read or inspect the preselected dispatch backend. In the dynamic Cordis form, settings are not persisted (sandbox has no fs); backend is determined by call arguments or environment variables.',
      parameters: {
        backend: { type: 'string', enum: ['mimocode', 'mimo-desktop'], description: 'If set, echo as selected backend (in-memory only in dynamic sandbox).' },
        desktopModel: { type: 'string', description: 'Optional desktop model id (echo only; desktop not supported in sandbox).' }
      },
      output: SETTINGS_OUT,
      execute: function (args) {
        const a = args || {}
        const effective = (a.backend && String(a.backend).trim()) || envGet('MIMO_BRIDGE_BACKEND') || envGet('MIMO_BACKEND') || 'mimocode'
        return {
          ok: true,
          settingsPath: null,
          fileBackend: null,
          configBackend: null,
          envBackend: envGet('MIMO_BRIDGE_BACKEND') || envGet('MIMO_BACKEND') || null,
          effectiveBackend: effective,
          desktopModel: a.desktopModel || null,
          desktopAvailable: false,
          desktopError: 'mimo-desktop is unavailable in the dynamic Cordis form (sandbox has no fs/import).',
          backends: ['mimocode', 'mimo-desktop'],
          note: 'dynamic 形态不持久化设置，backend 由工具参数或环境变量控制'
        }
      }
    }))

    const policyText = [
      'mimo-first execution policy (Xiaomi MiMo Desktop / MiMoCode local `mimo` CLI bridge).',
      '',
      'Local agent CLI "mimo" (Xiaomi MiMo Desktop) handles coding tasks under full DSH control (permissions auto-approved via --dangerously-skip-permissions, never prompts). By default, mimo runs in the background and returns a jobId immediately; collect results via job_output and watch live progress via mimo_status anytime.',
      '',
      'Decision table for tool selection:',
      '- Single read/glob/grep or short (<30s) command -> Native tools.',
      '- Implementing, editing, refactoring, debugging, builds, multi-file investigation -> mimo_run.',
      '- Follow-ups on the same topic -> mimo_continue (with latest=true or sessionId; mimo preserves session context).',
      '- Final build/test verification of mimo output -> Native tools.',
      '- Plan / read-only analysis -> mimo_run with mode=plan (maps to mimo --agent plan).',
      '',
      'Context protocol (one topic = one mimo session):',
      '- First dispatch on a topic: provide the task with a compact CONTEXT preamble (point to paths, do not paste file contents).',
      '- Follow-ups: call mimo_continue and state only what is new.',
      '',
      'Execution & Fallback protocol:',
      '- Dispatch defaults to background=true (set background=false only to block). Collect via job_output.',
      '- On rate-limit or network failure, a confirmation dialog opens in BOTH foreground and background while in flight.',
      '- If result has fallback=true (status FALLBACK_TO_DSH), the user chose DSH-local: finish with native tools and NEVER call mimo again for this task.',
      '- Never loop mimo calls; never ask mimo to call back into DSH.'
    ].join('\n')

    ctx.systemPrompt.section({
      name: 'mimo:policy',
      order: (typeof ctx.systemPrompt.getSectionOrder === 'function' ? ctx.systemPrompt.getSectionOrder('TOOL_SUBAGENT') : 2800) + 10,
      text: policyText
    })
  }
}
