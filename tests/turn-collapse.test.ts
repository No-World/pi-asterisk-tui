import assert from "node:assert/strict";
import test from "node:test";
import {
	findThinkingHostViaSegments,
	handleToolLineClick,
	renderCollapsedForTest,
	setThinkingDurations,
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
		render: (width: number) => ["", ...lines.map((line) => line.padEnd(width))],
	};
	assistant.setHiddenThinkingLabel = (label: string) => {
		assistant.hiddenThinkingLabel = label;
	};
	return assistant;
}

/** Label-only assistant message (run member). */
const makeLabelMessage = (): AssistantChild => makeAssistant([" ✻ Thought…"], true);

/** Text-bearing assistant message (ends a run). */
const makeTextMessage = (text: string): AssistantChild => makeAssistant([text], false);

function makeTool(toolName: string): Child & { toolName: string; toolCallId: string; result: object; isPartial: boolean } {
	return {
		toolName,
		toolCallId: `${toolName}-1`,
		result: { content: [] },
		isPartial: false,
		render: (width: number) => ["┌───", `│ ${toolName}`.padEnd(width), "└───"],
	};
}

function makeBash(command: string): Child & { command: string; appendOutput(): void; status?: string } {
	return {
		command,
		appendOutput() {},
		status: "done",
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

test("a label and its tools merge into one run line with verbs", () => {
	setTurnCollapseEnabled(true);
	setThinkingDurations([19_000]);
	const container = makeContainer([
		makeUserMessage("go"),
		makeLabelMessage(),
		makeTool("grep"),
		makeTool("ls"),
		makeBash("echo hi"),
		makeTextMessage("答案"),
	]);
	const lines = container.render(60);
	const out = lines.join("\n");
	const runLine = lines.find((l) => l.includes("Thought for 19s"));
	assert.ok(runLine, `run line missing\n${out}`);
	assert.ok(runLine.includes("searched for 1 pattern"), `grep verb\n${out}`);
	assert.ok(runLine.includes("listed 1 directory"), `ls verb\n${out}`);
	assert.ok(runLine.includes("ran 1 shell command"), `bash verb\n${out}`);
	assert.ok(!out.includes("$ echo hi"), `boxes hidden\n${out}`);
	assert.ok(out.includes("答案"), `text visible\n${out}`);
	setThinkingDurations(undefined);
});

test("a text message's leading label merges into the open run", () => {
	setTurnCollapseEnabled(true);
	setThinkingDurations([4_000]);
	const labeledText = makeAssistant([" ✻ Thought…", "完成 ✅ 结果"], true);
	const container = makeContainer([makeUserMessage("go"), makeBash("echo hi"), labeledText]);
	const lines = container.render(60);
	const out = lines.join("\n");
	const runLine = lines.find((l) => l.includes("Thought for 4s"));
	assert.ok(runLine, `run line carries the text message's thinking\n${out}`);
	assert.ok(runLine!.includes("ran 1 shell command"), `tools in the same line\n${out}`);
	assert.ok(out.includes("完成 ✅ 结果"), `text follows\n${out}`);
	const labelIdx = lines.findIndex((l) => l.includes("✻ Thought…"));
	assert.ok(labelIdx === -1 || labelIdx > lines.findIndex((l) => l === runLine), `label not duplicated\n${out}`);
	setThinkingDurations(undefined);
});

test("text closes the run: later tools start a fresh one", () => {
	setTurnCollapseEnabled(true);
	setThinkingDurations([0, 3_000, 5_000]);
	const msgA = makeTextMessage("先确认：");
	const msgB = makeAssistant([" ✻ Thought…", "完成 ✅ 结果A"], true);
	const msgC = makeAssistant([" ✻ Thought…", "以及 结果B"], true);
	const container = makeContainer([
		makeUserMessage("go"),
		msgA,
		makeBash("echo one"),
		makeBash("echo two"),
		msgB,
		makeBash("echo three"),
		msgC,
	]);
	const lines = container.render(60);
	const out = lines.join("\n");
	assert.ok(out.includes("先确认："), `msgA text\n${out}`);
	const firstRun = lines.find((l) => l.includes("Thought for 3s"));
	assert.ok(firstRun, `msgB's label joins the first run\n${out}`);
	assert.ok(firstRun!.includes("ran 2 shell commands"), `first run holds the adjacent tools\n${out}`);
	assert.ok(out.includes("完成 ✅ 结果A"), `msgB text follows\n${out}`);
	const secondRun = lines.find((l) => l.includes("Thought for 5s"));
	assert.ok(secondRun, `msgC's label starts its own run\n${out}`);
	assert.ok(secondRun!.includes("ran 1 shell command"), `second run holds only its own tool\n${out}`);
	assert.ok(!out.includes("ran 3 shell"), `no cross-text merging\n${out}`);
});

test("label-only runs without durations show a bare Thought line", () => {
	setTurnCollapseEnabled(true);
	setThinkingDurations(undefined);
	const container = makeContainer([makeUserMessage("go"), makeLabelMessage(), makeTextMessage("回答")]);
	const lines = container.render(60);
	const out = lines.join("\n");
	const runLine = lines.find((l) => l.includes("✻ Thought") && !l.includes("…"));
	assert.ok(runLine, `bare Thought run line\n${out}`);
	assert.ok(!out.includes("worked"), `no garbage summary line\n${out}`);
	assert.ok(out.includes("回答"), `text renders\n${out}`);
});

test("expanding a run opens thinking and tools together", () => {
	setTurnCollapseEnabled(true);
	setThinkingDurations([4_000]);
	const labelMsg = makeLabelMessage();
	const container = makeContainer([makeUserMessage("go"), labelMsg, makeBash("echo hi")]);
	const lines = container.render(60);
	const runIndex = lines.findIndex((l) => l.includes("Thought for 4s"));
	assert.ok(runIndex >= 0, "run line exists");
	assert.equal(labelMsg.hideThinkingBlock, true, "collapsed: thinking hidden");

	assert.equal(handleToolLineClick(runIndex, lines[runIndex]!), true);
	container.render(60);
	assert.equal(labelMsg.hideThinkingBlock, false, "expanded: thinking shown");
	const out = container.render(60).join("\n");
	assert.ok(out.includes("$ echo hi"), `tools shown\n${out}`);

	// collapse again: thinking re-hides
	const lines2 = container.render(60);
	const boxIdx = lines2.findIndex((l) => l.includes("$ echo hi"));
	assert.equal(handleToolLineClick(boxIdx, lines2[boxIdx]!), true);
	container.render(60);
	assert.equal(labelMsg.hideThinkingBlock, true, "re-collapsed: thinking hidden");
	assert.ok(container.render(60).join("\n").includes("Thought for 4s"), "run line back");
	setThinkingDurations(undefined);
});

test("text message without a label flushes the run before rendering", () => {
	setTurnCollapseEnabled(true);
	setThinkingDurations(undefined);
	const plain = makeTextMessage("完成 ✅ 无思考直接回答");
	const container = makeContainer([makeUserMessage("go"), makeTextMessage("先确认："), makeBash("echo one"), makeBash("echo two"), plain]);
	const lines = container.render(60);
	for (const l of lines) {
		if (l.trim()) console.log("LINE:", JSON.stringify(l.slice(0, 60)));
	}
	const out = lines.join("\n");
	assert.ok(out.includes("ran 2 shell commands"), `run line before plain text\n${out}`);
	assert.ok(out.includes("完成 ✅ 无思考直接回答"), `plain text renders\n${out}`);
});

test("text breaks runs; separate runs get separate lines", () => {
	setTurnCollapseEnabled(true);
	setThinkingDurations(undefined);
	const container = makeContainer([
		makeUserMessage("go"),
		makeTool("ls"),
		makeTextMessage("中间"),
		makeTool("ls"),
		makeTool("ls"),
	]);
	const out = container.render(60).join("\n");
	assert.ok(out.includes("listed 1 directory"), `first run\n${out}`);
	assert.ok(out.includes("listed 2 directories"), `second run grouped\n${out}`);
	assert.ok(out.includes("中间"), `text between\n${out}`);
});

test("unknown tools keep the called phrasing", () => {
	setTurnCollapseEnabled(true);
	const container = makeContainer([makeUserMessage("go"), makeTool("playwright"), makeTool("playwright")]);
	const out = container.render(60).join("\n");
	assert.ok(out.includes("called playwright ×2"), `unknown verb\n${out}`);
});

test("clicking a collapsed run line expands it; clicking a member collapses it", () => {
	setTurnCollapseEnabled(true);
	setThinkingDurations([5_000]);
	const tool = makeTool("ls");
	const container = makeContainer([makeUserMessage("go"), makeLabelMessage(), tool]);
	const lines = container.render(60);
	const runIndex = lines.findIndex((l) => l.includes("Thought for 5s"));
	assert.ok(runIndex >= 0, "run line exists");
	assert.equal(handleToolLineClick(runIndex, lines[runIndex]!), true);

	const expandedLines = container.render(60);
	const expanded = expandedLines.join("\n");
	assert.ok(expanded.includes("│ ls"), `tool box expanded\n${expanded}`);
	const boxIndex = expandedLines.findIndex((l) => l.includes("│ ls"));
	assert.ok(boxIndex >= 0);
	assert.equal(handleToolLineClick(boxIndex, expandedLines[boxIndex]!), true);
	assert.ok(!container.render(60).join("\n").includes("│ ls"), "run re-collapsed");
	setThinkingDurations(undefined);
});

test("running tools stay live and never merge into a collapsed run line", () => {
	setTurnCollapseEnabled(true);
	const live = makeBash("echo hi");
	(live as { status?: string }).status = "running";
	const container = makeContainer([makeUserMessage("go"), makeLabelMessage(), live]);
	const lines = container.render(60);
	const out = lines.join("\n");
	assert.ok(lines.some((l) => l.includes("bash · $ echo hi")), `live line present\n${out}`);
	assert.ok(out.includes("$ echo hi"), `live box streams\n${out}`);
	assert.ok(!out.includes("Thought for"), `live run not collapsed\n${out}`);
});

test("per-message labels: history says Thought, streaming says Thinking", () => {
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

test("label-only messages without durations still merge (tool phrases only)", () => {
	setTurnCollapseEnabled(true);
	setThinkingDurations(undefined);
	const container = makeContainer([makeUserMessage("go"), makeLabelMessage(), makeBash("echo hi")]);
	const out = container.render(60).join("\n");
	assert.ok(out.includes("ran 1 shell command"), `tool phrase\n${out}`);
	assert.ok(!out.includes("Thought for"), `no duration → no phrase\n${out}`);
});

test("disabled feature renders full boxes untouched", () => {
	setTurnCollapseEnabled(false);
	try {
		const container = makeContainer([makeUserMessage("off"), makeTool("playwright")]);
		const out = container.render(60).join("\n");
		assert.ok(!out.includes("✻ Ran"), `no run lines when disabled\n${out}`);
		assert.ok(out.includes("│ playwright"), `full box passthrough\n${out}`);
	} finally {
		setTurnCollapseEnabled(true);
	}
});
