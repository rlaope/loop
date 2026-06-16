import { TUI_ACTIONS } from "./tui-actions.js";
import { isTuiTextOverlay } from "./tui-overlays.js";

export { TUI_ACTIONS } from "./tui-actions.js";

export const TUI_FOCUS_REGIONS = Object.freeze(["prompt", "runs", "selectedRun", "actions", "status"]);

const AGENT_OPTIONS = Object.freeze(["codex", "claudecode"]);

/**
 * @typedef {{
 *   focusRegion: string,
 *   previousFocusRegion: string | null,
 *   selectedRunIndex: number,
 *   selectedRunId: string | null,
 *   selectedActionIndex: number,
 *   promptBuffer: string,
 *   promptMode: boolean,
 *   overlay: string | null,
 *   overlayIndex: number,
 *   overlayFieldIndex: number,
 *   overlayData: Record<string, unknown>,
 *   notice: string,
 *   agent: "codex" | "claudecode"
 * }} TuiModel
 *
 * @typedef {{ type: string, [key: string]: unknown }} TuiIntent
 * @typedef {{ type: string, [key: string]: unknown }} TuiEffect
 * @typedef {{ model: TuiModel, effects: TuiEffect[] }} TuiReduction
 */

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * @param {number} value
 * @param {number} min
 * @param {number} max
 */
function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

/**
 * @param {Array<Record<string, unknown> & { id: string }>} runs
 * @param {string | null | undefined} selectedRunId
 */
function selectedRunIndex(runs, selectedRunId) {
  if (!runs.length) {
    return -1;
  }
  const index = selectedRunId ? runs.findIndex((run) => run.id === selectedRunId) : -1;
  return index >= 0 ? index : 0;
}

/** @param {string | null} overlay */
function overlayFieldCount(overlay) {
  if (overlay === "noteInput") {
    return 4;
  }
  if (overlay === "verifyInput" || overlay === "followUpInput") {
    return 3;
  }
  if (overlay === "confirmComplete" || overlay === "confirmCodex") {
    return 2;
  }
  return 0;
}

/**
 * @param {Record<string, unknown> & { runs: Array<Record<string, unknown> & { id: string }>, selectedRunId?: string | null, agent: "codex" | "claudecode" }} snapshot
 * @param {{ notice?: string, focusRegion?: string, selectedRunId?: string | null, agent?: "codex" | "claudecode" }} [options]
 * @returns {TuiModel}
 */
export function createTuiModel(snapshot, {
  notice = "",
  focusRegion,
  selectedRunId = snapshot.selectedRunId ?? null,
  agent = snapshot.agent
} = {}) {
  const runIndex = selectedRunIndex(snapshot.runs, selectedRunId);
  return /** @type {TuiModel} */ ({
    focusRegion: focusRegion && TUI_FOCUS_REGIONS.includes(focusRegion) ? focusRegion : runIndex >= 0 ? "runs" : "prompt",
    previousFocusRegion: null,
    selectedRunIndex: runIndex,
    selectedRunId: runIndex >= 0 ? snapshot.runs[runIndex].id : null,
    selectedActionIndex: 0,
    promptBuffer: "",
    promptMode: runIndex < 0,
    overlay: null,
    overlayIndex: 0,
    overlayFieldIndex: 0,
    overlayData: {},
    notice,
    agent
  });
}

/**
 * @param {TuiModel} model
 * @param {Record<string, unknown> & { runs: Array<Record<string, unknown> & { id: string }>, agent: "codex" | "claudecode" }} snapshot
 * @returns {TuiModel}
 */
export function updateTuiSnapshot(model, snapshot) {
  const preferredRunId = model.selectedRunId;
  const runIndex = selectedRunIndex(snapshot.runs, preferredRunId);
  return {
    ...model,
    selectedRunIndex: runIndex,
    selectedRunId: runIndex >= 0 ? snapshot.runs[runIndex].id : null,
    focusRegion: snapshot.runs.length || model.focusRegion !== "runs" ? model.focusRegion : "prompt"
  };
}

/**
 * @param {Record<string, unknown> & { runs: Array<Record<string, unknown> & { id: string }>, selectedRunId?: string | null, selectedRun?: unknown }} snapshot
 * @param {TuiModel} model
 */
