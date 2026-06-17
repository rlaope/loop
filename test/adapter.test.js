import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { createServer as createNetServer } from "node:net";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

const testRegistryRoot = await mkdtemp(join(tmpdir(), "loop-adapter-registry-"));
process.env.LOOP_PROJECT_REGISTRY = join(testRegistryRoot, "projects.json");

/** @param {string} command */
function commandExists(command) {
  const result = spawnSync(command, ["--version"], { encoding: "utf8" });
  return !(result.error && "code" in result.error && result.error.code === "ENOENT");
}

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
  assert.match(skill, /\$Loop/);
  for (const component of ["Automations", "Worktrees", "Skills", "Plugins/connectors", "Sub-agents", "Memory"]) {
    assert.match(skill, new RegExp(component.replace("/", "\\/")));
  }
});

test("Codex can install the Loop plugin and render $Loop skill context", {
  skip: commandExists("codex") ? false : "codex CLI is not installed"
}, async () => {
  const root = await mkdtemp(join(tmpdir(), "loop-codex-plugin-"));
  const codexHome = join(root, "codex-home");
  const marketplace = join(root, "marketplace");
  const pluginRoot = join(marketplace, "plugins", "loop");
  await mkdir(join(marketplace, ".agents", "plugins"), { recursive: true });
  await mkdir(join(pluginRoot, ".codex-plugin"), { recursive: true });
  await mkdir(join(pluginRoot, "skills", "loop"), { recursive: true });
  await mkdir(codexHome, { recursive: true });
  await writeFile(
    join(pluginRoot, ".codex-plugin", "plugin.json"),
    await readFile(".codex-plugin/plugin.json", "utf8")
  );
  await writeFile(
    join(pluginRoot, "skills", "loop", "SKILL.md"),
    await readFile("skills/loop/SKILL.md", "utf8")
  );
  await writeFile(join(marketplace, ".agents", "plugins", "marketplace.json"), `${JSON.stringify({
    name: "loop-local-test",
    interface: { displayName: "Loop local test" },
    plugins: [{
      name: "loop",
      source: { source: "local", path: "./plugins/loop" },
      policy: { installation: "AVAILABLE", authentication: "ON_INSTALL" },
      category: "Productivity"
    }]
  }, null, 2)}\n`);
  const env = { ...process.env, CODEX_HOME: codexHome };

  const addMarketplace = spawnSync("codex", ["plugin", "marketplace", "add", marketplace], {
    env,
    encoding: "utf8"
  });
  assert.equal(addMarketplace.status, 0, addMarketplace.stderr || addMarketplace.stdout);
  const addPlugin = spawnSync("codex", ["plugin", "add", "loop@loop-local-test"], {
    env,
    encoding: "utf8"
  });
  assert.equal(addPlugin.status, 0, addPlugin.stderr || addPlugin.stdout);
  const pluginList = execFileSync("codex", ["plugin", "list"], { env, encoding: "utf8" });
  const promptInput = execFileSync(
    "codex",
    ["debug", "prompt-input", "$Loop 현재 대시보드 품질 루프를 검증해줘"],
    { env, encoding: "utf8" }
  );

  assert.match(pluginList, /loop@loop-local-test\s+installed, enabled/);
  assert.match(promptInput, /loop:loop/);
  assert.match(promptInput, /Available plugins/);
  assert.match(promptInput, /`Loop`/);
  assert.match(promptInput, /\$Loop 현재 대시보드 품질 루프를 검증해줘/);
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
  assert.doesNotMatch(read, /## Token Usage/);
  assert.doesNotMatch(read, /## Related Notes/);
});

test("CLI wiki add attaches supporting notes to a loop run", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "loop-cli-wiki-add-state-"));
  const output = execFileSync(
    process.execPath,
    ["bin/loop.js", "--dry-run", "--objective", "Wiki add maintenance", "--state-dir", stateDir],
    { encoding: "utf8" }
  );
  const parsed = JSON.parse(output);
  const add = execFileSync(
    process.execPath,
    [
      "bin/loop.js",
      "wiki",
      "add",
      "--state-dir",
      stateDir,
      "--run",
      parsed.stateId,
      "--kind",
      "idea",
      "--title",
      "Alternate exhibit path",
      "--body",
      "Try a founder-curated rail beside the product grid."
    ],
    { encoding: "utf8" }
  );
  const addedId = /Added wiki idea note ([^\n]+)/.exec(add)?.[1];
  const list = execFileSync(
    process.execPath,
    ["bin/loop.js", "wiki", "list", "--state-dir", stateDir],
    { encoding: "utf8" }
  );
  const read = execFileSync(
    process.execPath,
    ["bin/loop.js", "wiki", "read", String(addedId), "--state-dir", stateDir],
    { encoding: "utf8" }
  );

  assert.ok(addedId);
  assert.match(list, /Alternate exhibit path/);
  assert.match(list, /\| idea \|/);
  assert.match(read, /# Alternate exhibit path/);
  assert.match(read, /- Type: idea/);
  assert.match(read, /- Parent loop: Wiki add maintenance/);
});

