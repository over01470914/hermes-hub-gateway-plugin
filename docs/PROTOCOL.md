# Hermes Hub Gateway transport protocol

Protocol: `hermes-hub-gateway-rpc/v1`.

The lifecycle-owned plugin connects outbound to:

```text
/router/hermes-hub-gateways/{gatewayId}/stream
```

The host credential is sent only as an `Authorization: Bearer` header. It is
never placed in a URL or frame.

## Identity and hello

`hermesAgentId` is the durable logical Agent identity. `gatewayId` identifies a
rotatable transport instance. Router authenticates the WebSocket path and
bearer first. It sends a `ready` frame containing both ids and the selected
protocol; the plugin validates that frame, sends `hello`, then validates a
matching `hello_ack`. The plugin is not connected and does not start its RPC
receive loop until this bounded handshake completes:

```json
{
  "type": "hello",
  "hermesAgentId": "agent_...",
  "gatewayId": "gw_...",
  "runtime": "hermes-hub-gateway",
  "mode": "api-server",
  "protocols": ["hermes-hub-gateway-rpc/v1"],
  "capabilities": ["health", "sessions", "chat.stream"]
}
```

Heartbeat acknowledgements also carry both public ids. Authentication failure,
identity mismatch, or credential revocation is terminal for that socket; Hermes
Gateway decides whether and when to reconnect.

The two host ids are transport scope only. Router chatroom `session_id` remains
the canonical Hermes SessionDB id and is passed unchanged through the public
session create/read/fork/history APIs. Reconnect and credential rotation never
create a replacement session or replay an in-flight user message.

The plugin permits concurrent runs for different SessionDB ids, but rejects a
second active run for the same session with `session_busy`. This keeps stop and
approval routing isolated to one run while preserving multi-chatroom use.

## Frames

Router sends bounded `rpc_request`, `rpc_stream_request`,
`rpc_stream_cancel`, and `heartbeat` frames. The plugin responds with
`rpc_response`, `rpc_stream_chunk`, `rpc_stream_end`, `rpc_stream_error`, and
`heartbeat_ack`. Request, session, run, event name, payload, and event ordering
are preserved.

## Capability negotiation

Before opening the Router WebSocket, the plugin probes `/health` and
`/v1/capabilities`. Core capabilities are derived only from matching public
feature flags and endpoint descriptors. `/v1/models` is probed independently.
Cron is negotiated only when `jobs_admin=true` and all eight jobs
read/write/execute descriptors are present. A jobs-list probe by itself never
enables Cron. Current Hermes Agent main still advertises `jobs_admin=false`.

This version never advertises steer, clarify, media upload, Kanban, or generic
configuration mutation.

## Loopback allowlist

Permitted public API Server routes are:

- `GET /health`, `GET /v1/health`, `GET /v1/capabilities`
- `GET /v1/models`, only with negotiated `models`
- `GET|POST /api/sessions`
- `GET|PATCH|DELETE /api/sessions/{sessionId}`
- `GET /api/sessions/{sessionId}/messages`
- `POST /api/sessions/{sessionId}/fork`
- With negotiated `cron`: `GET|POST /api/jobs`
- With negotiated `cron`: `GET|PATCH|DELETE /api/jobs/{jobId}`
- With negotiated `cron`: `POST /api/jobs/{jobId}/pause|resume|run`
- Internal run start, status, SSE, approval, and stop calls required by an
  already negotiated chat stream.

Absolute URLs, non-loopback origins, credentials in URLs, redirects, path
traversal, unsupported methods, and oversized bodies are rejected.

## Ordering and completion

Each upstream SSE event is sent before the next event is read. For a successful
run, one canonical `message.complete` fallback is emitted immediately before
the single terminal `run.completed` event. No later upstream chunk is forwarded
after a terminal event. If SSE closes before a terminal event, the plugin polls
the public run status and emits the same terminal semantics. Control-plane
activity never becomes assistant content.

Run start is shielded from request cancellation. If cancellation races the
loopback `POST /v1/runs`, the plugin still collects the accepted `run_id` and
issues a compensating stop. A stop response of `stopping` is not terminal: the
session stays quarantined and rejects new runs until polling observes
`completed`, `failed`, or `cancelled`; a background reconciler continues after
the bounded foreground confirmation window. Teardown itself is bounded.
Timeout or transport loss never causes automatic replay.
