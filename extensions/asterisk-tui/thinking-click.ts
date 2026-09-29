import {
	handleToolLineClick,
	findThinkingHostViaSegments,
	lineIndexInAttachedContainer,
} from "./turn-collapse.ts";
/**
 * Click-to-expand for hidden thinking blocks (fullscreen TUI only).
 *
 * pi renders hidden thinking as a static label line; there is no per-message
 * expansion or component-level mouse routing. Two runtime details make it
 * work anyway (both version-guarded, inert on mismatch — same policy as
 * fullscreen-scroll.ts):
 *
 * 1. TuiAltScreen.prototype.handleViewportInput — wrapped once per process.
 *    The extension resolves the SAME pi-tui module instance pi core uses,
 *    so the wrap survives switchTuiMode instance swaps and applies even
 *    before the first fullscreen instance exists (sessions that start in
 *    regular mode and switch later via /settings).
 * 2. currentLayout — layout boxes carry screen-space rects (scroll already
 *    applied) plus the rendered lines of opaque leaves.
 *
 * pi-tui only puts Stack/ScrollView components into the box tree; plain
 * Containers (pi's chat container, and every AssistantMessageComponent inside
 * it) are opaque leaves. The chat leaf's component therefore IS pi's chat
 * container, and since Container.render concatenates its children exactly,
 * a clicked line index maps 1:1 onto the child that rendered it. We use that
 * to find the owning AssistantMessageComponent and flip its
 * setHideThinkingBlock — per message, not pi's global ctrl+t.
 *
 * Interaction: a click is an unmodified primary press that releases on the
 * same cell — drags (pi's fullscreen text selection) never trigger it. Click
 * the "✻ Thought…"/"✻ Thinking…" label to expand that message's thinking
 * inline; click anywhere in the expanded message to collapse it back to the
 * label. Mouse events are never consumed: pi-tui's own selection state
 * machine sees every press/motion/release, and a completed click is a
 * same-cell release, which no-ops on its side.
 */

const LABEL_MARKERS = ["✻ Thinking", "✻ Thought"] as const;

