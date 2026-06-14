export { allOutcomes, isKnownOutcome, isTerminalOutcome, nonTerminalOutcomes, terminalOutcomes } from "./core/outcomes.js";
export { evaluateBudget, recordBudgetActivity } from "./core/budget.js";
export { hasActiveApproval, requireWriteApproval } from "./core/approval.js";
export { checkIsolationDecision, checkRepoBoundary } from "./core/preflight.js";
export { evaluatePolicyGate } from "./core/policy.js";
export { appendEvidence, createRunState, slugifyObjective, transitionRunState } from "./core/run-state.js";
export { assertValidRunState, validateRunState } from "./core/schema.js";
export { evaluateStopCondition } from "./core/stop.js";
export { readLatestRunBySlug, readRunState, renderRunSummary, writeRunState } from "./core/state-store.js";
export {
  listWikiNotes,
  noteIdForRunState,
  readWikiIndex,
  readWikiNote,
  renderMarkdownHtml,
  renderWikiDashboardHtml,
  renderWikiGraphHtml,
  renderWikiList,
  renderWikiNote,
  wikiNotePath,
  writeWikiForRunState
} from "./core/wiki-store.js";
export {
  DEFAULT_WIKI_HOST,
  DEFAULT_WIKI_PORT,
  WIKI_FAILURE_EXIT_CODE,
  assertWikiDashboardHost,
  dashboardActionForRun,
  dashboardUrl,
  getDashboardStatus,
  serveWikiDashboard,
  startDetachedWikiDashboard,
  waitForDashboardReady
} from "./core/wiki-dashboard.js";

export const packageName = "@rlaope/loop";

/** @param {NodeJS.WritableStream} stream */
export function printHelp(stream) {
  stream.write(`Loop Engineering toolkit\n\n`);
  stream.write(`Usage:\n`);
  stream.write(`  loop --help\n`);
  stream.write(`  loop --version\n`);
  stream.write(`  loop "prompt"\n`);
  stream.write(`  loop run "prompt"\n`);
  stream.write(`  loop run --agent codex "prompt"\n`);
  stream.write(`  loop run --agent claudecode "prompt"\n`);
  stream.write(`  loop wiki [list|read <id>|open <id>|serve]\n`);
  stream.write(`  loop --dry-run --objective "<objective>" [--state-dir .loop]\n`);
  stream.write(`\n`);
  stream.write(`Run without cloning:\n`);
  stream.write(`  npm exec --yes --package github:rlaope/loop -- loop "<objective>"\n`);
  stream.write(`\n`);
  stream.write(`Options:\n`);
  stream.write(`  --help, -h       Show this help message.\n`);
  stream.write(`  --version, -v    Show the package version.\n`);
  stream.write(`  --dry-run        Write durable Loop state without source edits.\n`);
  stream.write(`  --agent          Select codex or claudecode without the 1/2 prompt.\n`);
  stream.write(`  --read-only      Run the selected agent without write permissions.\n`);
  stream.write(`  --objective      Objective for the Loop run.\n`);
  stream.write(`  --state-dir      Directory for durable Loop state. Defaults to .loop.\n`);
  stream.write(`  --wiki-dashboard  Start the local Loop Wiki dashboard during run mode.\n`);
  stream.write(`  --port           Port for Loop Wiki dashboard. Defaults to 3846.\n`);
  stream.write(`  --isolation      Write isolation mode: branch, worktree, or local.\n`);
  stream.write(`  --acknowledge-local  Explicitly acknowledge local-mode write risk.\n`);
  stream.write(`  --expected-root  Expected git root for write-capable runs. Defaults to cwd.\n`);
  stream.write(`  --expected-remote  Expected origin URL for write-capable runs.\n`);
  stream.write(`  --allow-no-remote  Allow write-capable runs in a local repo with no origin.\n`);
  stream.write(`  --no-interview   Skip ambiguity interview for automation or tests.\n`);
  stream.write(`\n`);
  stream.write(`Dry-run mode writes durable Loop state and local wiki artifacts only.\n`);
  stream.write(`Run mode records state, creates a local git boundary when needed, asks clarifying questions, then launches the selected agent.\n`);
  stream.write(`Wiki mode reads local .loop/wiki notes and opens a localhost dashboard.\n`);
}
