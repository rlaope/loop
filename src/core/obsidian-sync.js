import { createHash, randomUUID } from "node:crypto";
import { access, mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { homedir, platform } from "node:os";
import { basename, dirname, join, resolve, sep } from "node:path";

import {
  readWikiIndex,
  refreshWikiNoteDerivedArtifacts,
  wikiNotePath
} from "./wiki-store.js";

const DEFAULT_STATE_DIR = ".loop";
const CONFIG_FILE = "obsidian-sync.json";
const MANIFEST_FILE = "obsidian-sync-manifest.json";
const CONFLICTS_DIR = join("wiki", "conflicts");
const DEFAULT_INTERVAL_MS = 2000;

/**
 * @typedef {{
 *   version: 1,
 *   vaultPath: string,
 *   projectId: string,
 *   projectName: string,
 *   projectFolder: string,
 *   syncRoot: string,
 *   enabled: boolean,
 *   createdAt: string,
 *   updatedAt: string
 * }} ObsidianSyncConfig
 *
 * @typedef {{
 *   id: string,
 *   loopPath: string,
 *   obsidianRelativePath: string,
 *   baseHash: string,
 *   baseContent: string,
 *   loopHash: string,
 *   obsidianHash: string,
 *   paused?: boolean,
 *   conflictPath?: string,
 *   updatedAt: string
 * }} ObsidianSyncManifestNote
 *
 * @typedef {{
 *   version: 1,
 *   updatedAt: string,
 *   notes: Record<string, ObsidianSyncManifestNote>
 * }} ObsidianSyncManifest
 */

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

/** @param {string} value */
function hashText(value) {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

/** @param {string} value */
function compactHash(value) {
  return createHash("sha256").update(value).digest("hex").slice(0, 12);
}

/**
 * @param {string} value
 * @param {string} fallback
 */
function safeSegment(value, fallback) {
  const cleaned = value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^\p{Letter}\p{Number}._-]+/gu, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
  return cleaned || fallback;
}

/** @param {string} value */
function escapeXml(value) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/**
 * @param {string} root
 * @param {string} child
 */
function assertInside(root, child) {
  const base = resolve(root);
  const target = resolve(child);
  if (target !== base && !target.startsWith(`${base}${sep}`)) {
    throw new Error(`Path escapes Obsidian sync boundary: ${child}`);
  }
}

/**
 * @param {string} path
 * @param {string} contents
 */
async function atomicWriteFile(path, contents) {
  const tempPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
  await mkdir(dirname(path), { recursive: true });
  try {
    await writeFile(tempPath, contents);
    await rename(tempPath, path);
  } catch (error) {
    await rm(tempPath, { force: true }).catch(() => {});
    throw error;
  }
}

/** @param {string} path */
async function readTextIfExists(path) {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if (getErrorCode(error) === "ENOENT") {
      return null;
    }
    throw error;
  }
}

/** @param {string} path */
async function directoryExists(path) {
  try {
    return (await stat(path)).isDirectory();
  } catch (error) {
    if (getErrorCode(error) === "ENOENT") {
      return false;
    }
    throw error;
  }
}

/**
 * @param {string} stateDir
 */
export function obsidianSyncConfigPath(stateDir = DEFAULT_STATE_DIR) {
  return join(stateDir, CONFIG_FILE);
}

/**
 * @param {string} stateDir
 */
export function obsidianSyncManifestPath(stateDir = DEFAULT_STATE_DIR) {
  return join(stateDir, MANIFEST_FILE);
}

/**
 * @param {{ cwd?: string, stateDir?: string }} [options]
 */
export function obsidianProjectIdentity({ cwd = process.cwd(), stateDir = DEFAULT_STATE_DIR } = {}) {
  const resolvedStateDir = resolve(cwd, stateDir);
  const projectRoot = basename(resolvedStateDir) === DEFAULT_STATE_DIR
    ? dirname(resolvedStateDir)
    : resolve(cwd);
  const projectName = safeSegment(basename(projectRoot), "project");
  const projectId = compactHash(resolvedStateDir);
  return {
    projectId,
    projectName,
    projectFolder: `${projectName}-${projectId}`
  };
}

/**
 * @param {unknown} value
 * @returns {value is ObsidianSyncConfig}
 */
