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
import { parseKeyIntent } from "../src/core/tui-input.js";
import { createTuiModel, reduceTuiIntent, setTuiOverlay } from "../src/core/tui-state.js";

/** @param {number} ms */
function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function createTtyStreams() {
  const input = /** @type {PassThrough & { isTTY?: boolean, setRawMode?: (enabled: boolean) => unknown }} */ (new PassThrough());
  const output = /** @type {PassThrough & { isTTY?: boolean }} */ (new PassThrough());
  /** @type {boolean[]} */
  const rawModes = [];
  input.isTTY = true;
  output.isTTY = true;
  input.setRawMode = (enabled) => {
    rawModes.push(enabled);
    return input;
  };
  return { input, output, rawModes };
}

/**
 * @param {PassThrough} input
 * @param {string[]} keys
 */
async function writeKeys(input, keys) {
  for (const key of keys) {
    input.write(key);
    await delay(5);
  }
}

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
    hasCommand: false,
    stdinTTY: true,
    stdoutTTY: true,
    justRun: true
  }), "standard-run");
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

test("TUI home render shows prompt console panels, status, runs, and action buttons", () => {
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
    dashboard: {
      running: true,
      occupied: false,
      url: "http://127.0.0.1:3846"
    },
    obsidian: {
      configured: false
    },
    notice: "Ready.",
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
  assert.doesNotMatch(html, /Commands/);
  assert.match(html, /Loop Prompt Console/);
  assert.match(html, /Prompt/);
  assert.match(html, /Prompt ›/);
  assert.match(html, /Harness Status/);
  assert.match(html, /Agent: codex/);
  assert.match(html, /Wiki dashboard: online/);
  assert.match(html, /Obsidian: off/);
  assert.match(html, /Phase: intake>plan>act>\[verify\]>stop/);
  assert.match(html, /Build a darkwear/);
  assert.match(html, /Action Bar/);
  assert.match(html, /\[ Dashboard \]/);
  assert.match(html, /\[ Logs \]/);
  assert.match(html, /\[ Obsidian \]/);
  assert.match(html, /\[ Codex \]/);
  assert.match(html, /\[ Follow-up \]/);
  assert.match(html, /Tab\/Shift\+Tab focus/);
  assert.match(html, /Last Event/);
});

test("TUI reducer supports keyboard focus, run picker, and prompt submission", () => {
  const snapshot = {
    stateDir: ".loop",
    agent: /** @type {"codex"} */ ("codex"),
    selectedRunId: "run-1",
    selectedRun: null,
    runs: [
      { id: "run-1", status: "active", phase: "act", objective: "First run" },
      { id: "run-2", status: "active", phase: "verify", objective: "Second run" }
    ],
    notes: [],
    graph: { nodes: [], edges: [] },
    dashboard: { running: false, occupied: false, url: "http://127.0.0.1:3846" },
    notice: ""
  };
  let model = createTuiModel(snapshot);

  assert.equal(model.focusRegion, "runs");
  let reduced = reduceTuiIntent(model, { type: "moveDown", runCount: snapshot.runs.length });
  model = reduced.model;
  assert.equal(model.selectedRunIndex, 1);

  reduced = reduceTuiIntent(model, { type: "open", runCount: snapshot.runs.length });
  model = reduced.model;
  assert.equal(model.overlay, "runPicker");
  assert.equal(model.overlayIndex, 1);

  reduced = reduceTuiIntent(model, { type: "open", runCount: snapshot.runs.length });
  model = reduced.model;
  assert.equal(model.overlay, null);
  assert.equal(reduced.effects[0]?.type, "selectRunIndex");
  assert.equal(reduced.effects[0]?.index, 1);

  model = reduceTuiIntent(model, { type: "focusPrevious" }).model;
  assert.equal(model.focusRegion, "prompt");
  model = reduceTuiIntent(model, { type: "appendText", text: "후속 목표" }).model;
  reduced = reduceTuiIntent(model, { type: "open" });
  assert.equal(reduced.effects[0]?.type, "submitPrompt");
  assert.equal(reduced.effects[0]?.prompt, "후속 목표");
});

