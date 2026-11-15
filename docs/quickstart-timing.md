# Local quickstart timing worksheet

One measured run is recorded below (2026-11-15, maintainer machine, warm caches). It is a
single data point, not a third-party measurement; please add yours via the
"Quickstart feedback" issue template.

## Method

1. Record the revision, OS, CPU, available RAM and disk, Docker Engine and Compose
   versions, curl version, and network conditions. Have Python 3, OpenSSL, curl,
   Docker Engine with Compose v2, git, and a POSIX shell available. No host pnpm
   installation or provider key is required. The README curl examples use
   `--fail-with-body`, requiring curl 7.76.0 or later.
2. Start an external stopwatch immediately before the README `git clone`, then
   enter the cloned directory. Record clone and directory-entry time separately.
3. Run `sh scripts/quickstart-check.sh`. Do not enable shell tracing. Port 8080
   must be free. The script generates a temporary admin token and agent key,
   never displays them, and explicitly disables Compose's implicit environment
   file loading. It uses a unique Compose project so cleanup targets its own
   volumes. It does not reuse the manually started README stack.
4. Copy the summary table into the empty cells below. All phase durations use
   Python's monotonic clock, in seconds. Record success or failure; a failed
   phase is not a completed measurement. Later phases are absent after failure.
5. Record total clone-to-first-call time and clone-to-verification time. Add clone
   time to the script's cumulative elapsed durations (including setup and gaps),
   or use external stopwatch observations. A sum of phase durations omits small
   setup and between-phase overhead; do not present it as the exact total.
6. Record cold or warm image/build caches and network conditions. Fresh project
   volumes mean model weights are downloaded again. Docker image and build
   caches are not cleared by this script. Compare cold and warm runs separately.

The script separates the README's combined `up -d --build` into a build, model
initialization, and remaining startup, preserving dependency order. `model-pull`
includes pulling the Ollama image, starting Ollama, waiting for its health check,
then waiting for `model-init` to exit successfully. `health` includes the remaining
image downloads, service startup, database health and migrations, and polling the
README health response. Compose may revisit the completed model initializer;
any resulting cached pull belongs to `health`. These are elapsed workflow phases,
not isolated model transfer or CPU benchmarks.

Agent creation validates the once-only key. First call requires HTTP success and
nonempty completion content. Ledger read requires an allowed `chat.completions`
entry for that specific agent and model with upstream HTTP 200. Verify requires
`valid: true` and a nonempty checked chain. This is the README's online integrity
check; detecting a self-consistent rewrite or truncation requires an independently
retained checkpoint.

On normal exit, error, HUP, INT, or TERM, the script attempts `docker compose down
-v` for its project and removes private temporary files. SIGKILL or host failure
cannot run cleanup. Cleanup time is excluded from the printed total. Output and
error bodies are suppressed to prevent credential disclosure; failures identify
the phase without publishing raw logs. A cleanup failure reports the project name
for manual retry with `docker compose --env-file /dev/null -p PROJECT -f
docker-compose.local.yml --profile local down -v` (supply a fresh generated
`GARDAGENT_ADMIN_TOKEN` for Compose interpolation).

## Run context

| Field | Result |
| --- | --- |
| Revision / date | 47b4227 (main) / 2026-11-15 |
| OS / architecture | Ubuntu on WSL2, x86-64 |
| CPU / RAM / free disk | Intel N97, 4 cores / 8 GiB / ~946 GiB |
| Docker Engine / Compose | 29.9.2 / 5.6.1 |
| curl / Python | 8.5.0 / 3.12.3 |
| Network conditions | Home broadband (not measured) |
| Image / build cache state | Warm: Docker images from earlier builds were present; model volume fresh (model downloaded). No cold-cache run yet. |
| Exit status / failure phase | 0 / none |

## Results

| Phase | Seconds | Result |
| --- | --- | --- |
| Clone and enter directory (external stopwatch) | not measured | n/a |
| Build | 43.2 | PASS |
| Model pull | 164.3 | PASS |
| Health | 8.5 | PASS |
| Agent creation | 0.1 | PASS |
| First call | 3.3 | PASS |
| Ledger read | 0.1 | PASS |
| Verify | 0.1 | PASS |
| Script total before cleanup | 220.0 | PASS |
| Clone to first call | not measured (script: about 215 without clone) | n/a |
| Clone to verified ledger | not measured (script: 220.0 without clone) | n/a |
| Under 600 seconds to verified ledger? | Yes on this machine with warm image caches; cold-cache result unknown | n/a |

## README and Compose review

- Gateway publication matches the README: `127.0.0.1:8080:8080`. PostgreSQL,
  Ollama, and the fixture publish no host ports.
- `qwen2.5:0.5b`, zero accounting rates, authenticated administration, and the
  synthetic Anthropic fixture agree with the README.
- Startup waits for PostgreSQL health and successful model initialization. The
  readiness poll remains necessary after detached startup.
- The README now explicitly bypasses implicit local environment file loading.
- Prerequisites already cover the required host tools and resource estimates.
  Port 8080 availability and the curl minimum version are additional practical
  constraints recorded here. The single run above passed all phases; resource estimates and cold-cache timing remain unverified.