function isConfig(value) {
  return isRecord(value) &&
    value.version === 1 &&
    typeof value.vaultPath === "string" &&
    typeof value.projectId === "string" &&
    typeof value.projectName === "string" &&
    typeof value.projectFolder === "string" &&
    typeof value.syncRoot === "string" &&
    typeof value.enabled === "boolean" &&
    typeof value.createdAt === "string" &&
    typeof value.updatedAt === "string";
}

/**
 * @param {ObsidianSyncConfig} config
 * @param {{ cwd?: string, stateDir?: string }} [options]
 * @returns {ObsidianSyncConfig}
 */
function normalizeObsidianSyncConfig(config, { cwd = process.cwd(), stateDir = DEFAULT_STATE_DIR } = {}) {
  const expected = obsidianProjectIdentity({ cwd, stateDir });
  if (
    config.projectId !== expected.projectId ||
    config.projectName !== expected.projectName ||
    config.projectFolder !== expected.projectFolder
  ) {
    throw new Error("Obsidian sync config project identity does not match this Loop state directory");
  }
  const vaultPath = resolve(config.vaultPath);
  const syncRoot = join(vaultPath, "Loop", expected.projectFolder);
  assertInside(join(vaultPath, "Loop"), syncRoot);
  return {
    ...config,
    vaultPath,
    projectId: expected.projectId,
    projectName: expected.projectName,
    projectFolder: expected.projectFolder,
    syncRoot
  };
}

/**
 * @param {{ stateDir?: string, cwd?: string }} [options]
 * @returns {Promise<ObsidianSyncConfig | null>}
 */
export async function readObsidianSyncConfig({ stateDir = DEFAULT_STATE_DIR, cwd = process.cwd() } = {}) {
  try {
    const parsed = JSON.parse(await readFile(obsidianSyncConfigPath(stateDir), "utf8"));
    if (!isConfig(parsed)) {
      throw new Error("Obsidian sync config must be a version 1 object");
    }
    return normalizeObsidianSyncConfig(parsed, { cwd, stateDir });
  } catch (error) {
    if (getErrorCode(error) === "ENOENT") {
      return null;
    }
    throw error;
  }
}

/**
 * @param {ObsidianSyncConfig} config
 * @param {{ stateDir?: string }} [options]
 */
async function writeObsidianSyncConfig(config, { stateDir = DEFAULT_STATE_DIR } = {}) {
  await atomicWriteFile(obsidianSyncConfigPath(stateDir), `${JSON.stringify(config, null, 2)}\n`);
}

/**
 * @param {unknown} value
 * @returns {value is ObsidianSyncManifestNote}
 */
function isManifestNote(value) {
  return isRecord(value) &&
    typeof value.id === "string" &&
    typeof value.loopPath === "string" &&
    typeof value.obsidianRelativePath === "string" &&
    typeof value.baseHash === "string" &&
    typeof value.baseContent === "string" &&
    typeof value.loopHash === "string" &&
    typeof value.obsidianHash === "string" &&
    typeof value.updatedAt === "string";
}

/**
 * @param {{ stateDir?: string }} [options]
 * @returns {Promise<ObsidianSyncManifest>}
 */
export async function readObsidianSyncManifest({ stateDir = DEFAULT_STATE_DIR } = {}) {
  try {
    const parsed = JSON.parse(await readFile(obsidianSyncManifestPath(stateDir), "utf8"));
    if (!isRecord(parsed) || parsed.version !== 1 || !isRecord(parsed.notes)) {
      throw new Error("Obsidian sync manifest must be a version 1 object");
    }
    /** @type {Record<string, ObsidianSyncManifestNote>} */
    const notes = {};
    for (const [id, note] of Object.entries(parsed.notes)) {
      if (!isManifestNote(note)) {
        throw new Error(`Obsidian sync manifest note ${id} must be a version 1 object`);
      }
      notes[id] = {
        ...note,
        paused: note.paused === true,
        conflictPath: typeof note.conflictPath === "string" ? note.conflictPath : undefined
      };
    }
    return {
      version: 1,
      updatedAt: typeof parsed.updatedAt === "string" ? parsed.updatedAt : new Date(0).toISOString(),
      notes
    };
  } catch (error) {
    if (getErrorCode(error) === "ENOENT") {
      return {
        version: 1,
        updatedAt: new Date(0).toISOString(),
        notes: {}
      };
    }
    throw error;
  }
}

