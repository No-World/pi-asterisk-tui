/**
 * Selection copy with soft-wrap awareness (fullscreen TUI).
 *
 * pi-tui's fullscreen selection copies visual rows verbatim, so a logical
 * line that wrapped across N screen rows is pasted as N lines. This module
 * makes copy emit logical lines instead:
 *
 *   plain     — stock behavior (visual rows).
 *   unwrapped — WYSIWYG: wrapped rows join back into one line (paragraphs,
 *               headings, list items, quote lines, table rows with wrapped
 *               cells). What the screen shows is what you get, minus the
 *               wrapping. Default.
 *   raw       — source text: a selection that decomposes into complete
 *               markdown blocks (or one whole message) copies the
 *               pre-render source (`**bold**`, `$x^2$`, table pipes). Any
 *               impure selection downgrades WHOLE to unwrapped — raw and
 *               rendered text never mix in one clipboard blob.
 *
 * Mechanism (version-guarded, inert on mismatch — same policy as
 * thinking-click.ts / turn-collapse.ts):
 *
 * 1. Markdown.prototype.render is wrapped: during a fresh render the
 *    instance's renderToken (and wrapCellText) methods are intercepted,
 *    recording the pre-wrap token output lines — the logical lines — as a
 *    call tree. Recordings live in a WeakMap keyed per component and are
 *    reused on render cache hits.
 * 2. Text.prototype.render is wrapped the same way (logical lines come from
 *    splitting the source text).
 * 3. TuiAltScreen.prototype.getActiveSelectionText is replaced: selected
 *    content rows are mapped to owning components via turn-collapse's
 *    segments plus a transparency-verified container walk, then to logical
 *    lines via the recordings. Every mapped row is verified against the
 *    actual document row (ANSI-stripped equality); any mismatch degrades
 *    that row to stock behavior — never garbage.
 *
 * Wrap decisions are reproduced with pi-tui's own pure wrapTextWithAnsi
 * (resolved from the SAME module instance pi core uses), so continuation
 * detection is exact, not a width heuristic.
 */

import { childSegmentAt, lineIndexInAttachedContainer } from "./turn-collapse.ts";
import type { SelectionCopyMode } from "./config.ts";

const DEBUG_LOG = process.env.OPEN_TUI_DEBUG;
function debug(message: string): void {
	if (!DEBUG_LOG) return;
	try {
		// eslint-disable-next-line @typescript-eslint/no-require-imports
		const fs = require("node:fs") as typeof import("node:fs");
		fs.appendFileSync(DEBUG_LOG, `${Date.now()} [selection-copy] ${message}\n`);
	} catch {
		// Diagnostics are best-effort.
	}
}

/** Pure helpers resolved from pi-tui (injectable for tests). */
export interface SelectionDeps {
	wrapTextWithAnsi: (text: string, width: number) => string[];
	visibleWidth: (line: string) => number;
	sliceByColumn: (line: string, start: number, length: number, strict?: boolean) => string;
	strip: (line: string) => string;
	/** Optional: reproduces inline latex rendering for raw slicing alignment. */
	renderLatex?: (text: string, options?: { display?: boolean }) => string | null | undefined;
	/** Optional: OSC8 hyperlink capability for raw slicing alignment. */
	hyperlinks?: () => boolean;
}

let copyMode: SelectionCopyMode = "unwrapped";

/** Current copy mode (index.ts feeds this from asterisk-tui.json). */
export function setSelectionCopyMode(mode: SelectionCopyMode): void {
	copyMode = mode;
}

// ---------------------------------------------------------------------------
// Recordings
// ---------------------------------------------------------------------------

interface TokenLike {
	type?: unknown;
	raw?: unknown;
}

/** One intercepted renderToken call: pre-wrap output lines = logical lines. */
export interface TokenCallRecord {
	token: TokenLike;
	width: number;
	outputs: string[];
	children: TokenCallRecord[];
	/** wrapCellText calls that happened under this call (tables). */
	cells: CellCallRecord[];
}

export interface CellCallRecord {
	text: string;
	result: string[];
}

export interface MarkdownComponentLike {
	text: unknown;
	paddingX?: number;
	renderToken?: unknown;
	wrapCellText?: unknown;
	cachedLines?: string[];
}

export interface MarkdownRecord {
	component: MarkdownComponentLike;
	width: number;
	text: unknown;
	contentWidth: number;
	paddingX: number;
	topCalls: TokenCallRecord[];
	lines: string[];
	origins?: MdOriginInfo | undefined;
}

export interface TextComponentLike {
	text: unknown;
	paddingX?: number;
	cachedLines?: string[];
}

export interface TextRecord {
	component: TextComponentLike;
	width: number;
	text: unknown;
	lines: string[];
	origins?: TextOriginInfo | undefined;
}

const markdownRecords = new WeakMap<object, MarkdownRecord>();
const textRecords = new WeakMap<object, TextRecord>();

// ---------------------------------------------------------------------------
// Origin computation (Markdown)
// ---------------------------------------------------------------------------

/** A drawn row of a top-level call, pre top-level wrap and margins. */
interface DrawnRow {
	plain: string;
	group: number;
}

export interface MdOriginInfo {
	/** Logical line texts (plain; visible prefixes kept once). */
	groups: string[];
	/** Per component output row: group index, or -1 when opaque. */
	origins: number[];
	/** Per top-level call: its contiguous row range, token.raw, and (lists/
	 * quotes) which nested child produced each group. */
	callRows: Array<{
		start: number;
		end: number;
		raw: string | undefined;
		ownerByGroup?: Map<number, { child: number; output: number }>;
	}>;
}

/** Derives table column widths from the drawn top border `┌─w0─┬─w1─┐`. */
function deriveColumnWidths(topBorder: string, numCols: number): number[] | undefined {
	if (!topBorder.startsWith("┌") || !topBorder.endsWith("┐")) return undefined;
	const parts = topBorder.slice(1, -1).split("─┬─");
	if (parts.length !== numCols) return undefined;
	const widths: number[] = [];
	for (let i = 0; i < parts.length; i++) {
		const part = parts[i]!;
		if (!/^[─]+$/.test(part)) return undefined;
		let width = part.length;
		if (parts.length === 1) {
			if (part.length < 2) return undefined;
			width = part.length - 2;
		} else if (i === 0) {
			width = part.length - 1;
		} else if (i === parts.length - 1) {
			width = part.length - 1;
		}
		if (width < 1) return undefined;
		widths.push(width);
	}
	return widths;
}

/** Tables: drawn rows rebuilt from wrapCellText records; wrapped cells rejoin. */
function modelTableRows(deps: SelectionDeps, call: TokenCallRecord, groups: string[]): DrawnRow[] | undefined {
	const token = call.token as { header?: unknown[]; rows?: unknown[] };
	const numCols = Array.isArray(token.header) ? token.header.length : 0;
	const totalRows = Array.isArray(token.rows) ? token.rows.length : 0;
	if (numCols === 0 || call.cells.length !== (totalRows + 1) * numCols) return undefined;
	const plain = (value: string) => deps.strip(value);
	const outputs = call.outputs.map((line) => plain(line));
	if (outputs.length === 0) return undefined;
	const widths = deriveColumnWidths(outputs[0]!, numCols);
	if (!widths) return undefined;
	const headerCells = call.cells.slice(0, numCols);
	const bodyCells: CellCallRecord[][] = [];
	for (let r = 0; r < totalRows; r++) bodyCells.push(call.cells.slice((r + 1) * numCols, (r + 2) * numCols));
	// Every recorded fragment must fit its column (post-strip, trimmed).
	for (const cell of call.cells) {
		void cell;
	}
	for (let i = 0; i < call.cells.length; i++) {
		const colIdx = i % numCols;
		for (const fragment of call.cells[i]!.result) {
			if (deps.visibleWidth(plain(fragment).trimEnd()) > widths[colIdx]!) return undefined;
		}
	}
	const rows: DrawnRow[] = [];
	const sep = `├─${widths.map((w) => "─".repeat(w)).join("─┼─")}─┤`;
	const bottom = `└─${widths.map((w) => "─".repeat(w)).join("─┴─")}─┘`;
	const cellUnwrapped = (cell: CellCallRecord): string => plain(cell.text).trimEnd();
	const pushStructural = (line: string): void => {
		rows.push({ plain: line, group: -1 });
		void groups;
	};
	const pushDataRow = (cells: CellCallRecord[]): void => {
		const height = Math.max(...cells.map((cell) => cell.result.length));
		let groupIndex = -1;
		if (height > 0) {
			groupIndex = groups.length;
			groups.push(`│ ${cells.map(cellUnwrapped).join(" │ ")} │`);
		}
		for (let lineIdx = 0; lineIdx < height; lineIdx++) {
			const parts = cells.map((cell, colIdx) => {
				const text = plain(cell.result[lineIdx] ?? "").trimEnd();
				return text + " ".repeat(Math.max(0, widths[colIdx]! - deps.visibleWidth(text)));
			});
			rows.push({ plain: `│ ${parts.join(" │ ")} │`, group: groupIndex });
		}
	};
	pushStructural(outputs[0]!);
	pushDataRow(headerCells);
	pushStructural(sep);
	for (let r = 0; r < totalRows; r++) {
		pushDataRow(bodyCells[r]!);
		if (r < totalRows - 1) pushStructural(sep);
	}
	pushStructural(bottom);
	// Verify the rebuilt rows against the call's actual outputs.
	if (rows.length !== outputs.length) return undefined;
	for (let i = 0; i < rows.length; i++) {
		if (rows[i]!.plain.trimEnd() !== outputs[i]!.trimEnd()) return undefined;
	}
	return rows;
}

