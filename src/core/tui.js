import { emitKeypressEvents } from "node:readline";
import { basename } from "node:path";

import {
  addWikiNoteAction,
  createActionConfirmation,
  listRunsAction,
  listWikiNotesAction,
  markCompleteAction,
  markVerificationAction,
  prepareCodexOpenAction,
  prepareFollowUpRunAction,
  readRunLogTailAction
} from "./actions.js";
import { dashboardUrl, getDashboardStatus, serveWikiDashboard } from "./wiki-dashboard.js";
import { openTarget } from "./open-target.js";
import {
  initObsidianSync,
  installObsidianSyncService,
  obsidianSyncStatus,
  syncObsidianWiki
} from "./obsidian-sync.js";
import {
  codexCommandFromOpenEffect,
  codexCommandSpecFromOpenEffect,
  launchTerminalCommand,
  loopRunCommand
} from "./terminal-launcher.js";
import { disableRawMode, enableRawMode, parseKeyIntent } from "./tui-input.js";
import {
  renderTuiHome,
  renderTuiLogo,
  renderTuiProcessing,
  shouldUseTuiColor
} from "./tui-render.js";
import {
  createTuiModel,
  reduceTuiIntent,
  setTuiNotice,
  setTuiOverlay,
  snapshotForTuiModel,
  updateTuiSnapshot
} from "./tui-state.js";

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
 * @param {{ stateDir?: string, selectedRunId?: string | null, agent?: "codex" | "claudecode", dashboardHost?: string, dashboardPort?: number, getDashboardStatusImpl?: typeof getDashboardStatus, obsidianSyncStatusImpl?: typeof obsidianSyncStatus, detectObsidianCandidates?: boolean }} [options]
 */
