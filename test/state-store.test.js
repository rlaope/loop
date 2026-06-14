import test from "node:test";
import assert from "node:assert/strict";
import { appendFile, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  createRunState,
  deleteRunState,
  listRunStates,
  readLatestRunBySlug,
  readRunLog,
  readRunState,
  runLogPath,
  writeRunState
} from "../src/index.js";

test("writes machine-readable state and human-readable summary", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "loop-state-"));
  const state = createRunState({
    objective: "Persist memory",
    now: new Date("2026-06-13T00:00:00.000Z")
  });

  const paths = await writeRunState(state, { stateDir });
  const read = await readRunState(state.id, { stateDir });
  const latestIndex = JSON.parse(await readFile(join(stateDir, "latest-runs.json"), "utf8"));

  assert.match(paths.jsonPath, /persist-memory/);
  assert.match(paths.summaryPath, /persist-memory/);
  assert.equal(read.ok, true);
  assert.equal(read.ok && read.state.objective, "Persist memory");
  assert.equal(latestIndex["persist-memory"], state.id);
});

test("reads latest run by objective slug", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "loop-latest-"));
  const first = createRunState({
    objective: "Same objective",
    now: new Date("2026-06-13T00:00:00.000Z")
  });
  const second = createRunState({
    objective: "Same objective",
    now: new Date("2026-06-13T01:00:00.000Z")
  });

  await writeRunState(first, { stateDir });
  await writeRunState(second, { stateDir });

  const latest = await readLatestRunBySlug("same-objective", { stateDir });

  assert.equal(latest.ok, true);
  assert.equal(latest.ok && latest.state.id, second.id);
});

test("lists run states and reads run logs", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "loop-list-runs-"));
  const first = createRunState({
    objective: "First run",
    now: new Date("2026-06-13T00:00:00.000Z")
  });
  const second = createRunState({
    objective: "Second run",
    now: new Date("2026-06-13T01:00:00.000Z")
  });

  await writeRunState(first, { stateDir });
  await writeRunState(second, { stateDir });
  await appendFile(runLogPath({ stateDir, id: second.id }), "agent log line\n");
  const runs = await listRunStates({ stateDir });
  const log = await readRunLog(second.id, { stateDir });

  assert.equal(runs.length, 2);
  assert.equal(runs[0].state.id, second.id);
  assert.equal(log, "agent log line\n");
});

test("deletes run state artifacts and repairs latest index", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "loop-delete-run-"));
  const first = createRunState({
    objective: "Same objective",
    now: new Date("2026-06-13T00:00:00.000Z")
  });
  const second = createRunState({
    objective: "Same objective",
    now: new Date("2026-06-13T01:00:00.000Z")
  });

  await writeRunState(first, { stateDir });
  await writeRunState(second, { stateDir });
  await appendFile(runLogPath({ stateDir, id: second.id }), "delete me\n");

  await deleteRunState(second.id, { stateDir });
  const latest = await readLatestRunBySlug("same-objective", { stateDir });
  const runs = await listRunStates({ stateDir });

  assert.equal(latest.ok, true);
  assert.equal(latest.ok && latest.state.id, first.id);
  assert.deepEqual(runs.map((run) => run.state.id), [first.id]);
});

test("latest-run lookup rejects invalid slugs", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "loop-latest-slug-"));

  const latest = await readLatestRunBySlug("../escape", { stateDir });

  assert.equal(latest.ok, false);
  assert.equal(!latest.ok && latest.error.kind, "invalid_slug");
});

test("latest-run lookup surfaces corrupt index state", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "loop-latest-corrupt-index-"));
  const state = createRunState({ objective: "Indexed objective" });
  await writeRunState(state, { stateDir });
  await writeFile(join(stateDir, "latest-runs.json"), "{ not json");

  const latest = await readLatestRunBySlug("indexed-objective", { stateDir });

  assert.equal(latest.ok, false);
  assert.equal(!latest.ok && latest.error.kind, "corrupt_or_missing_state");
});

test("surfaces corrupt state as recoverable error", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "loop-corrupt-"));
  await writeFile(join(stateDir, "runs.json"), "not used");
  const read = await readRunState("missing", { stateDir });

  assert.equal(read.ok, false);
  assert.equal(!read.ok && read.error.kind, "corrupt_or_missing_state");
});

test("rejects path traversal run ids", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "loop-traversal-"));
  const state = createRunState({ objective: "Do not escape" });

  await assert.rejects(
    () => writeRunState({ ...state, id: "../escape" }, { stateDir }),
    /safe filename|Unsafe run id/
  );

  const read = await readRunState("../escape", { stateDir });
  assert.equal(read.ok, false);
});

test("latest-run lookup rejects malformed matching state", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "loop-latest-invalid-"));
  const runsDir = join(stateDir, "runs");
  await mkdir(runsDir);
  await writeFile(join(runsDir, "bad.json"), JSON.stringify({
    objectiveSlug: "bad-state",
    budget: {
      estimatedTokensUsed: -10
    }
  }));

  const latest = await readLatestRunBySlug("bad-state", { stateDir });

  assert.equal(latest.ok, false);
  assert.equal(!latest.ok && latest.error.kind, "corrupt_or_missing_state");
});
