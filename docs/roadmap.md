# Roadmap

This roadmap keeps the first release honest: the MVP ships a Codex-native,
strict dry-run loop surface, while write-capable automation and cross-agent
parity remain future work.

## Claude Code Adapter

- Add a `/loop` command surface that mirrors the Codex `$loop` lifecycle.
- Keep the same durable run-state schema so Codex and Claude runs can be
  compared without translation.
- Require explicit write approval and workspace isolation before enabling any
  non-dry-run behavior.

## Plugins And Connectors

- Treat connectors as evidence sources first, not automatic write targets.
- Add connector capability metadata before invoking external systems.
- Keep connector use gated by the same budget, stop-condition, and approval
  checks used by the local CLI.

## Sub-Agents And Worktrees

- Add a planner-to-executor handoff format for bounded sub-agent tasks.
- Record worktree path, branch, and remote evidence in every run state.
- Keep spawned agents below the parent run budget unless the user creates a new
  budget envelope.

## Release Criteria

- The Codex MVP remains the only supported runtime until adapter parity tests
  exist for another agent.
- A write-capable loop must fail closed on unknown policy modes, missing
  approvals, unsafe worktree state, missing repo-boundary evidence, and
  exhausted budgets.