test("TUI reducer opens Obsidian settings and dispatches selected vault actions", () => {
  const snapshot = {
    stateDir: ".loop",
    agent: /** @type {"codex"} */ ("codex"),
    selectedRunId: "run-1",
    selectedRun: null,
    runs: [{ id: "run-1", status: "active", phase: "act", objective: "Run" }],
    notes: [],
    graph: { nodes: [], edges: [] },
    dashboard: { running: false, occupied: false, url: "http://127.0.0.1:3846" },
    obsidian: { configured: false },
    notice: ""
  };
  let model = createTuiModel(snapshot, { focusRegion: "actions" });

  let reduced = reduceTuiIntent(model, { type: "action", action: "obsidian" });
  assert.equal(reduced.effects[0]?.type, "action");
  assert.equal(reduced.effects[0]?.action, "obsidian");

  model = setTuiOverlay(model, "obsidianSettings", {
    lines: ["Status: not configured"],
    actions: [
      { id: "init", label: "Use /tmp/LoopVault", vaultPath: "/tmp/LoopVault" },
      { id: "close", label: "Close" }
    ]
  });
  reduced = reduceTuiIntent(model, { type: "open" });

  assert.equal(reduced.effects[0]?.type, "obsidianAction");
  assert.equal(reduced.effects[0]?.action, "init");
  assert.equal(reduced.effects[0]?.vaultPath, "/tmp/LoopVault");

  model = reduceTuiIntent(model, { type: "moveDown" }).model;
  reduced = reduceTuiIntent(model, { type: "open" });
  assert.equal(reduced.effects.length, 0);
  assert.equal(reduced.model.overlay, null);
});

test("TUI reducer preserves confirmation and two-field note semantics", () => {
  const snapshot = {
    stateDir: ".loop",
    agent: /** @type {"codex"} */ ("codex"),
    selectedRunId: "run-1",
    selectedRun: null,
    runs: [{ id: "run-1", status: "active", phase: "verify", objective: "Run" }],
    notes: [],
    graph: { nodes: [], edges: [] },
    dashboard: { running: false, occupied: false, url: "http://127.0.0.1:3846" },
    notice: ""
  };
  let model = createTuiModel(snapshot, { focusRegion: "actions" });

  let reduced = reduceTuiIntent(model, { type: "action", action: "complete" });
  model = reduced.model;
  assert.equal(model.overlay, "confirmComplete");
  assert.equal(reduced.effects.length, 0);
  reduced = reduceTuiIntent(model, { type: "moveDown" });
  model = reduced.model;
  reduced = reduceTuiIntent(model, { type: "open" });
  assert.equal(reduced.effects.length, 0);
  assert.equal(reduced.model.overlay, null);

  model = createTuiModel(snapshot, { focusRegion: "actions" });
  model = reduceTuiIntent(model, { type: "action", action: "note" }).model;
  assert.equal(model.overlay, "noteInput");
  model = reduceTuiIntent(model, { type: "appendText", text: "Title" }).model;
  model = reduceTuiIntent(model, { type: "focusNext" }).model;
  model = reduceTuiIntent(model, { type: "appendText", text: "Body" }).model;
  model = reduceTuiIntent(model, { type: "focusNext" }).model;
  model = reduceTuiIntent(model, { type: "appendText", text: "Ignored" }).model;
  model = reduceTuiIntent(model, { type: "deleteText" }).model;
  assert.equal(model.overlayData.title, "Title");
  assert.equal(model.overlayData.body, "Body");
  reduced = reduceTuiIntent(model, { type: "open" });
  assert.equal(reduced.effects[0]?.type, "action");
  assert.equal(reduced.effects[0]?.action, "note");
  assert.equal(reduced.effects[0]?.title, "Title");
  assert.equal(reduced.effects[0]?.body, "Body");
});

test("TUI modal overlays ignore global shortcuts and background focus changes", () => {
  const snapshot = {
    stateDir: ".loop",
    agent: /** @type {"codex"} */ ("codex"),
    selectedRunId: "run-1",
    selectedRun: null,
    runs: [{ id: "run-1", status: "active", phase: "verify", objective: "Run" }],
    notes: [],
    graph: { nodes: [], edges: [] },
    dashboard: { running: false, occupied: false, url: "http://127.0.0.1:3846" },
    notice: ""
  };
  let model = createTuiModel(snapshot, { focusRegion: "actions" });
  model = reduceTuiIntent(model, { type: "action", action: "complete" }).model;

  assert.equal(model.overlay, "confirmComplete");
  assert.equal(parseKeyIntent({ str: "d", key: { name: "d" }, model }), null);

  let reduced = reduceTuiIntent(model, { type: "action", action: "dashboard" });
  assert.equal(reduced.model.overlay, "confirmComplete");
  assert.equal(reduced.effects.length, 0);

  reduced = reduceTuiIntent(model, { type: "refresh" });
  assert.equal(reduced.model.overlay, "confirmComplete");
  assert.equal(reduced.effects.length, 0);

  reduced = reduceTuiIntent(model, { type: "focusNext" });
  assert.equal(reduced.model.focusRegion, "actions");
  assert.equal(reduced.model.overlay, "confirmComplete");
});

