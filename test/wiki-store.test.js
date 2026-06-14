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
  deleteWikiNote,
  dashboardActionForRun,
  getDashboardStatus,
  listWikiNotes,
  noteIdForRunState,
  readWikiNote,
  renderMarkdownHtml,
  renderRunLogHtml,
  renderWikiDashboardHtml,
  renderWikiGraphHtml,
  serveWikiDashboard,
  waitForDashboardReady,
  writeWikiForRunState,
  writeWikiSupportingNote
} from "../src/index.js";

async function getFreePort() {
  const server = createNetServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Expected TCP server to listen on an address object");
  }
  const { port } = address;
  server.close();
  await once(server, "close");
  return port;
}

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
  assert.match(note.markdown, /## Narrative Summary/);
  assert.match(note.markdown, /## Purpose/);
  assert.match(note.markdown, /## Decision Log/);
  assert.match(note.markdown, /## Graph Links/);
  assert.match(note.markdown, /## Token Usage/);
  assert.doesNotMatch(note.markdown, /No explicit decisions recorded in run state/);
  assert.equal(memory.canonicalNote, `../user/${paths.id}.md`);
  assert.match(memory.derivedFromHash, /^sha256:/);
  assert.match(memory.generator.markdownHash, /^sha256:/);
  assert.equal(memory.tokens.total, null);
  assert.equal(memory.tokens.source, "unknown");
  assert.equal(memory.decisions.length, 3);
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

test("writes multiple supporting wiki notes for one loop run", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "loop-wiki-supporting-"));
  const state = createRunState({
    objective: "Build darkwear exhibit",
    now: new Date("2026-06-13T08:00:01.000Z")
  });
  const runPaths = await writeWikiForRunState(state, {
    stateDir,
    now: new Date("2026-06-13T08:02:00.000Z")
  });

  const plan = await writeWikiSupportingNote({
    stateDir,
    runId: state.id,
    kind: "plan",
    title: "Gallery implementation plan",
    body: "Use a restrained exhibit grid and keep product curation separate from buying links.",
    now: new Date("2026-06-13T08:03:00.000Z")
  });
  const verification = await writeWikiSupportingNote({
    stateDir,
    runId: state.id,
    kind: "verification",
    title: "QA findings",
    body: "Mobile cards need spacing verification before the site is treated as complete.",
    now: new Date("2026-06-13T08:04:00.000Z")
  });
  const notes = await listWikiNotes({ stateDir });
  const planMarkdown = await readWikiNote(plan.id, { stateDir });
  const planMemory = JSON.parse(await readFile(plan.memoryPath, "utf8"));
  const graph = /** @type {{ edges: Array<{ source: string, target: string, relationship: string }> }} */ (
    JSON.parse(await readFile(plan.graphPath, "utf8"))
  );

  assert.equal(notes.length, 3);
  assert.equal(notes.find((note) => note.id === runPaths.id)?.kind, "run");
  assert.equal(notes.find((note) => note.id === plan.id)?.kind, "plan");
  assert.equal(notes.find((note) => note.id === verification.id)?.kind, "verification");
  assert.equal(notes.find((note) => note.id === plan.id)?.parentId, runPaths.id);
  assert.equal(notes.find((note) => note.id === verification.id)?.parentId, runPaths.id);
  assert.match(planMarkdown.markdown, /# Gallery implementation plan/);
  assert.match(planMarkdown.markdown, /- Type: plan/);
  assert.match(planMarkdown.markdown, /- Parent loop: Build darkwear exhibit/);
  assert.match(planMarkdown.markdown, /Use a restrained exhibit grid/);
  assert.doesNotMatch(planMarkdown.markdown, /\.\.\/user\//);
  assert.equal(planMemory.kind, "plan");
  assert.equal(planMemory.parentId, runPaths.id);
  assert.deepEqual(planMemory.runIds, [state.id]);
  assert.ok(graph.edges.some((edge) => edge.source === plan.id && edge.target === runPaths.id && edge.relationship === "supports"));
  assert.ok(graph.edges.some((edge) => edge.source === verification.id && edge.target === runPaths.id && edge.relationship === "supports"));
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
  const note = await readWikiNote(secondPaths.id, { stateDir });
  const memory = JSON.parse(await readFile(secondPaths.memoryPath, "utf8"));
  const graph = JSON.parse(await readFile(secondPaths.graphPath, "utf8"));

  assert.equal(memory.graph.links.length, 1);
  assert.equal(memory.graph.links[0].relationship, "continues");
  assert.equal(memory.graph.links[0].title, "Same wiki objective");
  assert.equal(graph.edges.length, 1);
  assert.equal(graph.edges[0].target, noteIdForRunState(first));
  assert.match(note.markdown, /## Related Notes\n\n- Same wiki objective\n\n## Graph Links/);
  assert.doesNotMatch(note.markdown, /active\/intake, updated/);
  assert.match(note.markdown, /- continues: Same wiki objective/);
  assert.match(note.markdown, /This note continues 1 earlier note for the same objective/);
  assert.match(note.markdown, /Open Graph View for the full map/);
  assert.doesNotMatch(note.markdown, /\.\.\/user\//);
  assert.doesNotMatch(note.markdown, /previous note 2026-/);
  assert.doesNotMatch(note.markdown, /--continues-->/);
});

test("renders markdown notes as readable semantic HTML", () => {
  const html = renderMarkdownHtml([
    "# Darkwear Exhibit",
    "",
    "> Loop Wiki note: sample",
    "",
    "## Narrative Summary",
    "",
    "This is a readable paragraph with **context** and `code`.",
    "",
    "- passed: npm test passed",
    "- pending: manual QA",
    "",
    "| Field | Value |",
    "| --- | --- |",
    "| Status | active |"
  ].join("\n"));

  assert.match(html, /<article>/);
  assert.match(html, /<h1>Darkwear Exhibit<\/h1>/);
  assert.match(html, /<h2>Narrative Summary<\/h2>/);
  assert.match(html, /<blockquote>Loop Wiki note: sample<\/blockquote>/);
  assert.match(html, /<strong>context<\/strong>/);
  assert.match(html, /<code>code<\/code>/);
  assert.match(html, /<ul><li>passed: npm test passed<\/li><li>pending: manual QA<\/li><\/ul>/);
  assert.match(html, /<table>/);
  assert.doesNotMatch(html, /<main><pre>/);
});

test("markdown renderer avoids unsafe link schemes", () => {
  const html = renderMarkdownHtml("[safe](../user/note.md) [unsafe](javascript:alert(1))");

  assert.match(html, /href="\.\.\/user\/note\.md"/);
  assert.match(html, /href="#"/);
  assert.doesNotMatch(html, /javascript:alert/);
});

test("markdown renderer preserves escaped pipes inside table cells", () => {
  const html = renderMarkdownHtml([
    "| Field | Value |",
    "| --- | --- |",
    "| Path | a\\|b |"
  ].join("\n"));

  assert.match(html, /<td>a\|b<\/td>/);
  assert.doesNotMatch(html, /<td>a\\<\/td>/);
});

test("dashboard links to a separate graph view", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "loop-wiki-dashboard-ui-"));
  const first = createRunState({
    objective: "Dashboard graph objective",
    now: new Date("2026-06-13T08:00:00.000Z")
  });
  const second = createRunState({
    objective: "Dashboard graph objective",
    now: new Date("2026-06-13T09:00:00.000Z")
  });

  await writeWikiForRunState(first, { stateDir, now: new Date("2026-06-13T08:01:00.000Z") });
  await writeWikiForRunState(second, { stateDir, now: new Date("2026-06-13T09:01:00.000Z") });
  const notes = await listWikiNotes({ stateDir });
  const html = renderWikiDashboardHtml(notes);
  const graphHtml = renderWikiGraphHtml(notes);

  assert.match(html, /Current Reading Context/);
  assert.match(html, /History Stack/);
  assert.match(html, /href="\/graph"/);
  assert.match(html, /Delete note/);
  assert.match(html, /note-card/);
  assert.doesNotMatch(html, /graph-edge/);
  assert.match(graphHtml, /Graph View/);
  assert.match(graphHtml, /<svg viewBox="0 0 520 300"/);
  assert.match(graphHtml, /graph-edge/);
  assert.match(graphHtml, /nodeGlow/);
  assert.match(graphHtml, /Readable Connections/);
});

test("dashboard renders run log pages", () => {
  const html = renderRunLogHtml({
    id: "run-1",
    log: "agent streamed line\n"
  });

  assert.match(html, /Run Log/);
  assert.match(html, /agent streamed line/);
  assert.match(html, /Back to notes/);
});

test("dashboard server serves the graph view route", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "loop-wiki-graph-route-"));
  const state = createRunState({
    objective: "Graph route objective",
    now: new Date("2026-06-13T08:00:00.000Z")
  });
  const port = await getFreePort();
  const served = await serveWikiDashboard({ stateDir, port });
  await writeWikiForRunState(state, { stateDir, now: new Date("2026-06-13T08:01:00.000Z") });

  try {
    const response = await fetch(`http://127.0.0.1:${port}/graph`);
    const html = await response.text();

    assert.equal(response.status, 200);
    assert.match(html, /Graph View/);
    assert.match(html, /Back to notes/);
    assert.match(html, /<svg viewBox="0 0 520 300"/);
  } finally {
    if (served.server) {
      served.server.close();
      await once(served.server, "close");
    }
  }
});

