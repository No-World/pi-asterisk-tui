import type {
	AgentSettledEvent,
	AgentStartEvent,
	MessageEndEvent,
	MessageStartEvent,
	MessageUpdateEvent,
	ToolExecutionEndEvent,
	ToolExecutionStartEvent,
	TurnEndEvent,
	TurnStartEvent,
	Theme,
} from "@earendil-works/pi-coding-agent";
import type { IconGlyphs } from "./icons.ts";
import type { CostDisplayMode, IconMode, TelemetryConfig, WorkingBorderConfig, WorkingInputMode, WorkingLineConfig } from "./config.ts";
import { resolveGlyphs } from "./icons.ts";
import { cacheHitColor, estimateStreamedTokens, finiteOrZero, fmtTokens, formatDuration, formatInputBreakdown } from "./utils.ts";

const STALL_THRESHOLD_MS = 1000;

/**
 * Minimum wall-clock streaming window for a credible per-message speed. A
 * buffered proxy (or a one-shot tool-call block) can flush thousands of
 * tokens in a local burst, leaving a window of milliseconds — too short to
 * measure anything, and it used to inflate the HUD speed to absurd values
 * (e.g. 5449.8 tok/s).
 */
const MIN_MESSAGE_TPS_WINDOW_MS = 1000;

type TelemetryEvent =
	| AgentStartEvent
	| AgentSettledEvent
	| TurnStartEvent
	| MessageStartEvent
	| MessageUpdateEvent
	| MessageEndEvent
	| ToolExecutionStartEvent
	| ToolExecutionEndEvent
	| TurnEndEvent;
type AgentMessage = MessageStartEvent["message"];
type AssistantMessage = Extract<AgentMessage, { role: "assistant" }>;

interface MessageTiming {
	lastUpdateMs: number;
	firstOutputMs: number | null;
	inStall: boolean;
	/** Largest output-token count reported by provider usage while streaming this message. */
	liveUsageOutput: number;
	/** Largest input+cacheWrite / cacheRead reported while streaming (anthropic
	 *  message_start carries them, so the working segments light up immediately). */
	liveUsageInput: number;
	liveUsageCacheRead: number;
	/** Delta-based token estimate for providers without mid-stream usage (anthropic protocol). */
	streamedEstimate: number;
	/** perf-clock start of the message; anchors thinking-duration measurement. */
	startMs: number;
	/** Set once a thinking delta arrives for this message. */
	sawThinking: boolean;
	/** When thinking stopped (first non-thinking output); null while still thinking. */
	thinkingEndMs: number | null;
}

interface TurnTiming {
	startMs: number;
	firstTokenMs: number | null;
	currentMessage: MessageTiming | null;
	messages: AssistantMessage[];
	generationMs: number;
	stallMs: number;
	stallCount: number;
	/** Time the model spent thinking before visible output, summed over messages. */
	thinkingMs: number;
	/** Per-message thinking durations, in message order (0 for non-thinking). */
	messageThinkingMs: number[];
	/** Tool executions started during this turn, by tool name. */
	toolCounts: Map<string, number>;
}

/** Claude-style per-turn summary: thinking time plus tool usage. */
export interface TurnSummary {
	thinkingMs: number;
	toolCalls: number;
	bashCalls: number;
	toolCounts: ReadonlyMap<string, number>;
}

export interface TurnTelemetry {
	tps: number | null;
	ttftMs: number;
	/** Tool executions started during the run. */
	toolCalls: number;
	totalMs: number;
	inputTokens: number;
	outputTokens: number;
	cacheReadTokens: number;
	stallMs: number;
	stallCount: number;
	rateUsdPerMTokens: number | null;
	generationMs: number;
	totalTokens: number;
	/** Turn cache hit rate: cacheRead / (input + cacheWrite + cacheRead), null when no cache tokens. */
	cacheHitRate: number | null;
	costUsd: number;
	measurementMs: number | null;
}

function isAssistantMessage(message: AgentMessage): message is AssistantMessage {
	return message.role === "assistant";
}

function round(value: number, decimals: number): number {
	const factor = 10 ** decimals;
	return Math.round(value * factor) / factor;
}

