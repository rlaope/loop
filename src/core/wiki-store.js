import { createHash } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";

const DEFAULT_STATE_DIR = ".loop";
const SAFE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const INDEX_FILE = "index.json";
const GRAPH_FILE = "graph.json";

/**
 * @typedef {{ input: number | null, output: number | null, total: number | null, source: "agent-reported" | "estimated" | "unknown" }} WikiTokenUsage
 * @typedef {{ target: string, relationship: string, reason: string }} WikiLink
 * @typedef {{ jsonPath?: string, summaryPath?: string }} WikiRunPaths
 * @typedef {{ agent?: string, status?: string, pid?: number | null, startedAt?: string, endedAt?: string | null, logPath?: string }} WikiSession
 * @typedef {{ id: string, runId?: string, title: string, objective: string, objectiveSlug: string, status: string, phase: string, canonicalNote: string, aiMemory: string, createdAt: string, updatedAt: string, summary: string, tags: string[], links: WikiLink[], tokens: WikiTokenUsage, session?: WikiSession | null }} WikiIndexEntry
 * @typedef {{ version: 1, updatedAt: string, notes: WikiIndexEntry[] }} WikiIndex
 */

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** @param {unknown} error */
function getErrorCode(error) {
  return isRecord(error) && typeof error.code === "string" ? error.code : undefined;
}

/** @param {string} value */
function escapeMarkdown(value) {
  return value.replace(/\|/g, "\\|");
}

