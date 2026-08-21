# MyGRACE — Scalable GRACE with Lazy-Loading Indexes

**MyGRACE** is a scalable variant of GRACE (Graph-RAG Anchored Code Engineering) for **large projects** (20-200+ modules) developed by AI agents. It replaces monolithic XML files with lazy-loading indexes and per-entity files, cutting context usage per operation by up to ~90%.

**Primary platform: DeepSeek Harness.** Install with one command and the agent follows the methodology automatically in every project.

Current version: `0.1.0`

## Quick Start (DeepSeek Harness)

```bash
# 1. Install the CLI
bun add -g @osovv/mygrace-cli

# 2. Wire MyGRACE into DeepSeek Harness (skills + MCP server)
mygrace install-dsh

# 3. Restart the harness so the MCP row loads
dsh web

# 4. Bootstrap a project (docs/ indexes + AGENTS.md)
cd your-project
mygrace init-dsh --path . --name YourProject
```

After that:

- **The agent knows the methodology automatically** — DSH loads `AGENTS.md` at session start.
- **14 skills** (`mygrace-plan`, `mygrace-execute`, `mygrace-status`, …) appear in the Web GUI skill picker; the agent invokes them as needed.
- **7 MCP tools** (`mygrace_list_modules`, `mygrace_show_module`, `mygrace_show_phase`, `mygrace_list_verifications`, `mygrace_lint`, `mygrace_show_file`, `mygrace_status`) give the agent a structured, token-efficient read layer over the project graph.

Manage the integration: `mygrace install-dsh --dry-run`, `mygrace install-dsh --uninstall`.

## The Problem

Classic GRACE stores all modules in monolithic XML files. At 15+ modules these grow to thousands of lines, and an agent burns most of its context reading irrelevant data.

| Artifact | 5 modules | 20 modules | 50 modules |
|----------|-----------|------------|------------|
| `knowledge-graph.xml` | 150 lines | 800 lines | 2000-5000 lines |
| `development-plan.xml` | 200 lines | 1200 lines | 3000-8000 lines |
| `verification-plan.xml` | 100 lines | 600 lines | 1500-4000 lines |

## The MyGRACE Solution

Replace monolithic files with **indexes + per-entity files**:

| Classic GRACE | MyGRACE | Size per file |
|---------------|---------|---------------|
| `knowledge-graph.xml` | `graph-index.xml` + `docs/modules/M-XXX.xml` | Index ≤100 lines, module 30-80 lines |
| `development-plan.xml` | `plan-index.xml` + `docs/plans/Phase-N.xml` | Index ≤50 lines, phase 50-200 lines |
| `verification-plan.xml` | `verification-index.xml` + `docs/verification/V-M-XXX.xml` | Index ≤80 lines, entry 20-60 lines |

### Measured Token Savings

Measured with `bun run scripts/measure-context.ts --project examples/demo-store` (12 modules, 4 phases):

| Operation | Classic GRACE | MyGRACE | Savings |
|-----------|--------------|---------|---------|
| Status check (3 indexes) | 363 lines | 39 lines | **89%** |
| Single module work | 173 lines | 30 lines | **83%** |
| Phase execution | 31 lines | 14 lines | **55%** |
| Full verification audit | 159 lines | 159 lines | 0% (reading everything is reading everything) |

Savings grow with project size — the index stays flat while monolithic files grow linearly. The measurement is reproducible: the script synthesizes the classic equivalents by merging index + per-entity files, then compares operation-by-operation.

## Navigation Rule #1

**ALWAYS start with the index file. NEVER scan all per-entity files.**

```
Wrong:
1. Read knowledge-graph.xml (5000 lines) ← BURNING TOKENS
2. Search for M-AUTH
3. Read M-AUTH details

Right:
1. Read graph-index.xml (55 lines) ← FIND M-AUTH
2. Read docs/modules/M-AUTH.xml (60 lines) ← GET DETAILS
3. Done. 115 lines vs 5000.
```

## Project Structure

