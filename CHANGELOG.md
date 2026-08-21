# Changelog

## v0.0.3 (2026-04-10)

### New Platforms
- **KiloCode** — `rules/kilocode/.kilocoderules` (Cursor fork-compatible)
- **Codex (ChatGPT)** — `rules/codex/CODEX.md` (ChatGPT custom instructions / Code Interpreter)

### Total Platforms: 10
Claude Code, Qwen Code, Gemini CLI, OpenCode, Cursor, Windsurf, KiloCode, Codex (ChatGPT), GitHub Copilot, Aider

---

## v0.0.2 (2026-04-10)

### Multi-Platform Support
- **Claude Code** — `plugins/claude/.claude-plugin/plugin.json` + marketplace manifest
- **Qwen Code** — `extensions/mygrace/` extension with skills, agents, commands, hooks, MCP
- **Gemini CLI** — `plugins/gemini/.gemini-plugin/plugin.json`
- **OpenCode** — `plugins/opencode/.opencode/plugin.json`
- **Cursor** — `rules/cursor/.cursorrules`
- **Windsurf** — `rules/windsurf/.windsurfrules`
- **GitHub Copilot** — `rules/copilot/.github/copilot-instructions.md`
- **Aider** — `rules/aider/.aider.instructions.md`

### Architecture
All platforms share the same canonical skills in `skills/mygrace/`. Each platform gets its own packaging directory and platform-specific context files.

---

## v0.0.1 (2026-04-10)

Initial release of MyGRACE — scalable GRACE methodology with lazy-loading indexes.

### Architecture
- Replaced monolithic XML files (`knowledge-graph.xml`, `development-plan.xml`, `verification-plan.xml`) with index-based architecture
- `graph-index.xml` (≤100 lines) + `docs/modules/M-XXX.xml` (30-80 lines each)
- `plan-index.xml` (≤50 lines) + `docs/plans/Phase-N.xml` (50-200 lines each)
- `verification-index.xml` (≤80 lines) + `docs/verification/V-M-XXX.xml` (20-60 lines each)
- 96-97% context token savings vs classic GRACE
- Scalability: degrades at ~200+ modules vs ~15 in classic GRACE

### CLI
- `mygrace module index` — show graph-index.xml
- `mygrace module find <query>` — search modules by name/path/type/status
- `mygrace module show <id>` — show per-module file
- `mygrace module show <id> --with-verification` — module + verification file
- `mygrace module list [--status=X]` — filter modules
- `mygrace phase index` — show plan-index.xml
- `mygrace phase show <name>` — show per-phase file
- `mygrace verification index` — show verification-index.xml
- `mygrace lint` — integrity check including index synchronization
- `mygrace file show <path>` — file-local markup

### Lint
- Index ↔ per-entity file consistency checks
- Semantic block pairing validation
- Unique XML tag convention checks
- MODULE_CONTRACT presence detection

### Skills (14)
All skills adapted for lazy-loading navigation:
- Always start with index files
- Read only relevant per-entity files
- Never scan monolithic XML
- Update indexes after any change

### MCP Server
- `mygrace_list_modules` — list from graph-index.xml
- `mygrace_show_module` — per-module file from docs/modules/
- `mygrace_show_phase` — per-phase file from docs/plans/
- `mygrace_list_verifications` — list from verification-index.xml
- `mygrace_lint` — integrity check
- `mygrace_show_file` — file-local markup
