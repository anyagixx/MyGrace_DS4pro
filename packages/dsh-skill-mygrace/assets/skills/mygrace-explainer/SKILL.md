---
name: mygrace-explainer
description: "Complete MyGRACE methodology reference: lazy-loading indexes, per-module files, phase-based navigation. Use to refresh understanding of how the methodology works before applying other skills."
whenToUse: "You are unsure about MyGRACE concepts, file layout, or navigation rules and need the reference."
---

# MyGRACE — Scalable Graph-RAG Anchored Code Engineering

MyGRACE is a scalable variant of GRACE designed for **large projects** (20-200+ modules). It solves the context-overflow problem of classic GRACE by replacing monolithic XML files with lazy-loading indexes and per-entity files.

## Platform Support

**DeepSeek Harness (DSH) is the primary platform.** The `mygrace-*` skills are installed for the DSH `skill` tool, and AGENTS.md at the project root is auto-loaded by DSH — this skill only adds what AGENTS.md does not cover. Other platforms (Claude Code, Qwen Code, Cursor, etc.) are optional and not part of this distribution.

## The Problem MyGRACE Solves

Classic GRACE stores all modules in monolithic files:
- `knowledge-graph.xml` — 2000+ lines at 50 modules
- `development-plan.xml` — 3000+ lines at 50 modules
- `verification-plan.xml` — 1500+ lines at 50 modules

LLMs that read these files burn 80-95% of context tokens on irrelevant data. Quality degrades at ~15 modules.

## The MyGRACE Solution

| Classic GRACE | MyGRACE | Size |
|---------------|---------|------|
| `knowledge-graph.xml` (monolithic) | `graph-index.xml` + `docs/modules/M-XXX.xml` | Index ≤100 lines, module 30-80 lines |
| `development-plan.xml` (monolithic) | `plan-index.xml` + `docs/plans/Phase-N.xml` | Index ≤50 lines, phase 50-200 lines |
| `verification-plan.xml` (monolithic) | `verification-index.xml` + `docs/verification/V-M-XXX.xml` | Index ≤80 lines, entry 20-60 lines |

## Navigation Rules (CRITICAL — always follow these)

1. **ALWAYS** read `docs/graph-index.xml` first — it's the single source of module existence (≤100 lines)
2. **NEVER** read `docs/knowledge-graph.xml` — use `docs/modules/M-XXX.xml` per module
3. **NEVER** read `docs/development-plan.xml` — use `plan-index.xml` + `docs/plans/Phase-N.xml`
4. **NEVER** read `docs/verification-plan.xml` — use `verification-index.xml` + `docs/verification/V-M-XXX.xml`
5. Prefer MCP tools (`mygrace_list_modules`, `mygrace_show_module`, `mygrace_show_phase`, `mygrace_list_verifications`, `mygrace_lint`, `mygrace_show_file`) when connected; fall back to direct file reads or the `mygrace` CLI
6. Archive completed phases to `docs/archive/` — they stay in the index but details move out

## Six Core Principles
1. **Never Write Code Without a Contract** — MODULE_CONTRACT before code
2. **Semantic Markup Is Not Comments** — navigation anchors for LLMs
3. **Knowledge Graph Is Always Current** — graph-index.xml never drifts
4. **Top-Down Synthesis** — Requirements → Technology → Plan → Verification → Contracts → Code
5. **Verification Is Architecture** — testing, traces, log markers are part of the blueprint
6. **Governed Autonomy (PCAM)** — Purpose, Constraints, Autonomy, Metrics

## Development Workflow (DSH)

Run each stage via the `skill` tool:
1. `mygrace-init` — create index-based docs/ structure
2. Fill `docs/requirements.xml` and `docs/technology.xml`
3. `mygrace-plan` — architect modules, updates index + per-module files
4. `mygrace-verification` — design tests, updates verification-index + per-entry files
5. `mygrace-execute` — sequential module generation
6. `mygrace-multiagent-execute` — parallel-safe waves via subagents
7. `mygrace-refactor` — safe restructuring, updates indexes
8. `mygrace-refresh` — sync indexes with per-entity files
9. `mygrace-fix` — debug via lazy navigation
10. `mygrace-status` — health report (reads only indexes)
11. `mygrace-ask` — Q&A over artifacts

## Token Savings
| Task | Classic GRACE | MyGRACE | Savings |
|------|--------------|---------|---------|
| Status check | ~6500 lines | ~230 lines (3 indexes) | 96% |
| Single module work | ~6500 lines | ~180 lines (index + module + verification) | 97% |
| Phase execution | ~6500 lines | ~280 lines (indexes + phase + modules) | 96% |

## CLI
```bash
mygrace lint --path .                        # integrity check including index sync
mygrace module index --path .                # show graph-index.xml
mygrace module find <query> --path .         # resolve module IDs
mygrace module show M-XXX --path .           # per-module file (docs/modules/M-XXX.xml)
mygrace module list --status=wip --path .    # filter by status
mygrace phase index --path .                 # show plan-index.xml
mygrace phase show Phase-1 --path .          # show specific phase
mygrace verification index --path .          # show verification-index.xml
mygrace file show <path> --root . --contracts --blocks  # file-local markup
```
