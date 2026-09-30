import {
	CustomEditor,
	type ExtensionAPI,
	type ExtensionContext,
	type KeybindingsManager,
} from "@earendil-works/pi-coding-agent";
import type { EditorTheme, TUI, TuiMouseEvent, TuiMouseEventResult } from "@earendil-works/pi-tui";
import { CURSOR_MARKER, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { CursorStyle } from "./config.ts";
import {
	applyFullscreenWheelScrollLines,
	DEFAULT_FULLSCREEN_WHEEL_SCROLL_LINES,
} from "./fullscreen-scroll.ts";

/** Plain-text working status embedded in the editor's top border. The editor
 * wraps the indicator before handing it to pi's native ladder, which paints
 * the returned strings with the frame's border color at render time (ponytail
 * routing), so the status recolors together with thinking-level / bash-mode
 * borders. Width is the display-column budget; empty string means "nothing
 * to show". */
export interface WorkingStatusIndicator {
	renderInBorder(width: number): string;
	/** Degraded form for narrow borders (e.g. spinner glyph only). */
	renderSpinnerInBorder(width: number): string;
}

/** pi's parameter type for CustomEditor.setWorkingStatusIndicator. Structurally
 * we only ever rely on the two render methods, so plain-object indicators are
 * sound at runtime; the cast lives at the super call. */
type PiStatusIndicator = Parameters<CustomEditor["setWorkingStatusIndicator"]>[0];

/** One border line of inline footer content: left/right cells around the fill. */
export interface InlineFooterLine {
	left: string;
	right: string;
}

/** Inline footer provider: draws the classic footer's two main rows into the
 * editor's top/bottom borders instead of dedicated rows. Returns undefined
 * for a border to keep its plain rounded form. */
export interface InlineBorderContent {
	enabled(): boolean;
	render(kind: "top" | "bottom", width: number): InlineFooterLine | undefined;
}

function fillLine(content: string, width: number): string {
	const truncated = truncateToWidth(content, Math.max(0, width), "");
	const pad = " ".repeat(Math.max(0, width - visibleWidth(truncated)));
	return `${truncated}${pad}`;
}

const CURSOR_STYLE_SEQUENCES: Partial<Record<CursorStyle, string>> = {
	bar: "\x1b[6 q",
	underline: "\x1b[4 q",
};
const DEFAULT_CURSOR_STYLE_SEQUENCE = "\x1b[0 q";
// Frame geometry (rail + gap per side): mouse events arrive in framed
// coordinates, the base editor reasons in content coordinates (upstream #48).
const EDITOR_FRAME_LEFT_INSET = 2;
const EDITOR_FRAME_HORIZONTAL_CHROME = EDITOR_FRAME_LEFT_INSET * 2;

function removeSoftwareCursor(line: string, cursorMarker = ""): string {
	return line.replace(/\x1b\[7m([\s\S]*?)\x1b\[0m/g, (_match, cursor: string) => {
		const replacement = `${cursorMarker}${cursor}`;
		cursorMarker = "";
		return replacement;
	});
}

function configureCursor(tui: TUI, cursorStyle: CursorStyle): void {
	if (cursorStyle === "block") return;
	tui.setShowHardwareCursor(true);
	const sequence = CURSOR_STYLE_SEQUENCES[cursorStyle];
	if (sequence) tui.terminal.write(sequence);
}

function trimTrailingSpaces(text: string): string {
	return text.replace(/\s+$/g, "");
}

/** Inner content of an inline-footer border line, without corners: status
 * run (top only), optional left/right cells, fill, and the scroll label on
 * the right. `width` is the column budget between the corners. Returns
 * undefined when there is no inline content, so the caller falls back to the
 * native border. */
function inlineBorderCore(
	width: number,
	kind: "top" | "bottom",
	paint: (s: string) => string,
	renderLine: (width: number) => InlineFooterLine | undefined,
	hiddenLineCount: number,
	indicator?: WorkingStatusIndicator,
): string | undefined {
	if (width < 2) return undefined;

	const direction = kind === "top" ? "↑" : "↓";
	const right = hiddenLineCount > 0 ? paint(` ${direction} ${hiddenLineCount} more `) : "";
	let left = paint("─");

	if (kind === "top" && indicator) {
		const statusBudget = Math.max(1, width - visibleWidth(right) - 7);
		let status = indicator.renderInBorder(statusBudget);
		if (visibleWidth(status) > statusBudget) status = indicator.renderSpinnerInBorder(statusBudget);
		const leftBudget = Math.max(0, width - visibleWidth(right) - 1);
		status = truncateToWidth(status, Math.max(0, leftBudget - 4), "");
		if (visibleWidth(status) > 0) left = `${paint("── ")}${paint(status)}${paint(" ")}`;
	}

	const lineBudget = Math.max(0, width - visibleWidth(left) - visibleWidth(right) - 6);
	const line = renderLine(lineBudget);
	if (!line) return undefined;
	const leftContent = trimTrailingSpaces(line.left);
	const rightContent = trimTrailingSpaces(line.right);
	if (visibleWidth(leftContent) === 0 && visibleWidth(rightContent) === 0) {
		return undefined;
	}

	const leftCell = leftContent ? ` ${leftContent} ` : "";
	const rightCell = rightContent ? ` ${rightContent} ` : "";
	const fill = Math.max(1, width - visibleWidth(left) - visibleWidth(leftCell) - visibleWidth(rightCell) - visibleWidth(right) - 1);
	return `${left}${leftCell}${paint("─".repeat(fill))}${rightCell}${right}${paint("─")}`;
}

export class OpenTuiEditor extends CustomEditor {
	private readonly getRail: () => string;
	private readonly getBorder: (s: string) => string;
	private cursorStyle: CursorStyle;
	private previewHardwareCursor = false;
	// Named to avoid colliding with pi's private workingStatusIndicator.
	// Effective mirror (pi overlay ?? own) for the inline-border path.
	private frameStatusIndicator: WorkingStatusIndicator | undefined;
	// Extension-owned indicator: survives pi's lifecycle writes. pi clears
	// the embedded indicator at every turn boundary while workingVisible is
	// false (border mode hides pi's line) — routing those clears into our own
	// status silently blanked the frame mid-run (found in live testing).
	private ownFrameIndicator: WorkingStatusIndicator | undefined;
	// pi-fed overlay indicator (retry/compaction/branchSummary); takes
	// precedence over the own indicator while present.
	private piFrameIndicator: WorkingStatusIndicator | undefined;
	private inlineBorderContent: InlineBorderContent | undefined;
	// True only while our render() drives the base render, so the border hooks
	// know whether to emit the framed (cornered) form or pi's plain one.
	private framedPass = false;
	// Bottom border emitted by the latest framed pass — the structural marker
	// render() matches to split content lines from trailing autocomplete rows.
	private lastFrameBottomBorder: string | undefined;

	constructor(
		tui: TUI,
		editorTheme: EditorTheme,
		keybindings: KeybindingsManager,
		cursorStyle: CursorStyle = "block",
	) {
		// embedWorkingStatus starts false: pi's duck-typed embed routing must
		// stay off until the workingStatus mode opts in (ADR-0008). The native
		// ladder is opened per render instead — see render().
		super(tui, editorTheme, keybindings, { paddingX: 0, embedWorkingStatus: false });
		this.cursorStyle = cursorStyle;
		configureCursor(tui, cursorStyle);
		// ponytail: route the frame through this.borderColor so Pi can recolor it
		// via updateEditorBorderColor() — bash mode ("! " prefix → green) and
		// thinking-level borders both flow through this one property.
		this.getRail = () => this.borderColor("│");
		this.getBorder = (s: string) => this.borderColor(s);
	}

	override setPaddingX(_padding: number): void {
		// The custom rail owns the horizontal inset and keeps one stable text gap.
		super.setPaddingX(0);
	}

	setCursorStyle(cursorStyle: CursorStyle, blockHardwareCursor = false): void {
		const styleChanged = cursorStyle !== this.cursorStyle;
		this.previewHardwareCursor = cursorStyle !== "block";
		this.cursorStyle = cursorStyle;
		if (styleChanged) {
			if (cursorStyle === "block") {
				this.tui.terminal.write(DEFAULT_CURSOR_STYLE_SEQUENCE);
				this.tui.setShowHardwareCursor(blockHardwareCursor);
			} else {
				configureCursor(this.tui, cursorStyle);
			}
		}
		this.tui.requestRender();
	}

	/** Extension channel for our own border status. Unlike pi's lifecycle
	 * channel below, this one is never cleared by pi's turn-boundary
	 * writes — see ownFrameIndicator. */
	setFrameIndicator(indicator: WorkingStatusIndicator | undefined): void {
		this.ownFrameIndicator = indicator;
		this.applyFrameIndicator();
	}

	/** pi's lifecycle channel (embed routing): overlays pi's own
	 * retry/compaction/branchSummary indicators on top of ours, and treats
	 * pi's clears as "overlay ended" — our own status resumes, it never
	 * silently vanishes at tool/turn boundaries. pi's plain working loader
	 * is dropped (kind === "working"): our elapsed snapshot is the richer
	 * replacement and must not be overwritten by it. */
	override setWorkingStatusIndicator(indicator: WorkingStatusIndicator | undefined): void {
		if (indicator && (indicator as { kind?: string }).kind === "working") {
			indicator = undefined;
		}
		this.piFrameIndicator = indicator;
		this.applyFrameIndicator();
	}

	private applyFrameIndicator(): void {
		const effective = this.piFrameIndicator ?? this.ownFrameIndicator;
		this.frameStatusIndicator = effective;
		// Wrap before storing into pi's field: the native ladder inserts the
		// status raw between borderColor runs, but our indicators return plain
		// text — painting at render time keeps the status following bash-mode /
		// thinking-level recolors. pi's own ANSI-colored indicators pass through
		// unchanged in effect (their inner SGR wins over the outer wrap).
		const wrapped = effective && {
			renderInBorder: (width: number) => this.getBorder(effective.renderInBorder(width)),
			renderSpinnerInBorder: (width: number) => this.getBorder(effective.renderSpinnerInBorder(width)),
		};
		super.setWorkingStatusIndicator(wrapped as PiStatusIndicator);
		this.tui.requestRender();
	}

	/** Let pi embed its own working/retry/compaction indicators into the border
	 * (workingStatus "border"); "line"/"both" keep pi's status lines stock.
	 * Flips pi's duck-typed embedWorkingStatus flag, which is readonly only at
	 * the type level — see ADR-0008 for why routing and the ladder are split. */
	setEmbeddedWorkingStatusRouting(enabled: boolean): void {
		(this as { embedWorkingStatus: boolean }).embedWorkingStatus = enabled;
		this.tui.requestRender();
	}

	setInlineBorderContent(content: InlineBorderContent | undefined): void {
		this.inlineBorderContent = content;
		this.tui.requestRender();
	}

	override handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
		// The frame (rail + gap) shifts content two columns right of what the
		// base editor believes (paddingX is 0); translate clicks into content
		// coordinates so the caret lands where the user clicked. Narrow unframed
		// renders keep stock behavior — mirrors the width < 4 guard in render.
		if (event.width < EDITOR_FRAME_HORIZONTAL_CHROME) return super.handleMouse(event);

		return super.handleMouse({
			...event,
			x: event.x - EDITOR_FRAME_LEFT_INSET,
			width: event.width - EDITOR_FRAME_HORIZONTAL_CHROME,
		});
	}

	protected override renderTopBorder(width: number, hiddenLineCount: number): string {
		// Narrow unframed renders keep pi's plain border.
		if (!this.framedPass) return super.renderTopBorder(width, hiddenLineCount);
		// The hook width is the content width between the frame gaps; the
		// framed border spans four more columns in total, so the ladder and
		// scroll label budget over width + 2 and the corners finish the line.
		const span = width + 2;
		const inline = this.inlineBorderContent?.enabled() ? this.inlineBorderContent : undefined;
		const inner = (inline &&
			inlineBorderCore(span, "top", this.getBorder, (budget) => inline.render("top", budget), hiddenLineCount, this.frameStatusIndicator)) ??
			super.renderTopBorder(span, hiddenLineCount);
		return `${this.getBorder("╭")}${inner}${this.getBorder("╮")}`;
	}

	protected override renderBottomBorder(width: number, hiddenLineCount: number): string {
		if (!this.framedPass) return super.renderBottomBorder(width, hiddenLineCount);
		const span = width + 2;
		const inline = this.inlineBorderContent?.enabled() ? this.inlineBorderContent : undefined;
		const inner = (inline &&
			inlineBorderCore(span, "bottom", this.getBorder, (budget) => inline.render("bottom", budget), hiddenLineCount)) ??
			super.renderBottomBorder(span, hiddenLineCount);
		const line = `${this.getBorder("╰")}${inner}${this.getBorder("╯")}`;
		this.lastFrameBottomBorder = line;
		return line;
	}

	private renderBase(width: number): string[] {
		const renderedLines = super.render(width);
		if (this.cursorStyle === "block") return renderedLines;

		// A focused overlay suppresses the editor's cursor marker. Preserve its
		// position only for the live settings preview, then clear it on refocus.
		let cursorMarker = this.previewHardwareCursor && !this.focused ? CURSOR_MARKER : "";
		if (this.focused) this.previewHardwareCursor = false;
		return renderedLines.map((line) => {
			const rendered = removeSoftwareCursor(line, cursorMarker);
			if (rendered !== line) cursorMarker = "";
			return rendered;
		});
	}

	render(width: number): string[] {
		// Self-heal after /reload: pi resets UI state (hardware cursor back to
		// hidden) when extensions reload, but the editor only reconfigures the
		// cursor on install or style change. Re-assert it when we notice it's off.
		if (this.cursorStyle !== "block" && !this.tui.getShowHardwareCursor()) {
			configureCursor(this.tui, this.cursorStyle);
		}
		if (width < 4) return this.renderBase(width);

		const rail = this.getRail();
		// ponytail: 1-char rail + 1-char gap on each side = 4 chars of chrome.
		const innerWidth = Math.max(0, width - 4);
		// Render-phase gate flip (ADR-0008): pi's duck-typed embed routing and
		// the native ladder read the same embedWorkingStatus field. Outside
		// render() the field carries the routing mode (set via
		// setEmbeddedWorkingStatusRouting); while rendering it additionally
		// opens for our own indicator, so "both" mode keeps pi's status line
		// beside our border status. Readonly only at the type level.
		const gate = this as { embedWorkingStatus: boolean };
		this.framedPass = true;
		const savedEmbed = gate.embedWorkingStatus;
		gate.embedWorkingStatus = savedEmbed || this.frameStatusIndicator !== undefined;
		let baseLines: string[];
		try {
			baseLines = this.renderBase(innerWidth);
		} finally {
			gate.embedWorkingStatus = savedEmbed;
			this.framedPass = false;
		}

		// The hooks already emitted fully framed borders at full width; rail-wrap
		// only the content lines between them. The bottom border is located by
		// structural match on the recorded hook output — no border-shape
		// scraping of base render lines.
		const marker = this.lastFrameBottomBorder;
		let bottomIdx = marker === undefined ? -1 : baseLines.lastIndexOf(marker);
		if (bottomIdx < 1) bottomIdx = baseLines.length - 1;

		const result: string[] = [];
		result.push(baseLines[0] ?? "");
		for (let i = 1; i < bottomIdx; i++) {
			result.push(`${rail} ${fillLine(baseLines[i] ?? "", innerWidth)} ${rail}`);
		}
		result.push(baseLines[bottomIdx] ?? "");
		for (let i = bottomIdx + 1; i < baseLines.length; i++) {
			result.push(baseLines[i] ?? "");
		}

		return result.map((line) => truncateToWidth(line, width, ""));
	}
}

export function installEditor(
	_pi: ExtensionAPI,
	ctx: ExtensionContext,
	cursorStyle: CursorStyle = "block",
	wheelScrollLines = DEFAULT_FULLSCREEN_WHEEL_SCROLL_LINES,
) {
	let activeTui: TUI | undefined;
	let activeEditor: OpenTuiEditor | undefined;
	let previousHardwareCursor: boolean | undefined;
	let currentCursorStyle = cursorStyle;
	let currentWheelScrollLines = wheelScrollLines;
	let workingStatusIndicator: WorkingStatusIndicator | undefined;
	let inlineBorderContent: InlineBorderContent | undefined;
	let embeddedWorkingStatusRouting = false;

	ctx.ui.setEditorComponent((tui, editorTheme, keybindings) => {
		activeTui = tui;
		applyFullscreenWheelScrollLines(tui, currentWheelScrollLines);
		previousHardwareCursor = tui.getShowHardwareCursor();
		activeEditor = new OpenTuiEditor(tui, editorTheme, keybindings, currentCursorStyle);
		activeEditor.setFrameIndicator(workingStatusIndicator);
		activeEditor.setEmbeddedWorkingStatusRouting(embeddedWorkingStatusRouting);
		activeEditor.setInlineBorderContent(inlineBorderContent);
		return activeEditor;
	});
	return {
		setCursorStyle(nextCursorStyle: CursorStyle): void {
			currentCursorStyle = nextCursorStyle;
			activeEditor?.setCursorStyle(nextCursorStyle, previousHardwareCursor);
		},
		setWheelScrollLines(nextWheelScrollLines: number): void {
			currentWheelScrollLines = nextWheelScrollLines;
			if (activeTui) applyFullscreenWheelScrollLines(activeTui, currentWheelScrollLines);
		},
		setFrameIndicator(indicator: WorkingStatusIndicator | undefined): void {
			workingStatusIndicator = indicator;
			activeEditor?.setFrameIndicator(indicator);
		},
		setEmbeddedWorkingStatusRouting(enabled: boolean): void {
			embeddedWorkingStatusRouting = enabled;
			activeEditor?.setEmbeddedWorkingStatusRouting(enabled);
		},
		setInlineBorderContent(content: InlineBorderContent | undefined): void {
			inlineBorderContent = content;
			activeEditor?.setInlineBorderContent(content);
		},
		cleanup(): void {
			ctx.ui.setEditorComponent(undefined);
			if (activeTui) {
				if (currentCursorStyle !== "block") activeTui.terminal.write(DEFAULT_CURSOR_STYLE_SEQUENCE);
				if (previousHardwareCursor !== undefined) activeTui.setShowHardwareCursor(previousHardwareCursor);
			}
		},
	};
}
