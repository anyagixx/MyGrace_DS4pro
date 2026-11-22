---
name: mygrace-refresh
description: "Synchronize MyGRACE indexes with per-entity files after drift: read coded lint findings, fix orphaned/missing/drifted entries and stale trust. Use after manual edits, failed lint, or merge conflicts in docs/."
whenToUse: "`mygrace lint` reports findings, docs/ was edited by hand, or a merge changed indexes and entities."
---

# Refresh indexes

## 1. Detect drift (automated)

Run `mygrace lint --strict --format json --path <root>` and read the findings —
`mygrace lint` now checks:

- XML validity (line/column) for every `docs/*.xml`;
- index ↔ entity drift for all documented fields (`NAME`, `TYPE`, `STATUS`,
  `PATH`, `DEPENDS`, `VERIFICATION_REF`, phase name/status/steps, verification
  module/priority/status), plus duplicates and orphaned/missing files;
- missing module `PATH`, unknown `DEPENDS`, dangling `VERIFICATION_REF`;
- index caps and entity size budgets from `mygrace.config.json`;
- markup problems in configured source dirs.

Do not grep the XML by hand if the linter already has a coded finding.

## 2. Fix by class

- `ORPHANED_INDEX_ENTRY` — entity file is gone. Either delete the index entry or
  restore the file.
- `MISSING_INDEX_ENTRY` — entity file exists without an index line. Add it.
- `*_DRIFT` — index line vs entity file disagree. Decide the truth (usually the
  file), then update the index; adjust the file only with approval if the
  contract changed.
- `PATH_MISSING` / `DEPENDS_UNKNOWN` / `VERIFICATION_REF_MISSING` — fix the
  reference, not the linter.
- `ENTITY_TOO_SMALL` / `ENTITY_TOO_LARGE` / index cap findings — split or enrich
  the entity, or change `sizeBudgets`/`indexCaps` deliberately in config.
- Shard findings — `SHARD_FILE_MISSING` / `SHARD_ROOT_INVALID` (restore or
  regenerate the shard), `SHARD_COUNT_MISMATCH` (declared count vs actual
  entries in the root ref or shard root), `PATH_UNSAFE` (an `href` that escapes
  `docs/` or is not `.xml`), `DUPLICATE_INDEX_ENTRY` across shards. Fix by
  re-running `mygrace module shard --apply --path <root>` after the data is
  correct; the generator is deterministic.

## 3. Archive policy (important)

Archiving a completed phase means move `docs/plans/Phase-N.xml` to
`docs/archive/` **and remove its `plan-index.xml` entry** — keeping the entry
creates an orphaned-index finding. Same rule for any entity removed from active
directories.

## 4. Trust re-record

If `docs/modules/`, `docs/verification/` or `mygrace.config.json` changed, the
verification trust record is stale. After reviewing the commands, re-run
`mygrace trust --path <root>` (or use `--allow-commands` for a one-off run).

## 5. Confirm

`mygrace lint --strict --path <root>` must pass before handing back; report the
finding codes you fixed and any judgement calls (which side was truth).
