// mimo-first-bridge — self-contained Cordis plugin for an authored agent preset.
//
// Registers model tools (mimo_run, mimo_continue, mimo_status) that dispatch
// work to the local `mimo` CLI (Xiaomi MiMo Desktop / MiMoCode), and injects
// an "mimo-first" priority prompt section. DSH fully controls mimo: every
// invocation runs with --dangerously-skip-permissions so mimo never prompts.
//
// Imported by the cordis loader as an ESM plugin (named exports `name`,
// `inject`, `apply`). Intentionally dependency-free beyond ./mimo-core.mjs:
// a locally authored preset lives under the user home and must NOT import
// any @deepseek-ai/* package.

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
  BACKEND_MIMOCODE,
  BACKEND_DESKTOP,
  newDesktopSessionId,
  POLICY_TEXT,
  FALLBACK_LABEL,
  RETRY_LABEL,
  CANCEL_LABEL,
  HARD_TIMEOUT_GRACE_SEC
} from './mimo-core.mjs'
import {
  loadRuntime,
  desktopHealth,
  desktopSendTurn,
  desktopReadEvents,
  desktopListSessions,
  loadSettingsFile,
  saveSettingsFile
} from './runtime-settings.mjs'
import { existsSync } from 'node:fs'

export const name = 'mimo-first-bridge'
export const inject = ['tools', 'subprocess', 'systemPrompt', 'timer']

const CWD_FALLBACK = (typeof process !== 'undefined' && process.env && (process.env.MIMO_MCP_CWD || process.env.MIMO_BRIDGE_CWD))
  || (typeof process !== 'undefined' && process.cwd && process.cwd())
  || '.'

function resolveMimoExe() {
  const env = (typeof process !== 'undefined' && process.env) || {}
  const candidates = []
  if (env.MIMO_BIN) candidates.push(env.MIMO_BIN)
  if (env.MIMO_CLI) candidates.push(env.MIMO_CLI)
  if (env.USERPROFILE) candidates.push(env.USERPROFILE + '\\.mimocode\\bin\\mimo.exe')
  if (env.HOME) {
    candidates.push(env.HOME + '\\.mimocode\\bin\\mimo.exe')
    candidates.push(env.HOME + '/.mimocode/bin/mimo')
  }
  for (const exe of candidates) {
    try { if (exe && existsSync(exe)) return exe } catch (e) {}
  }
  return 'mimo'
}

const OUTPUT_SCHEMA = { type: 'object', additionalProperties: true }

