#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

import {
  appendEvidence,
  checkRepoBoundary,
  createRunState,
  evaluatePolicyGate,
  printHelp,
  recordBudgetActivity,
  transitionRunState,
  writeRunState
} from "../src/index.js";

const args = process.argv.slice(2);
const packageJson = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));

/** @param {string} flag */
function valueFor(flag) {
  const index = args.indexOf(flag);
  if (index === -1) {
    return undefined;
  }
  const value = args[index + 1];
  if (!value || value.startsWith("-")) {
    throw new Error(`${flag} requires a value`);
  }
  return value;
}

/** @param {string} flag */
function has(flag) {
  return args.includes(flag);
}

/**
 * @param {string} objective
 * @param {{ writeMode: boolean }} options
 */
function buildAgentPrompt(objective, { writeMode }) {
  return [
    "You are running under Loop Engineering.",
    "",
    `Objective: ${objective}`,
    "",
    "Loop contract:",
    "- Understand the objective before editing.",
    "- Keep work scoped to the current repository.",
    "- Use the smallest useful implementation path.",
    "- Verify changed behavior with the relevant tests or checks.",
    "- Stop when evidence shows the objective is complete or a blocker requires human judgment.",
    "",
    writeMode
      ? "This run has explicit write approval from the loop CLI invocation."
      : "This run is read-only. Do not modify files."
  ].join("\n");
}

/** @param {{ objective: string, stateDir: string, writeMode: boolean }} options */
async function writeInitialRunState({ objective, stateDir, writeMode }) {
  const now = new Date();
  const state = createRunState({
    objective,
    approvals: writeMode
      ? {
          humanApproval: true,
          approvalScope: ["write"],
          approvalExpiresAt: new Date(now.getTime() + 2 * 60 * 60 * 1000).toISOString()
        }
      : {},
    now
  });
  const active = {
    ...state,
    phase: "act",
    nextAction: writeMode ? "run codex agent with write approval" : "run codex agent read-only"
  };
  const paths = await writeRunState(active, { stateDir });
  return { state: active, paths };
}

/**
 * @param {object} options
 * @param {string} options.objective
 * @param {string} options.stateDir
 * @param {boolean} options.writeMode
 * @param {string | undefined} options.expectedRoot
 * @param {string | undefined} options.expectedRemote
 * @param {boolean} options.allowNoRemote
 * @param {string | undefined} options.isolationMode
 * @param {boolean} options.acknowledgeLocal
 */
async function runCodexAgent({
  objective,
  stateDir,
  writeMode,
  expectedRoot,
  expectedRemote,
  allowNoRemote,
  isolationMode,
  acknowledgeLocal
}) {
  const { state, paths } = await writeInitialRunState({ objective, stateDir, writeMode });
  const gate = evaluatePolicyGate(state, {
    mode: writeMode ? "write" : "read",
    isolationDecision: writeMode
      ? {
          mode: isolationMode,
          acknowledgedRisk: acknowledgeLocal
        }
      : undefined,
    repoBoundary: writeMode
      ? {
          cwd: process.cwd(),
          expectedRoot: expectedRoot ?? process.cwd(),
          expectedRemote,
          allowNoRemote
        }
      : undefined,
    nextActivity: {
      estimatedTokens: 0,
      attempts: 1
    }
  });
  if (!gate.ok) {
    const blocked = transitionRunState(state, gate.outcome === "budget_exhausted" ? "budget_exhausted" : "unsafe", {
      nextAction: gate.reason
    });
    await writeRunState(blocked, { stateDir });
    process.stderr.write(`Policy gate failed: ${gate.reason}\n`);
    process.exit(3);
  }

  const prompt = buildAgentPrompt(objective, { writeMode });
  const result = spawnSync("codex", [
    "exec",
    "--sandbox",
    writeMode ? "workspace-write" : "read-only",
    "--ask-for-approval",
    "never",
    "--cd",
    process.cwd(),
    prompt
  ], {
    encoding: "utf8",
    maxBuffer: 10 * 1024 * 1024
  });

  if (result.stdout) {
    process.stdout.write(result.stdout);
  }
  if (result.stderr) {
    process.stderr.write(result.stderr);
  }

  if (result.error) {
    const failed = transitionRunState(appendEvidence(state, {
      kind: "agent-run",
      status: "failed",
      summary: `Codex agent failed to start: ${result.error.message}`
    }), "failed", {
      nextAction: "install or authenticate Codex CLI, then rerun the loop"
    });
    await writeRunState(failed, { stateDir });
    process.stderr.write(`Codex agent failed to start: ${result.error.message}\n`);
    process.exit(5);
  }

  const exitCode = result.status ?? 1;
  const afterRun = appendEvidence(recordBudgetActivity(state, {
    kind: "agent-run",
    estimatedTokens: 0,
    attempts: 1
  }), {
    kind: "agent-run",
    status: exitCode === 0 ? "passed" : "failed",
    summary: `Codex agent exited with status ${exitCode}.`
  });
  const finalState = exitCode === 0
    ? {
        ...afterRun,
        phase: "verify",
        nextAction: "review agent changes and run project verification"
      }
    : transitionRunState(afterRun, "failed", {
        nextAction: "inspect Codex output and rerun with a smaller objective"
      });
  const finalPaths = await writeRunState(finalState, { stateDir });

  process.stdout.write(`${JSON.stringify({
    ok: exitCode === 0,
    agent: "codex",
    stateId: finalState.id,
    paths: finalPaths,
    initialPaths: paths,
    exitCode
  }, null, 2)}\n`);
  process.exit(exitCode);
}

