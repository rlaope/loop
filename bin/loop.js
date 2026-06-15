#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync, watchFile, unwatchFile } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";

import {
  appendEvidence,
  agentCommand,
  buildAgentPrompt,
  checkRepoBoundary,
  createRunState,
  dashboardActionForRun,
  dashboardUrl,
  deleteRunState,
  deleteWikiNote,
  doctorExitCode,
  getDashboardStatus,
  evaluatePolicyGate,
  listRunStates,
  listWikiNotes,
  loopNotificationPayload,
  noArgTuiDispatch,
  sendLoopNotification,
  shouldSendLoopNotification,
  openTarget,
  printHelp,
  readRunLog,
  readRunState,
  readWikiNote,
  recordBudgetActivity,
  renderDemoGuide,
  renderDoctorReport,
  renderWikiList,
  runLogPath,
  runAgentProcess,
  runDoctorChecks,
  runLoopTui,
  scriptPathFromImportMetaUrl,
  serveWikiDashboard,
  startDetachedWikiDashboard,
  transitionRunState,
  WIKI_FAILURE_EXIT_CODE,
  waitForDashboardReady,
  wikiNotePath,
  writeWikiForRunState,
  writeWikiSupportingNote,
  writeRunState
} from "../src/index.js";

const rawArgs = process.argv.slice(2);
const knownCommands = new Set(["run", "wiki", "status", "runs", "logs", "doctor", "demo"]);
const command = knownCommands.has(rawArgs[0]) ? rawArgs[0] : undefined;
const args = command ? rawArgs.slice(1) : rawArgs;
const packageJson = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const flagsWithValues = new Set([
  "--agent",
  "--expected-remote",
  "--expected-root",
  "--host",
  "--isolation",
  "--body",
  "--kind",
  "--lineage-source",
  "--objective",
  "--parent",
  "--parent-run",
  "--port",
  "--run",
  "--state-dir",
  "--title"
]);
const booleanFlags = new Set([
  "--acknowledge-local",
  "--allow-no-remote",
  "--dry-run",
  "--help",
  "--follow",
  "--no-interview",
  "--no-notify",
  "--read-only",
  "--stdin",
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

/** @param {string | undefined} source */
function normalizeLineageSource(source) {
  if (!source) {
    return undefined;
  }
  if (source === "tui" || source === "dashboard" || source === "cli") {
    return source;
  }
  throw new Error(`Unsupported lineage source: ${source}`);
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
 * @param {{ title: string, options: Array<{ label: string, value: T }>, defaultIndex?: number }} config
 * @returns {Promise<T>}
 */
async function chooseByNumber({ title, options, defaultIndex = 0 }) {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error(`${title} requires an interactive terminal`);
  }
  if (options.length === 0) {
    throw new Error(`${title} has no options`);
  }
  const safeDefaultIndex = options[defaultIndex] ? defaultIndex : 0;
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    process.stdout.write(`${title}\n`);
    for (const [index, option] of options.entries()) {
      process.stdout.write(`  ${index + 1}) ${option.label}\n`);
    }
    while (true) {
      const answer = (await rl.question(`Select [${safeDefaultIndex + 1}]: `)).trim();
      const selectedIndex = answer === "" ? safeDefaultIndex : Number(answer) - 1;
      const selected = options[selectedIndex];
      if (Number.isInteger(selectedIndex) && selected) {
        process.stdout.write(`${title} ${selected.label}\n`);
        return selected.value;
      }
      process.stdout.write(`Enter a number from 1 to ${options.length}.\n`);
    }
  } finally {
    rl.close();
  }
}

/** @returns {Promise<"codex" | "claudecode">} */
async function chooseAgent() {
  try {
    const selectedAgent = await chooseByNumber({
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
  return chooseByNumber({
    title: "Start Loop Wiki dashboard:",
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
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * @param {unknown} state
 */
function sessionFromState(state) {
  if (!isRecord(state) || !isRecord(state.session)) {
    return null;
  }
  return state.session;
}

/**
 * @param {number | null | undefined} pid
 */
function isPidAlive(pid) {
  if (!pid) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * @param {import("../src/core/run-state.js").LoopRunState} state
 */
function runtimeLabel(state) {
  const session = sessionFromState(state);
  if (!session) {
    return state.status === "active" ? "state active, no agent session recorded" : state.status;
  }
  const agent = typeof session.agent === "string" ? session.agent : "agent";
  const status = typeof session.status === "string" ? session.status : "recorded";
  const pid = typeof session.pid === "number" ? session.pid : null;
  if (status === "running") {
    return isPidAlive(pid) ? `${agent} running (pid ${pid})` : `${agent} marked running, pid not alive`;
  }
  if (status === "exited") {
    const exitCode = typeof session.exitCode === "number" ? session.exitCode : "?";
    return `${agent} exited (${exitCode})`;
  }
  return `${agent} ${status}`;
}

/** @param {string} value @param {number} maxLength */
function truncate(value, maxLength) {
  return value.length <= maxLength ? value : `${value.slice(0, maxLength - 1)}…`;
}

/**
 * @param {{ stateDir?: string }} [options]
 */
async function latestRun({ stateDir = ".loop" } = {}) {
  const runs = await listRunStates({ stateDir });
  return runs[0] ?? null;
}

/**
 * @param {{ stateDir?: string }} [options]
 */
async function handleStatusCommand({ stateDir = ".loop" } = {}) {
  const runs = await listRunStates({ stateDir });
  if (runs.length === 0) {
    process.stdout.write("No Loop runs found.\n");
    return;
  }
  const running = runs.filter(({ state }) => {
    const session = sessionFromState(state);
    return session && session.status === "running" && isPidAlive(typeof session.pid === "number" ? session.pid : null);
  });
  if (running.length > 0) {
    process.stdout.write("Running agent sessions:\n");
    for (const { state, logPath } of running) {
      process.stdout.write(`- ${state.id}\n`);
      process.stdout.write(`  ${runtimeLabel(state)}\n`);
      process.stdout.write(`  Objective: ${state.objective}\n`);
      process.stdout.write(`  Log: ${logPath}\n`);
    }
    return;
  }
  const latest = runs[0];
  process.stdout.write("No agent process is currently running.\n");
  process.stdout.write(`Latest run: ${latest.state.id}\n`);
  process.stdout.write(`Runtime: ${runtimeLabel(latest.state)}\n`);
  process.stdout.write(`Phase/status: ${latest.state.phase}/${latest.state.status}\n`);
  process.stdout.write(`Next action: ${latest.state.nextAction}\n`);
  process.stdout.write(`Log: ${latest.logPath}\n`);
}

/**
 * @param {{ stateDir?: string }} [options]
 */
async function handleRunsCommand({ stateDir = ".loop" } = {}) {
  const positionals = positionalArgs();
  if (positionals[0] === "delete") {
    const id = positionals[1];
    if (!id) {
      process.stderr.write("loop runs delete requires a run id\n");
      process.exit(1);
    }
    await deleteRunState(id, { stateDir });
    process.stdout.write(`Deleted run ${id}\n`);
    return;
  }
  const runs = await listRunStates({ stateDir });
  if (runs.length === 0) {
    process.stdout.write("No Loop runs found.\n");
    return;
  }
  process.stdout.write("| Run ID | Runtime | Phase | Updated | Objective |\n");
  process.stdout.write("| --- | --- | --- | --- | --- |\n");
  for (const { state } of runs) {
    process.stdout.write(`| ${state.id} | ${runtimeLabel(state)} | ${state.phase}/${state.status} | ${state.updatedAt} | ${truncate(state.objective.replace(/\|/g, "\\|"), 80)} |\n`);
  }
}

/**
 * @param {string} path
 * @param {number} offset
 */
function readFileFrom(path, offset) {
  const text = readFileSync(path, "utf8");
  return {
    text: text.slice(offset),
    offset: text.length
  };
}

/**
 * @param {{ stateDir?: string }} [options]
 */
async function handleLogsCommand({ stateDir = ".loop" } = {}) {
  const positionals = positionalArgs();
  const id = positionals[0] && positionals[0] !== "follow" ? positionals[0] : (await latestRun({ stateDir }))?.state.id;
  if (!id) {
    process.stdout.write("No Loop runs found.\n");
    return;
  }
  const logPath = runLogPath({ stateDir, id });
  const existing = await readRunLog(id, { stateDir });
  process.stdout.write(existing || `No log output recorded yet for ${id}.\n`);
  if (!has("--follow")) {
    return;
  }
  let offset = existing.length;
  process.stderr.write(`Following ${logPath}. Press Ctrl-C to stop.\n`);
  await new Promise(() => {
    setInterval(() => {}, 2 ** 31 - 1);
    watchFile(logPath, { interval: 500 }, () => {
      try {
        const next = readFileFrom(logPath, offset);
        offset = next.offset;
        if (next.text) {
          process.stdout.write(next.text);
        }
      } catch {
        unwatchFile(logPath);
      }
    });
  });
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

/** @param {string} value */
function realPathOrResolve(value) {
  try {
    return realpathSync(value);
  } catch {
    return resolve(value);
  }
}

/**
 * @param {{ writeMode: boolean, expectedRoot?: string }} options
 */
function ensureProjectBoundary({ writeMode, expectedRoot }) {
  if (!writeMode || expectedRoot) {
    return;
  }
  const cwd = realPathOrResolve(process.cwd());
  const homeDirs = new Set([homedir(), process.env.HOME].filter(Boolean).map((dir) => realPathOrResolve(String(dir))));
  if (homeDirs.has(cwd)) {
    throw new Error(`Loop refuses to run write-capable agents from your home directory (${cwd}). Change into the project folder first, for example: cd /path/to/project && loop "your objective".`);
  }
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

  if (subcommand === "add") {
    const afterAdd = positionals.slice(1);
    const explicitKind = valueFor("--kind");
    const explicitTitle = valueFor("--title");
    const explicitBody = valueFor("--body");
    const positionalLooksTyped = !explicitKind && afterAdd.length >= 3;
    const kind = explicitKind ?? (positionalLooksTyped ? afterAdd[0] : "note");
    const title = explicitTitle ?? (positionalLooksTyped ? afterAdd[1] : afterAdd[0]);
    const body = has("--stdin")
      ? readFileSync(0, "utf8")
      : (explicitBody ?? (positionalLooksTyped ? afterAdd.slice(2).join(" ") : afterAdd.slice(1).join(" ")));
    if (!title) {
      process.stderr.write("loop wiki add requires --title or a title argument\n");
      process.exit(1);
    }
    if (!body.trim()) {
      process.stderr.write("loop wiki add requires --body, --stdin, or a body argument\n");
      process.exit(1);
    }
    try {
      const result = await writeWikiSupportingNote({
        stateDir,
        runId: valueFor("--run"),
        parentId: valueFor("--parent"),
        kind,
        title,
        body
      });
      process.stdout.write(`Added wiki ${result.kind} note ${result.id}\n`);
      process.stdout.write(`${result.notePath}\n`);
      process.exit(0);
    } catch (error) {
      process.stderr.write(`Wiki note add failed: ${errorMessage(error)}\n`);
      process.exit(1);
    }
  }

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

  if (subcommand === "delete") {
    if (!id) {
      process.stderr.write("loop wiki delete requires a note id\n");
      process.exit(1);
    }
    try {
      const result = await deleteWikiNote(id, { stateDir });
      process.stdout.write(result.deleted ? `Deleted wiki note ${id}\n` : `Wiki note ${id} was already absent\n`);
      process.exit(0);
    } catch (error) {
      process.stderr.write(`Wiki note delete failed: ${errorMessage(error)}\n`);
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
      openTarget(served.url);
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

/** @param {{ objective: string, stateDir: string, writeMode: boolean, agent: string, lineage?: import("../src/core/run-state.js").RunLineage }} options */
async function writeInitialRunState({ objective, stateDir, writeMode, agent, lineage }) {
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
    lineage,
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
 * @param {"policy-blocked" | "run-started" | "agent-start-failed" | "run-finished"} event
 * @param {{
 *   agent?: string,
 *   objective: string,
 *   runId?: string,
 *   reason?: string,
 *   dashboardUrl?: string,
 *   exitCode?: number
 * }} input
 * @param {boolean} enabled
 */
function notifyLoopEvent(event, input, enabled) {
  if (!input.runId || !shouldSendLoopNotification({
    enabled,
    env: process.env,
    stdoutTTY: Boolean(process.stdout.isTTY),
    stderrTTY: Boolean(process.stderr.isTTY)
  })) {
    return;
  }
  try {
    sendLoopNotification(loopNotificationPayload(event, {
      ...input,
      runId: input.runId
    }));
  } catch {
    // Notifications are intentionally best-effort; the loop state is canonical.
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
  const url = dashboardUrl({ host, port });
  if (status.running) {
    if (process.stdout.isTTY || explicitFlag) {
      process.stdout.write(`Loop Wiki dashboard: ${url}\n`);
    }
    openTarget(url);
    return;
  }
  let consent = false;
  const initialAction = dashboardActionForRun({
    dashboardRunning: false,
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
    scriptPath: scriptPathFromImportMetaUrl(import.meta.url),
    stateDir,
    host,
    port
  });
  const ready = await waitForDashboardReady({ host, port });
  if (ready.running) {
    process.stdout.write(`Loop Wiki dashboard: ${url}\n`);
    openTarget(url);
    return;
  }
  process.stderr.write(`Loop Wiki dashboard did not confirm startup${pid ? ` (pid ${pid})` : ""}.\n`);
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
 * @param {string | undefined} options.parentRunId
 * @param {"tui" | "dashboard" | "cli" | undefined} options.lineageSource
 * @param {boolean} options.notificationsEnabled
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
  dashboardPort: port,
  parentRunId,
  lineageSource,
  notificationsEnabled
}) {
  try {
    ensureProjectBoundary({ writeMode, expectedRoot });
  } catch (error) {
    process.stderr.write(`Project boundary failed: ${errorMessage(error)}\n`);
    process.exit(2);
  }
  /** @type {import("../src/core/run-state.js").RunLineage | undefined} */
  let lineage;
  if (parentRunId) {
    const parent = await readRunState(parentRunId, { stateDir });
    if (!parent.ok) {
      process.stderr.write(`Parent run not found for follow-up: ${parentRunId}\n`);
      process.exit(1);
    }
    lineage = {
      parentRunId,
      rootRunId: parent.state.lineage?.rootRunId ?? parent.state.id,
      relationship: "continues",
      prompt: objective,
      createdFrom: lineageSource ?? "cli"
    };
  }
  const { state, paths } = await writeInitialRunState({ objective, stateDir, writeMode, agent, lineage });
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
    notifyLoopEvent("policy-blocked", {
      reason: gate.reason,
      runId: state.id,
      objective
    }, notificationsEnabled);
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
  const url = dashboardUrl({ host, port });
  const result = await runAgentProcess(command, {
    agent,
    state,
    stateDir,
    onStarted: async (runningState, runningPaths) => {
      await writeWikiOrExit(runningState, runningPaths, { stateDir, context: "running agent session" });
      notifyLoopEvent("run-started", {
        agent,
        dashboardUrl: url,
        runId: runningState.id,
        objective
      }, notificationsEnabled);
      process.stderr.write(`Loop agent session: ${runningState.id}\n`);
      process.stderr.write(`Loop agent log: ${runLogPath({ stateDir, id: runningState.id })}\n`);
      process.stderr.write("Inspect from another terminal: loop status | loop runs | loop logs --follow\n");
    }
  });

  if (result.error) {
    const failed = transitionRunState(appendEvidence(result.state, {
      kind: "agent-run",
      status: "failed",
      summary: `${agent} agent failed to start: ${result.error.message}`
    }), "failed", {
      nextAction: `install or authenticate ${agent}, then rerun the loop`
    });
    const failedPaths = await writeRunState(failed, { stateDir });
    await writeWikiOrExit(failed, failedPaths, { stateDir, context: "agent start failure" });
    notifyLoopEvent("agent-start-failed", {
      agent,
      reason: result.error.message,
      runId: failed.id,
      objective
    }, notificationsEnabled);
    process.stderr.write(`${agent} agent failed to start: ${result.error.message}\n`);
    process.exit(5);
  }

  const exitCode = result.exitCode;
  const afterRun = appendEvidence(recordBudgetActivity(result.state, {
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
  notifyLoopEvent("run-finished", {
    agent,
    exitCode,
    runId: finalState.id,
    objective
  }, notificationsEnabled);

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

const noArgAction = noArgTuiDispatch({
  argCount: rawArgs.length,
  stdinTTY: Boolean(process.stdin.isTTY),
  stdoutTTY: Boolean(process.stdout.isTTY)
});

if (noArgAction === "open-tui") {
  await runLoopTui({ stateDir: ".loop" });
  process.exit(0);
}

if (noArgAction === "non-interactive-guidance") {
  process.stderr.write("loop with no arguments opens the Loop Agent Console in an interactive terminal.\n");
  process.stderr.write("Use loop \"your objective\" or loop run \"your objective\" for direct run mode.\n");
  process.exit(1);
}

if (command === "status" || command === "runs" || command === "logs") {
  let stateDir;
  try {
    stateDir = valueFor("--state-dir") ?? ".loop";
    if (command === "status") {
      await handleStatusCommand({ stateDir });
    } else if (command === "runs") {
      await handleRunsCommand({ stateDir });
    } else {
      await handleLogsCommand({ stateDir });
    }
    process.exit(0);
  } catch (error) {
    process.stderr.write(`${errorMessage(error)}\n\n`);
    printHelp(process.stderr);
    process.exit(1);
  }
}

if (command === "wiki") {
  await handleWikiCommand();
}

if (command === "doctor") {
  try {
    const result = runDoctorChecks({
      cwd: process.cwd(),
      packageJson,
      expectedRoot: valueFor("--expected-root"),
      expectedRemote: valueFor("--expected-remote")
    });
    process.stdout.write(renderDoctorReport(result));
    process.exit(doctorExitCode(result));
  } catch (error) {
    process.stderr.write(`${errorMessage(error)}\n\n`);
    printHelp(process.stderr);
    process.exit(1);
  }
}

if (command === "demo") {
  process.stdout.write(renderDemoGuide());
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
  let parentRunId;
  /** @type {"tui" | "dashboard" | "cli" | undefined} */
  let lineageSource;
  try {
    resolvedAgent = normalizeAgent(valueFor("--agent")) ?? await chooseAgent();
    expectedRoot = valueFor("--expected-root");
    expectedRemote = valueFor("--expected-remote");
    isolationMode = valueFor("--isolation") ?? "local";
    host = dashboardHost();
    port = dashboardPort();
    parentRunId = valueFor("--parent-run");
    lineageSource = normalizeLineageSource(valueFor("--lineage-source")) ?? (parentRunId ? "cli" : undefined);
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
    dashboardPort: port,
    parentRunId,
    lineageSource,
    notificationsEnabled: !has("--no-notify")
  });
}

printHelp(process.stderr);
process.exit(1);
