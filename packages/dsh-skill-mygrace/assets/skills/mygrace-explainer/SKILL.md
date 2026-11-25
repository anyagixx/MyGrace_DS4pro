---
name: mygrace-explainer
description: "Complete MyGRACE methodology reference: indexes, per-entity files, trust model, configuration, enforcement and the honest measurement model. Use to refresh understanding before applying another skill."
whenToUse: "You are unsure how MyGRACE works — file layout, navigation rules, trust record, config keys or metric semantics."
---

# MyGRACE methodology reference

MyGRACE is an index-first engineering harness for AI coding agents: a small,
enforced map of the repository plus a contract-first workflow.

## Layout and navigation

| Classic artifact | MyGRACE replacement | Default budget |
|---|---|---|
| `knowledge-graph.xml` | `docs/graph-index.xml` + `docs/modules/M-XXX.xml` | index 100 lines, module 30–80 |
| `development-plan.xml` | `docs/plan-index.xml` + `docs/plans/Phase-N.xml` | index 50, phase 50–200 |
| `verification-plan.xml` | `docs/verification-index.xml` + `docs/verification/V-M-XXX.xml` | index 80, verification 20–60 |

Rules: read the index first; read one entity at a time; never scan all entity
files; caps and budgets are configurable in `mygrace.config.json` and enforced by
`mygrace lint`. Legacy monolithic XML is not used.

## Scaling and language support

- **Sharded indexes (ADR-6, implemented in Wave 3.1):** past the root index cap
  the root holds `<Shard href="modules/shard-<slug>.xml" count="N" />` references
  and each shard file starts with `<ModuleShard project=… group=… count=…>` plus
  normal `<M-…/>` lines. `mygrace module shard` plans deterministically (dry run
  by default; `--apply` writes atomically with a timestamped backup and is
  idempotent). `list`/`find`/`status`/`ci`/`test`/`verify` read the union
  transparently; `module show` reads the entity file directly.
- **Multi-language (G12):** `sourceDirs`, `markupExts` and `ignoreDirs` are
  honoured from config for any language; a user list *replaces* the default
  (polyglot repos enumerate every extension), and comment dialects `//`, `#`,
  `--`, `/*`, `<!--` are understood. `testRunner` is only the fallback when no
  canonical `<module-checks>` exists. Python/Go fixtures: `test/grace-language.test.ts`.

## Trust model (ADR-1)

`<module-checks>` in `docs/verification/V-M-XXX.xml` is the canonical command
source (module files are a deprecated fallback; `testRunner` from config is the
last fallback). `mygrace verify` / `mygrace verify` refuse to execute those
commands unless `.mygrace/trust.json` is current (`mygrace trust` after review),
`config.allowCommands` is true, or `--allow-commands` is passed. `.mygrace/` is
gitignored local state; editing docs/modules, docs/verification or the config
invalidates the record. Commands run argv-only, never through a shell.

## Enforcement

`mygrace lint` checks: XML validity (line/column), all index↔entity field drift,
duplicates, missing PATH/DEPENDS/VERIFICATION_REF targets, phase status/steps
drift, index caps, entity size budgets, block pairing by name, contract fields.
`--strict` makes warnings fail; `--format json` gives machine findings with
stable codes and honest exit codes (ADR-3).

## Configuration (`mygrace.config.json`)

`sourceDirs`, `markupExts`, `ignoreDirs`, `indexCaps`, `sizeBudgets`,
`testRunner`, `allowCommands`, `language`. `mygrace setup init` writes it; defaults
reproduce the classic layout; unknown keys are rejected.

## Honest metrics

`scripts/measure-context.ts` measures lines, bytes and a documented token
**estimate** (`ceil(bytes/4)`) — not a tokenizer. The classic baseline is
synthesized by concatenating indexes + entity files, so it is a model, not a real
classic repository. On the checked-in demo (3 modules): status 316 → 19 lines
(94%), single module 110 → 43 (61%), phase execution 116 → 64 (45%), full
verification audit 90 → 90 (0%). The 12/50/200-module sweep shows the win grows
with size but saturates; a 200-module point is synthetic. Reproduce with
`bun run scripts/measure-context.ts --json`; runtime view:
`mygrace context cost --path <root>`.

## Query surface and operations

- `mygrace trace <ID>` — read-only proof chain (module/verification → test files →
  command provenance → requirements → phases → dependents) with stable gap codes.
- `mygrace impact` — changed files → direct modules → transitive dependents →
  verification blast radius → phases → suggested commands.
- `mygrace next` — deterministic nine-code advice ladder; exit 0 for any advice.
- `mygrace projects` — bounded monorepo discovery by `docs/graph-index.xml`.
- `mygrace lint --changed` — incremental lint scope (git diff or `--files`).

## Platform

DeepSeek Harness is primary (skills + MCP + AGENTS.md). The `setup install --panel`
component is now a **LIVE** sidebar card (GET `/api/mygrace.status`, payload built
from `mygrace status --format json`; opt-in/private; route+loader verified
against the real DSH 0.2.1-rc.2 loader, live GUI session not exercised in CI).
Other platform files in this repository (`rules/`, `plugins/`, `extensions/`) are
legacy or metadata stubs; the CLI itself needs no DSH packages. Publishing is
tag-driven via `.github/workflows/release.yml` (`bun run publish:dry` gate); the
package is publish-ready but not published yet.

## Workflow

`mygrace-init` → fill requirements/technology → `mygrace-plan` →
`mygrace-verification` → `mygrace-execute` (or `mygrace-multiagent-execute`) →
`mygrace-reviewer` / `mygrace-refresh` as needed; `mygrace-status` and
`mygrace-ask` for orientation, `mygrace ci` as the final gate, `mygrace next` for
what to do after it. Archiving a phase = move its file to
`docs/archive/` **and** remove its `plan-index.xml` entry.
