/**
 * Claude-style turn collapsing (both TUI modes).
 *
 * After an agent run settles, everything it did — thinking blocks, tool and
 * bash executions — collapses into one clickable summary line:
 *
 *   ▸ ✻ Thought for 11s · called playwright ×3 · ran 1 shell command
 *
 * Assistant answer text stays visible. While the agent is working the turn
 * streams normally — thinking content streams inline (liveThinking, folds
 * back the moment the thinking phase ends) and running tools show a spinner
 * one-liner plus their live output box (liveTools). Clicking the line expands
 * the whole turn (thinking stays
 * behind per-message ✻ labels, individually clickable); clicking again
 * re-collapses it. In the regular TUI (no mouse capture) every compressed
 * line carries a trailing hint with the expand-all shortcut (registerShortcut
 * via index.ts; toggleExpandAll here).
 *
 * Mechanism (version-guarded, inert on mismatch — same policy as
 * fullscreen-scroll.ts / thinking-click.ts):
 *
 * 1. The shared TuiAltScreen / TuiMainScreen prototypes are wrapped. The
 *    alt-screen path discovers the chat container through the layout box
 *    tree (setLayoutRoot + requestRender hooks); the main-screen path walks
 *    the children tree directly (regular mode mounts containers without
 *    layout boxes).
 * 2. The container's render is overridden on the instance: children are grouped
 *    into turns by UserMessageComponent boundaries; a collapsed turn renders
 *    its assistant messages (thinking forced hidden), skips tool boxes and
 *    spacers, and emits the summary line. Render also records line segments so
 *    clicks can map a screen line back to its turn.
 * 3. tool counts come from the components themselves (works for history too);
 *    thinking duration comes from the live telemetry fed at agent_settled.
 */

import type { Theme } from "@earendil-works/pi-coding-agent";
import { effectiveThoughtTreatment, type CollapseMode, type CollapseStyle, type ThoughtTreatment, type ToolOverride } from "./config.ts";

interface Child {
	render?: (width: number) => string[];
	children?: unknown[];
}

interface AssistantLike {
	hideThinkingBlock?: boolean;
	setHideThinkingBlock(hide: boolean): void;
}

interface ChatContainer {
	children?: unknown[];
	render: (width: number) => string[];
	addChild?: (child: unknown) => void;
}

interface ViewportAltScreen {
	setLayoutRoot?: (component: unknown) => void;
	requestRender?: (...args: unknown[]) => void;
	layoutRoot?: unknown;
}

const ATTACHED = Symbol.for("open-tui.turnCollapse");
const COLLAPSE_INSTALLED = Symbol.for("open-tui.turnCollapseInstalled");
/** Reclaim bookkeeping: lets a reloaded module instance take over the patch. */
const ORIGINAL_RENDER = Symbol.for("open-tui.turnCollapse.originalRender");
const ORIGINAL_ADD_CHILD = Symbol.for("open-tui.turnCollapse.originalAddChild");
/** Global slot: any module instance can find the patched chat container. */
const CONTAINER_SLOT = Symbol.for("open-tui.turnCollapse.container");

const DEBUG_LOG = process.env.OPEN_TUI_DEBUG;
function debug(message: string): void {
	if (!DEBUG_LOG) return;
	try {
		// eslint-disable-next-line @typescript-eslint/no-require-imports
		const fs = require("node:fs") as typeof import("node:fs");
		fs.appendFileSync(DEBUG_LOG, `${Date.now()} [turn-collapse] ${message}\n`);
	} catch {
		// Diagnostics are best-effort.
	}
}

/** Runs the user expanded to their full content. Keyed by the run's head child. */
const expandedRuns = new WeakSet<object>();
/**
 * Messages live-expanded by the liveThinking preference (streaming thinking
 * phase). Tracked so the fold-back only touches what we expanded — user
 * expansion (expandedRuns) is never disturbed.
 */
const liveExpanded = new WeakSet<object>();
/** Heads of runs rendered as collapsed lines this frame. */
let collapsedRunHeads = new Set<object>();
/** member child -> run head (expanded runs collapse via any member line). */
const runMembership = new Map<object, object>();
/**
 * Idle render cache: while no agent run is active and nothing changed, the
 * walk output is reused instead of re-walking the whole transcript (scroll
 * and HUD ticks re-render without content changes). Busted by every render
 * request, config change, click, and attach/detach.
 */
let renderCache: {
	container: unknown;
	width: number;
	at: number;
	lines: string[];
	segments: typeof childSegments;
	heads: Set<object>;
} | undefined;

/** Idle cache window: unknown-source mutations (e.g. ctrl+t rebuilds) self-heal within this. */
const RENDER_CACHE_TTL_MS = 250;

function bustRenderCache(): void {
	renderCache = undefined;
}
/** Spinner frames for running tool lines. */
const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

function spinnerFrame(): string {
	return SPINNER_FRAMES[Math.floor(Date.now() / 120) % SPINNER_FRAMES.length]!;
}

function isToolRunning(child: unknown): boolean {
	const bash = child as { status?: unknown };
	if (typeof bash.status === "string") return bash.status === "running";
	const generic = child as { isPartial?: unknown; result?: unknown };
	if (generic.isPartial === true) return true;
	return generic.result === undefined;
}

