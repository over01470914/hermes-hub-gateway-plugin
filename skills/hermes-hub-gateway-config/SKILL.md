---
name: hermes-hub-gateway-config
description: Use when a Hermes Hub Gateway setup needs a minimal Hermes configuration check. Identify the exact missing setting without exposing secrets.
---

# Hermes Hub Gateway Config

Use this skill only for configuration diagnosis. Prefer the npm CLI doctor
before manual edits:

```bash
npm install -g @over01470914/hermes-hub-gateway@latest
hermes-hub-gateway doctor --runtime hermes
```

The expected local prerequisites are a working `hermes` CLI, an enabled local
API server, and a healthy Hermes Gateway. Do not ask for, print, or paste API
keys, approval tokens, Gateway tokens, or private configuration files.
