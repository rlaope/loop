import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { createServer as createHttpServer } from "node:http";
import { createServer as createNetServer } from "node:net";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  appendEvidence,
  createRunState,
  createDashboardConfirmationToken,
  deleteWikiNote,
  dashboardActionForRun,
  getDashboardStatus,
  listWikiNotes,
  registerLoopProject,
  noteIdForRunState,
  readRunState,
  readWikiNote,
  renderMarkdownHtml,
  renderRunLogHtml,
  renderWikiDashboardHtml,
  renderWikiGraphHtml,
  runLogPath,
  serveWikiDashboard,
  waitForDashboardReady,
  writeWikiForRunState,
  writeRunState,
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

/**
 * @param {Parameters<typeof serveWikiDashboard>[0] & { stateDir: string }} options
 */
async function serveTestWikiDashboard(options) {
  return serveWikiDashboard({
    registryPath: join(options.stateDir, "test-registry", "projects.json"),
    ...options
  });
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
  assert.doesNotMatch(note.markdown, /## Token Usage/);
  assert.doesNotMatch(note.markdown, /## Related Notes/);
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

test("writes Korean wiki notes when the objective is Korean", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "loop-wiki-ko-"));
  const state = createRunState({
    objective: "다크웨어 명품 전시 사이트 만들기",
    now: new Date("2026-06-13T08:00:01.000Z")
  });

  const paths = await writeWikiForRunState(state, { stateDir });
  const note = await readWikiNote(paths.id, { stateDir });
  const memory = JSON.parse(await readFile(paths.memoryPath, "utf8"));

  assert.match(note.markdown, /## 요약/);
  assert.match(note.markdown, /## 목적/);
  assert.match(note.markdown, /## 결정 기록/);
  assert.match(note.markdown, /아직 기록된 검증 증거가 없습니다/);
  assert.doesNotMatch(note.markdown, /## Narrative Summary/);
  assert.doesNotMatch(note.markdown, /This note captures/);
  assert.match(memory.summary, /이 노트는/);
  assert.doesNotMatch(memory.summary, /This note captures/);
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
  assert.doesNotMatch(note.markdown, /## Related Notes/);
  assert.doesNotMatch(note.markdown, /active\/intake, updated/);
  assert.match(note.markdown, /- continues: Same wiki objective/);
  assert.match(note.markdown, /This note continues 1 earlier note for the same objective/);
  assert.match(note.markdown, /Open Graph View for the full map/);
  assert.doesNotMatch(note.markdown, /\.\.\/user\//);
  assert.doesNotMatch(note.markdown, /previous note 2026-/);
  assert.doesNotMatch(note.markdown, /--continues-->/);
});

test("wiki graph prefers explicit lineage over objective slug fallback", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "loop-wiki-lineage-links-"));
  const sameSlugFallback = createRunState({
    objective: "Shared followup objective",
    now: new Date("2026-06-13T08:00:00.000Z")
  });
  const explicitParent = createRunState({
    objective: "Different parent objective",
    now: new Date("2026-06-13T08:30:00.000Z")
  });
  const child = createRunState({
    objective: "Shared followup objective",
    lineage: {
      parentRunId: explicitParent.id,
      rootRunId: explicitParent.id,
      relationship: "continues",
      prompt: "Shared followup objective",
      createdFrom: "dashboard"
    },
    now: new Date("2026-06-13T09:00:00.000Z")
  });

  const fallbackPaths = await writeWikiForRunState(sameSlugFallback, {
    stateDir,
    now: new Date("2026-06-13T08:01:00.000Z")
  });
  const parentPaths = await writeWikiForRunState(explicitParent, {
    stateDir,
    now: new Date("2026-06-13T08:31:00.000Z")
  });
  const childPaths = await writeWikiForRunState(child, {
    stateDir,
    now: new Date("2026-06-13T09:01:00.000Z")
  });
  const childNote = await readWikiNote(childPaths.id, { stateDir });
  const childMemory = JSON.parse(await readFile(childPaths.memoryPath, "utf8"));
  /** @type {{ edges: Array<{ source: string, target: string, relationship: string }> }} */
  const graph = JSON.parse(await readFile(childPaths.graphPath, "utf8"));
  const childEdges = graph.edges.filter((edge) => edge.source === childPaths.id);

  assert.equal(childMemory.graph.links.length, 1);
  assert.equal(childMemory.graph.links[0].relationship, "continues");
  assert.equal(childMemory.graph.links[0].title, "Different parent objective");
  assert.equal(childMemory.lineage.parentRunId, explicitParent.id);
  assert.equal(childEdges.length, 1);
  assert.equal(childEdges[0].target, parentPaths.id);
  assert.notEqual(childEdges[0].target, fallbackPaths.id);
  assert.match(childNote.markdown, /Different parent objective/);
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

  assert.match(html, /<h1>Loop Wiki<\/h1>/);
  assert.doesNotMatch(html, /Second Brain/);
  assert.match(html, /Loop Stack/);
  assert.match(html, /href="\/graph"/);
  assert.match(html, />Delete Note</);
  assert.match(html, /action="\/actions\/add-note"/);
  assert.match(html, /action="\/actions\/verify-run"/);
  assert.match(html, /action="\/actions\/follow-up"/);
  assert.match(html, /action="\/actions\/open-codex"/);
  assert.match(html, /run-stack/);
  assert.doesNotMatch(html, /Read Latest/);
  assert.doesNotMatch(html, /latest-card/);
  assert.doesNotMatch(html, /Tokens/);
  assert.doesNotMatch(html, /graph-edge/);
  assert.match(graphHtml, /Graph View/);
  assert.match(graphHtml, /<svg viewBox="0 0 1100 680"/);
  assert.match(graphHtml, /graph-edge/);
  assert.match(graphHtml, /nodeGlow/);
  assert.match(graphHtml, /Readable Connections/);
  assert.match(graphHtml, /graph-kind-run/);
});

test("dashboard localizes Korean notes and does not duplicate the latest run card", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "loop-wiki-dashboard-ko-"));
  const state = createRunState({
    objective: "다크웨어 명품 전시 사이트 만들기",
    now: new Date("2026-06-13T08:00:00.000Z")
  });

  await writeWikiForRunState(state, { stateDir, now: new Date("2026-06-13T08:01:00.000Z") });
  const notes = await listWikiNotes({ stateDir });
  const html = renderWikiDashboardHtml(notes);
  const graphHtml = renderWikiGraphHtml(notes);

  assert.match(html, /<html lang="ko">/);
  assert.match(html, /<h1>Loop Wiki<\/h1>/);
  assert.doesNotMatch(html, /세컨드 브레인/);
  assert.match(html, /그래프 보기/);
  assert.match(html, /루프 스택/);
  assert.match(html, /노트 읽기/);
  assert.doesNotMatch(html, /Read Latest/);
  assert.doesNotMatch(html, /latest-card/);
  assert.doesNotMatch(html, /metric-card--wide/);
  assert.match(html, /status-card/);
  assert.doesNotMatch(html, /This note captures/);
  assert.match(graphHtml, /<html lang="ko">/);
  assert.match(graphHtml, /읽기 쉬운 연결/);
});

