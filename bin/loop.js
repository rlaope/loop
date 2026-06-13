#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createInterface } from "node:readline/promises";

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

const rawArgs = process.argv.slice(2);
const command = rawArgs[0] === "run" ? "run" : undefined;
const args = command ? rawArgs.slice(1) : rawArgs;
const packageJson = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const flagsWithValues = new Set([
  "--agent",
  "--expected-remote",
  "--expected-root",
  "--isolation",
  "--objective",
  "--state-dir"
]);

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

function positionalArgs() {
  /** @type {string[]} */
  const positional = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--") {
      positional.push(...args.slice(index + 1));
      break;
    }
    if (arg.startsWith("-")) {
      if (flagsWithValues.has(arg)) {
        index += 1;
      }
      continue;
    }
    positional.push(arg);
  }
  return positional;
}

function objectiveFromArgs() {
  return valueFor("--objective") ?? positionalArgs().join(" ").trim();
}

/**
 * @param {string | undefined} agent
 * @returns {"codex" | "claudecode" | undefined}
 */
function normalizeAgent(agent) {
  if (!agent) {
    return undefined;
  }
  if (agent === "codex") {
    return "codex";
  }
  if (agent === "claudecode" || agent === "claude") {
    return "claudecode";
  }
  throw new Error(`Unsupported agent: ${agent}`);
}

/** @param {string} objective */
function needsDeepInterview(objective) {
  const trimmed = objective.trim();
  if (has("--no-interview")) {
    return false;
  }
  if (trimmed.length < 28) {
    return true;
  }
  const actionPattern = /build|create|make|implement|fix|design|ship|만들|구현|수정|추가|설계|제작|개발|빌드/i;
  const artifactPattern = /site|app|cli|tool|page|feature|workflow|adapter|웹|앱|사이트|페이지|기능|도구|전시|MVP/i;
  return !actionPattern.test(trimmed) || !artifactPattern.test(trimmed);
}

/**
 * @param {import("node:readline/promises").Interface} rl
 * @param {string} question
 */
async function askRequired(rl, question) {
  while (true) {
    const answer = (await rl.question(question)).trim();
    if (answer) {
      return answer;
    }
  }
}

async function chooseAgent() {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error("loop run requires --agent codex or --agent claudecode in non-interactive mode");
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    process.stdout.write("Select coding agent:\n");
    process.stdout.write("  1) codex\n");
    process.stdout.write("  2) claudecode\n");
    const answer = (await rl.question("Agent [codex]: ")).trim().toLowerCase();
    if (!answer || answer === "1" || answer === "codex") {
      return "codex";
    }
    if (answer === "2" || answer === "claude" || answer === "claudecode") {
      return "claudecode";
    }
    throw new Error(`Unsupported agent selection: ${answer}`);
  } finally {
    rl.close();
  }
}

/** @param {string} objective */
async function clarifyObjective(objective) {
  if (!needsDeepInterview(objective)) {
    return objective;
  }
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error("ambiguous loop objective requires an interactive terminal or --no-interview");
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    process.stdout.write("Loop needs a clearer goal before it can run.\n");
    const outcome = await askRequired(rl, "What should be built or changed? ");
    const evidence = await askRequired(rl, "What evidence proves it is done? ");
    const constraints = await askRequired(rl, "Any constraints, stack, style, or safety notes? ");
    return [
      objective,
      "",
      "Clarified Loop goal:",
      `- Target outcome: ${outcome}`,
      `- Completion evidence: ${evidence}`,
      `- Constraints: ${constraints}`
    ].join("\n");
  } finally {
    rl.close();
  }
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
    "- Leave a concise human-readable summary of what changed and what remains risky.",
    "",
    writeMode
      ? "This run has explicit write approval from the loop CLI invocation."
      : "This run is read-only. Do not modify files."
  ].join("\n");
}

/** @param {{ objective: string, stateDir: string, writeMode: boolean, agent: string }} options */
async function writeInitialRunState({ objective, stateDir, writeMode, agent }) {
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
    nextAction: writeMode ? `run ${agent} agent with write approval` : `run ${agent} agent read-only`
  };
  const paths = await writeRunState(active, { stateDir });
  return { state: active, paths };
}

/**
 * @param {"codex" | "claudecode"} agent
 * @param {string} prompt
 * @param {boolean} writeMode
 */
function agentCommand(agent, prompt, writeMode) {
  if (agent === "codex") {
    return {
      command: "codex",
      args: [
        "exec",
        "--sandbox",
        writeMode ? "workspace-write" : "read-only",
        "--ask-for-approval",
        "never",
        "--cd",
        process.cwd(),
        prompt
      ]
    };
  }
  return {
    command: "claude",
    args: [
      "--print",
      "--permission-mode",
      writeMode ? "acceptEdits" : "plan",
      prompt
    ]
  };
}

/**
 * @param {object} options
 * @param {"codex" | "claudecode"} options.agent
 * @param {string} options.objective
 * @param {string} options.stateDir
 * @param {boolean} options.writeMode
 * @param {string | undefined} options.expectedRoot
 * @param {string | undefined} options.expectedRemote
 * @param {boolean} options.allowNoRemote
 * @param {string | undefined} options.isolationMode
 * @param {boolean} options.acknowledgeLocal
 */
async function runAgent({
  agent,
  objective,
  stateDir,
  writeMode,
  expectedRoot,
  expectedRemote,
  allowNoRemote,
  isolationMode,
  acknowledgeLocal
}) {
  const { state, paths } = await writeInitialRunState({ objective, stateDir, writeMode, agent });
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
  const command = agentCommand(agent, prompt, writeMode);
  const result = spawnSync(command.command, command.args, {
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
      summary: `${agent} agent failed to start: ${result.error.message}`
    }), "failed", {
      nextAction: `install or authenticate ${agent}, then rerun the loop`
    });
    await writeRunState(failed, { stateDir });
    process.stderr.write(`${agent} agent failed to start: ${result.error.message}\n`);
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
    summary: `${agent} agent exited with status ${exitCode}.`
  });
  const finalState = exitCode === 0
    ? {
        ...afterRun,
        phase: "verify",
        nextAction: "review agent changes and run project verification"
      }
    : transitionRunState(afterRun, "failed", {
        nextAction: `inspect ${agent} output and rerun with a smaller objective`
      });
  const finalPaths = await writeRunState(finalState, { stateDir });

  process.stdout.write(`${JSON.stringify({
    ok: exitCode === 0,
    agent,
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
  objective = objectiveFromArgs();
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
  let expectedRoot;
  let expectedRemote;
  try {
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

if (command === "run" || has("--agent")) {
  let resolvedAgent;
  let expectedRoot;
  let expectedRemote;
  let isolationMode;
  try {
    resolvedAgent = normalizeAgent(valueFor("--agent")) ?? await chooseAgent();
    expectedRoot = valueFor("--expected-root");
    expectedRemote = valueFor("--expected-remote");
    isolationMode = valueFor("--isolation") ?? "local";
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n\n`);
    printHelp(process.stderr);
    process.exit(1);
  }

  let clarifiedObjective;
  try {
    clarifiedObjective = await clarifyObjective(objective);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n\n`);
    printHelp(process.stderr);
    process.exit(1);
  }

  await runAgent({
    agent: resolvedAgent,
    objective: clarifiedObjective,
    stateDir,
    writeMode: !has("--read-only"),
    expectedRoot,
    expectedRemote,
    allowNoRemote: has("--allow-no-remote") || command === "run",
    isolationMode,
    acknowledgeLocal: has("--acknowledge-local") || command === "run"
  });
}

printHelp(process.stderr);
process.exit(1);
