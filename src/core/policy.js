import { requireWriteApproval } from "./approval.js";
import { evaluateBudget } from "./budget.js";
import { checkIsolationDecision, checkRepoBoundary } from "./preflight.js";
import { evaluateStopCondition } from "./stop.js";

/**
 * @typedef {{ ok: boolean, outcome: string, reason: string, checks: Record<string, unknown> }} PolicyGateDecision
 */

/**
 * @param {import("./run-state.js").LoopRunState} state
 * @param {object} options
 * @param {"read" | "write"} [options.mode]
 * @param {{ mode?: string, acknowledgedRisk?: boolean }} [options.isolationDecision]
 * @param {{ cwd?: string, expectedRoot?: string, expectedRemote?: string, allowNoRemote?: boolean }} [options.repoBoundary]
 * @param {{ estimatedTokens?: number, attempts?: number }} [options.nextActivity]
 * @param {{ passed?: boolean, failed?: boolean, requiresHumanDecision?: boolean }} [options.stop]
 * @param {Date} [options.now]
 * @returns {PolicyGateDecision}
 */
export function evaluatePolicyGate(state, {
  mode = "read",
  isolationDecision,
  repoBoundary,
  nextActivity = {},
  stop = {},
  now = new Date()
} = {}) {
  if (mode !== "read" && mode !== "write") {
    return {
      ok: false,
      outcome: "unsafe",
      reason: `unsupported policy mode: ${String(mode)}`,
      checks: { mode }
    };
  }

  const budget = evaluateBudget(state, {
    ...nextActivity,
    now
  });
  if (budget.outcome !== "continue") {
    return { ok: false, outcome: budget.outcome, reason: budget.reason, checks: { budget } };
  }

  const stopDecision = evaluateStopCondition(state, { ...stop, now, budgetDecision: budget });
  if (stopDecision.outcome !== "continue") {
    return {
      ok: stopDecision.outcome === "complete",
      outcome: stopDecision.outcome,
      reason: stopDecision.reason,
      checks: { budget, stop: stopDecision }
    };
  }

  if (mode === "write") {
    const approval = requireWriteApproval(state, { now });
    if (approval.outcome !== "continue") {
      return { ok: false, outcome: approval.outcome, reason: approval.reason, checks: { budget, stop: stopDecision, approval } };
    }

    const isolation = checkIsolationDecision(isolationDecision ?? {});
    if (!isolation.ok) {
      return { ok: false, outcome: "unsafe", reason: isolation.reason, checks: { budget, stop: stopDecision, approval, isolation } };
    }

    if (!repoBoundary?.expectedRoot) {
      return {
        ok: false,
        outcome: "unsafe",
        reason: "write-capable automation requires expected repo root evidence",
        checks: { budget, stop: stopDecision, approval, isolation }
      };
    }

    if (!repoBoundary.expectedRemote && repoBoundary.allowNoRemote !== true) {
      return {
        ok: false,
        outcome: "unsafe",
        reason: "write-capable automation requires expected remote evidence or explicit no-remote acknowledgement",
        checks: { budget, stop: stopDecision, approval, isolation }
      };
    }

    const boundary = checkRepoBoundary(repoBoundary);
    if (!boundary.ok) {
      return {
        ok: false,
        outcome: "unsafe",
        reason: `repo boundary preflight failed: ${boundary.errors.join("; ")}`,
        checks: { budget, stop: stopDecision, approval, isolation, boundary }
      };
    }

    return {
      ok: true,
      outcome: "continue",
      reason: "policy gate passed",
      checks: { budget, stop: stopDecision, approval, isolation, boundary }
    };
  }

  return {
    ok: true,
    outcome: "continue",
    reason: "policy gate passed",
    checks: { budget, stop: stopDecision }
  };
}
