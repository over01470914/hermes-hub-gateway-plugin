# Hermes Hub Gateway Pairing Security Boundary

## Architecture

This skill is an orchestration layer, not the long-running Gateway transport:

```text
Hermes skill
  -> scripts/pair.mjs (preflight and pinned bootstrap)
  -> verified install.mjs (only pairing mutator and installer)
  -> Hermes Hub Gateway Plugin (long-running platform adapter)
```

The skill must never replace the Gateway Plugin with a prompt-only implementation. The plugin continues to own outbound Router connectivity and loopback Hermes API access.

## Trust roots

`release.json` is local, non-secret trust policy. The wrapper requires the Router health release to match every field before it looks up the pairing request or downloads code. A Router-provided URL, command, hash, identity, or release override is not enough by itself.

Updating `release.json` is a release operation. Before changing it:

1. Review the target commit and package manifest.
2. Recompute the installer byte count and lowercase SHA-256 from the exact raw bytes.
3. Update all seven fields atomically.
4. Run `node scripts/pair.test.mjs` from the skill directory and the Gateway installer smoke from the repository root.

Do not add a CLI option that overrides the local release policy. Tests use dependency injection through exported functions instead of a production override flag.

## Secret ownership

| Value | Owner and storage | May appear in a prompt? |
|---|---|---:|
| `HERMES_HUB_AGENT_APPROVAL_TOKEN` | Remote: Hermes protected process environment/secret manager. Loopback: Router-initialized `$HERMES_HOME/hermes-hub/pairing.json`, read only by trusted local wrapper and installer | No |
| `HERMES_HUB_GATEWAY_TOKEN` | Installer-managed private `identity.json` and Hermes private environment | No |
| `API_SERVER_KEY` | Hermes private environment/configuration | No |
| `CNB_TOKEN` | Machine-local secret environment for an explicitly configured private mirror | No |
| Router URL | Pairing request and local configuration | Yes, if it contains no credentials |
| Request ID | One pairing request | Yes |
| Release URLs, commit, hashes | Local trust policy and public release metadata | Yes; they are integrity metadata, not secrets |
| Eight-digit pairing code | Installer stdout and the requesting user | Only as the final one-line result |

Never place secrets in `SKILL.md`, `references/`, `templates/`, command arguments, logs, test fixtures containing production values, or Client metadata. The loopback pairing file is machine-local private state, not a committed config template, and no Router or Skill API may return its token.

## Permission model

Loading this skill does not grant extra privileges and must not bypass approvals. The normal Hermes terminal execution must already permit:

- Node.js execution;
- loopback Router HTTP or remote Router HTTPS;
- public release HTTPS;
- OS temporary-directory writes;
- Hermes plugin installation and Gateway restart.

The wrapper checks these operations through one deterministic path. It performs no retry, fallback endpoint, direct approval mutation, direct plugin copy, or direct Hermes configuration mutation. The verified installer alone owns those mutations.

## Output contract

Success is exactly one eight-digit stdout line from the verified installer. Failure is exactly:

```text
FAILED step <n>: <sanitized reason>
```

The wrapper preserves HTTP status and named installer failure text while removing the approval credential, token-shaped values, and absolute host paths. Agents must relay that one line without commentary and must not rerun a failed request automatically.
