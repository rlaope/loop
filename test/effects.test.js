import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  agentCommand,
  codexCommandSpecFromOpenEffect,
  codexResumeCommand,
  codexResumeCommandSpec,
  codexSessionIdFromLog,
  commandInCwd,
  followLogCommand,
  loopNotificationPayload,
  loopRunCommand,
  notificationCommand,
  openTarget,
  scriptPathFromImportMetaUrl,
  sendLoopNotification,
  shouldSendLoopNotification,
  shellCommand,
  shellQuote,
  terminalCommandDisplay,
  startDetachedWikiDashboard,
  terminalLaunchCommand
} from "../src/index.js";

test("agent command builds current Codex exec argument order", () => {
  const command = agentCommand("codex", "do work", true, { cwd: "/tmp/project" });

  assert.equal(command.command, "codex");
  assert.deepEqual(command.args.slice(0, 2), ["exec", "--sandbox"]);
  assert.ok(command.args.includes("workspace-write"));
  assert.ok(command.args.includes("--cd"));
  assert.equal(command.args.at(-1), "do work");
  assert.doesNotMatch(command.displayArgs.join(" "), /--ask-for-approval/);
});

test("agent command builds Claude Code print command", () => {
  const command = agentCommand("claudecode", "inspect only", false);

  assert.equal(command.command, "claude");
  assert.deepEqual(command.args, ["--print", "--permission-mode", "plan", "inspect only"]);
});

test("open target preserves the test log hook without launching", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "loop-open-target-"));
  const logPath = join(stateDir, "opened.log");

  const result = openTarget("http://127.0.0.1:3846", {
    env: { LOOP_OPEN_TARGET_LOG: logPath },
    stdoutTTY: true
  });
  const log = await readFile(logPath, "utf8");

  assert.equal(result.recorded, true);
  assert.equal(log.trim(), "http://127.0.0.1:3846");
});

test("desktop notifications build platform-specific commands", () => {
  const darwin = notificationCommand({
    platform: "darwin",
    title: "Loop",
    subtitle: "Darkwear",
    message: "Agent started"
  });
  const win32 = notificationCommand({
    platform: "win32",
    title: "Loop",
    subtitle: "Darkwear",
    message: "Agent started"
  });
  const linux = notificationCommand({
    platform: "linux",
    title: "Loop",
    subtitle: "Darkwear",
    message: "Agent started"
  });

  assert.equal(darwin?.command, "osascript");
  assert.match(darwin?.args.join(" "), /display notification/);
  assert.equal(win32?.command, "powershell.exe");
  assert.match(win32?.args.join(" "), /NotifyIcon/);
  assert.equal(linux?.command, "notify-send");
  assert.deepEqual(linux?.args.slice(0, 2), ["--app-name", "Loop"]);
});

test("desktop notification commands keep hostile text quoted or argument-bound", () => {
  const hostile = "Loop \"quote\" \\ $(rm -rf .); `tick`; 'single'\nnext";
  const darwin = notificationCommand({
    platform: "darwin",
    title: hostile,
    subtitle: hostile,
    message: hostile
  });
  const win32 = notificationCommand({
    platform: "win32",
    title: hostile,
    subtitle: hostile,
    message: hostile
  });
  const linux = notificationCommand({
    platform: "linux",
    title: hostile,
    subtitle: hostile,
    message: hostile
  });
  const darwinExpression = darwin?.args.at(-1) ?? "";
  const winScript = win32?.args.at(-1) ?? "";

  assert.match(darwinExpression, /\\"quote\\"/);
  assert.match(darwinExpression, /\\\\ \$\(rm -rf \.\)/);
  assert.match(winScript, /''single''/);
  assert.match(winScript, /\$\(rm -rf \.\)/);
  assert.equal(linux?.args[2], hostile.replace(/\s+/g, " ").trim());
  assert.equal(linux?.args[3], `${hostile.replace(/\s+/g, " ").trim()}\n${hostile.replace(/\s+/g, " ").trim()}`);
});

