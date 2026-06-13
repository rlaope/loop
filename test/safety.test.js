import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  createRunState,
  evaluateBudget,
  evaluatePolicyGate,
  evaluateStopCondition,
  recordBudgetActivity,
  requireWriteApproval
} from "../src/index.js";

/** @param {string[]} args @param {string} cwd */
function git(args, cwd) {
  execFileSync("git", args, { cwd, stdio: "ignore" });
}

test("nested activities consume the same run budget", () => {
  const state = createRunState({
    objective: "Budget all work",
    budget: { maxAttempts: 3, maxEstimatedTokens: 1000 }
  });

  const afterSubagent = recordBudgetActivity(state, {
    kind: "sub-agent",
    estimatedTokens: 400,
    attempts: 1
  });
  const afterAutomation = recordBudgetActivity(afterSubagent, {
    kind: "automation",
    estimatedTokens: 500,
    attempts: 1
  });

  assert.equal(afterAutomation.budget.estimatedTokensUsed, 900);
  assert.equal(afterAutomation.budget.attemptsUsed, 2);
  assert.equal(evaluateBudget(afterAutomation, { estimatedTokens: 200 }).outcome, "budget_exhausted");
});

test("budget rejects negative activity values", () => {
  const state = createRunState({ objective: "No budget refunds" });

  assert.throws(
    () => recordBudgetActivity(state, { kind: "sub-agent", estimatedTokens: -1 }),
    /non-negative/
  );
  assert.throws(
    () => evaluateBudget(state, { estimatedTokens: -1 }),
    /non-negative/
  );
});

test("stop condition completes on passing evidence", () => {
  const state = createRunState({ objective: "Prove completion" });

  assert.deepEqual(evaluateStopCondition(state, { passed: true }), {
    outcome: "complete",
    reason: "verification evidence passed"
  });
});

test("stop condition blocks on missing human decision", () => {
  const state = createRunState({ objective: "Needs a person" });

  const decision = evaluateStopCondition(state, { requiresHumanDecision: true });

  assert.equal(decision.outcome, "blocked");
});

test("policy gate composes read and write safety checks", () => {
  const readState = createRunState({ objective: "Read only" });
  const writeState = createRunState({ objective: "Write mode" });

  assert.equal(evaluatePolicyGate(readState, { mode: "read" }).ok, true);
  assert.equal(
    evaluatePolicyGate(writeState, {
      mode: "write",
      isolationDecision: { mode: "branch" }
    }).outcome,
    "unsafe"
  );
});

test("write policy requires repo-boundary preflight", async () => {
  const repo = await mkdtemp(join(tmpdir(), "loop-policy-repo-"));
  const noRemoteRepo = await mkdtemp(join(tmpdir(), "loop-policy-no-remote-"));
  git(["init", "-b", "main"], repo);
  git(["remote", "add", "origin", "https://github.com/rlaope/loop.git"], repo);
  git(["init", "-b", "main"], noRemoteRepo);
  const state = createRunState({
    objective: "Approved write",
    approvals: {
      humanApproval: true,
      approvalScope: ["write"],
      approvalExpiresAt: "2026-06-14T00:00:00.000Z"
    }
  });

  assert.equal(
    evaluatePolicyGate(state, {
      mode: "write",
      isolationDecision: { mode: "branch" },
      repoBoundary: { cwd: repo },
      now: new Date("2026-06-13T00:00:00.000Z")
    }).outcome,
    "unsafe"
  );
  assert.equal(
    evaluatePolicyGate(state, {
      mode: "write",
      isolationDecision: { mode: "branch" },
      repoBoundary: { cwd: repo, expectedRoot: repo },
      now: new Date("2026-06-13T00:00:00.000Z")
    }).outcome,
    "unsafe"
  );
  assert.equal(
    evaluatePolicyGate(state, {
      mode: "write",
      isolationDecision: { mode: "branch" },
      repoBoundary: {
        cwd: repo,
        expectedRoot: repo,
        expectedRemote: "https://github.com/rlaope/loop.git"
      },
      now: new Date("2026-06-13T00:00:00.000Z")
    }).ok,
    true
  );
  assert.equal(
    evaluatePolicyGate(state, {
      mode: "write",
      isolationDecision: { mode: "branch" },
      repoBoundary: {
        cwd: noRemoteRepo,
        expectedRoot: noRemoteRepo,
        allowNoRemote: true
      },
      now: new Date("2026-06-13T00:00:00.000Z")
    }).ok,
    true
  );
});

test("policy gate fails closed for unsupported modes", () => {
  const state = createRunState({ objective: "Unknown mode" });

  assert.equal(
    // @ts-expect-error invalid mode is intentionally exercised at runtime
    evaluatePolicyGate(state, { mode: "delete-everything" }).outcome,
    "unsafe"
  );
});

test("write-capable automation requires durable human approval", () => {
  const state = createRunState({ objective: "Try writing" });
  const approved = createRunState({
    objective: "Approved write",
    approvals: {
      humanApproval: true,
      approvalScope: ["write"],
      approvalExpiresAt: "2026-06-14T00:00:00.000Z"
    }
  });

  assert.equal(requireWriteApproval(state).outcome, "unsafe");
  assert.equal(
    requireWriteApproval(approved, { now: new Date("2026-06-13T00:00:00.000Z") }).outcome,
    "continue"
  );
});
