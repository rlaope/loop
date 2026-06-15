import { createServer } from "node:http";
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { once } from "node:events";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import { readRunLog, readRunState } from "./state-store.js";
import {
  addWikiNoteAction,
  createActionConfirmation,
  deleteRunAction,
  deleteWikiNoteAction,
  markCompleteAction,
  markVerificationAction,
  prepareCodexOpenAction,
  prepareFollowUpRunAction
} from "./actions.js";
import {
  codexCommandFromOpenEffect,
  codexCommandSpecFromOpenEffect,
  launchTerminalCommand,
  loopRunCommand
} from "./terminal-launcher.js";
import { openTarget } from "./open-target.js";
import {
  listWikiNotes,
  readWikiNote,
  renderRunLogHtml,
  renderWikiGraphHtml,
  renderMarkdownHtml,
  renderWikiDashboardHtml
} from "./wiki-store.js";

export const DEFAULT_WIKI_HOST = "127.0.0.1";
export const DEFAULT_WIKI_PORT = 3846;
export const WIKI_FAILURE_EXIT_CODE = 6;
const DEFAULT_CONFIRMATION_TTL_MS = 5 * 60 * 1000;
const DASHBOARD_SECRET_FILENAME = "dashboard-secret";

/** @param {string} host */
export function assertWikiDashboardHost(host) {
  if (host !== DEFAULT_WIKI_HOST) {
    throw new Error(`Loop Wiki dashboard only supports ${DEFAULT_WIKI_HOST}`);
  }
}

/**
 * @param {{ host?: string, port?: number }} [options]
 */
export function dashboardUrl({ host = DEFAULT_WIKI_HOST, port = DEFAULT_WIKI_PORT } = {}) {
  assertWikiDashboardHost(host);
  return `http://${host}:${port}`;
}

/** @param {string} stateDir */
export function dashboardSecretPath(stateDir = ".loop") {
  return join(stateDir, DASHBOARD_SECRET_FILENAME);
}

/** @param {string} stateDir */
export async function loadOrCreateDashboardSecret(stateDir = ".loop") {
  const path = dashboardSecretPath(stateDir);
  try {
    const existing = (await readFile(path, "utf8")).trim();
    if (/^[0-9a-f]{64}$/i.test(existing)) {
      return existing;
    }
  } catch (error) {
    if (!isRecord(error) || error.code !== "ENOENT") {
      throw error;
    }
  }
  const secret = randomBytes(32).toString("hex");
  await mkdir(stateDir, { recursive: true });
  await writeFile(path, `${secret}\n`, { mode: 0o600 });
  return secret;
}

/**
 * @param {string} encodedPayload
 * @param {string | Buffer} secret
 */
function signConfirmationPayload(encodedPayload, secret) {
  return createHmac("sha256", secret).update(encodedPayload).digest("base64url");
}

/**
 * @param {string} left
 * @param {string} right
 */
