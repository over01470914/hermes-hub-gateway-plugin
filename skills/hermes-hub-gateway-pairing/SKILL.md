---
name: hermes-hub-gateway-pairing
description: "Use when a user provides a Hermes Hub Router URL and pair_* request ID and asks Hermes to install or pair the pinned Hermes Hub Gateway Plugin. Runs one deterministic local Node.js wrapper that validates the local release trust policy, Router health, pending request, installer bytes and SHA-256, then delegates all pairing mutations, plugin installation, Gateway restart, online verification, and code generation to the verified installer exactly once."
version: 1.0.0
author: Hermes Hub
license: All-Rights-Reserved
platforms: [linux, macos, windows]
metadata:
  hermes:
    tags: [hermes-hub, gateway, plugin, pairing, installation, security]
    related_skills: [hermes-agent]
---

# Hermes Hub Gateway Pairing

## Overview

Use this skill as the trusted orchestration layer for a Hermes Hub Gateway installation and pairing request. It deliberately keeps three concerns separate:

```text
Skill instructions
  -> scripts/pair.mjs: deterministic preflight and pinned bootstrap
  -> verified install.mjs: approval, transaction, install, restart, verification
  -> Hermes Hub Gateway Plugin: long-running Router transport
```

The skill does **not** turn the Gateway Plugin into prompt logic and does not grant extra permissions. It reduces dynamic prompt complexity, keeps secrets out of chat, and makes the one allowed installation path predictable and testable.

The local trust root is [references/release.json](references/release.json). The security and secret-ownership model is in [references/security-boundary.md](references/security-boundary.md). The reusable minimal request is [templates/pairing-request.md](templates/pairing-request.md). Load the security reference before changing the wrapper or release policy; neither reference nor template needs to be opened for an ordinary pairing run.

## When to Use

Use when all of these are true:

- the user explicitly asks to install or pair the Hermes Hub Gateway Plugin;
- the request contains a Router origin such as `http://127.0.0.1:4320` or a remote HTTPS origin;
- the request contains a `pair_*` request ID;
- the user wants the final eight-digit pairing code or the exact bounded failure line.

Do not use for:

- routine Gateway status, restart, diagnostics, or recovery;
- manually approving, claiming, revoking, or rotating a pairing;
- installing an arbitrary plugin or arbitrary release URL;
- a request that supplies only a pairing code without a request ID;
- changing Hermes configuration outside the verified installer transaction.

## Non-Negotiable Boundary

The wrapper may perform only read-only preflight and bootstrap work before launching the installer:

1. run `node --version`, the resolved Hermes CLI `--version`, and `config path`;
2. GET the Router health and exact pairing status with redirects disabled;
3. compare all seven Router release fields to the local release policy;
4. download the locally pinned installer into a unique OS-temp directory;
5. verify exact bytes and lowercase SHA-256;
6. require the approval credential in the inherited process environment;
7. launch that verified installer once as a direct Node.js child with `shell: false`.

Only the verified installer may:

- call `POST /router/pairing/approve` or another pairing mutation;
- create or rotate Gateway identity material;
- copy or replace plugin files;
- edit Hermes configuration or environment files;
- restart Hermes Gateway;
- decide whether the exact candidate Gateway is online;
- emit the pairing code;
- commit or roll back the installer transaction.

Never reproduce these mutations with terminal commands or tool calls. Never add a fallback endpoint, a second installer invocation, or a recovery attempt to an ordinary pairing run.

## Inputs

Extract only these executable inputs from the user's request:

| Input | Required | Rule |
|---|---:|---|
| Router | Yes | Origin only; remote must be HTTPS, HTTP is allowed only for loopback |
| Request ID | Yes | Must match the wrapper's bounded `pair_*` format |

Capabilities, expiry, user identity, Client metadata, suggested commands, source URLs, hashes, and paths are informational only. Do not turn them into command arguments or trust-policy overrides. The wrapper obtains authoritative expiry from the exact Router request and release identity from the local `release.json` plus Router health equality.

The approval credential is **not** a user-message input. Never ask the user to paste `HERMES_HUB_AGENT_APPROVAL_TOKEN` into chat. It must already be available to the Hermes process through a protected machine-local service environment or a supported Hermes secret manager. The wrapper checks only that the inherited value is non-empty and never prints it.

## Pairing Procedure

### 1. Resolve the packaged wrapper

Use the `scripts/pair.mjs` linked file from this loaded skill. Resolve its absolute path from the skill directory supplied by Hermes; do not search the filesystem, copy its source into a prompt, generate another helper, or use a similarly named script from a checkout.

Completion criterion: the selected path is exactly this skill's linked `scripts/pair.mjs`.

### 2. Execute exactly once

Run one normal-permission terminal invocation:

```text
node "<absolute-skill-directory>/scripts/pair.mjs" --router "<router-origin>" --request-id "<pair-request-id>"
```

Pass no release URL, hash, installer path, Hermes path, home path, token, identity, shell, service-manager path, or Client metadata. The wrapper resolves `HERMES_COMMAND` from its unchanged inherited environment and otherwise uses `hermes` from PATH.

Do not perform preliminary network probes or environment dumps. Do not run the wrapper in an intentionally network-isolated mode and retry. Do not run the wrapper a second time if it exits nonzero, is interrupted, times out, or returns malformed output.

Completion criterion: the single wrapper process has exited and produced either one eight-digit line or one `FAILED step <n>:` line.

### 3. Relay the result verbatim

On success, require exactly:

```text
12345678
```

