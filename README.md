# Hermes Hub Gateway Plugin

This plugin is the Hermes Hub host connection. Hermes Gateway owns its
lifecycle, and the plugin maintains one authenticated outbound WebSocket to the
Router while calling Hermes only through its loopback public API Server.

```text
Flutter client
  -> Hermes Hub Router
  -> Hermes Hub Gateway Plugin
  -> loopback Hermes public API Server
  -> Hermes Agent and SessionDB
```

The stable `HERMES_HUB_AGENT_ID` identifies one logical Hermes Agent across
re-pairing and host restarts. `HERMES_HUB_GATEWAY_ID` and
`HERMES_HUB_GATEWAY_TOKEN` identify one transport instance and may be rotated
together. This preserves multiple devices and multiple independent session
chatrooms without coupling client identity to a WebSocket instance.

Chatroom `session_id` values remain Hermes SessionDB identities. They are never
derived from `hermesAgentId` or `gatewayId`, so reconnecting or rotating a
Gateway does not fork, reset, or replay an existing chatroom.
Different sessions may run concurrently up to the configured host bound; one
session may have only one active run, matching Hermes session lifecycle rules.
The process lock is scoped to the stable `hermesAgentId`, so rotating a Gateway
credential cannot accidentally start two transports for the same Agent.

## Hermes pairing skill

A Hermes-format orchestration skill is shipped under
[`skills/hermes-hub-gateway-pairing/`](skills/hermes-hub-gateway-pairing/).
It does not replace this runtime plugin. Its Node.js wrapper validates a local
pinned release policy, Router health, pending request, installer bytes, and
SHA-256 before launching the verified installer exactly once. Pairing approval,
plugin/config mutation, Gateway restart, exact online verification, and the
8-digit code remain owned by `install.mjs`.

Install or publish the complete skill directory so its `scripts/`,
`references/`, and `templates/` remain beside `SKILL.md`; installing only the
markdown file is incomplete. The approval token is never stored in the skill.
Provision it through a protected machine-local Hermes process environment or a
supported Hermes secret manager before starting pairing.

For clients that know the skill is installed, use the concise request template
at
[`templates/pairing-request.md`](skills/hermes-hub-gateway-pairing/templates/pairing-request.md)
instead of embedding the installer implementation in every prompt. Run its
wrapper tests with:

```powershell
node skills/hermes-hub-gateway-pairing/scripts/pair.test.mjs
```

## Pair and install

Create a pairing request in the client, then run from this standalone
repository root:

```powershell
node install.mjs `
  --router http://127.0.0.1:4320 `
  --request-id pair_example
```

From the Hermes Hub monorepo root, use:

```powershell
node apps/hermes-hub-gateway-plugin/install.mjs `
  --router http://127.0.0.1:4320 `
  --request-id pair_example
```

On Windows, the pinned installer currently resolves `whoami.exe` through
`PATH`; the Hermes service environment must therefore resolve the native
`C:\Windows\System32\whoami.exe` before any Git/MSYS shim. This is an existing
installer-release prerequisite, not something the pairing skill overrides.

The installer:

1. Recovers or rolls back any interrupted installation for the same identity.
2. Creates a private candidate identity and snapshots the current config, env,
   and plugin without changing the committed identity.
3. Verifies the exact six-file Gateway package against
   `package-manifest.json`. A standalone bootstrap `install.mjs` downloads the
   package from the Router before any host runtime is changed.
4. Approves the Router pairing request with that candidate.
5. Installs the plugin through a staged same-filesystem atomic swap, configures
   the loopback API Server, and restarts Hermes Gateway.
6. Waits until Router reports the exact candidate `hermesAgentId`, `gatewayId`,
   protocol, and post-restart connection online.
7. Starts a transient detached finalizer from the installed package, writes the
   8-digit code to stdout, and exits so Hermes can return the code to the client
   without deadlocking on an unfinished shell tool.
8. The finalizer commits the candidate identity only after Client claim makes
   that exact Gateway credential active. If the claim expires, it restores the
   prior plugin/config/env and restarts the prior runtime instead.

Progress is written to stderr and credentials are never printed. Router
approval is always protected: set the same 32-or-more-character
`HERMES_HUB_AGENT_APPROVAL_TOKEN` in the Router and installer process
environments. To keep the logical Agent id while replacing a
host transport credential, add `--rotate-gateway`. The finalizer is a bounded
installation child, not another persistent service. A failure before identity
commit restores the previous plugin/config/env and restarts that previous
runtime. A later invocation also performs the same recovery after a process or
machine crash.

The installable package contains only `__init__.py`, `adapter.py`,
`protocol.py`, `plugin.yaml`, `install.mjs`, and `package-manifest.json`.
Repository docs, tests, caches, and development files are never copied into the
Hermes plugin directory. If only `install.mjs` is present, its default package
source is the public GitHub raw directory at
`https://raw.githubusercontent.com/over01470914/hermes-hub-gateway-plugin/main/`.
The source is public and requires no repository credential. Use
`--source-base <url>` only for an intentional Router source or mirror. An
explicit private CNB mirror may use a machine-local read-only `CNB_TOKEN`; the
token is sent only to the exact `cnb.cool` host in an authorization header and
is never placed in a URL or log. Package sources must
use HTTPS outside loopback, contain no credentials/query/fragment, and return
content directly without redirects. Every payload byte count and SHA-256 must
match the manifest or installation stops before modifying Hermes.