export class TurnTelemetryTracker {
	private readonly now: () => number;
	private turn: TurnTiming | undefined;
	private agentStartMs: number | null = null;
	private agentTurns: TurnTelemetry[] = [];
	/** Output speed (tok/s) of the most recently completed assistant message. */
	private lastMessageTps: number | null = null;
	/** Tool executions started in the current agent run (live, for the working indicator). */
	private liveToolCalls = 0;
	/** Exact output tokens of completed messages in the current agent run. */
	private agentRunOutputTokens = 0;
	/** Input+cacheWrite+cacheRead of completed messages in the current run. */
	private agentRunInputTokens = 0;
	/** Cache-read tokens of completed messages in the current run. */
	private agentRunCacheReadTokens = 0;
	/** Cost (USD) of completed messages in the current run. */
	private agentRunCostUsd = 0;
	/** Streaming windows of completed messages; excludes tool time. */
	private agentRunGenerationMs = 0;
	/** Wall time spent inside tool executions this run (TTFT counts, tools don't). */
	private toolBusyAccumMs = 0;
	/** Perf-clock starts of currently executing tools (nested/parallel safe). */
	private activeToolStarts: number[] = [];
	/** Per-turn summaries collected during the current agent run. */
	private agentSummaries: TurnSummary[] = [];
	/** Merged summary of the most recently settled agent run. */
	private lastSummary: TurnSummary | undefined;
	/** Per-message thinking durations of the most recently settled agent run. */
	private lastRunThinkingMs: number[] = [];
	/** Per-message thinking durations collected during the current agent run. */
	private agentRunThinkingMs: number[] = [];
	/** Exact output tokens / streaming windows across the whole session (never reset). */
	private sessionOutputTokens = 0;
	private sessionGenerationMs = 0;

	constructor(now: () => number = () => performance.now()) {
		this.now = now;
	}

	getOutputTps(): number | null {
		return this.lastMessageTps;
	}

	/** Tool executions started so far in the current agent run. */
	getLiveToolCalls(): number {
		return this.liveToolCalls;
	}

	/** Summary of the most recently settled agent run, or the live run while it streams. */
	getLastTurnSummary(): TurnSummary | undefined {
		if (this.agentSummaries.length > 0) {
			return mergeSummaries(this.agentSummaries);
		}
		return this.lastSummary;
	}

	/**
	 * Output tokens accumulated so far in the current agent run: completed
	 * messages contribute exact usage (summed across turns, so a tool executing
	 * between turns never zeroes the counter — #11); the in-flight message uses
	 * provider-reported usage when available and a delta-based estimate
	 * otherwise (anthropic-protocol backends only send usage with the final
	 * message_delta, so without this the counter sits at 0 for the whole
	 * stream).
	 */
	getRunOutputTokens(): number {
		const current = this.turn?.currentMessage;
		const inFlight = current
			? Math.max(current.liveUsageOutput, Math.floor(current.streamedEstimate))
			: 0;
		return this.agentRunOutputTokens + inFlight;
	}
	/** Input+cacheWrite+cacheRead of the current run: completed messages plus
	 *  the in-flight one's provider-reported usage (message_start on the
	 *  anthropic protocol carries input/cacheRead, so the segments appear at
	 *  message start instead of waiting for its end). */
	getRunInputTokens(): number {
		const current = this.turn?.currentMessage;
		const live = current ? current.liveUsageInput + current.liveUsageCacheRead : 0;
		return this.agentRunInputTokens + live;
	}

	getRunCacheReadTokens(): number {
		const current = this.turn?.currentMessage;
		return this.agentRunCacheReadTokens + (current?.liveUsageCacheRead ?? 0);
	}

	/** Run-cumulative cost of completed messages, in USD. */
	getRunCostUsd(): number {
		return this.agentRunCostUsd;
	}

	/** Completed streaming windows plus the in-flight one; excludes tool time. */
	getRunGenerationMs(): number {
		const current = this.turn?.currentMessage;
		const live = current?.firstOutputMs != null ? Math.max(0, this.now() - current.firstOutputMs) : 0;
		return this.agentRunGenerationMs + live;
	}