test("dashboard server deletes wiki notes by post route", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "loop-wiki-delete-route-"));
  const state = createRunState({
    objective: "Delete note objective",
    now: new Date("2026-06-13T08:00:00.000Z")
  });
  const port = await getFreePort();
  const served = await serveWikiDashboard({ stateDir, port });
  const paths = await writeWikiForRunState(state, { stateDir, now: new Date("2026-06-13T08:01:00.000Z") });

  try {
    const response = await fetch(`http://127.0.0.1:${port}/notes/${paths.id}/delete`, {
      method: "POST",
      redirect: "manual"
    });
    const notes = await listWikiNotes({ stateDir });

    assert.equal(response.status, 303);
    assert.equal(response.headers.get("location"), "/");
    assert.deepEqual(notes, []);
  } finally {
    if (served.server) {
      served.server.close();
      await once(served.server, "close");
    }
  }
});

test("deletes wiki notes and rebuilds graph index", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "loop-wiki-delete-note-"));
  const state = createRunState({
    objective: "Delete graph objective",
    now: new Date("2026-06-13T08:00:00.000Z")
  });
  const paths = await writeWikiForRunState(state, { stateDir, now: new Date("2026-06-13T08:01:00.000Z") });

  const result = await deleteWikiNote(paths.id, { stateDir });
  const notes = await listWikiNotes({ stateDir });

  assert.equal(result.deleted, true);
  assert.deepEqual(notes, []);
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
