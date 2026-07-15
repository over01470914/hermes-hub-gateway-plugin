# Hermes Hub Gateway skills

This is the agent-facing skill suite shipped by
`@over01470914/hermes-hub-gateway`.

Install this public skill suite from GitHub, then install or upgrade the CLI
from npm:

```bash
hermes skills install "https://raw.githubusercontent.com/over01470914/hermes-hub-gateway-plugin/main/skills/hermes-hub-gateway-pair/SKILL.md" --yes
npm install -g @over01470914/hermes-hub-gateway@latest
```

## Included skills

- `hermes-hub-gateway-pair` — upgrade, verify Hermes readiness, and pair.
- `hermes-hub-gateway-doctor` — diagnose and repair host readiness.
- `hermes-hub-gateway-config` — identify a minimal configuration blocker.

The executable CLI, runtime, and pairing core are intentionally absent from
this repository. They are installed only through the npm package.
