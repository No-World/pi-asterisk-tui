import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import {
	DEFAULT_FULLSCREEN_WHEEL_SCROLL_LINES,
	normalizeFullscreenWheelScrollLines,
} from "./fullscreen-scroll.ts";
import type { IconMode } from "./icons.ts";

export type SettingsLanguage = "en" | "zh";
export type CursorStyle = "block" | "bar" | "underline";

export type { IconMode } from "./icons.ts";

export type FooterStyle = "hud" | "classic";
export type StylePreset = "hud" | "classic" | "custom";

/** Transcript compression mode: how finished non-body activity renders. */
export type CollapseMode = "native" | "single" | "group-same" | "group-all";
/** Spacing around compressed lines: compact (flush) or classic (blank-padded). */
export type CollapseStyle = "compact" | "classic";
/** Per-item compression override (tools and thinking alike). "default" follows the mode. */
export type ToolOverride = "default" | "single" | "group-same" | "expand";

export const COLLAPSE_MODES: readonly CollapseMode[] = ["native", "single", "group-same", "group-all"];
export const COLLAPSE_STYLES: readonly CollapseStyle[] = ["compact", "classic"];
export const TOOL_OVERRIDES: readonly ToolOverride[] = ["default", "single", "group-same", "expand"];
/** pi builtin tools — anything else counts as an extension/MCP tool for the panel. */
export const BUILTIN_TOOLS: readonly string[] = ["bash", "read", "edit", "write", "grep", "glob", "ls"];

export interface TurnCollapseConfig {
	/** Compression mode (was a plain boolean before: true → group-all, false → native). */
	mode: CollapseMode;
	/** Blank-line style around compressed lines. */
	style: CollapseStyle;
	/** Hold retry errors during a run (noise reduction, applies in every mode). */
	retryErrors: boolean;
	/** Thinking-block override — same state lattice as per-tool overrides. */
	thought: ToolOverride;
	/** Stream thinking content inline while it arrives; fold it back once the
	 *  thinking phase ends (text starts or the message stops streaming). */
	liveThinking: boolean;
	/** Render the native output box of running tools below the spinner
	 *  one-liner; off shows the spinner line only. */
	liveTools: boolean;
	/** Key id (pi KeyId string) that expands/collapses every compressed line
	 *  in the regular TUI, where mouse clicks are unavailable. Empty disables
	 *  the shortcut and the trailing hint. Takes effect after restart/reload. */
	expandAllKey: string;
	/** Per-tool overrides keyed by tool name; "*" matches tools without an entry. */
	tools: Record<string, ToolOverride>;
	/** Non-builtin tool names observed at runtime (auto-maintained, feeds the panel). */
	seenTools: string[];
}

export const DEFAULT_TURN_COLLAPSE: TurnCollapseConfig = {
	mode: "group-all",
	style: "compact",
	retryErrors: true,
	thought: "default",
	liveThinking: true,
	liveTools: true,
	expandAllKey: "ctrl+\\",
	tools: {},
	seenTools: [],
};

/** Effective thinking treatment: override resolved against the mode. */
export type ThoughtTreatment = "expand" | "single" | "group-same" | "run";

/**
 * Resolves the thinking override against the compression mode. Per-item
 * states are ABSOLUTE — group-same merges consecutive thinking even in
 * native mode; only `default` is relative. `run` (absorb into whole-run ✻
 * lines) is only reachable via mode group-all + default.
 */
export function effectiveThoughtTreatment(mode: CollapseMode, thought: ToolOverride): ThoughtTreatment {
	if (thought === "default") {
		switch (mode) {
			case "native":
				return "expand";
			case "single":
				return "single";
			case "group-same":
				return "group-same";
			default:
				return "run";
		}
	}
	return thought as ThoughtTreatment;
}

/** Thinking renders inline (pi native) — what pi's hideThinkingBlock should mirror. */
export function thoughtExpanded(mode: CollapseMode, thought: ToolOverride): boolean {
	return effectiveThoughtTreatment(mode, thought) === "expand";
}

