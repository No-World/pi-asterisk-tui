# pi-open-tui

**English** | [简体中文](./README.zh-CN.md)

A polished terminal interface for the [Pi](https://pi.dev) coding agent. It brings the strongest ideas from pi-haiku, pi-claude-code-tui, and pi-zentui into one configurable extension.

![pi-open-tui preview]

> [!IMPORTANT]
> **This is a fork** ([No-World/pi-open-tui](https://github.com/No-World/pi-open-tui)) with a
> [claude-hud](https://github.com/jarrodwatts/claude-hud) style footer: 4-line layout with
> model + thinking level, git state with diff stats, session name, agent working time, cost,
> context bar, Chinese token stats, tool usage counts, and per-file diff. It also fixes git
> detection when pi starts inside a repository subdirectory, and shows a per-turn timer plus
> a live output-token counter next to the working indicator (estimated from the stream while
> the model is generating, exact once the message completes). The transcript also stays
> compact Claude-style: hidden thinking renders as a one-line ✻ label (pi's ctrl+t) — in
> the fullscreen TUI the label is clickable to expand that message's thinking inline, click
> again to collapse — a live tool count on the working indicator, and a turn summary
> (✻ 8s · 2 shell commands) in the classic footer.
>
> Install **this fork** with:
>
> ```bash
> pi install git:github.com/No-World/pi-open-tui
> ```
>
> Upstream: [OldSuns/pi-open-tui](https://github.com/OldSuns/pi-open-tui)

(https://raw.githubusercontent.com/OldSuns/pi-open-tui/main/assets/preview_dashboard_1.png)

## Highlights

- **Pi header** with model, thinking level, working directory, and useful slash-command hints
- **Responsive footer** with Git state, detected runtime, context usage, token counts, cost, and extension status
- **Framed editor** with block, bar, and underline cursor styles
- **Project awareness** for 50+ runtimes and detailed Git states, including ahead/behind, staged, modified, untracked, stashed, and detached HEAD
- **Turn telemetry** for TPS, time to first token (TTFT), duration, stalls, tokens, and list-price rate
- **Compact Claude-style transcript**: hidden thinking shows as a one-line ✻ label — click it to expand that message's thinking inline in the fullscreen TUI (click again to collapse); the classic footer's done segment summarizes each turn (thinking time + tool count); the working indicator counts tools live. On first run the extension defaults pi's `hideThinkingBlock` to true (existing choices are kept); clicking requires `tuiMode: fullscreen`.
- **Interactive settings** through `/open-tui`, available in English and Simplified Chinese
- **Version-guarded Pi compatibility shim**: fullscreen wheel speed falls back to Pi's default if its runtime support changes

## Requirements

- Pi 0.80 or later
- A terminal with UTF-8 and color support
- A [Nerd Font](https://www.nerdfonts.com/font-downloads) for the full icon set (optional; ASCII icons are built in)
- For click-to-expand thinking: Pi's fullscreen TUI — set `"tuiMode": "fullscreen"` in `~/.pi/agent/settings.json` (see below)

## Click-to-expand thinking needs fullscreen mode

Collapsing thinking to the ✻ label works in any TUI mode (`ctrl+t` toggles it), but **expanding a
label by clicking requires Pi's fullscreen mode**. Pi only captures mouse events in the
fullscreen TUI; in regular mode the terminal handles clicks itself (native text selection) and
the extension never sees them — clicks on ✻ labels silently do nothing.

To enable, either:

- run `/settings` → **TUI mode** → `fullscreen` (applies immediately, no restart; close open
  overlays first), or
- set `"tuiMode": "fullscreen"` in `~/.pi/agent/settings.json` and restart Pi.

Switching modes mid-session is fine: the click handler wraps the shared viewport prototype, so
newly created fullscreen UIs pick it up right away. Note that fullscreen mode changes mouse
behavior everywhere: dragging selects text with Pi's own selection highlight instead of the
terminal's native selection, and the wheel scrolls the transcript viewport. Also make sure no
multiplexer intercepts the mouse (e.g. tmux's `set -g mouse on` swallows clicks before Pi sees
them).

## Install

Install the extension:

```bash
pi install git:github.com/No-World/pi-open-tui
```

Or try it for one session:

```bash
pi -e git:github.com/No-World/pi-open-tui
```

## Font and icons

Download any patched font from the official [Nerd Fonts downloads page](https://www.nerdfonts.com/font-downloads) or [latest GitHub release](https://github.com/ryanoasis/nerd-fonts/releases/latest). Install it, select that font in your terminal profile, and restart the terminal.

The default `auto` mode detects the terminal environment, not the installed font file. If icons appear as boxes or incorrect symbols, open `/open-tui` and choose one of these modes under **Appearance**:

- `nerd`: force Nerd Font icons after configuring a Nerd Font in the terminal
- `ascii`: use plain-text icons with no patched font required
- `auto`: use Nerd Font icons in recognized terminals and ASCII elsewhere

If the font is installed but `auto` still selects ASCII, choose `nerd` explicitly. In VS Code, Windows Terminal, and similar apps, configure the font in the terminal profile rather than only installing it in the operating system.

## Configuration

Run `/open-tui` to open the settings dialog. It provides **General**, **Appearance**, **Footer**, and **Telemetry** tabs. Settings are stored in `~/.pi/agent/open-tui.json`:

```json
{
  "enabled": true,
  "settingsLanguage": "en",
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

Key options:

| Option | Values | Notes |
| --- | --- | --- |
| `settingsLanguage` | `en`, `zh` | Changes the `/open-tui` interface language |
| `cursorStyle` | `block`, `bar`, `underline` | `bar` and `underline` require terminal cursor-shape support |
| `fullscreen.wheelScrollLines` | `1`-`10` | Lines scrolled per mouse-wheel notch in fullscreen mode; defaults to `4`. In `/open-tui`, press Enter on this item and type a number (values are clamped to `1`-`10`) |
| `icons.mode` | `auto`, `nerd`, `ascii` | Controls footer and telemetry icons |
| `footerSegments` | Boolean flags | Shows or hides individual footer data |
| `telemetry` | Boolean flags | Enables telemetry and its individual measurements |

`sessionName` appears only when the session has a name. `gitCommit` shows the short hash and tag in detached HEAD state. Disabling `extensionStatuses` hides the entire extension status line, including MCP status.

Fullscreen wheel speed uses an isolated compatibility shim for Pi 0.84.2's runtime field because Pi does not yet expose a public setter. On Pi versions without a compatible field, the setting is ignored and Pi's default scrolling remains active.

## Tool grouping (Claude Code style)

There is no turn-level folding line. Instead the transcript reads like Claude Code:

- Thinking collapses per message behind a clickable `✻ Thought…` label.
- Consecutive completed tool calls collapse together into one clickable line:
  `✻ ran 2 shell commands` for adjacent shells; groups separated by text each get
  their own `✻ ran 1 shell command` / `✻ called playwright` line. Click a group line
  to open those tools' full bordered output, click again to close.
- A running tool renders as an animated one-liner (`⠋ bash · $ echo hi`) with the live
  box streaming below it.

Disable grouping via `"turnCollapse": false` in the open-tui config. As with
click-to-expand, this needs the fullscreen TUI.

## Turn telemetry

After each complete agent run, pi-open-tui shows one transient result. Tool-call turns are combined into that result:

```text
> TPS 42.5 tok/s | ~ TTFT 1.2s | + 29.7s | ↑ 567 | ↓ 1.2k | ! stall 1x / 4.3s | $ $3.60/M
```

TPS is calculated from all provider-reported assistant output tokens divided by the total generation time across the run. Timing starts at `turn_start` and ends at the assistant `message_end`, so it includes TTFT, hidden reasoning, buffering, and stalls; tool execution between turns is excluded. Runs without output tokens or measurable generation time show `TPS —`.

The `$ / M` value is the model's list-price rate from `usage.cost.total`, not the cumulative session cost shown in the footer. Every telemetry field can be toggled from the **Telemetry** tab.

## Local development

```bash
npm install
npm test
npm run typecheck
pi -e .
```

## Acknowledgements

This project builds on several Pi community packages:

- **[pi-haiku](https://github.com/nnocte/pi-haiku)** — two-line footer structure and working timer
- **[pi-claude-code-tui](https://github.com/Phoobobo/pi-claude-code-tui)** — Pi logo frames and rounded editor border technique
- **[pi-zentui](https://github.com/lmilojevicc/pi-zentui)** — Starship-style footer segments, runtime detection, session lifecycle, and settings UI pattern
- **[pi-tps](https://github.com/monotykamary/pi-tps)** — turn timing, stall detection, and conservative TPS measurement

The logo frames are derived from Pi's official install script (`pi.dev/install.sh`). Runtime detection and Git porcelain parsing borrow structure from `pi-zentui`.

Special thanks to the **[LINUX DO](https://linux.do)** community for its support.

## License

[MIT](./LICENSE)
