import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

test("Codex plugin manifest points at skills", async () => {
  const manifest = JSON.parse(await readFile(".codex-plugin/plugin.json", "utf8"));

  assert.equal(manifest.name, "loop");
  assert.equal(manifest.skills, "./skills/");
  assert.equal(manifest.interface.displayName, "Loop");
  assert.deepEqual(manifest.interface.capabilities, ["Interactive"]);
});

test("$loop skill describes the six Loop Engineering components", async () => {
  const skill = await readFile("skills/loop/SKILL.md", "utf8");

  assert.match(skill, /\$loop/);
  for (const component of ["Automations", "Worktrees", "Skills", "Plugins/connectors", "Sub-agents", "Memory"]) {
    assert.match(skill, new RegExp(component.replace("/", "\\/")));
  }
});

test("CLI dry-run writes durable state without source edits", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "loop-cli-state-"));
  const output = execFileSync(
    process.execPath,
    ["bin/loop.js", "--dry-run", "--objective", "Dry maintenance", "--state-dir", stateDir],
    { encoding: "utf8" }
  );
  const parsed = JSON.parse(output);
  const stateText = await readFile(parsed.paths.jsonPath, "utf8");
  const state = JSON.parse(stateText);

  assert.equal(parsed.ok, true);
  assert.equal(state.objective, "Dry maintenance");
  assert.equal(state.verificationEvidence[0].status, "passed");
});

test("manifest capability matches dry-run only executable surface", async () => {
  const manifest = JSON.parse(await readFile(".codex-plugin/plugin.json", "utf8"));
  const help = execFileSync(process.execPath, ["bin/loop.js", "--help"], { encoding: "utf8" });

  assert.equal(manifest.interface.capabilities.includes("Write"), false);
  assert.match(help, /--dry-run/);
  assert.match(help, /strict dry-run\/read-only/);
});

test("CLI reports state write failures without an uncaught stack trace", async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "loop-cli-invalid-state-"));
  const fileStateDir = join(tempDir, "not-a-directory");
  await writeFile(fileStateDir, "occupied");

  const result = spawnSync(
    process.execPath,
    ["bin/loop.js", "--dry-run", "--objective", "Bad state dir", "--state-dir", fileStateDir],
    { encoding: "utf8" }
  );

  assert.equal(result.status, 4);
  assert.match(result.stderr, /State write failed:/);
  assert.doesNotMatch(result.stderr, /at async|Error:/);
  assert.equal(result.stdout, "");
});

test("CLI rejects flags that are missing values", () => {
  const result = spawnSync(
    process.execPath,
    ["bin/loop.js", "--dry-run", "--objective", "--state-dir"],
    { encoding: "utf8" }
  );

  assert.equal(result.status, 1);
  assert.match(result.stderr, /--objective requires a value/);
  assert.match(result.stderr, /Usage:/);
  assert.doesNotMatch(result.stdout, /"ok": true/);
});
