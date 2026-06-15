import { spawn } from "node:child_process";
import { appendFileSync } from "node:fs";

const MAX_TITLE_LENGTH = 64;
const MAX_MESSAGE_LENGTH = 220;

/**
 * @param {unknown} value
 * @param {number} maxLength
 */
function notificationText(value, maxLength) {
  const text = String(value ?? "")
    .replace(/\s+/g, " ")
    .trim();
  if (text.length <= maxLength) {
    return text;
  }
  return `${text.slice(0, Math.max(0, maxLength - 3)).trimEnd()}...`;
}

/** @param {string} value */
function appleScriptString(value) {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

/** @param {string} value */
function powershellString(value) {
  return `'${value.replace(/'/g, "''")}'`;
}

/**
 * @param {{
 *   title: string,
 *   message: string,
 *   subtitle?: string,
 *   platform?: NodeJS.Platform
 * }} input
 */
export function notificationCommand({
  title,
  message,
  subtitle,
  platform = process.platform
}) {
  const normalizedTitle = notificationText(title || "Loop", MAX_TITLE_LENGTH) || "Loop";
  const normalizedMessage = notificationText(message || "Open the Loop dashboard for details.", MAX_MESSAGE_LENGTH)
    || "Open the Loop dashboard for details.";
  const normalizedSubtitle = notificationText(subtitle, MAX_TITLE_LENGTH);

  if (platform === "darwin") {
    const expression = [
      `display notification "${appleScriptString(normalizedMessage)}"`,
      `with title "${appleScriptString(normalizedTitle)}"`,
      normalizedSubtitle ? `subtitle "${appleScriptString(normalizedSubtitle)}"` : ""
    ].filter(Boolean).join(" ");
    return { command: "osascript", args: ["-e", expression] };
  }

  if (platform === "win32") {
    const script = [
      "Add-Type -AssemblyName System.Windows.Forms;",
      "Add-Type -AssemblyName System.Drawing;",
      "$notify = New-Object System.Windows.Forms.NotifyIcon;",
      "$notify.Icon = [System.Drawing.SystemIcons]::Information;",
      `$notify.BalloonTipTitle = ${powershellString(normalizedTitle)};`,
      `$notify.BalloonTipText = ${powershellString(normalizedSubtitle ? `${normalizedSubtitle} - ${normalizedMessage}` : normalizedMessage)};`,
      "$notify.Visible = $true;",
      "$notify.ShowBalloonTip(5000);",
      "Start-Sleep -Seconds 6;",
      "$notify.Dispose();"
    ].join(" ");
    return {
      command: "powershell.exe",
      args: ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Sta", "-Command", script]
    };
  }

  if (platform === "linux" || platform === "freebsd" || platform === "openbsd") {
    return {
      command: "notify-send",
      args: ["--app-name", "Loop", normalizedTitle, normalizedSubtitle ? `${normalizedSubtitle}\n${normalizedMessage}` : normalizedMessage]
    };
  }

  return null;
}

/**
 * @param {string | undefined} value
 */
function truthyEnv(value) {
  return value === "1" || value === "true" || value === "yes";
}

/**
 * @param {{
 *   enabled?: boolean,
 *   env?: NodeJS.ProcessEnv,
 *   stdoutTTY?: boolean,
 *   stderrTTY?: boolean
 * }} [options]
 */
export function shouldSendLoopNotification({
  enabled = true,
  env = process.env,
  stdoutTTY = Boolean(process.stdout.isTTY),
  stderrTTY = Boolean(process.stderr.isTTY)
} = {}) {
  if (!enabled || truthyEnv(env.LOOP_DISABLE_NOTIFICATIONS)) {
    return false;
  }
  if (truthyEnv(env.LOOP_FORCE_NOTIFICATIONS) || env.LOOP_NOTIFICATION_LOG) {
    return true;
  }
  return Boolean(stdoutTTY || stderrTTY);
}

/**
 * @param {"policy-blocked" | "run-started" | "agent-start-failed" | "run-finished"} event
 * @param {{
 *   agent?: string,
 *   objective: string,
 *   runId: string,
 *   reason?: string,
 *   dashboardUrl?: string,
 *   exitCode?: number
 * }} context
 */
export function loopNotificationPayload(event, {
  agent = "agent",
  objective,
  runId,
  reason = "human attention required",
  dashboardUrl,
  exitCode = 0
}) {
  if (event === "policy-blocked") {
    return {
      title: "Loop needs attention",
      message: `Policy gate blocked the run: ${reason}`,
      subtitle: objective,
      runId,
      objective
    };
  }
  if (event === "run-started") {
    return {
      title: "Loop started",
      message: `${agent} is running.${dashboardUrl ? ` Dashboard: ${dashboardUrl}` : ""}`,
      subtitle: objective,
      runId,
      objective
    };
  }
  if (event === "agent-start-failed") {
    return {
      title: "Loop needs attention",
      message: `${agent} failed to start: ${reason}`,
      subtitle: objective,
      runId,
      objective
    };
  }
  return {
    title: exitCode === 0 ? "Loop needs review" : "Loop failed",
    message: exitCode === 0
      ? `${agent} finished. Review changes, verification evidence, and dashboard.`
      : `${agent} exited with status ${exitCode}. Inspect the dashboard or log.`,
    subtitle: objective,
    runId,
    objective
  };
}

/**
 * @param {{
 *   title: string,
 *   message: string,
 *   subtitle?: string,
 *   runId?: string,
 *   objective?: string
 * }} input
 * @param {{
 *   env?: NodeJS.ProcessEnv,
 *   platform?: NodeJS.Platform,
 *   spawnImpl?: typeof spawn,
 *   appendFileSyncImpl?: typeof appendFileSync
 * }} [options]
 */
export function sendLoopNotification(input, {
  env = process.env,
  platform = process.platform,
  spawnImpl = spawn,
  appendFileSyncImpl = appendFileSync
} = {}) {
  if (truthyEnv(env.LOOP_DISABLE_NOTIFICATIONS)) {
    return { ok: false, skipped: true, reason: "disabled" };
  }

  const payload = {
    title: notificationText(input.title || "Loop", MAX_TITLE_LENGTH) || "Loop",
    message: notificationText(input.message || "Open the Loop dashboard for details.", MAX_MESSAGE_LENGTH)
      || "Open the Loop dashboard for details.",
    subtitle: notificationText(input.subtitle, MAX_TITLE_LENGTH),
    runId: input.runId,
    objective: input.objective,
    timestamp: new Date().toISOString()
  };

  if (env.LOOP_NOTIFICATION_LOG) {
    appendFileSyncImpl(env.LOOP_NOTIFICATION_LOG, `${JSON.stringify(payload)}\n`);
    return { ok: true, recorded: true };
  }

  const commandSpec = notificationCommand({ ...payload, platform });
  if (!commandSpec) {
    return { ok: false, skipped: true, reason: "unsupported-platform" };
  }

  try {
    const child = spawnImpl(commandSpec.command, commandSpec.args, {
      detached: true,
      stdio: "ignore",
      windowsHide: true
    });
    child.once("error", () => {});
    child.unref();
  } catch (error) {
    return {
      ok: false,
      skipped: false,
      reason: error instanceof Error ? error.message : String(error)
    };
  }

  return { ok: true, dispatched: true };
}
