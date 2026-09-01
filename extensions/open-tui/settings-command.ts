import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import {
	Box,
	Input,
	Key,
	matchesKey,
	SelectList,
	type SelectItem,
	type TUI,
	Text,
} from "@earendil-works/pi-tui";
import type { CursorStyle, FooterStyle, HudConfig, IconMode, OpenTuiConfig, SettingsLanguage, StylePreset } from "./config.ts";
import { applyStylePreset, deriveStylePreset } from "./config.ts";
import {
	DEFAULT_FULLSCREEN_WHEEL_SCROLL_LINES,
	normalizeFullscreenWheelScrollLines,
} from "./fullscreen-scroll.ts";

interface SettingItem {
	id: string;
	label: string;
	currentValue: string;
}

type Tab = "features" | "icons" | "segments" | "telemetry";

const TABS: Tab[] = ["features", "icons", "segments", "telemetry"];

const COPY = {
	en: {
		title: "Open TUI Settings",
		tabs: { features: "General", icons: "Appearance", segments: "Footer", telemetry: "Telemetry" },
		hint: "Tab/Shift+Tab/←/→: tabs · ↑/↓: move · Enter/Space: change · Enter on wheel speed: type 1-10 · Esc/q: close",
		labels: {
			enabled: "Enabled",
			language: "Language",
			wheelScrollLines: "Mouse wheel speed",
			cursorStyle: "Cursor style",
			iconMode: "Icon mode",
			cwd: "CWD",
			sessionName: "Session name",
			gitBranch: "Git branch",
			gitStatus: "Git status",
			gitCommit: "Git commit (detached)",
			runtime: "Runtime",
			context: "Context bar",
			tokens: "Tokens",
			cost: "Cost",
			extensionStatuses: "Extension status line",
			footerStyle: "Footer style",
			stylePreset: "Style preset",
			hudModel: "Model",
			hudModelContextWindow: "Model · context window",
			hudModelThinking: "Model · thinking level",
			hudGit: "Git segment",
			hudGitDir: "Git · directory",
			hudGitBranch: "Git · branch",
			hudGitDiffTotals: "Git · [+a -d] totals",
			hudSessionName: "Session name",
			hudTime: "Working time",
			hudCost: "Cost",
			hudOutputSpeed: "Output speed",
			hudContextBar: "Context bar",
			hudContextPercent: "Context · percent",
			hudContextTokens: "Context · tokens",
			hudRuntime: "Runtime",
			hudTokens: "Tokens",
			hudTokenBreakdown: "Tokens · cache read",
			hudCacheHit: "Tokens · cache hit rate",
			hudTools: "Tool usage",
			hudToolsRunning: "Tools · running",
			hudToolsMax: "Tools · max visible",
			hudFiles: "File diffs",
			hudFilesUntracked: "Files · untracked count",
			hudFilesMax: "Files · max visible",
			hudEnvironment: "Environment line",
			hudMemory: "Memory usage",
			hudCompactions: "Compactions count",
			hudDailyCost: "Daily cost",
			hudPiVersion: "Pi version",
			totalDuration: "Total duration",
			tokenCounts: "Token counts",
			stallDetails: "Stall details",
			costRate: "Cost rate",
		},
		values: {
			on: "On",
			off: "Off",
			languages: { en: "English", zh: "简体中文" },
			wheelLines: (count: number) => `${count} ${count === 1 ? "line" : "lines"} / notch`,
			wheelPrompt: (count: number) => `Wheel scroll lines per notch, 1-10 (current: ${count}). Enter: apply · Esc: cancel`,
			cursorStyles: { block: "Block", bar: "Bar", underline: "Underline" },
			footerStyles: { hud: "HUD", classic: "Classic" },
			stylePresets: { hud: "HUD", classic: "Classic", custom: "Custom" },
			count: (n: number) => `${n}`,
			countPrompt: (label: string, current: number) => `${label}, 1-10 (current: ${current}). Enter: apply · Esc: cancel`,
			icons: { auto: "Auto", nerd: "Nerd", ascii: "ASCII" },
		},
	},
	zh: {
		title: "Open TUI 设置",
		tabs: { features: "常规", icons: "外观", segments: "Footer", telemetry: "遥测" },
		hint: "Tab/Shift+Tab/←/→：切页 · ↑/↓：移动 · Enter/Space：更改 · 滚轮速度项 Enter 输入 1-10 · Esc/q：关闭",
		labels: {
			enabled: "启用",
			language: "语言",
			wheelScrollLines: "鼠标滚轮速度",
			cursorStyle: "光标样式",
			iconMode: "图标模式",
			cwd: "当前目录",
			sessionName: "会话名",
			gitBranch: "Git 分支",
			gitStatus: "Git 状态",
			gitCommit: "Git 提交（分离 HEAD）",
			runtime: "运行环境",
			context: "上下文栏",
			tokens: "Token",
			cost: "费用",
			extensionStatuses: "扩展状态行",
			footerStyle: "Footer 样式",
			stylePreset: "风格预设",
			hudModel: "模型",
			hudModelContextWindow: "模型 · 上下文窗口",
			hudModelThinking: "模型 · 思考档位",
			hudGit: "Git 段",
			hudGitDir: "Git · 目录名",
			hudGitBranch: "Git · 分支",
			hudGitDiffTotals: "Git · [+a -d] 统计",
			hudSessionName: "会话名",
			hudTime: "工作时长",
			hudCost: "费用",
			hudOutputSpeed: "输出速度",
			hudContextBar: "上下文进度条",
			hudContextPercent: "上下文 · 百分比",
			hudContextTokens: "上下文 · Token 数",
			hudRuntime: "运行时",
			hudTokens: "Token 统计",
			hudTokenBreakdown: "Token · 缓存读",
			hudCacheHit: "Token · 缓存命中率",
			hudTools: "工具调用",
			hudToolsRunning: "工具 · 执行中",
			hudToolsMax: "工具 · 最多显示",
			hudFiles: "文件增删",
			hudFilesUntracked: "文件 · 未跟踪数",
			hudFilesMax: "文件 · 最多显示",
			hudEnvironment: "环境行",
			hudMemory: "内存占用",
			hudCompactions: "压缩次数",
			hudDailyCost: "今日费用",
			hudPiVersion: "Pi 版本",
			totalDuration: "总耗时",
			tokenCounts: "Token 数量",
			stallDetails: "停顿详情",
			costRate: "费用速率",
		},
		values: {
			on: "开启",
			off: "关闭",
			languages: { en: "English", zh: "简体中文" },
			wheelLines: (count: number) => `每格 ${count} 行`,
			wheelPrompt: (count: number) => `滚轮每格滚动行数（当前 ${count}，范围 1-10），输入后 Enter 应用 · Esc 取消`,
			cursorStyles: { block: "块", bar: "竖线", underline: "下划线" },
			footerStyles: { hud: "HUD 风格", classic: "经典风格" },
			stylePresets: { hud: "HUD 风格", classic: "经典风格", custom: "自定义" },
			count: (n: number) => `${n}`,
			countPrompt: (label: string, current: number) => `${label}（当前 ${current}，范围 1-10），输入后 Enter 应用 · Esc 取消`,
			icons: { auto: "自动", nerd: "Nerd", ascii: "ASCII" },
		},
	},
} as const;

