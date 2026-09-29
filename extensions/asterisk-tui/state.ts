import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AssistantMessage, ToolResultMessage } from "@earendil-works/pi-ai";
import type { GitStatus } from "./git.ts";
import { emptyGitStatus } from "./git.ts";
import type { TurnSummary } from "./telemetry.ts";
import { finiteOrZero, formatProviderLabel } from "./utils.ts";

export interface FooterState {
	git: GitStatus;
	sessionStartEpoch: number;
	workingSince: number | undefined;
	lastDoneIn: number | undefined;
	/** Claude-style summary of the most recently settled agent run. */
	lastTurnSummary: TurnSummary | undefined;
	/** Output speed (tok/s) of the latest assistant message. */
	outputTps: number | null;
}

export interface UsageTotals {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
	/** Cumulative cache hit rate: cacheRead / (input + cacheWrite + cacheRead). */
	cacheHitRate: number | undefined;
	/** Side-spend, mirroring pi's own "Tools/summaries" bucket in
	 * core/usage-totals.js: toolResult message usage (the tool's own LLM calls,
	 * e.g. subagents) plus compaction/branch_summary summarization calls. Real
	 * session cost, but not main-context accounting — never folded into the
	 * counters above, which stay assistant-only. */
	tools: SideSpendTotals;
}

export interface SideSpendTotals {
	input: number;
	output: number;
	cost: number;
}

let usageCache: { key: string; totals: UsageTotals } | undefined;

function entriesKey(ctx: ExtensionContext): string {
	const entries = ctx.sessionManager.getEntries();
	const last = entries.at(-1);
	return `${entries.length}:${last?.id ?? ""}:${last?.timestamp ?? ""}`;
}

export function getUsageTotals(ctx: ExtensionContext): UsageTotals {
	const key = entriesKey(ctx);
	if (usageCache && usageCache.key === key) return usageCache.totals;

	const totals: UsageTotals = {
		input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0,
		cacheHitRate: undefined,
		tools: { input: 0, output: 0, cost: 0 },
	};
	const addSideSpend = (u: ToolResultMessage["usage"]) => {
		if (!u) return;
		// Mirror the main counters' convention: cacheWrite bills near full
		// price, so it counts toward the input-side figure.
		totals.tools.input += finiteOrZero(u.input) + finiteOrZero(u.cacheWrite);
		totals.tools.output += finiteOrZero(u.output);
		totals.tools.cost += finiteOrZero(u.cost?.total);
	};
	for (const entry of ctx.sessionManager.getEntries()) {
		if (entry.type === "message" && entry.message?.role === "assistant") {
			const m = entry.message as AssistantMessage;
			const u = m.usage;
			if (!u) continue;
			const input = finiteOrZero(u.input);
			const cacheRead = finiteOrZero(u.cacheRead);
			const cacheWrite = finiteOrZero(u.cacheWrite);
			// input matches /session's "uncached" total: cacheWrite is billed near full
			// price (fresh content), only cacheRead is discounted repeat content.
			totals.input += input + cacheWrite;
			totals.output += finiteOrZero(u.output);
			totals.cacheRead += cacheRead;
			totals.cacheWrite += cacheWrite;
			totals.cost += finiteOrZero(u.cost?.total);
		} else if (entry.type === "message" && entry.message?.role === "toolResult") {
			addSideSpend((entry.message as ToolResultMessage).usage);
		} else if (entry.type === "branch_summary" || entry.type === "compaction") {
			addSideSpend(entry.usage);
		}
	}
	const promptTotal = totals.input + totals.cacheRead;
	if (promptTotal > 0) {
		totals.cacheHitRate = (totals.cacheRead / promptTotal) * 100;
	}

	usageCache = { key, totals };
	return totals;
}

export function invalidateUsageCache(): void {
	usageCache = undefined;
}

export function createInitialState(): FooterState {
	return {
		git: emptyGitStatus(),
		sessionStartEpoch: Date.now(),
		workingSince: undefined,
		lastDoneIn: undefined,
		lastTurnSummary: undefined,
		outputTps: null,
	};
}

export interface ModelMeta {
	provider: string;
	model: string;
	effort: string | undefined;
}

export function getModelMeta(
	ctx: ExtensionContext,
	getThinkingLevel: () => string,
): ModelMeta {
	const provider = formatProviderLabel(ctx.model?.provider);
	const model = ctx.model?.name ?? ctx.model?.id ?? "no-model";
	const reasoning = ctx.model?.reasoning ?? false;
	const effort = reasoning ? getThinkingLevel() : undefined;
	return { provider, model, effort };
}
