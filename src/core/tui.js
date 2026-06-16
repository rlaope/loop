import { createInterface } from "node:readline/promises";

import {
  addWikiNoteAction,
  createActionConfirmation,
  listRunsAction,
  listWikiNotesAction,
  markCompleteAction,
  markVerificationAction,
  prepareCodexOpenAction,
  prepareFollowUpRunAction,
  readGraphAction,
  readRunLogTailAction
} from "./actions.js";
import { dashboardUrl, getDashboardStatus, serveWikiDashboard } from "./wiki-dashboard.js";
import { openTarget } from "./open-target.js";
import {
  codexCommandFromOpenEffect,
  codexCommandSpecFromOpenEffect,
  launchTerminalCommand,
  loopRunCommand
} from "./terminal-launcher.js";
import {
  colorize,
  normalizeTuiAction,
  renderTuiHome,
  renderTuiLogo,
  renderTuiProcessing,
  shouldUseTuiColor,
  TUI_PROMPT_COLOR
} from "./tui-render.js";

export { renderTuiHome, renderTuiProcessing } from "./tui-render.js";

/**
 * @param {{ argCount: number, stdinTTY: boolean, stdoutTTY: boolean }} input
 */
export function noArgTuiDispatch({ argCount, stdinTTY, stdoutTTY }) {
  if (argCount !== 0) {
    return "continue-cli";
  }
  return stdinTTY && stdoutTTY ? "open-tui" : "non-interactive-guidance";
}

/**
 * @param {{ hasCommand: boolean, stdinTTY: boolean, stdoutTTY: boolean, justRun?: boolean }} input
 */
export function directPromptTuiDispatch({ hasCommand, stdinTTY, stdoutTTY, justRun = false }) {
  if (!justRun && !hasCommand && stdinTTY && stdoutTTY) {
    return "processing-tui";
  }
  return "standard-run";
}

/**
 * @param {{ stateDir?: string, selectedRunId?: string | null, agent?: "codex" | "claudecode", getDashboardStatusImpl?: typeof getDashboardStatus }} [options]
 */
async function loadSnapshot({
  stateDir = ".loop",
  selectedRunId = null,
  agent = "codex",
  getDashboardStatusImpl = getDashboardStatus
} = {}) {
  const dashboardProbe = getDashboardStatusImpl({ timeoutMs: 80 })
    .then((status) => {
      if (!status.running && status.occupied) {
        return { running: false, occupied: false, unknown: true };
      }
      return { ...status, unknown: false };
    })
    .catch(() => ({ running: false, occupied: false, unknown: true }));
  const [runs, notes, graph, dashboardStatus] = await Promise.all([
    listRunsAction({ stateDir }),
    listWikiNotesAction({ stateDir }),
    readGraphAction({ stateDir }),
    dashboardProbe
  ]);
  const runList = runs.runs;
  const selected = runList.find((run) => run.id === selectedRunId) ?? runList[0] ?? null;
  return {
    stateDir,
    agent,
    runs: runList,
    notes: notes.notes,
    graph: graph.graph,
    dashboard: {
      ...dashboardStatus,
      url: dashboardUrl()
    },
    notice: "",
    selectedRunId: selected?.id ?? null,
    selectedRun: selected
  };
}

/**
 * @param {NodeJS.WritableStream} output
 * @param {string} message
 */
function writeStatus(output, message) {
  output.write(`\n${message}\n`);
}

/**
 * @param {{ ok: boolean, error?: { message?: string, kind?: string } }} result
 * @param {string} successMessage
 */
function actionStatus(result, successMessage) {
  if (result.ok) {
    return successMessage;
  }
  return `Action failed: ${result.error?.message ?? result.error?.kind ?? "unknown error"}`;
}

/** @param {NodeJS.WritableStream} output */
function terminalWidth(output) {
  const columns = /** @type {{ columns?: unknown }} */ (output).columns;
  return typeof columns === "number" ? columns : undefined;
}

