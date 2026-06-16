import { TUI_ACTIONS } from "./tui-actions.js";

const RED = "\x1b[38;5;167m";
const DIM_RED = "\x1b[38;5;88m";
const YELLOW = "\x1b[38;5;220m";
const DIM_YELLOW = "\x1b[38;5;178m";
const GREEN = "\x1b[38;5;114m";
const MUTED = "\x1b[2m";
const RESET = "\x1b[0m";
const DEFAULT_WIDTH = 92;
const MIN_WIDTH = 72;
const MAX_WIDTH = 120;
const RUN_PICKER_VISIBLE_LIMIT = 12;
const PHASES = ["intake", "plan", "act", "verify", "stop"];
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

/** @param {string} value */
function stripAnsi(value) {
  return value.replace(/\x1b\[[0-9;]*m/g, "");
}

/** @param {string} character */
function characterWidth(character) {
  const code = character.codePointAt(0) ?? 0;
  if (
    (code >= 0x1100 && code <= 0x115f) ||
    (code >= 0x2329 && code <= 0x232a) ||
    (code >= 0x2e80 && code <= 0xa4cf) ||
    (code >= 0xac00 && code <= 0xd7a3) ||
    (code >= 0xf900 && code <= 0xfaff) ||
    (code >= 0xfe10 && code <= 0xfe19) ||
    (code >= 0xfe30 && code <= 0xfe6f) ||
    (code >= 0xff00 && code <= 0xff60) ||
    (code >= 0xffe0 && code <= 0xffe6)
  ) {
    return 2;
  }
  return 1;
}

/** @param {string} value */
function visibleWidth(value) {
  let width = 0;
  for (const character of stripAnsi(value)) {
    width += characterWidth(character);
  }
  return width;
}

/**
 * @param {string} value
 * @param {string} code
 * @param {boolean} enabled
 */
export function colorize(value, code, enabled) {
  return enabled ? `${code}${value}${RESET}` : value;
}

/**
 * @param {number | undefined} width
 */
function normalizeWidth(width) {
  if (!Number.isFinite(width)) {
    return DEFAULT_WIDTH;
  }
  return Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, Math.floor(/** @type {number} */ (width))));
}

/**
 * @param {number | undefined} width
 */
function layoutForWidth(width) {
  const frameWidth = normalizeWidth(width);
  const gap = 2;
  const paneWidth = Math.floor((frameWidth - gap) / 2);
  return { frameWidth, gap, paneWidth };
}

/**
 * @param {string} value
 * @param {number} width
 */
function fit(value, width) {
  const visible = stripAnsi(value);
  if (visibleWidth(visible) <= width) {
    return value;
  }
  let fitted = "";
  let used = 0;
  for (const character of visible) {
    const next = characterWidth(character);
    if (used + next > width - 3) {
      break;
    }
    fitted += character;
    used += next;
  }
  return `${fitted}...`;
}

/**
 * @param {string} value
 * @param {number} width
 */
function hardWrap(value, width) {
  /** @type {string[]} */
  const lines = [];
  let current = "";
  let used = 0;
  for (const character of value) {
    const next = characterWidth(character);
    if (current && used + next > width) {
      lines.push(current);
      current = "";
      used = 0;
    }
    current += character;
    used += next;
  }
  if (current) {
    lines.push(current);
  }
  return lines;
}

/**
 * @param {string} value
 * @param {number} width
 */
function wrapLine(value, width) {
  const visible = stripAnsi(value);
  if (visibleWidth(visible) <= width) {
    return [value];
  }
  /** @type {string[]} */
  const lines = [];
  let current = "";
  for (const word of visible.split(" ")) {
    const candidate = current ? `${current} ${word}` : word;
    if (visibleWidth(candidate) <= width) {
      current = candidate;
      continue;
    }
    if (current) {
      lines.push(current);
    }
    if (visibleWidth(word) > width) {
      const chunks = hardWrap(word, width);
      lines.push(...chunks.slice(0, -1));
      current = chunks.at(-1) ?? "";
    } else {
      current = word;
    }
  }
  if (current) {
    lines.push(current);
  }
  return lines.length ? lines : [""];
}

