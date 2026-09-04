/**
 * Claude-style turn collapsing (fullscreen TUI).
 *
 * After an agent run settles, everything it did — thinking blocks, tool and
 * bash executions — collapses into one clickable summary line:
 *
 *   ▸ ✻ Thought for 11s · called playwright ×3 · ran 1 shell command
 *
 * Assistant answer text stays visible. While the agent is working the turn
 * streams normally. Clicking the line expands the whole turn (thinking stays
 * behind per-message ✻ labels, individually clickable); clicking again
 * re-collapses it.
 *
 * Mechanism (version-guarded, inert on mismatch — same policy as
 * fullscreen-scroll.ts / thinking-click.ts):
 *
 * 1. TuiAltScreen.prototype.setLayoutRoot is wrapped to discover the chat-side
 *    container: getLayoutNode walks the root stack to the ScrollView, whose
 *    child component IS pi's chat container (verified against the real runtime).
 * 2. The container's render is overridden on the instance: children are grouped
 *    into turns by UserMessageComponent boundaries; a collapsed turn renders
 *    its assistant messages (thinking forced hidden), skips tool boxes and
 *    spacers, and emits the summary line. Render also records line segments so
 *    clicks can map a screen line back to its turn.
 * 3. tool counts come from the components themselves (works for history too);
 *    thinking duration comes from the live telemetry fed at agent_settled.
 */

import type { Theme } from "@earendil-works/pi-coding-agent";

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
}

interface ViewportAltScreen {
	setLayoutRoot?: (component: unknown) => void;
	requestRender?: (...args: unknown[]) => void;
	layoutRoot?: unknown;
}

