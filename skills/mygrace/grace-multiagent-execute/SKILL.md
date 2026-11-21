---
name: mygrace-multiagent-execute
description: "Execute a MyGRACE plan in parallel waves using DSH subagents, each worker reading only its module. Use for large plans where sequential execution is too slow or many modules are independent."
whenToUse: "A plan has multiple pending modules whose write scopes are disjoint and whose dependencies are complete — parallelize them."
---

Execute a MyGRACE plan in parallel waves using DSH-native agents.

## Prerequisites
- `docs/plan-index.xml`, `docs/graph-index.xml` must exist
- `docs/verification-index.xml` should exist
- `docs/plans/` with Phase-N.xml files
- Call the `mygrace-plan` / `mygrace-verification` skills first if these are missing
- Read indexes index-first: MCP `mygrace_phase_index` / `mygrace_find_modules` or CLI `mygrace phase index` / `mygrace module find <query>`

## Core Principle
Parallelize **module implementation**, not **architectural truth**.
- Controller (you) owns indexes and current phase files
- Workers own only their assigned module files
- Each worker reads ONLY its module — never the full plan

## Execution Profiles
- `safe` — approval per wave, review per module
- `balanced` (default) — one up-front approval, scoped reviews
- `fast` — mature codebases, minimal blocking

## LAZY LOADING (CRITICAL)

### Step 1: Build Waves from Index
1. Read `docs/plan-index.xml` (≤50 lines) — find pending phases
2. Read current `docs/plans/Phase-N.xml` — get steps
3. Group steps into parallel-safe waves (disjoint write scopes, all dependencies complete)
4. **DO NOT** read future phases — they're irrelevant now

### Step 2: Dispatch Workers (DSH subagents)
For each wave, for each module, launch a background `subagent` with a self-contained prompt:
- Point it at `docs/modules/M-XXX.xml` (30-80 lines) + verification excerpt (give paths; the worker reads the files itself, or use `mygrace_show_module` if the MCP server is connected)
- Instruct: "Read ONLY your module file and its verification excerpt. Do NOT read the plan, indexes, or other modules. Implement per the contract, add module-local tests, run module-local verification, then report what you changed."
- Workers in one wave run in parallel: start independent subagents in the same turn and continue working while they run
- For very large fan-out (many independent modules), the `workflow` tool is the better option — it orchestrates batches of subagents with phases and structured results

### Step 3: Review and Integrate
1. Collect worker reports; scoped review of changed files
2. Update `docs/graph-index.xml` — module statuses
3. Update `docs/plans/Phase-N.xml` — step statuses
4. Update `docs/plan-index.xml` — phase status when all steps done
5. Run targeted refresh on touched modules (call the `mygrace-refresh` skill, scoped)

### Step 4: Report
```
=== WAVE COMPLETE ===
Wave: N | Modules: M-xxx, M-yyy
Context tokens per worker: ~130 lines (vs ~6500 in classic GRACE)
```

## Rules
- Workers report results; the controller applies index/phase updates
- Controller updates only indexes and current phase files
- Never let workers read the full plan
- Archive completed phases to `docs/archive/` when project grows
