import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DEFAULT_TURN_COLLAPSE, DEFAULT_HUD_CONFIG, effectiveThoughtTreatment, loadConfig, normalizeHudConfig, normalizeTurnCollapse } from "../extensions/open-tui/config.ts";

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
	const agentDir = mkdtempSync(join(tmpdir(), "open-tui-config-"));
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	try {
		process.env.PI_CODING_AGENT_DIR = agentDir;
		writeFileSync(
			join(agentDir, "open-tui.json"),
			JSON.stringify({ hud: { tokens: false } }),
			"utf8",
		);
		const config = loadConfig();
		assert.equal(config.hud.tokens, "off");
		// off ≠ the HUD preset default, so the derived preset downgrades to custom
		assert.equal(config.stylePreset, "custom");
		writeFileSync(
			join(agentDir, "open-tui.json"),
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
	const agentDir = mkdtempSync(join(tmpdir(), "open-tui-config-"));
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	try {
		process.env.PI_CODING_AGENT_DIR = agentDir;
		writeFileSync(join(agentDir, "open-tui.json"), JSON.stringify({ turnCollapse: false }), "utf8");
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
