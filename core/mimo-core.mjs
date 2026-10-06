// core/mimo-core.mjs — single source of truth for mimo-first-bridge.
//
// Pure functions + status engine + line stream + execution helpers.
// MUST NOT use process / env / import / require / AbortController / native
// timers so the same module can be:
//   - imported by the preset (real Node) and the MCP server
//   - text-injected into dynamic/host.js (sandbox forbids import)
//
// CLI contract (MiMoCode / Xiaomi MiMo Desktop agent CLI, binary `mimo`):
//   mimo run [message...] --format json --dangerously-skip-permissions
//            --agent build|plan|compose --model provider/model
//            --variant minimal|high|max --dir <cwd>
//            --session <id> | --continue
// There is NO --print-timeout: hard timeout is enforced by the host adapter.

export const MAX_TRAIL = 12
export const MAX_ARG_LEN = 120
export const MAX_PROJECTS = 12
export const DEFAULT_TIMEOUT_SEC = 600
export const HARD_TIMEOUT_GRACE_SEC = 60

// Rate-limit / network / auth failures that should open the DSH fallback dialog.
export const LIMIT_RE = /rate.?limit|ratelimit|429|too many|quota|insufficient|credit|balance|exhausted|exceed|network|offline|ENETUNREACH|ECONNREFUSED|ECONNRESET|ETIMEDOUT|EAI_AGAIN|ENOTFOUND|timeout|timed out|unavailable|503|502|500|401|403|unauthorized|invalid api|api key|connection|proxy|socket|tls|ssl|dns|free API service has ended|sign in|configure a third-party|网络|超时|限流|流量|受限|配额|金额|余额|额度|认证|连接|断开|登录|第三方/i

export const FALLBACK_LABEL = '使用 DSH 本地 API 配置（回退）'
export const RETRY_LABEL = '重试 mimo 一次'
export const CANCEL_LABEL = '不回退（返回错误）'

// ── backend selection (mimocode CLI vs Xiaomi MiMo Desktop client) ───────────
// 预选优先级：工具参数 backend > 插件 config.backend > 环境变量 > settings 文件 > 默认 mimocode
export const BACKEND_MIMOCODE = 'mimocode'
export const BACKEND_DESKTOP = 'mimo-desktop'
export const BACKENDS = [BACKEND_MIMOCODE, BACKEND_DESKTOP]
export const DEFAULT_BACKEND = BACKEND_MIMOCODE

export function normalizeBackend(v) {
  if (v == null || v === '') return null
  const s = String(v).trim().toLowerCase()
  if (s === 'mimocode' || s === 'mimo-code' || s === 'cli' || s === 'mimo-cli') return BACKEND_MIMOCODE
  if (s === 'mimo-desktop' || s === 'desktop' || s === 'mimo_desktop' || s === 'xiaomi-mimo' || s === 'xiaomi-mimo-desktop') return BACKEND_DESKTOP
  return null
}

/**
 * Resolve the dispatch backend.
 * @param {object} sources { argBackend, configBackend, envBackend, fileBackend }
 */
export function resolveBackend(sources) {
  const order = [sources && sources.argBackend, sources && sources.configBackend, sources && sources.envBackend, sources && sources.fileBackend]
  for (const raw of order) {
    const b = normalizeBackend(raw)
    if (b) return b
  }
  return DEFAULT_BACKEND
}

export function parseSettingsJson(text) {
  if (!text) return {}
  try {
    const o = JSON.parse(String(text))
    return o && typeof o === 'object' ? o : {}
  } catch (e) {
    return {}
  }
}

/** Desktop-local API (Xiaomi MiMo Desktop) request builders. */
export const DESKTOP_API = {
  healthPath: '/v1/health',
  sessionsPath: '/v1/sessions',
  turnsPath: (id) => '/v1/sessions/' + encodeURIComponent(String(id)) + '/turns',
  eventsPath: (id, dir) => '/v1/sessions/' + encodeURIComponent(String(id)) + '/events' + (dir ? ('?dir=' + encodeURIComponent(String(dir))) : '')
}

/**
 * Body for POST /v1/sessions/:id/turns (verified: message+model required; directory optional).
 */
export function buildDesktopTurnBody(args) {
  const a = args || {}
  const message = String(a.prompt != null ? a.prompt : (a.message != null ? a.message : ''))
  const model = String(a.model || a.desktopModel || 'mimo-auto')
  const body = { message, model }
  const directory = a.directory || a.cwd
  if (directory) body.directory = String(directory)
  return body
}

