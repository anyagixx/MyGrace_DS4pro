# Changelog

## v0.1.0 (2026-08-21)

### DeepSeek Harness — primary platform
- **`mygrace install-dsh`** — one-command integration: copies the 14 skills to `$DSH_HOME/skills/` (auto-discovered, appears in the Web GUI skill picker without restart) and adds an idempotent MCP row to the profile's `cordis.patch.yml` (with `--dry-run` / `--uninstall`, automatic backup)
- **`mygrace init-dsh`** — non-interactive project bootstrap: docs/ index structure from templates + an AGENTS.md that DSH auto-loads
- **14 skills adapted to DSH** — DSH frontmatter (`name` / `description` / `whenToUse`), no platform-specific syntax, `multiagent` rewritten on native DSH `subagent`/`workflow`, MCP tools preferred with file-read fallback
- **`templates/AGENTS.dsh.md.template`** — compact DSH context file (~100 lines)
- The MyGRACE repository itself now ships an AGENTS.md (dogfooding)

### Core fixes
- **Fixed a critical hang**: `mygrace lint` outside a MyGRACE project now fails in milliseconds with a readable error instead of looping forever (`findProjectRoot` walk was unbounded)
- **Fixed broken MCP tools**: `mygrace_show_phase` (was calling `module show --phase`), `mygrace_list_verifications` (`--priority`/`--format` now implemented in `verification index`), `mygrace_show_file` (`--root` instead of ignored `--path`)
- **Real unit tests** — tests now import the actual `src/` code (22 → 29 tests), including regression tests for the hang, commented-template entries, STATUS drift, and all 6 MCP tool mappings
- `@modelcontextprotocol/sdk` declared as a dependency; `typescript` moved to devDependencies
- Shared helpers extracted to `src/grace-common.ts` (single `findProjectRoot` / XML parsers)
- XML comments are ignored when parsing index entries (commented template examples no longer surface as phantom modules)

### Consistency
- Markup unified: canonical `START_MODULE_CONTRACT`, legacy `=== MODULE_CONTRACT ===` accepted by lint and `file show`
- `scripts/validate-marketplace.ts` extended: skills may only reference existing CLI commands; extension manifest paths must resolve
- Fixed dangling paths in `extensions/mygrace/qwen-extension.json`; fixed dangling RTK.md reference in the Codex instructions
- Rewritten `grace-markup-validation.sh` hook: no python3 dependency, no dead checks, correct JSON output
- `lefhook.yml` now runs `bun test` + marketplace validation

### Product artifacts
- **`examples/demo-store`** — 12-module dogfood project (lint 0/0, tests pass), regenerable via `scripts/gen-example.ts`
- **`scripts/measure-context.ts`** — reproducible context measurements: status 89%, module work 83%, phase 55% on the demo project; README now cites measured numbers with methodology
- README rewritten: DeepSeek Harness quick start, honest platform matrix

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