/** Blockquotes: `│ ` + wrapped styled line; strip-equal to wrapping the bare line. */
function modelQuoteRows(
	deps: SelectionDeps,
	call: TokenCallRecord,
	groups: string[],
	ownerByGroup: Map<number, { child: number; output: number }>,
): DrawnRow[] | undefined {
	const quoteWidth = Math.max(1, call.width - 2);
	const rows: DrawnRow[] = [];
	const outputs: string[] = [];
	for (let childIndex = 0; childIndex < call.children.length; childIndex++) {
		const child = call.children[childIndex]!;
		for (let outputIndex = 0; outputIndex < child.outputs.length; outputIndex++) {
			const output = child.outputs[outputIndex]!;
			const group = groups.length;
			ownerByGroup.set(group, { child: childIndex, output: outputIndex });
			groups.push(`│ ${deps.strip(output).trimEnd()}`);
			for (const fragment of deps.wrapTextWithAnsi(output, quoteWidth)) {
				const plain = `│ ${deps.strip(fragment)}`;
				rows.push({ plain, group });
				outputs.push(plain);
			}
		}
	}
	// The renderer pops trailing blank quote lines before drawing.
	while (rows.length > 0 && rows[rows.length - 1]!.plain.trim() === "│") rows.pop();
	if (rows.length === 0) return [];
	const actual = call.outputs.map((line) => deps.strip(line).trimEnd());
	if (actual.length !== rows.length) return undefined;
	for (let i = 0; i < rows.length; i++) {
		if (rows[i]!.plain.trimEnd() !== actual[i]!) return undefined;
	}
	return rows;
}

/**
 * Lists: renderList wraps each item line at itemWidth (the width of the
 * nested renderToken call) and prefixes every wrapped row. Prefix width =
 * list width − item width; the prefix text comes from the first drawn row
 * (bullet as displayed), continuation rows contribute only their content.
 */
function modelListRows(
	deps: SelectionDeps,
	call: TokenCallRecord,
	groups: string[],
	ownerByGroup: Map<number, { child: number; output: number }>,
): DrawnRow[] | undefined {
	const rows: DrawnRow[] = [];
	const queue: Array<{
		child: number;
		outputIndex: number;
		childCall: TokenCallRecord;
		output: string;
		fragments: string[];
		index: number;
		group?: number;
	}> = [];
	for (let childIndex = 0; childIndex < call.children.length; childIndex++) {
		const child = call.children[childIndex]!;
		for (let outputIndex = 0; outputIndex < child.outputs.length; outputIndex++) {
			queue.push({
				child: childIndex,
				outputIndex,
				childCall: child,
				output: child.outputs[outputIndex]!,
				fragments: deps.wrapTextWithAnsi(child.outputs[outputIndex]!, child.width),
				index: 0,
			});
		}
	}
	let queueIndex = 0;
	const opaque = (output: string): void => {
		rows.push({ plain: deps.strip(output), group: -1 });
	};
	const tailOf = (output: string, prefixWidth: number): string =>
		deps.strip(deps.sliceByColumn(output, prefixWidth, deps.visibleWidth(output))).trimEnd();
	for (const output of call.outputs) {
		const entry = queue[queueIndex];
		if (entry) {
			const prefixWidth = Math.max(0, call.width - entry.childCall.width);
			const tail = tailOf(output, prefixWidth);
			const expected = deps.strip(entry.fragments[entry.index] ?? "").trimEnd();
			if (tail === expected) {
				if (entry.index === 0) {
					const prefixText = deps.strip(deps.sliceByColumn(output, 0, prefixWidth));
					entry.group = groups.length;
					ownerByGroup.set(entry.group, { child: entry.child, output: entry.outputIndex });
					groups.push(`${prefixText}${deps.strip(entry.output).trimEnd()}`);
				}
				entry.index += 1;
				if (entry.index >= entry.fragments.length) queueIndex += 1;
				rows.push({ plain: deps.strip(entry.fragments[entry.index - 1] ?? ""), group: entry.group ?? -1 });
				continue;
			}
			// Mismatch: resync by scanning for a queue entry whose current
			// fragment matches this row under that entry's prefix width.
			let resynced = false;
			for (let probe = queueIndex; probe < queue.length; probe++) {
				const candidate = queue[probe]!;
				const candidatePrefix = Math.max(0, call.width - candidate.childCall.width);
				const candidateTail = tailOf(output, candidatePrefix);
				const candidateExpected = deps.strip(candidate.fragments[candidate.index] ?? "").trimEnd();
				if (candidateTail === candidateExpected && candidateExpected !== "") {
					queueIndex = probe;
					resynced = true;
					break;
				}
			}
			if (resynced) {
				const entry2 = queue[queueIndex]!;
				const prefixWidth = Math.max(0, call.width - entry2.childCall.width);
				if (entry2.index === 0) {
					const prefixText = deps.strip(deps.sliceByColumn(output, 0, prefixWidth));
					entry2.group = groups.length;
					ownerByGroup.set(entry2.group, { child: entry2.child, output: entry2.outputIndex });
					groups.push(`${prefixText}${deps.strip(entry2.output).trimEnd()}`);
				}
				entry2.index += 1;
				if (entry2.index >= entry2.fragments.length) queueIndex += 1;
				rows.push({ plain: deps.strip(entry2.fragments[entry2.index - 1] ?? ""), group: entry2.group ?? -1 });
				continue;
			}
		}
		// Unmodeled row: loose spacing, nested list, or fallback line.
		opaque(output);
	}
	return rows;
}

/**
 * Replays one top-level call into drawn rows. Simple constructs (paragraph,
 * heading, text, latexBlock, code, hr, space, html) treat every output line
 * as one logical line. Returns undefined when verification fails — the call
 * degrades to fully opaque rows (row counts stay exact).
 */
function modelCallRows(
	deps: SelectionDeps,
	call: TokenCallRecord,
	groups: string[],
	ownerByGroup: Map<number, { child: number; output: number }>,
): DrawnRow[] | undefined {
	const tokenType = typeof call.token.type === "string" ? call.token.type : "";
	if (tokenType === "table") return modelTableRows(deps, call, groups);
	if (tokenType === "blockquote") return modelQuoteRows(deps, call, groups, ownerByGroup);
	if (tokenType === "list") return modelListRows(deps, call, groups, ownerByGroup);
	const rows: DrawnRow[] = [];
	for (const output of call.outputs) {
		const group = groups.length;
		groups.push(deps.strip(output).trimEnd());
		rows.push({ plain: deps.strip(output), group });
	}
	return rows;
}

/**
 * Builds (and caches on the record) the row→logical-line mapping for a
 * Markdown component recording. Each drawn row expands through the
 * top-level wrap (wide rows split further); every final row is verified
 * against the actual rendered line — mismatches degrade that row to opaque.
 */
