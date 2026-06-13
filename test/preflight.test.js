import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { mkdir, mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { checkIsolationDecision, checkRepoBoundary } from "../src/index.js";

/** @param {string[]} args @param {string} cwd */
function git(args, cwd) {
  execFileSync("git", args, { cwd, stdio: "ignore" });
}

test("repo boundary passes only for expected root and remote", async () => {
  const repo = await mkdtemp(join(tmpdir(), "loop-repo-"));
  git(["init", "-b", "main"], repo);
  git(["remote", "add", "origin", "https://github.com/rlaope/loop.git"], repo);

  const result = checkRepoBoundary({
    cwd: repo,
    expectedRoot: repo,
    expectedRemote: "https://github.com/rlaope/loop.git"
  });

  assert.equal(result.ok, true);
  assert.equal(result.root, realpathSync(repo));
});

test("repo boundary fails for unexpected parent root", async () => {
  const parent = await mkdtemp(join(tmpdir(), "loop-parent-"));
  const child = join(parent, "loop");
  git(["init", "-b", "main"], parent);
  git(["remote", "add", "origin", "https://github.com/rlaope/parent.git"], parent);
  await mkdir(child);

  const result = checkRepoBoundary({
    cwd: child,
    expectedRoot: child,
    expectedRemote: "https://github.com/rlaope/loop.git"
  });

  assert.equal(result.ok, false);
  assert.match(result.errors.join("\n"), /git root mismatch/);
});

test("repo boundary can validate root without an origin remote", async () => {
  const repo = await mkdtemp(join(tmpdir(), "loop-no-origin-"));
  git(["init", "-b", "main"], repo);

  const result = checkRepoBoundary({
    cwd: repo,
    expectedRoot: repo
  });

  assert.equal(result.ok, true);
  assert.equal(result.remote, null);
});

test("isolation decision requires a protected mode or acknowledged local mode", () => {
  assert.equal(checkIsolationDecision({ mode: "worktree" }).ok, true);
  assert.equal(checkIsolationDecision({ mode: "branch" }).ok, true);
  assert.equal(checkIsolationDecision({ mode: "local" }).ok, false);
  assert.equal(checkIsolationDecision({ mode: "local", acknowledgedRisk: true }).ok, true);
});