test("loop notification payload and gate are shared outside the CLI", () => {
  assert.equal(shouldSendLoopNotification({
    enabled: true,
    env: {},
    stdoutTTY: false,
    stderrTTY: false
  }), false);
  assert.equal(shouldSendLoopNotification({
    enabled: true,
    env: { LOOP_FORCE_NOTIFICATIONS: "1" },
    stdoutTTY: false,
    stderrTTY: false
  }), true);
  assert.deepEqual(loopNotificationPayload("run-finished", {
    agent: "codex",
    objective: "Build dashboard",
    runId: "run-1",
    exitCode: 0
  }), {
    title: "Loop needs review",
    message: "codex finished. Review changes, verification evidence, and dashboard.",
    subtitle: "Build dashboard",
    runId: "run-1",
    objective: "Build dashboard"
  });
});

test("desktop notifications support disable and log hooks", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "loop-notify-"));
  const logPath = join(stateDir, "notifications.jsonl");
  const disabled = sendLoopNotification({
    title: "Loop started",
    message: "codex is running"
  }, {
    env: { LOOP_DISABLE_NOTIFICATIONS: "1" }
  });
  const recorded = sendLoopNotification({
    title: "Loop needs review",
    message: "codex finished",
    runId: "run-1",
    objective: "Build dashboard"
  }, {
    env: { LOOP_NOTIFICATION_LOG: logPath }
  });
  const log = await readFile(logPath, "utf8");
  const event = JSON.parse(log.trim());

  assert.equal(disabled.skipped, true);
  assert.equal(recorded.recorded, true);
  assert.equal(event.title, "Loop needs review");
  assert.equal(event.runId, "run-1");
  assert.equal(event.objective, "Build dashboard");
});

test("terminal launcher builds shell and Codex resume commands", () => {
  const state = {
    session: {
      agent: "codex",
      cwd: "/tmp/project with spaces"
    }
  };
  const log = "hello\nsession id: 019ec4bd-7118-7443-8d6b-dce6b226eef3\n";

  assert.equal(shellQuote("simple/path"), "simple/path");
  assert.equal(shellQuote("has space"), "'has space'");
  assert.equal(shellCommand(["codex", "exec", "hello"]), "codex exec hello");
  assert.equal(commandInCwd("/tmp/project", "codex exec hello"), "cd /tmp/project && codex exec hello");
  assert.equal(followLogCommand("run-1", ".loop"), "loop logs run-1 --follow");
  assert.equal(codexSessionIdFromLog(log), "019ec4bd-7118-7443-8d6b-dce6b226eef3");
  assert.equal(
    codexResumeCommand(state, log),
    "cd '/tmp/project with spaces' && codex resume --include-non-interactive 019ec4bd-7118-7443-8d6b-dce6b226eef3"
  );
  assert.deepEqual(codexResumeCommandSpec(state, log), {
    command: "codex",
    args: ["resume", "--include-non-interactive", "019ec4bd-7118-7443-8d6b-dce6b226eef3"],
    cwd: "/tmp/project with spaces"
  });
  assert.equal(codexResumeCommand(state, "no session here"), null);
  assert.equal(
    terminalCommandDisplay({
      command: "codex",
      args: ["resume", "--include-non-interactive", "019ec4bd-7118-7443-8d6b-dce6b226eef3"],
      cwd: "/tmp/project with spaces"
    }),
    "cd '/tmp/project with spaces' && codex resume --include-non-interactive 019ec4bd-7118-7443-8d6b-dce6b226eef3"
  );
  assert.deepEqual(
    codexCommandSpecFromOpenEffect({
      type: "open-codex-terminal",
      sessionId: "019ec4bd-7118-7443-8d6b-dce6b226eef3",
      cwd: "/tmp/project with spaces"
    }),
    {
      command: "codex",
      args: ["resume", "--include-non-interactive", "019ec4bd-7118-7443-8d6b-dce6b226eef3"],
      cwd: "/tmp/project with spaces"
    }
  );
  assert.equal(codexCommandSpecFromOpenEffect({ type: "open-codex-terminal", cwd: "/tmp/project" }), null);
  assert.equal(
    loopRunCommand({
      agent: "codex",
      prompt: "Continue work",
      stateDir: "/tmp/project/.loop",
      parentRunId: "run-1",
      lineageSource: "tui"
    }),
    "loop run --agent codex --state-dir /tmp/project/.loop --parent-run run-1 --lineage-source tui 'Continue work'"
  );
});

