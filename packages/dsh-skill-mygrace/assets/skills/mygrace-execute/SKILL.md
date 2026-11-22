---
name: mygrace-execute
description: "Execute the MyGRACE development plan step by step with lazy loading: current phase + one module at a time, trust-gated verification, index updates. Use when the plan is approved and modules are ready to implement."
whenToUse: "The plan and verification surfaces exist, phases are pending, and the user wants module-by-module implementation."
---

# Execute the plan

## Prerequisites

- `docs/plan-index.xml`, `docs/graph-index.xml`, `docs/verification-index.xml`
  and the per-entity files exist (`mygrace-init`/`mygrace-plan` done).
- `mygrace lint --strict --path <root>` is clean.

## Lazy loading (critical)

1. Read `docs/plan-index.xml` — find the first pending phase.
2. Read only that `docs/plans/Phase-N.xml`.
3. For each step: read only its `docs/modules/M-XXX.xml` and the matching
   `docs/verification/V-M-XXX.xml`. Bounded by defaults: index caps (100/50/80)
   and entity budgets (30–80 / 20–60 lines) — never the whole plan or all modules.

## Trust gate (before running any project command)

Project commands come from repository files and are untrusted. Before
`mygrace test` / `mygrace verify` (or the MCP equivalents):

1. Review the declared `<module-checks>` in the verification files.
2. Run `mygrace trust --path <root>` to record their hashes (or pass
   `--allow-commands` for a one-off CI run; or set `config.allowCommands`).
3. If a command is refused, report it — do not bypass the gate.

Editing `docs/modules/`, `docs/verification/` or `mygrace.config.json`
invalidates the trust record: re-run `mygrace trust` before the next run.

## Per step

1. Implement the module against its contract: `MODULE_CONTRACT`,
   `MODULE_MAP`, `CHANGE_SUMMARY`, function contracts, semantic blocks.
2. Add/extend module tests; run scoped checks with
   `mygrace test --module <M-XXX> --compact --path <root>` (trust-gated).
3. Commit after verification passes.
4. Scoped review; fix findings.
5. Update statuses: `docs/plans/Phase-N.xml` step, `docs/graph-index.xml` and
   `docs/modules/M-XXX.xml` STATUS.
6. If `<module-checks>` changed, re-run `mygrace trust`.
7. Print a short progress report (module, status, command + exit code).
8. Before asking a human to review, run `mygrace ci --path <root>`; with the
   trust record current add `--tests` to include scoped verification runs.
9. Check the finished step traceability: `mygrace trace <M-XXX> --path <root>`
   (verification → tests → command → phases → dependents; exit 1 on a broken
   chain) and `mygrace impact --files <changed files> --path <root>` for the
   blast radius before handing off.

## After the phase

1. Set the phase status to `done` in `docs/plans/Phase-N.xml` and
   `docs/plan-index.xml`.
2. Run `mygrace ci --path <root>` (the agent's final self-check: strict lint +
   status + verification coverage) and `mygrace ci --path <root> --tests` when
   the trust record is current.
3. Re-check the finished phase: `mygrace trace <M-XXX>` for each new module and
   `mygrace next --path <root>` (the next recommendation should no longer name
   this phase).
4. Targeted refresh via the `mygrace-refresh` skill.
5. Optional archiving for large projects: move `Phase-N.xml` to
   `docs/archive/` **and remove its `plan-index.xml` entry** — otherwise lint
   reports an orphaned index entry.
6. Commit.

## Rules

- One phase at a time; steps sequential within a phase.
- Only read the current phase and current module.
- Update indexes after every change; `mygrace lint --strict` before commit.
- Never execute project commands without the trust decision above.
- Do not claim token savings; context cost is bounded by caps and budgets.