export function snapshotForTuiModel(snapshot, model) {
  const selectedRun = model.selectedRunIndex >= 0 ? snapshot.runs[model.selectedRunIndex] ?? null : null;
  return {
    ...snapshot,
    agent: model.agent,
    selectedRunId: selectedRun?.id ?? null,
    selectedRun,
    notice: model.notice
  };
}

/**
 * @param {Record<string, unknown> & { runs: Array<Record<string, unknown> & { id: string }> }} snapshot
 * @param {TuiModel} model
 */
export function selectedRunFromModel(snapshot, model) {
  return model.selectedRunIndex >= 0 ? snapshot.runs[model.selectedRunIndex] ?? null : null;
}

/** @param {TuiModel} model */
export function currentActionFromModel(model) {
  return TUI_ACTIONS[clamp(model.selectedActionIndex, 0, TUI_ACTIONS.length - 1)] ?? TUI_ACTIONS[0];
}

/**
 * @param {TuiModel} model
 * @param {string} notice
 * @returns {TuiModel}
 */
export function setTuiNotice(model, notice) {
  return { ...model, notice };
}

/**
 * @param {TuiModel} model
 * @param {string | null} overlay
 * @param {Record<string, unknown>} [overlayData]
 * @returns {TuiModel}
 */
export function setTuiOverlay(model, overlay, overlayData = {}) {
  return {
    ...model,
    previousFocusRegion: overlay ? model.focusRegion : model.previousFocusRegion,
    overlay,
    overlayIndex: 0,
    overlayFieldIndex: 0,
    overlayData
  };
}

/**
 * @param {TuiModel} model
 * @param {string} actionId
 * @returns {TuiReduction}
 */
function openAction(model, actionId) {
  const action = TUI_ACTIONS.find((item) => item.id === actionId);
  if (!action) {
    return { model, effects: [] };
  }
  if (action.runRequired && !model.selectedRunId) {
    return {
      model: {
        ...model,
        notice: `Select a run before ${action.label}.`
      },
      effects: []
    };
  }
  if (action.id === "quit") {
    return { model, effects: [{ type: "quit" }] };
  }
  if (action.id === "refresh") {
    return { model, effects: [{ type: "refresh" }] };
  }
  if (action.id === "agent") {
    return {
      model: setTuiOverlay(model, "agentPicker", { agents: [...AGENT_OPTIONS] }),
      effects: []
    };
  }
  if (action.id === "note") {
    return {
      model: setTuiOverlay(model, "noteInput", { title: "", body: "", validation: "" }),
      effects: []
    };
  }
  if (action.id === "verify") {
    return {
      model: setTuiOverlay(model, "verifyInput", { summary: "", validation: "" }),
      effects: []
    };
  }
  if (action.id === "follow") {
    return {
      model: setTuiOverlay(model, "followUpInput", { prompt: "", validation: "" }),
      effects: []
    };
  }
  if (action.id === "complete") {
    return {
      model: setTuiOverlay(model, "confirmComplete"),
      effects: []
    };
  }
  if (action.id === "codex") {
    return {
      model: setTuiOverlay(model, "confirmCodex"),
      effects: []
    };
  }
  return { model, effects: [{ type: "action", action: action.id }] };
}

/**
 * @param {TuiModel} model
 * @param {string} text
 * @returns {TuiModel}
 */
function appendText(model, text) {
  if (model.overlay === "noteInput") {
    if (model.overlayFieldIndex !== 0 && model.overlayFieldIndex !== 1) {
      return model;
    }
    const key = model.overlayFieldIndex === 1 ? "body" : "title";
    return {
      ...model,
      overlayData: {
        ...model.overlayData,
        [key]: `${String(model.overlayData[key] ?? "")}${text}`,
        validation: ""
      }
    };
  }
  if (model.overlay === "verifyInput") {
    if (model.overlayFieldIndex !== 0) {
      return model;
    }
    return {
      ...model,
      overlayData: {
        ...model.overlayData,
        summary: `${String(model.overlayData.summary ?? "")}${text}`,
        validation: ""
      }
    };
  }
  if (model.overlay === "followUpInput") {
    if (model.overlayFieldIndex !== 0) {
      return model;
    }
    return {
      ...model,
      overlayData: {
        ...model.overlayData,
        prompt: `${String(model.overlayData.prompt ?? "")}${text}`,
        validation: ""
      }
    };
  }
  return {
    ...model,
    focusRegion: "prompt",
    promptMode: true,
    promptBuffer: `${model.promptBuffer}${text}`,
    notice: ""
  };
}

