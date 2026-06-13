import { randomBytes } from "node:crypto";

import { isTerminalOutcome } from "./outcomes.js";

const DEFAULT_BUDGET = Object.freeze({
  maxAttempts: 3,
  maxEstimatedTokens: 50000,
  maxWallClockMs: 30 * 60 * 1000
});

/**
 * @param {string} name
 * @param {unknown} value
 * @param {{ positive?: boolean }} [options]
 */
function assertBudgetNumber(name, value, { positive = false } = {}) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`${name} must be a finite number`);
  }
  if (positive ? value <= 0 : value < 0) {
    throw new Error(`${name} must be ${positive ? "positive" : "non-negative"}`);
  }
}

/**
 * @typedef {object} LoopBudget
 * @property {number} maxAttempts
 * @property {number} maxEstimatedTokens
 * @property {number} maxWallClockMs
 * @property {number} attemptsUsed
 * @property {number} estimatedTokensUsed
 * @property {number} startedAtMs
 */

/**
 * @typedef {object} ApprovalState
 * @property {boolean} humanApproval
 * @property {string[]} approvalScope
 * @property {string | null} approvalExpiresAt
 */

/**
 * @typedef {object} VerificationEvidence
 * @property {string} kind
 * @property {string} status
 * @property {string} summary
 * @property {string} recordedAt
 */

/**
 * @typedef {object} LoopRunState
 * @property {1} schemaVersion
 * @property {string} id
 * @property {string} objective
 * @property {string} objectiveSlug
 * @property {string} phase
 * @property {"active" | "complete" | "paused" | "budget_exhausted" | "unsafe" | "failed" | "blocked"} status
 * @property {LoopBudget} budget
 * @property {{ description: string }} stopCondition
 * @property {VerificationEvidence[]} verificationEvidence
 * @property {ApprovalState} approvals
 * @property {{ kind: string, estimatedTokens: number, attempts: number, recordedAt: string }[]} budgetActivities
 * @property {string} nextAction
 * @property {string} createdAt
 * @property {string} updatedAt
 */

/** @param {string} objective */
export function slugifyObjective(objective) {
  return objective
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80) || "loop";
}

/**
 * @param {object} input
 * @param {string} input.objective
 * @param {Partial<LoopBudget>} [input.budget]
 * @param {{ description?: string }} [input.stopCondition]
 * @param {Partial<ApprovalState>} [input.approvals]
 * @param {Date} [input.now]
 * @returns {LoopRunState}
 */
export function createRunState({
  objective,
  budget = {},
  stopCondition = {},
  approvals = {},
  now = new Date()
}) {
  if (!objective || !objective.trim()) {
    throw new Error("Loop objective is required");
  }

  const resolvedBudget = {
    maxAttempts: budget.maxAttempts ?? DEFAULT_BUDGET.maxAttempts,
    maxEstimatedTokens: budget.maxEstimatedTokens ?? DEFAULT_BUDGET.maxEstimatedTokens,
    maxWallClockMs: budget.maxWallClockMs ?? DEFAULT_BUDGET.maxWallClockMs,
    attemptsUsed: budget.attemptsUsed ?? 0,
    estimatedTokensUsed: budget.estimatedTokensUsed ?? 0,
    startedAtMs: budget.startedAtMs ?? now.getTime()
  };

  assertBudgetNumber("budget.maxAttempts", resolvedBudget.maxAttempts, { positive: true });
  assertBudgetNumber("budget.maxEstimatedTokens", resolvedBudget.maxEstimatedTokens, { positive: true });
  assertBudgetNumber("budget.maxWallClockMs", resolvedBudget.maxWallClockMs, { positive: true });
  assertBudgetNumber("budget.attemptsUsed", resolvedBudget.attemptsUsed);
  assertBudgetNumber("budget.estimatedTokensUsed", resolvedBudget.estimatedTokensUsed);
  assertBudgetNumber("budget.startedAtMs", resolvedBudget.startedAtMs);

  const timestamp = now.toISOString();
  const objectiveSlug = slugifyObjective(objective);
  const runNonce = randomBytes(4).toString("hex");

  return {
    schemaVersion: 1,
    id: `${objectiveSlug}-${timestamp.replace(/[:.]/g, "")}-${runNonce}`,
    objective,
    objectiveSlug,
    phase: "intake",
    status: "active",
    budget: resolvedBudget,
    stopCondition: {
      description: stopCondition.description ?? "Stop when verification evidence proves the objective is complete."
    },
    verificationEvidence: [],
    approvals: {
      humanApproval: approvals.humanApproval ?? false,
      approvalScope: approvals.approvalScope ?? [],
      approvalExpiresAt: approvals.approvalExpiresAt ?? null
    },
    budgetActivities: [],
    nextAction: "plan",
    createdAt: timestamp,
    updatedAt: timestamp
  };
}

/**
 * @param {LoopRunState} state
 * @param {Partial<VerificationEvidence>} evidence
 * @param {Date} [now]
 * @returns {LoopRunState}
 */
export function appendEvidence(state, evidence, now = new Date()) {
  return {
    ...state,
    verificationEvidence: [
      ...state.verificationEvidence,
      {
        kind: evidence.kind ?? "manual",
        status: evidence.status ?? "unknown",
        summary: evidence.summary ?? "",
        recordedAt: evidence.recordedAt ?? now.toISOString()
      }
    ],
    updatedAt: now.toISOString()
  };
}

/**
 * @param {LoopRunState} state
 * @param {"complete" | "paused" | "budget_exhausted" | "unsafe" | "failed" | "blocked"} outcome
 * @param {{ nextAction?: string, now?: Date }} [options]
 * @returns {LoopRunState}
 */
export function transitionRunState(state, outcome, { nextAction, now = new Date() } = {}) {
  if (!isTerminalOutcome(outcome)) {
    throw new Error(`Unknown terminal outcome: ${String(outcome)}`);
  }

  return {
    ...state,
    phase: "stop",
    status: outcome,
    nextAction: nextAction ?? `terminal outcome: ${outcome}`,
    updatedAt: now.toISOString()
  };
}
