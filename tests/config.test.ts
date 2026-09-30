import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DEFAULT_CONFIG, DEFAULT_TURN_COLLAPSE, DEFAULT_HUD_CONFIG, effectiveThoughtTreatment, loadConfig, normalizeHudConfig, normalizeTurnCollapse } from "../extensions/asterisk-tui/config.ts";

test("loadConfig adopts settings from a legacy open-tui.json on first run", () => {
	const agentDir = mkdtempSync(join(tmpdir(), "asterisk-tui-config-"));
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	try {
		process.env.PI_CODING_AGENT_DIR = agentDir;
		writeFileSync(
			join(agentDir, "open-tui.json"),
			JSON.stringify({ footerStyle: "classic", settingsLanguage: "zh" }),
			"utf8",
		);
		const config = loadConfig();
		assert.equal(config.footerStyle, "classic");
		assert.equal(config.settingsLanguage, "zh");
		// Contents were adopted into the new location; the legacy file is kept.
		const adopted = join(agentDir, "asterisk-tui.json");
		assert.equal(JSON.parse(readFileSync(adopted, "utf8")).settingsLanguage, "zh");
		assert.ok(existsSync(join(agentDir, "open-tui.json")));
		// Once the new file exists it wins over the legacy one.
		writeFileSync(adopted, JSON.stringify({ settingsLanguage: "en" }), "utf8");
		assert.equal(loadConfig().settingsLanguage, "en");
	} finally {
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		rmSync(agentDir, { recursive: true, force: true });
	}
});

test("legacy boolean turnCollapse migrates to the mode contract", () => {
	assert.deepEqual(normalizeTurnCollapse(true), { ...DEFAULT_TURN_COLLAPSE, mode: "group-all" });
	assert.deepEqual(normalizeTurnCollapse(false), { ...DEFAULT_TURN_COLLAPSE, mode: "native" });
});

test("normalizeTurnCollapse fills defaults and drops invalid values", () => {
	const normalized = normalizeTurnCollapse({
		mode: "bogus",
		style: "classic",
		retryErrors: false,
		liveThinking: "yes",
		liveTools: false,
		expandAllKey: 42,
		tools: { bash: "single", read: "nope", "*": "expand" },
		seenTools: ["mcp_search", "mcp_search", 42],
	});
	assert.deepEqual(normalized, {
		mode: "group-all",
		style: "classic",
		retryErrors: false,
		thought: "default",
		liveThinking: true,
		liveTools: false,
		expandAllKey: "ctrl+\\",
		tools: { bash: "single", "*": "expand" },
		seenTools: ["mcp_search"],
	});
});

test("normalizeTurnCollapse keeps custom and disabled expand-all keys", () => {
	assert.equal(normalizeTurnCollapse({ expandAllKey: "alt+o" }).expandAllKey, "alt+o");
	assert.equal(normalizeTurnCollapse({ expandAllKey: "" }).expandAllKey, "");
	assert.equal(normalizeTurnCollapse({ expandAllKey: "  ctrl+\\  " }).expandAllKey, "ctrl+\\");
});

test("effectiveThoughtTreatment resolves default per mode and keeps overrides absolute", () => {
	assert.equal(effectiveThoughtTreatment("native", "default"), "expand");
	assert.equal(effectiveThoughtTreatment("single", "default"), "single");
	assert.equal(effectiveThoughtTreatment("group-same", "default"), "group-same");
	assert.equal(effectiveThoughtTreatment("group-all", "default"), "run");
	// Overrides are absolute: no native-mode degradation.
	assert.equal(effectiveThoughtTreatment("native", "group-same"), "group-same");
	assert.equal(effectiveThoughtTreatment("group-all", "group-same"), "group-same");
	assert.equal(effectiveThoughtTreatment("native", "expand"), "expand");
});

test("hud.statStyle rejects invalid values and defaults to icon+text", () => {
	const invalid = normalizeHudConfig({ ...structuredClone(DEFAULT_HUD_CONFIG), statStyle: "bogus" as "icon" });
	assert.equal(invalid.statStyle, "icon+text");
	const kept = normalizeHudConfig({ ...structuredClone(DEFAULT_HUD_CONFIG), statStyle: "icon" });
	assert.equal(kept.statStyle, "icon");
	const legacy = normalizeHudConfig({ ...structuredClone(DEFAULT_HUD_CONFIG), statStyle: undefined as unknown as "icon" });
	assert.equal(legacy.statStyle, "icon+text");
});