test("dashboard renders run log pages", () => {
  const state = {
    ...createRunState({
      objective: "다크웨어 명품 전시 사이트 만들기",
      now: new Date("2026-06-13T08:00:00.000Z")
    }),
    session: {
      agent: "codex",
      status: "running",
      pid: 1234,
      cwd: "/tmp/darkwear"
    }
  };
  const html = renderRunLogHtml({
    id: state.id,
    log: "agent streamed line\nsession id: 019ec4bd-7118-7443-8d6b-dce6b226eef3\n",
    state,
    stateDir: "/tmp/darkwear/.loop"
  });

  assert.match(html, /실시간 실행 로그/);
  assert.match(html, /agent streamed line/);
  assert.match(html, /노트로 돌아가기/);
  assert.match(html, /loop logs/);
  assert.match(html, /--follow/);
  assert.match(html, /--state-dir/);
  assert.match(html, /codex resume --include-non-interactive 019ec4bd-7118-7443-8d6b-dce6b226eef3/);
  assert.match(html, /라이브 테일/);
});

test("dashboard renders missing run logs as snapshots instead of live tails", () => {
  const html = renderRunLogHtml({
    id: "missing-run",
    log: "",
    state: null,
    stateDir: ".loop"
  });

  assert.match(html, /Log snapshot/);
  assert.doesNotMatch(html, /Live tail/);
  assert.doesNotMatch(html, /setInterval\(pollLog, 1000\)/);
});