test("TUI key parser maps navigation, shortcuts, and Korean prompt text", () => {
  const runsModel = {
    overlay: null,
    focusRegion: "runs",
    promptBuffer: "",
    promptMode: false
  };
  assert.deepEqual(parseKeyIntent({ key: { name: "down" }, model: runsModel, runCount: 2 }), {
    type: "moveDown",
    runCount: 2
  });
  assert.deepEqual(parseKeyIntent({ str: "d", key: { name: "d" }, model: runsModel }), {
    type: "action",
    action: "dashboard"
  });
  assert.deepEqual(parseKeyIntent({ str: "o", key: { name: "o" }, model: runsModel }), {
    type: "action",
    action: "obsidian"
  });
  assert.deepEqual(parseKeyIntent({ str: "한", key: { name: "한" }, model: runsModel }), {
    type: "appendText",
    text: "한"
  });
  assert.deepEqual(parseKeyIntent({
    str: "d",
    key: { name: "d" },
    model: { ...runsModel, focusRegion: "prompt", promptMode: true }
  }), {
    type: "appendText",
    text: "d"
  });
  assert.deepEqual(parseKeyIntent({ key: { name: "c", ctrl: true }, model: runsModel }), {
    type: "quit"
  });
});

test("TUI run picker windows long histories around the keyboard cursor", () => {
  const runs = Array.from({ length: 15 }, (_, index) => ({
    id: `run-${String(index + 1).padStart(2, "0")}`,
    status: "active",
    phase: "act",
    objective: `Run ${String(index + 1).padStart(2, "0")}`
  }));
  const snapshot = {
    stateDir: ".loop",
    agent: /** @type {"codex"} */ ("codex"),
    selectedRunId: "run-13",
    selectedRun: runs[12],
    runs,
    notes: [],
    graph: { nodes: [], edges: [] },
    dashboard: { running: false, occupied: false, url: "http://127.0.0.1:3846" },
    notice: ""
  };
  const model = {
    ...createTuiModel(snapshot),
    overlay: "runPicker",
    overlayIndex: 12
  };
  const html = renderTuiHome(snapshot, { width: 100, model });

  assert.match(html, /Showing 4-15 of 15/);
  assert.match(html, /13\. active\/act\s+Run 13/);
  assert.doesNotMatch(html, /1\. active\/act\s+Run 01/);
});

test("TUI home render distinguishes unknown wiki dashboard status from blocked", () => {
  /** @type {Parameters<typeof renderTuiHome>[0]} */
  const snapshot = {
    stateDir: ".loop",
    agent: "codex",
    selectedRunId: null,
    selectedRun: null,
    runs: [],
    notes: [],
    dashboard: {
      running: false,
      occupied: false,
      unknown: true,
      url: "http://127.0.0.1:3846"
    },
    notice: "",
    graph: { nodes: [], edges: [] }
  };
  const html = renderTuiHome(snapshot, { width: 80 });

  assert.match(html, /Wiki dashboard: unknown/);
  assert.doesNotMatch(html, /Wiki dashboard: blocked/);
  assert.match(html, /new Loop objective/i);
});

test("TUI snapshot normalizes uncertain dashboard probe occupation as unknown", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "loop-tui-dashboard-unknown-"));
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
    getDashboardStatusImpl: async () => ({ running: false, occupied: true })
  });

  assert.match(text, /Wiki dashboard: unknown/);
  assert.doesNotMatch(text, /Wiki dashboard: blocked/);
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
    dashboard: {
      running: false,
      occupied: false,
      url: "http://127.0.0.1:3846"
    },
    notice: "",
    graph: { nodes: [], edges: [] }
  }, {
    runId: state.id,
    frame: 1,
    logTail: "[loop] starting codex\nagent output"
  });

  assert.match(processing, /Processing live agent run/);
  assert.match(processing, /Harness Status/);
  assert.match(processing, /Wiki dashboard: off/);
  assert.match(processing, /PID: 1234/);
  assert.match(processing, /Phase: intake>plan>\[act\]>verify>stop/);
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
  assert.match(text, /Loop Prompt Console/);
  assert.match(text, /Render TUI objective/);
});

