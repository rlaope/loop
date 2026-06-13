# Contributing

Thanks for helping improve Loop.

Loop is early-stage infrastructure for agent workflows, so changes should stay
small, reviewable, and safety-first.

## Development

```sh
npm install
npm test
npm run lint
npm run typecheck
```

## Pull Requests

- Keep one logical change per commit when possible.
- Link commits or PR sections to the issue they address.
- Include tests for behavior changes and safety boundaries.
- Keep public docs narrower than the implementation until behavior is verified.
- Do not add write-capable automation without explicit approval, isolation, and
  budget enforcement.

## Review Bar

A change is not ready to merge until the relevant tests pass, package metadata
still matches the shipped surface, and docs do not overclaim support for
roadmap-only adapters or connectors.
