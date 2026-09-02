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
 *    (scroll already applied), rendered lines, and a parent chain, which is
 *    all the hit-testing needs. No coordinate math of our own.
 *
 * Interaction: click the "✻ Thought…"/"✻ Thinking…" label to expand that
 * message's thinking inline (AssistantMessageComponent.setHideThinkingBlock);
 * click anywhere in the expanded message to collapse it back to the label.
 */

const LABEL_MARKERS = ["✻ Thinking", "✻ Thought"] as const;

/** Matches SGR mouse press with no modifiers, primary button: `\x1b[<0;x;yM`. */
const SGR_PRESS = /^\x1b\[<0;(\d+);(\d+)M$/;

const ANSI_CODE = /\x1b\[[0-9;?]*[A-Za-z]/g;

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
): { box: LayoutBox; line: string } | undefined {
	let hit: { box: LayoutBox; line: string } | undefined;
	const visit = (box: LayoutBox): void => {
		const rect = box.rect;
		const clip = box.clip ?? rect;
		const contains =
			x >= rect.x && x < rect.x + rect.width && y >= rect.y && y < rect.y + rect.height &&
			x >= clip.x && x < clip.x + clip.width && y >= clip.y && y < clip.y + clip.height;
		if (contains && box.children.length === 0 && box.lines && box.lines.length > 0) {
			const line = box.lines[(box.lineOffset ?? 0) + y - rect.y];
			if (typeof line === "string") hit = { box, line };
		}
		for (const child of box.children) visit(child);
	};
	visit(root);
	return hit;
}

/** Nearest ancestor (starting at `box`) that renders a hidden-thinking label. */
export function findThinkingHost(box: LayoutBox): ThinkingHost | undefined {
	let current: LayoutBox | undefined = box;
	while (current) {
		if (isThinkingHost(current.component)) return current.component;
		current = current.parent;
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
	if (!isFullscreenTui(tui) || typeof target.handleViewportInput !== "function") {
		return () => {};
	}

	const expanded = new WeakSet<object>();
	const hadOwn = Object.prototype.hasOwnProperty.call(target, "handleViewportInput");
	const original = target.handleViewportInput;

	const handleClick = (data: string): boolean => {
		const press = parseSgrPrimaryPress(data);
		if (!press) return false;
		const root = target.currentLayout?.root;
		if (!root) return false;
		const hit = hitTestLeaf(root, press.x, press.y);
		if (!hit) return false;
		const host = findThinkingHost(hit.box);
		if (!host) return false;

		const span = labelSpan(hit.line);
		const onLabel = span !== undefined && press.x >= span.start && press.x < span.end;
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