test("dashboard server serves the graph view route", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "loop-wiki-graph-route-"));
  const state = createRunState({
    objective: "Graph route objective",
    now: new Date("2026-06-13T08:00:00.000Z")
  });
  const port = await getFreePort();
  const served = await serveTestWikiDashboard({ stateDir, port });
  await writeWikiForRunState(state, { stateDir, now: new Date("2026-06-13T08:01:00.000Z") });

  try {
    const response = await fetch(`http://127.0.0.1:${port}/graph`);
    const html = await response.text();

    assert.equal(response.status, 200);
    assert.match(html, /Graph View/);
    assert.match(html, /Back to notes/);
    assert.match(html, /<svg viewBox="0 0 1100 680"/);
  } finally {
    if (served.server) {
      served.server.close();
      await once(served.server, "close");
    }
  }
});

test("dashboard home aggregates Loop Wiki projects from the global registry", async () => {
  const root = await mkdtemp(join(tmpdir(), "loop-global-dashboard-"));
  const projectOne = join(root, "feedback-saas");
  const projectTwo = join(root, "darkwear-exhibit");
  const stateDirOne = join(projectOne, ".loop");
  const stateDirTwo = join(projectTwo, ".loop");
  const registryPath = join(root, "registry", "projects.json");
  const stateOne = createRunState({
    objective: "Build customer feedback dashboard",
    now: new Date("2026-06-13T08:00:00.000Z")
  });
  const stateTwo = createRunState({
    objective: "다크웨어 전시 사이트를 만든다",
    now: new Date("2026-06-13T09:00:00.000Z")
  });
  await writeRunState(stateOne, { stateDir: stateDirOne });
  await writeRunState(stateTwo, { stateDir: stateDirTwo });
  await writeFile(runLogPath({ stateDir: stateDirOne, id: stateOne.id }), "feedback log\n");
  await writeWikiForRunState(stateOne, { stateDir: stateDirOne });
  await writeWikiForRunState(stateTwo, { stateDir: stateDirTwo });
  const entryOne = await registerLoopProject({ cwd: projectOne, stateDir: ".loop", registryPath, now: new Date("2026-06-13T10:00:00.000Z") });
  const entryTwo = await registerLoopProject({ cwd: projectTwo, stateDir: ".loop", registryPath, now: new Date("2026-06-13T11:00:00.000Z") });
  const port = await getFreePort();
  const served = await serveTestWikiDashboard({ stateDir: stateDirOne, cwd: projectOne, port, registryPath });

  try {
    const home = await fetch(`http://127.0.0.1:${port}/`);
    const homeHtml = await home.text();
    const project = await fetch(`http://127.0.0.1:${port}/projects/${entryOne.id}`);
    const projectHtml = await project.text();
    const log = await fetch(`http://127.0.0.1:${port}/projects/${entryOne.id}/api/runs/${stateOne.id}/log`);
    const logPayload = await log.json();

    assert.equal(home.status, 200);
    assert.match(homeHtml, /<h1>Loop Wiki<\/h1>/);
    assert.doesNotMatch(homeHtml, /All Projects|모든 프로젝트/);
    assert.match(homeHtml, /feedback-saas/);
    assert.match(homeHtml, /darkwear-exhibit/);
    assert.match(homeHtml, new RegExp(`/projects/${entryOne.id}`));
    assert.match(homeHtml, new RegExp(`/projects/${entryTwo.id}`));
    assert.equal(project.status, 200);
    assert.match(projectHtml, /Build customer feedback dashboard/);
    assert.match(projectHtml, new RegExp(`/projects/${entryOne.id}/runs/${stateOne.id}/log`));
    assert.equal(log.status, 200);
    assert.equal(logPayload.log, "feedback log\n");
  } finally {
    if (served.server) {
      served.server.close();
      await once(served.server, "close");
    }
  }
});

