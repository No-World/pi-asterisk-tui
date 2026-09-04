# pi-asterisk-tui

**English** | [简体中文](./README.zh-CN.md)

A [Pi](https://pi.dev) terminal experience where everything the model does folds into tidy
`✻` lines — Claude Code style — plus a claude-hud style status dashboard.

![preview](assets/preview_dashboard_1.png)

```bash
pi install git:github.com/No-World/pi-asterisk-tui
```

## ✻ Transcript

The transcript renders as answer text plus one `✻` line per activity phase:

```
✻ Thought for 19s, searched for 9 patterns, listed 1 directory, ran 1 shell command
```

- **Run lines**: consecutive thinking blocks and tool calls merge into one line, verbs
  reading like a sentence — `ran 3 shell commands`, `edited 2 files`, `read 5 files`,
  `listed 2 directories`, `searched for 9 patterns`, `called playwright ×2` (leading verb
  capitalized when no thinking precedes). Thinking durations come from live telemetry;
  history turns read `✻ Thought, ran 1 shell command`.
- **One-click expand/collapse**: click a run line to open the full reasoning and every
  tool's bordered output at once — including the thinking of text-bearing messages, no
  second tap on labels. Click any member line to fold it all back.
- **Per-message thinking labels**: `✻ Thought…` (history) / `✻ Thinking…` (streaming),
  individually clickable to expand just that message's reasoning, styled identically to
  run lines (same accent ✻, same muted upright text).
- **Running tools** render as an animated one-liner (`⠋ bash · $ npm test`) with live
  output streaming beneath — and never drag completed neighbors out of their folded lines.
- **Retry UX**: the countdown carries the failure reason
  (`Retrying (2/10) in 5s… · 429 rate_limit_error`); intermediate errors are held back,
  a successful retry prints nothing, and only the last error shows if the run fails.
- **Compact spacing**: pi's internal spacer padding and OSC shell-integration markers
  around ✻ lines are folded away.

## Telemetry

- **Working indicator**: `Working… (34s · ↓ 1.2k tokens · 3 tools)` — elapsed, live output
  tokens estimated from the stream (exact on message completion), tool count as they start.
- **Turn telemetry** after each run: TPS, TTFT, duration, stall count/time, input/output
  token breakdown with cache-read and cache-write, cache hit rate, and list-price $/M rate.
- **Classic footer summary**: `✓ done 12s · ✻ 8s · 2 shell commands` after each run.

## HUD footer

A claude-hud style four-line dashboard (a starship-style classic preset is also built in):

1. **Status line** — model with context window, thinking level (moon-phase icons), git
   branch with dirty marker, ahead/behind, per-file diff totals `[+71 -5]`, session name,
   cumulative working time, cost, today's cost, live output speed (tok/s).
2. **Context line** — usage bar with percent and token counts, cache hit rate.
3. **Tools line** — per-tool usage counts with ✓, running tool labels.
4. **Environment line** — detected runtime + version, MCP server count (only when
   pi-mcp-adapter is actually installed), memory usage, compaction count, pi version.

Plus: OSC 8 hyperlinks on the working directory and changed files (click to open),
powerline-styled git segment, ahead/behind indicators, and full subdirectory git detection
(pi normally fails to show branch state when started inside a repository subdirectory).

## Editor & settings

- Framed editor with block / bar / underline cursor styles.
- Bilingual `/open-tui` settings panel (English / 简体中文) — the language choice also
  localizes HUD labels — covering footer segments, HUD toggles, telemetry fields, icon
  mode (nerd / ascii / auto), cursor style, and fullscreen wheel-scroll speed — with named
  style presets (hud / classic / custom).
- Version-guarded compatibility shims: fullscreen wheel speed falls back to pi defaults if
  the runtime shape changes.

Fresh installs default pi's `hideThinkingBlock` to `true` (existing choices are never
overridden) so the ✻ experience works out of the box.

## Requirements

- Pi 0.80+
- UTF-8 terminal; a [Nerd Font](https://www.nerdfonts.com/font-downloads) for the full icon
  set (ASCII icons are built in)
- **Fullscreen TUI** (`/settings` → TUI mode, or `"tuiMode": "fullscreen"` in
  `~/.pi/agent/settings.json`) for mouse interactions — click-to-expand needs pi's
  fullscreen mouse capture. Everything else works in regular mode.

## Configuration

Run `/open-tui`, or edit `~/.pi/agent/open-tui.json`. Notable keys:

| Key | Default | Effect |
| --- | --- | --- |
| `footerStyle` | `"hud"` | `hud` / `classic` footer presets |
| `turnCollapse` | `true` | ✻ run lines and tool grouping |
| `icons.mode` | `"auto"` | nerd / ascii / auto icon set |
| `cursorStyle` | `"block"` | editor cursor style |
| `telemetry.*` | on | working-indicator and post-turn telemetry fields |
| `footerSegments.*` | mixed | classic footer segment toggles |
| `hud.*` | on | every HUD segment individually toggleable |
| `fullscreen.wheelScrollLines` | `4` | mouse wheel lines per tick |

## How it works

Everything is a runtime patch over pi's extension surface, version-guarded and inert on
mismatch: the chat container's render is wrapped to re-chunk the transcript (containers,
messages, and tools are classified by content, not appearance), the fullscreen viewport's
mouse input is intercepted to route clicks through per-render line segments, and pi-tui's
loader messages carry retry reasons. No pi files are modified on disk.

## Local development

```bash
npm install
npm test && npm run typecheck
pi -e .
```

## Acknowledgements

- **[OldSuns/pi-open-tui](https://github.com/OldSuns/pi-open-tui)** — this project began as
  a fork of it; the original integration work and its credits carry over.
- **[claude-hud](https://github.com/jarrodwatts/claude-hud)** — the HUD footer layout.
- **[pi-haiku](https://github.com/nnocte/pi-haiku)** — footer structure and working timer.

## License

MIT
