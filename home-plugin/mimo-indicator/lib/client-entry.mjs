/**
 * @file client-entry.mjs
 * @description 组合树里 name: mimo-indicator 裸名行的宿主半边入口 —— 空操作占位。
 * 真正的宿主逻辑在 cordis.patch.yml 的 file:// 行（若部署），或主包 main 解析到的 lib/index.mjs。
 *
 * 为什么存在（沿自 agy-first-bridge v1.5.4 / codebuddy v1.1.8 教训）：
 * 宿主侧 client-modules 只扫描「裸包名」行才能发现 package.json 的 dsh.client
 * 声明。若同一宿主逻辑被 file:// 行与裸名行加载成两个 ESM 实例（URL 不同），
 * apply 执行两次 → ctx.provide 二次注册同名服务 → 后端启动崩溃。
 */
export const name = 'mimo-indicator-client'

export function apply() {}