type SettingsCopy = (typeof COPY)[SettingsLanguage];

function toggleSetting(config: OpenTuiConfig, key: keyof OpenTuiConfig["footerSegments"]): OpenTuiConfig {
	return {
		...config,
		footerSegments: {
			...config.footerSegments,
			[key]: !config.footerSegments[key],
		},
	};
}

function setHudNumber(
	config: OpenTuiConfig,
	key: "toolsMax" | "filesMax",
	raw: string,
): OpenTuiConfig | undefined {
	if (!/^\d+$/.test(raw)) return undefined;
	const parsed = Number(raw);
	if (parsed < 1) return undefined;
	return {
		...config,
		hud: { ...config.hud, [key]: Math.min(10, Math.floor(parsed)) },
	};
}

function cycleFooterStyle(config: OpenTuiConfig): OpenTuiConfig {
	const order: FooterStyle[] = ["hud", "classic"];
	const currentIdx = order.indexOf(config.footerStyle);
	const next = order[(currentIdx + 1) % order.length]!;
	return { ...config, footerStyle: next };
}

function cycleIconMode(config: OpenTuiConfig): OpenTuiConfig {
	const order: IconMode[] = ["auto", "nerd", "ascii"];
	const currentIdx = order.indexOf(config.icons.mode);
	const next = order[(currentIdx + 1) % order.length]!;
	return { ...config, icons: { mode: next } };
}