/** Migrates/normalizes any stored shape (including the legacy boolean) into a full config. */
export function normalizeTurnCollapse(value: unknown): TurnCollapseConfig {
	if (typeof value === "boolean") {
		return { ...DEFAULT_TURN_COLLAPSE, mode: value ? "group-all" : "native" };
	}
	const raw = (typeof value === "object" && value !== null ? value : {}) as Partial<TurnCollapseConfig>;
	const tools: Record<string, ToolOverride> = {};
	if (typeof raw.tools === "object" && raw.tools !== null) {
		for (const [name, override] of Object.entries(raw.tools)) {
			if (TOOL_OVERRIDES.includes(override)) tools[name] = override;
		}
	}
	const seenTools = Array.isArray(raw.seenTools)
		? raw.seenTools.filter((name): name is string => typeof name === "string")
		: [];
	return {
		mode: COLLAPSE_MODES.includes(raw.mode as CollapseMode) ? (raw.mode as CollapseMode) : DEFAULT_TURN_COLLAPSE.mode,
		style: COLLAPSE_STYLES.includes(raw.style as CollapseStyle) ? (raw.style as CollapseStyle) : DEFAULT_TURN_COLLAPSE.style,
		retryErrors: raw.retryErrors !== false,
		thought: TOOL_OVERRIDES.includes(raw.thought as ToolOverride) ? (raw.thought as ToolOverride) : "default",
		liveThinking: raw.liveThinking !== false,
		liveTools: raw.liveTools !== false,
		expandAllKey: typeof raw.expandAllKey === "string" ? raw.expandAllKey.trim() : DEFAULT_TURN_COLLAPSE.expandAllKey,
		tools,
		seenTools: [...new Set(seenTools)].sort(),
	};
}

/** HUD token-stats presentation: hidden, localized verbose labels, or
 *  language-independent compact shorthand (`↑ 77M (U 855k + R 77M) │ ↓ 266k │ C 98.9%`). */
export type TokenDisplayMode = "off" | "verbose" | "compact";
export const TOKEN_DISPLAY_MODES: readonly TokenDisplayMode[] = ["off", "verbose", "compact"];

/** Fine-grained HUD-style footer options (one per visible detail). */
export interface HudConfig {
	model: boolean;
	modelContextWindow: boolean;
	modelThinking: boolean;
	git: boolean;
	gitDir: boolean;
	gitBranch: boolean;
	gitDiffTotals: boolean;
	sessionName: boolean;
	time: boolean;
	cost: boolean;
	contextBar: boolean;
	contextPercent: boolean;
	contextTokens: boolean;

	tokens: TokenDisplayMode;
	tokenBreakdown: boolean;
	cacheHit: boolean;
	tools: boolean;
	toolsRunning: boolean;
	toolsMax: number;
	files: boolean;
	filesUntracked: boolean;
	filesMax: number;
	extensionStatuses: boolean;
	/** claude-hud style extras — opt-in, off by default */
	environment: boolean;
	memory: boolean;
	compactions: boolean;
	dailyCost: boolean;
	piVersion: boolean;
	/** Live output speed (tok/s) — part of the HUD preset */
	outputSpeed: boolean;
}

export const DEFAULT_HUD_CONFIG: HudConfig = {
	model: true,
	modelContextWindow: true,
	modelThinking: true,
	git: true,
	gitDir: true,
	gitBranch: true,
	gitDiffTotals: true,
	sessionName: true,
	time: true,
	cost: true,
	contextBar: true,
	contextPercent: true,
	contextTokens: true,

	tokens: "verbose",
	tokenBreakdown: true,
	cacheHit: true,
	tools: true,
	toolsRunning: true,
	toolsMax: 4,
	files: true,
	filesUntracked: true,
	filesMax: 4,
	extensionStatuses: true,
	environment: true,
	memory: false,
	compactions: false,
	dailyCost: false,
	piVersion: false,
	outputSpeed: true,
};