	/** Run cache hit rate (completed + in-flight usage); null without cache tokens. */
	getRunCacheHitRate(): number | null {
		const input = this.getRunInputTokens();
		const cacheRead = this.getRunCacheReadTokens();
		return cacheRead > 0 && input > 0 ? round((cacheRead / input) * 100, 1) : null;
	}

	/** Wall time currently attributable to tool executions: finished windows
	 *  plus the in-flight ones. Excluded from the working displays' elapsed
	 *  time — TTFT counts as response time, tool waits do not. */
	getToolBusyMs(): number {
		const now = this.now();
		const live = this.activeToolStarts.reduce((sum, start) => sum + Math.max(0, now - start), 0);
		return this.toolBusyAccumMs + live;
	}

	/** Run-average speed over response time: run tokens over wall-clock
	 *  elapsed since submission minus tool-execution time — the same elapsed
	 *  shown beside it on the working surfaces, so tokens/elapsed reconciles
	 *  by eye. */
	getRunActiveTps(): number | null {
		if (this.agentStartMs === null) return null;
		const ms = this.now() - this.agentStartMs - this.getToolBusyMs();
		const tokens = this.getRunOutputTokens();
		if (tokens <= 0 || ms < 1_000) return null;
		return round(tokens / (ms / 1000), 1);
	}

	/** Seeds the session totals from persisted run telemetry on resume, so the
	 *  session-average speed is continuous across restarts. */
	seedSessionTotals(outputTokens: number, generationMs: number): void {
		this.sessionOutputTokens = outputTokens;
		this.sessionGenerationMs = generationMs;
	}

	/** Session-average output speed: every message this session over its
	 *  summed streaming windows, including the in-flight one. The HUD footer's
	 *  speed segment shows this; the working surfaces are per-message. */
	getSessionTps(): number | null {
		const current = this.turn?.currentMessage;
		const liveOut = current ? Math.max(current.liveUsageOutput, Math.floor(current.streamedEstimate)) : 0;
		const liveMs = current?.firstOutputMs != null ? Math.max(0, this.now() - current.firstOutputMs) : 0;
		const tokens = this.sessionOutputTokens + liveOut;
		const ms = this.sessionGenerationMs + liveMs;
		if (tokens <= 0 || ms < MIN_MESSAGE_TPS_WINDOW_MS) return null;
		return round(tokens / (ms / 1000), 1);
	}

	getRunTps(): number | null {
		const genMs = this.getRunGenerationMs();
		if (genMs < MIN_MESSAGE_TPS_WINDOW_MS) return null;
		return round(this.getRunOutputTokens() / (genMs / 1000), 1);
	}


	handle(event: TelemetryEvent): TurnTelemetry | undefined {
		switch (event.type) {
			case "agent_start":
				if (this.agentStartMs === null) {
					this.agentStartMs = this.now();
					this.agentTurns = [];
					this.liveToolCalls = 0;
					this.agentRunOutputTokens = 0;
				this.agentRunInputTokens = 0;
				this.agentRunCacheReadTokens = 0;
				this.agentRunGenerationMs = 0;
				// stale speeds from the previous run must not leak into the new one
				this.lastMessageTps = null;
				this.agentRunCostUsd = 0;
				this.toolBusyAccumMs = 0;
				this.activeToolStarts = [];
					this.agentSummaries = [];
					this.agentRunThinkingMs = [];
				}
				return;
			case "agent_settled":
				return this.endAgent();
			case "turn_start":
				this.startTurn();
				return;
			case "message_start":
				this.startMessage(event.message);
				return;
			case "message_update":
				this.updateMessage(event);
				return;
			case "message_end":
				this.endMessage(event.message);
				return;
			case "tool_execution_start":
				this.liveToolCalls++;
				this.activeToolStarts.push(this.now());
				if (this.turn) {
					this.turn.toolCounts.set(event.toolName, (this.turn.toolCounts.get(event.toolName) ?? 0) + 1);
				}
				return;
			case "tool_execution_end": {
				const started = this.activeToolStarts.shift();
				if (started !== undefined) this.toolBusyAccumMs += Math.max(0, this.now() - started);
				return;
			}
			case "turn_end":
				return this.endTurnAndCollect();
		}
	}