function toggleEnabled(config: OpenTuiConfig): OpenTuiConfig {
	return { ...config, enabled: !config.enabled };
}

function toggleLanguage(config: OpenTuiConfig): OpenTuiConfig {
	return { ...config, settingsLanguage: config.settingsLanguage === "en" ? "zh" : "en" };
}

function cycleCursorStyle(config: OpenTuiConfig): OpenTuiConfig {
	const order: CursorStyle[] = ["block", "bar", "underline"];
	const currentIdx = order.indexOf(config.cursorStyle);
	const next = order[(currentIdx + 1) % order.length]!;
	return { ...config, cursorStyle: next };
}

function setWheelScrollLines(config: OpenTuiConfig, raw: string): OpenTuiConfig | undefined {
	if (!/^\d+$/.test(raw)) return undefined;
	const parsed = Number(raw);
	const bounded = Number.isFinite(parsed) ? parsed : Number.MAX_SAFE_INTEGER;
	return {
		...config,
		fullscreen: {
			...config.fullscreen,
			wheelScrollLines: normalizeFullscreenWheelScrollLines(bounded, DEFAULT_FULLSCREEN_WHEEL_SCROLL_LINES),
		},
	};
}

function toggleTelemetry(config: OpenTuiConfig, key: keyof OpenTuiConfig["telemetry"]): OpenTuiConfig {
	return {
		...config,
		telemetry: { ...config.telemetry, [key]: !config.telemetry[key] },
	};
}

function buildFeaturesItems(config: OpenTuiConfig, copy: SettingsCopy): SettingItem[] {
	return [
		{ id: "enabled", label: copy.labels.enabled, currentValue: config.enabled ? copy.values.on : copy.values.off },
		{ id: "settingsLanguage", label: copy.labels.language, currentValue: copy.values.languages[config.settingsLanguage] },
		{
			id: "wheelScrollLines",
			label: copy.labels.wheelScrollLines,
			currentValue: copy.values.wheelLines(config.fullscreen.wheelScrollLines),
		},
	];
}

function buildIconsItems(config: OpenTuiConfig, copy: SettingsCopy): SettingItem[] {
	return [
		{ id: "mode", label: copy.labels.iconMode, currentValue: copy.values.icons[config.icons.mode] },
		{ id: "cursorStyle", label: copy.labels.cursorStyle, currentValue: copy.values.cursorStyles[config.cursorStyle] },
		{ id: "stylePreset", label: copy.labels.stylePreset, currentValue: copy.values.stylePresets[deriveStylePreset(config)] },
	];
}

function toggleHud(config: OpenTuiConfig, key: keyof HudConfig): OpenTuiConfig {
	return {
		...config,
		hud: {
			...config.hud,
			[key]: !config.hud[key],
		},
	};
}

