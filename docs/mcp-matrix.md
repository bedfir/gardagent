# MCP governance matrix

Target behaviour of the MCP proxy for v1, to be implemented by M08. The rule is that **nothing passes silently**: every
message the proxy can see is either *governed and journaled*, *handled locally* (answered by the gateway, never
forwarded), or *refused* (never forwarded, answered with an error). Anything not listed here is refused. The matrix is
an allow-list, not a deny-list: a new method or notification added by a later revision of the protocol is refused until
this document and the code are updated.

The method names below are those of the MCP specification revision 2025-06-18. The proxy exposes only the Streamable
HTTP transport, as `POST /mcp/:server`; each server is declared in `GARDAGENT_MCP_SERVERS`.

## 0.3.0 behaviour (replaced by this matrix)

In 0.3.0 only `tools/call` is governed and journaled. Every other JSON-RPC message that has an id or a method
(`initialize`, `tools/list`, `resources/*`, `prompts/*`, notifications, …) is forwarded to the upstream server after the
agent key is checked, with no ledger row and no policy applied. JSON-RPC batches are refused with HTTP 400 and code
`-32600`. There is no route for `GET` or `DELETE`. A test of 0.3.0 asserts the forwarding of non-`tools/call` traffic;
M08 replaces that test, as allowed by the team rules.

## 1. Transports and framing

| Item | Decision | Reason |
| --- | --- | --- |
| `POST /mcp/:server`, one JSON-RPC message, response as JSON | Governed (per method below) | The only transport carried. |
| `POST` whose response is `text/event-stream` | Governed; events relayed one by one, see section 4 | Responses to governed calls may stream; the relayed text is hashed into `responseHash`. |
| JSON-RPC batch (array body) | Refused, HTTP 400, `-32600` (unchanged) | The 2025-06-18 revision removed batching; one message per request keeps one decision per row. |
| Body that is not a JSON-RPC 2.0 message | Refused, HTTP 400, `-32600` (unchanged) | Cannot be classified. |
| Message with an `id` and no `method` (a *response* from the client to a server request) | Refused, HTTP 400, `-32600`, journaled denial `mcp_client_response_refused` | The proxy never relays server-initiated requests to the client (section 4), so a client has nothing legitimate to answer. |
| `GET /mcp/:server` (server-to-client listening stream) | Refused, HTTP 405 with `Allow: POST` | An open stream carries server-initiated traffic that is not tied to a governed call and could not be journaled per message. Clients must tolerate 405 per the specification. |
| `DELETE /mcp/:server` (session termination) | Refused, HTTP 405 with `Allow: POST` | Sessions expire upstream; the proxy keeps no session state. |
| Legacy HTTP+SSE transport (2024-11-05) | Not carried (no route) | Out of scope. |
| stdio transport | Not applicable | Gardagent is an HTTP gateway; a stdio server is reached through its own HTTP bridge, declared as a URL. |
| `mcp-session-id`, `mcp-protocol-version` headers | Relayed both ways (unchanged) | Opaque to the proxy. |
| Unknown server name | HTTP 404, `-32000` (unchanged) | Not declared. |
| Missing or invalid agent key | HTTP 401 (503 `agent_unverifiable_during_outage` during an outage), journaled as `invalid_key` (unchanged) | Authentication comes first for every row of this table. |

## 2. Client-to-server requests (have an `id` and a `method`)

| Method | Decision | Ledger row | Reason |
| --- | --- | --- | --- |
| `initialize` | Governed: forwarded | `mcp.initialize`, allowed, cost 0 | Opens the session; proves which agent opened it and which protocol version was negotiated. No tool is exposed by it. |
| `ping` | Handled locally: the gateway answers `{}` | None | No effect and no data; journaling liveness probes would drown the ledger. Not forwarded, so it cannot carry data upstream. |
| `tools/list` | Governed: forwarded, and the result is **filtered to the tools the agent is allowed to call** | `mcp.tools/list`, allowed, cost 0 | The list is the agent's view of its mandate; tools outside it must not be advertised. |
| `tools/call` | Governed as in 0.3.0: tool allow-list, read/write class, approval, journal | `mcp.tools/call` (plus approval rows) | The only method that acts. |
| `resources/list`, `resources/templates/list`, `resources/read` | Refused, HTTP 200 with JSON-RPC error `-32601`, journaled denial | `mcp.<method>`, denied, reason `method_not_governed` | Mandates in v1 cover tools. Reading arbitrary resources would be data access outside the mandate. |
| `resources/subscribe`, `resources/unsubscribe` | Refused, same | same | Subscriptions create unrequested server-to-client traffic. |
| `prompts/list`, `prompts/get` | Refused, same | same | Prompts inject content into the agent's context outside the mandate. |
| `completion/complete` | Refused, same | same | Depends on prompts and resources, which are refused. |
| `logging/setLevel` | Refused, same | same | Changes the state of a server session shared by other callers. |
| Any other method (including extension methods and methods of later revisions) | Refused, same | `mcp.<method>` (method text truncated to 100 characters), denied, reason `method_not_governed` | Default deny. |