if (has("--help") || has("-h")) {
  printHelp(process.stdout);
  process.exit(0);
}

if (has("--version") || has("-v")) {
  process.stdout.write(`${packageJson.version}\n`);
  process.exit(0);
}

let objective;
let stateDir;
try {
  objective = valueFor("--objective");
  stateDir = valueFor("--state-dir") ?? ".loop";
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n\n`);
  printHelp(process.stderr);
  process.exit(1);
}

if (!objective) {
  printHelp(process.stderr);
  process.exit(1);
}

if (has("--dry-run")) {
  let stateDir;
  let expectedRoot;
  let expectedRemote;
  try {
    stateDir = valueFor("--state-dir") ?? ".loop";
    expectedRoot = valueFor("--expected-root");
    expectedRemote = valueFor("--expected-remote");
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n\n`);
    printHelp(process.stderr);
    process.exit(1);
  }

  if (expectedRoot || expectedRemote) {
    const boundary = checkRepoBoundary({
      expectedRoot,
      expectedRemote
    });
    if (!boundary.ok) {
      process.stderr.write(`Repo boundary preflight failed:\n${boundary.errors.join("\n")}\n`);
      process.exit(2);
    }
  }

  const initial = createRunState({ objective });
  const gate = evaluatePolicyGate(initial, {
    mode: "read",
    nextActivity: {
      estimatedTokens: 0,
      attempts: 1
    }
  });
  if (!gate.ok) {
    process.stderr.write(`Policy gate failed: ${gate.reason}\n`);
    process.exit(3);
  }

  const budgeted = recordBudgetActivity(initial, {
    kind: "adapter-smoke",
    estimatedTokens: 0,
    attempts: 1
  });
  const state = appendEvidence(budgeted, {
    kind: "dry-run",
    status: "passed",
    summary: "Dry-run recorded durable state without changing source files."
  });
  let paths;
  try {
    paths = await writeRunState(state, { stateDir });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`State write failed: ${message}\n`);
    process.exit(4);
  }

  process.stdout.write(`${JSON.stringify({ ok: true, stateId: state.id, paths }, null, 2)}\n`);
  process.exit(0);
}

let agent;
try {
  agent = valueFor("--agent");
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n\n`);
  printHelp(process.stderr);
  process.exit(1);
}

if (agent) {
  if (agent !== "codex") {
    process.stderr.write(`Unsupported agent: ${agent}\n\n`);
    printHelp(process.stderr);
    process.exit(1);
  }

  let expectedRoot;
  let expectedRemote;
  let isolationMode;
  try {
    expectedRoot = valueFor("--expected-root");
    expectedRemote = valueFor("--expected-remote");
    isolationMode = valueFor("--isolation");
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n\n`);
    printHelp(process.stderr);
    process.exit(1);
  }

  await runCodexAgent({
    objective,
    stateDir,
    writeMode: has("--write") || has("--allow-write"),
    expectedRoot,
    expectedRemote,
    allowNoRemote: has("--allow-no-remote"),
    isolationMode,
    acknowledgeLocal: has("--acknowledge-local")
  });
}

printHelp(process.stderr);
process.exit(1);
