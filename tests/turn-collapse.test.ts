import assert from "node:assert/strict";
import test from "node:test";
import {
	findThinkingHostViaSegments,
	handleToolLineClick,
	renderCollapsedForTest,
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
		render: (width: number) => ["", ...lines.flatMap((line) => (line.includes("✻") ? [line.padEnd(width), ""] : [line.padEnd(width)]))],
	};
	assistant.setHiddenThinkingLabel = (label: string) => {
		assistant.hiddenThinkingLabel = label;
	};
	return assistant;
}

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

test("consecutive tools collapse into group lines, non-adjacent stay separate", () => {
	setTurnCollapseEnabled(true);
	const bashA = makeBash("echo one");
	const bashB = makeBash("echo two");
	const tool = makeTool("playwright");
	const text = { render: (w: number) => ["assistant text".padEnd(w)] };
	const container = makeContainer([makeUserMessage("go"), bashA, makeSpacer(), bashB, text, tool]);

	const lines = container.render(60);
	const out = lines.join("\n");
	assert.ok(out.includes("✻ Ran 2 shell commands"), `adjacent bash grouped\n${out}`);
	assert.ok(out.includes("✻ Called playwright"), `separate tool line\n${out}`);
	assert.ok(out.includes("assistant text"), `text visible\n${out}`);
	assert.ok(!out.includes("$ echo one"), `boxes hidden behind group lines\n${out}`);
	assert.ok(!out.includes("▸"), `no turn summary line\n${out}`);

	// Click the group line → boxes open, group line REPLACED (thinking-block parity).
	const groupLine = lines.find((l) => l.includes("Ran 2 shell commands"));
	assert.ok(groupLine);
	assert.equal(handleToolLineClick(lines.indexOf(groupLine), groupLine), true);
	const openedLines = container.render(60);
	const opened = openedLines.join("\n");
	assert.ok(opened.includes("$ echo one") && opened.includes("$ echo two"), `both boxes open\n${opened}`);
	assert.ok(!opened.includes("Ran 2 shell commands"), `group line replaced by boxes\n${opened}`);
	assert.ok(opened.includes("Called playwright"), `other group untouched\n${opened}`);

	// Click a box line → collapse back to the single line.
	const boxLine = openedLines.findIndex((l) => l.includes("$ echo one"));
	assert.ok(boxLine >= 0);
	assert.equal(handleToolLineClick(boxLine, openedLines[boxLine]!), true);
	const recollapsed = container.render(60).join("\n");
	assert.ok(recollapsed.includes("Ran 2 shell commands"), "group line back");
	assert.ok(!recollapsed.includes("$ echo one"), "boxes hidden again");
});

test("tools separated only by empty renders still group together", () => {
	setTurnCollapseEnabled(true);
	const bashA = makeBash("echo one");
	const bashB = makeBash("echo two");
	const emptyAssistant = makeAssistant([], false); // renders 0 lines
	const container = makeContainer([makeUserMessage("go"), bashA, emptyAssistant, makeSpacer(), bashB]);
	const out = container.render(60).join("\n");
	assert.ok(out.includes("Ran 2 shell commands"), `empty assistant must not break the group\n${out}`);
	assert.ok(!out.includes("Ran 1 shell"), `no stray single lines\n${out}`);
});

test("running tools render an animated one-liner with the live box", () => {
	setTurnCollapseEnabled(true);
	const live = makeBash("echo hi");
	(live as { status?: string }).status = "running";
	const container = makeContainer([makeUserMessage("live"), live]);
	const lines = container.render(60);
	const out = lines.join("\n");
	assert.ok(lines.some((l) => l.includes("bash · $ echo hi")), `running one-liner present\n${out}`);
	assert.ok(out.includes("$ echo hi"), `live box streams at full size\n${out}`);
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

test("findThinkingHostViaSegments maps lines recorded during render", () => {
	setTurnCollapseEnabled(true);
	const assistant = makeAssistant([" ✻ Thinking…", "streaming"], true, true);
	const container = makeContainer([makeUserMessage("q"), assistant]);
	const lines = container.render(60);
	const labelIndex = lines.findIndex((line) => line.includes("✻ Thinking"));
	assert.ok(labelIndex >= 0, "label rendered");
	const found = findThinkingHostViaSegments(labelIndex) as AssistantChild | undefined;
	assert.equal(found, assistant);
	assert.equal(findThinkingHostViaSegments(-1), undefined);
});

test("compact spacing: no blanks around group lines and labels", () => {
	setTurnCollapseEnabled(true);
	const bash = makeBash("echo one");
	const labeled = makeAssistant([" ✻ Thought…", "完成 ✅ 已提交"], true);
	const container = makeContainer([makeUserMessage("go"), bash, makeSpacer(), makeSpacer(), labeled]);
	const lines = container.render(60).join("\n").split("\n").map((l) => l.trim());

	const groupIndex = lines.findIndex((l) => l.includes("Ran 1 shell command"));
	const labelIndex = lines.findIndex((l) => l.includes("✻ Thought"));
	const textIndex = lines.findIndex((l) => l.includes("完成 ✅"));
	assert.ok(groupIndex >= 0 && labelIndex >= 0 && textIndex >= 0);
	// group line directly followed by the label, label directly by the text
	assert.equal(labelIndex, groupIndex + 1, `group → label must be adjacent\n${lines.join("\n")}`);
	assert.equal(textIndex, labelIndex + 1, `label → text must be adjacent\n${lines.join("\n")}`);
});

test("disabled feature renders full boxes untouched", () => {
	setTurnCollapseEnabled(false);
	try {
		const container = makeContainer([makeUserMessage("off"), makeTool("playwright")]);
		const out = container.render(60).join("\n");
		assert.ok(!out.includes("✻ Ran"), `no group lines when disabled\n${out}`);
		assert.ok(out.includes("│ playwright"), `full box passthrough\n${out}`);
	} finally {
		setTurnCollapseEnabled(true);
	}
});