test("dashboard server serves live run log API", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "loop-wiki-log-api-"));
  const state = {
    ...createRunState({
      objective: "Live log objective",
      now: new Date("2026-06-13T08:00:00.000Z")
    }),
    session: {
      agent: "codex",
      status: "running",
      pid: 4321,
      cwd: "/tmp/live-log"
    }
  };
  const port = await getFreePort();
  await writeRunState(state, { stateDir });
  await writeFile(runLogPath({ stateDir, id: state.id }), "agent streamed line\n");
  const served = await serveTestWikiDashboard({ stateDir, port });

  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/runs/${state.id}/log`);
    const payload = await response.json();

    assert.equal(response.status, 200);
    assert.equal(payload.id, state.id);
    assert.equal(payload.log, "agent streamed line\n");
    assert.equal(payload.state.id, state.id);
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
  const confirmationSecret = "test-dashboard-secret";
  const served = await serveTestWikiDashboard({ stateDir, port, confirmationSecret });
  const paths = await writeWikiForRunState(state, { stateDir, now: new Date("2026-06-13T08:01:00.000Z") });
  const token = createDashboardConfirmationToken({
    action: "delete-note",
    targetId: paths.id,
    stateDir,
    secret: confirmationSecret
  });

  try {
    const rejected = await fetch(`http://127.0.0.1:${port}/notes/${paths.id}/delete`, {
      method: "POST",
      redirect: "manual"
    });
    const stillPresent = await listWikiNotes({ stateDir });
    const response = await fetch(`http://127.0.0.1:${port}/actions/delete-note`, {
      method: "POST",
      body: new URLSearchParams({ id: paths.id, confirmationToken: token }),
      redirect: "manual"
    });
    const notes = await listWikiNotes({ stateDir });

    assert.equal(rejected.status, 404);
    assert.equal(stillPresent.length, 1);
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

