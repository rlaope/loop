export { allOutcomes, isKnownOutcome, isTerminalOutcome, nonTerminalOutcomes, terminalOutcomes } from "./core/outcomes.js";
export { evaluateBudget, recordBudgetActivity } from "./core/budget.js";
export { hasActiveApproval, requireWriteApproval } from "./core/approval.js";
export { checkIsolationDecision, checkRepoBoundary } from "./core/preflight.js";
export { evaluatePolicyGate } from "./core/policy.js";
export { appendEvidence, createRunState, slugifyObjective } from "./core/run-state.js";
export { assertValidRunState, validateRunState } from "./core/schema.js";
export { evaluateStopCondition } from "./core/stop.js";
export { readLatestRunBySlug, readRunState, renderRunSummary, writeRunState } from "./core/state-store.js";

export const packageName = "@rlaope/loop";

/** @param {NodeJS.WritableStream} stream */
export function printHelp(stream) {
  stream.write(`Loop Engineering toolkit\n\n`);
  stream.write(`Usage: loop --dry-run --objective "<objective>" [--state-dir .loop]\n`);
  stream.write(`\n`);
  stream.write(`The MVP CLI is strict dry-run/read-only: it writes durable Loop state only.\n`);
  stream.write(`It does not perform source edits or write-capable automation.\n`);
}
