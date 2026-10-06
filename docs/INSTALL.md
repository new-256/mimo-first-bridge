# 安装指南

本插件提供三种形态，可组合使用：

1. **持久 Agent Preset** —— 工具 + MiMo-First 优先策略 + 回退弹窗 + `mimo_status`（多数用户首选）；
2. **家级状态灯插件** —— 状态灯随软件启动、所有会话自动显示、无需审批（与方式 A 搭配）；
3. **动态 Cordis 插件** —— 进程内临时形态（需一次性审批）。

另有 **MCP server**，可让 Claude Code / Codex / Cherry Studio 等任意 MCP 宿主发现 `mimo_*` 工具。

**推荐组合：方式 A + 方式 B**。

---

## 前提

- 一套可运行的 **DeepSeek Harness (DSH)**。
- 按预选 backend 二选一（或都装）：
  - **`mimocode`**：本机 **`mimo` CLI**（`mimo --version`，如 `C:\Users\<you>\.mimocode\bin\mimo.exe`；可用 `MIMO_BIN` 覆盖）。
  - **`mimo-desktop`**：**Xiaomi MiMo 桌面客户端在运行**（本地 API 见 `%APPDATA%\Xiaomi MiMo\desktop-api.json`）。
- 会话组合 Host 服务：`tools`、`subprocess`、`systemPrompt`、`timer`；可选：`jobs`、`planMode`、`sandboxPolicy`、`userQuestions`。

## 设置：预选 mimocode / 小米桌面客户端

安装后可**提前预选**派发目标（不必每次传 `backend`）：

1. **settings 文件**（最终用户最简单）：编辑 `%APPDATA%\mimo-first-bridge\settings.json`

   ```json
   {
     "backend": "mimo-desktop",
     "desktopModel": "mimo-auto"
   }
   ```

   参考仓库根目录 [`settings.example.json`](../settings.example.json)。路径可用 `MIMO_BRIDGE_SETTINGS` 覆盖。

2. **工具**：会话内调用 `mimo_settings({ backend: "mimocode" })` 即可写入并查看生效值。

3. **插件 config**（cordis 行，可进 DSH 插件配置）：

   ```yaml
   - id: mimo-first-bridge
     name: './mimo-first-bridge.mjs'
     config:
       backend: mimo-desktop   # 或 mimocode
   ```

4. **环境变量**：`MIMO_BRIDGE_BACKEND=mimo-desktop`（或 `MIMO_BACKEND`）。

优先级：工具参数 `backend` > 插件 `config.backend` > 环境变量 > settings 文件 > 默认 `mimocode`。

---

## 方式 A：持久 Agent Preset（推荐）

### 1. 用户 preset 根目录

```
${DSH_HOME:-$HOME/.dsh}/.agent-presets/
```

本仓库开发环境中它是：

```
C:\Users\<you>\AppData\Roaming\DSH Desktop\dsh-home\.agent-presets\
```

> 新版 DSH（0.1.6+）推荐用 bundle patch 声明预设（见 `home-plugin/mimo-indicator/cordis.patch.yml` 的 `preset-cordis-mimo` 行）。legacy 目录安装仍可用于本地调试。

### 2. 复制 preset 目录（legacy / 本地调试）

```powershell
Copy-Item -Recurse .\preset\mimo-first "$env:DSH_HOME\.agent-presets\mimo-first"
```

```bash
cp -R ./preset/mimo-first "${DSH_HOME:-$HOME/.dsh}/.agent-presets/mimo-first"
```

目录应为：

```
.agent-presets/mimo-first/
├─ preset.yml
├─ agent.cordis.yml
├─ mimo-core.mjs
└─ mimo-first-bridge.mjs
```

### 3. 语法自检

```bash
node --check ./preset/mimo-first/mimo-first-bridge.mjs
node --check ./preset/mimo-first/mimo-core.mjs
```

### 4. 使用

新开会话时选择 preset **`MiMo-First 执行代理`**（id：`mimo-first` 或 bundle 声明的 `cordis-mimo`）。你将得到 `standard` 的全部能力，外加 `mimo_run` / `mimo_continue` / `mimo_status`、MiMo 优先策略与限流/网络回退弹窗。

> **重要：切勿编辑随部署发行的 `agent-presets` 安装目录**（升级会被覆盖）。始终安装到用户 preset 根目录下的独立子目录。

### 5. 经 npm bundle 安装（制品态，推荐生产）

```powershell
dsh plugin --profile web add mimo-first-bridge
# 或本地：
dsh plugin --profile web add <本仓库路径>
```

`package.json` 的 `dsh.bundle.patch` 会自动挂上 `mimo-indicator` 状态灯与 `preset-cordis-mimo` 预设声明。

---

## 方式 B：家级状态灯插件

`npm`/bundle 安装会自动带上灯。若手工安装：

```powershell
$dshHome = "$env:APPDATA\DSH Desktop\dsh-home"
Copy-Item -Recurse .\home-plugin\mimo-indicator "$dshHome\plugins\mimo-indicator"
New-Item -ItemType Junction -Path "$dshHome\node_modules\mimo-first-bridge" -Target (Resolve-Path .)
# 用户层 cordis.patch.yml 追加：
# - insert:
#     - id: mimo-indicator
#       name: mimo-first-bridge
```

校验：

```powershell
Invoke-WebRequest -Uri "http://127.0.0.1:<DSH端口>/mimo-indicator/status"
```

---

## 方式 C：动态 Cordis 插件（进程内临时形态）

1. 在一个已加载 Cordis 能力的 DSH 会话里，用 `cordis_define` 定义插件：
   - `code.host` = [`dynamic/host.js`](../dynamic/host.js) 的完整内容；
   - `code.client` = [`dynamic/client.js`](../dynamic/client.js) 的完整内容。
2. 用 `cordis_run`（`mode: "run"`）激活返回的 `pluginId` / `packageId`。
3. 首次运行 **Client 半** 时，DSH GUI 会弹出一次性审批。
4. 停用用 `cordis_stop`；删除用 `cordis_undefine`。

---

## MCP server（任意 MCP 宿主）

```bash
node mcp/mimo-mcp-server.mjs --check   # 自检
```

注册示例：

```text
Claude Code : claude mcp add mimo -- node C:\path\to\mimo-mcp-server.mjs
Codex       : ~/.codex/config.toml [mcp_servers.mimo]
              command = "node"
              args    = ["C:\\path\\to\\mimo-mcp-server.mjs"]
```

---

## 卸载

- **Preset**：删除 `.agent-presets/mimo-first/`（或从 bundle patch 移除 `preset-cordis-mimo` 行）。
- **家级状态灯**：从 bundle/用户层 `cordis.patch.yml` 移除 `mimo-indicator` 行，删除 `dsh-home/plugins/mimo-indicator/` 与相关 junction。
- **动态插件**：`cordis_undefine <pluginId>`。