/** Matches any SGR mouse sequence: `\x1b[<button;x;yM|m` (press/motion/release). */
const SGR_MOUSE = /^\x1b\[<(\d+);(\d+);(\d+)([Mm])$/;

/** A parsed SGR mouse event (button incl. modifier/motion bits, 0-based cell). */
export interface SgrMouseEvent {
	button: number;
	x: number;
	y: number;
	release: boolean;
}

/** Parses any SGR mouse sequence: presses, motion, and releases, any button. */
export function parseSgrMouseEvent(data: string): SgrMouseEvent | undefined {
	const match = SGR_MOUSE.exec(data);
	if (!match) return undefined;
	return {
		button: Number.parseInt(match[1]!, 10),
		x: Number.parseInt(match[2]!, 10) - 1,
		y: Number.parseInt(match[3]!, 10) - 1,
		release: match[4] === "m",
	};
}

const ANSI_CODE = /\x1b\[[0-9;?]*[A-Za-z]/g;

const DEBUG_LOG = process.env.OPEN_TUI_DEBUG;
function debug(message: string): void {
	if (!DEBUG_LOG) return;
	try {
		// eslint-disable-next-line @typescript-eslint/no-require-imports
		const fs = require("node:fs") as typeof import("node:fs");
		fs.appendFileSync(DEBUG_LOG, `${Date.now()} [thinking-click] ${message}\n`);
	} catch {
		// Diagnostics are best-effort.
	}
}

interface LayoutRect {
	x: number;
	y: number;
	width: number;
	height: number;
}

interface LayoutBox {
	component: unknown;
	rect: LayoutRect;
	clip?: LayoutRect;
	children: LayoutBox[];
	parent?: LayoutBox;
	lines?: readonly string[];
	lineOffset?: number;
}

interface ThinkingHost {
	setHideThinkingBlock(hide: boolean): void;
	hideThinkingBlock?: boolean;
}

/** Live instance fields the wrapped handler needs (TuiAltScreen). */
interface ViewportInstance {
	currentLayout?: { root?: LayoutBox } | undefined;
	requestRender: () => void;
}

function isThinkingHost(component: unknown): component is ThinkingHost {
	if (component === null || typeof component !== "object") return false;
	const candidate = component as Partial<ThinkingHost>;
	return typeof candidate.setHideThinkingBlock === "function" && typeof candidate.hideThinkingBlock === "boolean";
}

export function parseSgrPrimaryPress(data: string): { x: number; y: number } | undefined {
	const match = SGR_MOUSE.exec(data);
	if (!match || match[4] !== "M" || Number.parseInt(match[1]!, 10) !== 0) return undefined;
	return { x: Number.parseInt(match[2]!, 10) - 1, y: Number.parseInt(match[3]!, 10) - 1 };
}

/** Deepest leaf box whose (clipped) rect contains the point, plus the line under it. */
export function hitTestLeaf(
	root: LayoutBox,
	x: number,
	y: number,
): { box: LayoutBox; line: string; lineIndex: number } | undefined {
	let hit: { box: LayoutBox; line: string; lineIndex: number } | undefined;
	const visit = (box: LayoutBox): void => {
		const rect = box.rect;
		const clip = box.clip ?? rect;
		const contains =
			x >= rect.x && x < rect.x + rect.width && y >= rect.y && y < rect.y + rect.height &&
			x >= clip.x && x < clip.x + clip.width && y >= clip.y && y < clip.y + clip.height;
		if (contains && box.children.length === 0 && box.lines && box.lines.length > 0) {
			const lineIndex = (box.lineOffset ?? 0) + y - rect.y;
			const line = box.lines[lineIndex];
			if (typeof line === "string") hit = { box, line, lineIndex };
		}
		for (const child of box.children) visit(child);
	};
	visit(root);
	return hit;
}

/**
 * Map a line index in a container's flattened render output to the thinking
 * host that rendered it, descending through nested Containers. Container.render
 * concatenates children exactly, so cumulative rendered heights give an exact
 * mapping; heights are measured on demand (clicks are rare, correctness beats
 * caching). Returns undefined when the line belongs to something else.
 */
export function findThinkingHostAtLine(
	container: { children?: unknown[] },
	lineIndex: number,
	width: number,
	depth = 0,
): ThinkingHost | undefined {
	const children = container.children;
	if (!Array.isArray(children) || depth > 8) return undefined;
	let cursor = 0;
	for (const child of children) {
		if (typeof child !== "object" || child === null) continue;
		const renderable = child as { render?: (width: number) => string[] };
		if (typeof renderable.render !== "function") continue;
		let height = 0;
		try {
			height = renderable.render(width).length;
		} catch {
			continue;
		}
		if (lineIndex < cursor + height) {
			if (isThinkingHost(child)) return child;
			const grandChildren = (child as { children?: unknown[] }).children;
			if (Array.isArray(grandChildren) && grandChildren.length > 0) {
				return findThinkingHostAtLine(child as { children?: unknown[] }, lineIndex - cursor, width, depth + 1);
			}
			return undefined;
		}
		cursor += height;
	}
	return undefined;
}

/** Column span of the ✻ label on its rendered line, if this line is a label. */
export function labelSpan(line: string): { start: number; end: number } | undefined {
	const plain = line.replace(ANSI_CODE, "");
	const marker = LABEL_MARKERS.find((candidate) => plain.includes(candidate));
	if (!marker) return undefined;
	const start = plain.indexOf(marker);
	if (start < 0) return undefined;
	return { start, end: plain.trimEnd().length };
}

const INSTALLED = Symbol.for("open-tui.thinkingClickExpand");
const expanded = new WeakSet<object>();

/**
 * Pending primary press: `{x,y}` while held, `"dragged"` once a button-motion
 * arrived. A click is a press that releases on the same cell without any
 * drag in between — identical to how pi-tui gates its own click affordances
 * (OSC 8 links) against text selection. Everything else (wheel, other
 * buttons, any non-mouse input) clears the pending state.
 */
let pendingClick: { x: number; y: number } | "dragged" | undefined;

/** Feeds one input event; true when the event completed a click that toggled something. */
const handleClickOn = (instance: ViewportInstance, data: string): boolean => {
	const event = parseSgrMouseEvent(data);
	if (!event) {
		pendingClick = undefined; // any non-mouse input aborts a pending click
		return false;
	}
	// Wheel and extended buttons carry no click intent.
	if ((event.button & 64) !== 0 || (event.button & 128) !== 0) {
		pendingClick = undefined;
		return false;
	}
	const button = event.button & 3;
	const motion = (event.button & 32) !== 0;
	if (event.release) {
		const pending = pendingClick;
		pendingClick = undefined;
		// Unmodified primary release on the press cell completes a click.
		if (
			typeof pending !== "object" || event.button !== 0 ||
			pending.x !== event.x || pending.y !== event.y
		) {
			return false;
		}
		return runClickPipeline(instance, event.x, event.y);
	}
	if (motion) {
		// Button-motion (button bit set, not the 32+3 button-less hover form)
		// is a drag: it cancels the click intent, selection keeps working.
		if (pendingClick !== undefined && button !== 3) pendingClick = "dragged";
		return false;
	}
	// Track only unmodified primary presses; anything else resets.
	pendingClick = event.button === 0 ? { x: event.x, y: event.y } : undefined;
	return false;
};

/** Runs the click pipeline at a screen cell: run-line toggles + label flow. */
const runClickPipeline = (instance: ViewportInstance, x: number, y: number): boolean => {
	const root = instance.currentLayout?.root;
	if (!root) {
		debug(`click(${x},${y}): no layout`);
		return false;
	}
	const hit = hitTestLeaf(root, x, y);
	if (!hit) {
		debug(`click(${x},${y}): no leaf hit`);
		return false;
	}
	const chat = hit.box.component as { children?: unknown[] } | null;
	if (typeof chat !== "object" || chat === null || !Array.isArray(chat.children)) {
		debug(`click(${x},${y}): leaf is not a container`);
		return false;
	}
	// Segment lookups are in the attached container's coordinates — translate
	// from the hit leaf (pi's opaque wrapper) first.
	const localIndex = lineIndexInAttachedContainer(chat, hit.lineIndex, hit.box.rect.width);
	// Tool group lines first: they sit above the thinking-label flow.
	if (localIndex !== undefined && handleToolLineClick(localIndex, hit.line)) {
		debug(`click(${x},${y}): toggled tool group`);
		return true;
	}
	// Segment lookup first: the recorded per-child ranges match what is on
	// screen exactly; re-render mapping can skew while a message streams.
	const host = ((localIndex !== undefined ? findThinkingHostViaSegments(localIndex) : undefined) ??
		findThinkingHostAtLine(chat, hit.lineIndex, hit.box.rect.width)) as ThinkingHost | undefined;
	if (!host) {
		debug(
			`click(${x},${y}): no host, line=${JSON.stringify(hit.line.slice(0, 60))} ` +
				`lineIndex=${hit.lineIndex}`,
		);
		return false;
	}

	const span = labelSpan(hit.line);
	const onLabel = span !== undefined && x >= span.start && x < span.end;
	debug(`click(${x},${y}): host=true onLabel=${onLabel} line=${JSON.stringify(hit.line.slice(0, 60))}`);
	if (onLabel && host.hideThinkingBlock !== false) {
		host.setHideThinkingBlock(false);
		expanded.add(host);
		instance.requestRender();
		return true;
	}
	if (!onLabel && expanded.has(host)) {
		host.setHideThinkingBlock(true);
		expanded.delete(host);
		instance.requestRender();
		return true;
	}
	return false;
};

type MutablePrototype = {
	handleViewportInput?: (this: ViewportInstance, data: string) => unknown;
	[INSTALLED]?: boolean;
};

/** Wraps handleViewportInput on a viewport prototype; returns a cleanup function. */
export function wrapViewportPrototype(proto: object | null | undefined): () => void {
	const target = proto as MutablePrototype | null | undefined;
	if (!target || typeof target.handleViewportInput !== "function") {
		debug("install: prototype without handleViewportInput, no-op");
		return () => {};
	}
	if (target[INSTALLED] === true) {
		debug("install: already wrapped");
		return () => {};
	}
	const original = target.handleViewportInput;
	target.handleViewportInput = function (data) {
		// Side-effect only. The click fires at release time and is never
		// consumed: pi-tui's selection state machine must see every mouse
		// event, and a same-cell release is already a no-op on its side.
		handleClickOn(this as ViewportInstance, data);
		return original.call(this, data);
	};
	target[INSTALLED] = true;
	debug("install: wrapped viewport prototype");
	return () => {
		delete target[INSTALLED];
		target.handleViewportInput = original;
	};
}

/**
 * Installs the click handler for the whole process by wrapping the shared
 * TuiAltScreen prototype — the extension resolves the SAME pi-tui module
 * instance pi core uses, so the wrap survives switchTuiMode instance swaps
 * and covers sessions that start in regular mode and switch later via
 * /settings. Silently no-ops when the runtime shape is not recognized.
 */
export function installThinkingClickExpand(): () => void {
	try {
		// eslint-disable-next-line @typescript-eslint/no-require-imports
		const piTui = require("@earendil-works/pi-tui") as { TuiAltScreen?: { prototype?: object } };
		return wrapViewportPrototype(piTui?.TuiAltScreen?.prototype);
	} catch (error) {
		debug(`install: require failed: ${error instanceof Error ? error.message : String(error)}`);
		return () => {};
	}
}