test("dashboard action endpoints add notes and update run state with confirmation", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "loop-wiki-actions-"));
  const state = createRunState({
    objective: "Dashboard action objective",
    now: new Date("2026-06-13T08:00:00.000Z")
  });
  const port = await getFreePort();
  const confirmationSecret = "test-dashboard-actions-secret";
  await writeRunState(state, { stateDir });
  const paths = await writeWikiForRunState(state, { stateDir, now: new Date("2026-06-13T08:01:00.000Z") });
  const served = await serveTestWikiDashboard({ stateDir, port, confirmationSecret });

  try {
    const addNote = await fetch(`http://127.0.0.1:${port}/actions/add-note`, {
      method: "POST",
      body: new URLSearchParams({
        targetId: paths.id,
        runId: state.id,
        parentId: paths.id,
        kind: "plan",
        title: "Dashboard plan",
        body: "Dashboard-created planning context.",
        confirmationToken: createDashboardConfirmationToken({
          action: "add-note",
          targetId: paths.id,
          stateDir,
          secret: confirmationSecret
        })
      }),
      redirect: "manual"
    });
    const afterAdd = await listWikiNotes({ stateDir });
    const verify = await fetch(`http://127.0.0.1:${port}/actions/verify-run`, {
      method: "POST",
      body: new URLSearchParams({
        id: state.id,
        summary: "Dashboard verification passed.",
        confirmationToken: createDashboardConfirmationToken({
          action: "verify-run",
          targetId: state.id,
          stateDir,
          secret: confirmationSecret
        })
      }),
      redirect: "manual"
    });
    const afterVerify = await readRunState(state.id, { stateDir });
    const notesAfterVerify = await listWikiNotes({ stateDir });
    const complete = await fetch(`http://127.0.0.1:${port}/actions/mark-complete`, {
      method: "POST",
      body: new URLSearchParams({
        id: state.id,
        confirmationToken: createDashboardConfirmationToken({
          action: "mark-complete",
          targetId: state.id,
          stateDir,
          secret: confirmationSecret
        })
      }),
      redirect: "manual"
    });
    const afterComplete = await readRunState(state.id, { stateDir });
    const notesAfterComplete = await listWikiNotes({ stateDir });
    const deleteRun = await fetch(`http://127.0.0.1:${port}/actions/delete-run`, {
      method: "POST",
      body: new URLSearchParams({
        id: state.id,
        confirmationToken: createDashboardConfirmationToken({
          action: "delete-run",
          targetId: state.id,
          stateDir,
          secret: confirmationSecret
        })
      }),
      redirect: "manual"
    });
    const afterDelete = await readRunState(state.id, { stateDir });
    const notesAfterDelete = await listWikiNotes({ stateDir });

    assert.equal(addNote.status, 303);
    assert.equal(afterAdd.length, 2);
    assert.ok(afterAdd.some((note) => note.title === "Dashboard plan" && note.kind === "plan"));
    assert.equal(verify.status, 303);
    assert.equal(afterVerify.ok, true);
    assert.equal(afterVerify.ok && afterVerify.state.phase, "verify");
    assert.ok(afterVerify.ok && afterVerify.state.verificationEvidence.some((item) => item.summary === "Dashboard verification passed."));
    assert.ok(notesAfterVerify.some((note) => note.kind === "run" && note.phase === "verify"));
    assert.equal(complete.status, 303);
    assert.equal(afterComplete.ok, true);
    assert.equal(afterComplete.ok && afterComplete.state.status, "complete");
    assert.ok(notesAfterComplete.some((note) => note.kind === "run" && note.status === "complete"));
    assert.equal(deleteRun.status, 303);
    assert.equal(afterDelete.ok, false);
    assert.ok(!notesAfterDelete.some((note) => note.kind === "run" && note.runId === state.id));
    assert.ok(notesAfterDelete.some((note) => note.kind === "plan" && note.title === "Dashboard plan"));
  } finally {
    if (served.server) {
      served.server.close();
      await once(served.server, "close");
    }
  }
});

