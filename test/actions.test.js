import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  addWikiNoteAction,
  createActionConfirmation,
  createRunState,
  deleteRunAction,
  deleteWikiNoteAction,
  listRunsAction,
  markCompleteAction,
  markVerificationAction,
  prepareCodexOpenAction,
  prepareFollowUpRunAction,
  readGraphAction,
  readRunLog,
  readRunLogTailAction,
  readRunState,
  runLogPath,
  writeRunState,
  writeWikiForRunState
} from "../src/index.js";

test("action module stays inside the domain boundary", async () => {
  const source = await readFile("src/core/actions.js", "utf8");

  assert.doesNotMatch(source, /node:child_process/);
  assert.doesNotMatch(source, /\bspawn\b/);
  assert.doesNotMatch(source, /process\.stdout|process\.stderr|process\.stdin/);
  assert.doesNotMatch(source, /serveWikiDashboard|startDetachedWikiDashboard|openTarget/);
});

test("shared actions list runs and read log tails without mutating state", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "loop-actions-list-"));
  const state = createRunState({
    objective: "Action list objective",
    now: new Date("2026-06-13T08:00:00.000Z")
  });
  await writeRunState(state, { stateDir });
  await writeFile(runLogPath({ stateDir, id: state.id }), "one\ntwo\nthree\n");

  const before = await readFile(join(stateDir, "runs", `${state.id}.json`), "utf8");
  const runs = await listRunsAction({ stateDir });
  const tail = await readRunLogTailAction({ stateDir, id: state.id, maxLines: 2 });
  const after = await readFile(join(stateDir, "runs", `${state.id}.json`), "utf8");

  assert.equal(runs.ok, true);
  assert.equal(runs.runs[0].id, state.id);
  assert.equal(tail.ok, true);
  assert.equal(tail.log, "three\n");
  assert.equal(after, before);
});

test("delete actions require matching confirmation and leave files unchanged without it", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "loop-actions-delete-"));
  const state = createRunState({
    objective: "Action delete objective",
    now: new Date("2026-06-13T08:00:00.000Z")
  });
  await writeRunState(state, { stateDir });
  const wiki = await writeWikiForRunState(state, { stateDir });

  const missing = await deleteRunAction({ stateDir, id: state.id });
  const wrong = await deleteWikiNoteAction({
    stateDir,
    id: wiki.id,
    confirmation: createActionConfirmation({ action: "delete-run", targetId: state.id, stateDir })
  });
  const stillReadable = await readRunState(state.id, { stateDir });
  const notesBeforeDelete = await readGraphAction({ stateDir });

  assert.equal(missing.ok, false);
  assert.ok("requiresConfirmation" in missing);
  assert.equal(missing.requiresConfirmation, true);
  assert.equal(wrong.ok, false);
  assert.ok("error" in wrong);
  assert.equal(wrong.error.kind, "confirmation_mismatch");
  assert.equal(stillReadable.ok, true);
  assert.equal(notesBeforeDelete.graph.nodes.length, 1);

  const deleteNote = await deleteWikiNoteAction({
    stateDir,
    id: wiki.id,
    confirmation: createActionConfirmation({ action: "delete-note", targetId: wiki.id, stateDir })
  });
  const deleteRun = await deleteRunAction({
    stateDir,
    id: state.id,
    confirmation: createActionConfirmation({ action: "delete-run", targetId: state.id, stateDir })
  });

  assert.equal(deleteNote.ok, true);
  assert.equal(deleteRun.ok, true);
  assert.equal((await readRunState(state.id, { stateDir })).ok, false);
});

test("verification and completion actions update run state through the store", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "loop-actions-complete-"));
  const state = createRunState({
    objective: "Action complete objective",
    now: new Date("2026-06-13T08:00:00.000Z")
  });
  await writeRunState(state, { stateDir });

  const verified = await markVerificationAction({
    stateDir,
    id: state.id,
    confirmation: createActionConfirmation({ action: "verify-run", targetId: state.id, stateDir }),
    summary: "manual QA passed"
  });
  const blockedComplete = await markCompleteAction({ stateDir, id: state.id });
  const completed = await markCompleteAction({
    stateDir,
    id: state.id,
    confirmation: createActionConfirmation({ action: "mark-complete", targetId: state.id, stateDir })
  });

  assert.equal(verified.ok, true);
  assert.ok("state" in verified);
  const verifiedState = verified.state;
  assert.ok(verifiedState);
  assert.equal(verifiedState.phase, "verify");
  assert.equal(blockedComplete.ok, false);
  assert.equal(completed.ok, true);
  assert.ok("state" in completed);
  const completedState = completed.state;
  assert.ok(completedState);
  assert.equal(completedState.status, "complete");
  assert.equal(completedState.verificationEvidence.length, 2);
});

