# Safety Model

Loop is intentionally bounded. A useful loop has to know when to stop.

## Required State

Every run records:

- objective
- phase
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

The MVP CLI is strict dry-run/read-only. It writes durable Loop state but does
not expose source edits or write-capable automation. Future write surfaces must
call the shared policy gate before side effects.

## Human Ownership

The loop can collect evidence. The engineer still owns comprehension,
judgment, and release decisions.
