# Security policy

## Reporting a vulnerability

Please report security vulnerabilities **privately**, through GitHub:

1. Open the **Security** tab of this repository.
2. Choose **Report a vulnerability** (GitHub private vulnerability reporting).
3. Describe the issue, the affected version, and steps to reproduce it. Do not include real secrets or real data.

Do not open a public issue, pull request or discussion for a vulnerability, and do not disclose it publicly before a fix
is available.

## What to expect

Gardagent is maintained by volunteers, so everything below is **best effort**, not a commitment:

- We aim to acknowledge a report within about 7 days.
- We will tell you whether we consider it a vulnerability, and keep you informed while we work on a fix.
- Fix times depend on severity and on maintainer availability; we cannot promise a deadline.
- Disclosure is coordinated: we publish a fixed release and an advisory first, and credit you if you wish. If a report
  receives no answer from us after a reasonable time, you are free to disclose it responsibly.
- There is no bug bounty program.

## Supported versions

Only the **latest published release** receives security fixes. Please reproduce the issue on the latest release before
reporting it.

## Scope

In scope:

- The gateway application (`apps/gateway`), the core library (`packages/core`) and the admin console (`apps/console`).
- The Docker image built from the `Dockerfile`, the root `docker-compose.yml` and the deployment kit in `deploy/`.
- Bypasses of the documented guarantees: agent authentication, model and tool allow-lists, budgets, human approval,
  and the integrity of the append-only ledger.

Out of scope:

- Behaviors already documented as limitations (see "Known limitations" in the [README](README.md)), for example the fact
  that only MCP `tools/call` is governed.
- Exposure caused by deploying differently from the documentation, for example publishing the gateway port to an
  untrusted network without the reverse proxy of `deploy/`.
- Weak or leaked secrets chosen by the operator, and the security of the model providers or MCP servers behind the
  gateway.
- Denial of service through traffic volume (there is no per-agent rate limiting yet), and findings that require
  administrator access or access to the host.
- Vulnerabilities in third-party dependencies with no demonstrated impact on Gardagent (please report those upstream).

Gardagent is a governance gateway, not a functional-safety system; see [docs/industrial-setup.md](docs/industrial-setup.md).

## Release image verification

For images produced by the release-chain workflow, verify the immutable image index digest, its keyless Sigstore signature, and its attached BuildKit provenance and SPDX inventory before deployment. Follow [the release verification procedure](docs/verify-release.md), including its first-release checklist. Earlier images may lack this evidence, and a failed signing job can leave an unsigned image in the registry.

The signature establishes the GitHub workflow/tag identity that signed the digest; it does not establish code safety or a human operator's identity. The attached inventory and provenance are build-system assertions bound by the signed index. Builds are not reproducible bit for bit. End-to-end publication and verification remain untested until a human pushes a tag and records the checklist results.