/**
 * @param {string} value
 * @param {number} width
 */
function padVisible(value, width) {
  const length = visibleWidth(value);
  return `${value}${" ".repeat(Math.max(0, width - length))}`;
}

/**
 * @param {string} title
 * @param {string[]} lines
 * @param {{ width?: number, color?: boolean, dim?: boolean, focused?: boolean }} [options]
 */
function renderBox(title, lines, { width = DEFAULT_WIDTH, color = false, dim = false, focused = false } = {}) {
  const label = title ? ` ${focused ? "▶ " : ""}${title} ` : "";
  const borderCode = focused ? RED : dim ? DIM_YELLOW : YELLOW;
  const top = `╭${label}${"─".repeat(Math.max(0, width - visibleWidth(label) - 2))}╮`;
  const bottom = `╰${"─".repeat(Math.max(0, width - 2))}╯`;
  const contentWidth = width - 4;
  const wrappedLines = (lines.length ? lines : [""]).flatMap((line) => wrapLine(line, contentWidth));
  const body = wrappedLines.map((line) => {
    const fitted = fit(line, contentWidth);
    return `│ ${padVisible(fitted, contentWidth)} │`;
  });
  return [
    colorize(top, borderCode, color),
    ...body,
    colorize(bottom, borderCode, color)
  ].join("\n");
}

/**
 * @param {string} label
 * @param {{ color?: boolean, active?: boolean }} [options]
 */
function renderButton(label, { color = false, active = false } = {}) {
  return colorize(`[ ${label} ]`, active ? YELLOW : DIM_YELLOW, color);
}

/**
 * @param {string} label
 * @param {string} value
 * @param {{ color?: boolean, tone?: "hot" | "warm" | "good" | "muted" }} [options]
 */
function renderPill(label, value, { color = false, tone = "warm" } = {}) {
  const code = tone === "good"
    ? GREEN
    : tone === "hot"
      ? RED
      : tone === "muted"
        ? MUTED
        : DIM_YELLOW;
  return colorize(`${label}: ${value}`, code, color);
}

/**
 * @param {string[]} leftLines
 * @param {string[]} rightLines
 * @param {{ color?: boolean, width?: number, leftFocused?: boolean, rightFocused?: boolean }} [options]
 */
function renderSplitPanels(leftLines, rightLines, { color = false, width, leftFocused = false, rightFocused = false } = {}) {
  const layout = layoutForWidth(width);
  const left = renderBox("Run Stack", leftLines, { width: layout.paneWidth, color, focused: leftFocused }).split("\n");
  const right = renderBox("Selected Run", rightLines, { width: layout.paneWidth, color, focused: rightFocused }).split("\n");
  const rows = Math.max(left.length, right.length);
  return Array.from({ length: rows }, (_, index) => {
    return `${padVisible(left[index] ?? "", layout.paneWidth)}${" ".repeat(layout.gap)}${right[index] ?? ""}`;
  }).join("\n");
}

/**
 * @param {string} value
 * @param {number} maxLength
 */
function truncate(value, maxLength) {
  return value.length <= maxLength ? value : `${value.slice(0, maxLength - 3)}...`;
}

/**
 * @param {string} value
 * @param {number} width
 */
function truncateVisible(value, width) {
  if (visibleWidth(value) <= width) {
    return value;
  }
  let fitted = "";
  let used = 0;
  for (const character of value) {
    const next = characterWidth(character);
    if (used + next > width - 3) {
      break;
    }
    fitted += character;
    used += next;
  }
  return `${fitted}...`;
}

/** @param {string} id */
function compactId(id) {
  if (id.length <= 24) {
    return id;
  }
  return `${id.slice(0, 10)}...${id.slice(-8)}`;
}

/**
 * @param {string | undefined} status
 */
