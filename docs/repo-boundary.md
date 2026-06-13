# Repository Boundary

Loop is published from the standalone repository at
`https://github.com/rlaope/loop.git`.

Local boundary checks for this pull request:

- Git top level: verified with `git rev-parse --show-toplevel` inside this
  repository.
- Default remote: `origin`
- Remote URL: `https://github.com/rlaope/loop.git`
- PR base branch: `main`
- PR implementation branch: `codex/loop-mvp-issue-commits`
- Backup branch for the original single-commit import:
  `backup/single-commit-mvp`

The `main` branch is intentionally kept as the pull-request comparison base.
The implementation branch rebuilds the MVP as issue-sized commits.
