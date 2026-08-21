# MyGRACE Instructions for ChatGPT (Codex)

You are assisting with a project that uses **MyGRACE** (Graph-RAG Anchored Code Engineering) — a scalable methodology for AI-driven code generation designed for large projects with 20-200+ modules.

## Critical Navigation Rule
**Always start with index files. Never scan all files at once.**

This project replaces monolithic documentation files with a lazy-loading index pattern:

1. **Read `docs/graph-index.xml` first** (≤100 lines) — this tells you every module that exists
2. **Read `docs/modules/M-XXX.xml`** (30-80 lines each) — only for the specific module you need
3. **Done** — ~130 lines vs ~6500 lines in classic approaches

**Do NOT** look for or read `knowledge-graph.xml`, `development-plan.xml`, or `verification-plan.xml` — these monolithic files do NOT exist in MyGRACE.

## Six Core Principles
1. **Never write code without a contract** — Every file must have a MODULE_CONTRACT comment block defining PURPOSE, SCOPE, DEPENDS, and LINKS before any code is written
2. **Semantic markup is not comments** — `START_BLOCK_NAME` and `END_BLOCK_NAME` markers are navigation anchors, not documentation
3. **Knowledge graph is always current** — `docs/graph-index.xml` never drifts from reality
4. **Top-down synthesis** — Requirements → Technology → Plan → Verification → Contracts → Code. Never jump to code
5. **Verification is architecture** — Tests, traces, and log markers are part of the architectural blueprint
6. **Governed autonomy** — You have freedom in HOW to implement, not in WHAT. The contract defines WHAT

## Project Structure
```
docs/
  graph-index.xml         # Module index — ALWAYS read this first (≤100 lines)
  plan-index.xml          # Phase index (≤50 lines)
  verification-index.xml  # Verification index (≤80 lines)
  operational-packets.xml # Execution packet templates
  modules/                # Per-module files: M-CONFIG.xml, M-AUTH.xml, etc.
  plans/                  # Per-phase files: Phase-1.xml, Phase-2.xml, etc.
  verification/           # Per-verification files: V-M-CONFIG.xml, etc.
  archive/                # Completed phases (moved here when project grows)
```

## File Conventions
Each governed source file contains:
- `MODULE_CONTRACT` — PURPOSE, SCOPE, DEPENDS, LINKS (what to build)
- `MODULE_MAP` — List of exported/local symbols
- `CHANGE_SUMMARY` — Recent changes with reasons
- `START_BLOCK_X` / `END_BLOCK_X` — Semantic code sections for navigation

## When Writing or Editing Code
- Always preserve MODULE_CONTRACT, MODULE_MAP, CHANGE_SUMMARY
- Always preserve START_BLOCK/END_BLOCK boundaries unless restructuring
- Update CHANGE_SUMMARY after making changes
- Update docs/graph-index.xml if module public interfaces change
- If a contract seems wrong, propose a change — don't silently deviate

## Module Types
- ENTRY_POINT — Where execution begins (CLI, HTTP handler)
- CORE_LOGIC — Business rules and domain logic
- DATA_LAYER — Persistence, queries, caching
- UI_COMPONENT — User interface elements
- UTILITY — Shared helpers, configuration, logging
- INTEGRATION — External service adapters

## Token Efficiency
This methodology saves 96-97% of context tokens compared to classic approaches. Always leverage the index-first pattern.
