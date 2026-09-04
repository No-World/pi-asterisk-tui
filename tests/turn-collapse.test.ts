import assert from "node:assert/strict";
import test from "node:test";
import {
	findThinkingHostViaSegments,
	makeInterceptedContainer,
	setAgentActive,
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

interface ContentBlock {
	type: string;
	text?: string;
	thinking?: string;
}

interface AssistantChild extends Child {
	hideThinkingBlock: boolean;
	setHideThinkingBlock(hide: boolean): void;
	isStreaming?: boolean;
	hiddenThinkingLabel?: string;
	setHiddenThinkingLabel?(label: string): void;
	lastMessage: { content: ContentBlock[] };
}

function makeAssistant(lines: string[], hideThinking: boolean, streaming = false): AssistantChild {
	const hasThinking = lines.some((line) => line.includes("✻"));
	const textBody = lines.filter((line) => !line.includes("✻")).join(" ").trim();
	const content: ContentBlock[] = [];
	if (hasThinking) content.push({ type: "thinking", thinking: "想了很多" });
	if (textBody) content.push({ type: "text", text: textBody });
	const assistant: AssistantChild = {
		hideThinkingBlock: hideThinking,
		setHideThinkingBlock(hide: boolean) {
			this.hideThinkingBlock = hide;
		},
		isStreaming: streaming,
		hiddenThinkingLabel: "✻ Thought…",
		lastMessage: { content },
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
	assert.ok(out.includes("Ran 2 shell commands"), `run line before plain text\n${out}`);
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
	assert.ok(out.includes("Listed 1 directory"), `first run\n${out}`);
	assert.ok(out.includes("Listed 2 directories"), `second run grouped\n${out}`);
	assert.ok(out.includes("中间"), `text between\n${out}`);
});

test("unknown tools keep the called phrasing", () => {
	setTurnCollapseEnabled(true);
	const container = makeContainer([makeUserMessage("go"), makeTool("playwright"), makeTool("playwright")]);
	const out = container.render(60).join("\n");
	assert.ok(out.includes("Called playwright ×2"), `unknown verb\n${out}`);
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
	assert.ok((history.hiddenThinkingLabel ?? "").includes("Thought…"), "history label");
	assert.ok((streaming.hiddenThinkingLabel ?? "").includes("Thinking…"), "streaming label");
	assert.ok((history.hiddenThinkingLabel ?? "").includes("\x1b[0m"), "label carries full styling");
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

test("tool-first run lines capitalize the leading verb", () => {
	setTurnCollapseEnabled(true);
	const container = makeContainer([makeUserMessage("go"), makeBash("echo hi"), makeTextMessage("done")]);
	const lines = container.render(60);
	const runLine = lines.find((l) => l.includes("Ran 1 shell command"));
	assert.ok(runLine, `capitalized leading verb\n${lines.join("\n")}`);
	assert.ok(!lines.join("\n").includes("✻ ran"), `no lowercase lead\n${lines.join("\n")}`);
});

test("expanded runs stay expanded across re-renders", () => {
	setTurnCollapseEnabled(true);
	setThinkingDurations([4_000]);
	const labelMsg = makeLabelMessage();
	const container = makeContainer([makeUserMessage("go"), labelMsg, makeBash("echo hi")]);
	const lines = container.render(60);
	const runIndex = lines.findIndex((l) => l.includes("Thought for 4s"));
	assert.ok(runIndex >= 0, "run line exists");
	handleToolLineClick(runIndex, lines[runIndex]!);

	// Re-render many times: the run must NOT collapse back on its own.
	for (let frame = 0; frame < 5; frame++) {
		const out = container.render(60).join("\n");
		assert.ok(out.includes("$ echo hi"), `frame ${frame}: tools stay expanded\n${out}`);
		assert.equal(labelMsg.hideThinkingBlock, false, `frame ${frame}: thinking stays expanded`);
	}
	setThinkingDurations(undefined);
});

test("expanding a run also opens text-tail thinking in one click", () => {
	setTurnCollapseEnabled(true);
	setThinkingDurations([2_500]);
	const tail = makeAssistant([" ✻ Thought…", "验证最终状态："], true);
	const container = makeContainer([makeUserMessage("go"), makeBash("echo hi"), tail]);
	const lines = container.render(60);
	const runIndex = lines.findIndex((l) => l.includes("Thought for 2s"));
	assert.ok(runIndex >= 0, `run line\n${lines.join("\n")}`);
	assert.equal(tail.hideThinkingBlock, true, "collapsed initially");

	handleToolLineClick(runIndex, lines[runIndex]!);
	container.render(60);
	assert.equal(tail.hideThinkingBlock, false, "one click opens text-tail thinking");
	const out = container.render(60).join("\n");
	assert.ok(out.includes("$ echo hi"), `tools open\n${out}`);
	assert.ok(out.includes("验证最终状态："), `text open\n${out}`);

	const lines2 = container.render(60);
	const boxIdx = lines2.findIndex((l) => l.includes("$ echo hi"));
	handleToolLineClick(boxIdx, lines2[boxIdx]!);
	container.render(60);
	assert.equal(tail.hideThinkingBlock, true, "collapse re-hides text-tail thinking");
	setThinkingDurations(undefined);
});

test("a running tool does not expand the completed run before it", () => {
	setTurnCollapseEnabled(true);
	const done = makeBash("echo done");
	const live = makeBash("echo live");
	(live as { status?: string }).status = "running";
	const container = makeContainer([makeUserMessage("go"), done, live]);
	const lines = container.render(60);
	const out = lines.join("\n");
	assert.ok(out.includes("Ran 1 shell command"), `completed tool stays folded\n${out}`);
	assert.ok(!out.includes("$ echo done"), `completed box hidden\n${out}`);
	assert.ok(out.includes("bash · $ echo live"), `live line present\n${out}`);
	assert.ok(out.includes("$ echo live"), `live box streams\n${out}`);
});

test("a streaming thinking message does not expand the completed run before it", () => {
	setTurnCollapseEnabled(true);
	const done = makeBash("echo done");
	const streamingLabel = makeAssistant([" ✻ Thinking…"], true, true);
	streamingLabel.lastMessage.content = [{ type: "thinking", thinking: "正在想" }];
	const container = makeContainer([makeUserMessage("go"), done, streamingLabel]);
	const out = container.render(60).join("\n");
	assert.ok(out.includes("Ran 1 shell command"), `completed tool stays folded\n${out}`);
	assert.ok(!out.includes("$ echo done"), `completed box hidden\n${out}`);
	assert.ok(out.includes("✻ Thinking…"), `streaming label visible\n${out}`);
});

test("retry errors are held back; only the last one renders at settle", () => {
	setTurnCollapseEnabled(true);
	const errorA = { render: () => ["Error: 429 first"] };
	const errorB = { render: () => ["Error: 429 second"] };
	const errorC = { render: () => ["Error: 429 third"] };
	const status = { render: () => ["some status"] };
	const container = makeInterceptedContainer();

	// agent run active: errors held, newest replaces older ones
	setAgentActive(true);
	container.addChild(errorA);
	container.addChild(status);
	container.addChild(errorB);
	container.addChild(errorC);
	let out = container.render(60).join("\n");
	assert.ok(!out.includes("429"), `no error output mid-run\n${out}`);
	assert.ok(out.includes("some status"), `non-error content unaffected\n${out}`);

	// settle: only the LAST error renders
	setAgentActive(false);
	out = container.render(60).join("\n");
	assert.ok(out.includes("Error: 429 third"), `last error at settle\n${out}`);
	assert.ok(!out.includes("429 first") && !out.includes("429 second"), `older errors dropped\n${out}`);
});

test("a successful assistant message drops held errors entirely", () => {
	setTurnCollapseEnabled(true);
	const errorA = { render: () => ["Error: 429 boom"] };
	const assistant = makeAssistant(["成功回复"], false);
	const container = makeInterceptedContainer();
	setAgentActive(true);
	container.addChild(errorA);
	container.addChild(assistant);
	setAgentActive(false);
	const out = container.render(60).join("\n");
	assert.ok(!out.includes("429"), `transient retry errors vanish on success\n${out}`);
	assert.ok(out.includes("成功回复"), `assistant renders\n${out}`);
});
