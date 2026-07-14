# Hermes Hub Gateway Plugin operations

## Managed local state

The installer stores one private
`platforms/hermes-hub-gateway/identity.json` below the active Hermes home. It
contains:

- stable `HERMES_HUB_AGENT_ID`;
- rotatable `HERMES_HUB_GATEWAY_ID`;
- rotatable `HERMES_HUB_GATEWAY_TOKEN`.

The formal identity is changed only after Router confirms that Client claim
promoted the exact candidate Gateway credential to `active`. Merely observing
a provisional socket online is not a commit. The file and installer state use
`0600` files inside `0700` directories on POSIX. On Windows the installer
removes inherited access and grants the current user full control; failure to
establish the private ACL is fatal. The identity must not be copied to another
machine, committed, attached to diagnostics, or included in backups shared
with other users.

During installation, a sibling `.identity.json.install-state/` directory holds
the pending candidate, crash journal, private config/env/plugin snapshots, and
the verified six-file Gateway package used by the atomic swap.
It can contain Gateway and local API credentials. Do not inspect it in shared
shell transcripts, copy it into diagnostics, or delete it while an installer is
running. A per-identity lock rejects concurrent installers. Transaction state
is removed after either a claimed/verified commit or a complete rollback.

Hermes configuration also contains `API_SERVER_ENABLED=true`, loopback host and
port, `API_SERVER_KEY`, Router URL, the three host identity values, and the
loopback API URL. The API Server must remain bound to `127.0.0.1`; never expose
its bearer key or port to a LAN.

## Standard pairing

From a standalone Gateway Plugin checkout:

```powershell
$env:HERMES_HUB_AGENT_APPROVAL_TOKEN = '<same 32+ character machine-local value configured on Router>'
node install.mjs `
  --router https://router.example `
  --request-id pair_example
```

From the Hermes Hub monorepo root:

```powershell
$env:HERMES_HUB_AGENT_APPROVAL_TOKEN = '<same 32+ character machine-local value configured on Router>'
node apps/hermes-hub-gateway-plugin/install.mjs `
  --router https://router.example `
  --request-id pair_example
```

Router approval protection is mandatory in every environment. Never put this
value in a command argument, committed file, pairing prompt, or log.

The foreground command does not return a pairing code until Router approval,
atomic plugin swap and discovery, Hermes configuration, Gateway restart, and
exact candidate registration all succeed. It then starts a detached bounded
finalizer, writes only the final 8 digits to stdout, and exits. This is
intentional: when Hermes invokes the installer as a shell tool, the client may
not see stdout until that tool finishes, so waiting for Client claim in the
foreground would deadlock pairing.

The detached finalizer polls only the exact candidate. Client claim promotes
the credential to `active`, after which the finalizer atomically commits the
formal identity and removes backups. If the code is never claimed, expiry
causes an automatic plugin/config/env rollback and old-runtime restart. The
finalizer is a transient installation process, not a persistent host service.

Remote Router URLs must use HTTPS. Plain HTTP is accepted only for a loopback
Router on the same host.

## Package delivery

The pairing command may download only a standalone `install.mjs`. When its
directory does not already contain a complete valid package, the installer
fetches `package-manifest.json` and the fixed payload allowlist from
`https://raw.githubusercontent.com/over01470914/hermes-hub-gateway-plugin/main/`
by default. The public GitHub source requires no repository credential.
`--source-base` can select the Router source endpoint or a controlled mirror,
but never relaxes transport or integrity checks. An explicit private CNB
mirror may use a least-privilege read-only `CNB_TOKEN` in the installer process
environment; it is sent only to the exact `cnb.cool` host and is never logged
or put in a URL.

The manifest has a bounded schema and package version plus the byte length and
SHA-256 of each payload. The currently executing bootstrap must match the
manifest's `install.mjs` entry. Redirects, missing/extra names, symbolic local
files, invalid hashes, unexpected lengths, and per-file or total oversize all
fail closed. Downloads are kept in the private transaction directory and the
old installed plugin remains available for rollback. The final installed
directory contains exactly:

- `__init__.py`
- `adapter.py`
- `protocol.py`
- `plugin.yaml`
- `install.mjs`
- `package-manifest.json`

Re-running the command reuses all host identity values. Use
`--rotate-gateway` to keep `hermesAgentId` stable while replacing Gateway id and
credential. Rotation requires a fresh live pairing request.

## Runtime readiness

A successful connection must show all of the following without secret data:

1. Hermes Gateway reports the `hermes_hub_gateway` platform active.
2. Router `/router/hermes-hub-gateways` has one online entry with the expected
   `hermesAgentId` and `gatewayId`.
3. Router `/router/heartbeat?hermesAgentId=...` reports that Agent online.
4. The negotiated capability list matches the current API Server probes.
5. A real session list and one non-sensitive chat smoke pass through Router,
   Gateway Plugin, API Server, and Hermes.

Registry counts alone do not prove the intended Agent is online.

## Recovery

The detached finalizer and every later installer invocation read the private
journal before creating a new candidate:

- if the formal identity equals the journaled candidate, local commit already
  completed and recovery only removes leftover backup/staging state;
- while a claim is pending, authoritative Router state decides the result: an
  `active` exact candidate is committed, a still-valid provisional candidate
  keeps the detached finalizer alive, and an expired/revoked candidate rolls
  back the plugin/config/env and restarts the prior runtime;
- before the claim-wait phase, an uncommitted interrupted transaction rolls
  back directly;
- if Router state or operator authentication is indeterminate, recovery keeps
  the private journal and fails closed instead of guessing between a now-active
  candidate and the prior credential;
- if restoration or the old-runtime restart cannot complete, the journal is
  retained. Re-run with the same `--hermes-home`, `--identity-file`, and
  `--target` values; do not manually copy a pending identity over the formal
  identity.

The plugin target is never deleted before replacement. New files are copied to
a sibling staging directory, the old directory is renamed to a private rollback
slot, and only then is the staged directory renamed into place.

- `api_server_disabled`: enable the loopback API Server and restart Hermes
  Gateway.
- `api_capability_probe_failed`: verify the API Server version, key, and local
  health before retrying.
- `connect_failed`: verify Router reachability and re-pair or rotate the
  Gateway credential. Never paste the credential into a command log.
- `router_handshake_timeout`, `router_handshake_identity_mismatch`, or
  `router_handshake_protocol_mismatch`: verify Router/Gateway identity binding
  and protocol version. The plugin remains offline until both `ready` and
  `hello_ack` validate.
- `identity_invalid`: preserve or restore the stable Agent id; do not silently
  replace a damaged identity file.
- Gateway disconnect during a run: reconcile stored session messages before an
  intentional retry. The plugin does not replay the run.
- Missing `models`: inspect the corresponding local probe. Cron is intentionally
  unavailable until a public contract can prove its read, write, and execute
  surfaces independently.
- A session that remains busy after stop is quarantined because terminal status
  has not yet been confirmed. Repair local API Server reachability and let the
  reconciler observe `completed`, `failed`, or `cancelled`; do not force a
  second run into that session.

## Verification gates

From a standalone Gateway Plugin checkout:

```powershell
python -m unittest discover tests -v
python -B tests/test_official_runtime_integration.py
node install.smoke.mjs
```

From the Hermes Hub monorepo root:

```powershell
python -m unittest discover apps/hermes-hub-gateway-plugin/tests -v
python -B apps/hermes-hub-gateway-plugin/tests/test_official_runtime_integration.py
node apps/hermes-hub-gateway-plugin/install.smoke.mjs
```

The official-runtime smoke uses `HERMES_AGENT_ROOT` when set, otherwise the
adjacent `../hermes-agent` checkout. It explicitly reports a unittest skip when
that checkout is absent; when present, discovery or API compatibility failures
fail the smoke rather than falling back to test stubs.

Connection-complete claims additionally require one real, non-secret
Router -> Hermes Hub Gateway Plugin -> API Server -> Hermes smoke result.