test("follow-up action creates lineage without launching an agent", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "loop-actions-followup-"));
  const parent = createRunState({
    objective: "Parent objective",
    now: new Date("2026-06-13T08:00:00.000Z")
  });
  await writeRunState(parent, { stateDir });

  const child = await prepareFollowUpRunAction({
    stateDir,
    parentRunId: parent.id,
    prompt: "Child objective",
    createdFrom: "tui",
    confirmation: createActionConfirmation({ action: "follow-up-run", targetId: parent.id, stateDir })
  });

  assert.equal(child.ok, true);
  assert.ok("state" in child);
  assert.ok("effect" in child);
  const childState = child.state;
  const childEffect = child.effect;
  assert.ok(childState);
  assert.ok(childEffect);
  assert.equal(childState.lineage?.parentRunId, parent.id);
  assert.equal(childState.lineage?.rootRunId, parent.id);
  assert.equal(childEffect.type, "loop-run");
});

test("codex open action returns a structured effect request", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "loop-actions-codex-"));
  const state = {
    ...createRunState({
      objective: "Codex open objective",
      now: new Date("2026-06-13T08:00:00.000Z")
    }),
    session: {
      agent: "codex",
      status: "running",
      pid: 123,
      cwd: "/tmp/project"
    }
  };
  await writeRunState(state, { stateDir });
  await writeFile(runLogPath({ stateDir, id: state.id }), "session id: 019ec4bd-7118-7443-8d6b-dce6b226eef3\n");

  const opened = await prepareCodexOpenAction({
    stateDir,
    id: state.id,
    confirmation: createActionConfirmation({ action: "open-codex", targetId: state.id, stateDir })
  });
  const log = await readRunLog(state.id, { stateDir });

  assert.equal(opened.ok, true);
  assert.ok("effect" in opened);
  const openEffect = opened.effect;
  assert.ok(openEffect);
  assert.equal(openEffect.type, "open-codex-terminal");
  assert.equal(openEffect.cwd, "/tmp/project");
  assert.equal(openEffect.sessionId, "019ec4bd-7118-7443-8d6b-dce6b226eef3");
  assert.match(log, /session id/);
});

test("codex open action fails without a recorded Codex session id", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "loop-actions-codex-missing-session-"));
  const state = {
    ...createRunState({
      objective: "Codex missing session objective",
      now: new Date("2026-06-13T08:00:00.000Z")
    }),
    session: {
      agent: "codex",
      status: "running",
      pid: 123,
      cwd: "/tmp/project"
    }
  };
  await writeRunState(state, { stateDir });
  await writeFile(runLogPath({ stateDir, id: state.id }), "agent started but no session id yet\n");

  const opened = await prepareCodexOpenAction({
    stateDir,
    id: state.id,
    confirmation: createActionConfirmation({ action: "open-codex", targetId: state.id, stateDir })
  });

  assert.equal(opened.ok, false);
  assert.ok("error" in opened);
  assert.equal(opened.error?.kind, "codex_session_id_missing");
});

test("add wiki note action writes supporting notes through the wiki store", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "loop-actions-add-note-"));
  const state = createRunState({
    objective: "Action add note objective",
    now: new Date("2026-06-13T08:00:00.000Z")
  });
  await writeWikiForRunState(state, { stateDir });

  const added = await addWikiNoteAction({
    stateDir,
    runId: state.id,
    targetId: state.id,
    kind: "decision",
    title: "Action note",
    body: "Keep the action layer free of process side effects.",
    confirmation: createActionConfirmation({ action: "add-note", targetId: state.id, stateDir })
  });
  const graph = await readGraphAction({ stateDir });

  assert.equal(added.ok, true);
  assert.equal(added.result.kind, "decision");
  assert.ok(graph.graph.nodes.some((node) => node.id === added.result.id));
  assert.ok(graph.graph.edges.some((edge) => edge.source === added.result.id));
});

test("add note and verification actions require matching confirmation", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "loop-actions-confirm-mutations-"));
  const state = createRunState({
    objective: "Confirm mutation objective",
    now: new Date("2026-06-13T08:00:00.000Z")
  });
  await writeRunState(state, { stateDir });

  const note = await addWikiNoteAction({
    stateDir,
    runId: state.id,
    targetId: state.id,
    kind: "note",
    title: "Unconfirmed note",
    body: "Should not be written without confirmation."
  });
  const verify = await markVerificationAction({
    stateDir,
    id: state.id,
    summary: "Should not be written without confirmation."
  });

  assert.equal(note.ok, false);
  assert.ok("requiresConfirmation" in note);
  assert.equal(verify.ok, false);
  assert.ok("requiresConfirmation" in verify);
});
