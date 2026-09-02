import assert from "node:assert/strict";
import test from "node:test";
import {
	attachLiveSummary,
	findThinkingHostViaSegments,
	handleToolLineClick,
	handleTurnLineClick,
	renderCollapsedForTest,
	setAgentWorking,
	setTurnCollapseEnabled,
} from "../extensions/open-tui/turn-collapse.ts";

interface Child {
	render: (width: number) => string[];
	children?: unknown[];
}

function makeUserMessage(text: string): Child & { text: string; rebuild(): void } {
	return {
		text,
		rebuild() {},
		render: (width: number) => [text.padEnd(width)],
	};
}

interface AssistantChild extends Child {
	hideThinkingBlock: boolean;
	setHideThinkingBlock(hide: boolean): void;
	isStreaming?: boolean;
	hiddenThinkingLabel?: string;
	setHiddenThinkingLabel?(label: string): void;
}

function makeAssistant(lines: string[], hideThinking: boolean, streaming = false): AssistantChild {
	const assistant: AssistantChild = {
		hideThinkingBlock: hideThinking,
		setHideThinkingBlock(hide: boolean) {
			this.hideThinkingBlock = hide;
		},
		isStreaming: streaming,
		hiddenThinkingLabel: "✻ Thought…",
		children: [],
		render: (width: number) => lines.map((line) => line.padEnd(width)),
	};
	assistant.setHiddenThinkingLabel = (label: string) => {
		assistant.hiddenThinkingLabel = label;
	};
	return assistant;
}

function makeTool(toolName: string): Child & { toolName: string; toolCallId: string } {
	return {
		toolName,
		toolCallId: `${toolName}-1`,
		render: (width: number) => ["┌───", `│ ${toolName}`.padEnd(width), "└───"],
	};
}

function makeBash(command: string): Child & { command: string; appendOutput(): void } {
	return {
		command,
		appendOutput() {},
		render: () => ["$ " + command, "output"],
	};
}

const makeSpacer = (): Child => {
	const spacer = { render: (_width: number) => [""] };
	Object.defineProperty(spacer, "constructor", { value: { name: "Spacer" } });
	return spacer as Child;
};

function makeContainer(children: unknown[]): {
	children: unknown[];
	render: (width: number) => string[];
} {
	return {
		children,
		render(width: number) {
			return renderCollapsedForTest(this, width);
		},
	};
}

test("idle turns collapse: tools and spacers hidden, assistant text kept", () => {
	setAgentWorking(false);
	setTurnCollapseEnabled(true);
	const assistant = makeAssistant([" ✻ Thought…", "answer text"], true);
	const container = makeContainer([
		makeUserMessage("do things"),
		assistant,
		makeTool("playwright"),
		makeTool("playwright"),
		makeBash("ls -la"),
		makeSpacer(),
	]);

	const lines = container.render(60);
	const text = lines.join("\n");

	assert.ok(text.includes("▸"), `summary marker missing\n${text}`);
	assert.ok(text.includes("playwright ×2"), `tool summary missing\n${text}`);
	assert.ok(text.includes("ran 1 shell command"), `bash summary missing\n${text}`);
	assert.ok(text.includes("answer text"), `assistant text must stay visible\n${text}`);
	assert.ok(!text.includes("│ playwright"), `tool boxes must be hidden\n${text}`);
	assert.ok(!text.includes("$ ls -la"), `bash box must be hidden\n${text}`);
	// thinking was already hidden; collapsed render keeps it that way
	assert.equal(assistant.hideThinkingBlock, true);
});

test("working turn streams normally", () => {
	setAgentWorking(true);
	const container = makeContainer([
		makeUserMessage("streaming"),
		makeAssistant(["answer"], true),
		makeTool("playwright"),
	]);
	const text = container.render(60).join("\n");
	assert.ok(!text.includes("▸"), `no summary while working\n${text}`);
	assert.ok(text.includes("│ playwright"), `tool box stays visible while working\n${text}`);
	setAgentWorking(false);
});

