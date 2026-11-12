# Documentation index

Start with the [README](../README.md) for the quick start, the configuration table, the security model and the known
limitations.

## Guides

| Document | Description |
| --- | --- |
| [self-hosting.md](self-hosting.md) | Running Gardagent on your own Linux host: install, TLS, administration allow-list, authentication-failure limits, agents, routine checks, backups and removal. |
| [reference.md](reference.md) | Detailed behavior: provider headers, MCP governance and read/write tools, `observe` and `enforce` modes, database outage handling, human approval, the admin API, the console. |
| [industrial-setup.md](industrial-setup.md) | Declaring MCP servers with read and write tools for plant and ERP-style environments, why writes need approval, and a safety notice (Gardagent is not a functional-safety system). |
| [migration-timing.md](migration-timing.md) | How schema migrations run and measured timings on a one-million-row ledger, with the `tools/migration-timing` script used. |
| [compatibility.md](compatibility.md) | What is stable from 1.0 (HTTP API, error codes, agent key format, ledger format, schema, environment variables), what "compatible" means, the deprecation rule and what is not covered. |
| [ledger-format.md](ledger-format.md) | The ledger format: version 1 as written by 0.3.0 (fields, canonical JSON, hash input, chain rule) and the version 2 specification. |
| [mandate.md](mandate.md) | The v1 mandate model: operators, policy revisions, approvals correlated to the entries they authorize, and what a token does not prove. |
| [mcp-matrix.md](mcp-matrix.md) | Target governance of every MCP method, notification and transport the proxy can see. |
| [../deploy/README.md](../deploy/README.md) | The deployment kit: Docker Compose stack, Caddy TLS edge, install, backup, restore and rotation scripts. |

## Technical archives (validation reports)

These files are dated records of end-to-end validation runs of earlier builds, kept for transparency. They describe what was
observed at the time, against specific commits, on a test server with test data; they are not guides, and the current
behavior is documented in the files above and in the [CHANGELOG](../CHANGELOG.md). The "pilot zero" name is historical: it
refers to the harness in `tools/pilot-zero`.

| Document | Description |
| --- | --- |
| [pilot-zero.md](pilot-zero.md) | The end-to-end validation harness, its acceptance criteria, and rounds 1 to 4 plus the first fault-injection tests (spool, fail-open, outages during streams). |
| [pilot-zero-round5.md](pilot-zero-round5.md) | Round 5: validation of the v0.2 changes and real outage scenarios. |
| [pilot-zero-round5-followup.md](pilot-zero-round5-followup.md) | Follow-up investigation of the points left unexplained by round 5. |
| [v0.2.1-validation.md](v0.2.1-validation.md) | Validation of v0.2.1: deployment, baseline and scenario results. |
| [validation-0.3.0.md](validation-0.3.0.md) | Validation of v0.3.0: fresh install from the documentation, kit checks and the 9-criterion end-to-end round. |
