import { spawnSync } from "node:child_process";
import { appendFileSync } from "node:fs";

/**
 * @param {string} target
 * @param {{
 *   env?: NodeJS.ProcessEnv,
 *   platform?: NodeJS.Platform,
 *   stdoutTTY?: boolean,
 *   spawnSyncImpl?: typeof spawnSync,
 *   appendFileSyncImpl?: typeof appendFileSync
 * }} [options]
 */
export function openTarget(target, {
  env = process.env,
  platform = process.platform,
  stdoutTTY = Boolean(process.stdout.isTTY),
  spawnSyncImpl = spawnSync,
  appendFileSyncImpl = appendFileSync
} = {}) {
  if (env.LOOP_OPEN_TARGET_LOG) {
    appendFileSyncImpl(env.LOOP_OPEN_TARGET_LOG, `${target}\n`);
    return { opened: false, recorded: true, target };
  }
  if (!stdoutTTY) {
    return { opened: false, recorded: false, target, reason: "non-tty" };
  }
  /** @type {Partial<Record<NodeJS.Platform, string>>} */
  const commandByPlatform = {
    darwin: "open",
    win32: "cmd",
    linux: "xdg-open"
  };
  const command = commandByPlatform[platform];
  if (!command) {
    return { opened: false, recorded: false, target, reason: "unsupported-platform" };
  }
  const args = platform === "win32" ? ["/c", "start", "", target] : [target];
  const result = spawnSyncImpl(command, args, { stdio: "ignore" });
  return {
    opened: true,
    recorded: false,
    target,
    command,
    args,
    status: result.status ?? null
  };
}
