import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";

import { runLogPath, writeRunState } from "./state-store.js";

/**
 * @param {string} objective
 * @param {{ writeMode: boolean }} options
 */
export function buildAgentPrompt(objective, { writeMode }) {
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

/**
 * @param {"codex" | "claudecode"} agent
 * @param {string} prompt
 * @param {boolean} writeMode
 * @param {{ cwd?: string }} [options]
 */
export function agentCommand(agent, prompt, writeMode, { cwd = process.cwd() } = {}) {
  if (agent === "codex") {
    return {
      command: "codex",
      displayArgs: [
        "exec",
        "--sandbox",
        writeMode ? "workspace-write" : "read-only",
        "--cd",
        cwd,
        "<loop prompt>"
      ],
      args: [
        "exec",
        "--sandbox",
        writeMode ? "workspace-write" : "read-only",
        "--cd",
        cwd,
        prompt
      ]
    };
  }
  return {
    command: "claude",
    displayArgs: [
      "--print",
      "--permission-mode",
      writeMode ? "acceptEdits" : "plan",
      "<loop prompt>"
    ],
    args: [
      "--print",
      "--permission-mode",
      writeMode ? "acceptEdits" : "plan",
      prompt
    ]
  };
}

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * @param {import("./run-state.js").LoopRunState} state
 * @param {Record<string, unknown>} session
 */
export function withSession(state, session) {
  const stateRecord = /** @type {Record<string, unknown>} */ (state);
  return {
    ...state,
    session: {
      ...(isRecord(stateRecord.session) ? stateRecord.session : {}),
      ...session
    },
    updatedAt: new Date().toISOString()
  };
}

/**
 * @param {{ command: string, args: string[], displayArgs: string[] }} command
 * @param {{
 *   agent: string,
 *   state: import("./run-state.js").LoopRunState,
 *   stateDir: string,
 *   cwd?: string,
 *   env?: NodeJS.ProcessEnv,
 *   stdout?: NodeJS.WritableStream,
 *   stderr?: NodeJS.WritableStream,
 *   spawnImpl?: typeof spawn,
 *   onStarted?: (state: import("./run-state.js").LoopRunState, paths: { jsonPath?: string, summaryPath?: string }) => Promise<void>
 * }} options
 */
export async function runAgentProcess(command, {
  agent,
  state,
  stateDir,
  cwd = process.cwd(),
  env = process.env,
  stdout = process.stdout,
  stderr = process.stderr,
  spawnImpl = spawn,
  onStarted
}) {
  const logPath = runLogPath({ stateDir, id: state.id });
  const log = createWriteStream(logPath, { flags: "a" });
  log.write(`[loop] ${new Date().toISOString()} starting ${agent}\n`);
  log.write(`[loop] command: ${command.command} ${command.displayArgs.join(" ")}\n\n`);
  const child = spawnImpl(command.command, command.args, {
    cwd,
    env,
    stdio: ["ignore", "pipe", "pipe"]
  });
  const runningState = withSession(state, {
    agent,
    status: "running",
    pid: child.pid ?? null,
    command: command.command,
    args: command.displayArgs,
    cwd,
    logPath,
    startedAt: new Date().toISOString(),
    endedAt: null,
    exitCode: null,
    signal: null
  });
  const runningPaths = await writeRunState(runningState, { stateDir });
  if (onStarted) {
    await onStarted(runningState, runningPaths);
  }

  if (child.stdout) {
    child.stdout.on("data", (chunk) => {
      stdout.write(chunk);
      log.write(chunk);
    });
  }
  if (child.stderr) {
    child.stderr.on("data", (chunk) => {
      stderr.write(chunk);
      log.write(chunk);
    });
  }

  /** @type {{ error?: Error, exitCode: number, signal: NodeJS.Signals | null }} */
  const result = await new Promise((resolve) => {
    let settled = false;
    child.once("error", (error) => {
      if (settled) {
        return;
      }
      settled = true;
      const resolvedError = error instanceof Error ? error : new Error(String(error));
      log.write(`\n[loop] ${new Date().toISOString()} failed to start: ${resolvedError.message}\n`);
      resolve({ error: resolvedError, exitCode: 1, signal: null });
    });
    child.once("close", (code, signal) => {
      if (settled) {
        return;
      }
      settled = true;
      const exitCode = code ?? (signal ? 1 : 0);
      log.write(`\n[loop] ${new Date().toISOString()} ${agent} exited with status ${exitCode}${signal ? ` signal ${signal}` : ""}.\n`);
      resolve({ exitCode, signal });
    });
  });
  await new Promise((resolve) => log.end(resolve));
  return {
    ...result,
    state: withSession(runningState, {
      status: result.error ? "failed_to_start" : "exited",
      endedAt: new Date().toISOString(),
      exitCode: result.exitCode,
      signal: result.signal
    }),
    logPath
  };
}
