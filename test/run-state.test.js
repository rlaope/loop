import test from "node:test";
import assert from "node:assert/strict";

import { appendEvidence, createRunState, slugifyObjective, terminalOutcomes, transitionRunState, validateRunState } from "../src/index.js";

test("creates a valid run state with required contract fields", () => {
  const state = createRunState({
    objective: "Build the loop",
    now: new Date("2026-06-13T00:00:00.000Z")
  });

  assert.equal(state.schemaVersion, 1);
  assert.equal(state.objectiveSlug, "build-the-loop");
  assert.equal(state.phase, "intake");
  assert.equal(state.budget.maxAttempts, 3);
  assert.equal(validateRunState(state).valid, true);
});

test("slugifies non-ascii objectives into stable distinct safe slugs", () => {
  const first = slugifyObjective("다크웨어 명품 큐레이션 전시 사이트");
  const same = slugifyObjective("다크웨어 명품 큐레이션 전시 사이트");
  const other = slugifyObjective("서로 다른 한국어 목적");

  assert.match(first, /^loop-[a-f0-9]{10}$/);
  assert.equal(first, same);
  assert.notEqual(first, other);
});

test("rejects missing required schema fields", () => {
  const state = createRunState({ objective: "Build the loop" });
  const invalid = { ...state, budget: undefined };

  const result = validateRunState(invalid);

  assert.equal(result.valid, false);
  assert.match(result.errors.join("\n"), /budget must be an object/);
});

test("rejects malformed nested schema records", () => {
  const state = createRunState({ objective: "Validate nested fields" });
  const invalid = {
    ...state,
    approvals: {
      ...state.approvals,
      approvalScope: ["write", 42]
    },
    verificationEvidence: [{ kind: "test", status: "passed", summary: "ok" }],
    budgetActivities: [{ kind: "sub-agent", estimatedTokens: Infinity, attempts: 1, recordedAt: "now" }]
  };

  const result = validateRunState(invalid);

  assert.equal(result.valid, false);
  assert.match(result.errors.join("\n"), /approvalScope/);
  assert.ok(result.errors.join("\n").includes("verificationEvidence[0].recordedAt"));
  assert.ok(result.errors.join("\n").includes("budgetActivities[0].estimatedTokens"));
});

test("rejects unsafe ids and negative budget values", () => {
  const state = createRunState({ objective: "Validate safety" });
  const invalid = {
    ...state,
    id: "../escape",
    budget: {
      ...state.budget,
      estimatedTokensUsed: -1
    }
  };

  const result = validateRunState(invalid);

  assert.equal(result.valid, false);
  assert.ok(result.errors.join("\n").includes("safe filename"));
  assert.ok(result.errors.join("\n").includes("estimatedTokensUsed"));
  assert.throws(
    () => createRunState({ objective: "bad", budget: { maxAttempts: -1 } }),
    /positive/
  );
});

test("rejects unbounded lifecycle fields", () => {
  const state = createRunState({ objective: "Lifecycle contract" });
  const invalid = {
    ...state,
    phase: "whatever",
    status: "mystery"
  };

  const result = validateRunState(invalid);

  assert.equal(result.valid, false);
  assert.ok(result.errors.join("\n").includes("phase must be one of"));
  assert.ok(result.errors.join("\n").includes("status must be one of"));
});

test("records verification evidence immutably", () => {
  const state = createRunState({ objective: "Verify the loop" });
  const updated = appendEvidence(state, {
    kind: "test",
    status: "passed",
    summary: "node --test passed"
  });

  assert.equal(state.verificationEvidence.length, 0);
  assert.equal(updated.verificationEvidence.length, 1);
  assert.equal(updated.verificationEvidence[0].summary, "node --test passed");
});

test("records terminal outcomes in durable state", () => {
  const state = createRunState({ objective: "Stop safely" });
  const updated = transitionRunState(state, "blocked", {
    nextAction: "wait for human decision",
    now: new Date("2026-06-13T00:01:00.000Z")
  });

  assert.equal(updated.phase, "stop");
  assert.equal(updated.status, "blocked");
  assert.equal(updated.nextAction, "wait for human decision");
  assert.equal(validateRunState(updated).valid, true);
  assert.throws(() => {
    // @ts-expect-error invalid outcome is intentionally exercised at runtime
    transitionRunState(state, "continue");
  }, /Unknown terminal outcome/);
});

test("documents terminal outcomes", () => {
  assert.deepEqual(terminalOutcomes, [
    "complete",
    "paused",
    "budget_exhausted",
    "unsafe",
    "failed",
    "blocked"
  ]);
});
