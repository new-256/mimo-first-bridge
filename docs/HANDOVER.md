# 交接文档（HANDOVER）

> 本文档面向**下一个维护会话 / DSH 团队**：接手 `mimo-first-bridge` 的开发与维护。
> 写于 v1.0.0 首发之际（2026-09-18）。读完本文即可上手，细节按「文档地图」深入。

## 1. 项目是什么

**mimo-first-bridge** —— DeepSeek Harness（DSH）的 **Xiaomi MiMo / MiMoCode** 优先派发桥：

- 让 DSH 每种模式优先使用本机 **`mimo` CLI**（Xiaomi MiMo Desktop 代理；全程接管、无弹窗）；
- 限流/网络/认证失败时回退对话；
- 实时状态灯（家级插件 + 动态形态推入同一张表）；
- 零依赖 MCP server，让任何 MCP 客户端（Claude Code / Codex / Cherry Studio…）发现 mimo；
- 按项目维度的 runs / token 用量观察。

| 关键坐标 | 值 |
| --- | --- |
| 工作区 | `C:\Users\lcl\Desktop\DSH插件开发\Xiaomi MiMo-bridge` |
| npm 包名 | `mimo-first-bridge`（**client 模块 id 必须等于此名**） |
| 当前版本 | 1.2.9（家级状态灯修复版；**待重启 DSH 生效**；registry `latest` 仍是 1.2.8） |
| 目标 CLI | `mimo`（MiMoCode / Xiaomi MiMo Desktop），开发时 v0.1.14 |
| 目标桌面 API | Xiaomi MiMo Desktop `desktop-api.json`（`port`+`token`，`/v1/sessions/:id/turns`） |
| 姊妹项目 | `agy-first-bridge`、`codebuddy-first-bridge`（同构） |

## 1.1 v1.2.9 待重启验证（接手先做这件事）

**用户症状**：状态灯长时间不消失（连续三次反馈，前两轮未修真因）。

**根因**（两处叠加，详见 CHANGELOG 1.2.9）：
- host 半 `readMcpLive()` 无条件并入 `mcp-live.json`，不给时效闸门、不打 `stale` 标记；
- client 半可见性用**全局租约** `presetActive`，普通会话被别的 mimo 会话的租约永久点亮。

**已做的修复与验证**：
| 项 | 结果 |
|---|---|
| 家级灯 host 半（`home-plugin/mimo-indicator/lib/index.mjs`） | ✅ 已改（`MCP_LIVE_TTL_MS` + `PROJECT_TTL_MS` + `stale`） |
| 家级灯 client 半（同目录 `client.js`） | ✅ 已改（per-session preset 判定 + `RECENT_MS`） |
| 已安装制品同步 | ✅ `profiles\web\node_modules\mimo-first-bridge` 两文件 CRLF 归一化后 IDENTICAL=True |
| 备份 | `index.mjs.bak-20260928-233852`、`client.js.bak-20260928-233852`（同目录） |
| `npm run check` / `npm test` | ✅ verify 全过 · core 35 · indicator-stale 8 · contracts · mcp-smoke |
| 变异验证（纪律 8） | ✅ verify 3 处变异全捕获；test 2 处变异全捕获 |
| 真实数据实证 | ✅ 真实 `mcp-live.json`（49.1h 前）→ 快照 `projects=0`、`state=idle`（修复前为 `state=ok` 常亮） |

**待你做的一步（只有重启能验证的部分）**：
家级灯 host 半是 **DSH 启动时加载**的，改文件不会热生效。
1. **重启 DSH Desktop**；
2. 打开任意会话，确认标题栏**没有** MiMo 状态灯（当前无 mimo 任务时应完全无灯）；
3. 开一个 MiMo preset 会话 → 灯应出现（"MIMO"/"✓ MIMO"）；
4. 关掉该会话、等 >75 秒（`MODE_TTL_MS`）→ 回到普通会话，**灯应消失**（这是原先不消失的场景）。

若第 4 步仍不消失，请附 `GET http://127.0.0.1:<端口>/mimo-indicator/status` 的返回。

## 2. 文档地图