export function newDesktopSessionId() {
  // ses_ + 18-ish random chars, same shape as Desktop API ids
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789'
  let s = ''
  for (let i = 0; i < 18; i++) s += chars[Math.floor(Math.random() * chars.length)]
  return 'ses_' + s
}

export function parseDesktopEvents(stdoutOrJson) {
  // events endpoint may return JSON array/object or NDJSON/SSE-ish text
  const raw = String(stdoutOrJson || '').trim()
  if (!raw) return { text: '', sessionId: null, error: null }
  try {
    const j = JSON.parse(raw)
    return extractDesktopText(j)
  } catch (e) {}
  const texts = []
  for (const line of raw.split(/\r?\n/)) {
    const ln = line.trim()
    if (!ln.startsWith('{')) continue
    try {
      const r = extractDesktopText(JSON.parse(ln))
      if (r.text) texts.push(r.text)
      if (r.error) return { text: texts.join('\n'), sessionId: r.sessionId, error: r.error }
    } catch (e) {}
  }
  return { text: texts.join('\n'), sessionId: null, error: null }
}

function extractDesktopText(j) {
  if (!j || typeof j !== 'object') return { text: '', sessionId: null, error: null }
  const sessionId = j.sessionID || j.sessionId || (j.session && j.session.id) || null
  if (j.type === 'error' || j.error) {
    const err = j.error || j
    const msg = (err.data && err.data.message) || err.message || err.name || 'error'
    return { text: '', sessionId, error: String(msg) }
  }
  let text = ''
  if (typeof j.text === 'string') text = j.text
  else if (typeof j.message === 'string') text = j.message
  else if (typeof j.content === 'string') text = j.content
  else if (typeof j.response === 'string') text = j.response
  else if (Array.isArray(j.parts)) {
    for (const p of j.parts) {
      if (p && typeof p.text === 'string') text += (text ? '\n' : '') + p.text
    }
  } else if (j.data && typeof j.data.text === 'string') text = j.data.text
  return { text, sessionId, error: null }
}

export function clampInt(v, def, min, max) {
  const n = Number(v)
  if (!Number.isFinite(n)) return def
  const i = Math.floor(n)
  if (i < min) return min
  if (i > max) return max
  return i
}

export function shortLabel(p) {
  const s = String(p || '').replace(/\s+/g, ' ').trim()
  return s.length > 80 ? s.slice(0, 77) + '...' : s
}

export function projectName(cwd) {
  const s = String(cwd || '')
  const parts = s.split(/[\\/]/).filter(Boolean)
  return parts.length ? parts[parts.length - 1] : s
}

export function summarizeArgs(parameters) {
  if (!parameters || typeof parameters !== 'object') return undefined
  const out = {}
  for (const k of Object.keys(parameters)) {
    let v = parameters[k]
    if (typeof v === 'string' && v.length > MAX_ARG_LEN) v = v.slice(0, MAX_ARG_LEN) + '…'
    out[k] = v
  }
  return out
}

export function isLimited(res) {
  if (!res || res.ok) return false
  if (res.status === 'SPAWN_ERROR' || res.status === 'MIMO_UNAVAILABLE' || res.status === 'HUNG_TIMEOUT') return true
  const hay = String(res.stderr || '') + ' ' + String(res.response || '') + ' ' + String(res.status || '') + ' ' + String(res.errorMessage || '')
  return LIMIT_RE.test(hay)
}

// ── success classification ───────────────────────────────────────────────────
// The status light must NOT paint a healthy dispatch red. `mimo-desktop` accepts
// a turn asynchronously and reports ACCEPTED (HTTP 202) with no reply text yet —
// that is a SUCCESS, not a failure. Only these statuses map to the green "ok"
// state; everything else non-empty maps to "failed".
export const SUCCESS_STATUSES = ['SUCCESS', 'ACCEPTED']

export function isSuccessStatus(status) {
  if (!status) return false
  return SUCCESS_STATUSES.indexOf(String(status)) >= 0
}

export function fallbackResult(res, mode) {
  return {
    ok: false,
    fallback: true,
    status: 'FALLBACK_TO_DSH',
    response: '',
    sessionId: (res && res.sessionId) || null,
    durationSeconds: null,
    numTurns: null,
    totalTokens: null,
    exitCode: res ? res.exitCode : null,
    mode: mode,
    backend: res ? res.backend : null,
    stderr: res ? res.stderr : '',
    errorMessage: res ? res.errorMessage : '',
    reason: res ? res.status : 'unknown'
  }
}

