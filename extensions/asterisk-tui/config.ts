import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { basename, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import {
	DEFAULT_FULLSCREEN_WHEEL_SCROLL_LINES,
	normalizeFullscreenWheelScrollLines,
} from "./fullscreen-scroll.ts";
import type { IconMode } from "./icons.ts";

export type SettingsLanguage = "en" | "zh";
export type CursorStyle = "block" | "bar" | "underline";

/** Selection copy semantics (fullscreen TUI): stock rows / WYSIWYG logical
 * lines / pre-render markdown source. */
export type SelectionCopyMode = "plain" | "unwrapped" | "raw";
export const SELECTION_COPY_MODES: readonly SelectionCopyMode[] = ["plain", "unwrapped", "raw"];
export const DEFAULT_SELECTION_COPY_MODE: SelectionCopyMode = "unwrapped";

export interface SelectionConfig {
	copy: SelectionCopyMode;
	/** Skip padded margins in selections: highlight clamps to content and
	 * plain-mode copies drop leading/trailing margin spaces. */
	trimPadding: boolean;
	/** Tab width in raw copies (rendered tabs are 3 columns). */
	tabWidth: SelectionTabWidth;
}

/** Tab presentation for raw copies: any integer 2–8 (3 = renderer default),
 * or "tab" to keep literal tab characters. */
export type SelectionTabWidth = 2 | 3 | 4 | 5 | 6 | 7 | 8 | "tab";
export const MIN_SELECTION_TAB_WIDTH = 2;
export const MAX_SELECTION_TAB_WIDTH = 8;

/** Parses raw panel input into a tab width: an integer 2–8, or "tab". */
export function parseSelectionTabWidth(raw: string): SelectionTabWidth | undefined {
	const trimmed = raw.trim();
	if (trimmed === "tab") return "tab";
	if (/^\d+$/.test(trimmed)) {
		const value = Number(trimmed);
		if (value >= MIN_SELECTION_TAB_WIDTH && value <= MAX_SELECTION_TAB_WIDTH) return value as SelectionTabWidth;
	}
	return undefined;
}

export const DEFAULT_SELECTION_CONFIG: SelectionConfig = {
	copy: DEFAULT_SELECTION_COPY_MODE,
	trimPadding: true,
	tabWidth: 3,
};

/** Migrates/normalizes the selection block (missing → defaults). */
export function normalizeSelectionConfig(value: unknown): SelectionConfig {
	const raw = (typeof value === "object" && value !== null ? value : {}) as Partial<SelectionConfig>;
	return {
		copy: SELECTION_COPY_MODES.includes(raw.copy as SelectionCopyMode)
			? (raw.copy as SelectionCopyMode)
			: DEFAULT_SELECTION_COPY_MODE,
		trimPadding: raw.trimPadding !== false,
		tabWidth:
			typeof raw.tabWidth === "number" &&
			Number.isInteger(raw.tabWidth) &&
			raw.tabWidth >= MIN_SELECTION_TAB_WIDTH &&
			raw.tabWidth <= MAX_SELECTION_TAB_WIDTH
				? (raw.tabWidth as SelectionTabWidth)
				: raw.tabWidth === "tab"
					? "tab"
					: DEFAULT_SELECTION_CONFIG.tabWidth,
	};
}

export type { IconMode } from "./icons.ts";

export type FooterStyle = "hud" | "classic";
export type StylePreset = "hud" | "classic" | "custom";

/** Working-status presentation while the agent runs: pi's working line, the
 *  editor's top border, or both (the historical default). */
export type WorkingStatusMode = "line" | "border" | "both";
export const WORKING_STATUS_MODES: readonly WorkingStatusMode[] = ["line", "border", "both"];

/** Input-token segment presentation on the working surfaces: hidden, the
 *  run total, or the total with its cache-read part spelled out. */
export type WorkingInputMode = "off" | "total" | "cache";
export const WORKING_INPUT_MODES: readonly WorkingInputMode[] = ["off", "total", "cache"];

/** Working-line content toggles; elapsed time is always shown. */
export interface WorkingLineConfig {
	/** Input tokens incl. cache read (updated at message boundaries). */
	/** Elapsed is always shown when everything else is off. */
	elapsed: boolean;
	input: WorkingInputMode;
	output: boolean;
	cacheHit: boolean;
	/** Run-cumulative cost of completed messages. */
	cost: boolean;
	/** Per-message output speed (the footer shows the run-average speed). */
	speed: boolean;
	tools: boolean;
}

/** Border-status content toggles; degrades by width (segments → elapsed → glyph). */
export interface WorkingBorderConfig {
	elapsed: boolean;
	/** Per-message output speed, shown only while width allows. */
	speed: boolean;
	output: boolean;
	input: WorkingInputMode;
	cacheHit: boolean;
	cost: boolean;	tools: boolean;
}

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

/** HUD stat-segment presentation: glyph only, glyph + text label, or text only.
 *  Applies to the time/cost/daily-cost/speed/token/cache-hit segments; the
 *  compact token shorthand is inherently icon-style and ignores it. */
export type HudStatStyle = "icon" | "icon+text" | "text";
export const HUD_STAT_STYLES: readonly HudStatStyle[] = ["icon", "icon+text", "text"];

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
	/** Opt-in short host name on the status line (first label of os.hostname()). */
	hostname: boolean;
	time: boolean;
	cost: boolean;
	contextBar: boolean;
	contextPercent: boolean;
	contextTokens: boolean;

	tokens: TokenDisplayMode;
	/** Icon/label presentation for the stat segments (time, cost, speed, tokens…). */
	statStyle: HudStatStyle;
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
	hostname: false,
	time: true,
	cost: true,
	contextBar: true,
	contextPercent: true,
	contextTokens: true,

	tokens: "verbose",
	statStyle: "icon+text",
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
	const rawStatStyle: unknown = hud.statStyle;
	const statStyle: HudStatStyle =
		typeof rawStatStyle === "string" && HUD_STAT_STYLES.includes(rawStatStyle as HudStatStyle)
			? (rawStatStyle as HudStatStyle)
			: DEFAULT_HUD_CONFIG.statStyle;
	return { ...hud, tokens, statStyle, toolsMax: clamp(hud.toolsMax), filesMax: clamp(hud.filesMax) };
}