test("dashboard follow-up and open-codex actions use confirmation and effect adapters", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "loop-wiki-followup-codex-"));
  const state = {
    ...createRunState({
      objective: "Dashboard follow-up objective",
      now: new Date("2026-06-13T08:00:00.000Z")
    }),
    session: {
      agent: "codex",
      status: "running",
      pid: 4321,
      cwd: "/tmp/dashboard-codex"
    }
  };
  const port = await getFreePort();
  const confirmationSecret = "test-dashboard-effects-secret";
  /** @type {Array<{ command: string, args?: string[], cwd?: string | null }>} */
  const launchedCommands = [];
  await writeRunState(state, { stateDir });
  await writeFile(runLogPath({ stateDir, id: state.id }), "session id: 019ec4bd-7118-7443-8d6b-dce6b226eef3\n");
  await writeWikiForRunState(state, { stateDir, now: new Date("2026-06-13T08:01:00.000Z") });
  const served = await serveTestWikiDashboard({
    stateDir,
    port,
    confirmationSecret,
    launchTerminalCommandImpl: (spec) => {
      launchedCommands.push(spec);
      return {
        pid: 9876,
        command: "test-terminal",
        args: [spec.command, ...(spec.args ?? [])],
        displayCommand: spec.command
      };
    }
  });

  try {
    const rejected = await fetch(`http://127.0.0.1:${port}/actions/follow-up`, {
      method: "POST",
      body: new URLSearchParams({
        parentRunId: state.id,
        prompt: "Continue from dashboard",
        agent: "claudecode"
      }),
      redirect: "manual"
    });
    const followUp = await fetch(`http://127.0.0.1:${port}/actions/follow-up`, {
      method: "POST",
      body: new URLSearchParams({
        parentRunId: state.id,
        prompt: "Continue from dashboard",
        agent: "claudecode",
        confirmationToken: createDashboardConfirmationToken({
          action: "follow-up-run",
          targetId: state.id,
          stateDir,
          secret: confirmationSecret
        })
      })
    });
    const followUpHtml = await followUp.text();
    const openCodex = await fetch(`http://127.0.0.1:${port}/actions/open-codex`, {
      method: "POST",
      body: new URLSearchParams({
        id: state.id,
        confirmationToken: createDashboardConfirmationToken({
          action: "open-codex",
          targetId: state.id,
          stateDir,
          secret: confirmationSecret
        })
      })
    });
    const codexHtml = await openCodex.text();

    assert.equal(rejected.status, 403);
    assert.equal(followUp.status, 200);
    assert.match(followUpHtml, /Follow-up prepared/);
    assert.match(followUpHtml, /loop run --agent claudecode/);
    assert.match(followUpHtml, /--parent-run/);
    assert.match(followUpHtml, /--lineage-source dashboard/);
    assert.equal(openCodex.status, 200);
    assert.equal(launchedCommands.length, 1);
    assert.deepEqual(launchedCommands[0], {
      command: "codex",
      args: ["resume", "--include-non-interactive", "019ec4bd-7118-7443-8d6b-dce6b226eef3"],
      cwd: "/tmp/dashboard-codex"
    });
    assert.match(codexHtml, /Codex terminal opened/);
    assert.match(codexHtml, /codex resume --include-non-interactive/);
  } finally {
    if (served.server) {
      served.server.close();
      await once(served.server, "close");
    }
  }
});

test("dashboard open-codex action does not launch without a concrete Codex session id", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "loop-wiki-open-codex-no-session-"));
  const state = {
    ...createRunState({
      objective: "Dashboard missing Codex session",
      now: new Date("2026-06-13T08:00:00.000Z")
    }),
    session: {
      agent: "codex",
      status: "running",
      pid: 4321,
      cwd: "/tmp/dashboard-codex"
    }
  };
  const port = await getFreePort();
  const confirmationSecret = "test-dashboard-missing-session-secret";
  let launches = 0;
  await writeRunState(state, { stateDir });
  await writeFile(runLogPath({ stateDir, id: state.id }), "codex started without a parseable session id\n");
  await writeWikiForRunState(state, { stateDir, now: new Date("2026-06-13T08:01:00.000Z") });
  const served = await serveTestWikiDashboard({
    stateDir,
    port,
    confirmationSecret,
    launchTerminalCommandImpl: () => {
      launches += 1;
      return { pid: 9876, command: "test-terminal", args: [], displayCommand: "test-terminal" };
    }
  });

  try {
    const openCodex = await fetch(`http://127.0.0.1:${port}/actions/open-codex`, {
      method: "POST",
      body: new URLSearchParams({
        id: state.id,
        confirmationToken: createDashboardConfirmationToken({
          action: "open-codex",
          targetId: state.id,
          stateDir,
          secret: confirmationSecret
        })
      })
    });
    const message = await openCodex.text();

    assert.equal(openCodex.status, 400);
    assert.equal(launches, 0);
    assert.match(message, /No Codex session id was found/);
  } finally {
    if (served.server) {
      served.server.close();
      await once(served.server, "close");
    }
  }
});

