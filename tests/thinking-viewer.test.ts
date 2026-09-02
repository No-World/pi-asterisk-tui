import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import type { Component, TUI } from "@earendil-works/pi-tui";
import {
	collectThinkingSections,
	registerThinkingCommand,
	ThinkingViewer,
} from "../extensions/open-tui/thinking-viewer.ts";

const theme = {
	fg: (_color: string, text: string) => text,
	bold: (text: string) => text,
} as Theme;

interface ViewerComponent extends Component {
	handleInput(data: string): void;
}

function makeCtx(entries: unknown[]): ExtensionContext {
	return {
		hasUI: true,
		mode: "tui",
		sessionManager: {
			getBranch: () => entries,
		},
	} as unknown as ExtensionContext;
}

function thinkingEntry(text: string, timestamp = "2026-10-01T10:30:00Z", extraBlocks: unknown[] = []) {
	return {
		type: "message",
		timestamp,
		message: {
			role: "assistant",
			model: "glm-4.7",
			content: [{ type: "thinking", thinking: text }, ...extraBlocks],
		},
	};
}

test("collectThinkingSections keeps only non-empty thinking blocks", () => {
	const ctx = makeCtx([
		{ type: "message", message: { role: "user", content: [{ type: "text", text: "hi" }] } },
		thinkingEntry("let me think"),
		{
			type: "message",
			timestamp: "2026-10-01T10:31:00Z",
			message: {
				role: "assistant",
				model: "glm-4.7",
				content: [
					{ type: "thinking", thinking: "   " },
					{ type: "text", text: "answer" },
				],
			},
		},
		{
			type: "message",
			timestamp: "2026-10-01T10:32:00Z",
			message: {
				role: "assistant",
				model: "glm-4.7",
				content: [
					{ type: "thinking", thinking: "first", redacted: false },
					{ type: "thinking", thinking: "opaque", redacted: true },
				],
			},
		},
	]);

	const sections = collectThinkingSections(ctx);
	assert.equal(sections.length, 2);
	assert.equal(sections[0]!.id, 1);
	assert.equal(sections[0]!.text, "let me think");
	assert.ok(sections[0]!.timestamp !== undefined);
	// Whitespace-only thinking is skipped, so the next section is id 2.
	assert.equal(sections[1]!.id, 2);
	assert.equal(sections[1]!.text, "first\n\n[redacted thinking]");
});

test("viewer renders sections and starts at the newest", () => {
	const sections = [
		{ id: 1, timestamp: "10:30", model: "glm-4.7", text: `${"old thinking line\n".repeat(8)}old tail` },
		{ id: 2, timestamp: "10:31", model: "glm-4.7", text: "new thinking" },
	];
	const viewer = new ThinkingViewer(sections, theme, 4, () => {});
	const lines = viewer.render(80);

	assert.match(lines[0]!, /Thinking.*2 messages/);
	const body = lines.slice(1, -1).join("\n");
	assert.ok(body.includes("new thinking"), `newest should be visible\n${body}`);
	assert.ok(!body.includes("old thinking line"), `older section should be scrolled out\n${body}`);
});

test("viewer empty state", () => {
	const viewer = new ThinkingViewer([], theme, 5, () => {});
	const lines = viewer.render(80);
	assert.ok(lines.join("\n").includes("No thinking blocks"));
});

test("viewer scroll keys move and clamp", () => {
	const long = Array.from({ length: 60 }, (_, i) => ({
		id: i + 1,
		timestamp: "10:30",
		model: "m",
		text: `section-${i}`,
	}));
	const viewer = new ThinkingViewer(long, theme, 5, () => {});
	const initial = viewer.render(80).join("\n");
	assert.ok(initial.includes("section-59"), "should start at the tail");

	viewer.handleInput("g");
	const top = viewer.render(80).join("\n");
	assert.ok(top.includes("section-0"), `g should jump to top\n${top}`);

	viewer.handleInput("d"); // page down
	const mid = viewer.render(80).join("\n");
	assert.ok(!mid.includes("section-0"), "paged past the top");

	viewer.handleInput("G");
	const tail = viewer.render(80).join("\n");
	assert.ok(tail.includes("section-59"), "G should jump to the bottom");

	// Scrolling past the end clamps instead of drifting.
	viewer.handleInput("j");
	viewer.handleInput("j");
	const clamped = viewer.render(80).join("\n");
	assert.ok(clamped.includes("section-59"));
});

test("viewer closes on escape or q", () => {
	let closed = 0;
	const viewer = new ThinkingViewer(
		[{ id: 1, timestamp: "10:30", model: "m", text: "hi" }],
		theme,
		5,
		() => closed++,
	);
	viewer.render(80);
	viewer.handleInput("\x1b");
	viewer.handleInput("q");
	assert.equal(closed, 2);
});

test("/thinking command registers and opens the overlay", async () => {
	let commandName = "";
	let commandHandler: ((args: string, ctx: ExtensionContext) => Promise<void> | void) | undefined;
	const pi = {
		registerCommand: (name: string, options: { handler: (args: string, ctx: ExtensionContext) => Promise<void> | void }) => {
			commandName = name;
			commandHandler = options.handler;
		},
	} as unknown as ExtensionAPI;

	registerThinkingCommand(pi);
	assert.equal(commandName, "thinking");

	let component: ViewerComponent | undefined;
	let overlayUsed = false;
	const overlay = async (
		factory: (tui: TUI, theme: Theme) => Component,
		options?: { overlay?: boolean },
	) => {
		overlayUsed = options?.overlay === true;
		const tui = { requestRender() {}, terminal: { rows: 24 } } as unknown as TUI;
		component = factory(tui, theme) as ViewerComponent;
		return undefined;
	};
	const ctx = {
		hasUI: true,
		mode: "tui",
		sessionManager: { getBranch: () => [thinkingEntry("visible in overlay")] },
		ui: { custom: overlay },
	} as unknown as ExtensionContext;

	const handler = commandHandler as unknown as (args: string, ctx: ExtensionContext) => Promise<void>;
	assert.ok(handler);
	await handler("", ctx);
	assert.ok(overlayUsed, "should render as an overlay");
	assert.ok(component, "overlay component should be created");
	const out = component!.render(80).join("\n");
	assert.ok(out.includes("visible in overlay"), `thinking text missing\n${out}`);
	assert.match(out, /1 message/);
});
