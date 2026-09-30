# pi-asterisk-tui

[English](./README.md) | **简体中文**

为 [Pi](https://pi.dev) 打造的终端体验——模型做的一切都折叠成整齐的 `✻` 行（Claude Code
风格），外加 claude-hud 风格的状态面板。

![预览](assets/preview_dashboard_1.png)

```bash
pi install npm:pi-asterisk-tui
```

或从 git 安装（跟随 `main`）：

```bash
pi install git:github.com/No-World/pi-asterisk-tui
```

## ✻ 转录

对话渲染为正文 + 压缩活动行。压缩到什么程度由**压缩模式**决定（`/*tui` → 压缩页）：

| 模式 | 渲染 |
| --- | --- |
| `native` | pi 原生渲染，不压缩 |
| `single` | 每个工具单独一行（`▸ bash · $ npm test`），互不归纳 |
| `group-same` | 连续同类工具归纳（`✻ read 3 files`）；思考单独归纳为 `✻ Thought for 11s`，互不合并 |
| `group-all` | Claude-Code 风格：连续思考 + 工具归纳为一行（默认） |

```
✻ Thought for 19s, searched for 9 patterns, listed 1 directory, ran 1 shell command
```

- **Run 行**（group-all）：动词读起来像一句话——`ran 3 shell commands`、`edited 2
  files`、`read 5 files`、`listed 2 directories`、`searched for 9 patterns`、`called
  playwright ×2`（前面没有思考时首字母大写）。思考时长来自实时遥测；历史轮次显示为
  `✻ Thought, ran 1 shell command`。
- **每工具覆盖**：每个工具可独立设为 default（跟随模式）/ single（单行）/ group-same（
  同类归纳行，不并入 ✻ 行）/ expand（原生盒子），`*` 通配未点名的工具。逐项状态是**绝对的**
  ——不随模式退化，group-same 在原生模式下照样归纳。
- **思考块**与工具共用同一套四态（`turnCollapse.thought`）：default（跟随模式）/ single（
  每条一行 ✻ 标签）/ group-same（归纳 Thought 行，不与工具合并）/ expand（内联展开，
  pi 原生）。整段并入 ✻ 行只有「模式 group-all + default」一条路径；pi 原生的
  hideThinkingBlock 仅作镜像，ctrl+t 翻转会被采纳为显式状态。
- **压缩行间隔**：compact（紧凑）或 classic（经典，压缩行前后各空一行，相邻压缩行之间
  只留一行；✻ 标签行也按压缩行对待，标签与后续正文之间同样空一行）。
- **一次点击展开/收回**：点击压缩行，完整思维链与所有工具的输出盒同时展开——包括
  带正文消息的思考，无需二次点击标签；点击任一成员行全部收回。点击 = 无修饰键按下并在
  同一格松开；拖选文本不会误触发展开/收回（pi 全屏自带的选区完全不受影响）。
- **逐消息思考标签**：`✻ Thought…`（历史）/ `✻ Thinking…`（流式中），可单独点击只展开
  那条消息的思维链，样式与压缩行完全一致（同色 ✻、同灰色正体文字）；也可在设置面板里
  直接开关（写入 pi 原生设置并同步当前会话）。
- **运行中的工具**渲染为动画单行（`⠋ bash · $ npm test`），下方实时流式输出，且不会把
  已完成的相邻工具拖出折叠行（native 模式保持纯 pi 盒子）。`turnCollapse.liveTools: false`
  可关掉实时输出盒，只留 spinner 单行；expand 覆盖的工具不受影响。
- **流式思考**（`turnCollapse.liveThinking`，默认开）：流式中的 thinking-only 消息实时内联
  显示思考内容；一旦该消息开始出正文（或停止流式），立即折回 ✻ 标签 / 归纳行，无需等
  整个 run 结束。
- **重试体验**：倒计时附带失败原因（`Retrying (2/10) in 5s… · 429 rate_limit_error`）；
  中间错误扣留不显示，重试成功什么都不打印，最终失败只输出最后一条（可独立开关）。
- **普通模式支持**：压缩行在 regular 模式（非全屏 TUI）同样生效——每条压缩行行尾标注
  当前生效的全部展开快捷键（如 `(ctrl+\ 展开)`），按一下整段展开（思维链 + 全部工具
  输出），再按一下全部收起；全屏模式仍以点击逐行展开为准。
- **紧凑间距**：✻ 行周围的 pi 内部 Spacer 与 OSC shell 集成标记一律折掉。

## 遥测

- **Working 指示器**：`Working… (34s · ↓ 1.2k tokens · 3 tools)`——耗时、按运行累计的
  输出 token（流式期间增量估算、完成回填精确值，工具执行不清零）、实时工具计数。
- **单轮遥测**：每次运行结束显示 TPS、TTFT、耗时、停顿次数/时长、输入/输出 token
  明细（含缓存读/写）、缓存命中率、模型标价 $/M 速率。
- **持久化**：每轮遥测以 session 自定义条目存储（扩展私有，不进模型上下文），重进会话时回显一次最近一轮，并按当前图标/语言设置重新格式化；回退剪枝时连同所属轮次一起剪掉。`telemetry.persist` 可关（默认开）。
- **工具/摘要侧花费**：挂在工具结果（工具自身的 LLM 调用，如子代理）与压缩/分支摘要上的
  token 用量是真实会话成本，但不属于主上下文记账——对齐 pi 自身的 `Tools/summaries` 桶，
  单独累计并以暗色后缀附在费用段上（`$0.012+$9.500 tools` / `费用 $0.01+$9.50 工具`），
  两种底栏一致；今日费用同口径汇总。无侧花费时渲染与从前完全一致。
- **Classic 底栏单轮摘要**：`✓ done 12s · ✻ 8s · 2 shell commands`。

## HUD 底栏

claude-hud 风格四行面板（同时内置 starship 风格 classic 预设）：

1. **状态行**——模型与上下文窗口、思考强度（月相图标）、git 分支与脏标记、
   ahead/behind、逐文件增删统计 `[+71 -5]`、会话名、累计工作时长、费用、今日费用、
   实时输出速度（tok/s；仅在该条消息流式传输满 1 秒后才更新——瞬发式爆发的响应
   无法测速，保留上一条可信速度）。
2. **上下文行**——用量进度条、百分比与 token 数、缓存命中率。Token 统计有三种呈现（`hud.tokens`）：本地化完整标签 `verbose`、语言无关的紧凑速记 `compact`（图标+数值，如 `77M (U 855k + R 77M) │ 266k │ 98.9%`）、或 `off`。统计段（时长、费用、今日费用、输出速度、token、缓存命中）的呈现由 `hud.statStyle` 控制：`icon`（纯图标）/ `icon+text`（图标+文字，默认）/ `text`（纯文字）；图标与遥测行、classic 底栏共用同一 glyph 集，`icons.mode: "ascii"` 下有符号回退。
3. **工具行**——按工具的调用计数（✓ 标记）、运行中的工具标签。
4. **环境行**——MCP 服务器计数（仅当实际安装了 pi-mcp-adapter 时统计）、内存占用、
   压缩次数、pi 版本。

另有：工作目录与变更文件的 OSC 8 超链接（点击打开）、powerline 风格 git 段、
ahead/behind 指示，以及完整的仓库子目录 git 检测（pi 原本在仓库子目录启动时无法显示
分支状态）。

## 编辑器与设置

- 带边框编辑器，块状 / 竖线 / 下划线三种光标样式。
- **上边框工作状态**（`borderWorkingStatus`，默认开，`/*tui` → Footer 页）：agent 运行
  期间，编辑器边框自带耗时与工作图标（`╭── ◐ 12s ────╮`）——随边框着色（与思考级别 /
  bash 模式变色同源），两种底栏风格下均生效。窄边框先退化为仅图标，再退化为纯边框；
  滚动提示（`↑ 3 more`）保持居中槽位。底栏自身的工作段不变。
- **内嵌底栏**（`inlineFooter`，默认关，仅 classic 风格）：把 classic 底栏的两行主内容
  画进编辑器边框——上边框左侧是位置段（cwd · 主机 · 会话 · git）、右侧是模型块；下边框
  左侧是轮末摘要、右侧是统计行（紧凑上下文 · token · 费用）。扩展状态行仍留在编辑器
  下方。宽度收缩时右侧块优先存活（与 plain 底栏的 alignRight 优先级一致）。工作期间
  下边框左格仅在上边框状态开启时留空——关掉 `borderWorkingStatus` 后工作计时回退到
  下边框单元格，状态永不失踪。小屏终端省下两行垂直空间。`footerStyle: "hud"` 下此
  开关无效。
- **选区复制（全屏）三级模式**（`/*tui` 面板或 `selection.copy` 配置，默认
  `unwrapped`）：`plain` 按视觉内容复制（pi 原生，逐显示行）；`unwrapped` 按逻辑
  内容复制——软换行拼回逻辑行（段落、列表项、引用、表格换行单元格全部还原）；
  `raw` 按原始内容复制——markdown 覆盖段输出渲染前源文（`**加粗**`、`$x^2$`、
  表格管道原样；整条消息选中直接取原文；非 markdown 行只对该部分退回逻辑内容）。
  另有独立开关 `selection.trimPadding`（默认开）：选中高亮不覆盖补齐空白、
  视觉内容复制前后不多出边距空格。
  注意：此功能依赖 pi-tui 渲染内部结构，**pi 版本更新后可能静默失效**（自动回退
  pi 原生复制，不报错）；失效后升级本扩展即可恢复。
- 双语 `/*tui` 设置面板（英文 / 简体中文，语言选择同时作用于 HUD 标签）：底栏
  段落、HUD 开关、遥测字段、图标模式（nerd / ascii / auto）、光标样式、全屏滚轮速度，
  以及「压缩」页（压缩模式、压缩行间隔、重试错误折叠、思考块开关、每工具覆盖——
  扩展/MCP 工具在出现过一次后才列出）——含命名风格预设（hud / classic / custom）。
- 版本守护的兼容层：全屏滚轮速度依赖的运行时结构变化时自动回退 pi 默认值。

全新安装会把 pi 的 `hideThinkingBlock` 默认置为 `true`（已有选择永不覆盖），✻ 体验
开箱即用。

## 环境要求

- Pi 0.85+（带框编辑器的鼠标点击对齐依赖 pi-tui 的组件级鼠标事件）
- UTF-8 终端；完整图标集需要 [Nerd Font](https://www.nerdfonts.com/font-downloads)
  （内置 ASCII 图标）
- 两种 TUI 模式均可用：压缩行在普通（regular）模式下通过快捷键全部展开/收起
  （默认 `ctrl+\`，压缩行行尾有标注）；**点击逐行展开/收起**依赖 pi 的全屏鼠标捕获
  （`/settings` → TUI mode，或 `~/.pi/agent/settings.json` 里 `"tuiMode":
  "fullscreen"`）。

## 字体与图标

默认的 `auto` 模式检查终端环境而非字体文件——字体选择权在终端模拟器，没有任何环境
变量能证实 Nerd Font 生效（ADR-0006）。auto 在交互式 UTF-8 TTY 下使用 Nerd Font 图标
（含 SSH 场景——终端名单嗅探在 SSH 下永不透传），非交互输出、`TERM=dumb`、显式非
UTF-8 locale 时退回 ASCII。auto 首次解析为 nerd 时会发一条一次性提示，告知图标变方框
时的处置路径。`/*tui` → 外观 可选：

- `nerd`：在终端配置 Nerd Font 后强制使用 Nerd Font 图标
- `ascii`：纯文本图标，无需补丁字体
- `auto`：交互式 UTF-8 TTY 用 nerd；dumb / 非交互 / 非 UTF-8 用 ASCII

图标显示为方框时，要么改设 `ascii`，要么安装
[Nerd Font](https://www.nerdfonts.com/font-downloads) 并在终端配置文件里选中——
VS Code、Windows Terminal 等应用必须设在终端配置文件里，只装到操作系统不算。

## 配置

`/*tui` 打开设置面板，或直接编辑 `~/.pi/agent/asterisk-tui.json`（首次运行会自动把旧
`open-tui.json` 的设置收养过来，旧文件保留不动）：

| 键 | 默认 | 作用 |
| --- | --- | --- |
| `footerStyle` | `"hud"` | `hud` / `classic` 底栏预设 |
| `turnCollapse.mode` | `"group-all"` | 压缩模式：`native` / `single` / `group-same` / `group-all` |
| `turnCollapse.style` | `"compact"` | 压缩行间隔：`compact` / `classic` |
| `turnCollapse.retryErrors` | `true` | 运行期间扣留重试错误；连续请求错误折叠为一行 `⚠ … ×N`（可点击展开） |
| `turnCollapse.thought` | `"default"` | 思考块：`default` / `single` / `group-same` / `expand` |
| `turnCollapse.liveThinking` | `true` | 流式期间内联显示思考内容，结束后折回 |
| `turnCollapse.liveTools` | `true` | 运行中在 spinner 行下方渲染实时输出盒 |
| `turnCollapse.expandAllKey` | `"ctrl+\\"` | 普通模式全部展开/收起快捷键（pi KeyId；空串禁用；重启/重载后生效） |
| `turnCollapse.tools` | `{}` | 每工具 `default` / `single` / `group-same` / `expand`；`*` 通配 |
| `icons.mode` | `"auto"` | nerd / ascii / auto 图标集；auto = 交互式 UTF-8 TTY 用 nerd（ADR-0006），首次解析为 nerd 时有一次提示 |
| `cursorStyle` | `"block"` | 编辑器光标样式 |
| `telemetry.*` | 开 | Working 指示器与轮末遥测字段；`telemetry.persist`（开）重进会话时回显最近一轮的遥测行 |
| `footerSegments.*` | 混合 | classic 底栏段落开关 |
| `footerSegments.hostname` | `false` | 可选主机名段（取主机名的首个标签）——多机 SSH 时一眼区分所在主机；HUD 侧同款开关为 `hud.hostname` |
| `footerSegments.capitalizeProviderName` | `true` | 首字母大写 provider 名；`false` 保留原始 id 大小写（适配 `cc-switch-zhipu-glm` 这类代理 id） |
| `borderWorkingStatus` | `true` | 编辑器上边框内嵌工作状态；两种底栏风格均适用 |
| `inlineFooter` | `false` | classic 底栏两行主内容改画进编辑器边框；`footerStyle: "hud"` 下无效 |
| `hud.*` | 开 | HUD 每个段落均可单独开关（`hud.tokens`：`verbose` / `compact` / `off`；`hud.statStyle`：`icon` / `icon+text` / `text`——统计段显示纯图标、图标+文字还是纯文字） |
| `fullscreen.wheelScrollLines` | `4` | 滚轮每格行数 |
| `selection.copy` | `"unwrapped"` | 选区复制：`plain`（视觉内容）/ `unwrapped`（逻辑内容，默认）/ `raw`（原始内容）；依赖 pi-tui 内部结构，pi 升级后可能静默回退原生 |
| `selection.trimPadding` | `true` | 选区边距裁剪：高亮不覆盖补齐空白、视觉内容复制不含前后边距空格 |
| `selection.tabWidth` | `3` | 原始内容复制的 Tab 宽度：2–8 任意整数（`3` 与渲染一致）或 `tab` 保留制表符；逐块复制会从原文确定性恢复真实 Tab |

## 实现方式

全部能力都是构建在 pi 扩展面上的运行时补丁——版本守护、不匹配即静默失效：聊天容器
的渲染被包裹以对转录重新分块（容器/消息/工具按内容而非外观分类）；全屏视口的鼠标输
入只观察不拦截，同格按下→松开的点击经由逐帧行段路由；pi-tui 的 loader 文案携带重试原因。磁盘上的 pi 文件
不做任何修改。

## 本地开发

```bash
npm install
npm test && npm run typecheck
pi -e .
```

## 致谢

- **[OldSuns/pi-open-tui](https://github.com/OldSuns/pi-open-tui)**——本项目最初由其
  fork 而来；原整合工作及其致谢一并延续。
- **[claude-hud](https://github.com/jarrodwatts/claude-hud)**——HUD 底栏布局。
- **[pi-haiku](https://github.com/nnocte/pi-haiku)**——底栏结构与工作计时器。

## 许可证

MIT
