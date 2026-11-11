# Contributing to Gardagent

Thank you for your interest in contributing! By participating you agree to follow the [Code of Conduct](CODE_OF_CONDUCT.md).
To report a security vulnerability, do not open an issue: see [SECURITY.md](SECURITY.md).

## Where to start

Good first contributions, none of which require deep knowledge of the gateway:

- **Documentation**: fix unclear or outdated passages in the [README](README.md) and [docs/](docs/README.md), or add
  missing examples.
- **Tests**: add cases for edge conditions described in the docs, or tighten existing assertions.
- **Translations**: the console strings live in `apps/console/src/i18n/fr.ts` and `en.ts` (same keys in both; see
  [docs/reference.md](docs/reference.md#console-language)), and `README.fr.md` follows the English README.
- **Known limitations**: the "Known limitations" section of the README lists real gaps; open an issue to discuss before
  starting on one, as some need a design decision.

For anything larger than a small fix, please open an issue first so that the approach can be agreed before you invest time.
The maintainers are volunteers; we cannot promise response times.

## Setup

This project uses [pnpm](https://pnpm.io/) (version pinned in `package.json`) and Node 22. Docker is only needed for the
PostgreSQL-backed tests and the image build.

```bash
corepack enable
pnpm install
```

## Running tests

```bash
pnpm test
```

Tests never call a real model or provider. Without a database, the PostgreSQL-backed tests are skipped; to run them, point
`TEST_DATABASE_URL` at a disposable database, for example:

```bash
docker run -d --name ga-test-pg -e POSTGRES_PASSWORD=test -e POSTGRES_DB=gardagent_test -p 5432:5432 postgres:16-alpine
TEST_DATABASE_URL=postgres://postgres:test@localhost:5432/gardagent_test pnpm test
docker rm -f ga-test-pg
```

Do not use a database that holds data you care about. If you write a test that calls `loadConfig`, remember that
`GARDAGENT_ADMIN_TOKEN` must be at least 32 characters.

## Project rules

- All code, comments, tests, documentation, issues and commit messages must be in **English**.
- French is allowed only in user-facing console strings and in the French README (`README.fr.md`).
- Do not commit secrets or credentials. `.env` files are ignored by git and excluded from the Docker build context for this
  reason; never paste real keys in issues, tests or logs.
- Keep changes focused and minimal, and add or update tests for behavior changes.

## Definition of done

Before opening a pull request, make sure the following pass:

1. `pnpm typecheck`
2. `pnpm test`, including the PostgreSQL tests when `TEST_DATABASE_URL` is available
3. `pnpm build`, and `docker build .` if you touched the `Dockerfile`, dependencies or the build
4. `CHANGELOG.md` has an entry under "Unreleased" for any user-visible change

The pull request template lists these points. Continuous integration runs the same checks.

## Commit messages

Use the imperative mood, keep the summary concise and describe what the change does. For example:

```
Add request timeout to MCP proxy
Fix budget reservation release on stream abort
```
