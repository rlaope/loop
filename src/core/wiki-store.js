import { createHash } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";

import { codexResumeCommand, followLogCommand } from "./terminal-launcher.js";

const DEFAULT_STATE_DIR = ".loop";
const SAFE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const INDEX_FILE = "index.json";
const GRAPH_FILE = "graph.json";

/**
 * @typedef {{ input: number | null, output: number | null, total: number | null, source: "agent-reported" | "estimated" | "unknown" }} WikiTokenUsage
 * @typedef {{ target: string, relationship: string, reason: string, title?: string, summary?: string, updatedAt?: string, status?: string, phase?: string, kind?: string }} WikiLink
 * @typedef {{ jsonPath?: string, summaryPath?: string }} WikiRunPaths
 * @typedef {{ agent?: string, status?: string, pid?: number | null, startedAt?: string, endedAt?: string | null, logPath?: string }} WikiSession
 * @typedef {import("./run-state.js").RunLineage} RunLineage
 * @typedef {{ id: string, runId?: string, kind: string, parentId?: string, parentTitle?: string, title: string, objective: string, objectiveSlug: string, status: string, phase: string, canonicalNote: string, aiMemory: string, createdAt: string, updatedAt: string, summary: string, tags: string[], links: WikiLink[], tokens: WikiTokenUsage, session?: WikiSession | null, lineage?: RunLineage }} WikiIndexEntry
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

const SUPPORTING_NOTE_KINDS = new Set(["plan", "verification", "idea", "decision", "reference", "note"]);

/**
 * @param {string | undefined} value
 */
function normalizeWikiKind(value) {
  const normalized = String(value || "note")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (!normalized || normalized === "run") {
    return "note";
  }
  return SUPPORTING_NOTE_KINDS.has(normalized) ? normalized : "note";
}

/**
 * @param {string} value
 */
function slugifyWikiTitle(value) {
  const slug = value
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return slug || "note";
}

/**
 * @param {{ parentId: string, kind: string, title: string, body: string, now: Date }} input
 */
function noteIdForSupportingNote({ parentId, kind, title, body, now }) {
  const nowIso = now.toISOString();
  const id = `${datePart(nowIso)}-${kind}-${slugifyWikiTitle(title)}-${compactTimestamp(nowIso)}Z-${shortHash(`${parentId}:${kind}:${title}:${body}:${nowIso}`)}`;
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
        kind: typeof entry.kind === "string" ? entry.kind : "run",
        parentId: typeof entry.parentId === "string" ? entry.parentId : undefined,
        parentTitle: typeof entry.parentTitle === "string" ? entry.parentTitle : undefined,
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
              reason: String(link.reason ?? ""),
              title: typeof link.title === "string" ? link.title : undefined,
              summary: typeof link.summary === "string" ? link.summary : undefined,
              updatedAt: typeof link.updatedAt === "string" ? link.updatedAt : undefined,
              status: typeof link.status === "string" ? link.status : undefined,
              phase: typeof link.phase === "string" ? link.phase : undefined,
              kind: typeof link.kind === "string" ? link.kind : undefined
            }))
          : [],
        tokens: normalizeTokens(entry.tokens),
        session: normalizeSession(entry.session),
        lineage: normalizeLineage(entry.lineage)
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
 * @param {unknown} value
 * @returns {RunLineage | undefined}
 */