/** @param {string} value */
function escapeHtml(value) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** @param {string} value */
function stripMarkdown(value) {
  return value
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/[`*_>#-]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * @param {string} value
 * @param {number} maxLength
 */
function truncateText(value, maxLength) {
  const trimmed = value.trim();
  if (trimmed.length <= maxLength) {
    return trimmed;
  }
  return `${trimmed.slice(0, Math.max(0, maxLength - 1)).trimEnd()}...`;
}

/**
 * @param {string} root
 * @param {string} child
 */
function assertInside(root, child) {
  const base = resolve(root);
  const target = resolve(child);
  if (target !== base && !target.startsWith(`${base}${sep}`)) {
    throw new Error(`Path escapes wiki directory: ${child}`);
  }
}

/**
 * @param {string} id
 */
function assertSafeId(id) {
  if (!SAFE_ID_PATTERN.test(id)) {
    throw new Error(`Unsafe wiki id: ${id}`);
  }
}

/**
 * @param {string} stateDir
 */
export function wikiDir(stateDir = DEFAULT_STATE_DIR) {
  return join(stateDir, "wiki");
}

/**
 * @param {string} stateDir
 */
function wikiPath(stateDir = DEFAULT_STATE_DIR) {
  const root = wikiDir(stateDir);
  return {
    root,
    userDir: join(root, "user"),
    aiDir: join(root, "ai"),
    indexPath: join(root, INDEX_FILE),
    graphPath: join(root, GRAPH_FILE)
  };
}

/** @param {string} text */
function hashText(text) {
  return `sha256:${createHash("sha256").update(text).digest("hex")}`;
}

/** @param {string} value */
function shortHash(value) {
  return createHash("sha256").update(value).digest("hex").slice(0, 8);
}

/**
 * @param {string} value
 */
function compactTimestamp(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new Error(`Invalid run timestamp: ${value}`);
  }
  return date.toISOString().slice(11, 23).replace(/[:.]/g, "");
}

/**
 * @param {string} value
 */
function datePart(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new Error(`Invalid run timestamp: ${value}`);
  }
  return date.toISOString().slice(0, 10);
}

/**
 * @param {import("./run-state.js").LoopRunState} state
 */
export function noteIdForRunState(state) {
  const id = `${datePart(state.createdAt)}-${state.objectiveSlug}-${compactTimestamp(state.createdAt)}Z-${shortHash(state.id)}`;
  assertSafeId(id);
  return id;
}

/**
 * @param {{ stateDir?: string, id: string }} options
 */
export function wikiNotePath({ stateDir = DEFAULT_STATE_DIR, id }) {
  assertSafeId(id);
  const { root, userDir } = wikiPath(stateDir);
  const target = join(userDir, `${id}.md`);
  assertInside(root, target);
  return target;
}

/**
 * @param {{ stateDir?: string, id: string }} options
 */
export function wikiMemoryPath({ stateDir = DEFAULT_STATE_DIR, id }) {
  assertSafeId(id);
  const { root, aiDir } = wikiPath(stateDir);
  const target = join(aiDir, `${id}.json`);
  assertInside(root, target);
  return target;
}

/**
 * @param {{ stateDir?: string }} [options]
 * @returns {Promise<WikiIndex>}
 */
export async function readWikiIndex({ stateDir = DEFAULT_STATE_DIR } = {}) {
  const { indexPath } = wikiPath(stateDir);
  try {
    const parsed = JSON.parse(await readFile(indexPath, "utf8"));
    if (!isRecord(parsed) || parsed.version !== 1 || !Array.isArray(parsed.notes)) {
      throw new Error("wiki index must be a version 1 object with notes");
    }
    return {
      version: 1,
      updatedAt: typeof parsed.updatedAt === "string" ? parsed.updatedAt : new Date(0).toISOString(),
      notes: parsed.notes.filter(isRecord).map((entry) => ({
        id: String(entry.id ?? ""),
        runId: typeof entry.runId === "string" ? entry.runId : undefined,
        title: String(entry.title ?? ""),
        objective: String(entry.objective ?? ""),
        objectiveSlug: String(entry.objectiveSlug ?? ""),
        status: String(entry.status ?? ""),
        phase: String(entry.phase ?? ""),
        canonicalNote: String(entry.canonicalNote ?? ""),
        aiMemory: String(entry.aiMemory ?? ""),
        createdAt: String(entry.createdAt ?? ""),
        updatedAt: String(entry.updatedAt ?? ""),
        summary: String(entry.summary ?? ""),
        tags: Array.isArray(entry.tags) ? entry.tags.map(String) : [],
        links: Array.isArray(entry.links)
          ? entry.links.filter(isRecord).map((link) => ({
              target: String(link.target ?? ""),
              relationship: String(link.relationship ?? ""),
              reason: String(link.reason ?? "")
            }))
          : [],
        tokens: normalizeTokens(entry.tokens),
        session: normalizeSession(entry.session)
      })).filter((entry) => SAFE_ID_PATTERN.test(entry.id))
    };
  } catch (error) {
    if (getErrorCode(error) === "ENOENT") {
      return { version: 1, updatedAt: new Date(0).toISOString(), notes: [] };
    }
    throw error;
  }
}

/**
 * @param {unknown} value
 * @returns {WikiTokenUsage}
 */
function normalizeTokens(value) {
  if (!isRecord(value)) {
    return unknownTokenUsage();
  }
  const source = value.source === "agent-reported" || value.source === "estimated" ? value.source : "unknown";
  return {
    input: typeof value.input === "number" ? value.input : null,
    output: typeof value.output === "number" ? value.output : null,
    total: typeof value.total === "number" ? value.total : null,
    source
  };
}

/**
 * @returns {WikiTokenUsage}
 */
function unknownTokenUsage() {
  return {
    input: null,
    output: null,
    total: null,
    source: "unknown"
  };
}

/**
 * @param {unknown} value
 * @returns {WikiSession | null}
 */
function normalizeSession(value) {
  if (!isRecord(value)) {
    return null;
  }
  return {
    agent: typeof value.agent === "string" ? value.agent : undefined,
    status: typeof value.status === "string" ? value.status : undefined,
    pid: typeof value.pid === "number" ? value.pid : null,
    startedAt: typeof value.startedAt === "string" ? value.startedAt : undefined,
    endedAt: typeof value.endedAt === "string" ? value.endedAt : null,
    logPath: typeof value.logPath === "string" ? value.logPath : undefined
  };
}

/**
 * @param {unknown} state
 * @returns {WikiSession | null}
 */
function sessionFromRunState(state) {
  return isRecord(state) ? normalizeSession(state.session) : null;
}

/** @param {WikiSession | null | undefined} session */
function sessionLabel(session) {
  if (!session) {
    return "not recorded";
  }
  const agent = session.agent ?? "agent";
  if (session.status === "running") {
    return `${agent} running${session.pid ? ` · pid ${session.pid}` : ""}`;
  }
  if (session.status === "exited") {
    return `${agent} exited`;
  }
  if (session.status === "failed_to_start") {
    return `${agent} failed to start`;
  }
  return `${agent} ${session.status ?? "session recorded"}`;
}

/**
 * @param {import("./run-state.js").LoopRunState} state
 */
function statusSummary(state) {
  return `${state.status} run in ${state.phase} phase. Next action: ${state.nextAction}`;
}

/**
 * @param {import("./run-state.js").LoopRunState} state
 */
function narrativeSummary(state) {
  return [
    `This note captures the Loop run for "${state.objective}".`,
    `The run is currently ${state.status} in the ${state.phase} phase, so the most important follow-up is: ${state.nextAction}.`,
    `Use this page as the human-readable source for what the agent was asked to do, what evidence exists, and what still needs judgment before treating the work as complete.`
  ].join(" ");
}

/**
 * @param {import("./run-state.js").LoopRunState} state
 */
function decisionEntries(state) {
  const approvalText = state.approvals.humanApproval
    ? `Write-capable work was approved for scope: ${state.approvals.approvalScope.join(", ") || "write"}.`
    : "No write approval was recorded, so the run should be treated as read-only or pre-action context until later evidence says otherwise.";
  return [
    {
      decision: "Use the objective as the working contract.",
      rationale: `The loop was started with this objective: ${state.objective}`
    },
    {
      decision: "Stop according to the recorded stop condition.",
      rationale: state.stopCondition.description
    },
    {
      decision: "Keep approval and safety state visible.",
      rationale: approvalText
    }
  ];
}

/**
 * @param {import("./run-state.js").LoopRunState} state
 */
function flagEntries(state) {
  /** @type {{ kind: string, text: string, severity: "low" | "medium" | "high" }[]} */
  const flags = [];
  if (state.status !== "complete") {
    flags.push({
      kind: state.status === "failed" || state.status === "unsafe" ? "risk" : "follow_up",
      text: `Run status is ${state.status}; next action is: ${state.nextAction}`,
      severity: state.status === "failed" || state.status === "unsafe" ? "high" : "medium"
    });
  }
  if (state.verificationEvidence.length === 0) {
    flags.push({
      kind: "assumption",
      text: "No verification evidence has been recorded yet.",
      severity: "medium"
    });
  }
  return flags;
}

/**
 * @param {WikiLink} link
 */
function linkTargetId(link) {
  const filename = link.target.split("/").pop() ?? link.target;
  return filename.endsWith(".md") ? filename.slice(0, -3) : filename;
}

/**
 * @param {WikiIndex} index
 * @param {import("./run-state.js").LoopRunState} state
 * @param {string} id
 * @returns {WikiLink[]}
 */
function relatedLinks(index, state, id) {
  return index.notes
    .filter((note) => note.id !== id && note.objectiveSlug === state.objectiveSlug)
    .slice(-5)
    .map((note) => ({
      target: `../user/${note.id}.md`,
      relationship: "continues",
      reason: "Earlier Loop Wiki note for the same objective."
    }));
}

/**
 * @param {import("./run-state.js").LoopRunState} state
 * @param {{ id: string, links: WikiLink[], paths?: WikiRunPaths }} options
 */
export function renderWikiNote(state, { id, links, paths = {} }) {
  const session = sessionFromRunState(state);
  const evidence = state.verificationEvidence.length === 0
    ? "- pending: No verification evidence has been recorded yet."
    : state.verificationEvidence.map((entry) => `- ${entry.status}: ${entry.summary}`).join("\n");
  const flags = flagEntries(state);
  const flagText = flags.length === 0
    ? "No flags recorded."
    : flags.map((flag) => `- ${flag.severity}: ${flag.kind} - ${flag.text}`).join("\n");
  const linkText = links.length === 0
    ? "No related notes yet."
    : links.map((link) => `- [${link.relationship}: previous note ${linkTargetId(link)}](${link.target}) - ${link.reason}`).join("\n");
  const decisions = decisionEntries(state);
  const decisionText = decisions
    .map((entry) => `- ${entry.decision} ${entry.rationale}`)
    .join("\n");
  const technicalRows = [
    ["Run ID", state.id],
    ["Objective slug", state.objectiveSlug],
    ["Phase", state.phase],
    ["Status", state.status],
    ["Agent session", sessionLabel(session)],
    ["Agent log", session?.logPath ?? "Not recorded."],
    ["State JSON", paths.jsonPath ?? "Not provided."],
    ["Run summary", paths.summaryPath ?? "Not provided."]
  ];

  return [
    `# ${state.objective}`,
    "",
    `> Loop Wiki note: ${id}`,
    "",
    "## Narrative Summary",
    "",
    narrativeSummary(state),
    "",
    "## Purpose",
    "",
    `The purpose of this run is to move the project toward: ${state.objective}`,
    "",
    `The current stop rule is: ${state.stopCondition.description}`,
    "",
    "## Decision Log",
    "",
    decisionText,
    "",
    "## Rationale",
    "",
    `The loop records the objective, safety state, run phase, verification evidence, and graph links so a human can recover context without replaying the whole agent conversation. The latest recorded next action is: ${state.nextAction}`,
    "",
    "## Work / Change Summary",
    "",
    statusSummary(state),
    "",
    `Agent session: ${sessionLabel(session)}.`,
    "",
    "## Technical Spec",
    "",
    "| Field | Value |",
    "| --- | --- |",
    ...technicalRows.map(([field, value]) => `| ${escapeMarkdown(field)} | ${escapeMarkdown(value)} |`),
    "",
    "## Verification Evidence",
    "",
    evidence,
    "",
    "## Flags / Risks / Follow-ups",
    "",
    flagText,
    "",
    "## Related Notes",
    "",
    linkText,
    "",
    "## Graph Links",
    "",
    links.length === 0
      ? "This note has no graph edges yet. Future runs with the same objective slug will appear here."
      : links.map((link) => `- ${id} --${link.relationship}--> ${linkTargetId(link)}: ${link.reason}`).join("\n"),
    "",
    "## Token Usage",
    "",
    "Exact token usage is not available from the current run state.",
    "",
    `Budget estimate used: ${state.budget.estimatedTokensUsed}/${state.budget.maxEstimatedTokens} estimated tokens.`,
    "",
    "## Machine Context",
    "",
    `- Run state: ${state.id}`,
    `- Objective slug: ${state.objectiveSlug}`,
    `- Created: ${state.createdAt}`,
    `- Updated: ${state.updatedAt}`,
    ""
  ].join("\n");
}

