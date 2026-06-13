# Security Policy

Loop is a safety-first agent workflow toolkit. Please report security issues
privately instead of opening a public issue with exploit details.

## Supported Versions

The project is pre-1.0. Security fixes target the latest `main` branch until
versioned releases begin.

## Reporting A Vulnerability

Open a private GitHub security advisory for this repository, or contact the
repository owner through GitHub if advisories are unavailable.

Please include:

- affected version or commit
- reproduction steps
- expected impact
- whether credentials, local files, or external systems are involved

## Security Boundaries

The current MVP is strict dry-run/read-only. Write-capable automation, external
connectors, and scheduled actions must remain gated by durable approval,
workspace isolation, repo-boundary preflight, and budget checks before they are
exposed.
