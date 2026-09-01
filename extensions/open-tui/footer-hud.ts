/**
 * claude-hud style footer for the vendored open-tui project.
 *
 * [glm-5.3[1.0M] ◕ xhigh] │ dir git:(branch* ↑3 [+71 -5]) │ session-name │ ⏱ 1h 6m │ $6.56
 * 上下文 ███░░░░░░░ 26% (264k/1.0M)                     node v22 │ cache 95%
 * ✓ Bash ×14 │ ✓ Read ×6 │ ✓ Edit ×3 │ +2 more
 * ~.env.dev.example(+9)  ~docker-compose.yml(+25)  ?3
 */

import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { OpenTuiConfig, HudConfig } from "./config.ts";
import { runtimeSymbol, type IconGlyphs, resolveGlyphs } from "./icons.ts";
import type { GitStatus } from "./git.ts";
import type { RuntimeInfo } from "./runtime.ts";
import {
	alignRight,
	basenamePath,
	cacheHitColor,
	effortColor,
	fmtTokens,
	formatCwd,
	formatDuration,
	sanitizeStatus,
	stressColor,
	truncateBranch,
} from "./utils.ts";
import type { FooterState, ModelMeta } from "./state.ts";
import { getUsageTotals } from "./state.ts";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);

// thinking-level icons aligned with claude-hud (off is not displayed)
const THINKING_ICONS: Record<string, string> = {
	minimal: "◌",
	low: "○",
	medium: "◔",
	high: "◑",
	xhigh: "◕",
	max: "●",
};

interface FileStat {
	path: string;
	add: number;
	del: number;
}
interface DiffStats {
	files: FileStat[];
	addTotal: number;
	delTotal: number;
}

async function collectDiffStats(cwd: string): Promise<DiffStats> {
	const empty: DiffStats = { files: [], addTotal: 0, delTotal: 0 };
	// "~name.ts" — basename only; "~" is a modified-file marker (claude-hud style)
	const toDisplay = (p: string): string => "~" + (p.split("/").pop() ?? p);

	const byPath = new Map<string, FileStat>();
	for (const args of [["diff", "--numstat"], ["diff", "--cached", "--numstat"]]) {
		try {
			const { stdout } = await exec("git", args, { cwd, timeout: 3000 });
			for (const line of stdout.split("\n")) {
				if (!line.trim()) continue;
				const [a, d, ...rest] = line.split("\t");
				const raw = rest.join("\t");
				const rp = raw.includes(" => ") ? raw.split(" => ").pop()! : raw;
				const p = toDisplay(rp);
				const cur = byPath.get(p) ?? { path: p, add: 0, del: 0 };
				cur.add += a === "-" ? 0 : Number(a);
				cur.del += d === "-" ? 0 : Number(d);
				byPath.set(p, cur);
			}
		} catch {
			// ignore individual failures
		}
	}
	const files = [...byPath.values()].sort((x, y) => y.add + y.del - (x.add + x.del));
	return {
		files,
		addTotal: files.reduce((s, f) => s + f.add, 0),
		delTotal: files.reduce((s, f) => s + f.del, 0),
	};
}

// ---- claude-hud style extras: cached collectors ----

interface EnvInfo {
	contextFiles: number;
	skills: number;
	extensions: number;
	packages: number;
}

function fileExists(p: string): boolean {
	try {
		return fs.statSync(p).isFile();
	} catch {
		return false;
	}
}

