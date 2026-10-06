# 架构

## 背景：DSH / Cordis 的两个平面

DSH 的能力由 Cordis 组合而成，每个能力是 `cordis.yml` 里的一行插件。存在两个平面：

- **Host 平面**：跑在 DSH 的 Node.js 进程里，掌管注册表、沙箱与审批栈、持久化、模型路由等。
- **Client 平面**：跑在浏览器页面里，负责主题、布局、工具卡片、Slot UI。

一个 **Agent Preset** 是「单个会话向这些注册表贡献了什么」——它的工具、人设、提示段。本插件只向 `tools` / `systemPrompt` 注册、不发布服务，属于「preset 面安全」的（像 `tool-fs`），无需 isolate realm。

Host 与 Client 之间只能通过包私有的 JSON RPC 通信：Host 用 `harness.handle(method, handler)` 暴露方法，Client 用 `host.call(method, args)`，方向是 **Client → Host**。

## 组件总览

```
                          ┌─────────────────────────── DSH Host (Node.js) ───────────────────────────┐
                          │                                                                          │
  模型 (任一模式)  ──工具调用──▶  mimo_run / mimo_continue / mimo_status                                │
                          │        │                                                                 │
                          │        ├─ buildArgv: 强制 --dangerously-skip-permissions               │
                          │        │              + --format json + --agent / --model / --variant    │
                          │        │                                                                 │
                          │        ├─ subprocess.spawn(mimo run ...) ──────▶  本机 mimo CLI           │
                          │        │      exec.signal + ctx.timeout→terminate() 做取消/超时           │
                          │        │      逐行解析 NDJSON 事件 → 更新 current/trail（实时）            │
                          │        │                                                                 │
                          │        ├─ 解析 text/error 事件 → { ok, status, response, sessionId, ... } │
                          │        │                                                                 │
                          │        ├─ 失败且疑似限流/网络？ ──▶ userQuestions.ask()  ← 真人弹窗          │
                          │        │         回退 → { fallback:true, status:FALLBACK_TO_DSH }         │
                          │        │         重试 → 再跑一次（上限 2 次）                              │
                          │        │                                                                 │
                          │        └─ 更新 status 快照 (begin/end + foldStep) ──┐                   │
                          │                                          │                                │
                          │   systemPrompt.section('mimo:policy')    │  ctx.emit('mimo/status')       │
                          │                                          │            ▲                   │
                          └──────────────────────────────────────────┼────────────┼───────────────────┘
                                                                     │            │
                          ┌───────────────── DSH Client (浏览器) ──────┼────────────┼───────┐
                          │  会话标题栏 Slot: conversation.session.header.utilities │       │
                          │       状态灯 Indicator（家级 mimo-indicator）             │       │
                          │       ● 工作中/成功/失败/本地回退/就绪                    │       │
                          └────────────────────────────────────────────────────────────────┘
```

## 四形态

```
mimo-first-bridge
├── preset/mimo-first/          ① Agent preset 形态（方式 A）
│   ├── agent.cordis.yml        # bridge 行 + persona 行 + workflow 双行
│   ├── preset.yml
│   ├── mimo-core.mjs           # 由 scripts/build.mjs 从 core/ 同步
│   └── mimo-first-bridge.mjs   # 会话内插件：mimo 优先派发 + 限流回退
├── home-plugin/mimo-indicator/ ② 家级状态灯（方式 B）
│   ├── cordis.patch.yml        # bundle 补丁层（id: mimo-indicator / name: mimo-first-bridge）
│   ├── lib/index.mjs           # host 半：mimoCollector 服务 + /mimo-indicator/status
│   ├── lib/client.js           # client 半：__ModuleLoader__.load({ id: "mimo-first-bridge" }) ←⚠ 契约
│   └── lib/client-entry.mjs    # 裸名行占位
├── dynamic/                    ③ 动态 Cordis 插件形态（方式 C，自包含 host.js/client.js）
└── mcp/mimo-mcp-server.mjs     ④ MCP server（零依赖，bin: mimo-mcp-server）
```

## 共享核心

```
core/mimo-core.mjs（单一事实来源：纯函数 + createStatusEngine + createLineStream
                    + buildArgv/parseMimoJson/buildResult + POLICY_TEXT）
   ├─ 直接 import（preset 经 ./mimo-core.mjs；MCP 经 ../core/mimo-core.mjs）
   ├─ scripts/build.mjs 同步副本 preset/mimo-first/mimo-core.mjs
   └─ dynamic/host.js 自包含内联（沙箱禁止 import）
```

