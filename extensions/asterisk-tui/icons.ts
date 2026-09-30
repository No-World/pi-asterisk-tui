export type IconMode = "auto" | "nerd" | "ascii";

export interface IconGlyphs {
	cwd: string;
	hostname: string;
	session: string;
	git: string;
	working: string;
	done: string;
	context: string;
	model: string;
	thinking: string;
	input: string;
	output: string;
	cacheHit: string;
	cost: string;
	/** Calendar — HUD daily-cost segment (distinct from session cost in icon-only mode). */
	daily: string;
	speed: string;
	latency: string;
	stall: string;
	/** Compress — compaction count on the HUD context bar. */
	compaction: string;
	/** Wrench — working-display tool count. */
	tools: string;
	extensions: string;
	ahead: string;
	behind: string;
	diverged: string;
	conflicted: string;
	stashed: string;
	modified: string;
	staged: string;
	untracked: string;
	renamed: string;
	deleted: string;
}

const NERD_GLYPHS: IconGlyphs = {
	cwd: "",
	hostname: "",
	session: "",
	git: "",
	working: "",
	done: "",
	context: "",
	model: "",
	thinking: "",
	// client network view: input = upload to API, output = download from API
	input: "",
	output: "",
	cacheHit: "",
	cost: "",
	// Written as an escape on purpose: PUA literals are fragile through
	// editor/agent transport; the codepoint is the contract.
	daily: "\u{f133}", // U+F133 nf-fa-calendar-o
	speed: "󰓅",
	latency: "",
	stall: "",
	tools: "\u{f0ad}", // U+F0AD nf-fa-wrench
	compaction: "\u{f066}", // U+F066 nf-fa-compress
	extensions: "",
	ahead: "↑",
	behind: "↓",
	diverged: "⇕",
	conflicted: "=",
	stashed: "$",
	modified: "!",
	staged: "+",
	untracked: "?",
	renamed: "»",
	deleted: "✘",
};

// ponytail: ASCII fallback uses compact symbols (not English words) to keep
// the footer's icon-like feel on non-Nerd-Font terminals. Symbols chosen to
// avoid collisions with the git-status set {= S ! A ? r x ^ v}.
const ASCII_GLYPHS: IconGlyphs = {
	cwd: "@",
	hostname: "h",
	session: "s",
	git: "*",
	working: "o",
	done: "+",
	context: "#",
	model: "M",
	thinking: "~",
	input: "↑",
	output: "↓",
	cacheHit: "c",
	cost: "$",
	daily: "d",
	speed: ">",
	latency: "~",
	stall: "!",
	tools: "t",
	compaction: "z",
	extensions: "&",
	ahead: "^",
	behind: "v",
	diverged: "^v",
	conflicted: "=",
	stashed: "S",
	modified: "!",
	staged: "A",
	untracked: "?",
	renamed: "r",
	deleted: "x",
};
// (The old NERD_FONT_TERMINALS allowlist was removed with the optimistic auto
// policy — see detectNerdFont and ADR-0006.)

export function detectNerdFont(): boolean {
	// The terminal emulator owns font selection, and no environment variable
	// can prove a Nerd Font is active — the old terminal allowlist guessed and
	// guessed wrong in both directions (iTerm2/WezTerm/VS Code/WT don't bundle
	// nerd glyphs; SSH never propagates TERM_PROGRAM). Auto mode is therefore
	// optimistic: nerd glyphs once output is an interactive UTF-8 TTY, ASCII for
	// non-TTY output, TERM=dumb, or an explicitly non-UTF-8 locale (ADR-0006).
	// The tofu failure mode is made self-diagnosing by a one-time hint — see
	// autoIconHintText below.
	if (process.env.TERM === "dumb" || process.stdout.isTTY !== true) return false;
	const locale = [process.env.LC_ALL, process.env.LC_CTYPE, process.env.LANG].find(Boolean);
	return locale === undefined || /utf-?8/i.test(locale);
}

/** Whether the one-time tofu hint should fire: auto mode resolved to nerd and
 * the hint has not been shown (and persisted) yet. Silent downgrades to ASCII
 * stay silent — nothing looks broken there, so there is nothing to diagnose. */
export function shouldShowAutoIconHint(mode: IconMode, autoHintShown: boolean): boolean {
	return mode === "auto" && !autoHintShown && resolveIconMode("auto") === "nerd";
}

export function autoIconHintText(language: "en" | "zh"): string {
	return language === "zh"
		? "图标显示为方框？在 /*tui → 外观 中把图标模式设为 ascii（或为终端配置 Nerd Font）"
		: "Icons showing as boxes? Set icons.mode=ascii in /*tui → Appearance (or configure a Nerd Font for your terminal)";
}

export function resolveIconMode(mode: IconMode): "nerd" | "ascii" {
	if (mode === "nerd") return "nerd";
	if (mode === "ascii") return "ascii";
	return detectNerdFont() ? "nerd" : "ascii";
}

export function resolveGlyphs(mode: IconMode): IconGlyphs {
	const resolved = resolveIconMode(mode);
	return resolved === "nerd" ? NERD_GLYPHS : ASCII_GLYPHS;
}