/**
 * Map DSH/mimo tool args to a `mimo run` argv.
 * @param {string} exe  resolved mimo binary
 * @param {object} args { prompt, mode, model, variant|effort, cwd, sessionId, continueLatest, title, agent }
 * @param {boolean} planActive  true when DSH plan mode is active (mode:auto)
 */
export function buildArgv(exe, args, planActive) {
  const timeoutSec = clampInt(args.timeoutSec, DEFAULT_TIMEOUT_SEC, 10, 3600)
  const argv = [exe, 'run']
  if (args.prompt != null && String(args.prompt).length) argv.push(String(args.prompt))
  argv.push('--format', 'json', '--dangerously-skip-permissions')

  let mode = args.mode || 'auto'
  if (mode === 'auto') mode = planActive ? 'plan' : 'build'
  if (mode === 'accept-edits') mode = 'build'
  // mimo --agent: build | plan | compose
  const agent = args.agent || mode
  if (agent === 'plan' || agent === 'build' || agent === 'compose') argv.push('--agent', agent)

  if (args.model) argv.push('--model', String(args.model))

  // effort (low/medium/high) maps to mimo --variant; pass-through if already a variant name
  let variant = args.variant || args.effort
  if (variant === 'low') variant = 'minimal'
  else if (variant === 'medium') variant = undefined
  else if (variant === 'high') variant = 'high'
  if (variant) argv.push('--variant', String(variant))

  if (args.cwd) argv.push('--dir', String(args.cwd))
  if (args.sessionId) argv.push('--session', String(args.sessionId))
  else if (args.continueLatest) argv.push('--continue')
  if (args.title) argv.push('--title', String(args.title))

  return { argv, timeoutSec, mode: agent }
}

/**
 * Tolerant parser for `mimo run --format json` NDJSON events.
 * MiMoCode (OpenCode fork) emits typed events; we only need:
 *   sessionID / session id, assistant text, step trail, errors, final summary.
 */
export function parseMimoJson(stdoutText) {
  const trimmed = String(stdoutText || '').trim()
  if (!trimmed) return null

  const events = []
  const lines = trimmed.split(/\r?\n/)
  for (const raw of lines) {
    const ln = raw.trim()
    if (!ln.startsWith('{')) continue
    try {
      const obj = JSON.parse(ln)
      if (obj && typeof obj === 'object') events.push(obj)
    } catch (e) { /* tolerate log lines */ }
  }
  if (!events.length) {
    try {
      const obj = JSON.parse(trimmed)
      if (obj && typeof obj === 'object') events.push(obj)
    } catch (e) {
      return { events: [], text: trimmed, sessionId: null, error: null, steps: [] }
    }
  }

  let sessionId = null
  let text = ''
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
    if (ev.type === 'session' && ev.properties && ev.properties.id) sessionId = ev.properties.id

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
      const p = ev.properties || ev
      if (p.tokens && typeof p.tokens === 'object') {
        const tt = p.tokens.total ?? p.tokens.input ?? p.tokens.output
        if (typeof tt === 'number') totalTokens = (totalTokens || 0) + tt
      }
      if (t === 'step_update' && (p.tool_name || p.tool || p.name)) {
        steps.push({
          at: Date.now(),
          kind: 'tool',
          label: shortLabel((p.tool_name || p.tool || p.name) + ' ' + JSON.stringify(summarizeArgs(p.arguments || p.args || p.input) || {}))
        })
      }
    } else if (t === 'tool' || t === 'tool-call' || t === 'tool_use') {
      const p = ev.properties || ev
      const name = p.tool || p.name || p.tool_name || 'tool'
      steps.push({
        at: Date.now(),
        kind: 'tool',
        label: shortLabel(name + ' ' + JSON.stringify(summarizeArgs(p.arguments || p.args || p.input) || {}))
      })
    }
  }

  if (textParts.length) text = textParts.join('\n')
  else {
    // whole-string JSON fallback: try common result shapes
    const last = events[events.length - 1] || {}
    const r = last.result || last
    if (typeof r.response === 'string') text = r.response
    else if (typeof r.text === 'string') text = r.text
  }

  return { events, text, sessionId, error: errorMessage, errorName, numTurns, totalTokens, steps }
}

