export { allOutcomes, isKnownOutcome, isTerminalOutcome, nonTerminalOutcomes, terminalOutcomes } from "./core/outcomes.js";
export { evaluateBudget, recordBudgetActivity } from "./core/budget.js";
export { hasActiveApproval, requireWriteApproval } from "./core/approval.js";
export { checkIsolationDecision, checkRepoBoundary } from "./core/preflight.js";
export { evaluatePolicyGate } from "./core/policy.js";
export { appendEvidence, createRunState, slugifyObjective, transitionRunState } from "./core/run-state.js";
export { assertValidRunState, validateRunState } from "./core/schema.js";
export { evaluateStopCondition } from "./core/stop.js";
export { readLatestRunBySlug, readRunState, renderRunSummary, writeRunState } from "./core/state-store.js";

export const packageName = "@rlaope/loop";

/** @param {NodeJS.WritableStream} stream */
export function printHelp(stream) {
  stream.write(`Loop Engineering toolkit\n\n`);
  stream.write(`Usage:\n`);
  stream.write(`  loop --help\n`);
  stream.write(`  loop --version\n`);
  stream.write(`  loop --dry-run --objective "<objective>" [--state-dir .loop]\n`);
  stream.write(`  loop --agent codex --objective "<objective>" [--write --isolation local --acknowledge-local]\n`);
  stream.write(`\n`);
  stream.write(`Run without cloning:\n`);
  stream.write(`  npm exec --yes --package github:rlaope/loop -- loop --dry-run --objective "<objective>"\n`);
  stream.write(`\n`);
  stream.write(`Options:\n`);
  stream.write(`  --help, -h       Show this help message.\n`);
  stream.write(`  --version, -v    Show the package version.\n`);
  stream.write(`  --dry-run        Write durable Loop state without source edits.\n`);
  stream.write(`  --agent codex    Run the objective through Codex CLI and record Loop state.\n`);
  stream.write(`  --write          Allow a write-capable agent run. Requires isolation evidence.\n`);
  stream.write(`  --objective      Objective for the Loop run.\n`);
  stream.write(`  --state-dir      Directory for durable Loop state. Defaults to .loop.\n`);
  stream.write(`  --isolation      Write isolation mode: branch, worktree, or local.\n`);
  stream.write(`  --acknowledge-local  Explicitly acknowledge local-mode write risk.\n`);
  stream.write(`  --expected-root  Expected git root for write-capable runs. Defaults to cwd.\n`);
  stream.write(`  --expected-remote  Expected origin URL for write-capable runs.\n`);
  stream.write(`  --allow-no-remote  Allow write-capable runs in a local repo with no origin.\n`);
  stream.write(`\n`);
  stream.write(`Dry-run mode writes durable Loop state only.\n`);
  stream.write(`Agent write mode requires explicit approval, isolation, and repo-boundary checks.\n`);
}
