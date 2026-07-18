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

The doctor verifies the npm-installed CLI can reach Hermes and enables the
local API server. It never starts, stops, restarts, or otherwise manages
Hermes Gateway. After a successful pairing claim, tell the Client to restart
Hermes Gateway once. If doctor fails, report the named blocking check and the
next safe command; do not inspect or print secrets.
