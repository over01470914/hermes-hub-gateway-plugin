---
name: hermes-hub-gateway-doctor
description: Use when Hermes Hub Gateway installation, skills, Hermes Gateway, or the local Hermes API needs diagnosis or repair. Report the blocking check and the next command.
---

# Hermes Hub Gateway Doctor

Use this skill for status and repair, not for generating a pairing code.

```bash
npm install -g @over01470914/hermes-hub-gateway@latest
hermes-hub-gateway doctor --runtime hermes
```

The doctor verifies the npm-installed CLI can reach Hermes, enables the local
API server, and restarts Hermes Gateway. It does not block pairing on a fixed
loopback API health probe; the verified installer owns the later Gateway
connection verification. If it fails, report the named blocking check and the
next safe command; do not inspect or print secrets.
