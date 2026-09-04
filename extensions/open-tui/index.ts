import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { type OpenTuiConfig, DEFAULT_CONFIG, ensureConfigExists, loadConfig, saveConfig } from "./config.ts";
import { ensureHideThinkingDefault } from "./pi-settings.ts";
import {
	installTurnCollapse,
	setAgentActive,
	setThinkingDurations,
	setTurnCollapseEnabled,
	setTurnCollapseTheme,
	uninstallTurnCollapse,
} from "./turn-collapse.ts";
import { installEditor } from "./editor.ts";
import { installFooter } from "./footer.ts";
import { installHeader } from "./header.ts";
import { emptyGitStatus, readGitStatus } from "./git.ts";
import { SessionLifecycle } from "./session-lifecycle.ts";
import { registerSettingsCommand } from "./settings-command.ts";
import { installThinkingClickExpand } from "./thinking-click.ts";
import { formatTurnTelemetry, TurnTelemetryTracker } from "./telemetry.ts";
import {
	createInitialState,
	getModelMeta,
	invalidateUsageCache,
	type FooterState,
} from "./state.ts";
import { formatDuration, fmtTokens } from "./utils.ts";

function isInteractiveLaunch(): boolean {
	if (!process.stdout.isTTY) return false;
	const args = process.argv.slice(2);
	const nonInteractiveFlags = ["-p", "--print", "--help", "-h", "--version", "-v", "--list-models", "--export"];
	for (const arg of args) {
		if (nonInteractiveFlags.includes(arg)) return false;
		if (arg.startsWith("--mode")) return false;
	}
	return true;
}

type PendingUiChange = "install" | "uninstall" | "reinstall";

export function getPendingUiChange(enabled: boolean, active: boolean): PendingUiChange | undefined {
	if (enabled === active) return undefined;
	return enabled ? "install" : "uninstall";
}

function clearVisibleScreen(): void {
	if (process.stdout.isTTY) {
		process.stdout.write("\x1b[2J\x1b[H");
	}
}

function isTuiContext(ctx: ExtensionContext): boolean {
	try {
		const mode = (ctx as ExtensionContext & { mode?: string }).mode;
		return ctx.hasUI && (mode === undefined || mode === "tui");
	} catch {
		return false;
	}
}