const HUD_TOGGLE_ITEMS: Array<{ id: string; key: keyof HudConfig; label: string }> = [
	{ id: "model", key: "model", label: "hudModel" },
	{ id: "modelContextWindow", key: "modelContextWindow", label: "hudModelContextWindow" },
	{ id: "modelThinking", key: "modelThinking", label: "hudModelThinking" },
	{ id: "git", key: "git", label: "hudGit" },
	{ id: "gitDir", key: "gitDir", label: "hudGitDir" },
	{ id: "gitBranch", key: "gitBranch", label: "hudGitBranch" },
	{ id: "gitDiffTotals", key: "gitDiffTotals", label: "hudGitDiffTotals" },
	{ id: "sessionName", key: "sessionName", label: "hudSessionName" },
	{ id: "time", key: "time", label: "hudTime" },
	{ id: "cost", key: "cost", label: "hudCost" },
	{ id: "outputSpeed", key: "outputSpeed", label: "hudOutputSpeed" },
	{ id: "contextBar", key: "contextBar", label: "hudContextBar" },
	{ id: "contextPercent", key: "contextPercent", label: "hudContextPercent" },
	{ id: "contextTokens", key: "contextTokens", label: "hudContextTokens" },
	{ id: "runtime", key: "runtime", label: "hudRuntime" },
	{ id: "tokens", key: "tokens", label: "hudTokens" },
	{ id: "tokenBreakdown", key: "tokenBreakdown", label: "hudTokenBreakdown" },
	{ id: "cacheHit", key: "cacheHit", label: "hudCacheHit" },
	{ id: "tools", key: "tools", label: "hudTools" },
	{ id: "toolsRunning", key: "toolsRunning", label: "hudToolsRunning" },
	{ id: "files", key: "files", label: "hudFiles" },
	{ id: "filesUntracked", key: "filesUntracked", label: "hudFilesUntracked" },
	{ id: "extensionStatuses", key: "extensionStatuses", label: "extensionStatuses" },
	{ id: "environment", key: "environment", label: "hudEnvironment" },
	{ id: "memory", key: "memory", label: "hudMemory" },
	{ id: "compactions", key: "compactions", label: "hudCompactions" },
	{ id: "dailyCost", key: "dailyCost", label: "hudDailyCost" },
	{ id: "piVersion", key: "piVersion", label: "hudPiVersion" },
];

function copyLabels(): unknown {
	return COPY.en.labels;
}

function buildSegmentsItems(config: OpenTuiConfig, copy: SettingsCopy): SettingItem[] {
	const flag = (value: boolean) => value ? copy.values.on : copy.values.off;
	const styleItem: SettingItem = {
		id: "footerStyle",
		label: copy.labels.footerStyle,
		currentValue: copy.values.footerStyles[config.footerStyle],
	};
	if (config.footerStyle === "classic") {
		const segs = config.footerSegments;
		return [
			styleItem,
			{ id: "cwd", label: copy.labels.cwd, currentValue: flag(segs.cwd) },
			{ id: "sessionName", label: copy.labels.sessionName, currentValue: flag(segs.sessionName) },
			{ id: "gitBranch", label: copy.labels.gitBranch, currentValue: flag(segs.gitBranch) },
			{ id: "gitStatus", label: copy.labels.gitStatus, currentValue: flag(segs.gitStatus) },
			{ id: "gitCommit", label: copy.labels.gitCommit, currentValue: flag(segs.gitCommit) },
			{ id: "runtime", label: copy.labels.runtime, currentValue: flag(segs.runtime) },
			{ id: "context", label: copy.labels.context, currentValue: flag(segs.context) },
			{ id: "tokens", label: copy.labels.tokens, currentValue: flag(segs.tokens) },
			{ id: "cost", label: copy.labels.cost, currentValue: flag(segs.cost) },
			{ id: "extensionStatuses", label: copy.labels.extensionStatuses, currentValue: flag(segs.extensionStatuses) },
		];
	}
	const hud = config.hud;
	const labels = copy.labels as Record<string, string>;
	return [
		styleItem,
		...HUD_TOGGLE_ITEMS.map(({ id, key, label }) => ({
			id,
			label: labels[label],
			currentValue: flag(hud[key] as boolean),
		})),
		{ id: "toolsMax", label: labels.hudToolsMax, currentValue: copy.values.count(hud.toolsMax) },
		{ id: "filesMax", label: labels.hudFilesMax, currentValue: copy.values.count(hud.filesMax) },
	];
}