test("hud.tokens tri-state migrates legacy booleans and rejects invalid values", () => {
	const legacyTrue = normalizeHudConfig({ ...structuredClone(DEFAULT_HUD_CONFIG), tokens: true as unknown as "verbose" });
	assert.equal(legacyTrue.tokens, "verbose");
	const legacyFalse = normalizeHudConfig({ ...structuredClone(DEFAULT_HUD_CONFIG), tokens: false as unknown as "off" });
	assert.equal(legacyFalse.tokens, "off");
	const invalid = normalizeHudConfig({ ...structuredClone(DEFAULT_HUD_CONFIG), tokens: "bogus" as "verbose" });
	assert.equal(invalid.tokens, "verbose");
	const kept = normalizeHudConfig({ ...structuredClone(DEFAULT_HUD_CONFIG), tokens: "compact" });
	assert.equal(kept.tokens, "compact");
});

test("loadConfig migrates a stored legacy hud.tokens boolean and keeps the hud preset", () => {
	const agentDir = mkdtempSync(join(tmpdir(), "asterisk-tui-config-"));
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	try {
		process.env.PI_CODING_AGENT_DIR = agentDir;
		writeFileSync(
			join(agentDir, "asterisk-tui.json"),
			JSON.stringify({ hud: { tokens: false } }),
			"utf8",
		);
		const config = loadConfig();
		assert.equal(config.hud.tokens, "off");
		// off ≠ the HUD preset default, so the derived preset downgrades to custom
		assert.equal(config.stylePreset, "custom");
		writeFileSync(
			join(agentDir, "asterisk-tui.json"),
			JSON.stringify({ hud: { tokens: true } }),
			"utf8",
		);
		const configOn = loadConfig();
		assert.equal(configOn.hud.tokens, "verbose");
		assert.equal(configOn.stylePreset, "hud");
	} finally {
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		rmSync(agentDir, { recursive: true, force: true });
	}
});

test("loadConfig migrates a stored legacy boolean via deepMerge", () => {
	const agentDir = mkdtempSync(join(tmpdir(), "asterisk-tui-config-"));
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	try {
		process.env.PI_CODING_AGENT_DIR = agentDir;
		writeFileSync(join(agentDir, "asterisk-tui.json"), JSON.stringify({ turnCollapse: false }), "utf8");
		const config = loadConfig();
		assert.equal(config.turnCollapse.mode, "native");
		assert.equal(config.turnCollapse.style, "compact");
		assert.equal(config.turnCollapse.retryErrors, true);
	} finally {
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		rmSync(agentDir, { recursive: true, force: true });
	}
});

test("borderWorkingStatus migrates into workingStatus and drops the stale key", () => {
	const agentDir = mkdtempSync(join(tmpdir(), "asterisk-tui-config-"));
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	try {
		process.env.PI_CODING_AGENT_DIR = agentDir;
		const write = (obj: unknown) =>
			writeFileSync(join(agentDir, "asterisk-tui.json"), JSON.stringify(obj), "utf8");

		write({ borderWorkingStatus: false });
		let config = loadConfig();
		assert.equal(config.workingStatus, "line");
		assert.equal("borderWorkingStatus" in config, false, "stale key removed");

		write({ borderWorkingStatus: true });
		config = loadConfig();
		assert.equal(config.workingStatus, "both");

		write({ workingStatus: "border" });
		config = loadConfig();
		assert.equal(config.workingStatus, "border");

		write({ workingStatus: "bogus" });
		config = loadConfig();
		assert.equal(config.workingStatus, "both");

		// content configs deep-merge: partial toggles keep the other defaults
		write({ workingLine: { tools: false } });
		config = loadConfig();
		assert.equal(config.workingLine.tools, false);
		assert.equal(config.workingLine.speed, true);
		assert.deepEqual(config.workingBorder, DEFAULT_CONFIG.workingBorder);
	} finally {
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		rmSync(agentDir, { recursive: true, force: true });
	}
});
