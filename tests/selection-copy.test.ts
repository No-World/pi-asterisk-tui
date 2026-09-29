import assert from "node:assert/strict";
import test from "node:test";
import { Box, Container, Markdown, sliceByColumn, stripTerminalSequences, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import * as piTui from "@earendil-works/pi-tui";
import { alignChildRow as alignChildRowImpl, findLeafAtLine, resolveSelectionRows } from "../extensions/asterisk-tui/selection-copy.ts";
import { attachForTest, renderCollapsedForTest, setCollapseOptions, uninstallTurnCollapse } from "../extensions/asterisk-tui/turn-collapse.ts";
const selectionCopyInternals = { alignChildRow: alignChildRowImpl, findLeafAtLine };
import { DEFAULT_CONFIG, normalizeSelectionConfig, type OpenTuiConfig } from "../extensions/asterisk-tui/config.ts";
import { cycleSelectionCopy, toggleSelectionTrimPadding } from "../extensions/asterisk-tui/settings-command.ts";
import {
	buildMarkdownOrigins,
	installSelectionCopy,
	buildTextOrigins,
	emitRaw,
	emitUnwrapped,
	trimHighlightColumns,
	type MarkdownRecord,
	type ResolvedSelection,
	type SelectionDeps,
	type TextRecord,
	type TokenCallRecord,
	__testing,
} from "../extensions/asterisk-tui/selection-copy.ts";

const deps: SelectionDeps = {
	wrapTextWithAnsi,
	visibleWidth,
	sliceByColumn,
	strip: stripTerminalSequences,
	renderLatex: (text) => (text.includes("x^2") ? "𝑥²" : null),
	hyperlinks: () => true,
};

/** Builds a Markdown record whose rendered lines follow pi-tui's layout:
 * margin + wrap fragment, padded right (padding trimmed on compare). */
function makeParagraphRecord(text: string, width: number, paddingX = 1): MarkdownRecord {
	const contentWidth = Math.max(1, width - paddingX * 2);
	const output = text;
	const fragments = wrapTextWithAnsi(output, contentWidth);
	const call: TokenCallRecord = {
		token: { type: "paragraph", raw: `${text}\n` },
		width: contentWidth,
		outputs: [output, ""],
		children: [],
		cells: [],
	};
	const lines: string[] = [];
	for (const fragment of fragments) {
		lines.push(" ".repeat(paddingX) + fragment + " ".repeat(paddingX));
	}
	lines.push(" ".repeat(paddingX) + " ".repeat(paddingX)); // spacing row
	const record: MarkdownRecord = {
		component: { text, paddingX },
		width,
		text,
		contentWidth,
		paddingX,
		topCalls: [call],
		lines,
	};
	return record;
}

function makeResolved(
	record: MarkdownRecord,
	selectedRows: number[],
	allLines: string[],
	startCol = 0,
	endCol?: number,
): ResolvedSelection {
	const selectedLines = selectedRows.map((row) => allLines[row] ?? "");
	return {
		bounds: {
			start: { row: 0, col: startCol },
			end: {
				row: selectedRows[selectedRows.length - 1] ?? 0,
				col: endCol ?? visibleWidth(selectedLines[selectedLines.length - 1] ?? ""),
				boundary: false,
			},
		},
		sourceLines: allLines,
		contentWidth: record.contentWidth,
		mapping: {
			entries: selectedRows.map((row) => {
				const origins = buildMarkdownOrigins(deps, record);
				const group = origins.origins[row];
				return group !== undefined && group >= 0
					? { record, group, text: origins.groups[group] ?? "" }
					: undefined;
			}),
			lines: selectedLines,
			markdown: selectedRows.map((row) => ({ record, localRow: row })),
		},
	};
}

test("normalizeSelectionConfig defaults and migration", () => {
	assert.equal(normalizeSelectionConfig(undefined).copy, "unwrapped");
	assert.equal(normalizeSelectionConfig({}).copy, "unwrapped");
	assert.equal(normalizeSelectionConfig({ copy: "raw" }).copy, "raw");
	assert.equal(normalizeSelectionConfig({ copy: "bogus" }).copy, "unwrapped");
	assert.equal(DEFAULT_CONFIG.selection.copy, "unwrapped");
});

test("cycleSelectionCopy walks plain → unwrapped → raw", () => {
	let config: OpenTuiConfig = structuredClone(DEFAULT_CONFIG);
	config = cycleSelectionCopy(config);
	assert.equal(config.selection.copy, "raw");
	config = cycleSelectionCopy(config);
	assert.equal(config.selection.copy, "plain");
	config = cycleSelectionCopy(config);
	assert.equal(config.selection.copy, "unwrapped");
});

test("paragraph origins: wrapped rows join into the logical line", () => {
	const record = makeParagraphRecord("hello world this is a fairly long paragraph that must wrap", 30);
	const origins = buildMarkdownOrigins(deps, record);
	const contentRows = origins.origins.slice(0, origins.origins.length - 1); // exclude spacing row
	assert.ok(contentRows.length > 2, "expected several wrapped rows");
	assert.ok(contentRows.every((group) => group === contentRows[0]), "all content rows share one logical line");
	assert.equal(origins.groups[contentRows[0]!], "hello world this is a fairly long paragraph that must wrap");
});

test("paragraph origins: CJK wrapping produces no phantom spaces", () => {
	const cjk = "这是一段很长的中文文本用来验证软换行在复制时能够被精确拼回单一逻辑行而不引入任何多余空格";
	const record = makeParagraphRecord(cjk, 30);
	const origins = buildMarkdownOrigins(deps, record);
	const group = origins.origins[0]!;
	assert.equal(origins.groups[group], cjk);
});

test("unwrapped emission: full coverage copies the single logical line", () => {
	const text = "hello world this is a fairly long paragraph that must wrap";
	const record = makeParagraphRecord(text, 30);
	const rows = [0, 1, 2, 3].filter((row) => row < record.lines.length - 1);
	const resolution = makeResolved(record, rows, record.lines);
	const result = emitUnwrapped(deps, resolution);
	assert.equal(result, text);
});

test("unwrapped emission: opaque rows fall back to stock slices", () => {
	const text = "hello world this is a fairly long paragraph that must wrap";
	const record = makeParagraphRecord(text, 30);
	const rows = [0, 1, 2, 3].filter((row) => row < record.lines.length - 1);
	const resolution = makeResolved(record, rows, record.lines);
	resolution.mapping.entries = resolution.mapping.entries.map(() => undefined); // unresolved
	const result = emitUnwrapped(deps, resolution);
	assert.ok(result !== undefined);
	assert.ok(result.includes("\n"), "stock behavior keeps visual rows");
	const expected = rows.map((row) => stripTerminalSequences(record.lines[row]!).trimEnd().replace(/^\s+/, "")).join("\n");
	assert.equal(result, expected);
});

test("table origins: wrapped cells rejoin into one drawn row", () => {
	// column widths [10, 4]; borders in renderTable's exact format
	const topBorder = `┌─${["─".repeat(10), "─".repeat(4)].join("─┬─")}─┐`;
	const cellsHeader = [
		{ text: "hello world", result: wrapTextWithAnsi("hello world", 10) },
		{ text: "x", result: wrapTextWithAnsi("x", 4) },
	];
	const cellsRow = [
		{ text: "foo bar baz", result: wrapTextWithAnsi("foo bar baz", 10) },
		{ text: "y", result: wrapTextWithAnsi("y", 4) },
	];
	const call: TokenCallRecord = {
		token: { type: "table", raw: "| hello world | x |\n|---|---|\n| foo bar baz | y |\n", header: [{}, {}], rows: [{}] } as unknown as TokenCallRecord["token"],
		width: 40,
		outputs: [],
		children: [],
		cells: [...cellsHeader, ...cellsRow],
	};
	// Build expected drawn outputs the way renderTable assembles them.
	const pad = (value: string, width: number) => value + " ".repeat(Math.max(0, width - visibleWidth(value)));
	const outputs: string[] = [topBorder];
	const headerHeight = Math.max(...cellsHeader.map((cell) => cell.result.length));
	for (let i = 0; i < headerHeight; i++) {
		outputs.push(`│ ${pad(cellsHeader[0]!.result[i] ?? "", 10)} │ ${pad(cellsHeader[1]!.result[i] ?? "", 4)} │`);
	}
	outputs.push(`├─${["─".repeat(10), "─".repeat(4)].join("─┼─")}─┤`);
	const rowHeight = Math.max(...cellsRow.map((cell) => cell.result.length));
	for (let i = 0; i < rowHeight; i++) {
		outputs.push(`│ ${pad(cellsRow[0]!.result[i] ?? "", 10)} │ ${pad(cellsRow[1]!.result[i] ?? "", 4)} │`);
	}
	outputs.push(`└─${["─".repeat(10), "─".repeat(4)].join("─┴─")}─┘`);
	call.outputs = outputs;
	const record: MarkdownRecord = {
		component: { text: "", paddingX: 1 },
		width: 42,
		text: "",
		contentWidth: 40,
		paddingX: 1,
		topCalls: [call],
		lines: outputs.map((line) => ` ${line} `),
	};
	const origins = buildMarkdownOrigins(deps, record);
	// header group and data-row group each span multiple display rows
	const dataGroup = origins.origins[origins.origins.length - 2]; // inside last drawn data row
	assert.ok(dataGroup !== undefined && dataGroup >= 0);
	assert.equal(origins.groups[dataGroup], "│ foo bar baz │ y │");
	const headerGroup = origins.origins[1];
	assert.ok(headerGroup !== undefined && headerGroup >= 0);
	assert.equal(origins.groups[headerGroup], "│ hello world │ x │");
});

test("text origins: logical lines map back (both padding formulas)", () => {
	const text = "some longer text that will definitely wrap at a narrow width";
	const paddingX = 1;
	const width = 24;
	const contentWidth = Math.max(1, width - paddingX * 2);
	const lines: string[] = [];
	for (const logical of text.split("\n")) {
		for (const fragment of wrapTextWithAnsi(logical, contentWidth)) {
			lines.push(" ".repeat(paddingX) + fragment);
		}
	}
	const record: TextRecord = { component: { text, paddingX }, width, text, lines };
	const origins = buildTextOrigins(deps, record);
	assert.deepEqual(origins.groups, [text]);
	assert.ok(origins.origins.length > 1);
	assert.ok(origins.origins.every((group) => group === 0));
});

test("raw emission: whole component returns the source text", () => {
	const text = "**bold** paragraph one\n\nsecond paragraph";
	// two paragraph calls sharing one record
	const contentWidth = 80;
	const callA: TokenCallRecord = { token: { type: "paragraph", raw: "**bold** paragraph one\n\n" }, width: contentWidth, outputs: ["\x1b[1mbold\x1b[22m paragraph one", ""], children: [], cells: [] };
	const callB: TokenCallRecord = { token: { type: "paragraph", raw: "second paragraph\n" }, width: contentWidth, outputs: ["second paragraph"], children: [], cells: [] };
	const lines = [
		" \x1b[1mbold\x1b[22m paragraph one",
		" ",
		" second paragraph",
	];
	const record: MarkdownRecord = {
		component: { text, paddingX: 1 },
		width: 82,
		text,
		contentWidth,
		paddingX: 1,
		topCalls: [callA, callB],
		lines,
	};
	const resolution = makeResolved(record, [0, 1, 2], lines);
	const result = emitRaw(deps, resolution);
	assert.equal(result, text);
});

test("raw emission: mid-paragraph cut slices the inline markdown", () => {
	const raw = "prefix **bold suffix** tail";
	const rendered = "prefix bold suffix tail";
	const record = makeParagraphRecordRecordForInline(raw, rendered, 20);
	const lines = record.lines;
	assert.ok(lines.length > 1, "fixture must wrap");
	// select from column 7 (after "prefix ") to the end of the last row
	const selectedRows = lines.map((_, i) => i);
	const lastWidth = visibleWidth(lines[lines.length - 1]!);
	const resolution = makeResolved(record, selectedRows, lines, 1 + 7, lastWidth);
	const result = emitRaw(deps, resolution);
	assert.equal(result, "**bold suffix** tail");
});

function makeParagraphRecordRecordForInline(raw: string, rendered: string, width = 30): MarkdownRecord {
	const paddingX = 1;
	const contentWidth = width - paddingX * 2;
	const fragments = wrapTextWithAnsi(rendered, contentWidth);
	const call: TokenCallRecord = {
		token: { type: "paragraph", raw: `${raw}\n` },
		width: contentWidth,
		outputs: [rendered],
		children: [],
		cells: [],
	};
	const lines = fragments.map((fragment) => " ".repeat(paddingX) + fragment);
	return {
		component: { text: raw, paddingX },
		width,
		text: raw,
		contentWidth,
		paddingX,
		topCalls: [call],
		lines,
	};
}

test("raw emission: latex partial selection keeps the whole math span", () => {
	const raw = "before $x^2$ after";
	const rendered = "before 𝑥² after";
	const record = makeParagraphRecordRecordForInline(raw, rendered, 14);
	const lines = record.lines;
	assert.ok(lines.length > 1, "fixture must wrap");
	// cut on the first row inside the rendered formula; snaps to the $...$ span
	const formulaCellCol = visibleWidth(" before ") + 1; // screen col of the second formula cell
	const selectedRows = lines.map((_, i) => i);
	const lastWidth = visibleWidth(lines[lines.length - 1]!);
	const resolution = makeResolved(record, selectedRows, lines, formulaCellCol, lastWidth);
	const result = emitRaw(deps, resolution);
	assert.equal(result, "$x^2$ after");
});

test("raw emission: non-markdown runs degrade per-part to unwrapped text", () => {
	const text = "alpha beta gamma delta epsilon zeta eta theta";
	const record = makeParagraphRecord(text, 30);
	const paragraphRows = [0, 1].filter((row) => row < record.lines.length - 1);
	const toolLine = "▸ bash · $ npm test";
	const entries: ResolvedSelection["mapping"]["entries"] = [];
	const markdown: ResolvedSelection["mapping"]["markdown"] = [];
	const lines: string[] = [];
	const origins = buildMarkdownOrigins(deps, record);
	for (const row of paragraphRows) {
		const group = origins.origins[row]!;
		entries.push({ record, group, text: origins.groups[group] ?? "" });
		markdown.push({ record, localRow: row });
		lines.push(record.lines[row]!);
	}
	entries.push(undefined);
	markdown.push(undefined);
	lines.push(` ${toolLine}`);
	const resolution: ResolvedSelection = {
		bounds: {
			start: { row: 0, col: 0 },
			end: { row: lines.length - 1, col: visibleWidth(lines[lines.length - 1]!), boundary: false },
		},
		sourceLines: lines,
		contentWidth: record.contentWidth,
		mapping: { entries, lines, markdown },
	};
	const result = emitRaw(deps, resolution);
	// markdown rows emit their logical line; the tool row degrades to text
	assert.ok(result !== undefined);
	const [first, second] = result!.split("\n");
	assert.equal(first, text);
	assert.equal(second, toolLine);
});

test("normalizeSelectionConfig: trimPadding defaults on, explicit off respected", () => {
	assert.equal(normalizeSelectionConfig(undefined).trimPadding, true);
	assert.equal(normalizeSelectionConfig({ copy: "raw" }).trimPadding, true);
	assert.equal(normalizeSelectionConfig({ trimPadding: false }).trimPadding, false);
	assert.equal(normalizeSelectionConfig({ trimPadding: true }).trimPadding, true);
});

test("toggleSelectionTrimPadding flips the switch", () => {
	let config = structuredClone(DEFAULT_CONFIG);
	assert.equal(config.selection.trimPadding, true);
	config = toggleSelectionTrimPadding(config);
	assert.equal(config.selection.trimPadding, false);
});

test("trimHighlightColumns clamps to content and skips padded rows", () => {
	const line = " content here   "; // left margin + trailing padding
	// full-width selection trims to the content span
	const full = trimHighlightColumns(deps, line, 0, visibleWidth(line));
	assert.deepEqual(full, { start: 1, end: 13 });
	// selection inside the content is untouched
	const inside = trimHighlightColumns(deps, line, 5, 8);
	assert.deepEqual(inside, { start: 5, end: 8 });
	// selection only over the padding disappears
	const padOnly = trimHighlightColumns(deps, line, 0, 1);
	assert.equal(padOnly, undefined);
	// blank rows never highlight
	assert.equal(trimHighlightColumns(deps, "    ", 0, 4), undefined);
	// CJK content measures by display columns
	const cjk = " \u4f60\u597d\u4e16\u754c";
	const cjkTrim = trimHighlightColumns(deps, cjk, 0, visibleWidth(cjk));
	assert.deepEqual(cjkTrim, { start: 1, end: 9 });
});

// ---------------------------------------------------------------------------
// Integration: real pi-tui Markdown pipeline (records via the real wrapper)
// ---------------------------------------------------------------------------

const identityTheme = {
	heading: (t: string) => t, link: (t: string) => t, linkUrl: (t: string) => t, code: (t: string) => t,
	codeBlock: (t: string) => t, codeBlockBorder: (t: string) => t, quote: (t: string) => t, quoteBorder: (t: string) => t,
	hr: (t: string) => t, listBullet: (t: string) => t, bold: (t: string) => t, italic: (t: string) => t,
	strikethrough: (t: string) => t, underline: (t: string) => t,
} as const;

test("integration: raw copy of a fully selected real-rendered table yields the pipe source", () => {
	const cleanup = installSelectionCopy({
		Markdown: { prototype: Markdown.prototype },
		// biome-ignore lint: partial module is fine — only Markdown is exercised
	} as unknown as Parameters<typeof installSelectionCopy>[0]);
	try {
		const source = [
			"intro paragraph before the table",
			"",
			"| 模式 | 复制结果 |",
			"|------|------|",
			"| 视觉内容 | 逐显示行无边距空格 |",
			"| 逻辑内容 | 每行拼回单行画法长文本长文本长文本 |",
			"",
			"tail text",
		].join("\n");
		const md = new Markdown(source, 1, 0, identityTheme as never, undefined, undefined);
		const width = 56;
		const lines = md.render(width);
		const mdRecord = __testing.markdownRecords.get(md as never);
		assert.ok(mdRecord, "recording captured");
		const origins = buildMarkdownOrigins(deps, mdRecord);
		const tableIdx = mdRecord.topCalls.findIndex((call) => call.token.type === "table");
		assert.ok(tableIdx >= 0, "table token recorded");
		const tableCall = origins.callRows[tableIdx]!;
		const rows: number[] = [];
		for (let r = tableCall.start; r < tableCall.end; r++) rows.push(r);
		const selectedLines = rows.map((r) => lines[r]!);
		const resolution = {
			bounds: {
				start: { row: rows[0]!, col: 0 },
				end: { row: rows[rows.length - 1]!, col: visibleWidth(selectedLines[selectedLines.length - 1]!), boundary: false },
			},
			sourceLines: lines,
			contentWidth: mdRecord.contentWidth,
			mapping: {
				entries: rows.map((r) => {
					const group = origins.origins[r]!;
					return group >= 0 ? { record: mdRecord, group, text: origins.groups[group] ?? "" } : undefined;
				}),
				lines: selectedLines,
				markdown: rows.map((r) => ({ record: mdRecord, localRow: r })),
			},
		} as unknown as ResolvedSelection;
		const result = emitRaw(deps, resolution);
		assert.ok(result !== undefined, "raw emission produced text");
		assert.ok(result!.startsWith("| 模式 |"), "pipe source, not the drawn form");
		assert.ok(result!.includes("| 视觉内容 | 逐显示行无边距空格 |"), "data row source");
	} finally {
		cleanup();
	}
});

// ---------------------------------------------------------------------------
// Alignment drift + Box descent (user-message scenarios)
// ---------------------------------------------------------------------------

test("alignment survives blank-row drops inside a segment (monotonic cursor)", () => {
	// Child renders 5 lines: [blank, A, B, C, blank]; the document dropped the
	// leading blank (duplicate-blank dedup) and the trailing blank.
	const childLines = ["", " A", " B", " C", ""];
	const document = [" A", " B", " C"];
	const segment = { start: 10, end: 13, child: {} };
	const memo = { renders: new Map(), walks: new Map(), cursors: new Map() } as never;
	for (let i = 0; i < document.length; i++) {
		const local = (selectionCopyInternals as never as {
			alignChildRow: (deps: SelectionDeps, memo: never, line: string, seg: typeof segment, row: number, lines: string[]) => number | undefined;
		}).alignChildRow(deps, memo, document[i]!, segment, segment.start + i, childLines);
		assert.equal(local, i + 1, `row ${i} aligns past the dropped blank`);
	}
});

test("alignment drift beyond the search window degrades to opaque", () => {
	const childLines = Array.from({ length: 20 }, (_, i) => ` line-${i}`);
	const segment = { start: 0, end: 1, child: {} };
	const memo = { renders: new Map(), walks: new Map(), cursors: new Map() } as never;
	const local = (selectionCopyInternals as never as {
		alignChildRow: (deps: SelectionDeps, memo: never, line: string, seg: typeof segment, row: number, lines: string[]) => number | undefined;
	}).alignChildRow(deps, memo, " line-19", segment, 0, childLines);
	assert.equal(local, undefined);
});

test("integration: raw copy descends Box-wrapped markdown (user message shape)", () => {
	const { Box, Container, Markdown } = piTui;
	const cleanup = installSelectionCopy(piTui as never);
	try {
		const source = [
			"| 类别 | 旧 | 新 |",
			"|------|------|------|",
			"| 环境变量 | OPEN_TUI_DEBUG | ASTERISK_TUI_DEBUG |",
		].join("\n");
		const md = new Markdown(source, 0, 0, identityTheme as never, undefined, undefined);
		// UserMessageComponent shape: Container → Box(padding 1, bg) → Markdown
		const box = new Box(1, 1, (t: string) => `\x1b[48;2;52;53;65m${t}\x1b[0m`);
		box.addChild(md);
		const outer = new Container();
		outer.addChild(box);
		const width = 60;
		const lines = outer.render(width);
		assert.ok(lines.length > 3, "box renders padding + table");
		const mdRecord = __testing.markdownRecords.get(md as never);
		assert.ok(mdRecord, "markdown recorded");
		const find = selectionCopyInternals.findLeafAtLine as typeof findLeafAtLine;
		// find the first table row (after top padding + border + header)
		const headerIndex = lines.findIndex((line) => stripTerminalSequences(line).includes("类别"));
		assert.ok(headerIndex > 0, "header row found");
		const hit = find(deps, outer, width, headerIndex);
		assert.ok(hit, "leaf found through the Box");
		assert.equal(hit!.record, mdRecord);
		assert.ok(hit!.localRow >= 0);
	} finally {
		cleanup();
	}
});

// ---------------------------------------------------------------------------
// E2E: real pi-tui components + real turn-collapse walk + real selection-copy
// pipeline (the layer where the wild blank-drop and Box bugs lived)
// ---------------------------------------------------------------------------

test("e2e: raw copy of a table inside a user message (Box-wrapped, OSC133, blank-dedup walk)", () => {
	const cleanupInstall = installSelectionCopy(piTui as never);
	const resetCollapseE2E = () =>
		setCollapseOptions({ mode: "group-all", style: "compact", thought: "default", tools: {}, retryErrors: true, liveThinking: true, liveTools: true });
	resetCollapseE2E();
	try {
		const userTable = [
			"| 类别 | 旧 | 新 |",
			"|------|------|------|",
			"| 环境变量 | OPEN_TUI_DEBUG | ASTERISK_TUI_DEBUG |",
			"| 运行时身份键 | open-tui.* | asterisk-tui.* |",
		].join("\n");
		const assistantText = "这是一段足够长的中文文本用来验证软换行拼回单一逻辑行不引入多余空格并且还会继续变长以触发至少一次折行";
		// UserMessageComponent shape: text/rebuild + Container → Box(1,1,bg) → Markdown
		const userMd = new Markdown(userTable, 0, 0, identityTheme as never, undefined, undefined);
		const userBox = new Box(1, 1, (t: string) => `\x1b[48;2;52;53;65m${t}\x1b[0m`);
		userBox.addChild(userMd);
		const userInner = new Container();
		userInner.addChild(userBox);
		const userMessage = {
			text: userTable,
			rebuild() {},
			children: userInner.children,
			render: (width: number) => {
				const lines = userInner.render(width);
				if (lines.length > 0) {
					lines[0] = `\x1b]133;A\x07${lines[0]}`;
					lines[lines.length - 1] = `\x1b]133;B\x07\x1b]133;C\x07${lines[lines.length - 1]}`;
				}
				return lines;
			},
		};
		// AssistantMessageComponent shape: Container → contentContainer → Markdown
		const assistantMd = new Markdown(assistantText, 1, 0, identityTheme as never, undefined, undefined);
		const assistantContent = new Container();
		assistantContent.addChild(assistantMd);
		const assistantMessage = {
			hideThinkingBlock: true,
			setHideThinkingBlock() {},
			children: assistantContent.children,
			render: (width: number) => {
				const lines = assistantContent.render(width);
				if (lines.length > 0) {
					lines[0] = `\x1b]133;A\x07${lines[0]}`;
					lines[lines.length - 1] = `\x1b]133;B\x07\x1b]133;C\x07${lines[lines.length - 1]}`;
				}
				return lines;
			},
		};
		const chat = {
			children: [userMessage, assistantMessage],
			render: (w: number) => renderCollapsedForTest(chat, w),
		};
		attachForTest(chat);
		const width = 40;
		const lines = chat.render(width); // the real patched pipeline
		// sanity: the walked document contains the user table and assistant text
		assert.ok(lines.some((l) => stripTerminalSequences(l).includes("│ 类别")), "user table rendered in walk output");

		const scrollView = { scrollTop: 0 };
		const view = {
			getSelectionBounds: () => ({
				start: { row: 0, col: 0, scrollView },
				end: { row: lines.length - 1, col: visibleWidth(lines[lines.length - 1] ?? ""), boundary: false },
			}),
			currentLayout: {
				root: {
					scrollView,
					scrollContentLines: lines,
					children: [{ component: chat, rect: { x: 0, y: 0, width, height: lines.length } }],
				},
			},
		};
		const resolution = resolveSelectionRows(deps, view);
		assert.ok(resolution, "resolution built through the real walk");
		const raw = emitRaw(deps, resolution);
		assert.ok(raw !== undefined, "raw emission");
		// user-message markdown contributes its pipe source
		assert.ok(raw!.includes("| 环境变量 | OPEN_TUI_DEBUG | ASTERISK_TUI_DEBUG |"), `pipe source in:\n${raw}`);
		// assistant text contributes unwrapped logical line
		assert.ok(raw!.split("\n").some((l) => l.includes("这是一段足够长的中文文本")), "assistant logical line present");
		// unwrapped over the same selection: assistant paragraph joins to one line
		const unwrapped = emitUnwrapped(deps, resolution);
		assert.ok(unwrapped!.split("\n").some((l) => l.replace(/\s/g, "") === assistantText), "assistant paragraph joined as one line");
	} finally {
		uninstallTurnCollapse();
		cleanupInstall();
	}
});

test("raw emission keeps blank-line separation between blocks (space tokens)", () => {
	const cleanupInstall = installSelectionCopy(piTui as never);
	try {
	const source = [
		"## 标题一",
		"",
		"第一段正文。",
		"",
		"| a | b |",
		"|---|---|",
		"| 1 | 2 |",
	].join("\n");
	const md = new Markdown(source, 1, 0, identityTheme as never, undefined, undefined);
	const width = 40;
	const lines = md.render(width);
	const mdRecord = __testing.markdownRecords.get(md as never);
	assert.ok(mdRecord, "recorded");
	const origins = buildMarkdownOrigins(deps, mdRecord);
	// Select every non-blank row but NOT the blank separator rows.
	const selectedRows: number[] = [];
	for (let r = 0; r < lines.length; r++) {
		if (stripTerminalSequences(lines[r]!).trim() !== "") selectedRows.push(r);
	}
	const selectedLines = selectedRows.map((r) => lines[r]!);
	// Start mid-line on the heading (col 2, past "##") — a drag that begins
	// inside the first line. The whole-component shortcut must NOT fire; the
	// per-call path runs and must still preserve blank-line separators.
	const resolution = {
		bounds: {
			start: { row: selectedRows[0]!, col: 2 },
			end: { row: selectedRows[selectedRows.length - 1]!, col: visibleWidth(selectedLines[selectedLines.length - 1]!), boundary: false },
		},
		sourceLines: lines,
		contentWidth: mdRecord.contentWidth,
		mapping: {
			entries: selectedRows.map((r) => {
				const g = origins.origins[r]!;
				return g >= 0 ? { record: mdRecord, group: g, text: origins.groups[g] ?? "" } : undefined;
			}),
			lines: selectedLines,
			markdown: selectedRows.map((r) => ({ record: mdRecord, localRow: r })),
		},
	} as unknown as ResolvedSelection;
	const result = emitRaw(deps, resolution);
	assert.ok(result !== undefined);
	assert.ok(
		result!.includes("## 标题一\n\n第一段正文。"),
		`heading separated from paragraph by a blank line:\n${JSON.stringify(result)}`,
	);
	assert.ok(
		result!.includes("第一段正文。\n\n| a | b |"),
		`paragraph separated from table by a blank line:\n${JSON.stringify(result)}`,
	);
	} finally {
		cleanupInstall();
	}
});

test("e2e: raw copy keeps fenced code blocks verbatim (indentation, fences, inline code)", () => {
	const cleanupInstall = installSelectionCopy(piTui as never);
	try {
		const source = [
			"改造前：",
			"",
			"```ts",
			"	const a = {",
			"		b: 1,",
			"	};",
			"```",
			"",
			"以及 `inline code` 与 **bold**。",
		].join("\n");
		const md = new Markdown(source, 1, 0, identityTheme as never, undefined, undefined);
		const width = 46;
		const lines = md.render(width);
		const mdRecord = __testing.markdownRecords.get(md as never);
		assert.ok(mdRecord, "recorded");
		const origins = buildMarkdownOrigins(deps, mdRecord);
		const selectedRows = lines.map((_, i) => i);
		const selectedLines = selectedRows.map((r) => lines[r]!);
		const resolution = {
			bounds: {
				start: { row: 0, col: 2 }, // mid-line start: forces the per-call path
				end: { row: lines.length - 1, col: visibleWidth(selectedLines[selectedLines.length - 1]!), boundary: false },
			},
			sourceLines: lines,
			contentWidth: mdRecord.contentWidth,
			mapping: {
				entries: selectedRows.map((r) => {
					const g = origins.origins[r]!;
					return g >= 0 ? { record: mdRecord, group: g, text: origins.groups[g] ?? "" } : undefined;
				}),
				lines: selectedLines,
				markdown: selectedRows.map((r) => ({ record: mdRecord, localRow: r })),
			},
		} as unknown as ResolvedSelection;
		const result = emitRaw(deps, resolution);
		assert.ok(result !== undefined);
		assert.ok(result!.includes("```ts"), "opening fence preserved");
		assert.ok(result!.includes("```\n"), "closing fence preserved");
		// pi-tui normalizes tabs to 3 spaces BEFORE lexing, so per-call raws carry
		// the normalized form; only whole-message coverage returns this.text verbatim.
		assert.ok(result!.includes("   b: 1,"), "code indentation preserved (tabs normalized to 3 spaces by the renderer)");
		assert.ok(result!.includes("`inline code`"), "inline code backticks preserved");
		assert.ok(result!.includes("**bold**"), "bold markers preserved");
	} finally {
		cleanupInstall();
	}
});