async function loadSnapshot({
  stateDir = ".loop",
  selectedRunId = null,
  agent = "codex",
  dashboardHost,
  dashboardPort,
  getDashboardStatusImpl = getDashboardStatus,
  obsidianSyncStatusImpl = obsidianSyncStatus,
  detectObsidianCandidates = false
} = {}) {
  const dashboardProbe = getDashboardStatusImpl({ host: dashboardHost, port: dashboardPort, timeoutMs: 80 })
    .then((status) => {
      if (!status.running && status.occupied) {
        return { running: false, occupied: false, unknown: true };
      }
      return { ...status, unknown: false };
    })
    .catch(() => ({ running: false, occupied: false, unknown: true }));
  const obsidianProbe = obsidianSyncStatusImpl({
    stateDir,
    detectCandidates: detectObsidianCandidates
  }).catch(() => ({
    configured: false,
    configPath: "",
    manifestPath: "",
    config: null,
    candidates: [],
    project: {
      projectId: "",
      projectName: "",
      projectFolder: ""
    },
    unknown: true
  }));
  const [runs, notes, dashboardStatus, obsidian] = await Promise.all([
    listRunsAction({ stateDir }),
    listWikiNotesAction({ stateDir }),
    dashboardProbe,
    obsidianProbe
  ]);
  const runList = runs.runs;
  const noteList = notes.notes;
  const selected = runList.find((run) => run.id === selectedRunId) ?? runList[0] ?? null;
  return {
    stateDir,
    agent,
    runs: runList,
    notes: noteList,
    graph: graphSummaryFromNotes(noteList),
    dashboard: {
      ...dashboardStatus,
      url: dashboardUrl({ host: dashboardHost, port: dashboardPort })
    },
    obsidian,
    notice: "",
    selectedRunId: selected?.id ?? null,
    selectedRun: selected
  };
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
 * @param {Awaited<ReturnType<typeof obsidianSyncStatus>> & { unknown?: boolean }} status
 * @param {string} [notice]
 */
function obsidianOverlayData(status, notice = "") {
  const configured = status.configured && status.config;
  const lines = configured
    ? [
        "Status: configured",
        `Vault: ${status.config?.vaultPath ?? ""}`,
        `Project folder: ${status.config?.projectFolder ?? status.project.projectFolder}`,
        `Sync root: ${status.config?.syncRoot ?? ""}`
      ]
    : [
        status.unknown ? "Status: unknown" : "Status: not configured",
        `Project folder: ${status.project.projectFolder || "unknown"}`,
        status.candidates.length
          ? `Detected vaults: ${status.candidates.length}`
          : "Detected vaults: none"
      ];
  const actions = configured
    ? [
        { id: "sync", label: "Sync now" },
        { id: "install-service", label: "Install watcher" },
        { id: "refresh", label: "Refresh" },
        { id: "close", label: "Close" }
      ]
    : [
        ...status.candidates.slice(0, 6).map((candidate) => ({
          id: "init",
          label: `Use ${basename(candidate) || candidate}`,
          vaultPath: candidate
        })),
        { id: "refresh", label: "Refresh" },
        { id: "close", label: "Close" }
      ];
  return { lines, actions, notice };
}

/**
 * @param {Array<Record<string, unknown> & { id: string, title?: string, kind?: string, parentId?: string, runId?: string, lineage?: unknown, status?: string, links?: Array<Record<string, unknown> & { target?: string, relationship?: string, reason?: string }> }>} notes
 */
function graphSummaryFromNotes(notes) {
  let edgeCount = 0;
  for (const note of notes) {
    edgeCount += note.links?.length ?? 0;
  }
  return {
    nodes: new Array(notes.length),
    edges: new Array(edgeCount)
  };
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
 *   obsidianSyncStatusImpl?: typeof obsidianSyncStatus,
 *   initObsidianSyncImpl?: typeof initObsidianSync,
 *   syncObsidianWikiImpl?: typeof syncObsidianWiki,
 *   installObsidianSyncServiceImpl?: typeof installObsidianSyncService,
 *   dashboardHost?: string,
 *   dashboardPort?: number,
 *   initialSelectedRunId?: string | null,
 *   initialAgent?: "codex" | "claudecode",
 *   addWikiNoteActionImpl?: typeof addWikiNoteAction,
 *   markVerificationActionImpl?: typeof markVerificationAction,
 *   markCompleteActionImpl?: typeof markCompleteAction,
 *   prepareFollowUpRunActionImpl?: typeof prepareFollowUpRunAction,
 *   prepareCodexOpenActionImpl?: typeof prepareCodexOpenAction,
 *   readRunLogTailActionImpl?: typeof readRunLogTailAction,
 *   listWikiNotesActionImpl?: typeof listWikiNotesAction
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
  obsidianSyncStatusImpl = obsidianSyncStatus,
  initObsidianSyncImpl = initObsidianSync,
  syncObsidianWikiImpl = syncObsidianWiki,
  installObsidianSyncServiceImpl = installObsidianSyncService,
  dashboardHost,
  dashboardPort,
  initialSelectedRunId = null,
  initialAgent = "codex",
  addWikiNoteActionImpl = addWikiNoteAction,
  markVerificationActionImpl = markVerificationAction,
  markCompleteActionImpl = markCompleteAction,
  prepareFollowUpRunActionImpl = prepareFollowUpRunAction,
  prepareCodexOpenActionImpl = prepareCodexOpenAction,
  readRunLogTailActionImpl = readRunLogTailAction,
  listWikiNotesActionImpl = listWikiNotesAction
} = {}) {
  if (!input.isTTY || !output.isTTY) {
    throw new Error("Loop Prompt Console requires an interactive terminal.");
  }
  let showLogo = true;
  /** @type {import("node:http").Server | null} */
  let dashboardServer = null;
  let snapshot = await loadSnapshot({
    stateDir,
    selectedRunId: initialSelectedRunId,
    agent: initialAgent,
    dashboardHost,
    dashboardPort,
    getDashboardStatusImpl,
    obsidianSyncStatusImpl
  });
  let model = createTuiModel(snapshot, {
    selectedRunId: initialSelectedRunId,
    agent: initialAgent
  });

  /**
   * @param {{ logo?: boolean }} [options]
   */
  async function render({ logo = false } = {}) {
    snapshot = await loadSnapshot({
      stateDir,
      selectedRunId: model.selectedRunId,
      agent: model.agent,
      dashboardHost,
      dashboardPort,
      getDashboardStatusImpl,
      obsidianSyncStatusImpl
    });
    model = updateTuiSnapshot(model, snapshot);
    const useColor = shouldUseTuiColor({ isTTY: output.isTTY, env });
    if (clearScreen) {
      output.write("\x1Bc");
    }
    if (logo) {
      output.write(`${renderTuiLogo({
        color: useColor
      })}\n\n`);
    }
    output.write(renderTuiHome(
      /** @type {Parameters<typeof renderTuiHome>[0]} */ (snapshotForTuiModel(snapshot, model)),
      {
        color: useColor,
        width: terminalWidth(output),
        model
      }
    ));
  }

  /**
   * @param {string} action
   */
  function selectedRunIdFor(action) {
    if (!model.selectedRunId) {
      model = setTuiNotice(model, `Select a run before ${action}.`);
      return null;
    }
    return model.selectedRunId;
  }

  /**
   * @param {{ type: string, [key: string]: unknown }} effect
   */
  async function handleEffect(effect) {
    if (effect.type === "selectRunIndex") {
      const index = typeof effect.index === "number" ? effect.index : -1;
      const selected = snapshot.runs[index] ?? null;
      model = {
        ...model,
        selectedRunIndex: selected ? index : -1,
        selectedRunId: selected?.id ?? null,
        notice: selected ? `Selected run ${selected.id}.` : "No run selected."
      };
      return false;
    }
    if (effect.type === "refresh") {
      return false;
    }
    if (effect.type === "quit") {
      return true;
    }
    if (effect.type === "obsidianAction") {
      const obsidianAction = String(effect.action ?? "");
      let notice = "";
      try {
        if (obsidianAction === "init") {
          const vaultPath = typeof effect.vaultPath === "string" ? effect.vaultPath : "";
          if (!vaultPath) {
            model = setTuiNotice(model, "No Obsidian vault selected.");
            return false;
          }
          const result = await initObsidianSyncImpl({ stateDir, vaultPath });
          notice = `Obsidian sync configured: ${result.config.projectFolder}`;
        } else if (obsidianAction === "sync") {
          const result = await syncObsidianWikiImpl({ stateDir });
          notice = `Obsidian sync complete: synced ${result.synced}, conflicts ${result.conflicts}.`;
        } else if (obsidianAction === "install-service") {
          const result = await installObsidianSyncServiceImpl({ stateDir });
          notice = result.ok
            ? `Obsidian watcher installed: ${result.plistPath}`
            : result.message ?? "Obsidian watcher install is not supported on this platform.";
        } else if (obsidianAction !== "refresh") {
          notice = `Unknown Obsidian action: ${obsidianAction}`;
        }
      } catch (error) {
        notice = `Obsidian action failed: ${error instanceof Error ? error.message : String(error)}`;
      }
      const status = await obsidianSyncStatusImpl({ stateDir, detectCandidates: true });
      model = setTuiOverlay(model, "obsidianSettings", obsidianOverlayData(status, notice));
      return false;
    }
    if (effect.type === "submitPrompt") {
      const prompt = String(effect.prompt ?? "").trim();
      if (!prompt) {
        model = setTuiNotice(model, "Prompt is empty.");
        return false;
      }
      if (!model.selectedRunId) {
        model = setTuiNotice(model, `Prepared new Loop prompt. Run: ${loopRunCommand({
          agent: model.agent,
          prompt,
          stateDir
        })}`);
        return false;
      }
      const follow = await prepareFollowUpRunActionImpl({
        stateDir,
        parentRunId: model.selectedRunId,
        prompt,
        createdFrom: "tui",
        confirmation: createActionConfirmation({ action: "follow-up-run", targetId: model.selectedRunId, stateDir })
      });
      if (follow.ok) {
        model = setTuiNotice(model, `Prepared connected Loop prompt. Run: ${loopRunCommand({
          agent: model.agent,
          prompt,
          stateDir,
          parentRunId: model.selectedRunId,
          lineageSource: "tui"
        })}`);
      } else {
        model = setTuiNotice(model, `Prompt failed: ${follow.error?.message ?? follow.error?.kind ?? "unknown error"}`);
      }
      return false;
    }
    if (effect.type !== "action") {
      return false;
    }
    const action = String(effect.action);
    if (action === "dashboard") {
      try {
        const url = dashboardUrl({ host: dashboardHost, port: dashboardPort });
        if (!dashboardServer) {
          const served = await serveWikiDashboardImpl({ stateDir, host: dashboardHost, port: dashboardPort });
          if (served.server) {
            dashboardServer = served.server;
          }
          openTargetImpl(served.url);
          model = setTuiNotice(model, `Wiki dashboard opened: ${served.url}`);
        } else {
          openTargetImpl(url);
          model = setTuiNotice(model, `Wiki dashboard opened: ${url}`);
        }
      } catch (error) {
        const fallbackUrl = dashboardUrl();
        model = setTuiNotice(model, `Dashboard failed: ${error instanceof Error ? error.message : String(error)} (${fallbackUrl})`);
      }
      return false;
    }
    if (action === "logs") {
      const runId = selectedRunIdFor("logs");
      if (!runId) {
        return false;
      }
      const tail = await readRunLogTailActionImpl({ stateDir, id: runId, maxLines: 60 });
      const lines = tail.log ? tail.log.split(/\r?\n/) : ["No log output recorded yet."];
      model = setTuiOverlay(model, "logPreview", { lines });
      return false;
    }
    if (action === "wiki") {
      const notes = await listWikiNotesActionImpl({ stateDir });
      const lines = notes.notes.length
        ? notes.notes.map((note) => `${note.kind} ${note.id} - ${note.title}`)
        : ["No wiki notes."];
      model = setTuiOverlay(model, "wikiList", { lines });
      return false;
    }
    if (action === "obsidian") {
      try {
        const status = await obsidianSyncStatusImpl({ stateDir, detectCandidates: true });
        model = setTuiOverlay(model, "obsidianSettings", obsidianOverlayData(status));
      } catch (error) {
        model = setTuiNotice(model, `Obsidian status failed: ${error instanceof Error ? error.message : String(error)}`);
      }
      return false;
    }
    if (action === "note") {
      const runId = selectedRunIdFor("note");
      if (!runId) {
        return false;
      }
      const result = await addWikiNoteActionImpl({
        stateDir,
        runId,
        targetId: runId,
        kind: "note",
        title: String(effect.title ?? ""),
        body: String(effect.body ?? ""),
        confirmation: createActionConfirmation({ action: "add-note", targetId: runId, stateDir })
      });
      model = setTuiNotice(model, actionStatus(result, "Note added."));
      return false;
    }
    if (action === "verify") {
      const runId = selectedRunIdFor("verify");
      if (!runId) {
        return false;
      }
      const result = await markVerificationActionImpl({
        stateDir,
        id: runId,
        summary: String(effect.summary ?? ""),
        confirmation: createActionConfirmation({ action: "verify-run", targetId: runId, stateDir })
      });
      model = setTuiNotice(model, actionStatus(result, "Verification evidence recorded."));
      return false;
    }
    if (action === "complete") {
      const runId = selectedRunIdFor("complete");
      if (!runId) {
        return false;
      }
      const result = await markCompleteActionImpl({
        stateDir,
        id: runId,
        confirmation: createActionConfirmation({ action: "mark-complete", targetId: runId, stateDir })
      });
      model = setTuiNotice(model, actionStatus(result, "Run marked complete."));
      return false;
    }
    if (action === "follow") {
      const runId = selectedRunIdFor("follow-up");
      if (!runId) {
        return false;
      }
      const prompt = String(effect.prompt ?? "");
      const follow = await prepareFollowUpRunActionImpl({
        stateDir,
        parentRunId: runId,
        prompt,
        createdFrom: "tui",
        confirmation: createActionConfirmation({ action: "follow-up-run", targetId: runId, stateDir })
      });
      if (follow.ok) {
        model = setTuiNotice(model, `Prepared follow-up. Run: ${loopRunCommand({
          agent: model.agent,
          prompt,
          stateDir,
          parentRunId: runId,
          lineageSource: "tui"
        })}`);
      } else {
        model = setTuiNotice(model, `Follow-up failed: ${follow.error?.message ?? follow.error?.kind ?? "unknown error"}`);
      }
      return false;
    }
    if (action === "codex") {
      const runId = selectedRunIdFor("codex");
      if (!runId) {
        return false;
      }
      const opened = await prepareCodexOpenActionImpl({
        stateDir,
        id: runId,
        confirmation: createActionConfirmation({ action: "open-codex", targetId: runId, stateDir })
      });
      if (opened.ok) {
        const spec = codexCommandSpecFromOpenEffect(opened.effect);
        if (spec) {
          launchTerminalCommandImpl(spec);
          model = setTuiNotice(model, `Opened Codex: ${codexCommandFromOpenEffect(opened.effect)}`);
        } else {
          model = setTuiNotice(model, "No Codex resume command is available for this run.");
        }
      } else {
        const message = "error" in opened && opened.error?.message
          ? opened.error.message
          : "No Codex resume command is available for this run.";
        model = setTuiNotice(model, message);
      }
      return false;
    }
    return false;
  }

  await render({ logo: showLogo });
  showLogo = false;
  if (once) {
    return;
  }

  emitKeypressEvents(input);
  enableRawMode(input);
  if (typeof input.resume === "function") {
    input.resume();
  }

  /** @type {((str: string, key: Record<string, unknown>) => void) | null} */
  let onKeypress = null;
  let queue = Promise.resolve();
  try {
    await new Promise((resolve, reject) => {
      let done = false;
      onKeypress = (str, key) => {
        queue = queue.then(async () => {
          if (done) {
            return;
          }
          const intent = parseKeyIntent({ str, key, model, runCount: snapshot.runs.length });
          if (!intent) {
            return;
          }
          const reduced = reduceTuiIntent(model, { ...intent, runCount: snapshot.runs.length });
          model = reduced.model;
          for (const effect of reduced.effects) {
            const shouldQuit = await handleEffect(effect);
            if (shouldQuit) {
              done = true;
              resolve(undefined);
              return;
            }
          }
          await render();
        }).catch((error) => {
          done = true;
          reject(error);
        });
      };
      input.on("keypress", /** @type {(...args: unknown[]) => void} */ (onKeypress));
    });
  } finally {
    if (onKeypress) {
      input.off("keypress", /** @type {(...args: unknown[]) => void} */ (onKeypress));
    }
    disableRawMode(input);
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
 *   dashboardHost?: string,
 *   dashboardPort?: number
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
  continueToConsole = true,
  dashboardHost,
  dashboardPort
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
      loadSnapshot({ stateDir, selectedRunId: runId, agent, dashboardHost, dashboardPort }),
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
    loadSnapshot({ stateDir, selectedRunId: runId, agent, dashboardHost, dashboardPort }),
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
      dashboardHost,
      dashboardPort,
      initialSelectedRunId: runId,
      initialAgent: agent
    });
  }

  return settledValue;
}
