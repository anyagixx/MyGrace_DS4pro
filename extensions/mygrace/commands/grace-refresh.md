---
name: grace:refresh
description: "Re-synchronize MyGRACE indexes with per-entity files"
---

1. Run `mygrace ci --path <project-root>` (or `mygrace lint --strict --path
   <project-root> --format json`) and collect the coded findings.
2. Fix each drift class: orphaned/missing index entries, field drift, missing
   PATH/DEPENDS/VERIFICATION_REF, caps/budgets.
3. When archiving a phase: move `docs/plans/Phase-N.xml` to `docs/archive/` **and
   remove its `plan-index.xml` entry**.
4. If `docs/modules/`, `docs/verification/` or `mygrace.config.json` changed,
   re-run `mygrace trust` after reviewing the declared commands.
5. Re-run the gate until it passes.

Use the `mygrace-refresh` skill for the full process.
