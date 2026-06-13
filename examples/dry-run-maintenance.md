# Dry-Run Maintenance Example

Use this path to prove Loop can persist state without changing source files.

```sh
node bin/loop.js \
  --dry-run \
  --objective "Triage open maintenance work" \
  --state-dir .loop
```

Expected result:

- `.loop/runs/<id>.json` is written.
- `.loop/runs/<id>.md` is written.
- The JSON state includes the objective, budget, stop condition, approval
  state, verification evidence, and next action.
- No source files are modified by the dry-run itself.

To add repository-boundary checking:

```sh
node bin/loop.js \
  --dry-run \
  --objective "Triage open maintenance work" \
  --expected-root "$(pwd)" \
  --expected-remote "https://github.com/rlaope/loop.git"
```