export interface FooterSegments {
	cwd: boolean;
	/** Opt-in short host name segment (first label of os.hostname()). */
	hostname: boolean;
	sessionName: boolean;
	gitBranch: boolean;
	gitStatus: boolean;
	gitCommit: boolean;

	context: boolean;
	tokens: boolean;
	cost: boolean;
	extensionStatuses: boolean;
	/** Uppercase the provider name's first letter (default); false keeps the
	 * raw provider id casing (e.g. proxy-style ids like cc-switch-zhipu-glm). */
	capitalizeProviderName: boolean;
}

export interface TelemetryConfig {
	enabled: boolean;
	/** Store each run's summary as a session custom entry and replay the last
	 *  one on session resume (the live notify itself is transcript-transient). */
	persist: boolean;
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
		/** Internal marker: the auto-mode tofu hint has been shown once. Not a
		 * user-facing setting; persisted so the hint never nags. */
		autoHintShown: boolean;
	};
	footerStyle: FooterStyle;
	footerSegments: FooterSegments;
	/** Working-status presentation while running: "line" (pi's working line),
	 *  "border" (editor top border only), or "both". Migrated from the old
	 *  borderWorkingStatus boolean (true→both, false→line). */
	workingStatus: WorkingStatusMode;
	/** Working-line content (inert while workingStatus is "border"). */
	workingLine: WorkingLineConfig;
	/** Border-status content (inert while workingStatus is "line"). */
	workingBorder: WorkingBorderConfig;
	/** Classic footer rows render inside the editor frame borders instead of
	 * dedicated rows (vertical-space saver). Inert under footerStyle "hud". */
	inlineFooter: boolean;
	hud: HudConfig;
	/** Selection copy behavior (fullscreen TUI); see selection-copy.ts. */
	selection: SelectionConfig;
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
		autoHintShown: false,
	},
	footerStyle: "hud",
	stylePreset: "hud",
	footerSegments: {
		cwd: true,
		hostname: false,
		sessionName: false,
		gitBranch: true,
		gitStatus: true,
		gitCommit: false,

		context: true,
		tokens: true,
		cost: true,
		extensionStatuses: true,
		capitalizeProviderName: true,
	},
	workingStatus: "both",
	workingLine: { elapsed: true, input: "cache", output: true, cacheHit: true, cost: true, speed: true, tools: true },
	workingBorder: { elapsed: true, speed: true, output: false, input: "off", cacheHit: false, cost: false, tools: true },
	inlineFooter: false,
	hud: structuredClone(DEFAULT_HUD_CONFIG),
	selection: structuredClone(DEFAULT_SELECTION_CONFIG),
	telemetry: {
		enabled: true,
		persist: true,
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
	return join(agentDir, "asterisk-tui.json");
}

