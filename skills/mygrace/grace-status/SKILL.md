---
name: mygrace-status
description: "Show MyGRACE project health by reading ONLY the three index files (~230 lines). Use to get a fast project status before planning next work."
whenToUse: "Before starting a work session or deciding the next action, when a quick project health read is needed."
---

Show the current state of the MyGRACE project.

## LAZY REPORT (reads only indexes — ~230 lines total)

### 1. Index Status (read these 3 files — ALWAYS)
- `docs/graph-index.xml` (≤100 lines) — module count, status distribution (MCP: `mygrace_list_modules`)
- `docs/plan-index.xml` (≤50 lines) — phase count, status distribution
- `docs/verification-index.xml` (≤80 lines) — verification count, priority distribution (MCP: `mygrace_list_verifications`)

### 2. Codebase Metrics (fast scan)
- Total source files
- Files WITH MODULE_CONTRACT
- Files WITHOUT MODULE_CONTRACT (warning)
- Paired vs unpaired semantic blocks

### 3. Index Consistency Check
One-call shortcut: MCP `mygrace_status` (or `mygrace status --path <root> --format json`) returns module/phase/verification counts plus lint errors/warnings in one JSON call — use it to skip steps 1–3 when only the health summary is needed.
Otherwise run `mygrace lint --path <root>` (MCP: `mygrace_lint`):
- Modules in graph-index vs files in docs/modules/
- Modules in graph-index vs source files with MODULE_CONTRACT
- Verification entries in verification-index vs files in docs/verification/
- Orphaned entries (in index but file missing)
- Missing entries (file exists but not in index)

### 4. Recent Changes
List 5 most recent CHANGE_SUMMARY entries (scan source files quickly)

### 5. Suggested Next Action
- No modules in index → run the `mygrace-plan` skill
- Modules pending, no verification → run the `mygrace-verification` skill
- Modules ready but not executed → run the `mygrace-execute` skill (or `mygrace-multiagent-execute` for parallel waves)
- Drift detected → run the `mygrace-refresh` skill
- All synced → "Project is healthy"

## Token Budget
This entire report uses ~230 lines of context. Classic GRACE equivalent: ~6500 lines.
**Savings: 96%**
