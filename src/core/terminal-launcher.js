import { spawn } from "node:child_process";

/**
 * @typedef {object} TerminalCommandSpec
 * @property {string} command
 * @property {string[]} [args]
 * @property {string | null} [cwd]
 */

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** @param {string} value */
export function shellQuote(value) {
  if (/^[A-Za-z0-9_/:=.,@%+-]+$/.test(value)) {
    return value;
  }
  return `'${value.replace(/'/g, "'\\''")}'`;
}

/** @param {string[]} args */
export function shellCommand(args) {
  return args.map(shellQuote).join(" ");
}

/**
 * @param {string} cwd
 * @param {string} command
 */
export function commandInCwd(cwd, command) {
  return `cd ${shellQuote(cwd)} && ${command}`;
}

/**
 * @param {TerminalCommandSpec} spec
 */
export function terminalCommandDisplay({ command, args = [], cwd = null }) {
  const commandText = shellCommand([command, ...args]);
  return cwd ? commandInCwd(cwd, commandText) : commandText;
}

/**
 * @param {string} id
 * @param {string | undefined} stateDir
 */
export function followLogCommand(id, stateDir) {
  const args = ["loop", "logs", id, "--follow"];
  if (stateDir && stateDir !== ".loop") {
    args.push("--state-dir", stateDir);
  }
  return shellCommand(args);
}

/** @param {string} log */
export function codexSessionIdFromLog(log) {
  return log.match(/\bsession id:\s*([0-9a-f]{8}-[0-9a-f-]{13,})/i)?.[1] ?? null;
}

/**
 * @param {unknown} state
 */
function rawSessionFromState(state) {
  return isRecord(state) && isRecord(state.session) ? state.session : null;
}

/**
 * @param {unknown} state
 * @param {string} log
 * @returns {TerminalCommandSpec | null}
 */
export function codexResumeCommandSpec(state, log) {
  const session = rawSessionFromState(state);
  const agent = typeof session?.agent === "string" ? session.agent : undefined;
  if (!session || agent !== "codex") {
    return null;
  }
  const codexSessionId = codexSessionIdFromLog(log);
  if (!codexSessionId) {
    return null;
  }
  const cwd = typeof session.cwd === "string" ? session.cwd : undefined;
  return {
    command: "codex",
    args: ["resume", "--include-non-interactive", codexSessionId],
    cwd: cwd ?? null
  };
}

/**
 * @param {unknown} state
 * @param {string} log
 */
export function codexResumeCommand(state, log) {
  const spec = codexResumeCommandSpec(state, log);
  return spec ? terminalCommandDisplay(spec) : null;
}

/**
 * @param {unknown} effect
 * @returns {TerminalCommandSpec | null}
 */
export function codexCommandSpecFromOpenEffect(effect) {
  if (!isRecord(effect) || effect.type !== "open-codex-terminal") {
    return null;
  }
  const sessionId = typeof effect.sessionId === "string" ? effect.sessionId : null;
  if (!sessionId) {
    return null;
  }
  const cwd = typeof effect.cwd === "string" ? effect.cwd : null;
  return {
    command: "codex",
    args: ["resume", "--include-non-interactive", sessionId],
    cwd
  };
}

/**
 * @param {unknown} effect
 */
export function codexCommandFromOpenEffect(effect) {
  const spec = codexCommandSpecFromOpenEffect(effect);
  return spec ? terminalCommandDisplay(spec) : null;
}

/**
 * @param {{ agent: "codex" | "claudecode" | string, prompt: string, stateDir?: string, parentRunId?: string | null, lineageSource?: "tui" | "dashboard" | "cli" | null }} input
 */
export function loopRunCommand({
  agent,
  prompt,
  stateDir = ".loop",
  parentRunId = null,
  lineageSource = null
}) {
  const args = ["loop", "run", "--agent", agent];
  if (stateDir && stateDir !== ".loop") {
    args.push("--state-dir", stateDir);
  }
  if (parentRunId) {
    args.push("--parent-run", parentRunId);
    if (lineageSource) {
      args.push("--lineage-source", lineageSource);
    }
  }
  args.push(prompt);
  return shellCommand(args);
}

/** @param {string} value */
function appleScriptQuote(value) {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, "\\\"")}"`;
}

/**
 * @param {{ command: string, args?: string[], cwd?: string | null, platform?: NodeJS.Platform }} input
 */
export function terminalLaunchCommand({
  command,
  args = [],
  cwd = null,
  platform = process.platform
}) {
  const displayCommand = terminalCommandDisplay({ command, args, cwd });
  if (platform === "darwin") {
    return {
      command: "osascript",
      args: ["-e", `tell application "Terminal" to do script ${appleScriptQuote(displayCommand)}`],
      displayCommand
    };
  }
  if (platform === "win32") {
    const startArgs = ["/c", "start", ""];
    if (cwd) {
      startArgs.push("/D", cwd);
    }
    startArgs.push("cmd", "/k", command, ...args);
    return {
      command: "cmd",
      args: startArgs,
      displayCommand
    };
  }
  return {
    command: "sh",
    args: [
      "-lc",
      `if command -v x-terminal-emulator >/dev/null 2>&1; then x-terminal-emulator -e sh -lc ${shellQuote(displayCommand)}; elif command -v gnome-terminal >/dev/null 2>&1; then gnome-terminal -- sh -lc ${shellQuote(displayCommand)}; else sh -lc ${shellQuote(displayCommand)}; fi`
    ],
    displayCommand
  };
}

/**
 * @param {{ command: string, args?: string[], cwd?: string | null, platform?: NodeJS.Platform, spawnImpl?: typeof spawn }} input
 */
export function launchTerminalCommand({
  command,
  args = [],
  cwd = null,
  platform = process.platform,
  spawnImpl = spawn
}) {
  const launch = terminalLaunchCommand({ command, args, cwd, platform });
  const child = spawnImpl(launch.command, launch.args, {
    detached: true,
    stdio: "ignore"
  });
  child.unref();
  return {
    pid: child.pid ?? null,
    ...launch
  };
}
