import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, resolve } from "node:path";

const REGISTRY_VERSION = 1;

/**
 * @typedef {{
 *   id: string,
 *   name: string,
 *   cwd: string,
 *   stateDir: string,
 *   createdAt: string,
 *   updatedAt: string
 * }} LoopProjectEntry
 */

/**
 * @typedef {{ version: 1, updatedAt: string, projects: LoopProjectEntry[] }} LoopProjectRegistry
 */

/**
 * @param {{ homeDir?: string }} [options]
 */
export function loopProjectRegistryPath({ homeDir = homedir() } = {}) {
  return resolve(homeDir, ".loop", "projects.json");
}

function defaultProjectRegistryPath() {
  return process.env.LOOP_PROJECT_REGISTRY
    ? resolve(process.env.LOOP_PROJECT_REGISTRY)
    : loopProjectRegistryPath();
}

/** @param {string} value */
function projectIdFor(value) {
  return createHash("sha256").update(resolve(value)).digest("hex").slice(0, 12);
}

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * @param {unknown} value
 * @returns {value is LoopProjectEntry}
 */
function isProjectEntry(value) {
  return isRecord(value) &&
    typeof value.id === "string" &&
    typeof value.name === "string" &&
    typeof value.cwd === "string" &&
    typeof value.stateDir === "string" &&
    typeof value.createdAt === "string" &&
    typeof value.updatedAt === "string";
}

/**
 * @param {string} path
 * @param {string} contents
 */
async function atomicWriteFile(path, contents) {
  const tempPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
  await mkdir(dirname(path), { recursive: true });
  try {
    await writeFile(tempPath, contents, { mode: 0o600 });
    await rename(tempPath, path);
  } catch (error) {
    await rm(tempPath, { force: true }).catch(() => {});
    throw error;
  }
}

/**
 * @param {{ registryPath?: string }} [options]
 * @returns {Promise<LoopProjectRegistry>}
 */
export async function readLoopProjectRegistry({ registryPath = defaultProjectRegistryPath() } = {}) {
  try {
    const parsed = JSON.parse(await readFile(registryPath, "utf8"));
    if (!isRecord(parsed) || parsed.version !== REGISTRY_VERSION || !Array.isArray(parsed.projects)) {
      return { version: REGISTRY_VERSION, updatedAt: new Date(0).toISOString(), projects: [] };
    }
    return {
      version: REGISTRY_VERSION,
      updatedAt: typeof parsed.updatedAt === "string" ? parsed.updatedAt : new Date(0).toISOString(),
      projects: parsed.projects.filter(isProjectEntry)
    };
  } catch (error) {
    if (isRecord(error) && error.code === "ENOENT") {
      return { version: REGISTRY_VERSION, updatedAt: new Date(0).toISOString(), projects: [] };
    }
    throw error;
  }
}

/**
 * @param {LoopProjectRegistry} registry
 * @param {{ registryPath?: string }} [options]
 */
export async function writeLoopProjectRegistry(registry, { registryPath = defaultProjectRegistryPath() } = {}) {
  await atomicWriteFile(registryPath, `${JSON.stringify(registry, null, 2)}\n`);
}

/**
 * @param {{
 *   cwd?: string,
 *   stateDir?: string,
 *   registryPath?: string,
 *   now?: Date
 * }} [options]
 */
export async function registerLoopProject({
  cwd = process.cwd(),
  stateDir = ".loop",
  registryPath = defaultProjectRegistryPath(),
  now = new Date()
} = {}) {
  const resolvedCwd = resolve(cwd);
  const resolvedStateDir = resolve(resolvedCwd, stateDir);
  const timestamp = now.toISOString();
  const registry = await readLoopProjectRegistry({ registryPath });
  const id = projectIdFor(resolvedStateDir);
  const existing = registry.projects.find((project) => project.id === id);
  const entry = {
    id,
    name: basename(resolvedCwd) || resolvedCwd,
    cwd: resolvedCwd,
    stateDir: resolvedStateDir,
    createdAt: existing?.createdAt ?? timestamp,
    updatedAt: timestamp
  };
  const projects = [
    entry,
    ...registry.projects.filter((project) => project.id !== id)
  ].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  /** @type {LoopProjectRegistry} */
  const updated = {
    version: REGISTRY_VERSION,
    updatedAt: timestamp,
    projects
  };
  await writeLoopProjectRegistry(updated, { registryPath });
  return entry;
}

/**
 * @param {{ registryPath?: string }} [options]
 */
export async function listLoopProjects({ registryPath = defaultProjectRegistryPath() } = {}) {
  const registry = await readLoopProjectRegistry({ registryPath });
  return registry.projects;
}

/**
 * @param {string} id
 * @param {{ registryPath?: string }} [options]
 */
export async function readLoopProject(id, { registryPath = defaultProjectRegistryPath() } = {}) {
  const projects = await listLoopProjects({ registryPath });
  return projects.find((project) => project.id === id) ?? null;
}
