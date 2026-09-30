# 8. 边框状态迁移到 pi 原生钩子（render 期门翻转保 workingStatus 三态）

Date: 2026-10-01

## Status

Accepted

## Context

pi-coding-agent 0.85 起原生吸收了边框内嵌工作状态（#54，实测 0.85.0–0.87.1 的 `custom-editor.js` 逐字节相同）：`CustomEditor` 提供 `embedWorkingStatus` 构造选项、`setWorkingStatusIndicator`，`Editor.render` 经 `renderTopBorder(width, hiddenLineCount)` / `renderBottomBorder(width, hiddenLineCount)` 钩子拼边框，且自带与我们手搬版完全一致的降级阶梯（full → spinner → plain，溢出标签居中）。我们此前维护着一份复制品：私有 indicator 镜像字段、自己的 `roundedBorder`/`inlineBorder` 阶梯、以及靠刮取 base render 输出重建边框（`findBottomBorderIndex` + 正则匹配 `↑ N more`）。

迁移的唯一硬约束：**pi 的 duck-typing 路由和原生阶梯读同一个 `embedWorkingStatus` 字段**。interactive-mode 用 `"embedWorkingStatus" in editor && === true` 判定"把 pi 自己的 working/retry/compaction 指示器嵌进边框（且不再显示独立状态行）"；`CustomEditor.renderTopBorder` 用同一字段做阶梯门。而我们的 `workingStatus` 配置默认值是 `"both"`（pi 状态行 + 我们的边框状态并存）——naive 地恒置 true 会让 `line`/`both` 模式下 pi 的状态行永久消失。另外 pi 的阶梯把 status 裸拼在 `borderColor(...)` 段之间（pi 的 StatusIndicator 自带颜色），而我们的纯文本 snapshot 依赖边框涂色随 bash 绿框 / thinking 级换色。

## Decision

1. **render 期门翻转**：构造时 `embedWorkingStatus: false`；新增 `setEmbeddedWorkingStatusRouting(enabled)` 按 `workingStatus === "border"` 翻转该字段（事件期语义 = pi 的嵌入路由）。我们的 `render()` 在驱动 base render 期间临时把字段置为 `saved || (我方 indicator !== undefined)`，finally 恢复——渲染期阶梯门额外为我方 indicator 打开，`both` 模式由此保住"pi 状态行 + 我方边框状态"并存。
2. **阶梯去重**：`renderTopBorder`/`renderBottomBorder` override 中非 inline 路径直接调 `super.renderTopBorder(span, hiddenLineCount)`（span = 钩子宽度 + 2，角字符由我们补 `╭╮`/`╰╯`），删除自有降级阶梯；滚动标签改从 `hiddenLineCount` 参数取，删掉全部输出刮取。
3. **涂色 wrapper**：`setWorkingStatusIndicator` override 把 indicator 包一层再喂给 super——wrapper 在渲染期用当前 `this.borderColor` 给输出涂色，ponytail 换色行为不变；pi 自带 ANSI 色的指示器实际不受影响（内层 SGR 先生效）。
4. **结构化定位**：底边框由钩子记录自己的输出串，`render()` 按值从尾部匹配分割内容行与 autocomplete 尾行，`isEditorBorderLine`/`findBottomBorderIndex` 及"用户 dash 行被误清空"的防御 hack 一并删除。

`WorkingStatusIndicator` 接口保留为接线类型（与 pi 的用法结构等同，仅在 super 调用处做一次收窄转换）。

## Considered Options

- **恒置 `embedWorkingStatus: true`**——`line`/`both` 模式下 pi 状态行永久消失（embed 优先于 line），默认配置被破坏，否。
- **不置 true、只用钩子**——阶梯被字段门死，等于保留复制品，违背 #54 主旨，否。
- **getter 遮蔽基类字段**——TS 报"property 被 accessor 覆盖"，且运行时基类构造的实例自有属性压过原型 getter，双重不可行，否。
- **状态自着色（模仿 pi 的 StatusIndicator）**——需要 snapshot 在组合期带色，bash 模式 / thinking 级换色无法跟随（那些是换编辑器实例上的 `borderColor` 函数），否。

## Consequences

- 删掉约 60 行阶梯复制品与全部刮行逻辑；滚动标签、状态降级、溢出布局跟随 pi 上游演进。
- 可预期的小行为变化：纯边框模式**底**部滚动标签从左置变为居中（与顶部一致）；`border` 模式下 pi 的 retry 倒计时 / compaction 从独立行移入边框。
- `embedWorkingStatus` 字段的 readonly 仅是类型层面，两处可写访问必须收敛在 `setEmbeddedWorkingStatusRouting` 与 `render()` 的 try/finally 内；后续 pi 若把字段改为真只读或语义变化，此 ADR 与 editor.ts 内注释是第一入口。
- 用户手打的全横线行不再被清空（原防御 hack 的副作用，顺带修复，有回归测试钉住）。
