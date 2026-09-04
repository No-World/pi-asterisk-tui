# pi-asterisk-tui

[English](./README.md) | **简体中文**

为 [Pi](https://pi.dev) 编程代理打造的 Claude Code 式紧凑对话体验——模型做的一切都折叠成
整齐的 `✻` 行，点击即可展开：

- `✻ Thought for 19s, searched for 9 patterns, listed 1 directory, ran 1 shell command`
  ——连续的思考与工具阶段合并为一行；点击展开完整思维链和工具输出，再点收回。
- [claude-hud](https://github.com/jarrodwatts/claude-hud) 风格四行底栏：模型与思考强度、
  git 状态与增删统计、会话名、agent 工作时长、费用、上下文进度条、token 统计、工具调用
  计数、逐文件 diff。
- Working 指示器实时显示单轮遥测（耗时、流式输出 token、工具数）、重试倒计时附带失败
  原因、逐消息思考标签。

```bash
pi install git:github.com/No-World/pi-asterisk-tui
```

![pi-asterisk-tui 预览](assets/preview_dashboard_1.png)

## 功能亮点

- **Pi 顶栏**：显示模型、思考等级、当前目录和常用斜杠命令提示
- **自适应底栏**：集中展示 Git 状态、运行环境、上下文用量、Token、费用和扩展状态
- **带边框的编辑器**：支持块状、竖线和下划线三种光标样式
- **项目环境感知**：识别 50 多种运行环境，并展示 ahead/behind、已暂存、已修改、未跟踪、stash 和 detached HEAD 等 Git 状态
- **单轮遥测**：展示 TPS、首 Token 延迟（TTFT）、耗时、停顿、Token 数量和模型标价速率
- **Claude 风格紧凑对话**：思考块折叠为一行 ✻ 标签，全屏模式下点击标签展开/收回对应思维链；Classic 底栏显示单轮摘要（思考时长 + 工具调用数），Working 指示器实时统计工具调用。首次运行时会将 pi 的 `hideThinkingBlock` 默认置为 true（已有设置不动）；点击展开需 `tuiMode: fullscreen`
- **交互式设置**：通过 `/open-tui` 配置，并支持英文和简体中文界面
- **带版本保护的 Pi 兼容层**：全屏滚轮速度所依赖的运行时支持发生变化时，会回退为 Pi 默认行为

## 环境要求

- Pi 0.80 或更高版本
- 支持 UTF-8 和彩色输出的终端
- 使用完整图标集时需要 [Nerd Font](https://www.nerdfonts.com/font-downloads)（可选；内置 ASCII 图标）
- 点击展开思维链需要 Pi 全屏模式：在 `~/.pi/agent/settings.json` 设置 `"tuiMode": "fullscreen"`（见下文）

## 点击展开思维链需要全屏模式

将思考块折叠为 ✻ 标签在任何 TUI 模式下都可用（`ctrl+t` 切换），但**点击标签展开对应思维链需要
Pi 的全屏模式**。Pi 只在全屏 TUI 中捕获鼠标事件；普通模式下点击由终端自己处理（原生文本选择），
扩展完全收不到——点击 ✻ 标签会毫无反应。

开启方法（二选一）：

- 运行 `/settings` → **TUI mode** → `fullscreen`（即时生效，无需重启；需先关闭已打开的浮层）；
- 在 `~/.pi/agent/settings.json` 设置 `"tuiMode": "fullscreen"` 后重启 Pi。

会话中途切换模式也没问题：点击处理器包裹的是共享的视口原型，新建的全屏 UI 立即生效。注意全屏
模式下鼠标行为整体变化：拖拽选中文本使用 Pi 自己绘制的选区高亮（而非终端原生选择），滚轮滚动的
是对话视口。另外确保没有多路复用器拦截鼠标（例如 tmux 的 `set -g mouse on` 会在 Pi 收到之前吞掉
点击）。

## 安装

安装扩展：

```bash
pi install git:github.com/No-World/pi-asterisk-tui
```

也可以只在当前会话中试用：

```bash
pi -e git:github.com/No-World/pi-asterisk-tui
```

## 字体与图标

可从 [Nerd Fonts 官方下载页](https://www.nerdfonts.com/font-downloads)或 [GitHub 最新版本](https://github.com/ryanoasis/nerd-fonts/releases/latest)下载任意已修补字体。安装后，请在终端配置中选择该字体，并重启终端。

默认的 `auto` 模式检测的是终端环境，无法确认终端当前实际使用的字体。如果图标显示为方框、乱码或错误符号，请打开 `/open-tui`，在**外观**页选择合适的模式：

- `nerd`：终端已配置 Nerd Font 时，强制使用 Nerd Font 图标
- `ascii`：使用纯文本图标，无需安装修补字体
- `auto`：在已识别的终端中使用 Nerd Font 图标，其他环境回退到 ASCII

如果已经安装字体，但 `auto` 仍选择 ASCII，请手动切换为 `nerd`。使用 VS Code、Windows Terminal 等应用时，只在操作系统中安装字体还不够，还需要在对应的终端配置中选中该字体。

## 配置

运行 `/open-tui` 打开设置窗口，其中包含**常规**、**外观**、**底栏**和**遥测**四个页面。设置保存在 `~/.pi/agent/open-tui.json`：

```json
{
  "enabled": true,
  "settingsLanguage": "zh",
  "cursorStyle": "block",
  "fullscreen": {
    "wheelScrollLines": 4
  },
  "icons": {
    "mode": "auto"
  },
  "footerSegments": {
    "cwd": true,
    "sessionName": false,
    "gitBranch": true,
    "gitStatus": true,
    "gitCommit": false,
    "runtime": true,
    "context": true,
    "tokens": true,
    "cost": true,
    "extensionStatuses": true
  },
  "telemetry": {
    "enabled": true,
    "tps": true,
    "ttft": true,
    "duration": true,
    "tokens": true,
    "stalls": true,
    "cost": true
  }
}
```

主要选项：

| 选项 | 可选值 | 说明 |
| --- | --- | --- |
| `settingsLanguage` | `en`、`zh` | 切换 `/open-tui` 设置界面的语言 |
| `cursorStyle` | `block`、`bar`、`underline` | `bar` 和 `underline` 需要终端支持光标形状转义序列 |
| `fullscreen.wheelScrollLines` | `1`-`10` | 全屏模式下滚轮每格滚动的行数，默认值为 `4`；`/open-tui` 中在该项上按 Enter 后直接输入数字（超出范围会自动钳制到 `1`-`10`） |
| `icons.mode` | `auto`、`nerd`、`ascii` | 控制底栏和遥测通知使用的图标 |
| `footerSegments` | 布尔开关 | 分别控制底栏中的各项数据 |
| `telemetry` | 布尔开关 | 控制遥测总开关和各项指标 |

`sessionName` 仅在会话有名称时显示；`gitCommit` 会在 detached HEAD 状态下显示短哈希和标签；关闭 `extensionStatuses` 会隐藏整行扩展状态，其中也包括 MCP 状态。

全屏滚轮速度通过隔离的兼容层写入 Pi 0.84.2 的运行时字段，因为 Pi 尚未提供公开 setter。若后续 Pi 版本不再包含兼容字段，该设置会被忽略并继续使用 Pi 的默认滚动行为。

## 工具分组（Claude Code 风格）

没有整轮折叠行，对话记录直接呈现为：

- 思考按消息折叠在可点击的 `✻ Thought…` 标签后。
- **连续的**已完成工具调用合并为一行可点击摘要：相邻的两个 bash 折成
  `✻ ran 2 shell commands`，中间隔着内容的各自成行 `✻ ran 1 shell command` /
  `✻ called playwright`。点击组行打开这些工具的完整输出盒——组行被盒子**替换**（与思考块
  一致）——点击盒子任意行收回成单行。
- 运行中的工具渲染为带动画的单行（`⠋ bash · $ echo hi`），下方实时流式输出。

在 open-tui 配置中设 `"turnCollapse": false` 可关闭分组。与点击展开一样需要全屏 TUI。

## 单轮遥测

每次 Agent 完整运行结束后，pi-asterisk-tui 会显示一条临时结果，并将其中的多个工具调用轮次合并统计：

```text
> TPS 42.5 tok/s | ~ TTFT 1.2s | + 29.7s | ↑ 567 | ↓ 1.2k | ! stall 1x / 4.3s | $ $3.60/M
```

TPS 的计算方式是：将本次运行中服务商报告的全部 Assistant 输出 Token，除以各个生成轮次的总耗时。计时范围从 `turn_start` 到 Assistant 的 `message_end`，包含 TTFT、隐藏推理、缓冲和停顿，但不包含轮次之间的工具执行时间。没有输出 Token 或无法测得生成时间时，会显示 `TPS —`。

`$ / M` 表示根据 `usage.cost.total` 得到的模型标价速率，不是底栏中的会话累计费用。所有遥测字段都可以在**遥测**页单独开关。

## 本地开发

```bash
npm install
npm test
npm run typecheck
pi -e .
```

## 致谢

本项目源自 **[OldSuns/pi-open-tui](https://github.com/OldSuns/pi-open-tui)** 的 fork，后发展为
独立项目，原代码库的致谢一并延续。同时基于多个 Pi 社区包的工作：

- **[pi-haiku](https://github.com/nnocte/pi-haiku)** — 双行底栏结构和工作计时器
- **[pi-claude-code-tui](https://github.com/Phoobobo/pi-claude-code-tui)** — Pi Logo 帧与圆角编辑器边框技术
- **[pi-zentui](https://github.com/lmilojevicc/pi-zentui)** — Starship 风格底栏、运行环境检测、会话生命周期和设置界面模式
- **[pi-tps](https://github.com/monotykamary/pi-tps)** — 单轮计时、停顿检测和保守的 TPS 计算方式

Logo 帧源自 Pi 官方安装脚本（`pi.dev/install.sh`）。运行环境检测和 Git porcelain 解析借鉴了 `pi-zentui` 的结构。

特别感谢 **[LINUX DO](https://linux.do)** 社区的支持。

## 许可证

[MIT](./LICENSE)
