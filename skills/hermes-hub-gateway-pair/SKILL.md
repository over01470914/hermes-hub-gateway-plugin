---
name: hermes-hub-gateway-pair
description: Use when a user wants to pair Hermes Hub with this Hermes host. Upgrade the Hermes Hub Gateway CLI, verify Hermes readiness, and return the final 8-digit code on its own line.
---

# Hermes Hub Gateway Pair

Use this skill for Hermes Hub pairing and first-time host setup.

## Required workflow

1. Install or upgrade the complete Hermes Hub Gateway npm package. Do this even
   if the command already exists, because it repairs a stale CLI installation.

```bash
npm install -g @over01470914/hermes-hub-gateway@latest
```

2. Verify the Hermes CLI, Hermes Gateway, and local Hermes API. Doctor may
   enable the local API and restart Hermes Gateway; it must complete before a
   pairing request is mutated.

```bash
hermes-hub-gateway doctor --runtime hermes
```

3. Pair exactly once with the Router origin and request id supplied by Hermes
   Hub. The CLI owns release validation, installer integrity checks, approval,
   configuration, Gateway restart, online verification, and transaction
   recovery. Do not construct another helper or call `install.mjs` directly.

```bash
hermes-hub-gateway pair --runtime hermes --router "<router-origin>" --request-id "<pair-request-id>"
```

## Output rules

- On success, put the final 8-digit pairing code on its own line.
- If step 0 fails, state the concrete failure and run or provide its `NEXT:`
  command. A repaired preflight may be attempted again.
- Once `pair` starts, do not invoke it again automatically. Relay its exact
  failure and wait for a fresh operator-directed request.
- Never expose approval tokens, Gateway credentials, API keys, or local paths.
