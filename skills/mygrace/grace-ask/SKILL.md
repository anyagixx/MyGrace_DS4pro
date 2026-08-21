---
name: mygrace-ask
description: "Answer questions about the current MyGRACE project using lazy index navigation (index first, details on demand). Use when the user asks what a module does, where something lives, or how artifacts relate."
whenToUse: "User asks a question about project structure, modules, phases, verification, or code location."
---

Answer a question about the current MyGRACE project.

## Process — LAZY NAVIGATION (CRITICAL)

### Step 1: Load Index Only
Read **ONLY** `docs/graph-index.xml` (≤100 lines). This tells you every module that exists.
- **DO NOT** read `docs/knowledge-graph.xml` (monolithic, too large)
- **DO NOT** read all module files — you don't need them yet
- Prefer the MCP tool `mygrace_list_modules` when connected; fall back to reading the file directly.

### Step 2: Identify Relevant Modules from Index
From graph-index.xml, find modules related to the question:
- Match by NAME, TYPE, PATH, DEPENDS
- Note the module IDs (e.g., M-AUTH, M-CHATS)

### Step 3: Read Only Relevant Per-Module Files
For each relevant module:
- Read `docs/modules/M-XXX.xml` (30-80 lines each)
- Read `docs/verification/V-M-XXX.xml` if the question is about behavior/testing
- **DO NOT** read non-relevant modules
- Prefer MCP tools `mygrace_show_module` / `mygrace_show_phase` when connected.

### Step 4: If CLI Available
Use `mygrace module find <query> --path <root>` to resolve module IDs from names/paths
Use `mygrace module show M-XXX --path <root>` for structured module output (saves tokens vs raw XML)
Use `mygrace module show M-XXX --with-verification --path <root>` to include the verification excerpt.

### Step 5: Dive Into Code If Needed
- Use the PATH from graph-index.xml to locate source files
- Read MODULE_CONTRACT and relevant START_BLOCK/END_BLOCK sections
- `mygrace file show <path> --root <root> --contracts --blocks` shows file-local markup compactly (MCP: `mygrace_show_file`).

### Step 6: Answer
Provide answer grounded in actual artifacts. Cite which modules/files you used.

## Important
- **Always start with graph-index.xml** — never skip it
- **Never read monolithic XML files** — they don't exist in MyGRACE
- **Read only modules relevant to the question** — don't preload everything
- If info isn't in artifacts, say so. Suggest the relevant `mygrace-*` skill (e.g., mygrace-refactor, mygrace-refresh) via the skill tool if changes are needed.