export default function (pi: ExtensionAPI) {
	const sessionLifecycle = new SessionLifecycle();
	const state: FooterState = createInitialState();
	const turnTelemetry = new TurnTelemetryTracker();

	let config: OpenTuiConfig = structuredClone(DEFAULT_CONFIG);
	let active = false;
	let lastCtx: ExtensionContext | undefined;
	let requestFooterRender: (() => void) | undefined;
	let workingTimer: ReturnType<typeof setInterval> | undefined;
	let cleanupHeader: (() => void) | undefined;
	let cleanupFooter: (() => void) | undefined;
	let cleanupThinkingClick: (() => void) | undefined;
	let cleanupTurnCollapse: (() => void) | undefined;
	let editor: ReturnType<typeof installEditor> | undefined;
	let pendingUiChange: PendingUiChange | undefined;

	const getThinkingLevel = () => (sessionLifecycle.isCurrent() ? pi.getThinkingLevel() : "off");

	const applyUi = (ctx: ExtensionContext) => {
		if (!isTuiContext(ctx)) return;
		if (!config.enabled) {
			uninstallUi(ctx);
			return;
		}
		if (!active) {
			cleanupHeader = installHeader(pi, ctx);
			cleanupFooter = installFooter(
				ctx,
				() => state,
				() => config,
				() => getModelMeta(ctx, getThinkingLevel),
				{
					setRequestRender: (fn) => {
						requestFooterRender = fn ?? undefined;
					},
					scheduleGitRefresh: () => {
						void scheduleGitRefresh(ctx);
					},
				},
			);
			editor = installEditor(pi, ctx, config.cursorStyle, config.fullscreen.wheelScrollLines);
			// Re-enabled mid-session: the collapse/click patches install here too
			// (session_start only covers fresh sessions).
			if (!cleanupThinkingClick) cleanupThinkingClick = installThinkingClickExpand();
			if (!cleanupTurnCollapse) {
				setTurnCollapseTheme(ctx.ui.theme);
				cleanupTurnCollapse = installTurnCollapse();
			}
			active = true;
		}
	};

	const uninstallUi = (ctx: ExtensionContext) => {
		if (!isTuiContext(ctx)) return;
		// Cross-instance safety net: even when this instance never installed
		// the collapse patch (e.g. enabled=false at startup, then /reload), a
		// previous instance's container patch must be torn down too.
		uninstallTurnCollapse();
		if (active) {
			cleanupHeader?.();
			cleanupFooter?.();
			cleanupThinkingClick?.();
			cleanupTurnCollapse?.();
			editor?.cleanup();
			cleanupHeader = undefined;
			cleanupFooter = undefined;
			cleanupThinkingClick = undefined;
			cleanupTurnCollapse = undefined;
			editor = undefined;
			requestFooterRender = undefined;
			active = false;
		}
	};

	const scheduleGitRefresh = async (ctx: ExtensionContext) => {
		if (!sessionLifecycle.isCurrent()) return;
		const segs = config.footerSegments;
		if (!segs.gitBranch && !segs.gitStatus && !segs.gitCommit) {
			state.git = emptyGitStatus();
			requestFooterRender?.();
			return;
		}
		const generation = sessionLifecycle.currentGeneration();
		const cwd = ctx.cwd;
		const git = await readGitStatus(cwd, {
			readCommit: true,
			readTag: segs.gitCommit,
			readCounts: segs.gitStatus,
		});
		if (!sessionLifecycle.isCurrent(generation)) return;
		state.git = git;
		requestFooterRender?.();
	};

	const refreshInteractiveState = (ctx: ExtensionContext, project = false) => {
		if (!sessionLifecycle.isCurrent() || !ctx.hasUI) return;
		if (project) {
			void scheduleGitRefresh(ctx);
		}
		requestFooterRender?.();
	};

	const startWorkingTimer = () => {
		stopWorkingTimer();
		const tick = () => {
			if (!sessionLifecycle.isCurrent() || !active) return;
			requestFooterRender?.();
		};
		tick();
		workingTimer = setInterval(tick, 250);
		workingTimer.unref?.();
	};

	const stopWorkingTimer = () => {
		if (workingTimer) {
			clearInterval(workingTimer);
			workingTimer = undefined;
		}
	};

	// "⠴ Working… (7m 57s · ↓ 14.8k tokens · 3 tools)" — per-turn timer, output tokens, and
	// live tool count on the working indicator.
	// setWorkingMessage only swaps the label; pi's spinner frames stay untouched.
	let workingLabelTimer: ReturnType<typeof setInterval> | undefined;
	const updateWorkingLabel = () => {
		const ctx = lastCtx;
		if (!ctx?.ui?.setWorkingMessage) return;
		if (state.workingSince === undefined) return;
		const elapsed = formatDuration(Date.now() - state.workingSince);
		const outTokens = turnTelemetry.getTurnOutputTokens();
		const tools = turnTelemetry.getLiveToolCalls();
		const toolPart = tools > 0 ? ` · ${tools} tool${tools > 1 ? "s" : ""}` : "";
		ctx.ui.setWorkingMessage(`Working… (${elapsed} · ↓ ${fmtTokens(outTokens)} tokens${toolPart})`);
	};
	const startWorkingLabel = () => {
		stopWorkingLabel();
		updateWorkingLabel();
		workingLabelTimer = setInterval(updateWorkingLabel, 1000);
		workingLabelTimer.unref?.();
	};
	const stopWorkingLabel = () => {
		if (workingLabelTimer) {
			clearInterval(workingLabelTimer);
			workingLabelTimer = undefined;
		}
		lastCtx?.ui?.setWorkingMessage?.(); // restore default "Working..."
	};

	// Claude-style transcript labels for hidden thinking blocks (ctrl+t toggles
	// pi's hideThinkingBlock; the label is global, so it stays duration-less —
	// accurate per-turn numbers live in the footer summary instead).
	const setThinkingLabel = (ctx: ExtensionContext | undefined, label: string) => {
		if (!ctx || !isTuiContext(ctx)) return;
		ctx.ui?.setHiddenThinkingLabel?.(label);
	};

	pi.on("session_start", async (_event, ctx) => {
		sessionLifecycle.start();
		lastCtx = ctx;
		state.sessionStartEpoch = Date.now();
		state.workingSince = undefined;
		state.lastDoneIn = undefined;
		state.lastTurnSummary = undefined;
		invalidateUsageCache();

		ensureConfigExists();
		config = loadConfig((msg, level) => ctx.ui.notify(msg, level));

		if (isInteractiveLaunch() && config.enabled) {
			clearVisibleScreen();
			// Wrap the shared TuiAltScreen prototype once per process — covers
			// mode switches and sessions that start in regular mode.
			cleanupThinkingClick?.();
			cleanupThinkingClick = installThinkingClickExpand();
			setTurnCollapseEnabled(config.turnCollapse);
			setTurnCollapseTheme(ctx.ui.theme);
			setThinkingDurations(undefined); // per-session; fed at agent_settled
			cleanupTurnCollapse?.();
			cleanupTurnCollapse = installTurnCollapse();
			// Fresh installs: default pi to collapsed thinking so ✻ labels (and
			// click-to-expand in the fullscreen TUI) work everywhere. Existing
			// choices (ctrl+t) are left untouched.
			if (ensureHideThinkingDefault() === "written") {
				ctx.ui.notify(
					config.settingsLanguage === "zh"
						? "已默认折叠思考块（✻ 标签，全屏模式下可点击展开；ctrl+t 切换显示）"
						: "Thinking blocks now collapsed by default (✻ labels, click to expand in fullscreen; ctrl+t toggles)",
					"info",
				);
			}
		}

		applyUi(ctx);
		setThinkingLabel(ctx, "✻ Thought…");

		refreshInteractiveState(ctx, true);
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		sessionLifecycle.shutdown();
		stopWorkingTimer();
		stopWorkingLabel();
		if (active) {
			uninstallUi(ctx);
		}
		lastCtx = undefined;
	});

	pi.on("agent_start", (event, ctx) => {
		turnTelemetry.handle(event);
		setAgentActive(true);
		// Drop the previous run's per-message durations while streaming —
		// ordinals no longer line up until the new run settles.
		setThinkingDurations(undefined);
		if (!sessionLifecycle.isCurrent()) return;
		state.workingSince = Date.now();
		state.lastDoneIn = undefined;
		startWorkingTimer();
		startWorkingLabel();
	});

	pi.on("agent_end", (_event, _ctx) => {
		if (!sessionLifecycle.isCurrent()) return;
		stopWorkingTimer();
		stopWorkingLabel();
		if (state.workingSince !== undefined) {
			state.lastDoneIn = Date.now() - state.workingSince;
			state.workingSince = undefined;
		}
		requestFooterRender?.();
	});

	pi.on("turn_start", (event) => {
		turnTelemetry.handle(event);
	});

	pi.on("message_start", (event) => {
		turnTelemetry.handle(event);
	});

	pi.on("message_update", (event) => {
		turnTelemetry.handle(event);
	});

	pi.on("tool_execution_start", (event) => {
		turnTelemetry.handle(event);
	});

	pi.on("turn_end", (event) => {
		turnTelemetry.handle(event);
	});

	pi.on("agent_settled", (event, ctx) => {
		const telemetry = turnTelemetry.handle(event);
		setAgentActive(false); // flushes the last held retry error, if any
		setThinkingDurations(turnTelemetry.getLastRunThinkingDurations());
		state.lastTurnSummary = turnTelemetry.getLastTurnSummary();
		requestFooterRender?.();
		if (telemetry && config.enabled && config.telemetry.enabled && isTuiContext(ctx)) {
			const message = formatTurnTelemetry(telemetry, ctx.ui.theme, config.telemetry, config.icons.mode);
			if (message) ctx.ui.notify(message, "info");
		}
	});

	pi.on("model_select", (_event, ctx) => {
		refreshInteractiveState(ctx);
	});

	pi.on("thinking_level_select", (_event, ctx) => {
		refreshInteractiveState(ctx);
	});

	pi.on("message_end", (event, ctx) => {
		turnTelemetry.handle(event);
		state.outputTps = turnTelemetry.getOutputTps();
		if (!sessionLifecycle.isCurrent()) return;
		invalidateUsageCache();
		refreshInteractiveState(ctx);
	});

	pi.on("tool_execution_end", (_event, ctx) => {
		refreshInteractiveState(ctx);
	});

	pi.on("session_compact", (_event, ctx) => {
		if (!sessionLifecycle.isCurrent()) return;
		invalidateUsageCache();
		refreshInteractiveState(ctx);
	});

	pi.on("session_tree", (_event, ctx) => {
		if (!sessionLifecycle.isCurrent()) return;
		invalidateUsageCache();
		refreshInteractiveState(ctx);
	});

	registerSettingsCommand(pi, {
		getConfig: () => config,
		onConfigChanged: (newConfig) => {
			const cursorStyleChanged = config.cursorStyle !== newConfig.cursorStyle;
			const wheelScrollLinesChanged = config.fullscreen.wheelScrollLines !== newConfig.fullscreen.wheelScrollLines;
			const footerStyleChanged = config.footerStyle !== newConfig.footerStyle;
			saveConfig(newConfig);
			config = newConfig;
			if (cursorStyleChanged && active && editor) {
				editor.setCursorStyle(newConfig.cursorStyle);
			}
			if (wheelScrollLinesChanged && active && editor) {
				editor.setWheelScrollLines(newConfig.fullscreen.wheelScrollLines);
			}
			if (lastCtx) {
				pendingUiChange = getPendingUiChange(newConfig.enabled, active);
				if (!pendingUiChange && footerStyleChanged && active) {
					pendingUiChange = "reinstall";
				}
			}
			const gitNeeded =
				newConfig.footerStyle === "hud"
					? newConfig.hud.git
					: newConfig.footerSegments.gitBranch || newConfig.footerSegments.gitStatus || newConfig.footerSegments.gitCommit;
			if (lastCtx && gitNeeded) {
				void scheduleGitRefresh(lastCtx);
			} else {
				state.git = emptyGitStatus();
			}
			requestFooterRender?.();
		},
		onOverlayClosed: () => {
			if (!lastCtx || pendingUiChange === undefined) return;
			const change = pendingUiChange;
			pendingUiChange = undefined;
			if (!config.enabled || change === "uninstall") {
				uninstallUi(lastCtx);
			} else {
				if (change === "reinstall") uninstallUi(lastCtx);
				applyUi(lastCtx);
			}
		},
	});
}
