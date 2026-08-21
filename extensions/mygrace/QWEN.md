# MyGRACE — Scalable GRACE with Lazy-Loading

This project uses **MyGRACE** — a scalable variant of GRACE designed for large projects (20-200+ modules).

## Why MyGRACE?
Classic GRACE degrades at ~15 modules because monolithic XML files exceed 5000 lines, burning 80-95% of LLM context tokens on irrelevant data.

MyGRACE replaces monolithic files with **indexes + per-entity files**:
- `graph-index.xml` (≤100 lines) → `docs/modules/M-XXX.xml` (30-80 lines each)
- `plan-index.xml` (≤50 lines) → `docs/plans/Phase-N.xml` (50-200 lines each)
- `verification-index.xml` (≤80 lines) → `docs/verification/V-M-XXX.xml` (20-60 lines each)

**Token savings: 96%** per navigation operation.

## Navigation Rule #1
**ALWAYS** start with the index file. **NEVER** scan all per-entity files.
1. Read `docs/graph-index.xml` → find module ID
2. Read `docs/modules/M-XXX.xml` → only that module
3. Done. ~180 lines vs ~6500.

## Quick Reference
| Task | Command | Context Used |
|------|---------|-------------|
| Status | `/mygrace:status` | ~230 lines (3 indexes) |
| Find module | `mygrace module find auth` | ~100 lines (index) |
| Show module | `mygrace module show M-AUTH` | ~130 lines (index + module) |
| Execute plan | `/mygrace:execute` | ~280 lines per step |
| Health check | `mygrace lint` | ~230 lines (indexes) + files |

## Skills
`/mygrace:init` · `/mygrace:plan` · `/mygrace:execute` · `/mygrace:multiagent` · `/mygrace:refactor` · `/mygrace:refresh` · `/mygrace:reviewer` · `/mygrace:fix` · `/mygrace:status` · `/mygrace:ask` · `/mygrace:verification` · `/mygrace:cli` · `/mygrace:explainer` · `/mygrace:setup-subagents`