function collectEnvInfo(cwd: string): EnvInfo {
	const agentDir = getAgentDir();
	let contextFiles = 0;
	if (
		fileExists(path.join(agentDir, "AGENTS.md")) ||
		fileExists(path.join(agentDir, "CLAUDE.md"))
	) {
		contextFiles++;
	}
	let dir = cwd;
	for (;;) {
		if (fileExists(path.join(dir, "AGENTS.override.md"))) contextFiles++;
		else if (fileExists(path.join(dir, "AGENTS.md")) || fileExists(path.join(dir, "CLAUDE.md"))) contextFiles++;
		const parent = path.dirname(dir);
		if (parent === dir) break;
		dir = parent;
	}

	let skills = 0;
	try {
		for (const entry of fs.readdirSync(path.join(agentDir, "skills"), { withFileTypes: true })) {
			if (entry.isDirectory() && fileExists(path.join(agentDir, "skills", entry.name, "SKILL.md"))) skills++;
		}
	} catch {
		/* no skills dir */
	}

	let extensions = 0;
	try {
		extensions = fs.readdirSync(path.join(agentDir, "extensions")).length;
	} catch {
		/* no extensions dir */
	}

	let packages = 0;
	try {
		const settings = JSON.parse(fs.readFileSync(path.join(agentDir, "settings.json"), "utf8"));
		packages = Array.isArray(settings.packages) ? settings.packages.length : 0;
	} catch {
		/* ignore */
	}

	return { contextFiles, skills, extensions, packages };
}

function todayStartMs(): number {
	const d = new Date();
	d.setHours(0, 0, 0, 0);
	return d.getTime();
}

/** Sum today's cost across this project's session files (assistant usage). */
function collectDailyCost(sessionDir: string | null): number {
	if (!sessionDir) return 0;
	let total = 0;
	let files: string[];
	try {
		files = fs.readdirSync(sessionDir).filter((f) => f.endsWith(".jsonl"));
	} catch {
		return 0;
	}
	const start = todayStartMs();
	for (const f of files) {
		const p = path.join(sessionDir, f);
		try {
			if (fs.statSync(p).mtimeMs < start) continue;
			const content = fs.readFileSync(p, "utf8");
			for (const line of content.split("\n")) {
				if (!line.includes('"assistant"')) continue;
				try {
					const e = JSON.parse(line);
					if (e.type === "message" && e.message?.role === "assistant") {
						total += e.message.usage?.cost?.total ?? 0;
					}
				} catch {
					/* skip bad line */
				}
			}
		} catch {
			/* skip unreadable file */
		}
	}
	return total;
}

async function collectPiVersion(): Promise<string | null> {
	try {
		const { stdout } = await exec("pi", ["--version"], { timeout: 3000 });
		return stdout.trim().split("\n")[0] ?? null;
	} catch {
		return null;
	}
}

function renderContextBar(theme: Theme, ctx: ExtensionContext, hud: HudConfig): string {
	const usage = ctx.getContextUsage();
	const ctxWin = usage?.contextWindow ?? ctx.model?.contextWindow ?? 0;
	if (ctxWin <= 0) return "";
	const tokens = usage?.tokens ?? 0;
	const pct = usage?.percent ?? 0;
	const filled = Math.round((pct / 100) * 10);
	const color = stressColor(pct);
	let bar = theme.fg("dim", "上下文 ") +
		theme.fg(color, "█".repeat(filled)) +
		theme.fg("dim", "░".repeat(10 - filled));
	if (hud.contextPercent) bar += theme.fg("muted", ` ${Math.floor(pct)}%`);
	if (hud.contextTokens) {
		bar += theme.fg("dim", ` (${fmtTokens(tokens)}/${fmtTokens(ctxWin)})`);
	}
	return bar;
}

export interface FooterHooks {
	setRequestRender: (fn: (() => void) | undefined) => void;
	scheduleGitRefresh: () => void;
}

