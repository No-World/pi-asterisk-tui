import type {
	AgentSettledEvent,
	AgentStartEvent,
	MessageEndEvent,
	MessageStartEvent,
	MessageUpdateEvent,
	ToolExecutionStartEvent,
	TurnEndEvent,
	TurnStartEvent,
	Theme,
} from "@earendil-works/pi-coding-agent";
import type { IconMode, TelemetryConfig } from "./config.ts";
import { resolveGlyphs } from "./icons.ts";
import { cacheHitColor, estimateStreamedTokens, finiteOrZero, fmtTokens, formatDuration, formatInputBreakdown } from "./utils.ts";

const STALL_THRESHOLD_MS = 1000;

type TelemetryEvent =
	| AgentStartEvent
	| AgentSettledEvent
	| TurnStartEvent
	| MessageStartEvent
	| MessageUpdateEvent
	| MessageEndEvent
	| ToolExecutionStartEvent
	| TurnEndEvent;
type AgentMessage = MessageStartEvent["message"];
type AssistantMessage = Extract<AgentMessage, { role: "assistant" }>;

interface MessageTiming {
	lastUpdateMs: number;
	firstOutputMs: number | null;
	inStall: boolean;
	/** Largest output-token count reported by provider usage while streaming this message. */
	liveUsageOutput: number;
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
	/** Per-turn summaries collected during the current agent run. */
	private agentSummaries: TurnSummary[] = [];
	/** Merged summary of the most recently settled agent run. */
	private lastSummary: TurnSummary | undefined;
	/** Per-message thinking durations of the most recently settled agent run. */
	private lastRunThinkingMs: number[] = [];
	/** Per-message thinking durations collected during the current agent run. */
	private agentRunThinkingMs: number[] = [];

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
	 * Output tokens accumulated so far in the current turn: completed messages use
	 * exact usage; the in-flight message uses provider-reported usage when available
	 * and a delta-based estimate otherwise (anthropic-protocol backends only send
	 * usage with the final message_delta, so without this the counter sits at 0
	 * for the whole stream).
	 */
	getTurnOutputTokens(): number {
		let sum = 0;
		for (const message of this.turn?.messages ?? []) {
			sum += finiteOrZero(message.usage?.output);
		}
		const current = this.turn?.currentMessage;
		if (current) {
			sum += Math.max(current.liveUsageOutput, Math.floor(current.streamedEstimate));
		}
		return sum;
	}

	handle(event: TelemetryEvent): TurnTelemetry | undefined {
		switch (event.type) {
			case "agent_start":
				if (this.agentStartMs === null) {
					this.agentStartMs = this.now();
					this.agentTurns = [];
					this.liveToolCalls = 0;
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
				if (this.turn) {
					this.turn.toolCounts.set(event.toolName, (this.turn.toolCounts.get(event.toolName) ?? 0) + 1);
				}
				return;
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
			// per-message output speed: tokens / streaming duration
			const out = finiteOrZero(message.usage?.output);
			const firstOutput = current.firstOutputMs;
			const genMs = firstOutput !== null ? endMs - firstOutput : 0;
			if (out > 0 && firstOutput !== null && genMs > 0) {
				this.lastMessageTps = round(out / (genMs / 1000), 1);
			}
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
	if (config.cost && telemetry.rateUsdPerMTokens !== null) {
		parts.push(theme.fg("warning", `${glyphs.cost} $${telemetry.rateUsdPerMTokens.toFixed(2)}/M`));
	}
	return parts.join(` ${theme.fg("dim", "|")} `);
}