`scripts/build.mjs --check` 保证 preset 副本与 core 一致（CI / npm test）。

## 关键约束（沙箱 vs 真实 Node）

| 约束 | 动态插件（沙箱） | Preset `.mjs`（真实 Node） |
| --- | --- | --- |
| `import` / `require` | ❌ 禁止 | ✅ 可用（仅 `./mimo-core.mjs`，不得 `@deepseek-ai/*`） |
| `AbortController` | ❌ 无（改用 `exec.signal` + `handle.terminate()`） | ✅ 有，但仍沿用同一套 |
| `process` / `Buffer` / 原生定时器 | ❌ 无 | ✅ 有 |
| 工具注册 | `harness.registerTool(ctx, harness.defineTool({...}))` | `ctx.tools.register(<纯对象 ToolDefinition>)` |
| Host→Client RPC | `harness.handle`（本插件未用；灯走 HTTP） | ⚠️ 无 Client 半 |

## 家级状态灯（`home-plugin/mimo-indicator/`）

```
会话内 mimo-first-bridge                        DSH Host（root realm）
  ┌─ preset 形态（真 Node 模块）：                ┌─ mimo-indicator host 半（lib/index.mjs）
  │   begin/end/foldStep                         │   ctx.on('mimo/status') → projects[cwd] 全局表
  │   ── ctx.emit('mimo/status', {snapshot}) ───►│   ctx.on('mimo/mode')   → presetActive 租约
  │   （挂载时 emit mimo/mode {active:true}，30s 续期）│   ctx.provide('mimoCollector', {mergeSnapshot})
  │                                                │   webServer.register({kind:'exact', path:'/mimo-indicator/status'})
  └─ 动态形态（沙箱无 ctx.emit）：                 │   GET → JSON {state, running, projects[], presetActive}
      publish() → ctx.get('mimoCollector')           │
      .mergeSnapshot(snapshot()) ─────────────────►│   （服务方法调用，无需事件）
      MCP 子进程写 mcp-live.json ────────────────►│   status 路由读盘合并
                                                    ▼
                                        DSH Client（浏览器）
                                          mimo-indicator client 半（lib/client.js，花名册模块）
                                          fetch('/mimo-indicator/status') 每 1.2s → 按项目渲染灯
```

- host 半：`ctx.on('mimo/status')`（preset）与 `mimoCollector` 服务（动态）与 `mcp-live.json`（MCP）汇入同一张 `projects[cwd]` 表。
- `presetActive` 是心跳租约（TTL 75s，preset 每 30s 续期）。
- client 半：`window.__ModuleLoader__.load({ id: "mimo-first-bridge", factory })` — **id 必须等于主包名**。
- **裸名行占位 `lib/client-entry.mjs`**：防止 file:// 行与裸名行把 host 逻辑加载成两个 ESM 实例导致 `ctx.provide` 二次注册崩溃。

## CLI 映射（Xiaomi MiMo Desktop / MiMoCode `mimo`）

| 工具参数 | mimo CLI |
| --- | --- |
| prompt | `mimo run [message...]` |
| — | `--format json --dangerously-skip-permissions` |
| mode plan / build / compose | `--agent plan\|build\|compose` |
| model | `--model provider/model` |
| effort low / high | `--variant minimal\|high` |
| cwd | `--dir` |
| sessionId / latest | `--session <id>` / `--continue` |
| title | `--title` |
| timeoutSec | 宿主硬超时 + 60s 优雅期（**mimo 无 --print-timeout**） |

输出为 NDJSON 事件流；`parseMimoJson` 抽取 `sessionID`、`text`/`message` 正文、`error` 事件、`tool`/`step_*` 轨迹。

## 生命周期与可逆性

所有副作用都挂到当前 Fiber，`cordis_stop` / `cordis_undefine` / preset 卸载时自动回收：

- 工具：`ctx.tools.register(...)` / `harness.registerTool(...)` 返回 disposer；
- 提示段：`ctx.systemPrompt.section(...)`；
- 样式：`styles.insert(...)`（`ctx.effect` 包裹）；
- 定时器：`ctx.timeout(...)` / `ctx.interval(...)` 返回 disposer。

## 数据流纪律

插件从不序列化 DSH 的活对象（Service / Event / Slot / Session）。它只读取需要的叶子字段（mimo 的 stdout 文本、退出码、sessionId 等），构造最小的、无 Host 引用的 JSON 对象跨 RPC 传输和展示。