export function installHudFooter(
	ctx: ExtensionContext,
	getState: () => FooterState,
	getConfig: () => OpenTuiConfig,
	getModelMeta: () => ModelMeta,
	hooks: FooterHooks,
): () => void {
	ctx.ui.setFooter((tui, theme, footerData) => {
		hooks.setRequestRender(() => tui.requestRender());
		const requestRender = () => tui.requestRender();
		const unsubBranch = footerData.onBranchChange(() => {
			hooks.scheduleGitRefresh();
			tui.requestRender();
		});

		// working/done timer ticks (kept from upstream) + diff stats polling
		let diff: DiffStats = { files: [], addTotal: 0, delTotal: 0 };
		let polling = false;
		const refreshDiff = async () => {
			if (polling) return;
			polling = true;
			try {
				diff = await collectDiffStats(ctx.sessionManager.getCwd());
			} finally {
				polling = false;
			}
			tui.requestRender();
		};
		void refreshDiff();
		const diffTimer = setInterval(() => void refreshDiff(), 4000);
		const tickTimer = setInterval(requestRender, 1000);

		// claude-hud style extras: env info / daily cost / version (60s cache)
		let envInfo: EnvInfo | null = null;
		let dailyCost = 0;
		let piVer: string | null = null;
		let extrasInflight = false;
		const refreshExtras = async () => {
			if (extrasInflight) return;
			extrasInflight = true;
			try {
				envInfo = collectEnvInfo(ctx.sessionManager.getCwd());
				const sessionFile = ctx.sessionManager.getSessionFile?.();
				dailyCost = collectDailyCost(sessionFile ? path.dirname(sessionFile) : null);
				if (piVer === null) piVer = await collectPiVersion();
			} finally {
				extrasInflight = false;
			}
			tui.requestRender();
		};
		void refreshExtras();
		const extrasTimer = setInterval(() => void refreshExtras(), 60000);

		return {
			dispose() {
				clearInterval(diffTimer);
				clearInterval(tickTimer);
				clearInterval(extrasTimer);
				unsubBranch();
				hooks.setRequestRender(undefined);
			},
			invalidate() {},
			render(width: number): string[] {
				if (width <= 0) return [""];
				const state = getState();
				const config = getConfig();
				const glyphs: IconGlyphs = resolveGlyphs(config.icons.mode);
				const hud = config.hud;
				const meta = getModelMeta();
				const sep = theme.fg("dim", " │ ");

				// ---- session stats: cost, tool counts, elapsed ----
				const totals = getUsageTotals(ctx);
				const toolCounts = new Map<string, number>();
				const pendingCalls = new Map<string, string>(); // toolCallId -> name
				let turnStartMs: number | null = null;
				let lastTs: number | null = null;
				let workingMs = 0;
				let compactions = 0;

				for (const e of ctx.sessionManager.getBranch() as any[]) {
					if (e.type === "compaction") compactions++;
					const ts = e.timestamp ? new Date(e.timestamp).getTime() : null;
					if (e.type === "message" && e.message?.role === "user") {
						// close the previous turn with the prior entry's ts, then open a new one
						if (turnStartMs !== null && lastTs !== null) {
							workingMs += lastTs - turnStartMs;
						}
						turnStartMs = ts;
					}
					if (ts !== null) lastTs = ts;
					if (e.type !== "message") continue;
					const msg = e.message;
					if (msg.role === "assistant" && Array.isArray(msg.content)) {
						for (const block of msg.content) {
							if (block?.type === "toolCall") {
								pendingCalls.set(block.id, block.name ?? block.toolName ?? "tool");
							}
						}
					} else if (msg.role === "toolResult" && msg.toolName) {
						pendingCalls.delete(msg.toolCallId);
						toolCounts.set(msg.toolName, (toolCounts.get(msg.toolName) ?? 0) + 1);
					}
				}
				// accumulate the in-flight turn (or the just-finished one)
				if (turnStartMs !== null && lastTs !== null) {
					workingMs +=
						(state.workingSince !== undefined ? Date.now() : lastTs) - turnStartMs;
				}
				const running = [...pendingCalls.values()].slice(-2);

				// ---- line 1: [model[ctx] ◕ level] │ dir git:(…) │ name │ ⏱ time │ $cost ----
				const usage = ctx.getContextUsage();
				const ctxWin = usage?.contextWindow ?? ctx.model?.contextWindow ?? 0;
				let modelBlock = "";
				if (hud.model) {
					modelBlock =
						theme.fg("dim", "[") +
						theme.fg("accent", meta.model) +
						(hud.modelContextWindow && ctxWin > 0
							? theme.fg("dim", "[") + theme.fg("muted", fmtTokens(ctxWin)) + theme.fg("dim", "]")
							: "");
					if (hud.modelThinking && meta.effort && meta.effort !== "off") {
						const icon = THINKING_ICONS[meta.effort] ?? "○";
						modelBlock +=
							" " +
							theme.fg(effortColor(meta.effort), icon) +
							theme.fg("muted", ` ${meta.effort}`);
					}
					modelBlock += theme.fg("dim", "]");
				}

				const left1: string[] = [];
				if (modelBlock) left1.push(modelBlock);

				const git: GitStatus = state.git;
				const cwd = formatCwd(ctx.sessionManager.getCwd());
				const dir = basenamePath(cwd) || cwd;
				if (hud.git) {
					let gitStr = hud.gitDir ? theme.fg("dim", dir) : "";
					if (hud.gitBranch && git.branch) {
						const dirty =
							git.modified + git.staged + git.untracked + git.conflicted + git.renamed + git.deleted >
							0;
						const ab = git.ahead > 0 ? ` ↑${git.ahead}` : "";
						const bb = git.behind > 0 ? ` ↓${git.behind}` : "";
						const dd =
							hud.gitDiffTotals && diff.addTotal + diff.delTotal > 0
								? ` ${theme.fg("warning", `[+${diff.addTotal} -${diff.delTotal}]`)}`
								: "";
						gitStr +=
							(gitStr ? " " : "") +
							theme.fg("dim", "git:(") +
							theme.fg("mdLink", truncateBranch(git.branch, 24)) +
							(dirty ? theme.fg("warning", "*") : "") +
							theme.fg("muted", ab + bb) +
							dd +
							theme.fg("dim", ")");
					}
					if (gitStr) left1.push(gitStr);
				}

				if (hud.sessionName) {
					const name = ctx.sessionManager.getSessionName();
					if (name) left1.push(theme.fg("success", truncateToWidth(name, 24, "…")));
				}

				const right1: string[] = [];
				if (hud.time) {
					right1.push(theme.fg("muted", `⏱️ ${formatDuration(workingMs)}`));
				}
				if (hud.cost) right1.push(theme.fg("muted", `费用 $${totals.cost.toFixed(2)}`));
				if (hud.dailyCost) right1.push(theme.fg("muted", `今日 $${dailyCost.toFixed(2)}`));
				const line1 = alignRight(left1.join(sep), right1.join(sep), width, theme);

				// ---- line 2: context bar … runtime │ cache-hit │ tokens ----
				let line2 = "";
				if (hud.contextBar) line2 = renderContextBar(theme, ctx, hud);
				const right2: string[] = [];
				if (hud.runtime && state.runtime) {
					const rt: RuntimeInfo = state.runtime;
					const sym = runtimeSymbol(rt.name, config.icons.mode);
					right2.push(
						theme.fg("success", sym) + theme.fg("muted", rt.version ? ` ${rt.version}` : "")
					);
				}
				if (hud.tokens) {
					const cachedPart =
						hud.tokenBreakdown && totals.cacheRead > 0
							? theme.fg("dim", `·缓存读 ${fmtTokens(totals.cacheRead)}`)
							: "";
					right2.push(
						theme.fg("accent", `↑输入 ${fmtTokens(totals.input + totals.cacheRead)}`) +
						cachedPart
					);
					right2.push(theme.fg("success", `↓输出 ${fmtTokens(totals.output)}`));
					if (hud.cacheHit && totals.latestCacheHitRate !== undefined) {
						right2.push(
							theme.fg(
								cacheHitColor(totals.latestCacheHitRate),
								`缓存命中 ${totals.latestCacheHitRate.toFixed(1)}%`
							)
						);
					}
				}
				if (hud.compactions && compactions > 0) {
				right2.push(theme.fg("muted", `压实 ${compactions}`));
			}
				if (hud.piVersion && piVer) right2.push(theme.fg("muted", piVer));
				if (right2.length) {
					line2 = alignRight(line2, right2.join(sep), width, theme);
				}

				// ---- optional: memory usage line (claude-hud expanded style) ----
				let memLine = "";
				if (hud.memory) {
					const totalMem = os.totalmem();
					const usedMem = totalMem - os.freemem();
					const memPct = (usedMem / totalMem) * 100;
					const memFilled = Math.round((memPct / 100) * 10);
					const fmtGB = (n: number) => `${(n / 1024 ** 3).toFixed(0)}G`;
					memLine =
						theme.fg("dim", "内存 ") +
						theme.fg(stressColor(memPct), "█".repeat(memFilled)) +
						theme.fg("dim", "░".repeat(10 - memFilled)) +
						theme.fg("muted", ` ${Math.floor(memPct)}%`) +
						theme.fg("dim", ` (${fmtGB(usedMem)}/${fmtGB(totalMem)})`);
				}

				// ---- optional: environment line (context files / skills / extensions / packages) ----
				let envLine = "";
				if (hud.environment && envInfo) {
					const parts: string[] = [];
					if (envInfo.contextFiles > 0) {
						parts.push(theme.fg("muted", `${envInfo.contextFiles} AGENTS.md`));
					}
					if (envInfo.skills > 0) parts.push(theme.fg("muted", `${envInfo.skills} skills`));
					if (envInfo.extensions > 0) {
						parts.push(theme.fg("muted", `${envInfo.extensions} 扩展`));
					}
					if (envInfo.packages > 0) parts.push(theme.fg("muted", `${envInfo.packages} 包`));
					if (parts.length) envLine = parts.join(sep);
				}

				// ---- line 3: tool usage ----
				let line3 = "";
				if (hud.tools) {
					const parts: string[] = [];
					if (hud.toolsRunning) {
						for (const name of running) {
							parts.push(theme.fg("warning", "◐") + theme.fg("mdLink", ` ${name}`));
						}
					}
					const sorted = [...toolCounts.entries()].sort((a, b) => b[1] - a[1]);
					for (const [name, count] of sorted.slice(0, hud.toolsMax)) {
						parts.push(
							theme.fg("success", "✓") + theme.fg("muted", ` ${name} ×${count}`)
						);
					}
					const hidden = sorted.length - hud.toolsMax;
					if (hidden > 0) parts.push(theme.fg("dim", `+${hidden} more`));
					if (parts.length) line3 = parts.join(sep);
				}

				// ---- line 4: changed files ----
				let line4 = "";
				if (hud.files) {
					const parts: string[] = diff.files.slice(0, hud.filesMax).map((f) =>
						theme.fg(
							"muted",
							`${f.path}(+${f.add}${f.del ? ` -${f.del}` : ""})`
						)
					);
					if (hud.filesUntracked && git.untracked > 0) {
						parts.push(theme.fg("warning", `?${git.untracked}`));
					}
					if (parts.length) line4 = parts.join(theme.fg("dim", "  "));
				}

				// ---- line 5: extension statuses (e.g. running subagents) ----
				let line5 = "";
				if (hud.extensionStatuses) {
					const statuses = [...footerData.getExtensionStatuses().values()]
						.map((s) => sanitizeStatus(s))
						.filter((s) => s.length > 0);
					if (statuses.length) {
						line5 = statuses.map((s) => theme.fg("muted", s)).join(theme.fg("dim", " │ "));
					}
				}

				return [line1, line2, memLine, envLine, line3, line4, line5]
					.filter((l) => l.length > 0)
					.map((l) => truncateToWidth(l, width, theme.fg("dim", "…")));
			},
		};
	});

	return () => {
		ctx.ui.setFooter(undefined);
	};
}
