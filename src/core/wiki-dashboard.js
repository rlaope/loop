import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { once } from "node:events";

import {
  listWikiNotes,
  readWikiNote,
  renderWikiGraphHtml,
  renderMarkdownHtml,
  renderWikiDashboardHtml
} from "./wiki-store.js";

export const DEFAULT_WIKI_HOST = "127.0.0.1";
export const DEFAULT_WIKI_PORT = 3846;
export const WIKI_FAILURE_EXIT_CODE = 6;

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

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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
 * @param {{ stateDir?: string, host?: string, port?: number }} [options]
 */
export function createWikiServer({
  stateDir = ".loop",
  host = DEFAULT_WIKI_HOST,
  port = DEFAULT_WIKI_PORT
} = {}) {
  assertWikiDashboardHost(host);
  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? "/", dashboardUrl({ host, port }));
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
      if (url.pathname.startsWith("/notes/")) {
        const id = decodeURIComponent(url.pathname.slice("/notes/".length));
        const note = await readWikiNote(id, { stateDir });
        response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        response.end(renderMarkdownHtml(note.markdown));
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
      response.end(renderWikiDashboardHtml(notes));
    } catch (error) {
      response.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
      response.end(error instanceof Error ? error.message : String(error));
    }
  });
  return server;
}

/**
 * @param {{ stateDir?: string, host?: string, port?: number }} [options]
 */
export async function serveWikiDashboard({
  stateDir = ".loop",
  host = DEFAULT_WIKI_HOST,
  port = DEFAULT_WIKI_PORT
} = {}) {
  assertWikiDashboardHost(host);
  const status = await getDashboardStatus({ host, port });
  if (status.running) {
    return { status: "already-running", url: dashboardUrl({ host, port }), server: null };
  }
  if (status.occupied) {
    throw new Error(`Port ${port} is already in use by another service.`);
  }

  const server = createWikiServer({ stateDir, host, port });
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
 * @param {{ scriptPath: string, stateDir?: string, host?: string, port?: number }} options
 */
export function startDetachedWikiDashboard({
  scriptPath,
  stateDir = ".loop",
  host = DEFAULT_WIKI_HOST,
  port = DEFAULT_WIKI_PORT
}) {
  assertWikiDashboardHost(host);
  const child = spawn(process.execPath, [
    scriptPath,
    "wiki",
    "serve",
    "--state-dir",
    stateDir,
    "--host",
    host,
    "--port",
    String(port)
  ], {
    detached: true,
    stdio: "ignore"
  });
  child.unref();
  return child.pid ?? null;
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
