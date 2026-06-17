# Loop Engineering

Loop Engineering is the shift from directly prompting a coding agent every turn
to designing a system that prompts, checks, and stops the agent on your behalf.

A loop is a recursive goal: define the purpose, give the agent safe operating
rules, and let it iterate until the stop condition says the work is complete,
blocked, unsafe, failed, or out of budget.

## Components

| Component | MVP role |
| --- | --- |
| Automations | Read-only discovery and triage by default. |
| Worktrees | Isolation boundary for code-changing work. |
| Skills | Durable workflow instructions such as `$loop`. |
| Plugins/connectors | Distribution and optional tool integrations. |
| Sub-agents | Maker/checker and specialist delegation. |
| Memory | Local durable state outside the chat session, with optional Obsidian mirroring for human-readable markdown notes. |

## Lifecycle

1. Intake: objective, risk, budget, stop condition.
2. Plan: acceptance criteria and verification evidence.
3. Discover: local code, issues, CI, docs, or connector context.
4. Isolate: worktree, branch, or explicit local-mode acknowledgement.
5. Act: run the selected skill, command, or bounded sub-agent work.
6. Verify: tests, lint, typecheck, smoke checks, and reviewer evidence.
7. Persist: state, attempt, evidence, next action, blockers, terminal status.
8. Stop: complete, paused, budget exhausted, unsafe, failed, or blocked.

Loop Wiki memory stays markdown-first. `.loop/wiki/user/*.md` is the human note,
derived JSON/index/graph files are for agents and dashboards, and optional
Obsidian sync mirrors only human-facing markdown content into a local vault.
Delete and rename propagation needs a separate tombstone or move contract.

Loop does not remove the engineer. It gives the engineer a visible control
surface for repeated agent work.
