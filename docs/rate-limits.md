# Per-agent rate limits

Set `requestsPerMinute` and `maxConcurrentRequests` through `POST /admin/agents` or `PATCH /admin/agents/:id`. Each accepts an integer from 0 to 2147483647; zero or an omitted field on creation means unlimited. A patch omitting a field keeps its current value. Limit changes create immutable policy revisions.

The rolling minute counts admissions in the preceding 60 seconds. The concurrency limit counts active responses, including streaming responses and MCP approval waits. The same agent shares both limits across model endpoints and MCP; separate agents have separate counters. A refusal is recorded as `rate_limited`, costs zero and creates no budget reservation. Refused attempts do not extend the rolling window. Observe mode forwards the request and records `observed:rate_limited` in its completion entry.

Model endpoints return HTTP 429 in their provider's error format and a `Retry-After` header in whole seconds, rounded up until enough admissions expire. A concurrency refusal uses 1 second as a retry hint; it cannot predict when a running response will finish. MCP requests currently return HTTP 200 with JSON-RPC error -32004 and `retryAfter` data; this is a gap against the v1 exit criterion requiring HTTP 429 for rate limiting. MCP notification refusals return HTTP 429 and an empty body, with no JSON-RPC response. Both include `Retry-After`.

This is a single-instance feature. State lives only in the gateway process. Restarting discards every counter and minute-window history. Policy edits preserve the process's existing active counts and recent history. Concurrency slots are released on response finish or client disconnect, including error responses. Authentication failures retain their separate source-address limiter.