| 文档 | 用途 |
| --- | --- |
| [ARCHITECTURE.md](ARCHITECTURE.md) | 架构深解（四形态、状态机、CLI 映射） |
| [INSTALL.md](INSTALL.md) | 安装方式 A/B/C + MCP 注册 |
| [DEV-DISCIPLINE.md](DEV-DISCIPLINE.md) | **开发-制品闭环七条纪律**（必读） |
| [FALLBACK-AND-INDICATOR.md](FALLBACK-AND-INDICATOR.md) | 回退弹窗与状态灯 |
| [CHANGELOG.md](CHANGELOG.md) | 版本历史 |
| [../README.md](../README.md) | 用户文档 |
| [../scripts/verify.mjs](../scripts/verify.mjs) | 发布闸门（client id 契约 + 版本锁 + 分发结构） |
| [../scripts/build.mjs](../scripts/build.mjs) | 派生产物同步（core → preset 副本） |

## 3. 架构速览（四形态）

见 [ARCHITECTURE.md](ARCHITECTURE.md)。一句话：

- **preset**（`preset/mimo-first/`）：会话内工具 + 策略 + 回退弹窗；
- **home-plugin**（`home-plugin/mimo-indicator/`）：家级状态灯 + `/mimo-indicator/status` + `mimoCollector`；
- **dynamic**（`dynamic/`）：进程内临时形态（沙箱自包含 host.js）；
- **mcp**（`mcp/mimo-mcp-server.mjs`）：stdio MCP，工具镜像 DSH 插件。

**最核心的契约**（verify.mjs 已锁死）：

> `home-plugin/mimo-indicator/lib/client.js` 里 `__ModuleLoader__.load({ id })` 的 id **必须等于主包名 `mimo-first-bridge`**。
> client-modules 的 graph 行 id 按包名生成，浏览器侧 `arrive()` 校验 bundle 必须注册同名模块，否则整个 client combo 崩溃（`Failed to load plugins`）。
> slot id `mimo-indicator-home` 是另一命名空间，无需与包名一致。

## 4. CLI 契约（Xiaomi MiMo Desktop / MiMoCode）

### 4.1 backend 预选（设置）

用户可在设置中**提前预选**派发目标，无需每次传参：

| 途径 | 位置 |
| --- | --- |
| settings 文件 | `%APPDATA%\mimo-first-bridge\settings.json`（`MIMO_BRIDGE_SETTINGS` 可覆盖）→ `{ "backend": "mimocode"\|"mimo-desktop", "desktopModel": "mimo-auto" }` |
| 工具 | `mimo_settings` 读/写 |
| 插件 config | cordis 行 `config.backend`（`apply(ctx, config)` 第二参） |
| 环境变量 | `MIMO_BRIDGE_BACKEND` / `MIMO_BACKEND` |
| 单次覆盖 | `mimo_run`/`mimo_continue` 的 `backend` 参数 |

优先级：**工具参数 > 插件 config > 环境变量 > settings 文件 > 默认 `mimocode`**。实现在 `core/mimo-core.mjs`（`resolveBackend`）+ `core/runtime-settings.mjs`（`loadRuntime`）。

### 4.2 mimocode（默认）

```text
mimo run [message...] --format json --dangerously-skip-permissions
         --agent build|plan|compose --model provider/model
         --variant minimal|high --dir <cwd>
         --session <id> | --continue --title <t>
```

- 输出：NDJSON 事件（`type: error|text|message|tool|step-*`，带 `sessionID`）。
- **无 `--print-timeout`**：硬超时由宿主 `timeoutSec + 60s` + `handle.terminate()` 兜底。
- 解析：`core/mimo-core.mjs` 的 `parseMimoJson` / `createLineStream`（半行安全）。

### 4.3 mimo-desktop（Xiaomi MiMo 桌面客户端本地 API）

