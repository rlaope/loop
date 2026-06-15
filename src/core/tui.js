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
import { dashboardUrl, serveWikiDashboard } from "./wiki-dashboard.js";
import { openTarget } from "./open-target.js";
import {
  codexCommandFromOpenEffect,
  codexCommandSpecFromOpenEffect,
  launchTerminalCommand,
  loopRunCommand
} from "./terminal-launcher.js";

const RED = "\x1b[38;5;167m";
const DIM_RED = "\x1b[38;5;88m";
const RESET = "\x1b[0m";
const LOOP_LOGO_LINES = [
  " _      ___   ___  ____ ",
  "| |    / _ \\ / _ \\|  _ \\",
  "| |   | | | | | | | |_) |",
  "| |___| |_| | |_| |  __/",
  "|_____|\\___/ \\___/|_|",
  "        .----->----.",
  "     .-'           '-.",
  "   .'   plan   act    '.",
  "   \\    verify stop    /",
  "     '-.           .-'",
  "        '----<----'"
];

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
 * @param {string} value
 * @param {number} maxLength
 */
function truncate(value, maxLength) {
  return value.length <= maxLength ? value : `${value.slice(0, maxLength - 3)}...`;
}

/**
 * @param {{ color?: boolean }} [options]
 */
function renderTuiLogo({ color = false } = {}) {
  if (!color) {
    return LOOP_LOGO_LINES.join("\n");
  }
  return LOOP_LOGO_LINES.map((line, index) => {
    const tone = index < 5 ? RED : DIM_RED;
    return `${tone}${line}${RESET}`;
  }).join("\n");
}

/**
 * @param {{ isTTY?: boolean, env?: NodeJS.ProcessEnv }} input
 */
function shouldUseTuiColor({ isTTY = false, env = process.env }) {
  if (!isTTY) {
    return false;
  }
  if (env.NO_COLOR !== undefined || env.FORCE_COLOR === "0" || env.TERM === "dumb") {
    return false;
  }
  return true;
}

/**
 * @param {{ stateDir?: string, selectedRunId?: string | null, agent?: "codex" | "claudecode" }} [options]
 */
async function loadSnapshot({ stateDir = ".loop", selectedRunId = null, agent = "codex" } = {}) {
  const [runs, notes, graph] = await Promise.all([
    listRunsAction({ stateDir }),
    listWikiNotesAction({ stateDir }),
    readGraphAction({ stateDir })
  ]);
  const runList = runs.runs;
  const selected = runList.find((run) => run.id === selectedRunId) ?? runList[0] ?? null;
  return {
    stateDir,
    agent,
    runs: runList,
    notes: notes.notes,
    graph: graph.graph,
    selectedRunId: selected?.id ?? null,
    selectedRun: selected
  };
}

/**
 * @param {Awaited<ReturnType<typeof loadSnapshot>>} snapshot
 */