function buildTelemetryItems(config: OpenTuiConfig, copy: SettingsCopy): SettingItem[] {
	const telemetry = config.telemetry;
	const flag = (value: boolean) => value ? copy.values.on : copy.values.off;
	return [
		{ id: "enabled", label: copy.labels.enabled, currentValue: flag(telemetry.enabled) },
		{ id: "tps", label: "TPS", currentValue: flag(telemetry.tps) },
		{ id: "ttft", label: "TTFT", currentValue: flag(telemetry.ttft) },
		{ id: "duration", label: copy.labels.totalDuration, currentValue: flag(telemetry.duration) },
		{ id: "tokens", label: copy.labels.tokenCounts, currentValue: flag(telemetry.tokens) },
		{ id: "stalls", label: copy.labels.stallDetails, currentValue: flag(telemetry.stalls) },
		{ id: "cost", label: copy.labels.costRate, currentValue: flag(telemetry.cost) },
	];
}

function cycleStylePreset(config: OpenTuiConfig): OpenTuiConfig {
	// Custom is a derived state, not a cycle target — otherwise a classic
	// preset could never cycle back to HUD (custom apply is a no-op).
	// HUD → Classic → HUD; from Custom, reset to HUD.
	const current = deriveStylePreset(config);
	return applyStylePreset(config, current === "hud" ? "classic" : "hud");
}

function buildItems(tab: Tab, config: OpenTuiConfig): SettingItem[] {
	const copy = COPY[config.settingsLanguage];
	switch (tab) {
		case "features": return buildFeaturesItems(config, copy);
		case "icons": return buildIconsItems(config, copy);
		case "segments": return buildSegmentsItems(config, copy);
		case "telemetry": return buildTelemetryItems(config, copy);
	}
}

function handleSettingChange(
	tab: Tab,
	itemId: string,
	config: OpenTuiConfig,
): OpenTuiConfig {
	if (tab === "features") {
		if (itemId === "enabled") return toggleEnabled(config);
		if (itemId === "settingsLanguage") return toggleLanguage(config);
	}
	if (tab === "icons") {
		if (itemId === "mode") return cycleIconMode(config);
		if (itemId === "cursorStyle") return cycleCursorStyle(config);
		if (itemId === "stylePreset") return cycleStylePreset(config);
	}
	if (tab === "segments") {
		if (itemId === "toolsMax" || itemId === "filesMax") return config; // numeric, via input
		let next: OpenTuiConfig;
		if (itemId === "footerStyle") {
			next = cycleFooterStyle(config);
		} else if (config.footerStyle === "hud" && itemId in config.hud) {
			next = toggleHud(config, itemId as keyof HudConfig);
		} else {
			next = toggleSetting(config, itemId as keyof OpenTuiConfig["footerSegments"]);
		}
		// preset label always reflects the actual config
		return { ...next, stylePreset: deriveStylePreset(next) };
	}
	if (tab === "telemetry") {
		return toggleTelemetry(config, itemId as keyof OpenTuiConfig["telemetry"]);
	}
	return config;
}

interface SettingsUiHandle {
	render: (width: number) => string[];
	invalidate: () => void;
	handleInput: (data: string) => void;
}

class SettingsUi implements SettingsUiHandle {
	private tab: Tab = "features";
	private config: OpenTuiConfig;
	private selectList: SelectList;
	private readonly selectedItemByTab: Partial<Record<Tab, string>> = {};
	private readonly container: Box;
	private readonly theme: Theme;
	private readonly onChange: (config: OpenTuiConfig) => void;
	private readonly onClose: () => void;
	private cachedWidth: number | undefined;
	private cachedLines: string[] | undefined;
	private compact = false;
	private numberInput: { itemId: string; input: Input } | undefined;