/**
 * @param {{
 *   stateDir?: string,
 *   input?: NodeJS.ReadableStream & { isTTY?: boolean },
 *   output?: NodeJS.WritableStream & { isTTY?: boolean },
 *   once?: boolean,
 *   clearScreen?: boolean,
 *   env?: NodeJS.ProcessEnv,
 *   openTargetImpl?: typeof openTarget,
 *   launchTerminalCommandImpl?: typeof launchTerminalCommand,
 *   serveWikiDashboardImpl?: typeof serveWikiDashboard,
 *   getDashboardStatusImpl?: typeof getDashboardStatus,
 *   initialSelectedRunId?: string | null,
 *   initialAgent?: "codex" | "claudecode"
 * }} [options]
 */
export async function runLoopTui({
  stateDir = ".loop",
  input = process.stdin,
  output = process.stdout,
  once = false,
  clearScreen = true,
  env = process.env,
  openTargetImpl = openTarget,
  launchTerminalCommandImpl = launchTerminalCommand,
  serveWikiDashboardImpl = serveWikiDashboard,
  getDashboardStatusImpl = getDashboardStatus,
  initialSelectedRunId = null,
  initialAgent = "codex"
} = {}) {
  if (!input.isTTY || !output.isTTY) {
    throw new Error("Loop Prompt Console requires an interactive terminal.");
  }
  let selectedRunId = /** @type {string | null} */ (initialSelectedRunId);
  let agent = /** @type {"codex" | "claudecode"} */ (initialAgent);
  let showLogo = true;
  let lastNotice = "";
  /** @type {import("node:http").Server | null} */
  let dashboardServer = null;
  const rl = createInterface({ input, output });
  try {
    while (true) {
      const snapshot = await loadSnapshot({ stateDir, selectedRunId, agent, getDashboardStatusImpl });
      selectedRunId = snapshot.selectedRunId;
      const useColor = shouldUseTuiColor({ isTTY: output.isTTY, env });
      if (clearScreen) {
        output.write("\x1Bc");
      }
      if (showLogo) {
        output.write(`${renderTuiLogo({
          color: useColor
        })}\n\n`);
      }
      output.write(renderTuiHome({
        ...snapshot,
        notice: lastNotice
      }, { color: useColor, width: terminalWidth(output) }));
      showLogo = false;
      if (once) {
        return;
      }
      const answer = (await rl.question(colorize("Prompt › ", TUI_PROMPT_COLOR, useColor))).trim();
      const action = normalizeTuiAction(answer);
      if (!answer || action === "refresh") {
        continue;
      }
      if (action === "quit") {
        return;
      }
      if (/^[1-9]$/.test(answer)) {
        const selected = snapshot.runs[Number(answer) - 1];
        if (selected) {
          selectedRunId = selected.id;
          lastNotice = `Selected run ${selected.id}.`;
        }
        continue;
      }
      if (action === "agent") {
        const choice = (await rl.question("Agent 1) codex 2) claudecode [1]: ")).trim();
        agent = choice === "2" ? "claudecode" : "codex";
        lastNotice = `Agent switched to ${agent}.`;
        continue;
      }
      if (action === "dashboard") {
        try {
          const url = dashboardUrl();
          if (!dashboardServer) {
            const served = await serveWikiDashboardImpl({ stateDir });
            if (served.server) {
              dashboardServer = served.server;
            }
            openTargetImpl(served.url);
            lastNotice = `Wiki dashboard opened: ${served.url}`;
          } else {
            openTargetImpl(url);
            lastNotice = `Wiki dashboard opened: ${url}`;
          }
        } catch (error) {
          const fallbackUrl = dashboardUrl();
          lastNotice = `Dashboard failed: ${error instanceof Error ? error.message : String(error)} (${fallbackUrl})`;
        }
        continue;
      }
      if (!selectedRunId && action) {
        lastNotice = `Select a run first for ${action}. Type a full objective to prepare a new Loop prompt.`;
        continue;
      }
      if (!selectedRunId) {
        lastNotice = `Prepared new Loop prompt. Run: ${loopRunCommand({
          agent,
          prompt: answer,
          stateDir
        })}`;
        await rl.question("Press Enter to return.");
        continue;
      }
      if (action === "logs") {
        const tail = await readRunLogTailAction({ stateDir, id: selectedRunId, maxLines: 60 });
        writeStatus(output, tail.log || "No log output recorded yet.");
        await rl.question("Press Enter to return.");
        continue;
      }
      if (action === "wiki") {
        const notes = await listWikiNotesAction({ stateDir });
        writeStatus(output, notes.notes.map((note) => `${note.kind} ${note.id} - ${note.title}`).join("\n") || "No wiki notes.");
        await rl.question("Press Enter to return.");
        continue;
      }
      if (action === "note") {
        const title = (await rl.question("Title: ")).trim();
        const body = (await rl.question("Body: ")).trim();
        if (title && body) {
          const result = await addWikiNoteAction({
            stateDir,
            runId: selectedRunId,
            targetId: selectedRunId,
            kind: "note",
            title,
            body,
            confirmation: createActionConfirmation({ action: "add-note", targetId: selectedRunId, stateDir })
          });
          lastNotice = actionStatus(result, "Note added.");
        } else {
          lastNotice = "Title and body are required.";
        }
        continue;
      }
      if (action === "verify") {
        const summary = (await rl.question("Evidence summary: ")).trim();
        if (summary) {
          const result = await markVerificationAction({
            stateDir,
            id: selectedRunId,
            summary,
            confirmation: createActionConfirmation({ action: "verify-run", targetId: selectedRunId, stateDir })
          });
          lastNotice = actionStatus(result, "Verification evidence recorded.");
        } else {
          lastNotice = "Evidence summary is required.";
        }
        continue;
      }
      if (action === "complete") {
        const confirm = (await rl.question(`Mark ${selectedRunId} complete? y/N `)).trim().toLowerCase();
        if (confirm === "y" || confirm === "yes") {
          const result = await markCompleteAction({
            stateDir,
            id: selectedRunId,
            confirmation: createActionConfirmation({ action: "mark-complete", targetId: selectedRunId, stateDir })
          });
          lastNotice = actionStatus(result, "Run marked complete.");
        }
        continue;
      }
      if (action === "follow") {
        const prompt = (await rl.question("Follow-up objective: ")).trim();
        if (prompt) {
          const follow = await prepareFollowUpRunAction({
            stateDir,
            parentRunId: selectedRunId,
            prompt,
            createdFrom: "tui",
            confirmation: createActionConfirmation({ action: "follow-up-run", targetId: selectedRunId, stateDir })
          });
          if (follow.ok) {
            lastNotice = `Prepared follow-up. Run: ${loopRunCommand({
              agent,
              prompt,
              stateDir,
              parentRunId: selectedRunId,
              lineageSource: "tui"
            })}`;
            await rl.question("Press Enter to return.");
          }
        }
        continue;
      }
      if (action === "codex") {
        const confirm = (await rl.question(`Open Codex for ${selectedRunId}? y/N `)).trim().toLowerCase();
        if (confirm === "y" || confirm === "yes") {
          const opened = await prepareCodexOpenAction({
            stateDir,
            id: selectedRunId,
            confirmation: createActionConfirmation({ action: "open-codex", targetId: selectedRunId, stateDir })
          });
          if (opened.ok) {
            const spec = codexCommandSpecFromOpenEffect(opened.effect);
            if (spec) {
              launchTerminalCommandImpl(spec);
              lastNotice = `Opened Codex: ${codexCommandFromOpenEffect(opened.effect)}`;
            }
          } else {
            const message = "error" in opened && opened.error?.message
              ? opened.error.message
              : "No Codex resume command is available for this run.";
            lastNotice = message;
          }
          await rl.question("Press Enter to return.");
        }
        continue;
      }
      const follow = await prepareFollowUpRunAction({
        stateDir,
        parentRunId: selectedRunId,
        prompt: answer,
        createdFrom: "tui",
        confirmation: createActionConfirmation({ action: "follow-up-run", targetId: selectedRunId, stateDir })
      });
      if (follow.ok) {
        lastNotice = `Prepared connected Loop prompt. Run: ${loopRunCommand({
          agent,
          prompt: answer,
          stateDir,
          parentRunId: selectedRunId,
          lineageSource: "tui"
        })}`;
      } else {
        lastNotice = `Prompt failed: ${follow.error?.message ?? follow.error?.kind ?? "unknown error"}`;
      }
      await rl.question("Press Enter to return.");
    }
  } finally {
    rl.close();
    if (dashboardServer) {
      await new Promise((resolve) => dashboardServer?.close(resolve));
    }
  }
}

