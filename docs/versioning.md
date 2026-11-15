# Versioning and the road to 1.0

Gardagent is a 0.x project and says so. Version numbers describe how much evidence exists, not how many
features are written. This page is the rule the maintainers follow.

## What a number means today

| Release | Meaning |
| --- | --- |
| `0.x.0` (minor) | New behaviour. May change interfaces or configuration; every such change is listed in the [CHANGELOG](../CHANGELOG.md) with upgrade notes. A database migration is versioned and tested from the previous minor. |
| `0.x.y` (patch) | Fixes only. No schema, ledger-format or hash change; upgrade is a drop-in. Security fixes are announced in [SECURITY.md](../SECURITY.md). |

The ledger is the one surface we treat as a promise already: entries written by a release keep verifying with the
standalone verifier of later releases. If a change would break that, it needs a new ledger format version and a
verifier that still reads the old one.

## Plan

There is no date for 1.0. The next releases are driven by what real users report:

1. **0.5.0, "first users".** The goal is not a feature list. It is: someone outside the project installs it,
   runs the quickstart and the examples, and tells us where it hurt. Their blockers decide the content. Candidates
   already known: a cold-cache quickstart timing, a rehearsed 0.3 to 0.5 upgrade with restore, and the
   `README.fr.md` sync.
2. **0.6 onwards.** Whatever the feedback and the [known limitations](../README.md#status) call for. Each minor
   states its goal in one sentence in the CHANGELOG.

## What 1.0 requires

1.0 is a promise of stability to people we do not know. It is released only when **all** of the following hold,
and the evidence is linked from the release notes:

1. At least three independent deployments or evaluations are reported, covering at least four weeks of use, with
   their upgrade and first-run results.
2. The Anthropic endpoint is verified beyond the single narrow run recorded on 2026-11-12 (one model, short
   prompts, no tool use or cache pricing): more models and request kinds, and the recorded cost compared with
   real billing; otherwise the claim is narrowed or removed.
3. A person, not an AI session, has reviewed the security-critical code: authentication, the ledger and its
   verifier, MCP admission and approvals.
4. The quickstart has been timed by someone other than a maintainer on a cold cache.
5. A restore from backup, including database, spool and executable pairing, has been rehearsed and written up.
6. Two consecutive minors have shipped without a breaking change to the surfaces in the
   [compatibility policy](compatibility.md).

The [readiness inventory](v1-readiness.md) lists the technical evidence collected so far. It is an input to this
list, not a substitute: passing our own tests does not make a release 1.0.

## Names in the documentation

Several documents use "v1" as a label (`upgrade-0.3-to-1.0.md`, "the v1 mandate model", `v1-readiness.md`).
They describe features that exist now. Read "v1" there as "the stable line we are working toward". The
[compatibility policy](compatibility.md) states what will be frozen at 1.0; until then every 0.x release may
change anything not covered by the ledger promise above.
