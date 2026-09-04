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
import { pathToFileURL } from "node:url";
import type { OpenTuiConfig, HudConfig, SettingsLanguage } from "./config.ts";
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

// HUD labels follow the /open-tui panel language (settingsLanguage).
interface HudStrings {
	contextLabel: string;
	costLabel: string;
	todayLabel: string;
	speedLabel: string;
	cacheLabel: string;
	inputLabel: string;
	outputLabel: string;
	hitLabel: string;
	compactionLabel: string;
	memoryLabel: string;
	extensionsLabel: string;
	packagesLabel: string;
}

const HUD_STRINGS: Record<SettingsLanguage, HudStrings> = {
	en: {
		contextLabel: "ctx ",
		costLabel: "cost ",
		todayLabel: "today ",
		speedLabel: "out ",
		cacheLabel: "·cache ",
		inputLabel: "↑in ",
		outputLabel: "↓out ",
		hitLabel: "hit ",
		compactionLabel: "compact ",
		memoryLabel: "mem ",
		extensionsLabel: " ext",
		packagesLabel: " pkgs",
	},
	zh: {
		contextLabel: "上下文 ",
		costLabel: "费用 ",
		todayLabel: "今日 ",
		speedLabel: "输出: ",
		cacheLabel: "·缓存 ",
		inputLabel: "↑输入 ",
		outputLabel: "↓输出 ",
		hitLabel: "缓存命中 ",
		compactionLabel: "压实 ",
		memoryLabel: "内存 ",
		extensionsLabel: " 扩展",
		packagesLabel: " 包",
	},
};

type FileStatus = "added" | "modified" | "deleted";

interface FileStat {
	/** Display name: file basename */
	path: string;
	/** Absolute path for OSC 8 hyperlinks */
	absPath: string;
	status: FileStatus;
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
	let top: string | null = null;
	try {
		const { stdout } = await exec("git", ["rev-parse", "--show-toplevel"], {
			cwd,
			timeout: 3000,
		});
		top = stdout.trim() || null;
	} catch {
		return empty; // not a git repo
	}
	if (!top) return empty;

	// per-file status codes (A/M/D/…) from git status, keyed by repo-relative path
	const statusMap = new Map<string, string>();
	try {
		const { stdout } = await exec("git", ["status", "--porcelain"], { cwd, timeout: 3000 });
		for (const line of stdout.split("\n")) {
			if (line.length < 4) continue;
			const xy = line.slice(0, 2);
			let sp = line.slice(3).trim();
			if (sp.startsWith('"') && sp.endsWith('"')) sp = sp.slice(1, -1);
			if (sp.includes(" -> ")) sp = sp.split(" -> ").pop()!;
			statusMap.set(sp, xy);
		}
	} catch {
		/* ignore */
	}