function safeEqual(left, right) {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

/**
 * @param {{
 *   action: string,
 *   targetId: string,
 *   stateDir?: string,
 *   secret: string | Buffer,
 *   now?: Date,
 *   ttlMs?: number
 * }} input
 */
export function createDashboardConfirmationToken({
  action,
  targetId,
  stateDir = ".loop",
  secret,
  now = new Date(),
  ttlMs = DEFAULT_CONFIRMATION_TTL_MS
}) {
  const payload = {
    version: 1,
    action,
    targetId,
    stateDir: resolve(stateDir),
    expiresAt: now.getTime() + ttlMs
  };
  const encodedPayload = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${encodedPayload}.${signConfirmationPayload(encodedPayload, secret)}`;
}

/**
 * @param {{
 *   token: string,
 *   action: string,
 *   targetId: string,
 *   stateDir?: string,
 *   secret: string | Buffer,
 *   now?: Date
 * }} input
 */
export function verifyDashboardConfirmationToken({
  token,
  action,
  targetId,
  stateDir = ".loop",
  secret,
  now = new Date()
}) {
  const [encodedPayload, signature, extra] = token.split(".");
  if (!encodedPayload || !signature || extra !== undefined) {
    return {
      ok: false,
      error: {
        kind: "confirmation_invalid",
        message: "Missing or malformed dashboard confirmation token."
      }
    };
  }
  const expectedSignature = signConfirmationPayload(encodedPayload, secret);
  if (!safeEqual(signature, expectedSignature)) {
    return {
      ok: false,
      error: {
        kind: "confirmation_invalid",
        message: "Dashboard confirmation token signature is invalid."
      }
    };
  }
  let payload;
  try {
    payload = JSON.parse(Buffer.from(encodedPayload, "base64url").toString("utf8"));
  } catch {
    return {
      ok: false,
      error: {
        kind: "confirmation_invalid",
        message: "Dashboard confirmation token payload is invalid."
      }
    };
  }
  if (
    !isRecord(payload) ||
    payload.version !== 1 ||
    payload.action !== action ||
    payload.targetId !== targetId ||
    payload.stateDir !== resolve(stateDir)
  ) {
    return {
      ok: false,
      error: {
        kind: "confirmation_mismatch",
        message: "Dashboard confirmation token does not match this action target."
      }
    };
  }
  if (typeof payload.expiresAt !== "number" || payload.expiresAt < now.getTime()) {
    return {
      ok: false,
      error: {
        kind: "confirmation_expired",
        message: "Dashboard confirmation token expired."
      }
    };
  }
  return { ok: true };
}

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * @param {import("node:http").IncomingMessage} request
 */
async function readFormBody(request) {
  /** @type {Buffer[]} */
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    size += buffer.length;
    if (size > 64 * 1024) {
      throw new Error("Dashboard action body is too large.");
    }
    chunks.push(buffer);
  }
  return new URLSearchParams(Buffer.concat(chunks).toString("utf8"));
}

/**
 * @param {URLSearchParams} form
 * @param {string} key
 */
function formString(form, key) {
  const value = form.get(key);
  return typeof value === "string" ? value.trim() : "";
}

/**
 * @param {import("node:http").ServerResponse} response
 * @param {number} status
 * @param {string} message
 */
function sendPlain(response, status, message) {
  response.writeHead(status, { "content-type": "text/plain; charset=utf-8" });
  response.end(`${message}\n`);
}

/**
 * @param {import("node:http").ServerResponse} response
 * @param {string} location
 */
function redirect(response, location = "/") {
  response.writeHead(303, { location });
  response.end();
}

/**
 * @param {import("node:http").ServerResponse} response
 * @param {{ title: string, message: string, command?: string }} input
 */
function sendActionResult(response, { title, message, command }) {
  const commandHtml = command
    ? `<section class="result-card"><h2>Command</h2><code>${escapeHtml(command)}</code></section>`
    : "";
  response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  response.end(`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(title)}</title>
  <style>
    :root { color-scheme: dark; --ink: #f4f0e8; --muted: #9da0a6; --line: #2a2b31; --panel: #15161a; --page: #090a0d; --blue: #8bd3ff; }
    * { box-sizing: border-box; }
    body { margin: 0; min-height: 100vh; font: 15px/1.55 ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; color: var(--ink); background: var(--page); }
    main { max-width: 760px; margin: 0 auto; padding: 34px 18px; display: grid; gap: 14px; }
    .result-card { border: 1px solid var(--line); border-radius: 8px; padding: 18px; background: var(--panel); }
    h1 { margin: 0; font-size: 26px; line-height: 1.15; }
    h2 { margin: 0 0 10px; font-size: 13px; color: var(--muted); text-transform: uppercase; }
    p { margin: 8px 0 0; color: var(--muted); }
    a { color: var(--blue); text-underline-offset: 3px; }
    code { display: block; overflow-x: auto; border: 1px solid var(--line); border-radius: 7px; padding: 10px; background: #050609; color: var(--ink); }
  </style>
</head>
<body>
  <main>
    <section class="result-card">
      <h1>${escapeHtml(title)}</h1>
      <p>${escapeHtml(message)}</p>
    </section>
    ${commandHtml}
    <a href="/">Back to Loop Wiki</a>
  </main>
</body>
</html>`);
}

/** @param {string} value */
function escapeHtml(value) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** @param {unknown} error */
function getErrorCode(error) {
  return isRecord(error) && typeof error.code === "string" ? error.code : undefined;
}

/** @param {unknown} error */
function getNestedErrorCode(error) {
  const code = getErrorCode(error);
  if (code || !isRecord(error)) {
    return code;
  }
  return getNestedErrorCode(error.cause);
}

/** @param {number} ms */
function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * @param {{ host?: string, port?: number, timeoutMs?: number }} [options]
 */
export async function getDashboardStatus({
  host = DEFAULT_WIKI_HOST,
  port = DEFAULT_WIKI_PORT,
  timeoutMs = 250
} = {}) {
  assertWikiDashboardHost(host);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${dashboardUrl({ host, port })}/health`, {
      signal: controller.signal
    });
    if (!response.ok) {
      return { running: false, occupied: true };
    }
    const body = await response.json().catch(() => ({}));
    return {
      running: body && body.name === "loop-wiki",
      occupied: !(body && body.name === "loop-wiki")
    };
  } catch (error) {
    if (getNestedErrorCode(error) === "ECONNREFUSED") {
      return { running: false, occupied: false };
    }
    return { running: false, occupied: true };
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * @param {{ host?: string, port?: number, timeoutMs?: number, intervalMs?: number }} [options]
 */
export async function waitForDashboardReady({
  host = DEFAULT_WIKI_HOST,
  port = DEFAULT_WIKI_PORT,
  timeoutMs = 1500,
  intervalMs = 100
} = {}) {
  assertWikiDashboardHost(host);
  const deadline = Date.now() + timeoutMs;
  let status = await getDashboardStatus({ host, port });
  while (!status.running && !status.occupied && Date.now() < deadline) {
    await delay(intervalMs);
    status = await getDashboardStatus({ host, port });
  }
  return status;
}

/**
 * @param {{
 *   stateDir?: string,
 *   host?: string,
 *   port?: number,
 *   confirmationSecret?: string | Buffer,
 *   confirmationTtlMs?: number,
 *   launchTerminalCommandImpl?: typeof launchTerminalCommand,
 *   openTargetImpl?: typeof openTarget
 * }} [options]
 */
export function createWikiServer({
  stateDir = ".loop",
  host = DEFAULT_WIKI_HOST,
  port = DEFAULT_WIKI_PORT,
  confirmationSecret = randomBytes(32),
  confirmationTtlMs = DEFAULT_CONFIRMATION_TTL_MS,
  launchTerminalCommandImpl = launchTerminalCommand,
  openTargetImpl = openTarget
} = {}) {
  assertWikiDashboardHost(host);
  /** @type {(input: { action: string, targetId: string }) => string} */
  const tokenFor = ({ action, targetId }) => createDashboardConfirmationToken({
    action,
    targetId,
    stateDir,
    secret: confirmationSecret,
    ttlMs: confirmationTtlMs
  });
  /**
   * @param {import("node:http").ServerResponse} response
   * @param {URLSearchParams} form
   * @param {string} action
   * @param {string} targetId
   */
  const dashboardConfirmation = (response, form, action, targetId) => {
    const token = formString(form, "confirmationToken");
    const verified = verifyDashboardConfirmationToken({
      token,
      action,
      targetId,
      stateDir,
      secret: confirmationSecret
    });
    if (!verified.ok) {
      sendPlain(response, 403, verified.error?.message ?? "Dashboard confirmation token is invalid.");
      return null;
    }
    return {
      ...createActionConfirmation({ action, targetId, stateDir }),
      token
    };
  };
  /**
   * @param {import("node:http").ServerResponse} response
   * @param {{ ok: boolean, error?: { message?: string, kind?: string } }} result
   */
  const ensureActionOk = (response, result) => {
    if (result.ok) {
      return true;
    }
    sendPlain(response, 400, result.error?.message ?? result.error?.kind ?? "Dashboard action failed.");
    return false;
  };
  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? "/", dashboardUrl({ host, port }));
      if (request.method === "POST" && url.pathname.startsWith("/actions/")) {
        const actionName = url.pathname.slice("/actions/".length);
        const form = await readFormBody(request);
        if (actionName === "delete-note") {
          const id = formString(form, "id");
          const confirmation = dashboardConfirmation(response, form, "delete-note", id);
          if (!confirmation) {
            return;
          }
          const result = await deleteWikiNoteAction({ id, stateDir, confirmation });
          if (!ensureActionOk(response, result)) {
            return;
          }
          redirect(response);
          return;
        }
        if (actionName === "add-note") {
          const targetId = formString(form, "targetId") || "wiki";
          const confirmation = dashboardConfirmation(response, form, "add-note", targetId);
          if (!confirmation) {
            return;
          }
          const title = formString(form, "title");
          const body = formString(form, "body");
          if (!title || !body) {
            sendPlain(response, 400, "Title and body are required to add a wiki note.");
            return;
          }
          const result = await addWikiNoteAction({
            stateDir,
            runId: formString(form, "runId") || undefined,
            parentId: formString(form, "parentId") || undefined,
            targetId,
            kind: formString(form, "kind") || "note",
            title,
            body,
            confirmation
          });
          if (!ensureActionOk(response, result)) {
            return;
          }
          redirect(response);
          return;
        }
        if (actionName === "delete-run") {
          const id = formString(form, "id");
          const confirmation = dashboardConfirmation(response, form, "delete-run", id);
          if (!confirmation) {
            return;
          }
          const result = await deleteRunAction({ id, stateDir, confirmation });
          if (!ensureActionOk(response, result)) {
            return;
          }
          redirect(response);
          return;
        }
        if (actionName === "verify-run") {
          const id = formString(form, "id");
          const confirmation = dashboardConfirmation(response, form, "verify-run", id);
          if (!confirmation) {
            return;
          }
          const result = await markVerificationAction({
            id,
            stateDir,
            summary: formString(form, "summary") || "Verified from the Loop Wiki dashboard.",
            confirmation
          });
          if (!ensureActionOk(response, result)) {
            return;
          }
          redirect(response, `/runs/${encodeURIComponent(id)}/log`);
          return;
        }
        if (actionName === "mark-complete") {
          const id = formString(form, "id");
          const confirmation = dashboardConfirmation(response, form, "mark-complete", id);
          if (!confirmation) {
            return;
          }
          const result = await markCompleteAction({
            id,
            stateDir,
            confirmation,
            summary: formString(form, "summary") || "Marked complete from the Loop Wiki dashboard."
          });
          if (!ensureActionOk(response, result)) {
            return;
          }
          redirect(response, `/runs/${encodeURIComponent(id)}/log`);
          return;
        }
        if (actionName === "follow-up") {
          const parentRunId = formString(form, "parentRunId");
          const prompt = formString(form, "prompt");
          const agent = formString(form, "agent") === "claudecode" ? "claudecode" : "codex";
          const confirmation = dashboardConfirmation(response, form, "follow-up-run", parentRunId);
          if (!confirmation) {
            return;
          }
          if (!prompt) {
            sendPlain(response, 400, "Follow-up prompt is required.");
            return;
          }
          const result = await prepareFollowUpRunAction({
            parentRunId,
            prompt,
            stateDir,
            createdFrom: "dashboard",
            confirmation
          });
          if (!ensureActionOk(response, result)) {
            return;
          }
          sendActionResult(response, {
            title: "Follow-up prepared",
            message: `Prepared a follow-up loop from ${parentRunId}. Run the command below to start it with ${agent}.`,
            command: loopRunCommand({
              agent,
              prompt,
              stateDir,
              parentRunId,
              lineageSource: "dashboard"
            })
          });
          return;
        }
        if (actionName === "open-codex") {
          const id = formString(form, "id");
          const confirmation = dashboardConfirmation(response, form, "open-codex", id);
          if (!confirmation) {
            return;
          }
          const result = await prepareCodexOpenAction({ id, stateDir, confirmation });
          if (!ensureActionOk(response, result)) {
            return;
          }
          if (!result.ok || !("effect" in result)) {
            sendPlain(response, 400, "No Codex resume command is available for this run.");
            return;
          }
          const commandSpec = codexCommandSpecFromOpenEffect(result.effect);
          const command = codexCommandFromOpenEffect(result.effect);
          if (!commandSpec || !command) {
            sendPlain(response, 400, "No Codex resume command is available for this run.");
            return;
          }
          const launched = launchTerminalCommandImpl(commandSpec);
          sendActionResult(response, {
            title: "Codex terminal opened",
            message: `Launched terminal command${launched.pid ? ` with pid ${launched.pid}` : ""}.`,
            command
          });
          return;
        }
        if (actionName === "open-dashboard") {
          const targetId = "dashboard";
          if (!dashboardConfirmation(response, form, "open-dashboard", targetId)) {
            return;
          }
          openTargetImpl(dashboardUrl({ host, port }));
          redirect(response);
          return;
        }
        if (actionName === "graph-view") {
          redirect(response, "/graph");
          return;
        }
        sendPlain(response, 404, `Unknown dashboard action: ${actionName}`);
        return;
      }
      if (request.method !== "GET") {
        sendPlain(response, 404, "Unknown dashboard action.");
        return;
      }
      if (url.pathname === "/health") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(`${JSON.stringify({ ok: true, name: "loop-wiki" })}\n`);
        return;
      }
      if (url.pathname === "/api/index") {
        const notes = await listWikiNotes({ stateDir });
        response.writeHead(200, { "content-type": "application/json" });
        response.end(`${JSON.stringify({ notes }, null, 2)}\n`);
        return;
      }
      if (url.pathname.startsWith("/api/runs/") && url.pathname.endsWith("/log")) {
        const id = decodeURIComponent(url.pathname.slice("/api/runs/".length, -"/log".length));
        const [log, readState] = await Promise.all([
          readRunLog(id, { stateDir }),
          readRunState(id, { stateDir })
        ]);
        response.writeHead(200, {
          "cache-control": "no-store",
          "content-type": "application/json; charset=utf-8"
        });
        response.end(`${JSON.stringify({
          id,
          log,
          state: readState.ok ? readState.state : null,
          updatedAt: new Date().toISOString()
        })}\n`);
        return;
      }
      if (url.pathname.startsWith("/notes/")) {
        const id = decodeURIComponent(url.pathname.slice("/notes/".length));
        const note = await readWikiNote(id, { stateDir });
        response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        response.end(renderMarkdownHtml(note.markdown, { noteId: note.id, confirmationTokenFor: tokenFor }));
        return;
      }
      if (url.pathname.startsWith("/runs/") && url.pathname.endsWith("/log")) {
        const id = decodeURIComponent(url.pathname.slice("/runs/".length, -"/log".length));
        const [log, readState] = await Promise.all([
          readRunLog(id, { stateDir }),
          readRunState(id, { stateDir })
        ]);
        response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        response.end(renderRunLogHtml({
          id,
          log,
          state: readState.ok ? readState.state : null,
          stateDir
        }));
        return;
      }
      if (url.pathname === "/graph") {
        const notes = await listWikiNotes({ stateDir });
        response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        response.end(renderWikiGraphHtml(notes));
        return;
      }
      const notes = await listWikiNotes({ stateDir });
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(renderWikiDashboardHtml(notes, { confirmationTokenFor: tokenFor }));
    } catch (error) {
      response.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
      response.end(error instanceof Error ? error.message : String(error));
    }
  });
  return server;
}