export function buildMarkdownOrigins(deps: SelectionDeps, record: MarkdownRecord): MdOriginInfo {
	if (record.origins) return record.origins;
	const groups: string[] = [];
	const origins: number[] = [];
	const callRows: MdOriginInfo["callRows"] = [];
	const margin = " ".repeat(record.paddingX);
	let cursor = 0;
	let verified = 0;
	const pushFinalRows = (drawn: DrawnRow[], call: TokenCallRecord): void => {
		for (const row of drawn) {
			for (const fragment of deps.wrapTextWithAnsi(row.plain, record.contentWidth)) {
				const actual = record.lines[cursor];
				if (typeof actual === "string" && deps.strip(actual).trimEnd() === (margin + fragment).trimEnd()) {
					origins.push(row.group);
					verified += 1;
				} else {
					origins.push(-1);
				}
				cursor += 1;
			}
		}
		void call;
	};
	for (const call of record.topCalls) {
		const start = cursor;
		const ownerByGroup = new Map<number, { child: number; output: number }>();
		const modeled = modelCallRows(deps, call, groups, ownerByGroup);
		if (modeled && modeled.length > 0) {
			pushFinalRows(modeled, call);
		} else {
			// Unmodeled or empty-modeled: rows are the top-level wrap of the
			// call's outputs (row counts stay exact), each row its own line.
			for (const output of call.outputs) {
				const group = groups.length;
				groups.push(deps.strip(output).trimEnd());
				pushFinalRows([{ plain: deps.strip(output), group }], call);
			}
		}
		callRows.push({
			start,
			end: cursor,
			raw: typeof call.token.raw === "string" ? call.token.raw : undefined,
			ownerByGroup: ownerByGroup.size > 0 ? ownerByGroup : undefined,
		});
	}
	while (cursor < record.lines.length) {
		origins.push(-1);
		cursor += 1;
	}
	if (cursor !== record.lines.length || (verified === 0 && record.lines.length > 0)) {
		debug(`markdown origins: model desync (cursor=${cursor} lines=${record.lines.length})`);
		for (let i = 0; i < origins.length; i++) origins[i] = -1;
	}
	record.origins = { groups, origins, callRows };
	return record.origins;
}

// ---------------------------------------------------------------------------
// Origin computation (Text)
// ---------------------------------------------------------------------------

export interface TextOriginInfo {
	groups: string[];
	/** Per component output row: group index, or -1 when opaque. */
	origins: number[];
}

/**
 * Text components wrap the raw source (tabs → 3 spaces) at
 * width − 2·paddingX. Two padding formulas exist across pi-tui versions;
 * both are tried and whichever reproduces the recorded lines wins.
 */
export function buildTextOrigins(deps: SelectionDeps, record: TextRecord): TextOriginInfo {
	if (record.origins) return record.origins;
	const result: TextOriginInfo = { groups: [], origins: [] };
	const paddingX = typeof record.component.paddingX === "number" ? record.component.paddingX : 1;
	const width = record.width;
	const clamped = Math.min(paddingX, Math.max(0, Math.floor((width - 1) / 2)));
	const paddings = paddingX === clamped ? [paddingX] : [paddingX, clamped];
	const normalized = typeof record.text === "string" ? record.text.replace(/\t/g, "   ") : "";
	const logicalLines = normalized.length === 0 ? [] : normalized.split(/\r\n|\r|\n/);
	for (const padding of paddings) {
		const contentWidth = Math.max(1, width - padding * 2);
		const groups: string[] = [];
		const origins: number[] = [];
		const margin = " ".repeat(padding);
		let cursor = 0;
		let ok = true;
		for (const line of logicalLines) {
			const group = groups.length;
			groups.push(deps.strip(line).trimEnd());
			for (const fragment of deps.wrapTextWithAnsi(line, contentWidth)) {
				const actual = record.lines[cursor];
				if (typeof actual !== "string" || deps.strip(actual).trimEnd() !== (margin + fragment).trimEnd()) {
					ok = false;
				}
				origins.push(group);
				cursor += 1;
			}
		}
		if (ok && cursor === record.lines.length) {
			result.groups = groups;
			result.origins = origins;
			break;
		}
	}
	if (result.groups.length === 0 && record.lines.length > 0) {
		result.origins = record.lines.map(() => -1);
	}
	record.origins = result;
	return result;
}

// ---------------------------------------------------------------------------
// Document-level row resolution
// ---------------------------------------------------------------------------

export interface SelectionPoint {
	row: number;
	col: number;
	scrollView?: unknown;
	boundary?: boolean;
}

/** Per selected row: its logical line (or undefined), plus display line. */
export interface RowMapping {
	entries: Array<{ record: object; group: number; text: string } | undefined>;
	lines: string[];
	/** Markdown leaf info per row for raw mode. */
	markdown: Array<{ record: MarkdownRecord; localRow: number } | undefined>;
}

