# 3. 转录压缩契约：四档模式 × 每工具覆盖 × 间隔风格

Date: 2026-09-07

## Status

Accepted

## Context

`turnCollapse` 原本只是一个布尔开关（✻ run 行 vs 原生盒子）。实际使用中压缩粒度是分层的：有人只想每个工具占一行、有人想按类型归纳、有人要整段归纳，还有人要纯 pi 原生；且个别工具（如长输出的 bash）需要脱离全局策略单独展开或单独压缩。思考块（Thought）的可见性本身是 pi 原生 `hideThinkingBlock`（ctrl+t / pi 设置），但它直接决定压缩行能否归纳思考——用户需要在同一个面板里设置它。设置项契约如何定，决定了渲染层（`renderExpandedTurn` 分档 walk）与面板的结构。

## Decision

1. **四档模式** `turnCollapse.mode`：`native`（不压缩，运行中工具也无 spinner 单行）/ `single`（每工具一行 `▸`，互不归纳）/ `group-same`（连续同类归纳，Thought 与工具互不合并）/ `group-all`（原 ✻ 行，默认）。旧布尔值迁移：`true`→`group-all`，`false`→`native`。
2. **每工具覆盖**三态 `default` / `single` / `expand`，`default` 是显式状态（面板循环与 json 语义一致；存为 default 时从 json 删键），`*` 通配未点名工具。effective 处理由「覆盖 > 模式默认」格决定；`expand` 打断一切归纳。
3. **间隔风格** `turnCollapse.style`：`compact`（现状）/ `classic`（压缩行前后各空一行，相邻压缩行之间只留一行——由渲染闭包里的 deferredBlank 惰性插入，避免双空行）。
4. **Thought 面板代理 pi 原生设置**：面板项读写 pi 的 `settings.json` `hideThinkingBlock`（单一事实源，不在 open-tui.json 重复存储），会话内通过翻转既有消息组件 + `addChild` 归一化新消息同步；探测到 pi 全局标志翻转（ctrl+t）时自动采纳，避免两个开关互相拉扯。关闭时思维链内联，归纳行只含工具。
5. **重试错误折叠**独立为 `turnCollapse.retryErrors`（降噪不属于压缩语义，native 模式下也默认保留）。
6. **扩展/MCP 工具按需呈现**：pi 扩展 API 无法枚举已注册工具，`seenTools` 缓存运行时观察到的非内置工具名并持久化；面板对应区块只在缓存非空时出现。

## Considered Options

- **保留布尔 + 若干独立细分开关** — 否：组合语义（"开压缩但 bash 例外"）要跨多个键心算，UI 与渲染分支更乱；模式是用户心智里的单选。
- **三态 per-tool 用 inherit/缺省表示"跟随"** — 否：用户明确要求显式 `default` 状态；隐式缺省在面板里不可见、json 里语义含糊。
- **Thought 在 open-tui.json 里存一份** — 否：与 pi 原生设置形成双事实源，ctrl+t 一按就漂移；代理写入 + 翻转探测保持单一来源。
- **面板动态枚举全部已注册工具** — 否：扩展 API 无此能力；静态猜 MCP 工具名不可靠。运行时观察 + 持久化缓存是可得的最诚实信号。
- **classic 严格"每行前后各空"（相邻双空行）** — 否：视觉割裂；合并为单空行更接近原生盒子节奏（用户已确认）。

## Consequences

- 正面：压缩粒度从 1 档变 4 档 × 每工具覆盖，且契约对旧配置自动迁移；Thought 一处设置全局生效。
- 成本：`renderExpandedTurn` 分发为四个 walk（native/single/group-same/run），分支增多——共享 `classifyAssistant` / `toolTreatment` / `emitSingleToolLine` 收敛；测试覆盖各档与覆盖组合。
- 已知限制：`seenTools` 只记调用过的工具（新装插件首次调用后出现）；Thought 的 ctrl+t 翻转在下一条新消息到达时才被采纳。
- 关联：CONTEXT.md「压缩模式 / 工具单行 / 每工具覆盖 / 压缩行间隔 / 思考块折叠」词条。
