import assert from "node:assert/strict";
import test from "node:test";
import type { KeybindingsManager } from "@earendil-works/pi-coding-agent";
import { TuiMainScreen, visibleWidth, type EditorTheme, type Terminal, type TUI } from "@earendil-works/pi-tui";
import { installEditor, OpenTuiEditor } from "../extensions/asterisk-tui/editor.ts";
import { stripAnsi } from "../extensions/asterisk-tui/utils.ts";

const tui = {
	terminal: { rows: 24 },
	requestRender() {},
} as TUI;

const editorTheme = {
	borderColor: (text: string) => text,
	selectList: {
		selectedPrefix: (text: string) => text,
		selectedText: (text: string) => text,
		description: (text: string) => text,
		scrollInfo: (text: string) => text,
		noMatch: (text: string) => text,
	},
} as EditorTheme;

test("compensates Pi editor padding for the custom left rail", () => {
	const editor = new OpenTuiEditor(
		tui,
		editorTheme,
		{ matches: () => false } as unknown as KeybindingsManager,
	);
	editor.setText("x");

	// Pi copies editorPaddingX after constructing a custom editor.
	editor.setPaddingX(2);
	const contentLine = stripAnsi(editor.render(40)[1] ?? "");

	assert.equal(contentLine.indexOf("x"), 2);
});

test("uses the terminal hardware cursor for non-block styles", () => {
	for (const [cursorStyle, sequence] of [
		["bar", "\x1b[6 q"],
		["underline", "\x1b[4 q"],
	] as const) {
		const writes: string[] = [];
		let hardwareCursor: boolean | undefined;
		const hardwareTui = {
			...tui,
			terminal: {
				rows: 24,
				write: (data: string) => writes.push(data),
			},
			getShowHardwareCursor: () => hardwareCursor ?? false,
			setShowHardwareCursor: (enabled: boolean) => {
				hardwareCursor = enabled;
			},
		} as unknown as TUI;
		const editor = new OpenTuiEditor(
			hardwareTui,
			editorTheme,
			{ matches: () => false } as unknown as KeybindingsManager,
			cursorStyle,
		);

		const lines = editor.render(40);

		assert.equal(hardwareCursor, true);
		assert.ok(writes.includes(sequence), `${cursorStyle} cursor sequence was sent`);
		assert.ok(lines.every((line) => !line.includes("\x1b[7m")), "software block cursor was removed");
	}
});

test("shows a hardware cursor while previewing a non-block style under an overlay", () => {
	const cursorEvents: string[] = [];
	const terminal = {
		columns: 80,
		rows: 24,
		kittyProtocolActive: false,
		start() {},
		stop() {},
		write() {},
		hideCursor: () => cursorEvents.push("hide"),
		showCursor: () => cursorEvents.push("show"),
	} as unknown as Terminal;
	const overlayTui = new TuiMainScreen(terminal, false);
	const editor = new OpenTuiEditor(
		overlayTui,
		editorTheme,
		{ matches: () => false } as unknown as KeybindingsManager,
	);
	overlayTui.addChild(editor);
	overlayTui.setFocus(editor);
	overlayTui.showOverlay({ render: () => ["settings"], invalidate() {} });
	cursorEvents.length = 0;

	editor.setCursorStyle("bar");
	(overlayTui as unknown as { doRender(): void }).doRender();

	assert.equal(cursorEvents.at(-1), "show");

	overlayTui.hideOverlay();
	(overlayTui as unknown as { doRender(): void }).doRender();
	overlayTui.showOverlay({ render: () => ["other overlay"], invalidate() {} });
	cursorEvents.length = 0;
	(overlayTui as unknown as { doRender(): void }).doRender();
	assert.equal(cursorEvents.at(-1), "hide");
	overlayTui.stop();
});

test("preserves block hardware cursor settings", () => {
	let changes = 0;
	const hardwareTui = {
		...tui,
		getShowHardwareCursor: () => true,
		setShowHardwareCursor: () => changes++,
	} as unknown as TUI;

	new OpenTuiEditor(
		hardwareTui,
		editorTheme,
		{ matches: () => false } as unknown as KeybindingsManager,
		"block",
	);

	assert.equal(changes, 0);
});

test("restores cursor shape and visibility when the editor is removed", () => {
	const writes: string[] = [];
	const visibility: boolean[] = [];
	const hardwareTui = {
		...tui,
		terminal: {
			rows: 24,
			write: (data: string) => writes.push(data),
		},
		getShowHardwareCursor: () => false,
		setShowHardwareCursor: (enabled: boolean) => visibility.push(enabled),
	} as unknown as TUI;
	const ctx = {
		ui: {
			setEditorComponent: (factory: unknown) => {
				if (typeof factory === "function") {
					factory(hardwareTui, editorTheme, { matches: () => false });
				}
			},
		},
	} as unknown as import("@earendil-works/pi-coding-agent").ExtensionContext;

	const editor = installEditor({} as import("@earendil-works/pi-coding-agent").ExtensionAPI, ctx, "bar");
	editor.cleanup();

	assert.ok(writes.includes("\x1b[0 q"), "cursor shape was reset");
	assert.deepEqual(visibility, [true, false]);
});

test("frame recolors via borderColor (bash mode / thinking level hook)", () => {
	let painted = "";
	const theme = {
		...editorTheme,
		borderColor: (text: string) => {
			painted = text;
			return text;
		},
	} as EditorTheme;
	const editor = new OpenTuiEditor(
		tui,
		theme,
		{ matches: () => false } as unknown as KeybindingsManager,
	);
	editor.setText("hi");

	const lines = editor.render(40);
	const top = stripAnsi(lines[0] ?? "");
	const body = stripAnsi(lines[1] ?? "");

	// Top border and rail both route through borderColor.
	assert.ok(top.startsWith("╭") && top.endsWith("╮"), `top border shape: ${top!}`);
	assert.ok(body.startsWith("│") && body.endsWith("│"), `body rails: ${body!}`);
	assert.ok(painted.length > 0, "borderColor was invoked for the frame");
});