const OSC133_PREFIX = /^(?:\x1b\]133;[ABC](?:\x07|\x1b\\))+/;
const ANSI_CODE_RE = /\x1b\[[0-9;?]*[A-Za-z]/g;

function isBlankish(line: string | undefined): boolean {
	if (line === undefined) return true;
	return line.replace(OSC133_PREFIX, "").replace(ANSI_CODE_RE, "").trim() === "";
}

function stripEq(deps: SelectionDeps, a: string | undefined, b: string | undefined): boolean {
	if (a === undefined || b === undefined) return false;
	return deps.strip(a.replace(OSC133_PREFIX, "")).trimEnd() === deps.strip(b.replace(OSC133_PREFIX, "")).trimEnd();
}

interface WalkHit {
	record: MarkdownRecord | TextRecord;
	localRow: number;
}

/** Per-copy-invocation walk cache: the document is frozen while the
 * synchronous copy runs, so component renders and transparency checks are
 * computed once per component instead of once per selected row. */
export interface WalkMemo {
	renders: Map<object, string[]>;
	walks: Map<object, { spans: Array<{ component: unknown; start: number; lines: string[] }>; total: number }>;
}

function createWalkMemo(): WalkMemo {
	return { renders: new Map(), walks: new Map() };
}

function memoRender(memo: WalkMemo, component: unknown, width: number): string[] | undefined {
	const existing = memo.renders.get(component as object);
	if (existing) return existing;
	if (typeof component !== "object" || component === null) return undefined;
	try {
		const lines = (component as { render?: (width: number) => string[] }).render?.(width) ?? [];
		if (!Array.isArray(lines)) return undefined;
		memo.renders.set(component as object, lines);
		return lines;
	} catch {
		return undefined;
	}
}

/** Cached transparency walk for one container: child spans + own-render
 * verification, computed once per copy invocation. */
function memoWalk(deps: SelectionDeps, memo: WalkMemo, component: object, width: number): { spans: Array<{ component: unknown; start: number; lines: string[] }>; total: number } | undefined {
	const cached = memo.walks.get(component);
	if (cached) return cached;
	const children = (component as { children?: unknown[] }).children;
	if (!Array.isArray(children) || children.length === 0) return undefined;
	const own = memoRender(memo, component, width);
	if (!own) return undefined;
	const spans: Array<{ component: unknown; start: number; lines: string[] }> = [];
	let total = 0;
	for (const child of children) {
		const lines = memoRender(memo, child, width);
		if (!lines) return undefined;
		spans.push({ component: child, start: total, lines });
		total += lines.length;
	}
	if (total !== own.length) return undefined;
	const flat: string[] = [];
	for (const span of spans) flat.push(...span.lines);
	for (let i = 0; i < own.length; i++) {
		if (!stripEq(deps, own[i], flat[i])) return undefined;
	}
	const result = { spans, total };
	memo.walks.set(component, result);
	return result;
}

/**
 * Finds the Markdown/Text leaf that rendered `localLine` inside a component
 * subtree, recursing only through containers whose render is a plain
 * concatenation of their children (verified once per copy invocation;
 * OSC133 prefixes tolerated). Rows beyond a leaf's own lines are opaque.
 */
export function findLeafAtLine(
	deps: SelectionDeps,
	component: unknown,
	width: number,
	localLine: number,
	memo: WalkMemo = createWalkMemo(),
	depth = 0,
): WalkHit | undefined {
	if (typeof component !== "object" || component === null || depth > 8) return undefined;
	if (localLine < 0) return undefined;
	const mdRecord = markdownRecords.get(component);
	if (mdRecord && mdRecord.width === width) return { record: mdRecord, localRow: localLine < mdRecord.lines.length ? localLine : -1 };
	const txRecord = textRecords.get(component);
	if (txRecord && txRecord.width === width) return { record: txRecord, localRow: localLine < txRecord.lines.length ? localLine : -1 };
	const walk = memoWalk(deps, memo, component, width);
	if (!walk || localLine >= walk.total) return undefined;
	for (const span of walk.spans) {
		if (localLine < span.start + span.lines.length) {
			return findLeafAtLine(deps, span.component, width, localLine - span.start, memo, depth + 1);
		}
	}
	return undefined;
}

interface LayoutBoxLike {
	scrollView?: unknown;
	scrollContentLines?: string[];
	rect?: { width?: number };
	children?: LayoutBoxLike[];
	component?: unknown;
}

function findScrollViewBox(box: LayoutBoxLike | undefined, scrollView: unknown): LayoutBoxLike | undefined {
	if (!box || typeof box !== "object") return undefined;
	if (box.scrollView === scrollView) return box;
	for (const child of box.children ?? []) {
		const hit = findScrollViewBox(child, scrollView);
		if (hit) return hit;
	}
	return undefined;
}

/**
 * Aligns a document row to the child's own render line, tolerating the
 * mutations turn-collapse's walk applies inside a segment: dropped duplicate
 * blanks, dropped label-flow blanks, and inserted separator blanks. The
 * aligned pair is verified against the actual document row — synthesized
 * run-label lines never match and stay opaque.
 */
function alignChildRow(
	deps: SelectionDeps,
	sourceLine: string,
	segment: { start: number; end: number; child: unknown },
	row: number,
	childLines: string[] | undefined,
): number | undefined {
	if (!childLines || childLines.length === 0) return undefined;
	const offset = row - segment.start;
	if (offset < 0) return undefined;
	const candidates: number[] = [];
	if (segment.end - segment.start === childLines.length) {
		if (offset < childLines.length) candidates.push(offset);
	} else {
		// Slow path: replay the blank-dedup walk across the segment.
		let local = 0;
		let seen = 0;
		let prevBlank = false;
		while (local < childLines.length) {
			const childLine = childLines[local]!;
			const blank = isBlankish(childLine);
			if (blank && prevBlank) {
				local += 1;
				continue;
			}
			if (segment.start + seen === row) candidates.push(local);
			seen += 1;
			prevBlank = blank;
			local += 1;
		}
	}
	for (const local of candidates) {
		if (stripEq(deps, sourceLine, childLines[local])) return local;
	}
	return undefined;
}

export interface ResolvedSelection {
	bounds: { start: SelectionPoint; end: SelectionPoint };
	sourceLines: string[];
	contentWidth: number;
	mapping: RowMapping;
}

/**
 * Maps selected document rows to logical lines. Returns undefined when the
 * smart path does not apply (no layout, screen-space selection, unknown
 * structure) — callers then use stock behavior.
 */
export function resolveSelectionRows(
	deps: SelectionDeps,
	view: {
		getSelectionBounds?: () => { start: SelectionPoint; end: SelectionPoint } | undefined;
		currentLayout?: { root?: LayoutBoxLike };
	},
): ResolvedSelection | undefined {
	const bounds = view.getSelectionBounds?.();
	if (!bounds || !bounds.start.scrollView) return undefined;
	const box = findScrollViewBox(view.currentLayout?.root, bounds.start.scrollView);
	const sourceLines = box?.scrollContentLines;
	const childBox = box?.children?.[0];
	const contentWidth = childBox?.rect?.width;
	if (!sourceLines || typeof contentWidth !== "number") return undefined;
	const docComponent = childBox?.component;
	if (typeof docComponent !== "object" || docComponent === null) return undefined;

	// The document→container offset is structural (banners before the chat
	// container); compute it once instead of per row.
	const firstContainerLine = lineIndexInAttachedContainer(docComponent, bounds.start.row, contentWidth);
	if (firstContainerLine === undefined) return undefined;
	const docOffset = bounds.start.row - firstContainerLine;
	const memo = createWalkMemo();

	const entries: RowMapping["entries"] = [];
	const markdown: RowMapping["markdown"] = [];
	const lines: string[] = [];
	for (let row = bounds.start.row; row <= bounds.end.row; row++) {
		const line = sourceLines[row] ?? "";
		lines.push(line);
		let entry: RowMapping["entries"][number];
		let md: RowMapping["markdown"][number];
		const containerLine = row - docOffset;
		const segment = childSegmentAt(containerLine);
		if (segment) {
			const childLines = memoRender(memo, segment.child, contentWidth);
			const local = alignChildRow(deps, line, segment, containerLine, childLines);
			if (local !== undefined) {
				const hit = findLeafAtLine(deps, segment.child, contentWidth, local, memo);
				if (hit && hit.localRow >= 0) {
					if ("topCalls" in hit.record) {
						const record = hit.record as MarkdownRecord;
						const origins = buildMarkdownOrigins(deps, record);
						const group = origins.origins[hit.localRow];
						if (group !== undefined && group >= 0) {
							entry = { record, group, text: origins.groups[group] ?? "" };
						}
						md = { record, localRow: hit.localRow };
					} else {
						const record = hit.record as TextRecord;
						const origins = buildTextOrigins(deps, record);
						const group = origins.origins[hit.localRow];
						if (group !== undefined && group >= 0) {
							entry = { record, group, text: origins.groups[group] ?? "" };
						}
					}
				}
			}
		}
		entries.push(entry);
		markdown.push(md);
	}
	return { bounds, sourceLines, contentWidth, mapping: { entries, lines, markdown } };
}

// ---------------------------------------------------------------------------
// Clipboard assembly
// ---------------------------------------------------------------------------

const CJK_RE = /[\u2e80-\u9fff\uf900-\ufaff\uff00-\uffef]/;

/** Joins two partial-row slices: no space between CJK-adjacent fragments. */
function joinPartial(left: string, right: string): string {
	const l = left.trimEnd();
	const r = right.trimStart();
	if (l === "" || r === "") return l + r;
	if (CJK_RE.test(l[l.length - 1]!) || CJK_RE.test(r[0]!)) return l + r;
	return `${l} ${r}`;
}

// ---------------------------------------------------------------------------
// Inline raw↔rendered alignment (regex tokenizer + snap-to-wrapper)
// ---------------------------------------------------------------------------

interface InlineSeg {
	raw: string;
	rendered: string;
	wrapper: boolean;
}

/** Splits a single-line block's raw markdown into (raw, rendered) segments. */
function inlineSegments(deps: SelectionDeps, raw: string): InlineSeg[] | undefined {
	const segs: InlineSeg[] = [];
	let pos = 0;
	while (pos < raw.length) {
		const rest = raw.slice(pos);
		let match: RegExpExecArray | null;
		// code span: inner text renders as-is
		if ((match = /^(`+)([\s\S]*?)\1/.exec(rest))) {
			segs.push({ raw: match[0], rendered: match[2] ?? "", wrapper: true });
			pos += match[0].length;
			continue;
		}
		// latex: rendered via pi-tui's own renderLatex when available
		if ((match = /^\$\$([\s\S]+?)\$\$/.exec(rest) || /^\$(?!\s)([^$\n]+?)(?<!\s)\$/.exec(rest) || /^\\\(([\s\S]+?)\\\)/.exec(rest))) {
			const inner = match[1] ?? "";
			const renderedLatex = deps.renderLatex?.(inner, { display: match[0].startsWith("$$") }) ?? null;
			segs.push({ raw: match[0], rendered: renderedLatex ?? match[0], wrapper: true });
			pos += match[0].length;
			continue;
		}
		// link / image
		if ((match = /^(!?)\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/.exec(rest))) {
			const bang = match[1] ?? "";
			const text = match[2] ?? "";
			const href = match[3] ?? "";
			let rendered = text;
			if (bang !== "!" && deps.hyperlinks && !deps.hyperlinks()) {
				const hrefNorm = href.startsWith("mailto:") ? href.slice(7) : href;
				if (text !== href && text !== hrefNorm) rendered = `${text} (${href})`;
			}
			segs.push({ raw: match[0], rendered, wrapper: true });
			pos += match[0].length;
			continue;
		}
		// autolink: renders the bare URL
		if ((match = /^<https?:\/\/[^>]+>/.exec(rest))) {
			segs.push({ raw: match[0], rendered: match[0].slice(1, -1), wrapper: true });
			pos += match[0].length;
			continue;
		}
		// backslash escape: renders the escaped char
		if ((match = /^\\([\\`*_{}\[\]()#+\-.!>~|$])/.exec(rest))) {
			segs.push({ raw: match[0], rendered: match[1] ?? "", wrapper: false });
			pos += match[0].length;
			continue;
		}
		// emphasis markers: render to nothing
		if ((match = /^(\*\*|__|\*|_|~~)/.exec(rest))) {
			segs.push({ raw: match[0], rendered: "", wrapper: false });
			pos += match[0].length;
			continue;
		}
		// plain run up to the next special char
		const next = /[`$_<>\\!*~\[]/.exec(rest);
		if (next && next.index > 0) {
			const plain = rest.slice(0, next.index);
			segs.push({ raw: plain, rendered: plain, wrapper: false });
			pos += plain.length;
			continue;
		}
		if (next) {
			segs.push({ raw: rest[0]!, rendered: rest[0]!, wrapper: false });
			pos += 1;
			continue;
		}
		segs.push({ raw: rest, rendered: rest, wrapper: false });
		pos += rest.length;
	}
	return segs;
}

interface AlignedSeg {
	rawStart: number;
	rawEnd: number;
	renderedStart: number;
	renderedEnd: number;
	wrapper: boolean;
}

/** Aligns raw↔rendered for one logical line; undefined when they disagree. */
function alignInline(deps: SelectionDeps, raw: string, rendered: string): AlignedSeg[] | undefined {
	const segs = inlineSegments(deps, raw);
	if (!segs) return undefined;
	const renderedConcat = segs.map((seg) => seg.rendered).join("");
	if (renderedConcat !== rendered) return undefined;
	const out: AlignedSeg[] = [];
	let rawOffset = 0;
	let renderedOffset = 0;
	for (const seg of segs) {
		out.push({
			rawStart: rawOffset,
			rawEnd: rawOffset + seg.raw.length,
			renderedStart: renderedOffset,
			renderedEnd: renderedOffset + seg.rendered.length,
			wrapper: seg.wrapper,
		});
		rawOffset += seg.raw.length;
		renderedOffset += seg.rendered.length;
	}
	return out;
}

/** Maps a rendered offset into a raw offset; cuts inside wrappers snap out. */
function rawOffsetFor(segs: AlignedSeg[], renderedOffset: number, edge: "start" | "end"): number | undefined {
	for (const seg of segs) {
		if (renderedOffset >= seg.renderedStart && renderedOffset < seg.renderedEnd) {
			if (seg.wrapper) return edge === "start" ? seg.rawStart : seg.rawEnd;
			const span = seg.renderedEnd - seg.renderedStart;
			const frac = span === 0 ? 0 : (renderedOffset - seg.renderedStart) / span;
			return Math.round(seg.rawStart + frac * (seg.rawEnd - seg.rawStart));
		}
	}
	if (renderedOffset === 0) return 0;
	const last = segs[segs.length - 1];
	if (last && renderedOffset >= last.renderedEnd) return last.rawEnd;
	return undefined;
}

/** Strips orphaned emphasis markers whose partner fell outside the slice. */
function balanceRawSlice(slice: string): string {
	let out = slice;
	for (;;) {
		const lead = /^(\*\*|__|\*|_|~~)/.exec(out);
		if (lead) {
			const rest = out.slice(lead[0].length);
			if (!rest.includes(lead[0])) {
				out = rest;
				continue;
			}
		}
		const trail = /(\*\*|__|\*|_|~~)$/.exec(out);
		if (trail) {
			const rest = out.slice(0, out.length - trail[0].length);
			if (!rest.includes(trail[0])) {
				out = rest;
				continue;
			}
		}
		return out;
	}
}

/**
 * Locates each wrap fragment's content inside the rendered logical line
 * (fragments are joined by the whitespace the wrap trimmed). Returns each
 * fragment's [start, end) offsets, or undefined when they do not line up.
 */
function locateFragments(deps: SelectionDeps, rendered: string, fragments: string[]): Array<[number, number]> | undefined {
	const offsets: Array<[number, number]> = [];
	let pos = 0;
	for (const fragment of fragments) {
		const content = deps.strip(fragment).trimEnd();
		if (!rendered.startsWith(content, pos)) return undefined;
		offsets.push([pos, pos + content.length]);
		pos += content.length;
		// skip the inter-fragment whitespace the wrap dropped
		while (pos < rendered.length && /\s/.test(rendered[pos]!)) pos += 1;
	}
	return offsets;
}

/**
 * Converts a display-row cut (fragment index + column) into an offset inside
 * the rendered logical line. `contentColStart` is where fragment content
 * begins on screen (margin + prefix width).
 */
function cutToRenderedOffset(
	deps: SelectionDeps,
	rendered: string,
	fragments: string[],
	fragmentIndex: number,
	col: number,
	contentColStart: number,
): number | undefined {
	const offsets = locateFragments(deps, rendered, fragments);
	if (!offsets) return undefined;
	const [start, end] = offsets[fragmentIndex] ?? [0, 0];
	const content = deps.strip(fragments[fragmentIndex] ?? "").trimEnd();
	const contentCol = Math.max(0, col - contentColStart);
	const prefix = deps.sliceByColumn(content, 0, contentCol);
	const consumed = deps.strip(prefix).length;
	return Math.min(end, start + consumed);
}
/**
 * Slices a single-line block's raw markdown for a partial selection.
 * Returns undefined when alignment fails (caller snaps to the whole block).
 */
function sliceInlineRaw(
	deps: SelectionDeps,
	raw: string,
	rendered: string,
	fragments: string[],
	contentWidth: number,
	startCut: { fragmentIndex: number; col: number; contentColStart: number } | undefined,
	endCut: { fragmentIndex: number; col: number; contentColStart: number } | undefined,
): string | undefined {
	void contentWidth;
	const segs = alignInline(deps, raw, rendered);
	if (!segs) return undefined;
	let rawStart = 0;
	let rawEnd = raw.length;
	if (startCut) {
		const offset = cutToRenderedOffset(deps, rendered, fragments, startCut.fragmentIndex, startCut.col, startCut.contentColStart);
		if (offset === undefined) return undefined;
		const mapped = rawOffsetFor(segs, offset, "start");
		if (mapped === undefined) return undefined;
		rawStart = mapped;
	}
	if (endCut) {
		const offset = cutToRenderedOffset(deps, rendered, fragments, endCut.fragmentIndex, endCut.col, endCut.contentColStart);
		if (offset === undefined) return undefined;
		const mapped = rawOffsetFor(segs, offset, "end");
		if (mapped === undefined) return undefined;
		rawEnd = mapped;
	}
	// Snap outward over adjacent emphasis markers when their partner is
	// inside the slice — keeps pairs like **…** balanced.
	const isMarker = (seg: AlignedSeg): boolean => !seg.wrapper && seg.renderedStart === seg.renderedEnd;
	const markerBefore = [...segs].reverse().find((seg) => isMarker(seg) && seg.rawEnd === rawStart);
	if (markerBefore) {
		const markerText = raw.slice(markerBefore.rawStart, markerBefore.rawEnd);
		if (raw.slice(rawStart, rawEnd).includes(markerText)) rawStart = markerBefore.rawStart;
	}
	const markerAfter = segs.find((seg) => isMarker(seg) && seg.rawStart === rawEnd);
	if (markerAfter) {
		const markerText = raw.slice(markerAfter.rawStart, markerAfter.rawEnd);
		if (raw.slice(rawStart, rawEnd).includes(markerText)) rawEnd = markerAfter.rawEnd;
	}
	return balanceRawSlice(raw.slice(rawStart, rawEnd));
}

function stockSlice(deps: SelectionDeps, line: string, startCol: number, endCol: number): string {
	const width = deps.visibleWidth(line);
	const start = Math.max(0, Math.min(startCol, width));
	const end = Math.max(start, Math.min(endCol, width));
	const stripped = deps.strip(deps.sliceByColumn(line, start, Math.max(0, end - start), true));
	// Cuts at column 0 include the left margin — drop it (content only).
	return (start === 0 ? stripped.replace(/^\s+/, "") : stripped).trimEnd();
}

/** Exclusive end column of the selection on row `idx` (clamped to the row width). */
function rowEndCol(deps: SelectionDeps, bounds: { end: SelectionPoint }, idx: number, lines: string[]): number {
	const width = deps.visibleWidth(lines[idx] ?? "");
	if (idx !== lines.length - 1) return width;
	const end = bounds.end.boundary ? bounds.end.col : bounds.end.col + 1;
	return Math.max(0, Math.min(end, width));
}

/** True when the selection covers row `idx` through its full width. */
function rowFullyCovered(deps: SelectionDeps, bounds: { start: SelectionPoint; end: SelectionPoint }, idx: number, lines: string[]): boolean {
	const width = deps.visibleWidth(lines[idx] ?? "");
	const startOk = idx !== 0 || bounds.start.col === 0;
	const endOk = idx !== lines.length - 1 || rowEndCol(deps, bounds, idx, lines) >= width;
	return startOk && endOk;
}

/**
 * Unwrapped emission: rows of the same logical line run together; a run
 * fully inside the selection emits the logical text, partial runs emit
 * joined display slices, opaque rows emit stock slices.
 */
export function emitUnwrapped(deps: SelectionDeps, resolution: ResolvedSelection): string | undefined {
	return emitRows(deps, resolution, 0, resolution.mapping.entries.length);
}

/** Unwrapped emission over mapping rows [from, to). */
function emitRows(deps: SelectionDeps, resolution: ResolvedSelection, from: number, to: number): string | undefined {
	const { bounds, mapping } = resolution;
	const lines = mapping.lines;
	const parts: string[] = [];
	let idx = from;
	while (idx < to) {
		const entry = mapping.entries[idx];
		if (entry === undefined) {
			parts.push(stockSlice(deps, lines[idx] ?? "", idx === 0 ? bounds.start.col : 0, rowEndCol(deps, bounds, idx, lines)));
			idx += 1;
			continue;
		}
		let end = idx + 1;
		while (
			end < to &&
			mapping.entries[end]?.record === entry.record &&
			mapping.entries[end]?.group === entry.group
		) end += 1;
		if (rowFullyCovered(deps, bounds, idx, lines) && rowFullyCovered(deps, bounds, end - 1, lines)) {
			parts.push(entry.text);
		} else {
			let acc = "";
			for (let i = idx; i < end; i++) {
				const slice = stockSlice(deps, lines[i] ?? "", i === 0 ? bounds.start.col : 0, rowEndCol(deps, bounds, i, lines));
				acc = acc === "" ? slice : joinPartial(acc, slice);
			}
			parts.push(acc);
		}
		idx = end;
	}
	const text = parts.join("\n");
	return text.length === 0 ? undefined : text;
}

/**
 * Raw mode, segment-granular: the selection is partitioned into runs of
 * consecutive rows. Markdown runs emit raw source (whole-component →
 * component text; block boundaries sliced: inline regex alignment for
 * paragraphs/quotes, raw-line granularity for code blocks and tables, item
 * granularity for lists; anything unslicable snaps to its whole block —
 * still raw). Non-markdown runs (tool lines, ✻ labels, borders, Text
 * components) degrade to unwrapped text for those rows only.
 */
export function emitRaw(deps: SelectionDeps, resolution: ResolvedSelection): string | undefined {
	const { mapping } = resolution;
	const rows = mapping.entries.length;
	if (rows === 0) return undefined;
	const parts: string[] = [];
	let idx = 0;
	while (idx < rows) {
		const md = mapping.markdown[idx];
		if (!md) {
			let end = idx + 1;
			while (end < rows && !mapping.markdown[end]) end += 1;
			parts.push(emitRows(deps, resolution, idx, end) ?? "");
			idx = end;
			continue;
		}
		const record = md.record;
		let end = idx + 1;
		while (end < rows && mapping.markdown[end]?.record === record) end += 1;
		const raw = emitRawRun(deps, resolution, idx, end);
		parts.push(raw ?? emitRows(deps, resolution, idx, end) ?? "");
		idx = end;
	}
	const text = parts.join("\n");
	return text.length === 0 ? undefined : text;
}

/** Raw emission for one maximal run of rows inside a single component. */
function emitRawRun(
	deps: SelectionDeps,
	resolution: ResolvedSelection,
	fromIdx: number,
	toIdx: number,
): string | undefined {
	const { mapping } = resolution;
	const record = mapping.markdown[fromIdx]!.record;
	const origins = buildMarkdownOrigins(deps, record);
	const selectedLocal = new Set<number>();
	for (let i = fromIdx; i < toIdx; i++) selectedLocal.add(mapping.markdown[i]!.localRow);
	const covered = [...selectedLocal].sort((a, b) => a - b);
	const spanStart = covered[0]!;
	const spanEnd = covered[covered.length - 1]!;
	// Whole component: all non-blank rows covered, span reaches both ends.
	const nonBlankRows: number[] = [];
	for (let r = 0; r < record.lines.length; r++) {
		if (!isBlankish(record.lines[r])) nonBlankRows.push(r);
	}
	const startCut = fromIdx === 0 ? selectionCut(deps, resolution, "start", origins) : undefined;
	const endCut = toIdx === mapping.entries.length ? selectionCut(deps, resolution, "end", origins) : undefined;
	const coversWhole =
		nonBlankRows.length > 0 &&
		!startCut &&
		!endCut &&
		nonBlankRows.every((r) => selectedLocal.has(r)) &&
		spanStart <= nonBlankRows[0]! &&
		spanEnd >= nonBlankRows[nonBlankRows.length - 1]!;
	if (coversWhole) {
		return typeof record.text === "string" ? record.text : undefined;
	}
	const raws: string[] = [];
	for (let callIndex = 0; callIndex < origins.callRows.length; callIndex++) {
		const callRow = origins.callRows[callIndex]!;
		if (callRow.start > spanEnd || callRow.end <= spanStart) continue;
		let hasNonBlank = false;
		let allCovered = true;
		for (let r = callRow.start; r < callRow.end; r++) {
			if (isBlankish(record.lines[r])) continue;
			hasNonBlank = true;
			if (!selectedLocal.has(r)) allCovered = false;
		}
		if (!hasNonBlank) continue; // pure spacing call — skippable
		const cutInCall =
			(startCut !== undefined && startCut.row >= callRow.start && startCut.row < callRow.end) ||
			(endCut !== undefined && endCut.row >= callRow.start && endCut.row < callRow.end);
		const fullyCovered = !cutInCall && allCovered && callRow.start >= spanStart && callRow.end <= spanEnd + 1;
		if (fullyCovered) {
			if (typeof callRow.raw !== "string") return undefined;
			raws.push(callRow.raw);
			continue;
		}
		const call = record.topCalls[callIndex];
		if (!call) return undefined;
		const callStartCut = startCut && startCut.row >= callRow.start && startCut.row < callRow.end ? startCut : undefined;
		const callEndCut = endCut && endCut.row >= callRow.start && endCut.row < callRow.end ? endCut : undefined;
		const sliced = sliceCallRaw(deps, record, call, callRow, selectedLocal, origins, callStartCut, callEndCut);
		if (sliced !== undefined) {
			raws.push(sliced);
			continue;
		}
		if (typeof callRow.raw !== "string") return undefined;
		raws.push(callRow.raw);
	}
	if (raws.length === 0) return undefined;
	return raws.join("");
}

/** A mid-logical-line selection boundary, in component-local coordinates. */
interface SelectionCut {
	row: number;
	col: number;
	group: number;
}

function selectionCut(
	deps: SelectionDeps,
	resolution: ResolvedSelection,
	edge: "start" | "end",
	origins: MdOriginInfo,
): SelectionCut | undefined {
	const { bounds, mapping } = resolution;
	const idx = edge === "start" ? 0 : mapping.entries.length - 1;
	const md = mapping.markdown[idx];
	if (!md) return undefined;
	const group = origins.origins[md.localRow];
	if (group === undefined || group < 0) return undefined;
	const line = mapping.lines[idx] ?? "";
	const width = deps.visibleWidth(line);
	const col = edge === "start" ? bounds.start.col : (bounds.end.boundary ? bounds.end.col : bounds.end.col + 1);
	if (edge === "start" && col === 0) return undefined;
	if (edge === "end" && col >= width) return undefined;
	return { row: md.localRow, col, group };
}

/** First component row of the logical line containing `row`. */
function firstRowOfGroup(origins: MdOriginInfo, row: number): number | undefined {
	const group = origins.origins[row];
	if (group === undefined || group < 0) return undefined;
	let first = row;
	while (first > 0 && origins.origins[first - 1] === group) first -= 1;
	return first;
}

/** Distinct logical groups across a call's rows, in row order. */
function callGroupsInOrder(origins: MdOriginInfo, callRow: { start: number; end: number }): number[] {
	const groups: number[] = [];
	let seen = -1;
	for (let r = callRow.start; r < callRow.end; r++) {
		const group = origins.origins[r];
		if (group !== undefined && group >= 0 && group !== seen) {
			groups.push(group);
			seen = group;
		}
	}
	return groups;
}

/** Slices one partially covered call's raw text; undefined → snap whole. */
function sliceCallRaw(
	deps: SelectionDeps,
	record: MarkdownRecord,
	call: TokenCallRecord,
	callRow: { start: number; end: number; raw: string | undefined; ownerByGroup?: Map<number, { child: number; output: number }> },
	selectedLocal: Set<number>,
	origins: MdOriginInfo,
	startCut: SelectionCut | undefined,
	endCut: SelectionCut | undefined,
): string | undefined {
	if (typeof callRow.raw !== "string") return undefined;
	const tokenType = typeof call.token.type === "string" ? call.token.type : "";
	switch (tokenType) {
		case "code":
			return sliceCodeRaw(call, callRow, selectedLocal, origins);
		case "table":
			return sliceTableRaw(deps, call, callRow, selectedLocal, origins);
		case "list":
			return sliceListRaw(call, callRow, selectedLocal, origins);
		case "blockquote":
			return sliceQuoteRaw(deps, record, call, callRow, selectedLocal, origins, startCut, endCut);
		case "latexBlock":
		case "heading":
			return undefined; // rendered ≠ raw lines / prefix handling → snap whole
		default:
			return sliceParagraphLikeRaw(deps, record, call, callRow, origins, startCut, endCut);
	}
}

/** Paragraph/text/html: inline-align the partial selection into token.raw. */
function sliceParagraphLikeRaw(
	deps: SelectionDeps,
	record: MarkdownRecord,
	call: TokenCallRecord,
	callRow: { start: number; end: number; raw: string | undefined },
	origins: MdOriginInfo,
	startCut: SelectionCut | undefined,
	endCut: SelectionCut | undefined,
): string | undefined {
	const output = call.outputs[0];
	if (typeof output !== "string" || typeof callRow.raw !== "string") return undefined;
	const rendered = deps.strip(output).trimEnd();
	const raw = callRow.raw.replace(/\r?\n$/, "");
	const fragments = deps.wrapTextWithAnsi(output, record.contentWidth);
	const toCut = (cut: SelectionCut): { fragmentIndex: number; col: number; contentColStart: number } | undefined => {
		const first = firstRowOfGroup(origins, cut.row);
		if (first === undefined) return undefined;
		return { fragmentIndex: cut.row - first, col: cut.col, contentColStart: record.paddingX };
	};
	const s = startCut ? toCut(startCut) : undefined;
	const e = endCut ? toCut(endCut) : undefined;
	if ((startCut && !s) || (endCut && !e)) return undefined;
	return sliceInlineRaw(deps, raw, rendered, fragments, record.contentWidth, s, e);
}

/** Code blocks: covered code lines map 1:1 to interior raw lines (no fences). */
function sliceCodeRaw(
	call: TokenCallRecord,
	callRow: { start: number; end: number; raw: string | undefined },
	selectedLocal: Set<number>,
	origins: MdOriginInfo,
): string | undefined {
	if (typeof callRow.raw !== "string") return undefined;
	const groups = callGroupsInOrder(origins, callRow);
	// outputs: [fence, ...codeLines, fence, spacing?]
	const coveredOutputs = new Set<number>();
	for (let r = callRow.start; r < callRow.end; r++) {
		if (!selectedLocal.has(r)) continue;
		const group = origins.origins[r];
		if (group === undefined) continue;
		const outputIndex = groups.indexOf(group);
		if (outputIndex < 0) continue;
		coveredOutputs.add(outputIndex);
	}
	if (coveredOutputs.size === 0) return undefined;
	const codeLineCount = call.outputs.length - 2;
	for (const outputIndex of coveredOutputs) {
		if (outputIndex === 0 || outputIndex >= call.outputs.length - 1) return undefined; // fence or trailing spacing
	}
	const rawLines = callRow.raw.split("\n").map((line) => line.replace(/\r$/, ""));
	while (rawLines.length > 0 && rawLines[rawLines.length - 1] === "") rawLines.pop();
	if (rawLines.length < 2) return undefined;
	const interior = rawLines.slice(1, -1);
	if (interior.length !== codeLineCount) return undefined;
	const picked: string[] = [];
	for (const outputIndex of [...coveredOutputs].sort((a, b) => a - b)) {
		const line = interior[outputIndex - 1];
		if (line === undefined) return undefined;
		picked.push(line);
	}
	return picked.join("\n");
}

const TABLE_SEPARATOR = /^\s*\|?[\s:|-]*-+[\s:|-]*\|?\s*$/;

/** Tables: covered drawn rows (header/data) map 1:1 to raw table lines. */
function sliceTableRaw(
	deps: SelectionDeps,
	call: TokenCallRecord,
	callRow: { start: number; end: number; raw: string | undefined },
	selectedLocal: Set<number>,
	origins: MdOriginInfo,
): string | undefined {
	void deps;
	if (typeof callRow.raw !== "string") return undefined;
	const groups = callGroupsInOrder(origins, callRow);
	const coveredGroups = new Set<number>();
	for (let r = callRow.start; r < callRow.end; r++) {
		if (!selectedLocal.has(r)) continue;
		const group = origins.origins[r];
		if (group !== undefined && group >= 0) coveredGroups.add(group);
	}
	if (coveredGroups.size === 0) return undefined;
	const rawLines = callRow.raw.split("\n").map((line) => line.replace(/\r$/, "")).filter((line) => line.trim() !== "");
	const separatorIndex = rawLines.findIndex((line) => TABLE_SEPARATOR.test(line));
	if (separatorIndex !== 1) return undefined;
	const tableRows = [rawLines[0]!, ...rawLines.slice(2)];
	if (tableRows.length !== groups.length) return undefined;
	const picked: string[] = [];
	for (const group of groups) {
		if (!coveredGroups.has(group)) continue;
		const rawLine = tableRows[groups.indexOf(group)];
		if (rawLine === undefined) return undefined;
		picked.push(rawLine);
	}
	return picked.length > 0 ? picked.join("\n") : undefined;
}

/** Lists: covered items (via group→child mapping) emit their raw lines. */
function sliceListRaw(
	call: TokenCallRecord,
	callRow: { start: number; end: number; ownerByGroup?: Map<number, { child: number; output: number }> },
	selectedLocal: Set<number>,
	origins: MdOriginInfo,
): string | undefined {
	const owners = callRow.ownerByGroup;
	if (!owners) return undefined;
	const coveredChildren = new Set<number>();
	for (let r = callRow.start; r < callRow.end; r++) {
		if (!selectedLocal.has(r)) continue;
		const group = origins.origins[r];
		if (group === undefined || group < 0) continue;
		const owner = owners.get(group);
		if (owner) coveredChildren.add(owner.child);
	}
	if (coveredChildren.size === 0) return undefined;
	const raws: string[] = [];
	for (const childIndex of [...coveredChildren].sort((a, b) => a - b)) {
		const child = call.children[childIndex];
		const raw = child?.token.raw;
		if (typeof raw !== "string") return undefined;
		raws.push(raw);
	}
	return raws.join("");
}

/** Quotes: covered content children emit `> `-prefixed raw; partial children
 * inline-align when possible, else snap to the whole child. */
function sliceQuoteRaw(
	deps: SelectionDeps,
	record: MarkdownRecord,
	call: TokenCallRecord,
	callRow: { start: number; end: number; ownerByGroup?: Map<number, { child: number; output: number }> },
	selectedLocal: Set<number>,
	origins: MdOriginInfo,
	startCut: SelectionCut | undefined,
	endCut: SelectionCut | undefined,
): string | undefined {
	const owners = callRow.ownerByGroup;
	if (!owners) return undefined;
	const coveredChildren = new Set<number>();
	let cutChildStart: { child: number; cut: SelectionCut } | undefined;
	let cutChildEnd: { child: number; cut: SelectionCut } | undefined;
	for (let r = callRow.start; r < callRow.end; r++) {
		if (!selectedLocal.has(r)) continue;
		const group = origins.origins[r];
		if (group === undefined || group < 0) continue;
		const owner = owners.get(group);
		if (owner) coveredChildren.add(owner.child);
	}
	if (startCut) {
		const group = origins.origins[startCut.row];
		if (group !== undefined && group >= 0) {
			const owner = owners.get(group);
			if (owner) cutChildStart = { child: owner.child, cut: startCut };
		}
	}
	if (endCut) {
		const group = origins.origins[endCut.row];
		if (group !== undefined && group >= 0) {
			const owner = owners.get(group);
			if (owner) cutChildEnd = { child: owner.child, cut: endCut };
		}
	}
	if (coveredChildren.size === 0) return undefined;
	const prefixQuote = (text: string): string =>
		text.split("\n").map((line) => (line === "" ? ">" : `> ${line}`)).join("\n");
	const parts: string[] = [];
	for (const childIndex of [...coveredChildren].sort((a, b) => a - b)) {
		const child = call.children[childIndex];
		const raw = child?.token.raw;
		if (typeof raw !== "string") return undefined;
		const isCutStart = cutChildStart?.child === childIndex;
		const isCutEnd = cutChildEnd?.child === childIndex;
		if (!isCutStart && !isCutEnd) {
			parts.push(prefixQuote(raw.replace(/\n$/, "")));
			continue;
		}
		const output = child?.outputs[cutChildStart?.child === childIndex ? owners.get(origins.origins[cutChildStart.cut.row] ?? -1)?.output ?? 0 : cutChildEnd?.child === childIndex ? (owners.get(origins.origins[cutChildEnd.cut.row] ?? -1)?.output ?? 0) : 0];
		if (typeof output !== "string") return undefined;
		const rendered = deps.strip(output).trimEnd();
		const fragments = deps.wrapTextWithAnsi(output, child!.width);
		const toCut = (cut: SelectionCut): { fragmentIndex: number; col: number; contentColStart: number } | undefined => {
			const first = firstRowOfGroup(origins, cut.row);
			if (first === undefined) return undefined;
			return { fragmentIndex: cut.row - first, col: cut.col, contentColStart: record.paddingX + 2 };
		};
		const s = isCutStart ? toCut(cutChildStart!.cut) : undefined;
		const e = isCutEnd ? toCut(cutChildEnd!.cut) : undefined;
		if ((isCutStart && !s) || (isCutEnd && !e)) return undefined;
		const sliced = sliceInlineRaw(deps, raw.replace(/\r?\n$/, ""), rendered, fragments, child!.width, s, e);
		if (sliced === undefined) {
			parts.push(prefixQuote(raw.replace(/\n$/, "")));
			continue;
		}
		parts.push(prefixQuote(sliced));
	}
	return parts.join("\n");
}

// ---------------------------------------------------------------------------
// Installation
// ---------------------------------------------------------------------------

interface PiTuiModule {
	Markdown?: { prototype?: object };
	Text?: { prototype?: object };
	TuiAltScreen?: { prototype?: object };
	wrapTextWithAnsi?: (text: string, width: number) => string[];
	visibleWidth?: (line: string) => number;
	sliceByColumn?: (line: string, start: number, length: number, strict?: boolean) => string;
	stripTerminalSequences?: (line: string) => string;
	renderLatex?: (text: string, options?: { display?: boolean }) => string | null | undefined;
	getCapabilities?: () => { hyperlinks?: boolean };
}

let cachedDeps: SelectionDeps | undefined;

function getDeps(): SelectionDeps | undefined {
	if (cachedDeps) return cachedDeps;
	try {
		// eslint-disable-next-line @typescript-eslint/no-require-imports
		const piTui = require("@earendil-works/pi-tui") as PiTuiModule;
		if (
			typeof piTui.wrapTextWithAnsi !== "function" ||
			typeof piTui.visibleWidth !== "function" ||
			typeof piTui.sliceByColumn !== "function" ||
			typeof piTui.stripTerminalSequences !== "function"
		) {
			return undefined;
		}
		cachedDeps = {
			wrapTextWithAnsi: piTui.wrapTextWithAnsi,
			visibleWidth: piTui.visibleWidth,
			sliceByColumn: piTui.sliceByColumn,
			strip: piTui.stripTerminalSequences,
			renderLatex: typeof piTui.renderLatex === "function" ? piTui.renderLatex : undefined,
			hyperlinks:
				typeof piTui.getCapabilities === "function"
				? () => piTui.getCapabilities?.().hyperlinks === true
				: undefined,
		};
		return cachedDeps;
	} catch (error) {
		debug(`deps: require failed: ${error instanceof Error ? error.message : String(error)}`);
		return undefined;
	}
}

interface AltScreenLike {
	getSelectionBounds?: () => { start: SelectionPoint; end: SelectionPoint } | undefined;
	currentLayout?: { root?: LayoutBoxLike };
	previousScreen?: string[];
}

interface MutableProto {
	render?: (width: number) => string[];
	getActiveSelectionText?: (this: AltScreenLike) => string | undefined;
}

type GuardedProto = MutableProto & Record<symbol, boolean | undefined>;

const INSTALLED_MD = Symbol.for("open-tui.selectionCopy.markdown");
const INSTALLED_TEXT = Symbol.for("open-tui.selectionCopy.text");
const INSTALLED_ALT = Symbol.for("open-tui.selectionCopy.altScreen");

function wrapMarkdown(proto: object | null | undefined): () => void {
	const target = proto as GuardedProto | null | undefined;
	if (!target || typeof target.render !== "function" || target[INSTALLED_MD]) return () => {};
	const original = target.render;
	type MdSelf = MarkdownComponentLike & {
		renderToken?: (token: TokenLike, width: number, ...rest: unknown[]) => string[];
		wrapCellText?: (text: string, maxWidth: number, ...rest: unknown[]) => string[];
	};
	target.render = function (this: MdSelf, width: number) {
		const self = this;
		const prior = markdownRecords.get(self as object);
		if (prior && prior.width === width && prior.text === self.text && self.cachedLines === prior.lines) {
			return prior.lines;
		}
		const savedToken = self.renderToken;
		const savedCell = typeof self.wrapCellText === "function" ? self.wrapCellText : undefined;
		const topCalls: TokenCallRecord[] = [];
		const stack: TokenCallRecord[] = [];
		const attach = (node: TokenCallRecord): void => {
			const parent = stack[stack.length - 1];
			if (parent) parent.children.push(node);
			else topCalls.push(node);
		};
		if (typeof savedToken === "function") {
			self.renderToken = function (token: TokenLike, callWidth: number, ...rest: unknown[]) {
				const node: TokenCallRecord = { token, width: callWidth, outputs: [], children: [], cells: [] };
				attach(node);
				stack.push(node);
				try {
					node.outputs = savedToken.call(self, token, callWidth, ...rest) ?? [];
					return node.outputs;
				} finally {
					stack.pop();
				}
			};
		}
		if (savedCell) {
			self.wrapCellText = function (text: string, maxWidth: number, ...rest: unknown[]) {
				const result = savedCell.call(self, text, maxWidth, ...rest);
				const node = stack[stack.length - 1];
				if (node && Array.isArray(result)) node.cells.push({ text, result });
				return result;
			};
		}
		let out: string[];
		try {
			out = original.call(self, width) ?? [];
		} finally {
			if (typeof savedToken === "function") self.renderToken = savedToken;
			if (savedCell) self.wrapCellText = savedCell;
		}
		const paddingX = typeof self.paddingX === "number" ? self.paddingX : 0;
		markdownRecords.set(self as object, {
			component: self,
			width,
			text: self.text,
			contentWidth: Math.max(1, width - paddingX * 2),
			paddingX,
			topCalls,
			lines: Array.isArray(self.cachedLines) && self.cachedLines.length === out.length ? self.cachedLines : out,
		});
		return out;
	};
	target[INSTALLED_MD] = true;
	return () => {
		delete target[INSTALLED_MD];
		target.render = original;
	};
}

function wrapText(proto: object | null | undefined): () => void {
	const target = proto as GuardedProto | null | undefined;
	if (!target || typeof target.render !== "function" || target[INSTALLED_TEXT]) return () => {};
	const original = target.render;
	type TextSelf = TextComponentLike;
	target.render = function (this: TextSelf, width: number) {
		const out = original.call(this, width) ?? [];
		// Fast path: cached renders return the same array — reuse the record
		// instead of re-allocating one on every frame (spinner labels etc.).
		const prior = textRecords.get(this as object);
		if (prior && prior.width === width && prior.text === this.text && prior.lines === out) {
			return out;
		}
		textRecords.set(this as object, { component: this, width, text: this.text, lines: out });
		return out;
	};
	target[INSTALLED_TEXT] = true;
	return () => {
		delete target[INSTALLED_TEXT];
		target.render = original;
	};
}

function wrapAltScreen(proto: object | null | undefined): () => void {
	const target = proto as GuardedProto | null | undefined;
	if (!target || typeof target.getActiveSelectionText !== "function" || target[INSTALLED_ALT]) return () => {};
	const original = target.getActiveSelectionText;
	target.getActiveSelectionText = function (this: AltScreenLike) {
		const stock = (): string | undefined => original.call(this);
		try {
			if (copyMode === "plain") return stock();
			const deps = getDeps();
			if (!deps) return stock();
			const resolution = resolveSelectionRows(deps, this);
			if (!resolution) return stock();
			if (copyMode === "raw") {
				const raw = emitRaw(deps, resolution);
				if (raw !== undefined && raw.length > 0) return raw;
			}
			const text = emitUnwrapped(deps, resolution);
			return text === undefined ? stock() : text;
		} catch (error) {
			debug(`getActiveSelectionText: ${error instanceof Error ? error.message : String(error)}`);
			return stock();
		}
	};
	target[INSTALLED_ALT] = true;
	return () => {
		delete target[INSTALLED_ALT];
		target.getActiveSelectionText = original;
	};
}

/** Test access to the recording registries. */
export const __testing = {
	markdownRecords,
	textRecords,
};

/**
 * Installs selection-copy for the whole process (same module-instance
 * discipline as thinking-click.ts). Silently no-ops on unknown shapes.
 */
export function installSelectionCopy(): () => void {
	try {
		// eslint-disable-next-line @typescript-eslint/no-require-imports
		const piTui = require("@earendil-works/pi-tui") as PiTuiModule;
		const cleanups = [
			wrapMarkdown(piTui.Markdown?.prototype),
			wrapText(piTui.Text?.prototype),
			wrapAltScreen(piTui.TuiAltScreen?.prototype),
		];
		return () => {
			for (const cleanup of cleanups) cleanup();
		};
	} catch (error) {
		debug(`install: require failed: ${error instanceof Error ? error.message : String(error)}`);
		return () => {};
	}
}