/**
 * @param {{
 *   stateDir?: string,
 *   host?: string,
 *   port?: number,
 *   confirmationSecret?: string | Buffer,
 *   confirmationTtlMs?: number,
 *   launchTerminalCommandImpl?: typeof launchTerminalCommand,
 *   openTargetImpl?: typeof openTarget
 * }} [options]
 */
export async function serveWikiDashboard({
  stateDir = ".loop",
  host = DEFAULT_WIKI_HOST,
  port = DEFAULT_WIKI_PORT,
  confirmationSecret,
  confirmationTtlMs,
  launchTerminalCommandImpl,
  openTargetImpl
} = {}) {
  assertWikiDashboardHost(host);
  const status = await getDashboardStatus({ host, port });
  if (status.running) {
    return { status: "already-running", url: dashboardUrl({ host, port }), server: null };
  }
  if (status.occupied) {
    throw new Error(`Port ${port} is already in use by another service.`);
  }
  const resolvedConfirmationSecret = confirmationSecret ?? await loadOrCreateDashboardSecret(stateDir);

  const server = createWikiServer({
    stateDir,
    host,
    port,
    confirmationSecret: resolvedConfirmationSecret,
    confirmationTtlMs,
    launchTerminalCommandImpl,
    openTargetImpl
  });
  server.listen(port, host);
  await Promise.race([
    once(server, "listening"),
    once(server, "error").then(([error]) => {
      throw error instanceof Error ? error : new Error(String(error));
    })
  ]);
  return { status: "started", url: dashboardUrl({ host, port }), server };
}

/**
 * @param {object} options
 * @param {boolean} options.dashboardRunning
 * @param {boolean} options.stdinTTY
 * @param {boolean} options.stdoutTTY
 * @param {boolean} options.explicitFlag
 * @param {boolean} [options.userConsent]
 */
export function dashboardActionForRun({
  dashboardRunning,
  stdinTTY,
  stdoutTTY,
  explicitFlag,
  userConsent
}) {
  if (dashboardRunning) {
    return "skip-running";
  }
  if (explicitFlag) {
    return "start";
  }
  if (stdinTTY && stdoutTTY) {
    if (userConsent === undefined) {
      return "ask";
    }
    return userConsent ? "start" : "skip-declined";
  }
  return "skip-non-interactive";
}
