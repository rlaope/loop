# Compatibility Matrix

| Surface | MVP behavior | Notes |
| --- | --- | --- |
| Codex `$loop` | Shipped first. | `$loop <objective>` maps to the Codex skill in `skills/loop/SKILL.md`. |
| Codex `/goal` | Interop only. | Long-running goal tracking can wrap the durable plan, but the core state remains local. |
| Codex automations | Read-only or triage-only by default. | Write-capable automation requires durable human approval. |
| Codex worktrees | Supported as an isolation decision. | Code-changing loops should prefer worktree or branch isolation. |
| Claude Code namespaced `/loop` | Roadmap. | A future Claude adapter should default to a namespaced command to avoid conflicts. |
| Claude Code bare `/loop` | Explicit opt-in only. | Bare `/loop` can conflict with built-in or user-customized command behavior. |
| Connectors/MCP | Roadmap. | Optional after local durable state and first adapter tests are stable. |
| Issue tracker memory | Roadmap. | Local `.loop` state is the MVP baseline. |

## Command Naming

Codex uses `$` for explicit skill invocation, so the first adapter targets
`$loop`. Claude Code already has slash-command conventions, so the safe default
for a future Claude adapter is namespaced rather than bare `/loop`.

The MVP documentation should never imply that Claude parity has shipped before
the second adapter exists.
