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

	// Click on the summary line → expand.
	assert.equal(handleTurnLineClick(summaryIndex, lines[summaryIndex]!), true);
	const expandedLines = container.render(60);
	const expanded = expandedLines.join("\n");
	assert.ok(!expanded.includes("▸"), `collapsed marker gone after expand\n${expanded}`);
	assert.ok(expanded.includes("▾"), `expanded handle line missing\n${expanded}`);
	assert.ok(expanded.includes("⏺ playwright"), `tool one-liner after expand\n${expanded}`);

	assert.ok(expanded.includes("⏺ playwright"), `tool one-liner after expand\n${expanded}`);

	// Click on the ▾ handle → re-collapse.
	const handleIndex = expandedLines.findIndex((line) => line.includes("▾"));
	assert.ok(handleIndex >= 0, "handle line exists");
	assert.equal(handleTurnLineClick(handleIndex, expandedLines[handleIndex]!), true);
	const collapsedAgain = container.render(60);
	assert.ok(collapsedAgain.join("\n").includes("▸"), "re-collapsed");

	// Plain content lines never toggle.
	assert.equal(handleTurnLineClick(0, "│ playwright"), false);
});

test("live thinking duration lands on the summary line", () => {
	setAgentWorking(false);
	const userMessage = makeUserMessage("with thinking");
	const container = makeContainer([userMessage, makeTool("read")]);
	container.render(60); // records currentTurnKey
	attachLiveSummary({ thinkingMs: 11_000 });
	const text = container.render(60).join("\n");
	assert.ok(text.includes("Thought for 11s"), `duration missing\n${text}`);
	assert.ok(text.includes("called read"), `tool part missing\n${text}`);
});

test("disabled feature passes through untouched", () => {
	setAgentWorking(false);
	setTurnCollapseEnabled(false);
	try {
		const container = makeContainer([makeUserMessage("off"), makeTool("playwright")]);
		const text = container.render(60).join("\n");
		assert.ok(!text.includes("▸"), `no summary when disabled\n${text}`);
		assert.ok(text.includes("│ playwright"), `passthrough render\n${text}`);
	} finally {
		setTurnCollapseEnabled(true);
	}
});

test("per-message labels: history says Thought, streaming says Thinking", () => {
	setAgentWorking(false);
	setTurnCollapseEnabled(true);
	const history = makeAssistant([" ✻ Thought…", "old answer"], true);
	const streaming = makeAssistant([" ✻ Thinking…", "streaming…"], true, true);
	const container = makeContainer([
		makeUserMessage("first"),
		history,
		makeUserMessage("second"),
		streaming,
	]);
	container.render(60);
	assert.equal(history.hiddenThinkingLabel, "✻ Thought…");
	assert.equal(streaming.hiddenThinkingLabel, "✻ Thinking…");
});

test("findThinkingHostViaSegments maps lines recorded during render", () => {
	setAgentWorking(true); // expanded path — segments recorded for children
	const assistant = makeAssistant([" ✻ Thinking…", "streaming"], true, true);
	const container = makeContainer([makeUserMessage("q"), assistant]);
	const lines = container.render(60);
	const labelIndex = lines.findIndex((line) => line.includes("✻ Thinking"));
	assert.ok(labelIndex >= 0, "label rendered");
	const found = findThinkingHostViaSegments(labelIndex) as AssistantChild | undefined;
	assert.equal(found, assistant);
	assert.equal(findThinkingHostViaSegments(-1), undefined);
});

test("expanded turns render tools as one-liners until clicked", () => {
	setAgentWorking(false);
	setTurnCollapseEnabled(true);
	const tool = makeTool("playwright");
	const bash = makeBash("echo hi");
	const container = makeContainer([makeUserMessage("go"), tool, bash]);

	// Collapsed by default: no tool content at all.
	const collapsed = container.render(60).join("\n");
	assert.ok(!collapsed.includes("⏺"), `no one-liners while turn collapsed\n${collapsed}`);

	// Expand the turn: tools appear as one-liners, not boxes.
	handleTurnLineClick(collapsed.split("\n").findIndex((l) => l.includes("▸")), collapsed.split("\n").find((l) => l.includes("▸")) ?? "");
	const expandedLines = container.render(60);
	const expanded = expandedLines.join("\n");
	assert.ok(expanded.includes("⏺ playwright"), `tool one-liner missing\n${expanded}`);
	assert.ok(expanded.includes("bash · $ echo hi"), `bash one-liner missing\n${expanded}`);
	assert.ok(!expanded.includes("│ playwright"), `box border must be hidden\n${expanded}`);

	// Click the bash one-liner → full box for that tool only.
	const bashLine = expandedLines.findIndex((l) => l.includes("bash · $"));
	assert.ok(bashLine >= 0);
	assert.equal(handleToolLineClick(bashLine, expandedLines[bashLine]!), true);
	const after = container.render(60).join("\n");
	assert.ok(after.includes("$ echo hi"), `bash box expanded\n${after}`);
	assert.ok(after.includes("⏺ playwright"), `other tool stays one-line\n${after}`);

	// Click again → back to one-liner (box-only output line disappears).
	const lines2 = container.render(60);
	const bashLine2 = lines2.findIndex((l) => l.includes("bash · $"));
	handleToolLineClick(bashLine2, lines2[bashLine2]!);
	const recollapsed = container.render(60).join("\n");
	assert.ok(!recollapsed.includes("\noutput"), "bash box re-collapsed");
	assert.ok(recollapsed.includes("bash · $ echo hi"), "one-liner back");
});

test("working turns stream tool boxes at full size", () => {
	setAgentWorking(true);
	const container = makeContainer([makeUserMessage("live"), makeBash("echo hi")]);
	const text = container.render(60).join("\n");
	assert.ok(!text.includes("⏺"), `no one-liners while working\n${text}`);
	assert.ok(text.includes("$ echo hi"), `live box stays full\n${text}`);
	setAgentWorking(false);
});
