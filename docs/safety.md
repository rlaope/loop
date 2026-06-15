# Safety Model

Loop is intentionally bounded. A useful loop has to know when to stop.

## Required State

Every run records:

- objective
- phase
- status, including terminal outcomes
- budget
- attempts
- stop condition
- verification evidence
- approval state
- next action

## Budgets

Budgets apply to the whole run, including nested sub-agents, automations, and
adapter smoke activity. A child agent is not a free side channel.

The MVP tracks:

- max attempts
- estimated token use
- wall-clock time

## Write Approval

Write-capable automation requires durable approval fields:

- `humanApproval`
- `approvalScope`
- `approvalExpiresAt`

If approval is missing or expired, the safe outcome is `unsafe`.

## Isolation

Code-changing loops must choose one of:

- worktree
- branch
- explicit local-mode acknowledgement

The repo-boundary preflight fails when the checkout resolves to an unexpected
parent git root or remote.

Dry-run mode is strict read-only. It writes durable Loop state but does not
expose source edits. It also writes local Loop Wiki artifacts derived from that
state so humans can inspect the run without reading raw transcripts.

Run mode can launch Codex through `codex exec` or Claude Code through
`claude --print`. Write-capable agent runs must call the shared policy gate
before side effects; the write-mode gate requires durable approval, isolation,
and repo-boundary preflight evidence.

## Loop Wiki

Loop Wiki is local-first:

- `.loop/wiki/user/*.md` is the canonical human-readable note.
- `.loop/wiki/ai/*.json`, `index.json`, and `graph.json` are derived artifacts.
- Raw transcripts and private agent internals are not captured by default.
- Exact token usage stays `unknown` unless an agent reports it directly.
- The dashboard binds to localhost only and does not start in non-interactive
  `loop run` unless `--wiki-dashboard` is explicit.
- Dashboard write/external actions require server-issued confirmation tokens
  bound to the action, target id, state directory, and expiry.
- The dashboard confirmation secret is persisted inside the local state
  directory with file mode `0600`; deleting that file invalidates existing
  dashboard action tokens.
- The no-argument Agent Console TUI can prepare local actions, but dangerous
  actions still pass through the shared confirmation model.
- After a run passes the policy gate, wiki generation is part of CLI success.
  If `.loop/wiki` cannot be written, the command exits with code 6 after
  preserving the durable `.loop/runs` state.

## Human Ownership

The loop can collect evidence. The engineer still owns comprehension,
judgment, and release decisions.
