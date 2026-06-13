import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";

const DEFAULT_STATE_DIR = ".loop";
const SAFE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const INDEX_FILE = "index.json";
const GRAPH_FILE = "graph.json";

/**
 * @typedef {{ input: number | null, output: number | null, total: number | null, source: "agent-reported" | "estimated" | "unknown" }} WikiTokenUsage
 * @typedef {{ target: string, relationship: string, reason: string }} WikiLink
 * @typedef {{ jsonPath?: string, summaryPath?: string }} WikiRunPaths
 * @typedef {{ id: string, title: string, objective: string, objectiveSlug: string, status: string, phase: string, canonicalNote: string, aiMemory: string, createdAt: string, updatedAt: string, summary: string, tags: string[], links: WikiLink[], tokens: WikiTokenUsage }} WikiIndexEntry
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
        tokens: normalizeTokens(entry.tokens)
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
 * @param {import("./run-state.js").LoopRunState} state
 */
function statusSummary(state) {
  return `${state.status} run in ${state.phase} phase. Next action: ${state.nextAction}`;
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
      reason: `Previous Loop Wiki note for objective slug ${state.objectiveSlug}.`
    }));
}

/**
 * @param {import("./run-state.js").LoopRunState} state
 * @param {{ id: string, links: WikiLink[], paths?: WikiRunPaths }} options
 */
export function renderWikiNote(state, { id, links, paths = {} }) {
  const evidence = state.verificationEvidence.length === 0
    ? "No evidence recorded yet."
    : state.verificationEvidence.map((entry) => `- ${entry.status}: ${entry.summary}`).join("\n");
  const flags = flagEntries(state);
  const flagText = flags.length === 0
    ? "No flags recorded."
    : flags.map((flag) => `- ${flag.severity}: ${flag.kind} - ${flag.text}`).join("\n");
  const linkText = links.length === 0
    ? "No related notes yet."
    : links.map((link) => `- [${link.relationship}: ${link.target}](${link.target}) - ${link.reason}`).join("\n");
  const technicalRows = [
    ["Run ID", state.id],
    ["Objective slug", state.objectiveSlug],
    ["Phase", state.phase],
    ["Status", state.status],
    ["State JSON", paths.jsonPath ?? "Not provided."],
    ["Run summary", paths.summaryPath ?? "Not provided."]
  ];

  return [
    `# ${state.objective}`,
    "",
    `> Loop Wiki note: ${id}`,
    "",
    "## Purpose",
    "",
    state.objective,
    "",
    "## Decisions",
    "",
    "No explicit decisions recorded in run state.",
    "",
    "## Rationale / Evidence",
    "",
    evidence,
    "",
    "## Change Summary",
    "",
    statusSummary(state),
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
    .find((line) => line && !line.startsWith("#") && !line.startsWith(">"));
  return paragraph ?? "Loop Wiki note.";
}

/**
 * @param {import("./run-state.js").LoopRunState} state
 * @param {{ id: string, noteRelativePath: string, markdown: string, markdownHash: string, generatedMarkdownHash: string, links: WikiLink[], paths?: WikiRunPaths }} options
 */
function buildAiMemory(state, { id, noteRelativePath, markdown, markdownHash, generatedMarkdownHash, links, paths = {} }) {
  const flags = flagEntries(state);
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
    decisions: [],
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
    target: link.target,
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
    tokens: memory.tokens
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
 * @param {WikiIndexEntry[]} notes
 */
export function renderWikiDashboardHtml(notes) {
  const cards = notes.length === 0
    ? "<p>No Loop Wiki notes found.</p>"
    : notes.map((note) => `
      <article class="card">
        <h2>${escapeHtml(note.title)}</h2>
        <p>${escapeHtml(note.summary)}</p>
        <dl>
          <dt>Status</dt><dd>${escapeHtml(note.status)}</dd>
          <dt>Tokens</dt><dd>${note.tokens.total === null ? "unknown" : String(note.tokens.total)}</dd>
        </dl>
        <a href="/notes/${encodeURIComponent(note.id)}">Read note</a>
      </article>`).join("\n");
  const graph = notes.flatMap((note) => note.links.map((link) => `${note.id} -> ${link.target}`));
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Loop Wiki</title>
  <style>
    body { margin: 0; font: 15px/1.5 ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; color: #181818; background: #f6f7f2; }
    header { padding: 24px 32px 12px; border-bottom: 1px solid #d9dccf; background: #ffffff; }
    main { display: grid; grid-template-columns: minmax(0, 1fr) 280px; gap: 24px; padding: 24px 32px; }
    h1 { margin: 0; font-size: 28px; }
    h2 { margin: 0 0 8px; font-size: 18px; }
    .stack { display: grid; gap: 12px; }
    .card { border: 1px solid #d9dccf; border-radius: 8px; padding: 16px; background: #ffffff; }
    .graph { border-left: 1px solid #d9dccf; padding-left: 20px; }
    dl { display: grid; grid-template-columns: auto 1fr; gap: 4px 10px; }
    dt { font-weight: 700; }
    a { color: #174ea6; }
    pre { white-space: pre-wrap; overflow-wrap: anywhere; }
    @media (max-width: 760px) { main { grid-template-columns: 1fr; padding: 16px; } .graph { border-left: 0; padding-left: 0; } }
  </style>
</head>
<body>
  <header>
    <h1>Loop Wiki</h1>
    <p>Local second brain for delegated agent work.</p>
  </header>
  <main>
    <section class="stack">${cards}</section>
    <aside class="graph">
      <h2>Related Notes</h2>
      <pre>${escapeHtml(graph.length === 0 ? "No graph links yet." : graph.join("\n"))}</pre>
    </aside>
  </main>
</body>
</html>`;
}

/**
 * @param {string} markdown
 */
export function renderMarkdownHtml(markdown) {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Loop Wiki Note</title>
  <style>
    body { margin: 0; font: 15px/1.6 ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; color: #181818; background: #fbfbf8; }
    main { max-width: 920px; margin: 0 auto; padding: 28px 20px 60px; }
    pre { white-space: pre-wrap; overflow-wrap: anywhere; }
    a { color: #174ea6; }
  </style>
</head>
<body>
  <main><pre>${escapeHtml(markdown)}</pre></main>
</body>
</html>`;
}
