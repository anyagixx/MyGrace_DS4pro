# MyGRACE — Scalable GRACE with Lazy-Loading Indexes

**MyGRACE** is a scalable variant of GRACE (Graph-RAG Anchored Code Engineering) designed for **large projects** with 20-200+ modules. It replaces monolithic XML files with lazy-loading indexes and per-entity files, reducing context token usage by **96%**.

Current version: `0.0.3`

## Platform Support

MyGRACE works across all major AI coding platforms. Canonical skills live in `skills/mygrace/` and are packaged for each platform:

| Platform | Packaging | Context File | Install |
|----------|-----------|-------------|---------|
| **Claude Code** | `plugins/claude/.claude-plugin/` | `CLAUDE.md` | Marketplace or skills dir |
| **Qwen Code** | `extensions/mygrace/` | `QWEN.md` | Extension or skills dir |
| **Gemini CLI** | `plugins/gemini/.gemini-plugin/` | `GEMINI.md` | Skills directory |
| **OpenCode** | `plugins/opencode/.opencode/` | `AGENTS.md` | Skills directory |
| **Cursor** | `rules/cursor/` | `.cursorrules` | Copy to project root |
| **Windsurf** | `rules/windsurf/` | `.windsurfrules` | Copy to project root |
| **KiloCode** | `rules/kilocode/` | `.kilocoderules` | Copy to project root |
| **Codex (ChatGPT)** | `rules/codex/` | `CODEX.md` | Copy to project or paste in custom instructions |
| **GitHub Copilot** | `rules/copilot/` | `.github/copilot-instructions.md` | Copy to project root |
| **Aider** | `rules/aider/` | `.aider.instructions.md` | Copy to project root |

All 14 skills are **shared** across platforms — only the packaging and context file names differ.

## The Problem

Classic GRACE stores all modules in monolithic XML files:

| Artifact | 5 modules | 20 modules | 50 modules |
|----------|-----------|------------|------------|
| `knowledge-graph.xml` | 150 lines | 800 lines | 2000-5000 lines |
| `development-plan.xml` | 200 lines | 1200 lines | 3000-8000 lines |
| `verification-plan.xml` | 100 lines | 600 lines | 1500-4000 lines |

At 15+ modules, LLMs burn 80-95% of context tokens reading irrelevant data. Attention dilution degrades response quality.

## The MyGRACE Solution

Replace monolithic files with **indexes + per-entity files**:

| Classic GRACE | MyGRACE | Size per file |
|---------------|---------|---------------|
| `knowledge-graph.xml` | `graph-index.xml` + `docs/modules/M-XXX.xml` | Index ≤100 lines, module 30-80 lines |
| `development-plan.xml` | `plan-index.xml` + `docs/plans/Phase-N.xml` | Index ≤50 lines, phase 50-200 lines |
| `verification-plan.xml` | `verification-index.xml` + `docs/verification/V-M-XXX.xml` | Index ≤80 lines, entry 20-60 lines |

### Token Savings

| Task | Classic GRACE | MyGRACE | Savings |
|------|--------------|---------|---------|
| Status check | ~6500 lines | ~230 lines | **96%** |
| Single module work | ~6500 lines | ~180 lines | **97%** |
| Phase execution | ~6500 lines | ~280 lines | **96%** |

### Scalability

| Metric | Classic GRACE | MyGRACE |
|--------|--------------|---------|
| Point of degradation | ~15 modules | ~200+ modules |
| Context per operation | Linear growth | Constant (~200 lines) |
| Archive support | No | Yes (`docs/archive/`) |

## Project Structure

```
mygrace-project/
├── docs/
│   ├── graph-index.xml          ← ALWAYS read first (≤100 lines)
│   ├── plan-index.xml           ← Phase index (≤50 lines)
│   ├── verification-index.xml   ← Verification index (≤80 lines)
│   ├── operational-packets.xml  ← Packet templates (stays small)
│   ├── modules/                 ← Per-module files (M-XXX.xml, 30-80 lines each)
│   ├── plans/                   ← Per-phase files (Phase-N.xml, 50-200 lines each)
│   ├── verification/            ← Per-verification files (V-M-XXX.xml, 20-60 lines each)
│   └── archive/                 ← Completed phases (moved when project grows)
├── AGENTS.md
├── QWEN.md
└── src/                         ← Source code with MODULE_CONTRACT, semantic blocks
```

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