/**
 * @param {TuiModel} model
 * @returns {TuiModel}
 */
function deleteText(model) {
  if (model.overlay === "noteInput") {
    if (model.overlayFieldIndex !== 0 && model.overlayFieldIndex !== 1) {
      return model;
    }
    const key = model.overlayFieldIndex === 1 ? "body" : "title";
    return {
      ...model,
      overlayData: {
        ...model.overlayData,
        [key]: String(model.overlayData[key] ?? "").slice(0, -1),
        validation: ""
      }
    };
  }
  if (model.overlay === "verifyInput") {
    if (model.overlayFieldIndex !== 0) {
      return model;
    }
    return {
      ...model,
      overlayData: {
        ...model.overlayData,
        summary: String(model.overlayData.summary ?? "").slice(0, -1),
        validation: ""
      }
    };
  }
  if (model.overlay === "followUpInput") {
    if (model.overlayFieldIndex !== 0) {
      return model;
    }
    return {
      ...model,
      overlayData: {
        ...model.overlayData,
        prompt: String(model.overlayData.prompt ?? "").slice(0, -1),
        validation: ""
      }
    };
  }
  return {
    ...model,
    promptBuffer: model.promptBuffer.slice(0, -1)
  };
}

/**
 * @param {TuiModel} model
 * @returns {TuiModel}
 */
function closeOverlay(model) {
  if (!model.overlay) {
    if (model.promptMode) {
      return { ...model, promptMode: false };
    }
    return model;
  }
  return {
    ...model,
    focusRegion: model.previousFocusRegion ?? model.focusRegion,
    previousFocusRegion: null,
    overlay: null,
    overlayIndex: 0,
    overlayFieldIndex: 0,
    overlayData: {}
  };
}

/**
 * @param {TuiModel} model
 * @param {number} delta
 * @param {number} count
 * @returns {TuiModel}
 */
function moveOverlayIndex(model, delta, count) {
  return {
    ...model,
    overlayIndex: clamp(model.overlayIndex + delta, 0, Math.max(0, count - 1))
  };
}

/**
 * @param {TuiModel} model
 * @param {number} delta
 * @returns {TuiModel}
 */
function moveFieldIndex(model, delta) {
  return {
    ...model,
    overlayFieldIndex: clamp(model.overlayFieldIndex + delta, 0, Math.max(0, overlayFieldCount(model.overlay) - 1))
  };
}

/**
 * @param {TuiModel} model
 * @param {number} delta
 * @returns {TuiModel}
 */
function moveFocus(model, delta) {
  const index = TUI_FOCUS_REGIONS.indexOf(model.focusRegion);
  const next = (index + delta + TUI_FOCUS_REGIONS.length) % TUI_FOCUS_REGIONS.length;
  return {
    ...model,
    focusRegion: TUI_FOCUS_REGIONS[next],
    promptMode: TUI_FOCUS_REGIONS[next] === "prompt" ? model.promptMode : false
  };
}

/**
 * @param {TuiModel} model
 * @returns {TuiReduction}
 */
function submitPrompt(model) {
  const prompt = model.promptBuffer.trim();
  if (!prompt) {
    return {
      model: {
        ...model,
        promptMode: true,
        notice: "Prompt is empty."
      },
      effects: []
    };
  }
  return {
    model: {
      ...model,
      promptBuffer: "",
      promptMode: false
    },
    effects: [{ type: "submitPrompt", prompt }]
  };
}

/**
 * @param {TuiModel} model
 * @returns {TuiReduction}
 */
function submitNote(model) {
  const title = String(model.overlayData.title ?? "").trim();
  const body = String(model.overlayData.body ?? "").trim();
  if (!title || !body) {
    return {
      model: {
        ...model,
        overlayData: {
          ...model.overlayData,
          validation: "Title and body are required."
        }
      },
      effects: []
    };
  }
  return {
    model: closeOverlay(model),
    effects: [{ type: "action", action: "note", title, body }]
  };
}

/**
 * @param {TuiModel} model
 * @returns {TuiReduction}
 */
function submitVerify(model) {
  const summary = String(model.overlayData.summary ?? "").trim();
  if (!summary) {
    return {
      model: {
        ...model,
        overlayData: {
          ...model.overlayData,
          validation: "Evidence summary is required."
        }
      },
      effects: []
    };
  }
  return {
    model: closeOverlay(model),
    effects: [{ type: "action", action: "verify", summary }]
  };
}