export function buildResult(parsed, outcome, mode, stderrText, stdoutText) {
  const exitCode = outcome ? outcome.exitCode : null
  const errText = (parsed && parsed.error) ? String(parsed.error) : ''
  const stderr = (stderrText ? String(stderrText).slice(-2000) : '') + (errText ? (stderrText ? ' ' : '') + errText : '')
  const text = parsed && typeof parsed.text === 'string' ? parsed.text : ''
  const failed = exitCode !== 0 || !!(parsed && parsed.error)
  const backend = (parsed && parsed.backend) || (outcome && outcome.backend) || null
  if (parsed) {
    return {
      ok: !failed && (!!text || parsed.accepted === true),
      status: failed ? (parsed.errorName || 'ERROR') : (parsed.accepted && !text ? 'ACCEPTED' : (text ? 'SUCCESS' : 'EMPTY')),
      response: text,
      sessionId: parsed.sessionId || null,
      durationSeconds: null,
      numTurns: parsed.numTurns || null,
      totalTokens: parsed.totalTokens || null,
      exitCode,
      mode,
      backend,
      stderr,
      errorMessage: parsed.error || '',
      accepted: parsed.accepted === true,
      steps: Array.isArray(parsed.steps) ? parsed.steps.slice(-MAX_TRAIL) : []
    }
  }
  return {
    ok: false,
    status: 'PARSE_ERROR',
    response: '',
    sessionId: null,
    durationSeconds: null,
    numTurns: null,
    totalTokens: null,
    exitCode,
    mode,
    backend,
    stderr,
    errorMessage: '',
    rawStdout: String(stdoutText || '').slice(-2000)
  }
}

export function desktopResult(ok, opts) {
  const o = opts || {}
  return {
    ok: !!ok,
    fallback: false,
    status: o.status || (ok ? (o.accepted ? 'ACCEPTED' : 'SUCCESS') : 'ERROR'),
    response: o.response || '',
    sessionId: o.sessionId || null,
    durationSeconds: null,
    numTurns: null,
    totalTokens: null,
    exitCode: o.exitCode != null ? o.exitCode : (ok ? 0 : 1),
    mode: o.mode || 'auto',
    backend: BACKEND_DESKTOP,
    stderr: o.stderr || '',
    errorMessage: o.errorMessage || '',
    accepted: o.accepted === true,
    steps: []
  }
}

/**
 * Fold a live step into a status trail entry.
 */
export function foldStepUpdate(ev, trail) {
  if (!ev || typeof ev !== 'object') return
  const t = ev.type
  const p = ev.properties || ev
  let entry = null
  if (t === 'tool' || t === 'tool-call' || t === 'tool_use' || t === 'step_update') {
    const name = p.tool_name || p.tool || p.name
    if (name) {
      entry = {
        at: Date.now(),
        kind: 'tool',
        label: shortLabel(name + ' ' + JSON.stringify(summarizeArgs(p.arguments || p.args || p.input) || {})),
        state: p.state || p.status || 'ACTIVE'
      }
    }
  } else if (t === 'text' || t === 'message') {
    const chunk = p.text || p.content || ''
    if (typeof chunk === 'string' && chunk) {
      entry = { at: Date.now(), kind: 'text', label: shortLabel(chunk) }
    }
  } else if (t === 'error') {
    const err = p.error || p
    entry = {
      at: Date.now(),
      kind: 'error',
      label: shortLabel((err.data && err.data.message) || err.message || 'error')
    }
  }
  if (entry) {
    trail.push(entry)
    while (trail.length > MAX_TRAIL) trail.shift()
  }
}

/** Cross-chunk half-line-safe NDJSON line splitter. */
export function createLineStream() {
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
    flush() {
      const line = buf.replace(/\r$/, '')
      buf = ''
      return line.trim() ? [line] : []
    }
  }
}

/**
 * Per-project status engine. Pure data; host adapters call begin/end/publish.
 */
