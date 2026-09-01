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
	runtime: boolean;
	tokens: boolean;
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
	runtime: true,
	tokens: true,
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
	return { ...hud, toolsMax: clamp(hud.toolsMax), filesMax: clamp(hud.filesMax) };
}

export interface FooterSegments {
	cwd: boolean;
	sessionName: boolean;
	gitBranch: boolean;
	gitStatus: boolean;
	gitCommit: boolean;
	runtime: boolean;
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
		runtime: true,
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