/**
 * @param {string} markdown
 */
function shortSummaryFromMarkdown(markdown) {
  const paragraph = markdown
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line && !line.startsWith("#") && !line.startsWith(">") && !line.startsWith("|") && !line.startsWith("-"));
  return paragraph ? truncateText(stripMarkdown(paragraph), 180) : "Loop Wiki note.";
}

/**
 * @param {import("./run-state.js").LoopRunState} state
 * @param {{ id: string, noteRelativePath: string, markdown: string, markdownHash: string, generatedMarkdownHash: string, links: WikiLink[], paths?: WikiRunPaths }} options
 */
function buildAiMemory(state, { id, noteRelativePath, markdown, markdownHash, generatedMarkdownHash, links, paths = {} }) {
  const flags = flagEntries(state);
  const decisions = decisionEntries(state);
  const session = sessionFromRunState(state);
  return {
    version: 1,
    id,
    canonicalNote: noteRelativePath,
    derivedFromHash: markdownHash,
    generator: {
      markdownHash: generatedMarkdownHash,
      source: "loop-renderer"
    },
    runIds: [state.id],
    objective: state.objective,
    objectiveSlug: state.objectiveSlug,
    summary: shortSummaryFromMarkdown(markdown),
    status: state.status,
    phase: state.phase,
    session,
    decisions,
    technicalSpec: {
      stack: [],
      entrypoints: [],
      changedFiles: [],
      commands: [],
      runState: paths.jsonPath ?? null,
      runSummary: paths.summaryPath ?? null
    },
    verification: {
      commands: [],
      evidence: state.verificationEvidence.map((entry) => ({
        kind: entry.kind,
        status: entry.status,
        summary: entry.summary,
        recordedAt: entry.recordedAt
      })),
      gaps: state.verificationEvidence.length === 0 ? ["No verification evidence recorded yet."] : []
    },
    flags,
    graph: {
      tags: ["loop-wiki", state.objectiveSlug, state.status],
      links
    },
    tokens: unknownTokenUsage(),
    budgetEstimate: {
      estimatedTokensUsed: state.budget.estimatedTokensUsed,
      maxEstimatedTokens: state.budget.maxEstimatedTokens,
      source: "loop-budget-estimate"
    },
    createdAt: state.createdAt,
    updatedAt: state.updatedAt
  };
}

/**
 * @param {string} memoryPath
 */
