---
name: mygrace-cli
description: "Operate the mygrace CLI and MCP tools for linting and lazy module/phase/verification queries. Use when a fast, token-efficient read layer over MyGRACE artifacts is needed."
whenToUse: "Prefer this skill when the mygrace CLI or MCP server is available; it saves context vs raw file reads."
---

Use the `mygrace` CLI as a fast MyGRACE-aware read/query layer, and the MCP tools as the preferred in-agent access path.

## MCP Tools (preferred when connected)
- `mygrace_list_modules` — modules from graph-index.xml (filter by status/type)
- `mygrace_show_module` — per-module file (optionally with verification)
- `mygrace_show_phase` — per-phase file
- `mygrace_list_verifications` — verification entries
- `mygrace_lint` — integrity check including index sync
- `mygrace_show_file` — file-local markup
- `mygrace_status` — aggregated health (module/phase/verification counts + lint) as JSON
If the MCP server is not connected, fall back to the CLI commands below or direct file reads.

## CLI Commands

### Index Commands
- `mygrace module index --path <root>` — show graph-index.xml (≤100 lines)
- `mygrace phase index --path <root>` — show plan-index.xml (≤50 lines)
- `mygrace verification index --path <root>` — show verification-index.xml (≤80 lines)

### Module Commands
- `mygrace module find <query> --path <root>` — resolve module IDs from the index
- `mygrace module show <id> --path <root>` — read per-module file (docs/modules/M-XXX.xml)
- `mygrace module show <id> --with-verification --path <root>` — module + verification file
- `mygrace module list --status=wip --path <root>` — filter modules by status
- `mygrace module list --type=CORE_LOGIC --path <root>` — filter by type
- `mygrace module list --format json --path <root>` — machine-readable output

### Phase Commands
- `mygrace phase show Phase-N --path <root>` — read per-phase file

### General
- `mygrace lint --path <root>` — integrity check including index synchronization
- `mygrace status --path <root>` — aggregated health from the 3 indexes + lint
- `mygrace status --path <root> --format json` — machine-readable health (use for dashboards/panels)
- `mygrace file show <path> --root <root>` — file-local markup
- `mygrace file show <path> --root <root> --contracts --blocks` — with contracts and blocks

## Lazy Navigation Pattern
1. Start with an index command (≤100 lines)
2. Use module/phase show for details (30-200 lines)
3. **Never read monolithic XML** — it doesn't exist in MyGRACE

## Output Guidance
- Use default text output for quick review
- Use `--format json` for scripts and subagents
- Treat the CLI as navigation help — read source files for exact evidence when needed