export function normalizeHudConfig(hud: HudConfig): HudConfig {
	const clamp = (n: number) => (Number.isFinite(n) && n >= 1 ? Math.min(10, Math.floor(n)) : 4);
	// hud.tokens was a boolean before the compact mode existed; migrate it here
	const rawTokens: unknown = hud.tokens;
	const tokens: TokenDisplayMode =
		typeof rawTokens === "string" && TOKEN_DISPLAY_MODES.includes(rawTokens as TokenDisplayMode)
			? (rawTokens as TokenDisplayMode)
			: rawTokens === true
				? "verbose"
				: rawTokens === false
					? "off"
					: DEFAULT_HUD_CONFIG.tokens;
	return { ...hud, tokens, toolsMax: clamp(hud.toolsMax), filesMax: clamp(hud.filesMax) };
}

export interface FooterSegments {
	cwd: boolean;
	sessionName: boolean;
	gitBranch: boolean;
	gitStatus: boolean;
	gitCommit: boolean;

	context: boolean;
	tokens: boolean;
	cost: boolean;
	extensionStatuses: boolean;
}

export interface TelemetryConfig {
	enabled: boolean;
	tps: boolean;
	ttft: boolean;
	duration: boolean;
	tokens: boolean;
	stalls: boolean;
	cost: boolean;
}

export interface FullscreenConfig {
	wheelScrollLines: number;
}

export interface OpenTuiConfig {
	enabled: boolean;
	settingsLanguage: SettingsLanguage;
	cursorStyle: CursorStyle;
	/**
	 * Fine-grained transcript compression (fullscreen TUI). Thought visibility
	 * itself is pi's native hideThinkingBlock setting; see pi-settings.ts.
	 */
	turnCollapse: TurnCollapseConfig;
	fullscreen: FullscreenConfig;
	icons: {
		mode: IconMode;
	};
	footerStyle: FooterStyle;
	footerSegments: FooterSegments;
	hud: HudConfig;
	/** Which named style is active; manual footer edits downgrade it to "custom". */
	stylePreset: StylePreset;
	telemetry: TelemetryConfig;
}

export const DEFAULT_CONFIG: OpenTuiConfig = {
	enabled: true,
	settingsLanguage: "en",
	cursorStyle: "block",
	turnCollapse: structuredClone(DEFAULT_TURN_COLLAPSE),
	fullscreen: {
		wheelScrollLines: DEFAULT_FULLSCREEN_WHEEL_SCROLL_LINES,
	},
	icons: {
		mode: "auto",
	},
	footerStyle: "hud",
	stylePreset: "hud",
	footerSegments: {
		cwd: true,
		sessionName: false,
		gitBranch: true,
		gitStatus: true,
		gitCommit: false,

		context: true,
		tokens: true,
		cost: true,
		extensionStatuses: true,
	},
	hud: structuredClone(DEFAULT_HUD_CONFIG),
	telemetry: {
		enabled: true,
		tps: true,
		ttft: true,
		duration: true,
		tokens: true,
		stalls: true,
		cost: true,
	},
};

