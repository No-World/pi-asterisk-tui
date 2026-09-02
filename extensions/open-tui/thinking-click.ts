import type { TUI } from "@earendil-works/pi-tui";

/**
 * Click-to-expand for hidden thinking blocks (fullscreen TUI only).
 *
 * pi renders hidden thinking as a static label line; there is no per-message
 * expansion or component-level mouse routing. This module pokes two runtime
 * details, both version-guarded and inert on mismatch (same policy as
 * fullscreen-scroll.ts):
 *
 * 1. TuiAltScreen.handleViewportInput — instance-level wrap so an expanding
 *    click is consumed before the alt-screen turns it into text selection.
 * 2. TuiAltScreen.currentLayout — layout boxes carry screen-space rects
 *    (scroll already applied) plus the rendered lines of opaque leaves.
 *
 * pi-tui only puts Stack/ScrollView components into the box tree; plain
 * Containers (pi's chat container, and every AssistantMessageComponent inside
 * it) are opaque leaves. The chat leaf's component therefore IS pi's chat
 * container, and since Container.render concatenates its children exactly,
 * a clicked line index maps 1:1 onto the child that rendered it. We use that
 * to find the owning AssistantMessageComponent and flip its
 * setHideThinkingBlock — per message, not pi's global ctrl+t.
 *
 * Interaction: click the "✻ Thought…"/"✻ Thinking…" label to expand that
 * message's thinking inline; click anywhere in the expanded message to
 * collapse it back to the label.
 */

const LABEL_MARKERS = ["✻ Thinking", "✻ Thought"] as const;

/** Matches SGR mouse press with no modifiers, primary button: `\x1b[<0;x;yM`. */
const SGR_PRESS = /^\x1b\[<0;(\d+);(\d+)M$/;

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

type ViewportTui = TUI & {
	mode?: unknown;
	currentLayout?: { root?: LayoutBox } | undefined;
	handleViewportInput?: (data: string) => unknown;
};

export function isFullscreenTui(tui: TUI): boolean {
	return (tui as ViewportTui).mode === "fullscreen";
}

function isThinkingHost(component: unknown): component is ThinkingHost {
	if (typeof component !== "object" || component === null) return false;
	const candidate = component as Partial<ThinkingHost>;
	return typeof candidate.setHideThinkingBlock === "function" && typeof candidate.hideThinkingBlock === "boolean";
}

export function parseSgrPrimaryPress(data: string): { x: number; y: number } | undefined {
	const match = SGR_PRESS.exec(data);
	if (!match) return undefined;
	return { x: Number.parseInt(match[1]!, 10) - 1, y: Number.parseInt(match[2]!, 10) - 1 };
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

/**
 * Installs the click handler on a fullscreen TUI. Returns a cleanup function;
 * silently no-ops when the runtime shape is not recognized.
 */
export function installThinkingClickExpand(tui: TUI): () => void {
	const target = tui as ViewportTui;
	debug(`install: mode=${String(target.mode)} hasInput=${typeof target.handleViewportInput}`);
	if (!isFullscreenTui(tui) || typeof target.handleViewportInput !== "function") {
		debug("install: unsupported shape, no-op");
		return () => {};
	}

	const expanded = new WeakSet<object>();
	const hadOwn = Object.prototype.hasOwnProperty.call(target, "handleViewportInput");
	const original = target.handleViewportInput;

	const handleClick = (data: string): boolean => {
		const press = parseSgrPrimaryPress(data);
		if (!press) return false;
		const root = target.currentLayout?.root;
		if (!root) {
			debug(`click(${press.x},${press.y}): no layout`);
			return false;
		}
		const hit = hitTestLeaf(root, press.x, press.y);
		if (!hit) {
			debug(`click(${press.x},${press.y}): no leaf hit`);
			return false;
		}
		const chat = hit.box.component as { children?: unknown[] } | null;
		if (typeof chat !== "object" || chat === null || !Array.isArray(chat.children)) {
			debug(`click(${press.x},${press.y}): leaf is not a container`);
			return false;
		}
		const host = findThinkingHostAtLine(chat, hit.lineIndex, hit.box.rect.width);
		if (!host) {
			debug(
				`click(${press.x},${press.y}): no host, line=${JSON.stringify(hit.line.slice(0, 60))} ` +
					`lineIndex=${hit.lineIndex}`,
			);
			return false;
		}

		const span = labelSpan(hit.line);
		const onLabel = span !== undefined && press.x >= span.start && press.x < span.end;
		debug(`click(${press.x},${press.y}): host=true onLabel=${onLabel} line=${JSON.stringify(hit.line.slice(0, 60))}`);
		if (onLabel && host.hideThinkingBlock !== false) {
			host.setHideThinkingBlock(false);
			expanded.add(host);
			tui.requestRender();
			return true;
		}
		if (!onLabel && expanded.has(host)) {
			host.setHideThinkingBlock(true);
			expanded.delete(host);
			tui.requestRender();
			return true;
		}
		return false;
	};

	target.handleViewportInput = (data: string) => {
		if (handleClick(data)) return { consume: true };
		return original.call(target, data);
	};

	return () => {
		if (hadOwn) {
			target.handleViewportInput = original;
		} else {
			delete target.handleViewportInput;
		}
	};
}
