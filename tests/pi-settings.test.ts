import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ensureHideThinkingDefault, piSettingsPath } from "../extensions/open-tui/pi-settings.ts";

function withAgentDir(fn: (dir: string) => void): void {
	const dir = mkdtempSync(join(tmpdir(), "open-tui-pi-settings-"));
	try {
		fn(dir);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

test("ensureHideThinkingDefault creates settings with the key when the file is missing", () => {
	withAgentDir((dir) => {
		assert.equal(ensureHideThinkingDefault(dir), "written");
		const settings = JSON.parse(readFileSync(piSettingsPath(dir), "utf8")) as Record<string, unknown>;
		assert.equal(settings.hideThinkingBlock, true);
	});
});

test("ensureHideThinkingDefault adds the key and preserves existing settings", () => {
	withAgentDir((dir) => {
		writeFileSync(piSettingsPath(dir), JSON.stringify({ theme: "dark", tuiMode: "fullscreen" }, null, 2));
		assert.equal(ensureHideThinkingDefault(dir), "written");
		const settings = JSON.parse(readFileSync(piSettingsPath(dir), "utf8")) as Record<string, unknown>;
		assert.equal(settings.theme, "dark");
		assert.equal(settings.tuiMode, "fullscreen");
		assert.equal(settings.hideThinkingBlock, true);
	});
});

test("ensureHideThinkingDefault never overrides an existing choice", () => {
	withAgentDir((dir) => {
		writeFileSync(piSettingsPath(dir), JSON.stringify({ hideThinkingBlock: false }, null, 2));
		assert.equal(ensureHideThinkingDefault(dir), "exists");
		const settings = JSON.parse(readFileSync(piSettingsPath(dir), "utf8")) as Record<string, unknown>;
		assert.equal(settings.hideThinkingBlock, false);
	});
});

test("ensureHideThinkingDefault reports errors without throwing", () => {
	withAgentDir((dir) => {
		// A directory at the settings path makes readFileSync throw.
		rmSync(piSettingsPath(dir), { force: true });
		writeFileSync(join(dir, "settings.json.tmp"), "");
		rmSync(join(dir, "settings.json.tmp"));
		// Simulate unreadable content instead: invalid JSON.
		writeFileSync(piSettingsPath(dir), "{ not json");
		assert.equal(ensureHideThinkingDefault(dir), "error");
	});
});