test("terminal launcher builds platform-specific new-terminal commands", () => {
  const spec = {
    command: "codex",
    args: ["resume", "--include-non-interactive", "019ec4bd-7118-7443-8d6b-dce6b226eef3"],
    cwd: "/tmp/project with spaces"
  };
  const darwin = terminalLaunchCommand({ ...spec, platform: "darwin" });
  const win32 = terminalLaunchCommand({ ...spec, platform: "win32" });
  const linux = terminalLaunchCommand({ ...spec, platform: "linux" });

  assert.equal(darwin.command, "osascript");
  assert.match(darwin.args.join(" "), /Terminal/);
  assert.equal(win32.command, "cmd");
  assert.deepEqual(win32.args.slice(0, 7), ["/c", "start", "", "/D", "/tmp/project with spaces", "cmd", "/k"]);
  assert.deepEqual(win32.args.slice(7), ["codex", "resume", "--include-non-interactive", "019ec4bd-7118-7443-8d6b-dce6b226eef3"]);
  assert.equal(linux.command, "sh");
  assert.match(linux.args.join(" "), /x-terminal-emulator|gnome-terminal/);
});

test("terminal launcher does not collapse Windows cwd into the command string", () => {
  const cwd = "C:\\work dir & whoami";
  const win32 = terminalLaunchCommand({
    command: "codex",
    args: ["resume", "--include-non-interactive", "019ec4bd-7118-7443-8d6b-dce6b226eef3"],
    cwd,
    platform: "win32"
  });

  assert.equal(win32.command, "cmd");
  assert.equal(win32.args[4], cwd);
  assert.equal(win32.args[7], "codex");
  assert.notEqual(win32.args[7], `cd ${cwd}`);
});

test("dashboard process starter delegates to detached node process", () => {
  /** @type {{ command?: string, args?: string[], options?: import("node:child_process").SpawnOptions }} */
  const call = {};
  const spawnImpl = /** @type {typeof import("node:child_process").spawn} */ ((
    /** @type {string} */ command,
    /** @type {string[] | undefined} */ args,
    /** @type {import("node:child_process").SpawnOptions | undefined} */ options
  ) => {
    call.command = command;
    call.args = Array.isArray(args) ? args.map(String) : [];
    call.options = options;
    return /** @type {import("node:child_process").ChildProcess} */ ({
      pid: 4321,
      unref() {}
    });
  });

  const pid = startDetachedWikiDashboard({
    scriptPath: "/tmp/loop/bin/loop.js",
    stateDir: "/tmp/project/.loop",
    port: 3999,
    spawnImpl
  });

  assert.equal(pid, 4321);
  assert.equal(call.command, process.execPath);
  assert.deepEqual(call.args?.slice(0, 3), ["/tmp/loop/bin/loop.js", "wiki", "serve"]);
  assert.ok(call.args?.includes("--state-dir"));
  assert.ok(call.args?.includes("3999"));
  assert.equal(call.options?.detached, true);
});

test("dashboard process script path decodes file URL escapes", () => {
  assert.equal(
    scriptPathFromImportMetaUrl("file:///tmp/loop%20install/bin/loop.js"),
    "/tmp/loop install/bin/loop.js"
  );
});