function normalizeLineage(value) {
  if (!isRecord(value)) {
    return undefined;
  }
  if (
    typeof value.parentRunId !== "string" ||
    typeof value.rootRunId !== "string" ||
    value.relationship !== "continues" ||
    typeof value.prompt !== "string" ||
    (value.createdFrom !== "tui" && value.createdFrom !== "dashboard" && value.createdFrom !== "cli")
  ) {
    return undefined;
  }
  return {
    parentRunId: value.parentRunId,
    rootRunId: value.rootRunId,
    relationship: "continues",
    prompt: value.prompt,
    createdFrom: value.createdFrom
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
/** @typedef {"en" | "ko"} WikiLocale */

/** @param {string | null | undefined} value */
function hasHangul(value) {
  return /[가-힣]/.test(value ?? "");
}

/**
 * @param {import("./run-state.js").LoopRunState} state
 * @returns {WikiLocale}
 */
function localeForState(state) {
  return hasHangul(state.objective) ? "ko" : "en";
}

/**
 * @param {WikiIndexEntry} note
 * @returns {WikiLocale}
 */
function localeForNote(note) {
  return hasHangul(note.title) || hasHangul(note.objective) || hasHangul(note.summary) ? "ko" : "en";
}

/**
 * @param {WikiIndexEntry[]} notes
 * @returns {WikiLocale}
 */
function localeForNotes(notes) {
  return notes.some((note) => localeForNote(note) === "ko") ? "ko" : "en";
}

/** @param {WikiLocale} locale */
function wikiText(locale) {
  return locale === "ko"
    ? {
        lang: "ko",
        missingSession: "기록 없음",
        agent: "agent",
        running: "실행 중",
        exited: "종료됨",
        failedToStart: "시작 실패",
        sessionRecorded: "세션 기록됨",
        noEvidence: "- pending: 아직 기록된 검증 증거가 없습니다.",
        noFlags: "기록된 플래그가 없습니다.",
        noteQuote: "Loop Wiki 노트",
        narrative: "요약",
        purpose: "목적",
        decisionLog: "결정 기록",
        rationale: "근거",
        changeSummary: "작업 / 변경 요약",
        technicalSpec: "기술 명세",
        verification: "검증 증거",
        flags: "플래그 / 리스크 / 후속 작업",
        graphLinks: "그래프 링크",
        machineContext: "머신 컨텍스트",
        field: "항목",
        value: "값",
        runId: "Run ID",
        objectiveSlug: "목적 slug",
        phase: "단계",
        status: "상태",
        agentSession: "에이전트 세션",
        agentLog: "에이전트 로그",
        stateJson: "상태 JSON",
        runSummary: "실행 요약",
        notProvided: "제공되지 않음",
        notRecorded: "기록되지 않음",
        secondBrain: "세컨드 브레인",
        graphView: "그래프 보기",
        recentStatus: "최근 상태",
        runs: "실행",
        attached: "첨부",
        total: "전체",
        loopStack: "루프 스택",
        notes: "노트",
        read: "읽기",
        readNote: "노트 읽기",
        viewLog: "로그 보기",
        delete: "삭제",
        deleteNote: "노트 삭제",
        deleteRun: "실행 삭제",
        addNote: "노트 추가",
        noteTitle: "노트 제목",
        noteBody: "맥락, 결정, 검증 증거를 기록하세요.",
        noteKind: "종류",
        verify: "검증 기록",
        evidenceSummary: "검증 증거 요약",
        markComplete: "완료 처리",
        completeSummary: "완료 근거",
        followUp: "후속 목표 준비",
        followUpPrompt: "이 루프의 맥락을 이어받을 다음 목표",
        agentChoice: "에이전트",
        openCodex: "Codex 열기",
        localActions: "로컬 액션",
        attachedNotes: "첨부 노트",
        noAttachedNotes: "첨부 노트가 없습니다.",
        unattachedNotes: "분리된 노트",
        preserved: "보존됨",
        visibleNotes: "표시된 노트",
        noNotesYet: "아직 노트가 없습니다.",
        readableConnections: "읽기 쉬운 연결",
        backToNotes: "노트로 돌아가기",
        liveRunLog: "실시간 실행 로그",
        liveTail: "라이브 테일",
        logSnapshot: "로그 스냅샷",
        commandToWatch: "터미널에서 보기",
        commandToResume: "Codex 이어보기",
        commandUnavailable: "이 실행에서 이어보기 명령을 만들 수 없습니다.",
        outputEmpty: "아직 기록된 로그가 없습니다.",
        pollingHint: "로그 파일을 1초마다 다시 읽고 있습니다.",
        copied: "복사됨",
        copy: "복사"
      }
    : {
        lang: "en",
        missingSession: "not recorded",
        agent: "agent",
        running: "running",
        exited: "exited",
        failedToStart: "failed to start",
        sessionRecorded: "session recorded",
        noEvidence: "- pending: No verification evidence has been recorded yet.",
        noFlags: "No flags recorded.",
        noteQuote: "Loop Wiki note",
        narrative: "Narrative Summary",
        purpose: "Purpose",
        decisionLog: "Decision Log",
        rationale: "Rationale",
        changeSummary: "Work / Change Summary",
        technicalSpec: "Technical Spec",
        verification: "Verification Evidence",
        flags: "Flags / Risks / Follow-ups",
        graphLinks: "Graph Links",
        machineContext: "Machine Context",
        field: "Field",
        value: "Value",
        runId: "Run ID",
        objectiveSlug: "Objective slug",
        phase: "Phase",
        status: "Status",
        agentSession: "Agent session",
        agentLog: "Agent log",
        stateJson: "State JSON",
        runSummary: "Run summary",
        notProvided: "Not provided.",
        notRecorded: "Not recorded.",
        secondBrain: "Second Brain",
        graphView: "Graph View",
        recentStatus: "Recent Status",
        runs: "Runs",
        attached: "Attached",
        total: "Total",
        loopStack: "Loop Stack",
        notes: "notes",
        read: "Read",
        readNote: "Read Note",
        viewLog: "View Log",
        delete: "Delete",
        deleteNote: "Delete Note",
        deleteRun: "Delete Run",
        addNote: "Add Note",
        noteTitle: "Note title",
        noteBody: "Record context, decisions, or verification evidence.",
        noteKind: "Kind",
        verify: "Record Verification",
        evidenceSummary: "Verification evidence summary",
        markComplete: "Mark Complete",
        completeSummary: "Completion evidence",
        followUp: "Prepare Follow-up",
        followUpPrompt: "Next objective that continues this loop",
        agentChoice: "Agent",
        openCodex: "Open Codex",
        localActions: "Local Actions",
        attachedNotes: "Attached Notes",
        noAttachedNotes: "No attached notes.",
        unattachedNotes: "Unattached Notes",
        preserved: "preserved",
        visibleNotes: "Visible Notes",
        noNotesYet: "No notes yet.",
        readableConnections: "Readable Connections",
        backToNotes: "Back to notes",
        liveRunLog: "Live Run Log",
        liveTail: "Live tail",
        logSnapshot: "Log snapshot",
        commandToWatch: "Watch in terminal",
        commandToResume: "Resume Codex",
        commandUnavailable: "No resume command can be built for this run.",
        outputEmpty: "No log output recorded yet.",
        pollingHint: "Reading the log file every second.",
        copied: "Copied",
        copy: "Copy"
      };
}

const KO_STATUS_LABELS = new Map([
  ["active", "진행 중"],
  ["complete", "완료"],
  ["paused", "일시정지"],
  ["budget_exhausted", "예산 소진"],
  ["unsafe", "안전 차단"],
  ["failed", "실패"],
  ["blocked", "차단됨"]
]);

const KO_PHASE_LABELS = new Map([
  ["intake", "접수"],
  ["plan", "계획"],
  ["discover", "탐색"],
  ["isolate", "격리"],
  ["act", "실행"],
  ["verify", "검증"],
  ["persist", "기록"],
  ["stop", "종료"]
]);

const KO_KIND_LABELS = new Map([
  ["run", "실행"],
  ["plan", "계획"],
  ["verification", "검증"],
  ["idea", "아이디어"],
  ["decision", "결정"],
  ["reference", "참고"],
  ["note", "노트"]
]);

const KO_EVIDENCE_STATUS_LABELS = new Map([
  ["passed", "통과"],
  ["failed", "실패"],
  ["pending", "대기"],
  ["unknown", "알 수 없음"]
]);

const KO_FLAG_KIND_LABELS = new Map([
  ["follow_up", "후속 작업"],
  ["risk", "리스크"],
  ["assumption", "가정"]
]);

const KO_SEVERITY_LABELS = new Map([
  ["low", "낮음"],
  ["medium", "중간"],
  ["high", "높음"]
]);

const KO_RUN_TEXT = new Map([
  ["review agent changes and run project verification", "에이전트 변경사항을 검토하고 프로젝트 검증을 실행합니다."],
  ["Stop when verification evidence proves the objective is complete.", "검증 증거가 목적 완료를 입증하면 멈춥니다."],
  ["plan", "계획을 수립합니다."]
]);

/**
 * @param {string} value
 * @param {WikiLocale} locale
 */
function localizeRunText(value, locale) {
  return locale === "ko" ? KO_RUN_TEXT.get(value) ?? value : value;
}

/**
 * @param {string} value
 * @param {WikiLocale} locale
 */
function displayStatus(value, locale) {
  return locale === "ko" ? KO_STATUS_LABELS.get(value) ?? value : value;
}

/**
 * @param {string} value
 * @param {WikiLocale} locale
 */
function displayPhase(value, locale) {
  return locale === "ko" ? KO_PHASE_LABELS.get(value) ?? value : value;
}

/**
 * @param {string} value
 * @param {WikiLocale} locale
 */
function displayKind(value, locale) {
  return locale === "ko" ? KO_KIND_LABELS.get(value) ?? value : value;
}

/**
 * @param {string} value
 * @param {WikiLocale} locale
 */
function displayEvidenceStatus(value, locale) {
  return locale === "ko" ? KO_EVIDENCE_STATUS_LABELS.get(value) ?? value : value;
}

/**
 * @param {string} value
 * @param {WikiLocale} locale
 */
function displayFlagKind(value, locale) {
  return locale === "ko" ? KO_FLAG_KIND_LABELS.get(value) ?? value : value;
}

/**
 * @param {string} value
 * @param {WikiLocale} locale
 */
function displaySeverity(value, locale) {
  return locale === "ko" ? KO_SEVERITY_LABELS.get(value) ?? value : value;
}

/**
 * @param {string} value
 * @param {WikiLocale} locale
 */
function localizeEvidenceSummary(value, locale) {
  if (locale !== "ko") {
    return value;
  }
  const codexExit = value.match(/^codex agent exited with status (\d+)\.$/);
  if (codexExit) {
    return `codex 에이전트가 상태 코드 ${codexExit[1]}으로 종료되었습니다.`;
  }
  const claudeExit = value.match(/^claudecode agent exited with status (\d+)\.$/);
  if (claudeExit) {
    return `Claude Code 에이전트가 상태 코드 ${claudeExit[1]}으로 종료되었습니다.`;
  }
  return value;
}

/**
 * @param {WikiSession | null | undefined} session
 * @param {WikiLocale} [locale]
 */
function sessionLabel(session, locale = "en") {
  const text = wikiText(locale);
  if (!session) {
    return text.missingSession;
  }
  const agent = session.agent ?? text.agent;
  if (session.status === "running") {
    return `${agent} ${text.running}${session.pid ? ` · pid ${session.pid}` : ""}`;
  }
  if (session.status === "exited") {
    return `${agent} ${text.exited}`;
  }
  if (session.status === "failed_to_start") {
    return `${agent} ${text.failedToStart}`;
  }
  return `${agent} ${session.status ?? text.sessionRecorded}`;
}

/**
 * @param {import("./run-state.js").LoopRunState} state
 * @param {WikiLocale} [locale]
 */
function statusSummary(state, locale = "en") {
  if (locale === "ko") {
    return `${displayPhase(state.phase, locale)} 단계의 ${displayStatus(state.status, locale)} 실행입니다. 다음 작업: ${localizeRunText(state.nextAction, locale)}`;
  }
  return `${state.status} run in ${state.phase} phase. Next action: ${state.nextAction}`;
}

/**
 * @param {import("./run-state.js").LoopRunState} state
 * @param {WikiLocale} [locale]
 */
function narrativeSummary(state, locale = "en") {
  if (locale === "ko") {
    return [
      `이 노트는 "${state.objective}" Loop 실행을 기록합니다.`,
      `현재 실행은 ${displayPhase(state.phase, locale)} 단계의 ${displayStatus(state.status, locale)} 상태이며, 가장 중요한 후속 작업은 "${localizeRunText(state.nextAction, locale)}"입니다.`,
      "이 페이지는 에이전트에게 맡긴 목적, 현재 증거, 완료 판단 전에 사람이 확인해야 할 내용을 복구하기 위한 사람이 읽는 기록입니다."
    ].join(" ");
  }
  return [
    `This note captures the Loop run for "${state.objective}".`,
    `The run is currently ${state.status} in the ${state.phase} phase, so the most important follow-up is: ${state.nextAction}.`,
    `Use this page as the human-readable source for what the agent was asked to do, what evidence exists, and what still needs judgment before treating the work as complete.`
  ].join(" ");
}

/**
 * @param {import("./run-state.js").LoopRunState} state
 * @param {WikiLocale} [locale]
 */
function decisionEntries(state, locale = "en") {
  const approvalScope = state.approvals.approvalScope.join(", ") || "write";
  const localizedApprovalScope = locale === "ko"
    ? approvalScope.replace(/\bwrite\b/g, "쓰기").replace(/\bread\b/g, "읽기")
    : approvalScope;
  if (locale === "ko") {
    const approvalText = state.approvals.humanApproval
      ? `쓰기 가능한 작업이 다음 범위로 승인되었습니다: ${localizedApprovalScope}.`
      : "쓰기 승인이 기록되지 않았으므로, 이후 증거가 생기기 전까지 이 실행은 읽기 전용 또는 실행 전 맥락으로 보아야 합니다.";
    return [
      {
        decision: "목적을 작업 계약으로 사용합니다.",
        rationale: `Loop는 다음 목적으로 시작되었습니다: ${state.objective}`
      },
      {
        decision: "기록된 멈춤 조건에 따라 중단합니다.",
        rationale: localizeRunText(state.stopCondition.description, locale)
      },
      {
        decision: "승인과 안전 상태를 계속 보이게 둡니다.",
        rationale: approvalText
      }
    ];
  }
  const approvalText = state.approvals.humanApproval
    ? `Write-capable work was approved for scope: ${approvalScope}.`
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
 * @param {WikiLocale} [locale]
 */
function flagEntries(state, locale = "en") {
  /** @type {{ kind: string, text: string, severity: "low" | "medium" | "high" }[]} */
  const flags = [];
  if (state.status !== "complete") {
    flags.push({
      kind: state.status === "failed" || state.status === "unsafe" ? "risk" : "follow_up",
      text: locale === "ko"
        ? `실행 상태는 ${displayStatus(state.status, locale)}입니다. 다음 작업: ${localizeRunText(state.nextAction, locale)}`
        : `Run status is ${state.status}; next action is: ${state.nextAction}`,
      severity: state.status === "failed" || state.status === "unsafe" ? "high" : "medium"
    });
  }
  if (state.verificationEvidence.length === 0) {
    flags.push({
      kind: "assumption",
      text: locale === "ko" ? "아직 기록된 검증 증거가 없습니다." : "No verification evidence has been recorded yet.",
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

/** @param {WikiLink} link */
function relatedNoteTitle(link) {
  return truncateText(stripMarkdown(link.title || "Previous Loop note"), 84);
}

/**
 * @param {WikiIndex} index
 * @param {import("./run-state.js").LoopRunState} state
 * @param {string} id
 * @returns {WikiLink[]}
 */
function relatedLinks(index, state, id) {
  const locale = localeForState(state);
  if (state.lineage) {
    const parent = index.notes.find((note) => note.runId === state.lineage?.parentRunId && note.kind === "run");
    if (parent) {
      return [{
        target: `../user/${parent.id}.md`,
        relationship: state.lineage.relationship,
        reason: locale === "ko" ? "명시적인 후속 실행 lineage parent입니다." : "Explicit follow-up lineage parent.",
        title: parent.title,
        summary: parent.summary,
        updatedAt: parent.updatedAt,
        status: parent.status,
        phase: parent.phase,
        kind: parent.kind
      }];
    }
  }
  return index.notes
    .filter((note) => note.id !== id && note.objectiveSlug === state.objectiveSlug && note.kind === "run")
    .slice(0, 5)
    .map((note) => ({
      target: `../user/${note.id}.md`,
      relationship: "continues",
      reason: locale === "ko" ? "같은 목적에 대한 이전 Loop Wiki 노트입니다." : "Earlier Loop Wiki note for the same objective.",
      title: note.title,
      summary: note.summary,
      updatedAt: note.updatedAt,
      status: note.status,
      phase: note.phase,
      kind: note.kind
    }));
}

/** @param {WikiIndexEntry} note */
function isRunNote(note) {
  return note.kind === "run";
}

/**
 * @param {WikiIndex} index
 * @param {{ runId?: string, parentId?: string }} options
 * @returns {WikiIndexEntry | null}
 */
function resolveSupportingParent(index, { runId, parentId }) {
  if (parentId) {
    const candidate = index.notes.find((note) => note.id === parentId);
    if (!candidate) {
      return null;
    }
    if (isRunNote(candidate) || !candidate.parentId) {
      return candidate;
    }
    return index.notes.find((note) => note.id === candidate.parentId) ?? candidate;
  }
  if (runId) {
    return index.notes.find((note) => note.runId === runId && isRunNote(note))
      ?? index.notes.find((note) => note.runId === runId)
      ?? null;
  }
  return index.notes.find(isRunNote) ?? index.notes[0] ?? null;
}

/**
 * @param {import("./run-state.js").LoopRunState} state
 * @param {{ id: string, links: WikiLink[], paths?: WikiRunPaths }} options
 */
export function renderWikiNote(state, { id, links, paths = {} }) {
  const locale = localeForState(state);
  const text = wikiText(locale);
  const session = sessionFromRunState(state);
  const evidence = state.verificationEvidence.length === 0
    ? text.noEvidence
    : state.verificationEvidence.map((entry) => `- ${displayEvidenceStatus(entry.status, locale)}: ${localizeEvidenceSummary(entry.summary, locale)}`).join("\n");
  const flags = flagEntries(state, locale);
  const flagText = flags.length === 0
    ? text.noFlags
    : flags.map((flag) => `- ${displaySeverity(flag.severity, locale)}: ${displayFlagKind(flag.kind, locale)} - ${flag.text}`).join("\n");
  const decisions = decisionEntries(state, locale);
  const decisionText = decisions
    .map((entry) => `- ${entry.decision} ${entry.rationale}`)
    .join("\n");
  const technicalRows = [
    [text.runId, state.id],
    [text.objectiveSlug, state.objectiveSlug],
    [text.phase, locale === "ko" ? `${displayPhase(state.phase, locale)} (${state.phase})` : state.phase],
    [text.status, locale === "ko" ? `${displayStatus(state.status, locale)} (${state.status})` : state.status],
    [text.agentSession, sessionLabel(session, locale)],
    [text.agentLog, session?.logPath ?? text.notRecorded],
    [text.stateJson, paths.jsonPath ?? text.notProvided],
    [text.runSummary, paths.summaryPath ?? text.notProvided]
  ];

  return [
    `# ${state.objective}`,
    "",
    `> ${text.noteQuote}: ${id}`,
    "",
    `## ${text.narrative}`,
    "",
    narrativeSummary(state, locale),
    "",
    `## ${text.purpose}`,
    "",
    locale === "ko"
      ? `이 실행의 목적은 프로젝트를 다음 방향으로 진행하는 것입니다: ${state.objective}`
      : `The purpose of this run is to move the project toward: ${state.objective}`,
    "",
    locale === "ko"
      ? `현재 멈춤 규칙: ${localizeRunText(state.stopCondition.description, locale)}`
      : `The current stop rule is: ${state.stopCondition.description}`,
    "",
    `## ${text.decisionLog}`,
    "",
    decisionText,
    "",
    `## ${text.rationale}`,
    "",
    locale === "ko"
      ? `Loop는 목적, 안전 상태, 실행 단계, 검증 증거, 그래프 링크를 기록해서 사람이 전체 에이전트 대화를 다시 재생하지 않아도 맥락을 복구할 수 있게 합니다. 마지막으로 기록된 다음 작업: ${localizeRunText(state.nextAction, locale)}`
      : `The loop records the objective, safety state, run phase, verification evidence, and graph links so a human can recover context without replaying the whole agent conversation. The latest recorded next action is: ${state.nextAction}`,
    "",
    `## ${text.changeSummary}`,
    "",
    statusSummary(state, locale),
    "",
    locale === "ko" ? `에이전트 세션: ${sessionLabel(session, locale)}.` : `Agent session: ${sessionLabel(session, locale)}.`,
    "",
    `## ${text.technicalSpec}`,
    "",
    `| ${text.field} | ${text.value} |`,
    "| --- | --- |",
    ...technicalRows.map(([field, value]) => `| ${escapeMarkdown(field)} | ${escapeMarkdown(value)} |`),
    "",
    `## ${text.verification}`,
    "",
    evidence,
    "",
    `## ${text.flags}`,
    "",
    flagText,
    "",
    `## ${text.graphLinks}`,
    "",
    links.length === 0
      ? (locale === "ko"
          ? "아직 그래프 연결이 없습니다. 같은 목적 slug의 이후 실행은 여기에 표시됩니다."
          : "This note has no graph edges yet. Future runs with the same objective slug will appear here.")
      : [
          locale === "ko"
            ? `이 노트는 같은 목적의 이전 노트 ${links.length}개를 이어갑니다. 전체 지도는 그래프 보기에서 확인하세요.`
            : `This note continues ${links.length} earlier note${links.length === 1 ? "" : "s"} for the same objective. Open Graph View for the full map.`,
          "",
          ...links.map((link) => `- ${link.relationship}: ${relatedNoteTitle(link)}`)
        ].join("\n"),
    "",
    `## ${text.machineContext}`,
    "",
    locale === "ko" ? `- 실행 상태: ${state.id}` : `- Run state: ${state.id}`,
    locale === "ko" ? `- 목적 slug: ${state.objectiveSlug}` : `- Objective slug: ${state.objectiveSlug}`,
    locale === "ko" ? `- 생성: ${state.createdAt}` : `- Created: ${state.createdAt}`,
    locale === "ko" ? `- 갱신: ${state.updatedAt}` : `- Updated: ${state.updatedAt}`,
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
  const locale = localeForState(state);
  const flags = flagEntries(state, locale);
  const decisions = decisionEntries(state, locale);
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
    lineage: state.lineage,
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
      gaps: state.verificationEvidence.length === 0
        ? [locale === "ko" ? "아직 기록된 검증 증거가 없습니다." : "No verification evidence recorded yet."]
        : []
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
 * @param {{ kind: string, title: string, body: string, parent: WikiIndexEntry, links: WikiLink[] }} input
 */
function renderSupportingWikiNote({ kind, title, body, parent, links }) {
  const locale = localeForNote(parent);
  const kindLabel = displayKind(kind, locale);
  return [
    `# ${title}`,
    "",
    locale === "ko" ? `> Loop Wiki ${kindLabel} 노트` : `> Loop Wiki ${kind} note`,
    "",
    locale === "ko" ? "## 맥락" : "## Context",
    "",
    locale === "ko" ? `- 유형: ${kindLabel}` : `- Type: ${kind}`,
    locale === "ko" ? `- 상위 루프: ${parent.title}` : `- Parent loop: ${parent.title}`,
    locale === "ko" ? `- 목적: ${parent.objective}` : `- Objective: ${parent.objective}`,
    "",
    locale === "ko" ? "## 노트" : "## Note",
    "",
    body.trim(),
    "",
    locale === "ko" ? "## 연결 방식" : "## How It Connects",
    "",
    locale === "ko"
      ? `이 노트는 ${kindLabel} 자료를 메인 실행 노트에 섞지 않고 별도 아티팩트로 보존해서 상위 루프를 보조합니다.`
      : `This note supports the parent loop by preserving a separate ${kind} artifact instead of folding it into the main run note.`,
    ""
  ].join("\n");
}

/**
 * @param {{ id: string, kind: string, parent: WikiIndexEntry, title: string, body: string, noteRelativePath: string, markdown: string, links: WikiLink[], nowIso: string }} input
 */
function buildSupportingAiMemory({ id, kind, parent, title, body, noteRelativePath, markdown, links, nowIso }) {
  return {
    version: 1,
    id,
    kind,
    parentId: parent.id,
    parentTitle: parent.title,
    parentRunId: parent.runId ?? null,
    canonicalNote: noteRelativePath,
    derivedFromHash: hashText(markdown),
    generator: {
      markdownHash: hashText(markdown),
      source: "loop-supporting-note"
    },
    runIds: parent.runId ? [parent.runId] : [],
    objective: parent.objective,
    objectiveSlug: parent.objectiveSlug,
    title,
    summary: shortSummaryFromMarkdown(markdown),
    body,
    status: parent.status,
    phase: parent.phase,
    session: parent.session ?? null,
    graph: {
      tags: ["loop-wiki", kind, parent.objectiveSlug],
      links
    },
    tokens: unknownTokenUsage(),
    createdAt: nowIso,
    updatedAt: nowIso
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
      kind: note.kind,
      parentId: note.parentId,
      lineage: note.lineage,
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
    kind: "run",
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
    session: memory.session,
    lineage: state.lineage
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
 * @param {{ stateDir?: string, runId?: string, parentId?: string, kind?: string, title: string, body: string, now?: Date }} options
 */
export async function writeWikiSupportingNote({
  stateDir = DEFAULT_STATE_DIR,
  runId,
  parentId,
  kind,
  title,
  body,
  now = new Date()
}) {
  const trimmedTitle = title.trim();
  const trimmedBody = body.trim();
  if (!trimmedTitle) {
    throw new Error("Supporting wiki note title is required");
  }
  if (!trimmedBody) {
    throw new Error("Supporting wiki note body is required");
  }

  const normalizedKind = normalizeWikiKind(kind);
  const { root, userDir, aiDir, indexPath, graphPath } = wikiPath(stateDir);
  await mkdir(userDir, { recursive: true });
  await mkdir(aiDir, { recursive: true });

  const index = await readWikiIndex({ stateDir });
  const parent = resolveSupportingParent(index, { runId, parentId });
  if (!parent) {
    throw new Error("No Loop Wiki run note found; run loop first or pass --run/--parent");
  }

  const nowIso = now.toISOString();
  const id = noteIdForSupportingNote({
    parentId: parent.id,
    kind: normalizedKind,
    title: trimmedTitle,
    body: trimmedBody,
    now
  });
  const notePath = wikiNotePath({ stateDir, id });
  const memoryPath = wikiMemoryPath({ stateDir, id });
  const noteRelativePath = relative(aiDir, notePath);
  const aiRelativeFromRoot = relative(root, memoryPath);
  const noteRelativeFromRoot = relative(root, notePath);
  const links = [{
    target: `../user/${parent.id}.md`,
    relationship: "supports",
    reason: localeForNote(parent) === "ko"
      ? `이 Loop 실행을 보조하는 ${normalizedKind} 노트입니다.`
      : `Supporting ${normalizedKind} note for this Loop run.`,
    title: parent.title,
    summary: parent.summary,
    updatedAt: parent.updatedAt,
    status: parent.status,
    phase: parent.phase,
    kind: parent.kind
  }];
  const markdown = renderSupportingWikiNote({
    kind: normalizedKind,
    title: trimmedTitle,
    body: trimmedBody,
    parent,
    links
  });
  const memory = buildSupportingAiMemory({
    id,
    kind: normalizedKind,
    parent,
    title: trimmedTitle,
    body: trimmedBody,
    noteRelativePath,
    markdown,
    links,
    nowIso
  });

  await writeFile(notePath, markdown);
  await writeFile(memoryPath, `${JSON.stringify(memory, null, 2)}\n`);

  const entry = {
    id,
    runId: parent.runId,
    kind: normalizedKind,
    parentId: parent.id,
    parentTitle: parent.title,
    title: trimmedTitle,
    objective: parent.objective,
    objectiveSlug: parent.objectiveSlug,
    status: parent.status,
    phase: parent.phase,
    canonicalNote: noteRelativeFromRoot,
    aiMemory: aiRelativeFromRoot,
    createdAt: nowIso,
    updatedAt: nowIso,
    summary: memory.summary,
    tags: memory.graph.tags,
    links,
    tokens: memory.tokens,
    session: memory.session
  };
  const nextIndex = upsertIndexEntry(index, entry, nowIso);
  await writeFile(indexPath, `${JSON.stringify(nextIndex, null, 2)}\n`);
  await writeFile(graphPath, `${JSON.stringify(buildGraph(nextIndex, nowIso), null, 2)}\n`);

  return {
    id,
    kind: normalizedKind,
    notePath,
    memoryPath,
    indexPath,
    graphPath,
    parentId: parent.id
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
    "| ID | Type | Status | Title | Updated |",
    "| --- | --- | --- | --- | --- |",
    ...notes.map((note) => `| ${escapeMarkdown(note.id)} | ${escapeMarkdown(note.kind)} | ${escapeMarkdown(note.status)} | ${escapeMarkdown(note.title)} | ${escapeMarkdown(note.updatedAt)} |`)
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
    return "<p class=\"empty\">No graph nodes yet.</p>";
  }
  const width = 1100;
  const height = 680;
  const centerX = width / 2;
  const centerY = height / 2;
  /** @type {Map<string, { x: number, y: number }>} */
  const positions = new Map();
  const roots = notes.filter((note) => isRunNote(note) || !note.parentId);
  const rootNotes = roots.length > 0 ? roots : notes.slice(0, 1);
  const rootRadius = rootNotes.length === 1 ? 0 : Math.min(220, 130 + rootNotes.length * 18);
  rootNotes.forEach((note, index) => {
    const angle = rootNotes.length === 1 ? 0 : (Math.PI * 2 * index / rootNotes.length) - Math.PI / 2;
    positions.set(note.id, {
      x: centerX + Math.cos(angle) * rootRadius,
      y: centerY + Math.sin(angle) * rootRadius
    });
  });
  /** @type {Map<string, WikiIndexEntry[]>} */
  const childrenByParent = new Map();
  for (const note of notes) {
    if (!note.parentId) {
      continue;
    }
    childrenByParent.set(note.parentId, [...(childrenByParent.get(note.parentId) ?? []), note]);
  }
  for (const [parentId, children] of childrenByParent) {
    const parent = positions.get(parentId) ?? { x: centerX, y: centerY };
    const radius = Math.min(170, 82 + children.length * 12);
    children.forEach((note, index) => {
      const angle = (Math.PI * 2 * index / children.length) - Math.PI / 2;
      positions.set(note.id, {
        x: Math.max(60, Math.min(width - 60, parent.x + Math.cos(angle) * radius)),
        y: Math.max(60, Math.min(height - 70, parent.y + Math.sin(angle) * radius))
      });
    });
  }
  const unpositioned = notes.filter((note) => !positions.has(note.id));
  const outerRadius = Math.min(300, 180 + unpositioned.length * 10);
  unpositioned.forEach((note, index) => {
    const angle = (Math.PI * 2 * index / unpositioned.length) + Math.PI / 5;
    positions.set(note.id, {
      x: centerX + Math.cos(angle) * outerRadius,
      y: centerY + Math.sin(angle) * outerRadius
    });
  });
  const edges = graphEdges(notes);
  const edgeHtml = edges.map((edge) => {
    const source = positions.get(edge.source);
    const target = positions.get(edge.target);
    if (!source || !target) {
      return "";
    }
    return `<line x1="${source.x.toFixed(1)}" y1="${source.y.toFixed(1)}" x2="${target.x.toFixed(1)}" y2="${target.y.toFixed(1)}" class="graph-edge graph-edge-${escapeHtml(edge.relationship)}"><title>${escapeHtml(edge.relationship)}: ${escapeHtml(edge.reason)}</title></line>`;
  }).join("");
  const nodeHtml = notes.map((note) => {
    const point = positions.get(note.id);
    if (!point) {
      return "";
    }
    const label = truncateText(note.title, 24);
    const radius = isRunNote(note) ? 16 : 10;
    return `<a href="/notes/${encodeURIComponent(note.id)}" class="graph-node-link"><g class="graph-node graph-kind-${escapeHtml(note.kind)} ${statusClass(note.status)}">
      <circle cx="${point.x.toFixed(1)}" cy="${point.y.toFixed(1)}" r="${radius}"><title>${escapeHtml(note.title)}</title></circle>
      <text x="${point.x.toFixed(1)}" y="${(point.y + radius + 18).toFixed(1)}" text-anchor="middle">${escapeHtml(label)}</text>
    </g></a>`;
  }).join("");
  return `<svg viewBox="0 0 ${width} ${height}" role="img" aria-label="Loop Wiki graph view">
    <defs>
      <filter id="nodeGlow" x="-120%" y="-120%" width="340%" height="340%">
        <feGaussianBlur stdDeviation="5" result="blur"></feGaussianBlur>
        <feMerge>
          <feMergeNode in="blur"></feMergeNode>
          <feMergeNode in="SourceGraphic"></feMergeNode>
        </feMerge>
      </filter>
      <radialGradient id="runNode" cx="50%" cy="45%" r="70%">
        <stop offset="0%" stop-color="#f4f0e8"></stop>
        <stop offset="100%" stop-color="#8bd3ff"></stop>
      </radialGradient>
    </defs>
    ${edgeHtml}${nodeHtml}
  </svg>`;
}

/**
 * @param {WikiIndexEntry[]} notes
 * @param {{ confirmationTokenFor?: (input: { action: string, targetId: string }) => string }} [options]
 */
export function renderWikiDashboardHtml(notes, { confirmationTokenFor = () => "" } = {}) {
  const locale = localeForNotes(notes);
  const text = wikiText(locale);
  const recent = notes[0];
  const runNotes = notes.filter(isRunNote);
  const attachedNotes = notes.filter((note) => note.parentId);
  /** @type {Map<string, WikiIndexEntry[]>} */
  const childrenByParent = new Map();
  for (const note of attachedNotes) {
    const key = note.parentId ?? "";
    childrenByParent.set(key, [...(childrenByParent.get(key) ?? []), note]);
  }
  /**
   * @param {string} name
   * @param {string | undefined} value
   */
  const hiddenInput = (name, value) => value
    ? `<input type="hidden" name="${escapeHtml(name)}" value="${escapeHtml(value)}">`
    : "";
  /**
   * @param {string} action
   * @param {string} targetId
   */
  const tokenInput = (action, targetId) => hiddenInput("confirmationToken", confirmationTokenFor({ action, targetId }));
  /**
   * @param {string} id
   * @param {string} buttonClass
   * @param {string} label
   */
  const deleteNoteForm = (id, buttonClass, label) => `
              <form method="post" action="/actions/delete-note">
                ${hiddenInput("id", id)}
                ${tokenInput("delete-note", id)}
                <button class="${escapeHtml(buttonClass)}" type="submit">${escapeHtml(label)}</button>
              </form>`;
  /**
   * @param {WikiIndexEntry} runNote
   */
  const renderLocalActionPanel = (runNote) => {
    if (!runNote.runId) {
      return "";
    }
    const kindOptions = ["note", "plan", "verification", "idea", "decision", "reference"]
      .map((kind) => `<option value="${kind}">${escapeHtml(displayKind(kind, locale))}</option>`)
      .join("");
    return `
          <section class="local-actions-panel" aria-label="${escapeHtml(text.localActions)}">
            <div class="section-title-row"><h4>${escapeHtml(text.localActions)}</h4><span>${escapeHtml(runNote.runId)}</span></div>
            <form class="stack-form note-form" method="post" action="/actions/add-note">
              ${hiddenInput("targetId", runNote.id)}
              ${hiddenInput("runId", runNote.runId)}
              ${hiddenInput("parentId", runNote.id)}
              ${tokenInput("add-note", runNote.id)}
              <label><span>${escapeHtml(text.noteKind)}</span><select name="kind">${kindOptions}</select></label>
              <label><span>${escapeHtml(text.noteTitle)}</span><input name="title" autocomplete="off"></label>
              <textarea name="body" rows="3" placeholder="${escapeHtml(text.noteBody)}"></textarea>
              <button class="button secondary" type="submit">${escapeHtml(text.addNote)}</button>
            </form>
            <form class="stack-form inline-form" method="post" action="/actions/verify-run">
              ${hiddenInput("id", runNote.runId)}
              ${tokenInput("verify-run", runNote.runId)}
              <input name="summary" autocomplete="off" placeholder="${escapeHtml(text.evidenceSummary)}">
              <button class="button secondary" type="submit">${escapeHtml(text.verify)}</button>
            </form>
            <form class="stack-form inline-form" method="post" action="/actions/follow-up">
              ${hiddenInput("parentRunId", runNote.runId)}
              ${tokenInput("follow-up-run", runNote.runId)}
              <select name="agent" aria-label="${escapeHtml(text.agentChoice)}">
                <option value="codex">codex</option>
                <option value="claudecode">claudecode</option>
              </select>
              <input name="prompt" autocomplete="off" placeholder="${escapeHtml(text.followUpPrompt)}">
              <button class="button ghost" type="submit">${escapeHtml(text.followUp)}</button>
            </form>
            <div class="danger-row">
              <form method="post" action="/actions/open-codex">
                ${hiddenInput("id", runNote.runId)}
                ${tokenInput("open-codex", runNote.runId)}
                <button class="button ghost" type="submit">${escapeHtml(text.openCodex)}</button>
              </form>
              <form method="post" action="/actions/mark-complete">
                ${hiddenInput("id", runNote.runId)}
                ${hiddenInput("summary", locale === "ko" ? "Loop Wiki 대시보드에서 완료 처리했습니다." : "Marked complete from the Loop Wiki dashboard.")}
                ${tokenInput("mark-complete", runNote.runId)}
                <button class="button secondary" type="submit">${escapeHtml(text.markComplete)}</button>
              </form>
              <form method="post" action="/actions/delete-run">
                ${hiddenInput("id", runNote.runId)}
                ${tokenInput("delete-run", runNote.runId)}
                <button class="button danger" type="submit">${escapeHtml(text.deleteRun)}</button>
              </form>
            </div>
          </section>`;
  };
  /** @type {Set<string>} */
  const renderedAttachedIds = new Set();
  /**
   * @param {WikiIndexEntry[]} children
   */
  const renderAttachedRows = (children) => {
    if (children.length === 0) {
      return `<p class="muted small">${escapeHtml(text.noAttachedNotes)}</p>`;
    }
    for (const child of children) {
      renderedAttachedIds.add(child.id);
    }
    return children.map((child) => `
          <article class="attached-note">
            <div>
              <div class="note-row-meta">
                <span class="kind">${escapeHtml(displayKind(child.kind, locale))}</span>
                <span>${escapeHtml(child.updatedAt)}</span>
              </div>
              <h4>${escapeHtml(child.title)}</h4>
              <p>${escapeHtml(child.summary)}</p>
            </div>
            <div class="inline-actions">
              <a class="text-link" href="/notes/${encodeURIComponent(child.id)}">${escapeHtml(text.read)}</a>
              ${deleteNoteForm(child.id, "text-danger", text.delete)}
            </div>
          </article>`).join("");
  };
  const rootNotes = runNotes.length > 0
    ? runNotes
    : notes.filter((note) => !note.parentId);
  const rootStacks = rootNotes.map((runNote) => {
    const children = childrenByParent.get(runNote.id) ?? [];
    const childRows = renderAttachedRows(children);
    const logLink = runNote.runId
      ? `<a class="button ghost" href="/runs/${encodeURIComponent(runNote.runId)}/log">${escapeHtml(text.viewLog)}</a>`
      : "";
    return `
      <article class="run-stack">
        <div class="run-main">
          <div class="note-card-header">
            <span class="kind">${escapeHtml(displayKind(runNote.kind, locale))}</span>
            <span class="status ${statusClass(runNote.status)}">${escapeHtml(displayStatus(runNote.status, locale))}</span>
            <span>${escapeHtml(sessionLabel(runNote.session, locale))}</span>
          </div>
          <h3>${escapeHtml(runNote.title)}</h3>
          <p>${escapeHtml(runNote.summary)}</p>
          <div class="card-actions">
            <a class="button secondary" href="/notes/${encodeURIComponent(runNote.id)}">${escapeHtml(text.readNote)}</a>
            ${logLink}
            ${deleteNoteForm(runNote.id, "button danger", text.deleteNote)}
          </div>
        </div>
        <div class="attached-list">
          <div class="section-title-row">
            <h4>${escapeHtml(text.attachedNotes)}</h4>
            <span>${children.length}</span>
          </div>
          ${childRows}
          ${renderLocalActionPanel(runNote)}
        </div>
      </article>`;
  }).join("\n");
  const unstackedNotes = attachedNotes.filter((note) => !renderedAttachedIds.has(note.id));
  const unstackedStack = unstackedNotes.length === 0
    ? ""
    : `
      <article class="run-stack unstacked-stack">
        <div class="run-main">
          <div class="note-card-header">
            <span class="kind">${escapeHtml(text.notes)}</span>
            <span class="status status-active">${escapeHtml(text.preserved)}</span>
          </div>
          <h3>${escapeHtml(text.unattachedNotes)}</h3>
          <p>${escapeHtml(locale === "ko" ? "상위 실행 또는 상위 노트가 더 이상 이 스택에 보이지 않는 노트입니다." : "Notes whose parent run or parent note is no longer visible in this stack.")}</p>
        </div>
        <div class="attached-list">
          <div class="section-title-row">
            <h4>${escapeHtml(text.visibleNotes)}</h4>
            <span>${unstackedNotes.length}</span>
          </div>
          ${renderAttachedRows(unstackedNotes)}
        </div>
      </article>`;
  const recentStatus = recent ? `
        <div class="status-card">
          <span>${escapeHtml(text.recentStatus)}</span>
          <strong>${escapeHtml(displayStatus(recent.status, locale))}</strong>
          <small>${escapeHtml(`${displayPhase(recent.phase, locale)} · ${sessionLabel(recent.session, locale)}`)}</small>
        </div>` : `
        <div class="status-card">
          <span>${escapeHtml(text.recentStatus)}</span>
          <strong>${escapeHtml(text.noNotesYet)}</strong>
        </div>`;
  const stackHtml = `${rootStacks}${unstackedStack}` || `<p class="muted">${escapeHtml(text.noNotesYet)}</p>`;
  return `<!doctype html>
<html lang="${text.lang}">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Loop Wiki</title>
  <style>
    :root { color-scheme: dark; --ink: #f4f0e8; --muted: #9da0a6; --line: #2a2b31; --panel: #15161a; --panel-strong: #1d1f25; --page: #090a0d; --blue: #8bd3ff; --green: #77d99a; --red: #ff7b72; --amber: #f4c95d; --violet: #c9a7ff; }
    * { box-sizing: border-box; }
    body { margin: 0; min-height: 100vh; font: 15px/1.55 ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; color: var(--ink); background: var(--page); }
    body::before { content: ""; position: fixed; inset: 0; pointer-events: none; background-image: linear-gradient(rgba(255,255,255,.035) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,.035) 1px, transparent 1px); background-size: 32px 32px; mask-image: linear-gradient(to bottom, rgba(0,0,0,.8), rgba(0,0,0,.18)); }
    header { position: sticky; top: 0; z-index: 5; padding: 18px 32px; border-bottom: 1px solid var(--line); background: rgba(9, 10, 13, .92); backdrop-filter: blur(14px); }
    main { position: relative; padding: 22px 32px 40px; }
    h1 { margin: 0; font-size: 25px; line-height: 1.1; letter-spacing: 0; }
    h2 { margin: 0; font-size: 20px; line-height: 1.2; letter-spacing: 0; }
    h3 { margin: 10px 0 8px; font-size: 18px; line-height: 1.25; letter-spacing: 0; }
    h4 { margin: 0; font-size: 13px; letter-spacing: 0; }
    p { margin: 0; color: var(--muted); }
    a { color: var(--blue); text-decoration-thickness: 1px; text-underline-offset: 3px; }
    .header-row { display: flex; justify-content: space-between; gap: 16px; align-items: flex-start; }
    .actions { display: flex; gap: 8px; flex-wrap: wrap; justify-content: flex-end; }
    .eyebrow { color: var(--violet); font-size: 12px; font-weight: 800; text-transform: uppercase; }
    .dashboard-grid { display: grid; gap: 16px; max-width: 1280px; margin: 0 auto; }
    .overview-grid { display: grid; grid-template-columns: minmax(240px, 1fr) repeat(3, max-content); gap: 8px; align-items: stretch; }
    .status-card, .metric-card, .run-stack { border: 1px solid var(--line); border-radius: 8px; background: linear-gradient(180deg, rgba(29,31,37,.96), rgba(18,19,24,.96)); box-shadow: 0 18px 70px rgba(0,0,0,.25); }
    .status-card { min-height: 58px; padding: 10px 12px; display: grid; grid-template-columns: auto 1fr; gap: 2px 10px; align-items: center; }
    .status-card span { color: var(--muted); font-size: 11px; font-weight: 800; text-transform: uppercase; }
    .status-card strong { font-size: 16px; line-height: 1.1; }
    .status-card small { grid-column: 1 / -1; color: var(--muted); overflow-wrap: anywhere; }
    .metric-card { min-width: 78px; min-height: 58px; padding: 9px 11px; display: grid; gap: 2px; align-content: center; }
    .metric-card span { color: var(--muted); font-size: 10px; font-weight: 800; text-transform: uppercase; }
    .metric-card strong { font-size: 20px; line-height: 1; }
    .stack-list { display: grid; gap: 12px; }
    .run-stack { display: grid; grid-template-columns: minmax(0, 1.1fr) minmax(300px, .9fr); overflow: hidden; }
    .run-main { padding: 16px; display: grid; gap: 10px; border-right: 1px solid var(--line); }
    .attached-list { padding: 14px; display: grid; gap: 10px; background: rgba(255,255,255,.025); }
    .attached-note { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 12px; padding: 12px; border: 1px solid #25262c; border-radius: 8px; background: #101116; }
    .attached-note h4 { margin-top: 5px; font-size: 14px; }
    .attached-note p { margin-top: 4px; font-size: 13px; }
    .local-actions-panel { display: grid; gap: 10px; margin-top: 2px; padding-top: 12px; border-top: 1px solid var(--line); }
    .stack-form { display: grid; gap: 8px; }
    .stack-form label { display: grid; gap: 4px; color: var(--muted); font-size: 12px; font-weight: 800; }
    .inline-form { grid-template-columns: minmax(120px, 1fr) auto; align-items: end; }
    .inline-form select { min-width: 118px; }
    input, textarea, select { width: 100%; border: 1px solid var(--line); border-radius: 7px; background: #08090d; color: var(--ink); font: inherit; }
    input, select { min-height: 36px; padding: 7px 10px; }
    textarea { min-height: 78px; padding: 9px 10px; resize: vertical; }
    .note-form { grid-template-columns: minmax(100px, 140px) minmax(0, 1fr); }
    .note-form textarea, .note-form button { grid-column: 1 / -1; }
    .danger-row { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
    .note-card-header, .note-row-meta, .section-title-row { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; color: var(--muted); font-size: 12px; }
    .section-title-row { justify-content: space-between; color: var(--ink); }
    .section-title-row span { color: var(--muted); }
    .stack-heading { margin-bottom: 10px; }
    .status, .kind { display: inline-flex; align-items: center; min-height: 22px; padding: 2px 8px; border-radius: 999px; border: 1px solid var(--line); font-weight: 700; }
    .kind { color: var(--blue); background: rgba(139,211,255,.08); border-color: rgba(139,211,255,.3); text-transform: capitalize; }
    .status-complete { color: var(--green); background: rgba(119,217,154,.08); border-color: rgba(119,217,154,.35); }
    .status-risk { color: var(--red); background: rgba(255,123,114,.08); border-color: rgba(255,123,114,.35); }
    .status-active { color: var(--amber); background: rgba(244,201,93,.08); border-color: rgba(244,201,93,.35); }
    .button { display: inline-flex; align-items: center; justify-content: center; min-height: 36px; padding: 7px 12px; border-radius: 7px; border: 1px solid rgba(139,211,255,.45); background: var(--blue); color: #071016; font-weight: 800; text-decoration: none; }
    .button.secondary, .button.ghost { justify-self: start; border-color: var(--line); background: #0d0e12; color: var(--ink); }
    .button.ghost { color: var(--blue); }
    .button.danger { border-color: rgba(255,123,114,.35); background: rgba(255,123,114,.08); color: var(--red); cursor: pointer; }
    .card-actions { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
    .inline-actions { display: flex; gap: 8px; align-items: start; }
    .text-link, .text-danger { border: 0; padding: 0; background: transparent; color: var(--blue); font: inherit; font-size: 12px; font-weight: 800; text-decoration: none; cursor: pointer; }
    .text-danger { color: var(--red); }
    form { margin: 0; }
    .muted { color: var(--muted); }
    .small { font-size: 13px; }
    @media (max-width: 980px) { .overview-grid { grid-template-columns: 1fr repeat(3, max-content); } .run-stack { grid-template-columns: 1fr; } .run-main { border-right: 0; border-bottom: 1px solid var(--line); } }
    @media (max-width: 760px) { header { padding: 16px; } main { padding: 14px; } .header-row { display: grid; } .actions { justify-content: flex-start; } .overview-grid { grid-template-columns: 1fr 1fr 1fr; } .status-card { grid-column: 1 / -1; } .attached-note, .inline-form, .note-form { grid-template-columns: 1fr; } .note-form textarea, .note-form button { grid-column: auto; } }
  </style>
</head>
<body>
  <header>
    <div class="header-row">
      <div>
        <p class="eyebrow">Loop Wiki</p>
        <h1>${escapeHtml(text.secondBrain)}</h1>
      </div>
      <nav class="actions" aria-label="Wiki views">
        <a class="button" href="/graph">${escapeHtml(text.graphView)}</a>
      </nav>
    </div>
  </header>
  <main>
    <section class="dashboard-grid">
      <section class="overview-grid">
        ${recentStatus}
        <div class="metric-card"><span>${escapeHtml(text.runs)}</span><strong>${runNotes.length}</strong></div>
        <div class="metric-card"><span>${escapeHtml(text.attached)}</span><strong>${attachedNotes.length}</strong></div>
        <div class="metric-card"><span>${escapeHtml(text.total)}</span><strong>${notes.length}</strong></div>
      </section>
      <section>
        <div class="section-title-row stack-heading"><h2>${escapeHtml(text.loopStack)}</h2><span>${notes.length} ${escapeHtml(text.notes)}</span></div>
        <div class="stack-list">${stackHtml}</div>
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
  const locale = localeForNotes(notes);
  const text = wikiText(locale);
  const edges = graphEdges(notes);
  const noteById = new Map(notes.map((note) => [note.id, note]));
  const edgeSummary = edges.length === 0
    ? `<p class="empty">${escapeHtml(locale === "ko" ? "아직 그래프 연결이 없습니다. 반복되는 목적은 자동으로 연결됩니다." : "No graph links yet. Repeated objectives will connect automatically.")}</p>`
    : `<ul>${edges.slice(0, 8).map((edge) => {
        const source = noteById.get(edge.source);
        const target = noteById.get(edge.target);
        return `<li><strong>${escapeHtml(source ? truncateText(source.title, 42) : edge.source)}</strong> ${escapeHtml(edge.relationship)} <strong>${escapeHtml(target ? truncateText(target.title, 42) : edge.target)}</strong></li>`;
      }).join("")}</ul>`;
  return `<!doctype html>
<html lang="${text.lang}">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Loop Wiki Graph</title>
  <style>
    :root { color-scheme: dark; --ink: #f4f0e8; --muted: #9da0a6; --line: #2a2b31; --panel: #15161a; --page: #07080b; --blue: #8bd3ff; --green: #77d99a; --red: #ff7b72; --amber: #f4c95d; --violet: #c9a7ff; }
    * { box-sizing: border-box; }
    body { margin: 0; min-height: 100vh; font: 15px/1.55 ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; color: var(--ink); background: var(--page); }
    header { display: flex; justify-content: space-between; gap: 16px; align-items: flex-start; padding: 18px 28px; border-bottom: 1px solid var(--line); background: rgba(7,8,11,.94); backdrop-filter: blur(14px); }
    h1 { margin: 0; font-size: 26px; line-height: 1.1; }
    h2 { margin: 0 0 12px; font-size: 16px; }
    p { margin: 6px 0 0; color: var(--muted); }
    a { color: var(--blue); text-decoration-thickness: 1px; text-underline-offset: 3px; }
    .button { display: inline-flex; align-items: center; justify-content: center; min-height: 36px; padding: 7px 12px; border-radius: 7px; border: 1px solid var(--line); background: #0d0e12; color: var(--blue); font-weight: 800; text-decoration: none; }
    main { display: grid; grid-template-columns: minmax(0, 1fr) 320px; gap: 16px; padding: 16px 28px 28px; }
    .graph-stage, .side-panel { border: 1px solid var(--line); border-radius: 8px; background: var(--panel); }
    .graph-stage { min-height: 72vh; overflow: hidden; background-color: #08090d; background-image: linear-gradient(rgba(255,255,255,.04) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,.04) 1px, transparent 1px); background-size: 34px 34px; }
    .side-panel { padding: 16px; align-self: start; }
    svg { display: block; width: 100%; min-height: 72vh; }
    .graph-edge { stroke: rgba(157,160,166,.55); stroke-width: 1.2; }
    .graph-edge-supports { stroke: rgba(139,211,255,.58); }
    .graph-edge-continues { stroke: rgba(201,167,255,.55); stroke-dasharray: 5 5; }
    .graph-node circle { fill: #11141b; stroke: var(--blue); stroke-width: 2.2; filter: url(#nodeGlow); }
    .graph-kind-run circle { fill: url(#runNode); stroke: #f4f0e8; }
    .graph-kind-plan circle { stroke: var(--blue); }
    .graph-kind-verification circle { stroke: var(--green); }
    .graph-kind-idea circle { stroke: var(--violet); }
    .graph-kind-decision circle { stroke: var(--amber); }
    .graph-kind-reference circle { stroke: #f59e9e; }
    .graph-node.status-complete circle { stroke-width: 2.6; }
    .graph-node.status-risk circle { stroke: var(--red); }
    .graph-node text { fill: var(--ink); font-size: 11px; pointer-events: none; paint-order: stroke; stroke: #07080b; stroke-width: 4px; stroke-linejoin: round; }
    .empty, li { color: var(--muted); }
    ul { margin: 0; padding-left: 18px; }
    li { margin: 7px 0; }
    @media (max-width: 880px) { header { display: grid; padding: 16px; } main { grid-template-columns: 1fr; padding: 14px; } .graph-stage, svg { min-height: 520px; } }
  </style>
</head>
<body>
  <header>
    <div>
      <h1>${escapeHtml(text.graphView)}</h1>
    </div>
    <a class="button" href="/">${escapeHtml(text.backToNotes)}</a>
  </header>
  <main>
    <section class="graph-stage">${renderGraphSvg(notes)}</section>
    <aside class="side-panel">
      <h2>${escapeHtml(text.readableConnections)}</h2>
      ${edgeSummary}
    </aside>
  </main>
</body>
</html>`;
}

/**
 * @param {string} markdown
 * @param {{ noteId?: string, confirmationTokenFor?: (input: { action: string, targetId: string }) => string }} [options]
 */
export function renderMarkdownHtml(markdown, { noteId, confirmationTokenFor = () => "" } = {}) {
  const locale = hasHangul(markdown) ? "ko" : "en";
  const text = wikiText(locale);
  const toolbar = noteId
    ? `<nav class="toolbar" aria-label="Note actions">
        <a class="button" href="/">${escapeHtml(text.backToNotes)}</a>
        <form method="post" action="/actions/delete-note">
          <input type="hidden" name="id" value="${escapeHtml(noteId)}">
          <input type="hidden" name="confirmationToken" value="${escapeHtml(confirmationTokenFor({ action: "delete-note", targetId: noteId }))}">
          <button class="button danger" type="submit">${escapeHtml(text.deleteNote)}</button>
        </form>
      </nav>`
    : `<nav class="toolbar" aria-label="Note actions"><a class="button" href="/">${escapeHtml(text.backToNotes)}</a></nav>`;
  return `<!doctype html>
<html lang="${text.lang}">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Loop Wiki Note</title>
  <style>
    :root { color-scheme: dark; --ink: #f4f0e8; --muted: #9da0a6; --line: #2a2b31; --panel: #15161a; --page: #090a0d; --blue: #8bd3ff; --red: #ff7b72; }
    * { box-sizing: border-box; }
    body { margin: 0; font: 16px/1.65 ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; color: var(--ink); background: var(--page); }
    main { max-width: 940px; margin: 0 auto; padding: 28px 20px 64px; }
    article { border: 1px solid var(--line); border-radius: 8px; padding: 28px; background: var(--panel); box-shadow: 0 18px 70px rgba(0,0,0,.28); }
    h1 { margin: 0 0 12px; font-size: 32px; line-height: 1.15; }
    h2 { margin: 30px 0 10px; padding-top: 18px; border-top: 1px solid var(--line); font-size: 21px; }
    h3 { margin: 20px 0 8px; font-size: 18px; }
    p { margin: 10px 0; }
    blockquote { margin: 14px 0; padding: 10px 14px; border-left: 4px solid var(--blue); background: rgba(139,211,255,.08); color: var(--ink); }
    ul { padding-left: 22px; }
    li { margin: 5px 0; }
    table { width: 100%; border-collapse: collapse; margin: 12px 0; font-size: 14px; }
    th, td { border: 1px solid var(--line); padding: 8px 10px; text-align: left; vertical-align: top; }
    th { background: #20222a; }
    code { padding: 1px 5px; border-radius: 5px; background: #20222a; }
    pre { padding: 14px; border-radius: 8px; overflow-x: auto; background: #050609; color: #f8fafc; }
    a { color: var(--blue); text-underline-offset: 3px; }
    .toolbar { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; justify-content: space-between; margin-bottom: 12px; }
    .button { display: inline-flex; align-items: center; justify-content: center; min-height: 36px; padding: 7px 12px; border-radius: 7px; border: 1px solid var(--line); background: #0d0e12; color: var(--blue); font-weight: 800; text-decoration: none; }
    .button.danger { border-color: rgba(255,123,114,.35); background: rgba(255,123,114,.08); color: var(--red); cursor: pointer; }
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
 * @param {unknown} state
 */
function rawSessionFromState(state) {
  return isRecord(state) && isRecord(state.session) ? state.session : null;
}

/** @param {unknown} value */
function jsonScript(value) {
  return JSON.stringify(value)
    .replace(/</g, "\\u003c")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}

/**
 * @param {{ id: string, log: string, state?: import("./run-state.js").LoopRunState | null, stateDir?: string }} input
 */
export function renderRunLogHtml({ id, log, state = null, stateDir }) {
  const locale = isRecord(state) && typeof state.objective === "string" && hasHangul(state.objective)
    ? "ko"
    : hasHangul(log) ? "ko" : "en";
  const text = wikiText(locale);
  const content = log.trim() ? escapeHtml(log) : escapeHtml(text.outputEmpty);
  const session = normalizeSession(rawSessionFromState(state));
  const sessionLabelText = sessionLabel(session, locale);
  const isLive = session?.status === "running";
  const liveClass = isLive ? "live-pill" : "live-pill static";
  const liveDot = isLive ? "<span class=\"live-dot\"></span>" : "";
  const liveLabel = isLive ? text.liveTail : text.logSnapshot;
  const pollingText = isLive ? text.pollingHint : text.logSnapshot;
  const status = isRecord(state) && typeof state.status === "string" ? state.status : text.notRecorded;
  const phase = isRecord(state) && typeof state.phase === "string" ? state.phase : text.notRecorded;
  const statusText = status === text.notRecorded ? status : displayStatus(status, locale);
  const phaseText = phase === text.notRecorded ? phase : displayPhase(phase, locale);
  const objective = isRecord(state) && typeof state.objective === "string" ? state.objective : id;
  const logCommand = followLogCommand(id, stateDir);
  const resumeCommand = codexResumeCommand(state, log);
  const boot = jsonScript({
    id,
    emptyText: text.outputEmpty,
    pollingHint: pollingText,
    isLive
  });
  const livePollingScript = isLive ? "setInterval(pollLog, 1000);" : "";
  return `<!doctype html>
<html lang="${text.lang}">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Loop Run Log</title>
  <style>
    :root { color-scheme: dark; --ink: #f4f0e8; --muted: #9da0a6; --line: #2a2b31; --panel: #15161a; --page: #090a0d; --blue: #8bd3ff; --green: #77d99a; --amber: #f4c95d; --red: #ff7b72; }
    * { box-sizing: border-box; }
    body { margin: 0; font: 15px/1.55 ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; color: var(--ink); background: var(--page); }
    body::before { content: ""; position: fixed; inset: 0; pointer-events: none; background-image: linear-gradient(rgba(255,255,255,.035) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,.035) 1px, transparent 1px); background-size: 32px 32px; mask-image: linear-gradient(to bottom, rgba(0,0,0,.7), rgba(0,0,0,.12)); }
    main { position: relative; max-width: 1240px; margin: 0 auto; padding: 24px 18px 48px; }
    header { display: flex; justify-content: space-between; gap: 12px; align-items: flex-start; margin-bottom: 14px; }
    h1 { margin: 0; font-size: 25px; line-height: 1.15; overflow-wrap: anywhere; }
    h2 { margin: 0 0 10px; font-size: 13px; text-transform: uppercase; color: var(--muted); letter-spacing: 0; }
    p { margin: 6px 0 0; color: var(--muted); }
    .layout { display: grid; grid-template-columns: minmax(0, 1fr) 320px; gap: 14px; align-items: start; }
    .terminal, .side-card { border: 1px solid var(--line); border-radius: 8px; background: #050609; box-shadow: 0 18px 70px rgba(0,0,0,.28); }
    .terminal-bar { display: flex; justify-content: space-between; gap: 10px; align-items: center; min-height: 38px; padding: 8px 12px; border-bottom: 1px solid var(--line); background: #101116; }
    .traffic { display: flex; gap: 6px; }
    .traffic span { width: 10px; height: 10px; border-radius: 999px; background: var(--muted); opacity: .75; }
    .traffic span:nth-child(1) { background: var(--red); }
    .traffic span:nth-child(2) { background: var(--amber); }
    .traffic span:nth-child(3) { background: var(--green); }
    .live-pill { display: inline-flex; align-items: center; gap: 7px; color: var(--green); font-size: 12px; font-weight: 800; }
    .live-pill.static { color: var(--muted); }
    .live-dot { width: 8px; height: 8px; border-radius: 999px; background: var(--green); box-shadow: 0 0 16px rgba(119,217,154,.75); animation: pulse 1.2s ease-in-out infinite; }
    pre { margin: 0; min-height: 68vh; max-height: 72vh; padding: 16px; overflow: auto; color: #f8fafc; white-space: pre-wrap; overflow-wrap: anywhere; font: 13px/1.55 ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace; }
    #cursor { display: inline-block; width: 8px; height: 16px; margin-left: 2px; background: var(--blue); vertical-align: -2px; animation: blink 1s steps(2, start) infinite; }
    .side-card { display: grid; gap: 14px; padding: 14px; background: var(--panel); }
    .meta { display: grid; gap: 8px; }
    .meta-row { display: grid; grid-template-columns: 76px minmax(0, 1fr); gap: 10px; color: var(--muted); font-size: 13px; }
    .meta-row strong { color: var(--ink); font-weight: 700; overflow-wrap: anywhere; }
    .command-card { display: grid; gap: 8px; padding-top: 12px; border-top: 1px solid var(--line); }
    .command-row { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 6px; align-items: stretch; }
    code { display: block; padding: 9px 10px; border: 1px solid var(--line); border-radius: 7px; background: #0b0c10; color: #e7edf5; overflow-x: auto; font: 12px/1.45 ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace; }
    .button { display: inline-flex; align-items: center; justify-content: center; min-height: 36px; padding: 7px 12px; border-radius: 7px; border: 1px solid var(--line); background: #0d0e12; color: var(--blue); font-weight: 800; text-decoration: none; white-space: nowrap; }
    button.button { cursor: pointer; font: inherit; }
    .status { display: inline-flex; align-items: center; width: fit-content; min-height: 22px; padding: 2px 8px; border-radius: 999px; border: 1px solid rgba(244,201,93,.35); color: var(--amber); background: rgba(244,201,93,.08); font-weight: 800; }
    .status-complete { color: var(--green); background: rgba(119,217,154,.08); border-color: rgba(119,217,154,.35); }
    .status-risk { color: var(--red); background: rgba(255,123,114,.08); border-color: rgba(255,123,114,.35); }
    .small { font-size: 12px; }
    @keyframes pulse { 0%, 100% { opacity: .45; transform: scale(.88); } 50% { opacity: 1; transform: scale(1.08); } }
    @keyframes blink { 0%, 45% { opacity: 1; } 46%, 100% { opacity: 0; } }
    @media (max-width: 900px) { header { display: grid; } .layout { grid-template-columns: 1fr; } pre { min-height: 58vh; max-height: none; } }
  </style>
</head>
<body>
  <main>
    <header>
      <div>
        <h1>${escapeHtml(text.liveRunLog)}</h1>
        <p>${escapeHtml(objective)}</p>
      </div>
      <a class="button" href="/">${escapeHtml(text.backToNotes)}</a>
    </header>
    <section class="layout">
      <div class="terminal">
        <div class="terminal-bar">
          <div class="traffic" aria-hidden="true"><span></span><span></span><span></span></div>
          <span class="${liveClass}">${liveDot}${escapeHtml(liveLabel)}</span>
        </div>
        <pre id="log-scroll"><code id="log-output">${content}</code><span id="cursor" aria-hidden="true"></span></pre>
      </div>
      <aside class="side-card">
        <section class="meta">
          <div class="meta-row"><span>${escapeHtml(text.runId)}</span><strong>${escapeHtml(id)}</strong></div>
          <div class="meta-row"><span>${escapeHtml(text.status)}</span><strong><span class="status ${statusClass(status)}">${escapeHtml(statusText)}</span></strong></div>
          <div class="meta-row"><span>${escapeHtml(text.phase)}</span><strong>${escapeHtml(phaseText)}</strong></div>
          <div class="meta-row"><span>${escapeHtml(text.agentSession)}</span><strong>${escapeHtml(sessionLabelText)}</strong></div>
        </section>
        <section class="command-card">
          <h2>${escapeHtml(text.commandToWatch)}</h2>
          <div class="command-row">
            <code>${escapeHtml(logCommand)}</code>
            <button class="button" type="button" data-copy="${escapeHtml(logCommand)}">${escapeHtml(text.copy)}</button>
          </div>
          <p class="small" id="live-meta">${escapeHtml(pollingText)}</p>
        </section>
        <section class="command-card">
          <h2>${escapeHtml(text.commandToResume)}</h2>
          ${resumeCommand ? `
          <div class="command-row">
            <code>${escapeHtml(resumeCommand)}</code>
            <button class="button" type="button" data-copy="${escapeHtml(resumeCommand)}">${escapeHtml(text.copy)}</button>
          </div>` : `<p class="small">${escapeHtml(text.commandUnavailable)}</p>`}
        </section>
      </aside>
    </section>
  </main>
  <script type="application/json" id="boot">${boot}</script>
  <script>
    const boot = JSON.parse(document.getElementById("boot").textContent || "{}");
    const output = document.getElementById("log-output");
    const scrollBox = document.getElementById("log-scroll");
    const meta = document.getElementById("live-meta");
    const emptyText = boot.emptyText || "";
    function renderLog(log) {
      const next = log && log.trim() ? log : emptyText;
      const wasNearBottom = scrollBox.scrollTop + scrollBox.clientHeight >= scrollBox.scrollHeight - 48;
      output.textContent = next;
      if (wasNearBottom) {
        scrollBox.scrollTop = scrollBox.scrollHeight;
      }
    }
    async function pollLog() {
      try {
        const response = await fetch("/api/runs/" + encodeURIComponent(boot.id) + "/log", { cache: "no-store" });
        if (!response.ok) {
          throw new Error(String(response.status));
        }
        const payload = await response.json();
        renderLog(payload.log || "");
        if (meta) {
          meta.textContent = (boot.pollingHint || "") + " " + new Date(payload.updatedAt || Date.now()).toLocaleTimeString();
        }
      } catch (error) {
        if (meta) {
          meta.textContent = String(error && error.message ? error.message : error);
        }
      }
    }
    for (const button of document.querySelectorAll("[data-copy]")) {
      button.addEventListener("click", async () => {
        const value = button.getAttribute("data-copy") || "";
        await navigator.clipboard.writeText(value);
        const previous = button.textContent;
        button.textContent = ${JSON.stringify(text.copied)};
        setTimeout(() => { button.textContent = previous; }, 900);
      });
    }
    renderLog(output.textContent || "");
    ${livePollingScript}
  </script>
</body>
</html>`;
}