async function readPreviousGeneratedMarkdownHash(memoryPath) {
  try {
    const parsed = JSON.parse(await readFile(memoryPath, "utf8"));
    if (!isRecord(parsed)) {
      return null;
    }
    if (isRecord(parsed.generator) && typeof parsed.generator.markdownHash === "string") {
      return parsed.generator.markdownHash;
    }
    return typeof parsed.generatedMarkdownHash === "string" ? parsed.generatedMarkdownHash : null;
  } catch (error) {
    if (getErrorCode(error) === "ENOENT") {
      return null;
    }
    throw error;
  }
}

/**
 * @param {string} notePath
 */
async function readExistingMarkdown(notePath) {
  try {
    return await readFile(notePath, "utf8");
  } catch (error) {
    if (getErrorCode(error) === "ENOENT") {
      return null;
    }
    throw error;
  }
}

/**
 * @param {WikiIndex} index
 * @param {WikiIndexEntry} entry
 * @param {string} now
 * @returns {WikiIndex}
 */
function upsertIndexEntry(index, entry, now) {
  const notes = index.notes.filter((note) => note.id !== entry.id);
  notes.push(entry);
  notes.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
  return {
    version: 1,
    updatedAt: now,
    notes
  };
}

/**
 * @param {WikiIndex} index
 * @param {string} now
 */
function buildGraph(index, now) {
  const edges = index.notes.flatMap((note) => note.links.map((link) => ({
    source: note.id,
    target: linkTargetId(link),
    relationship: link.relationship,
    reason: link.reason
  })));
  return {
    version: 1,
    updatedAt: now,
    nodes: index.notes.map((note) => ({
      id: note.id,
      label: note.title,
      path: note.canonicalNote,
      status: note.status,
      tags: note.tags
    })),
    edges
  };
}

/**
 * @param {import("./run-state.js").LoopRunState} state
 * @param {{ stateDir?: string, paths?: WikiRunPaths, now?: Date }} [options]
 */
export async function writeWikiForRunState(state, { stateDir = DEFAULT_STATE_DIR, paths = {}, now = new Date() } = {}) {
  const id = noteIdForRunState(state);
  const { root, userDir, aiDir, indexPath, graphPath } = wikiPath(stateDir);
  await mkdir(userDir, { recursive: true });
  await mkdir(aiDir, { recursive: true });

  const index = await readWikiIndex({ stateDir });
  const links = relatedLinks(index, state, id);
  const notePath = wikiNotePath({ stateDir, id });
  const memoryPath = wikiMemoryPath({ stateDir, id });
  const noteRelativePath = relative(aiDir, notePath);
  const aiRelativeFromRoot = relative(root, memoryPath);
  const noteRelativeFromRoot = relative(root, notePath);
  const generatedMarkdown = renderWikiNote(state, { id, links, paths });
  const generatedMarkdownHash = hashText(generatedMarkdown);
  const existingMarkdown = await readExistingMarkdown(notePath);
  const previousGeneratedMarkdownHash = await readPreviousGeneratedMarkdownHash(memoryPath);
  const shouldRefreshMarkdown = (
    existingMarkdown === null ||
    (previousGeneratedMarkdownHash !== null && hashText(existingMarkdown) === previousGeneratedMarkdownHash)
  );
  const markdown = shouldRefreshMarkdown ? generatedMarkdown : existingMarkdown;
  const markdownHash = hashText(markdown);
  const memory = buildAiMemory(state, {
    id,
    noteRelativePath,
    markdown,
    markdownHash,
    generatedMarkdownHash,
    links,
    paths
  });

  if (shouldRefreshMarkdown) {
    await writeFile(notePath, markdown);
  }
  await writeFile(memoryPath, `${JSON.stringify(memory, null, 2)}\n`);

  const entry = {
    id,
    runId: state.id,
    title: state.objective,
    objective: state.objective,
    objectiveSlug: state.objectiveSlug,
    status: state.status,
    phase: state.phase,
    canonicalNote: noteRelativeFromRoot,
    aiMemory: aiRelativeFromRoot,
    createdAt: state.createdAt,
    updatedAt: state.updatedAt,
    summary: memory.summary,
    tags: memory.graph.tags,
    links,
    tokens: memory.tokens,
    session: memory.session
  };
  const nextIndex = upsertIndexEntry(index, entry, now.toISOString());
  await writeFile(indexPath, `${JSON.stringify(nextIndex, null, 2)}\n`);
  await writeFile(graphPath, `${JSON.stringify(buildGraph(nextIndex, now.toISOString()), null, 2)}\n`);

  return {
    id,
    notePath,
    memoryPath,
    indexPath,
    graphPath
  };
}

/**
 * @param {{ stateDir?: string }} [options]
 */
export async function listWikiNotes({ stateDir = DEFAULT_STATE_DIR } = {}) {
  const index = await readWikiIndex({ stateDir });
  return index.notes;
}

/**
 * @param {string} id
 * @param {{ stateDir?: string }} [options]
 */
export async function readWikiNote(id, { stateDir = DEFAULT_STATE_DIR } = {}) {
  const notePath = wikiNotePath({ stateDir, id });
  return {
    id,
    path: notePath,
    markdown: await readFile(notePath, "utf8")
  };
}

/**
 * @param {string} id
 * @param {{ stateDir?: string }} [options]
 */
export async function deleteWikiNote(id, { stateDir = DEFAULT_STATE_DIR } = {}) {
  assertSafeId(id);
  const { indexPath, graphPath } = wikiPath(stateDir);
  const index = await readWikiIndex({ stateDir });
  /** @type {WikiIndex} */
  const nextIndex = {
    version: 1,
    updatedAt: new Date().toISOString(),
    notes: index.notes.filter((note) => note.id !== id)
  };
  await rm(wikiNotePath({ stateDir, id }), { force: true });
  await rm(wikiMemoryPath({ stateDir, id }), { force: true });
  await writeFile(indexPath, `${JSON.stringify(nextIndex, null, 2)}\n`);
  await writeFile(graphPath, `${JSON.stringify(buildGraph(nextIndex, nextIndex.updatedAt), null, 2)}\n`);
  return { deleted: index.notes.some((note) => note.id === id), id };
}

