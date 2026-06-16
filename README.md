# Loop

<p align="center">
  <a href="https://github.com/rlaope/loop"><img src="https://img.shields.io/badge/GitHub-rlaope%2Floop-181717?logo=github&logoColor=white" alt="GitHub repository"></a>
  <a href="https://github.com/rlaope/loop/stargazers"><img src="https://img.shields.io/github/stars/rlaope/loop?style=social" alt="GitHub stars"></a>
  <a href="https://github.com/rlaope/loop/blob/main/LICENSE"><img src="https://img.shields.io/github/license/rlaope/loop" alt="License"></a>
  <a href="#quickstart"><img src="https://img.shields.io/badge/npm-github%3Arlaope%2Floop-CB3837?logo=npm&logoColor=white" alt="npm install from GitHub"></a>
  <a href="https://x.com/rlaope"><img src="https://img.shields.io/badge/X-%40rlaope-000000?logo=x&logoColor=white" alt="X @rlaope"></a>
</p>

![Loop Engineering poster](assets/loop-engineering-poster.png)

<div align="center">
  <p><strong>Recursive goals for coding agents that need memory, budgets, and stopping rules.</strong></p>
  <p>Loop is a safety-first Loop Engineering toolkit for coding agents.</p>
  <p>
    Instead of prompting an agent every turn, define a purpose and let the loop
    drive the agent through intake, planning, discovery, isolation, action,
    verification, memory, and stopping rules.
  </p>
  <p>
    The MVP proves the shared core and Codex <code>$loop</code> adapter first.
    Claude Code <code>/loop</code>, connectors, scheduled write automation,
    and marketplace distribution are roadmap work after the core contract is
    stable.
  </p>
  <p>
    Built by <a href="https://github.com/rlaope">@rlaope</a> ·
    <a href="https://rlaope.github.io/artengine-lab/">Art & Engineering</a>
  </p>
</div>

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
- Loop Wiki second-brain storage in `.loop/wiki/user/*.md`,
  `.loop/wiki/ai/*.json`, `.loop/wiki/index.json`, and
  `.loop/wiki/graph.json`.
- A shared run-state schema with objective, phase, budget, stop condition,
  verification evidence, approval state, and next action.
- Budget and stop-condition helpers for bounded agent loops.
- Repo-boundary and isolation preflight helpers for code-changing work.
- A Codex plugin manifest and `$loop` skill.
- A dry-run CLI path that writes state without changing source files.
- A `loop run` command that can hand an objective to Codex or Claude Code after
  agent selection and optional goal clarification.
- Best-effort desktop notifications on macOS, Windows, and Linux when a run
  starts, needs human attention, or finishes and needs review.
- A no-argument `loop` Agent Console for inspecting runs, wiki notes, log
  tails, agent choice, follow-up intent, and Codex resume actions from a TUI.
- `loop wiki` commands for listing, reading, opening, serving, deleting, and
  adding local second-brain notes.
- A localhost-only Loop Wiki dashboard with graph view, markdown note reading,
  live log pages, token-confirmed local actions, follow-up command preparation,
  and a button to open Codex in a separate terminal when a Codex session exists.

## Quickstart

Install Loop once:

```sh
npm install -g github:rlaope/loop
loop --version
loop doctor
loop demo
```

Create or enter the project you want the coding agent to work on:

```sh
mkdir darkwear-exhibit
cd darkwear-exhibit
loop "Build a darkwear luxury exhibition site"
```

If the folder is not a git repository yet, `loop` initializes a local git
repository there first. That keeps write-capable agent work bounded to the
folder you started from, even when the folder lives inside a larger parent repo.

`loop "prompt"` asks you to type `1` or `2` to choose the prototype agent, then
opens the Agent Console processing view in the same terminal. The agent output
is captured in the run log while the TUI shows the current run state, next
action, wiki count, graph count, and live log tail. When the agent exits, Loop
finishes the state/wiki update and leaves you in the normal Agent Console.

Use `loop run "prompt"` when you want the older explicit CLI stream that prints
agent output and returns JSON for scripts. If you like the short command but
want to skip the processing TUI for one run, use `loop "prompt" --just-run`.

- `codex`
- `claudecode`

You can skip the picker by passing the agent explicitly:

```sh
loop run --agent codex "Build a darkwear luxury exhibition site"
loop run --agent claudecode "Build a darkwear luxury exhibition site"
loop --agent codex "Build a darkwear luxury exhibition site" --just-run
```

