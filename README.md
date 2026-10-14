> **⚠️ 此包已统一 / This package is unified**
>
> 三个旧桥接包（agy / codebuddy / mimo）已合并为统一包 **[@luchenglong/cli-bridge](https://www.npmjs.com/package/@luchenglong/cli-bridge)**
> （仓库 [new-256/cli-bridge](https://github.com/new-256/cli-bridge)）。旧包在 npm 上已标记 deprecated。
>
> 安装：`npm i @luchenglong/cli-bridge`　迁移对照：[docs/MIGRATION.md](https://github.com/new-256/cli-bridge/blob/main/docs/MIGRATION.md)
> 本仓库已归档（只读），代码与历史保留。

---

# mimo-first-bridge

> 一个用于 **DeepSeek Harness (DSH)** 的 Cordis 插件：把编码/构建/调试/排查等实际工作**优先派发给本机的 `mimo` CLI**（**Xiaomi MiMo Desktop / MiMoCode**），DSH 全程掌控 mimo（`--dangerously-skip-permissions`，mimo 全程无提示），并在 **mimo 流量受限 / 网络不通 / 认证失败** 时弹窗让用户选择是否回退到 **DSH 本地 API 配置**；同时在会话标题栏提供一个 **实时状态灯**，清晰显示 mimo 是否正在工作。

同构姊妹项目：[`agy-first-bridge`](../agy-first-bridge)、[`codebuddy-first-bridge`](../codebuddy-first-bridge)。

## 这是什么

`mimo-first-bridge` 是 **DeepSeek Harness (DSH)** 的 Cordis 插件。它注册模型工具（`mimo_run`、`mimo_continue`、`mimo_status` 与 `mimo_settings`），把真实工作转交给本机 **`mimo` CLI**（MiMoCode）或 **Xiaomi MiMo 桌面客户端** 执行，并注入 *mimo-first* 策略，让模型在各种模式下优先使用 mimo。

## 四种形态

| 形态 | 位置 | 能力 | 状态灯 | 持久 |
| --- | --- | --- | --- | --- |
| **Agent preset** | [`preset/mimo-first/`](preset/mimo-first/) | `mimo_run` / `mimo_continue` / `mimo_status` / `mimo_settings` + MiMo-First 策略 + 回退弹窗（双后端） | ❌（依赖家级） | ✅ |
| **家级状态灯** | [`home-plugin/mimo-indicator/`](home-plugin/mimo-indicator/) | 所有会话自动显示实时状态灯 | ✅ | ✅ |
| **动态 Cordis 插件** | [`dynamic/`](dynamic/) | `mimo_run` / `mimo_continue` / `mimo_status` + mimocode 后端（沙箱无 fs/import，mimo-desktop 返回 DESKTOP_UNSUPPORTED）+ 推入家级状态灯 | ✅ | ❌ 进程内 |
| **MCP server** | [`mcp/`](mcp/) | 任意 MCP 宿主自动发现四工具（含 `mimo_settings` 与双后端） | ❌ | ✅（客户端配置） |

**推荐组合：preset + 家级状态灯**（`dsh plugin --profile web add mimo-first-bridge` 一次装齐）。

## 模型工具 + 设置

### 设置：提前预选派发目标（backend）

用户可在**设置**中提前选择调用 **MiMoCode** 还是 **小米桌面客户端**，无需每次指定：

| 预选途径 | 示例 |
| --- | --- |
| **settings 文件**（推荐给最终用户） | `%APPDATA%\mimo-first-bridge\settings.json` → `{ "backend": "mimocode" \| "mimo-desktop" }` |
| **工具** | `mimo_settings({ backend: "mimo-desktop" })` 读/写默认值 |
| **插件 config**（cordis 行 / DSH 插件配置） | `config.backend: mimocode \| mimo-desktop` |
| **环境变量** | `MIMO_BRIDGE_BACKEND=mimo-desktop` |
| **单次覆盖** | `mimo_run(..., backend: "mimocode")` |

优先级：**工具参数 > 插件 config > 环境变量 > settings 文件 > 默认 `mimocode`**。

| backend | 含义 | 调用方式 |
| --- | --- | --- |
| `mimocode`（默认） | 本机 `mimo` CLI（MiMoCode） | `mimo run --format json --dangerously-skip-permissions` |
| `mimo-desktop` | 小米 MiMo **桌面客户端**本地 API | Desktop 开启时经 `desktop-api.json`（`Authorization: Bearer`）`POST /v1/sessions/:id/turns` |

`mimo-desktop` 需 **Xiaomi MiMo 桌面端在运行**；未启动时返回 `DESKTOP_UNAVAILABLE`，可改回 `mimocode`。

### `mimo_run`

```text
mimo_run(prompt, backend?, mode?, model?, effort?, cwd?, timeoutSec?, background?, title?)
```

把任务派给预选 backend（或本次指定的 `backend`）。`mimocode` 强制 `--format json --dangerously-skip-permissions`，从不弹权限提示。

- `backend`：`mimocode` | `mimo-desktop`（默认用设置里的预选值）
- `mode`：`auto`（跟随 DSH plan）/ `plan`（只读）/ `build`（全工具）/ `compose`
- `model`：`provider/model`（mimocode）或桌面模型 id 如 `mimo-auto`（mimo-desktop）
- `effort`：`low|medium|high` → `--variant minimal|high`（仅 mimocode）
- `background`：默认 `true`（立即返回 jobId，用 `job_output` 收取；`mimo_status` 看进度）

### `mimo_continue`

```text
mimo_continue(prompt, sessionId?, latest?, backend?, ...)
```

续接既有会话（mimocode：`--session` / `--continue`；mimo-desktop：同 sessionId 投递 turn）。

### `mimo_status`

```text
mimo_status(cwd?)
```

实时观察 + 用量统计 + `defaultBackend`（当前预选）。

### `mimo_settings`

```text
mimo_settings(backend?, desktopModel?)
```

读/写**预选 backend** 与桌面模型，持久化到 settings 文件。无参调用返回当前生效配置（含 Desktop API 是否可用）。

## 安装

见 [docs/INSTALL.md](docs/INSTALL.md)。快速路径：

```powershell
dsh plugin --profile web add mimo-first-bridge
```

前提：本机 `mimo --version` 可用（Xiaomi MiMo Desktop / MiMoCode CLI）。

## MCP（可选）

不需要 DSH 时，把 [`mcp/mimo-mcp-server.mjs`](mcp/mimo-mcp-server.mjs) 注册为 MCP 服务器，Claude Code / Codex / Cherry Studio 等宿主即可自动发现四个工具（`mimo_run` / `mimo_continue` / `mimo_status` / `mimo_settings`）：

```bash
node mcp/mimo-mcp-server.mjs --check
claude mcp add mimo -- node C:\path\to\mimo-mcp-server.mjs
```

## 开发

```bash
npm run build     # 同步 core → preset 副本
npm run check     # build --check + verify + MCP --check
npm test          # core + contracts + mcp-smoke
```

**关键契约**：client 模块 id 永远 === 主包名 `mimo-first-bridge`（`scripts/verify.mjs` 已锁死）。详见 [docs/HANDOVER.md](docs/HANDOVER.md) 与 [docs/DEV-DISCIPLINE.md](docs/DEV-DISCIPLINE.md)。

## 安全说明

`--dangerously-skip-permissions` 表示 mimo 会在不再询问的情况下改动文件、执行命令。这是「DSH 完全控制 mimo」的直接实现，请仅在你信任执行环境时使用。

## License

MIT
