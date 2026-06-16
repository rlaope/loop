import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";

import { assertValidRunState } from "./schema.js";

const DEFAULT_STATE_DIR = ".loop";
const SAFE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const LATEST_INDEX_FILE = "latest-runs.json";

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** @param {unknown} error */
function getErrorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

/** @param {unknown} error */
function getErrorCode(error) {
  return isRecord(error) && typeof error.code === "string" ? error.code : undefined;
}

/**
 * @typedef {{ kind: string, message?: string, path?: string }} StateStoreError
 * @typedef {{ ok: true, state: import("./run-state.js").LoopRunState, path?: string }} StateStoreSuccess
 * @typedef {{ ok: false, error: StateStoreError }} StateStoreFailure
 * @typedef {StateStoreSuccess | StateStoreFailure} StateStoreResult
 */

/** @param {string} value */
function escapeMarkdown(value) {
  return value.replace(/\|/g, "\\|");
}

/**
 * @param {string} runsDir
 * @param {string} id
 * @param {".json" | ".md" | ".log"} extension
 */
function safeRunPath(runsDir, id, extension) {
  if (!SAFE_ID_PATTERN.test(id)) {
    throw new Error(`Unsafe run id: ${id}`);
  }
  const base = resolve(runsDir);
  const target = resolve(runsDir, `${id}${extension}`);
  if (target !== base && !target.startsWith(`${base}${sep}`)) {
    throw new Error(`Run path escapes state directory: ${id}`);
  }
  return target;
}

/**
 * @param {unknown} value
 * @returns {value is NodeJS.ErrnoException}
 */
function hasCode(value) {
  return isRecord(value) && typeof value.code === "string";
}

/**
 * @param {string} stateDir
 */