/**
 * @param {WikiIndexEntry[]} notes
 */
export function renderWikiList(notes) {
  if (notes.length === 0) {
    return "No Loop Wiki notes found.\n";
  }
  return `${[
    "| ID | Status | Objective | Updated |",
    "| --- | --- | --- | --- |",
    ...notes.map((note) => `| ${escapeMarkdown(note.id)} | ${escapeMarkdown(note.status)} | ${escapeMarkdown(note.objective)} | ${escapeMarkdown(note.updatedAt)} |`)
  ].join("\n")}\n`;
}

/**
 * @param {string} value
 */
function statusClass(value) {
  if (value === "complete") {
    return "status-complete";
  }
  if (value === "failed" || value === "unsafe" || value === "blocked") {
    return "status-risk";
  }
  return "status-active";
}

/**
 * @param {WikiTokenUsage} tokens
 */
function tokenLabel(tokens) {
  if (tokens.total !== null) {
    return `${tokens.total} total`;
  }
  return tokens.source === "unknown" ? "unknown" : tokens.source;
}

/** @param {string} value */
function safeLinkHref(value) {
  const href = value.trim();
  if (/^(https?:|\/|\.\/|\.\.\/|#)/i.test(href)) {
    return href;
  }
  return "#";
}

/**
 * @param {string} value
 */
function renderInlineMarkdown(value) {
  return escapeHtml(value)
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_match, label, href) => {
      const safeHref = safeLinkHref(String(href).replace(/&amp;/g, "&"));
      return `<a href="${escapeHtml(safeHref)}">${label}</a>`;
    })
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
}

/**
 * @param {string} line
 */
function splitTableRow(line) {
  const body = line
    .trim()
    .replace(/^\||\|$/g, "");
  /** @type {string[]} */
  const cells = [];
  let current = "";
  for (let index = 0; index < body.length; index += 1) {
    const char = body[index];
    if (char === "\\" && body[index + 1] === "|") {
      current += "|";
      index += 1;
      continue;
    }
    if (char === "|") {
      cells.push(current.trim());
      current = "";
      continue;
    }
    current += char;
  }
  cells.push(current.trim());
  return cells;
}

/**
 * @param {string[]} lines
 * @param {number} index
 */
function renderMarkdownTable(lines, index) {
  const header = splitTableRow(lines[index]);
  let cursor = index + 2;
  const rows = [];
  while (cursor < lines.length && /^\s*\|/.test(lines[cursor])) {
    rows.push(splitTableRow(lines[cursor]));
    cursor += 1;
  }
  const head = header.map((cell) => `<th>${renderInlineMarkdown(cell)}</th>`).join("");
  const body = rows.map((row) => `<tr>${row.map((cell) => `<td>${renderInlineMarkdown(cell)}</td>`).join("")}</tr>`).join("");
  return {
    html: `<table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`,
    nextIndex: cursor
  };
}

/**
 * @param {string[]} lines
 * @param {number} index
 */
function renderMarkdownList(lines, index) {
  let cursor = index;
  const items = [];
  while (cursor < lines.length && /^\s*-\s+/.test(lines[cursor])) {
    items.push(lines[cursor].replace(/^\s*-\s+/, ""));
    cursor += 1;
  }
  return {
    html: `<ul>${items.map((item) => `<li>${renderInlineMarkdown(item)}</li>`).join("")}</ul>`,
    nextIndex: cursor
  };
}

/**
 * @param {string} markdown
 */