/**
 * @param {{
 *   stateDir?: string,
 *   runId: string,
 *   agent?: "codex" | "claudecode",
 *   runPromise: Promise<unknown>,
 *   input?: NodeJS.ReadableStream & { isTTY?: boolean },
 *   output?: NodeJS.WritableStream & { isTTY?: boolean },
 *   clearScreen?: boolean,
 *   env?: NodeJS.ProcessEnv,
 *   intervalMs?: number,
 *   continueToConsole?: boolean
 * }} options
 */
export async function runLoopProcessingTui({
  stateDir = ".loop",
  runId,
  agent = "codex",
  runPromise,
  input = process.stdin,
  output = process.stdout,
  clearScreen = true,
  env = process.env,
  intervalMs = 900,
  continueToConsole = true
}) {
  if (!input.isTTY || !output.isTTY) {
    throw new Error("Loop Prompt Console requires an interactive terminal.");
  }
  let frame = 0;
  let settled = false;
  /** @type {unknown} */
  let settledValue;
  /** @type {unknown} */
  let settledError;
  const watched = runPromise.then((value) => {
    settled = true;
    settledValue = value;
  }, (error) => {
    settled = true;
    settledError = error;
  });

  while (!settled) {
    const useColor = shouldUseTuiColor({ isTTY: output.isTTY, env });
    const [snapshot, tail] = await Promise.all([
      loadSnapshot({ stateDir, selectedRunId: runId, agent }),
      readRunLogTailAction({ stateDir, id: runId, maxLines: 24 }).catch(() => ({ log: "" }))
    ]);
    if (clearScreen) {
      output.write("\x1Bc");
    }
    output.write(`${renderTuiLogo({
      color: useColor
    })}\n\n`);
    output.write(renderTuiProcessing(snapshot, {
      runId,
      frame,
      logTail: tail.log,
      color: useColor,
      width: terminalWidth(output)
    }));
    output.write("\n");
    frame += 1;
    await Promise.race([
      watched,
      new Promise((resolve) => setTimeout(resolve, intervalMs))
    ]);
  }

  await watched;
  if (settledError) {
    throw settledError;
  }

  const [snapshot, tail] = await Promise.all([
    loadSnapshot({ stateDir, selectedRunId: runId, agent }),
    readRunLogTailAction({ stateDir, id: runId, maxLines: 24 }).catch(() => ({ log: "" }))
  ]);
  const useColor = shouldUseTuiColor({ isTTY: output.isTTY, env });
  if (clearScreen) {
    output.write("\x1Bc");
  }
  output.write(renderTuiProcessing(snapshot, {
    runId,
    frame,
    logTail: tail.log,
    color: useColor,
    width: terminalWidth(output)
  }));
  output.write("\n\nAgent process exited. Opening Loop Prompt Console...\n");

  if (continueToConsole) {
    await runLoopTui({
      stateDir,
      input,
      output,
      clearScreen,
      env,
      initialSelectedRunId: runId,
      initialAgent: agent
    });
  }

  return settledValue;
}
