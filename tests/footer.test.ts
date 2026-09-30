import assert from "node:assert/strict";
import test from "node:test";
import type {
	ExtensionContext,
	ReadonlyFooterDataProvider,
	Theme,
} from "@earendil-works/pi-coding-agent";
import { visibleWidth, type Component, type TUI } from "@earendil-works/pi-tui";
import { DEFAULT_CONFIG } from "../extensions/asterisk-tui/config.ts";
import { installClassicFooter as installFooter } from "../extensions/asterisk-tui/footer-classic.ts";
import { installHudFooter, statSegment } from "../extensions/asterisk-tui/footer-hud.ts";
import { emptyGitStatus } from "../extensions/asterisk-tui/git.ts";
import { autoIconHintText, resolveGlyphs, resolveIconMode, shouldShowAutoIconHint } from "../extensions/asterisk-tui/icons.ts";
import { getModelMeta, getUsageTotals, invalidateUsageCache, type FooterState } from "../extensions/asterisk-tui/state.ts";
import { effortColor, fitSegmentsByPriority, formatProviderLabel, shortHostname, truncateBranch, truncatePath } from "../extensions/asterisk-tui/utils.ts";
import { hostname as osHostname } from "node:os";

const theme = {
	fg: (_color: string, text: string) => text,
} as Theme;

test("formatProviderLabel capitalizes by default and preserves raw casing on demand", () => {
	assert.equal(formatProviderLabel("anthropic"), "Anthropic");
	assert.equal(formatProviderLabel("anthropic", false), "anthropic");
	// Proxy-style ids stay untouched when capitalization is off.
	assert.equal(formatProviderLabel("cc-switch-zhipu-glm", false), "cc-switch-zhipu-glm");
	assert.equal(formatProviderLabel(undefined), "Unknown");
	assert.equal(formatProviderLabel(undefined, false), "Unknown");
});

test("classic footer keeps the raw provider casing when capitalization is off", () => {
	let footerFactory: NonNullable<Parameters<ExtensionContext["ui"]["setFooter"]>[0]> | undefined;
	const ctx = {
		model: { provider: "cc-switch-zhipu-glm", contextWindow: 1_000 },
		ui: {
			setFooter(factory: typeof footerFactory) {
				footerFactory = factory;
			},
		},
		sessionManager: {
			getCwd: () => "/work/project",
			getEntries: () => [],
			getSessionName: () => undefined,
		},
		getContextUsage: () => ({ tokens: 250, contextWindow: 1_000, percent: 25 }),
	} as unknown as ExtensionContext;
	const config = structuredClone(DEFAULT_CONFIG);
	config.icons.mode = "ascii";
	const state: FooterState = {
		git: { ...emptyGitStatus(), branch: "main" },
		sessionStartEpoch: Date.now(),
		workingSince: undefined,
		lastDoneIn: undefined,
		lastTurnSummary: undefined,
		outputTps: null,
	};
	installFooter(
		ctx,
		() => state,
		() => config,
		() => getModelMeta(ctx, () => "high", config.footerSegments.capitalizeProviderName),
		{ setRequestRender() {}, scheduleGitRefresh() {} },
	);
	assert.ok(footerFactory);
	const footerData = {
		onBranchChange: () => () => {},
		getExtensionStatuses: () => new Map(),
	} as unknown as ReadonlyFooterDataProvider;
	const component = footerFactory(
		{ requestRender() {} } as TUI,
		theme,
		footerData,
	) as Component;

	// Default on: capitalized.
	const on = component.render(160).join("\n");
	assert.ok(on.includes("Cc-switch-zhipu-glm"), `capitalized provider missing\n${on}`);

	// Off: raw id casing preserved.
	config.footerSegments.capitalizeProviderName = false;
	const off = component.render(160).join("\n");
	assert.ok(off.includes("cc-switch-zhipu-glm"), `raw provider casing missing\n${off}`);
});

test("branch truncation preserves the branch prefix", () => {
	assert.equal(truncateBranch("fix/cwd-footer-truncation", 20), "fix/cwd-footer-tr...");
	assert.equal(truncateBranch("main", 20), "main");
});

test("cwd path truncation keeps head and tail segments", () => {
	assert.equal(truncatePath("~/projects/pi-asterisk-tui", 30), "~/projects/pi-asterisk-tui");
	assert.equal(truncatePath("~/projects/pi-asterisk-tui", 24), "~/.../pi-asterisk-tui");
});

test("cwd path truncation measures display columns, not code units", () => {
	// Regression (upstream #46): CJK paths are few code units but wide on
	// screen; every truncated result must fit its terminal-column budget.
	const path = "~/文档/甲乙丙丁戊己项目";
	for (const budget of [14, 10, 8, 6, 4, 3]) {
		const out = truncatePath(path, budget);
		assert.ok(
			visibleWidth(out) <= budget,
			`budget ${budget}: "${out}" is ${visibleWidth(out)} display columns`,
		);
	}
});

test("branch truncation measures display columns, not code units", () => {
	const out = truncateBranch("修复/中文分支名称很长", 10);
	assert.ok(visibleWidth(out) <= 10, `"${out}" is ${visibleWidth(out)} display columns`);
	assert.ok(out.endsWith("..."));
});

test("fitSegmentsByPriority terminates when a truncate callback cannot shrink", () => {
	// Regression (upstream #46): a truncate callback returning a string wider
	// than the budget used to spin the while loop forever — 100% CPU, no
	// repaint, SIGTERM unable to land. It must drop the stuck segment instead.
	const stuck = "中文路径无法收缩"; // 8 code units, 16 display columns
	const out = fitSegmentsByPriority(
		[
			{ text: stuck, priority: 0, truncate: () => stuck },
			{ text: "kept", priority: 5 },
		],
		10,
	);
	assert.deepEqual(out, ["kept"]);
});

test("footer compacts cwd before truncating lower-priority segments", () => {
	assert.deepEqual(
		fitSegmentsByPriority(
			[
				{ text: "@ ~/projects/pi-asterisk-tui", compactText: "@ pi-asterisk-tui", priority: 0 },
				{ text: "* fix/cwd-footer-truncation", priority: 3 },
				{ text: "node 24.6.0", priority: 4 },
			],
			57,
		),
		["@ pi-asterisk-tui", "* fix/cwd-footer-truncation", "node 24.6.0"],
	);
});

test("narrow footer keeps the cwd basename", () => {
	let footerFactory: NonNullable<Parameters<ExtensionContext["ui"]["setFooter"]>[0]> | undefined;
	const ctx = {
		model: { provider: "openai", contextWindow: 1_000 },
		ui: {
			setFooter(factory: typeof footerFactory) {
				footerFactory = factory;
			},
		},
		sessionManager: {
			getCwd: () => "/work/projects/pi-asterisk-tui",
			getEntries: () => [],
			getSessionName: () => undefined,
		},
		getContextUsage: () => ({ tokens: 0, contextWindow: 1_000, percent: 0 }),
	} as unknown as ExtensionContext;
	const config = structuredClone(DEFAULT_CONFIG);
	config.icons.mode = "ascii";
	const state: FooterState = {
		git: { ...emptyGitStatus(), branch: "main" },
		sessionStartEpoch: Date.now(),
		workingSince: undefined,
		lastDoneIn: undefined,
		lastTurnSummary: undefined,
		outputTps: null,
	};
	installFooter(
		ctx,
		() => state,
		() => config,
		() => ({ provider: "OpenAI", model: "gpt-5", effort: "off" }),
		{ setRequestRender() {}, scheduleGitRefresh() {} },
	);
	assert.ok(footerFactory);
	const footerData = {
		onBranchChange: () => () => {},
		getExtensionStatuses: () => new Map(),
	} as unknown as ReadonlyFooterDataProvider;
	const component = footerFactory(
		{ requestRender() {} } as TUI,
		theme,
		footerData,
	) as Component;
	// Width 59: the full cwd does not fit alongside git+context bar.
	// The footer compacts the cwd to its basename before dropping segments.
	const out = component.render(59).join("\n");
	assert.ok(out.includes("pi-a"), `cwd basename prefix missing\n${out}`);
	assert.ok(!out.includes("~/work/projects"), `full cwd should be compacted\n${out}`);
});

