import test from "node:test";
import assert from "node:assert/strict";
import { LOGO_FRAMES, renderLogo } from "../extensions/open-tui/header.ts";

const lastFrame = LOGO_FRAMES.length - 1;
const identity = (s: string) => s;

test("static logo wordmark reads Pi with sparkle asterisk", () => {
	const lines = renderLogo(lastFrame, identity);
	assert.equal(lines.length, 7);
	// grid rows y1..y7; wordmark spans cells x2..x9 = 24 columns
	assert.deepEqual(
		lines.slice(0, 2).concat(lines[6]!),
		[" ".repeat(24), " ".repeat(24), " ".repeat(24)],
	);
	assert.equal(lines[2], "█████████      ███   ███");
	assert.equal(lines[3], "███   ███         ███   ");
	assert.equal(lines[4], "██████   ███   ███   ███");
	assert.equal(lines[5], "███      ███            ");
});

test("narrow columns drop the asterisk and keep the bare Pi glyph", () => {
	const lines = renderLogo(lastFrame, identity, false);
	assert.equal(lines.length, 7);
	// bare glyph spans cells x2..x5 = 12 columns
	assert.equal(lines[2], "█████████");
	assert.equal(lines[3], "███   ███   ");
	assert.equal(lines[4], "██████   ███");
	assert.equal(lines[5], "███      ███");
});
