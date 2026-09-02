import assert from "node:assert/strict";
import test from "node:test";
import {
	findThinkingHostAtLine,
	hitTestLeaf,
	labelSpan,
	parseSgrPrimaryPress,
	wrapViewportPrototype,
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
	// Mimic pi-tui Container: render concatenates children exactly.
	const makeContainer = (children: unknown[]) => ({
		children,
		render: (width: number) => {
			const lines: string[] = [];
			for (const child of children) {
				const renderable = child as { render?: (w: number) => string[] };
				if (typeof renderable.render === "function") lines.push(...renderable.render(width));
			}
			return lines;
		},
	});
	const inner = makeContainer([message]);
	const middle = makeContainer([{ render: (_w: number) => ["banner"] }, inner]);
	const outer = makeContainer([makeSpacer(), middle]);
	// outer lines: 0 spacer · 1 banner · 2-3 message.
	assert.equal(findThinkingHostAtLine(outer, 2, 80), message, "label line through two wrappers");
	assert.equal(findThinkingHostAtLine(outer, 3, 80), message);
	assert.equal(findThinkingHostAtLine(outer, 1, 80), undefined, "banner line has no host");
});

/** Fake viewport whose handleViewportInput lives on the prototype, like TuiAltScreen. */
class FakeViewport {
	currentLayout: { root: LayoutBox } | undefined;
	renders = 0;
	calls: string[] = [];

	constructor(root?: LayoutBox) {
		this.currentLayout = root ? { root } : undefined;
	}

	requestRender(): void {
		this.renders++;
	}

	handleViewportInput(data: string): { consume: boolean } {
		this.calls.push(data);
		return { consume: true };
	}
}

function makeChatLeaf(chat: { children: unknown[] }, lines: string[], y = 2): LayoutBox {
	return {
		component: chat,
		rect: { x: 0, y, width: 80, height: lines.length },
		children: [],
		lines,
	};
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

	const cleanup = wrapViewportPrototype(FakeViewport.prototype);
	const tui = new FakeViewport(root);

	// Click the label (row y=3 → lineIndex 1) → expand.
	assert.deepEqual(tui.handleViewportInput("\x1b[<0;5;4M"), { consume: true });
	assert.equal(message.hideThinkingBlock, false);
	assert.ok(tui.renders > 0);
	assert.equal(tui.calls.length, 0, "click should not reach selection handling");

	// Click the expanded thinking (y=4 → lineIndex 2) → collapse.
	tui.handleViewportInput("\x1b[<0;5;5M");
	assert.equal(message.hideThinkingBlock, true);

	// Clicking the label again re-expands.
	tui.handleViewportInput("\x1b[<0;5;4M");
	assert.equal(message.hideThinkingBlock, false);

	// A fresh instance (e.g. after a TUI mode switch) inherits the wrap.
	const next = new FakeViewport(root);
	next.handleViewportInput("\x1b[<0;5;5M");
	assert.equal(message.hideThinkingBlock, true, "second instance should collapse via shared prototype");

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

	const cleanup = wrapViewportPrototype(FakeViewport.prototype);
	const tui = new FakeViewport(root);

	// Click the label's columns but on the answer row (y=3 → lineIndex 1) → not a label.
	assert.deepEqual(tui.handleViewportInput("\x1b[<0;5;4M"), { consume: true });
	assert.equal(tui.calls.length, 1, "falls through to the original handler");
	assert.equal(message.hideThinkingBlock, true);

	// Non-mouse input passes through.
	tui.handleViewportInput("j");
	assert.equal(tui.calls.length, 2);

	cleanup();
});

test("wrap guards, restores, and no-ops on foreign prototypes", () => {
	const original = FakeViewport.prototype.handleViewportInput;

	const cleanup = wrapViewportPrototype(FakeViewport.prototype);
	assert.notEqual(FakeViewport.prototype.handleViewportInput, original, "prototype should be wrapped");

	// Second wrap is a guarded no-op and must not unwrap on its cleanup.
	const noopCleanup = wrapViewportPrototype(FakeViewport.prototype);
	noopCleanup();
	assert.notEqual(FakeViewport.prototype.handleViewportInput, original, "guarded wrap must not unwrap");

	cleanup();
	assert.equal(FakeViewport.prototype.handleViewportInput, original, "cleanup should restore the original");

	// Foreign shapes are no-ops, not throws.
	assert.doesNotThrow(() => wrapViewportPrototype(undefined)());
	assert.doesNotThrow(() => wrapViewportPrototype(null)());
	assert.doesNotThrow(() => wrapViewportPrototype({})());
});