test("embeds the working status in the top border", () => {
	const editor = new OpenTuiEditor(
		tui,
		editorTheme,
		{ matches: () => false } as unknown as KeybindingsManager,
	);
	editor.setWorkingStatusIndicator({
		renderInBorder: () => "◐ working",
		renderSpinnerInBorder: () => "◐",
	});

	assert.match(stripAnsi(editor.render(40)[0] ?? ""), /^╭── ◐ working ─+╮$/);
});

test("degrades the working border to spinner-only when narrow", () => {
	const editor = new OpenTuiEditor(
		tui,
		editorTheme,
		{ matches: () => false } as unknown as KeybindingsManager,
	);
	editor.setWorkingStatusIndicator({
		renderInBorder: () => "◐ working",
		renderSpinnerInBorder: () => "◐",
	});

	// width 14 → contentWidth 12 < status(9) + 5: spinner-only ladder rung.
	const top = stripAnsi(editor.render(14)[0] ?? "");
	assert.ok(top.includes("◐"), `spinner missing: ${top}`);
	assert.ok(!top.includes("working"), `full status leaked on narrow border: ${top}`);
	assert.equal(visibleWidth(top), 14);
});

test("keeps a narrow scrolled working border intact", () => {
	const editor = new OpenTuiEditor(
		tui,
		editorTheme,
		{ matches: () => false } as unknown as KeybindingsManager,
	);
	editor.setText(Array.from({ length: 10 }, (_, index) => `line ${index}`).join("\n"));
	let spinnerRenders = 0;
	editor.setWorkingStatusIndicator({
		renderInBorder: () => "◐ working status that ignores width",
		renderSpinnerInBorder: () => {
			spinnerRenders++;
			return "◐";
		},
	});

	const topBorder = stripAnsi(editor.render(30)[0] ?? "");

	assert.equal(spinnerRenders, 1);
	assert.equal(visibleWidth(topBorder), 30);
	assert.match(topBorder, /↑ 3 more/);
	assert.ok(topBorder.endsWith("╮"));
});

test("drops the working status when the indicator goes empty", () => {
	const editor = new OpenTuiEditor(
		tui,
		editorTheme,
		{ matches: () => false } as unknown as KeybindingsManager,
	);
	let working = true;
	editor.setWorkingStatusIndicator({
		renderInBorder: () => (working ? "◐ working" : ""),
		renderSpinnerInBorder: () => (working ? "◐" : ""),
	});

	assert.match(stripAnsi(editor.render(40)[0] ?? ""), /◐ working/);
	working = false;
	assert.match(stripAnsi(editor.render(40)[0] ?? ""), /^╭─+╮$/);
});

test("renders inline footer lines in the editor frame", () => {
	const editor = new OpenTuiEditor(
		tui,
		editorTheme,
		{ matches: () => false } as unknown as KeybindingsManager,
	);
	editor.setInlineBorderContent({
		enabled: () => true,
		render: (kind) =>
			kind === "top"
				? { left: "cwd", right: "model" }
				: { left: "done", right: "stats" },
	});

	const lines = editor.render(40).map(stripAnsi);
	assert.match(lines[0] ?? "", /^╭─ cwd ─+ model ─╮$/);
	assert.match(lines.at(-1) ?? "", /^╰─ done ─+ stats ─╯$/);
	assert.equal(visibleWidth(lines[0] ?? ""), 40);
	assert.equal(visibleWidth(lines.at(-1) ?? ""), 40);
});

test("falls back to plain borders when inline content is empty", () => {
	const editor = new OpenTuiEditor(
		tui,
		editorTheme,
		{ matches: () => false } as unknown as KeybindingsManager,
	);
	editor.setInlineBorderContent({
		enabled: () => true,
		render: () => ({ left: "", right: "" }),
	});

	assert.match(stripAnsi(editor.render(40)[0] ?? ""), /^╭─+╮$/);
});

test("maps framed editor clicks to content coordinates", () => {
	const editor = new OpenTuiEditor(
		tui,
		editorTheme,
		{ matches: () => false } as unknown as KeybindingsManager,
	);
	editor.setText("abcdef");
	editor.render(40);

	const click = (x: number): void => {
		editor.handleMouse({
			type: "click",
			button: "left",
			x,
			y: 1,
			screenX: x,
			screenY: 1,
			width: 40,
			height: 8,
			shift: false,
			alt: false,
			ctrl: false,
		});
	};

	// Content starts at framed x=2 (rail + gap); clicks translate back.
	click(2);
	assert.equal(editor.getCursor().col, 0);
	click(3);
	assert.equal(editor.getCursor().col, 1);
	click(39);
	assert.equal(editor.getCursor().col, 6);
});

test("leaves narrow unframed editor mouse coordinates unchanged", () => {
	const editor = new OpenTuiEditor(
		tui,
		editorTheme,
		{ matches: () => false } as unknown as KeybindingsManager,
	);
	editor.setText("abc");
	editor.render(3);

	editor.handleMouse({
		type: "click",
		button: "left",
		x: 0,
		y: 1,
		screenX: 0,
		screenY: 1,
		width: 3,
		height: 8,
		shift: false,
		alt: false,
		ctrl: false,
	});
	assert.equal(editor.getCursor().col, 0);
});