	private startTurn(): void {
		this.turn = {
			startMs: this.now(),
			firstTokenMs: null,
			currentMessage: null,
			messages: [],
			generationMs: 0,
			stallMs: 0,
			stallCount: 0,
			thinkingMs: 0,
			messageThinkingMs: [],
			toolCounts: new Map(),
		};
	}

	private startMessage(message: AgentMessage): void {
		if (!this.turn || !isAssistantMessage(message)) return;
		const now = this.now();
		this.turn.currentMessage = {
			lastUpdateMs: now,
			firstOutputMs: null,
			inStall: false,
			liveUsageOutput: finiteOrZero(message.usage?.output),
			liveUsageInput: finiteOrZero(message.usage?.input) + finiteOrZero(message.usage?.cacheWrite),
			liveUsageCacheRead: finiteOrZero(message.usage?.cacheRead),
			streamedEstimate: 0,
			startMs: now,
			sawThinking: false,
			thinkingEndMs: null,
		};
	}

	private updateMessage(event: MessageUpdateEvent): void {
		const turn = this.turn;
		const current = turn?.currentMessage;
		const message = event.message;
		if (!turn || !current || !isAssistantMessage(message)) return;

		// Providers that report cumulative usage mid-stream update the partial
		// message in place; keep the largest value seen for the live counter.
		const reportedOutput = finiteOrZero(message.usage?.output);
		if (reportedOutput > current.liveUsageOutput) {
			current.liveUsageOutput = reportedOutput;
		}
		const reportedInput = finiteOrZero(message.usage?.input) + finiteOrZero(message.usage?.cacheWrite);
		if (reportedInput > current.liveUsageInput) {
			current.liveUsageInput = reportedInput;
		}
		const reportedCacheRead = finiteOrZero(message.usage?.cacheRead);
		if (reportedCacheRead > current.liveUsageCacheRead) {
			current.liveUsageCacheRead = reportedCacheRead;
		}

		const streamEvent = event.assistantMessageEvent;
		if (
			streamEvent.type !== "text_delta" &&
			streamEvent.type !== "thinking_delta" &&
			streamEvent.type !== "toolcall_delta"
		) return;
		if (streamEvent.delta.length === 0) return;
		current.streamedEstimate += estimateStreamedTokens(streamEvent.delta);

		const now = this.now();
		if (streamEvent.type === "thinking_delta") {
			current.sawThinking = true;
		} else if (current.sawThinking && current.thinkingEndMs === null) {
			// First visible output after thinking closes the thinking window.
			current.thinkingEndMs = now;
		}
		if (current.firstOutputMs === null) {
			current.firstOutputMs = now;
			turn.firstTokenMs ??= now;
			current.lastUpdateMs = now;
			return;
		}

		const gap = now - current.lastUpdateMs;
		if (gap >= STALL_THRESHOLD_MS) {
			if (!current.inStall) turn.stallCount++;
			current.inStall = true;
			turn.stallMs += gap;
		} else {
			current.inStall = false;
		}
		current.lastUpdateMs = now;
	}

	private endMessage(message: AgentMessage): void {
		const turn = this.turn;
		if (!turn || !isAssistantMessage(message)) return;

		const current = turn.currentMessage;
		if (current) {
			const endMs = this.now();
			turn.generationMs = endMs - turn.startMs;
			if (current.firstOutputMs === null && finiteOrZero(message.usage?.output) > 0) {
				turn.firstTokenMs ??= endMs;
			}
			// per-message output speed: tokens / streaming duration. Windows below
			// MIN_MESSAGE_TPS_WINDOW_MS are burst artifacts, not generation time;
			// keep the last credible speed instead of publishing garbage.
			const out = finiteOrZero(message.usage?.output);
			const firstOutput = current.firstOutputMs;
			const genMs = firstOutput !== null ? endMs - firstOutput : 0;
			if (out > 0 && firstOutput !== null && genMs >= MIN_MESSAGE_TPS_WINDOW_MS) {
				this.lastMessageTps = round(out / (genMs / 1000), 1);
			}
			this.agentRunGenerationMs += genMs;
			this.sessionGenerationMs += genMs;
			if (current.sawThinking) {
				const messageThinkingMs = Math.max(0, (current.thinkingEndMs ?? endMs) - current.startMs);
				turn.thinkingMs += messageThinkingMs;
				turn.messageThinkingMs.push(messageThinkingMs);
			} else {
				turn.messageThinkingMs.push(0);
			}
			turn.currentMessage = null;
		}
		if (!current) turn.messageThinkingMs.push(0);
		this.agentRunOutputTokens += finiteOrZero(message.usage?.output);
		this.sessionOutputTokens += finiteOrZero(message.usage?.output);
		this.agentRunInputTokens +=
			finiteOrZero(message.usage?.input) +
			finiteOrZero(message.usage?.cacheWrite) +
			finiteOrZero(message.usage?.cacheRead);
		this.agentRunCacheReadTokens += finiteOrZero(message.usage?.cacheRead);
		this.agentRunCostUsd += finiteOrZero(message.usage?.cost?.total);
		turn.messages.push(message);
	}