	constructor(
		theme: Theme,
		config: OpenTuiConfig,
		onChange: (config: OpenTuiConfig) => void,
		onClose: () => void,
	) {
		this.theme = theme;
		this.config = config;
		this.onChange = onChange;
		this.onClose = onClose;
		this.container = new Box(1, 1, (s: string) => theme.bg("customMessageBg", s));
		this.selectList = new SelectList([], 12, {
			selectedPrefix: (t) => theme.fg("accent", t),
			selectedText: (t) => theme.fg("accent", t),
			description: (t) => theme.fg("muted", t),
			scrollInfo: (t) => theme.fg("dim", t),
			noMatch: (t) => theme.fg("warning", t),
		});
		this.rebuild();
	}

	private applySetting(itemId: string): void {
		this.selectedItemByTab[this.tab] = itemId;
		const numericItem =
			(this.tab === "features" && itemId === "wheelScrollLines") ||
			(this.tab === "segments" && (itemId === "toolsMax" || itemId === "filesMax"));
		if (numericItem) {
			this.openNumberInput(itemId);
			this.invalidate();
			return;
		}
		this.config = handleSettingChange(this.tab, itemId, this.config);
		this.onChange(this.config);
		this.rebuild(itemId);
	}

	private openNumberInput(itemId: string): void {
		const input = new Input();
		input.onSubmit = (value) => {
			let next: OpenTuiConfig | undefined;
			if (itemId === "wheelScrollLines") {
				next = setWheelScrollLines(this.config, value);
			} else {
				next = setHudNumber(this.config, itemId as "toolsMax" | "filesMax", value);
			}
			this.numberInput = undefined;
			if (next) {
				if (itemId === "toolsMax" || itemId === "filesMax") {
					next = { ...next, stylePreset: deriveStylePreset(next) };
				}
				this.config = next;
				this.onChange(this.config);
			}
			this.rebuild(itemId);
		};
		input.onEscape = () => {
			this.numberInput = undefined;
			this.rebuild(itemId);
		};
		this.numberInput = { itemId, input };
		this.rebuild(itemId);
	}

	private switchTab(offset: number): void {
		const idx = TABS.indexOf(this.tab);
		this.tab = TABS[(idx + offset + TABS.length) % TABS.length]!;
		this.rebuild();
	}

	private rebuild(preferredItemId = this.selectedItemByTab[this.tab]): void {
		const copy = COPY[this.config.settingsLanguage];
		this.container.clear();
		this.container.addChild(new Text(this.theme.bold(this.theme.fg("accent", copy.title)), 1, 0));

		const tabBar = TABS.map((tab) => {
			const active = tab === this.tab;
			const label = active ? `[${copy.tabs[tab]}]` : ` ${copy.tabs[tab]} `;
			return active ? this.theme.fg("accent", label) : this.theme.fg("dim", label);
		}).join(" ");
		this.container.addChild(new Text(tabBar, 1, 0));
		this.container.addChild(new Text(this.theme.fg("dim", copy.hint), 1, 0));

		const editingId = this.numberInput?.itemId;
		const items = buildItems(this.tab, this.config).map((item) => {
			const editing = item.id === editingId;
			return {
				value: item.id,
				label: editing
					? (this.compact ? `${item.label}:` : item.label)
					: (this.compact ? `${item.label}: ${item.currentValue}` : item.label),
				description: editing || this.compact ? undefined : item.currentValue,
			} as SelectItem;
		});
		this.selectList = new SelectList(items, Math.min(items.length, 10), {
			selectedPrefix: (t) => this.theme.fg("accent", t),
			selectedText: (t) => this.theme.fg("accent", t),
			description: (t) => this.theme.fg("muted", t),
			scrollInfo: (t) => this.theme.fg("dim", t),
			noMatch: (t) => this.theme.fg("warning", t),
		});
		const selectedIndex = items.findIndex((item) => item.value === preferredItemId);
		if (selectedIndex >= 0) {
			this.selectList.setSelectedIndex(selectedIndex);
		}
		this.selectedItemByTab[this.tab] = this.selectList.getSelectedItem()?.value;
		this.selectList.onSelectionChange = (item) => {
			this.selectedItemByTab[this.tab] = item.value;
		};
		this.selectList.onSelect = (item) => {
			this.applySetting(item.value);
		};
		this.selectList.onCancel = () => {
			this.onClose();
		};
		this.container.addChild(this.selectList);
		if (this.numberInput && editingId !== undefined) {
			const input = this.numberInput.input;
			input.focused = true;
			const labels = copy.labels as Record<string, string>;
			const prompt =
				editingId === "wheelScrollLines"
					? copy.values.wheelPrompt(this.config.fullscreen.wheelScrollLines)
					: editingId === "toolsMax"
						? copy.values.countPrompt(labels.hudToolsMax ?? editingId, this.config.hud.toolsMax)
						: copy.values.countPrompt(labels.hudFilesMax ?? editingId, this.config.hud.filesMax);
			const inputGroup = new Box(4, 0);
			inputGroup.addChild(new Text(
				this.theme.fg("muted", prompt),
				0,
				0,
			));
			inputGroup.addChild(input);
			this.container.addChild(inputGroup);
		}

		this.cachedWidth = undefined;
		this.cachedLines = undefined;
	}