function latestIndexPath(stateDir) {
  const base = resolve(stateDir);
  const target = resolve(stateDir, LATEST_INDEX_FILE);
  if (target !== base && !target.startsWith(`${base}${sep}`)) {
    throw new Error("Latest-run index path escapes state directory");
  }
  return target;
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

/**
 * @param {string} stateDir
 * @returns {Promise<
 *   { ok: true, index: Record<string, string> } |
 *   { ok: false, error: StateStoreError }
 * >}
 */
async function readLatestIndex(stateDir) {
  try {
    const parsed = JSON.parse(await readFile(latestIndexPath(stateDir), "utf8"));
    if (!isRecord(parsed)) {
      return {
        ok: false,
        error: {
          kind: "corrupt_or_missing_state",
          message: "latest-run index must be an object",
          path: latestIndexPath(stateDir)
        }
      };
    }
    const invalidEntry = Object.entries(parsed).find(([slug, id]) => (
      !SAFE_ID_PATTERN.test(slug) ||
      typeof id !== "string" ||
      !SAFE_ID_PATTERN.test(id)
    ));
    if (invalidEntry) {
      return {
        ok: false,
        error: {
          kind: "corrupt_or_missing_state",
          message: `latest-run index contains an invalid entry: ${invalidEntry[0]}`,
          path: latestIndexPath(stateDir)
        }
      };
    }
    /** @type {Record<string, string>} */
    const index = {};
    for (const [slug, id] of Object.entries(parsed)) {
      if (typeof id === "string") {
        index[slug] = id;
      }
    }
    return { ok: true, index };
  } catch (error) {
    if (getErrorCode(error) === "ENOENT") {
      return { ok: true, index: {} };
    }
    return {
      ok: false,
      error: {
        kind: "corrupt_or_missing_state",
        message: getErrorMessage(error),
        path: latestIndexPath(stateDir)
      }
    };
  }
}

/**
 * @param {string} stateDir
 * @param {Record<string, string>} index
 */
async function writeLatestIndex(stateDir, index) {
  await atomicWriteFile(latestIndexPath(stateDir), `${JSON.stringify(index, null, 2)}\n`);
}

/**
 * @param {import("./run-state.js").LoopRunState} state
 * @returns {string}
 */
export function renderRunSummary(state) {
  return [
    `# Loop Run: ${state.objective}`,
    "",
    `| Field | Value |`,
    `| --- | --- |`,
    `| ID | ${escapeMarkdown(state.id)} |`,
    `| Phase | ${escapeMarkdown(state.phase)} |`,
    `| Status | ${escapeMarkdown(state.status)} |`,
    `| Next action | ${escapeMarkdown(state.nextAction)} |`,
    `| Attempts | ${state.budget.attemptsUsed}/${state.budget.maxAttempts} |`,
    `| Estimated tokens | ${state.budget.estimatedTokensUsed}/${state.budget.maxEstimatedTokens} |`,
    "",
    `## Stop Condition`,
    "",
    state.stopCondition.description,
    "",
    `## Verification Evidence`,
    "",
    state.verificationEvidence.length === 0
      ? "No evidence recorded yet."
      : state.verificationEvidence.map((evidence) => `- ${evidence.status}: ${evidence.summary}`).join("\n"),
    ""
  ].join("\n");
}

/**
 * @param {import("./run-state.js").LoopRunState} state
 * @param {{ stateDir?: string }} [options]
 */
export async function writeRunState(state, { stateDir = DEFAULT_STATE_DIR } = {}) {
  assertValidRunState(state);
  const runsDir = join(stateDir, "runs");
  await mkdir(runsDir, { recursive: true });

  const jsonPath = safeRunPath(runsDir, state.id, ".json");
  const summaryPath = safeRunPath(runsDir, state.id, ".md");
  await atomicWriteFile(jsonPath, `${JSON.stringify(state, null, 2)}\n`);
  await atomicWriteFile(summaryPath, renderRunSummary(state));
  const latestIndex = await readLatestIndex(stateDir);
  if (!latestIndex.ok) {
    throw new Error(`Corrupt latest-run index: ${latestIndex.error.message ?? latestIndex.error.kind}`);
  }
  const index = latestIndex.index;
  index[state.objectiveSlug] = state.id;
  await writeLatestIndex(stateDir, index);

  return { jsonPath, summaryPath };
}

/**
 * @param {{ stateDir?: string, id: string }} options
 */
export function runLogPath({ stateDir = DEFAULT_STATE_DIR, id }) {
  return safeRunPath(join(stateDir, "runs"), id, ".log");
}

/**
 * @param {string} id
 * @param {{ stateDir?: string }} [options]
 * @returns {Promise<StateStoreResult>}
 */
export async function readRunState(id, { stateDir = DEFAULT_STATE_DIR } = {}) {
  try {
    const runsDir = join(stateDir, "runs");
    const jsonPath = safeRunPath(runsDir, id, ".json");
    const parsed = JSON.parse(await readFile(jsonPath, "utf8"));
    assertValidRunState(parsed);
    return { ok: true, state: parsed, path: jsonPath };
  } catch (error) {
    return {
      ok: false,
      error: {
        kind: "corrupt_or_missing_state",
        message: error instanceof Error ? error.message : String(error),
        path: join(stateDir, "runs", `${id}.json`)
      }
    };
  }
}

/**
 * @param {{ stateDir?: string }} [options]
 * @returns {Promise<Array<{ state: import("./run-state.js").LoopRunState, path: string, summaryPath: string, logPath: string }>>}
 */
export async function listRunStates({ stateDir = DEFAULT_STATE_DIR } = {}) {
  const runsDir = join(stateDir, "runs");
  try {
    const files = (await readdir(runsDir)).filter((file) => file.endsWith(".json"));
    const runs = [];
    for (const file of files) {
      const id = file.slice(0, -5);
      const jsonPath = safeRunPath(runsDir, id, ".json");
      const parsed = JSON.parse(await readFile(jsonPath, "utf8"));
      assertValidRunState(parsed);
      runs.push({
        state: parsed,
        path: jsonPath,
        summaryPath: safeRunPath(runsDir, id, ".md"),
        logPath: safeRunPath(runsDir, id, ".log")
      });
    }
    runs.sort((a, b) => String(b.state.updatedAt).localeCompare(String(a.state.updatedAt)));
    return runs;
  } catch (error) {
    if (hasCode(error) && error.code === "ENOENT") {
      return [];
    }
    throw error;
  }
}

/**
 * @param {string} id
 * @param {{ stateDir?: string }} [options]
 */
export async function readRunLog(id, { stateDir = DEFAULT_STATE_DIR } = {}) {
  try {
    return await readFile(runLogPath({ stateDir, id }), "utf8");
  } catch (error) {
    if (hasCode(error) && error.code === "ENOENT") {
      return "";
    }
    throw error;
  }
}

/**
 * @param {string} id
 * @param {{ stateDir?: string }} [options]
 */
export async function deleteRunState(id, { stateDir = DEFAULT_STATE_DIR } = {}) {
  const read = await readRunState(id, { stateDir });
  const state = read.ok ? read.state : null;
  const runsDir = join(stateDir, "runs");
  await rm(safeRunPath(runsDir, id, ".json"), { force: true });
  await rm(safeRunPath(runsDir, id, ".md"), { force: true });
  await rm(safeRunPath(runsDir, id, ".log"), { force: true });

  const latestIndex = await readLatestIndex(stateDir);
  if (!latestIndex.ok) {
    throw new Error(`Corrupt latest-run index: ${latestIndex.error.message ?? latestIndex.error.kind}`);
  }
  const index = latestIndex.index;
  if (state && index[state.objectiveSlug] === id) {
    const remaining = (await listRunStates({ stateDir }))
      .filter((run) => run.state.objectiveSlug === state.objectiveSlug);
    if (remaining[0]) {
      index[state.objectiveSlug] = remaining[0].state.id;
    } else {
      delete index[state.objectiveSlug];
    }
  } else {
    for (const [slug, indexedId] of Object.entries(index)) {
      if (indexedId === id) {
        delete index[slug];
      }
    }
  }
  await writeLatestIndex(stateDir, index);
  return { deleted: true, state };
}

/**
 * @param {string} objectiveSlug
 * @param {{ stateDir?: string }} [options]
 * @returns {Promise<StateStoreResult>}
 */
export async function readLatestRunBySlug(objectiveSlug, { stateDir = DEFAULT_STATE_DIR } = {}) {
  const runsDir = join(stateDir, "runs");
  try {
    if (!SAFE_ID_PATTERN.test(objectiveSlug)) {
      return { ok: false, error: { kind: "invalid_slug" } };
    }

    const latestIndex = await readLatestIndex(stateDir);
    if (!latestIndex.ok) {
      return { ok: false, error: latestIndex.error };
    }
    const index = latestIndex.index;
    const indexedId = index[objectiveSlug];
    if (indexedId) {
      const indexed = await readRunState(indexedId, { stateDir });
      if (indexed.ok && indexed.state.objectiveSlug === objectiveSlug) {
        return indexed;
      }
    }

    const files = (await readdir(runsDir)).filter((file) => file.endsWith(".json"));
    const candidates = [];
    for (const file of files) {
      const text = await readFile(join(runsDir, file), "utf8");
      const parsed = JSON.parse(text);
      assertValidRunState(parsed);
      if (parsed.objectiveSlug === objectiveSlug) {
        candidates.push(parsed);
      }
    }
    candidates.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
    return candidates[0] ? { ok: true, state: candidates[0] } : { ok: false, error: { kind: "not_found" } };
  } catch (error) {
    return {
      ok: false,
      error: {
        kind: "corrupt_or_missing_state",
        message: error instanceof Error ? error.message : String(error)
      }
    };
  }
}
