import { resolve } from "node:path";

import { appendEvidence, createRunState, transitionRunState } from "./run-state.js";
import {
  deleteRunState,
  listRunStates,
  readRunLog,
  readRunState,
  writeRunState
} from "./state-store.js";
import {
  deleteWikiNote,
  listWikiNotes,
  readWikiNote,
  writeWikiSupportingNote
} from "./wiki-store.js";

const DEFAULT_STATE_DIR = ".loop";

export const DANGEROUS_ACTIONS = Object.freeze([
  "add-note",
  "delete-run",
  "delete-note",
  "verify-run",
  "mark-complete",
  "follow-up-run",
  "open-codex"
]);

/**
 * @typedef {{ accepted: true, action: string, targetId: string, stateDir: string, token?: string }} ActionConfirmation
 * @typedef {{ ok: false, requiresConfirmation: true, action: string, targetId: string, confirmationLabel: string, error: { kind: "confirmation_required" | "confirmation_mismatch", message: string } }} ConfirmationFailure
 */

/**
 * @param {string} action
 * @param {string} targetId
 */
function confirmationLabel(action, targetId) {
  const label = action
    .split("-")
    .map((part) => `${part.slice(0, 1).toUpperCase()}${part.slice(1)}`)
    .join(" ");
  return `${label} ${targetId}`;
}

/**
 * @param {{ action: string, targetId: string, stateDir?: string }} input
 * @returns {ActionConfirmation}
 */
export function createActionConfirmation({ action, targetId, stateDir = DEFAULT_STATE_DIR }) {
  return {
    accepted: true,
    action,
    targetId,
    stateDir
  };
}

/**
 * @param {string} action
 * @param {string} targetId
 * @param {string} message
 * @param {"confirmation_required" | "confirmation_mismatch"} kind
 * @returns {ConfirmationFailure}
 */
function confirmationFailure(action, targetId, message, kind) {
  return {
    ok: false,
    requiresConfirmation: true,
    action,
    targetId,
    confirmationLabel: confirmationLabel(action, targetId),
    error: {
      kind,
      message
    }
  };
}

/**
 * @param {{ action: string, targetId: string, stateDir?: string, confirmation?: Partial<ActionConfirmation> }} input
 * @returns {null | ConfirmationFailure}
 */
export function requireActionConfirmation({
  action,
  targetId,
  stateDir = DEFAULT_STATE_DIR,
  confirmation
}) {
  if (!confirmation || confirmation.accepted !== true) {
    return confirmationFailure(action, targetId, "Action requires explicit confirmation.", "confirmation_required");
  }
  if (
    typeof confirmation.action !== "string" ||
    typeof confirmation.targetId !== "string" ||
    typeof confirmation.stateDir !== "string" ||
    confirmation.action !== action ||
    confirmation.targetId !== targetId ||
    resolve(confirmation.stateDir) !== resolve(stateDir)
  ) {
    return confirmationFailure(action, targetId, "Confirmation does not match this action target.", "confirmation_mismatch");
  }
  return null;
}

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * @param {unknown} state
 */
function sessionFromState(state) {
  return isRecord(state) && isRecord(state.session) ? state.session : null;
}

/** @param {string} log */
function codexSessionIdFromLog(log) {
  return log.match(/\bsession id:\s*([0-9a-f]{8}-[0-9a-f-]{13,})/i)?.[1] ?? null;
}

/**
 * @param {string} target
 */
function linkTargetId(target) {
  const filename = target.split("/").pop() ?? target;
  return filename.endsWith(".md") ? filename.slice(0, -3) : filename;
}

/**
 * @param {{ stateDir?: string }} [options]
 */
export async function listRunsAction({ stateDir = DEFAULT_STATE_DIR } = {}) {
  const runs = await listRunStates({ stateDir });
  return {
    ok: true,
    runs: runs.map((run) => ({
      id: run.state.id,
      objective: run.state.objective,
      objectiveSlug: run.state.objectiveSlug,
      phase: run.state.phase,
      status: run.state.status,
      nextAction: run.state.nextAction,
      updatedAt: run.state.updatedAt,
      paths: {
        jsonPath: run.path,
        summaryPath: run.summaryPath,
        logPath: run.logPath
      },
      session: sessionFromState(run.state),
      lineage: run.state.lineage
    }))
  };
}