test("dashboard confirmation tokens are bound to action target and expiry", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "loop-wiki-token-binding-"));
  const state = createRunState({
    objective: "Token binding objective",
    now: new Date("2026-06-13T08:00:00.000Z")
  });
  const port = await getFreePort();
  const confirmationSecret = "test-dashboard-token-secret";
  const paths = await writeWikiForRunState(state, { stateDir, now: new Date("2026-06-13T08:01:00.000Z") });
  const served = await serveTestWikiDashboard({ stateDir, port, confirmationSecret });

  try {
    const wrongAction = await fetch(`http://127.0.0.1:${port}/actions/delete-note`, {
      method: "POST",
      body: new URLSearchParams({
        id: paths.id,
        confirmationToken: createDashboardConfirmationToken({
          action: "delete-run",
          targetId: paths.id,
          stateDir,
          secret: confirmationSecret
        })
      }),
      redirect: "manual"
    });
    const expired = await fetch(`http://127.0.0.1:${port}/actions/delete-note`, {
      method: "POST",
      body: new URLSearchParams({
        id: paths.id,
        confirmationToken: createDashboardConfirmationToken({
          action: "delete-note",
          targetId: paths.id,
          stateDir,
          secret: confirmationSecret,
          ttlMs: -1
        })
      }),
      redirect: "manual"
    });
    const notes = await listWikiNotes({ stateDir });

    assert.equal(wrongAction.status, 403);
    assert.equal(expired.status, 403);
    assert.equal(notes.length, 1);
  } finally {
    if (served.server) {
      served.server.close();
      await once(served.server, "close");
    }
  }
});

test("dashboard server persists confirmation secret per state directory", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "loop-wiki-persisted-secret-"));
  const firstPort = await getFreePort();
  const secondPort = await getFreePort();
  let savedSecret = "";
  const first = await serveTestWikiDashboard({ stateDir, port: firstPort });

  try {
    savedSecret = await readFile(join(stateDir, "dashboard-secret"), "utf8");
    assert.match(savedSecret.trim(), /^[0-9a-f]{64}$/i);
  } finally {
    if (first.server) {
      first.server.close();
      await once(first.server, "close");
    }
  }

  const second = await serveTestWikiDashboard({ stateDir, port: secondPort });
  try {
    const secondSecret = await readFile(join(stateDir, "dashboard-secret"), "utf8");
    assert.equal(secondSecret, savedSecret);
  } finally {
    if (second.server) {
      second.server.close();
      await once(second.server, "close");
    }
  }
});

test("dashboard keeps attached notes visible when their parent is deleted", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "loop-wiki-orphaned-note-"));
  const parent = createRunState({
    objective: "Parent run",
    now: new Date("2026-06-13T08:00:00.000Z")
  });
  const other = createRunState({
    objective: "Other run",
    now: new Date("2026-06-13T09:00:00.000Z")
  });
  const parentPaths = await writeWikiForRunState(parent, {
    stateDir,
    now: new Date("2026-06-13T08:01:00.000Z")
  });
  const child = await writeWikiSupportingNote({
    stateDir,
    runId: parent.id,
    kind: "plan",
    title: "Orphaned implementation plan",
    body: "This note should remain readable after its parent is deleted.",
    now: new Date("2026-06-13T08:02:00.000Z")
  });
  await writeWikiForRunState(other, {
    stateDir,
    now: new Date("2026-06-13T09:01:00.000Z")
  });

  await deleteWikiNote(parentPaths.id, { stateDir });
  const notes = await listWikiNotes({ stateDir });
  const html = renderWikiDashboardHtml(notes);

  assert.equal(notes.length, 2);
  assert.match(html, /Unattached Notes/);
  assert.match(html, /Orphaned implementation plan/);
  assert.match(html, new RegExp(`href="/notes/${child.id}"`));
  assert.match(html, /action="\/actions\/delete-note"/);
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

test("dashboard status treats legacy project-only Loop Wiki servers as occupied", async () => {
  const server = createHttpServer((request, response) => {
    if (request.url === "/health") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(`${JSON.stringify({ ok: true, name: "loop-wiki" })}\n`);
      return;
    }
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end("<!doctype html><title>Legacy Loop Wiki</title>");
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Expected HTTP server to listen on an address object");
  }

  try {
    const status = await getDashboardStatus({ port: address.port });

    assert.equal(status.running, false);
    assert.equal(status.occupied, true);
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