test("CLI wiki obsidian status is read-only before init", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "loop-cli-obsidian-status-"));
  const output = execFileSync(
    process.execPath,
    ["bin/loop.js", "wiki", "obsidian", "status", "--state-dir", stateDir],
    { encoding: "utf8" }
  );

  assert.match(output, /Obsidian sync: not configured/);
  assert.equal(existsSync(join(stateDir, "obsidian-sync.json")), false);
  assert.equal(existsSync(join(stateDir, "obsidian-sync-manifest.json")), false);
});

test("CLI wiki obsidian init and sync mirror wiki markdown", async () => {
  const root = await mkdtemp(join(tmpdir(), "loop-cli-obsidian-sync-"));
  const project = join(root, "feedback-project");
  const stateDir = join(project, ".loop");
  const vault = join(root, "Vault");
  const loopBin = resolve("bin/loop.js");
  await mkdir(project, { recursive: true });
  await mkdir(join(vault, ".obsidian"), { recursive: true });
  const dryRun = execFileSync(
    process.execPath,
    [loopBin, "--dry-run", "--objective", "Obsidian CLI sync", "--state-dir", stateDir],
    { cwd: project, encoding: "utf8" }
  );
  const parsed = JSON.parse(dryRun);
  const init = execFileSync(
    process.execPath,
    [loopBin, "wiki", "obsidian", "init", "--state-dir", stateDir, "--vault", vault],
    { cwd: project, encoding: "utf8" }
  );
  const sync = execFileSync(
    process.execPath,
    [loopBin, "wiki", "obsidian", "sync", "--state-dir", stateDir],
    { cwd: project, encoding: "utf8" }
  );
  const manifest = JSON.parse(await readFile(join(stateDir, "obsidian-sync-manifest.json"), "utf8"));
  const note = manifest.notes[parsed.wikiPaths.id];
  const mirrored = await readFile(join(vault, note.obsidianRelativePath), "utf8");

  assert.match(init, /Obsidian sync configured/);
  assert.match(init, /feedback-project-[a-f0-9]{12}/);
  assert.match(sync, /Obsidian sync complete/);
  assert.match(sync, /Loop to Obsidian: 1/);
  assert.match(mirrored, /# Obsidian CLI sync/);
});

test("CLI wiki obsidian expected failures avoid uncaught stack traces", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "loop-cli-obsidian-fail-"));
  const result = spawnSync(
    process.execPath,
    ["bin/loop.js", "wiki", "obsidian", "sync", "--state-dir", stateDir],
    { encoding: "utf8" }
  );

  assert.equal(result.status, 1);
  assert.match(result.stderr, /Obsidian sync failed: Obsidian sync is not configured/);
  assert.doesNotMatch(result.stderr, /at async|Error:/);
  assert.equal(result.stdout, "");
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

