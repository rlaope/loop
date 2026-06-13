# Roadmap

This roadmap keeps the first release honest: the MVP ships durable Loop state,
dry-run safety checks, and a prototype `loop run` surface for Codex and Claude
Code. Rich automation, native command adapters, and long-term knowledge storage
remain future work.

## Claude Code Adapter

- Harden the `loop run --agent claudecode` prototype with parity tests against
  real Claude Code behavior.
- Add a native `/loop` command surface that mirrors the Codex `$loop` lifecycle.
- Keep the same durable run-state schema so Codex and Claude runs can be
  compared without translation.
- Require explicit write approval and workspace isolation before enabling any
  non-dry-run behavior.

## Knowledge Store

- Accumulate human-readable run summaries, decisions, blockers, and evidence
  into a future knowledge store.
- Shape the store like an LLM-readable project wiki so humans can inspect work
  without reading raw chat transcripts.
- Keep `.loop/runs/*.json` and `.loop/runs/*.md` as the append-only baseline
  until richer sync targets exist.

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

- Codex and Claude Code run prototypes stay explicit until adapter parity tests
  cover both real CLIs.
- A write-capable loop must fail closed on unknown policy modes, missing
  approvals, unsafe worktree state, missing repo-boundary evidence, and
  exhausted budgets.
