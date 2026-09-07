# 3. 转录压缩契约：四档模式 × 每工具覆盖 × 间隔风格

Date: 2026-09-07

## Status

Accepted

## Context

`turnCollapse` 原本只是一个布尔开关（✻ run 行 vs 原生盒子）。实际使用中压缩粒度是分层的：有人只想每个工具占一行、有人想按类型归纳、有人要整段归纳，还有人要纯 pi 原生；且个别工具（如长输出的 bash）需要脱离全局策略单独展开或单独压缩。思考块（Thought）的可见性本身是 pi 原生 `hideThinkingBlock`（ctrl+t / pi 设置），但它直接决定压缩行能否归纳思考——用户需要在同一个面板里设置它。设置项契约如何定，决定了渲染层（`renderExpandedTurn` 分档 walk）与面板的结构。

## Decision

1. **四档模式** `turnCollapse.mode`：`native`（不压缩，运行中工具也无 spinner 单行）/ `single`（每工具一行 `▸`，互不归纳）/ `group-same`（连续同类归纳，Thought 与工具互不合并）/ `group-all`（原 ✻ 行，默认）。旧布尔值迁移：`true`→`group-all`，`false`→`native`。
2. **每工具覆盖**四态 `default` / `single` / `group-same` / `expand`，与模式共用同一套词汇；`default` 是显式状态（面板循环与 json 语义一致；存为 default 时从 json 删键），`*` 通配未点名工具。逐项状态是**绝对的**：不随模式退化（group-same 在 native 模式下照样归纳成行）；**group-all（整段归纳）只存在于全局模式层**，逐项不开放——归纳档位是全局决策。
3. **间隔风格** `turnCollapse.style`：`compact`（现状）/ `classic`（压缩行前后各空一行，相邻压缩行之间只留一行——由渲染闭包里的 deferredBlank 惰性插入，避免双空行）。
4. **思考块与工具共用同一套四态**（`turnCollapse.thought`：`default` / `single` / `group-same` / `expand`）：default 跟随模式（native→内联 / single→逐条标签 / group-same→归纳 Thought 行 / group-all→并入 run 行），其余绝对；「并入 run 行」只有模式 group-all + default 一条路径。事实源是 open-tui.json；pi 的 `hideThinkingBlock` 降级为**镜像**（expand→false，其余→true，变更时才写盘），保证扩展停用时 pi 原生行为一致。ctrl+t 翻转仍被采纳：展开→`expand`、折叠→`single`（显式态）。会话启动时若 pi 标志为 false 且 thought 为 default，则升级为 `expand`，尊重用户既有选择。
5. **重试错误折叠**独立为 `turnCollapse.retryErrors`（降噪不属于压缩语义，native 模式下也默认保留）。
6. **扩展/MCP 工具按需呈现**：pi 扩展 API 无法枚举已注册工具，`seenTools` 缓存运行时观察到的非内置工具名并持久化；面板对应区块只在缓存非空时出现。

## Considered Options

- **保留布尔 + 若干独立细分开关** — 否：组合语义（"开压缩但 bash 例外"）要跨多个键心算，UI 与渲染分支更乱；模式是用户心智里的单选。
- **三态 per-tool 用 inherit/缺省表示"跟随"** — 否：用户明确要求显式 `default` 状态；隐式缺省在面板里不可见、json 里语义含糊。
- **thought 自造一套名词（follow/label/merge/inline）** — 否：与工具/模式词汇不对齐，多一套概念；改为复用 default/single/group-same/expand。
- **逐项开放 group-all** — 否：整段归纳是全局决策，逐项开放徒增组合噪声（用户裁决）。
- **group-same 在 native 模式退化（降为单行）** — 否：逐项状态应绝对，语义随模式漂移不可预测；native 下照样归纳（用户裁决）。
- **Thought 在 open-tui.json 与 pi settings 双存储** — 否：双事实源会漂移；改为 open-tui.json 唯一事实源 + hideThinkingBlock 镜像。
- **面板动态枚举全部已注册工具** — 否：扩展 API 无此能力；静态猜 MCP 工具名不可靠。运行时观察 + 持久化缓存是可得的最诚实信号。
- **classic 严格"每行前后各空"（相邻双空行）** — 否：视觉割裂；合并为单空行更接近原生盒子节奏（用户已确认）。

## Consequences

- 正面：压缩粒度从 1 档变 4 档 × 工具/思考各四态逐项覆盖，且三层（模式/工具/思考）共用一套词汇；契约对旧配置自动迁移。
- 成本：walk 按模式分为两个：group-all 的 run walk（含辅助 Thought 行/同类组）与其余模式的统一 item walk（模式只决定 default 解析为）——分支收敛在 `toolTreatment` / `thoughtTreatment`；测试覆盖各档与覆盖组合。
- 已知限制：`seenTools` 只记调用过的工具（新装插件首次调用后出现）；Thought 的 ctrl+t 翻转在下一条新消息到达时才被采纳。
- 关联：CONTEXT.md「压缩模式 / 工具单行 / 每工具覆盖 / 压缩行间隔 / 思考块显示」词条。
