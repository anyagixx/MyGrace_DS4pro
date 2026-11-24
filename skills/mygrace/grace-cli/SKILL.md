---
name: mygrace-cli
description: "Reference for the mygrace CLI (22 commands) and MCP server (23 tools): quality gate, trust, index reads, verification and JSON envelopes. Use when you need the exact command/flag/tool for a MyGRACE operation."
whenToUse: "You need a concrete CLI command or MCP tool — flags, exit codes, trust behaviour or JSON output."
---

Use `mygrace` as the MyGRACE-aware read/execute layer, and the MCP tools as the
preferred in-agent access path (23 tools; DSH exposes them as
`mcp__mygrace__<tool>`).

## Project resolution (harness sessions)

The harness may start the MCP server in its launch directory, which is **not**
necessarily the workspace you are editing. For every MCP call pass `path` =
the absolute workspace root (`projectRoot` for `mygrace_show_file`); for CLI
calls pass `--path <workspace>`. The server remembers the last valid project, so
an omitted root falls back to it (then `MYGRACE_PROJECT_ROOT`, then server cwd),
but explicit paths are required for correctness across multiple projects.

## Contract

- Exit codes: `0` ok · `1` findings/failed tests/drift · `2` usage/config/trust
  refusal · `3` internal error. `--strict` promotes warnings to `1`.
- Every `--format json` command prints
  `{ ok, exitCode, data, findings[], meta }` and exits with `exitCode`.
- Project-declared commands (`test`/`verify`) are **trust-gated**: they execute
  only with `.mygrace/trust.json` (via `mygrace trust`), `config.allowCommands`,
  or `--allow-commands`.

## Gate + read commands

- `mygrace ci --path <root> [--tests] [--allow-commands] [--format json]` — one-command quality gate (strict lint + status + coverage; `--tests` adds trust-gated tests)
- `mygrace status --path <root> [--format json]` — counts + lint summary
- `mygrace module index --path <root>` (prints a shard summary when the index is sharded) · `mygrace module find <query> --path <root>` · `mygrace module show <id> --path <root>` (add `--with-verification`) · `mygrace module list --status=<s> --type=<t> --path <root>`
- `mygrace module shard --path <root>` — dry-run shard plan (`--apply` writes `docs/modules/shard-<slug>.xml` + `<Shard/>` refs with a backup; dry run is the default; `--group-by type|status|prefix`). Reads are shard-transparent except `module show`.
- `mygrace phase index --path <root>` · `mygrace phase show <Phase-N> --path <root>`
- `mygrace verification index --priority <p> --format json --path <root>`
- `mygrace file show <path> --root <root> [--contracts] [--blocks]`
- `mygrace context-cost --path <root>` — read budget per operation
- `mygrace doctor --path <root> [--format json]` — environment + DSH integration

## Execution commands (trust-gated)

- `mygrace trust --path <root>` — review declared commands, write `.mygrace/trust.json`
- `mygrace test --module <M-XXX> [--compact] [--allow-commands] --path <root>`
- `mygrace verify [--module <M-XXX>] [--allow-commands] --path <root>` — digest; `.mygrace/last-failures.md` on failure
- `mygrace lint --strict --path <root>` — integrity gate; incremental scope with `--changed [--base <ref>]` or `--files a,b,c`
- `mygrace trace <ID> --path <root> [--format json] [--code] [--strict-contracts]` — proof chain (module/verification → tests → command provenance → requirements → phases → dependents); ID is M-XXX or V-M-XXX; exit 1 on broken chain; `--code` adds the optional MODULE_MAP↔symbol check (Octocode, ADR-9), `--strict-contracts` promotes missing symbols to errors
- `mygrace impact [--files a,b,c] [--staged] [--since <ref>] --path <root> [--format json] [--code-graph]` — changed files → modules, dependents, verification blast radius, phases, suggested commands (`--files` works without git); `--code-graph` adds real code import edges via optional Octocode (info findings only)
- `mygrace next --path <root> [--format json]` — deterministic nine-code advice (NEXT/WHY/RUN/IDS/CODE); exit 0 for any advice
- `mygrace projects --path <root> [--depth 4] [--strict] [--format json]` — monorepo discovery with per-project lint/coverage
- `mygrace integrations status --path <root> [--format json]` — detect optional external tools (Octocode/Archify), versions and tested ranges; advisory (exit 0), never required by the core gates
- `mygrace diagram [--format text|json|html|mermaid] [--out <html>] [--check] --path <root>` — deterministic architecture IR from the docs graph; json/mermaid always work, html needs optional Archify (validate+deliver); `--check` fails when the committed IR is stale
- `mygrace packet <M-XXX>` / `mygrace focus <M-XXX>` — worker prompt / minimal set

## MCP tools (23)

`mygrace_list_modules`, `mygrace_show_module`, `mygrace_show_phase`,
`mygrace_find_modules`, `mygrace_phase_index`, `mygrace_doctor`,
`mygrace_test`, `mygrace_trust`, `mygrace_ci`, `mygrace_packet`,
`mygrace_focus`, `mygrace_context_cost`, `mygrace_verify`,
`mygrace_list_verifications`, `mygrace_lint`, `mygrace_show_file`,
`mygrace_status`, `mygrace_trace`, `mygrace_impact`, `mygrace_next`,
`mygrace_projects`, `mygrace_integrations`, `mygrace_diagram`.

MCP `path` is optional: explicit argument → `MYGRACE_PROJECT_ROOT` → server
working directory. Prefer MCP for index reads; use the CLI for anything the MCP
catalogue does not cover. Local state (`.mygrace/`) is never committed.

## Configuration

`mygrace.config.json` (optional; written by `mygrace init-dsh`) sets
`sourceDirs`, `markupExts`, `ignoreDirs`, `indexCaps`, `sizeBudgets`,
`testRunner`, `allowCommands` and `language`. A list you set replaces the default
entirely, and `testRunner` is only the fallback when no canonical
`<module-checks>` exists.
