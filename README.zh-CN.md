# pi-asterisk-tui

[English](./README.md) | **简体中文**

为 [Pi](https://pi.dev) 打造的终端体验——模型做的一切都折叠成整齐的 `✻` 行（Claude Code
风格），外加 claude-hud 风格的状态面板。

![预览](assets/preview_dashboard_1.png)

```bash
pi install git:github.com/No-World/pi-asterisk-tui
```

## ✻ 转录

对话记录渲染为正文 + 每段活动一行 `✻`：

```
✻ Thought for 19s, searched for 9 patterns, listed 1 directory, ran 1 shell command
```

- **Run 行**：连续的思考块与工具调用合并为一行，动词读起来像一句话——`ran 3 shell
  commands`、`edited 2 files`、`read 5 files`、`listed 2 directories`、`searched for 9
  patterns`、`called playwright ×2`（前面没有思考时首字母大写）。思考时长来自实时
  遥测；历史轮次显示为 `✻ Thought, ran 1 shell command`。
- **一次点击展开/收回**：点击 run 行，完整思维链与所有工具的输出盒同时展开——包括
  带正文消息的思考，无需二次点击标签；点击任一成员行全部收回。
- **逐消息思考标签**：`✻ Thought…`（历史）/ `✻ Thinking…`（流式中），可单独点击只展开
  那条消息的思维链，样式与 run 行完全一致（同色 ✻、同灰色正体文字）。
- **运行中的工具**渲染为动画单行（`⠋ bash · $ npm test`），下方实时流式输出，且不会把
  已完成的相邻工具拖出折叠行。
- **重试体验**：倒计时附带失败原因（`Retrying (2/10) in 5s… · 429 rate_limit_error`）；
  中间错误扣留不显示，重试成功什么都不打印，最终失败只输出最后一条。
- **紧凑间距**：✻ 行周围的 pi 内部 Spacer 与 OSC shell 集成标记一律折掉。

## 遥测

- **Working 指示器**：`Working… (34s · ↓ 1.2k tokens · 3 tools)`——耗时、流式期间按增量
  估算的输出 token（完成回填精确值）、实时工具计数。
- **单轮遥测**：每次运行结束显示 TPS、TTFT、耗时、停顿次数/时长、输入/输出 token
  明细（含缓存读/写）、缓存命中率、模型标价 $/M 速率。
- **Classic 底栏单轮摘要**：`✓ done 12s · ✻ 8s · 2 shell commands`。

## HUD 底栏

claude-hud 风格四行面板（同时内置 starship 风格 classic 预设）：

1. **状态行**——模型与上下文窗口、思考强度（月相图标）、git 分支与脏标记、
   ahead/behind、逐文件增删统计 `[+71 -5]`、会话名、累计工作时长、费用、今日费用、
   实时输出速度（tok/s）。
2. **上下文行**——用量进度条、百分比与 token 数、缓存命中率。
3. **工具行**——按工具的调用计数（✓ 标记）、运行中的工具标签。
4. **环境行**——MCP 服务器计数（仅当实际安装了 pi-mcp-adapter 时统计）、内存占用、
   压缩次数、pi 版本。

另有：工作目录与变更文件的 OSC 8 超链接（点击打开）、powerline 风格 git 段、
ahead/behind 指示，以及完整的仓库子目录 git 检测（pi 原本在仓库子目录启动时无法显示
分支状态）。

## 编辑器与设置

- 带边框编辑器，块状 / 竖线 / 下划线三种光标样式。
- 双语 `/open-tui` 设置面板（英文 / 简体中文，语言选择同时作用于 HUD 标签）：底栏
  段落、HUD 开关、遥测字段、图标模式（nerd / ascii / auto）、光标样式、全屏滚轮速度
  ——含命名风格预设（hud / classic / custom）。
- 版本守护的兼容层：全屏滚轮速度依赖的运行时结构变化时自动回退 pi 默认值。

全新安装会把 pi 的 `hideThinkingBlock` 默认置为 `true`（已有选择永不覆盖），✻ 体验
开箱即用。

## 环境要求

- Pi 0.80+
- UTF-8 终端；完整图标集需要 [Nerd Font](https://www.nerdfonts.com/font-downloads)
  （内置 ASCII 图标）
- **全屏 TUI**（`/settings` → TUI mode，或 `~/.pi/agent/settings.json` 里
  `"tuiMode": "fullscreen"`）——鼠标交互依赖 pi 的全屏鼠标捕获；其他功能在普通模式
  下均可用。

## 配置

`/open-tui` 打开设置面板，或直接编辑 `~/.pi/agent/open-tui.json`：

| 键 | 默认 | 作用 |
| --- | --- | --- |
| `footerStyle` | `"hud"` | `hud` / `classic` 底栏预设 |
| `turnCollapse` | `true` | ✻ run 行与工具分组 |
| `icons.mode` | `"auto"` | nerd / ascii / auto 图标集 |
| `cursorStyle` | `"block"` | 编辑器光标样式 |
| `telemetry.*` | 开 | Working 指示器与轮末遥测字段 |
| `footerSegments.*` | 混合 | classic 底栏段落开关 |
| `hud.*` | 开 | HUD 每个段落均可单独开关 |
| `fullscreen.wheelScrollLines` | `4` | 滚轮每格行数 |

## 实现方式

全部能力都是构建在 pi 扩展面上的运行时补丁——版本守护、不匹配即静默失效：聊天容器
的渲染被包裹以对转录重新分块（容器/消息/工具按内容而非外观分类）；全屏视口的鼠标输
入被拦截，点击经由逐帧行段路由；pi-tui 的 loader 文案携带重试原因。磁盘上的 pi 文件
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