test("clicking the summary line toggles the turn", () => {
	setAgentWorking(false);
	const container = makeContainer([
		makeUserMessage("toggle me"),
		makeTool("playwright"),
	]);
	const lines = container.render(60);
	const summaryIndex = lines.findIndex((line) => line.includes("▸"));
	assert.ok(summaryIndex >= 0, "summary line exists");

	// Click the summary line → expand: plain meta line (no ▸), group line visible.
	assert.equal(handleTurnLineClick(summaryIndex, lines[summaryIndex]!), true);
	const expandedLines = container.render(60);
	const expanded = expandedLines.join("\n");
	assert.ok(!expanded.includes("▸"), `collapsed marker gone after expand\n${expanded}`);
	assert.ok(expanded.includes("✻ called playwright"), `plain meta line stays\n${expanded}`);
	assert.ok(expanded.includes("⏺"), `group line visible\n${expanded}`);

	// Click the meta line → re-collapse.
	const metaIndex = expandedLines.findIndex((line) => line.includes("✻ called playwright"));
	assert.ok(metaIndex >= 0, "meta line exists");
	assert.equal(handleTurnLineClick(metaIndex, expandedLines[metaIndex]!), true);
	assert.ok(container.render(60).join("\n").includes("▸"), "re-collapsed");

	// Plain content lines never toggle.
	assert.equal(handleTurnLineClick(0, "│ playwright"), false);
});

test("consecutive tools collapse into group lines, non-adjacent stay separate", () => {
	setAgentWorking(false);
	setTurnCollapseEnabled(true);
	const bashA = makeBash("echo one");
	const bashB = makeBash("echo two");
	const tool = makeTool("playwright");
	const text = { render: (w: number) => ["assistant text".padEnd(w)] };
	const container = makeContainer([makeUserMessage("go"), bashA, makeSpacer(), bashB, text, tool]);

	// Expand the turn first.
	const collapsedLines = container.render(60);
	const summary = collapsedLines.find((l) => l.includes("▸"));
	assert.ok(summary, "summary line exists");
	handleTurnLineClick(collapsedLines.indexOf(summary), summary);

	const expandedLines = container.render(60);
	const expanded = expandedLines.join("\n");
	assert.ok(expanded.includes("ran 2 shell commands"), `adjacent bash grouped\n${expanded}`);
	assert.ok(expanded.includes("called playwright"), `separate tool line\n${expanded}`);
	assert.ok(!expanded.includes("echo one"), `boxes hidden behind group lines\n${expanded}`);

	// Click the group line → both bash boxes open.
	const groupLine = expandedLines.find((l) => l.includes("⏺") && l.includes("ran 2 shell commands"));
	assert.ok(groupLine);
	handleToolLineClick(expandedLines.indexOf(groupLine), groupLine);
	const opened = container.render(60).join("\n");
	assert.ok(opened.includes("$ echo one") && opened.includes("$ echo two"), `both boxes open\n${opened}`);
	assert.ok(opened.includes("called playwright"), `other group untouched\n${opened}`);

	// Click again → re-collapsed.
	const lines2 = container.render(60);
	const group2 = lines2.find((l) => l.includes("⏺") && l.includes("ran 2 shell commands"));
	handleToolLineClick(lines2.indexOf(group2!), group2!);
	assert.ok(!container.render(60).join("\n").includes("$ echo one"), "group re-collapsed");
});

test("working turns stream tool boxes at full size", () => {
	setAgentWorking(true);
	setAgentWorking(true);
	const live = makeBash("echo hi");
	(live as { status?: string }).status = "running";
	const container = makeContainer([makeUserMessage("live"), live]);
	const lines = container.render(60);
	const text = lines.join("\n");
	assert.ok(lines.some((l) => l.includes("bash · $ echo hi")), `running one-liner present\n${text}`);
	assert.ok(text.includes("$ echo hi"), `live box streams at full size\n${text}`);
	setAgentWorking(false);
});