test("narrow footer with a CJK cwd terminates and fits the width", () => {
	// Regression (upstream #46): with the cwd basename short in code units but
	// wide on screen, the fitting loop livelocked at 100% CPU and never
	// rendered. The footer must terminate and emit lines within the budget.
	let footerFactory: NonNullable<Parameters<ExtensionContext["ui"]["setFooter"]>[0]> | undefined;
	const ctx = {
		model: { provider: "openai", contextWindow: 1_000 },
		ui: {
			setFooter(factory: typeof footerFactory) {
				footerFactory = factory;
			},
		},
		sessionManager: {
			getCwd: () => "/工作空间/甲乙丙丁戊己庚辛壬癸目录",
			getEntries: () => [],
			getSessionName: () => undefined,
		},
		getContextUsage: () => ({ tokens: 250, contextWindow: 1_000, percent: 25 }),
	} as unknown as ExtensionContext;
	const config = structuredClone(DEFAULT_CONFIG);
	config.icons.mode = "ascii";
	const state: FooterState = {
		git: { ...emptyGitStatus(), branch: "main" },
		sessionStartEpoch: Date.now(),
		workingSince: undefined,
		lastDoneIn: undefined,
		lastTurnSummary: undefined,
		outputTps: null,
	};
	installFooter(
		ctx,
		() => state,
		() => config,
		() => ({ provider: "OpenAI", model: "gpt-5", effort: "off" }),
		{ setRequestRender() {}, scheduleGitRefresh() {} },
	);
	assert.ok(footerFactory);
	const footerData = {
		onBranchChange: () => () => {},
		getExtensionStatuses: () => new Map(),
	} as unknown as ReadonlyFooterDataProvider;
	const component = footerFactory(
		{ requestRender() {} } as TUI,
		theme,
		footerData,
	) as Component;
	for (const width of [30, 24, 16]) {
		const lines = component.render(width);
		for (const line of lines) {
			assert.ok(
				visibleWidth(line) <= width,
				`width ${width}: line is ${visibleWidth(line)} display columns: ${line}`,
			);
		}
	}
});

test("narrow footer sheds the context bar before left segments", () => {
	let footerFactory: NonNullable<Parameters<ExtensionContext["ui"]["setFooter"]>[0]> | undefined;
	const ctx = {
		model: { provider: "openai", contextWindow: 1_000 },
		ui: {
			setFooter(factory: typeof footerFactory) {
				footerFactory = factory;
			},
		},
		sessionManager: {
			getCwd: () => "/work/project",
			getEntries: () => [],
			getSessionName: () => undefined,
		},
		getContextUsage: () => ({ tokens: 250, contextWindow: 1_000, percent: 25 }),
	} as unknown as ExtensionContext;
	const config = structuredClone(DEFAULT_CONFIG);
	config.icons.mode = "ascii";
	const state: FooterState = {
		git: { ...emptyGitStatus(), branch: "main" },
		sessionStartEpoch: Date.now(),
		workingSince: undefined,
		lastDoneIn: undefined,
		lastTurnSummary: undefined,
		outputTps: null,
	};
	installFooter(
		ctx,
		() => state,
		() => config,
		() => ({ provider: "OpenAI", model: "gpt-5", effort: "off" }),
		{ setRequestRender() {}, scheduleGitRefresh() {} },
	);
	assert.ok(footerFactory);
	const footerData = {
		onBranchChange: () => () => {},
		getExtensionStatuses: () => new Map(),
	} as unknown as ReadonlyFooterDataProvider;
	const component = footerFactory(
		{ requestRender() {} } as TUI,
		theme,
		footerData,
	) as Component;

	// Roomy width: full bar with tokens is right-aligned on line 1.
	const wide = component.render(120).join("\n").split("\n")[0]!;
	assert.ok(wide.includes("250/1.0k"), `full context missing\n${wide}`);

	// Narrow: bar + tokens compact to just icon + pct, cwd survives.
	const narrow = component.render(40).join("\n").split("\n")[0]!;
	assert.ok(narrow.includes("25.0%"), `compact pct missing\n${narrow}`);
	assert.ok(!narrow.includes("250/1.0k"), `token counts should be compacted\n${narrow}`);
	assert.ok(narrow.includes("project"), `cwd should survive\n${narrow}`);

	// Extremely narrow: the context segment is truncated to nothing useful
	// once it no longer fits even alone (everything else is already gone).
	const tiny = component.render(6).join("\n").split("\n")[0]!;
	assert.ok(!tiny.includes("25.0%"), `context should be dropped\n${tiny}`);
});

test("both icon modes provide every footer semantic", () => {
	const keys = [
		"cwd",
		"session",
		"git",
		"working",
		"done",
		"context",
		"model",
		"thinking",
		"input",
		"output",
		"cacheHit",
		"cost",
		"speed",
		"latency",
		"stall",
		"extensions",
	] as const;

	for (const mode of ["nerd", "ascii"] as const) {
		const glyphs = resolveGlyphs(mode);
		for (const key of keys) assert.notEqual(glyphs[key], "", `${mode}.${key}`);
	}
});



test("normalizes invalid usage totals", () => {
	const usage = {
		input: Number.POSITIVE_INFINITY,
		output: undefined,
		cacheRead: 100,
		cacheWrite: null,
		cost: { total: Number.NaN },
	};
	const ctx = {
		sessionManager: {
			getEntries: () => [{ id: "invalid-usage", timestamp: 1, type: "message", message: { role: "assistant", usage } }],
		},
	} as unknown as ExtensionContext;

	invalidateUsageCache();
	assert.deepEqual(getUsageTotals(ctx), {
		input: 0, output: 0, cacheRead: 100, cacheWrite: 0, cost: 0, cacheHitRate: 100,
		tools: { input: 0, output: 0, cost: 0 },
	});
	invalidateUsageCache();
});

test("usage totals count cache-write tokens as input, matching /session's uncached figure", () => {
	// cacheWrite is fresh, near-full-price content; cacheRead is discounted repeat
	// content and stays out of "input".
	const usage = {
		input: 90,
		output: 12,
		cacheRead: 5000,
		cacheWrite: 27009,
		cost: { total: 0.01 },
	};
	const ctx = {
		sessionManager: {
			getEntries: () => [{ id: "cache-write", timestamp: 1, type: "message", message: { role: "assistant", usage } }],
		},
	} as unknown as ExtensionContext;

	invalidateUsageCache();
	const totals = getUsageTotals(ctx);
	assert.equal(totals.input, 27099);
	assert.equal(totals.cacheRead, 5000);
	invalidateUsageCache();
});

test("usage totals skip tool-result usage (not main-context accounting)", () => {
	// ToolResultMessage.usage is usage from the tool execution itself (e.g. a
	// subagent's own LLM call); shell output similarly re-enters the context as
	// the next request's input, never as assistant output.
	const ctx = {
		sessionManager: {
			getEntries: () => [
				{ id: "a1", timestamp: 1, type: "message", message: { role: "assistant", usage: { input: 10, output: 20, cacheRead: 0, cacheWrite: 0, cost: { total: 0.001 } } } },
			{ id: "t1", timestamp: 2, type: "message", message: { role: "toolResult", toolCallId: "t1", toolName: "subagent", content: [], usage: { input: 5_000, output: 9_999, cacheRead: 0, cacheWrite: 0, totalTokens: 14_999, cost: { total: 9 } } } },
			],
		},
	} as unknown as ExtensionContext;

	invalidateUsageCache();
	const totals = getUsageTotals(ctx);
	assert.equal(totals.output, 20);
	assert.equal(totals.input, 10);
	assert.equal(totals.cost, 0.001);
	// The tool's own spend lands in the side-spend bucket, not the main counters.
	assert.deepEqual(totals.tools, { input: 5_000, output: 9_999, cost: 9 });
	invalidateUsageCache();
});

