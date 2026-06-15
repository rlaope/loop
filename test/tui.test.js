import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";

import {
  createRunState,
  noArgTuiDispatch,
  renderTuiHome,
  runLoopTui,
  writeRunState,
  writeWikiForRunState
} from "../src/index.js";

test("no-arg dispatch opens TUI only for interactive terminals", () => {
  assert.equal(noArgTuiDispatch({
    argCount: 0,
    stdinTTY: true,
    stdoutTTY: true
  }), "open-tui");
  assert.equal(noArgTuiDispatch({
    argCount: 0,
    stdinTTY: false,
    stdoutTTY: true
  }), "non-interactive-guidance");
  assert.equal(noArgTuiDispatch({
    argCount: 1,
    stdinTTY: true,
    stdoutTTY: true
  }), "continue-cli");
});

test("TUI home render shows runs, wiki, graph, and commands", () => {
  /** @type {Parameters<typeof renderTuiHome>[0]} */
  const snapshot = {
    stateDir: ".loop",
    agent: "codex",
    selectedRunId: "run-1",
    selectedRun: {
      id: "run-1",
      objective: "Build a darkwear exhibit",
      objectiveSlug: "build-a-darkwear-exhibit",
      phase: "verify",
      status: "active",
      nextAction: "review changes",
      updatedAt: "2026-06-13T00:00:00.000Z",
      paths: {
        jsonPath: ".loop/runs/run-1.json",
        summaryPath: ".loop/runs/run-1.md",
        logPath: ".loop/runs/run-1.log"
      },
      session: null,
      lineage: undefined
    },
    runs: [{
      id: "run-1",
      objective: "Build a darkwear exhibit",
      objectiveSlug: "build-a-darkwear-exhibit",
      phase: "verify",
      status: "active",
      nextAction: "review changes",
      updatedAt: "2026-06-13T00:00:00.000Z",
      paths: {
        jsonPath: ".loop/runs/run-1.json",
        summaryPath: ".loop/runs/run-1.md",
        logPath: ".loop/runs/run-1.log"
      },
      session: null,
      lineage: undefined
    }],
    notes: [{
      id: "note-1",
      kind: "run",
      title: "Build a darkwear exhibit",
      objective: "Build a darkwear exhibit",
      objectiveSlug: "build-a-darkwear-exhibit",
      status: "active",
      phase: "verify",
      canonicalNote: ".loop/wiki/user/note-1.md",
      aiMemory: ".loop/wiki/ai/note-1.json",
      createdAt: "2026-06-13T00:00:00.000Z",
      updatedAt: "2026-06-13T00:00:00.000Z",
      summary: "summary",
      tags: [],
      links: [],
      tokens: { input: null, output: null, total: null, source: "unknown" },
      session: null
    }],
    graph: {
      nodes: [{
        id: "note-1",
        label: "Build a darkwear exhibit",
        kind: "run",
        parentId: undefined,
        runId: "run-1",
        lineage: undefined,
        status: "active"
      }],
      edges: []
    }
  };
  const html = renderTuiHome(snapshot);

  assert.doesNotMatch(html, /\.----->----\./);
  assert.match(html, /Loop Agent Console/);
  assert.match(html, /Build a darkwear exhibit/);
  assert.match(html, /Wiki: 1 notes/);
  assert.match(html, /codex open terminal/);
});

test("TUI one-shot mode renders local state without waiting for input", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "loop-tui-state-"));
  const state = createRunState({
    objective: "Render TUI objective",
    now: new Date("2026-06-13T08:00:00.000Z")
  });
  await writeRunState(state, { stateDir });
  await writeWikiForRunState(state, { stateDir });
  const input = /** @type {PassThrough & { isTTY?: boolean }} */ (new PassThrough());
  const output = /** @type {PassThrough & { isTTY?: boolean }} */ (new PassThrough());
  input.isTTY = true;
  output.isTTY = true;
  let text = "";
  output.on("data", (chunk) => {
    text += String(chunk);
  });

  await runLoopTui({
    stateDir,
    input,
    output,
    once: true,
    clearScreen: false,
    env: { FORCE_COLOR: "1" }
  });

  assert.match(text, /\x1b\[38;5;167m/);
  assert.match(text, /\.----->----\./);
  assert.match(text, /Loop Agent Console/);
  assert.match(text, /Render TUI objective/);
});

test("TUI init logo honors no-color terminal preferences", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "loop-tui-no-color-"));
  const input = /** @type {PassThrough & { isTTY?: boolean }} */ (new PassThrough());
  const output = /** @type {PassThrough & { isTTY?: boolean }} */ (new PassThrough());
  input.isTTY = true;
  output.isTTY = true;
  let text = "";
  output.on("data", (chunk) => {
    text += String(chunk);
  });

  await runLoopTui({
    stateDir,
    input,
    output,
    once: true,
    clearScreen: false,
    env: { NO_COLOR: "1" }
  });

  assert.match(text, /\.----->----\./);
  assert.doesNotMatch(text, /\x1b\[/);
});

test("TUI init logo appears only on the startup render", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "loop-tui-logo-once-"));
  const input = /** @type {PassThrough & { isTTY?: boolean }} */ (new PassThrough());
  const output = /** @type {PassThrough & { isTTY?: boolean }} */ (new PassThrough());
  input.isTTY = true;
  output.isTTY = true;
  let text = "";
  let promptCount = 0;
  output.on("data", (chunk) => {
    const value = String(chunk);
    text += value;
    if (!value.includes("loop> ")) {
      return;
    }
    promptCount += 1;
    input.write(promptCount === 1 ? "refresh\n" : "q\n");
  });

  await runLoopTui({
    stateDir,
    input,
    output,
    clearScreen: false,
    env: { FORCE_COLOR: "1" }
  });

  assert.equal((text.match(/\.----->----\./g) ?? []).length, 1);
  assert.equal((text.match(/Loop Agent Console/g) ?? []).length, 2);
});

test("CLI no-arg non-TTY prints TUI guidance", () => {
  const result = spawnSync(process.execPath, ["bin/loop.js"], {
    encoding: "utf8"
  });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /Loop Agent Console/);
  assert.match(result.stderr, /loop "your objective"/);
  assert.equal(result.stdout, "");
});