test("TUI dashboard status follows custom dashboard port", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "loop-tui-custom-port-"));
  const input = /** @type {PassThrough & { isTTY?: boolean }} */ (new PassThrough());
  const output = /** @type {PassThrough & { isTTY?: boolean }} */ (new PassThrough());
  input.isTTY = true;
  output.isTTY = true;
  let text = "";
  /** @type {Array<{ host?: string, port?: number, timeoutMs?: number }>} */
  const probes = [];
  output.on("data", (chunk) => {
    text += String(chunk);
  });

  await runLoopTui({
    stateDir,
    input,
    output,
    once: true,
    clearScreen: false,
    dashboardPort: 45678,
    getDashboardStatusImpl: async (options = {}) => {
      probes.push(options);
      return { running: true, occupied: false };
    }
  });

  assert.equal(probes[0]?.port, 45678);
  assert.match(text, /Wiki dashboard: online/);
  assert.match(text, /http:\/\/127\.0\.0\.1:45678/);
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
  assert.match(text, /Processing live agent run/);
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
  const { input, output, rawModes } = createTtyStreams();
  let text = "";
  output.on("data", (chunk) => {
    text += String(chunk);
  });

  const run = runLoopTui({
    stateDir,
    input,
    output,
    clearScreen: false,
    env: { FORCE_COLOR: "1" }
  });
  await delay(20);
  input.write("\x03");
  await run;

  assert.equal((text.match(/\.----->----\./g) ?? []).length, 1);
  assert.match(text, /Loop Prompt Console/);
  assert.deepEqual(rawModes, [true, false]);
});

test("TUI dashboard command starts and opens the local dashboard", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "loop-tui-dashboard-"));
  const state = createRunState({
    objective: "Dashboard shortcut run",
    now: new Date("2026-06-13T08:00:00.000Z")
  });
  await writeRunState(state, { stateDir });
  await writeWikiForRunState(state, { stateDir });
  const { input, output } = createTtyStreams();
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

  const run = runLoopTui({
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
  await delay(20);
  await writeKeys(input, ["d", "q"]);
  await run;

  assert.equal(serveCalls, 1);
  assert.equal(opened, "http://127.0.0.1:3846");
  assert.equal(closed, true);
});

test("TUI Obsidian settings can detect and initialize a vault from the keyboard", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "loop-tui-obsidian-"));
  const state = createRunState({
    objective: "Mirror wiki notes into Obsidian",
    now: new Date("2026-06-13T08:00:00.000Z")
  });
  await writeRunState(state, { stateDir });
  await writeWikiForRunState(state, { stateDir });
  const { input, output } = createTtyStreams();
  const vaultPath = join(stateDir, "PersonalVault");
  let configured = false;
  let initializedVault = "";
  let text = "";
  output.on("data", (chunk) => {
    text += String(chunk).replace(/\x1b\[[0-9;]*m/g, "");
  });

  const statusForTest = async ({ detectCandidates = false } = {}) => ({
    configured,
    configPath: join(stateDir, "obsidian-sync.json"),
    manifestPath: join(stateDir, "obsidian-sync-manifest.json"),
    config: configured
      ? {
          version: /** @type {1} */ (1),
          vaultPath,
          projectId: "project-1",
          projectName: "loop",
          projectFolder: "loop-project-1",
          syncRoot: join(vaultPath, "Loop", "loop-project-1"),
          enabled: true,
          createdAt: "2026-06-13T08:00:00.000Z",
          updatedAt: "2026-06-13T08:00:00.000Z"
        }
      : null,
    candidates: configured || !detectCandidates ? [] : [vaultPath],
    project: {
      projectId: "project-1",
      projectName: "loop",
      projectFolder: "loop-project-1"
    }
  });

  const run = runLoopTui({
    stateDir,
    input,
    output,
    clearScreen: false,
    obsidianSyncStatusImpl: statusForTest,
    initObsidianSyncImpl: async ({ vaultPath: selectedVaultPath }) => {
      initializedVault = selectedVaultPath;
      configured = true;
      return {
        ok: true,
        config: {
          version: 1,
          vaultPath,
          projectId: "project-1",
          projectName: "loop",
          projectFolder: "loop-project-1",
          syncRoot: join(vaultPath, "Loop", "loop-project-1"),
          enabled: true,
          createdAt: "2026-06-13T08:00:00.000Z",
          updatedAt: "2026-06-13T08:00:00.000Z"
        },
        configPath: join(stateDir, "obsidian-sync.json")
      };
    }
  });
  await delay(20);
  await writeKeys(input, ["o", "\r", "\x03"]);
  await run;

  assert.equal(initializedVault, vaultPath);
  assert.match(text, /Obsidian Settings/);
  assert.match(text, /Use .*PersonalVault/);
  assert.match(text, /Obsidian sync configured: loop-project-1/);
  assert.match(text, /Obsidian: configured/);
});

