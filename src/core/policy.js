import { requireWriteApproval } from "./approval.js";
import { evaluateBudget } from "./budget.js";
import { checkIsolationDecision } from "./preflight.js";
import { evaluateStopCondition } from "./stop.js";

/**
 * @typedef {{ ok: boolean, outcome: string, reason: string, checks: Record<string, unknown> }} PolicyGateDecision
 */

/**
 * @param {import("./run-state.js").LoopRunState} state
 * @param {object} options
 * @param {"read" | "write"} [options.mode]
 * @param {{ mode?: string, acknowledgedRisk?: boolean }} [options.isolationDecision]
 * @param {{ estimatedTokens?: number, attempts?: number }} [options.nextActivity]
 * @param {{ passed?: boolean, failed?: boolean, requiresHumanDecision?: boolean }} [options.stop]
 * @param {Date} [options.now]
 * @returns {PolicyGateDecision}
 */
export function evaluatePolicyGate(state, {
  mode = "read",
  isolationDecision,
  nextActivity = {},
  stop = {},
  now = new Date()
} = {}) {
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
  }

  return {
    ok: true,
    outcome: "continue",
    reason: "policy gate passed",
    checks: { budget, stop: stopDecision }
  };
}