test("usage totals bucket summarization calls as side spend", () => {
	// compaction/branch_summary usage is the summarization LLM call's own cost
	// (pi: "Usage from the LLM call(s) that generated this summary") — real
	// session spend, still not main-context accounting.
	const ctx = {
		sessionManager: {
			getEntries: () => [
				{ id: "a1", timestamp: 1, type: "message", message: { role: "assistant", usage: { input: 40, output: 8, cacheRead: 0, cacheWrite: 0, cost: { total: 0.002 } } } },
				{ id: "c1", timestamp: 2, type: "compaction", summary: "…", firstKeptEntryId: "a1", tokensBefore: 900, usage: { input: 700, output: 300, cacheRead: 0, cacheWrite: 120, cost: { total: 0.75 } } },
				{ id: "b1", timestamp: 3, type: "branch_summary", fromId: "a1", summary: "…", usage: { input: 200, output: 50, cacheRead: 0, cacheWrite: 0, cost: { total: 0.25 } } },
			],
		},
	} as unknown as ExtensionContext;

	invalidateUsageCache();
	const totals = getUsageTotals(ctx);
	assert.equal(totals.input, 40);
	assert.equal(totals.output, 8);
	assert.equal(totals.cost, 0.002);
	// Cache-hit rate stays assistant-only (main-context quality signal).
	assert.equal(totals.cacheHitRate, 0);
	// input mirrors the main convention: input + cacheWrite on the input side.
	assert.deepEqual(totals.tools, { input: 700 + 120 + 200, output: 350, cost: 1 });
	invalidateUsageCache();
});

test("classic cost segment shows the tools side-spend suffix when present", () => {
	let footerFactory: NonNullable<Parameters<ExtensionContext["ui"]["setFooter"]>[0]> | undefined;
	const entries = [
		{
			id: "usage-1",
			timestamp: Date.now(),
			type: "message",
			message: {
				role: "assistant",
				usage: { input: 90, output: 12, cacheRead: 0, cacheWrite: 0, cost: { total: 0.01 } },
			},
		},
		{
			id: "tool-1",
			timestamp: Date.now(),
			type: "message",
			message: {
				role: "toolResult",
				toolCallId: "t1",
				toolName: "subagent",
				content: [],
				usage: { input: 5_000, output: 9_999, cacheRead: 0, cacheWrite: 0, cost: { total: 9 } },
			},
		},
		{
			id: "compact-1",
			timestamp: Date.now(),
			type: "compaction",
			summary: "…",
			firstKeptEntryId: "usage-1",
			tokensBefore: 900,
			usage: { input: 700, output: 300, cacheRead: 0, cacheWrite: 0, cost: { total: 0.5 } },
		},
	];
	const ctx = {
		model: { provider: "openai", contextWindow: 1_000 },
		ui: {
			setFooter(factory: typeof footerFactory) {
				footerFactory = factory;
			},
		},
		sessionManager: {
			getCwd: () => "/work/project",
			getEntries: () => entries,
			getSessionName: () => undefined,
		},
		getContextUsage: () => ({ tokens: 250, contextWindow: 1_000, percent: 25 }),
	} as unknown as ExtensionContext;
	const config = structuredClone(DEFAULT_CONFIG);
	config.icons.mode = "ascii";
	const state: FooterState = {
		git: { ...emptyGitStatus(), branch: "main" },
		sessionStartEpoch: Date.now(),
		workingSince: undefined,
		lastDoneIn: undefined,
		lastTurnSummary: undefined,
		outputTps: null,
	};
	installFooter(
		ctx,
		() => state,
		() => config,
		() => ({ provider: "OpenAI", model: "gpt-5", effort: "off" }),
		{ setRequestRender() {}, scheduleGitRefresh() {} },
	);
	assert.ok(footerFactory);
	const footerData = {
		onBranchChange: () => () => {},
		getExtensionStatuses: () => new Map(),
	} as unknown as ReadonlyFooterDataProvider;
	const component = footerFactory(
		{ requestRender() {} } as TUI,
		theme,
		footerData,
	) as Component;
	const out = component.render(160).join("\n");
	// Main cost stays assistant-only; side spend rides along dimmed.
	assert.ok(out.includes("$0.010"), `main cost missing\n${out}`);
	assert.ok(out.includes("+$9.500 tools"), `side-spend suffix missing\n${out}`);
});

test("hud cost segment shows the tools side-spend suffix when present", () => {
	let footerFactory: NonNullable<Parameters<ExtensionContext["ui"]["setFooter"]>[0]> | undefined;
	const entries = [
		{
			type: "message",
			id: "usage-entry-1",
			timestamp: new Date().toISOString(),
			message: {
				role: "assistant",
				content: [],
				usage: { input: 855, cacheRead: 0, cacheWrite: 0, output: 266, cost: { total: 0 } },
			},
		},
		{
			type: "message",
			id: "tool-entry-1",
			timestamp: new Date().toISOString(),
			message: {
				role: "toolResult",
				toolCallId: "t1",
				toolName: "subagent",
				content: [],
				usage: { input: 500, output: 900, cacheRead: 0, cacheWrite: 0, cost: { total: 1.25 } },
			},
		},
	];
	const ctx = {
		model: { provider: "openai", contextWindow: 1_000_000 },
		ui: {
			setFooter(factory: typeof footerFactory) {
				footerFactory = factory;
			},
		},
		sessionManager: {
			getCwd: () => "/work/project",
			getEntries: () => entries,
			getBranch: () => entries,
			getSessionName: () => undefined,
		},
		getContextUsage: () => ({ tokens: 250_000, contextWindow: 1_000_000, percent: 25 }),
	} as unknown as ExtensionContext;
	const config = structuredClone(DEFAULT_CONFIG);
	config.icons.mode = "ascii";
	const state: FooterState = {
		git: { ...emptyGitStatus(), branch: "main" },
		sessionStartEpoch: Date.now(),
		workingSince: undefined,
		lastDoneIn: undefined,
		lastTurnSummary: undefined,
		outputTps: null,
	};
	const handle = installHudFooter(
		ctx,
		() => state,
		() => config,
		() => ({ provider: "OpenAI", model: "gpt-5", effort: "off" }),
		{ setRequestRender() {}, scheduleGitRefresh() {} },
	);
	assert.ok(footerFactory);
	const hudTheme = { ...theme, underline: (text: string) => text } as Theme;
	const footerData = {
		onBranchChange: () => () => {},
		getExtensionStatuses: () => new Map(),
	} as unknown as ReadonlyFooterDataProvider;
	let component: Component | undefined;
	try {
		component = footerFactory(
			{ requestRender() {} } as TUI,
			hudTheme,
			footerData,
		) as Component;
		const out = component.render(160).join("\n");
		assert.ok(out.includes("+$1.25 tools"), `side-spend suffix missing\n${out}`);
	} finally {
		handle.cleanup();
		(component as unknown as { dispose?: () => void } | undefined)?.dispose?.();
	}
});

