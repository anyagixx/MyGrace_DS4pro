---
name: mygrace-status
description: "Report MyGRACE project health from the three indexes plus the lint summary, and choose the next action. Use before starting a work session or when deciding what to do next."
whenToUse: "You need a fast, truthful status snapshot and a recommended next action without reading the codebase."
---

# Project status

## What to read (bounded)

Run the status command; it reads only the three index files plus the lint result
and returns counts — it never scans the source tree for you:

- `mygrace status --path <root> --format json` — modules/phases/verifications by
  status and priority, plus lint error/warning counts.
- `mygrace ci --path <root>` — one-command gate (strict lint + status + verification coverage).
- `mygrace lint --strict --path <root>` when you need the findings themselves.
- `mygrace setup doctor --path <root>` when the environment/integration looks wrong.
- `mygrace next --path <root>` — the deterministic recommendation with its code
  (INIT_PROJECT · FIX_INDEX · FIX_LINT_ERRORS · ADD_VERIFICATION_COVERAGE ·
  TRUST_COMMANDS · VERIFY_MODULE · REFRESH_WARNINGS · NEXT_PHASE · NOTHING_TO_DO);
  use it instead of inventing the next action.

Do not read `docs/modules/`, `docs/plans/` or `docs/verification/` in bulk for a
status report; the indexes are the source of truth for counts and status.

## Report

1. **Counts** — modules (by status), phases (by status), verifications (by
   status/priority); index caps from `mygrace.config.json` if the project sets
   them. When the module index is sharded, `mygrace inspect module index --path <root>`
   prints the shard summary; counts still come from the transparent union.
2. **Integrity** — `lint --strict` result: error/warning counts + finding codes
   (`ORPHANED_INDEX_ENTRY`, `STATUS_DRIFT`, `PATH_MISSING`, `XML_INVALID`, …).
3. **Blockers** — missing requirements/technology, empty indexes, stale trust
   record (run `mygrace trust` after reviewing commands).
4. **Next action** — prefer `mygrace next` (deterministic, code + WHY/RUN/IDS);
   otherwise pick one:
   - no modules in the index → `mygrace-plan` skill;
   - modules planned but no verification surfaces → `mygrace-verification` skill;
   - verification ready but modules unimplemented → `mygrace-execute` skill
     (or `mygrace-multiagent-execute` for independent waves);
   - drift findings → `mygrace-refresh` skill;
   - clean and complete → say so and stop.

## Honest scope

This report is about indexes and lint, not code quality. Do not claim a
"percentage saved" or estimate tokens; if you need read-budget numbers, run
`mygrace context cost --path <root>`.

## Capsule fast path (experimental, v1.6)

If this project ships qualified capsules (`mygrace capsule list --format json` shows
`qualified: true`), prefer the `daily-check` (status → lint → ci → next) capsule over re-deriving the sequence:

```bash
mygrace capsule run <name> [--module M-XXX]
mygrace capsule continue <run-id>   # after a judgment step
```

If the run reports `CAPSULE_DEOPT`, stop and follow the source skill procedure
above; capsules never replace this skill and never execute anything beyond the
read-only MyGRACE CLI allowlist. Qualify first if the capsule is not qualified:
`mygrace capsule qualify <name> --fixture examples/demo-store`.