async function getFreePort() {
  const server = createNetServer();
  server.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Expected TCP server to listen on an address object");
  }
  const { port } = address;
  await new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve(undefined);
    });
  });
  return port;
}

/**
 * @param {number} port
 * @returns {Promise<import("node:child_process").ChildProcess>}
 */
async function startExternalDashboard(port) {
  const code = [
    "import { createServer } from 'node:http';",
    "const port = Number(process.argv[1]);",
    "const server = createServer((request, response) => {",
    "  if (request.url === '/health') {",
    "    response.writeHead(200, { 'content-type': 'application/json' });",
    "    response.end(JSON.stringify({ ok: true, name: 'loop-wiki', mode: 'global' }) + '\\n');",
    "    return;",
    "  }",
    "  response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });",
    "  response.end('<!doctype html><title>Loop Wiki</title>');",
    "});",
    "server.listen(port, '127.0.0.1', () => process.stdout.write('ready\\n'));",
    "process.on('SIGTERM', () => server.close(() => process.exit(0)));"
  ].join("\n");
  const child = spawn(process.execPath, ["--input-type=module", "-e", code, String(port)], {
    stdio: ["ignore", "pipe", "pipe"]
  });
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  let stderr = "";
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error(`dashboard test server did not start: ${stderr}`));
    }, 1500);
    const cleanup = () => {
      clearTimeout(timeout);
      child.stdout.off("data", onStdout);
      child.stderr.off("data", onStderr);
      child.off("exit", onExit);
    };
    /** @param {string} chunk */
    const onStdout = (chunk) => {
      if (chunk.includes("ready")) {
        cleanup();
        resolve(undefined);
      }
    };
    /** @param {string} chunk */
    const onStderr = (chunk) => {
      stderr += chunk;
    };
    /** @param {number | null} code */
    const onExit = (code) => {
      cleanup();
      reject(new Error(`dashboard test server exited before ready: ${code}; ${stderr}`));
    };
    child.stdout.on("data", onStdout);
    child.stderr.on("data", onStderr);
    child.once("exit", onExit);
  });
  return child;
}

/** @param {import("node:child_process").ChildProcess} child */
async function stopExternalProcess(child) {
  if (child.exitCode !== null) {
    return;
  }
  child.kill("SIGTERM");
  await new Promise((resolve) => child.once("exit", resolve));
}

test("manifest capability matches explicit CLI surfaces", async () => {
  const manifest = JSON.parse(await readFile(".codex-plugin/plugin.json", "utf8"));
  const help = execFileSync(process.execPath, ["bin/loop.js", "--help"], { encoding: "utf8" });

  assert.equal(manifest.interface.capabilities.includes("Write"), false);
  assert.match(help, /--dry-run/);
  assert.match(help, /loop run --agent codex/);
  assert.match(help, /loop run --agent claudecode/);
  assert.match(help, /loop doctor/);
  assert.match(help, /loop demo/);
  assert.match(help, /--no-notify/);
  assert.match(help, /--just-run/);
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

test("CLI doctor reports local readiness without requiring optional agents", async () => {
  const result = spawnSync(
    process.execPath,
    ["bin/loop.js", "doctor", "--expected-root", process.cwd()],
    { encoding: "utf8" }
  );

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /Loop Doctor/);
  assert.match(result.stdout, /Status: ready/);
  assert.match(result.stdout, /\[pass\] Node\.js runtime/);
  assert.match(result.stdout, /\[pass\] git CLI/);
  assert.match(result.stdout, /\[pass\] repo boundary/);
  assert.match(result.stdout, /Codex CLI/);
  assert.match(result.stdout, /Claude Code CLI/);
  assert.match(result.stdout, /npm run verify/);
});

test("CLI doctor fails explicit repo-boundary mismatches", async () => {
  const wrongRoot = await mkdtemp(join(tmpdir(), "loop-wrong-root-"));
  const result = spawnSync(
    process.execPath,
    ["bin/loop.js", "doctor", "--expected-root", wrongRoot],
    { encoding: "utf8" }
  );

  assert.equal(result.status, 1);
  assert.match(result.stdout, /Loop Doctor/);
  assert.match(result.stdout, /\[fail\] repo boundary/);
  assert.match(result.stdout, /git root mismatch/);
});

test("CLI demo prints workflows without writing local state", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "loop-demo-"));
  const result = spawnSync(
    process.execPath,
    [resolve("bin/loop.js"), "demo"],
    { cwd, encoding: "utf8" }
  );

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /Loop Demo/);
  assert.match(result.stdout, /Product quality loop/);
  assert.match(result.stdout, /real user can understand/i);
  assert.match(result.stdout, /loop doctor/);
  assert.match(result.stdout, /loop wiki/);
  assert.match(result.stdout, /loop --dry-run/);
  assert.equal(existsSync(join(cwd, ".loop")), false);
});

