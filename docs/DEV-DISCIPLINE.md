# 开发纪律：开发-制品闭环（DEV DISCIPLINE）

> 本纪律适用于本机**所有 DSH 插件**的开发与部署（继承自 agy-first-bridge / codebuddy-first-bridge 事故制度）。

## 闭环流程（每版必走，缺一环不算完成）

```
开发 → 测试 → 提交仓库 → 发版（tag + npm publish）
     → 卸载本地开发态接线
     → 从制品源安装（registry / 固定 tag）
     → 测试（含需要重启的运行时验证）
     → 对比一致性（已安装 ≡ 发布 tag）
     → 闭环备案（写入交接文档并提交）
     → 等待下一次修订
```

加粗环节（卸载开发态 → 制品安装 → 一致性对比 → 备案）最常被跳过，也全部是事故来源。

## 十条纪律

1. **交付即制品**：版本发布并验证通过后，本机部署必须切换到**制品形态**（registry 安装）。禁止让 `file:` 依赖 / junction 直连仓库工作副本的开发态接线跨会话存活。
2. **开发态是临时的**：开发态接线仅限活跃开发会话内使用；会话收尾时必须拆除，或在交接文档中显式标注「当前为开发态 + 接线位置」。
3. **路径解耦**：部署配置中禁止出现指向**易变路径**（桌面、用户目录、可迁移的仓库位置）的引用。一律使用 registry 包名或长期稳定路径。
4. **完整性校验**：从制品源安装必须校验完整性——`npm pack` 下载后比对 tgz SHA512 与 `npm view <pkg>@<ver> dist.integrity`。
5. **一致性核验**：安装后对比「已安装文件 vs 发布 tag」：文件清单 + 内容哈希（CRLF/LF 归一化后再比）。任何差异必须逐项归因。
6. **交接文档反映真实形态**：交接 / 部署文档必须记录**当前真实部署形态**、各层版本、验证方法；「待重启验证」的变更要写明验证步骤。
7. **闭环备案**：闭环执行记录（备份文件名、完整性校验值、对比结论、提交号）写入交接文档并提交进仓库。
8. **变异验证（新护栏必须能失败）**：新增的回归测试 / verify 护栏，必须用「把修复回退成原始 bug」的方式验证它**真的会失败**。只跑「测试通过」不算验收 —— v1.2.3 就抓到过一个空转测试（项目数 15 < 上限 24，从未进入淘汰分支，测什么都通过）。
9. **对外契约必须进护栏**：与**外部框架**的交互（DSH 的 `slots.register(options, component)` 签名、`exports.inject` 声明、Cordis 服务名……）必须写进 `scripts/verify.mjs`。v1.2.3 的 45 条护栏**全部只校验自身内部一致性**，没有任何一条覆盖框架 API 契约，于是一个"状态灯从未注册成功"的 P0 缺陷一路绿灯发布出去。
10. **禁止静默吞错**：`try { ... } catch (e) {}` 会把"彻底失败"伪装成"没有内容可渲染"。注册类 / 初始化类调用要么不吞，要么在 catch 中落到可见状态（console.warn + 状态灯降级）。v1.2.5 的灯不显示，就是因为必崩的 `slot "undefined" is not declared` 被空 catch 吞掉，浏览器控制台全无痕迹。

> **规则 8 的第二次实战（v1.2.5 假护栏）**：新增的"不得用 OR 聚合"护栏本身是假护栏，
> 变异测试连续抓出 **7 个漏网点**：① 只认 `= list.some(`，被 `if (some()) x = true` 绕过；
> ② 正则只锚行首，`if (...)` 前缀写法漏网；③ RHS `[^\n;]+` 吃穿行尾，同行双赋值被吞；
> ④ 声明排除正则 `[^\n]*?` 跨 `{}` `;`，把 `for (const q ...)` 误判为声明而排除。
> **结论：护栏的自然语言目标（"不得用 OR"）不能靠枚举正则实现，必须转成可判定的
> 结构性命题（"赋值点恰好 1 个，且来源为 `top`"），并对该命题做多写法变异验证。**
> 最终该护栏通过 **12 种 OR 写法变体**的变异矩阵全部捕获才算合格。

## 本仓部署形态速查

| 层 | 载体 | 形态 |
| --- | --- | --- |
| Agent preset | bundle `preset-cordis-mimo`（随包分发） | 制品态 |
| Profile bundle | `dsh-home\profiles\web`（`dsh plugin --profile web add mimo-first-bridge`） | 制品态（推荐） |
| 家级状态灯 | 同包 `home-plugin/mimo-indicator`（bundle patch 行 `mimo-indicator`） | 随包分发 |
| 宿主 MCP 全局 | `dsh-home\cordis.patch.yml` 的 `mcp-mimo-global` 行 → `dsh-home\bin\mimo-mcp\mcp\mimo-mcp-server.mjs` | 稳定绝对路径 + 自包含拷贝 |

> 自包含副本共 **4 处**：`core/mimo-core.mjs`（单一真源）、`preset/mimo-first/mimo-core.mjs`（build.mjs 同步）、
> `home-plugin/mimo-indicator/lib/index.mjs`（host 半）、`dynamic/host.js`（沙箱禁止 import）。
> **改 core 的状态机语义时必须手同步后三者**，`scripts/verify.mjs` 已为关键契约加锁。

## 事故背景（为什么要这份纪律）

参考姊妹仓事故：

- **agy-first-bridge v1.6.2**：仓库迁移导致 `file:` + junction 开发态断链 → **状态灯 bundle 静默失效**（工具仍可用而灯不亮）。
- **codebuddy-first-bridge v1.1.7→v1.1.8**：client.js 注册 id 误用内层包名 → `arrive()` 抛 `loaded without registering` → **整屏插件页崩溃**，桌面壳 enterSafeMode 全树注释。
- **mimo-first-bridge v1.2.3**：`slots.register` 用错签名 + 缺 `inject` 声明，且被空 `catch` 吞错 → **状态灯从未出现**，而 45 条护栏全绿（护栏只校验自身一致性，不覆盖框架契约）。见规则 9、10。

本仓已用 `scripts/verify.mjs` 把 **client 模块 id === 主包名** 钉死为发布闸门。

**教训：开发态接线是有保质期的债——发布之日就是还债之时。**