test("ASCII footer renders icons as semantic labels", () => {
	let footerFactory: NonNullable<Parameters<ExtensionContext["ui"]["setFooter"]>[0]> | undefined;
	const entries = [{
		id: "usage-1",
		timestamp: Date.now(),
		type: "message",
		message: {
			role: "assistant",
			usage: {
				input: 90,
				output: 12,
				cacheRead: 5000,
				cacheWrite: 27009,
				cost: { total: 0.01 },
			},
		},
	}];
	const ctx = {
		model: { provider: "openai", contextWindow: 1_000 },
		ui: {
			setFooter(factory: typeof footerFactory) {
				footerFactory = factory;
			},
		},
		sessionManager: {
			getCwd: () => "C:\\work\\project",
			getEntries: () => entries,
			getSessionName: () => undefined,
		},
		getContextUsage: () => ({ tokens: 250, contextWindow: 1_000, percent: 25 }),
	} as unknown as ExtensionContext;
	const config = structuredClone(DEFAULT_CONFIG);
	config.icons.mode = "ascii";
	const state: FooterState = {
		git: { ...emptyGitStatus(), branch: "main", modified: 2 },
		sessionStartEpoch: Date.now(),
		workingSince: Date.now() - 2_000,
		lastDoneIn: undefined,
		lastTurnSummary: undefined,
		outputTps: null,
	};

	installFooter(
		ctx,
		() => state,
		() => config,
		() => ({ provider: "OpenAI", model: "gpt-5", effort: "high" }),
		{ setRequestRender() {}, scheduleGitRefresh() {} },
	);
	assert.ok(footerFactory);

	let extensionStatusReads = 0;
	const footerData = {
		onBranchChange: () => () => {},
		getExtensionStatuses: () => {
			extensionStatusReads++;
			return new Map([["goal", "goal active"]]);
		},
	} as unknown as ReadonlyFooterDataProvider;
	const component = footerFactory(
		{ requestRender() {} } as TUI,
		theme,
		footerData,
	) as Component;
	const output = component.render(160).join("\n");

	for (const expected of [
		"@",
		"* main",
		"!2",
		"o working",
		"#",
		"M",
		"~ high",
		"↑ 32k (U 27k + R 5.0k)",
		"↓ 12",
		"c 15.6%",
		"$ $0.010",
		"& goal active",
	]) {
		assert.ok(output.includes(expected), `missing ${expected}\n${output}`);
	}
	assert.equal(extensionStatusReads, 1);

	config.footerSegments.extensionStatuses = false;
	const hiddenOutput = component.render(160);
	assert.equal(hiddenOutput.length, 2);
	assert.doesNotMatch(hiddenOutput.join("\n"), /goal active/);
	assert.equal(extensionStatusReads, 1);
});

test("shortHostname takes the first label only", () => {
	assert.equal(shortHostname("mba.example.com"), "mba");
	assert.equal(shortHostname("single-host"), "single-host");
	assert.equal(shortHostname(""), "");
});

test("classic hostname segment is opt-in and renders the short host", () => {
	let footerFactory: NonNullable<Parameters<ExtensionContext["ui"]["setFooter"]>[0]> | undefined;
	const ctx = {
		model: { provider: "openai", contextWindow: 1_000 },
		ui: {
			setFooter(factory: typeof footerFactory) {
				footerFactory = factory;
			},
		},
		sessionManager: {
			getCwd: () => "/work/project",
			getEntries: () => [],
			getSessionName: () => undefined,
		},
		getContextUsage: () => ({ tokens: 250, contextWindow: 1_000, percent: 25 }),
	} as unknown as ExtensionContext;
	const config = structuredClone(DEFAULT_CONFIG);
	config.icons.mode = "ascii";
	const state: FooterState = {
		git: { ...emptyGitStatus(), branch: "main" },
		sessionStartEpoch: Date.now(),
		workingSince: undefined,
		lastDoneIn: undefined,
		lastTurnSummary: undefined,
		outputTps: null,
	};
	installFooter(
		ctx,
		() => state,
		() => config,
		() => ({ provider: "OpenAI", model: "gpt-5", effort: "off" }),
		{ setRequestRender() {}, scheduleGitRefresh() {} },
	);
	assert.ok(footerFactory);
	const footerData = {
		onBranchChange: () => () => {},
		getExtensionStatuses: () => new Map(),
	} as unknown as ReadonlyFooterDataProvider;
	const component = footerFactory(
		{ requestRender() {} } as TUI,
		theme,
		footerData,
	) as Component;

	// Default off: no host in the footer.
	const off = component.render(160).join("\n");
	assert.ok(!off.includes(shortHostname(osHostname())), `host leaked while disabled\n${off}`);

	// Opt-in: short host appears with the ascii glyph.
	config.footerSegments.hostname = true;
	const on = component.render(160).join("\n");
	assert.ok(on.includes(`h ${shortHostname(osHostname())}`), `host segment missing\n${on}`);
});

test("hud hostname segment is opt-in on the status line", () => {
	let footerFactory: NonNullable<Parameters<ExtensionContext["ui"]["setFooter"]>[0]> | undefined;
	const entries = [{
		type: "message",
		id: "usage-entry-1",
		timestamp: new Date().toISOString(),
		message: {
			role: "assistant",
			content: [],
			usage: { input: 855, cacheRead: 0, cacheWrite: 0, output: 266, cost: { total: 0 } },
		},
	}];
	const ctx = {
		model: { provider: "openai", contextWindow: 1_000_000 },
		ui: {
			setFooter(factory: typeof footerFactory) {
				footerFactory = factory;
			},
		},
		sessionManager: {
			getCwd: () => "/work/project",
			getEntries: () => entries,
			getBranch: () => entries,
			getSessionName: () => undefined,
		},
		getContextUsage: () => ({ tokens: 250_000, contextWindow: 1_000_000, percent: 25 }),
	} as unknown as ExtensionContext;
	const config = structuredClone(DEFAULT_CONFIG);
	config.icons.mode = "ascii";
	const state: FooterState = {
		git: { ...emptyGitStatus(), branch: "main" },
		sessionStartEpoch: Date.now(),
		workingSince: undefined,
		lastDoneIn: undefined,
		lastTurnSummary: undefined,
		outputTps: null,
	};
	const handle = installHudFooter(
		ctx,
		() => state,
		() => config,
		() => ({ provider: "OpenAI", model: "gpt-5", effort: "off" }),
		{ setRequestRender() {}, scheduleGitRefresh() {} },
	);
	assert.ok(footerFactory);
	const hudTheme = { ...theme, underline: (text: string) => text } as Theme;
	const footerData = {
		onBranchChange: () => () => {},
		getExtensionStatuses: () => new Map(),
	} as unknown as ReadonlyFooterDataProvider;
	let component: Component | undefined;
	try {
		component = footerFactory(
			{ requestRender() {} } as TUI,
			hudTheme,
			footerData,
		) as Component;
		const off = component.render(160).join("\n");
		assert.ok(!off.includes(shortHostname(osHostname())), `host leaked while disabled\n${off}`);
		config.hud.hostname = true;
		const on = component.render(160).join("\n");
		assert.ok(on.includes(shortHostname(osHostname())), `host segment missing\n${on}`);
	} finally {
		handle.cleanup();
		(component as unknown as { dispose?: () => void } | undefined)?.dispose?.();
	}
});