test("TUI complete action requires confirmation and cancel has no side effect", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "loop-tui-complete-cancel-"));
  const state = createRunState({
    objective: "Complete cancel run",
    now: new Date("2026-06-13T08:00:00.000Z")
  });
  await writeRunState(state, { stateDir });
  await writeWikiForRunState(state, { stateDir });
  const { input, output } = createTtyStreams();
  let text = "";
  let completeCalls = 0;
  output.on("data", (chunk) => {
    text += String(chunk).replace(/\x1b\[[0-9;]*m/g, "");
  });

  const run = runLoopTui({
    stateDir,
    input,
    output,
    clearScreen: false,
    markCompleteActionImpl: async () => {
      completeCalls += 1;
      return {
        ok: true,
        state,
        paths: { jsonPath: "run.json", summaryPath: "run.md" },
        wikiPaths: {
          id: "note-1",
          notePath: "note.md",
          memoryPath: "memory.json",
          indexPath: "index.json",
          graphPath: "graph.json"
        }
      };
    }
  });
  await delay(20);
  await writeKeys(input, [
    "c",
    "\x1b[B",
    "\r",
    "\x03"
  ]);
  await run;

  assert.match(text, /Confirm Complete/);
  assert.equal(completeCalls, 0);
});

test("TUI note action keeps title and body as separate required fields", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "loop-tui-note-fields-"));
  const state = createRunState({
    objective: "Note field run",
    now: new Date("2026-06-13T08:00:00.000Z")
  });
  await writeRunState(state, { stateDir });
  await writeWikiForRunState(state, { stateDir });
  const { input, output } = createTtyStreams();
  let text = "";
  /** @type {Array<{ title: string, body: string }>} */
  const notes = [];
  output.on("data", (chunk) => {
    text += String(chunk).replace(/\x1b\[[0-9;]*m/g, "");
  });

  const run = runLoopTui({
    stateDir,
    input,
    output,
    clearScreen: false,
    addWikiNoteActionImpl: async (options) => {
      notes.push({ title: options.title, body: options.body });
      return {
        ok: true,
        result: {
          id: "note-1",
          kind: "note",
          notePath: "note.md",
          memoryPath: "memory.json",
          indexPath: "index.json",
          graphPath: "graph.json",
          parentId: state.id
        }
      };
    }
  });
  await delay(20);
  await writeKeys(input, [
    "n",
    "Title",
    "\t",
    "Body",
    "\t",
    "\r",
    "\x03"
  ]);
  await run;

  assert.match(text, /Add Note/);
  assert.deepEqual(notes, [{ title: "Title", body: "Body" }]);
});

test("TUI free text input is treated as a Loop prompt, not an unknown command", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "loop-tui-prompt-input-"));
  const state = createRunState({
    objective: "Improve dashboard UX",
    now: new Date("2026-06-13T08:00:00.000Z")
  });
  await writeRunState(state, { stateDir });
  await writeWikiForRunState(state, { stateDir });
  const { input, output } = createTtyStreams();
  let text = "";
  output.on("data", (chunk) => {
    text += String(chunk).replace(/\x1b\[[0-9;]*m/g, "");
  });

  const run = runLoopTui({
    stateDir,
    input,
    output,
    clearScreen: false,
    getDashboardStatusImpl: async () => ({ running: false, occupied: false })
  });
  await delay(20);
  await writeKeys(input, ["\t", "\t", "\t", "\t", "Continue polishing the live log view", "\r", "\x03"]);
  await run;

  assert.match(text, /Prepared connected Loop prompt/);
  assert.match(text, /--parent-run/);
  assert.match(text, /Continue polishing the live log view/);
  assert.doesNotMatch(text, /Unknown command/);
});

test("CLI no-arg non-TTY prints TUI guidance", () => {
  const result = spawnSync(process.execPath, ["bin/loop.js"], {
    encoding: "utf8"
  });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /Loop Prompt Console/);
  assert.match(result.stderr, /loop "your objective"/);
  assert.equal(result.stdout, "");
});