The `-32601` refusals are journaled as denials because a refusal is an event a delegating party may need to see. An
agent that probes methods in a loop is bounded by the rate limit of M09 and by the auth-failure aggregation already in
the gateway, not by silence.

## 3. Client-to-server notifications (have a `method`, no `id`)

A notification has no response; the proxy answers HTTP 202 with an empty body when it accepts one, and HTTP 202 with no
forwarding when it refuses one (a refusal cannot be an error response, because there is no id to answer). A refused
notification is still journaled.

| Notification | Decision | Ledger row | Reason |
| --- | --- | --- | --- |
| `notifications/initialized` | Governed: forwarded after admission (valid agent key, declared server, rate limit of M09, `params` absent or an object) | `mcp.notifications/initialized`, allowed, cost 0, `upstreamStatus` as returned upstream | Completes the handshake. It happens after, and independently of, the `mcp.initialize` row, which cannot record it; it is its own event. |
| `notifications/cancelled` | Governed: forwarded after the same admission checks and `params` an object with a `requestId` | `mcp.notifications/cancelled`, allowed, cost 0, `upstreamStatus` as returned upstream | Cancelling changes the outcome of an operation, so it is journaled. Its `requestHash` covers `params`, hence the cancelled `requestId`. The row does not link itself to the cancelled call's row; the matching is by that id and the agent, which a reader can do from the hash of the call it knows. |
| `notifications/progress` | Refused (202, not forwarded) | `mcp.notifications/progress`, denied, reason `method_not_governed` | Progress refers to a server-initiated request, which the proxy never relays. |
| `notifications/roots/list_changed` | Refused | same | Roots are not supported (`roots/list` is refused below). |
| Any other notification | Refused | `mcp.<method>`, denied, reason `method_not_governed` | Default deny. |

## 4. Server-to-client traffic (inside a governed response stream)

Server messages reach the client only inside the SSE response to a governed `POST` (there is no listening stream; see
section 1).

| Message from the server | Decision | Reason |
| --- | --- | --- |
| The JSON-RPC response to the request | Relayed; hashed into `responseHash` | The governed outcome. |
| `notifications/progress`, `notifications/message` (logging), `notifications/cancelled` | Relayed | Informational, part of the stream whose text is hashed. |
| `notifications/tools/list_changed`, `notifications/prompts/list_changed`, `notifications/resources/list_changed`, `notifications/resources/updated` | Relayed | Informational; acting on them needs a governed `tools/list`, or a refused method. |
| `sampling/createMessage` (the server asks the agent's model to generate) | Not relayed; the call is journaled with reason `server_request_refused` | It would make the agent's model work for the server outside the agent's model allow-list and budget. |
| `elicitation/create`, `roots/list` | Not relayed; same journal reason | The agent has no human to ask, and roots are not supported. |
| `ping` from the server | Not relayed; the gateway does not answer | No effect on the governed call. |
| Any other server-initiated request | Not relayed; same journal reason | Default deny. |

Because a server-initiated request that is not relayed is never answered, the upstream call may then wait. The
proxy limits that wait with the existing upstream timeout and ends the stream; the row carries the reason.

## 5. Ledger and policy for the new rows

- New actions follow the existing naming: `mcp.initialize`, `mcp.tools/list`, and `mcp.<method>` for refusals.
- All rows carry `cost` 0, `promptTokens` 0, `completionTokens` 0; `model` is `<server>/-` when no tool is concerned
  (the exact placeholder is for M08 to fix and test; it must not collide with `<server>/<tool>#read|write`).
- In `observe` mode the proxy forwards what `enforce` mode would refuse, journaling the row with reason
  `observed:method_not_governed` (as `observed:tool_not_allowed` today). `observe` never turns a refusal of section 1
  (malformed or unsupported framing) into a forward.
- Request bodies are never written into the ledger; only a `requestHash`. Its input depends on the row:
  - `mcp.tools/call` and the approval rows (`mcp.approval.requested`, `mcp.approval.decided`): the canonical JSON of
    `params.arguments ?? {}`, **unchanged from 0.3.0**. The approval is bound to this hash and the executed call must
    produce the same value (`docs/mandate.md`, `docs/ledger-format.md`); M08 must not change it.
  - Every other method or notification (`initialize`, `tools/list`, `notifications/*`, refusals): the canonical JSON
    of `params ?? {}`. These rows have no approval, so no equality with another hash is at stake. The hash proves what
    the client sent in `params`, not the method name, which the `action` field carries.
- The matrix is tested by a table-driven test in M08: one case per row above, asserting the HTTP outcome, whether the
  upstream was called, and the ledger row.