After at least one run exists, typing only `loop` in an interactive terminal
opens the local Agent Console TUI. Use it to select a run, read wiki context,
tail logs, add notes, record verification, mark a run complete, prepare a
follow-up objective, open the dashboard, or open/resume Codex in a new terminal
tab when a concrete Codex session id has been recorded. Follow-up commands
include `--parent-run` lineage so the next loop remains connected to the
previous run. In non-interactive shells, no-argument `loop` prints guidance
instead of waiting for input.

If you want to try Loop without installing it first:

```sh
npm exec --yes --package github:rlaope/loop -- loop "Build a darkwear luxury exhibition site"
```

Before a first real run, `loop doctor` checks the local Node.js, git, package,
repo-boundary, and optional agent CLI readiness without writing `.loop`,
launching agents, starting the dashboard, or calling the network. `loop demo`
prints a small command catalog for common first-run, explicit-agent, and
dry-run follow-up workflows; it is also read-only.

If Loop says the git root does not match, you probably passed an explicit
`--expected-root` that does not match the current project. Run Loop from the
folder you want the agent to edit, or pass the intended root explicitly.

If the prompt is too ambiguous for a loop, the CLI asks a short deep-interview
style set of questions in the terminal, closes the interview, records the
clarified objective, and then starts the selected coding agent.

When a Loop Wiki dashboard is already running, `loop "prompt"` and `loop run`
open it automatically. If it is not running in an interactive terminal, Loop
asks whether to start it; choosing Yes starts the localhost dashboard and opens
it in your browser.

Interactive CLI runs also send best-effort system notifications when the agent
starts, when Loop needs human attention, and when the agent finishes and needs
review. Disable them with `--no-notify` or `LOOP_DISABLE_NOTIFICATIONS=1`; use
`LOOP_FORCE_NOTIFICATIONS=1` for non-interactive shells.

While an agent is running, Loop writes a live session record and log under
`.loop/runs`. You can inspect the run from another terminal:

```sh
loop status
loop runs
loop logs --follow
```

`loop status` shows whether a Codex or Claude Code process is currently alive.
`loop runs` lists previous sessions. `loop logs <run-id>` prints a captured
agent log, and `loop logs --follow` streams the latest run log.

Running the same objective again creates a new run session. Older sessions are
not reactivated; they remain in history and related wiki notes are connected in
the graph view.

Dry-run mode is still available when you only want durable state and a wiki
note without source edits:

```sh
loop --dry-run --objective "Build a darkwear luxury exhibition site"
```

Read the generated second-brain notes locally:

```sh
loop wiki list
loop wiki read <note-id>
loop wiki open <note-id>
loop wiki delete <note-id>
loop wiki
```

`loop wiki` starts and opens a localhost-only dashboard for `.loop/wiki`. The
main run note under `.loop/wiki/user` is canonical for the loop session; AI
memory, index, and graph files are derived from the local wiki. `loop run` does
not start the dashboard in non-interactive automation unless `--wiki-dashboard`
is passed. Most users can ignore that flag and open the dashboard later with
`loop wiki`.

The dashboard is also a local action surface. Each run stack can add attached
notes, record verification, mark the run complete, prepare a follow-up command
with a chosen agent, delete run or note artifacts, open the graph view, and
open Codex in a new terminal when a Codex session id is available. Mutating or
external actions are protected by server-issued confirmation tokens bound to
the local state directory, action, target, and expiry. The dashboard secret is
stored under the local state directory so a browser tab does not lose valid
actions just because the localhost server restarted.

A loop is not limited to one markdown file. The run note is the parent context,
and you can attach multiple implementation plans, verification findings,
decisions, references, or ideas to the same run:

```sh
loop wiki add --kind plan --title "Implementation plan" --body "Build the gallery first, then verify responsive spacing."
loop wiki add --kind verification --title "QA findings" --body "Mobile product cards need another pass."
loop wiki add --kind idea --title "Curation angle" --body "Group pieces by silhouette instead of brand."
```

If you need to attach a note to a specific session, pass `--run <run-id>`. If
you omit it, Loop attaches the new note to the latest run note in the local wiki.

To remove a run-state session and its captured log:

```sh
loop runs delete <run-id>
```

To verify the package:

```sh
npm install
npm run verify
```

After the package is published to npm, the shorter registry form will be:

```sh
npx @rlaope/loop "Build a darkwear luxury exhibition site"
npx @rlaope/loop run "Build a darkwear luxury exhibition site"
npx @rlaope/loop --dry-run --objective "Build a darkwear luxury exhibition site"
npm install -g @rlaope/loop
```

## Codex Usage

Install or load this repository as a Codex plugin source, then invoke:

```text
$loop <objective>
$Loop <objective>
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
npm run verify
```

Build the loop, stay the engineer.