/**
 * @param {ObsidianSyncManifest} manifest
 * @param {{ stateDir?: string }} [options]
 */
async function writeObsidianSyncManifest(manifest, { stateDir = DEFAULT_STATE_DIR } = {}) {
  await atomicWriteFile(obsidianSyncManifestPath(stateDir), `${JSON.stringify(manifest, null, 2)}\n`);
}

/**
 * @param {{
 *   stateDir?: string,
 *   cwd?: string,
 *   vaultPath: string,
 *   now?: Date
 * }} options
 */
export async function initObsidianSync({
  stateDir = DEFAULT_STATE_DIR,
  cwd = process.cwd(),
  vaultPath,
  now = new Date()
}) {
  const resolvedVaultPath = resolve(vaultPath);
  const identity = obsidianProjectIdentity({ cwd, stateDir });
  const syncRoot = join(resolvedVaultPath, "Loop", identity.projectFolder);
  const nowIso = now.toISOString();
  await mkdir(syncRoot, { recursive: true });
  const existing = await readObsidianSyncConfig({ stateDir, cwd });
  /** @type {ObsidianSyncConfig} */
  const config = {
    version: 1,
    vaultPath: resolvedVaultPath,
    projectId: identity.projectId,
    projectName: identity.projectName,
    projectFolder: identity.projectFolder,
    syncRoot,
    enabled: true,
    createdAt: existing?.createdAt ?? nowIso,
    updatedAt: nowIso
  };
  await writeObsidianSyncConfig(config, { stateDir });
  return {
    ok: true,
    config,
    configPath: obsidianSyncConfigPath(stateDir)
  };
}

/**
 * @param {{
 *   homeDir?: string,
 *   searchRoots?: string[],
 *   maxDepth?: number,
 *   maxCandidates?: number
 * }} [options]
 */
export async function detectObsidianVaults({
  homeDir = homedir(),
  searchRoots,
  maxDepth = 3,
  maxCandidates = 12
} = {}) {
  const roots = searchRoots ?? [
    join(homeDir, "Documents"),
    join(homeDir, "Desktop"),
    join(homeDir, "Obsidian"),
    join(homeDir, "vaults")
  ];
  /** @type {string[]} */
  const found = [];
  /** @type {{ path: string, depth: number }[]} */
  const queue = [];
  for (const root of roots) {
    if (await directoryExists(root)) {
      queue.push({ path: resolve(root), depth: 0 });
    }
  }
  /** @type {Set<string>} */
  const seen = new Set();
  while (queue.length && found.length < maxCandidates) {
    const current = queue.shift();
    if (!current || seen.has(current.path)) {
      continue;
    }
    seen.add(current.path);
    if (await directoryExists(join(current.path, ".obsidian"))) {
      found.push(current.path);
      continue;
    }
    if (current.depth >= maxDepth) {
      continue;
    }
    let entries;
    try {
      entries = await readdir(current.path, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name === "node_modules" || entry.name === ".git") {
        continue;
      }
      if (entry.name.startsWith(".") && entry.name !== ".obsidian") {
        continue;
      }
      queue.push({ path: join(current.path, entry.name), depth: current.depth + 1 });
    }
  }
  return found.sort((left, right) => left.localeCompare(right));
}

/**
 * @param {{
 *   stateDir?: string,
 *   cwd?: string,
 *   homeDir?: string,
 *   searchRoots?: string[],
 *   maxDepth?: number,
 *   detectCandidates?: boolean
 * }} [options]
 */
export async function obsidianSyncStatus({
  stateDir = DEFAULT_STATE_DIR,
  cwd = process.cwd(),
  homeDir,
  searchRoots,
  maxDepth,
  detectCandidates = true
} = {}) {
  const config = await readObsidianSyncConfig({ stateDir, cwd });
  const candidates = config || !detectCandidates
    ? []
    : await detectObsidianVaults({ homeDir, searchRoots, maxDepth });
  const identity = obsidianProjectIdentity({ cwd, stateDir });
  return {
    configured: Boolean(config),
    configPath: obsidianSyncConfigPath(stateDir),
    manifestPath: obsidianSyncManifestPath(stateDir),
    config,
    candidates,
    project: identity
  };
}

/**
 * @param {import("./wiki-store.js").WikiIndexEntry} note
 */
