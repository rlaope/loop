import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { resolve } from "node:path";

/**
 * @param {string[]} args
 * @param {string} cwd
 */
function git(args, cwd) {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"]
  }).trim();
}

/**
 * @param {object} options
 * @param {string} [options.cwd]
 * @param {string} [options.expectedRoot]
 * @param {string} [options.expectedRemote]
 */
export function checkRepoBoundary({
  cwd = process.cwd(),
  expectedRoot,
  expectedRemote
} = {}) {
  try {
    const root = git(["rev-parse", "--show-toplevel"], cwd);
    let remote = null;
    if (expectedRemote) {
      remote = git(["remote", "get-url", "origin"], cwd);
    } else {
      try {
        remote = git(["remote", "get-url", "origin"], cwd);
      } catch {
        remote = null;
      }
    }
    const actualRoot = realpathSync(root);
    const expectedResolvedRoot = expectedRoot ? realpathSync(resolve(expectedRoot)) : undefined;
    const errors = [];

    if (expectedResolvedRoot && actualRoot !== expectedResolvedRoot) {
      errors.push([
        `git root mismatch: expected ${expectedResolvedRoot}, got ${actualRoot}`,
        "You are probably inside a parent git repository.",
        `Run from the git root (${actualRoot}), run git init in the intended project folder,`,
        `or pass --expected-root ${actualRoot} if you intentionally want the parent repository.`
      ].join(" "));
    }
    if (expectedRemote && remote !== expectedRemote) {
      errors.push(`origin mismatch: expected ${expectedRemote}, got ${remote}`);
    }

    return { ok: errors.length === 0, root: actualRoot, remote, errors };
  } catch (error) {
    return {
      ok: false,
      root: null,
      remote: null,
      errors: [error instanceof Error ? error.message : String(error)]
    };
  }
}

/**
 * @param {{ mode?: string, acknowledgedRisk?: boolean }} decision
 */
export function checkIsolationDecision(decision) {
  if (decision.mode === "worktree" || decision.mode === "branch") {
    return { ok: true, reason: `${decision.mode} isolation selected` };
  }
  if (decision.mode === "local" && decision.acknowledgedRisk === true) {
    return { ok: true, reason: "local mode explicitly acknowledged" };
  }
  return {
    ok: false,
    reason: "code-changing loops require worktree, branch, or explicit local-mode acknowledgement"
  };
}
