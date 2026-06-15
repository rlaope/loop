# Compatibility Matrix

| Surface | MVP behavior | Notes |
| --- | --- | --- |
| Codex `$loop` / `$Loop` | Shipped first. | `$loop <objective>` and the display-case `$Loop <objective>` map to the Codex skill in `skills/loop/SKILL.md`. |
| Loop Agent Console TUI | Shipped local baseline. | `loop` with no arguments opens a terminal console for run selection, wiki/log reading, verification notes, lineage-preserving follow-up intent, dashboard open, and Codex resume actions when a session id is known. |
| Loop CLI Codex agent | Prototype. | `loop run --agent codex "prompt"` launches `codex exec` after Loop state and safety checks. |
| Loop CLI Claude Code agent | Prototype. | `loop run --agent claudecode "prompt"` launches `claude --print` after Loop state and safety checks. |
| Loop Wiki CLI | Shipped local baseline. | `loop wiki list/read/open/serve` reads `.loop/wiki` notes and serves a localhost dashboard. |
| Loop Wiki dashboard actions | Shipped local baseline. | Dashboard forms use persisted server-issued confirmation tokens for local mutations and external Codex terminal launch. |
| Codex `/goal` | Interop only. | Long-running goal tracking can wrap the durable plan, but the core state remains local. |
| Codex automations | Read-only or triage-only by default. | Write-capable automation requires durable human approval. |
| Codex worktrees | Supported as an isolation decision. | Code-changing loops should prefer worktree or branch isolation. |
| Claude Code namespaced `/loop` | Roadmap. | A future native Claude command should default to a namespaced command to avoid conflicts. |
| Claude Code bare `/loop` | Explicit opt-in only. | Bare `/loop` can conflict with built-in or user-customized command behavior. |
| Connectors/MCP | Roadmap. | Optional after local durable state and first adapter tests are stable. |
| Issue tracker memory | Roadmap. | Local `.loop` state and Loop Wiki are the MVP baseline. |

## Command Naming

Codex uses `$` for explicit skill invocation, so the first adapter targets
`$loop`. Claude Code already has slash-command conventions, so the safe default
for a future Claude adapter is namespaced rather than bare `/loop`.

The MVP documentation should never imply that Claude parity has shipped before
the second adapter exists.