/**
 * @param {TuiModel} model
 * @returns {TuiReduction}
 */
function submitFollowUp(model) {
  const prompt = String(model.overlayData.prompt ?? "").trim();
  if (!prompt) {
    return {
      model: {
        ...model,
        overlayData: {
          ...model.overlayData,
          validation: "Follow-up objective is required."
        }
      },
      effects: []
    };
  }
  return {
    model: closeOverlay(model),
    effects: [{ type: "action", action: "follow", prompt }]
  };
}

/**
 * @param {TuiModel} model
 * @returns {TuiReduction}
 */
function openCurrent(model) {
  if (model.overlay === "runPicker") {
    return {
      model: {
        ...closeOverlay(model),
        selectedRunIndex: model.overlayIndex,
        selectedRunId: null
      },
      effects: [{ type: "selectRunIndex", index: model.overlayIndex }]
    };
  }
  if (model.overlay === "actionMenu") {
    const action = TUI_ACTIONS[model.overlayIndex];
    return openAction(closeOverlay(model), action?.id ?? "refresh");
  }
  if (model.overlay === "agentPicker") {
    const agent = /** @type {"codex" | "claudecode"} */ (AGENT_OPTIONS[model.overlayIndex] ?? "codex");
    return {
      model: {
        ...closeOverlay(model),
        agent,
        notice: `Agent switched to ${agent}.`
      },
      effects: [{ type: "refresh" }]
    };
  }
  if (model.overlay === "confirmComplete") {
    if (model.overlayIndex === 0) {
      return { model: closeOverlay(model), effects: [{ type: "action", action: "complete" }] };
    }
    return { model: closeOverlay(model), effects: [] };
  }
  if (model.overlay === "confirmCodex") {
    if (model.overlayIndex === 0) {
      return { model: closeOverlay(model), effects: [{ type: "action", action: "codex" }] };
    }
    return { model: closeOverlay(model), effects: [] };
  }
  if (model.overlay === "obsidianSettings") {
    const actions = Array.isArray(model.overlayData.actions)
      ? model.overlayData.actions.filter(isRecord)
      : [];
    const action = actions[model.overlayIndex];
    const actionId = typeof action?.id === "string" ? action.id : "close";
    if (actionId === "close") {
      return { model: closeOverlay(model), effects: [] };
    }
    return {
      model,
      effects: [{
        type: "obsidianAction",
        action: actionId,
        vaultPath: typeof action?.vaultPath === "string" ? action.vaultPath : undefined
      }]
    };
  }
  if (model.overlay === "noteInput") {
    if (model.overlayFieldIndex === 3) {
      return { model: closeOverlay(model), effects: [] };
    }
    if (model.overlayFieldIndex === 2) {
      return submitNote(model);
    }
    return { model: moveFieldIndex(model, 1), effects: [] };
  }
  if (model.overlay === "verifyInput") {
    if (model.overlayFieldIndex === 2) {
      return { model: closeOverlay(model), effects: [] };
    }
    return submitVerify(model);
  }
  if (model.overlay === "followUpInput") {
    if (model.overlayFieldIndex === 2) {
      return { model: closeOverlay(model), effects: [] };
    }
    return submitFollowUp(model);
  }
  if (model.overlay === "logPreview" || model.overlay === "wikiList") {
    return { model: closeOverlay(model), effects: [] };
  }
  if (model.focusRegion === "prompt") {
    return submitPrompt(model);
  }
  if (model.focusRegion === "runs") {
    if (model.selectedRunIndex < 0) {
      return { model: { ...model, notice: "No runs yet. Type a prompt to start." }, effects: [] };
    }
    return {
      model: {
        ...setTuiOverlay(model, "runPicker", {}),
        overlayIndex: Math.max(0, model.selectedRunIndex)
      },
      effects: []
    };
  }
  if (model.focusRegion === "selectedRun") {
    return {
      model: setTuiOverlay(model, "actionMenu", {}),
      effects: []
    };
  }
  if (model.focusRegion === "actions") {
    return openAction(model, currentActionFromModel(model).id);
  }
  return { model, effects: [] };
}

/**
 * @param {TuiModel} model
 * @param {TuiIntent} intent
 * @returns {TuiReduction}
 */
