import assert from "node:assert/strict";
import test from "node:test";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type {
	ExtensionAPI,
	ExtensionContext,
	MessageUpdateEvent,
	Theme,
	TurnEndEvent,
} from "@earendil-works/pi-coding-agent";
import { DEFAULT_CONFIG } from "../extensions/asterisk-tui/config.ts";
import openTui from "../extensions/asterisk-tui/index.ts";
import {
	formatTurnTelemetry,
	formatWorkingBorderText,
	formatWorkingLineMessage,
	loadLastTelemetryEntry,
	sumSessionTelemetry,
	TELEMETRY_ENTRY_TYPE,
	TurnTelemetryTracker,
} from "../extensions/asterisk-tui/telemetry.ts";
import { resolveGlyphs } from "../extensions/asterisk-tui/icons.ts";
import { estimateStreamedTokens } from "../extensions/asterisk-tui/utils.ts";

const theme = {
	fg: (_color: string, text: string) => text,
} as Theme;

function makeMessage(output = 20, input = 50, cacheWrite = 0, cacheRead = 0): AssistantMessage {
	const totalTokens = input + output + cacheWrite + cacheRead;
	return {
		role: "assistant",
		content: [{ type: "text", text: "response" }],
		api: "openai-completions",
		provider: "openai",
		model: "gpt-4",
		usage: {
			input,
			output,
			cacheRead,
			cacheWrite,
			totalTokens,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: totalTokens * 0.000004 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

function update(
	message: AssistantMessage,
	assistantMessageEvent: MessageUpdateEvent["assistantMessageEvent"] = {
		type: "text_delta",
		contentIndex: 0,
		delta: "x",
		partial: message,
	},
): MessageUpdateEvent {
	return {
		type: "message_update",
		message,
		assistantMessageEvent,
	};
}

function startTurn(tracker: TurnTelemetryTracker, message: AssistantMessage, turnIndex = 0): void {
	tracker.handle({ type: "turn_start", turnIndex, timestamp: Date.now() });
	tracker.handle({ type: "message_start", message });
}

function endTurn(tracker: TurnTelemetryTracker, message: AssistantMessage, turnIndex = 0) {
	tracker.handle({ type: "message_end", message });
	return tracker.handle({ type: "turn_end", turnIndex, message, toolResults: [], messageEntryId: "m1", toolResultEntryIds: [], ...BOUNDARY_FIXTURE });
}

/** pi 0.87 TurnEndEvent carries the full boundary state; fixtures need it
 * present but the tracker only reads message/toolResults. */
const BOUNDARY_FIXTURE: Pick<TurnEndEvent, "entries" | "continue" | "context" | "outcome"> = {
	entries: [],
	continue: false,
	context: { contextEntries: [], contextMessages: [], llmMessages: [], pendingMessages: [], canContinue: false },
	outcome: "completed",
};

test("uses total output over full generation time", () => {
	let now = 0;
	const tracker = new TurnTelemetryTracker(() => now);
	const message = makeMessage();
	startTurn(tracker, message);
	for (const timestamp of [4_000, 4_100]) {
		now = timestamp;
		tracker.handle(update(message));
	}
	now = 5_000;
	const telemetry = endTurn(tracker, message);

	assert.deepEqual(telemetry, {
		tps: 4,
		ttftMs: 4_000,
		toolCalls: 0,
		totalMs: 5_000,
		inputTokens: 50,
		outputTokens: 20,
		cacheReadTokens: 0,
		stallMs: 0,
		stallCount: 0,
		rateUsdPerMTokens: 4,
		generationMs: 5_000,
		totalTokens: 70, cacheHitRate: null,
		costUsd: 0.00028,
		measurementMs: 5_000,
	});
	assert.equal(
		formatTurnTelemetry(telemetry!, theme, DEFAULT_CONFIG.telemetry, "ascii"),
		"> TPS 4.0 tok/s | ~ TTFT 4.0s | + 5.0s | ↑ 50 | ↓ 20 | $ $0.0003 · $4.00/M",
	);
});

test("normalizes invalid usage without breaking turn telemetry", () => {
	let now = 0;
	const tracker = new TurnTelemetryTracker(() => now);
	const messages = [makeMessage(), makeMessage()];
	Object.assign(messages[0]!.usage, { input: Number.POSITIVE_INFINITY, totalTokens: null, cost: { total: Number.NaN } });
	Object.assign(messages[1]!.usage, { output: undefined, cost: undefined });

	tracker.handle({ type: "turn_start", turnIndex: 0, timestamp: Date.now() });
	for (const message of messages) {
		tracker.handle({ type: "message_start", message });
		now += 100;
		tracker.handle(update(message));
		now += 100;
		tracker.handle({ type: "message_end", message });
	}
	const telemetry = tracker.handle({ type: "turn_end", turnIndex: 0, message: messages[1]!, toolResults: [], messageEntryId: "m1", toolResultEntryIds: [], ...BOUNDARY_FIXTURE })!;

	assert.equal(telemetry.inputTokens, 50);
	assert.equal(telemetry.outputTokens, 20);
	assert.equal(telemetry.totalTokens, 70);
	assert.equal(telemetry.costUsd, 0);
	assert.equal(telemetry.rateUsdPerMTokens, null);
});

test("measures non-streamed responses from turn start", () => {
	let now = 0;
	const tracker = new TurnTelemetryTracker(() => now);
	const message = makeMessage();

	tracker.handle({ type: "turn_start", turnIndex: 0, timestamp: Date.now() });
	now = 5_000;
	tracker.handle({ type: "message_start", message });
	tracker.handle({ type: "message_end", message });
	const telemetry = tracker.handle({ type: "turn_end", turnIndex: 0, message, toolResults: [], messageEntryId: "m1", toolResultEntryIds: [], ...BOUNDARY_FIXTURE })!;

	assert.equal(telemetry.tps, 4);
	assert.equal(telemetry.ttftMs, 5_000);
	assert.equal(telemetry.generationMs, 5_000);
	assert.equal(telemetry.measurementMs, 5_000);
});

test("uses footer semantics and respects telemetry segment settings", () => {
	const colors: string[] = [];
	const styledTheme = {
		fg: (color: string, text: string) => {
			colors.push(color);
			return text;
		},
	} as Theme;
	const telemetry = {
		tps: 50,
		ttftMs: 200,
		toolCalls: 3,
		totalMs: 900,
		inputTokens: 50,
		outputTokens: 20,
		cacheReadTokens: 5_000,
		stallMs: 800,
		stallCount: 1,
		rateUsdPerMTokens: 4,
		generationMs: 700,
		totalTokens: 70, cacheHitRate: null,
		costUsd: 0.00028,
		measurementMs: 400,
	};

	assert.match(
		formatTurnTelemetry(telemetry, styledTheme, DEFAULT_CONFIG.telemetry, "ascii"),
		/^> TPS 50\.0 tok\/s \| ~ TTFT 0\.2s \| \+ 0\.9s \| t 3 \| ↑ 5\.0k \(U 50 \+ R 5\.0k\) \| ↓ 20.*! stall 1x \/ 0\.8s \| \$ \$0.0003 \u00b7 \$4.00\/M$/,
	);
	assert.deepEqual(colors, ["accent", "text", "success", "text", "accent", "success", "warning", "warning", "dim"]);

	const hidden: typeof DEFAULT_CONFIG.telemetry = {
		enabled: false,
		persist: false,
		tools: false,
		tps: false,
		ttft: false,
		duration: false,
		tokens: false,
		stalls: false,
		cost: "off",
	};
	assert.equal(formatTurnTelemetry(telemetry, theme, hidden, "ascii"), "");

	// cost-only mode drops the rate dimension
	const spendOnly = formatTurnTelemetry(
		telemetry,
		styledTheme as unknown as Theme,
		{ ...DEFAULT_CONFIG.telemetry, cost: "cost" },
		"ascii",
	);
	assert.ok(spendOnly.includes("$0.0003") && !spendOnly.includes("/M"), spendOnly);
});

test("returns no TPS without output or generation time", () => {
	const scenarios = [
		{ name: "zero duration", updates: [0, 0], endMs: 0, output: 20 },
		{ name: "zero output", updates: [100, 200], endMs: 800, output: 0 },
	];

	for (const scenario of scenarios) {
		let now = 0;
		const tracker = new TurnTelemetryTracker(() => now);
		const message = makeMessage(scenario.output);
		startTurn(tracker, message);
		for (const timestamp of scenario.updates) {
			now = timestamp;
			tracker.handle(update(message));
		}
		now = scenario.endMs;
		const telemetry = endTurn(tracker, message);
		assert.equal(telemetry?.tps, null, scenario.name);
		assert.equal(telemetry?.outputTokens, scenario.output, scenario.name);
	}
});

test("keeps stalls in delivery time so they lower TPS", () => {
	function measure(updates: number[], endMs: number) {
		let now = 0;
		const tracker = new TurnTelemetryTracker(() => now);
		const message = makeMessage();
		startTurn(tracker, message);
		for (const timestamp of updates) {
			now = timestamp;
			tracker.handle(update(message));
		}
		now = endMs;
		return endTurn(tracker, message)!;
	}

	const uninterrupted = measure([100, 200, 300], 800);
	const stalled = measure([100, 1200, 2300, 2400, 3500], 3600);

	assert.equal(uninterrupted.tps, 25);
	assert.equal(stalled.tps, 5.6);
	assert.ok(stalled.tps! < uninterrupted.tps!);
	assert.equal(stalled.stallMs, 3300);
	assert.equal(stalled.stallCount, 2);
	assert.match(formatTurnTelemetry(stalled, theme, DEFAULT_CONFIG.telemetry, "ascii"), /! stall 2x \/ 3\.3s/);
});

test("only meaningful stream deltas define TTFT and stalls", () => {
	let now = 0;
	const tracker = new TurnTelemetryTracker(() => now);
	const message = makeMessage();
	startTurn(tracker, message);

	now = 100;
	tracker.handle(update(message, { type: "start", partial: message }));
	now = 200;
	tracker.handle(update(message, { type: "text_start", contentIndex: 0, partial: message }));
	now = 700;
	tracker.handle(update(message));
	now = 800;
	tracker.handle(update(message));
	now = 900;
	tracker.handle(update(message));
	now = 10_000;
	tracker.handle(update(message, { type: "done", reason: "stop", message }));
	now = 10_100;
	const telemetry = endTurn(tracker, message)!;

	assert.equal(telemetry.ttftMs, 700);
	assert.equal(telemetry.stallMs, 0);
	assert.equal(telemetry.stallCount, 0);
});

test("is stable across chunk counts", () => {
	function measure(updateTimes: number[]) {
		let now = 0;
		const tracker = new TurnTelemetryTracker(() => now);
		const message = makeMessage();
		startTurn(tracker, message);
		for (const timestamp of updateTimes) {
			now = timestamp;
			tracker.handle(update(message));
		}
		now = 800;
		return endTurn(tracker, message)!;
	}

	assert.equal(measure([100, 700]).tps, 25);
	assert.equal(measure([100, 200, 300, 400, 500, 700]).tps, 25);
});

test("uses full generation time for high rates", () => {
	let now = 0;
	const tracker = new TurnTelemetryTracker(() => now);
	const message = makeMessage(3_000);
	startTurn(tracker, message);
	now = 100;
	tracker.handle(update(message));
	now = 200;
	tracker.handle(update(message));
	now = 300;

	assert.equal(endTurn(tracker, message)?.tps, 10_000);
});

test("excludes tool gaps between assistant messages", () => {
	function measure(toolGapMs: number) {
		let now = 0;
		const tracker = new TurnTelemetryTracker(() => now);
		const first = makeMessage(20, 10);
		const second = makeMessage(20, 10);

		tracker.handle({ type: "agent_start" });
		startTurn(tracker, first);
		for (const timestamp of [100, 200]) {
			now = timestamp;
			tracker.handle(update(first));
		}
		now = 400;
		endTurn(tracker, first);

		now += toolGapMs;
		const secondStartMs = now;
		startTurn(tracker, second, 1);
		for (const offset of [100, 200]) {
			now = secondStartMs + offset;
			tracker.handle(update(second));
		}
		now = secondStartMs + 400;
		endTurn(tracker, second, 1);
		return tracker.handle({ type: "agent_settled" })!;
	}

	assert.equal(measure(0).tps, 50);
	assert.equal(measure(10_000).tps, 50);
});

test("includes every message's tokens and generation time", () => {
	let now = 0;
	const tracker = new TurnTelemetryTracker(() => now);
	const short = makeMessage(5, 20);
	const measured = makeMessage(20, 50);

	tracker.handle({ type: "agent_start" });
	startTurn(tracker, short);
	now = 100;
	tracker.handle(update(short));
	now = 150;
	endTurn(tracker, short);

	startTurn(tracker, measured, 1);
	for (const timestamp of [200, 300]) {
		now = timestamp;
		tracker.handle(update(measured));
	}
	now = 700;
	endTurn(tracker, measured, 1);
	const telemetry = tracker.handle({ type: "agent_settled" })!;

	assert.equal(telemetry.tps, 35.7);
	assert.equal(telemetry.measurementMs, 700);
	assert.equal(telemetry.inputTokens, 70);
	assert.equal(telemetry.outputTokens, 25);
});

test("counts cache-write tokens as input, matching /session's uncached figure", () => {
	// cacheWrite is fresh, near-full-price content; cacheRead is discounted repeat
	// content and stays out of inputTokens.
	let now = 0;
	const tracker = new TurnTelemetryTracker(() => now);
	const message = makeMessage(12, 90, 27009, 5000);

	tracker.handle({ type: "agent_start" });
	startTurn(tracker, message);
	now = 100;
	tracker.handle(update(message));
	now = 150;
	endTurn(tracker, message);
	const telemetry = tracker.handle({ type: "agent_settled" })!;

	assert.equal(telemetry.inputTokens, 27099);
	assert.equal(telemetry.cacheReadTokens, 5000);
	assert.match(
		formatTurnTelemetry(telemetry, theme, DEFAULT_CONFIG.telemetry, "ascii"),
		/\| ↑ 32k \(U 27k \+ R 5\.0k\) \| ↓ 12 \|/,
	);
});

test("aggregates all output and generation time across an agent run", () => {
	let now = 0;
	const tracker = new TurnTelemetryTracker(() => now);
	const short = makeMessage(5, 20);
	const first = makeMessage(20, 50);
	const second = makeMessage(30, 100);

	tracker.handle({ type: "agent_start" });
	startTurn(tracker, short);
	now = 100;
	tracker.handle(update(short));
	now = 150;
	endTurn(tracker, short);

	now = 200;
	startTurn(tracker, first, 1);
	for (const timestamp of [300, 400]) {
		now = timestamp;
		tracker.handle(update(first));
	}
	now = 800;
	endTurn(tracker, first, 1);

	now = 900;
	startTurn(tracker, second, 2);
	for (const timestamp of [1_000, 1_100]) {
		now = timestamp;
		tracker.handle(update(second));
	}
	now = 1_600;
	endTurn(tracker, second, 2);
	now = 1_700;
	const telemetry = tracker.handle({ type: "agent_settled" })!;

	assert.equal(telemetry.tps, 37.9);
	assert.equal(telemetry.measurementMs, 1_450);
	assert.equal(telemetry.inputTokens, 170);
	assert.equal(telemetry.outputTokens, 55);
	assert.equal(telemetry.totalTokens, 225);
	assert.equal(telemetry.rateUsdPerMTokens, 4);
});

test("per-message output speed requires a credible streaming window", () => {
	// Credible message: 40 tokens over 2s → 20 tok/s.
	let now = 0;
	const tracker = new TurnTelemetryTracker(() => now);
	const credible = makeMessage(40, 50);
	startTurn(tracker, credible);
	now = 1_000;
	tracker.handle(update(credible));
	now = 3_000;
	tracker.handle({ type: "message_end", message: credible });
	assert.equal(tracker.getOutputTps(), 20);

	// Buffered proxy flushes a 2725-token message in a 520ms local burst:
	// wall clock says nothing about generation time — keep the last credible
	// speed instead of publishing ~5200 tok/s.
	const burst = makeMessage(2_725, 50);
	startTurn(tracker, burst, 1);
	now = 90_000;
	tracker.handle(update(burst));
	now = 90_500;
	tracker.handle(update(burst));
	now = 90_520;
	tracker.handle({ type: "message_end", message: burst });
	assert.equal(tracker.getOutputTps(), 20);
});

test("output speed stays hidden when every window is a burst", () => {
	let now = 0;
	const tracker = new TurnTelemetryTracker(() => now);
	const burst = makeMessage(3_000, 50);
	startTurn(tracker, burst);
	now = 1_000;
	tracker.handle(update(burst));
	now = 1_500;
	tracker.handle(update(burst));
	now = 1_520;
	tracker.handle({ type: "message_end", message: burst });
	assert.equal(tracker.getOutputTps(), null);
});

test("per-message output speed accepts a window at the threshold", () => {
	let now = 0;
	const tracker = new TurnTelemetryTracker(() => now);
	const message = makeMessage(10, 50);
	startTurn(tracker, message);
	now = 1_000;
	tracker.handle(update(message));
	now = 2_000;
	tracker.handle({ type: "message_end", message: message });
	assert.equal(tracker.getOutputTps(), 10);
});

test("tool results never feed the output counters", () => {
	let now = 0;
	const tracker = new TurnTelemetryTracker(() => now);
	tracker.handle({ type: "agent_start" });

	// Completed assistant message: 40 tokens over 2s → 20 tok/s.
	const message = makeMessage(40, 50);
	startTurn(tracker, message);
	now = 1_000;
	tracker.handle(update(message));
	now = 3_000;
	tracker.handle({ type: "message_end", message });
	assert.equal(tracker.getRunOutputTokens(), 40);
	assert.equal(tracker.getOutputTps(), 20);

	// Shell tool returns 30k chars; subagent-style tools even attach their own
	// usage to the toolResult message — none of that is main-context output.
	const toolResult = {
		role: "toolResult",
		toolCallId: "t1",
		toolName: "bash",
		content: [{ type: "text", text: "x".repeat(30_000) }],
		usage: { input: 5_000, output: 9_999, cacheRead: 0, cacheWrite: 0, totalTokens: 14_999, cost: { total: 1 } },
	} as unknown as AssistantMessage;
	tracker.handle({ type: "tool_execution_start", toolCallId: "t1", toolName: "bash", args: {} });
	tracker.handle({ type: "message_start", message: toolResult });
	tracker.handle({ type: "message_end", message: toolResult });

	assert.equal(tracker.getRunOutputTokens(), 40);
	assert.equal(tracker.getOutputTps(), 20);
});

test("estimateStreamedTokens weights CJK and ASCII differently", () => {
	assert.equal(estimateStreamedTokens(""), 0);
	assert.equal(estimateStreamedTokens("你好世界"), 4);
	assert.equal(estimateStreamedTokens("hello"), 1.25);
	// Mixed content: 2 CJK code points (2) + 12 ASCII code points (3).
	assert.equal(estimateStreamedTokens("你好hello world!"), 5);
});

test("working output tokens count the in-flight message while streaming", () => {
	const tracker = new TurnTelemetryTracker(() => 0);
	const message = makeMessage(2, 50); // message_start reports a tiny initial output count
	startTurn(tracker, message);
	assert.equal(tracker.getRunOutputTokens(), 2);

	// Deltas without provider usage: estimate takes over (4 CJK tokens > 2).
	tracker.handle(update(message, { type: "thinking_delta", contentIndex: 0, delta: "你好世界", partial: message }));
	assert.equal(tracker.getRunOutputTokens(), 4);

	// More deltas accumulate onto the estimate (4 + floor(3) = 7).
	tracker.handle(update(message, { type: "text_delta", contentIndex: 0, delta: "hello world!", partial: message }));
	assert.equal(tracker.getRunOutputTokens(), 7);

	// Providers that stream cumulative usage win over the estimate.
	const cumulative = makeMessage(40, 50);
	tracker.handle(update(cumulative, { type: "text_delta", contentIndex: 0, delta: "x", partial: cumulative }));
	assert.equal(tracker.getRunOutputTokens(), 40);

	// Completing the message snaps the counter to exact usage.
	const final = makeMessage(23, 50);
	tracker.handle({ type: "message_end", message: final });
	assert.equal(tracker.getRunOutputTokens(), 23);
});

test("working output tokens sum completed messages plus the streaming one", () => {
	const tracker = new TurnTelemetryTracker(() => 0);
	const first = makeMessage(20, 50);
	startTurn(tracker, first);
	tracker.handle({ type: "message_end", message: first });

	const second = makeMessage(1, 50);
	tracker.handle({ type: "message_start", message: second });
	tracker.handle(update(second, { type: "text_delta", contentIndex: 0, delta: "你好世界哈", partial: second }));
	assert.equal(tracker.getRunOutputTokens(), 25);
});

test("working output tokens survive turn boundaries within an agent run", () => {
	const tracker = new TurnTelemetryTracker(() => 0);
	tracker.handle({ type: "agent_start" });

	// Turn 1: 20 output tokens, then the assistant ends with a tool call.
	const first = makeMessage(20, 50);
	startTurn(tracker, first);
	tracker.handle(update(first));
	endTurn(tracker, first);

	// A tool executing between turns must not zero the run counter (#11).
	tracker.handle({ type: "tool_execution_start", toolCallId: "t1", toolName: "bash", args: {} });
	assert.equal(tracker.getRunOutputTokens(), 20);

	// Turn 2: the new message adds on top instead of restarting from 0.
	const second = makeMessage(1, 50);
	startTurn(tracker, second, 1);
	tracker.handle(update(second, { type: "text_delta", contentIndex: 0, delta: "你好世界哈", partial: second }));
	assert.equal(tracker.getRunOutputTokens(), 25);

	// The run settles; the next agent run starts from a clean slate.
	const settled = makeMessage(5, 50);
	endTurn(tracker, settled, 1);
	tracker.handle({ type: "agent_settled" });
	tracker.handle({ type: "agent_start" });
	assert.equal(tracker.getRunOutputTokens(), 0);
});

test("asterisk-tui notifies once after a complete agent run", () => {
	const handlers = new Map<string, Array<(event: any, ctx: ExtensionContext) => void>>();
	const notifications: string[] = [];
	const persisted: Array<{ customType: string; data: unknown }> = [];
	const renderers = new Map<string, (entry: any, options: any, theme: any) => unknown>();
	const pi = {
		on(event: string, handler: (event: any, ctx: ExtensionContext) => void) {
			handlers.set(event, [...(handlers.get(event) ?? []), handler]);
		},
		registerCommand() {},
		registerEntryRenderer(customType: string, renderer: never) {
			renderers.set(customType, renderer as unknown as (entry: any, options: any, theme: any) => unknown);
		},
		getThinkingLevel: () => "off",
	} as unknown as ExtensionAPI;
	const ctx = {
		hasUI: true,
		mode: "tui",
		ui: { theme, notify: (message: string) => notifications.push(message) },
		sessionManager: {
			appendCustomEntry: (customType: string, data: unknown) => {
				persisted.push({ customType, data });
				return "tel-1";
			},
		},
	} as unknown as ExtensionContext;
	const emit = (event: string, payload: unknown) => {
		for (const handler of handlers.get(event) ?? []) handler(payload, ctx);
	};
	const message = makeMessage();

	openTui(pi);
	emit("agent_start", { type: "agent_start" });
	emit("turn_start", { type: "turn_start", turnIndex: 0, timestamp: Date.now() });
	emit("message_start", { type: "message_start", message });
	emit("message_update", update(message));
	emit("message_end", { type: "message_end", message });
	emit("turn_end", { type: "turn_end", turnIndex: 0, message, toolResults: [], messageEntryId: "m1", toolResultEntryIds: [], ...BOUNDARY_FIXTURE });

	assert.equal(notifications.length, 0);
	emit("agent_settled", { type: "agent_settled" });
	// persist on (default): the entry replaces the transient notify — it renders
	// as a transcript line via the registered entry renderer instead
	assert.equal(notifications.length, 0);
	assert.equal(persisted.length, 1);
	assert.equal(persisted[0]!.customType, "asterisk.telemetry");
	const renderer = renderers.get("asterisk.telemetry");
	assert.ok(renderer, "entry renderer registered");
	const component = renderer({ type: "custom", customType: "asterisk.telemetry", data: persisted[0]!.data }, { expanded: false }, theme) as
		{ render(width: number): string[] } | undefined;
	assert.ok(component, "renderer returns a component for valid data");
	assert.match(component!.render(120).join("\n"), /TPS .*TTFT/);
	// garbage payloads render nothing (the transcript skips the entry silently)
	const bad = renderer({ type: "custom", customType: "asterisk.telemetry", data: { ttftMs: "x" } }, { expanded: false }, theme);
	assert.equal(bad, undefined);
});

test("turn summary tracks thinking time and tool counts across a run", () => {
	let now = 0;
	const tracker = new TurnTelemetryTracker(() => now);
	tracker.handle({ type: "agent_start" });

	// Turn 1: think for 3s (1s -> 4s), then text; one bash + one read.
	now = 1_000;
	const message = makeMessage(20, 50);
	startTurn(tracker, message);
	now = 2_000;
	tracker.handle(update(message, { type: "thinking_delta", contentIndex: 0, delta: "嗯", partial: message }));
	now = 4_000;
	tracker.handle(update(message, { type: "text_delta", contentIndex: 0, delta: "hello", partial: message }));
	tracker.handle({ type: "tool_execution_start", toolCallId: "a", toolName: "bash", args: {} });
	tracker.handle({ type: "tool_execution_start", toolCallId: "b", toolName: "read", args: {} });
	assert.equal(tracker.getLiveToolCalls(), 2);
	now = 5_000;
	tracker.handle({ type: "message_end", message });
	tracker.handle({ type: "turn_end", turnIndex: 0, message, toolResults: [], messageEntryId: "m1", toolResultEntryIds: [], ...BOUNDARY_FIXTURE });

	const live = tracker.getLastTurnSummary()!;
	assert.equal(live.thinkingMs, 3_000);
	assert.equal(live.toolCalls, 2);
	assert.equal(live.bashCalls, 1);

	// Turn 2: no thinking, one more bash.
	now = 6_000;
	const second = makeMessage(10, 50);
	startTurn(tracker, second, 1);
	tracker.handle({ type: "tool_execution_start", toolCallId: "c", toolName: "bash", args: {} });
	now = 7_000;
	endTurn(tracker, second, 1);

	tracker.handle({ type: "agent_settled" });
	const summary = tracker.getLastTurnSummary()!;
	assert.equal(summary.thinkingMs, 3_000);
	assert.equal(summary.toolCalls, 3);
	assert.equal(summary.bashCalls, 2);
	assert.equal(summary.toolCounts.get("read"), 1);

	// Live counter resets when the next run starts.
	tracker.handle({ type: "agent_start" });
	assert.equal(tracker.getLiveToolCalls(), 0);
});

test("loadLastTelemetryEntry replays the newest valid persisted run", () => {
	const run = (over: Record<string, unknown>) => ({
		type: "custom",
		customType: TELEMETRY_ENTRY_TYPE,
		data: {
			tps: 47.8, ttftMs: 5100, toolCalls: 2, totalMs: 1_241_000, inputTokens: 135_000, outputTokens: 52_000,
			cacheReadTokens: 3_600_000, stallMs: 8600, stallCount: 4, rateUsdPerMTokens: 0.36,
			generationMs: 900_000, totalTokens: 3_787_000, cacheHitRate: 96.4, costUsd: 0.36,
			measurementMs: 900_000,
			...over,
		},
	});
	// newest valid entry wins
	const newest = run({ outputTokens: 99 });
	assert.equal(loadLastTelemetryEntry([run({}), newest])?.outputTokens, 99);
	// empty branch, foreign custom entries, and malformed payloads are skipped
	assert.equal(loadLastTelemetryEntry([]), undefined);
	assert.equal(loadLastTelemetryEntry([{ type: "custom", customType: "pi.share", data: {} }]), undefined);
	assert.equal(loadLastTelemetryEntry([run({ ttftMs: "corrupted" })]), undefined);
	assert.equal(loadLastTelemetryEntry([run({ totalMs: Number.NaN })]), undefined);
	// invalid entries do not shadow an older valid one
	assert.equal(loadLastTelemetryEntry([run({ outputTokens: 7 }), run({ costUsd: null })])?.outputTokens, 7);
});

test("run metrics accumulate input, cache and generation across messages", () => {
	let now = 0;
	const tracker = new TurnTelemetryTracker(() => now);
	tracker.handle({ type: "agent_start" });

	const first = makeMessage(20, 50, 10, 1_000);
	startTurn(tracker, first);
	now = 100;
	tracker.handle(update(first));
	now = 2_100;
	endTurn(tracker, first);
	assert.equal(tracker.getRunInputTokens(), 50 + 10 + 1_000);
	assert.equal(tracker.getRunCacheReadTokens(), 1_000);
	assert.equal(tracker.getRunCacheHitRate(), 94.3);
	assert.equal(tracker.getRunGenerationMs(), 2_000);

	const second = makeMessage(30, 5, 0, 0);
	startTurn(tracker, second, 1);
	now = 2_150;
	tracker.handle(update(second));
	now = 3_150;
	endTurn(tracker, second, 1);
	assert.equal(tracker.getRunInputTokens(), 1_065);
	assert.equal(tracker.getRunGenerationMs(), 3_000);
	// run-average speed (footer): 50 tokens over the summed 3s of streaming
	assert.equal(tracker.getRunTps(), 16.7);
	// per-message speed (working displays): the latest message alone
	assert.equal(tracker.getOutputTps(), 30);

	// a fresh run resets the accumulators
	tracker.handle({ type: "agent_settled" });
	tracker.handle({ type: "agent_start" });
	assert.equal(tracker.getRunInputTokens(), 0);
	assert.equal(tracker.getRunGenerationMs(), 0);
	assert.equal(tracker.getRunTps(), null);
});

test("working line and border compose from config toggles", () => {
	const glyphs = resolveGlyphs("ascii");
	const source = {
		elapsedText: "2m 3s",
		runTps: 12.5 as number | null,
		runInputTokens: 3_400_000,
		runCacheReadTokens: 3_300_000,
		runOutputTokens: 5_300,
		runCacheHitRate: 96.4 as number | null,
		runCostUsd: 0.42,
		toolCount: 3,
	};
	assert.equal(
		formatWorkingLineMessage(
			{ elapsed: true, input: "cache", output: true, cacheHit: true, cost: "cost", speed: true, tools: true },
			source,
			glyphs,
		),
		"Working\u2026 (o 2m 3s \u00b7 > 12.5 tok/s \u00b7 \u2191 3.4M (R 3.3M) \u00b7 \u2193 5.3k \u00b7 c 96.4% \u00b7 t 3 \u00b7 $ $0.42)",
	);
	// cost+rate appends the blended run rate (run cost over run tokens)
	assert.equal(
		formatWorkingLineMessage(
			{ elapsed: false, input: "off", output: false, cacheHit: false, cost: "cost+rate", speed: false, tools: false },
			source,
			glyphs,
		),
		"Working\u2026 ($ $0.42 \u00b7 $0.12/M)",
	);
	assert.equal(
		formatWorkingBorderText(
			{ elapsed: false, speed: true, output: false, input: "total", cacheHit: false, cost: "off", tools: true },
			source,
			glyphs,
		),
		"> 12.5 tok/s \u00b7 \u2191 3.4M \u00b7 t 3",
	);
	// everything off (or speed not yet credible) still shows the elapsed time
	assert.equal(
		formatWorkingBorderText(
			{ elapsed: false, speed: true, output: false, input: "off", cacheHit: false, cost: "off", tools: false },
			{ ...source, runTps: null },
			glyphs,
		),
		"o 2m 3s",
	);
});

test("run response-time speed and session-average speed track their own scopes", () => {
	let now = 0;
	const tracker = new TurnTelemetryTracker(() => now);
	tracker.handle({ type: "agent_start" }); // submitted at t=0

	// no speed before any token exists or before a 1s window
	const message = makeMessage(0, 50);
	startTurn(tracker, message);
	now = 500;
	assert.equal(tracker.getRunActiveTps(), null);

	// first streamed output at t=0.1s (opens the session streaming window)
	now = 100;
	tracker.handle(update(message, { type: "text_delta", contentIndex: 0, delta: "x".repeat(40), partial: message }));

	// 100 exact tokens by t=2.1s: wall speed = 100/2.1 (includes TTFT)
	const done = makeMessage(100, 50);
	now = 2_100;
	tracker.handle({ type: "message_end", message: done });
	assert.equal(tracker.getRunActiveTps(), 47.6);

	// a tool runs until t=4.2s: the wall average decays, tokens unchanged
	now = 4_200;
	assert.equal(tracker.getRunActiveTps(), 23.8);

	// session average uses streaming windows only, so it stays higher
	assert.ok(tracker.getSessionTps()! > tracker.getRunActiveTps()!);
	tracker.handle({ type: "agent_settled" });
	tracker.handle({ type: "agent_start" });
	assert.equal(tracker.getRunActiveTps(), null); // fresh run: no tokens yet
	assert.ok(tracker.getSessionTps()! > 0, "session average survives run boundaries");
});

test("tool-execution time is excluded from elapsed and run speed", () => {
	let now = 0;
	const tracker = new TurnTelemetryTracker(() => now);
	tracker.handle({ type: "agent_start" });

	// 100 tokens stream between t=1s and t=2.1s
	const message = makeMessage(0, 50);
	startTurn(tracker, message);
	now = 1_000;
	tracker.handle(update(message, { type: "text_delta", contentIndex: 0, delta: "x".repeat(40), partial: message }));
	const done = makeMessage(100, 50);
	now = 2_100;
	tracker.handle({ type: "message_end", message: done });
	assert.equal(tracker.getRunActiveTps(), 47.6);

	// a tool runs t=2.1s→4.2s: busy while running, accumulated after the end
	tracker.handle({ type: "tool_execution_start", toolCallId: "t1", toolName: "bash", args: {} });
	now = 4_200;
	assert.equal(tracker.getToolBusyMs(), 2_100);
	tracker.handle({ type: "tool_execution_end", toolCallId: "t1", toolName: "bash", result: {}, durationMs: 2_100 } as never);
	assert.equal(tracker.getToolBusyMs(), 2_100);
	// speed no longer decays during tool waits: same tokens, response time 2.1s
	assert.equal(tracker.getRunActiveTps(), 47.6);

	// fresh run resets the tool windows
	tracker.handle({ type: "agent_settled" });
	tracker.handle({ type: "agent_start" });
	assert.equal(tracker.getToolBusyMs(), 0);
});

test("working surfaces hide zero token segments", () => {
	const glyphs = resolveGlyphs("ascii");
	const source = {
		elapsedText: "5s",
		runTps: null as number | null,
		runInputTokens: 0,
		runCacheReadTokens: 0,
		runOutputTokens: 0,
		runCacheHitRate: null as number | null,
		runCostUsd: 0,
		toolCount: 0,
	};
	assert.equal(
		formatWorkingLineMessage({ elapsed: true, input: "cache", output: true, cacheHit: true, cost: "cost+rate", speed: true, tools: true }, source, glyphs),
		"Working\u2026 (o 5s)",
	);
	assert.equal(
		formatWorkingBorderText({ elapsed: true, speed: true, output: true, input: "cache", cacheHit: true, cost: "cost+rate", tools: true }, source, glyphs),
		"o 5s",
	);
});

test("sumSessionTelemetry seeds the session speed across restarts", () => {
	const run = (out: number, gen: number) => ({
		type: "custom",
		customType: "asterisk.telemetry",
		data: { tps: 1, ttftMs: 100, totalMs: 1000, inputTokens: 10, outputTokens: out, cacheReadTokens: 0, stallMs: 0, stallCount: 0, rateUsdPerMTokens: 1, generationMs: gen, totalTokens: out + 10, cacheHitRate: null, costUsd: 0.01, measurementMs: gen },
	});
	const totals = sumSessionTelemetry([run(100, 2_000), { type: "custom", customType: "pi.share" }, run(50, 3_000), run(NaN, 1)]);
	assert.ok(totals);
	assert.equal(totals.outputTokens, 150);
	assert.equal(totals.generationMs, 5_000);
	assert.equal(sumSessionTelemetry([]), null);

	// seeded tracker reports the historical session average immediately
	const tracker = new TurnTelemetryTracker(() => 0);
	tracker.seedSessionTotals(totals.outputTokens, totals.generationMs);
	assert.equal(tracker.getSessionTps(), 30);
	// and keeps accumulating on top after a live run
	tracker.handle({ type: "agent_start" });
	const message = makeMessage(30, 5);
	startTurn(tracker, message);
	tracker.handle(update(message));
	tracker.handle({ type: "message_end", message: { ...message, usage: { ...message.usage, output: 30 } } });
	assert.equal(tracker.getSessionTps(), 36); // 180 tokens / 5s
});

test("input and cache-read light up at message start (anthropic message_start usage)", () => {
	const tracker = new TurnTelemetryTracker(() => 0);
	tracker.handle({ type: "agent_start" });
	const message = makeMessage(0, 0, 0, 0);
	// anthropic message_start carries input/cacheRead before any output
	tracker.handle({ type: "turn_start", turnIndex: 0, timestamp: Date.now() });
	tracker.handle({
		type: "message_start",
		message: { ...message, usage: { ...message.usage, input: 42_000, cacheRead: 3_600_000 } },
	});
	assert.equal(tracker.getRunInputTokens(), 42_000 + 3_600_000);
	assert.equal(tracker.getRunCacheReadTokens(), 3_600_000);
	assert.equal(tracker.getRunCacheHitRate(), 98.8);
	// usage growing mid-stream keeps the max
	tracker.handle(update({ ...message, usage: { ...message.usage, input: 50_000, cacheRead: 3_700_000 } }));
	assert.equal(tracker.getRunInputTokens(), 50_000 + 3_700_000);
});