export function createStatusEngine(opts) {
  const cwdFallback = (opts && opts.cwdFallback) || ''
  const projects = Object.create(null)
  const listeners = []
  // 单调递增序号：用于在墙钟毫秒撞车时判定「哪个项目最近活动」。
  let seqCounter = 0
  function touch(p) { p.seq = ++seqCounter; p.updatedAt = Date.now() }

  function ensureProject(cwd) {
    const key = String(cwd || cwdFallback)
    let p = projects[key]
    if (!p) {
      const keys = Object.keys(projects)
      if (keys.length >= MAX_PROJECTS) {
        // 淘汰逻辑：宁可暂时超出上限，也绝不淘汰正在 running 的项目
        const idle = keys.filter((k) => projects[k].running === 0)
        if (idle.length) {
          const victim = idle.sort((a, b) => projects[a].updatedAt - projects[b].updatedAt)[0]
          delete projects[victim]
        }
      }
      p = {
        cwd: key,
        name: projectName(key),
        state: 'idle',
        running: 0,
        current: null,
        trail: [],
        lastStatus: null,
        lastAt: 0,
        lastSessionId: null,
        lastOk: false,
        fallbackActive: false,
        runs: 0,
        totalTokens: 0,
        updatedAt: 0,
        // 单调序号：墙钟毫秒在同一毫秒内会撞车（两个项目可共享 lastAt/updatedAt），
        // 顶层聚合「谁最近」必须靠它才能确定，不依赖时钟分辨率。
        seq: ++seqCounter
      }
      projects[key] = p
    }
    return p
  }

  function globalState() {
    const list = Object.keys(projects).map((k) => projects[k])
    let running = 0, lastStatus = null, lastAt = 0, lastSessionId = null, fallbackActive = false
    let current = null, trail = [], updatedAt = 0, runs = 0, totalTokens = 0
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
    // 顶层聚合只认同「最近一次活动」的那个项目，不能用 OR 把任意历史项目的
    // fallbackActive 抬上来：否则一个早已回退的陈旧项目会永久把整盏灯涂成琥珀，
    // 即使当前项目刚刚成功（state=ok）也永远看不到绿色。
    // 排序必须确定：同一毫秒内两个项目都可能写入，故以单调 seq 为主键、
    // updatedAt 为次键、cwd 为最终稳定 tie-break。
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
      state: g.state,
      running: g.running,
      lastStatus: g.lastStatus,
      lastAt: g.lastAt,
      lastSessionId: g.lastSessionId,
      fallbackActive: g.fallbackActive,
      current: g.current,
      trail: g.trail,
      updatedAt: g.updatedAt,
      runs: g.runs,
      totalTokens: g.totalTokens,
      projects: list.map((p) => ({
        cwd: p.cwd,
        name: p.name,
        state: p.state,
        running: p.running,
        current: p.current,
        trail: p.trail.slice(-MAX_TRAIL),
        lastStatus: p.lastStatus,
        lastAt: p.lastAt,
        lastSessionId: p.lastSessionId,
        fallbackActive: p.fallbackActive,
        runs: p.runs,
        totalTokens: p.totalTokens,
        updatedAt: p.updatedAt
      }))
    }
  }

  function emit() {
    const snap = snapshot()
    for (const fn of listeners) {
      try { fn(snap) } catch (e) { /* listener errors must not break status */ }
    }
    return snap
  }

  return {
    snapshot,
    onSnapshot(fn) { listeners.push(fn) },
    begin(cwd) {
      const p = ensureProject(cwd)
      p.running += 1
      p.state = 'running'
      p.current = null
      touch(p)
      return emit()
    },
    setProject(cwd, patch) {
      const p = ensureProject(cwd)
      if (patch.current !== undefined) p.current = patch.current
      touch(p)
      if (patch.updatedAt !== undefined) p.updatedAt = patch.updatedAt
      return emit()
    },
    foldStep(cwd, ev) {
      const p = ensureProject(cwd)
      foldStepUpdate(ev, p.trail)
      if (ev && (ev.type === 'tool' || ev.type === 'step_update' || ev.type === 'text')) {
        const last = p.trail[p.trail.length - 1]
        p.current = last || p.current
      }
      touch(p)
      return emit()
    },
    end(res, cwd) {
      const p = ensureProject(cwd)
      p.running = Math.max(0, p.running - 1)
      p.lastAt = Date.now()
      p.lastStatus = res ? res.status : 'UNKNOWN'
      p.lastSessionId = res ? (res.sessionId || p.lastSessionId) : p.lastSessionId
      p.lastOk = !!(res && res.ok)
      if (res && res.fallback) {
        p.fallbackActive = true
      } else if (p.running === 0) {
        p.fallbackActive = false
      }
      p.state = p.running > 0
        ? 'running'
        : (p.fallbackActive
            ? 'fallback'
            : (isSuccessStatus(p.lastStatus) ? 'ok' : (p.lastStatus ? 'failed' : 'idle')))
      p.runs += 1
      if (res && typeof res.totalTokens === 'number') p.totalTokens += res.totalTokens
      p.current = p.running > 0 ? p.current : null
      touch(p)
      return emit()
    },
    mergeExternal(list) {
      // Merge MCP / external project snapshots (same cwd overwrites when newer).
      if (!Array.isArray(list)) return
      for (const src of list) {
        if (!src || !src.cwd) continue
        const p = ensureProject(src.cwd)
        const srcAt = Number(src.updatedAt) || 0
        // G 项：有明确时间戳且更旧就丢弃，避免旧快照覆盖本地较新状态
        if (srcAt && srcAt < p.updatedAt) continue
        if (typeof src.running === 'number') p.running = src.running
        if (src.current !== undefined) p.current = src.current
        if (Array.isArray(src.trail)) p.trail = src.trail.slice(-MAX_TRAIL)
        if (src.lastStatus) p.lastStatus = src.lastStatus
        if (src.lastAt) p.lastAt = Number(src.lastAt) || p.lastAt
        if (src.lastSessionId) p.lastSessionId = src.lastSessionId
        if (src.fallbackActive !== undefined) p.fallbackActive = !!src.fallbackActive
        if (typeof src.runs === 'number') p.runs = src.runs
        if (typeof src.totalTokens === 'number') p.totalTokens = src.totalTokens
        // C 项：派生 state 本地重算（对齐 home-plugin host 半），避免盲信外部 state 导致 ACCEPTED 误判
        if (src.state === 'running' || p.running > 0) p.state = 'running'
        else p.state = isSuccessStatus(p.lastStatus) ? 'ok' : (p.fallbackActive ? 'fallback' : (p.lastStatus ? 'failed' : 'idle'))
        // 先取 seq/updatedAt 基线再 bump：外部快照也要推进「最近活动」序号，
        // 否则合并进来的新状态无法参与顶层聚合的先后判定。
        touch(p)
        if (srcAt) p.updatedAt = srcAt
      }
      return emit()
    },
    clearFallback() {
      for (const k of Object.keys(projects)) {
        projects[k].fallbackActive = false
        if (projects[k].state === 'fallback') projects[k].state = projects[k].running > 0 ? 'running' : 'idle'
      }
      return emit()
    }
  }
}

