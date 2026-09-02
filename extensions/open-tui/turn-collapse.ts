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

interface TurnSummaryData {
	thinkingMs: number | null;
}

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

/** Turns the user explicitly expanded (everything else collapses when idle). */
const expandedTurns = new WeakSet<object>();
/** Tool boxes the user expanded to their full bordered output (within expanded turns). */
const expandedTools = new WeakSet<object>();

function truncate(text: string, max: number): string {
	return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** Claude-style one-liner for a tool box: `⏺ bash · $ echo hi`. */
function renderToolLine(child: unknown): string {
	const marker = fg("accent", "⏺");
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

/** Click routing for tool one-liners inside expanded turns. */
export function handleToolLineClick(lineIndex: number, line: string): boolean {
	if (!line.includes("⏺")) return false;
	for (const segment of childSegments) {
		if (lineIndex >= segment.start && lineIndex < segment.end && isToolBox(segment.child)) {
			if (expandedTools.has(segment.child)) {
				expandedTools.delete(segment.child);
			} else {
				expandedTools.add(segment.child);
			}
			requestRenderRef?.();
			return true;
		}
	}
	return false;
}
/** Live thinking duration per turn, keyed by the turn's user message component. */
const liveSummaries = new WeakMap<object, TurnSummaryData>();
/** Line segments (in container render output) covered by summary lines. */
let summarySegments: Array<{ start: number; end: number; key: object }> = [];
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

/** Segment lookup for the click pipeline: the child that rendered a line. */
export function findThinkingHostViaSegments(lineIndex: number): unknown | undefined {
	for (const segment of childSegments) {
		if (lineIndex >= segment.start && lineIndex < segment.end) {
			return isAssistantMessage(segment.child) ? segment.child : undefined;
		}
	}
	return undefined;
}
/** Key of the most recent turn seen while rendering (live summary target). */
let currentTurnKey: object | undefined;

let agentWorking = false;
let themeRef: Theme | undefined;
let requestRenderRef: (() => void) | undefined;
let enabled = true;

export function setTurnCollapseEnabled(value: boolean): void {
	enabled = value;
}

export function setAgentWorking(working: boolean): void {
	agentWorking = working;
}

export function setTurnCollapseTheme(theme: Theme): void {
	themeRef = theme;
}

export function setTurnCollapseRender(requestRender: () => void): void {
	requestRenderRef = requestRender;
}

/** Feed the settled run's thinking duration onto the turn rendered last. */
export function attachLiveSummary(data: TurnSummaryData | undefined): void {
	if (!currentTurnKey || !data) return;
	liveSummaries.set(currentTurnKey, data);
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
	let bash = 0;
	for (const child of turnChildren) {
		if (!isToolBox(child)) continue;
		if (typeof (child as { command?: unknown }).command === "string") {
			bash++;
			continue;
		}
		const name = (child as { toolName?: string }).toolName ?? "tool";
		// The agent's bash tool renders as a generic ToolExecutionComponent.
		if (name === "bash") {
			bash++;
			continue;
		}
		counts.set(name, (counts.get(name) ?? 0) + 1);
	}
	const parts: string[] = [];
	if (counts.size > 0) {
		const names = [...counts.entries()].map(([name, n]) => (n > 1 ? `${name} ×${n}` : name));
		parts.push(`called ${names.join(", ")}`);
	}
	if (bash > 0) parts.push(`ran ${bash} shell command${bash > 1 ? "s" : ""}`);
	return parts;
}

function renderSummaryLine(key: object, turnChildren: unknown[], expanded: boolean): string {
	const parts: string[] = [];
	const live = liveSummaries.get(key);
	if (live && live.thinkingMs !== null && live.thinkingMs >= 1000) {
		parts.push(`Thought for ${formatDuration(live.thinkingMs)}`);
	}
	parts.push(...summarizeTools(turnChildren));
	const arrow = fg("accent", expanded ? "▾" : "▸");
	const text = parts.length > 0 ? parts.join(" · ") : "turn";
	return ` ${arrow} ${fg("muted", `✻ ${text}`)}`;
}

/** Toggle handler wired into the shared mouse pipeline. */
export function handleTurnLineClick(lineIndex: number, line: string): boolean {
	if (!line.includes("▸") && !line.includes("▾")) return false;
	const segment = summarySegments.find((s) => lineIndex >= s.start && lineIndex < s.end);
	if (!segment) return false;
	if (expandedTurns.has(segment.key)) {
		expandedTurns.delete(segment.key);
	} else {
		expandedTurns.add(segment.key);
	}
	requestRenderRef?.();
	return true;
}

let renderLogState: string | undefined;

function renderCollapsed(container: ChatContainer, original: (width: number) => string[], width: number): string[] {
	// The walk below replaces Container.render entirely. Disabling collapse does
	// not skip it: per-message labels and click segments still need the walk.
	void original;
	const children = (container.children ?? []) as unknown[];
	const userCount = children.filter(isUserMessage).length;
	const renderState = `${children.length}:${userCount}:${agentWorking}:${enabled}`;
	if (renderLogState !== renderState) {
		renderLogState = renderState;
		debug(`render: children=${children.length} userMsgs=${userCount} working=${agentWorking}`);
	}
	const out: string[] = [];
	summarySegments = [];
	childSegments = [];
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
		pushChild(child, safeRender(child as Child, width));
	};

	let i = 0;
	while (i < children.length) {
		const child = children[i];
		if (isUserMessage(child)) {
			const key = child;
			currentTurnKey = key;
			let j = i + 1;
			while (j < children.length && !isUserMessage(children[j])) j++;
			const turnChildren = children.slice(i + 1, j);
			const isLast = j >= children.length;
			const working = agentWorking && isLast;
			const collapsed = enabled && !working && !expandedTurns.has(key);
			if (collapsed) {
				debug(`collapse turn: turnChildren=${turnChildren.length}`);
				// The prompt itself stays visible; the summary replaces its effects.
				renderChild(child);
				push([renderSummaryLine(key, turnChildren, false)]);
				summarySegments.push({ start: cursor - 1, end: cursor, key });
				for (const turnChild of turnChildren) {
					if (isSpacer(turnChild) || isToolBox(turnChild)) {
						continue; // hidden while collapsed
					}
					if (isAssistantMessage(turnChild) && turnChild.hideThinkingBlock !== true) {
						turnChild.setHideThinkingBlock(true);
					}
					renderChild(turnChild);
				}
			} else {
				renderChild(child);
				// Expanded turns keep a ▸/▾ handle so one click re-collapses.
				if (enabled) {
					push([renderSummaryLine(key, turnChildren, true)]);
					summarySegments.push({ start: cursor - 1, end: cursor, key });
				}
				for (const turnChild of turnChildren) {
					// Claude-style: completed tool calls render as one-liners;
					// click to open the full bordered box (header line stays on
					// top as the collapse handle). Live (working) boxes stream
					// at full size.
					if (!working && enabled && isToolBox(turnChild)) {
						if (expandedTools.has(turnChild)) {
							const boxLines = safeRender(turnChild as Child, width);
							pushChild(turnChild, [renderToolLine(turnChild), ...boxLines]);
						} else {
							pushChild(turnChild, [renderToolLine(turnChild)]);
						}
						continue;
					}
					renderChild(turnChild);
				}
			}
			i = j;
		} else {
			renderChild(child);
			i++;
		}
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
