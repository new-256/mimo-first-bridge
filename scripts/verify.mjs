#!/usr/bin/env node
// scripts/verify.mjs — 发布元数据一致性闸门（npm run check / prepack 自动调用）。
//
// 为什么必须存在：client.js 的 __ModuleLoader__ 注册 id 必须 === 主包名。
// client-modules 按主包 name 生成 graph 行 id；若 bundle 已加载却没注册同名
// 模块，arrive() 抛 'loaded without registering'，combo 机制单模块失败糊掉
// 整屏插件页（agy-first-bridge v1.6.1 / codebuddy v1.1.8 同款事故）。

import { readFileSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
let failed = false
function check(label, cond) {
  if (cond) { console.log('ok: ' + label) }
  else { console.error('FAIL: ' + label); failed = true }
}
function read(rel) { return readFileSync(join(root, rel), 'utf8') }

// ── 1. 版本号三处锁死 ────────────────────────────────────────────────────────
const pkg = JSON.parse(read('package.json'))
const mcpSrc = read(join('mcp', 'mimo-mcp-server.mjs'))
const changelog = read(join('docs', 'CHANGELOG.md'))
const mcpMatch = mcpSrc.match(/^const VERSION = '([^']+)'/m)
const logMatch = changelog.match(/^## \[(\d+\.\d+\.\d+)\]/m)

check('mcp server declares VERSION', !!mcpMatch)
check('CHANGELOG has a top version entry', !!logMatch)
if (mcpMatch) check('version sync package.json == MCP VERSION (' + pkg.version + ')', pkg.version === mcpMatch[1])
if (logMatch) check('version sync package.json == CHANGELOG top (' + pkg.version + ')', pkg.version === logMatch[1])

// ── 2. 【核心】client 半注册 id 必须 === 主包名 ──────────────────────────────
const clientSrc = read(join('home-plugin', 'mimo-indicator', 'lib', 'client.js'))
const regMatch = clientSrc.match(/__ModuleLoader__\s*\.\s*load\s*\(\s*\{[\s\S]*?id:\s*["']([^"']+)["']/)
check('client.js contains a __ModuleLoader__.load registration', !!regMatch)
if (regMatch) {
  check(
    'client module id === main package name ("' + pkg.name + '"); got "' + regMatch[1] + '"',
    regMatch[1] === pkg.name
  )
  check('client module id is NOT the deprecated inner-package name "mimo-indicator"', regMatch[1] !== 'mimo-indicator')
}

// ── 2b. 【核心】slots 注册契约 —— 状态灯能否显示的成败点 ────────────────────
// 事故复盘（v1.2.3 发布后实测发现，灯完全不显示）：
//   client.js 曾写成 slots.register({ id, position, component }) 单参调用，且
//   缺少 exports.inject = ["slots"]。两处都致命，且被 try/catch 静默吞掉，控制台
//   无任何报错，表现为"灯就是不出现"。
//   DSH 框架真实签名（dsh-client-ui-slots/lib/index.js register(options, component)）：
//     register(options, component) {
//       const rec = this.records.get(options.name);
//       if (!rec?.spec) throw new Error(`slot "${options.name}" is not declared ...`);
//   即 options 必带 name（无 position 字段），component 是第 2 个实参。
//   官方范例（dsh-cordis-client-runner/lib/client.js）：inject:['slots'] +
//     ctx.slots.inject('<slot>', () => ctx.slots.register({ name:'<slot>' }, () => R...))
check('client.js does not use the bogus single-arg slots.register({...component}) form',
  !/slots\.register\s*\(\s*\{\s*id\s*:/.test(clientSrc))
check('client.js passes slot name via options.name (not options.position)',
  /name:\s*["']conversation\.session\.header\.utilities["']/.test(clientSrc) &&
  !/position:\s*["']conversation\.session\.header\.utilities["']/.test(clientSrc))
check('client.js declares Cordis service-level inject ["slots"] on the module exports',
  /exports\.inject\s*=\s*\[\s*["']slots["']\s*\]/.test(clientSrc))
check('client.js exports.default carries inject ["slots"] (unwrapExports keeps it)',
  /exports\.default\s*=\s*\{[^}]*inject\s*:\s*\[\s*["']slots["']\s*\]/.test(clientSrc))
check('client.js waits for the slot to be declared via slots.inject(...) before register',
  /\.inject\s*\(\s*["']conversation\.session\.header\.utilities["']/.test(clientSrc))

// ── 2c. 【核心】顶层 fallbackActive 聚合不得用 OR ──────────────────────────────
// 事故复盘：顶层聚合曾写成 `if (p.fallbackActive) fallbackActive = true`，即所有项目
// 取 OR。结果一个早已回退的陈旧项目会永久把整盏灯涂成琥珀，即使当前项目刚成功
// （state=ok）也永远看不到绿色。正解是只认同「最近一次活动」的那个项目。
// 且「最近」必须用单调 seq 判定 —— 墙钟毫秒同一毫秒可写入两个项目。
const aggCoreSrc = read(join('core', 'mimo-core.mjs'))
const aggHostSrc = read(join('home-plugin', 'mimo-indicator', 'lib', 'index.mjs'))
const aggDynSrc = read(join('dynamic', 'host.js'))
for (const [label, src] of [['core', aggCoreSrc], ['home-plugin host', aggHostSrc], ['dynamic host', aggDynSrc]]) {
  // 判定原则：在**顶层聚合函数体内**，fallbackActive 必须恰好只被赋值一次，且那次
  // 赋值必须来自唯一的 top 项目。任何额外赋值（if / some() / filter() / reduce /
  // ||= / 三元）都会把陈旧项目的回退态抬到顶层 —— 即"灯永远不绿"的旧病复发。
  //
  // 为什么不用"匹配某种 OR 写法"的正则判负：漏一种写法就是假护栏。本护栏第一版正是
  // 如此 —— 只认 `= list.some(`，被 `if (list.some(...)) fallbackActive = true` 绕过，
  // 变异测试证明其失效。故改为「统计赋值点数量 + 校验唯一赋值来源」的白名单式判定。
  //
  // 作用域限定在聚合函数内：初始化字面量、mergeExternal 的外部快照合并、
  // clearFallback 的重置都是合法赋值，不应计入。
  const stripped = src.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '')
  // 用花括号配对精确切出聚合函数体（初版用 '\n  }' 结束锚，在 dynamic/host.js 里
  // 提前/滞后截断，把别的函数一起吞进来，导致基线误报）。
  function extractFn(text, header) {
    const s = text.indexOf(header)
    if (s < 0) return null
    const open = text.indexOf('{', s + header.length - 1)
    if (open < 0) return null
    let depth = 0
    for (let i = open; i < text.length; i++) {
      const c = text[i]
      if (c === '{') depth++
      else if (c === '}') { depth--; if (depth === 0) return text.slice(open + 1, i) }
    }
    return null
  }
  let aggBody = null
  for (const fn of ['globalState()', 'function snapshot()', 'snapshot()']) {
    const b = extractFn(stripped, fn)
    if (b) { aggBody = b; break }
  }
  check(label + ' has a discoverable top-level aggregation function', !!aggBody)
  if (aggBody) {
    // 关键：统计**赋值点个数**必须基于「LHS 出现次数」，不能基于 RHS 匹配结果 ——
    // 若用 /fallbackActive\s*=\s*([^\n;]+)/g 取 RHS，`[^\n;]+` 会一路吃到行尾，
    // 于是 `if (q.fallbackActive) fallbackActive = true`（同一行两个 fallbackActive）
    // 只产生 1 个匹配，第二个赋值被吞掉 → 变异测试当场抓出这个漏网点。
    // 现在改为：对每个 fallbackActive 出现位置，向右看是否紧跟赋值运算符。
    // 声明排除必须**限制在单条语句内**：初版用 /\b(?:let|const|var)\s+[^\n]*?fallbackActive\s*[=,]/g，
    // [^\n]*? 可跨过 `{` `}` `;`，把 `for (const q of list) { if (q.fallbackActive) fallbackActive = true }`
    // 误判成 const 声明而整体排除 —— 变异测试抓出 2 个漏网点（for-if / while-loop）。
    // 现在 [^;{}\n]*? 保证不跨语句边界。
    const declSpans = [...aggBody.matchAll(/\b(?:let|const|var)\s+[^;{}\n]*?\bfallbackActive\s*[=,]/g)]
      .map((m) => [m.index, m.index + m[0].length])
    const inDecl = (i) => declSpans.some(([a, b]) => i >= a && i < b)
    const assigns = []
    const reLhs = /fallbackActive\s*(\|\|=|&&=|\?\?=|=)/g
    let m
    while ((m = reLhs.exec(aggBody)) !== null) {
      if (inDecl(m.index)) continue
      const after = aggBody.slice(m.index + m[0].length, m.index + m[0].length + 80)
      const rhs = (after.split(/[\n;{}]/)[0] || '').trim()
      assigns.push({ op: m[1], rhs })
    }
    const clean = assigns.filter((a) => a.op === '=' && /^!!?\s*top\.fallbackActive$/.test(a.rhs))
    check(label + ' assigns top-level fallbackActive exactly once, from the top project only (got ' +
      assigns.length + ': ' + JSON.stringify(assigns.map((a) => a.op + ' ' + a.rhs)) + ')',
      assigns.length === 1 && clean.length === 1)
  }
  check(label + ' selects a single "most recent" project for top-level state',
    /let\s+top\s*=\s*null/.test(src))
  check(label + ' orders "most recent" by monotonic seq (clock-tie safe)',
    /const\s+sa\s*=\s*p\.seq\s*\|\|\s*0/.test(src))
}
// 正向哨兵：三种形态都必须真的存在 seq 单调递增来源，否则「最近」无据可依。
for (const [label, src] of [['core', aggCoreSrc], ['home-plugin host', aggHostSrc], ['dynamic host', aggDynSrc]]) {
  check(label + ' maintains a monotonic seq counter',
    /seqCounter/.test(src) && /seq:\s*\+\+seqCounter/.test(src))
}

// ── 2d. 【核心】Desktop 投递必须以「回读确认会话存在」为准，不得信任 202 ──────
// 事故复盘：Desktop API 对**任意** session id 都无条件返回 202 {"ok":true}，不校验
// 目标会话是否存在。实测向自造 id POST 得到 202，但 GET /v1/sessions 计数不变
// （19→19），会话从未创建、任务从未执行；而向真实存在的 id POST 会推进 time.updated。
// 桥接层原先拿 202 当成功 → 报告 ACCEPTED，用户在 Desktop UI 里什么都看不到。
const rsSrc = read(join('core', 'runtime-settings.mjs'))
check('runtime-settings computes delivered from a session-list re-read (not from 202)',
  /delivered:\s*accepted\s*&&\s*verified\s*!==\s*false/.test(rsSrc))
check('runtime-settings verifies the target session id against the session list',
  /verified\s*=\s*list\.some\(/.test(rsSrc))
for (const [label, f] of [['mcp server', mcpSrc], ['preset bridge',
    read(join('preset', 'mimo-first', 'mimo-first-bridge.mjs'))]]) {
  check(label + ' gates the desktop turn on turn.delivered',
    /okTurn\s*=\s*turn\.delivered\s*===\s*true/.test(f))
  check(label + ' does not gate the desktop turn on turn.accepted || turn.ok',
    !/if\s*\(\s*turn\.accepted\s*\|\|\s*turn\.ok\s*\)/.test(f))
  check(label + ' surfaces DESKTOP_SESSION_NOT_CREATED when delivery is unconfirmed',
    /DESKTOP_SESSION_NOT_CREATED/.test(f))
}

// ── 2e. 【核心】desktop 后端必须能指定已存在会话（mimo_run 需声明 sessionId） ──
// 事故复盘：runDesktop() 内部读 args.sessionId，但 mimo_run 的 inputSchema 没声明
// 该字段 → MCP 层参数校验静默丢弃 → 永远走 newDesktopSessionId() 自造 id → 因
// Desktop API 不能创建会话，mimo_run 在 desktop 后端下完全不可用（无路可走）。
const runSchema = mcpSrc.slice(mcpSrc.indexOf("name: 'mimo_run'"), mcpSrc.indexOf("name: 'mimo_continue'"))
const contSchema = mcpSrc.slice(mcpSrc.indexOf("name: 'mimo_continue'"), mcpSrc.indexOf("name: 'mimo_status'"))
check('mimo_run declares the sessionId input (desktop cannot create sessions)',
  /sessionId:\s*\{/.test(runSchema))
check('mimo_continue declares the sessionId input', /sessionId:\s*\{/.test(contSchema))
check('the desktop turn body is built from args.sessionId when provided', /args\.sessionId\s*\|\|/.test(mcpSrc))
// 【真正的根因】只声明 schema 不够 —— 中间层的白名单 map 会把未列出的字段**静默丢掉**。
// 实测：schema 已加 sessionId，但 mimo_run 仍造新 id，根因是 `const mapped = {...}`
// 这个白名单漏了 sessionId（只在 mimo_continue 分支补）。必须显式断言它被转发。
const presetSrc2 = read(join('preset', 'mimo-first', 'mimo-first-bridge.mjs'))
check('mcp server forwards sessionId through the mapped whitelist',
  /const mapped = \{[\s\S]{0,600}?sessionId:\s*a\.sessionId/.test(mcpSrc))
check('preset bridge forwards sessionId through the mapped whitelist',
  /const mapped = \{[\s\S]{0,600}?sessionId:\s*a\.sessionId/.test(presetSrc2))
check('preset mimo_run declares sessionId in its parameters',
  /name: 'mimo_run'[\s\S]{0,4000}?sessionId: \{ type: 'string'/.test(presetSrc2))
check('delivery error text does not point at a non-existent parameter path',
  !/再用 mimo_run 的 sessionId 参数指定该会话 id/.test(mcpSrc))

// ── 3. 标准 npm 分发形态结构钉死 ─────────────────────────────────────────────
check('main package main points to indicator lib/index.mjs',
  pkg.main === './home-plugin/mimo-indicator/lib/index.mjs')
check('main package exports ./client points to client.js',
  pkg.exports && pkg.exports['./client'] === './home-plugin/mimo-indicator/lib/client.js')
check('main package exports ./preset-plugin exposed',
  pkg.exports && pkg.exports['./preset-plugin'] === './preset/mimo-first/mimo-first-bridge.mjs')
check('main package exports ./package.json exposed',
  pkg.exports && pkg.exports['./package.json'] === './package.json')
check('main package declares dsh.client.platform=web',
  pkg.dsh && pkg.dsh.client && pkg.dsh.client.platform === 'web')
check('main package declares dsh.bundle.patch',
  pkg.dsh && pkg.dsh.bundle && pkg.dsh.bundle.patch === './home-plugin/mimo-indicator/cordis.patch.yml')

const bundlePatch = read(join('home-plugin', 'mimo-indicator', 'cordis.patch.yml'))
check('bundle patch layer has an insert row named after the MAIN package',
  /-\s+id:\s*mimo-indicator\b/.test(bundlePatch) && /name:\s*mimo-first-bridge\b/.test(bundlePatch))

const hostSrc = read(join('home-plugin', 'mimo-indicator', 'lib', 'index.mjs'))
check('host resolves MCP live file via DSH_HOME/detectDshHome (layout-independent)',
  /DSH_HOME/.test(hostSrc) && /plugins['",\s)]+mimo-indicator['",\s)]+mcp-live\.json/.test(hostSrc))
check('host keeps MIMO_MCP_LIVE_FILE explicit override first', /MIMO_MCP_LIVE_FILE/.test(hostSrc))
check('mcp server resolves MCP live file via DSH_HOME (layout-independent)',
  /DSH_HOME/.test(mcpSrc) && /plugins['",\s)]+mimo-indicator['",\s)]+mcp-live\.json/.test(mcpSrc))
check('mcp server keeps MIMO_MCP_LIVE_FILE explicit override first', /MIMO_MCP_LIVE_FILE/.test(mcpSrc))

const dynamicSrc = read(join('dynamic', 'host.js'))
check('dynamic host detects runtime environment safely', /typeof process !== 'undefined'/.test(dynamicSrc))
check('dynamic host resolves MIMO_BIN via probe chain',
  /MIMO_CLI/.test(dynamicSrc) && /mimocode/.test(dynamicSrc))

// ── 3b. 成功状态分类护栏（ACCEPTED 不得画成红色）────────────────────────────
// mimo-desktop 异步受理后回报 ACCEPTED（HTTP 202），此时没有回复文本；状态机若只
// 认 SUCCESS 就会把健康派发画成红色 ✗。core 与两处自包含副本必须都认 ACCEPTED。
const coreSrc = read(join('core', 'mimo-core.mjs'))
check('core classifies ACCEPTED as success', /SUCCESS_STATUSES/.test(coreSrc) && /'ACCEPTED'/.test(coreSrc))
check('host half classifies ACCEPTED as success', /SUCCESS_STATUSES/.test(hostSrc) && /'ACCEPTED'/.test(hostSrc))
check('host half recomputes derived state instead of trusting external snapshots',
  /isSuccessStatus\(p\.lastStatus\)/.test(hostSrc) && !/if \(src\.state\) p\.state = src\.state/.test(hostSrc))
check('core mergeExternal recomputes derived state instead of trusting external snapshots',
  !/if \(src\.state\) p\.state = src\.state/.test(coreSrc) && /isSuccessStatus\(p\.lastStatus\)/.test(coreSrc))
check('dynamic host classifies ACCEPTED as success',
  /SUCCESS_STATUSES\s*=\s*\[[^\]]*'ACCEPTED'/.test(dynamicSrc) && /isSuccessStatus\(p\.lastStatus\)/.test(dynamicSrc))
check('no state machine compares lastStatus to SUCCESS alone',
  !/lastStatus === 'SUCCESS'/.test(coreSrc) && !/lastStatus === 'SUCCESS'/.test(hostSrc) && !/lastStatus === 'SUCCESS'/.test(dynamicSrc))

// ── 3c. 状态机与并发护栏（A/B/D 项回归防护）─────────────────────────────────
const mcpHandleTool = mcpSrc.slice(mcpSrc.indexOf('async function handleTool'))
check('mcp handleTool does not duplicate engine.end on fallback',
  !/fallbackResult[\s\S]*?engine\.end/.test(mcpHandleTool))
check('core status engine never evicts running projects',
  !/const pool = idle\.length \? idle : keys/.test(coreSrc) && /if \(idle\.length\)/.test(coreSrc))
check('indicator host never evicts running projects',
  !/const pool = idle\.length \? idle : keys/.test(hostSrc) && /if \(idle\.length\)/.test(hostSrc))
check('dynamic host never evicts running projects',
  !/const pool = idle\.length \? idle : keys/.test(dynamicSrc) && /if \(idle\.length\)/.test(dynamicSrc))
check('core end() guards running state and fallbackActive under concurrency',
  /p\.running > 0[\s\S]*?'running'/.test(coreSrc) && /else if \(p\.running === 0\)/.test(coreSrc))
check('dynamic end() guards running state and fallbackActive under concurrency',
  /p\.running > 0 \? 'running'/.test(dynamicSrc) && /else if \(p\.running === 0\)/.test(dynamicSrc))

// ── 4. 内层包：private，结构自洽 ─────────────────────────────────────────────
const hpPkgPath = join('home-plugin', 'mimo-indicator', 'package.json')
if (existsSync(join(root, hpPkgPath))) {
  const hpPkg = JSON.parse(read(hpPkgPath))
  check('inner package mimo-indicator is private (never republished)', hpPkg.private === true)
  check('inner package version syncs with main package', hpPkg.version === pkg.version)
}

// ── 5. preset 组合结构要素 ───────────────────────────────────────────────────
const cordis = read(join('preset', 'mimo-first', 'agent.cordis.yml'))
check('agent.cordis.yml has bridge row id mimo-first-bridge', /^- id: mimo-first-bridge$/m.test(cordis))
check('agent.cordis.yml bridge row points to ./mimo-first-bridge.mjs',
  /name:\s*['"]?\.\/mimo-first-bridge\.mjs['"]?/.test(cordis))

const presetYml = read(join('preset', 'mimo-first', 'preset.yml'))
check('preset.yml declares name', /^name:\s*\S+/m.test(presetYml))
check('preset.yml declares description', /^description:\s*\S+/m.test(presetYml))

// ── 6. 工作流引擎跨版本双行 ─────────────────────────────────────────────────
const allIds = new Set((cordis.match(/^[ \t]*- id: (\S+)$/gm) || []).map((r) => r.trim().slice(6)))
check('preset declares the modern workflow engine row (workflow-ptc)', allIds.has('workflow-ptc'))
check('preset declares the legacy workflow engine row (workflow-worker-thread)',
  allIds.has('workflow-worker-thread'))

const lines = cordis.split('\n')
for (const id of ['workflow-ptc', 'workflow-worker-thread']) {
  const start = lines.findIndex((l) => new RegExp(`^[ \\t]*- id: ${id}$`).test(l))
  let body = ''
  if (start !== -1) {
    for (let i = start + 1; i < lines.length; i++) {
      if (/^[ \t]*- id: /.test(lines[i])) break
      body += lines[i] + '\n'
    }
  }
  check('workflow row ' + id + ' has !!js disabled guard', /!!js/.test(body) && /disabled:/.test(body))
}

// ── 7. 工具名契约 ───────────────────────────────────────────────────────────
const bridge = read(join('preset', 'mimo-first', 'mimo-first-bridge.mjs'))
check('preset registers mimo_run', /name:\s*'mimo_run'/.test(bridge))
check('preset registers mimo_continue', /name:\s*'mimo_continue'/.test(bridge))
check('preset registers mimo_status', /name:\s*'mimo_status'/.test(bridge))
check('preset registers mimo_settings', /name:\s*'mimo_settings'/.test(bridge))
check('preset injects mimo:policy section', /mimo:policy/.test(bridge))
check('preset resolves backend via loadRuntime', /loadRuntime/.test(bridge))
check('preset executeWithFallback has clean retry loop without duplicate dialogs',
  !/attempt < 2[\s\S]*?attempt >= 2/.test(bridge) && /for\s*\(\s*let attempt = 1;\s*attempt <= 2;\s*attempt\+\+\s*\)/.test(bridge))
check('dynamic host registers mimo_run', /name:\s*'mimo_run'/.test(read(join('dynamic', 'host.js'))))
check('dynamic host registers mimo_settings', /name:\s*'mimo_settings'/.test(read(join('dynamic', 'host.js'))))
check('core declares BACKENDS', /BACKEND_MIMOCODE/.test(read(join('core', 'mimo-core.mjs'))))
check('runtime-settings reads desktop-api.json', /desktop-api\.json/.test(read(join('core', 'runtime-settings.mjs'))))

// ── 8. 状态灯「长时间不消失」护栏（v1.2.9） ──────────────────────────────────
// 结构性命题，不靠自然语言枚举正则（纪律 8 教训）：
//   a) host 半必须对 mcp-live.json 的整份文件做时效闸门；
//   b) host 半必须给快照项目打 stale 标记；
//   c) client 半的可见性不得单独依赖全局租约 presetActive —— 必须存在
//      per-session 的预设判定函数，且 readyShow 的判定式里 iAmMimo 是主项。
const indHost = read(join('home-plugin', 'mimo-indicator', 'lib', 'index.mjs'))
const indClient = read(join('home-plugin', 'mimo-indicator', 'lib', 'client.js'))

check('indicator host gates the whole mcp-live.json by writtenAt freshness',
  /MCP_LIVE_TTL_MS/.test(indHost) && /Date\.now\(\)\s*-\s*writtenAt\)\s*>\s*MCP_LIVE_TTL_MS/.test(indHost))
check('indicator host marks stale projects in the snapshot',
  /PROJECT_TTL_MS/.test(indHost) && /stale:\s*isStale\(p\)/.test(indHost))
check('indicator host never marks a running project stale',
  /if\s*\(\s*p\.running\s*>\s*0\s*\)\s*return false/.test(indHost))
check('indicator client reads per-session agentPreset (not only the global presetActive lease)',
  /isMimoPreset\(/.test(indClient) && /projectionValues\.agentPreset/.test(indClient))
check('indicator client ready-placeholder is gated on THIS session being a mimo preset',
  /iAmMimo\s*===\s*true\s*\|\|\s*\(iAmMimo\s*===\s*null/.test(indClient))
check('indicator client declares RECENT_MS window for non-running projects',
  /RECENT_MS/.test(indClient))
check('indicator client register descriptor carries inject() for session context',
  /inject:\s*function\s*\(injectedSessionId\)/.test(indClient))
check('regression test indicator-stale is wired into npm test',
  /tests\/indicator-stale\.test\.mjs/.test(read('package.json')))

if (failed) {
  console.error('\nverify FAILED')
  process.exit(1)
}
console.log('\nverify ok (' + pkg.name + ' ' + pkg.version + ')')
