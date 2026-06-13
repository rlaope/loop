import { evaluateBudget } from "./budget.js";

/**
 * @typedef {{ outcome: "complete" | "blocked" | "failed" | "budget_exhausted" | "continue", reason: string }} StopDecision
 */

/**
 * @param {import("./run-state.js").LoopRunState} state
 * @param {{ passed?: boolean, failed?: boolean, requiresHumanDecision?: boolean, nextEstimatedTokens?: number, now?: Date, budgetDecision?: import("./budget.js").BudgetDecision }} [input]
 * @returns {StopDecision}
 */
export function evaluateStopCondition(state, input = {}) {
  const budget = input.budgetDecision ?? evaluateBudget(state, {
    estimatedTokens: input.nextEstimatedTokens ?? 0,
    attempts: 1,
    now: input.now
  });
  if (budget.outcome === "budget_exhausted") {
    return budget;
  }

  if (input.passed === true || state.verificationEvidence.some((evidence) => evidence.status === "passed")) {
    return { outcome: "complete", reason: "verification evidence passed" };
  }

  if (input.requiresHumanDecision) {
    return { outcome: "blocked", reason: "human decision required before continuing" };
  }

  if (input.failed) {
    return { outcome: "failed", reason: "verification evidence failed without a recovery path" };
  }

  return { outcome: "continue", reason: "stop condition not satisfied yet" };
}
