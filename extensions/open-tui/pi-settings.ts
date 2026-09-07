import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export type HideThinkingSync = "written" | "exists" | "error";

/** Path of pi's global settings.json (same agent dir as open-tui.json). */
export function piSettingsPath(agentDir: string = getAgentDir()): string {
	return join(agentDir, "settings.json");
}

/** Reads pi's native hideThinkingBlock setting; undefined when unset (pi default: false). */
export function readHideThinkingBlock(agentDir: string = getAgentDir()): boolean | undefined {
	try {
		const path = piSettingsPath(agentDir);
		if (!existsSync(path)) return undefined;
		const settings = JSON.parse(readFileSync(path, "utf8")) as { hideThinkingBlock?: unknown };
		return typeof settings.hideThinkingBlock === "boolean" ? settings.hideThinkingBlock : undefined;
	} catch {
		return undefined;
	}
}

/** Persists pi's native hideThinkingBlock (same file ctrl+t writes). */
export function writeHideThinkingBlock(hide: boolean, agentDir: string = getAgentDir()): HideThinkingSync {
	try {
		const path = piSettingsPath(agentDir);
		if (!existsSync(path)) {
			writeFileSync(path, `${JSON.stringify({ hideThinkingBlock: hide }, null, 2)}\n`);
			return "written";
		}
		const settings = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
		settings.hideThinkingBlock = hide;
		writeFileSync(path, `${JSON.stringify(settings, null, 2)}\n`);
		return "written";
	} catch {
		return "error";
	}
}

/**
 * One-time migration for fresh installs: when pi's global settings have no
 * `hideThinkingBlock` opinion yet, default it to true so the compact ✻ labels
 * (and click-to-expand in the fullscreen TUI) work out of the box. An existing
 * value — e.g. set through pi's ctrl+t toggle — is never overridden.
 */
export function ensureHideThinkingDefault(agentDir: string = getAgentDir()): HideThinkingSync {
	try {
		const path = piSettingsPath(agentDir);
		if (!existsSync(path)) {
			writeFileSync(path, `${JSON.stringify({ hideThinkingBlock: true }, null, 2)}\n`);
			return "written";
		}
		const settings = JSON.parse(readFileSync(path, "utf8")) as { hideThinkingBlock?: unknown };
		if (settings.hideThinkingBlock !== undefined) return "exists";
		settings.hideThinkingBlock = true;
		writeFileSync(path, `${JSON.stringify(settings, null, 2)}\n`);
		return "written";
	} catch {
		return "error";
	}
}
