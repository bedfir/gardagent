# Console browser tests

Run `pnpm test:e2e` after installing workspace dependencies. The script builds the
workspace and runs Chromium using Playwright. Use the official image named in
`e2e/DOCKER_IMAGE`; it already contains the matching browser and system libraries.
Outside the image, install Chromium with `pnpm exec playwright install chromium`.
Keep the pinned dependency, image file and CI container version together when
upgrading Playwright. The runner processes `.team/pnpm-requests.txt` before running
the gate; that step generates the dependency manifest and lockfile changes.

The browser image supplies browsers and system libraries, but does not guarantee
pnpm or Corepack. Provision pnpm 10.28.0 before invoking the root script. CI does
this with `pnpm/action-setup`. A container runner using npm can install it into a
writable prefix (for example, `npm install --prefix /cache/pnpm --no-package-lock
--no-save pnpm@10.28.0`), then prepend `/cache/pnpm/node_modules/.bin` to `PATH`
before running `pnpm test:e2e`. This setup belongs to the runner, before the script
is invoked; suppressing a failed `corepack enable` leaves pnpm unavailable.

Each test starts its own real gateway on an ephemeral loopback port with a fresh
MemoryStore and serves `apps/console/dist`. Admin routes are authenticated with an
obviously fake token. The upstream adapter returns local synthetic responses;
there are no real provider calls, environment-file loading or PostgreSQL setup.
Browser traffic is not intercepted or mocked.

Coverage includes wrong-token refusal, successful admin login and logout, session
reload, existing agent listing, creation and key display, a pending tool call
approved and another rejected with a reason, decision history, agent/model/verdict
and cost filters, filter reload/reset/empty results, a nonempty ledger integrity
result and head hash, and French/English switching with saved locale and translated
login errors. Approval tests check both upstream forwarding and refusal.

Assertions wait for observable state rather than fixed sleeps. Tests use isolated
stores and browser contexts and have no retries. CI uses the same root script and
uploads the HTML report, screenshots and traces on failure. Local artifacts go to
`playwright-report/` and `test-results/` (ignored by Git).

This suite covers Chromium with the in-memory store. It does not establish browser
coverage for PostgreSQL, Firefox, WebKit, mobile layouts or real providers. Execution
and the dependency installation are delegated to the runner; adding this suite is
not evidence of a passing browser run until the runner reports one.
