# 回退与状态灯

## 限流 / 网络回退弹窗

`mimo_run` / `mimo_continue` 每次执行后，若结果 `ok === false` 且被判定为「疑似流量受限 / 网络不通 / 认证失败」，就会触发回退弹窗。判定 `isLimited(res)` 命中任一即可：

- 状态为 `SPAWN_ERROR` / `MIMO_UNAVAILABLE` / `HUNG_TIMEOUT`；
- stderr / response / errorMessage / status 命中 `LIMIT_RE`（含 rate limit、429、quota、ETIMEDOUT、`free API service has ended`、网络/超时/限流/额度/认证/登录/第三方 等中英文关键词）。

弹窗选项：

| 选项 | 值 | 含义 |
| --- | --- | --- |
| 使用 DSH 本地 API 配置（回退） | `fallback` | 结果 `fallback=true` / `status=FALLBACK_TO_DSH`，模型应改用原生工具完成 |
| 重试 mimo 一次 | `retry` | 再跑一次（总共最多 2 次） |
| 不回退（返回错误） | `error` | 返回 mimo 原始错误 |

### 给模型的提示（已写入 `mimo:policy`）

> 若返回 `fallback=true`（status FALLBACK_TO_DSH），表示用户选择回退：请用原生 DSH 工具 / 本地模型完成本任务，且**不要**再调用 mimo。若 `ok=false` 但没有 `fallback`，报告 mimo 错误。绝不循环调用 mimo；绝不让 mimo 回调 DSH。

MCP 形态无 UI 弹窗：失败时在结果文本中附加同样的防循环提示，回退决策交给调用方代理。

## 状态灯

| 状态 | 样式 | 含义 |
| --- | --- | --- |
| running | 蓝色呼吸圆点 `⟳ MIMO` | 有项目正在跑 |
| ok | 绿色 `✓ MIMO` | 最近一次成功 |
| failed | 红色 `✗ MIMO` | 最近一次失败 |
| fallback | 琥珀 `↩ MIMO` | 用户选择了 DSH 本地回退 |
| idle | 灰色 `MIMO` | 无最近运行（preset 激活时常驻占位） |

数据源：`GET /mimo-indicator/status` → `{ state, running, projects[], presetActive }`。浏览器每 1.2s 轮询；点击灯打开详情面板（当前步骤 + 轨迹）。

显示策略：

- 本会话是 MiMo preset（`presetActive` 租约有效）→ 常驻显示；
- 普通会话 → 仅在有运行中/回退/短时 ok/failed 项目时显示。

三个数据入口汇入同一张表：

1. preset：`ctx.emit('mimo/status')`；
2. 动态插件：`mimoCollector.mergeSnapshot()`；
3. MCP 子进程：写 `<dsh-home>/plugins/mimo-indicator/mcp-live.json`，路由读盘合并。