function renderMarkdownBody(markdown) {
  const lines = markdown.split(/\r?\n/);
  /** @type {string[]} */
  const html = [];
  let index = 0;
  while (index < lines.length) {
    const line = lines[index];
    const trimmed = line.trim();
    if (!trimmed) {
      index += 1;
      continue;
    }
    if (trimmed.startsWith("```")) {
      const code = [];
      index += 1;
      while (index < lines.length && !lines[index].trim().startsWith("```")) {
        code.push(lines[index]);
        index += 1;
      }
      html.push(`<pre><code>${escapeHtml(code.join("\n"))}</code></pre>`);
      index += 1;
      continue;
    }
    const heading = /^(#{1,6})\s+(.+)$/.exec(trimmed);
    if (heading) {
      const level = Math.min(heading[1].length, 3);
      html.push(`<h${level}>${renderInlineMarkdown(heading[2])}</h${level}>`);
      index += 1;
      continue;
    }
    if (trimmed.startsWith(">")) {
      html.push(`<blockquote>${renderInlineMarkdown(trimmed.replace(/^>\s*/, ""))}</blockquote>`);
      index += 1;
      continue;
    }
    if (/^\s*-\s+/.test(line)) {
      const list = renderMarkdownList(lines, index);
      html.push(list.html);
      index = list.nextIndex;
      continue;
    }
    if (/^\s*\|/.test(line) && lines[index + 1] && /^\s*\|\s*-/.test(lines[index + 1])) {
      const table = renderMarkdownTable(lines, index);
      html.push(table.html);
      index = table.nextIndex;
      continue;
    }
    const paragraph = [trimmed];
    index += 1;
    while (
      index < lines.length &&
      lines[index].trim() &&
      !/^(#{1,6})\s+/.test(lines[index].trim()) &&
      !lines[index].trim().startsWith(">") &&
      !/^\s*-\s+/.test(lines[index]) &&
      !/^\s*\|/.test(lines[index])
    ) {
      paragraph.push(lines[index].trim());
      index += 1;
    }
    html.push(`<p>${renderInlineMarkdown(paragraph.join(" "))}</p>`);
  }
  return html.join("\n");
}

/**
 * @param {WikiIndexEntry[]} notes
 */
function graphEdges(notes) {
  return notes.flatMap((note) => note.links.map((link) => ({
    source: note.id,
    target: linkTargetId(link),
    relationship: link.relationship,
    reason: link.reason
  })));
}

/**
 * @param {WikiIndexEntry[]} notes
 */
function renderGraphSvg(notes) {
  if (notes.length === 0) {
    return "<p>No graph nodes yet. Run Loop once to create the first note.</p>";
  }
  const width = 520;
  const height = 300;
  const centerX = width / 2;
  const centerY = height / 2;
  const radius = Math.min(150, 60 + notes.length * 18);
  const positions = new Map(notes.map((note, index) => {
    const angle = notes.length === 1 ? -Math.PI / 2 : (Math.PI * 2 * index / notes.length) - Math.PI / 2;
    return [note.id, {
      x: centerX + Math.cos(angle) * radius,
      y: centerY + Math.sin(angle) * radius
    }];
  }));
  const edges = graphEdges(notes);
  const edgeHtml = edges.map((edge) => {
    const source = positions.get(edge.source);
    const target = positions.get(edge.target);
    if (!source || !target) {
      return "";
    }
    return `<line x1="${source.x.toFixed(1)}" y1="${source.y.toFixed(1)}" x2="${target.x.toFixed(1)}" y2="${target.y.toFixed(1)}" class="graph-edge"><title>${escapeHtml(edge.relationship)}: ${escapeHtml(edge.reason)}</title></line>`;
  }).join("");
  const nodeHtml = notes.map((note) => {
    const point = positions.get(note.id);
    if (!point) {
      return "";
    }
    const label = truncateText(note.title, 28);
    return `<a href="/notes/${encodeURIComponent(note.id)}" class="graph-node-link"><g class="graph-node ${statusClass(note.status)}">
      <circle cx="${point.x.toFixed(1)}" cy="${point.y.toFixed(1)}" r="18"><title>${escapeHtml(note.title)}</title></circle>
      <text x="${point.x.toFixed(1)}" y="${(point.y + 34).toFixed(1)}" text-anchor="middle">${escapeHtml(label)}</text>
    </g></a>`;
  }).join("");
  return `<svg viewBox="0 0 ${width} ${height}" role="img" aria-label="Loop Wiki graph view">
    <defs>
      <filter id="nodeGlow" x="-80%" y="-80%" width="260%" height="260%">
        <feGaussianBlur stdDeviation="3" result="blur"></feGaussianBlur>
        <feMerge>
          <feMergeNode in="blur"></feMergeNode>
          <feMergeNode in="SourceGraphic"></feMergeNode>
        </feMerge>
      </filter>
    </defs>
    ${edgeHtml}${nodeHtml}
  </svg>`;
}

/**
 * @param {WikiIndexEntry[]} notes
 */
export function renderWikiDashboardHtml(notes) {
  const recent = notes[0];
  const cards = notes.length === 0
    ? "<p>No Loop Wiki notes found. Run <code>loop \"your objective\"</code> to create the first second-brain note.</p>"
    : notes.map((note) => {
        const logLink = note.runId
          ? `<a class="button secondary" href="/runs/${encodeURIComponent(note.runId)}/log">View log</a>`
          : "";
        return `
      <article class="note-card">
        <div class="note-card-header">
          <span class="status ${statusClass(note.status)}">${escapeHtml(note.status)}</span>
          <span>${escapeHtml(note.phase)}</span>
        </div>
        <h3>${escapeHtml(note.title)}</h3>
        <p>${escapeHtml(note.summary)}</p>
        <dl class="meta-grid">
          <dt>Updated</dt><dd>${escapeHtml(note.updatedAt)}</dd>
          <dt>Tokens</dt><dd>${escapeHtml(tokenLabel(note.tokens))}</dd>
          <dt>Agent</dt><dd>${escapeHtml(sessionLabel(note.session))}</dd>
          <dt>Context</dt><dd>${note.links.length === 0 ? "No related notes yet" : `${note.links.length} related note${note.links.length === 1 ? "" : "s"}`}</dd>
        </dl>
        <div class="card-actions">
          <a class="button secondary" href="/notes/${encodeURIComponent(note.id)}">Read note</a>
          ${logLink}
          <form method="post" action="/notes/${encodeURIComponent(note.id)}/delete">
            <button class="button danger" type="submit">Delete note</button>
          </form>
        </div>
      </article>`;
      }).join("\n");
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Loop Wiki</title>
  <style>
    :root { color-scheme: light; --ink: #16181d; --muted: #596070; --line: #d9dee8; --panel: #ffffff; --page: #f5f7fa; --blue: #1f5fbf; --green: #1f7a4d; --red: #b42318; --amber: #9a6700; }
    * { box-sizing: border-box; }
    body { margin: 0; font: 15px/1.55 ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; color: var(--ink); background: var(--page); }
    header { padding: 24px 32px 16px; border-bottom: 1px solid var(--line); background: var(--panel); }
    main { padding: 20px 32px 36px; }
    h1 { margin: 0; font-size: 28px; line-height: 1.1; }
    h2 { margin: 0 0 12px; font-size: 18px; }
    h3 { margin: 8px 0; font-size: 17px; line-height: 1.25; }
    p { margin: 0; color: var(--muted); }
    a { color: var(--blue); text-decoration-thickness: 1px; text-underline-offset: 3px; }
    .subtitle { margin-top: 8px; max-width: 760px; }
    .header-row { display: flex; justify-content: space-between; gap: 16px; align-items: flex-start; }
    .actions { display: flex; gap: 8px; flex-wrap: wrap; justify-content: flex-end; }
    .dashboard-grid { display: grid; gap: 16px; }
    .history-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(280px, 1fr)); gap: 12px; }
    .panel, .note-card { border: 1px solid var(--line); border-radius: 8px; background: var(--panel); }
    .panel { padding: 16px; }
    .note-card { padding: 14px; display: grid; gap: 8px; }
    .note-card-header, .summary-row { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; color: var(--muted); font-size: 13px; }
    .status { display: inline-flex; align-items: center; min-height: 22px; padding: 2px 8px; border-radius: 999px; border: 1px solid var(--line); font-weight: 700; }
    .status-complete { color: var(--green); background: #eef8f1; border-color: #b7dfc2; }
    .status-risk { color: var(--red); background: #fff0ee; border-color: #f5c3bd; }
    .status-active { color: var(--amber); background: #fff7df; border-color: #ead189; }
    .meta-grid { display: grid; grid-template-columns: 78px minmax(0, 1fr); gap: 4px 10px; margin: 12px 0 0; font-size: 13px; }
    .meta-grid dt { color: var(--muted); font-weight: 700; }
    .meta-grid dd { margin: 0; overflow-wrap: anywhere; }
    .button { display: inline-flex; align-items: center; justify-content: center; min-height: 36px; padding: 7px 12px; border-radius: 7px; border: 1px solid var(--blue); background: var(--blue); color: #ffffff; font-weight: 700; text-decoration: none; }
    .button.secondary { justify-self: start; border-color: var(--line); background: #ffffff; color: var(--blue); }
    .button.danger { border-color: #f0c4bf; background: #fff7f6; color: var(--red); cursor: pointer; }
    .card-actions { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
    form { margin: 0; }
    .empty { color: var(--muted); }
    @media (max-width: 760px) { header { padding: 20px 16px 14px; } main { padding: 16px; } .header-row { display: grid; } .actions { justify-content: flex-start; } }
  </style>
</head>
<body>
  <header>
    <div class="header-row">
      <div>
        <h1>Loop Wiki</h1>
        <p class="subtitle">Local second brain for delegated agent work. Read the latest note and scan run history without opening raw files.</p>
      </div>
      <nav class="actions" aria-label="Wiki views">
        <a class="button" href="/graph">Graph View</a>
      </nav>
    </div>
  </header>
  <main>
    <section class="dashboard-grid">
      <section class="panel">
        <h2>Current Reading Context</h2>
        ${recent ? `
          <div class="summary-row">
            <span class="status ${statusClass(recent.status)}">${escapeHtml(recent.status)}</span>
            <span>${escapeHtml(recent.phase)}</span>
            <span>${escapeHtml(sessionLabel(recent.session))}</span>
            <span>${escapeHtml(recent.updatedAt)}</span>
          </div>
          <h3>${escapeHtml(recent.title)}</h3>
          <p>${escapeHtml(recent.summary)}</p>
          <p style="margin-top: 12px;"><a class="button secondary" href="/notes/${encodeURIComponent(recent.id)}">Read current note</a></p>
        ` : "<p class=\"empty\">No notes yet.</p>"}
      </section>
      <section>
        <h2>History Stack</h2>
        <div class="history-grid">${cards}</div>
      </section>
    </section>
  </main>
</body>
</html>`;
}

/**
 * @param {WikiIndexEntry[]} notes
 */
export function renderWikiGraphHtml(notes) {
  const edges = graphEdges(notes);
  const noteById = new Map(notes.map((note) => [note.id, note]));
  const edgeSummary = edges.length === 0
    ? "<p class=\"empty\">No graph links yet. Repeated objectives will connect automatically.</p>"
    : `<ul>${edges.slice(0, 8).map((edge) => {
        const source = noteById.get(edge.source);
        const target = noteById.get(edge.target);
        return `<li><strong>${escapeHtml(source ? truncateText(source.title, 42) : edge.source)}</strong> continues <strong>${escapeHtml(target ? truncateText(target.title, 42) : edge.target)}</strong></li>`;
      }).join("")}</ul>`;
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Loop Wiki Graph</title>
  <style>
    :root { color-scheme: light; --ink: #16181d; --muted: #596070; --line: #d9dee8; --panel: #ffffff; --page: #f5f7fa; --blue: #1f5fbf; --green: #1f7a4d; --red: #b42318; --amber: #9a6700; }
    * { box-sizing: border-box; }
    body { margin: 0; min-height: 100vh; font: 15px/1.55 ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; color: var(--ink); background: var(--page); }
    header { display: flex; justify-content: space-between; gap: 16px; align-items: flex-start; padding: 22px 28px 14px; border-bottom: 1px solid var(--line); background: var(--panel); }
    h1 { margin: 0; font-size: 26px; line-height: 1.1; }
    h2 { margin: 0 0 12px; font-size: 16px; }
    p { margin: 6px 0 0; color: var(--muted); }
    a { color: var(--blue); text-decoration-thickness: 1px; text-underline-offset: 3px; }
    .button { display: inline-flex; align-items: center; justify-content: center; min-height: 36px; padding: 7px 12px; border-radius: 7px; border: 1px solid var(--line); background: #ffffff; color: var(--blue); font-weight: 700; text-decoration: none; }
    main { display: grid; grid-template-columns: minmax(0, 1fr) 300px; gap: 16px; padding: 16px 28px 28px; }
    .graph-stage, .side-panel { border: 1px solid var(--line); border-radius: 8px; background: var(--panel); }
    .graph-stage { min-height: 68vh; overflow: hidden; background: #fbfcfe; }
    .side-panel { padding: 16px; align-self: start; }
    svg { display: block; width: 100%; min-height: 68vh; }
    .graph-edge { stroke: #9babc2; stroke-width: 1.3; }
    .graph-node circle { fill: #ffffff; stroke: var(--blue); stroke-width: 2.4; filter: url(#nodeGlow); }
    .graph-node.status-complete circle { stroke: var(--green); }
    .graph-node.status-risk circle { stroke: var(--red); }
    .graph-node.status-active circle { stroke: var(--amber); }
    .graph-node text { fill: var(--ink); font-size: 11px; pointer-events: none; }
    .empty, li { color: var(--muted); }
    ul { margin: 0; padding-left: 18px; }
    li { margin: 7px 0; }
    @media (max-width: 880px) { header { display: grid; padding: 18px 16px 12px; } main { grid-template-columns: 1fr; padding: 16px; } .graph-stage, svg { min-height: 460px; } }
  </style>
</head>
<body>
  <header>
    <div>
      <h1>Graph View</h1>
      <p>Notes are dots. Lines show repeated or continued Loop context. Click a dot to open the note.</p>
    </div>
    <a class="button" href="/">Back to notes</a>
  </header>
  <main>
    <section class="graph-stage">${renderGraphSvg(notes)}</section>
    <aside class="side-panel">
      <h2>Readable Connections</h2>
      ${edgeSummary}
    </aside>
  </main>
</body>
</html>`;
}

/**
 * @param {string} markdown
 * @param {{ noteId?: string }} [options]
 */
export function renderMarkdownHtml(markdown, { noteId } = {}) {
  const toolbar = noteId
    ? `<nav class="toolbar" aria-label="Note actions">
        <a class="button" href="/">Back to notes</a>
        <form method="post" action="/notes/${encodeURIComponent(noteId)}/delete">
          <button class="button danger" type="submit">Delete note</button>
        </form>
      </nav>`
    : `<nav class="toolbar" aria-label="Note actions"><a class="button" href="/">Back to notes</a></nav>`;
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Loop Wiki Note</title>
  <style>
    :root { --ink: #17191f; --muted: #596070; --line: #d9dee8; --panel: #ffffff; --page: #f6f7fa; --blue: #1f5fbf; }
    * { box-sizing: border-box; }
    body { margin: 0; font: 16px/1.65 ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; color: var(--ink); background: var(--page); }
    main { max-width: 940px; margin: 0 auto; padding: 28px 20px 64px; }
    article { border: 1px solid var(--line); border-radius: 8px; padding: 28px; background: var(--panel); }
    h1 { margin: 0 0 12px; font-size: 32px; line-height: 1.15; }
    h2 { margin: 30px 0 10px; padding-top: 18px; border-top: 1px solid var(--line); font-size: 21px; }
    h3 { margin: 20px 0 8px; font-size: 18px; }
    p { margin: 10px 0; }
    blockquote { margin: 14px 0; padding: 10px 14px; border-left: 4px solid var(--blue); background: #eef4ff; color: #26364f; }
    ul { padding-left: 22px; }
    li { margin: 5px 0; }
    table { width: 100%; border-collapse: collapse; margin: 12px 0; font-size: 14px; }
    th, td { border: 1px solid var(--line); padding: 8px 10px; text-align: left; vertical-align: top; }
    th { background: #f0f3f8; }
    code { padding: 1px 5px; border-radius: 5px; background: #eef1f6; }
    pre { padding: 14px; border-radius: 8px; overflow-x: auto; background: #111827; color: #f8fafc; }
    a { color: var(--blue); text-underline-offset: 3px; }
    .toolbar { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; justify-content: space-between; margin-bottom: 12px; }
    .button { display: inline-flex; align-items: center; justify-content: center; min-height: 36px; padding: 7px 12px; border-radius: 7px; border: 1px solid var(--line); background: #ffffff; color: var(--blue); font-weight: 700; text-decoration: none; }
    .button.danger { border-color: #f0c4bf; background: #fff7f6; color: #b42318; cursor: pointer; }
    form { margin: 0; }
    @media (max-width: 760px) { main { padding: 14px; } article { padding: 18px; } h1 { font-size: 26px; } }
  </style>
</head>
<body>
  <main>${toolbar}<article>${renderMarkdownBody(markdown)}</article></main>
</body>
</html>`;
}

/**
 * @param {{ id: string, log: string }} input
 */
export function renderRunLogHtml({ id, log }) {
  const content = log.trim() ? escapeHtml(log) : "No log output recorded yet.";
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Loop Run Log</title>
  <style>
    :root { --ink: #17191f; --muted: #596070; --line: #d9dee8; --panel: #ffffff; --page: #f6f7fa; --blue: #1f5fbf; }
    * { box-sizing: border-box; }
    body { margin: 0; font: 15px/1.55 ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; color: var(--ink); background: var(--page); }
    main { max-width: 1100px; margin: 0 auto; padding: 24px 18px 48px; }
    header { display: flex; justify-content: space-between; gap: 12px; align-items: flex-start; margin-bottom: 12px; }
    h1 { margin: 0; font-size: 24px; line-height: 1.2; overflow-wrap: anywhere; }
    p { margin: 6px 0 0; color: var(--muted); }
    pre { margin: 0; min-height: 62vh; padding: 16px; border: 1px solid var(--line); border-radius: 8px; overflow: auto; background: #111827; color: #f8fafc; white-space: pre-wrap; }
    .button { display: inline-flex; align-items: center; justify-content: center; min-height: 36px; padding: 7px 12px; border-radius: 7px; border: 1px solid var(--line); background: #ffffff; color: var(--blue); font-weight: 700; text-decoration: none; white-space: nowrap; }
  </style>
</head>
<body>
  <main>
    <header>
      <div>
        <h1>Run Log</h1>
        <p>${escapeHtml(id)}</p>
      </div>
      <a class="button" href="/">Back to notes</a>
    </header>
    <pre>${content}</pre>
  </main>
</body>
</html>`;
}
