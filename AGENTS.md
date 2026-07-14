# Hermes Hub Gateway Plugin Agent Notes

This module is the only Hermes host transport for Hermes Hub. Hermes Gateway
owns its start, stop, failure notification, and reconnect lifecycle.

## Hermes reference discipline

Before changing lifecycle, identity, pairing, session, or API behavior, compare
against the matching official Hermes Agent sources:

- `gateway/platforms/base.py` for adapter state, fatal notification, scoped
  locks, teardown, and reconnect ownership;
- `gateway/session.py` for one-active-run session isolation and durable session
  identity;
- `gateway/pairing.py` for private atomic state, code secrecy, expiry, and
  approval boundaries;
- `gateway/platforms/api_server.py` for the only loopback endpoints and
  capabilities this plugin may expose.

## Boundary

- Use only public Hermes plugin, `BasePlatformAdapter`, and loopback API Server
  contracts.
- Keep `HERMES_HUB_AGENT_ID` stable across pairing. Gateway id and credential
  may rotate together without changing the logical Hermes Agent identity.
- Never log or return `HERMES_HUB_GATEWAY_TOKEN`, `API_SERVER_KEY`, pairing
  approval material, prompts, message bodies, provider keys, or local paths.
- Send both `hermesAgentId` and `gatewayId` in every host hello and heartbeat
  acknowledgement. Never put a credential in a frame or URL.
- Keep Router chatroom `session_id` independent from both host ids. Session
  create/read/fork/history must remain public API Server and SessionDB work.
- Derive advertised capabilities from the live `/v1/capabilities` response.
  Advertise `models` only after its concrete endpoint probe passes. Keep Cron
  fail-closed until its read, write, and execute surfaces can each be proven by
  a public contract; a successful jobs-list probe is not sufficient.
- Keep all loopback calls behind the explicit allowlist in `protocol.py`.
- Do not expose generic configuration mutation or private Hermes runtime APIs.
- Do not advertise steer, clarify, media, or Kanban until a complete public
  implementation and tests exist.
- Never automatically replay a dispatched run or ambiguous mutation.

## Verification

```powershell
python -m unittest discover apps/hermes-hub-gateway-plugin/tests -v
node apps/hermes-hub-gateway-plugin/install.smoke.mjs
```

For stream/lifecycle changes, also prove cancellation stops the active Hermes
run and provide a non-secret Router -> Gateway Plugin -> API Server -> Hermes
smoke result.