const ATTACHED = Symbol.for("open-tui.turnCollapse");
const COLLAPSE_INSTALLED = Symbol.for("open-tui.turnCollapseInstalled");

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
/** Heads of runs rendered as collapsed lines this frame. */
let collapsedRunHeads = new Set<object>();
/** member child -> run head (expanded runs collapse via any member line). */
const runMembership = new Map<object, object>();
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
function syncThinkingLabel(child: unknown): void {
	const candidate = child as {
		isStreaming?: unknown;
		hiddenThinkingLabel?: unknown;
		setHiddenThinkingLabel?: (label: string) => void;
	};
	if (typeof candidate.setHiddenThinkingLabel !== "function") return;
	const desired = candidate.isStreaming === true ? "✻ Thinking…" : "✻ Thought…";
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
let enabled = true;

export function setTurnCollapseEnabled(value: boolean): void {
	enabled = value;
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
	renderChild: (child: unknown) => void;
}

interface ExpandedWalk {
	push: (lines: string[]) => void;
	pushChild: (child: unknown, lines: string[]) => void;
	renderChild: (child: unknown) => void;
}

type RunMember =
	| { kind: "label"; child: unknown }
	| { kind: "tool"; child: unknown }
	/** A text-bearing message whose leading ✻ label was absorbed into the run. */
	| { kind: "text-tail"; child: unknown };

/**
 * Claude-Code style run merging: consecutive label-only messages and tool
 * groups (with nothing visible between) collapse into ONE line:
 *   ✻ Thought for 19s, searched for 9 patterns, ran 1 shell command
 */
function renderExpandedTurn(turnChildren: unknown[], walk: ExpandedWalk, width: number): void {
	const completedTool = (candidate: unknown): boolean =>
		isToolBox(candidate) && !isToolRunning(candidate);

	const isTransparent = (candidate: unknown): boolean => {
		if (isSpacer(candidate)) return true;
		if (isToolBox(candidate)) return false;
		const lines = safeRender(candidate as Child, width);
		return lines.length === 0 || lines.every((line) => isBlankLine(line));
	};

	// Classify assistant messages by CONTENT, not by what they currently
	// render: expanding a run flips hideThinkingBlock, which would otherwise
	// re-classify label members as text on the next frame, rebuild the runs,
	// and self-destruct the expanded state.
	const classify = (child: unknown): "label" | "transparent" | "text" | "other" => {
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
		if (hasText) return "text";
		if (hasThinking) return "label";
		return "transparent";
	};

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

	const flushRun = (): void => {
		if (runMembers.length === 0) return;
		const head = (runMembers[0]!.child as object);
		const tools = runMembers.filter((member) => member.kind === "tool");
		const hasThinking = runMembers.some((member) => member.kind !== "tool");
		const thinkingMs = runMembers.reduce((sum, member) => {
			if (member.kind === "tool") return sum;
			return sum + ((member.child as { __openTuiThinkingMs?: number }).__openTuiThinkingMs ?? 0);
		}, 0);
		if (enabled && !runLive && !(tools.length === 0 && thinkingMs < 1000 && !hasThinking)) {
			if (expandedRuns.has(head)) {
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
				walk.pushChild(head, [renderRunLine(runMembers)]);
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
		} else if (enabled && !runLive) {
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
					if (!enabled) {
						walk.renderChild(member.child);
						continue;
					}
					// Running tool: animated one-liner + the live box below.
					if (isToolRunning(member.child)) {
						walk.pushChild(member.child, [renderToolLine(member.child, fg("accent", spinnerFrame()))]);
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
		if (isTransparent(current)) {
			// Absorbed while a run is open; otherwise rendered as padding.
			if (runMembers.length > 0) {
				index++;
				continue;
			}
			walk.renderChild(current);
			index++;
			continue;
		}
		if (completedTool(current)) {
			runMembers.push({ kind: "tool", child: current });
			index++;
			continue;
		}
		if (isToolBox(current)) {
			// A running tool must not drag already-completed members into the
			// live (expanded) render — fold them into their own line first.
			if (runMembers.length > 0 && !runLive) flushRun();
			runMembers.push({ kind: "tool", child: current });
			runLive = true;
			index++;
			continue;
		}
		const kind = classify(current);
		if (kind === "label") {
			if ((current as { isStreaming?: unknown }).isStreaming === true && runMembers.length > 0 && !runLive) {
				// Same for a streaming thinking message following completed work.
				flushRun();
			}
			runMembers.push({ kind: "label", child: current });
			if (runIsLive(runMembers)) runLive = true;
			index++;
			continue;
		}
		if (kind === "text" && runMembers.length > 0 && !runLive && (current as { __openTuiHasThinking?: boolean }).__openTuiHasThinking === true) {
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
		walk.renderChild(current);
		index++;
	}
	flushRun();
}

// A line is blank when it is empty or consists solely of zero-width control
// sequences — CSI ([...m) and OSC (]..., incl. pi's 133 shell
// integration markers that land on spacer lines).
const ZERO_WIDTH_LINE = /^(?:\x1b\[[0-9;?]*[A-Za-z]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\))*$/;

function isBlankLine(line: string): boolean {
	return line === "" || ZERO_WIDTH_LINE.test(line);
}

function startsWithLabel(lines: string[]): boolean {
	const first = lines.find((line) => !isBlankLine(line));
	return first !== undefined && first.includes("✻");
}

let renderLogState: string | undefined;
let dumpCount = 0;

function renderCollapsed(container: ChatContainer, original: (width: number) => string[], width: number): string[] {
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

	const push = (lines: string[]): void => {
		for (const line of lines) {
			out.push(line);
			cursor++;
		}
	};
	const pushChild = (child: unknown, lines: string[]): void => {
		const start = cursor;
		push(lines);
		if (cursor > start) childSegments.push({ start, end: cursor, child });
	};
	const renderChild = (child: unknown): void => {
		if (isAssistantMessage(child)) syncThinkingLabel(child);

		let lines = safeRender(child as Child, width);
		if (isAssistantMessage(child) && startsWithLabel(lines)) {
			// Compact transcript: pi renders a leading Spacer inside the
			// message and another after the thinking label; drop both so the
			// ✻ line sits flush and connects straight to the following text.
			while (lines.length > 0 && isBlankLine(lines[0]!)) lines = lines.slice(1);
			let labelEnd = 0;
			while (labelEnd < lines.length && !isBlankLine(lines[labelEnd]!) && lines[labelEnd]!.includes("✻")) {
				labelEnd++;
			}
			while (labelEnd < lines.length && isBlankLine(lines[labelEnd]!)) {
				lines = [...lines.slice(0, labelEnd), ...lines.slice(labelEnd + 1)];
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
	return out;
}

let attachedContainer: unknown;

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

function attachToContainer(container: unknown): void {
	if (typeof container !== "object" || container === null) {
		debug("attach: no container");
		return;
	}
	const target = container as ChatContainer & { [ATTACHED]?: boolean };
	if (target[ATTACHED] === true) return;
	if (typeof target.render !== "function" || !Array.isArray(target.children)) {
		debug(`attach: unusable shape ctor=${(container as { constructor?: { name?: string } }).constructor?.name}`);
		return;
	}
	target[ATTACHED] = true;
	attachedContainer = container;
	debug(`attach: container ctor=${(container as { constructor?: { name?: string } }).constructor?.name} children=${target.children.length}`);
	const original = target.render;
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

/**
 * Installs turn collapsing for the whole process by wrapping the shared
 * TuiAltScreen prototype (the extension resolves the same pi-tui module
 * instance pi core uses). Discovery hooks both setLayoutRoot (mode switches)
 * and requestRender (startup: the initial layout root is mounted before
 * extensions load, so the setLayoutRoot call is already gone by the time we
 * wrap). Silently no-ops on unknown shapes.
 */
export function installTurnCollapse(): () => void {
	try {
		// eslint-disable-next-line @typescript-eslint/no-require-imports
		const piTui = require("@earendil-works/pi-tui") as {
			TuiAltScreen?: { prototype?: ViewportAltScreen & Record<PropertyKey, unknown> };
		};
		const proto = piTui?.TuiAltScreen?.prototype;
		debug(`install: proto=${proto !== undefined} setLayoutRoot=${typeof proto?.setLayoutRoot}`);
		if (!proto || typeof proto.setLayoutRoot !== "function" || typeof proto.requestRender !== "function") {
			return () => {};
		}
		if (proto[COLLAPSE_INSTALLED] === true) {
			debug("install: already installed");
			return () => {};
		}
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
			try {
				tryDiscover(this);
			} catch {
				// Discovery is best-effort.
			}
			return originalRequestRender.apply(this, args);
		};
		proto[COLLAPSE_INSTALLED] = true;
		debug("install: wrapped setLayoutRoot + requestRender");
		return () => {
			delete proto[COLLAPSE_INSTALLED];
			proto.setLayoutRoot = originalSetLayoutRoot;
			proto.requestRender = originalRequestRender;
		};
	} catch (error) {
		debug(`install: failed: ${error instanceof Error ? error.message : String(error)}`);
		return () => {};
	}
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
