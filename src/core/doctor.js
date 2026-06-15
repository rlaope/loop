import { spawnSync } from "node:child_process";

import { checkRepoBoundary } from "./preflight.js";

export const MIN_NODE_MAJOR = 20;

/**
 * @typedef {"pass" | "warn" | "fail"} DoctorStatus
 *
 * @typedef {object} DoctorCheck
 * @property {string} name
 * @property {DoctorStatus} status
 * @property {string} summary
 * @property {string} [detail]
 *
 * @typedef {object} DoctorResult
 * @property {boolean} ok
 * @property {string} cwd
 * @property {string} packageName
 * @property {string} packageVersion
 * @property {DoctorCheck[]} checks
 */

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * @param {unknown} value
 * @returns {string}
 */
function stringOrUnknown(value) {
  return typeof value === "string" && value.trim() ? value : "unknown";
}

/**
 * @param {string} version
 */
function majorVersion(version) {
  const major = Number(version.split(".")[0]);
  return Number.isInteger(major) ? major : 0;
}

/**
 * @param {string} output
 */
function firstLine(output) {
  return output.trim().split(/\r?\n/)[0] ?? "";
}

/**
 * @param {string} command
 * @param {string[]} args
 * @param {typeof spawnSync} spawnSyncImpl
 */
function commandCheck(command, args, spawnSyncImpl) {
  const result = spawnSyncImpl(command, args, {
    encoding: "utf8",
    timeout: 1500
  });
  if (result.error) {
    return {
      ok: false,
      summary: result.error.message
    };
  }
  if (result.status !== 0) {
    return {
      ok: false,
      summary: firstLine(result.stderr || result.stdout) || `${command} exited with status ${result.status}`
    };
  }
  return {
    ok: true,
    summary: firstLine(result.stdout || result.stderr) || `${command} available`
  };
}

/**
 * @param {object} [options]
 * @param {string} [options.cwd]
 * @param {Record<string, unknown>} [options.packageJson]
 * @param {string} [options.expectedRoot]
 * @param {string} [options.expectedRemote]
 * @param {typeof spawnSync} [options.spawnSyncImpl]
 * @returns {DoctorResult}
 */
export function runDoctorChecks({
  cwd = process.cwd(),
  packageJson = {},
  expectedRoot,
  expectedRemote,
  spawnSyncImpl = spawnSync
} = {}) {
  /** @type {DoctorCheck[]} */
  const checks = [];
  const packageName = stringOrUnknown(packageJson.name);
  const packageVersion = stringOrUnknown(packageJson.version);

  const nodeVersion = process.versions.node;
  const nodeMajor = majorVersion(nodeVersion);
  checks.push({
    name: "Node.js runtime",
    status: nodeMajor >= MIN_NODE_MAJOR ? "pass" : "fail",
    summary: `v${nodeVersion}`,
    detail: `Loop requires Node.js >= ${MIN_NODE_MAJOR}.`
  });

  const git = commandCheck("git", ["--version"], spawnSyncImpl);
  checks.push({
    name: "git CLI",
    status: git.ok ? "pass" : "fail",
    summary: git.summary,
    detail: "Loop uses git to bound write-capable agent runs."
  });

  const npm = commandCheck("npm", ["--version"], spawnSyncImpl);
  checks.push({
    name: "npm CLI",
    status: npm.ok ? "pass" : "warn",
    summary: npm.ok ? `npm ${npm.summary}` : npm.summary,
    detail: "npm is only required for install, local development, and package verification."
  });

  const scripts = isRecord(packageJson.scripts) ? packageJson.scripts : {};
  const hasVerify = typeof scripts.verify === "string" && scripts.verify.trim().length > 0;
  checks.push({
    name: "package metadata",
    status: packageName !== "unknown" && packageVersion !== "unknown" ? "pass" : "warn",
    summary: `${packageName}@${packageVersion}`,
    detail: hasVerify ? "npm run verify is available." : "npm run verify is not defined in this package metadata."
  });

  if (!hasVerify) {
    checks.push({
      name: "verify script",
      status: "warn",
      summary: "npm run verify is not available",
      detail: "Installed users can ignore this; contributors should run verification from the source repository."
    });
  } else {
    checks.push({
      name: "verify script",
      status: "pass",
      summary: "npm run verify",
      detail: "Runs lint, typecheck, tests, and package-content validation."
    });
  }

  const boundary = checkRepoBoundary({ cwd, expectedRoot, expectedRemote });
  const explicitBoundary = Boolean(expectedRoot || expectedRemote);
  if (boundary.ok) {
    checks.push({
      name: "repo boundary",
      status: "pass",
      summary: boundary.root ? `git root ${boundary.root}` : "git root detected",
      detail: boundary.remote ? `origin ${boundary.remote}` : "No origin remote is required for local first runs."
    });
  } else {
    checks.push({
      name: "repo boundary",
      status: explicitBoundary ? "fail" : "warn",
      summary: boundary.errors.join(" "),
      detail: explicitBoundary
        ? "The explicit --expected-root or --expected-remote check failed."
        : "loop run can initialize a local git repository before launching a write-capable agent."
    });
  }

  const codex = commandCheck("codex", ["--version"], spawnSyncImpl);
  checks.push({
    name: "Codex CLI",
    status: codex.ok ? "pass" : "warn",
    summary: codex.ok ? codex.summary : "codex is not available on PATH",
    detail: "Needed only when running loop with --agent codex."
  });

  const claude = commandCheck("claude", ["--version"], spawnSyncImpl);
  checks.push({
    name: "Claude Code CLI",
    status: claude.ok ? "pass" : "warn",
    summary: claude.ok ? claude.summary : "claude is not available on PATH",
    detail: "Needed only when running loop with --agent claudecode."
  });

  return {
    ok: checks.every((check) => check.status !== "fail"),
    cwd,
    packageName,
    packageVersion,
    checks
  };
}

/**
 * @param {DoctorResult} result
 */
export function doctorExitCode(result) {
  return result.ok ? 0 : 1;
}

/**
 * @param {DoctorResult} result
 */
export function renderDoctorReport(result) {
  const lines = [
    "Loop Doctor",
    "",
    `Status: ${result.ok ? "ready" : "needs attention"}`,
    `Package: ${result.packageName}@${result.packageVersion}`,
    `Working directory: ${result.cwd}`,
    ""
  ];

  for (const check of result.checks) {
    lines.push(`[${check.status}] ${check.name}: ${check.summary}`);
    if (check.detail) {
      lines.push(`       ${check.detail}`);
    }
  }

  lines.push("");
  lines.push("Next:");
  lines.push("- Run `loop demo` to see first-run command examples.");
  lines.push("- Run `loop \"your objective\"` from the project folder when ready.");
  lines.push("- Run `npm run verify` from the Loop source repository before contributing.");
  lines.push("");

  return `${lines.join("\n")}\n`;
}