test("CLI accepts equals-style option values", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "loop-cli-equals-state-"));
  const output = execFileSync(
    process.execPath,
    [
      "bin/loop.js",
      "--dry-run",
      "--objective=Equals style objective",
      `--state-dir=${stateDir}`
    ],
    { encoding: "utf8" }
  );
  const parsed = JSON.parse(output);

  assert.equal(parsed.ok, true);
  assert.ok(parsed.paths.jsonPath.startsWith(stateDir));
  assert.ok(parsed.wikiPaths.memoryPath);
});

test("CLI wiki serve opens an already-running dashboard URL", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "loop-cli-wiki-open-state-"));
  const openLog = join(stateDir, "open-targets.log");
  const port = await getFreePort();
  const dashboard = await startExternalDashboard(port);

  try {
    const output = execFileSync(
      process.execPath,
      ["bin/loop.js", "wiki", "serve", "--state-dir", stateDir, "--port", String(port)],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          LOOP_OPEN_TARGET_LOG: openLog
        }
      }
    );
    const opened = await readFile(openLog, "utf8");

    assert.match(output, new RegExp(`Loop Wiki dashboard: http://127\\.0\\.0\\.1:${port}`));
    assert.equal(opened.trim(), `http://127.0.0.1:${port}`);
  } finally {
    await stopExternalProcess(dashboard);
  }
});

test("CLI rejects unknown and malformed options", () => {
  const unknown = spawnSync(
    process.execPath,
    ["bin/loop.js", "--dry-run", "--bogus", "--objective", "Unknown option objective"],
    { encoding: "utf8" }
  );
  const booleanValue = spawnSync(
    process.execPath,
    ["bin/loop.js", "--dry-run=true", "--objective", "Boolean value objective"],
    { encoding: "utf8" }
  );

  assert.equal(unknown.status, 1);
  assert.match(unknown.stderr, /Unknown option: --bogus/);
  assert.equal(unknown.stdout, "");
  assert.equal(booleanValue.status, 1);
  assert.match(booleanValue.stderr, /--dry-run does not take a value/);
  assert.equal(booleanValue.stdout, "");
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
  const notificationLog = join(repo, "notifications.jsonl");
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
        PATH: `${fakeBin}:${process.env.PATH ?? ""}`,
        LOOP_NOTIFICATION_LOG: notificationLog
      }
    }
  );
  const output = JSON.parse(result.stdout);
  const state = JSON.parse(await readFile(output.paths.jsonPath, "utf8"));
  const log = await readFile(join(stateDir, "runs", `${state.id}.log`), "utf8");
  const codexArgs = JSON.parse(await readFile(join(repo, "codex-args.json"), "utf8"));
  const notifications = (await readFile(notificationLog, "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));

  assert.equal(result.status, 0);
  assert.equal(output.agent, "codex");
  assert.equal(state.phase, "verify");
  assert.equal(state.session.agent, "codex");
  assert.equal(state.session.status, "exited");
  assert.equal(state.session.exitCode, 0);
  assert.match(result.stderr, /Loop agent session:/);
  assert.match(result.stderr, /loop logs --follow/);
  assert.match(log, /starting codex/);
  assert.deepEqual(notifications.map((event) => event.title), ["Loop started", "Loop needs review"]);
  assert.equal(notifications[0].runId, state.id);
  assert.equal(notifications[1].runId, state.id);
  assert.equal(state.approvals.humanApproval, true);
  assert.equal(state.verificationEvidence.at(-1).status, "passed");
  assert.deepEqual(codexArgs.slice(0, 2), ["exec", "--sandbox"]);
  assert.doesNotMatch(codexArgs.join(" "), /--ask-for-approval/);
  assert.ok(codexArgs.includes("--sandbox"));
  assert.ok(codexArgs.includes("workspace-write"));
  assert.match(output.wikiPaths.notePath, /wiki\/user/);
});

