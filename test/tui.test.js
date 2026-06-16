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
  assert.match(html, /Phase: intake>plan>act>\[verify\]>stop/);
  assert.match(html, /Build a darkwear/);
  assert.match(html, /Action Bar/);
  assert.match(html, /Primary \[ Enter Send Prompt \]/);
  assert.match(html, /Review\s+\[ W Wiki \]/);
  assert.match(html, /System\s+\[ 1-9 Select \]/);
  assert.match(html, /X Codex/);
  assert.match(html, /Last Event/);
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
  const input = /** @type {PassThrough & { isTTY?: boolean }} */ (new PassThrough());
  const output = /** @type {PassThrough & { isTTY?: boolean }} */ (new PassThrough());
  input.isTTY = true;
  output.isTTY = true;
  let text = "";
  let promptCount = 0;
  output.on("data", (chunk) => {
    const value = String(chunk);
    text += value;
    const plain = value.replace(/\x1b\[[0-9;]*m/g, "");
    if (!plain.endsWith("Prompt › ")) {
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
  assert.equal((text.match(/Loop Prompt Console/g) ?? []).length, 2);
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
    const plain = String(chunk).replace(/\x1b\[[0-9;]*m/g, "");
    if (!plain.endsWith("Prompt › ")) {
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

test("TUI free text input is treated as a Loop prompt, not an unknown command", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "loop-tui-prompt-input-"));
  const state = createRunState({
    objective: "Improve dashboard UX",
    now: new Date("2026-06-13T08:00:00.000Z")
  });
  await writeRunState(state, { stateDir });
  await writeWikiForRunState(state, { stateDir });
  const input = /** @type {PassThrough & { isTTY?: boolean }} */ (new PassThrough());
  const output = /** @type {PassThrough & { isTTY?: boolean }} */ (new PassThrough());
  input.isTTY = true;
  output.isTTY = true;
  let text = "";
  let stage = 0;
  output.on("data", (chunk) => {
    const value = String(chunk);
    const plain = value.replace(/\x1b\[[0-9;]*m/g, "");
    text += plain;
    if (stage === 0 && plain.endsWith("Prompt › ")) {
      stage = 1;
      input.write("Continue polishing the live log view\n");
      return;
    }
    if (stage === 1 && plain.includes("Press Enter to return.")) {
      stage = 2;
      input.write("\n");
      return;
    }
    if (stage === 2 && plain.endsWith("Prompt › ")) {
      stage = 3;
      input.write("q\n");
    }
  });

  await runLoopTui({
    stateDir,
    input,
    output,
    clearScreen: false,
    getDashboardStatusImpl: async () => ({ running: false, occupied: false })
  });

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