## Install

### Skills
```bash
# Copy skills to your Qwen Code skills directory
cp -r skills/mygrace/grace-* ~/.qwen/skills/
```

### CLI
```bash
bun add -g @osovv/mygrace-cli
mygrace lint --path /path/to/project
```

### CLI Commands

| Command | What It Does | Context Used |
|---------|-------------|--------------|
| `mygrace module index` | Show graph-index.xml | ≤100 lines |
| `mygrace module find <query>` | Search modules by name/path/type/status | ≤100 lines |
| `mygrace module show <id>` | Show per-module file (docs/modules/M-XXX.xml) | 30-80 lines |
| `mygrace module show <id> --with-verification` | Module + verification file | 50-140 lines |
| `mygrace module list --status=wip` | Filter modules by status | ≤100 lines |
| `mygrace phase index` | Show plan-index.xml | ≤50 lines |
| `mygrace phase show Phase-N` | Show per-phase file | 50-200 lines |
| `mygrace verification index` | Show verification-index.xml | ≤80 lines |
| `mygrace lint` | Integrity check including index sync | ~230 lines |
| `mygrace file show <path>` | File-local markup | Source file only |

## Quick Start

```
1. /mygrace:init     → Create index-based docs/ structure
2. Fill requirements.xml + technology.xml
3. /mygrace:plan     → Design modules, creates index entries + per-module files
4. /mygrace:verification → Design tests, creates verification entries
5. /mygrace:execute  → Generate modules sequentially (lazy-loading)
6. /mygrace:status   → Health report (reads only indexes)
```

## Skills

| Skill | Purpose | Key Difference from Classic GRACE |
|-------|---------|-----------------------------------|
| `/mygrace:init` | Bootstrap project | Creates index files + per-entity directories |
| `/mygrace:plan` | Design architecture | Writes per-module files + index entries |
| `/mygrace:execute` | Sequential execution | Reads only current phase + current module |
| `/mygrace:multiagent` | Parallel waves | Each worker reads only its module |
| `/mygrace:refactor` | Safe restructuring | Updates indexes atomically |
| `/mygrace:refresh` | Sync indexes | Detects index ↔ file drift |
| `/mygrace:reviewer` | Integrity review | Checks index consistency |
| `/mygrace:fix` | Debug | Lazy: index → module → block |
| `/mygrace:status` | Health report | Reads only 3 indexes (~230 lines) |
| `/mygrace:ask` | Q&A | Lazy navigation via indexes |
| `/mygrace:verification` | Design tests | Per-verification files + index |
| `/mygrace:cli` | CLI reference | Index-based commands |
| `/mygrace:explainer` | Methodology ref | Documents scalable architecture |
| `/mygrace:setup-subagents` | Create agents | Lazy-navigation-aware agents |

## Migration from Classic GRACE

If you have an existing GRACE project with monolithic XML files:

1. Run `mygrace lint --path .` to assess current state
2. Run `/mygrace:refresh` to split monolithic files into indexes + per-entity files
3. The tool will:
   - Create `graph-index.xml` from `knowledge-graph.xml` module entries
   - Create `docs/modules/M-XXX.xml` for each module
   - Create `plan-index.xml` from `development-plan.xml` phases
   - Create `docs/plans/Phase-N.xml` for each phase
   - Create `verification-index.xml` from `verification-plan.xml` entries
   - Create `docs/verification/V-M-XXX.xml` for each verification entry
4. Archive the original monolithic files to `docs/archive/monolithic-backup/`

## Why This Works

Research on LLM attention patterns shows:
- **Attention dilution**: When relevant info is buried in large context, models miss it
- **Constant context is better than complete context**: 200 relevant lines outperform 5000 lines with 200 relevant
- **Index patterns are natural**: Humans use tables of contents before reading chapters — LLMs should too

MyGRACE enforces the same discipline for every operation: index first, details on demand.

## License

MIT

## Author

Forked from [GRACE marketplace](https://github.com/osovv/grace-marketplace) by osovv.
GRACE methodology designed by Vladimir Ivanov ([@turboplanner](https://t.me/turboplanner)).