	/** Per-message thinking durations of the last settled agent run, in message order. */
	getLastRunThinkingDurations(): number[] {
		return this.lastRunThinkingMs;
	}

	private endTurnAndCollect(): TurnTelemetry | undefined {
		const telemetry = this.endTurn();
		if (telemetry && this.agentStartMs !== null) this.agentTurns.push(telemetry);
		return telemetry;
	}

	private collectThinkingDurations(turn: TurnTiming): void {
		if (this.agentStartMs === null) return;
		this.agentRunThinkingMs.push(...turn.messageThinkingMs);
	}

	private collectTurnSummary(turn: TurnTiming): void {
		if (this.agentStartMs === null) return;
		this.agentSummaries.push({
			thinkingMs: turn.thinkingMs,
			toolCalls: sumMapValues(turn.toolCounts),
			bashCalls: turn.toolCounts.get("bash") ?? 0,
			toolCounts: new Map(turn.toolCounts),
		});
	}

	private endTurn(): TurnTelemetry | undefined {
		const turn = this.turn;
		this.turn = undefined;
		if (!turn) return;
		this.collectTurnSummary(turn);
		this.collectThinkingDurations(turn);
		if (turn.firstTokenMs === null || turn.messages.length === 0) return;

		const endMs = this.now();
		let inputTokens = 0;
		let outputTokens = 0;
		let cacheReadTokens = 0;
		let totalTokens = 0;
		let costUsd = 0;
		for (const message of turn.messages) {
			// match /session's "uncached" total: cacheWrite is fresh, near-full-price
			// content; only cacheRead is discounted repeat content.
			inputTokens += finiteOrZero(message.usage?.input) + finiteOrZero(message.usage?.cacheWrite);
			outputTokens += finiteOrZero(message.usage?.output);
			cacheReadTokens += finiteOrZero(message.usage?.cacheRead);
			totalTokens += finiteOrZero(message.usage?.totalTokens);
			costUsd += finiteOrZero(message.usage?.cost?.total);
		}

		const measurementMs = outputTokens > 0 && turn.generationMs > 0 ? turn.generationMs : null;
		const tps = measurementMs === null
			? null
			: round(outputTokens / (measurementMs / 1000), 1);
		const validCost = Number.isFinite(costUsd) && costUsd > 0;
		const validTokens = Number.isFinite(totalTokens) && totalTokens > 0;
		return {
			tps,
			ttftMs: turn.firstTokenMs - turn.startMs,
			toolCalls: sumMapValues(turn.toolCounts),
			totalMs: endMs - turn.startMs,
			inputTokens,
			outputTokens,
			cacheReadTokens,
			stallMs: turn.stallMs,
			stallCount: turn.stallCount,
			rateUsdPerMTokens: validCost && validTokens
				? round(costUsd / (totalTokens / 1_000_000), 2)
				: null,
			generationMs: turn.generationMs,
			totalTokens,
			cacheHitRate:
				cacheReadTokens > 0
					? round((cacheReadTokens / (inputTokens + cacheReadTokens)) * 100, 1)
					: null,
			costUsd: validCost ? costUsd : 0,
			measurementMs,
		};
	}

