---
name: mygrace-refresh
description: "Synchronize MyGRACE indexes with per-entity files: detect orphaned, missing, or drifted entries and fix them with user approval. Use after manual edits or when lint reports drift."
whenToUse: "Indexes may have drifted from per-entity files — after manual edits, failed lint, or merge conflicts in docs/."
---

Synchronize MyGRACE indexes with per-entity files.

## What MyGRACE Refresh Does
Classic GRACE refresh compares code against monolithic XML.
MyGRACE refresh compares **indexes against per-entity files**.

## Detecting Drift First (MCP / CLI)
Before manual review, run `mygrace lint --path <root>` (MCP: `mygrace_lint`) — it reports orphaned, missing, and drifted entries automatically. Refresh then fixes the reported issues.

## Sync Checks

### 1. Graph Index ↔ Module Files
For each entry in `docs/graph-index.xml`:
- Does `docs/modules/M-XXX.xml` exist? → If no, flag as orphaned
- Does STATUS match between index and file? → If no, update index
- Does PATH in index match file's actual location? → If no, update index

For each file in `docs/modules/`:
- Is there a graph-index entry? → If no, add to index

### 2. Plan Index ↔ Phase Files
For each entry in `docs/plan-index.xml`:
- Does `docs/plans/Phase-N.xml` exist? → If no, flag as orphaned
- Does step count match? → If no, update index
- Does STATUS match? → If no, update index

### 3. Verification Index ↔ Verification Files
For each entry in `docs/verification-index.xml`:
- Does `docs/verification/V-M-XXX.xml` exist? → If no, flag as orphaned
- Does STATUS/PRIORITY match? → If no, update index

For each file in `docs/verification/`:
- Is there a verification-index entry? → If no, add to index

### 4. Archive Check
- If a phase is "done" and project has >10 modules, suggest archiving to `docs/archive/`

## Process
1. **Choose Scope**: `targeted` (specific modules) or `full` (all indexes)
2. **Scan indexes and per-entity directories** (prefer MCP tools `mygrace_list_modules` / `mygrace_list_verifications` when connected; fall back to direct reads)
3. **Compare** — find orphaned, missing, drifted entries
4. **Report** — structured drift report
5. **Fix with user approval** — update indexes or create missing files

## Rules
- Indexes are the source of truth for navigation — they MUST be current
- Prefer targeted refresh after clean waves
- Archive old phases to keep active directories small
- Per-entity files can have implementation details that indexes don't need — that's by design