function stableStringify(value: unknown): string {
	if (typeof value !== "object" || value === null) return JSON.stringify(value) ?? "";
	if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
	const entries = Object.entries(value as Record<string, unknown>)
		.filter(([, v]) => v !== undefined)
		.sort(([a], [b]) => a.localeCompare(b));
	return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(",")}}`;
}

/**
 * The style preset is derived from the actual configuration, never stored:
 * HUD/Classic when the config matches that preset's defaults, else Custom.
 * Manual footer edits therefore show up as Custom immediately, and reloads
 * can never leave a stale preset label behind.
 */
export function deriveStylePreset(config: OpenTuiConfig): StylePreset {
	if (config.footerStyle === "hud" && stableStringify(config.hud) === stableStringify(DEFAULT_HUD_CONFIG)) {
		return "hud";
	}
	if (
		config.footerStyle === "classic" &&
		stableStringify(config.footerSegments) === stableStringify(DEFAULT_CONFIG.footerSegments)
	) {
		return "classic";
	}
	return "custom";
}

export function applyStylePreset(config: OpenTuiConfig, preset: StylePreset): OpenTuiConfig {
	if (preset === "hud") {
		return {
			...config,
			footerStyle: "hud",
			stylePreset: "hud",
			hud: structuredClone(DEFAULT_HUD_CONFIG),
		};
	}
	if (preset === "classic") {
		return {
			...config,
			footerStyle: "classic",
			stylePreset: "classic",
			footerSegments: structuredClone(DEFAULT_CONFIG.footerSegments),
		};
	}
	return { ...config, stylePreset: "custom" };
}

export function getConfigPath(): string {
	const agentDir = getAgentDir();
	return join(agentDir, "open-tui.json");
}

function deepMerge<T>(base: T, override: unknown): T {
	if (typeof base !== "object" || base === null || Array.isArray(base)) {
		return (override as T) ?? base;
	}
	if (typeof override !== "object" || override === null || Array.isArray(override)) {
		return base;
	}
	const result = { ...(base as Record<string, unknown>) };
	const overrideRec = override as Record<string, unknown>;
	for (const key of Object.keys(overrideRec)) {
		const baseVal = (base as Record<string, unknown>)[key];
		const overVal = overrideRec[key];
		if (typeof baseVal === "object" && baseVal !== null && !Array.isArray(baseVal)
			&& typeof overVal === "object" && overVal !== null && !Array.isArray(overVal)) {
			result[key] = deepMerge(baseVal, overVal);
		} else if (overVal !== undefined) {
			result[key] = overVal;
		}
	}
	return result as T;
}

export function ensureConfigExists(): void {
	const path = getConfigPath();
	if (existsSync(path)) return;
	try {
		const agentDir = getAgentDir();
		if (!existsSync(agentDir)) mkdirSync(agentDir, { recursive: true });
		writeFileSync(path, JSON.stringify(DEFAULT_CONFIG, null, 2) + "\n", "utf8");
	} catch {
		// ponytail: silent fallback — config creation is best-effort
	}
}

export function loadConfig(notify?: (msg: string, level: "warning" | "info") => void): OpenTuiConfig {
	const path = getConfigPath();
	if (!existsSync(path)) {
		ensureConfigExists();
		return structuredClone(DEFAULT_CONFIG);
	}

	try {
		const raw = readFileSync(path, "utf8");
		const parsed: unknown = JSON.parse(raw);
		const config = deepMerge(DEFAULT_CONFIG, parsed);
		if (config.settingsLanguage !== "en" && config.settingsLanguage !== "zh") {
			config.settingsLanguage = DEFAULT_CONFIG.settingsLanguage;
		}
		if (config.cursorStyle !== "block" && config.cursorStyle !== "bar" && config.cursorStyle !== "underline") {
			config.cursorStyle = DEFAULT_CONFIG.cursorStyle;
		}
		if (config.footerStyle !== "hud" && config.footerStyle !== "classic") {
			config.footerStyle = DEFAULT_CONFIG.footerStyle;
		}
		config.turnCollapse = normalizeTurnCollapse(config.turnCollapse);
		if (!["hud", "classic", "custom"].includes(config.stylePreset)) {
			config.stylePreset = "custom";
		}
		config.hud = normalizeHudConfig(deepMerge(DEFAULT_HUD_CONFIG, config.hud));
		config.stylePreset = deriveStylePreset(config);
		config.fullscreen.wheelScrollLines = normalizeFullscreenWheelScrollLines(
			config.fullscreen.wheelScrollLines,
			DEFAULT_CONFIG.fullscreen.wheelScrollLines,
		);
		return config;
	} catch (err) {
		notify?.(`open-tui config parse error: ${err instanceof Error ? err.message : String(err)}`, "warning");
		return structuredClone(DEFAULT_CONFIG);
	}
}

export function saveConfig(config: OpenTuiConfig): void {
	const path = getConfigPath();
	try {
		const agentDir = getAgentDir();
		if (!existsSync(agentDir)) mkdirSync(agentDir, { recursive: true });
		writeFileSync(path, JSON.stringify(config, null, 2) + "\n", "utf8");
	} catch {
		// ponytail: silent fallback — config save is best-effort
	}
}
