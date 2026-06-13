import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmod, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
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

/** @param {string[]} args @param {string} cwd */
function git(args, cwd) {
  execFileSync("git", args, { cwd, stdio: "ignore" });
}

test("manifest capability matches explicit CLI surfaces", async () => {
  const manifest = JSON.parse(await readFile(".codex-plugin/plugin.json", "utf8"));
  const help = execFileSync(process.execPath, ["bin/loop.js", "--help"], { encoding: "utf8" });

  assert.equal(manifest.interface.capabilities.includes("Write"), false);
  assert.match(help, /--dry-run/);
  assert.match(help, /--agent codex/);
  assert.match(help, /Agent write mode requires explicit approval/);
});

test("CLI prints help and package version", async () => {
  const packageJson = JSON.parse(await readFile("package.json", "utf8"));
  const help = execFileSync(process.execPath, ["bin/loop.js", "--help"], { encoding: "utf8" });
  const shortHelp = execFileSync(process.execPath, ["bin/loop.js", "-h"], { encoding: "utf8" });
  const version = execFileSync(process.execPath, ["bin/loop.js", "--version"], { encoding: "utf8" });
  const shortVersion = execFileSync(process.execPath, ["bin/loop.js", "-v"], { encoding: "utf8" });

  assert.match(help, /Usage:/);
  assert.match(help, /--version/);
  assert.match(shortHelp, /Usage:/);
  assert.equal(version.trim(), packageJson.version);
  assert.equal(shortVersion.trim(), packageJson.version);
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

test("CLI codex agent mode runs through policy gate and records state", async () => {
  const repo = await mkdtemp(join(tmpdir(), "loop-agent-repo-"));
  const fakeBin = await mkdtemp(join(tmpdir(), "loop-fake-bin-"));
  const stateDir = join(repo, ".loop");
  const fakeCodex = join(fakeBin, "codex");
  await writeFile(fakeCodex, [
    "#!/usr/bin/env node",
    "import { writeFileSync } from 'node:fs';",
    "writeFileSync('codex-args.json', JSON.stringify(process.argv.slice(2), null, 2));"
  ].join("\n"));
  await chmod(fakeCodex, 0o755);
  git(["init", "-b", "main"], repo);

  const result = spawnSync(
    process.execPath,
    [
      resolve("bin/loop.js"),
      "--agent",
      "codex",
      "--write",
      "--isolation",
      "local",
      "--acknowledge-local",
      "--allow-no-remote",
      "--objective",
      "Build a site",
      "--state-dir",
      stateDir
    ],
    {
      cwd: repo,
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${fakeBin}:${process.env.PATH ?? ""}`
      }
    }
  );
  const output = JSON.parse(result.stdout);
  const state = JSON.parse(await readFile(output.paths.jsonPath, "utf8"));
  const codexArgs = JSON.parse(await readFile(join(repo, "codex-args.json"), "utf8"));

  assert.equal(result.status, 0);
  assert.equal(output.agent, "codex");
  assert.equal(state.phase, "verify");
  assert.equal(state.approvals.humanApproval, true);
  assert.equal(state.verificationEvidence.at(-1).status, "passed");
  assert.deepEqual(codexArgs.slice(0, 2), ["exec", "--sandbox"]);
  assert.ok(codexArgs.includes("workspace-write"));
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