	private endAgent(): TurnTelemetry | undefined {
		const startMs = this.agentStartMs;
		const turns = this.agentTurns;
		this.lastRunThinkingMs = this.agentRunThinkingMs;

		this.agentStartMs = null;
		this.agentTurns = [];
		if (this.agentSummaries.length > 0) {
			this.lastSummary = mergeSummaries(this.agentSummaries);
			this.agentSummaries = [];
		}
		if (startMs === null || turns.length === 0) return;

		const outputTokens = turns.reduce((sum, turn) => sum + turn.outputTokens, 0);
		const inputTokens = turns.reduce((sum, turn) => sum + turn.inputTokens, 0);
		const cacheReadTokens = turns.reduce((sum, turn) => sum + turn.cacheReadTokens, 0);
		const totalTokens = turns.reduce((sum, turn) => sum + turn.totalTokens, 0);
		const costUsd = turns.reduce((sum, turn) => sum + turn.costUsd, 0);
		const stallMs = turns.reduce((sum, turn) => sum + turn.stallMs, 0);
		const stallCount = turns.reduce((sum, turn) => sum + turn.stallCount, 0);
		const generationMs = turns.reduce((sum, turn) => sum + turn.generationMs, 0);
		const measurementMs = outputTokens > 0 && generationMs > 0 ? generationMs : null;
		const tps = measurementMs === null
			? null
			: round(outputTokens / (measurementMs / 1000), 1);
		const validRate = costUsd > 0 && totalTokens > 0;
		const cacheHitRate =
			cacheReadTokens > 0
				? round((cacheReadTokens / (inputTokens + cacheReadTokens)) * 100, 1)
				: null;
		return {
			tps,
			ttftMs: turns[0]!.ttftMs,
			toolCalls: turns.reduce((sum, turn) => sum + turn.toolCalls, 0),
			totalMs: this.now() - startMs,
			inputTokens,
			outputTokens,
			cacheReadTokens,
			stallMs,
			stallCount,
			rateUsdPerMTokens: validRate ? round(costUsd / (totalTokens / 1_000_000), 2) : null,
			cacheHitRate,
			generationMs,
			totalTokens,
			costUsd,
			measurementMs,
		};
	}
}

function sumMapValues(map: ReadonlyMap<string, number>): number {
	let sum = 0;
	for (const count of map.values()) sum += count;
	return sum;
}

function mergeSummaries(summaries: TurnSummary[]): TurnSummary {
	const toolCounts = new Map<string, number>();
	let thinkingMs = 0;
	for (const summary of summaries) {
		thinkingMs += summary.thinkingMs;
		for (const [name, count] of summary.toolCounts) {
			toolCounts.set(name, (toolCounts.get(name) ?? 0) + count);
		}
	}
	return {
		thinkingMs,
		toolCalls: sumMapValues(toolCounts),
		bashCalls: toolCounts.get("bash") ?? 0,
		toolCounts,
	};
}

function formatTurnDuration(ms: number): string {
	return ms < 60_000 ? `${(ms / 1000).toFixed(1)}s` : formatDuration(ms);
}

/** Session-file custom entry type carrying one run's telemetry. Custom entries
 *  are extension-owned transcript data: never sent to the LLM, not rendered by
 *  the stock TUI, and pruned with their branch on rewind. */
export const TELEMETRY_ENTRY_TYPE = "asterisk.telemetry";

const isFiniteNumber = (value: unknown): value is number =>
	typeof value === "number" && Number.isFinite(value);

/** Most recent persisted telemetry on a session branch, defensively validated;
 *  foreign custom entries and malformed payloads are skipped silently. */
export function loadLastTelemetryEntry(entries: Iterable<unknown>): TurnTelemetry | undefined {
	let last: TurnTelemetry | undefined;
	for (const raw of entries) {
		const entry = raw as { type?: unknown; customType?: unknown; data?: unknown } | null;
		if (!entry || entry.type !== "custom" || entry.customType !== TELEMETRY_ENTRY_TYPE) continue;
		const data = entry.data as Record<string, unknown> | undefined;
		if (
			!data || !isFiniteNumber(data.ttftMs) || !isFiniteNumber(data.totalMs) ||
			!isFiniteNumber(data.outputTokens) || !isFiniteNumber(data.stallCount) || !isFiniteNumber(data.costUsd)
		) continue;
		last = data as unknown as TurnTelemetry;
	}
	return last;
}

