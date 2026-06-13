#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { emitKeypressEvents } from "node:readline";
import { createInterface } from "node:readline/promises";

import {
  appendEvidence,
  checkRepoBoundary,
  createRunState,
  dashboardActionForRun,
  dashboardUrl,
  getDashboardStatus,
  evaluatePolicyGate,
  listWikiNotes,
  printHelp,
  readWikiNote,
  recordBudgetActivity,
  renderWikiList,
  serveWikiDashboard,
  startDetachedWikiDashboard,
  transitionRunState,
  WIKI_FAILURE_EXIT_CODE,
  waitForDashboardReady,
  wikiNotePath,
  writeWikiForRunState,
  writeRunState
} from "../src/index.js";

const rawArgs = process.argv.slice(2);
const command = rawArgs[0] === "run" || rawArgs[0] === "wiki" ? rawArgs[0] : undefined;
const args = command ? rawArgs.slice(1) : rawArgs;
const packageJson = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const flagsWithValues = new Set([
  "--agent",
  "--expected-remote",
  "--expected-root",
  "--host",
  "--isolation",
  "--objective",
  "--port",
  "--state-dir"
]);
const booleanFlags = new Set([
  "--acknowledge-local",
  "--allow-no-remote",
  "--dry-run",
  "--help",
  "--no-interview",
  "--read-only",
  "--version",
  "--wiki-dashboard",
  "-h",
  "-v"
]);
const knownFlags = new Set([...flagsWithValues, ...booleanFlags]);

/** @param {string} arg */
function parseOptionToken(arg) {
  if (!arg.startsWith("-") || arg === "-") {
    return null;
  }
  const equalsIndex = arg.indexOf("=");
  if (equalsIndex === -1) {
    return { name: arg, value: undefined, hasEquals: false };
  }
  return {
    name: arg.slice(0, equalsIndex),
    value: arg.slice(equalsIndex + 1),
    hasEquals: true
  };
}

function validateOptions() {
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--") {
      break;
    }
    const option = parseOptionToken(arg);
    if (!option) {
      continue;
    }
    if (!knownFlags.has(option.name)) {
      throw new Error(`Unknown option: ${option.name}`);
    }
    if (flagsWithValues.has(option.name)) {
      if (option.hasEquals) {
        if (!option.value) {
          throw new Error(`${option.name} requires a value`);
        }
        continue;
      }
      const value = args[index + 1];
      if (!value || value.startsWith("-")) {
        throw new Error(`${option.name} requires a value`);
      }
      index += 1;
      continue;
    }
    if (option.hasEquals) {
      throw new Error(`${option.name} does not take a value`);
    }
  }
}

/** @param {string} flag */
function valueFor(flag) {
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--") {
      break;
    }
    if (arg === flag) {
      return args[index + 1];
    }
    if (arg.startsWith(`${flag}=`)) {
      return arg.slice(flag.length + 1);
    }
  }
  return undefined;
}

/** @param {string} flag */
function has(flag) {
  return args.some((arg) => arg === flag);
}

