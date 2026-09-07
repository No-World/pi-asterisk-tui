import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DEFAULT_TURN_COLLAPSE, loadConfig, normalizeTurnCollapse } from "../extensions/open-tui/config.ts";

test("legacy boolean turnCollapse migrates to the mode contract", () => {
	assert.deepEqual(normalizeTurnCollapse(true), { ...DEFAULT_TURN_COLLAPSE, mode: "group-all" });
	assert.deepEqual(normalizeTurnCollapse(false), { ...DEFAULT_TURN_COLLAPSE, mode: "native" });
});

test("normalizeTurnCollapse fills defaults and drops invalid values", () => {
	const normalized = normalizeTurnCollapse({
		mode: "bogus",
		style: "classic",
		retryErrors: false,
		tools: { bash: "single", read: "nope", "*": "expand" },
		seenTools: ["mcp_search", "mcp_search", 42],
	});
	assert.deepEqual(normalized, {
		mode: "group-all",
		style: "classic",
		retryErrors: false,
		tools: { bash: "single", "*": "expand" },
		seenTools: ["mcp_search"],
	});
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
