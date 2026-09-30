# 9. pi 0.99 适配：原生功能让位与原生 MCP 计数（双代并存策略）

Date: 2026-10-01

## Status

Accepted

## Context

pi 0.99（0.99.0/0.99.1，2026-09-29 发布）吸收了两块我们自带的机制：

1. **全屏滚轮速度**：pi-tui 公开 `setWheelScrollLines(number | "auto")` + 加速器，pi 从自己的 settings 读取 `fullscreenWheelScrollLines` 并在启动、设置变更等多处回写。我们的 `fullscreen.wheelScrollLines` 走的是写 0.87 私有字段的 shim——同一旋钮出现两个 owner，回写必然打架。
2. **MCP**：原生支持 `mcp.json`（全局 agentDir + 受信项目 `.pi/mcp.json`）+ `pi.registerMcpServer()` 运行时注册，`/mcp` 与 `pi mcp` 管理。我们的 HUD 环境段此前只统计 pi-mcp-adapter 的配置链（仅当 adapter 实际安装）。

约束：用户运行环境横跨 0.85–0.99（本机 0.87.1 + adapter 是现实存在的运行态），`peerDependencies >=0.85` 不能收窄；pi-mcp-adapter 的适配备忘明确要求**暂时保留**。

另核实：0.87→0.99 我们触碰的全部 API 面（CustomEditor 钩子体系、pi-tui Editor、全部 import 符号）逐字节相同或存活，typecheck+全量测试在两代 devDeps 下均绿——无需其他兼容层。`ctx.ui.theme` 是读穿 globalThis Symbol 的 Proxy，system 主题明暗切换重建实例也不会让我们的缓存引用失效。

## Decision

1. **滚轮让位而非桥接**：`hasNativeFullscreenWheelScroll()`（`piVersionAtLeast("0.99.0")`，对比 pi 的 `VERSION`）为真时 `applyFullscreenWheelScrollLines` 直接 no-op，设置 UI 该项显示"pi ≥0.99 原生接管"且 Enter 不再弹数字输入。理由：pi 在三个时机回写自己的值，桥接（用公开 setter 推我们的值）会互相覆盖、最后写者胜出不可预测；且原生多出 `"auto"` 加速模式严格更强。配置字段保留，降级 pi 上行为不变。
2. **MCP 计数并集**：HUD 环境段在 pi ≥0.99 追加统计原生服务器（全局 `mcp.json` + 受信项目 `.pi/mcp.json`——项目条目替换同名全局条目，`enabled: false` 不计——+ `pi.getMcpServers()` 运行时注册），与 adapter 配置链**同时**计数、按名去重、同名原生优先。adapter 链原样保留（"不要丢掉"），迁移期两者并存时数字诚实。刻意**不订阅** `mcp_servers_change`——处理该事件会把本扩展标记为"MCP 连接器"，产生劫持语义。
3. **版本探测统一走 `piVersionAtLeast`**（`current` 参数可注入供测试），分散的 feature-detect 不再各写一套。
4. devDeps 升至 0.99.1（CI 持续证明前向兼容），0.85–0.98 路径由门控测试与 mock 覆盖（双代各跑一遍全量：0.99 下 234 pass + 1 门控 skip，0.87 下 235 全过）。

## Considered Options

- **滚轮桥接（0.99 上把我们的值推进原生 setter）**——pi 三处回写点会覆盖我们，互相打架不可预测，否。
- **滚轮设置项直接删除**——降级 pi（含本机 0.87.1）失去功能，破坏 `>=0.85` 承诺，否。
- **MCP 计数版本二选一切换（0.99 只看原生、忽略 adapter）**——迁移期 adapter 仍在供数时显示 0，误导；并集+去重才是诚实计数，否。
- **订阅 `mcp_servers_change` 拿实时注册变化**——事件处理即"自认 MCP 连接器"，与内置 MCP 扩展冲突，否；改用 `pi.getMcpServers()` 拉取（60s 环境段刷新已足够）。

## Consequences

- 双代行为矩阵靠 `piVersionAtLeast` 一处收口；pi 后续若再吸收我们的机制（遥测、折叠等），沿用本 ADR 的判定框架：让位（回写打架/原生更强）或并集（纯计数/展示类）。
- 0.99 上我们的滚轮配置值变成死数据（UI 已标注指向原生）；若用户降级 pi，值自动重新生效。
- adapter 下线后（用户明确表态前）其计数链保留不动；届时可整块删除并回缩本 ADR 的 MCP 部分。
- 测试对代际敏感的场景（滚轮 prompt 交互、shim 写入）以 `hasNativeFullscreenWheelScroll()` 门控 skip，两代各自的全量绿是合并门禁。
