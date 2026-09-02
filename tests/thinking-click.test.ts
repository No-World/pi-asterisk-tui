import assert from "node:assert/strict";
import test from "node:test";
import type { TUI } from "@earendil-works/pi-tui";
import {
	findThinkingHost,
	hitTestLeaf,
	installThinkingClickExpand,
	labelSpan,
	parseSgrPrimaryPress,
} from "../extensions/open-tui/thinking-click.ts";

interface LayoutBox {
	component: unknown;
	rect: { x: number; y: number; width: number; height: number };
	clip?: { x: number; y: number; width: number; height: number };
	children: LayoutBox[];
	parent?: LayoutBox;
	lines?: readonly string[];
	lineOffset?: number;
}

/** Duck-typed stand-in for pi's AssistantMessageComponent. */
function makeMessage(hideThinking: boolean): {
	component: {
		hideThinkingBlock: boolean;
		setHideThinkingBlock(hide: boolean): void;
	};
} {
	const component = {
		hideThinkingBlock: hideThinking,
		setHideThinkingBlock(hide: boolean) {
			this.hideThinkingBlock = hide;
		},
	};
	return { component };
}

function leafBox(
	line: string,
	y: number,
	parent?: LayoutBox,
	x = 0,
	width = 80,
): LayoutBox {
	const box: LayoutBox = {
		component: { some: "text-component" },
		rect: { x, y, width, height: 1 },
		children: [],
		lines: [line],
	};
	if (parent) {
		box.parent = parent;
		parent.children.push(box);
		parent.rect.height += 1;
	}
	return box;
}

test("parseSgrPrimaryPress only matches unmodified primary presses", () => {
	assert.deepEqual(parseSgrPrimaryPress("\x1b[<0;11;6M"), { x: 10, y: 5 });
	// wheel, release, modified clicks, plain keys are ignored
	assert.equal(parseSgrPrimaryPress("\x1b[<64;11;6M"), undefined);
	assert.equal(parseSgrPrimaryPress("\x1b[<0;11;6m"), undefined);
	assert.equal(parseSgrPrimaryPress("\x1b[<5;11;6M"), undefined);
	assert.equal(parseSgrPrimaryPress("j"), undefined);
});

test("labelSpan finds the ✻ label columns", () => {
	const span = labelSpan("\x1b[3m\x1b[38;2;1;2;3m ✻ Thought…\x1b[0m");
	assert.ok(span);
	assert.equal(span.start, 1);
	assert.equal(span.end, " ✻ Thought…".trimEnd().length);
	assert.equal(labelSpan("regular assistant text"), undefined);
});

test("hitTestLeaf resolves the leaf box and line under a point", () => {
	const root: LayoutBox = {
		component: { root: true },
		rect: { x: 0, y: 0, width: 80, height: 0 },
		children: [],
	};
	leafBox(" ✻ Thought…", 3, root);
	leafBox("  let me think about this", 4, root);

	const hit = hitTestLeaf(root, 4, 4);
	assert.ok(hit);
	assert.equal(hit.line, "  let me think about this");
	// Outside every box.
	assert.equal(hitTestLeaf(root, 4, 40), undefined);
	// Clipped away: parent clips to the first row only.
	const clipped: LayoutBox = {
		component: { root: true },
		rect: { x: 0, y: 0, width: 80, height: 0 },
		children: [],
	};
	const child = leafBox(" ✻ Thought…", 3, clipped);
	child.clip = { x: 0, y: 0, width: 80, height: 0 };
	assert.equal(hitTestLeaf(clipped, 4, 3), undefined);
});

test("findThinkingHost walks up to the message component", () => {
	const { component } = makeMessage(true);
	const root: LayoutBox = {
		component: { root: true },
		rect: { x: 0, y: 0, width: 80, height: 0 },
		children: [],
	};
	const messageBox: LayoutBox = {
		component,
		rect: { x: 0, y: 2, width: 80, height: 0 },
		children: [],
		parent: root,
	};
	root.children.push(messageBox);
	const label = leafBox(" ✻ Thought…", 2, messageBox);

	assert.equal(findThinkingHost(label), component);
	assert.equal(findThinkingHost(messageBox), component);
});

