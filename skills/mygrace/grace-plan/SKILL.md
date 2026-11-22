---
name: mygrace-plan
description: "Run the MyGRACE architectural planning phase: design modules, phases and verification surfaces, write per-entity files and update the three indexes. Use after requirements and technology exist."
whenToUse: "Requirements are gathered (docs/requirements.xml, docs/technology.xml) and the module architecture needs to be designed and recorded."
---

# Plan the architecture

## Prerequisites

`docs/requirements.xml` (≥1 use case), `docs/technology.xml`, and the scaffold
from `mygrace-init` (three indexes + per-entity directories). If missing, run the
`mygrace-init` skill first.

## Process

1. **Analyze requirements.** Read `docs/requirements.xml` only; derive candidate
   modules per use case.
2. **Design modules.** For each: id (`M-XXX`), NAME, TYPE
   (`ENTRY_POINT`/`CORE_LOGIC`/`DATA_LAYER`/`UI_COMPONENT`/`UTILITY`/`INTEGRATION`),
   one-sentence purpose, dependencies, public interfaces, source/test paths,
   `VERIFICATION_REF` (`V-M-XXX`). Respect `sizeBudgets.module` (default 30–80
   lines): the contract, not the implementation.
3. **Design phases.** Group modules into ordered phases; one step per module with
   enough context to execute without re-reading the plan
   (`sizeBudgets.phase` default 50–200 lines).
4. **Walk through 2–3 scenarios** across the proposed index → modules to catch
   missing dependencies.
5. **Get explicit user approval** before writing files.

## Write the artifacts

1. `docs/graph-index.xml` — one line per module (sorted by status: wip > pending > done; default cap 100 lines, `indexCaps.graph`).
2. `docs/modules/M-XXX.xml` — full contract per module.
3. `docs/plan-index.xml` — one line per phase (default cap 50).
4. `docs/plans/Phase-N.xml` — steps with module refs.
5. `docs/verification-index.xml` — one line per module's verification entry (default cap 80).
6. `docs/verification/V-M-XXX.xml` — scenarios + **canonical `<module-checks>`**
   (the `mygrace-verification` skill owns the detail; `mygrace test`/`verify`
   read the command from here).

## Scaling the index (sharding)

When `sizeBudgets`/`indexCaps` are respected but the flat module count approaches
`indexCaps.graph` (default 100 lines), plan shards instead of deleting entries:

- preview the deterministic plan with `mygrace module shard --path <root>` (dry run;
  `--group-by type|status|prefix` changes the grouping);
- write it with `mygrace module shard --apply --path <root>`: it generates
  `docs/modules/shard-<slug>.xml`, rewrites the root index atomically, keeps a
  timestamped backup, and is idempotent on re-run;
- keep the root index as `<Shard href="modules/shard-<slug>.xml" count="N" />`
  references; per-shard caps are enforced by lint (same `indexCaps.graph`);
- `module show` still reads the entity file directly; `list`/`find`/`status`/`ci`
  read the union transparently.

## Monorepos and incremental lint

- Several governed projects in one tree (for example `apps/*` + shared
  libraries): discover them with `mygrace projects --path <tree>` (bounded BFS,
  per-project lint/coverage, exit 1 on findings) before proposing a shared plan.
- Once plans exist, `mygrace lint --changed [--base <ref>]` gives incremental
  index checks for quick local loops (index → full index checks, entity → that
  entity, source → markup only); the final gate is still
  `mygrace lint --strict` + `mygrace ci`.

## Output

Module breakdown, data/flow notes, verification surface overview, implementation
order, risks. Do not generate code.

## After writing

- `mygrace lint --strict --path <root>` must pass (fix drift, caps and budgets).
- Review declared commands and run `mygrace trust --path <root>` before the first
  `test`/`verify` (trust gate).
- Every module gets its own file; no monolithic aggregation.
