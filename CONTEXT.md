# pi-asterisk-tui

Pi 终端体验扩展：✻ 转录折叠 + claude-hud 风格 HUD。本文档是项目的**术语表（ubiquitous language）**，只定义概念，不含实现细节；代码、ADR、讨论共用这套词汇。

## 转录

**✻ 行**：
一个 turn 内连续的思考块与工具调用合并成的一句话摘要行（如 `✻ Thought for 19s, ran 3 shell commands`），可点击整体展开/收回。
_Avoid_: 工具行（工具输出展开前不单独占行，都在 ✻ 行里）、状态行（那是底栏的职责）

**压缩模式**：
`turnCollapse.mode` 的四档：native（pi 原生，不压缩）/ single（每工具单行，互不归纳）/ group-same（连续同类归纳，Thought 与工具互不合并）/ group-all（✻ 行，整段归纳）。整段归纳（group-all）只存在于这一层。
_Avoid_: 开关式的「转录折叠」（旧契约只有一个布尔；现在是四档模式，折叠程度由档位决定）

**工具单行**：
single 档或每工具覆盖里的单行形态：`▸ bash · $ npm test`，一工具一行，点击展开原生盒子。
_Avoid_: ✻ 行（那是归纳后的摘要；工具单行不合并相邻内容）

**每工具覆盖**：
`turnCollapse.tools` 里按工具名的四态设置：default（跟随压缩模式）/ single（单行）/ group-same（同类归纳行，不并入 ✻ 行）/ expand（原生盒子）；`*` 通配未点名的工具。逐项状态是**绝对的**——不随模式退化，group-same 在 native 模式下照样归纳；只有 default 是相对的。
_Avoid_: 缺省/inherit（状态是显式的 default，不是「未设置」）、group-all（归纳整段只存在于全局压缩模式，逐项不开放）

**压缩行间隔**：
`turnCollapse.style` 两档：compact（压缩行紧贴上下文）/ classic（压缩行前后各空一行，相邻压缩行之间只留一行）。

**思考块显示**：
`turnCollapse.thought`，与每工具覆盖同一套四态：default（跟随模式：native→内联 / single→逐条标签 / group-same→归纳 Thought 行 / group-all→并入 ✻ 行）/ single（每条一行 ✻ 标签）/ group-same（归纳 Thought 行，不与工具合并）/ expand（内联展开）。事实源是 asterisk-tui.json（首次运行自动收养旧 open-tui.json，旧文件保留）；pi 原生的 hideThinkingBlock 只是镜像，ctrl+t 翻转会被采纳为显式状态（展开→expand，折叠→single）。
_Avoid_: hideThinkingBlock 作为主设置（那是 pi 的消息级开关，现为镜像）、二态「思考块折叠」（旧契约）

**转录折叠**：
把对话渲染重组为「正文 + 压缩行」的整体机制（设置项 `turnCollapse`，含模式/风格/每工具覆盖）。两种 TUI 模式都生效。
_Avoid_: hideThinkingBlock（那是 pi 原生的消息级开关；本扩展默认它开，但折叠是自己的渲染层）、全屏专属（旧表述——regular 模式现在同样压缩）