/**
 * @param {{ id: string, stateDir?: string }} options
 */
export async function readRunAction({ id, stateDir = DEFAULT_STATE_DIR }) {
  const read = await readRunState(id, { stateDir });
  if (!read.ok) {
    return { ok: false, error: read.error };
  }
  const log = await readRunLog(id, { stateDir });
  return {
    ok: true,
    state: read.state,
    log
  };
}

/**
 * @param {{ id: string, stateDir?: string, maxLines?: number }} options
 */
export async function readRunLogTailAction({ id, stateDir = DEFAULT_STATE_DIR, maxLines = 80 }) {
  const log = await readRunLog(id, { stateDir });
  const lines = log.split(/\r?\n/);
  return {
    ok: true,
    id,
    log: lines.slice(Math.max(0, lines.length - maxLines)).join("\n")
  };
}

/**
 * @param {{ stateDir?: string }} [options]
 */
export async function listWikiNotesAction({ stateDir = DEFAULT_STATE_DIR } = {}) {
  return {
    ok: true,
    notes: await listWikiNotes({ stateDir })
  };
}

/**
 * @param {{ id: string, stateDir?: string }} options
 */
export async function readWikiNoteAction({ id, stateDir = DEFAULT_STATE_DIR }) {
  try {
    const note = await readWikiNote(id, { stateDir });
    return { ok: true, note };
  } catch (error) {
    return {
      ok: false,
      error: {
        kind: "note_read_failed",
        message: error instanceof Error ? error.message : String(error)
      }
    };
  }
}

/**
 * @param {{ stateDir?: string, runId?: string, parentId?: string, kind?: string, title: string, body: string, targetId?: string, confirmation?: Partial<ActionConfirmation> }} options
 */
export async function addWikiNoteAction(options) {
  const stateDir = options.stateDir ?? DEFAULT_STATE_DIR;
  const targetId = options.targetId ?? options.parentId ?? options.runId ?? "wiki";
  const confirmationError = requireActionConfirmation({
    action: "add-note",
    targetId,
    stateDir,
    confirmation: options.confirmation
  });
  if (confirmationError) {
    return confirmationError;
  }
  const result = await writeWikiSupportingNote({
    stateDir,
    runId: options.runId,
    parentId: options.parentId,
    kind: options.kind,
    title: options.title,
    body: options.body
  });
  return { ok: true, result };
}

/**
 * @param {{ id: string, stateDir?: string, confirmation?: Partial<ActionConfirmation> }} options
 */
export async function deleteWikiNoteAction({ id, stateDir = DEFAULT_STATE_DIR, confirmation }) {
  const confirmationError = requireActionConfirmation({
    action: "delete-note",
    targetId: id,
    stateDir,
    confirmation
  });
  if (confirmationError) {
    return confirmationError;
  }
  return {
    ok: true,
    result: await deleteWikiNote(id, { stateDir })
  };
}

/**
 * @param {{ id: string, stateDir?: string, confirmation?: Partial<ActionConfirmation> }} options
 */
export async function deleteRunAction({ id, stateDir = DEFAULT_STATE_DIR, confirmation }) {
  const confirmationError = requireActionConfirmation({
    action: "delete-run",
    targetId: id,
    stateDir,
    confirmation
  });
  if (confirmationError) {
    return confirmationError;
  }
  return {
    ok: true,
    result: await deleteRunState(id, { stateDir })
  };
}

/**
 * @param {{ id: string, stateDir?: string, kind?: string, status?: string, summary: string, confirmation?: Partial<ActionConfirmation> }} options
 */
export async function markVerificationAction({
  id,
  stateDir = DEFAULT_STATE_DIR,
  kind = "manual",
  status = "passed",
  summary,
  confirmation
}) {
  const confirmationError = requireActionConfirmation({
    action: "verify-run",
    targetId: id,
    stateDir,
    confirmation
  });
  if (confirmationError) {
    return confirmationError;
  }
  const read = await readRunState(id, { stateDir });
  if (!read.ok) {
    return { ok: false, error: read.error };
  }
  const next = {
    ...appendEvidence(read.state, { kind, status, summary }),
    phase: "verify",
    nextAction: "review verification evidence and decide whether the run is complete"
  };
  const paths = await writeRunState(next, { stateDir });
  return { ok: true, state: next, paths };
}

