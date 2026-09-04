#!/usr/bin/env node
/**
 * Mechanical doc gates — docs/adrs/0001 + docs/adrs/0002.
 *
 *   links — relative markdown links/images in repo docs must resolve on disk
 *   adrs  — docs/adrs: unique numbers, README index <-> files consistent,
 *           Date line, valid Status value, Considered Options section present
 *   posts — docs/postmortems/YYYY-MM-DD-*.md carry the loop shape
 *           (Rule: line + Timeline / Root cause / Guardrails sections)
 *
 * Usage:
 *   node scripts/check-docs.mjs             full check against this repo
 *   node scripts/check-docs.mjs --selftest  verify the checker itself on fixtures
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const STATUS_RE = /^(Accepted|Proposed|Rejected|Deprecated|Superseded by ADR-\d{1,4})\b/;
const ADR_FILE_RE = /^\d{4}-.*\.md$/;
const POST_FILE_RE = /^\d{4}-\d{2}-\d{2}-.*\.md$/;

function walkMarkdown(dir, out = []) {
	for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
		if (entry.name.startsWith(".") || entry.name === "node_modules" || entry.name === "assets") continue;
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) walkMarkdown(full, out);
		else if (entry.name.endsWith(".md")) out.push(full);
	}
	return out;
}

function checkLinks(root, violations) {
	for (const file of walkMarkdown(root)) {
		const lines = fs.readFileSync(file, "utf8").split("\n");
		let inFence = false;
		lines.forEach((line, i) => {
			if (/^\s*(```|~~~)/.test(line)) {
				inFence = !inFence;
				return;
			}
			if (inFence) return;
			for (const m of line.matchAll(/!?\[[^\]]*\]\(([^)]+)\)/g)) {
				let target = m[1].trim();
				if (target.startsWith("<") && target.endsWith(">")) target = target.slice(1, -1);
				if (/^(https?:|mailto:|data:)/i.test(target)) continue;
				const filePart = target.split("#")[0].trim();
				if (!filePart) continue;
				const resolved = filePart.startsWith("/")
					? path.join(root, filePart)
					: path.resolve(path.dirname(file), filePart);
				if (!fs.existsSync(resolved)) {
					violations.push(`${path.relative(root, file)}:${i + 1}: dead link "${filePart}"`);
				}
			}
		});
	}
}

function checkAdrShape(file, text, root, violations) {
	const where = path.relative(root, file);
	if (!/^Date:\s*\d{4}-\d{2}-\d{2}/m.test(text)) {
		violations.push(`${where}: missing "Date: YYYY-MM-DD" line`);
	}
	const statusHeading = text.match(/^##\s+Status\s*$/m);
	if (!statusHeading) {
		violations.push(`${where}: missing "## Status" section`);
	} else {
		const rest = text.slice(statusHeading.index + statusHeading[0].length);
		const value = rest.split("\n").map((l) => l.trim()).find((l) => l.length > 0);
		if (!value || !STATUS_RE.test(value)) {
			violations.push(
				`${where}: Status must be Accepted|Proposed|Rejected|Deprecated|Superseded by ADR-NNNN (got "${value ?? ""}")`,
			);
		}
	}
	if (!/^##\s+Considered Options/m.test(text)) {
		violations.push(`${where}: missing "## Considered Options" section`);
	}
}

function checkAdrs(root, violations) {
	const dir = path.join(root, "docs", "adrs");
	if (!fs.existsSync(dir)) return;
	const files = fs.readdirSync(dir).filter((f) => ADR_FILE_RE.test(f)).sort();
	const seen = new Map();
	for (const f of files) {
		const num = f.slice(0, 4);
		if (seen.has(num)) violations.push(`docs/adrs: duplicate ADR number ${num} (${seen.get(num)} vs ${f})`);
		else seen.set(num, f);
		checkAdrShape(path.join(dir, f), fs.readFileSync(path.join(dir, f), "utf8"), root, violations);
	}
	const readme = path.join(dir, "README.md");
	if (!fs.existsSync(readme)) {
		violations.push("docs/adrs/README.md: missing (ADR index required)");
		return;
	}
	const indexed = new Set(
		[...fs.readFileSync(readme, "utf8").matchAll(/\]\((?:\.\/)?(\d{4}-[^)\s#]+\.md)\)/g)].map((m) => m[1]),
	);
	for (const f of files) {
		if (!indexed.has(f)) violations.push(`docs/adrs/${f}: not listed in docs/adrs/README.md index`);
	}
	for (const f of indexed) {
		if (!files.includes(f)) violations.push(`docs/adrs/README.md: index entry "${f}" has no matching file`);
	}
}

function checkPostmortems(root, violations) {
	const dir = path.join(root, "docs", "postmortems");
	if (!fs.existsSync(dir)) return;
	const required = [
		[/^Rule:/m, "Rule: line"],
		[/^##\s+Timeline/m, "## Timeline section"],
		[/^##\s+Root cause/m, "## Root cause section"],
		[/^##\s+Guardrails/m, "## Guardrails section"],
	];
	for (const f of fs.readdirSync(dir)) {
		if (!POST_FILE_RE.test(f)) continue;
		const text = fs.readFileSync(path.join(dir, f), "utf8");
		for (const [re, label] of required) {
			if (!re.test(text)) violations.push(`docs/postmortems/${f}: missing ${label}`);
		}
	}
}

function runChecks(root) {
	const violations = [];
	checkLinks(root, violations);
	checkAdrs(root, violations);
	checkPostmortems(root, violations);
	return violations;
}

function selftest() {
	const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "check-docs-selftest-"));
	const fail = (msg) => {
		console.error(`SELFTEST FAIL: ${msg}`);
		process.exit(1);
	};
	const must = (violations, needle) => {
		if (!violations.some((v) => v.includes(needle))) {
			fail(`expected a violation containing "${needle}", got:\n  ${violations.join("\n  ") || "(none)"}`);
		}
	};

	// Dirty fixture: every rule class fires at least once.
	const dirty = path.join(tmp, "dirty");
	fs.mkdirSync(path.join(dirty, "docs/adrs"), { recursive: true });
	fs.mkdirSync(path.join(dirty, "docs/postmortems"), { recursive: true });
	fs.writeFileSync(path.join(dirty, "page.md"), "[ok](./ok.md) [dead](./missing.md)\n");
	fs.writeFileSync(path.join(dirty, "ok.md"), "fine\n");
	fs.writeFileSync(path.join(dirty, "docs/adrs/README.md"), "| [0001](./0001-good.md) | [0003](./0003-bad.md) |\n");
	const good = "# 1. Good\n\nDate: 2026-01-01\n\n## Status\n\nAccepted\n\n## Considered Options\n\n- none\n";
	fs.writeFileSync(path.join(dirty, "docs/adrs/0001-good.md"), good);
	fs.writeFileSync(path.join(dirty, "docs/adrs/0002-orphan.md"), good); // not indexed
	fs.writeFileSync(path.join(dirty, "docs/adrs/0003-bad.md"), "# 3. Bad\n\n## Status\n\nMaybe\n"); // bad status, no options/date
	fs.writeFileSync(path.join(dirty, "docs/adrs/0003-dup.md"), good); // duplicate number + not indexed
	fs.writeFileSync(path.join(dirty, "docs/postmortems/2026-01-01-bad.md"), "# x\n\n## Timeline\n\nt\n");
	const v = runChecks(dirty);
	must(v, "dead link");
	must(v, "0002-orphan.md");
	must(v, "duplicate ADR number 0003");
	must(v, "Status must be");
	must(v, "Considered Options");
	must(v, "Date:");
	must(v, "Rule:");

	// Clean fixture: zero violations.
	const clean = path.join(tmp, "clean");
	fs.mkdirSync(path.join(clean, "docs/adrs"), { recursive: true });
	fs.mkdirSync(path.join(clean, "docs/postmortems"), { recursive: true });
	fs.writeFileSync(path.join(clean, "docs/adrs/README.md"), "| [0001](./0001-a.md) |\n");
	fs.writeFileSync(path.join(clean, "docs/adrs/0001-a.md"), good);
	fs.writeFileSync(
		path.join(clean, "docs/postmortems/2026-01-01-a.md"),
		"# x\n\nDate: 2026-01-01\nRule: P1\n\n## Timeline\n\nt\n\n## Root cause\n\nr\n\n## Guardrails\n\ng\n",
	);
	const cleanV = runChecks(clean);
	if (cleanV.length) fail(`clean fixture should pass, got:\n  ${cleanV.join("\n  ")}`);

	fs.rmSync(tmp, { recursive: true, force: true });
	console.log("check-docs selftest: PASS (7 violation classes verified, clean fixture green)");
}

if (process.argv.includes("--selftest")) {
	selftest();
} else {
	const violations = runChecks(repoRoot);
	if (violations.length) {
		for (const v of violations) console.error(`docs-gate: ${v}`);
		console.error(`docs-gate: ${violations.length} violation(s)`);
		process.exit(1);
	}
	console.log("docs-gate: OK (links / ADR index+shape / postmortem shape)");
}
