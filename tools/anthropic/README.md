# Human-only Anthropic verification

Status: **verified once against the provider, narrowly** (see the recorded result below): one model, plain and streaming requests, usage and configured-cost check. Everything else remains format-compatible only. Automated tests use hand-built public-format fixtures, never real responses. Agents must never run this harness. It is outside the test suite and refuses to run whenever `CI` is defined, even with opt-in.

Use Node 22 and installed workspace dependencies. From the repository root, build with `pnpm build`. In a private interactive shell, read your own key without echoing it or putting its value in shell history:

```bash
read -rsp 'Anthropic key: ' ANTHROPIC_API_KEY
export ANTHROPIC_API_KEY
read -rp 'Model identifier available to your key: ' ANTHROPIC_VERIFY_MODEL
export ANTHROPIC_VERIFY_MODEL
read -rp 'Configured input USD per million: ' ANTHROPIC_VERIFY_INPUT_RATE
export ANTHROPIC_VERIFY_INPUT_RATE
read -rp 'Configured output USD per million: ' ANTHROPIC_VERIFY_OUTPUT_RATE
export ANTHROPIC_VERIFY_OUTPUT_RATE
GARDAGENT_VERIFY_ANTHROPIC=1 node tools/anthropic/verify.mjs
unset ANTHROPIC_API_KEY
```

The model and rates are required; no possibly stale provider rates are assumed. With no explicit opt-in, the command prints SKIP before importing gateway modules or reading the key. Do not source or create an environment file. Disable shell tracing before entering credentials. The harness reads the key at runtime, retains it only in memory and writes no files. Output contains only pass/fail status. These two real requests may incur provider charges.

The harness uses the built gateway with authentication enabled and an ephemeral MemoryStore, sends a non-streaming and a streaming request to `https://api.anthropic.com/v1/messages`, compares upstream and downstream response bodies, validates format, reconstructs usage and checks the ledger and spend. It does not exercise PostgreSQL, persistent deployment configuration, cache hits, provider billing reconciliation, or stream latency. A failure prints no exception or provider body; check the build and supplied configuration before retrying. A UTC-midnight crossing fails rather than producing an ambiguous spend assertion.

## Accounting contract

Configured rates are USD per million, numerically micro-USD per counted unit. Recorded cost is `ceil((input_tokens + cache_creation_input_tokens + cache_read_input_tokens) * inputRate + output_tokens * outputRate)`, rounded once after summation. Missing cache counts are zero. Streaming starts with `message_start.message.usage`; fields in `message_delta.usage` replace prior values, including cumulative output. The unit fixtures explicitly test this replacement.

Cache creation and read counts are priced at the ordinary configured input rate, **not distinct provider cache rates**. Nested `cache_creation` duration breakdowns are ignored to avoid double counting; `server_tool_use`, `service_tier` and all other usage fields are ignored. This checks Gardagent's configured accounting, not equality to a provider invoice. The harness makes no promise of generating cache traffic; synthetic tests cover those fields.

## Record a human result

After a human run, add a dated section to this file with commit identifier, Node version, exact model identifier, configured input/output rates, each mode's PASS/FAIL, and limitations. Never record keys, environment dumps, prompts, response bodies or account identifiers. A passing result supports only that revision, model, modes and accounting configuration. Update compatibility wording only to the extent supported by that recorded result.

## Recorded results

### 2026-11-12 — one run, authorised by the maintainer, executed by the project lead

- Revision: `22e4e81` (`v1-dev`, merge of M14). Node 22.23.3 (`node:22-bookworm` container).
- Model: `claude-haiku-5-5`. Configured rates: 0.10 USD per million input tokens, 0.50 USD per million output tokens.
- Non-streaming request: PASS (response format passed through, usage captured, recorded cost equals usage x configured rates).
- Streaming request: PASS (same checks).
- Limitations: a single run with short prompts on one model; no long-context pricing tier, no cache-token pricing and no tool use were exercised; the provider's real billing was not compared with the recorded cost. This is not a statement of general provider compatibility.
- Run by the project lead (an AI agent) with a temporary, spend-limited key supplied by the maintainer. The key was not stored in the repository and is to be revoked by the maintainer.