	const byPath = new Map<string, FileStat>();
	for (const args of [["diff", "--numstat"], ["diff", "--cached", "--numstat"]]) {
		try {
			const { stdout } = await exec("git", args, { cwd, timeout: 3000 });
			for (const line of stdout.split("\n")) {
				if (!line.trim()) continue;
				const [a, d, ...rest] = line.split("\t");
				const raw = rest.join("\t");
				const rp = raw.includes(" => ") ? raw.split(" => ").pop()! : raw;
				const abs = rp.startsWith("/") ? rp : `${top}/${rp}`;
				const p = rp.split("/").pop() ?? rp;
				const xy = statusMap.get(rp) ?? "";
				const status: FileStatus = xy.includes("A")
					? "added"
					: xy.includes("D")
						? "deleted"
						: "modified";
				const cur = byPath.get(p) ?? { path: p, absPath: abs, status, add: 0, del: 0 };
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
	mcp: number;
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
	let hasMcpAdapter = false;
	try {
		const settings = JSON.parse(fs.readFileSync(path.join(agentDir, "settings.json"), "utf8"));
		const pkgs: unknown = settings.packages;
		packages = Array.isArray(pkgs) ? pkgs.length : 0;
		hasMcpAdapter = Array.isArray(pkgs) && pkgs.some((p) => String(p).includes("pi-mcp-adapter"));
	} catch {
		/* ignore */
	}

	// enabled MCP servers across pi-mcp-adapter's config chain (highest precedence first);
	// only counted when pi-mcp-adapter is actually installed
	const mcpNames = new Map<string, boolean>(); // name -> disabled
	const mcpFiles = hasMcpAdapter ? [
		path.join(os.homedir(), ".config", "mcp", "mcp.json"),
		path.join(os.homedir(), ".agents", "mcp.json"),
		path.join(os.homedir(), ".agents", "mcp", "mcp.json"),
		path.join(agentDir, "mcp.json"),
		path.join(cwd, ".mcp.json"),
		path.join(cwd, ".pi", "mcp.json"),
	] : [];
	for (const f of mcpFiles) {
		try {
			const cfg = JSON.parse(fs.readFileSync(f, "utf8"));
			const servers = cfg?.mcpServers;
			if (!servers || typeof servers !== "object") continue;
			for (const [name, entry] of Object.entries(servers as Record<string, unknown>)) {
				if (!mcpNames.has(name)) {
					mcpNames.set(name, Boolean((entry as Record<string, unknown> | null)?.disabled));
				}
			}
		} catch {
			/* ignore */
		}
	}
	const mcp = [...mcpNames.values()].filter((d) => !d).length;

	return { contextFiles, skills, extensions, packages, mcp };
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


/** OSC 8 hyperlink — Cmd/Ctrl+click opens the target in supporting terminals. */
function link(url: string, text: string): string {
	return `\x1b]8;;${url}\x1b\\${text}\x1b]8;;\x1b\\`;
}

interface RunningCall {
	name: string;
	label: string;
}

function truncateLabel(v: string, mode: "head" | "tail" = "head"): string {
	const one = v.replace(/\s+/g, " ").trim();
	if (one.length <= 36) return one;
	// paths keep their tail (.../basename); commands keep their head
	if (mode === "tail") return `...${one.slice(-33)}`;
	return `${one.slice(0, 35)}…`;
}

/** Short human label for a running tool call: "docker compose -f…", "/pattern/", a path… */
function toolCallLabel(name: string, args: unknown): string {
	let a: unknown = args;
	if (typeof a === "string") {
		try {
			a = JSON.parse(a);
		} catch {
			return truncateLabel(String(args));
		}
	}
	if (!a || typeof a !== "object") return "";
	const o = a as Record<string, unknown>;
	let v = "";
	let mode: "head" | "tail" = "head";
	switch (name) {
		case "bash":
			v = String(o.command ?? "");
			break;
		case "read":
		case "edit":
		case "write":
			v = String(o.path ?? o.file ?? "");
			mode = "tail";
			break;
		case "grep":
			v = o.pattern ? `/${o.pattern}/` : "";
			break;
		case "find":
			v = String(o.query ?? o.pattern ?? "");
			break;
		default: {
			const first = Object.values(o)[0];
			v = typeof first === "string" ? first : "";
		}
	}
	return truncateLabel(v, mode);
}

function renderContextBar(theme: Theme, ctx: ExtensionContext, hud: HudConfig, strings: HudStrings): string {
	const usage = ctx.getContextUsage();
	const ctxWin = usage?.contextWindow ?? ctx.model?.contextWindow ?? 0;
	if (ctxWin <= 0) return "";
	const tokens = usage?.tokens ?? 0;
	const pct = usage?.percent ?? 0;
	const filled = Math.round((pct / 100) * 10);
	const color = stressColor(pct);
	let bar = theme.fg("dim", strings.contextLabel) +
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
				const strings = HUD_STRINGS[config.settingsLanguage] ?? HUD_STRINGS.en;
				const meta = getModelMeta();
				const sep = theme.fg("dim", " │ ");

				// ---- session stats: cost, tool counts, elapsed ----
				const totals = getUsageTotals(ctx);
				const toolCounts = new Map<string, number>();
				const pendingCalls = new Map<string, RunningCall>(); // toolCallId -> running call
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
								const name = block.name ?? block.toolName ?? "tool";
								pendingCalls.set(block.id, {
									name,
									label: toolCallLabel(name, block.arguments ?? block.args),
								});
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
					let gitStr = hud.gitDir
						? link(
							pathToFileURL(ctx.sessionManager.getCwd()).href,
							theme.underline(theme.fg("mdHeading", dir)),
						)
						: "";
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
							theme.fg("customMessageLabel", "git:(") +
							theme.fg("borderAccent", truncateBranch(git.branch, 24)) +
							(dirty ? theme.fg("borderAccent", "*") : "") +
							theme.fg("muted", ab + bb) +
							dd +
							theme.fg("customMessageLabel", ")");
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
				if (hud.cost) right1.push(theme.fg("muted", `${strings.costLabel}$${totals.cost.toFixed(2)}`));
				if (hud.dailyCost) right1.push(theme.fg("muted", `${strings.todayLabel}$${dailyCost.toFixed(2)}`));
				if (hud.outputSpeed && state.outputTps !== null && state.outputTps > 0) {
					right1.push(theme.fg("accent", `${strings.speedLabel}${state.outputTps.toFixed(1)} tok/s`));
				}
				const line1 = alignRight(left1.join(sep), right1.join(sep), width, theme);

				// ---- line 2: context bar … runtime │ cache-hit │ tokens ----
				let line2 = "";
				if (hud.contextBar) line2 = renderContextBar(theme, ctx, hud, strings);
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
							? theme.fg("dim", `${strings.cacheLabel}${fmtTokens(totals.cacheRead)}`)
							: "";
					right2.push(
						theme.fg("accent", `${strings.inputLabel}${fmtTokens(totals.input + totals.cacheRead)}`) +
						cachedPart
					);
					const cacheWritePart =
						hud.tokenBreakdown && totals.cacheWrite > 0
							? theme.fg("dim", `${strings.cacheLabel}${fmtTokens(totals.cacheWrite)}`)
							: "";
					right2.push(
						theme.fg("success", `${strings.outputLabel}${fmtTokens(totals.output)}`) + cacheWritePart
					);
					if (hud.cacheHit && totals.cacheHitRate !== undefined) {
						right2.push(
							theme.fg(
								cacheHitColor(totals.cacheHitRate),
								`${strings.hitLabel}${totals.cacheHitRate.toFixed(1)}%`
							)
						);
					}
				}
				if (hud.compactions && compactions > 0) {
				right2.push(theme.fg("muted", `${strings.compactionLabel}${compactions}`));
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
						theme.fg("dim", strings.memoryLabel) +
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
						parts.push(theme.fg("muted", `${envInfo.extensions}${strings.extensionsLabel}`));
					}
					if (envInfo.packages > 0) parts.push(theme.fg("muted", `${envInfo.packages}${strings.packagesLabel}`));
					if (envInfo.mcp > 0) parts.push(theme.fg("muted", `${envInfo.mcp} MCP`));
					if (parts.length) envLine = parts.join(sep);
				}

				// ---- line 3: tool usage ----
				let line3 = "";
				if (hud.tools) {
					const parts: string[] = [];
					if (hud.toolsRunning) {
						for (const call of running) {
							const label = call.label ? `: ${call.label}` : "";
							parts.push(
								theme.fg("warning", "◐") + theme.fg("mdLink", ` ${call.name}${label}`)
							);
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
					const parts: string[] = diff.files.slice(0, hud.filesMax).map((f) => {
						const prefix = f.status === "added" ? "+" : f.status === "deleted" ? "-" : "~";
						const color =
							f.status === "added" ? "success" : f.status === "deleted" ? "error" : "warning";
						const stats =
							f.status === "deleted"
								? `(-${f.del})`
								: `(+${f.add}${f.del ? ` -${f.del}` : ""})`;
						return link(
							pathToFileURL(f.absPath).href,
							theme.underline(theme.fg(color, `${prefix}${f.path}${stats}`))
						);
					});
					if (hud.filesUntracked && git.untracked > 0) {
						parts.push(theme.fg("warning", `+${git.untracked}`));
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
