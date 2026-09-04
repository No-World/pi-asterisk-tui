# pi-asterisk-tui

Pi 终端体验扩展：✻ 转录折叠 + claude-hud 风格 HUD。本文档是项目的**术语表（ubiquitous language）**，只定义概念，不含实现细节；代码、ADR、讨论共用这套词汇。

## 转录

**✻ 行**：
一个 turn 内连续的思考块与工具调用合并成的一句话摘要行（如 `✻ Thought for 19s, ran 3 shell commands`），可点击整体展开/收回。
_Avoid_: 工具行（工具输出展开前不单独占行，都在 ✻ 行里）、状态行（那是底栏的职责）

**转录折叠**：
把对话渲染重组为「正文 + ✻ 行」的整体机制（设置项 `turnCollapse`）。
_Avoid_: hideThinkingBlock（那是 pi 原生的消息级开关；本扩展默认它开，但折叠是自己的渲染层）

**思考标签**：
单条消息的 `✻ Thought…`（历史）/ `✻ Thinking…`（流式）标签，单独点击只展开该消息的思维链。
_Avoid_: ✻ 行（思考标签只管一条消息的推理；✻ 行合并整段活动）

**运行中工具行**：
工具执行时的动画单行（`⠋ bash · $ npm test`）+ 下方实时流式输出。
_Avoid_: ✻ 行（工具完成后即并入 ✻ 行）

## 遥测

**运行指示器**：
`Working… (34s · ↓ 1.2k tokens · 3 tools)` 运行中指示——耗时、流式估算的输出 token、已开始的工具计数。

**单轮遥测**：
每次运行结束输出的一次性统计（TPS / TTFT / 时长 / 停顿、token 明细含缓存读写、命中率、$/M 标价）。
_Avoid_: 运行指示器（一个是过程中的实时行，一个是事后的总结块）

## 底栏

**HUD 底栏**：
claude-hud 风格四行面板：状态行 / 上下文行 / 工具行 / 环境行（`footerStyle: "hud"`）。
_Avoid_: Classic 底栏

**Classic 底栏**：
starship 风格单行页脚 + 单轮摘要（`footerStyle: "classic"`）。
_Avoid_: HUD 底栏

**底栏预设**：
`footerStyle` 的取值（hud / classic / custom）——设置面板里按名保存的组合。

## 编辑器与设置

**编辑器**：
带框输入区，光标样式 block / bar / underline。
_Avoid_: 设置面板（编辑器是输入框本体，不是配置界面）

**设置面板**：
`/open-tui` 双语面板（English / 简体中文），语言选择同时本地化 HUD 标签。
_Avoid_: pi 的 `/settings`（那是宿主的设置；本扩展的配置都在自己的设置面板里）

**图标模式**：
`icons.mode` = nerd / ascii / auto。

**全屏滚动**：
fullscreen TUI 模式下的滚轮滚动（`fullscreen.wheelScrollLines`）。

## 架构

**运行时补丁**：
对 pi 扩展面的运行时包裹/拦截（容器渲染、鼠标路由、loader 消息），带版本守卫、运行时形状不匹配即惰性失效；磁盘上不改任何 pi 文件。
_Avoid_: fork 修改（本项目前身是 pi-open-tui 的 fork，现为纯扩展，不修改 pi 源码）

**兼容垫片**：
对运行时形状变化的防御性回退（如 fullscreen 滚速回退 pi 默认值）。
