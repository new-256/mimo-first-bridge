// core/runtime-settings.mjs — Node-side settings resolution for preset + MCP.
// NOT used by dynamic/host.js (sandbox forbids import/process).

import { existsSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { homedir, platform } from 'node:os'
import {
  parseSettingsJson,
  resolveBackend,
  normalizeBackend,
  BACKENDS,
  DEFAULT_BACKEND,
  BACKEND_MIMOCODE,
  BACKEND_DESKTOP,
  buildDesktopTurnBody,
  DESKTOP_API,
  newDesktopSessionId,
  parseDesktopEvents
} from './mimo-core.mjs'

export { resolveBackend, normalizeBackend, BACKENDS, DEFAULT_BACKEND, BACKEND_MIMOCODE, BACKEND_DESKTOP }

/** Default settings file location (editable "设置" surface). */
export function defaultSettingsPath() {
  if (process.env.MIMO_BRIDGE_SETTINGS) return process.env.MIMO_BRIDGE_SETTINGS
  const home = process.env.APPDATA
    || (process.env.HOME ? join(process.env.HOME, '.config') : join(homedir(), '.config'))
  return join(home, 'mimo-first-bridge', 'settings.json')
}

export function loadSettingsFile(path) {
  const p = path || defaultSettingsPath()
  try {
    if (!existsSync(p)) return { path: p, data: {} }
    return { path: p, data: parseSettingsJson(readFileSync(p, 'utf8')) }
  } catch (e) {
    return { path: p, data: {} }
  }
}

export function saveSettingsFile(data, path) {
  const p = path || defaultSettingsPath()
  const dir = dirname(p)
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  writeFileSync(p, JSON.stringify(data || {}, null, 2) + '\n', 'utf8')
  return p
}

/**
 * Full backend resolution + desktop API discovery.
 * @param {object} opts { argBackend, configBackend, config }
 */
export function loadRuntime(opts) {
  const o = opts || {}
  const config = o.config || {}
  const file = loadSettingsFile(o.settingsPath)
  const fileData = file.data || {}
  const envBackend = process.env.MIMO_BRIDGE_BACKEND || process.env.MIMO_BACKEND
  const backend = resolveBackend({
    argBackend: o.argBackend,
    configBackend: o.configBackend || config.backend,
    envBackend,
    fileBackend: fileData.backend
  })

  const desktopModel = config.desktopModel || fileData.desktopModel || process.env.MIMO_DESKTOP_MODEL || 'mimo-auto'

  // Xiaomi MiMo Desktop local API discovery
  const apiFileCandidates = [
    process.env.MIMO_DESKTOP_API_FILE,
    fileData.desktopApiFile,
    config.desktopApiFile,
    process.env.APPDATA ? join(process.env.APPDATA, 'Xiaomi MiMo', 'desktop-api.json') : null,
    process.env.HOME ? join(process.env.HOME, '.config', 'Xiaomi MiMo', 'desktop-api.json') : null,
    process.env.HOME ? join(process.env.HOME, 'Library', 'Application Support', 'Xiaomi MiMo', 'desktop-api.json') : null
  ].filter(Boolean)

  let desktop = {
    available: false,
    baseUrl: null,
    token: null,
    apiFile: null,
    error: null
  }

  if (process.env.MIMO_DESKTOP_PORT && process.env.MIMO_DESKTOP_TOKEN) {
    desktop = {
      available: true,
      baseUrl: 'http://127.0.0.1:' + process.env.MIMO_DESKTOP_PORT,
      token: process.env.MIMO_DESKTOP_TOKEN,
      apiFile: null,
      error: null
    }
  } else {
    for (const p of apiFileCandidates) {
      try {
        if (!existsSync(p)) continue
        const j = parseSettingsJson(readFileSync(p, 'utf8'))
        if (j && j.port && j.token) {
          desktop = {
            available: true,
            baseUrl: 'http://127.0.0.1:' + j.port,
            token: String(j.token),
            apiFile: p,
            error: null
          }
          break
        }
      } catch (e) {
        desktop = { available: false, baseUrl: null, token: null, apiFile: p, error: String(e && e.message || e) }
      }
    }
    if (!desktop.available && !desktop.error) {
      desktop.error = 'desktop-api.json not found (start Xiaomi MiMo Desktop)'
    }
  }

  return {
    backend,
    settingsPath: file.path,
    settings: fileData,
    desktopModel,
    desktop,
    platform: platform()
  }
}

/** HTTP helper for the Desktop local API (Bearer token). */
export async function desktopFetch(runtime, method, path, body, timeoutMs) {
  const d = runtime && runtime.desktop
  if (!d || !d.available || !d.baseUrl) {
    const err = new Error('MiMo Desktop API unavailable: ' + (d && d.error || 'not configured'))
    err.code = 'DESKTOP_UNAVAILABLE'
    throw err
  }
  const url = d.baseUrl + path
  const ctrl = new AbortController()
  const ms = timeoutMs == null ? 8000 : timeoutMs
  const t = setTimeout(() => ctrl.abort(), ms)
  try {
    const res = await fetch(url, {
      method: method || 'GET',
      headers: {
        Authorization: 'Bearer ' + d.token,
        'Content-Type': 'application/json'
      },
      body: body != null ? (typeof body === 'string' ? body : JSON.stringify(body)) : undefined,
      signal: ctrl.signal
    })
    const text = await res.text()
    let json = null
    try { json = text ? JSON.parse(text) : null } catch (e) {}
    return { status: res.status, ok: res.ok, text, json }
  } finally {
    clearTimeout(t)
  }
}

export async function desktopHealth(runtime) {
  try {
    const r = await desktopFetch(runtime, 'GET', '/v1/health')
    return { ok: r.ok, status: r.status, body: r.json || r.text }
  } catch (e) {
    return { ok: false, status: 0, error: String(e && e.message || e) }
  }
}

export async function desktopListSessions(runtime, limit) {
  const r = await desktopFetch(runtime, 'GET', '/v1/sessions?limit=' + (limit || 10))
  return r.json
}

export async function desktopSendTurn(runtime, sessionId, args) {
  const id = sessionId || newDesktopSessionId()
  const body = buildDesktopTurnBody(args)
  const r = await desktopFetch(runtime, 'POST', DESKTOP_API.turnsPath(id), body, 15000)

  // 【实测事故】Desktop API 对**任意** session id 都无条件返回 202 {"ok":true} ——
  // 它不校验目标会话是否存在。实测：向自造 id POST 得到 202，但
  //   GET /v1/sessions 计数不变（19→19），会话从未创建，任务从未执行。
  // 而向**真实存在**的 id POST 会推进该会话的 time.updated。
  // 因此 202 不能作为成功判据，必须回读会话列表确认目标 id 确实存在，
  // 否则桥接层会把"静默丢弃"报告成 ACCEPTED，用户在 Desktop UI 里什么都看不到。
  const accepted = r.status === 202 || (r.json && r.json.ok === true)
  let verified = null
  if (accepted) {
    try {
      const list = await desktopListSessions(runtime, 200)
      if (Array.isArray(list)) verified = list.some((s) => s && String(s.id) === String(id))
      else verified = null // 无法判定，不据此报错
    } catch (e) {
      verified = null
    }
  }
  return {
    id,
    status: r.status,
    ok: r.ok,
    body: r.json || r.text,
    accepted,
    verified,
    // 仅当回读确认存在（或回读不可用）才算真正投递成功
    delivered: accepted && verified !== false
  }
}

export async function desktopReadEvents(runtime, sessionId, dir, timeoutMs) {
  try {
    const r = await desktopFetch(runtime, 'GET', DESKTOP_API.eventsPath(sessionId, dir), null, timeoutMs || 2500)
    return parseDesktopEvents(r.text || (r.json ? JSON.stringify(r.json) : ''))
  } catch (e) {
    return { text: '', sessionId, error: String(e && e.message || e) }
  }
}