export const POLICY_TEXT = [
  'mimo-first execution policy (Xiaomi MiMo: MiMoCode CLI or MiMo Desktop client).',
  '',
  'Local backends (selectable in settings: backend = mimocode | mimo-desktop):',
  '- mimocode (default): local `mimo` CLI (MiMoCode). Full DSH control (--dangerously-skip-permissions, never prompts).',
  '- mimo-desktop: Xiaomi MiMo Desktop client local API (running Desktop app; uses its login/model/session UI).',
  '',
  'By default, dispatch runs in the background and returns a jobId immediately; collect via job_output and watch live progress via mimo_status.',
  '',
  'Decision table for tool selection:',
  '- Single read/glob/grep or short (<30s) command -> Native tools.',
  '- Implementing, editing, refactoring, debugging, builds, multi-file investigation -> mimo_run.',
  '- Follow-ups on the same topic -> mimo_continue (with latest=true or sessionId; context is preserved).',
  '- Final build/test verification of mimo output -> Native tools.',
  '- Plan / read-only analysis -> mimo_run with mode=plan.',
  '- Desktop-native work (Desktop session UI, shared Desktop login/model) -> prefer backend=mimo-desktop (or preselect it in settings).',
  '',
  'Backend preselection (settings):',
  '- Default backend is configured OUT-OF-BAND (plugin config.backend / env MIMO_BRIDGE_BACKEND / settings file).',
  '- Per-call `backend` argument overrides the default only when necessary.',
  '- Do NOT invent a backend every call — use the preselected default.',
  '',
  'Context protocol (one topic = one mimo session):',
  '- First dispatch on a topic: compact CONTEXT preamble (point to paths, do not paste file contents).',
  '- Follow-ups: call mimo_continue and state only what is new.',
  '',
  'Execution & Fallback protocol:',
  '- Dispatch defaults to background=true. Collect via job_output.',
  '- On rate-limit/network/auth failure, a confirmation dialog offers DSH-local fallback.',
  '- If result has fallback=true (status FALLBACK_TO_DSH), finish with native tools and NEVER call mimo again for this task.',
  '- Never loop mimo calls; never ask mimo to call back into DSH.'
].join('\n')
