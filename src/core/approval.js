/**
 * @param {import("./run-state.js").LoopRunState} state
 * @param {string} scope
 * @param {Date} [now]
 */
export function hasActiveApproval(state, scope, now = new Date()) {
  if (!state.approvals.humanApproval) {
    return false;
  }
  if (!state.approvals.approvalScope.includes(scope)) {
    return false;
  }
  if (!state.approvals.approvalExpiresAt) {
    return false;
  }
  return Date.parse(state.approvals.approvalExpiresAt) > now.getTime();
}

/**
 * @param {import("./run-state.js").LoopRunState} state
 * @param {{ scope?: string, now?: Date }} [options]
 * @returns {{ outcome: "continue" | "unsafe", reason: string }}
 */
export function requireWriteApproval(state, { scope = "write", now = new Date() } = {}) {
  if (hasActiveApproval(state, scope, now)) {
    return { outcome: "continue", reason: "durable human approval is active" };
  }
  return {
    outcome: "unsafe",
    reason: `write-capable automation requires active durable approval for scope: ${scope}`
  };
}