export function renderTuiHome(snapshot) {
  const runRows = snapshot.runs.length === 0
    ? "  No Loop runs yet. Start with: loop run \"your objective\""
    : snapshot.runs.slice(0, 8).map((run, index) => {
        const marker = run.id === snapshot.selectedRunId ? "*" : " ";
        return `${marker} ${index + 1}. ${run.status}/${run.phase} ${truncate(run.objective, 72)}\n     ${run.id}`;
      }).join("\n");
  const selected = snapshot.selectedRun
    ? [
        `Selected: ${snapshot.selectedRun.id}`,
        `Status: ${snapshot.selectedRun.status}/${snapshot.selectedRun.phase}`,
        `Next: ${snapshot.selectedRun.nextAction}`
      ].join("\n")
    : "Selected: none";
  return [
    "Loop Agent Console",
    "==================",
    `State: ${snapshot.stateDir}`,
    `Agent: ${snapshot.agent}`,
    "",
    "Runs",
    runRows,
    "",
    selected,
    "",
    `Wiki: ${snapshot.notes.length} notes | Graph: ${snapshot.graph.nodes.length} nodes, ${snapshot.graph.edges.length} edges`,
    "",
    "Commands",
    "  1-9 select run    logs show tail       wiki list notes",
    "  note add note     verify add evidence  complete mark complete",
    "  follow prepare    codex open terminal  dashboard start/open wiki",
    "  agent switch      refresh              q quit",
    ""
  ].join("\n");
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
 *   serveWikiDashboardImpl?: typeof serveWikiDashboard
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
  serveWikiDashboardImpl = serveWikiDashboard
} = {}) {
  if (!input.isTTY || !output.isTTY) {
    throw new Error("Loop Agent Console requires an interactive terminal.");
  }
  let selectedRunId = /** @type {string | null} */ (null);
  let agent = /** @type {"codex" | "claudecode"} */ ("codex");
  let showLogo = true;
  /** @type {import("node:http").Server | null} */
  let dashboardServer = null;
  const rl = createInterface({ input, output });
  try {
    while (true) {
      const snapshot = await loadSnapshot({ stateDir, selectedRunId, agent });
      selectedRunId = snapshot.selectedRunId;
      if (clearScreen) {
        output.write("\x1Bc");
      }
      if (showLogo) {
        output.write(`${renderTuiLogo({
          color: shouldUseTuiColor({ isTTY: output.isTTY, env })
        })}\n\n`);
      }
      output.write(renderTuiHome(snapshot));
      showLogo = false;
      if (once) {
        return;
      }
      const answer = (await rl.question("loop> ")).trim();
      if (!answer || answer === "refresh" || answer === "r") {
        continue;
      }
      if (answer === "q" || answer === "quit" || answer === "exit") {
        return;
      }
      if (/^[1-9]$/.test(answer)) {
        const selected = snapshot.runs[Number(answer) - 1];
        if (selected) {
          selectedRunId = selected.id;
        }
        continue;
      }
      if (answer === "agent") {
        const choice = (await rl.question("Agent 1) codex 2) claudecode [1]: ")).trim();
        agent = choice === "2" ? "claudecode" : "codex";
        continue;
      }
      if (answer === "dashboard") {
        try {
          const url = dashboardUrl();
          if (!dashboardServer) {
            const served = await serveWikiDashboardImpl({ stateDir });
            if (served.server) {
              dashboardServer = served.server;
            }
            openTargetImpl(served.url);
            writeStatus(output, `Dashboard: ${served.url}`);
          } else {
            openTargetImpl(url);
            writeStatus(output, `Dashboard: ${url}`);
          }
        } catch (error) {
          const fallbackUrl = dashboardUrl();
          writeStatus(output, `Dashboard failed to start: ${error instanceof Error ? error.message : String(error)}\nURL: ${fallbackUrl}`);
        }
        continue;
      }
      if (!selectedRunId) {
        writeStatus(output, "Select a run first.");
        continue;
      }
      if (answer === "logs") {
        const tail = await readRunLogTailAction({ stateDir, id: selectedRunId, maxLines: 60 });
        writeStatus(output, tail.log || "No log output recorded yet.");
        await rl.question("Press Enter to return.");
        continue;
      }
      if (answer === "wiki") {
        const notes = await listWikiNotesAction({ stateDir });
        writeStatus(output, notes.notes.map((note) => `${note.kind} ${note.id} - ${note.title}`).join("\n") || "No wiki notes.");
        await rl.question("Press Enter to return.");
        continue;
      }
      if (answer === "note") {
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
          writeStatus(output, actionStatus(result, "Note added."));
        } else {
          writeStatus(output, "Title and body are required.");
        }
        continue;
      }
      if (answer === "verify") {
        const summary = (await rl.question("Evidence summary: ")).trim();
        if (summary) {
          const result = await markVerificationAction({
            stateDir,
            id: selectedRunId,
            summary,
            confirmation: createActionConfirmation({ action: "verify-run", targetId: selectedRunId, stateDir })
          });
          writeStatus(output, actionStatus(result, "Verification evidence recorded."));
        } else {
          writeStatus(output, "Evidence summary is required.");
        }
        continue;
      }
      if (answer === "complete") {
        const confirm = (await rl.question(`Mark ${selectedRunId} complete? y/N `)).trim().toLowerCase();
        if (confirm === "y" || confirm === "yes") {
          const result = await markCompleteAction({
            stateDir,
            id: selectedRunId,
            confirmation: createActionConfirmation({ action: "mark-complete", targetId: selectedRunId, stateDir })
          });
          writeStatus(output, actionStatus(result, "Run marked complete."));
        }
        continue;
      }
      if (answer === "follow") {
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
            writeStatus(output, `Prepared follow-up. Run: ${loopRunCommand({
              agent,
              prompt,
              stateDir,
              parentRunId: selectedRunId,
              lineageSource: "tui"
            })}`);
            await rl.question("Press Enter to return.");
          }
        }
        continue;
      }
      if (answer === "codex") {
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
              writeStatus(output, `Opened Codex: ${codexCommandFromOpenEffect(opened.effect)}`);
            }
          } else {
            const message = "error" in opened && opened.error?.message
              ? opened.error.message
              : "No Codex resume command is available for this run.";
            writeStatus(output, message);
          }
          await rl.question("Press Enter to return.");
        }
        continue;
      }
      writeStatus(output, `Unknown command: ${answer}`);
    }
  } finally {
    rl.close();
    if (dashboardServer) {
      await new Promise((resolve) => dashboardServer?.close(resolve));
    }
  }
}
