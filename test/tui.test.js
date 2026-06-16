import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";

import {
  createRunState,
  directPromptTuiDispatch,
  noArgTuiDispatch,
  renderTuiHome,
  renderTuiProcessing,
  runLoopProcessingTui,
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

test("direct prompt dispatch opens processing TUI only for interactive shorthand runs", () => {
  assert.equal(directPromptTuiDispatch({
    hasCommand: false,
    stdinTTY: true,
    stdoutTTY: true
  }), "processing-tui");
  assert.equal(directPromptTuiDispatch({
    hasCommand: true,
    stdinTTY: true,
    stdoutTTY: true
  }), "standard-run");
  assert.equal(directPromptTuiDispatch({
    hasCommand: false,
    stdinTTY: false,
    stdoutTTY: true
  }), "standard-run");
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

test("TUI processing render summarizes active run and live log", () => {
  const state = createRunState({
    objective: "Improve dashboard observability",
    now: new Date("2026-06-13T08:00:00.000Z")
  });
  const processing = renderTuiProcessing({
    stateDir: ".loop",
    agent: "codex",
    selectedRunId: state.id,
    selectedRun: {
      ...state,
      phase: "act",
      nextAction: "run codex agent",
      paths: {
        jsonPath: ".loop/runs/run-1.json",
        summaryPath: ".loop/runs/run-1.md",
        logPath: ".loop/runs/run-1.log"
      },
      session: {
        agent: "codex",
        status: "running",
        pid: 1234
      },
      lineage: undefined
    },
    runs: [],
    notes: [],
    graph: { nodes: [], edges: [] }
  }, {
    runId: state.id,
    frame: 1,
    logTail: "[loop] starting codex\nagent output"
  });

  assert.match(processing, /Processing run/);
  assert.match(processing, /Agent pid: 1234/);
  assert.match(processing, /Improve dashboard observability/);
  assert.match(processing, /agent output/);
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

test("TUI processing mode follows a run promise without opening the command prompt", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "loop-tui-processing-"));
  const state = createRunState({
    objective: "Processing TUI objective",
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

  const value = await runLoopProcessingTui({
    stateDir,
    runId: state.id,
    agent: "codex",
    runPromise: new Promise((resolve) => setTimeout(() => resolve("done"), 5)),
    input,
    output,
    clearScreen: false,
    intervalMs: 1,
    continueToConsole: false,
    env: { NO_COLOR: "1" }
  });

  assert.equal(value, "done");
  assert.match(text, /Processing run/);
  assert.match(text, /Processing TUI objective/);
  assert.match(text, /Agent process exited/);
  assert.doesNotMatch(text, /loop> /);
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

test("TUI dashboard command starts and opens the local dashboard", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "loop-tui-dashboard-"));
  const input = /** @type {PassThrough & { isTTY?: boolean }} */ (new PassThrough());
  const output = /** @type {PassThrough & { isTTY?: boolean }} */ (new PassThrough());
  input.isTTY = true;
  output.isTTY = true;
  let promptCount = 0;
  let serveCalls = 0;
  let opened = "";
  let closed = false;
  const server = createServer();
  server.on("close", () => {
    closed = true;
  });
  await new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve(undefined));
  });
  output.on("data", (chunk) => {
    if (!String(chunk).includes("loop> ")) {
      return;
    }
    promptCount += 1;
    input.write(promptCount === 1 ? "dashboard\n" : "q\n");
  });

  await runLoopTui({
    stateDir,
    input,
    output,
    clearScreen: false,
    serveWikiDashboardImpl: async () => {
      serveCalls += 1;
      return {
        status: "started",
        url: "http://127.0.0.1:3846",
        server
      };
    },
    openTargetImpl: (target) => {
      opened = target;
      return { opened: true, recorded: false, target };
    }
  });

  assert.equal(serveCalls, 1);
  assert.equal(opened, "http://127.0.0.1:3846");
  assert.equal(closed, true);
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
