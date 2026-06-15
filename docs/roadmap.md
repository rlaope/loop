# Roadmap

This roadmap keeps the first release honest: the MVP ships durable Loop state,
dry-run safety checks, a local Agent Console TUI, a local Loop Wiki dashboard,
and a prototype `loop run` surface for Codex and Claude Code. Rich automation,
native command adapters, external sync, and hosted knowledge storage remain
future work.

## Public Alpha Readiness

- Keep `loop doctor` read-only and local-only so first-time users can inspect
  Node.js, git, repo-boundary, package, and optional agent CLI readiness before
  launching a loop.
- Keep `loop demo` as a read-only command catalog. It must not write `.loop`,
  launch agents, start dashboards, or make network calls.
- Keep `npm run verify` as the contributor and CI quality gate for lint,
  typecheck, tests, and package-content validation.

## Claude Code Adapter

- Harden the `loop run --agent claudecode` prototype with parity tests against
  real Claude Code behavior.
- Add a native `/loop` command surface that mirrors the Codex `$loop` lifecycle.
- Keep the same durable run-state schema so Codex and Claude runs can be
  compared without translation.
- Require explicit write approval and workspace isolation before enabling any
  non-dry-run behavior.

## Knowledge Store

- Ship a local Loop Wiki baseline under `.loop/wiki`.
- Keep `.loop/wiki/user/*.md` as the canonical human-readable note.
- Derive `.loop/wiki/ai/*.json`, `.loop/wiki/index.json`, and
  `.loop/wiki/graph.json` from the canonical note and run metadata.
- Keep local dashboard actions token-confirmed and localhost-bound.
- Keep exact token usage as `unknown` unless an agent reports it directly.
- Defer external sync to GitHub, Linear, Notion, Obsidian, or cloud services.

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
- The public alpha CLI must expose `loop doctor`, `loop demo`, `loop --help`,
  `loop --version`, `loop status`, `loop runs`, `loop logs`, and `loop wiki`
  with matching README examples and local tests.
