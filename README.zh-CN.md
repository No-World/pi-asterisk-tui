# pi-asterisk-tui

[English](./README.md) | **简体中文**

为 [Pi](https://pi.dev) 打造的终端体验——模型做的一切都折叠成整齐的 `✻` 行，Claude Code 风格。

![预览](assets/preview_dashboard_1.png)

```bash
pi install git:github.com/No-World/pi-asterisk-tui
```

## ✻ 行

对话记录渲染为正文 + 每段活动一行 `✻`：

```
✻ Thought for 19s, searched for 9 patterns, listed 1 directory, ran 1 shell command
```

- 连续的思考块与工具调用**合并为一行**——动词读起来像一句话（`ran 3 shell commands`、
  `edited 2 files`、`called playwright ×2`；前面没有思考时首字母大写）。
- **点击该行**：完整思维链和所有工具的输出盒同时展开；点击任一成员全部收回。不需要
  二次点击——带正文消息的思考在同一次点击里一并展开。
- **运行中的**工具渲染为动画单行（`⠋ bash · $ npm test`），下方实时流式输出，且不会
  把已完成的相邻工具拖出折叠行。
- 历史会话同样折叠；思考时长来自实时遥测，历史轮次显示为 `✻ Thought, ran 1 shell
  command`。

## 其余能力

- **HUD 底栏**（claude-hud 风格四行）：模型与思考强度、git 状态与增删统计、会话名、纯
  agent 工作时长、费用、上下文进度条、token 统计与缓存命中率、工具调用计数、逐文件
  diff；另有 starship 风格的 classic 预设。
- **Working 指示器遥测**：`Working… (34s · ↓ 1.2k tokens · 3 tools)`——流式期间按增量
  估算 token（完成时回填精确值），工具实时计数。
- **单轮遥测**：每次运行结束显示 TPS、TTFT、耗时、停顿、token 明细、$/M 速率。
- **重试体验**：倒计时附带失败原因（`Retrying (2/10) in 5s… · 429 rate_limit_error`）；
  中间错误扣留不显示，只有最终失败时输出最后一条；重试成功则什么都不显示。
- 逐消息思考标签（`✻ Thought…` / 流式时 `✻ Thinking…`），可单独点击，样式与 run 行
  完全一致。
- **Classic 底栏单轮摘要**：`✓ done 12s · ✻ 8s · 2 shell commands`。
- 带边框编辑器（块/竖线/下划线光标）、全屏滚轮速度调节、双语 `/open-tui` 设置面板。
- 紧凑转录间距：✻ 行周围的 pi 内部 Spacer 与 OSC shell 集成标记一律折掉。

## 环境要求

- Pi 0.80+
- UTF-8 终端；完整图标集需要 [Nerd Font](https://www.nerdfonts.com/font-downloads)
  （内置 ASCII 图标）
- **全屏 TUI**（`/settings` → TUI mode，或 `~/.pi/agent/settings.json` 里
  `"tuiMode": "fullscreen"`）——鼠标交互依赖 pi 的全屏鼠标捕获；其他功能在普通模式
  下均可用。

## 配置

`/open-tui` 打开设置面板（英文 / 简体中文），或直接编辑 `~/.pi/agent/open-tui.json`：

| 键 | 默认 | 作用 |
| --- | --- | --- |
| `footerStyle` | `"hud"` | `hud` / `classic` 底栏预设 |
| `turnCollapse` | `true` | ✻ run 行与工具分组 |
| `telemetry.*` | 开 | Working 指示器与轮末遥测字段 |
| `fullscreen.wheelScrollLines` | `4` | 滚轮每格行数 |

全新安装会把 pi 的 `hideThinkingBlock` 默认置为 `true`（已有选择永不覆盖），✻ 体验
开箱即用。

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