test("CLI follow-up run records parent lineage from prepared commands", async () => {
  const repo = await mkdtemp(join(tmpdir(), "loop-agent-followup-repo-"));
  const fakeBin = await mkdtemp(join(tmpdir(), "loop-fake-bin-"));
  const stateDir = join(repo, ".loop");
  const fakeCodex = join(fakeBin, "codex");
  await writeFile(fakeCodex, [
    "#!/usr/bin/env node",
    "console.log('follow-up agent done');"
  ].join("\n"));
  await chmod(fakeCodex, 0o755);
  git(["init", "-b", "main"], repo);

  const parentOutput = execFileSync(
    process.execPath,
    [
      resolve("bin/loop.js"),
      "--dry-run",
      "--objective",
      "Parent darkwear exhibit",
      "--state-dir",
      stateDir
    ],
    { cwd: repo, encoding: "utf8" }
  );
  const parent = JSON.parse(parentOutput);
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
      "--parent-run",
      parent.stateId,
      "--lineage-source",
      "dashboard",
      "Continue darkwear exhibit"
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
  const output = JSON.parse(result.stdout.slice(result.stdout.indexOf("{")));
  const state = JSON.parse(await readFile(output.paths.jsonPath, "utf8"));

  assert.equal(result.status, 0, result.stderr);
  assert.equal(state.lineage.parentRunId, parent.stateId);
  assert.equal(state.lineage.rootRunId, parent.stateId);
  assert.equal(state.lineage.createdFrom, "dashboard");
  assert.equal(state.lineage.relationship, "continues");
});