/** Sums output tokens and streaming windows over every persisted telemetry
 *  entry on a branch — the resume seed for the session-average speed. */
export function sumSessionTelemetry(entries: Iterable<unknown>): { outputTokens: number; generationMs: number } | null {
	let outputTokens = 0;
	let generationMs = 0;
	let seen = false;
	for (const raw of entries) {
		const entry = raw as { type?: unknown; customType?: unknown; data?: unknown } | null;
		if (!entry || entry.type !== "custom" || entry.customType !== TELEMETRY_ENTRY_TYPE) continue;
		const data = entry.data as Record<string, unknown> | undefined;
		if (
			!data || !isFiniteNumber(data.outputTokens) || !isFiniteNumber(data.generationMs) ||
			!isFiniteNumber(data.ttftMs) || !isFiniteNumber(data.totalMs)
		) continue;
		outputTokens += data.outputTokens;
		generationMs += data.generationMs;
		seen = true;
	}
	return seen ? { outputTokens, generationMs } : null;
}

/** Append one run's telemetry to the session file. Prefers the official
 *  pi.appendEntry (emits entry_appended, so the TUI renders the line live);
 *  the ReadonlySessionManager cast stays only as a fallback for pi versions
 *  without appendEntry — it bypasses the event, leaving restore-only
 *  rendering, and a future restricted proxy degrades it to a no-op. */
export function persistTurnTelemetry(
	pi: { appendEntry?: (customType: string, data?: unknown) => void },
	sessionManager: object | undefined,
	telemetry: TurnTelemetry,
): void {
	if (typeof pi.appendEntry === "function") {
		try {
			pi.appendEntry(TELEMETRY_ENTRY_TYPE, telemetry);
			return;
		} catch {
			// fall through to the legacy cast below
		}
	}
	if (!sessionManager || typeof sessionManager !== "object") return;
	const sm = sessionManager as {
		appendCustomEntry?: (customType: string, data?: unknown) => string;
	};
	try {
		sm.appendCustomEntry?.(TELEMETRY_ENTRY_TYPE, telemetry);
	} catch {
		// best-effort: non-persisted sessions reject the append
	}
}

export function formatTurnTelemetry(
	telemetry: TurnTelemetry,
	theme: Theme,
	config: TelemetryConfig,
	iconMode: IconMode,
): string {
	const glyphs = resolveGlyphs(iconMode);
	const parts: string[] = [];
	if (config.tps) {
		const value = telemetry.tps === null ? "—" : `${telemetry.tps.toFixed(1)} tok/s`;
		parts.push(theme.fg(telemetry.tps === null ? "muted" : "accent", `${glyphs.speed} TPS ${value}`));
	}
	if (config.ttft) {
		parts.push(theme.fg("text", `${glyphs.latency} TTFT ${formatTurnDuration(telemetry.ttftMs)}`));
	}
	if (config.duration) {
		parts.push(theme.fg("success", `${glyphs.done} ${formatTurnDuration(telemetry.totalMs)}`));
	}
	if (config.tools) {
		const toolCalls = finiteOrZero(telemetry.toolCalls);
		if (toolCalls > 0) parts.push(theme.fg("text", `${glyphs.tools} ${toolCalls}`));
	}
	if (config.tokens) {
		parts.push(theme.fg("accent", `${glyphs.input} ${formatInputBreakdown(telemetry.inputTokens, telemetry.cacheReadTokens)}`));
		parts.push(theme.fg("success", `${glyphs.output} ${fmtTokens(telemetry.outputTokens)}`));
		if (telemetry.cacheHitRate !== null) {
			parts.push(
				theme.fg(cacheHitColor(telemetry.cacheHitRate), `${glyphs.cacheHit} ${telemetry.cacheHitRate.toFixed(1)}%`),
			);
		}
	}
	if (config.stalls && telemetry.stallMs > 0) {
		parts.push(theme.fg("warning", `${glyphs.stall} stall ${telemetry.stallCount}x / ${formatTurnDuration(telemetry.stallMs)}`));
	}
	if (config.cost !== "off") {
		// two dimensions: what this run actually cost, and the blended
		// per-million rate (dominated by the cache-read share — see CONTEXT)
		const costParts: string[] = [];
		if (telemetry.costUsd > 0) {
			const actual = telemetry.costUsd < 0.05 ? telemetry.costUsd.toFixed(4) : telemetry.costUsd.toFixed(2);
			costParts.push(`$${actual}`);
		}
		if (config.cost === "cost+rate" && telemetry.rateUsdPerMTokens !== null) {
			costParts.push(`$${telemetry.rateUsdPerMTokens.toFixed(2)}/M`);
		}
		if (costParts.length) parts.push(theme.fg("warning", `${glyphs.cost} ${costParts.join(" · ")}`));
	}
	return parts.join(` ${theme.fg("dim", "|")} `);
}

