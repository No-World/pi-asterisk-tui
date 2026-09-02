import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, wrapTextWithAnsi, type TUI } from "@earendil-works/pi-tui";

/** One assistant message's worth of thinking blocks. */
export interface ThinkingSection {
	/** 1-based ordinal among assistant messages that have thinking. */
	id: number;
	/** "HH:MM" from the session entry timestamp, when available. */
	timestamp: string | undefined;
	/** Model id that produced the thinking, when available. */
	model: string | undefined;
	/** Joined thinking text; redacted blocks become a placeholder. */
	text: string;
}

interface BranchEntry {
	type?: string;
	timestamp?: string;
	message?: {
		role?: string;
		model?: string;
		content?: Array<{ type?: string; thinking?: string; redacted?: boolean }>;
	};
}

function pad2(value: number): string {
	return value < 10 ? `0${value}` : String(value);
}

/** Collect thinking sections from the current session branch, oldest first. */
export function collectThinkingSections(ctx: ExtensionContext): ThinkingSection[] {
	const sections: ThinkingSection[] = [];
	let id = 0;
	for (const entry of ctx.sessionManager.getBranch() as BranchEntry[]) {
		if (entry?.type !== "message") continue;
		const message = entry.message;
		if (!message || message.role !== "assistant" || !Array.isArray(message.content)) continue;
		const blocks = message.content.filter(
			(block) => block?.type === "thinking" && typeof block.thinking === "string" && block.thinking.trim().length > 0,
		);
		if (blocks.length === 0) continue;
		id++;
		const date = entry.timestamp ? new Date(entry.timestamp) : undefined;
		const timestamp =
			date !== undefined && !Number.isNaN(date.getTime())
				? `${pad2(date.getHours())}:${pad2(date.getMinutes())}`
				: undefined;
		sections.push({
			id,
			timestamp,
			model: message.model,
			text: blocks
				.map((block) => (block.redacted ? "[redacted thinking]" : block.thinking!.trim()))
				.join("\n\n"),
		});
	}
	return sections;
}

const KEY_HINT = "↑/↓ j/k: scroll · u/d PgUp/PgDn: page · g/G: top/bottom · Esc/q: close";

/**
 * Scrollable full-screen viewer for thinking blocks that pi hides behind the
 * one-line label (hideThinkingBlock, ctrl+t). Per-message expansion is not
 * possible in pi's transcript, so this overlay is the peek window.
 */
export class ThinkingViewer {
	private readonly sections: ThinkingSection[];
	private readonly theme: Theme;
	private readonly height: number;
	private readonly onClose: () => void;
	private lines: string[] = [];
	private scroll = 0;
	private cachedWidth: number | undefined;
	private positioned = false;

	constructor(sections: ThinkingSection[], theme: Theme, height: number, onClose: () => void) {
		this.sections = sections;
		this.theme = theme;
		this.height = Math.max(3, height);
		this.onClose = onClose;
	}

	/** Pre-wrapped, colored body lines for the given width. */
	private rebuild(width: number): void {
		this.cachedWidth = width;
		const lines: string[] = [];
		if (this.sections.length === 0) {
			lines.push(this.theme.fg("muted", "No thinking blocks in this session."));
		}
		for (const section of this.sections) {
			const meta = [section.timestamp, section.model].filter(Boolean).join(" · ");
			const header = meta ? `#${section.id} · ${meta}` : `#${section.id}`;
			lines.push(this.theme.fg("accent", `✻ ${header}`));
			const wrapped = wrapTextWithAnsi(section.text, Math.max(10, width - 2));
			for (const line of wrapped) {
				lines.push(this.theme.fg("thinkingText", `  ${line}`));
			}
			lines.push("");
		}
		if (lines.length > 0 && lines.at(-1) === "") lines.pop();
		this.lines = lines;
		if (!this.positioned) {
			// Start at the newest thinking (bottom), like a chat tail.
			this.scroll = Math.max(0, lines.length - this.height);
			this.positioned = true;
		}
		this.scroll = Math.max(0, Math.min(this.scroll, this.maxScroll()));
	}

	private maxScroll(): number {
		return Math.max(0, this.lines.length - this.height);
	}

	private scrollBy(lines: number): void {
		this.scroll = Math.max(0, Math.min(this.scroll + lines, this.maxScroll()));
	}

	render(width: number): string[] {
		if (width !== this.cachedWidth) this.rebuild(width);
		const title = this.theme.fg("accent", this.theme.bold("✻ Thinking"));
		const count = this.theme.fg("muted", ` ${this.sections.length} message${this.sections.length === 1 ? "" : "s"}`);
		const header = `${title}${count}`;
		const body: string[] = [];
		const slice = this.lines.slice(this.scroll, this.scroll + this.height);
		for (let i = 0; i < this.height; i++) {
			body.push(slice[i] ?? "");
		}
		const position =
			this.lines.length > this.height
				? ` · ${Math.min(this.scroll + this.height, this.lines.length)}/${this.lines.length}`
				: "";
		const footer = this.theme.fg("dim", `${KEY_HINT}${position}`);
		return [header, ...body, footer];
	}

	handleInput(data: string): void {
		if (matchesKey(data, Key.escape) || matchesKey(data, "q")) {
			this.onClose();
			return;
		}
		if (matchesKey(data, Key.up) || matchesKey(data, "k")) {
			this.scrollBy(-1);
			return;
		}
		if (matchesKey(data, Key.down) || matchesKey(data, "j")) {
			this.scrollBy(1);
			return;
		}
		if (matchesKey(data, Key.pageUp) || matchesKey(data, "u") || matchesKey(data, Key.home)) {
			this.scrollBy(-this.height);
			return;
		}
		if (matchesKey(data, Key.pageDown) || matchesKey(data, "d") || matchesKey(data, Key.end)) {
			this.scrollBy(this.height);
			return;
		}
		if (matchesKey(data, "g")) {
			this.scroll = 0;
			return;
		}
		if (matchesKey(data, Key.shift("g"))) {
			this.scroll = this.maxScroll();
			return;
		}
	}
}

/** Registers the `/thinking` overlay command. */
export function registerThinkingCommand(pi: ExtensionAPI): void {
	pi.registerCommand("thinking", {
		description: "View thinking blocks hidden behind the ✻ label",
		handler: async (_args: string, ctx: ExtensionContext) => {
			if (!ctx.hasUI) return;
			await ctx.ui.custom<void>((tui: TUI, theme, _kb, done) => {
				const rows = (tui as TUI & { terminal?: { rows?: number } }).terminal?.rows ?? 24;
				const viewer = new ThinkingViewer(
					collectThinkingSections(ctx),
					theme,
					rows - 4,
					() => done(undefined),
				);
				return {
					render: (width: number) => viewer.render(width),
					invalidate: () => {},
					handleInput: (data: string) => {
						viewer.handleInput(data);
						tui.requestRender();
					},
				};
			}, { overlay: true });
		},
	});
}
