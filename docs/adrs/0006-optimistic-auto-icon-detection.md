# 6. 图标 auto 检测采用乐观策略 + 一次性豆腐块提示

Date: 2026-09-29

## Status

Accepted

## Context

`icons.mode: "auto"` 需要在无字体信息的环境里猜测终端是否配有 Nerd Font。原实现（fork 自上游 0.3.0）用终端名单（`TERM_PROGRAM`/`LC_TERMINAL` ∈ {iTerm.app, Ghostty, WezTerm, kitty, rio, tabby, WindowsTerminal, vscode} + `WT_SESSION`）判定。上游在 #40（d543db5）改为乐观策略并给出理由：字体选择权在终端模拟器，env 永远无法证实。

评估（issue #42）发现旧名单**双向皆错**：

- 名单 8 项中 4 项（iTerm2 / WezTerm / VS Code / Windows Terminal）默认字体**不含** nerd 字形——这些用户今天就在看豆腐块（误报早已存在，并非"安全"策略）
- SSH 场景 `TERM_PROGRAM` 不透传——本地配了 NF 字体的用户远程使用时被静默降级为 ascii（上游 #40 报告人的原始痛点）
- 名单外终端（Terminal.app / VTE / Alacritty + NF 字体用户）同样被静默降级

两种失败模式的性质差异是决策核心：豆腐块**立刻可见、布局稳定**（17 个 nerd 字形全为 PUA 区码点、宽度 1，packer 不受影响）、一眼可归因为字体、一个设置项可修复；静默 ascii **看起来像故意设计**，用户会得出"这个扩展就长这样"的结论而永不排查。

## Decision

auto 检测改为乐观策略（与上游 0.3.7+ 一致）：交互式 UTF-8 TTY ⇒ nerd；非 TTY 输出、`TERM=dumb`、显式非 UTF-8 locale ⇒ ascii。locale 缺省视为乐观。

为中和乐观策略的剩余风险（默认字体的 stock 终端开箱见豆腐块），加**一次性自愈提示**：auto 首次解析为 nerd 时发一条 `ctx.ui.notify`（info 级，双语），告知"图标显示为方框？去 `/*tui` → 外观设 ascii 或为终端配置 Nerd Font"，确认后经 `icons.autoHintShown` 标记持久化，永不复发。auto 解析为 ascii 时不提示——那里没有可见的破损，无需诊断。

## Considered Options

- **维持终端名单**：零工作量，但双向皆错（见 Context），是最差的均衡——否。
- **名单裁剪到自带字形的终端（仅 Ghostty/kitty）**：最大化静默降级，对高 NF 采用率的本扩展受众严格更差——否。
- **乐观策略，裸跟上游**：修复 SSH/名单外，但 stock Terminal.app/VTE 用户开箱豆腐块且无引导——否，保留其检测逻辑但补提示。

## Consequences

- 正面：SSH 与名单外终端的 NF 用户获得正确图标；与上游 fork 家族行为/文档收敛；豆腐块从"上网搜索诊断"降为"一眼诊断、一跳修复"。
- 负面：默认字体终端（Terminal.app、stock VTE/Alacritty 等）首次使用会看到一次豆腐块 + 一条提示；`icons.autoHintShown` 进入配置文件（内部标记，非用户设置，不上面板）。
- 关联：issue #42（评估全文）；上游 OldSuns/pi-open-tui#40、d543db5。