/**
 * @param {{ id: string, stateDir?: string, confirmation?: Partial<ActionConfirmation>, summary?: string }} options
 */
export async function markCompleteAction({
  id,
  stateDir = DEFAULT_STATE_DIR,
  confirmation,
  summary = "Marked complete by Loop action."
}) {
  const confirmationError = requireActionConfirmation({
    action: "mark-complete",
    targetId: id,
    stateDir,
    confirmation
  });
  if (confirmationError) {
    return confirmationError;
  }
  const read = await readRunState(id, { stateDir });
  if (!read.ok) {
    return { ok: false, error: read.error };
  }
  const completed = transitionRunState(appendEvidence(read.state, {
    kind: "manual",
    status: "passed",
    summary
  }), "complete", {
    nextAction: "complete"
  });
  const paths = await writeRunState(completed, { stateDir });
  return { ok: true, state: completed, paths };
}

/**
 * @param {{ parentRunId: string, prompt: string, stateDir?: string, createdFrom: "tui" | "dashboard" | "cli", confirmation?: Partial<ActionConfirmation> }} options
 */
export async function prepareFollowUpRunAction({
  parentRunId,
  prompt,
  stateDir = DEFAULT_STATE_DIR,
  createdFrom,
  confirmation
}) {
  const confirmationError = requireActionConfirmation({
    action: "follow-up-run",
    targetId: parentRunId,
    stateDir,
    confirmation
  });
  if (confirmationError) {
    return confirmationError;
  }
  const parent = await readRunState(parentRunId, { stateDir });
  if (!parent.ok) {
    return { ok: false, error: parent.error };
  }
  const state = createRunState({
    objective: prompt,
    lineage: {
      parentRunId,
      rootRunId: parent.state.lineage?.rootRunId ?? parent.state.id,
      relationship: "continues",
      prompt,
      createdFrom
    }
  });
  return {
    ok: true,
    state,
    effect: {
      type: "loop-run",
      objective: prompt,
      lineage: state.lineage
    }
  };
}

/**
 * @param {{ id: string, stateDir?: string, confirmation?: Partial<ActionConfirmation> }} options
 */
export async function prepareCodexOpenAction({ id, stateDir = DEFAULT_STATE_DIR, confirmation }) {
  const confirmationError = requireActionConfirmation({
    action: "open-codex",
    targetId: id,
    stateDir,
    confirmation
  });
  if (confirmationError) {
    return confirmationError;
  }
  const read = await readRunState(id, { stateDir });
  if (!read.ok) {
    return { ok: false, error: read.error };
  }
  const session = sessionFromState(read.state);
  if (!session || session.agent !== "codex") {
    return {
      ok: false,
      error: {
        kind: "codex_session_unavailable",
        message: "No Codex session is recorded for this run."
      }
    };
  }
  const log = await readRunLog(id, { stateDir });
  const sessionId = codexSessionIdFromLog(log);
  if (!sessionId) {
    return {
      ok: false,
      error: {
        kind: "codex_session_id_missing",
        message: "No Codex session id was found in this run log. The dashboard will not guess a different session."
      }
    };
  }
  return {
    ok: true,
    effect: {
      type: "open-codex-terminal",
      runId: id,
      cwd: typeof session.cwd === "string" ? session.cwd : null,
      sessionId
    }
  };
}

/**
 * @param {{ stateDir?: string }} [options]
 */
export async function readGraphAction({ stateDir = DEFAULT_STATE_DIR } = {}) {
  const notes = await listWikiNotes({ stateDir });
  return {
    ok: true,
    graph: {
      nodes: notes.map((note) => ({
        id: note.id,
        label: note.title,
        kind: note.kind,
        parentId: note.parentId,
        runId: note.runId,
        lineage: note.lineage,
        status: note.status
      })),
      edges: notes.flatMap((note) => note.links.map((link) => ({
        source: note.id,
        target: linkTargetId(link.target),
        relationship: link.relationship,
        reason: link.reason
      })))
    }
  };
}
