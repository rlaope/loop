import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable, Writable } from "node:stream";
import { performance } from "node:perf_hooks";

import { createRunState } from "../src/core/run-state.js";
import { writeRunState } from "../src/core/state-store.js";
import { runLoopTui } from "../src/core/tui.js";
import { writeWikiForRunState, writeWikiSupportingNote } from "../src/core/wiki-store.js";

const RUN_COUNT = Number.parseInt(process.env.LOOP_PERF_TUI_RUNS ?? "120", 10);
const NOTES_PER_RUN = Number.parseInt(process.env.LOOP_PERF_TUI_NOTES_PER_RUN ?? "2", 10);
const ITERATIONS = Number.parseInt(process.env.LOOP_PERF_TUI_ITERATIONS ?? "24", 10);
const WARMUP = Number.parseInt(process.env.LOOP_PERF_TUI_WARMUP ?? "4", 10);
const P95_LIMIT_MS = Number.parseFloat(process.env.LOOP_PERF_TUI_P95_LIMIT_MS ?? "250");

class NullOutput extends Writable {
  constructor() {
    super();
    this.isTTY = true;
    this.columns = 104;
  }

  /**
   * @param {Buffer | string} _chunk
   * @param {BufferEncoding} _encoding
   * @param {(error?: Error | null) => void} callback
   */
  _write(_chunk, _encoding, callback) {
    callback();
  }
}

/** @returns {Readable & { isTTY?: boolean }} */
function nullInput() {
  const input = /** @type {Readable & { isTTY?: boolean }} */ (new Readable({ read() {} }));
  input.isTTY = true;
  return input;
}

/**
 * @param {number[]} values
 * @param {number} percentileValue
 */
function percentile(values, percentileValue) {
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(sorted.length - 1, Math.ceil((percentileValue / 100) * sorted.length) - 1);
  return sorted[index] ?? 0;
}

/** @param {string} stateDir */
async function createFixture(stateDir) {
  for (let index = 0; index < RUN_COUNT; index += 1) {
    const state = createRunState({
      objective: `Improve Loop TUI performance for project dashboard run ${index}`,
      now: new Date(Date.UTC(2026, 5, 16, 0, 0, index))
    });
    const paths = await writeRunState(state, { stateDir });
    const wiki = await writeWikiForRunState(state, { stateDir, paths });
    for (let noteIndex = 0; noteIndex < NOTES_PER_RUN; noteIndex += 1) {
      await writeWikiSupportingNote({
        stateDir,
        runId: state.id,
        parentId: wiki.id,
        kind: noteIndex % 2 === 0 ? "verification" : "decision",
        title: `Supporting note ${index}-${noteIndex}`,
        body: `Evidence, decision context, and follow-up notes for run ${index}, note ${noteIndex}.`
      });
    }
  }
}

/** @param {string} stateDir */
async function measureOnce(stateDir) {
  const started = performance.now();
  await runLoopTui({
    stateDir,
    input: nullInput(),
    output: new NullOutput(),
    once: true,
    clearScreen: false,
    env: { NO_COLOR: "1" },
    getDashboardStatusImpl: async () => ({ running: false, occupied: false })
  });
  return performance.now() - started;
}

async function main() {
  const root = await mkdtemp(join(tmpdir(), "loop-perf-tui-"));
  const stateDir = join(root, ".loop");
  try {
    await createFixture(stateDir);
    for (let index = 0; index < WARMUP; index += 1) {
      await measureOnce(stateDir);
    }
    const samples = [];
    for (let index = 0; index < ITERATIONS; index += 1) {
      samples.push(await measureOnce(stateDir));
    }
    const p50 = percentile(samples, 50);
    const p95 = percentile(samples, 95);
    const min = Math.min(...samples);
    const max = Math.max(...samples);
    const passed = p95 <= P95_LIMIT_MS;
    const summary = {
      runs: RUN_COUNT,
      notesPerRun: NOTES_PER_RUN,
      samples: samples.length,
      p50Ms: Number(p50.toFixed(2)),
      p95Ms: Number(p95.toFixed(2)),
      minMs: Number(min.toFixed(2)),
      maxMs: Number(max.toFixed(2)),
      limitMs: P95_LIMIT_MS,
      passed
    };
    console.log(JSON.stringify(summary, null, 2));
    if (!passed) {
      throw new Error(`TUI p95 ${summary.p95Ms}ms exceeded ${P95_LIMIT_MS}ms`);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

await main();