function renderFooterWithSession(opts: {
	sessionName?: string | null;
	mode?: "nerd" | "ascii";
	sessionNameEnabled?: boolean;
	width?: number;
}): string {
	const {
		sessionName,
		mode = "ascii",
		sessionNameEnabled = true,
		width = 160,
	} = opts;
	const name = sessionName === undefined ? "test-session" : sessionName;
	let footerFactory: NonNullable<Parameters<ExtensionContext["ui"]["setFooter"]>[0]> | undefined;
	const ctx = {
		model: { provider: "openai", contextWindow: 1_000 },
		ui: {
			setFooter(factory: typeof footerFactory) {
				footerFactory = factory;
			},
		},
		sessionManager: {
			getCwd: () => "/work/project",
			getEntries: () => [],
			getSessionName: () => name,
		},
		getContextUsage: () => ({ tokens: 0, contextWindow: 1_000, percent: 0 }),
	} as unknown as ExtensionContext;
	const config = structuredClone(DEFAULT_CONFIG);
	config.icons.mode = mode;
	config.footerSegments.sessionName = sessionNameEnabled;
	const state: FooterState = {
		git: emptyGitStatus(),
		sessionStartEpoch: Date.now(),
		workingSince: undefined,
		lastDoneIn: undefined,
		lastTurnSummary: undefined,
		outputTps: null,
	};
	installFooter(
		ctx,
		() => state,
		() => config,
		() => ({ provider: "OpenAI", model: "gpt-5", effort: "off" }),
		{ setRequestRender() {}, scheduleGitRefresh() {} },
	);
	assert.ok(footerFactory);
	const footerData = {
		onBranchChange: () => () => {},
		getExtensionStatuses: () => new Map(),
	} as unknown as ReadonlyFooterDataProvider;
	const component = footerFactory(
		{ requestRender() {} } as TUI,
		theme,
		footerData,
	) as Component;
	return component.render(width).join("\n");
}

test("footer shows session name next to cwd when set", () => {
	const out = renderFooterWithSession({ sessionName: "my-session" });
	assert.ok(out.includes("my-session"), `missing session name\n${out}`);
});

test("footer hides session name when getSessionName returns empty", () => {
	const out = renderFooterWithSession({ sessionName: null });
	assert.ok(!out.includes("test-session"), `should not render name\n${out}`);
});

test("footer hides session name when footerSegments.sessionName is false", () => {
	const out = renderFooterWithSession({ sessionName: "my-session", sessionNameEnabled: false });
	assert.ok(!out.includes("my-session"), `should be hidden when disabled\n${out}`);
});