function statusTone(status) {
  if (status === "complete" || status === "completed") {
    return "good";
  }
  if (status === "failed" || status === "blocked") {
    return "hot";
  }
  return "warm";
}

/**
 * @param {string | undefined} phase
 * @param {{ color?: boolean }} [options]
 */
function renderPhaseRail(phase, { color = false } = {}) {
  const current = phase && PHASES.includes(phase) ? phase : null;
  return PHASES.map((item) => {
    if (item === current) {
      return colorize(`[${item}]`, YELLOW, color);
    }
    return colorize(item, MUTED, color);
  }).join(">");
}

/**
 * @param {{ color?: boolean }} [options]
 */
export function renderTuiLogo({ color = false } = {}) {
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
export function shouldUseTuiColor({ isTTY = false, env = process.env }) {
  if (!isTTY) {
    return false;
  }
  if (env.NO_COLOR !== undefined || env.FORCE_COLOR === "0" || env.TERM === "dumb") {
    return false;
  }
  return true;
}

/**
 * @param {string | undefined} value
 * @param {string} fallback
 */
function displayValue(value, fallback = "unknown") {
  return value && value.trim() ? value : fallback;
}

/**
 * @param {{ running?: boolean, occupied?: boolean, unknown?: boolean }} dashboard
 */
function wikiDashboardLabel(dashboard) {
  if (dashboard.running) {
    return "online";
  }
  if (dashboard.unknown) {
    return "unknown";
  }
  if (dashboard.occupied) {
    return "blocked";
  }
  return "off";
}

/**
 * @param {unknown} value
 */
function textValue(value) {
  return typeof value === "string" ? value : "";
}

/**
 * @param {unknown} model
 * @returns {model is {
 *   focusRegion: string,
 *   selectedRunIndex: number,
 *   selectedActionIndex: number,
 *   promptBuffer: string,
 *   promptMode: boolean,
 *   overlay: string | null,
 *   overlayIndex: number,
 *   overlayFieldIndex: number,
 *   overlayData: Record<string, unknown>
 * }}
 */
function hasTuiModel(model) {
  return typeof model === "object" && model !== null && "focusRegion" in model && "selectedRunIndex" in model;
}

/**
 * @param {number} index
 * @param {number} selected
 * @param {{ color?: boolean }} [options]
 */
function rowCursor(index, selected, { color = false } = {}) {
  return index === selected ? colorize("›", RED, color) : colorize(" ", MUTED, color);
}

/**
 * @param {object} snapshot
 * @param {Array<Record<string, unknown> & { id: string, status: string, phase: string, objective: string }>} snapshot.runs
 * @param {Array<unknown>} snapshot.notes
 * @param {{
 *   overlay: string | null,
 *   overlayIndex: number,
 *   overlayFieldIndex: number,
 *   overlayData: Record<string, unknown>
 * }} model
 * @param {{ color?: boolean, width?: number }} [options]
 */
function renderOverlay(snapshot, model, { color = false, width } = {}) {
  if (!model.overlay) {
    return "";
  }
  const layout = layoutForWidth(width);
  const overlayWidth = Math.min(layout.frameWidth, 88);
  if (model.overlay === "runPicker") {
    const selectedIndex = Math.max(0, Math.min(model.overlayIndex, Math.max(0, snapshot.runs.length - 1)));
    const start = Math.max(0, Math.min(
      selectedIndex - Math.floor(RUN_PICKER_VISIBLE_LIMIT / 2),
      Math.max(0, snapshot.runs.length - RUN_PICKER_VISIBLE_LIMIT)
    ));
    const visibleRuns = snapshot.runs.slice(start, start + RUN_PICKER_VISIBLE_LIMIT);
    const rows = snapshot.runs.length
      ? visibleRuns.map((run, offset) => {
          const index = start + offset;
          const status = `${run.status}/${run.phase}`;
          return `${rowCursor(index, model.overlayIndex, { color })} ${index + 1}. ${padVisible(status, 17)} ${truncateVisible(run.objective, overlayWidth - 28)}`;
        })
      : ["No runs yet."];
    return renderBox("Run Picker", [
      "Choose a run with ↑/↓, then press Enter.",
      snapshot.runs.length > RUN_PICKER_VISIBLE_LIMIT
        ? `Showing ${start + 1}-${start + visibleRuns.length} of ${snapshot.runs.length}.`
        : "",
      "",
      ...rows
    ], { width: overlayWidth, color, focused: true });
  }
  if (model.overlay === "actionMenu") {
    const rows = TUI_ACTIONS.map((action, index) => {
      const confirm = action.confirm ? "  confirm" : "";
      return `${rowCursor(index, model.overlayIndex, { color })} ${padVisible(action.label, 12)} ${action.runRequired ? "run" : "global"}${confirm}`;
    });
    return renderBox("Action Menu", [
      "Choose an action with ↑/↓. Enter opens the selected action.",
      "",
      ...rows
    ], { width: overlayWidth, color, focused: true });
  }
  if (model.overlay === "agentPicker") {
    const agents = Array.isArray(model.overlayData.agents) ? model.overlayData.agents : ["codex", "claudecode"];
    return renderBox("Agent Picker", [
      "Select the agent for prepared Loop commands.",
      "",
      ...agents.map((agent, index) => `${rowCursor(index, model.overlayIndex, { color })} ${String(agent)}`)
    ], { width: overlayWidth, color, focused: true });
  }
  if (model.overlay === "confirmComplete") {
    return renderBox("Confirm Complete", [
      "Mark the selected run complete?",
      "This records completion evidence and updates the run state.",
      "",
      `${rowCursor(0, model.overlayIndex, { color })} Confirm`,
      `${rowCursor(1, model.overlayIndex, { color })} Cancel`
    ], { width: overlayWidth, color, focused: true });
  }
  if (model.overlay === "confirmCodex") {
    return renderBox("Confirm Codex", [
      "Open a Codex resume terminal for the selected run?",
      "Loop will launch only after this explicit confirmation.",
      "",
      `${rowCursor(0, model.overlayIndex, { color })} Confirm`,
      `${rowCursor(1, model.overlayIndex, { color })} Cancel`
    ], { width: overlayWidth, color, focused: true });
  }
  if (model.overlay === "noteInput") {
    const title = textValue(model.overlayData.title);
    const body = textValue(model.overlayData.body);
    const validation = textValue(model.overlayData.validation);
    return renderBox("Add Note", [
      "Title and body are both required.",
      "",
      `${rowCursor(0, model.overlayFieldIndex, { color })} Title: ${title || colorize("empty", MUTED, color)}`,
      `${rowCursor(1, model.overlayFieldIndex, { color })} Body: ${body || colorize("empty", MUTED, color)}`,
      "",
      `${rowCursor(2, model.overlayFieldIndex, { color })} Add note`,
      `${rowCursor(3, model.overlayFieldIndex, { color })} Cancel`,
      ...(validation ? ["", colorize(validation, RED, color)] : [])
    ], { width: overlayWidth, color, focused: true });
  }
  if (model.overlay === "verifyInput") {
    const summary = textValue(model.overlayData.summary);
    const validation = textValue(model.overlayData.validation);
    return renderBox("Verification Evidence", [
      "Write the evidence summary.",
      "",
      `${rowCursor(0, model.overlayFieldIndex, { color })} Summary: ${summary || colorize("empty", MUTED, color)}`,
      "",
      `${rowCursor(1, model.overlayFieldIndex, { color })} Save evidence`,
      `${rowCursor(2, model.overlayFieldIndex, { color })} Cancel`,
      ...(validation ? ["", colorize(validation, RED, color)] : [])
    ], { width: overlayWidth, color, focused: true });
  }
  if (model.overlay === "followUpInput") {
    const prompt = textValue(model.overlayData.prompt);
    const validation = textValue(model.overlayData.validation);
    return renderBox("Follow-up Objective", [
      "Prepare a connected Loop command for the selected run.",
      "",
      `${rowCursor(0, model.overlayFieldIndex, { color })} Prompt: ${prompt || colorize("empty", MUTED, color)}`,
      "",
      `${rowCursor(1, model.overlayFieldIndex, { color })} Prepare`,
      `${rowCursor(2, model.overlayFieldIndex, { color })} Cancel`,
      ...(validation ? ["", colorize(validation, RED, color)] : [])
    ], { width: overlayWidth, color, focused: true });
  }
  if (model.overlay === "logPreview") {
    const lines = Array.isArray(model.overlayData.lines) ? model.overlayData.lines.map(String) : ["No log output recorded yet."];
    return renderBox("Log Preview", [
      "Esc returns to the console.",
      "",
      ...lines.slice(-18)
    ], { width: overlayWidth, color, focused: true });
  }
  if (model.overlay === "wikiList") {
    const lines = Array.isArray(model.overlayData.lines) ? model.overlayData.lines.map(String) : ["No wiki notes."];
    return renderBox("Wiki Notes", [
      "Esc returns to the console.",
      "",
      ...lines.slice(0, 18)
    ], { width: overlayWidth, color, focused: true });
  }
  return "";
}

/**
 * @param {object} snapshot
 * @param {string} snapshot.stateDir
 * @param {"codex" | "claudecode"} snapshot.agent
 * @param {Array<Record<string, unknown> & { id: string, status: string, phase: string, objective: string, nextAction?: string }>} snapshot.runs
 * @param {Array<unknown>} snapshot.notes
 * @param {{ nodes: Array<unknown>, edges: Array<unknown> }} snapshot.graph
 * @param {{ running?: boolean, occupied?: boolean, unknown?: boolean, url: string }} snapshot.dashboard
 * @param {string} snapshot.notice
 * @param {string | null} snapshot.selectedRunId
 * @param {(Record<string, unknown> & { id: string, status: string, phase: string, objective: string, nextAction?: string }) | null} snapshot.selectedRun
 * @param {{ color?: boolean, width?: number, model?: unknown }} [options]
 */
export function renderTuiHome(snapshot, { color = false, width, model = null } = {}) {
  const layout = layoutForWidth(width);
  const objectiveWidth = Math.max(10, layout.paneWidth - 30);
  const tuiModel = hasTuiModel(model) ? model : null;
  const focused = /** @param {string} region */ (region) => tuiModel?.focusRegion === region && !tuiModel.overlay;
  const selectedRunIndex = tuiModel?.selectedRunIndex ?? snapshot.runs.findIndex((run) => run.id === snapshot.selectedRunId);
  const runRows = snapshot.runs.length === 0
    ? [
        "Ready for the first Loop run.",
        "Prompt input starts a new objective."
      ]
    : snapshot.runs.slice(0, 8).map((run, index) => {
        const marker = index === selectedRunIndex
          ? colorize(focused("runs") ? "›" : ">", focused("runs") ? RED : YELLOW, color)
          : colorize(" ", MUTED, color);
        const status = renderPill(run.status.toUpperCase(), run.phase, {
          color,
          tone: statusTone(run.status)
        });
        const objective = truncateVisible(run.objective, objectiveWidth);
        return `${marker} ${index + 1}  ${padVisible(status, 18)} ${objective}`;
      });
  const selectedLines = snapshot.selectedRun
    ? [
        `${renderPill("Run", compactId(snapshot.selectedRun.id), { color, tone: "muted" })}`,
        `${renderPill("Status", `${snapshot.selectedRun.status}/${snapshot.selectedRun.phase}`, {
          color,
          tone: statusTone(snapshot.selectedRun.status)
        })}`,
        `Phase: ${renderPhaseRail(snapshot.selectedRun.phase, { color })}`,
        `Objective: ${snapshot.selectedRun.objective}`,
        `${colorize("Next:", YELLOW, color)} ${displayValue(snapshot.selectedRun.nextAction)}`,
        "Enter opens actions for this run."
      ]
    : [
        "No run selected.",
        "Prompt mode: new objective.",
        "Recent runs will appear on the left."
      ];
  const wikiStatus = wikiDashboardLabel(snapshot.dashboard);
  const selectedHint = snapshot.selectedRunId ? compactId(snapshot.selectedRunId) : "new objective";
  const promptBuffer = tuiModel?.promptBuffer ?? "";
  const promptLines = [
    snapshot.selectedRunId
      ? `Follow-up target: ${selectedHint}`
      : "Mode: new Loop objective",
    snapshot.selectedRun
      ? `Current next action: ${displayValue(snapshot.selectedRun.nextAction)}`
      : "Enter a goal and Loop will prepare the run.",
    "",
    `${colorize("Prompt ›", focused("prompt") ? RED : YELLOW, color)} ${
      promptBuffer
        ? truncateVisible(promptBuffer, layout.frameWidth - 15)
        : colorize("type an objective, or Tab to navigate", MUTED, color)
    }`
  ];
  const harnessLines = [
    [
      renderPill("Agent", snapshot.agent, { color }),
      renderPill("Wiki dashboard", wikiStatus, {
        color,
        tone: wikiStatus === "online" ? "good" : wikiStatus === "blocked" ? "hot" : "warm"
      }),
      renderPill("Selected", selectedHint, { color, tone: snapshot.selectedRunId ? "warm" : "muted" })
    ].join("   "),
    [
      renderPill("Runs", String(snapshot.runs.length), { color, tone: "muted" }),
      renderPill("Notes", String(snapshot.notes.length), { color, tone: "muted" }),
      renderPill("Graph", `${snapshot.graph.nodes.length}/${snapshot.graph.edges.length}`, { color, tone: "muted" }),
      `Focus ${tuiModel?.focusRegion ?? "prompt"}`,
      `Dashboard ${snapshot.dashboard.url}`
    ].join("   ")
  ];
  const selectedActionIndex = tuiModel?.selectedActionIndex ?? 0;
  const actionLines = [
    TUI_ACTIONS.slice(0, 4).map((action, offset) => renderButton(action.label, {
      color,
      active: focused("actions") && selectedActionIndex === offset
    })).join(" "),
    TUI_ACTIONS.slice(4, 8).map((action, offset) => renderButton(action.label, {
      color,
      active: focused("actions") && selectedActionIndex === offset + 4
    })).join(" "),
    TUI_ACTIONS.slice(8).map((action, offset) => renderButton(action.label, {
      color,
      active: focused("actions") && selectedActionIndex === offset + 8
    })).join(" ")
  ];
  const notice = snapshot.notice
    ? renderBox("Last Event", [snapshot.notice], { width: layout.frameWidth, color, dim: true })
    : "";
  const sections = [
    colorize("LOOP  Prompt Console", YELLOW, color),
    colorize("Loop Prompt Console · Goal-driven agent harness", DIM_YELLOW, color),
    "",
    renderBox("Prompt", promptLines, { width: layout.frameWidth, color, focused: focused("prompt") }),
    "",
    renderBox("Harness Status", harnessLines, { width: layout.frameWidth, color, dim: true, focused: focused("status") }),
    "",
    renderSplitPanels(runRows, selectedLines, {
      width: layout.frameWidth,
      color,
      leftFocused: focused("runs"),
      rightFocused: focused("selectedRun")
    }),
    "",
    renderBox("Action Bar", actionLines, { width: layout.frameWidth, color, dim: true, focused: focused("actions") })
  ];
  const overlay = tuiModel ? renderOverlay(snapshot, tuiModel, { color, width: layout.frameWidth }) : "";
  if (overlay) {
    sections.push("", overlay);
  }
  if (notice) {
    sections.push("", notice);
  }
  sections.push("", colorize("Tab/Shift+Tab focus · ↑/↓ move · Enter open/send · Esc back · Ctrl+C quit", MUTED, color), "");
  return sections.join("\n");
}

/**
 * @param {object} snapshot
 * @param {string} [snapshot.stateDir]
 * @param {"codex" | "claudecode"} snapshot.agent
 * @param {Array<unknown>} [snapshot.runs]
 * @param {Array<unknown>} snapshot.notes
 * @param {{ nodes: Array<unknown>, edges: Array<unknown> }} snapshot.graph
 * @param {{ running?: boolean, occupied?: boolean, unknown?: boolean, url?: string }} snapshot.dashboard
 * @param {string} [snapshot.notice]
 * @param {string | null} [snapshot.selectedRunId]
 * @param {(Record<string, unknown> & { id: string, objective: string, nextAction?: string, status: string, phase: string, session?: unknown }) | null} snapshot.selectedRun
 * @param {{ runId: string, frame?: number, logTail?: string, color?: boolean, width?: number }} options
 */
export function renderTuiProcessing(snapshot, {
  runId,
  frame = 0,
  logTail = "",
  color = false,
  width
}) {
  const layout = layoutForWidth(width);
  const selected = snapshot.selectedRun;
  const spinner = ["|", "/", "-", "\\"][frame % 4];
  const session = selected && typeof selected.session === "object" && selected.session !== null
    ? /** @type {Record<string, unknown>} */ (selected.session)
    : {};
  const pid = typeof session.pid === "number" ? String(session.pid) : "pending";
  const status = selected ? `${selected.status}/${selected.phase}` : "starting";
  const next = selected ? selected.nextAction : "waiting for run state";
  const objective = selected ? selected.objective : runId;
  const log = logTail.trim()
    ? logTail.trim().split("\n").slice(-18).join("\n")
    : "Waiting for agent output...";
  const wikiStatus = wikiDashboardLabel(snapshot.dashboard);
  const logLines = log.split("\n").slice(-18);
  return [
    colorize("LOOP  Processing Console", YELLOW, color),
    colorize("Processing live agent run · Live agent harness", DIM_YELLOW, color),
    "",
    renderBox("Prompt", [
      `${colorize(spinner, YELLOW, color)} Agent is working on the current Loop objective.`,
      `Objective: ${truncateVisible(objective, Math.max(40, layout.frameWidth - 16))}`,
      `Phase: ${selected ? renderPhaseRail(selected.phase, { color }) : colorize("starting", MUTED, color)}`,
      "",
      `${colorize("Prompt ›", YELLOW, color)} ${colorize("locked until this run exits", MUTED, color)}`
    ], { width: layout.frameWidth, color }),
    "",
    renderBox("Harness Status", [
      [
        renderPill("Agent", snapshot.agent, { color }),
        renderPill("PID", pid, { color, tone: pid === "pending" ? "muted" : "warm" }),
        renderPill("Wiki dashboard", wikiStatus, {
          color,
          tone: wikiStatus === "online" ? "good" : wikiStatus === "blocked" ? "hot" : "warm"
        })
      ].join("   "),
      `${renderPill("Run", compactId(runId), { color, tone: "muted" })}   ${renderPill("Status", status, {
        color,
        tone: selected ? statusTone(selected.status) : "warm"
      })}`,
      `${colorize("Next:", YELLOW, color)} ${displayValue(next)}`,
      `${renderPill("Wiki", `${snapshot.notes.length} notes`, { color, tone: "muted" })}   ${renderPill("Graph", `${snapshot.graph.nodes.length}/${snapshot.graph.edges.length}`, { color, tone: "muted" })}`
    ], { width: layout.frameWidth, color, dim: true }),
    "",
    renderBox("Live Log", logLines, { width: layout.frameWidth, color, dim: true }),
    "",
    colorize("Ctrl+C stops watching only; the run log remains on disk.", MUTED, color),
    colorize("When the agent exits, Loop returns here as a prompt console.", MUTED, color)
  ].join("\n");
}

export const TUI_PROMPT_COLOR = YELLOW;
