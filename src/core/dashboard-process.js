import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

export const DASHBOARD_PROCESS_HOST = "127.0.0.1";

/** @param {string} importMetaUrl */
export function scriptPathFromImportMetaUrl(importMetaUrl) {
  return fileURLToPath(importMetaUrl);
}

/** @param {string} host */
function assertDashboardProcessHost(host) {
  if (host !== DASHBOARD_PROCESS_HOST) {
    throw new Error(`Loop Wiki dashboard only supports ${DASHBOARD_PROCESS_HOST}`);
  }
}

/**
 * @param {{
 *   scriptPath: string,
 *   stateDir?: string,
 *   host?: string,
 *   port?: number,
 *   spawnImpl?: typeof spawn
 * }} options
 */
export function startDetachedWikiDashboard({
  scriptPath,
  stateDir = ".loop",
  host = DASHBOARD_PROCESS_HOST,
  port = 3846,
  spawnImpl = spawn
}) {
  assertDashboardProcessHost(host);
  const child = spawnImpl(process.execPath, [
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
