# Security policy

OpenCodex is a proxy and client integration that can handle model-provider credentials,
local Codex state, OAuth sessions, and management endpoints. Please report security
issues privately so affected users have time to update before details become public.

## Supported versions

| Release line | Security fixes |
| --- | --- |
| `main` (development) | Best-effort fixes for verified issues |
| Latest stable `@groeponline/opencodex` release on npm | Best-effort fixes |
| Current npm `preview` release | Evaluated case by case; update to the latest build |
| Older releases | Not maintained |

A fix on `main` does not mean an npm package or running deployment has been
updated. Check the published version and its release notes before assuming a
remediation is installed.

## Report a vulnerability privately

Use [GitHub private vulnerability reporting](https://github.com/GroepOnline/opencodex/security/advisories/new).
Do not post unpublished exploit details, access tokens, private hostnames, or
reproduction data in a public issue, pull request, discussion, or log.

If GitHub's private reporting form cannot be accessed, open a public issue
asking maintainers for a private coordination channel. Include **no**
vulnerability details or sensitive attachments in that issue. This project
does not advertise a separate private security email address.

Potentially relevant areas include authentication and authorization, session
handling, secrets and provider keys, unintended exposure of local Codex
state, management/API access, proxy request isolation, update/install paths,
and build or release automation.

## Useful information in a report

- Affected package version, commit, operating system, and deployment mode
  (local CLI, dashboard, container, or remote proxy).
- A minimal reproduction using synthetic credentials and non-production
  endpoints, including expected behavior versus observed behavior.
- A clear impact statement, preconditions, and whether an unauthenticated
  or lower-privileged actor can trigger the behavior.
- Relevant sanitized logs or requests. Remove access tokens, cookies,
  authorization headers, personal data, and customer content.

Please do not scan, exploit, or extract data from a deployment that you do
not own or have permission to test.

## Triage, fixes, and disclosure

Maintainers triage privately on a best-effort basis: confirm scope and
reproduction, assess impact, prepare a fix or mitigation, and coordinate
publication through a security advisory when appropriate. No fixed
response or remediation SLA and no bug-bounty payment are promised.

Security fixes require validation on the exact code revision. Publication
to npm, GitHub Releases, container images, or a separately operated
runtime are distinct actions; a merged fix does not prove deployment.

## Deployment responsibilities

Operators should limit management interfaces to trusted networks or
authenticated access, protect stored provider credentials, and keep
runtime and dependencies updated. If a key or token has been exposed,
revoke or rotate it through its issuing provider without sharing the
credential in the report.

For non-sensitive hardening proposals, use ordinary issues or pull
requests. See [Contributing](./CONTRIBUTING.md) and
[Maintainers](./MAINTAINERS.md) for the normal review process.
