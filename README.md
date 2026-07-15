# Hermes Hub Gateway Skills

This repository is the public, agent-facing half of Hermes Hub Gateway
distribution. It contains instructions only: no installer, runtime plugin,
pairing implementation, test fixture, credential, or executable code is
published here.

Install the required skill and then the npm package:

    hermes skills install "https://raw.githubusercontent.com/over01470914/hermes-hub-gateway-plugin/main/skills/hermes-hub-gateway-pair/SKILL.md" --yes --force
    npm install -g @over01470914/hermes-hub-gateway@latest

The npm package contains the `hermes-hub-gateway` CLI, Hermes lifecycle-owned
runtime, manifest verification, and deterministic pairing core. For a local
loopback Router, `pair` also asks Router to repair its own missing or malformed
approval configuration without returning the token. It does not use pm2;
Hermes Gateway owns the runtime lifecycle.

## Public contents

- [Pairing skill](skills/hermes-hub-gateway-pair/SKILL.md)
- [Doctor skill](skills/hermes-hub-gateway-doctor/SKILL.md)
- [Configuration skill](skills/hermes-hub-gateway-config/SKILL.md)

The Router publishes only the GitHub skills repository and npm package release
metadata. It never serves executable Gateway files.