export function apply(ctx, config) {
  const cfg = config || {}
  const subprocess = ctx.subprocess
  const jobs = ctx.get('jobs')
  const planMode = ctx.get('planMode')
  const sandboxPolicy = ctx.get('sandboxPolicy')
  const userQuestions = ctx.get('userQuestions')
  const timer = ctx.timer

  // 预选 backend：settings 文件 / env / 插件 config（apply 第二参）/ 工具参数
  const runtime = loadRuntime({ configBackend: cfg.backend, config: cfg })
  const defaultBackend = runtime.backend

  const engine = createStatusEngine({
    cwdFallback: (sandboxPolicy && sandboxPolicy.workspaceRoot) || CWD_FALLBACK
  })

  function publish() {
    const snap = engine.snapshot()
    snap.defaultBackend = defaultBackend
    try { ctx.emit('mimo/status', { snapshot: snap }) } catch (e) {}
    try {
      const collector = ctx.get('mimoCollector')
      if (collector && typeof collector.mergeSnapshot === 'function') collector.mergeSnapshot(snap)
    } catch (e) {}
  }
  engine.onSnapshot(() => publish())

  try {
    ctx.emit('mimo/mode', { active: true, backend: defaultBackend })
    if (timer && typeof timer.interval === 'function') {
      ctx.effect(() => timer.interval(() => {
        try { ctx.emit('mimo/mode', { active: true, backend: defaultBackend }) } catch (e) {}
      }, 30 * 1000))
    }
  } catch (e) {}

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
        try {
          const ev = JSON.parse(line)
          if (ev && typeof ev === 'object') engine.foldStep(cwd, ev)
        } catch (e) {}
      }
    }
    try {
      if (handle && handle.stdout && typeof handle.stdout.on === 'function') {
        handle.stdout.on('data', drain)
      }
    } catch (e) {}
  }

  async function runDesktop(args) {
    const cwd = String(args.cwd || (sandboxPolicy && sandboxPolicy.workspaceRoot) || CWD_FALLBACK)
    const sessionId = args.sessionId || args.continueLatest && runtime.settings.lastDesktopSessionId || newDesktopSessionId()
    engine.begin(cwd)
    try {
      const health = await desktopHealth(runtime)
      if (!health.ok) {
        const res = desktopResult(false, {
          status: 'DESKTOP_UNAVAILABLE',
          sessionId,
          mode: args.mode || 'auto',
          stderr: String(health.error || health.body || 'desktop api not ready'),
          errorMessage: 'MiMo Desktop client unavailable. Start Xiaomi MiMo Desktop and retry, or set backend=mimocode.'
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
      // 是否存在。必须以 turn.delivered（回读会话列表确认目标 id 存在）为准。
      const okTurn = turn.delivered === true
      let text = ''
      if (okTurn) {
        try {
          const ev = await desktopReadEvents(runtime, sessionId, cwd, 2500)
          text = ev.text || ''
        } catch (e) {}
      }
      const res = desktopResult(okTurn, {
        status: okTurn ? (text ? 'SUCCESS' : 'ACCEPTED') : 'DESKTOP_SESSION_NOT_CREATED',
        response: text || (okTurn
          ? '(Desktop turn accepted; watch Desktop UI or call mimo_continue for the reply)'
          : ''),
        sessionId,
        accepted: okTurn,
        mode: args.mode || 'auto',
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
        mode: args.mode || 'auto',
        stderr: String(e && e.message || e),
        errorMessage: String(e && e.message || e)
      })
      engine.end(res, cwd)
      return res
    }
  }

  async function runSync(args, exec) {
    const backend = args.backend || defaultBackend
    if (backend === BACKEND_DESKTOP) return await runDesktop(args)
    const cwd = String(args.cwd || (sandboxPolicy && sandboxPolicy.workspaceRoot) || CWD_FALLBACK)
    const planActive = !!(planMode && (planMode.active || planMode.enabled))
    const built = buildArgv(resolveMimoExe(), args, planActive)
    engine.begin(cwd)

    let handle
    try {
      handle = subprocess.spawn({
        argv: built.argv,
        cwd,
        stdio: [{ kind: 'null' }, { kind: 'pipe' }, { kind: 'pipe' }],
        graceMs: 5000
      })
    } catch (e) {
      const res = {
        ok: false,
        status: 'SPAWN_ERROR',
        response: '',
        sessionId: null,
        exitCode: null,
        mode: built.mode,
        stderr: String(e && e.message || e),
        errorMessage: String(e && e.message || e)
      }
      engine.end(res, cwd)
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
      ctx.effect(() => timer.timeout(() => {
        try { handle.terminate() } catch (e) {}
      }, hardSec * 1000))
    }

    startLiveParser(handle, cwd)

    let outcome = null
    try {
      outcome = handle && handle.done ? await handle.done : null
    } catch (e) {
      outcome = { exitCode: -1, error: String(e && e.message || e) }
    }

    const { stdoutText, stderrText } = readStreams(handle)
    const parsed = parseMimoJson(stdoutText)
    const res = buildResult(parsed, outcome, built.mode, stderrText, stdoutText)
    engine.end(res, cwd)
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
        agent,
        signal
      })
      const v = (sel && (sel.value || sel.label)) || sel
      if (String(v).indexOf(FALLBACK_LABEL) >= 0 || v === 'fallback') return 'fallback'
      if (String(v).indexOf(RETRY_LABEL) >= 0 || v === 'retry') return 'retry'
      return 'error'
    } catch (e) {
      return 'error'
    }
  }

  async function executeWithFallback(args, exec) {
    const cwd = String(args.cwd || (sandboxPolicy && sandboxPolicy.workspaceRoot) || CWD_FALLBACK)
    let res = await runSync(args, exec)
    // 显式单次重试语义：初次受限询问一次；若选 retry 则重试；重试后若仍受限进行最终询问
    for (let attempt = 1; attempt <= 2; attempt++) {
      if (res.ok || res.fallback || !isLimited(res)) break
      const decision = await askFallback(exec ? exec.agent : undefined, exec ? exec.signal : undefined, res)
      if (decision === 'fallback') {
        res = fallbackResult(res, res.mode)
        engine.end(res, cwd)
        break
      }
      if (decision === 'retry') {
        if (attempt < 2) {
          res = await runSync(args, exec)
          continue
        }
        if (res && typeof res === 'object') {
          res.errorMessage = (res.errorMessage ? res.errorMessage + ' ' : '') + '(已达重试上限)'
        }
        break
      }
      break
    }
    return res
  }

  async function coreExecute(args, exec) {
    const a = args || {}
    const cwd = String(a.cwd || (sandboxPolicy && sandboxPolicy.workspaceRoot) || CWD_FALLBACK)
    const background = a.background !== false && !!(jobs && typeof jobs.start === 'function')

    if (background) {
      const job = await jobs.start({
        kind: 'bash',
        owner: exec && exec.agent,
        run: async () => {
          let res
          try {
            res = await executeWithFallback(a, undefined)
          } catch (e) {
            res = {
              ok: false,
              status: 'ERROR',
              response: '',
              sessionId: null,
              stderr: String(e && e.message || e),
              errorMessage: String(e && e.message || e),
              mode: a.mode || 'auto'
            }
            engine.end(res, cwd)
          }
          return { cancel: () => {}, done: Promise.resolve(res) }
        }
      })
      const jobId = job && (job.id || job.jobId)
      return {
        ok: true,
        background: true,
        jobId: String(jobId),
        mode: a.mode || 'auto',
        note: 'mimo running in background; collect with job_output ' + String(jobId) + '. Failures open the fallback dialog while the job is in flight; collect with job_output to see the outcome (fallback=true means the user chose DSH-local).'
      }
    }

    return await executeWithFallback(a, exec)
  }

  function renderResult(args, v) {
    const b = v && v.backend ? ' backend=' + v.backend : ''
    if (v && v.background) {
      return [{
        type: 'text',
        text: 'mimo dispatched in background (mode=' + v.mode + b + '). jobId=' + v.jobId + '. Collect with job_output. Failures open the fallback dialog while the job is in flight; collect with job_output to see the outcome (fallback=true means the user chose DSH-local).'
      }]
    }
    if (v && v.fallback) {
      return [{
        type: 'text',
        text: 'status=FALLBACK_TO_DSH fallback=true' + b + '\n' + (v.reason ? 'reason=' + v.reason + '\n' : '') + 'The user chose DSH-local. Finish this task with native DSH tools and NEVER call mimo again for it.'
      }]
    }
    if (!v || !v.ok) {
      const err = (v && (v.stderr || v.errorMessage || v.status)) || 'unknown error'
      return [{ type: 'text', text: 'mimo_run failed' + b + ': ' + shortLabel(err) }]
    }
    const head = 'mimo ok status=' + v.status + b + (v.sessionId ? ' sessionId=' + v.sessionId : '')
    return [{ type: 'text', text: head + '\n\n' + String(v.response || '') }]
  }

  function renderStatus(args, snap) {
    const s = snap || engine.snapshot()
    const lines = [
      'mimo status: state=' + s.state + ' running=' + s.running +
        (s.lastStatus ? ' last=' + s.lastStatus : '') +
        (s.lastSessionId ? ' session=' + s.lastSessionId : '') +
        (s.runs ? ' runs=' + s.runs : '') +
        (s.totalTokens ? ' tokens=' + s.totalTokens : '')
    ]
    for (const p of (s.projects || [])) {
      lines.push('')
      lines.push('[' + p.name + '] ' + p.state + ' running=' + p.running + (p.lastStatus ? ' last=' + p.lastStatus : '') + (p.lastSessionId ? ' session=' + p.lastSessionId : ''))
      if (p.current) lines.push('  current: ' + (p.current.label || JSON.stringify(p.current)))
      for (const e of (p.trail || []).slice(-5)) lines.push('  · ' + (e.label || ''))
      if (p.runs || p.totalTokens) lines.push('  usage: runs=' + (p.runs || 0) + ' tokens=' + (p.totalTokens || 0))
    }
    return [{ type: 'text', text: lines.join('\n') }]
  }

  function renderSettings(args, v) {
    const s = v || {}
    const lines = [
      'mimo settings',
      '  settings file  : ' + (s.settingsPath || '(unknown)'),
      '  file backend   : ' + (s.fileBackend || '(unset)'),
      '  config backend : ' + (s.configBackend || '(unset)'),
      '  env backend    : ' + (s.envBackend || '(unset)'),
      '  effective      : ' + (s.effectiveBackend || '(unknown)'),
      '  desktop model  : ' + (s.desktopModel || '(default)'),
      '  desktop api    : ' + (s.desktopAvailable
        ? 'available' + (s.desktopApiFile ? ' (' + s.desktopApiFile + ')' : '')
        : 'unavailable' + (s.desktopError ? ' — ' + s.desktopError : '')),
      '  backends       : ' + ((Array.isArray(s.backends) && s.backends.length ? s.backends.join(' | ') : 'mimocode | mimo-desktop'))
    ]
    if (s.note) lines.push('  note           : ' + s.note)
    return [{ type: 'text', text: lines.join('\n') }]
  }

  const OUT = { schema: OUTPUT_SCHEMA, render: renderResult }
  const STATUS_OUT = { schema: OUTPUT_SCHEMA, render: renderStatus }
  const SETTINGS_OUT = { schema: OUTPUT_SCHEMA, render: renderSettings }

  ctx.tools.register({
    name: 'mimo_run',
    description: 'Dispatch a coding/build/debug/investigation task to the local mimo agent CLI (Xiaomi MiMo Desktop / MiMoCode) and return its final answer. DSH fully controls mimo (--dangerously-skip-permissions; mimo never prompts). On rate-limit/network failure DSH pops a fallback dialog; fallback=true means finish with native tools. Runs in the background by default (returns a jobId immediately; collect with job_output); set background=false to block for the final answer. While it runs, call mimo_status to watch what mimo is doing live.',
    parameters: {
      prompt: {
        type: 'string',
        description: 'The task instruction for mimo. On first dispatch for a topic, include a compact CONTEXT preamble (goal, repo root, key paths, decisions/constraints; point at paths, do not paste file contents — mimo reads the repo itself). For follow-ups on the same topic, use mimo_continue with latest=true or sessionId (mimo keeps conversation context; state only what is new).',
        required: true
      },
      mode: {
        type: 'string',
        enum: ['auto', 'plan', 'build', 'compose', 'accept-edits'],
        description: 'auto follows DSH plan state (plan vs build); plan = read-only analysis (--agent plan); build = full tools (--agent build); compose = compose workflow.'
      },
      backend: {
        type: 'string',
        enum: BACKENDS,
        description: 'Dispatch backend for THIS call only. Default comes from settings preselection (plugin config.backend / MIMO_BRIDGE_BACKEND / settings file): mimocode = local `mimo` CLI (MiMoCode); mimo-desktop = Xiaomi MiMo Desktop client local API. Prefer the preselected default; override only when necessary.'
      },
      model: { type: 'string', description: 'Optional mimo model id as provider/model (e.g. mimo/mimo). For mimo-desktop, desktop model id (e.g. mimo-auto).' },
      effort: { type: 'string', enum: ['low', 'medium', 'high'], description: 'Optional reasoning effort, mapped to mimo --variant (low→minimal, high→high). mimocode only.' },
      cwd: { type: 'string', description: 'Working directory for mimo (--dir / desktop directory).' },
      timeoutSec: { type: 'integer', description: 'Hard timeout seconds (10-3600, default 600). Grace +60s on top.' },
      background: { type: 'boolean', description: 'Defaults to true: dispatch returns a jobId immediately; collect with job_output, watch progress with mimo_status. Set false to block for the final answer.' },
      // desktop 后端**不能创建会话**（API 对任意 id 都回 202 但不落库），所以必须能
      // 显式指定一个**已存在**的 Desktop 会话 id，否则每次都生成自造 id → 静默空操作。
      sessionId: { type: 'string', description: 'mimo-desktop only: id of an ALREADY EXISTING MiMo Desktop session (see the Desktop app). Omit for mimocode.' },
      title: { type: 'string', description: 'Optional session title.' }
    },
    output: OUT,
    execute: (args, exec) => coreExecute(args || {}, exec)
  })

  ctx.tools.register({
    name: 'mimo_continue',
    description: 'Continue an existing mimo session with a follow-up prompt. Pass sessionId or set latest=true. Same DSH-controlled, no-prompt execution and same fallback dialog as mimo_run.',
    parameters: {
      prompt: { type: 'string', description: 'Follow-up instruction for the ongoing mimo session. State only what is new; mimo preserves its conversation context.', required: true },
      sessionId: { type: 'string', description: 'mimo session id to resume (--session).' },
      latest: { type: 'boolean', description: 'Continue the most recent mimo session (--continue).' },
      backend: { type: 'string', enum: BACKENDS, description: 'Dispatch backend for THIS call only (see mimo_run.backend). Prefer the preselected default.' },
      mode: { type: 'string', enum: ['auto', 'plan', 'build', 'compose', 'accept-edits'], description: 'Execution mode.' },
      model: { type: 'string', description: 'Optional mimo model id as provider/model.' },
      effort: { type: 'string', enum: ['low', 'medium', 'high'], description: 'Optional reasoning effort.' },
      cwd: { type: 'string', description: 'Working directory for mimo.' },
      timeoutSec: { type: 'integer', description: 'Hard timeout seconds (10-3600, default 600).' },
      background: { type: 'boolean', description: 'Defaults to true (background job).' }
    },
    output: OUT,
    execute: (args, exec) => {
      const a = args || {}
      const mapped = {
        prompt: a.prompt,
        mode: a.mode,
        model: a.model,
        effort: a.effort,
        cwd: a.cwd,
        timeoutSec: a.timeoutSec,
        background: a.background,
        backend: a.backend,
        // 【关键】desktop 后端的 sessionId 必须转发（白名单转发漏了它会导致
        // mimo_run 传 sessionId 被静默丢弃 → 永远造新 id → desktop 后端不可用）。
        sessionId: a.sessionId
      }
      if (a.sessionId) mapped.sessionId = a.sessionId
      else if (a.latest) mapped.continueLatest = true
      return coreExecute(mapped, exec)
    }
  })

  ctx.tools.register({
    name: 'mimo_settings',
    description: 'Read or change the preselected dispatch backend (settings). backend=mimocode (local mimo CLI / MiMoCode) or mimo-desktop (Xiaomi MiMo Desktop client). Call with only backend to set the default for subsequent mimo_run/mimo_continue; call with no args to read current settings. Persisted to the settings file; plugin config and MIMO_BRIDGE_BACKEND env still override when set.',
    parameters: {
      backend: { type: 'string', enum: BACKENDS, description: 'If set, save this as the default backend.' },
      desktopModel: { type: 'string', description: 'Optional desktop model id (mimo-desktop backend only), e.g. mimo-auto.' }
    },
    output: SETTINGS_OUT,
    execute: (args) => {
      const a = args || {}
      const file = loadSettingsFile()
      const data = Object.assign({}, file.data || {})
      if (a.backend) data.backend = a.backend
      if (a.desktopModel) data.desktopModel = a.desktopModel
      if (a.backend || a.desktopModel) {
        try { saveSettingsFile(data) } catch (e) {
          return [{ type: 'text', text: 'mimo_settings save failed: ' + String(e && e.message || e) }]
        }
      }
      const rt = loadRuntime({ configBackend: cfg.backend, config: cfg })
      return {
        settingsPath: rt.settingsPath,
        fileBackend: data.backend || null,
        configBackend: cfg.backend || null,
        envBackend: process.env.MIMO_BRIDGE_BACKEND || process.env.MIMO_BACKEND || null,
        effectiveBackend: rt.backend,
        desktopModel: rt.desktopModel,
        desktopAvailable: !!(rt.desktop && rt.desktop.available),
        desktopError: rt.desktop && rt.desktop.error || null,
        desktopApiFile: rt.desktop && rt.desktop.apiFile || null,
        backends: BACKENDS,
        note: 'Preselect via settings file / plugin config.backend / MIMO_BRIDGE_BACKEND. Per-call `backend` overrides only that call.'
      }
    }
  })

  ctx.tools.register({
    name: 'mimo_status',
    description: 'Read a live snapshot of what the local mimo agent is currently doing. Returns one section per project (working directory): running count, current step, recent step trail, last completed run status + session id, per-project runs/token usage. Call this to check on an in-flight mimo_run/mimo_continue without waiting for it to finish.',
    parameters: {
      cwd: { type: 'string', description: 'Optional: filter the snapshot to a single project (working directory).' }
    },
    output: STATUS_OUT,
    execute: (args) => {
      const a = args || {}
      const snap = engine.snapshot()
      if (a.cwd) {
        const key = String(a.cwd)
        snap.projects = (snap.projects || []).filter((p) => p.cwd === key)
        const g = snap.projects[0]
        if (g) {
          snap.state = g.state
          snap.running = g.running
          snap.current = g.current
          snap.trail = g.trail
          snap.lastStatus = g.lastStatus
          snap.lastAt = g.lastAt
          snap.lastSessionId = g.lastSessionId
          snap.fallbackActive = g.fallbackActive
          snap.runs = g.runs
          snap.totalTokens = g.totalTokens
          snap.updatedAt = g.updatedAt
        }
      }
      return snap
    }
  })

  ctx.effect(() => ctx.systemPrompt.section({
    name: 'mimo:policy',
    order: (typeof ctx.systemPrompt.getSectionOrder === 'function' ? ctx.systemPrompt.getSectionOrder('TOOL_SUBAGENT') : 2800) + 10,
    text: POLICY_TEXT
  }))
}