/** Live values the working-status surfaces render from. */
export interface WorkingContentSource {
	elapsedText: string;
	/** Run speed from submission to now; null until tokens exist. */
	runTps: number | null;
	runInputTokens: number;
	runCacheReadTokens: number;
	runOutputTokens: number;
	runCacheHitRate: number | null;
	runCostUsd: number;
	toolCount: number;
}

/** Glyph-prefixed segments shared by both working surfaces — every segment
 *  carries its own icon (clock/wrench included) so the two never disagree. */
function workingSegments(
	source: WorkingContentSource,
	glyphs: IconGlyphs,
	opts: { elapsed: boolean; speed: boolean; input: WorkingInputMode; output: boolean; cacheHit: boolean; cost: CostDisplayMode; tools: boolean },
): string[] {
	const parts: string[] = [];
	if (opts.elapsed) parts.push(`${glyphs.working} ${source.elapsedText}`);
	if (opts.speed && source.runTps !== null) parts.push(`${glyphs.speed} ${source.runTps.toFixed(1)} tok/s`);
	if (opts.input !== "off" && source.runInputTokens > 0) {
		const total = fmtTokens(source.runInputTokens);
		const cachePart = opts.input === "cache" && source.runCacheReadTokens > 0
			? ` (R ${fmtTokens(source.runCacheReadTokens)})`
			: "";
		parts.push(`${glyphs.input} ${total}${cachePart}`);
	}
	if (opts.output && source.runOutputTokens > 0) parts.push(`${glyphs.output} ${fmtTokens(source.runOutputTokens)}`);
	if (opts.cacheHit && source.runCacheHitRate !== null) parts.push(`${glyphs.cacheHit} ${source.runCacheHitRate.toFixed(1)}%`);
	if (opts.tools && source.toolCount > 0) parts.push(`${glyphs.tools} ${source.toolCount}`);
	if (opts.cost !== "off" && source.runCostUsd > 0) {
		// same blended rate as the footers: run cost over run tokens
		// (usage.totalTokens ≈ input+cacheRead+cacheWrite+output)
		const runTokens = source.runInputTokens + source.runOutputTokens;
		const rate = opts.cost === "cost+rate" && runTokens > 0
			? ` · $${(source.runCostUsd / (runTokens / 1_000_000)).toFixed(2)}/M`
			: "";
		parts.push(`${glyphs.cost} $${source.runCostUsd.toFixed(2)}${rate}`);
	}
	return parts;
}

/** pi working-line message: "Working… ( 1m 23s · 󰓅 62.2 tok/s · …)". Elapsed
 *  always leads; every other segment is gated by the workingLine config. */
export function formatWorkingLineMessage(
	content: WorkingLineConfig,
	source: WorkingContentSource,
	glyphs: IconGlyphs,
): string {
	const parts = workingSegments(source, glyphs, content);
	return `Working… (${parts.join(" · ")})`;
}

/** Border status text: the same glyph-prefixed segments, joined directly. The
 *  editor truncates by width and degrades to the glyph alone when narrow. */
export function formatWorkingBorderText(
	content: WorkingBorderConfig,
	source: WorkingContentSource,
	glyphs: IconGlyphs,
): string {
	const parts = workingSegments(source, glyphs, content);
	if (parts.length === 0) parts.push(`${glyphs.working} ${source.elapsedText}`);
	return parts.join(" · ");
}