function truncate(text: string, max: number): string {
	return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** One-liner for a tool box: `<marker> bash · $ echo hi`. */
function renderToolLine(child: unknown, marker: string): string {
	const bash = (child as { command?: unknown }).command;
	if (typeof bash === "string") {
		return ` ${marker} ${fg("muted", `bash · $ ${truncate(bash, 48)}`)}`;
	}
	const name = (child as { toolName?: string }).toolName ?? "tool";
	const args = (child as { args?: Record<string, unknown> }).args;
	if (name === "bash") {
		const cmd = (args as { command?: unknown } | undefined)?.command;
		const command = typeof cmd === "string" ? cmd : "";
		return ` ${marker} ${fg("muted", `bash · $ ${truncate(command, 48)}`)}`;
	}
	let hint = "";
	if (args !== null && typeof args === "object") {
		const entries = Object.entries(args as Record<string, unknown>);
		if (entries.length > 0) {
			const [key, value] = entries[0]!;
			const rendered = typeof value === "string" ? value : JSON.stringify(value);
			hint = ` · ${key}: ${truncate(rendered, 32)}`;
		}
	}
	return ` ${marker} ${fg("muted", `${name}${hint}`)}`;
}

/** Claude-style group line: `✻ ran 2 shell commands` for consecutive tools. */
function renderGroupLine(group: unknown[]): string {
	const parts = summarizeTools(group);
	const text = parts.length > 0 ? parts.join(" · ") : "tools";
	return ` ${fg("accent", "✻")} ${fg("muted", text)}`;
}

/** Click routing for collapsed run lines and expanded-run members. */
export function handleToolLineClick(lineIndex: number, line: string): boolean {
	void line;
	for (const segment of childSegments) {
		if (lineIndex >= segment.start && lineIndex < segment.end) {
			const child = segment.child as object;
			let head: object | undefined;
			if (collapsedRunHeads.has(child)) {
				head = child; // a collapsed run's summary line
			} else if (isToolBox(child)) {
				if (isToolRunning(child)) return false; // live boxes are not clickable
				head = runMembership.get(child); // a member of an expanded run
			}
			if (head === undefined) continue; // label lines fall through to the thinking flow
			if (expandedRuns.has(head)) {
				expandedRuns.delete(head);
			} else {
				expandedRuns.add(head);
			}
			bustRenderCache();
			requestRenderRef?.();
			return true;
		}
	}
	return false;
}
/** Per-child line segments from the last render — keeps click mapping in sync
 *  with what is actually on screen (re-rendering at click time can skew while
 *  a message streams). */
let childSegments: Array<{ start: number; end: number; child: unknown }> = [];

/**
 * Per-message thinking labels: the label is instance state on each
 * AssistantMessageComponent, so history can show "✻ Thought…" while the
 * streaming message shows "✻ Thinking…" — no global label flipping.
 */
/**
 * Styled thinking label: same ✻ icon color and upright font as the run
 * lines. pi wraps the label in italic + thinkingText gray; a leading SGR
 * reset takes over completely.
 */
function styledThinkingLabel(text: string): string {
	return `\x1b[0m${fg("accent", "✻")}${fg("muted", ` ${text}`)}`;
}

function syncThinkingLabel(child: unknown): void {
	const candidate = child as {
		isStreaming?: unknown;
		hiddenThinkingLabel?: unknown;
		setHiddenThinkingLabel?: (label: string) => void;
	};
	if (typeof candidate.setHiddenThinkingLabel !== "function") return;
	const desired = styledThinkingLabel(candidate.isStreaming === true ? "Thinking…" : "Thought…");
	if (candidate.hiddenThinkingLabel !== desired) {
		candidate.setHiddenThinkingLabel(desired);
	}
}

/** Per-message thinking durations (ms) of the last settled run, message-ordered. */
let thinkingDurations: number[] | undefined;
let assistantOrdinal = 0;

/** Feed the settled run's per-message thinking durations (undefined for history). */
export function setThinkingDurations(durations: number[] | undefined): void {
	thinkingDurations = durations;
	assistantOrdinal = 0;
	bustRenderCache();
}

function resetAssistantOrdinal(): void {
	assistantOrdinal = 0;
}

const VERB_PHRASES: Record<string, (count: number) => string> = {
	bash: (n) => `ran ${n} shell command${n > 1 ? "s" : ""}`,
	ls: (n) => `listed ${n} director${n > 1 ? "ies" : "y"}`,
	glob: (n) => `searched for ${n} pattern${n > 1 ? "s" : ""}`,
	grep: (n) => `searched for ${n} pattern${n > 1 ? "s" : ""}`,
	read: (n) => `read ${n} file${n > 1 ? "s" : ""}`,
	edit: (n) => `edited ${n} file${n > 1 ? "s" : ""}`,
	write: (n) => `edited ${n} file${n > 1 ? "s" : ""}`,
};

/** Claude-style verb phrase for a tool: `ran 2 shell commands`, `searched for 9 patterns`. */
function verbPhrase(toolName: string, count: number): string {
	const phrase = VERB_PHRASES[toolName];
	if (phrase) return phrase(count);
	return count > 1 ? `called ${toolName} ×${count}` : `called ${toolName}`;
}

/** Segment lookup for the click pipeline: the child that rendered a line. */
export function findThinkingHostViaSegments(lineIndex: number): unknown | undefined {
	for (const segment of childSegments) {
		if (lineIndex >= segment.start && lineIndex < segment.end) {
			return isAssistantMessage(segment.child) ? segment.child : undefined;
		}
	}
	return undefined;
}
let themeRef: Theme | undefined;
let requestRenderRef: (() => void) | undefined;

/** Collapse preferences fed from open-tui.json (index.ts wires config → here). */
export interface CollapseOptions {
	mode: CollapseMode;
	style: CollapseStyle;
	tools: Record<string, ToolOverride>;
	/** Thinking-block override — same lattice as per-tool overrides. */
	thought: ToolOverride;
	/** Hold retry errors during a run (independent of the compression mode). */
	retryErrors: boolean;
	/** Stream thinking content inline while it arrives; fold back after. */
	liveThinking: boolean;
	/** Render running tool output boxes below the spinner one-liner. */
	liveTools: boolean;
	/** Trailing hint text for compressed lines in the regular TUI (already
	 *  localized; undefined hides it). Derived from the registered shortcut. */
	expandAllHint?: string;
}

let collapse: CollapseOptions = {
	mode: "group-all",
	style: "compact",
	tools: {},
	thought: "default",
	retryErrors: true,
	liveThinking: true,
	liveTools: true,
};

/**
 * Which renderer last requested a frame — the regular (main-screen) and
 * fullscreen (alt-screen) wraps keep this in sync on every request. Gates
 * the regular-only affordances: the expand-all shortcut and its hint.
 */
let rendererMode: "regular" | "fullscreen" | undefined;
/** Global expand-all view state; only effective while rendererMode is regular. */
let expandAllActive = false;

const expandAllOn = (): boolean => rendererMode === "regular" && expandAllActive;

/** A run renders expanded when the user clicked it OR expand-all is on. */
const runExpanded = (head: object): boolean => expandAllOn() || expandedRuns.has(head);

/** Test hook: pretend a renderer of this mode is drawing frames. */
export function setRendererModeForTest(mode: "regular" | "fullscreen" | undefined): void {
	rendererMode = mode;
}

/**
 * The expand-all shortcut (regular TUI): flips every compressed line between
 * fully expanded and collapsed. Returns the new state, or undefined when the
 * current renderer is not the regular one (fullscreen keeps click-to-expand).
 */
export function toggleExpandAll(): "expanded" | "collapsed" | undefined {
	if (rendererMode !== "regular") return undefined;
	expandAllActive = !expandAllActive;
	bustRenderCache();
	requestRenderRef?.();
	return expandAllActive ? "expanded" : "collapsed";
}

export function setCollapseOptions(options: CollapseOptions): void {
	collapse = options;
	bustRenderCache();
	applyThinkingVisibilityToContainer();
}

/** Compat/test helper: boolean collapse switch (true = group-all, false = native). */
export function setTurnCollapseEnabled(value: boolean): void {
	collapse = { ...collapse, mode: value ? "group-all" : "native" };
	bustRenderCache();
	applyThinkingVisibilityToContainer();
}

/** Compat/test helper: merge partial live-view preferences. */
export function setLiveViewOptions(options: { liveThinking?: boolean; liveTools?: boolean }): void {
	collapse = {
		...collapse,
		...(options.liveThinking === undefined ? {} : { liveThinking: options.liveThinking }),
		...(options.liveTools === undefined ? {} : { liveTools: options.liveTools }),
	};
	bustRenderCache();
	applyThinkingVisibilityToContainer();
}

/** Effective thinking treatment for the current mode + override. */
function thoughtTreatment(): ThoughtTreatment {
	return effectiveThoughtTreatment(collapse.mode, collapse.thought);
}

/**
 * Thinking-block visibility preference. The single source of truth is
 * open-tui.json (turnCollapse.thought); pi's native hideThinkingBlock is
 * only a mirror (index.ts writes it) so pi-native rendering matches when the
 * extension is off.
 */
let thoughtPref: ToolOverride | undefined;
/** pi's global flag as last seen on an arriving message (ctrl+t detector). */
let lastObservedPiFlag: boolean | undefined;

export function setThoughtPreference(state: ToolOverride): void {
	thoughtPref = state;
	collapse = { ...collapse, thought: state };
	bustRenderCache();
	applyThinkingVisibilityToContainer();
	requestRenderRef?.();
}

/** Flips every live assistant message to the effective fold state. */
export function applyThinkingVisibilityToContainer(): void {
	if (thoughtPref === undefined) return;
	const hidden = thoughtTreatment() !== "expand";
	const container = (globalThis as Record<symbol, unknown>)[CONTAINER_SLOT];
	if (typeof container !== "object" || container === null) return;
	for (const child of ((container as ChatContainer).children ?? []) as unknown[]) {
		if (isAssistantMessage(child) && child.hideThinkingBlock !== hidden) {
			child.setHideThinkingBlock(hidden);
		}
	}
}

/** Canonical tool name of a tool box (bash boxes carry a raw command string). */
function toolNameOf(child: unknown): string {
	if (typeof (child as { command?: unknown }).command === "string") return "bash";
	const name = (child as { toolName?: unknown }).toolName;
	return typeof name === "string" ? name : "tool";
}

/** Effective treatment of a tool: per-tool override, else the mode default. */
function toolTreatment(child: unknown): "single" | "expand" | "group-same" | "run" {
	const override = collapse.tools[toolNameOf(child)] ?? collapse.tools["*"];
	if (override === "single" || override === "expand") return override;
	if (override === "group-same") return "group-same";
	switch (collapse.mode) {
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

export function setTurnCollapseTheme(theme: Theme): void {
	themeRef = theme;
}

export function setTurnCollapseRender(requestRender: () => void): void {
	requestRenderRef = requestRender;
}

function fg(color: Parameters<Theme["fg"]>[0], text: string): string {
	return themeRef ? themeRef.fg(color, text) : text;
}

function isUserMessage(child: unknown): child is Child & object {
	if (typeof child !== "object" || child === null) return false;
	const candidate = child as Child & { text?: unknown; rebuild?: unknown };
	return typeof candidate.text === "string" && typeof candidate.rebuild === "function";
}

function isAssistantMessage(child: unknown): child is Child & AssistantLike {
	if (typeof child !== "object" || child === null) return false;
	const candidate = child as Child & Partial<AssistantLike>;
	return typeof candidate.setHideThinkingBlock === "function" && typeof candidate.hideThinkingBlock === "boolean";
}

function isToolBox(child: unknown): child is { toolName?: unknown; command?: unknown } & Child {
	if (typeof child !== "object" || child === null) return false;
	const candidate = child as { toolName?: unknown; command?: unknown; appendOutput?: unknown; toolCallId?: unknown };
	const generic = typeof candidate.toolName === "string" && typeof candidate.toolCallId === "string";
	const bash = typeof candidate.command === "string" && typeof candidate.appendOutput === "function";
	return generic || bash;
}

function isSpacer(child: unknown): boolean {
	if (typeof child !== "object" || child === null) return false;
	const name = (child as { constructor?: { name?: string } }).constructor?.name;
	return name === "Spacer";
}

function safeRender(child: Child, width: number): string[] {
	if (typeof child.render !== "function") return [];
	try {
		return child.render(width) ?? [];
	} catch {
		return [];
	}
}

function formatDuration(ms: number): string {
	const totalSeconds = Math.max(0, Math.floor(ms / 1000));
	if (totalSeconds < 60) return `${totalSeconds}s`;
	const s = totalSeconds % 60;
	const totalMinutes = Math.floor(totalSeconds / 60);
	if (totalMinutes < 60) return `${totalMinutes}m ${s}s`;
	const m = totalMinutes % 60;
	const h = Math.floor(totalMinutes / 60);
	return `${h}h ${m}m`;
}

function summarizeTools(turnChildren: unknown[]): string[] {
	const counts = new Map<string, number>();
	for (const child of turnChildren) {
		if (!isToolBox(child)) continue;
		const name =
			typeof (child as { command?: unknown }).command === "string"
				? "bash"
				: ((child as { toolName?: string }).toolName ?? "tool");
		counts.set(name, (counts.get(name) ?? 0) + 1);
	}
	const parts: string[] = [];
	for (const [name, count] of counts) {
		parts.push(verbPhrase(name, count));
	}
	return parts;
}



interface ExpandedWalk {
	push: (lines: string[]) => void;
	pushChild: (child: unknown, lines: string[]) => void;
	/** Compressed summary line(s) — classic style pads them with blank lines. */
	pushCompressed: (child: unknown, lines: string[]) => void;
	/** True when the last emitted line was a compressed line (spacer absorption). */
	lastCompressed: () => boolean;
	renderChild: (child: unknown) => void;
}

type RunMember =
	| { kind: "label"; child: unknown }
	| { kind: "tool"; child: unknown }
	/** A text-bearing message whose leading ✻ label was absorbed into the run. */
	| { kind: "text-tail"; child: unknown };

/**
 * Live-thinking sync: expand streaming thinking-phase messages, fold back
 * once the phase ends (text starts or streaming stops, or the preference
 * turned off). Runs inside classification so every walk maintains it.
 */
function syncLiveThinking(child: AssistantLike & { isStreaming?: unknown }, hasText: boolean, hasThinking: boolean): void {
	const streaming = child.isStreaming === true;
	const inThinkingPhase = collapse.liveThinking && streaming && hasThinking && !hasText;
	if (inThinkingPhase) {
		liveExpanded.add(child);
		if (child.hideThinkingBlock !== false) child.setHideThinkingBlock(false);
	} else if (liveExpanded.has(child)) {
		liveExpanded.delete(child);
		const hidden = thoughtTreatment() !== "expand";
		if (child.hideThinkingBlock !== hidden) child.setHideThinkingBlock(hidden);
	}
}

/**
 * Classify assistant messages by CONTENT, not by what they currently render:
 * expanding a run flips hideThinkingBlock, which would otherwise re-classify
 * label members as text on the next frame, rebuild the runs, and self-destruct
 * the expanded state. With the thought preference set to "visible", thinking
 * -only messages classify as ordinary visible content instead of labels.
 */
function classifyAssistant(child: unknown): "label" | "transparent" | "text" | "other" {
	if (!isAssistantMessage(child)) return "other";
	const ordinal = assistantOrdinal++;
	const duration = thinkingDurations?.[ordinal] ?? 0;
	(child as { __openTuiThinkingMs?: number }).__openTuiThinkingMs = duration;
	const content = (child as { lastMessage?: { content?: Array<{ type?: string; text?: string; thinking?: string }> } })
		.lastMessage?.content;
	if (!Array.isArray(content)) return "transparent";
	const hasText = content.some(
		(block) => block?.type === "text" && typeof block.text === "string" && block.text.trim().length > 0,
	);
	const hasThinking = content.some(
		(block) => block?.type === "thinking" && typeof block.thinking === "string" && block.thinking.trim().length > 0,
	);
	(child as { __openTuiHasThinking?: boolean }).__openTuiHasThinking = hasThinking;
	syncLiveThinking(child, hasText, hasThinking);
	if (hasText) return "text";
	if (hasThinking) return thoughtTreatment() === "expand" ? "other" : "label";
	return "transparent";
}

function isTransparentChild(candidate: unknown, width: number): boolean {
	if (isSpacer(candidate)) return true;
	if (isToolBox(candidate)) return false;
	const lines = safeRender(candidate as Child, width);
	return lines.length === 0 || lines.every((line) => isBlankLine(line));
}

/** One tool, one line (`▸ bash · $ …`); clicking toggles its native box. */
function emitSingleToolLine(child: object, walk: ExpandedWalk): void {
	if (runExpanded(child)) {
		runMembership.set(child, child);
		walk.renderChild(child);
		return;
	}
	collapsedRunHeads.add(child);
	walk.pushCompressed(child, [renderToolLine(child, fg("accent", "▸"))]);
}

/** Shared emitter for a Thought line (consecutive thinking-only messages). */
function makeLabelRun(walk: ExpandedWalk) {
	let members: unknown[] = [];
	return {
		isEmpty: (): boolean => members.length === 0,
		push(child: unknown): void {
			members.push(child);
		},
		flush(): void {
			if (members.length === 0) return;
			const head = members[0] as object;
			if (runExpanded(head)) {
				for (const member of members) {
					runMembership.set(member as object, head);
					// Expand the thinking itself — same affordance as run lines.
					if ((member as AssistantLike).hideThinkingBlock !== false) {
						(member as AssistantLike).setHideThinkingBlock(false);
					}
					walk.renderChild(member);
				}
			} else {
				collapsedRunHeads.add(head);
				for (const member of members) {
					runMembership.set(member as object, head);
					if ((member as AssistantLike).hideThinkingBlock !== true) {
						(member as AssistantLike).setHideThinkingBlock(true);
					}
				}
				const thinkingMs = members.reduce<number>(
					(sum, member) => sum + ((member as { __openTuiThinkingMs?: number }).__openTuiThinkingMs ?? 0),
					0,
				);
				const text = thinkingMs >= 1000 ? `Thought for ${formatDuration(thinkingMs)}` : "Thought";
				walk.pushCompressed(head, [` ${fg("accent", "✻")} ${fg("muted", text)}`]);
			}
			members = [];
		},
	};
}

/** Shared emitter for a same-type tool group line (`✻ read 3 files`). */
function makeToolTypeRun(walk: ExpandedWalk, expanded: () => boolean) {
	let members: unknown[] = [];
	return {
		isEmpty: (): boolean => members.length === 0,
		accepts(child: unknown): boolean {
			return members.length === 0 || toolNameOf(child) === toolNameOf(members[members.length - 1]);
		},
		push(child: unknown): void {
			members.push(child);
		},
		flush(): void {
			if (members.length === 0) return;
			const head = members[0] as object;
			if (expanded() || runExpanded(head)) {
				for (const tool of members) {
					runMembership.set(tool as object, head);
					walk.renderChild(tool);
				}
			} else {
				collapsedRunHeads.add(head);
				for (const tool of members) {
					runMembership.set(tool as object, head);
				}
				walk.pushCompressed(head, [renderGroupLine(members)]);
			}
			members = [];
		},
	};
}

/** Render a finished turn according to the compression mode. */
function renderExpandedTurn(turnChildren: unknown[], walk: ExpandedWalk, width: number): void {
	if (collapse.mode === "group-all") {
		renderRunTurn(turnChildren, walk, width);
	} else {
		renderItemTurn(turnChildren, walk, width);
	}
}

/**
 * Unified walk for the native / single / group-same modes. The mode only
 * decides what "default" resolves to (toolTreatment / thoughtTreatment);
 * every per-item state is absolute. Effective treatments here are expand /
 * single / group-same — run absorption only exists in group-all mode.
 */
function renderItemTurn(turnChildren: unknown[], walk: ExpandedWalk, width: number): void {
	let live = false;
	const labelRun = makeLabelRun(walk);
	const toolRun = makeToolTypeRun(walk, () => live);

	const runsOpen = (): boolean => !labelRun.isEmpty() || !toolRun.isEmpty();
	const flushAll = (): void => {
		labelRun.flush();
		toolRun.flush();
	};
	/** A folded thinking-only message renders as a standalone ✻ line. */
	const labelCompressible = (child: unknown): boolean => {
		if (!isAssistantMessage(child) || child.hideThinkingBlock !== true) return false;
		if (thoughtTreatment() === "expand") return false;
		const content = (child as { lastMessage?: { content?: Array<{ type?: string; text?: string; thinking?: string }> } })
			.lastMessage?.content;
		if (!Array.isArray(content)) return false;
		const hasText = content.some(
			(block) => block?.type === "text" && typeof block.text === "string" && block.text.trim().length > 0,
		);
		const hasThinking = content.some(
			(block) => block?.type === "thinking" && typeof block.thinking === "string" && block.thinking.trim().length > 0,
		);
		return hasThinking && !hasText;
	};
	const nextCompressible = (child: unknown): boolean =>
		typeof child === "object" && child !== null &&
		((isToolBox(child) && !isToolRunning(child) &&
			(toolTreatment(child) === "single" || toolTreatment(child) === "group-same")) ||
			labelCompressible(child));

	let index = 0;
	while (index < turnChildren.length) {
		const current = turnChildren[index];
		if (isTransparentChild(current, width)) {
			// Absorbed while runs are open, after a compressed line, or right
			// before compressed output (label lines included).
			if (!runsOpen() && !walk.lastCompressed() && !nextCompressible(turnChildren[index + 1])) {
				walk.renderChild(current);
			}
			index++;
			continue;
		}
		if (isToolBox(current)) {
			const treatment = toolTreatment(current);
			if (isToolRunning(current)) {
				flushAll();
				live = true;
				if (treatment !== "expand") {
					walk.pushChild(current, [renderToolLine(current, fg("accent", spinnerFrame()))]);
					if (!collapse.liveTools) {
						index++;
						continue; // spinner one-liner only
					}
				}
				walk.renderChild(current);
				index++;
				continue;
			}
			if (treatment === "expand") {
				flushAll();
				walk.renderChild(current); // native box (mode default in native)
				index++;
				continue;
			}
			if (treatment === "single") {
				flushAll();
				emitSingleToolLine(current as object, walk);
				index++;
				continue;
			}
			// group-same: a type change closes the open tool group.
			if (!toolRun.accepts(current)) toolRun.flush();
			toolRun.push(current);
			index++;
			continue;
		}
		const kind = classifyAssistant(current);
		if (
			kind === "label" &&
			thoughtTreatment() === "group-same" &&
			!live &&
			(current as { isStreaming?: unknown }).isStreaming !== true
		) {
			if (!toolRun.isEmpty()) toolRun.flush(); // kinds never merge
			labelRun.push(current);
			index++;
			continue;
		}
		// Visible content (text, per-message labels, inline thinking, errors).
		flushAll();
		walk.renderChild(current);
		index++;
	}
	flushAll();
}

/**
 * group-all mode (Claude-Code style run merging): consecutive label-only
 * messages and tool groups (with nothing visible between) collapse into ONE
 * line:
 *   ✻ Thought for 19s, searched for 9 patterns, ran 1 shell command
 */
function renderRunTurn(turnChildren: unknown[], walk: ExpandedWalk, width: number): void {
	const completedTool = (candidate: unknown): boolean =>
		isToolBox(candidate) && !isToolRunning(candidate);

	/** Render a text message minus its leading ✻ label lines (absorbed run). */
	const renderTextTail = (child: unknown): void => {
		const lines = safeRender(child as Child, width);
		let cut = 0;
		// skip leading blanks
		while (cut < lines.length && isBlankLine(lines[cut]!)) cut++;
		// skip the label run
		while (cut < lines.length && !isBlankLine(lines[cut]!) && lines[cut]!.includes("✻")) cut++;
		// keep one structure: blanks before the remaining text are dropped too
		while (cut < lines.length && isBlankLine(lines[cut]!)) cut++;
		walk.pushChild(child, lines.slice(cut));
	};

	const runIsLive = (members: RunMember[]): boolean =>
		members.some(
			(member) =>
				member.kind === "tool" && isToolRunning(member.child) ||
				(member.kind === "label" && (member.child as { isStreaming?: unknown }).isStreaming === true),
		);

	const renderRunLine = (members: RunMember[]): string => {
		const thinkingMs = members.reduce((sum, member) => {
			if (member.kind === "tool") return sum;
			return sum + ((member.child as { __openTuiThinkingMs?: number }).__openTuiThinkingMs ?? 0);
		}, 0);
		const hasThinking = members.some((member) => member.kind !== "tool");
		const tools = members.filter((member) => member.kind === "tool").map((member) => member.child);
		const parts: string[] = [];
		if (thinkingMs >= 1000) parts.push(`Thought for ${formatDuration(thinkingMs)}`);
		else if (hasThinking) parts.push("Thought");
		parts.push(...summarizeTools(tools));
		if (DEBUG_LOG) {
			const detail = members
				.map((member) => {
					if (member.kind === "tool") return "tool";
					const msg = (member.child as { lastMessage?: { content?: Array<{ type?: string; thinking?: string }> } }).lastMessage;
					const real = Array.isArray(msg?.content) &&
						msg!.content!.some((block) => block?.type === "thinking" && typeof block.thinking === "string" && block.thinking.trim().length > 0);
					return `${member.kind}:${real === true ? "real-thinking" : "NO-THINKING"}`;
				})
				.join(" ");
			debug(`runline hasThinking=${hasThinking} [${detail}]`);
		}
		const joined = parts.length > 0 ? parts.join(", ") : "worked";
		// Leading verb phrases capitalize; mid-sentence phrases stay lowercase.
		const text = joined.charAt(0).toUpperCase() + joined.slice(1);
		return ` ${fg("accent", "✻")} ${fg("muted", text)}`;
	};

	let index = 0;
	let runMembers: RunMember[] = [];
	let runLive = false;
	const labelRun = makeLabelRun(walk);
	const toolRun = makeToolTypeRun(walk, () => runLive);
	const flushAux = (): void => {
		labelRun.flush();
		toolRun.flush();
	};

	const flushRun = (): void => {
		if (runMembers.length === 0) return;
		const head = (runMembers[0]!.child as object);
		const tools = runMembers.filter((member) => member.kind === "tool");
		const hasThinking = runMembers.some((member) => member.kind !== "tool");
		const thinkingMs = runMembers.reduce((sum, member) => {
			if (member.kind === "tool") return sum;
			return sum + ((member.child as { __openTuiThinkingMs?: number }).__openTuiThinkingMs ?? 0);
		}, 0);
		if (!runLive && !(tools.length === 0 && thinkingMs < 1000 && !hasThinking)) {
			if (runExpanded(head)) {
				for (const member of runMembers) {
					runMembership.set(member.child as object, head);
					if (member.kind === "label" || member.kind === "text-tail") {
						// Expand the thinking along with the tools — one click,
						// no second tap on the label.
						if ((member.child as AssistantLike).hideThinkingBlock !== false) {
							(member.child as AssistantLike).setHideThinkingBlock(false);
						}
					}
					walk.renderChild(member.child);
				}
			} else {
				collapsedRunHeads.add(head);
				walk.pushCompressed(head, [renderRunLine(runMembers)]);
				for (const member of runMembers) {
					if (
						(member.kind === "label" || member.kind === "text-tail") &&
						(member.child as AssistantLike).hideThinkingBlock !== true
					) {
						(member.child as AssistantLike).setHideThinkingBlock(true);
					}
					if (member.kind === "text-tail") renderTextTail(member.child);
				}
			}
		} else if (!runLive) {
			// Label-only run without duration data: nothing to summarize —
			// render the labels as ordinary clickable lines.
			for (const member of runMembers) {
				if (member.kind === "text-tail") renderTextTail(member.child);
				else walk.renderChild(member.child);
			}
		} else {
			for (const member of runMembers) {
				if (member.kind === "text-tail") {
					renderTextTail(member.child);
					continue;
				}
				if (member.kind === "tool") {
					// Running tool: animated one-liner + the live box below
					// (native-override tools render the box alone).
					if (isToolRunning(member.child) && toolTreatment(member.child) !== "expand") {
						walk.pushChild(member.child, [renderToolLine(member.child, fg("accent", spinnerFrame()))]);
						if (!collapse.liveTools) continue; // spinner one-liner only
					}
					walk.renderChild(member.child);
					continue;
				}
				walk.renderChild(member.child);
			}
		}
		runMembers = [];
		runLive = false;
	};

	while (index < turnChildren.length) {
		const current = turnChildren[index];
		if (isTransparentChild(current, width)) {
			// Absorbed while a run or aux group is open, after a compressed
			// line, or right before compressed output; otherwise padding.
			if (runMembers.length > 0 || !labelRun.isEmpty() || !toolRun.isEmpty() || walk.lastCompressed()) {
				index++;
				continue;
			}
			walk.renderChild(current);
			index++;
			continue;
		}
		if (completedTool(current)) {
			const treatment = toolTreatment(current);
			if (treatment === "expand") {
				// Per-tool native override: a visible boundary for runs.
				flushRun();
				flushAux();
				walk.renderChild(current);
			} else if (treatment === "single") {
				flushRun();
				flushAux();
				emitSingleToolLine(current as object, walk);
			} else if (treatment === "group-same") {
				// Same-type group line, never absorbed into run lines.
				flushRun();
				if (!toolRun.accepts(current)) toolRun.flush();
				toolRun.push(current);
			} else {
				flushAux();
				runMembers.push({ kind: "tool", child: current });
			}
			index++;
			continue;
		}
		if (isToolBox(current)) {
			const treatment = toolTreatment(current);
			if (treatment === "expand") {
				flushRun();
				flushAux();
				walk.renderChild(current);
				index++;
				continue;
			}
			if (treatment === "single" || treatment === "group-same") {
				flushRun();
				flushAux();
				// Running override tool: spinner one-liner (+ live box when enabled);
				// it collapses to its own line (or type group) once finished.
				walk.pushChild(current, [renderToolLine(current, fg("accent", spinnerFrame()))]);
				if (collapse.liveTools) walk.renderChild(current);
				index++;
				continue;
			}
			// A running tool must not drag already-completed members into the
			// live (expanded) render — fold them into their own line first.
			flushAux();
			if (runMembers.length > 0 && !runLive) flushRun();
			runMembers.push({ kind: "tool", child: current });
			runLive = true;
			index++;
			continue;
		}
		const kind = classifyAssistant(current);
		if (kind === "label") {
			const treatment = thoughtTreatment();
			if (treatment === "run") {
				if ((current as { isStreaming?: unknown }).isStreaming === true && runMembers.length > 0 && !runLive) {
					// Same for a streaming thinking message following completed work.
					flushRun();
				}
				flushAux();
				runMembers.push({ kind: "label", child: current });
				if (runIsLive(runMembers)) runLive = true;
				index++;
				continue;
			}
			if (treatment === "group-same" && !runLive && (current as { isStreaming?: unknown }).isStreaming !== true) {
				// Thought lines stay separate from run lines.
				flushRun();
				if (!toolRun.isEmpty()) toolRun.flush();
				labelRun.push(current);
				index++;
				continue;
			}
			// "single": per-message labels are visible boundaries.
			flushRun();
			flushAux();
			walk.renderChild(current);
			index++;
			continue;
		}
		if (
			kind === "text" && runMembers.length > 0 && !runLive &&
			(current as { __openTuiHasThinking?: boolean }).__openTuiHasThinking === true &&
			thoughtTreatment() === "run"
		) {
			// Text message with a leading thinking label: the label joins the
			// open run (duration included) and the run CLOSES here — the text
			// is a visible boundary; later tools start a fresh run.
			runMembers.push({ kind: "text-tail", child: current });
			flushRun();
			index++;
			continue;
		}
		// Visible content (text, errors) ends the run.
		flushRun();
		flushAux();
		walk.renderChild(current);
		index++;
	}
	flushRun();
	flushAux();
}

// A line is blank when it is empty or consists solely of zero-width control
// sequences — CSI ([...m) and OSC (]..., incl. pi's 133 shell
// integration markers that land on spacer lines).
const ZERO_WIDTH_LINE = /^(?:\x1b\[[0-9;?]*[A-Za-z]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\))*$/;

function isBlankLine(line: string): boolean {
	if (line === "") return true;
	// Fast reject: a line starting with a printable char cannot be zero-width-only.
	if (!line.startsWith("\x1b")) return false;
	return ZERO_WIDTH_LINE.test(line);
}

function startsWithLabel(lines: string[]): boolean {
	const first = lines.find((line) => !isBlankLine(line));
	return first !== undefined && first.includes("✻");
}

let renderLogState: string | undefined;
let dumpCount = 0;

function renderCollapsed(container: ChatContainer, original: (width: number) => string[], width: number): string[] {
	const frameStart = PROFILE_LOG ? Date.now() : 0;
	// Idle cache hit: nothing changed since the last walk (scroll, HUD ticks).
	if (
		renderCache && !agentActive && renderCache.container === container && renderCache.width === width &&
		Date.now() - renderCache.at < RENDER_CACHE_TTL_MS
	) {
		childSegments = renderCache.segments;
		collapsedRunHeads = renderCache.heads;
		return renderCache.lines;
	}
	// The walk below replaces Container.render entirely. Disabling collapse does
	// not skip it: per-message labels and click segments still need the walk.
	void original;
	const children = (container.children ?? []) as unknown[];
	const userCount = children.filter(isUserMessage).length;
	const renderState = `${children.length}:${userCount}`;
	if (renderLogState !== renderState) {
		renderLogState = renderState;
		debug(`render: children=${children.length} userMsgs=${userCount}`);
	}
	const out: string[] = [];
	childSegments = [];
	collapsedRunHeads = new Set();
	resetAssistantOrdinal();
	let cursor = 0;
	// classic style: a blank is pending after a compressed line; it is emitted
	// lazily before the next non-blank line (adjacent blanks never double).
	let deferredBlank = false;
	// Walk-level spacer-absorption signal: the last emitted line was compressed.
	let lastCompressedLine = false;

	const push = (lines: string[]): void => {
		if (!deferredBlank && lines.length > 8) {
			// Batch fast path (big children): boundary blank-collapse only.
			let batch = lines;
			if (out.length > 0 && isBlankLine(lines[0]!) && isBlankLine(out[out.length - 1]!)) {
				batch = lines.slice(1);
			}
			out.push(...batch);
			cursor += batch.length;
			lastCompressedLine = false;
			return;
		}
		for (const line of lines) {
			if (deferredBlank && !isBlankLine(line)) {
				out.push("");
				cursor++;
			}
			deferredBlank = false;
			// Never stack blank lines: classic padding, pi spacers, and message
			// leading blanks collapse into a single separator.
			if (isBlankLine(line) && out.length > 0 && isBlankLine(out[out.length - 1]!)) {
				continue;
			}
			out.push(line);
			cursor++;
			lastCompressedLine = false;
		}
	};
	const pushChild = (child: unknown, lines: string[]): void => {
		const start = cursor;
		push(lines);
		if (cursor > start) childSegments.push({ start, end: cursor, child });
	};
	/** Trailing key hint appended to compressed lines in the regular TUI. */
	const compressedHint = (): string | undefined =>
		rendererMode === "regular" && !expandAllOn() && collapse.expandAllHint !== undefined
			? ` ${fg("dim", `(${collapse.expandAllHint})`)}`
			: undefined;
	/** Compressed lines: classic style pads them with blank lines around. */
	const pushCompressed = (child: unknown, lines: string[]): void => {
		if (collapse.style === "classic" && out.length > 0 && !isBlankLine(out[out.length - 1]!)) {
			out.push("");
			cursor++;
			deferredBlank = false; // this blank IS the pending separator
		}
		const hint = compressedHint();
		const withHint = hint === undefined || lines.length === 0
			? lines
			: [...lines.slice(0, -1), lines[lines.length - 1]! + hint];
		pushChild(child, withHint);
		if (collapse.style === "classic") deferredBlank = true;
		lastCompressedLine = true;
	};
	const renderChild = (child: unknown): void => {
		if (isAssistantMessage(child)) syncThinkingLabel(child);

		let lines = safeRender(child as Child, width);
		if (isAssistantMessage(child) && startsWithLabel(lines)) {
			// pi renders a leading Spacer inside the message; drop it so the
			// ✻ line starts the message.
			while (lines.length > 0 && isBlankLine(lines[0]!)) lines = lines.slice(1);
			let labelEnd = 0;
			while (labelEnd < lines.length && !isBlankLine(lines[labelEnd]!) && lines[labelEnd]!.includes("✻")) {
				labelEnd++;
			}
			if (collapse.style === "classic") {
				// Classic: EVERY ✻ label line is a compressed line — padded
				// before, and one blank keeps it apart from the text tail (if any).
				const tail = lines.slice(labelEnd);
				let cut = 0;
				while (cut < tail.length && isBlankLine(tail[cut]!)) cut++;
				const rest = tail.slice(cut);
				pushCompressed(child, lines.slice(0, labelEnd));
				if (rest.length > 0) pushChild(child, ["", ...rest]);
				return;
			}
			// Compact: drop the blanks after the label so the ✻ line sits flush
			// and connects straight to the following text.
			while (labelEnd < lines.length && isBlankLine(lines[labelEnd]!)) {
				lines = [...lines.slice(0, labelEnd), ...lines.slice(labelEnd + 1)];
			}
			// A folded label-only message renders as a standalone ✻ line —
			// treat it as a compressed line so spacing applies in compact too.
			const visible = lines.filter((line) => !isBlankLine(line));
			if (child.hideThinkingBlock === true && visible.length > 0 && visible.every((line) => line.includes("✻"))) {
				pushCompressed(child, lines);
				return;
			}
		}
		pushChild(child, lines);
	};

	let i = 0;
	while (i < children.length) {
		const child = children[i];
		if (isUserMessage(child)) {
			let j = i + 1;
			while (j < children.length && !isUserMessage(children[j])) j++;
			const turnChildren = children.slice(i + 1, j);
			// Claude-Code style: no turn-level line at all. The prompt, the
			// messages (thinking behind ✻ labels), and per-group tool lines
			// render directly.
			renderChild(child);
			renderExpandedTurn(turnChildren, {
				push,
				pushChild,
				pushCompressed,
				lastCompressed: () => lastCompressedLine,
				renderChild,
			}, width);
			i = j;
		} else {
			renderChild(child);
			i++;
		}
	}
	if (DEBUG_LOG && (dumpCount = (dumpCount + 1) % 300) === 1) {
		out.forEach((line, idx) => debug(`L${idx}: ${JSON.stringify(line.slice(0, 120))}`));
	}
	profileFrame(container, width, out.length, Date.now() - frameStart);
	if (!agentActive) {
		renderCache = { container, width, at: Date.now(), lines: out, segments: childSegments, heads: collapsedRunHeads };
	}
	return out;
}

/**
 * Opt-in frame probe (OPEN_TUI_PROFILE=<path>): logs walk duration, child and
 * line counts for slow frames — rate-limited to one line per second, zero cost
 * when unset. Answers "is the transcript walk the lag source" with data.
 */
const PROFILE_LOG = process.env.OPEN_TUI_PROFILE;
let profileLastLog = 0;
function profileFrame(container: ChatContainer, width: number, lines: number, durationMs: number): void {
	if (!PROFILE_LOG || durationMs < 4) return;
	const now = Date.now();
	if (now - profileLastLog < 1000) return;
	profileLastLog = now;
	try {
		// eslint-disable-next-line @typescript-eslint/no-require-imports
		const fs = require("node:fs") as typeof import("node:fs");
		fs.appendFileSync(
			PROFILE_LOG,
			`${now} walk ${durationMs.toFixed(1)}ms children=${(container.children ?? []).length} lines=${lines} width=${width} mode=${collapse.mode} style=${collapse.style}\n`,
		);
	} catch {
		// Diagnostics are best-effort.
	}
}

let attachedContainer: unknown;
/** Error blocks held back during an agent run — only the newest is kept. */
let heldErrorGroup: unknown[] = [];
let agentActive = false;
/** Where flushed errors land (production: container.addChild; tests: array). */
let errorSink: ((children: unknown[]) => void) | undefined;

/** Called by index.ts: true while an agent run is streaming/retrying. */
export function setAgentActive(active: boolean): void {
	agentActive = active;
	bustRenderCache();
	if (!active) flushHeldErrors();
}

function flushHeldErrors(): void {
	heldErrorSummary = undefined;
	bustRenderCache();
	if (heldErrorGroup.length === 0 || errorSink === undefined) return;
	const group = heldErrorGroup;
	heldErrorGroup = [];
	errorSink(group);
	requestRenderRef?.();
}

/** Short summary of a held retry error for the retry indicator line. */
let heldErrorSummary: string | undefined;

/**
 * 'Error: 429 {"type":"error","error":{"type":"rate_limit_error"...}}'
 * → "429 rate_limit_error"; falls back to the leading text truncated.
 */
export function summarizeErrorLines(lines: string[]): string | undefined {
	const first = lines.find((line) => !isBlankLine(line));
	if (first === undefined) return undefined;
	const stripped = first.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "").trimStart();
	if (!stripped.startsWith("Error:")) return undefined;
	const plain = stripped.replace(/^Error:\s*/, "").trim();
	if (plain.length === 0) return undefined;
	const code = plain.match(/^(\d{3})\b/)?.[1];
	// Prefer the innermost error type ("error":{"type":X}); the wrapper's
	// own "type":"error" carries no information.
	const type = [...plain.matchAll(/"type\":\"([a-z_]+)\"/gi)].map((m) => m[1]).find((t) => t !== "error")
		?? plain.match(/"code\":\"([a-z0-9_]+)\"/i)?.[1];
	if (code !== undefined && type !== undefined) return `${code} ${type}`;
	if (code !== undefined) return code;
	return plain.slice(0, 60);
}

const RETRY_LINE = /^Retrying \(\d+\/\d+\) in /;
const LOADER_PATCHED = Symbol.for("open-tui.retryErrorSummary");

/** Appends the held error summary to retry indicator lines. */
function installRetrySummaryPatch(): () => void {
	try {
		// eslint-disable-next-line @typescript-eslint/no-require-imports
		const piTui = require("@earendil-works/pi-tui") as {
			Loader?: { prototype?: Record<PropertyKey, unknown> & { setMessage?: (message?: string) => void } };
		};
		const proto = piTui?.Loader?.prototype;
		const setMessage = proto?.setMessage;
		if (!proto || typeof setMessage !== "function" || proto[LOADER_PATCHED] === true) {
			return () => {};
		}
		proto.setMessage = function (message?: string) {
			if (
				typeof message === "string" &&
				RETRY_LINE.test(message) &&
				heldErrorSummary !== undefined
			) {
				message = `${message} · ${heldErrorSummary}`;
			}
			return setMessage.call(this, message);
		};
		proto[LOADER_PATCHED] = true;
		return () => {
			delete proto[LOADER_PATCHED];
			proto.setMessage = setMessage;
		};
	} catch {
		return () => {};
	}
}

/** A pi showError Text: first visible line starts with "Error:". */
function isErrorTextChild(child: unknown): boolean {
	if (typeof child !== "object" || child === null) return false;
	if ((child as { children?: unknown[] }).children !== undefined) return false;
	const renderable = child as { render?: (width: number) => string[] };
	if (typeof renderable.render !== "function") return false;
	try {
		const lines = renderable.render(200) ?? [];
		const first = lines.find((line) => !isBlankLine(line));
		return first !== undefined && first.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "").trimStart().startsWith("Error:");
	} catch {
		return false;
	}
}

/**
 * Translate a line index from the hit leaf's coordinate space (pi's opaque
 * scroll-child wrapper, whose lines include sibling banners before our
 * container) into our attached container's own render coordinates. Returns
 * undefined when the leaf is unrelated.
 */
export function lineIndexInAttachedContainer(leaf: unknown, leafLineIndex: number, width: number): number | undefined {
	if (leaf === attachedContainer) return leafLineIndex;
	if (typeof leaf !== "object" || leaf === null) return undefined;
	const kids = (leaf as { children?: unknown[] }).children;
	if (!Array.isArray(kids)) return undefined;
	let offset = 0;
	for (const kid of kids) {
		if (kid === attachedContainer) return leafLineIndex - offset;
		if (typeof kid !== "object" || kid === null) continue;
		const renderable = kid as { render?: (width: number) => string[] };
		if (typeof renderable.render !== "function") continue;
		try {
			offset += renderable.render(width).length;
		} catch {
			// best-effort
		}
	}
	return undefined;
}

/**
 * Restores the chat container to its pristine render/addChild and drops all
 * interception state. Safe to call from any module instance (extension
 * /reload) and when nothing is attached. No-ops on legacy patches without
 * reclaim bookkeeping to keep the display working.
 */
function detachFromContainer(): void {
	const container = (globalThis as Record<symbol, unknown>)[CONTAINER_SLOT];
	if (typeof container !== "object" || container === null) return;
	const target = container as ChatContainer & {
		[ATTACHED]?: boolean;
		[ORIGINAL_RENDER]?: ChatContainer["render"];
		[ORIGINAL_ADD_CHILD]?: (child: unknown) => void;
	};
	if (target[ATTACHED] !== true) return;
	if (typeof target[ORIGINAL_RENDER] === "function") target.render = target[ORIGINAL_RENDER];
	if (typeof target[ORIGINAL_ADD_CHILD] === "function") target.addChild = target[ORIGINAL_ADD_CHILD];
	delete target[ATTACHED];
	(globalThis as Record<symbol, unknown>)[CONTAINER_SLOT] = undefined;
	attachedContainer = undefined;
	childSegments = [];
	bustRenderCache();
	errorSink = undefined;
	heldErrorGroup = [];
	heldErrorSummary = undefined;
	collapsedRunHeads = new Set();
	debug("detach: container restored to pristine render/addChild");
	requestRenderRef?.();
}

/** Uninstalls every turn-collapse modification, even across /reload instances. */
export function uninstallTurnCollapse(): void {
	detachFromContainer();
}

/** Keeps arrivals in sync with the thought preference; see setThoughtPreference. */
function syncThoughtPreference(child: AssistantLike): void {
	if (thoughtPref === undefined) return;
	// An arriving message's initial hideThinkingBlock IS pi's in-memory global
	// flag. When it flips underneath us (ctrl+t / pi's settings UI), the flip
	// wins and becomes an explicit preference state; otherwise our choice wins.
	const arriving = child.hideThinkingBlock === true;
	if (lastObservedPiFlag !== undefined && arriving !== lastObservedPiFlag) {
		thoughtPref = arriving ? "single" : "expand";
		collapse = { ...collapse, thought: thoughtPref };
	}
	lastObservedPiFlag = arriving;
	// During an active run with live thinking, arriving messages start
	// unhidden so the first thinking frame streams inline instead of flashing
	// a ✻ label; classification maintains the state from there.
	const hidden = thoughtTreatment() !== "expand" && !(collapse.liveThinking && agentActive);
	if (arriving !== hidden) {
		child.setHideThinkingBlock(hidden);
	}
}

function attachToContainer(container: unknown): void {
	if (typeof container !== "object" || container === null) {
		debug("attach: no container");
		return;
	}
	const target = container as ChatContainer & {
		[ATTACHED]?: boolean;
		[ORIGINAL_RENDER]?: ChatContainer["render"];
		[ORIGINAL_ADD_CHILD]?: (child: unknown) => void;
	};
	if (target[ATTACHED] === true) {
		// A previous module instance (extension /reload) patched this container;
		// its render override still collapses, but segment recording lands in
		// that dead instance's state, so click lookups here find nothing. Restore
		// the pristine methods and re-patch with ours.
		if (typeof target[ORIGINAL_RENDER] !== "function") return; // legacy patch without bookkeeping
		detachFromContainer();
	}
	if (typeof target.render !== "function" || !Array.isArray(target.children)) {
		debug(`attach: unusable shape ctor=${(container as { constructor?: { name?: string } }).constructor?.name}`);
		return;
	}
	target[ATTACHED] = true;
	attachedContainer = container;
	bustRenderCache();
	(globalThis as Record<symbol, unknown>)[CONTAINER_SLOT] = container;
	const addChildRaw = target.addChild as ((child: unknown) => void) | undefined;
	if (typeof addChildRaw === "function") {
		target[ORIGINAL_ADD_CHILD] = addChildRaw;
		const addChild = addChildRaw.bind(target);
		errorSink = (children: unknown[]): void => {
			for (const child of children) addChild(child);
		};
		target.addChild = (child: unknown): void => {
			// During a run, retry errors are held back (when enabled) — only the
			// newest survives, and it renders when the run settles. A successful
			// assistant message drops them entirely (they were transient).
			if (agentActive && collapse.retryErrors && isErrorTextChild(child)) {
				heldErrorGroup = [child];
				heldErrorSummary = summarizeErrorLines(safeRender(child as Child, 200));
				return;
			}
			if (isAssistantMessage(child)) {
				syncThoughtPreference(child);
				heldErrorGroup = [];
				heldErrorSummary = undefined;
			}
			bustRenderCache();
			addChild(child);
		};
	}
	debug(`attach: container ctor=${(container as { constructor?: { name?: string } }).constructor?.name} children=${target.children.length}`);
	const original = target.render;
	target[ORIGINAL_RENDER] = original;
	target.render = function (this: ChatContainer, width: number) {
		return renderCollapsed(this, original as (width: number) => string[], width);
	};
}

/**
 * Find the chat-side container in the rendered layout box tree: the child of
 * the first scroll box (scroll boxes carry a scrollView field). Pure data -
 * no pi-tui internals beyond the box shape are needed.
 */
/**
 * Descend from the scroll child wrapper to the container whose DIRECT children
 * include user or assistant message components (pi's chat container). Returns
 * undefined until the first message is rendered.
 */
function findMessageHolder(wrapper: unknown): unknown {
	let found: unknown;
	const visit = (component: unknown, depth: number): void => {
		if (found !== undefined || depth > 6 || typeof component !== "object" || component === null) return;
		const kids = (component as { children?: unknown[] }).children;
		if (!Array.isArray(kids)) return;
		if (kids.some(isUserMessage) || kids.some(isAssistantMessage)) {
			found = component;
			return;
		}
		for (const kid of kids) {
			if (typeof kid === "object" && kid !== null && Array.isArray((kid as { children?: unknown[] }).children)) {
				visit(kid, depth + 1);
			}
		}
	};
	visit(wrapper, 0);
	return found;
}

function findChatContainerInBoxes(root: unknown): unknown {
	let found: unknown;
	interface BoxLike {
		scrollView?: unknown;
		children?: BoxLike[];
		component?: unknown;
	}
	const visit = (box: unknown, depth: number): void => {
		if (found !== undefined || depth > 12 || typeof box !== "object" || box === null) return;
		const candidate = box as BoxLike;
		if (candidate.scrollView !== undefined && Array.isArray(candidate.children)) {
			const child = candidate.children[0];
			const component = child && (child as BoxLike).component;
			if (
				typeof component === "object" && component !== null &&
				Array.isArray((component as { children?: unknown[] }).children) &&
				typeof (component as { render?: unknown }).render === "function"
			) {
				found = component;
				return;
			}
		}
		for (const child of candidate.children ?? []) visit(child, depth + 1);
	};
	visit(root, 0);
	return found;
}

/** Live instance fields the regular-mode wrap needs (TuiMainScreen). */
interface MainScreenLike {
	children?: unknown[];
	requestRender?: (...args: unknown[]) => void;
}

const MAIN_INSTALLED = Symbol.for("open-tui.turnCollapseMainInstalled");

/**
 * Wraps TuiMainScreen.prototype.requestRender (regular TUI): flags the
 * renderer mode, keeps requestRenderRef pointed at the live renderer, and
 * discovers the chat container by walking the children tree (the regular
 * renderer mounts the document/chat containers directly — there are no
 * layout boxes to walk). Returns the cleanup function, or undefined when the
 * prototype was not wrappable / is already wrapped by another instance.
 */
export function wrapMainScreenRequestRender(proto: object | null | undefined): (() => void) | undefined {
	const target = proto as (MainScreenLike & Record<PropertyKey, unknown>) | null | undefined;
	if (!target || typeof target.requestRender !== "function") {
		debug("install(main): prototype without requestRender, no-op");
		return undefined;
	}
	if (target[MAIN_INSTALLED] === true) {
		debug("install(main): already wrapped");
		return undefined;
	}
	const original = target.requestRender;
	let discovered = false;
	target.requestRender = function (this: MainScreenLike, ...args: unknown[]) {
		rendererMode = "regular";
		try {
			if (typeof this.requestRender === "function") {
				requestRenderRef = () => this.requestRender!();
			}
		} catch {
			// Ref capture is best-effort.
		}
		try {
			if (!discovered) {
				const holder = findMessageHolder(this);
				if (holder !== undefined) {
					debug(`discover(main-screen): attached holder ctor=${(holder as { constructor?: { name?: string } }).constructor?.name}`);
					attachToContainer(holder);
					discovered = true;
				}
			}
		} catch {
			// Discovery is best-effort.
		}
		return (original as (this: MainScreenLike, ...args: unknown[]) => unknown).apply(this, args);
	};
	target[MAIN_INSTALLED] = true;
	debug("install(main): wrapped requestRender");
	return () => {
		delete target[MAIN_INSTALLED];
		target.requestRender = original;
	};
}

/**
 * Installs turn collapsing for the whole process by wrapping the shared
 * TuiAltScreen prototype (the extension resolves the same pi-tui module
 * instance pi core uses). Discovery hooks both setLayoutRoot (mode switches)
 * and requestRender (startup: the initial layout root is mounted before
 * extensions load, so the setLayoutRoot call is already gone by the time we
 * wrap). The TuiMainScreen prototype gets the same treatment for sessions
 * that run in (or switch to) the regular TUI. Silently no-ops on unknown
 * shapes.
 */
export function installTurnCollapse(): () => void {
	try {
		// eslint-disable-next-line @typescript-eslint/no-require-imports
		const piTui = require("@earendil-works/pi-tui") as {
			TuiAltScreen?: { prototype?: ViewportAltScreen & Record<PropertyKey, unknown> };
			TuiMainScreen?: { prototype?: object };
		};
		const proto = piTui?.TuiAltScreen?.prototype;
		debug(`install: proto=${proto !== undefined} setLayoutRoot=${typeof proto?.setLayoutRoot}`);
		let cleanupAlt: (() => void) | undefined;
		if (!proto || typeof proto.setLayoutRoot !== "function" || typeof proto.requestRender !== "function") {
			// No usable alt-screen prototype; the main-screen wrap below still
			// covers regular-mode sessions.
		} else if (proto[COLLAPSE_INSTALLED] === true) {
			debug("install: already installed");
		} else {
			let discovered = false;
			const tryDiscover = (instance: ViewportAltScreen): void => {
				if (discovered) return;
				const root = (instance as { currentLayout?: { root?: unknown } }).currentLayout?.root;
				if (typeof root !== "object" || root === null) return;
				const wrapper = findChatContainerInBoxes(root);
				if (wrapper === undefined) return;
				// The scroll child may be a plain wrapper; the messages live in a
				// nested container that directly holds user/assistant components.
				const holder = findMessageHolder(wrapper);
				if (holder === undefined) return; // no messages yet — retry on later renders
				debug(`discover(requestRender): attached holder ctor=${(holder as { constructor?: { name?: string } }).constructor?.name}`);
				attachToContainer(holder);
				discovered = true;
			};
			const originalSetLayoutRoot = proto.setLayoutRoot as (this: ViewportAltScreen, component: unknown) => void;
			proto.setLayoutRoot = function (this: ViewportAltScreen & { requestRender?: () => void }, component: unknown) {
				const result = originalSetLayoutRoot.call(this, component);
				try {
					rendererMode = "fullscreen";
					if (typeof this.requestRender === "function") {
						requestRenderRef = () => this.requestRender!();
					}
				} catch {
					// Ref capture is best-effort.
				}
				return result;
			};
			const originalRequestRender = proto.requestRender as (this: ViewportAltScreen, ...args: unknown[]) => void;
			proto.requestRender = function (this: ViewportAltScreen, ...args: unknown[]) {
				rendererMode = "fullscreen";
				try {
					if (typeof this.requestRender === "function") {
						requestRenderRef = () => this.requestRender!();
					}
				} catch {
					// Ref capture is best-effort.
				}
				try {
					tryDiscover(this);
				} catch {
					// Discovery is best-effort.
				}
				return originalRequestRender.apply(this, args);
			};
			proto[COLLAPSE_INSTALLED] = true;
			const cleanupAltFn = () => {
				delete proto[COLLAPSE_INSTALLED];
				proto.setLayoutRoot = originalSetLayoutRoot;
				proto.requestRender = originalRequestRender;
			};
			cleanupAlt = cleanupAltFn;
			debug("install: wrapped setLayoutRoot + requestRender");
		}
		const cleanupMain = wrapMainScreenRequestRender(piTui?.TuiMainScreen?.prototype);
		if (cleanupAlt === undefined && cleanupMain === undefined) return () => {};
		const cleanupRetryPatch = installRetrySummaryPatch();
		return () => {
			cleanupAlt?.();
			cleanupMain?.();
			cleanupRetryPatch();
			detachFromContainer();
		};
	} catch (error) {
		debug(`install: failed: ${error instanceof Error ? error.message : String(error)}`);
		return () => {};
	}
}

/** Test hook: attach the container patch like installTurnCollapse would. */
export function attachForTest(container: unknown): void {
	attachToContainer(container);
}

/** Test hook: a container-like object with the same addChild interception. */
export function makeInterceptedContainer(): {
	children: unknown[];
	addChild(child: unknown): void;
	render(width: number): string[];
} {
	const container = { children: [] as unknown[] };
	const state = { children: container.children };
	errorSink = (children: unknown[]): void => {
		state.children.push(...children);
	};
	return {
		get children() {
			return state.children;
		},
		addChild(child: unknown): void {
			if (agentActive && collapse.retryErrors && isErrorTextChild(child)) {
				heldErrorGroup = [child];
				heldErrorSummary = summarizeErrorLines(safeRender(child as Child, 200));
				return;
			}
			if (isAssistantMessage(child)) {
				syncThoughtPreference(child);
				heldErrorGroup = [];
				heldErrorSummary = undefined;
			}
			bustRenderCache();
			state.children.push(child);
		},
		render(width: number): string[] {
			return renderCollapsedForTest(this, width);
		},
	};
}

/** Test hook: run the collapsed render against a container-like object. */
export function renderCollapsedForTest(container: { children?: unknown[] }, width: number): string[] {
	const original = (w: number): string[] => {
		const out: string[] = [];
		for (const child of (container.children ?? []) as unknown[]) {
			for (const line of safeRender(child as Child, w)) out.push(line);
		}
		return out;
	};
	return renderCollapsed(container as ChatContainer, original, width);
}
