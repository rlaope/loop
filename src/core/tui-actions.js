export const TUI_ACTIONS = Object.freeze([
  { id: "dashboard", label: "Dashboard", runRequired: false },
  { id: "logs", label: "Logs", runRequired: true },
  { id: "wiki", label: "Wiki", runRequired: false },
  { id: "codex", label: "Codex", runRequired: true, confirm: true },
  { id: "note", label: "Note", runRequired: true },
  { id: "verify", label: "Verify", runRequired: true },
  { id: "follow", label: "Follow-up", runRequired: true },
  { id: "agent", label: "Agent", runRequired: false },
  { id: "complete", label: "Complete", runRequired: true, confirm: true },
  { id: "refresh", label: "Refresh", runRequired: false },
  { id: "quit", label: "Quit", runRequired: false }
]);

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

/** @param {string} value */
export function normalizeTuiAction(value) {
  const lower = value.trim().toLowerCase();
  return TUI_ACTION_ALIASES.get(lower) ?? null;
}