function noteFileName(note) {
  return `${note.id}-${safeSegment(note.title || note.id, "note")}.md`;
}

/**
 * @param {ObsidianSyncConfig} config
 * @param {string} relativePath
 */
function obsidianPathFor(config, relativePath) {
  const path = resolve(config.vaultPath, relativePath);
  assertInside(config.vaultPath, path);
  assertInside(config.syncRoot, path);
  return path;
}

/**
 * @param {string} base
 * @param {string} loopContent
 * @param {string} obsidianContent
 */
function tryThreeWayMerge(base, loopContent, obsidianContent) {
  if (loopContent === obsidianContent) {
    return { ok: true, content: loopContent };
  }
  if (loopContent === base) {
    return { ok: true, content: obsidianContent };
  }
  if (obsidianContent === base) {
    return { ok: true, content: loopContent };
  }
  if (base && loopContent.startsWith(base) && obsidianContent.startsWith(base)) {
    const loopSuffix = loopContent.slice(base.length);
    const obsidianSuffix = obsidianContent.slice(base.length);
    const joiner = loopSuffix.endsWith("\n") || obsidianSuffix.startsWith("\n") ? "" : "\n";
    return {
      ok: true,
      content: `${base}${loopSuffix}${joiner}${obsidianSuffix}`
    };
  }
  return { ok: false, content: null };
}

/**
 * @param {{
 *   stateDir: string,
 *   noteId: string,
 *   loopContent: string,
 *   obsidianContent: string,
 *   baseContent: string,
 *   now: Date
 * }} input
 */
async function writeConflictFile({
  stateDir,
  noteId,
  loopContent,
  obsidianContent,
  baseContent,
  now
}) {
  const timestamp = now.toISOString().replace(/[:.]/g, "");
  const conflictPath = join(stateDir, CONFLICTS_DIR, `${noteId}-${timestamp}.md`);
  const markdown = [
    `# Obsidian Sync Conflict: ${noteId}`,
    "",
    "Loop detected edits on both sides and refused to overwrite either note.",
    "Resolve the conflict manually, then run Obsidian sync again.",
    "",
    "## Loop Wiki Version",
    "",
    "```md",
    loopContent,
    "```",
    "",
    "## Obsidian Version",
    "",
    "```md",
    obsidianContent,
    "```",
    "",
    "## Last Synced Base",
    "",
    "```md",
    baseContent,
    "```",
    ""
  ].join("\n");
  await atomicWriteFile(conflictPath, markdown);
  return conflictPath;
}

/**
 * @param {{
 *   noteId: string,
 *   loopPath: string,
 *   obsidianRelativePath: string,
 *   baseContent: string,
 *   loopContent: string,
 *   obsidianContent: string,
 *   nowIso: string,
 *   paused?: boolean,
 *   conflictPath?: string
 * }} input
 * @returns {ObsidianSyncManifestNote}
 */
function manifestNote({
  noteId,
  loopPath,
  obsidianRelativePath,
  baseContent,
  loopContent,
  obsidianContent,
  nowIso,
  paused = false,
  conflictPath
}) {
  return {
    id: noteId,
    loopPath,
    obsidianRelativePath,
    baseHash: hashText(baseContent),
    baseContent,
    loopHash: hashText(loopContent),
    obsidianHash: hashText(obsidianContent),
    paused,
    conflictPath,
    updatedAt: nowIso
  };
}

/**
 * @param {{
 *   stateDir?: string,
 *   cwd?: string,
 *   config?: ObsidianSyncConfig | null,
 *   now?: Date
 * }} [options]
 */
