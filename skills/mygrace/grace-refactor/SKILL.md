---
name: mygrace-refactor
description: "Refactor MyGRACE-governed code safely: classify the change, update code + per-entity files + indexes atomically, re-record trust, verify by blast radius. Use for rename, move, split, merge, extract or interface changes."
whenToUse: "Any structural change to governed modules — rename, move, split, merge, extract, interface-tighten, path-only."
---

# Refactor safely

## 1. Classify and scope

Identify the refactor type and the affected module/phase/verification ids from
`docs/graph-index.xml` (index only). Read the affected entity files; do not scan
unrelated modules.

## 2. Build the refactor packet

For the source and target scope list: files/tests, `docs/modules/M-XXX.xml`,
`docs/plans/Phase-N.xml`, `docs/verification/V-M-XXX.xml`, and the three index
entries that reference them.

## 3. Apply the smallest safe change

- Update source code; keep semantic markup and contracts consistent with reality.
- Update per-entity files (contract, CrossLinks, annotations).
- **Update index entries** — a refactor is not done until indexes match reality.
- If a contract/interface changes, get explicit approval first.

## 4. Synchronize

1. `docs/graph-index.xml` — ids, names, paths, dependencies, statuses.
2. `docs/plan-index.xml` — phase names, step counts, statuses.
3. `docs/verification-index.xml` — verification entries (module/priority/status).
4. Verification files — test paths and `<module-checks>` if they moved.
5. If the refactor changes the module count, re-check the root index cap and
   re-shard (`mygrace module shard --path <root>` dry run, then `--apply`); old
   generated shards are removed with a backup and the operation is idempotent.

## 5. Verify by blast radius

- `mygrace lint --strict --path <root>` first (structural drift),
- module-local checks (`mygrace verify --module <M-XXX>`; trust-gated — re-run
  `mygrace trust` if docs/verification changed),
- then integration surfaces touched by the refactor.

## 6. Review and refresh

Scoped review (`mygrace-reviewer` skill) and targeted refresh
(`mygrace-refresh` skill) for touched modules; re-record trust if command
sources changed.

## Rules

- Index updates are mandatory; `--strict` lint must pass.
- Never silently invent architecture; propose contract changes.
- For split/merge: create the new per-entity files and index entries, remove the
  old ones, and update `plan-index.xml` step references.