发现：`%APPDATA%\Xiaomi MiMo\desktop-api.json` → `{api, port, token, pid}`。鉴权：`Authorization: Bearer <token>`。

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/v1/health` | `{ok, api, app, engine}` |
| GET | `/v1/sessions?limit=N` | 会话列表 |
| POST | `/v1/sessions/:id/turns` | body **必须** `{message, model}`（可选 `directory`）；`202 {"ok":true}` 表示已受理 |
| GET | `/v1/sessions/:id/events?dir=` | 读事件/回复（可能流式；短超时解析） |

实现：`core/runtime-settings.mjs` 的 `desktopFetch` / `desktopSendTurn` / `desktopReadEvents`。Desktop 未运行 → `DESKTOP_UNAVAILABLE`。

开发时注意：本机若 MiMo 免费 API 已结束，`mimocode` 路径会得到
`free API service has ended` → `isLimited` 命中并触发回退弹窗，属预期路径，不是桥接故障。

## 5. 发布与维护

1. 改代码。
2. 四处版本：`package.json` / `home-plugin/mimo-indicator/package.json`（内层包）/ `mcp/mimo-mcp-server.mjs` 的 `VERSION` / `docs/CHANGELOG.md` 顶部（`scripts/verify.mjs` 会校验前三处 + CHANGELOG 顶部一致）。
3. `node scripts/build.mjs`（同步 preset core —— 改 `core/*.mjs` 后必跑）。
4. `npm run check`（build --check + verify + MCP --check）全绿。
5. `npm test`（core + contracts + mcp-smoke）全绿。
6. commit + `git tag vX.Y.Z` + push（含 tags）+ `npm publish --userconfig "$env:USERPROFILE\.npmrc"`（prepack 自动 verify）。
7. 按 [DEV-DISCIPLINE.md](DEV-DISCIPLINE.md) 执行开发态拆除 → 制品安装 → 一致性核验 → 闭环备案。
8. **发布后**：`dsh plugin --profile web add mimo-first-bridge@<ver>` 升级本机；若该版本改了 `home-plugin/mimo-indicator/lib/index.mjs` 或 `mcp/`，同步刷新 `dsh-home\bin\mimo-mcp\` 自包含副本，并**重启 DSH** 让家级灯生效。

> ⚠️ **npm 认证**：本机 `NPM_CONFIG_USERCONFIG` 指向 `backend\.npmrc`（无 token）。所有 npm 发布/查询命令必须显式加 `--userconfig "$env:USERPROFILE\.npmrc"`，否则 `ENEEDAUTH`。
> ⚠️ **registry 传播**：`npm publish` 成功后 `dist-tags.latest` 可能滞后 1–3 分钟。装指定版本（`@<ver>`）可绕过；`npm view` 未命中先直查 `https://registry.npmjs.org/<pkg>` 再判断。

## 6. 未决事项（新会话待办）

1. **npm 已发布（v1.2.8）**：`mimo-first-bridge@1.2.8` 已在 registry（`latest`）。仓库坐标已补。GitHub 仓库 `new-256/mimo-first-bridge` **尚未创建**（与姊妹包 `codebuddy-bridge` 同款：先声明坐标、仓库后建）；建仓后 `git remote add` + push 即可。
2. **本机 DSH 已安装制品态**（见 §8 闭环备案）。**两处常驻进程需重启才生效**：
   - 家级灯 host 半（`home-plugin/mimo-indicator/lib/index.mjs`）—— 由 DSH 主进程加载；
   - MCP 子进程（`dsh-home\bin\mimo-mcp\mcp\mimo-mcp-server.mjs`）—— 常驻，DSH 启动时创建后不重建。
   重启前 `mimo_run` 仍走旧代码（实测：传 `sessionId` 会被旧 schema 静默丢弃）。
3. **仓库尚无 `.git`**：v1.2.5 的闭环记录（含变异矩阵证据）尚未提交；DEV-DISCIPLINE 规则 7 要求归档。
3. **mimo 免费 API 已结束**：`mimocode` 后端在本机必然得到 `MiMo free API service has ended` → `isLimited` 命中 → 回退弹窗，属**预期路径**。真实成功路径已由 **`mimo-desktop`** 覆盖（桌面端在运行时端到端通过）。要在 `mimocode` 上跑通真实成功路径，需 `mimo providers` 登录或配置第三方 API。
4. **上游 issue（与姊妹仓同款，可复用文案）**：
   - `dsh`：`plugin add` 时应静态校验 client 注册 id=包名；
   - `dsh-client-modules`：单模块注册失败应只禁用该插件，不该炸整批；
   - `dsh-desktop`：enterSafeMode 应优先隔离该 bundle/补丁行，而非全树注释。
5. **本仓尚未 git init**：`Xiaomi MiMo-bridge` 与 `codebuddy-first-bridge` 一样还不是 git 仓库（`agy-first-bridge` 是）。首次建仓时注意 `package.json` 已声明 `repository`，需与远端一致。
6. **`dynamic/host.js` 的探测链已就绪**（v1.2.0）；末位字面量仅作部署期兜底，分发给他人时优先设 `MIMO_BIN`。
7. **npm 发布需显式 userconfig**：本机 `NPM_CONFIG_USERCONFIG` 指向 `backend\.npmrc`（无 token），真实 token 在 `C:\Users\lcl\.npmrc`。发布/查询一律加 `--userconfig "$env:USERPROFILE\.npmrc"`，否则报 `ENEEDAUTH`。

## 7. 新会话快速上手（5 分钟）

```powershell
cd "C:\Users\lcl\Desktop\DSH插件开发\Xiaomi MiMo-bridge"
npm run check          # verify 全过 + MCP check
npm test               # core + contracts + mcp-smoke 全过
mimo --version         # 确认 CLI 在位
```

然后按任务性质查文档：安装 → INSTALL；兼容/契约 → verify.mjs + contracts.test；发布 → DEV-DISCIPLINE；架构 → ARCHITECTURE；历史 → CHANGELOG。

## 8. 验收记录

### v1.2.7（2026-09-25）desktop 后端无法指定已存在会话 —— P0

**触发**：用户在 MiMo Desktop 中手动创建了 `dsh-mimo` 会话并要求"用这个"。

**根因**：`runDesktop()` 内部一直读 `args.sessionId`，但 **`mimo_run` 的
`inputSchema.properties` 没有声明 `sessionId`** → MCP 层参数校验**静默丢弃**该参数 →
代码永远走 `newDesktopSessionId()` 生成自造 id。由于 Desktop API **不能创建会话**，
这使得 **`mimo_run` 在 desktop 后端下完全不可用**：没有任何途径命中真实会话。
（`mimo_continue` 有该参数，所以问题只出在 `mimo_run`。）

**修正**：`mimo_run` 补上 `sessionId` 声明；并修正 1.2.6 引入的错误文案
（原文案让用户"用 mimo_run 的 sessionId 参数指定"，而该参数当时尚未声明）。

**实测闭环（用用户的 `dsh-mimo` 会话）**：

| 项 | 值 |
|---|---|
| 会话 id | `ses_ffe5f26577c16ffecDFuhVIZys` |
| 标题 / 目录 | `dsh-mimo` / `C:\Users\lcl\Desktop\dsh-mimo` |
| `accepted` / `status` | `true` / `202` |
| `verified` / `delivered` | `true` / **`true`** ✅ |
| `time.updated` 变化 | 1790358095943 → **1790358478514**（推进到当前，证明 turn 落地） |

| 项目 | 结果 |
|---|---|
| 发布版本 | `mimo-first-bridge@1.2.7`（registry `latest`） |
| 完整性 | `npm pack` SHA512 === registry `dist.integrity` ✅ |
| 已安装 ≡ 已发布 | 22 文件 / **0 内容差异** ✅ |
| bin 副本 | 3 文件字节同源 ✅ |
| 测试 | core 35 + desktop-delivery 4 + contracts + mcp-smoke ✅ |
| 变异验证 | 4 种回退变体（删两处 schema 声明 / 忽略 args.sessionId / 恢复误导文案）全部被捕获 ✅ |

**待重启验证**：MCP 子进程是常驻进程，**重启 DSH Desktop 后** `mimo_run` 的
`sessionId` 参数才会真正生效（重启前仍被旧 schema 丢弃）。

### v1.2.5（2026-09-24）状态灯"永远不绿" + 注册契约缺失 —— 两项 P0

**触发**：用户目视检查时报"没有看见灯"。实测发现两个彼此独立的 P0 缺陷。

#### 缺陷 1：状态灯从未注册成功（灯根本不出现）
`client.js` 写成单参 `slots.register({ id, position, component })` 且缺少
`exports.inject = ["slots"]`。DSH 框架真实签名为 `register(options, component)`
（`@deepseek-ai/dsh-client-ui-slots/lib/index.js`），`options` 必带 `name`、**无 `position`**，
组件必须是第 2 个实参。原写法 `options.name === undefined`，框架首行即抛
`slot "undefined" is not declared`；外层 `try { register() } catch (e) {}` 把错误**完全吞掉**，
控制台无任何报错。另需 `slots.inject(slot, cb)` 等插槽被 declare 后再注册。
**修正**：三处齐改（`name` 字段 + 双参 + `slots.inject` 等待 + 顶层 `inject` 声明）。

#### 缺陷 2：顶层 `fallbackActive` 用 OR 聚合（灯永远不绿）
`if (p.fallbackActive) fallbackActive = true` —— 只要**任意**历史项目回退过，整盏灯永久琥珀。
实测证据：当前项目 `lastStatus=ACCEPTED`（成功），路由仍返回
`state=fallback, fallbackActive=true`。三形态同病（core / host 半 / dynamic）。
**修正**：顶层只认同唯一"最近活动"项目；新增单调 `seq` 计数器解决同毫秒墙钟撞车。

| 项目 | 结果 |
|---|---|
| 发布版本 | `mimo-first-bridge@1.2.5`（registry `latest`） |
| 完整性 | `npm pack` SHA512 === registry `dist.integrity` ✅ |
| 已安装 ≡ 已发布 | 22 文件 / **0 内容差异**（CRLF/LF 归一化）✅ |
| bin 副本 | 3 文件与制品 SHA256 同源 ✅ |
| 护栏 | `scripts/verify.mjs` **60 条**（+12 聚合契约 +5 slots 契约）✅ |
| 测试 | `tests/core.test.mjs` **35 项**（+2 聚合回归）✅ |
| 变异验证 | 聚合护栏 **12 种 OR 写法变体全部捕获** ✅ |
| slots 护栏变异 | 5 条护栏还原修复后全部 FAIL ✅ |

**实测闭环（模拟用户真实状态）**：
陈旧 `lib` 项目 `fallback` + 当前项目 `ACCEPTED` → 顶层正确输出
`state=ok, fallbackActive=false`（修复前为 `state=fallback`）。

**待重启验证**：家级灯 host 半 1.2.5（当前 DSH 进程内仍为启动时加载的旧代码）。

#### Lesson：假护栏（DEV-DISCIPLINE 规则 8 第二次实战）
聚合护栏**第一版是假护栏**，被变异测试连续抓出 7 个漏网点：
1. 只匹配 `= list.some(`，被 `if (list.some(...)) x = true` 绕过（4 个变体漏网）
2. 改统计赋值点后，正则只锚行首（`^\s*`），`if (...)` 前缀写法漏网
3. RHS 用 `[^\n;]+` 吃穿行尾，同行双赋值被吞成 1 个匹配
4. 声明排除正则 `[^\n]*?` 跨 `{}` `;`，把 `for (const q ...)` 误判为声明而排除
**最终解**：不用"枚举 OR 写法"，改判**结构性命题** —— "聚合函数体内 `fallbackActive`
的 LHS 赋值点恰好 1 个，且来源为 `top.fallbackActive`"，声明排除限制在单语句内。
**结论：护栏的自然语言目标不能靠枚举正则实现；必须转成可判定的结构命题，并对该命题
做多写法变异验证。**

### v1.2.3（2026-09-24）agy 只读审计 → 7 项真问题修复

**审计方式**：agy（Gemini）以**只读模式（plan）**独立审查全部核心代码，输出 8 节分项结论；我随后逐条对照源码复核、剔除误报，确认 7 项真问题；修复由 agy 在 accept-edits 模式执行，我逐项回读源码 + 变异测试验收。

**本轮确立的验收范式**：**先证伪 → 再修 → 变异验证**。凡新增回归测试，必须用「把修复回退成原始 bug」验证该测试**真的会失败**，否则视为空转。（此前只跑「测试通过」是不够的。）

| # | 级别 | 问题 | 修法 | 变异测试验收 |
| --- | --- | --- | --- | --- |
| A | **P0** | MCP `handleTool` 二次 `engine.end`（`runMimo`/`runDesktop` 内部已全覆盖） | 删除冗余调用 | ✅ 还原后 2 次派发 `runs=3`（应 2） |
| B | **P0** | 淘汰逻辑在全 running 时回退 `pool = keys`，**删掉运行中项目** | 仅淘汰 idle；全 running 时宁超限 | ✅ 还原后 `running=12`（应 30） |
| C | P1 | `mergeExternal` 盲信外部派生 `state`，与家级灯策略漂移 → preset 侧 ACCEPTED 重新画红 | 与 host 半同策略重算 | ✅ 还原后 `failed`（应 `ok`） |
| D | P1 | `end()` 并发下 state 算错、误清 `fallbackActive` | `running>0` 强制 `running`；仅 `running===0` 才清标记 | ✅ 单测锁定 |
| E | P2 | dynamic 形态缺 `mimo_settings`（3 个工具 vs 4 个） | 补齐，如实返回无 fs | ✅ 探针实跑，四工具齐全 |
| F | P2 | preset 重试连问两次，第二次选 retry 静默失败 | 显式 `for attempt=1..2`，耗尽时标注上限 | ✅ verify 护栏锁定 |
| G | P2 | `mergeExternal` 接受更旧的外部快照 | 有明确时间戳且更旧即丢弃 | ✅ 单测锁定 |

**本轮修掉的一个「假护栏」（重要教训）**：
> agy 为 B 项写的回归测试 `status engine never evicts running projects when full` 只创建 **15** 个项目，而 `MAX_PROJECTS = 24` —— **从未进入淘汰分支**，无论修复与否都通过（空转）。我在变异测试中发现后改写为 30 个项目（越过上限），并补「idle 仍应淘汰」的正向用例，此后变异测试才真正失败。

**制品闭环**

| 项 | 值 |
| --- | --- |
| 发布版本 | `mimo-first-bridge@1.2.3`（registry `latest`） |
| 制品完整性 | `npm pack` 实测 SHA512 **===** registry `dist.integrity` ✅ |
| 一致性核验 | 已安装 22 文件 vs 发布 22 文件：**内容差异 = 0** ✅ |
| bin 副本 | 3 文件与制品 SHA256 逐一同源；变异测试后已还原为纯净 1.2.3 ✅ |
| 护栏 / 测试 | verify **45** 条（原 40）· core **33** 项（原 27）· contracts · mcp-smoke 全绿 |
| 真实端到端 | 1 个 server 进程 2 次派发 → `runs` 精确 1→2、`running` 恒 0、`mimo_status` 与落盘一致 ✅ |

**待重启验证**：家级灯 host 半 1.2.3（当前 DSH 进程内仍为启动时加载的旧代码）——**重启 DSH Desktop 后**生效。

### v1.2.2（2026-09-24）制品闭环 —— 已安装 ≡ 已发布

**当前真实部署形态（三层，全为制品态）**

| 层 | 载体 | 形态 |
| --- | --- | --- |
| Profile bundle | `dsh-home\profiles\web` → `mimo-first-bridge@^1.2.2` + bundles 登记 | ✅ registry 制品（真实目录，非 junction） |
| 家级状态灯 | 同包 `home-plugin/mimo-indicator`（bundle patch 行 `mimo-indicator`） | ✅ 随包分发 |
| Agent preset | bundle patch 行 `preset-cordis-mimo`（`mimo-first-bridge/preset-plugin`） | ✅ 随包分发 |
| 宿主 MCP 全局 | `dsh-home\cordis.patch.yml` 行 `mcp-mimo-global` → `dsh-home\bin\mimo-mcp\`（自包含副本） | ✅ 稳定绝对路径 |

**闭环执行记录**

| 项 | 值 |
| --- | --- |
| 发布版本 | `mimo-first-bridge@1.2.2`（registry `latest`） |
| 制品完整性 | `npm pack` 实测 SHA512 **===** registry `dist.integrity`（`sha512-MWLn…` 系列，逐版实测 True） |
| 一致性核验 | 已安装 22 文件 vs 发布 22 文件：**文件清单一致、CRLF/LF 归一化后内容差异 = 0** |
| bin 副本 | 3 个文件与制品 SHA256 逐一同源（`mcp/` + `core/` 同级布局，匹配包内 `../core/` 导入） |
| MCP 子进程 | 运行中仅 1 个（无重复注册，行 id 唯一） |
| 备份文件 | `dsh-home\cordis.patch.yml.bak-mimo-20260924-062303`（追加 MCP 全局行之前） |

**验证结果**

| 项 | 结果 |
| --- | --- |
| `scripts/build.mjs --check` | ✅ core + runtime-settings 同步 |
| `scripts/verify.mjs` | ✅ 全过（含新增 8 条：MCP live 锚定 2、dynamic 探测 2、ACCEPTED 分类 4） |
| `tests/core.test.mjs` | ✅ **27 项**（含 `isSuccessStatus`、ACCEPTED 派发后快照为 `ok`） |
| `tests/contracts.test.mjs` / `mcp-smoke` | ✅ 四工具 + MCP 握手 |
| MCP→状态灯 live 路径（修复 #1） | ✅ 端到端：写在 `<DSH_HOME>\plugins\mimo-indicator\mcp-live.json`，错误位置 `node_modules\plugins\` 无残留 |
| `mimo_settings` 渲染 | ✅ 独立 renderSettings，输出可读多行（不再是 `state=undefined`） |
| 真实 `mimo-desktop` 端到端 | ✅ 经运行中的桌面端：`ACCEPTED` + 真实 `ses_*`；`mimo_continue` 续接同会话成功 |
| 真实 `mimocode` 端到端 | ✅ 得到 `MiMo free API service has ended` → `isLimited` → `FALLBACK_TO_DSH`（预期路径） |
| ACCEPTED→绿灯（修复 #7） | ✅ 真实派发后 `lastStatus=ACCEPTED` 渲染 `state=ok`（此前为红色 ✗） |
| `/mimo-indicator/status` 路由 | ✅ HTTP 200，`presetActive: true`，快照含 MCP 写入的会话 |
| 需重启验证 | ⏳ 家级灯 host 半 1.2.2（当前 DSH 进程内仍是启动时加载的旧代码） |

### v1.1.0（2026-09-24）backend 预选 + 桌面端

| 项 | 结果 |
| --- | --- |
| `scripts/build.mjs --check` | ✅ core + runtime-settings 同步 |
| `scripts/verify.mjs` | ✅ 含 mimo_settings / BACKENDS / desktop-api 护栏 |
| `tests/core.test.mjs` | ✅ 25 项（含 resolveBackend 优先级、buildDesktopTurnBody 契约） |
| `tests/contracts.test.mjs` / `mcp-smoke` | ✅ 四工具 + settings 路径 |
| MCP `mimo_settings` | ✅ 读默认 backend / Desktop API 可用性 |
| MCP `mimo_run backend=mimo-desktop` | ✅ 经桌面 API `POST .../turns` 受理路径 |
| settings 预选优先级 | ✅ 单测锁定 arg > config > env > file > default |

### v1.0.0（2026-09-18）

| 项 | 结果 |
| --- | --- |
| `scripts/verify.mjs` | ✅ 30 项全过（client id / 版本三处 / 分发结构 / workflow 双行 / 工具名） |
| `tests/core.test.mjs` | ✅ 18 项 |
| 真实 `mimo run` 端到端（经 MCP tools/call） | ✅ 免费 API 已结束 → `isLimited` → `FALLBACK_TO_DSH` |

## 9. 给 DSH 维护方的一句话

保持 **client 模块 id === 主包名**、**workflow 双行 disabled 守卫**、**开发态不跨会话存活** 这三条，就不会再踩姊妹仓踩过的坑；其余结构与 `agy-first-bridge` / `codebuddy-first-bridge` 同构，可对照维护。