## Capability negotiation

Every connection probes the current public API Server before sending `hello`:

- `health` covers the public API Server health and capability descriptors.
- `sessions` covers the public `/api/sessions` list/create/read/update/delete,
  messages, and fork routes.
- `sessions.usage` is a bounded projection of usage fields in public session
  metadata; the plugin does not call a private context RPC.
- `chat.stream` covers `POST /v1/runs` plus ordered
  `GET /v1/runs/{run_id}/events`.
- `run.stop` and `run.approval` map only to the exact-run `/v1/runs/{run_id}`
  stop and approval routes.
- `models` is included only when `GET /v1/models` returns a valid, non-empty
  list. Model choice is sent with a new run; it is not persisted by a session
  model patch.
- `cron` is included only when `/v1/capabilities` sets `jobs_admin=true` and
  enumerates the complete jobs list/create/read/update/delete/pause/resume/run
  contract. Hermes Agent main and the locally verified 0.18.2 build currently
  advertise `jobs_admin=false`, so they remain fail-closed.
- Generic slash or command dispatch, steer, clarify/sudo/secret responses,
  media upload, Kanban, configuration writes, reasoning/fast mutation, and
  persistent session-model patches are not advertised or routed.

An allowlisted operation without its negotiated capability fails closed. A run
is never replayed after a timeout or transport loss.

## Security boundary

- Router receives the Gateway host credential only as the WebSocket bearer and
  during the protected pairing approval request.
- Non-loopback Router URLs must use HTTPS/WSS; plaintext HTTP/WS is accepted
  only for loopback development.
- `API_SERVER_KEY` is attached only to loopback HTTP calls.
- The local API URL must be an HTTP or HTTPS loopback origin using
  `127.0.0.1`, `localhost`, or `::1`; it may not contain credentials, a path,
  query parameters, fragments, or redirects.
- The plugin does not log prompts, message bodies, credentials, keys, or local
  filesystem paths.
- Private Hermes RPC methods are not compatibility fallbacks for a missing
  public operation.
- Only the session, run-control, health, and model routes listed in
  [PROTOCOL.md](docs/PROTOCOL.md) can reach the API Server.

See [OPERATIONS.md](docs/OPERATIONS.md) for recovery and verification.

## Configuration validation

Hermes calls the plugin dependency check before merging platform settings, so
that check never reads credentials or runtime configuration. The later
configured-state check requires `API_SERVER_ENABLED=true`, validates the
effective Router WebSocket transport (`ws` is loopback-only; remote transport
must use `wss`), enforces the `agent_` and `gw_` identity formats, and rejects
invalid timeout values instead of silently clamping them.

The accepted host bounds are: concurrency `1..64`, request timeout `3..600`
seconds, handshake timeout `1..30`, run-start timeout `3..30`, and stop-confirm
timeout `1..30`. Adapter values may come from `PlatformConfig.extra`; the
global Hermes API Server enablement remains the `API_SERVER_ENABLED` service
switch.
