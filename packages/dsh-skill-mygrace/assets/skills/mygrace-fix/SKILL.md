---
name: mygrace-fix
description: "Debug using MyGRACE lazy navigation: index → relevant module → block → fix. Use when a bug report or failing test needs tracing to a governed module."
whenToUse: "A bug, error, or failing test needs to be traced and fixed inside a MyGRACE-governed project."
---

Debug using MyGRACE lazy navigation.

## LAZY PROCESS (CRITICAL — saves 95%+ context tokens)

### Step 1: Locate via Index
Read **ONLY** `docs/graph-index.xml` (≤100 lines) (MCP: `mygrace_list_modules`).
- Find the module likely involved in the error
- Note its PATH and VERIFICATION_REF
- **DO NOT** read all modules — you know which one you need from the error description

### Step 2: Read Only the Target Module
- Read `docs/modules/M-XXX.xml` (30-80 lines) — the module contract (MCP: `mygrace_show_module`)
- Read `docs/verification/V-M-XXX.xml` (20-60 lines) — relevant scenarios
- **DO NOT** read unrelated modules

### Step 3: Navigate to Block
From error with `[Module][function][BLOCK_NAME]`:
- Search for `START_BLOCK_BLOCK_NAME` in source at PATH from index
- `mygrace file show <path> --root <root> --contracts --blocks` lists file-local markup compactly (MCP: `mygrace_show_file`)
- Read the containing function's CONTRACT

### Step 4: Analyze and Fix
- Compare CONTRACT (expected) vs code (actual)
- Apply fix WITHIN semantic block boundaries
- Update CHANGE_SUMMARY

### Step 5: Update Metadata
- Update module file if contract changed
- Update graph-index.xml if STATUS changed
- Update verification file if tests/markers changed
- Run module-local verification
- Run `mygrace lint --path <root>` (MCP: `mygrace_lint`) to confirm indexes are still synced

## Important
- **Always start with graph-index.xml** — one file, ≤100 lines
- **Read only the target module** — ~130 lines total vs ~6500 in classic GRACE
- Never fix code without reading its CONTRACT
- Never change CONTRACT without approval
