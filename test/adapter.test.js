import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
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
  assert.match(parsed.wikiPaths.notePath, /wiki\/user/);
});

test("CLI wiki list and read expose dry-run notes", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "loop-cli-wiki-state-"));
  const output = execFileSync(
    process.execPath,
    ["bin/loop.js", "--dry-run", "--objective", "Wiki maintenance", "--state-dir", stateDir],
    { encoding: "utf8" }
  );
  const parsed = JSON.parse(output);
  const list = execFileSync(
    process.execPath,
    ["bin/loop.js", "wiki", "list", "--state-dir", stateDir, "--host", "0.0.0.0", "--port", "not-a-port"],
    { encoding: "utf8" }
  );
  const read = execFileSync(
    process.execPath,
    ["bin/loop.js", "wiki", "read", parsed.wikiPaths.id, "--state-dir", stateDir],
    { encoding: "utf8" }
  );

  assert.match(list, new RegExp(parsed.wikiPaths.id));
  assert.match(read, /# Wiki maintenance/);
  assert.match(read, /## Token Usage/);
});

test("CLI dry-run reports wiki failure after durable state write", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "loop-cli-wiki-fail-"));
  await writeFile(join(stateDir, "wiki"), "occupied");

  const result = spawnSync(
    process.execPath,
    ["bin/loop.js", "--dry-run", "--objective", "Wiki failure", "--state-dir", stateDir],
    { encoding: "utf8" }
  );
  const runFiles = await readdir(join(stateDir, "runs"));

  assert.equal(result.status, 6);
  assert.match(result.stderr, /Wiki write failed after durable state write/);
  assert.ok(runFiles.some((file) => file.endsWith(".json")));
});

/** @param {string[]} args @param {string} cwd */
function git(args, cwd) {
  execFileSync("git", args, { cwd, stdio: "ignore" });
}

/** @param {string} cwd */
function gitRoot(cwd) {
  return execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd, encoding: "utf8" }).trim();
}

test("manifest capability matches explicit CLI surfaces", async () => {
  const manifest = JSON.parse(await readFile(".codex-plugin/plugin.json", "utf8"));
  const help = execFileSync(process.execPath, ["bin/loop.js", "--help"], { encoding: "utf8" });

  assert.equal(manifest.interface.capabilities.includes("Write"), false);
  assert.match(help, /--dry-run/);
  assert.match(help, /loop run --agent codex/);
  assert.match(help, /loop run --agent claudecode/);
  assert.match(help, /asks clarifying questions/);
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
      "run",
      "--agent",
      "codex",
      "--no-interview",
      "--state-dir",
      stateDir,
      "Build a darkwear luxury website MVP"
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
  assert.deepEqual(codexArgs.slice(0, 3), ["--ask-for-approval", "never", "exec"]);
  assert.ok(codexArgs.includes("--sandbox"));
  assert.ok(codexArgs.includes("workspace-write"));
  assert.match(output.wikiPaths.notePath, /wiki\/user/);
});