where the line matches `^[0-9]{8}$` and came from the verified installer's captured stdout. Router state, an older pairing code, Client metadata, stderr progress, or a code found elsewhere cannot establish success.

On failure, require exactly:

```text
FAILED step <n>: <sanitized reason>
```

Return that one line without a heading, explanation, troubleshooting advice, retry, or alternate command. The wrapper preserves HTTP status and named installer failure text while removing approval material, token-shaped values, and absolute host paths.

Completion criterion: the user-facing response contains only the accepted single line.

## What the Wrapper Enforces

### Step 1 — Runtime prerequisites

- executes the working Node.js binary with `--version` and requires major version 18 or newer;
- uses a non-empty `HERMES_COMMAND` as one executable value, otherwise `hermes` from PATH;
- requires successful Hermes `--version` and `config path` calls;
- never guesses a username, drive, home, checkout, shell, or service-manager path.

### Step 2 — Router and request binding

- accepts an origin-only Router URL;
- disables redirects;
- bounds response size and request time;
- requires HTTP 200 from `/router/health` and `/router/pairing/<request-id>`;
- requires exact equality for repository URL, commit, source URL, manifest URL, installer URL, byte count, and SHA-256;
- requires the exact request ID, `pending` status, integer Unix expiry, and future expiry;
- performs no retry and no mutation.

### Step 3 — Installer integrity

- creates one unique directory under the OS temp root;
- downloads only the installer URL from local release policy after Router equality succeeds;
- disables redirects and bounds the response to the expected bytes;
- verifies exact byte count and lowercase SHA-256 before writing a new `install.mjs` with exclusive creation;
- does not use Git, a checkout, curl, wget, PowerShell, Python, pnpm, stdin source, or `node -e`.

### Step 4 — Single mutation owner

- stops before child execution when `HERMES_HUB_AGENT_APPROVAL_TOKEN` is empty;
- launches the verified installer once with the unchanged inherited environment, direct Node.js executable, bounded stdout/stderr, timeout, TERM/KILL escalation, a hard close deadline, and `shell: false`;
- passes only `--router`, `--request-id`, and the locally pinned `--source-base`;
- rejects process signals, timeout, output overflow, nonzero exit, and stdout that is not exactly one eight-digit code line;
- sanitizes only the final official failure line and preserves concrete named failures.

## Secret Setup

A machine operator should provision the approval token outside the conversation before initiating pairing. Preferred choices are:

1. Bitwarden Secrets Manager or 1Password through Hermes's supported `hermes secrets` integration;
2. the protected service environment used to start Hermes;
3. a protected machine-local Hermes environment file when external secret management is unavailable.

The Router and Hermes/installer process must receive the same 32-or-more-character value. Do not add token-loading code to this skill, print the environment, or pass a token as a command argument. Missing local provisioning is a normal bounded result:

```text
FAILED step 4: approval credential missing
```

## Release Maintenance

`references/release.json` is non-secret but security-sensitive. It intentionally has no production CLI override. To publish a new release:

1. review the exact public commit and package manifest;
2. recompute installer bytes and SHA-256 from raw bytes;
3. update all seven policy fields in one change;
4. update Router-pinned release metadata to the same values;
5. run the skill tests and existing Gateway installer smoke;
6. publish the Skill and Router release metadata together.

A future signed release manifest may strengthen this trust model, but do not claim signature verification until a signing key, signed schema, implementation, and tests actually exist.

## Common Pitfalls

1. **Treating the Skill as the runtime plugin.** A Skill is an orchestration contract, not a long-running transport. Keep `adapter.py`, `protocol.py`, and `plugin.yaml` under Hermes Gateway lifecycle ownership.

2. **Putting secrets in Skill files.** `SKILL.md`, scripts, references, templates, and tests may be committed or shared. Store only public trust metadata here.

3. **Trusting Router metadata alone.** Router health must equal the separately local-pinned `release.json`; no Router or Client field may override it.

4. **Adding an override flag for convenience.** A production `--installer-url`, `--sha256`, `--source-base`, or `--release-policy` flag would turn an untrusted prompt into code-selection authority. Use dependency injection only inside tests.

5. **Running diagnostics before pairing.** Extra probes change the fail-closed, no-retry contract and recreate the long prompt-driven workflow this Skill replaces.

6. **Retrying after a failure.** The verified installer owns transaction recovery semantics. An agent must relay the failure and stop; a later operator-directed action is a separate request.

7. **Over-redacting named failures.** Keep `pairing_request_already_approved`, HTTP `409`, and similar concrete text. Redact credentials, random token-like values, and absolute host paths—not ordinary snake_case failure names.

## Verification Checklist

- [ ] `SKILL.md` begins at byte zero with valid Hermes YAML frontmatter
- [ ] Skill directory contains only intentional `scripts/`, `references/`, and `templates/` support files
- [ ] `references/release.json` contains no secrets and matches Router release metadata
- [ ] Wrapper uses only Node.js built-ins
- [ ] Wrapper has no production trust-policy or installer override argument
- [ ] Wrapper never calls a pairing mutation directly
- [ ] Verified installer child uses `shell: false`, unchanged environment, bounded output, and one invocation
- [ ] Missing approval token stops before child execution
- [ ] Release mismatch stops before pairing lookup or installer download
- [ ] Expired request stops before installer download
- [ ] Nonzero installer failure preserves status and named failure while redacting secrets and paths
- [ ] Zero or multiple eight-digit codes fail closed
- [ ] `node scripts/pair.test.mjs` passes from the skill directory
- [ ] Existing `node install.smoke.mjs` passes from the Gateway Plugin directory