export async function syncObsidianWiki({
  stateDir = DEFAULT_STATE_DIR,
  cwd = process.cwd(),
  config = null,
  now = new Date()
} = {}) {
  const resolvedConfig = config
    ? normalizeObsidianSyncConfig(config, { stateDir, cwd })
    : await readObsidianSyncConfig({ stateDir, cwd });
  if (!resolvedConfig) {
    throw new Error("Obsidian sync is not configured. Run loop wiki obsidian init --vault <path> first.");
  }
  await mkdir(resolvedConfig.syncRoot, { recursive: true });
  const index = await readWikiIndex({ stateDir });
  const manifest = await readObsidianSyncManifest({ stateDir });
  const nowIso = now.toISOString();
  const nextManifest = {
    version: /** @type {1} */ (1),
    updatedAt: nowIso,
    notes: { ...manifest.notes }
  };
  const summary = {
    ok: true,
    config: resolvedConfig,
    manifestPath: obsidianSyncManifestPath(stateDir),
    synced: 0,
    unchanged: 0,
    loopToObsidian: 0,
    obsidianToLoop: 0,
    merged: 0,
    conflicts: 0,
    paused: 0,
    notes: /** @type {Array<{ id: string, action: string, obsidianPath?: string, conflictPath?: string }>} */ ([])
  };

  for (const note of index.notes) {
    const existing = nextManifest.notes[note.id];
    const loopPath = wikiNotePath({ stateDir, id: note.id });
    const obsidianRelativePath = existing?.obsidianRelativePath ?? join("Loop", resolvedConfig.projectFolder, noteFileName(note));
    const obsidianPath = obsidianPathFor(resolvedConfig, obsidianRelativePath);
    if (existing?.paused) {
      summary.paused += 1;
      summary.notes.push({ id: note.id, action: "paused", obsidianPath, conflictPath: existing.conflictPath });
      continue;
    }

    const loopContent = await readFile(loopPath, "utf8");
    const obsidianContent = await readTextIfExists(obsidianPath);
    if (!existing || obsidianContent === null) {
      await atomicWriteFile(obsidianPath, loopContent);
      nextManifest.notes[note.id] = manifestNote({
        noteId: note.id,
        loopPath,
        obsidianRelativePath,
        baseContent: loopContent,
        loopContent,
        obsidianContent: loopContent,
        nowIso
      });
      summary.loopToObsidian += 1;
      summary.synced += 1;
      summary.notes.push({ id: note.id, action: "loop-to-obsidian", obsidianPath });
      continue;
    }

    const loopHash = hashText(loopContent);
    const obsidianHash = hashText(obsidianContent);
    const loopChanged = loopHash !== existing.loopHash;
    const obsidianChanged = obsidianHash !== existing.obsidianHash;
    if (!loopChanged && !obsidianChanged) {
      summary.unchanged += 1;
      summary.notes.push({ id: note.id, action: "unchanged", obsidianPath });
      continue;
    }
    if (loopChanged && !obsidianChanged) {
      await atomicWriteFile(obsidianPath, loopContent);
      nextManifest.notes[note.id] = manifestNote({
        noteId: note.id,
        loopPath,
        obsidianRelativePath,
        baseContent: loopContent,
        loopContent,
        obsidianContent: loopContent,
        nowIso
      });
      summary.loopToObsidian += 1;
      summary.synced += 1;
      summary.notes.push({ id: note.id, action: "loop-to-obsidian", obsidianPath });
      continue;
    }
    if (!loopChanged && obsidianChanged) {
      await atomicWriteFile(loopPath, obsidianContent);
      await refreshWikiNoteDerivedArtifacts(note.id, { stateDir, now });
      nextManifest.notes[note.id] = manifestNote({
        noteId: note.id,
        loopPath,
        obsidianRelativePath,
        baseContent: obsidianContent,
        loopContent: obsidianContent,
        obsidianContent,
        nowIso
      });
      summary.obsidianToLoop += 1;
      summary.synced += 1;
      summary.notes.push({ id: note.id, action: "obsidian-to-loop", obsidianPath });
      continue;
    }

    const merged = tryThreeWayMerge(existing.baseContent, loopContent, obsidianContent);
    if (merged.ok && typeof merged.content === "string") {
      await atomicWriteFile(loopPath, merged.content);
      await atomicWriteFile(obsidianPath, merged.content);
      await refreshWikiNoteDerivedArtifacts(note.id, { stateDir, now });
      nextManifest.notes[note.id] = manifestNote({
        noteId: note.id,
        loopPath,
        obsidianRelativePath,
        baseContent: merged.content,
        loopContent: merged.content,
        obsidianContent: merged.content,
        nowIso
      });
      summary.merged += 1;
      summary.synced += 1;
      summary.notes.push({ id: note.id, action: "merged", obsidianPath });
      continue;
    }

    const conflictPath = await writeConflictFile({
      stateDir,
      noteId: note.id,
      loopContent,
      obsidianContent,
      baseContent: existing.baseContent,
      now
    });
    nextManifest.notes[note.id] = manifestNote({
      noteId: note.id,
      loopPath,
      obsidianRelativePath,
      baseContent: existing.baseContent,
      loopContent,
      obsidianContent,
      nowIso,
      paused: true,
      conflictPath
    });
    summary.conflicts += 1;
    summary.paused += 1;
    summary.notes.push({ id: note.id, action: "conflict", obsidianPath, conflictPath });
  }

  await writeObsidianSyncManifest(nextManifest, { stateDir });
  return summary;
}