test("CLI run initializes a local git repo when none exists", async () => {
  const repo = await mkdtemp(join(tmpdir(), "loop-agent-non-git-"));
  const fakeBin = await mkdtemp(join(tmpdir(), "loop-fake-bin-"));
  const stateDir = join(repo, ".loop");
  const fakeCodex = join(fakeBin, "codex");
  await writeFile(fakeCodex, [
    "#!/usr/bin/env node",
    "import { writeFileSync } from 'node:fs';",
    "writeFileSync('codex-args.json', JSON.stringify(process.argv.slice(2), null, 2));"
  ].join("\n"));
  await chmod(fakeCodex, 0o755);

  const result = spawnSync(
    process.execPath,
    [
      resolve("bin/loop.js"),
      "run",
      "--agent",
      "codex",
      "--no-interview",
      "--state-dir",
      stateDir,
      "Build a darkwear luxury website MVP"
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

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /initialized a local git repository/);
  assert.equal(gitRoot(repo), realpathSync(repo));
  assert.equal(output.agent, "codex");
  assert.equal(state.phase, "verify");
});

test("CLI run creates a nested project boundary instead of using a parent repo", async () => {
  const parent = await mkdtemp(join(tmpdir(), "loop-parent-repo-"));
  const repo = join(parent, "darkwear");
  const fakeBin = await mkdtemp(join(tmpdir(), "loop-fake-bin-"));
  const stateDir = join(repo, ".loop");
  const fakeCodex = join(fakeBin, "codex");
  await mkdir(repo);
  await writeFile(fakeCodex, [
    "#!/usr/bin/env node",
    "import { writeFileSync } from 'node:fs';",
    "writeFileSync('codex-args.json', JSON.stringify(process.argv.slice(2), null, 2));"
  ].join("\n"));
  await chmod(fakeCodex, 0o755);
  git(["init", "-b", "main"], parent);

  const result = spawnSync(
    process.execPath,
    [
      resolve("bin/loop.js"),
      "run",
      "--agent",
      "codex",
      "--no-interview",
      "--state-dir",
      stateDir,
      "Build a darkwear luxury website MVP"
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

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /initialized a local git repository/);
  assert.equal(gitRoot(repo), realpathSync(repo));
  assert.notEqual(gitRoot(repo), realpathSync(parent));
  assert.equal(output.agent, "codex");
});

test("CLI prompt defaults to run mode when an agent is explicit", async () => {
  const repo = await mkdtemp(join(tmpdir(), "loop-default-run-repo-"));
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
      "--no-interview",
      "--state-dir",
      stateDir,
      "Build a darkwear luxury website MVP"
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

  assert.equal(result.status, 0, result.stderr);
  assert.equal(output.agent, "codex");
  assert.match(output.wikiPaths.notePath, /wiki\/user/);
});

test("CLI run policy failure keeps exit 3 and skips wiki", async () => {
  const repo = await mkdtemp(join(tmpdir(), "loop-policy-fail-repo-"));
  const stateDir = join(repo, ".loop");
  git(["init", "-b", "main"], repo);

  const result = spawnSync(
    process.execPath,
    [
      resolve("bin/loop.js"),
      "run",
      "--agent",
      "codex",
      "--no-interview",
      "--state-dir",
      stateDir,
      "--expected-root",
      join(repo, "elsewhere"),
      "Build a darkwear luxury website MVP"
    ],
    { cwd: repo, encoding: "utf8" }
  );

  assert.equal(result.status, 3);
  assert.match(result.stderr, /Policy gate failed:/);
  await assert.rejects(() => readdir(join(stateDir, "wiki")), /ENOENT/);
});

test("CLI run stops before agent when initial wiki write fails", async () => {
  const repo = await mkdtemp(join(tmpdir(), "loop-initial-wiki-fail-repo-"));
  const fakeBin = await mkdtemp(join(tmpdir(), "loop-fake-bin-"));
  const stateDir = join(repo, ".loop");
  const fakeCodex = join(fakeBin, "codex");
  await writeFile(fakeCodex, [
    "#!/usr/bin/env node",
    "import { writeFileSync } from 'node:fs';",
    "writeFileSync('agent-ran', 'yes');"
  ].join("\n"));
  await chmod(fakeCodex, 0o755);
  git(["init", "-b", "main"], repo);
  await mkdir(stateDir);
  await writeFile(join(stateDir, "wiki"), "occupied");

  const result = spawnSync(
    process.execPath,
    [
      resolve("bin/loop.js"),
      "run",
      "--agent",
      "codex",
      "--no-interview",
      "--state-dir",
      stateDir,
      "Build a darkwear luxury website MVP"
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

  assert.equal(result.status, 6);
  assert.match(result.stderr, /Wiki write failed after durable state write/);
  await assert.rejects(() => readFile(join(repo, "agent-ran"), "utf8"), /ENOENT/);
});

test("CLI run reports final wiki failure after agent output", async () => {
  const repo = await mkdtemp(join(tmpdir(), "loop-final-wiki-fail-repo-"));
  const fakeBin = await mkdtemp(join(tmpdir(), "loop-fake-bin-"));
  const stateDir = join(repo, ".loop");
  const fakeCodex = join(fakeBin, "codex");
  await writeFile(fakeCodex, [
    "#!/usr/bin/env node",
    "import { rmSync, writeFileSync } from 'node:fs';",
    "console.log('agent completed');",
    "rmSync('.loop/wiki', { recursive: true, force: true });",
    "writeFileSync('.loop/wiki', 'occupied');"
  ].join("\n"));
  await chmod(fakeCodex, 0o755);
  git(["init", "-b", "main"], repo);

  const result = spawnSync(
    process.execPath,
    [
      resolve("bin/loop.js"),
      "run",
      "--agent",
      "codex",
      "--no-interview",
      "--state-dir",
      stateDir,
      "Build a darkwear luxury website MVP"
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
  const runFiles = await readdir(join(stateDir, "runs"));
  await rm(join(stateDir, "wiki"), { force: true });

  assert.equal(result.status, 6);
  assert.match(result.stdout, /agent completed/);
  assert.match(result.stderr, /Wiki write failed after durable state write/);
  assert.ok(runFiles.some((file) => file.endsWith(".json")));
});

test("CLI Claude Code agent mode invokes claude print adapter", async () => {
  const repo = await mkdtemp(join(tmpdir(), "loop-claude-agent-repo-"));
  const fakeBin = await mkdtemp(join(tmpdir(), "loop-fake-claude-bin-"));
  const stateDir = join(repo, ".loop");
  const fakeClaude = join(fakeBin, "claude");
  await writeFile(fakeClaude, [
    "#!/usr/bin/env node",
    "import { writeFileSync } from 'node:fs';",
    "writeFileSync('claude-args.json', JSON.stringify(process.argv.slice(2), null, 2));"
  ].join("\n"));
  await chmod(fakeClaude, 0o755);
  git(["init", "-b", "main"], repo);

  const result = spawnSync(
    process.execPath,
    [
      resolve("bin/loop.js"),
      "run",
      "--agent",
      "claudecode",
      "--no-interview",
      "--state-dir",
      stateDir,
      "Build a darkwear luxury website MVP"
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
  const claudeArgs = JSON.parse(await readFile(join(repo, "claude-args.json"), "utf8"));

  assert.equal(result.status, 0);
  assert.equal(output.agent, "claudecode");
  assert.equal(state.phase, "verify");
  assert.equal(state.verificationEvidence.at(-1).status, "passed");
  assert.deepEqual(claudeArgs.slice(0, 3), ["--print", "--permission-mode", "acceptEdits"]);
});

test("CLI run requires explicit agent in non-interactive mode", () => {
  const result = spawnSync(
    process.execPath,
    [resolve("bin/loop.js"), "run", "--no-interview", "Build a darkwear luxury website MVP"],
    { encoding: "utf8" }
  );

  assert.equal(result.status, 1);
  assert.match(result.stderr, /requires --agent codex or --agent claudecode/);
});

test("CLI run requires interview for ambiguous non-interactive objectives", () => {
  const result = spawnSync(
    process.execPath,
    [resolve("bin/loop.js"), "run", "--agent", "codex", "do it"],
    { encoding: "utf8" }
  );

  assert.equal(result.status, 1);
  assert.match(result.stderr, /ambiguous loop objective requires an interactive terminal/);
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
