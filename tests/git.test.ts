import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	emptyGitStatus,
	hasGitChanges,
	readBranchViaRevParse,
	readGitStatus,
} from "../extensions/open-tui/git.ts";

function git(cwd: string, ...args: string[]): void {
	execFileSync("git", args, { cwd, stdio: "ignore" });
}

function makeRepo(): string {
	const dir = mkdtempSync(join(tmpdir(), "open-tui-git-"));
	git(dir, "init", "-b", "main");
	writeFileSync(join(dir, "a.txt"), "hello\n");
	git(dir, "add", "a.txt");
	git(dir, "-c", "user.email=t@example.com", "-c", "user.name=t", "commit", "-m", "init");
	return dir;
}

test("readGitStatus parses branch and worktree counts", async () => {
	const dir = makeRepo();
	try {
		writeFileSync(join(dir, "a.txt"), "changed\n");
		writeFileSync(join(dir, "b.txt"), "untracked\n");
		const status = await readGitStatus(dir, { readCounts: true });
		assert.equal(status.branch, "main");
		assert.equal(status.modified, 1);
		assert.equal(status.untracked, 1);
		assert.ok(hasGitChanges(status));
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("readGitStatus survives a fatally broken repo (bad gitdir file)", async () => {
	const dir = mkdtempSync(join(tmpdir(), "open-tui-git-"));
	try {
		writeFileSync(join(dir, ".git"), `gitdir: ${join(dir, "nonexistent")}`);
		const status = await readGitStatus(dir);
		assert.equal(status.branch, undefined);
		assert.deepEqual(status, emptyGitStatus());
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("readGitStatus falls back to ignore-submodules and rev-parse", async () => {
	// The real-world trigger (linked worktree + broken submodule core.worktree)
	// is verified manually against such a worktree; here we cover the rev-parse
	// fallback's own contract on a healthy repo and a detached HEAD.
	const dir = makeRepo();
	try {
		assert.equal(await readBranchViaRevParse(dir), "main");
		git(dir, "checkout", "--detach");
		assert.equal(await readBranchViaRevParse(dir), undefined, "detached → undefined");
		assert.equal(await readBranchViaRevParse(join(dir, "no-such-dir")), undefined);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("emptyGitStatus and hasGitChanges stay consistent", () => {
	const empty = emptyGitStatus();
	assert.equal(empty.branch, undefined);
	assert.ok(!hasGitChanges(empty));
	assert.ok(hasGitChanges({ ...empty, ahead: 1 }));
});