/**
 * @param {{
 *   stateDir?: string,
 *   intervalMs?: number,
 *   syncImpl?: (options: { stateDir?: string }) => Promise<unknown>,
 *   onResult?: (result: unknown) => void,
 *   onError?: (error: unknown) => void
 * }} [options]
 */
export function startObsidianSyncWatcher({
  stateDir = DEFAULT_STATE_DIR,
  intervalMs = DEFAULT_INTERVAL_MS,
  syncImpl = syncObsidianWiki,
  onResult = () => {},
  onError = () => {}
} = {}) {
  let stopped = false;
  let running = false;
  /** @type {NodeJS.Timeout | null} */
  let timer = null;
  let maxConcurrent = 0;
  let concurrent = 0;

  const schedule = () => {
    if (!stopped) {
      timer = setTimeout(runOnce, Math.max(1, intervalMs));
    }
  };
  const runOnce = async () => {
    if (stopped || running) {
      schedule();
      return;
    }
    running = true;
    concurrent += 1;
    maxConcurrent = Math.max(maxConcurrent, concurrent);
    try {
      onResult(await syncImpl({ stateDir }));
    } catch (error) {
      onError(error);
    } finally {
      concurrent -= 1;
      running = false;
      schedule();
    }
  };
  timer = setTimeout(runOnce, 0);
  return {
    stop() {
      stopped = true;
      if (timer) {
        clearTimeout(timer);
      }
    },
    stats() {
      return {
        running,
        stopped,
        maxConcurrent
      };
    }
  };
}

/**
 * @param {{
 *   stateDir?: string,
 *   label?: string,
 *   nodePath?: string,
 *   scriptPath?: string,
 *   cwd?: string,
 *   intervalMs?: number
 * }} [options]
 */
export function renderMacLaunchAgentPlist({
  stateDir = DEFAULT_STATE_DIR,
  label = "com.rlaope.loop.obsidian-sync",
  nodePath = process.execPath,
  scriptPath = process.argv[1] || "loop",
  cwd = process.cwd(),
  intervalMs = DEFAULT_INTERVAL_MS
} = {}) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${escapeXml(label)}</string>
  <key>WorkingDirectory</key>
  <string>${escapeXml(resolve(cwd))}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${escapeXml(nodePath)}</string>
    <string>${escapeXml(scriptPath)}</string>
    <string>wiki</string>
    <string>obsidian</string>
    <string>watch</string>
    <string>--state-dir</string>
    <string>${escapeXml(stateDir)}</string>
    <string>--interval</string>
    <string>${escapeXml(String(intervalMs))}</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
</dict>
</plist>
`;
}

/**
 * @param {{
 *   stateDir?: string,
 *   homeDir?: string,
 *   label?: string,
 *   nodePath?: string,
 *   scriptPath?: string,
 *   cwd?: string,
 *   intervalMs?: number,
 *   platformName?: NodeJS.Platform
 * }} [options]
 */
export async function installObsidianSyncService({
  stateDir = DEFAULT_STATE_DIR,
  homeDir = homedir(),
  label = "com.rlaope.loop.obsidian-sync",
  nodePath,
  scriptPath,
  cwd,
  intervalMs,
  platformName = platform()
} = {}) {
  if (platformName !== "darwin") {
    return {
      ok: false,
      unsupported: true,
      message: "Persistent Obsidian sync service install is currently supported on macOS only."
    };
  }
  await access(obsidianSyncConfigPath(stateDir));
  const plistPath = join(homeDir, "Library", "LaunchAgents", `${label}.plist`);
  await atomicWriteFile(plistPath, renderMacLaunchAgentPlist({
    stateDir,
    label,
    nodePath,
    scriptPath,
    cwd,
    intervalMs
  }));
  return {
    ok: true,
    unsupported: false,
    plistPath
  };
}
