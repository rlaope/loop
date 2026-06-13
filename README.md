# Loop

<p align="center">
  <img src="assets/loop-engineering-poster.png" alt="Loop Engineering poster" width="640">
</p>

Loop is a safety-first Loop Engineering toolkit for coding agents.

Instead of prompting an agent every turn, define a purpose and let the loop
drive the agent through intake, planning, discovery, isolation, action,
verification, memory, and stopping rules.

The MVP proves the shared core and Codex `$loop` adapter first. Claude Code
`/loop`, connectors, scheduled write automation, and marketplace distribution
are roadmap work after the core contract is stable.

## Loop Engineering Components

![Loop Engineering components](assets/loop-engineering-components.png)

Loop is built around six working components:

- Automations: repeatable read-only discovery, triage, and scheduled checks.
- Worktrees: isolated branches or directories for code-changing work.
- Skills: durable workflow instructions such as `$loop`.
- Plugins/connectors: distribution and optional external context surfaces.
- Sub-agents: delegated maker/checker or specialist lanes.
- Memory: markdown, JSON state, or issue boards that survive one chat session.

## What Ships In The MVP

- Durable local memory in `.loop/runs/*.json`, `.loop/runs/*.md`, and
  `.loop/latest-runs.json`.
- A shared run-state schema with objective, phase, budget, stop condition,
  verification evidence, approval state, and next action.
- Budget and stop-condition helpers for bounded agent loops.
- Repo-boundary and isolation preflight helpers for code-changing work.
- A Codex plugin manifest and `$loop` skill.
- A dry-run CLI path that writes state without changing source files.

## Quickstart

```sh
npm install
node bin/loop.js --dry-run --objective "Triage open maintenance work"
```

The command writes a durable state record under `.loop/runs/` and updates the
latest-run index.

The current CLI is strict dry-run/read-only. Source edits and write-capable
automation are intentionally not exposed until the write policy gate is wired
into a later adapter surface.

To verify the package:

```sh
npm test
npm run lint
npm run typecheck
```

## Codex Usage

Install or load this repository as a Codex plugin source, then invoke:

```text
$loop <objective>
```

The skill tells the agent to record durable state, check repository boundaries,
choose an isolation mode, enforce budgets, and keep maker/checker separation.

## Safety Defaults

Loop is not an excuse to stop engineering. It is a way to make agent repetition
observable and bounded.

- Every loop needs a budget and stop condition before work starts.
- Code-changing loops need a worktree, branch, or explicit local-mode
  acknowledgement.
- MVP automations are read-only or triage-only unless durable human approval
  exists.
- Passing tests are evidence, not proof that the human no longer owns the
  result.

## Docs

- [Loop Engineering concept](docs/loop-engineering.md)
- [Compatibility matrix](docs/compatibility.md)
- [Safety model](docs/safety.md)
- [Issue-to-commit map](docs/issues.md)
- [Roadmap](docs/roadmap.md)
- [Dry-run maintenance example](examples/dry-run-maintenance.md)

## Development

```sh
npm install
npm test
npm run lint
npm run typecheck
```

Build the loop, stay the engineer.
