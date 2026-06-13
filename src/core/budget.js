/**
 * @typedef {{ outcome: "continue" | "budget_exhausted", reason: string }} BudgetDecision
 */

/**
 * @param {string} name
 * @param {unknown} value
 */
function assertNonNegativeFinite(name, value) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new Error(`${name} must be a non-negative finite number`);
  }
}

/**
 * @param {import("./run-state.js").LoopRunState} state
 * @param {{ kind: string, estimatedTokens?: number, attempts?: number }} activity
 * @param {Date} [now]
 * @returns {import("./run-state.js").LoopRunState}
 */
export function recordBudgetActivity(state, activity, now = new Date()) {
  const estimatedTokens = activity.estimatedTokens ?? 0;
  const attempts = activity.attempts ?? 0;
  assertNonNegativeFinite("activity.estimatedTokens", estimatedTokens);
  assertNonNegativeFinite("activity.attempts", attempts);

  return {
    ...state,
    budget: {
      ...state.budget,
      attemptsUsed: state.budget.attemptsUsed + attempts,
      estimatedTokensUsed: state.budget.estimatedTokensUsed + estimatedTokens
    },
    budgetActivities: [
      ...state.budgetActivities,
      {
        kind: activity.kind,
        estimatedTokens,
        attempts,
        recordedAt: now.toISOString()
      }
    ],
    updatedAt: now.toISOString()
  };
}

/**
 * @param {import("./run-state.js").LoopRunState} state
 * @param {{ estimatedTokens?: number, attempts?: number, now?: Date }} [nextActivity]
 * @returns {BudgetDecision}
 */
export function evaluateBudget(state, nextActivity = {}) {
  const now = nextActivity.now ?? new Date();
  const nextAttempts = nextActivity.attempts ?? 0;
  const nextTokens = nextActivity.estimatedTokens ?? 0;
  assertNonNegativeFinite("nextActivity.attempts", nextAttempts);
  assertNonNegativeFinite("nextActivity.estimatedTokens", nextTokens);

  const projectedAttempts = state.budget.attemptsUsed + nextAttempts;
  const projectedTokens = state.budget.estimatedTokensUsed + nextTokens;
  const elapsedMs = now.getTime() - state.budget.startedAtMs;

  if (projectedAttempts > state.budget.maxAttempts) {
    return {
      outcome: "budget_exhausted",
      reason: `attempt budget would be exceeded: ${projectedAttempts}/${state.budget.maxAttempts}`
    };
  }

  if (projectedTokens > state.budget.maxEstimatedTokens) {
    return {
      outcome: "budget_exhausted",
      reason: `estimated token budget would be exceeded: ${projectedTokens}/${state.budget.maxEstimatedTokens}`
    };
  }

  if (elapsedMs > state.budget.maxWallClockMs) {
    return {
      outcome: "budget_exhausted",
      reason: `wall-clock budget exceeded: ${elapsedMs}/${state.budget.maxWallClockMs}ms`
    };
  }

  return { outcome: "continue", reason: "budget available" };
}
