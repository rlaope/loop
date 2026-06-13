# Loop Engineering MVP Issue Map

This branch keeps one implementation unit per public issue so the pull request
can be reviewed as a sequence instead of one large root commit.

| Issue | Commit unit | Deliverable |
| --- | --- | --- |
| #1 | Tracking map | MVP scope, review order, and PR-level coordination |
| #2 | Repository boundary | Evidence that this is the standalone `rlaope/loop` repository |
| #3 | Project bootstrap | Node package metadata, linting, typecheck, and npm lockfile |
| #4 | Core loop state | Run state, schema validation, durable memory, and public exports |
| #5 | Safety gates | Budget, stop-condition, approval, isolation, and policy checks |
| #6 | Agent adapters | `$loop` skill, plugin manifest, dry-run CLI, and `loop run` prototypes |
| #7 | User docs | README, compatibility matrix, safety notes, and dry-run example |
| #8 | Release gate | Test suite and validation coverage for the first release |
| #9 | Roadmap | Claude Code adapter and connector expansion plan |

The pull request should close the implemented MVP gates and keep future adapter
expansion visible as roadmap work.
