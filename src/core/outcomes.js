export const terminalOutcomes = Object.freeze([
  "complete",
  "paused",
  "budget_exhausted",
  "unsafe",
  "failed",
  "blocked"
]);

export const nonTerminalOutcomes = Object.freeze(["continue"]);

export const allOutcomes = Object.freeze([
  ...terminalOutcomes,
  ...nonTerminalOutcomes
]);

/** @param {string} outcome */
export function isTerminalOutcome(outcome) {
  return terminalOutcomes.includes(outcome);
}

/** @param {string} outcome */
export function isKnownOutcome(outcome) {
  return allOutcomes.includes(outcome);
}
