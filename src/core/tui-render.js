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
const PHASES = ["intake", "plan", "act", "verify", "stop"];
const TUI_ACTION_ALIASES = new Map([
  ["l", "logs"],
  ["log", "logs"],
  ["logs", "logs"],
  ["w", "wiki"],
  ["wiki", "wiki"],
  ["d", "dashboard"],
  ["dash", "dashboard"],
  ["dashboard", "dashboard"],
  ["a", "agent"],
  ["agent", "agent"],
  ["n", "note"],
  ["note", "note"],
  ["v", "verify"],
  ["verify", "verify"],
  ["c", "complete"],
  ["complete", "complete"],
  ["f", "follow"],
  ["follow", "follow"],
  ["x", "codex"],
  ["codex", "codex"],
  ["r", "refresh"],
  ["refresh", "refresh"],
  ["q", "quit"],
  ["quit", "quit"],
  ["exit", "quit"]
]);
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
 * @param {{ width?: number, color?: boolean, dim?: boolean }} [options]
 */
function renderBox(title, lines, { width = DEFAULT_WIDTH, color = false, dim = false } = {}) {
  const label = title ? ` ${title} ` : "";
  const borderCode = dim ? DIM_YELLOW : YELLOW;
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
 * @param {{ color?: boolean, width?: number }} [options]
 */
function renderSplitPanels(leftLines, rightLines, { color = false, width } = {}) {
  const layout = layoutForWidth(width);
  const left = renderBox("Run Stack", leftLines, { width: layout.paneWidth, color }).split("\n");
  const right = renderBox("Selected Run", rightLines, { width: layout.paneWidth, color }).split("\n");
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

/** @param {string} value */
export function normalizeTuiAction(value) {
  const lower = value.trim().toLowerCase();
  return TUI_ACTION_ALIASES.get(lower) ?? null;
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
 * @param {{ color?: boolean, width?: number }} [options]
 */
export function renderTuiHome(snapshot, { color = false, width } = {}) {
  const layout = layoutForWidth(width);
  const objectiveWidth = Math.max(10, layout.paneWidth - 30);
  const runRows = snapshot.runs.length === 0
    ? [
        "Ready for the first Loop run.",
        "Prompt input starts a new objective."
      ]
    : snapshot.runs.slice(0, 8).map((run, index) => {
        const marker = run.id === snapshot.selectedRunId
          ? colorize(">", YELLOW, color)
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
        "Inspect: L Logs / W Wiki / X Codex"
      ]
    : [
        "No run selected.",
        "Prompt mode: new objective.",
        "Recent runs will appear on the left."
      ];
  const wikiStatus = wikiDashboardLabel(snapshot.dashboard);
  const selectedHint = snapshot.selectedRunId ? compactId(snapshot.selectedRunId) : "new objective";
  const promptLines = [
    snapshot.selectedRunId
      ? `Follow-up target: ${selectedHint}`
      : "Mode: new Loop objective",
    snapshot.selectedRun
      ? `Current next action: ${displayValue(snapshot.selectedRun.nextAction)}`
      : "Enter a goal and Loop will prepare the run.",
    "",
    `${colorize("Prompt ›", YELLOW, color)} ${colorize("write the objective here", MUTED, color)}`
  ];
  const statusColor = wikiStatus === "online" ? GREEN : DIM_YELLOW;
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
      `Dashboard ${snapshot.dashboard.url}`
    ].join("   ")
  ];
  const actionLines = [
    [
      colorize("Primary", DIM_YELLOW, color),
      renderButton("Enter Send Prompt", { color, active: true }),
      renderButton("D Dashboard", { color, active: wikiStatus === "online" }),
      renderButton("L Logs", { color }),
      renderButton("X Codex", { color })
    ].join(" "),
    [
      colorize("Review ", DIM_YELLOW, color),
      renderButton("W Wiki", { color }),
      renderButton("N Note", { color }),
      renderButton("V Verify", { color }),
      renderButton("F Follow-up", { color })
    ].join(" "),
    [
      colorize("System ", DIM_YELLOW, color),
      renderButton("1-9 Select", { color }),
      renderButton("A Agent", { color }),
      renderButton("C Complete", { color }),
      renderButton("Q Quit", { color })
    ].join(" ")
  ];
  const notice = snapshot.notice
    ? renderBox("Last Event", [snapshot.notice], { width: layout.frameWidth, color, dim: true })
    : "";
  const sections = [
    colorize("LOOP  Prompt Console", YELLOW, color),
    colorize("Loop Prompt Console · Goal-driven agent harness", DIM_YELLOW, color),
    "",
    renderBox("Prompt", promptLines, { width: layout.frameWidth, color }),
    "",
    renderBox("Harness Status", harnessLines, { width: layout.frameWidth, color, dim: true }),
    "",
    renderSplitPanels(runRows, selectedLines, { width: layout.frameWidth, color }),
    "",
    renderBox("Action Bar", actionLines, { width: layout.frameWidth, color, dim: true })
  ];
  if (notice) {
    sections.push("", notice);
  }
  sections.push("", colorize("Enter submits prompt text. Lettered buttons trigger the visible actions.", MUTED, color), "");
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
  const statusColor = wikiStatus === "online" ? GREEN : DIM_YELLOW;
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