	handleInput(data: string): void {
		if (this.numberInput) {
			this.numberInput.input.handleInput(data);
			this.invalidate();
			return;
		}
		if (matchesKey(data, Key.tab) || matchesKey(data, Key.right)) {
			this.switchTab(1);
			this.invalidate();
			return;
		}
		if (matchesKey(data, Key.shift("tab")) || matchesKey(data, Key.left)) {
			this.switchTab(-1);
			this.invalidate();
			return;
		}
		if (matchesKey(data, Key.escape) || matchesKey(data, "q")) {
			this.onClose();
			return;
		}
		if (matchesKey(data, Key.space) || data === " ") {
			const selected = this.selectList.getSelectedItem();
			if (selected) this.applySetting(selected.value);
		} else {
			this.selectList.handleInput?.(data);
		}
		this.invalidate();
	}

	render(width: number): string[] {
		const compact = width <= 60;
		if (compact !== this.compact) {
			this.compact = compact;
			this.rebuild();
		}
		if (this.cachedLines && this.cachedWidth === width) return this.cachedLines;
		this.cachedWidth = width;
		this.cachedLines = this.container.render(width);
		return this.cachedLines;
	}

	invalidate(): void {
		this.cachedWidth = undefined;
		this.cachedLines = undefined;
		this.container.invalidate();
	}
}

export function registerSettingsCommand(
	pi: ExtensionAPI,
	hooks: {
		getConfig: () => OpenTuiConfig;
		onConfigChanged: (config: OpenTuiConfig) => void;
		onOverlayClosed?: () => void;
	},
): void {
	pi.registerCommand("open-tui", {
		description: "Open the open-tui settings UI",
		handler: async (_args, ctx: ExtensionContext) => {
			if (!ctx.hasUI) return;
		await ctx.ui.custom<void>((tui: TUI, theme, _kb, done) => {
			const ui = new SettingsUi(
				theme,
				hooks.getConfig(),
				(config) => hooks.onConfigChanged(config),
				() => done(undefined),
			);
			return {
				render: (w: number) => ui.render(w),
				invalidate: () => ui.invalidate(),
				handleInput: (data: string) => {
					ui.handleInput(data);
					tui.requestRender();
				},
			};
		}, { overlay: true });
		// Overlay is closed and focus is back on the editor. Deferred UI changes
		// (e.g. toggling the extension) run here, so pi core's focus restore
		// cannot strand the overlay without keyboard input.
		hooks.onOverlayClosed?.();
		},
	});
}