**全部展开**：
regular 模式（无鼠标捕获）下的全局 toggle：按 `turnCollapse.expandAllKey`（默认 `ctrl+\`，压缩行行尾标注当前生效键）把所有压缩行整段展开（思维链 + 全部工具输出），再按收起。单一事实源是注册进 pi 的那个键——行尾标注随注册值渲染，配置改动重启/重载后生效。
_Avoid_: 点击展开（那是全屏模式的逐行交互）、ctrl+o / app.tools.expand（pi 原生工具输出切换，作用于盒子内部，不解开压缩行）、keybindings.json 重绑（pi 键位系统不接受扩展命名键位）

**思考标签**：
单条消息的 `✻ Thought…`（历史）/ `✻ Thinking…`（流式）标签，单独点击只展开该消息的思维链。
_Avoid_: ✻ 行（思考标签只管一条消息的推理；✻ 行合并整段活动）

**流式思考**：
`turnCollapse.liveThinking`（默认开）：流式中的 thinking-only 消息实时内联渲染思考内容；thinking 阶段一结束（正文出现或停止流式）立即折回思考标签 / ✻ 行，不等整个 run 结束。
_Avoid_: 思考块显示（那是折后的四态契约；流式思考只管流式期间的实时展示）

**运行中工具行**：
工具执行时的动画单行（`⠋ bash · $ npm test`）+ 下方实时流式输出（`turnCollapse.liveTools` 可关，关后只剩单行；expand 覆盖的工具始终整盒展示）。
_Avoid_: ✻ 行（工具完成后即并入 ✻ 行）

## 遥测

**运行指示器**：
`Working… (34s · ↓ 1.2k tokens · 3 tools)` 运行中指示——耗时、按运行累计的输出 token（跨轮次累加）、已开始的工具计数。

**单轮遥测**：
每次运行结束输出的一次性统计（TPS / TTFT / 时长 / 停顿、token 明细含缓存读写、命中率、$/M 标价）。同轮数据另存为 session 自定义条目（`telemetry.persist`，默认开），重进会话时回显最近一轮；回退剪枝连同所属轮次一起剪掉。
_Avoid_: 运行指示器（一个是过程中的实时行，一个是事后的总结块）

**输出速度（HUD）**：
状态行的 `输出 N tok/s`（hud.statStyle 图标+文字档）——最近一条流式满 1 秒的消息的 tok/s；瞬发式爆发的响应不参与更新，保留上一条可信值。
_Avoid_: 单轮遥测的 TPS（分母含 TTFT，是请求吞吐而非生成速度）

**侧花费（tools/summaries）**：
挂在工具结果（工具自身的 LLM 调用，如子代理）与压缩/分支摘要条目上的 token 用量——真实会话成本，但非主上下文记账；对齐 pi 自身的 Tools/summaries 桶单独累计，在费用段以暗色后缀呈现。
_Avoid_: 主上下文计数（assistant 消息的 input/output/cache/费用——两者永不合并）

## 底栏

**HUD 底栏**：
claude-hud 风格四行面板：状态行 / 上下文行 / 工具行 / 环境行（`footerStyle: "hud"`）。
_Avoid_: Classic 底栏

**Classic 底栏**：
starship 风格单行页脚 + 单轮摘要（`footerStyle: "classic"`）。
_Avoid_: HUD 底栏

**内嵌底栏**：
`inlineFooter` 开启时 classic 底栏的两行主内容画进编辑器上下边框（位置段+模型块 / 轮末摘要+统计行），只省行数不换内容；扩展状态行仍留编辑器下方。
_Avoid_: HUD 底栏（四行布局无法内嵌，开关对 hud 无效）、边框工作状态（那是编辑器自己的运行指示，不是底栏内容）

**底栏预设**：
`footerStyle` 的取值（hud / classic / custom）——设置面板里按名保存的组合。

## 编辑器与设置

**编辑器**：
带框输入区，光标样式 block / bar / underline。
_Avoid_: 设置面板（编辑器是输入框本体，不是配置界面）

**设置面板**：
`/*tui` 双语面板（English / 简体中文），语言选择同时本地化 HUD 标签。
_Avoid_: pi 的 `/settings`（那是宿主的设置；本扩展的配置都在自己的设置面板里）

**图标模式**：
`icons.mode` = nerd / ascii / auto。

**Token 显示模式**：
HUD Token 统计的呈现方式（`hud.tokens`）= verbose（本地化完整标签）/ compact（语言无关速记，图标+数值，如 `77M (U 855k + R 77M) │ 266k │ 98.9%`）/ off。
_Avoid_: Token 开关（已是三态，不是布尔）

**统计样式（HUD）**：
`hud.statStyle` = icon（纯图标）/ icon+text（图标+文字，默认）/ text（纯文字），作用于时长、费用、今日费用、输出速度、token、缓存命中段；图标与遥测行/classic 底栏共用同一 glyph 集（icons.mode，含 ascii 回退），compact token 速记固定图标+数值不受此项影响。
_Avoid_: 图标模式（icons.mode 决定用哪套字形/字体回退；statStyle 决定图标是否出现）

**全屏滚动**：
fullscreen TUI 模式下的滚轮滚动（`fullscreen.wheelScrollLines`）。

**选区复制**：
fullscreen TUI 鼠标选区复制到剪贴板的行为（`selection.copy`）三级：plain（按视觉内容，逐显示行，pi 原生）/ unwrapped（按逻辑内容，软换行拼回逻辑行，默认）/ raw（按原始内容，markdown 覆盖段输出渲染前源文，非 markdown 行只对该部分退回逻辑内容）。实现依赖 pi-tui 渲染内部结构，版本更新后可能静默失效并回退原生。
**选区边距裁剪**：
`selection.trimPadding`（默认开）：选中的「冗余」——前后各一列边距——不出现在高亮里，也不进入视觉内容复制；内容缩进（如工具输出代码缩进）不属于冗余，完整保留。关闭则高亮与视觉复制回到 pi 原生（含边距）。
_Avoid_: 高亮裁剪（开关同时管高亮与复制两处，不只高领）、把内容缩进当边距（只有那一列边距是冗余）

**选区 Tab 宽度**：
`selection.tabWidth`（默认 3=与渲染一致）：原始内容复制里制表符的呈现——2–8 任意整数空格或 `tab` 保留字面制表符；逐块路径从组件原文反演恢复真实 Tab（渲染器在解析前把 Tab 规范化成 3 空格）。
_Avoid_: 渲染缩进设置（这只影响复制输出，屏幕渲染宽度固定 3 列）
_Avoid_: 复制修复（是三档内容形态契约，不是单点 bugfix）、拼接为单行（那只描述了折行症状；三档是视觉/逻辑/原始内容之分）

**逻辑行**：
渲染折行前的原始行（markdown 词元的一次 renderToken 输出）；软换行把它折成多个显示行，选区复制把它拼回去。
_Avoid_: 显示行/视觉行（那是终端上的一行，可能只是逻辑行的半截）

**软换行**：
渲染管线在列宽处对逻辑行的自动折行（`wrapTextWithAnsi`）；与源文里的硬换行不同，复制时应拼回单行。
_Avoid_: 硬换行/换行符（源文真实存在的 `\n`，复制时保留）

## 架构

**运行时补丁**：
对 pi 扩展面的运行时包裹/拦截（容器渲染、鼠标路由、loader 消息），带版本守卫、运行时形状不匹配即惰性失效；磁盘上不改任何 pi 文件。
_Avoid_: fork 修改（本项目前身是 pi-open-tui 的 fork，现为纯扩展，不修改 pi 源码）

**兼容垫片**：
对运行时形状变化的防御性回退（如 fullscreen 滚速回退 pi 默认值）。