/** @param {string | undefined} value */
function parsePort(value) {
  if (value === undefined) {
    return 3846;
  }
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Invalid port: ${value}`);
  }
  return port;
}

function dashboardHost() {
  const host = valueFor("--host") ?? "127.0.0.1";
  if (host !== "127.0.0.1") {
    throw new Error("Loop Wiki dashboard only supports 127.0.0.1");
  }
  return host;
}

function dashboardPort() {
  return parsePort(valueFor("--port"));
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
      const option = parseOptionToken(arg);
      if (option && flagsWithValues.has(option.name) && !option.hasEquals) {
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

/**
 * @template T
 * @param {{ title: string, options: Array<{ label: string, value: T }>, escapeIndex?: number }} config
 * @returns {Promise<T>}
 */
async function chooseWithArrows({ title, options, escapeIndex = 0 }) {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error(`${title} requires an interactive terminal`);
  }
  if (options.length === 0) {
    throw new Error(`${title} has no options`);
  }
  emitKeypressEvents(process.stdin);
  const previousRawMode = process.stdin.isRaw;
  let inputRestored = false;
  const restoreInput = () => {
    if (inputRestored) {
      return;
    }
    if (typeof process.stdin.setRawMode === "function") {
      process.stdin.setRawMode(Boolean(previousRawMode));
    }
    process.stdin.pause();
    inputRestored = true;
  };
  if (typeof process.stdin.setRawMode === "function") {
    process.stdin.setRawMode(true);
  }
  process.stdin.resume();
  let selected = 0;
  let renderedLines = 0;
  /** @param {number} lines */
  const clearRenderedLines = (lines) => {
    if (lines > 0) {
      process.stdout.write(`\x1b[${lines}F\x1b[J`);
    }
  };
  const render = () => {
    clearRenderedLines(renderedLines);
    const lines = [
      title,
      "Use arrow keys, then Enter.",
      ...options.map((option, index) => `${index === selected ? "> " : "  "}${index + 1}) ${option.label}`)
    ];
    process.stdout.write(`${lines.join("\n")}\n`);
    renderedLines = lines.length;
  };
  try {
    render();
    return await new Promise((resolve) => {
      /**
       * @param {string} _str
       * @param {{ name?: string, sequence?: string, ctrl?: boolean }} key
       */
      const onKeypress = (_str, key) => {
        const sequence = key.sequence ?? _str;
        if ((key.ctrl === true && key.name === "c") || sequence === "\u0003") {
          cancel();
          return;
        }
        if (key.name === "up" || key.name === "left") {
          selected = selected === 0 ? options.length - 1 : selected - 1;
          render();
          return;
        }
        if (key.name === "down" || key.name === "right" || key.name === "tab") {
          selected = selected === options.length - 1 ? 0 : selected + 1;
          render();
          return;
        }
        if (key.name === "escape") {
          const escapeOption = options[escapeIndex] ?? options[0];
          cleanup(escapeOption.value, escapeOption.label);
          return;
        }
        if (key.name === "return" || key.name === "enter" || sequence === "\r" || sequence === "\n") {
          cleanup(options[selected].value, options[selected].label);
        }
      };
      /**
       * @param {T} value
       * @param {string} [label]
       */
      const cleanup = (value, label) => {
        process.stdin.off("keypress", onKeypress);
        clearRenderedLines(renderedLines);
        if (label) {
          process.stdout.write(`${title} ${label}\n`);
        }
        renderedLines = 0;
        resolve(value);
      };
      const cancel = () => {
        process.stdin.off("keypress", onKeypress);
        clearRenderedLines(renderedLines);
        process.stdout.write(`${title} cancelled\n`);
        renderedLines = 0;
        restoreInput();
        process.exit(130);
      };
      process.stdin.on("keypress", onKeypress);
    });
  } finally {
    restoreInput();
  }
}

/** @returns {Promise<"codex" | "claudecode">} */
async function chooseAgent() {
  try {
    const selectedAgent = await chooseWithArrows({
      title: "Select coding agent:",
      options: [
        { label: "codex", value: "codex" },
        { label: "claudecode", value: "claudecode" }
      ]
    });
    return selectedAgent === "codex" ? "codex" : "claudecode";
  } catch (error) {
    if (error instanceof Error && error.message.includes("requires an interactive terminal")) {
      throw new Error("loop run requires --agent codex or --agent claudecode in non-interactive mode");
    }
    throw error;
  }
}

async function chooseDashboardStart() {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    return false;
  }
  return chooseWithArrows({
    title: "Start Loop Wiki dashboard:",
    escapeIndex: 1,
    options: [
      { label: "Yes", value: true },
      { label: "No", value: false }
    ]
  });
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

/** @param {unknown} error */
function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

/**
 * @param {string} target
 */
function openTarget(target) {
  if (!process.stdout.isTTY) {
    return;
  }
  /** @type {Partial<Record<NodeJS.Platform, string>>} */
  const commandByPlatform = {
    darwin: "open",
    win32: "cmd",
    linux: "xdg-open"
  };
  const opener = commandByPlatform[process.platform];
  if (!opener) {
    return;
  }
  const argsForOpen = process.platform === "win32" ? ["/c", "start", "", target] : [target];
  spawnSync(opener, argsForOpen, { stdio: "ignore" });
}

/** @param {string} cwd */
function initializeGitBoundary(cwd) {
  const result = spawnSync("git", ["init"], {
    cwd,
    encoding: "utf8"
  });
  if (result.error) {
    throw new Error(`Loop could not initialize a local git repository in ${cwd}: ${result.error.message}`);
  }
  if (result.status !== 0) {
    const detail = (result.stderr || result.stdout || `git exited with status ${result.status}`).trim();
    throw new Error(`Loop could not initialize a local git repository in ${cwd}: ${detail}`);
  }
}

/**
 * @param {{ writeMode: boolean, expectedRoot?: string }} options
 */
function ensureProjectBoundary({ writeMode, expectedRoot }) {
  if (!writeMode || expectedRoot) {
    return;
  }
  const cwd = process.cwd();
  if (existsSync(join(cwd, ".git"))) {
    return;
  }
  initializeGitBoundary(cwd);
  process.stderr.write(`Loop initialized a local git repository in ${cwd} to bound this run.\n`);
}

async function handleWikiCommand() {
  let stateDir;
  try {
    stateDir = valueFor("--state-dir") ?? ".loop";
  } catch (error) {
    process.stderr.write(`${errorMessage(error)}\n\n`);
    printHelp(process.stderr);
    process.exit(1);
  }

  const positionals = positionalArgs();
  const subcommand = positionals[0] ?? "serve";
  const id = positionals[1];

  if (subcommand === "list") {
    try {
      const notes = await listWikiNotes({ stateDir });
      process.stdout.write(renderWikiList(notes));
      process.exit(0);
    } catch (error) {
      process.stderr.write(`Wiki list failed: ${errorMessage(error)}\n`);
      process.exit(1);
    }
  }

  if (subcommand === "read") {
    if (!id) {
      process.stderr.write("loop wiki read requires a note id\n");
      process.exit(1);
    }
    try {
      const note = await readWikiNote(id, { stateDir });
      process.stdout.write(note.markdown);
      process.exit(0);
    } catch (error) {
      process.stderr.write(`Wiki note read failed: ${errorMessage(error)}\n`);
      process.exit(1);
    }
  }

  if (subcommand === "open") {
    if (!id) {
      process.stderr.write("loop wiki open requires a note id\n");
      process.exit(1);
    }
    try {
      await readWikiNote(id, { stateDir });
      const notePath = wikiNotePath({ stateDir, id });
      process.stdout.write(`${notePath}\n`);
      openTarget(notePath);
      process.exit(0);
    } catch (error) {
      process.stderr.write(`Wiki note open failed: ${errorMessage(error)}\n`);
      process.exit(1);
    }
  }

  if (subcommand === "serve") {
    let host;
    let port;
    try {
      host = dashboardHost();
      port = dashboardPort();
    } catch (error) {
      process.stderr.write(`${errorMessage(error)}\n\n`);
      printHelp(process.stderr);
      process.exit(1);
    }
    try {
      const served = await serveWikiDashboard({ stateDir, host, port });
      process.stdout.write(`Loop Wiki dashboard: ${served.url}\n`);
      if (served.server) {
        await new Promise(() => {});
      }
      process.exit(0);
    } catch (error) {
      process.stderr.write(`Loop Wiki dashboard failed: ${errorMessage(error)}\n`);
      process.exit(1);
    }
  }

  process.stderr.write(`Unknown wiki command: ${subcommand}\n\n`);
  printHelp(process.stderr);
  process.exit(1);
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
 * @param {import("../src/core/run-state.js").LoopRunState} state
 * @param {{ jsonPath?: string, summaryPath?: string }} paths
 * @param {{ stateDir: string, context: string }} options
 */
async function writeWikiOrExit(state, paths, { stateDir, context }) {
  try {
    return await writeWikiForRunState(state, { stateDir, paths });
  } catch (error) {
    process.stderr.write(`Wiki write failed after durable state write: ${errorMessage(error)}\n`);
    process.stderr.write(`Context: ${context}\n`);
    if (paths.jsonPath || paths.summaryPath) {
      process.stderr.write(`Durable state paths: ${JSON.stringify(paths)}\n`);
    }
    process.exit(WIKI_FAILURE_EXIT_CODE);
  }
}

/**
 * @param {{ stateDir: string, explicitFlag: boolean, host: string, port: number }} options
 */
async function maybeStartDashboardForRun({ stateDir, explicitFlag, host, port }) {
  const status = await getDashboardStatus({ host, port });
  if (status.occupied) {
    process.stderr.write(`Loop Wiki dashboard port ${port} is occupied by another service; not starting dashboard.\n`);
    return;
  }
  let consent = false;
  const initialAction = dashboardActionForRun({
    dashboardRunning: status.running,
    stdinTTY: Boolean(process.stdin.isTTY),
    stdoutTTY: Boolean(process.stdout.isTTY),
    explicitFlag
  });
  let action = initialAction;
  if (initialAction === "ask") {
    consent = await chooseDashboardStart();
    action = dashboardActionForRun({
      dashboardRunning: false,
      stdinTTY: true,
      stdoutTTY: true,
      explicitFlag: false,
      userConsent: consent
    });
  }
  if (action !== "start") {
    return;
  }
  const pid = startDetachedWikiDashboard({
    scriptPath: new URL(import.meta.url).pathname,
    stateDir,
    host,
    port
  });
  const ready = await waitForDashboardReady({ host, port });
  if (ready.running) {
    process.stdout.write(`Loop Wiki dashboard: ${dashboardUrl({ host, port })}\n`);
    return;
  }
  process.stderr.write(`Loop Wiki dashboard did not confirm startup${pid ? ` (pid ${pid})` : ""}.\n`);
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
        "--ask-for-approval",
        "never",
        "exec",
        "--sandbox",
        writeMode ? "workspace-write" : "read-only",
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
 * @param {boolean} options.wikiDashboard
 * @param {string} options.dashboardHost
 * @param {number} options.dashboardPort
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
  acknowledgeLocal,
  wikiDashboard,
  dashboardHost: host,
  dashboardPort: port
}) {
  ensureProjectBoundary({ writeMode, expectedRoot });
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

  await writeWikiOrExit(state, paths, { stateDir, context: "initial run state" });
  await maybeStartDashboardForRun({
    stateDir,
    explicitFlag: wikiDashboard,
    host,
    port
  });

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
    const failedPaths = await writeRunState(failed, { stateDir });
    await writeWikiOrExit(failed, failedPaths, { stateDir, context: "agent start failure" });
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
  const wikiPaths = await writeWikiOrExit(finalState, finalPaths, { stateDir, context: "final run state" });

  process.stdout.write(`${JSON.stringify({
    ok: exitCode === 0,
    agent,
    stateId: finalState.id,
    paths: finalPaths,
    wikiPaths,
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

try {
  validateOptions();
} catch (error) {
  process.stderr.write(`${errorMessage(error)}\n\n`);
  printHelp(process.stderr);
  process.exit(1);
}

if (command === "wiki") {
  await handleWikiCommand();
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

const isRunMode = command === "run" || has("--agent") || !command;

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
  const wikiPaths = await writeWikiOrExit(state, paths, { stateDir, context: "dry-run state" });

  process.stdout.write(`${JSON.stringify({ ok: true, stateId: state.id, paths, wikiPaths }, null, 2)}\n`);
  process.exit(0);
}

if (isRunMode) {
  let resolvedAgent;
  let expectedRoot;
  let expectedRemote;
  let isolationMode;
  let host;
  let port;
  try {
    resolvedAgent = normalizeAgent(valueFor("--agent")) ?? await chooseAgent();
    expectedRoot = valueFor("--expected-root");
    expectedRemote = valueFor("--expected-remote");
    isolationMode = valueFor("--isolation") ?? "local";
    host = dashboardHost();
    port = dashboardPort();
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
    allowNoRemote: has("--allow-no-remote") || isRunMode,
    isolationMode,
    acknowledgeLocal: has("--acknowledge-local") || isRunMode,
    wikiDashboard: has("--wiki-dashboard"),
    dashboardHost: host,
    dashboardPort: port
  });
}

printHelp(process.stderr);
process.exit(1);