test("footer truncates long session names to 24 width units", () => {
	const longName = "x".repeat(60);
	const out = renderFooterWithSession({ sessionName: longName, width: 200 });
	const clean = out.replace(/\x1b\[[0-9;]*m/g, "");
	assert.ok(!clean.includes(longName), "full name must not appear\n" + clean);
	assert.match(clean, /x{10,}\.\.\./, "truncated name should keep a prefix and ellipsis\n" + clean);
});

test("session name uses matching glyph in nerd and ascii modes", () => {
	const asciiOut = renderFooterWithSession({ mode: "ascii", sessionName: "sess" });
	assert.ok(asciiOut.includes(resolveGlyphs("ascii").session), `ascii glyph missing\n${asciiOut}`);
	const nerdOut = renderFooterWithSession({ mode: "nerd", sessionName: "sess" });
	assert.ok(nerdOut.includes(resolveGlyphs("nerd").session), `nerd glyph missing\n${nerdOut}`);
});

test("done segment summarizes thinking time and tool usage Claude-style", () => {
	let footerFactory: NonNullable<Parameters<ExtensionContext["ui"]["setFooter"]>[0]> | undefined;
	const ctx = {
		model: { provider: "openai", contextWindow: 1_000 },
		ui: {
			setFooter(factory: typeof footerFactory) {
				footerFactory = factory;
			},
		},
		sessionManager: {
			getCwd: () => "/work/project",
			getEntries: () => [],
			getSessionName: () => undefined,
		},
		getContextUsage: () => ({ tokens: 0, contextWindow: 1_000, percent: 0 }),
	} as unknown as ExtensionContext;
	const config = structuredClone(DEFAULT_CONFIG);
	config.icons.mode = "ascii";
	const state: FooterState = {
		git: emptyGitStatus(),
		sessionStartEpoch: Date.now(),
		workingSince: undefined,
		lastDoneIn: 12_000,
		lastTurnSummary: {
			thinkingMs: 8_000,
			toolCalls: 2,
			bashCalls: 2,
			toolCounts: new Map([["bash", 2]]),
		},
		outputTps: null,
	};
	installFooter(
		ctx,
		() => state,
		() => config,
		() => ({ provider: "OpenAI", model: "gpt-5", effort: "off" }),
		{ setRequestRender() {}, scheduleGitRefresh() {} },
	);
	assert.ok(footerFactory);
	const footerData = {
		onBranchChange: () => () => {},
		getExtensionStatuses: () => new Map(),
	} as unknown as ReadonlyFooterDataProvider;
	const component = footerFactory(
		{ requestRender() {} } as TUI,
		theme,
		footerData,
	) as Component;

	const line = component.render(120).join("\n").split("\n")[0]!;
	assert.ok(line.includes("done 12s"), `duration missing\n${line}`);
	assert.ok(line.includes("✻ 8s"), `thinking time missing\n${line}`);
	assert.ok(line.includes("2 shell commands"), `bash summary missing\n${line}`);

	// Mixed tools collapse to the generic wording.
	state.lastTurnSummary = {
		thinkingMs: 0,
		toolCalls: 3,
		bashCalls: 1,
		toolCounts: new Map([["bash", 1], ["read", 2]]),
	};
	const mixed = component.render(120).join("\n").split("\n")[0]!;
	assert.ok(mixed.includes("3 tools"), `generic tool wording missing\n${mixed}`);
	assert.ok(!mixed.includes("✻"), `thinking marker should be absent when there was none\n${mixed}`);
});

test("hud compact token mode renders language-independent shorthand", () => {
	let footerFactory: NonNullable<Parameters<ExtensionContext["ui"]["setFooter"]>[0]> | undefined;
	const entries = [{
		type: "message",
		id: "usage-entry-1",
		timestamp: new Date().toISOString(),
		message: {
			role: "assistant",
			content: [],
			usage: { input: 855_000, cacheRead: 6_900_000, cacheWrite: 0, output: 266_000, cost: { total: 0 } },
		},
	}];
	const ctx = {
		model: { provider: "openai", contextWindow: 1_000_000 },
		ui: {
			setFooter(factory: typeof footerFactory) {
				footerFactory = factory;
			},
		},
		sessionManager: {
			getCwd: () => "/work/project",
			getEntries: () => entries,
			getBranch: () => entries,
			getSessionName: () => undefined,
		},
		getContextUsage: () => ({ tokens: 250_000, contextWindow: 1_000_000, percent: 25 }),
	} as unknown as ExtensionContext;
	const config = structuredClone(DEFAULT_CONFIG);
	config.icons.mode = "ascii";
	const state: FooterState = {
		git: { ...emptyGitStatus(), branch: "main" },
		sessionStartEpoch: Date.now(),
		workingSince: undefined,
		lastDoneIn: undefined,
		lastTurnSummary: undefined,
		outputTps: null,
	};
	const handle = installHudFooter(
		ctx,
			() => state,
			() => config,
			() => ({ provider: "OpenAI", model: "gpt-5", effort: "off" }),
			{ setRequestRender() {}, scheduleGitRefresh() {} },
	);
	const hudTheme = { ...theme, underline: (text: string) => text } as Theme;
	let component: Component | undefined;
	try {
		assert.ok(footerFactory);
		const footerData = {
			onBranchChange: () => () => {},
			getExtensionStatuses: () => new Map(),
		} as unknown as ReadonlyFooterDataProvider;
		component = footerFactory(
			{ requestRender() {} } as TUI,
			hudTheme,
			footerData,
		) as Component;

		// compact (ascii icons): ↑ 7.8M (U 855k + R 6.9M) │ ↓ 266k │ c 89.0% — same in both languages
		invalidateUsageCache();
		config.hud.tokens = "compact";
		config.settingsLanguage = "en";
		const en = component.render(120).join("\n");
		assert.ok(en.includes("↑ 7.8M (U 855k + R 6.9M)"), `compact input breakdown missing\n${en}`);
		assert.ok(en.includes("↓ 266k"), `compact output missing\n${en}`);
		assert.ok(en.includes("c 89.0%"), `compact cache-hit missing\n${en}`);
		assert.ok(!en.includes("↑in "), `verbose input label leaked\n${en}`);
		assert.ok(!en.includes("hit "), `verbose hit label leaked\n${en}`);

		config.settingsLanguage = "zh";
		const zh = component.render(120).join("\n");
		assert.ok(zh.includes("↑ 7.8M (U 855k + R 6.9M)"), `compact should be language-independent\n${zh}`);
		assert.ok(!zh.includes("↑输入"), `chinese verbose label leaked in compact mode\n${zh}`);

		// sub-toggles stay orthogonal: no parens without breakdown, no C without cacheHit
		config.settingsLanguage = "en";
		config.hud.tokenBreakdown = false;
		const noBreakdown = component.render(120).join("\n");
		assert.ok(noBreakdown.includes("↑ 7.8M"), `bare compact input missing\n${noBreakdown}`);
		assert.ok(!noBreakdown.includes("(U "), `breakdown leaked while disabled\n${noBreakdown}`);
		config.hud.tokenBreakdown = true;
		config.hud.cacheHit = false;
		const noHit = component.render(120).join("\n");
		assert.ok(!noHit.includes("c 89"), `cache-hit leaked while disabled\n${noHit}`);

		// verbose keeps the localized labels (icon+text default: glyph + space + label)
		invalidateUsageCache();
		config.hud.cacheHit = true;
		config.hud.tokens = "verbose";
		const verbose = component.render(120).join("\n");
		assert.ok(verbose.includes("↑ in 7.8M"), `verbose input missing\n${verbose}`);
		assert.ok(verbose.includes("·cache 6.9M"), `verbose cache-read suffix missing\n${verbose}`);
		assert.ok(verbose.includes("↓ out 266k"), `verbose output missing\n${verbose}`);

		// off hides the whole token block
		config.hud.tokens = "off";
		const off = component.render(120).join("\n");
		assert.ok(!off.includes("↑ 7.8M"), `input leaked while off\n${off}`);
		assert.ok(!off.includes("↓ 266k"), `output leaked while off\n${off}`);
	} finally {
		handle.cleanup();
		(component as unknown as { dispose?: () => void } | undefined)?.dispose?.();
	}
});

test("hud labels follow the settings language", () => {
	let footerFactory: NonNullable<Parameters<ExtensionContext["ui"]["setFooter"]>[0]> | undefined;
	const ctx = {
		model: { provider: "openai", contextWindow: 1_000 },
		ui: {
			setFooter(factory: typeof footerFactory) {
				footerFactory = factory;
			},
		},
		sessionManager: {
			getCwd: () => "/work/project",
			getEntries: () => [],
			getBranch: () => [],
			getSessionName: () => undefined,
		},
		getContextUsage: () => ({ tokens: 250, contextWindow: 1_000, percent: 25 }),
	} as unknown as ExtensionContext;
	const config = structuredClone(DEFAULT_CONFIG);
	config.icons.mode = "ascii";
	const state: FooterState = {
		git: { ...emptyGitStatus(), branch: "main" },
		sessionStartEpoch: Date.now(),
		workingSince: undefined,
		lastDoneIn: undefined,
		lastTurnSummary: undefined,
		outputTps: null,
	};
	const handle = installHudFooter(
		ctx,
		() => state,
		() => config,
		() => ({ provider: "OpenAI", model: "gpt-5", effort: "off" }),
		{ setRequestRender() {}, scheduleGitRefresh() {} },
	);
	const hudTheme = { ...theme, underline: (text: string) => text } as Theme;
	let component: Component | undefined;
	try {
		assert.ok(footerFactory);
		const footerData = {
			onBranchChange: () => () => {},
			getExtensionStatuses: () => new Map(),
		} as unknown as ReadonlyFooterDataProvider;
		component = footerFactory(
			{ requestRender() {} } as TUI,
			hudTheme,
			footerData,
		) as Component;

		config.settingsLanguage = "en";
		const en = component.render(120).join("\n");
		assert.ok(en.includes("ctx "), `english context label missing\n${en}`);
		assert.ok(!en.includes("上下文"), `chinese label leaked in english mode\n${en}`);

		config.settingsLanguage = "zh";
		const zh = component.render(120).join("\n");
		assert.ok(zh.includes("上下文"), `chinese context label missing\n${zh}`);
		assert.ok(!zh.includes("ctx "), `english label leaked in chinese mode\n${zh}`);
	} finally {
		handle.cleanup();
		(component as unknown as { dispose?: () => void } | undefined)?.dispose?.();
	}
});

test("hud budgets the branch to the space line 1 actually has", () => {
	const branch = "fix/ops/offline-delivery-webhook"; // 32 chars, over the old fixed caps
	let footerFactory: NonNullable<Parameters<ExtensionContext["ui"]["setFooter"]>[0]> | undefined;
	const ctx = {
		model: { provider: "openai", contextWindow: 1_000 },
		ui: {
			setFooter(factory: typeof footerFactory) {
				footerFactory = factory;
			},
		},
		sessionManager: {
			getCwd: () => "/work/projects/AgentCloudCity",
			getEntries: () => [],
			getBranch: () => [],
			getSessionName: () => undefined,
		},
		getContextUsage: () => ({ tokens: 250, contextWindow: 1_000, percent: 25 }),
	} as unknown as ExtensionContext;
	const config = structuredClone(DEFAULT_CONFIG);
	config.icons.mode = "ascii";
	const state: FooterState = {
		git: { ...emptyGitStatus(), branch },
		sessionStartEpoch: Date.now(),
		workingSince: undefined,
		lastDoneIn: undefined,
		lastTurnSummary: undefined,
		outputTps: null,
	};
	const handle = installHudFooter(
		ctx,
		() => state,
		() => config,
		() => ({ provider: "OpenAI", model: "gpt-5", effort: "off" }),
		{ setRequestRender() {}, scheduleGitRefresh() {} },
	);
	const hudTheme = { ...theme, underline: (text: string) => text } as Theme;
	let component: Component | undefined;
	try {
		assert.ok(footerFactory);
		const footerData = {
			onBranchChange: () => () => {},
			getExtensionStatuses: () => new Map(),
		} as unknown as ReadonlyFooterDataProvider;
		component = footerFactory(
			{ requestRender() {} } as TUI,
			hudTheme,
			footerData,
		) as Component;

		const wide = component.render(200).join("\n").split("\n")[0]!;
		assert.ok(wide.includes(branch), `full branch missing when it fits\n${wide}`);

		const narrow = component.render(80).join("\n").split("\n")[0]!;
		assert.ok(!narrow.includes(branch), `branch should shrink to fit\n${narrow}`);
		assert.ok(narrow.includes("git:("), `git segment missing\n${narrow}`);
		assert.ok(visibleWidth(narrow) <= 80, `line 1 overflows the viewport\n${narrow}`);
	} finally {
		handle.cleanup();
		(component as unknown as { dispose?: () => void } | undefined)?.dispose?.();
	}
});

test("classic shows the full branch until the packer runs out of room", () => {
	const branch = "fix/ops/offline-delivery-webhook";
	let footerFactory: NonNullable<Parameters<ExtensionContext["ui"]["setFooter"]>[0]> | undefined;
	const ctx = {
		model: { provider: "openai", contextWindow: 1_000 },
		ui: {
			setFooter(factory: typeof footerFactory) {
				footerFactory = factory;
			},
		},
		sessionManager: {
			getCwd: () => "/work/projects/AgentCloudCity",
			getEntries: () => [],
			getBranch: () => [],
			getSessionName: () => undefined,
		},
		getContextUsage: () => ({ tokens: 250, contextWindow: 1_000, percent: 25 }),
	} as unknown as ExtensionContext;
	const config = structuredClone(DEFAULT_CONFIG);
	config.icons.mode = "ascii";
	const state: FooterState = {
		git: { ...emptyGitStatus(), branch },
		sessionStartEpoch: Date.now(),
		workingSince: undefined,
		lastDoneIn: undefined,
		lastTurnSummary: undefined,
		outputTps: null,
	};
	const handle = installFooter(
		ctx,
		() => state,
		() => config,
		() => ({ provider: "OpenAI", model: "gpt-5", effort: "off" }),
		{ setRequestRender() {}, scheduleGitRefresh() {} },
	);
	let component: Component | undefined;
	try {
		assert.ok(footerFactory);
		const footerData = {
			onBranchChange: () => () => {},
			getExtensionStatuses: () => new Map(),
		} as unknown as ReadonlyFooterDataProvider;
		component = footerFactory(
			{ requestRender() {} } as TUI,
			theme,
			footerData,
		) as Component;

		const wide = component.render(120).join("\n").split("\n")[0]!;
		assert.ok(wide.includes(branch), `full branch missing when it fits\n${wide}`);

		const narrow = component.render(30).join("\n").split("\n")[0]!;
		assert.ok(!narrow.includes(branch), `branch should shrink to fit\n${narrow}`);
		assert.ok(narrow.includes("fix/ops/"), `branch prefix missing\n${narrow}`);
		assert.ok(visibleWidth(narrow) <= 30, `line 1 overflows the viewport\n${narrow}`);
	} finally {
		handle.cleanup();
		(component as unknown as { dispose?: () => void } | undefined)?.dispose?.();
	}
});

test("inline footer moves classic rows into border content", () => {
	let footerFactory: NonNullable<Parameters<ExtensionContext["ui"]["setFooter"]>[0]> | undefined;
	const ctx = {
		model: { provider: "openai", contextWindow: 1_000 },
		ui: {
			setFooter(factory: typeof footerFactory) {
				footerFactory = factory;
			},
		},
		sessionManager: {
			getCwd: () => "/work/project",
			getEntries: () => [],
			getSessionName: () => undefined,
		},
		getContextUsage: () => ({ tokens: 250, contextWindow: 1_000, percent: 25 }),
	} as unknown as ExtensionContext;
	const config = structuredClone(DEFAULT_CONFIG);
	config.icons.mode = "ascii";
	config.footerStyle = "classic";
	const state: FooterState = {
		git: { ...emptyGitStatus(), branch: "main" },
		sessionStartEpoch: Date.now(),
		workingSince: undefined,
		lastDoneIn: 12_000,
		lastTurnSummary: undefined,
		outputTps: null,
	};
	const handle = installFooter(
		ctx,
		() => state,
		() => config,
		() => ({ provider: "OpenAI", model: "gpt-5", effort: "off" }),
		{ setRequestRender() {}, scheduleGitRefresh() {} },
	);
	assert.ok(footerFactory);
	const footerData = {
		onBranchChange: () => () => {},
		getExtensionStatuses: () => new Map(),
	} as unknown as ReadonlyFooterDataProvider;
	const component = footerFactory(
		{ requestRender() {} } as TUI,
		theme,
		footerData,
	) as Component;

	// Default off: two main rows, provider disabled.
	assert.equal(handle.inline.enabled(), false);
	assert.equal(handle.inline.render("top", 60), undefined);
	const rows = component.render(80);
	assert.equal(rows.length, 2);

	// Opt-in: rows vanish (no extension statuses configured), borders carry content.
	config.inlineFooter = true;
	assert.equal(handle.inline.enabled(), true);
	assert.deepEqual(component.render(80), []);
	const top = handle.inline.render("top", 60);
	assert.ok(top, "top line missing");
	assert.ok(top.left.includes("project"), `cwd missing from top-left: ${top.left}`);
	assert.ok(top.right.includes("gpt-5"), `model missing from top-right: ${top.right}`);
	const bottom = handle.inline.render("bottom", 60);
	assert.ok(bottom, "bottom line missing");
	assert.ok(bottom.right.length > 0, `stats missing from bottom-right: ${bottom.right}`);
	// Idle state: the done summary rides bottom-left.
	assert.ok(bottom.left.includes("done"), `done summary missing: ${bottom.left}`);

	// Working state: bottom-left suppresses the timer while the border status
	// owns it (default on)…
	state.workingSince = Date.now() - 5_000;
	const working = handle.inline.render("bottom", 60);
	assert.ok(working, "bottom line missing while working");
	assert.equal(working.left, "", `timer leaked while working: ${working.left}`);

	// …and falls back to the bottom cell when the border status is disabled,
	// so the working state is never invisible.
	config.workingStatus = "line";
	const fallback = handle.inline.render("bottom", 60);
	assert.ok(fallback, "bottom line missing in fallback");
	assert.ok(fallback.left.includes("working"), `fallback timer missing: ${fallback.left}`);

	handle.cleanup();
});

test("auto gates nerd icons by TTY and UTF-8 support (ADR-0006)", () => {
	const envKeys = ["TERM_PROGRAM", "LC_TERMINAL", "WT_SESSION", "TERM", "LC_ALL", "LC_CTYPE", "LANG"];
	const originalEnv = new Map(envKeys.map((key) => [key, process.env[key]]));
	const hadOwnIsTTY = Object.hasOwn(process.stdout, "isTTY");
	const originalIsTTY = process.stdout.isTTY;
	const setIsTTY = (value: boolean) => {
		Object.defineProperty(process.stdout, "isTTY", { configurable: true, value });
	};

	try {
		for (const key of envKeys) delete process.env[key];
		process.env.TERM = "xterm-256color";
		process.env.LANG = "C.UTF-8";

		// Optimistic: interactive UTF-8 TTY ⇒ nerd, unknown terminal included.
		setIsTTY(true);
		assert.equal(resolveIconMode("auto"), "nerd");
		process.env.TERM_PROGRAM = "some-unlisted-runner";
		assert.equal(resolveIconMode("auto"), "nerd");

		// Non-UTF-8 locale, TERM=dumb, non-TTY output ⇒ ascii.
		process.env.LANG = "C";
		assert.equal(resolveIconMode("auto"), "ascii");
		process.env.LANG = "C.UTF-8";
		process.env.TERM = "dumb";
		assert.equal(resolveIconMode("auto"), "ascii");
		process.env.TERM = "xterm-256color";
		setIsTTY(false);
		assert.equal(resolveIconMode("auto"), "ascii");

		// Missing locale defaults to optimistic (matches upstream).
		setIsTTY(true);
		delete process.env.LANG;
		assert.equal(resolveIconMode("auto"), "nerd");
	} finally {
		for (const key of envKeys) {
			const value = originalEnv.get(key);
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
		if (hadOwnIsTTY) {
			Object.defineProperty(process.stdout, "isTTY", { configurable: true, value: originalIsTTY });
		} else {
			Reflect.deleteProperty(process.stdout, "isTTY");
		}
	}
});

test("tofu hint fires once only for auto-resolved nerd (ADR-0006)", () => {
	const envKeys = ["TERM", "LC_ALL", "LC_CTYPE", "LANG"];
	const originalEnv = new Map(envKeys.map((key) => [key, process.env[key]]));
	const hadOwnIsTTY = Object.hasOwn(process.stdout, "isTTY");
	const originalIsTTY = process.stdout.isTTY;

	try {
		for (const key of envKeys) delete process.env[key];
		process.env.TERM = "xterm-256color";
		process.env.LANG = "C.UTF-8";
		Object.defineProperty(process.stdout, "isTTY", { configurable: true, value: true });

		// Auto → nerd, hint not yet shown: fires.
		assert.equal(shouldShowAutoIconHint("auto", false), true);
		// Persisted marker suppresses it.
		assert.equal(shouldShowAutoIconHint("auto", true), false);
		// Explicit modes never hint — the user chose.
		assert.equal(shouldShowAutoIconHint("nerd", false), false);
		assert.equal(shouldShowAutoIconHint("ascii", false), false);

		// Auto resolving to ascii stays silent.
		Object.defineProperty(process.stdout, "isTTY", { configurable: true, value: false });
		assert.equal(shouldShowAutoIconHint("auto", false), false);

		// Both languages carry the remediation path.
		assert.match(autoIconHintText("en"), /icons\.mode=ascii/);
		assert.match(autoIconHintText("zh"), /ascii/);
	} finally {
		for (const key of envKeys) {
			const value = originalEnv.get(key);
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
		if (hadOwnIsTTY) {
			Object.defineProperty(process.stdout, "isTTY", { configurable: true, value: originalIsTTY });
		} else {
			Reflect.deleteProperty(process.stdout, "isTTY");
		}
	}
});

test("hud stat segments follow the statStyle tri-state", () => {
	// icon: glyph + value; icon+text: glyph + label + value; text: label + value.
	// The ascii cost glyph is "$" itself, so that mode renders "$ $0.16" —
	// matching the nerd dollar glyph, which also pairs with the value's "$".
	assert.equal(statSegment("icon", "\u{f155}", "cost ", "$0.16"), "\u{f155} $0.16");
	assert.equal(statSegment("icon+text", "\u{f155}", "cost ", "$0.16"), "\u{f155} cost $0.16");
	assert.equal(statSegment("text", "\u{f155}", "cost ", "$0.16"), "cost $0.16");
	assert.equal(statSegment("icon", "$", "cost ", "$0.16"), "$ $0.16");
	// empty label (time segment) renders the bare duration in every style
	assert.equal(statSegment("text", "\u{f017}", "", "2m 43s"), "2m 43s");
});

test("effortColor covers every level pi's thinking border uses", () => {
	// pi maps border colors off/minimal/low/medium/high/xhigh/max →
	// thinking{Off,Minimal,Low,Medium,High,Xhigh,Max}; a missing case here
	// desyncs the ● ball from the editor border (max once fell to medium).
	assert.equal(effortColor("minimal"), "thinkingMinimal");
	assert.equal(effortColor("low"), "thinkingLow");
	assert.equal(effortColor("medium"), "thinkingMedium");
	assert.equal(effortColor("high"), "thinkingHigh");
	assert.equal(effortColor("xhigh"), "thinkingXhigh");
	assert.equal(effortColor("max"), "thinkingMax");
});

function recordingTheme(sink: Array<{ color: string; text: string }>): Theme {
	return {
		fg: (color: string, text: string) => {
			sink.push({ color, text });
			return text;
		},
		underline: (text: string) => text,
	} as unknown as Theme;
}

function colorsFor(sink: Array<{ color: string; text: string }>, text: string): string[] {
	return sink.filter((p) => p.text === text).map((p) => p.color);
}

function makeHudCtx(): ExtensionContext {
	return {
		model: { provider: "openai", contextWindow: 1_000_000 },
		ui: {
			setFooter(factory: NonNullable<Parameters<ExtensionContext["ui"]["setFooter"]>[0]>) {
				(this as { factory?: unknown }).factory = factory;
			},
		},
		sessionManager: {
			getCwd: () => "/work/project",
			getEntries: () => [],
			getBranch: () => [],
			getSessionName: () => undefined,
		},
		getContextUsage: () => ({ tokens: 250_000, contextWindow: 1_000_000, percent: 25 }),
	} as unknown as ExtensionContext;
}

test("hud model block paints name, ball, and level text with the effort color", () => {
	let footerFactory: NonNullable<Parameters<ExtensionContext["ui"]["setFooter"]>[0]> | undefined;
	const ctx = makeHudCtx();
	ctx.ui.setFooter = (factory: typeof footerFactory) => {
		footerFactory = factory;
	};
	const config = structuredClone(DEFAULT_CONFIG);
	config.icons.mode = "ascii";
	const state: FooterState = {
		git: { ...emptyGitStatus(), branch: "main" },
		sessionStartEpoch: Date.now(),
		workingSince: undefined,
		lastDoneIn: undefined,
		lastTurnSummary: undefined,
		outputTps: null,
	};
	let meta = { provider: "OpenAI", model: "glm-5.3", effort: "max" };
	const handle = installHudFooter(
		ctx,
		() => state,
		() => config,
		() => meta,
		{ setRequestRender() {}, scheduleGitRefresh() {} },
	);
	assert.ok(footerFactory);
	const footerData = {
		onBranchChange: () => () => {},
		getExtensionStatuses: () => new Map(),
	} as unknown as ReadonlyFooterDataProvider;
	let sink: Array<{ color: string; text: string }> = [];
	const component = footerFactory(
		{ requestRender() {} } as TUI,
		recordingTheme(sink),
		footerData,
	) as Component;
	try {
		component.render(160);
		// max: name, ball+level text all thinkingMax — same color as the border.
		assert.deepEqual(colorsFor(sink, "glm-5.3"), ["thinkingMax"]);
		assert.deepEqual(colorsFor(sink, "● max"), ["thinkingMax"]);

		// off: no effort indicator → model name keeps the accent baseline.
		sink.length = 0;
		meta = { provider: "OpenAI", model: "glm-5.3", effort: "off" };
		(component as unknown as { render(w: number): string[] }).render(160);
		assert.deepEqual(colorsFor(sink, "glm-5.3"), ["accent"]);
	} finally {
		handle.cleanup();
		(component as unknown as { dispose?: () => void }).dispose?.();
	}
});

test("classic footer model name follows the effort color", () => {
	let footerFactory: NonNullable<Parameters<ExtensionContext["ui"]["setFooter"]>[0]> | undefined;
	const ctx = makeHudCtx();
	ctx.ui.setFooter = (factory: typeof footerFactory) => {
		footerFactory = factory;
	};
	const config = structuredClone(DEFAULT_CONFIG);
	config.icons.mode = "ascii";
	const state: FooterState = {
		git: { ...emptyGitStatus(), branch: "main" },
		sessionStartEpoch: Date.now(),
		workingSince: undefined,
		lastDoneIn: undefined,
		lastTurnSummary: undefined,
		outputTps: null,
	};
	let meta = { provider: "OpenAI", model: "gpt-5", effort: "max" };
	const handle = installFooter(
		ctx,
		() => state,
		() => config,
		() => meta,
		{ setRequestRender() {}, scheduleGitRefresh() {} },
	);
	assert.ok(footerFactory);
	const footerData = {
		onBranchChange: () => () => {},
		getExtensionStatuses: () => new Map(),
	} as unknown as ReadonlyFooterDataProvider;
	let sink: Array<{ color: string; text: string }> = [];
	const component = footerFactory(
		{ requestRender() {} } as TUI,
		recordingTheme(sink),
		footerData,
	) as Component;
	try {
		component.render(160);
		assert.deepEqual(colorsFor(sink, "gpt-5"), ["thinkingMax"]);

		sink.length = 0;
		meta = { provider: "OpenAI", model: "gpt-5", effort: "off" };
		component.render(160);
		assert.deepEqual(colorsFor(sink, "gpt-5"), ["text"]);
	} finally {
		handle.cleanup();
		(component as unknown as { dispose?: () => void }).dispose?.();
	}
});
