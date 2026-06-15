import { terminalOutcomes } from "./outcomes.js";

const REQUIRED_STRING_FIELDS = [
  "id",
  "objective",
  "objectiveSlug",
  "phase",
  "status",
  "nextAction",
  "createdAt",
  "updatedAt"
];

const REQUIRED_BUDGET_FIELDS = [
  "maxAttempts",
  "maxEstimatedTokens",
  "maxWallClockMs",
  "attemptsUsed",
  "estimatedTokensUsed",
  "startedAtMs"
];

const SAFE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const VALID_PHASES = new Set(["intake", "plan", "discover", "isolate", "act", "verify", "persist", "stop"]);
const VALID_STATUSES = new Set(["active", ...terminalOutcomes]);
const VALID_LINEAGE_RELATIONSHIPS = new Set(["continues"]);
const VALID_LINEAGE_SOURCES = new Set(["tui", "dashboard", "cli"]);

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * @param {unknown} state
 * @returns {{ valid: boolean, errors: string[] }}
 */
export function validateRunState(state) {
  const errors = [];
  if (!isRecord(state)) {
    return { valid: false, errors: ["state must be an object"] };
  }

  if (state.schemaVersion !== 1) {
    errors.push("schemaVersion must be 1");
  }

  for (const field of REQUIRED_STRING_FIELDS) {
    if (typeof state[field] !== "string" || state[field] === "") {
      errors.push(`${field} must be a non-empty string`);
    }
  }

  if (typeof state.id === "string" && !SAFE_ID_PATTERN.test(state.id)) {
    errors.push("id must be a safe filename token");
  }
  if (typeof state.objectiveSlug === "string" && !SAFE_ID_PATTERN.test(state.objectiveSlug)) {
    errors.push("objectiveSlug must be a safe filename token");
  }
  if (typeof state.phase === "string" && !VALID_PHASES.has(state.phase)) {
    errors.push(`phase must be one of: ${Array.from(VALID_PHASES).join(", ")}`);
  }
  if (typeof state.status === "string" && !VALID_STATUSES.has(state.status)) {
    errors.push(`status must be one of: ${Array.from(VALID_STATUSES).join(", ")}`);
  }

  if (!isRecord(state.budget)) {
    errors.push("budget must be an object");
  } else {
    for (const field of REQUIRED_BUDGET_FIELDS) {
      if (typeof state.budget[field] !== "number" || !Number.isFinite(state.budget[field])) {
        errors.push(`budget.${field} must be a finite number`);
      }
    }
    for (const field of ["attemptsUsed", "estimatedTokensUsed", "startedAtMs"]) {
      if (typeof state.budget[field] === "number" && state.budget[field] < 0) {
        errors.push(`budget.${field} must be non-negative`);
      }
    }
    for (const field of ["maxAttempts", "maxEstimatedTokens", "maxWallClockMs"]) {
      if (typeof state.budget[field] === "number" && state.budget[field] <= 0) {
        errors.push(`budget.${field} must be positive`);
      }
    }
  }

  if (!isRecord(state.stopCondition) || typeof state.stopCondition.description !== "string" || state.stopCondition.description === "") {
    errors.push("stopCondition.description must be a non-empty string");
  }

  if (!Array.isArray(state.verificationEvidence)) {
    errors.push("verificationEvidence must be an array");
  } else {
    state.verificationEvidence.forEach((evidence, index) => {
      if (!isRecord(evidence)) {
        errors.push(`verificationEvidence[${index}] must be an object`);
        return;
      }
      for (const field of ["kind", "status", "summary", "recordedAt"]) {
        if (typeof evidence[field] !== "string") {
          errors.push(`verificationEvidence[${index}].${field} must be a string`);
        }
      }
    });
  }

  if (!Array.isArray(state.budgetActivities)) {
    errors.push("budgetActivities must be an array");
  } else {
    state.budgetActivities.forEach((activity, index) => {
      if (!isRecord(activity)) {
        errors.push(`budgetActivities[${index}] must be an object`);
        return;
      }
      if (typeof activity.kind !== "string") {
        errors.push(`budgetActivities[${index}].kind must be a string`);
      }
      if (
        typeof activity.estimatedTokens !== "number" ||
        !Number.isFinite(activity.estimatedTokens) ||
        activity.estimatedTokens < 0
      ) {
        errors.push(`budgetActivities[${index}].estimatedTokens must be a non-negative finite number`);
      }
      if (
        typeof activity.attempts !== "number" ||
        !Number.isFinite(activity.attempts) ||
        activity.attempts < 0
      ) {
        errors.push(`budgetActivities[${index}].attempts must be a non-negative finite number`);
      }
      if (typeof activity.recordedAt !== "string") {
        errors.push(`budgetActivities[${index}].recordedAt must be a string`);
      }
    });
  }

  if (!isRecord(state.approvals)) {
    errors.push("approvals must be an object");
  } else {
    if (typeof state.approvals.humanApproval !== "boolean") {
      errors.push("approvals.humanApproval must be a boolean");
    }
    if (!Array.isArray(state.approvals.approvalScope)) {
      errors.push("approvals.approvalScope must be an array");
    } else if (state.approvals.approvalScope.some((scope) => typeof scope !== "string")) {
      errors.push("approvals.approvalScope must contain only strings");
    }
    if (
      state.approvals.approvalExpiresAt !== null &&
      typeof state.approvals.approvalExpiresAt !== "string"
    ) {
      errors.push("approvals.approvalExpiresAt must be a string or null");
    }
  }

  if (state.lineage !== undefined) {
    if (!isRecord(state.lineage)) {
      errors.push("lineage must be an object when present");
    } else {
      for (const field of ["parentRunId", "rootRunId", "prompt", "createdFrom", "relationship"]) {
        if (typeof state.lineage[field] !== "string" || state.lineage[field] === "") {
          errors.push(`lineage.${field} must be a non-empty string`);
        }
      }
      if (typeof state.lineage.parentRunId === "string" && !SAFE_ID_PATTERN.test(state.lineage.parentRunId)) {
        errors.push("lineage.parentRunId must be a safe filename token");
      }
      if (typeof state.lineage.rootRunId === "string" && !SAFE_ID_PATTERN.test(state.lineage.rootRunId)) {
        errors.push("lineage.rootRunId must be a safe filename token");
      }
      if (typeof state.lineage.relationship === "string" && !VALID_LINEAGE_RELATIONSHIPS.has(state.lineage.relationship)) {
        errors.push(`lineage.relationship must be one of: ${Array.from(VALID_LINEAGE_RELATIONSHIPS).join(", ")}`);
      }
      if (typeof state.lineage.createdFrom === "string" && !VALID_LINEAGE_SOURCES.has(state.lineage.createdFrom)) {
        errors.push(`lineage.createdFrom must be one of: ${Array.from(VALID_LINEAGE_SOURCES).join(", ")}`);
      }
    }
  }

  return { valid: errors.length === 0, errors };
}

/**
 * @param {unknown} state
 * @returns {asserts state is import("./run-state.js").LoopRunState}
 */
export function assertValidRunState(state) {
  const result = validateRunState(state);
  if (!result.valid) {
    throw new Error(`Invalid loop run state: ${result.errors.join("; ")}`);
  }
}