test("CLI --no-notify suppresses lifecycle notification dispatch", async () => {
  const repo = await mkdtemp(join(tmpdir(), "loop-agent-no-notify-repo-"));
  const fakeBin = await mkdtemp(join(tmpdir(), "loop-fake-bin-"));
  const stateDir = join(repo, ".loop");
  const notificationLog = join(repo, "notifications.jsonl");
  const fakeCodex = join(fakeBin, "codex");
  await writeFile(fakeCodex, [
    "#!/usr/bin/env node",
    "console.log('agent done');"
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
      "--no-notify",
      "--state-dir",
      stateDir,
      "Build a darkwear luxury website MVP"
    ],
    {
      cwd: repo,
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${fakeBin}:${process.env.PATH ?? ""}`,
        LOOP_NOTIFICATION_LOG: notificationLog
      }
    }
  );

  assert.equal(result.status, 0, result.stderr);
  assert.equal(existsSync(notificationLog), false);
});

test("CLI run opens an already-running dashboard URL", async () => {
  const repo = await mkdtemp(join(tmpdir(), "loop-run-open-dashboard-repo-"));
  const fakeBin = await mkdtemp(join(tmpdir(), "loop-fake-bin-"));
  const stateDir = join(repo, ".loop");
  const openLog = join(repo, "open-targets.log");
  const fakeCodex = join(fakeBin, "codex");
  const port = await getFreePort();
  await writeFile(fakeCodex, [
    "#!/usr/bin/env node",
    "import { writeFileSync } from 'node:fs';",
    "writeFileSync('codex-args.json', JSON.stringify(process.argv.slice(2), null, 2));"
  ].join("\n"));
  await chmod(fakeCodex, 0o755);
  git(["init", "-b", "main"], repo);
  const dashboard = await startExternalDashboard(port);

  try {
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
        "--port",
        String(port),
        "Build a darkwear luxury website MVP"
      ],
      {
        cwd: repo,
        encoding: "utf8",
        env: {
          ...process.env,
          PATH: `${fakeBin}:${process.env.PATH ?? ""}`,
          LOOP_OPEN_TARGET_LOG: openLog
        }
      }
    );
    const output = JSON.parse(result.stdout);
    const opened = await readFile(openLog, "utf8");

    assert.equal(result.status, 0, result.stderr);
    assert.equal(output.agent, "codex");
    assert.equal(opened.trim(), `http://127.0.0.1:${port}`);
  } finally {
    await stopExternalProcess(dashboard);
  }
});

test("CLI exposes run status, run list, and logs", async () => {
  const repo = await mkdtemp(join(tmpdir(), "loop-observe-repo-"));
  const fakeBin = await mkdtemp(join(tmpdir(), "loop-fake-bin-"));
  const stateDir = join(repo, ".loop");
  const fakeCodex = join(fakeBin, "codex");
  await writeFile(fakeCodex, [
    "#!/usr/bin/env node",
    "console.log('agent streamed line');"
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
  const jsonStart = result.stdout.indexOf("{");
  const output = JSON.parse(result.stdout.slice(jsonStart));
  const status = execFileSync(process.execPath, [resolve("bin/loop.js"), "status", "--state-dir", stateDir], {
    cwd: repo,
    encoding: "utf8"
  });
  const runs = execFileSync(process.execPath, [resolve("bin/loop.js"), "runs", "--state-dir", stateDir], {
    cwd: repo,
    encoding: "utf8"
  });
  const logs = execFileSync(process.execPath, [resolve("bin/loop.js"), "logs", output.stateId, "--state-dir", stateDir], {
    cwd: repo,
    encoding: "utf8"
  });
  const follow = spawnSync(
    process.execPath,
    [resolve("bin/loop.js"), "logs", output.stateId, "--follow", "--state-dir", stateDir],
    {
      cwd: repo,
      encoding: "utf8",
      timeout: 700
    }
  );

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /agent streamed line/);
  assert.match(status, /No agent process is currently running/);
  assert.match(status, new RegExp(output.stateId));
  assert.match(runs, /codex exited \(0\)/);
  assert.match(logs, /agent streamed line/);
  assert.equal(follow.error && "code" in follow.error ? follow.error.code : undefined, "ETIMEDOUT");
  assert.notEqual(follow.status, 13);
  assert.match(follow.stdout, /agent streamed line/);
  assert.doesNotMatch(follow.stderr, /unsettled top-level await/);
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

test("CLI run refuses write-capable agents from the home directory", async () => {
  const repo = await mkdtemp(join(tmpdir(), "loop-home-guard-"));
  const fakeBin = await mkdtemp(join(tmpdir(), "loop-fake-bin-"));
  const stateDir = join(repo, ".loop");
  const fakeCodex = join(fakeBin, "codex");
  await writeFile(fakeCodex, [
    "#!/usr/bin/env node",
    "throw new Error('codex should not start from home directory');"
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
        HOME: repo,
        PATH: `${fakeBin}:${process.env.PATH ?? ""}`
      }
    }
  );

  assert.equal(result.status, 2);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /refuses to run write-capable agents from your home directory/);
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
      "--agent=codex",
      "--no-interview",
      `--state-dir=${stateDir}`,
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
  const notificationLog = join(repo, "notifications.jsonl");
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
    {
      cwd: repo,
      encoding: "utf8",
      env: {
        ...process.env,
        LOOP_NOTIFICATION_LOG: notificationLog
      }
    }
  );
  const notifications = (await readFile(notificationLog, "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));

  assert.equal(result.status, 3);
  assert.match(result.stderr, /Policy gate failed:/);
  assert.equal(notifications[0].title, "Loop needs attention");
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