export function reduceTuiIntent(model, intent) {
  if (intent.type === "quit") {
    return { model, effects: [{ type: "quit" }] };
  }
  if (intent.type === "refresh") {
    if (model.overlay) {
      return { model, effects: [] };
    }
    return { model, effects: [{ type: "refresh" }] };
  }
  if (intent.type === "close") {
    return { model: closeOverlay(model), effects: [] };
  }
  if (intent.type === "focusNext") {
    if (model.overlay && isTuiTextOverlay(model.overlay)) {
      return { model: moveFieldIndex(model, 1), effects: [] };
    }
    if (model.overlay) {
      return { model, effects: [] };
    }
    return { model: moveFocus(model, 1), effects: [] };
  }
  if (intent.type === "focusPrevious") {
    if (model.overlay && isTuiTextOverlay(model.overlay)) {
      return { model: moveFieldIndex(model, -1), effects: [] };
    }
    if (model.overlay) {
      return { model, effects: [] };
    }
    return { model: moveFocus(model, -1), effects: [] };
  }
  if (intent.type === "moveLeft") {
    if (model.overlay && !isTuiTextOverlay(model.overlay)) {
      return { model, effects: [] };
    }
    return { model: model.overlay && isTuiTextOverlay(model.overlay) ? moveFieldIndex(model, -1) : moveFocus(model, -1), effects: [] };
  }
  if (intent.type === "moveRight") {
    if (model.overlay && !isTuiTextOverlay(model.overlay)) {
      return { model, effects: [] };
    }
    return { model: model.overlay && isTuiTextOverlay(model.overlay) ? moveFieldIndex(model, 1) : moveFocus(model, 1), effects: [] };
  }
  if (intent.type === "moveUp" || intent.type === "moveDown") {
    const delta = intent.type === "moveDown" ? 1 : -1;
    if (model.overlay === "runPicker") {
      const count = Number(intent.runCount ?? 0);
      return { model: moveOverlayIndex(model, delta, count), effects: [] };
    }
    if (model.overlay === "actionMenu") {
      return { model: moveOverlayIndex(model, delta, TUI_ACTIONS.length), effects: [] };
    }
    if (model.overlay === "agentPicker") {
      return { model: moveOverlayIndex(model, delta, AGENT_OPTIONS.length), effects: [] };
    }
    if (model.overlay === "confirmComplete" || model.overlay === "confirmCodex") {
      return { model: moveOverlayIndex(model, delta, 2), effects: [] };
    }
    if (model.overlay === "obsidianSettings") {
      const count = Array.isArray(model.overlayData.actions) ? model.overlayData.actions.length : 0;
      return { model: moveOverlayIndex(model, delta, count), effects: [] };
    }
    if (model.overlay && isTuiTextOverlay(model.overlay)) {
      return { model: moveFieldIndex(model, delta), effects: [] };
    }
    if (model.focusRegion === "runs") {
      const count = Number(intent.runCount ?? 0);
      const selectedRunIndex = count ? clamp(model.selectedRunIndex + delta, 0, count - 1) : -1;
      return {
        model: {
          ...model,
          selectedRunIndex,
          selectedRunId: null
        },
        effects: [{ type: "selectRunIndex", index: selectedRunIndex }]
      };
    }
    if (model.focusRegion === "actions") {
      return {
        model: {
          ...model,
          selectedActionIndex: clamp(model.selectedActionIndex + delta, 0, TUI_ACTIONS.length - 1)
        },
        effects: []
      };
    }
    return { model, effects: [] };
  }
  if (intent.type === "open") {
    return openCurrent(model);
  }
  if (intent.type === "appendText") {
    return { model: appendText(model, String(intent.text ?? "")), effects: [] };
  }
  if (intent.type === "deleteText") {
    return { model: deleteText(model), effects: [] };
  }
  if (intent.type === "action") {
    if (model.overlay) {
      return { model, effects: [] };
    }
    return openAction(model, String(intent.action));
  }
  if (intent.type === "selectRunShortcut") {
    if (model.overlay) {
      return { model, effects: [] };
    }
    const index = Number(intent.index);
    return {
      model: {
        ...model,
        selectedRunIndex: index,
        selectedRunId: null,
        focusRegion: "runs"
      },
      effects: [{ type: "selectRunIndex", index }]
    };
  }
  return { model, effects: [] };
}

/** @param {unknown} value */
export function isTuiModel(value) {
  if (!isRecord(value)) {
    return false;
  }
  return typeof value.focusRegion === "string" && Object.hasOwn(value, "selectedRunIndex");
}
