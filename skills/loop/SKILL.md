---
name: loop
description: Run a Loop Engineering workflow for a coding-agent objective with durable state, budget/stop rules, isolation checks, and human verification boundaries. Use when the user invokes $loop or asks the agent to keep iterating safely until a goal is complete.
---

# Loop

Loop turns a user objective into a bounded agent run: intake, plan, discover,
isolate, act, verify, persist, then stop or escalate.

## Invocation

Use this skill for:

- `$loop <objective>`
- "run a loop for this"
- "keep iterating until this goal is complete"

## Operating Contract

Before changing source files:

1. Record the objective, budget, stop condition, and next action in durable
   state outside the chat.
2. Confirm the repository boundary and remote.
3. Choose an isolation mode: worktree, branch, or explicit local-mode
   acknowledgement.
4. Keep write-capable automation read-only or triage-only unless durable human
   approval exists.
5. Use maker/checker separation for implementation and verification.

## Local CLI

To run a coding agent through the Loop CLI:

```sh
loop run "<objective>"
loop run --agent codex "<objective>"
loop run --agent claudecode "<objective>"
```

`loop run` records durable state, asks for an agent when one is not provided,
asks clarifying deep-interview style questions when the objective is ambiguous,
then launches the selected coding agent.

For state-only smoke checks:

```sh
node bin/loop.js --dry-run --objective "<objective>"
```

The dry-run path writes `.loop/runs/*.json` and `.loop/runs/*.md` records
without changing source files or launching an agent.

## Component Map

- Automations: scheduled read-only discovery and triage.
- Worktrees: isolated execution when changes are needed.
- Skills: reusable workflow instructions such as this `$loop` surface.
- Plugins/connectors: distribution plus optional tool integrations.
- Sub-agents: maker/checker and specialist delegation.
- Memory: durable local state, optionally synced to an issue tracker later.