function makeTui(root: LayoutBox | undefined) {
	const calls: string[] = [];
	let renders = 0;
	const tui = {
		mode: "fullscreen",
		currentLayout: root ? { root } : undefined,
		requestRender: () => {
			renders++;
		},
		handleViewportInput(data: string) {
			calls.push(data);
			return { consume: true };
		},
	};
	return { tui: tui as unknown as TUI & Record<string, unknown>, calls, getRenders: () => renders };
}

test("clicking the label expands, clicking the message collapses", () => {
	const { component } = makeMessage(true);
	const root: LayoutBox = {
		component: { root: true },
		rect: { x: 0, y: 0, width: 80, height: 0 },
		children: [],
	};
	const messageBox: LayoutBox = {
		component,
		rect: { x: 0, y: 2, width: 80, height: 0 },
		children: [],
		parent: root,
	};
	root.children.push(messageBox);
	leafBox(" ✻ Thought…", 2, messageBox);
	leafBox("  inner reasoning", 3, messageBox);

	const { tui, calls, getRenders } = makeTui(root);
	const cleanup = installThinkingClickExpand(tui);
	const input = (tui as unknown as { handleViewportInput: (data: string) => unknown }).handleViewportInput;

	// Click the label (screen row 3 = y 2) → expand.
	assert.deepEqual(input("\x1b[<0;5;3M"), { consume: true });
	assert.equal(component.hideThinkingBlock, false);
	assert.ok(getRenders() > 0);
	assert.equal(calls.length, 0, "click should not reach selection handling");

	// Click the expanded thinking (y 3) → collapse.
	input("\x1b[<0;5;4M");
	assert.equal(component.hideThinkingBlock, true);

	// Clicking the label again re-expands.
	input("\x1b[<0;5;3M");
	assert.equal(component.hideThinkingBlock, false);

	cleanup();
});

test("non-label clicks fall through untouched", () => {
	const { component } = makeMessage(true);
	const root: LayoutBox = {
		component: { root: true },
		rect: { x: 0, y: 0, width: 80, height: 0 },
		children: [],
	};
	leafBox(" ✻ Thought…", 2, root);
	leafBox("plain answer text", 3, root);

	const { tui, calls } = makeTui(root);
	const cleanup = installThinkingClickExpand(tui);
	const input = (tui as unknown as { handleViewportInput: (data: string) => unknown }).handleViewportInput;

	// Click on the answer row (y 3) at the label's columns → not a label.
	assert.deepEqual(input("\x1b[<0;5;4M"), { consume: true });
	assert.equal(calls.length, 1, "falls through to the original handler");
	assert.equal(component.hideThinkingBlock, true);

	// Non-mouse input passes through.
	input("j");
	assert.equal(calls.length, 2);

	cleanup();
});

test("install no-ops outside fullscreen mode and cleanup restores the prototype", () => {
	const { tui, calls } = makeTui(undefined);
	(tui as unknown as { mode: string }).mode = "regular";
	const cleanup = installThinkingClickExpand(tui);
	cleanup();
	assert.equal(calls.length, 0);

	const root: LayoutBox = {
		component: { root: true },
		rect: { x: 0, y: 0, width: 80, height: 0 },
		children: [],
	};
	const full = makeTui(root);
	const original = (full.tui as unknown as { handleViewportInput: unknown }).handleViewportInput;
	const cleanupFull = installThinkingClickExpand(full.tui);
	const patched = (full.tui as unknown as { handleViewportInput: unknown }).handleViewportInput;
	assert.notEqual(patched, original);
	cleanupFull();
	assert.equal(
		(full.tui as unknown as { handleViewportInput: unknown }).handleViewportInput,
		original,
		"cleanup should restore the original method",
	);
});
