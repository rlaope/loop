import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { createServer as createNetServer } from "node:net";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  appendEvidence,
  createRunState,
  dashboardActionForRun,
  getDashboardStatus,
  listWikiNotes,
  noteIdForRunState,
  readWikiNote,
  serveWikiDashboard,
  waitForDashboardReady,
  writeWikiForRunState
} from "../src/index.js";

test("writes canonical markdown and derived AI memory", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "loop-wiki-"));
  const state = appendEvidence(createRunState({
    objective: "Build darkwear exhibit",
    now: new Date("2026-06-13T08:00:01.000Z")
  }), {
    kind: "test",
    status: "passed",
    summary: "npm test passed"
  }, new Date("2026-06-13T08:01:00.000Z"));

  const paths = await writeWikiForRunState(state, {
    stateDir,
    paths: {
      jsonPath: join(stateDir, "runs", `${state.id}.json`),
      summaryPath: join(stateDir, "runs", `${state.id}.md`)
    },
    now: new Date("2026-06-13T08:02:00.000Z")
  });
  const note = await readWikiNote(paths.id, { stateDir });
  const memory = JSON.parse(await readFile(paths.memoryPath, "utf8"));
  const notes = await listWikiNotes({ stateDir });

  assert.match(paths.id, /^2026-06-13-build-darkwear-exhibit-080001000Z-[a-f0-9]{8}$/);
  assert.match(note.markdown, /## Purpose/);
  assert.match(note.markdown, /## Token Usage/);
  assert.match(note.markdown, /No explicit decisions recorded in run state/);
  assert.equal(memory.canonicalNote, `../user/${paths.id}.md`);
  assert.match(memory.derivedFromHash, /^sha256:/);
  assert.match(memory.generator.markdownHash, /^sha256:/);
  assert.equal(memory.tokens.total, null);
  assert.equal(memory.tokens.source, "unknown");
  assert.deepEqual(memory.decisions, []);
  assert.equal(notes.length, 1);
  assert.equal(notes[0].id, paths.id);
});

test("wiki note identity is stable for the same run state", () => {
  const state = createRunState({
    objective: "Repeatable note",
    now: new Date("2026-06-13T09:10:11.000Z")
  });

  assert.equal(noteIdForRunState(state), noteIdForRunState({
    ...state,
    status: "failed",
    updatedAt: new Date("2026-06-13T09:20:00.000Z").toISOString()
  }));
});

test("wiki note identity does not collide for same-millisecond reruns", () => {
  const first = createRunState({
    objective: "Fast rerun",
    now: new Date("2026-06-13T09:10:11.000Z")
  });
  const second = createRunState({
    objective: "Fast rerun",
    now: new Date("2026-06-13T09:10:11.000Z")
  });

  assert.notEqual(first.id, second.id);
  assert.notEqual(noteIdForRunState(first), noteIdForRunState(second));
});

test("preserves human-edited canonical markdown on regeneration", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "loop-wiki-human-edit-"));
  const state = createRunState({
    objective: "Preserve human note",
    now: new Date("2026-06-13T10:00:00.000Z")
  });
  const paths = await writeWikiForRunState(state, { stateDir });
  const editedMarkdown = "# Human edited note\n\nThis sentence must survive.\n";
  await writeFile(paths.notePath, editedMarkdown);

  await writeWikiForRunState({
    ...state,
    status: "failed",
    updatedAt: new Date("2026-06-13T10:01:00.000Z").toISOString()
  }, { stateDir });
  await writeWikiForRunState({
    ...state,
    status: "complete",
    updatedAt: new Date("2026-06-13T10:02:00.000Z").toISOString()
  }, { stateDir });
  const note = await readFile(paths.notePath, "utf8");
  const memory = JSON.parse(await readFile(paths.memoryPath, "utf8"));

  assert.equal(note, editedMarkdown);
  assert.match(memory.derivedFromHash, /^sha256:/);
  assert.match(memory.generator.markdownHash, /^sha256:/);
  assert.equal(memory.summary, "This sentence must survive.");
  assert.equal(memory.status, "complete");
});

test("links previous notes with the same objective slug", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "loop-wiki-links-"));
  const first = createRunState({
    objective: "Same wiki objective",
    now: new Date("2026-06-13T08:00:00.000Z")
  });
  const second = createRunState({
    objective: "Same wiki objective",
    now: new Date("2026-06-13T09:00:00.000Z")
  });

  await writeWikiForRunState(first, { stateDir, now: new Date("2026-06-13T08:01:00.000Z") });
  const secondPaths = await writeWikiForRunState(second, { stateDir, now: new Date("2026-06-13T09:01:00.000Z") });
  const memory = JSON.parse(await readFile(secondPaths.memoryPath, "utf8"));

  assert.equal(memory.graph.links.length, 1);
  assert.equal(memory.graph.links[0].relationship, "continues");
});

test("dashboard run policy respects TTY and explicit flags", () => {
  assert.equal(dashboardActionForRun({
    dashboardRunning: true,
    stdinTTY: false,
    stdoutTTY: false,
    explicitFlag: false
  }), "skip-running");
  assert.equal(dashboardActionForRun({
    dashboardRunning: false,
    stdinTTY: false,
    stdoutTTY: false,
    explicitFlag: false
  }), "skip-non-interactive");
  assert.equal(dashboardActionForRun({
    dashboardRunning: false,
    stdinTTY: false,
    stdoutTTY: false,
    explicitFlag: true
  }), "start");
  assert.equal(dashboardActionForRun({
    dashboardRunning: false,
    stdinTTY: true,
    stdoutTTY: true,
    explicitFlag: false
  }), "ask");
  assert.equal(dashboardActionForRun({
    dashboardRunning: false,
    stdinTTY: true,
    stdoutTTY: true,
    explicitFlag: false,
    userConsent: false
  }), "skip-declined");
});

test("dashboard server rejects non-localhost hosts in core API", async () => {
  await assert.rejects(
    () => serveWikiDashboard({ host: "0.0.0.0" }),
    /only supports 127\.0\.0\.1/
  );
});

test("dashboard status treats occupied non-http ports as occupied", async () => {
  const server = createNetServer((socket) => {
    socket.write("not http\r\n");
    socket.destroy();
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Expected TCP server to listen on an address object");
  }

  try {
    const status = await getDashboardStatus({
      port: address.port,
      timeoutMs: 100
    });
    assert.deepEqual(status, { running: false, occupied: true });
  } finally {
    server.close();
    await once(server, "close");
  }
});

test("dashboard readiness reports unconfirmed startup without hard failure", async () => {
  const status = await waitForDashboardReady({
    port: 65534,
    timeoutMs: 25,
    intervalMs: 5
  });

  assert.deepEqual(status, { running: false, occupied: false });
});