```
your-project/
├── docs/
│   ├── graph-index.xml          ← ALWAYS read first (≤100 lines)
│   ├── plan-index.xml           ← Phase index (≤50 lines)
│   ├── verification-index.xml   ← Verification index (≤80 lines)
│   ├── operational-packets.xml  ← Packet templates (stays small)
│   ├── requirements.xml         ← Requirements
│   ├── technology.xml           ← Technology stack
│   ├── modules/                 ← M-XXX.xml per module (30-80 lines)
│   ├── plans/                   ← Phase-N.xml per phase (50-200 lines)
│   ├── verification/            ← V-M-XXX.xml per entry (20-60 lines)
│   └── archive/                 ← Completed phases
├── AGENTS.md                    ← Auto-loaded by DeepSeek Harness
└── src/                         ← Source with MODULE_CONTRACT + semantic blocks
```

## Skills (14, shared across platforms)

| Skill | Purpose |
|-------|---------|
| `mygrace-init` | Bootstrap docs/ + AGENTS.md (fast path: `mygrace init-dsh`) |
| `mygrace-plan` | Design modules/phases/verification, write per-entity files + indexes |
| `mygrace-verification` | Design test scenarios, log markers, evidence per module |
| `mygrace-execute` | Implement a phase step by step (current phase + module only) |
| `mygrace-multiagent-execute` | Parallel waves via DSH subagents |
| `mygrace-refactor` | Safe restructuring with atomic index updates |
| `mygrace-refresh` | Sync indexes with per-entity files |
| `mygrace-reviewer` | Integrity audit (scoped / wave / full) |
| `mygrace-fix` | Debug: index → module → block |
| `mygrace-status` | Health report from 3 indexes only (~230 lines) |
| `mygrace-ask` | Q&A via lazy navigation |
| `mygrace-cli` | CLI / MCP reference |
| `mygrace-explainer` | Full methodology reference |
| `mygrace-setup-subagents` | Ready-to-use DSH subagent role prompts |

## CLI Commands

| Command | What It Does | Context Used |
|---------|--------------|--------------|
| `mygrace install-dsh` | Install into DeepSeek Harness (skills + MCP) | — |
| `mygrace init-dsh` | Bootstrap docs/ + AGENTS.md from templates | — |
| `mygrace module index` | Show graph-index.xml | ≤100 lines |
| `mygrace module find <query>` | Search modules by name/path/type/status | ≤100 lines |
| `mygrace module show <id>` | Show per-module file | 30-80 lines |
| `mygrace module show <id> --with-verification` | Module + verification file | 50-140 lines |
| `mygrace module list --status=wip` | Filter modules by status | ≤100 lines |
| `mygrace phase index` | Show plan-index.xml | ≤50 lines |
| `mygrace phase show Phase-N` | Show per-phase file | 50-200 lines |
| `mygrace verification index [--priority X] [--format json]` | Show/filter verification index | ≤80 lines |
| `mygrace lint` | Integrity check including index sync | ~230 lines |
| `mygrace file show <path> --root <root> --contracts --blocks` | File-local markup | Source file only |

## Example Project

`examples/demo-store` is a 12-module demo store used for dogfooding: `mygrace lint` passes 0/0, its tests pass, and it feeds `scripts/measure-context.ts`. Regenerate with `bun run scripts/gen-example.ts`.

## Platform Support

**DeepSeek Harness — primary, fully wired** (skills + MCP + AGENTS.md auto-loading).

| Platform | Packaging | Status |
|----------|-----------|--------|
| **DeepSeek Harness** | `mygrace install-dsh` | ✅ Primary |
| **Qwen Code** | `extensions/mygrace/` | ⚠️ Maintained, not the focus |
| **Codex / Cursor / Windsurf / KiloCode / Copilot / Aider** | `rules/*` instruction files | ⚠️ Instruction files only |
| **Claude Code / Gemini CLI / OpenCode** | `plugins/*` | ⚠️ Metadata stubs — context files not yet shipped |

## Why This Works

When relevant information is buried in a large context, models miss it. Constant, relevant context beats complete context: 40 relevant lines outperform 5000 lines containing 200 relevant ones. Indexes are how humans navigate books — tables of contents before chapters. MyGRACE enforces the same discipline for every operation: index first, details on demand.

## Development

```bash
bun test                              # unit tests (imports real src code)
bun run scripts/validate-marketplace.ts   # packaging validation
bun run scripts/gen-example.ts        # regenerate examples/demo-store
bun run scripts/measure-context.ts    # context savings report
```

## License

MIT

## Author

Forked from [GRACE marketplace](https://github.com/osovv/grace-marketplace) by osovv.
GRACE methodology designed by Vladimir Ivanov ([@turboplanner](https://t.me/turboplanner)).
