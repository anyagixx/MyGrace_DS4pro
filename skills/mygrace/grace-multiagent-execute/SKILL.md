---
name: mygrace-multiagent-execute
description: "Execute a MyGRACE plan in parallel waves using DSH subagents: disjoint module write scopes, controller-owned indexes, trust-gated commands. Use when a plan has many independent modules and sequential execution is too slow."
whenToUse: "Multiple pending modules have disjoint write scopes and their dependencies are complete — parallelize them as a wave."
---

# Parallel execution with subagents

## Core principle

Parallelize **module implementation**, not architectural truth:

- **Controller (you)** owns indexes, phase files, and trust decisions.
- **Workers** own only their assigned module and tests.
- Each worker reads only its module file, its verification file and the source it
  needs — never the whole plan or all modules.

## Prerequisites

`docs/plan-index.xml`, `docs/graph-index.xml` and `docs/verification-index.xml`
exist; `mygrace lint --strict --path <root>` is clean.

## Building waves

1. Read `docs/plan-index.xml` (≤50 lines) → pending phases; read only the current
   `docs/plans/Phase-N.xml`.
2. Group steps into waves: disjoint write scopes, dependencies complete, no two
   workers editing the same files.
3. Do not read future phases.

## Dispatching workers

For each module in a wave, launch a background `subagent` with a self-contained
prompt containing:

- the module id, its `docs/modules/M-XXX.xml` path, its
  `docs/verification/V-M-XXX.xml` path and the exact write scope;
- the instruction: read only those files, implement per contract, add tests, run
  module-local checks, report what changed;
- the trust rule: project commands are trust-gated. If checks are required, the
  controller reviews `<module-checks>` and runs `mygrace trust` (or the wave runs
  with `--allow-commands`) — workers must not bypass it.

For large fan-out the `workflow` tool is the better option; keep one module per
worker.

## Trust gate for the wave

Before any worker/controller executes project commands: review the declared
`<module-checks>`, then `mygrace trust --path <root>` once for the current docs
state (editing docs invalidates it). CI-only waves may use `--allow-commands`.

## Integration

1. Collect worker reports; run a scoped review of changed files.
2. Controller updates `docs/graph-index.xml` statuses, `docs/plans/Phase-N.xml`
   steps, and `docs/plan-index.xml` when the phase completes.
3. Run `mygrace ci --path <root>` (add `--tests` once trust is current) as the
   wave gate, then targeted refresh (`mygrace-refresh` skill) for touched modules.
4. Archiving a phase = move the file to `docs/archive/` **and remove its
   plan-index entry** (otherwise lint reports an orphan).

## Rules

- Workers never update indexes; the controller does.
- One writer per file; no overlapping write scopes in a wave.
- No worker reads the full plan or execution packet for other modules.
- Never execute untrusted project commands; report a refusal instead of forcing.
