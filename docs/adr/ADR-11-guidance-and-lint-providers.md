# ADR-11 — External lint providers are trust-gated adapters

**Status:** accepted (v3.1.0)

## Context

MyGRACE lint is deterministic and offline. Projects increasingly have external
domain scanners (for example Modern Web Guidance `legacy-scan`) whose findings
are useful but whose output shape and update cadence are outside MyGRACE's
control. Embedding those rules into the core would violate the "any complexity"
scope and make every release depend on external content.

## Decision

1. `mygrace.config.json` may declare `lintProviders` (max 16). Each entry has a
   stable `name`, `adapter` (`legacy-scan` | `json-findings`), a command template
   (`{path}` expands to the project root), `timeoutMs` and `failOn`
   (`error` | `warning` | `none`; default `warning`).
2. Providers are **opt-in via config** and run only when project commands are
   trusted (`trust` record, `allowCommands: true`, or `--allow-commands`).
3. Commands are tokenized without a shell, checked against the existing
   dangerous-command deny list, capped by timeout, spawned with a scrubbed
   environment and appended to `.mygrace/audit.log`.
4. Output is parsed as untrusted data. Invalid JSON or provider failures become
   `LINT_PROVIDER_*` warnings; they never crash lint/ci.
5. Findings get the configured severity and the stable code
   `LINT_PROVIDER_FINDING`; `--strict` can fail warnings in CI.

## Consequences

- The core repo stays free of domain rules; adapters add type-specific findings.
- Provider commands are a supply-chain surface: pin versions, review commands,
  and keep the trust gate. CI should not pass `--allow-unsafe-commands` casually.
- Adding a new provider shape means adding a small adapter function, not a new
  top-level command.