/** Pre-rename location; its settings are adopted into getConfigPath() on first run. */
function getLegacyConfigPath(): string {
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

/** Reads a file's contents; null when missing. Other errors propagate. */
function readFileIfExists(path: string): string | null {
	try {
		return readFileSync(path, "utf8");
	} catch (err) {
		if ((err as NodeJS.ErrnoException | null)?.code !== "ENOENT") throw err;
		return null;
	}
}

export function ensureConfigExists(): void {
	const path = getConfigPath();
	try {
		const agentDir = getAgentDir();
		mkdirSync(agentDir, { recursive: true });
		// First run after the rename: adopt legacy open-tui.json settings verbatim.
		// "wx" makes the create atomic — a concurrent creator wins with EEXIST.
		const legacySeed = readFileIfExists(getLegacyConfigPath());
		const seed = legacySeed !== null
			? legacySeed
			: JSON.stringify(DEFAULT_CONFIG, null, 2) + "\n";
		writeFileSync(path, seed, { flag: "wx" });
	} catch {
		// ponytail: silent fallback — config creation is best-effort
	}
}

export function loadConfig(notify?: (msg: string, level: "warning" | "info") => void): OpenTuiConfig {
	const path = getConfigPath();
	// Read-first: on the first run ensureConfigExists adopts legacy
	// open-tui.json settings into the new location, then we read it back. If
	// that write failed (e.g. read-only dir), read the legacy file directly —
	// the next saveConfig writes the new location.
	let source = path;
	try {
		let raw = readFileIfExists(path);
		if (raw === null) {
			ensureConfigExists();
			raw = readFileIfExists(path);
		}
		if (raw === null) {
			const legacyPath = getLegacyConfigPath();
			raw = readFileIfExists(legacyPath);
			if (raw === null) return structuredClone(DEFAULT_CONFIG);
			source = legacyPath;
		}
		const parsed: unknown = JSON.parse(raw);
		// borderWorkingStatus (boolean) folds into the workingStatus tri-state
		// BEFORE the merge — otherwise the filled-in default is indistinguishable
		// from an explicit "both" and the legacy value would be ignored
		const parsedRecord = parsed as Record<string, unknown>;
		if (parsedRecord !== null && typeof parsedRecord === "object") {
			if (parsedRecord.workingStatus === undefined && typeof parsedRecord.borderWorkingStatus === "boolean") {
				parsedRecord.workingStatus = parsedRecord.borderWorkingStatus ? "both" : "line";
			}
			delete parsedRecord.borderWorkingStatus;
		}
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
		config.selection = normalizeSelectionConfig(config.selection);
		if (!["hud", "classic", "custom"].includes(config.stylePreset)) {
			config.stylePreset = "custom";
		}
		config.hud = normalizeHudConfig(deepMerge(DEFAULT_HUD_CONFIG, config.hud));
		if (!WORKING_STATUS_MODES.includes(config.workingStatus)) {
			config.workingStatus = "both";
		}
		// legacy boolean input toggles fold into the tri-state (true showed the
		// plain total; the cache breakdown is the upgrade default)
		for (const group of ["workingLine", "workingBorder"] as const) {
			const rawInput: unknown = (config[group] as unknown as Record<string, unknown>).input;
			if (rawInput === true) (config[group] as unknown as Record<string, unknown>).input = "cache";
			else if (rawInput === false) (config[group] as unknown as Record<string, unknown>).input = "off";
			else if (typeof rawInput !== "string" || !WORKING_INPUT_MODES.includes(rawInput as WorkingInputMode)) {
				(config[group] as unknown as Record<string, unknown>).input = DEFAULT_CONFIG[group].input;
			}
		}
		config.stylePreset = deriveStylePreset(config);
		config.fullscreen.wheelScrollLines = normalizeFullscreenWheelScrollLines(
			config.fullscreen.wheelScrollLines,
			DEFAULT_CONFIG.fullscreen.wheelScrollLines,
		);
		return config;
	} catch (err) {
		notify?.(`${basename(source)} parse error: ${err instanceof Error ? err.message : String(err)}`, "warning");
		return structuredClone(DEFAULT_CONFIG);
	}
}

export function saveConfig(config: OpenTuiConfig): void {
	const path = getConfigPath();
	try {
		const agentDir = getAgentDir();
		mkdirSync(agentDir, { recursive: true });
		writeFileSync(path, JSON.stringify(config, null, 2) + "\n", "utf8");
	} catch {
		// ponytail: silent fallback — config save is best-effort
	}
}
