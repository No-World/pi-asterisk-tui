import assert from "node:assert/strict";
import test from "node:test";
import type { TUI } from "@earendil-works/pi-tui";
import {
	findThinkingHostAtLine,
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
function makeMessage(lines: string[], hideThinking: boolean) {
	const component = {
		hideThinkingBlock: hideThinking,
		setHideThinkingBlock(hide: boolean) {
			this.hideThinkingBlock = hide;
		},
		render: (width: number) => lines.map((line) => line.padEnd(width)),
	};
	return component;
}

function makeSpacer() {
	return { render: (_width: number) => [""] };
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

test("hitTestLeaf resolves the leaf box, line, and line index", () => {
	const root: LayoutBox = {
		component: { root: true },
		rect: { x: 0, y: 0, width: 80, height: 0 },
		children: [],
	};
	const chatLines = ["user asks", " ✻ Thought…", "  inner reasoning", "answer"];
	root.children.push({
		component: { children: [] },
		rect: { x: 0, y: 1, width: 80, height: chatLines.length },
		children: [],
		lines: chatLines,
	});

	const hit = hitTestLeaf(root, 4, 2);
	assert.ok(hit);
	assert.equal(hit.lineIndex, 1);
	assert.equal(hit.line, " ✻ Thought…");
	assert.equal(hit.box.component, root.children[0]!.component);
	// Outside every box.
	assert.equal(hitTestLeaf(root, 4, 40), undefined);
	// Clipped away.
	const clipped: LayoutBox = {
		component: { root: true },
		rect: { x: 0, y: 0, width: 80, height: 0 },
		children: [],
	};
	const child: LayoutBox = {
		component: { children: [] },
		rect: { x: 0, y: 3, width: 80, height: 1 },
		children: [],
		lines: [" ✻ Thought…"],
		clip: { x: 0, y: 0, width: 80, height: 0 },
	};
	clipped.children.push(child);
	assert.equal(hitTestLeaf(clipped, 4, 3), undefined);
});

test("findThinkingHostAtLine maps a chat line onto its owning message", () => {
	const message = makeMessage([" ✻ Thought…", "  inner reasoning", "answer"], true);
	const chat = { children: [makeSpacer(), message, makeSpacer(), { render: undefined }] };
	// Line 0 is the spacer; lines 1-3 belong to the message.
	assert.equal(findThinkingHostAtLine(chat, 0, 80), undefined);
	assert.equal(findThinkingHostAtLine(chat, 1, 80), message);
	assert.equal(findThinkingHostAtLine(chat, 3, 80), message);
	assert.equal(findThinkingHostAtLine(chat, 4, 80), undefined);
	// Non-container input.
	assert.equal(findThinkingHostAtLine({}, 0, 80), undefined);
});

test("findThinkingHostAtLine descends through nested wrappers", () => {
	const message = makeMessage([" ✻ Thought…", "  inner reasoning"], true);
	const inner = { children: [message] };
	const middle = { children: [{ render: (_w: number) => ["banner"] }, inner] };
	const outer = { children: [makeSpacer(), middle] };
	// outer lines: 0 spacer · 1 banner · 2-3 message.
	assert.equal(findThinkingHostAtLine(outer, 2, 80), message, "label line through two wrappers");
	assert.equal(findThinkingHostAtLine(outer, 3, 80), message);
	assert.equal(findThinkingHostAtLine(outer, 1, 80), undefined, "banner line has no host");
});

function makeChatLeaf(chat: { children: unknown[] }, lines: string[], y = 2): LayoutBox {
	return {
		component: chat,
		rect: { x: 0, y, width: 80, height: lines.length },
		children: [],
		lines,
	};
}

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
	const message = makeMessage([" ✻ Thought…", "  inner reasoning", "answer"], true);
	const chat = { children: [makeSpacer(), message] };
	const lines = ["", ...message.render(80)];
	const root: LayoutBox = {
		component: { root: true },
		rect: { x: 0, y: 0, width: 80, height: 0 },
		children: [makeChatLeaf(chat, lines)],
	};

	const { tui, calls, getRenders } = makeTui(root);
	const cleanup = installThinkingClickExpand(tui);
	const input = (tui as unknown as { handleViewportInput: (data: string) => unknown }).handleViewportInput;

	// Click the label (row y=3 → lineIndex 1) → expand.
	assert.deepEqual(input("\x1b[<0;5;4M"), { consume: true });
	assert.equal(message.hideThinkingBlock, false);
	assert.ok(getRenders() > 0);
	assert.equal(calls.length, 0, "click should not reach selection handling");

	// Click the expanded thinking (y=4 → lineIndex 2) → collapse.
	input("\x1b[<0;5;5M");
	assert.equal(message.hideThinkingBlock, true);

	// Clicking the label again re-expands.
	input("\x1b[<0;5;4M");
	assert.equal(message.hideThinkingBlock, false);

	cleanup();
});

test("non-label clicks fall through untouched", () => {
	const message = makeMessage([" ✻ Thought…", "answer"], true);
	const chat = { children: [message] };
	const lines = [...message.render(80)];
	const root: LayoutBox = {
		component: { root: true },
		rect: { x: 0, y: 0, width: 80, height: 0 },
		children: [makeChatLeaf(chat, lines)],
	};

	const { tui, calls } = makeTui(root);
	const cleanup = installThinkingClickExpand(tui);
	const input = (tui as unknown as { handleViewportInput: (data: string) => unknown }).handleViewportInput;

	// Click the label's columns but on the answer row (y=3 → lineIndex 1) → not a label.
	assert.deepEqual(input("\x1b[<0;5;4M"), { consume: true });
	assert.equal(calls.length, 1, "falls through to the original handler");
	assert.equal(message.hideThinkingBlock, true);

	// Non-mouse input passes through.
	input("j");
	assert.equal(calls.length, 2);

	cleanup();
});

test("install no-ops outside fullscreen mode and cleanup restores the original", () => {
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
