# 5. 选区复制：换行感知与三级模式（plain / unwrapped / raw）

Date: 2026-09-28

## Status

Accepted

## Context

pi-tui 全屏模式的文本选区按**视觉行**逐行复制：一条被软换行折成 N 行的逻辑行，粘贴出来就是 N 行（含被折行 trim 掉的词间空白丢失）。上游 pi-tui（至 0.87.1）的 `getActiveSelectionText` 就是简单 `join("\n")`，渲染后的行不携带「我是续行」的元数据；`wrapTextWithAnsi` 是 ESM 导出的纯函数，无法 monkey-patch。同时本扩展的转录压缩会重排文档行（空白去重、✻ 标签流、压缩行合成），文档行号不能直接映射回组件渲染行。

## Decision

在 `selection-copy.ts` 实现三级复制模式（`selection.copy`，默认 `unwrapped`，`/*tui` 面板可切）：

- **plain**：原生行为（按显示行逐行）。
- **unwrapped**：WYSIWYG 单行还原。所见即所复制——把软换行的行拼回逻辑行（段落/标题/列表项/引用行/表格行含换行单元格，单元格拼回 `│ 内容 │ 内容 │` 形态），屏幕上保留的符号照抄。
- **raw**：源文还原。markdown 覆盖段输出渲染前源文（`**bold**`、`$x^2$`、表格管道）；整条消息全覆盖直接取组件原文；块边界不齐时**按块类型切片**（段落/引用用 inline 正则对齐 + 语法包装外吸附，代码块/表格按 raw 行切，列表按 item 切），切不动就整块吸附——仍是 raw；非 markdown 行（工具行、✻ 标签、边框）只对该部分降级为 unwrapped 文本，按选区顺序拼接。markdown 块内部永不出现 raw/渲染混合。

机制（沿本仓版本守护惯例，失配即静默回退原生）：

1. 包 `Markdown.prototype.render`，渲染期间临时拦截实例 `renderToken`/`wrapCellText`，记录调用树（pre-wrap 逻辑行 + token.raw）；`Text.prototype.render` 同理。记录按组件 WeakMap 存放，缓存命中复用。
2. 包 `TuiAltScreen.prototype.getActiveSelectionText`：选区行 → turn-collapse 行段 + 带校验的子树透明行走（子渲染拼接与父渲染 strip 相等才下钻）→ Markdown/Text 叶子 → 逻辑行。续行判定用 pi-tui 自己的 `wrapTextWithAnsi`（同模块实例）**精确重放**，每行与实际文档行 strip 相等校验，失败即该行降级 opaque（走原生切片）。

## Considered Options

- **宽度启发式拼接**（行宽==内容宽判续行）：CJK 几乎每行恰好排满、逻辑行末尾恰好占满宽、折行 trim 空白三处歧义，会粘错段落或拆错词——否。
- **等上游修**：pi-tui 无 logical-line 概念，动渲染核心管线，节奏不可控——否。
- **复制时主动重放渲染**（invalidate + 重跑）：流式期间内容已变导致对不上，且污染 pi 组件缓存；改为渲染期被动记录 + 缓存身份核对——否。

## Consequences

- 与 pi-tui `Markdown` 内部结构强耦合（renderToken 管线、表格拼装、列表前缀）。升级 pi 最坏情况是功能静默消失回到原生行为，行为契约由 `deriveColumnWidths`/strip 校验等结构探测守护。
- 列表项内嵌套列表、合成压缩行的行是 opaque（按显示行复制）；这些场景没有可还原的逻辑行。
- raw 模式的边界块可能向外吸附（选了半句加粗拿到整段 `**…**`）——取「剪贴板里永远是配平的 markdown」而非「严格等于选中范围」。
- raw 模式下选区跨 markdown 与非 markdown 内容时按段拼接（raw 段 + unwrapped 段），这是明确的产品决策而非混合事故。
- 仅覆盖全屏 TUI；普通模式选区归终端模拟器，应用侧无法干预。
