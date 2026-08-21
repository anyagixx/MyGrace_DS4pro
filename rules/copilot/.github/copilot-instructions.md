# MyGRACE Instructions

This project uses **MyGRACE** (Graph-RAG Anchored Code Engineering) — a scalable GRACE methodology with lazy-loading indexes for large projects.

## Critical Navigation Rule
Always start with index files. Never scan all per-entity files at once.

1. Read `docs/graph-index.xml` first (≤100 lines) — this tells you every module
2. Read `docs/modules/M-XXX.xml` only for the specific module you need (30-80 lines)
3. Never read monolithic XML files — they don't exist in MyGRACE

## Core Principles
- Never write code without a MODULE_CONTRACT
- START_BLOCK/END_BLOCK are navigation anchors, not comments
- graph-index.xml is always current — it never drifts from reality
- Top-down: Requirements → Technology → Plan → Verification → Contracts → Code
- Verification (tests, traces, logs) is part of the architecture
- Governed autonomy: you have freedom in HOW, not in WHAT

## Project Structure
```
docs/
  graph-index.xml         # Module index (≤100 lines)
  plan-index.xml          # Phase index (≤50 lines)
  verification-index.xml  # Verification index (≤80 lines)
  modules/                # Per-module files (M-XXX.xml)
  plans/                  # Per-phase files (Phase-N.xml)
  verification/           # Per-verification files (V-M-XXX.xml)
```

## File Markup
Each governed source file has:
- MODULE_CONTRACT (PURPOSE, SCOPE, DEPENDS, LINKS)
- MODULE_MAP (exported/local symbols)
- CHANGE_SUMMARY (recent changes)
- START_BLOCK / END_BLOCK pairs (semantic navigation)

## CLI Commands (if available)
- `mygrace module index` — show module list
- `mygrace module find <query>` — search modules
- `mygrace module show M-XXX` — show module details
- `mygrace lint` — integrity check
- `mygrace file show <path>` — file-local markup
