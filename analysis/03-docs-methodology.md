# MyGRACE — Audit 03: Documentation, Skills, Templates, Rules, Plugins — Factual Consistency & Methodology Quality

- **Task:** shared task `task-3` (claimed at revision 1)
- **Auditor:** docs-methodology-auditor (teammate)
- **Repo:** `/home/truffle/Downloads/MyGrace_DS4pro-main` — `@osovv/mygrace-cli` v1.0.1
- **Environment:** bun 1.4.5; `dsh` 0.2.1-rc.2 present; `pnpm` absent; read-only inspection of project files; the only file written is this report.
- **Method:** read all docs/skills/templates/rules/plugins/extensions + `src/*.ts`; ran every documented CLI command/flag; ran the MCP mapping code paths via the CLI; reproduced the repo's own measurement and packaging scripts; ran `bun test`; executed deliberate drift/archive experiments in `/tmp`; checked the npm registry. Evidence commands and raw outputs are listed in §10.

## Verdict in one paragraph

The index-first methodology is **real, not buzzword-driven**: it demonstrably cuts context (89% / 83% / 55% / 0% measured and faithfully reproducible in `README.md:59-66`), the core CLI/MCP read layer works, and the 15 skills have valid DSH frontmatter. But the documentation ecosystem is **systematically stale**: the count of skills is stated as 14, 15 and 12 in different files; several central invariants are unenforced (module-checks placement, archive policy, phase-status drift, "status from indexes only"); the install instructions cannot work because **no `@osovv/*` package exists on npm**; and the repo violates its own methodology (`docs/` is absent, `mygrace lint` exits 1). This is a credible prototype with marketing-grade claims layered on top; the docs need a truth pass before anyone should call it v1.0.x.

## Scores (independent, justified)

| Dimension | Score | Justification |
|---|---|---|
| **Documentation accuracy** | **4 / 10** | Strongest part: README's MCP-tool list (15/15 exact names), measured-savings table (reproduced to the line), platform matrix's "metadata stubs" statement, and version string are all accurate. Weakest: a critical broken install path (npm 404), three mutually contradictory skill counts (15, 14 and 12) spread across 12+ files, "96–97%" claims that contradict the repo's own 89/83/55/0% measurements, a stale root `AGENTS.md` (7/15 MCP tools, 12/15 skills, missing whole Wave-E section), a stale validator that prints "Skills: 14 ✓", and an archive rule that provably fails lint. 34 of the 59 doc claims checked are broken (table §2). |
| **Methodology soundness** | **5 / 10** | The core idea (index ≤100 lines → per-entity 30–80/50–200/20–60 lines, lazy loading) is legitimate context engineering with measured benefit. But as *specified* it is internally inconsistent: size caps forbid the advertised 200+ module scale, the shipped templates/example violate the entity size contracts (phase: 8-line template vs 50–200 requirement), the verification-command contract is read from the wrong file, archiving a done phase breaks lint, phase-status drift is undetectable by `lint`, and "status from 3 indexes only" is false (it runs a full lint scan). Principles #3 ("never drifts") and #5 ("verification is architecture") are aspirations, not enforced properties. |

---

# 1. What the implementation actually exposes (baseline for cross-checks)

## 1.1 CLI (verified via `bun run src/grace.ts <cmd> --help`)

14 top-level commands are registered (`src/grace.ts:34-49`): `lint`, `module {index,find,show,list}`, `phase {index,show}`, `verification {index}`, `file {show}`, `status`, `install-dsh`, `init-dsh`, `doctor`, `test`, `packet`, `focus`, `context-cost`, `verify`.

Flags that matter for the doc audit (all verified to work, including citty's auto kebab↔camel aliasing):

| Command | Real flags (help) | Notes |
|---|---|---|
| `module show <ID>` | `--path`, `--withVerification` (`--with-verification` works via citty alias) | verified |
| `install-dsh` | `--profile`, `--dryRun` (`--dry-run` works), `--uninstall`, `--bundle`, `--source`, `--dshHome` | verified in `/tmp` |
| `test` | `--module`, `--compact`, `--path` | verified |
| `verify` | `--module`, `--all`, `--path` | `--all` is declarative only |
| `packet` / `focus` | positional `ID`, `--path` | verified |
| `context-cost` | `--path`, `--format` | verified |
| `doctor` | `--path`, `--format` | verified, exits 1 on errors |
| `status` | `--path`, `--format` | verified |
| `lint` | `--path`, `--format`, `--allowMissingDocs` | verified |

Stale header comment in the same file: `src/grace.ts:6-15` documents only 9 of the 14 commands (missing `status`, `install-dsh`, `init-dsh`, `doctor`, `test`, `packet`, `focus`, `context-cost`, `verify`). Internal but telling: the file's own doc-comment was never updated after Waves E/F/H.

## 1.2 MCP server — exactly 15 tools, names as in README

`src/grace-mcp.ts:26-222` registers exactly 15 tools; `src/grace-mcp-commands.ts:112-128` (`TOOL_NAMES`) lists the same 15. Programmatic diff of README's backticked `mygrace_*` names vs code names = **no difference**:

```
mygrace_list_modules, mygrace_show_module, mygrace_show_phase, mygrace_find_modules,
mygrace_phase_index, mygrace_doctor, mygrace_test, mygrace_packet, mygrace_focus,
mygrace_context_cost, mygrace_verify, mygrace_list_verifications, mygrace_lint,
mygrace_show_file, mygrace_status
```

One behavioral defect: `mygrace_test`'s JSON schema declares `compact: default true` (`src/grace-mcp.ts:114`) but the mapper appends `--compact` **only when the argument is explicitly `true`** (`src/grace-mcp-commands.ts:68`). A client that omits `compact` gets the CLI default (`false`) — the advertised default is never applied.

## 1.3 Skills on disk — 15, installed as `mygrace-*`

15 dirs under `skills/mygrace/grace-*`; `skillSourceDirs()` (`src/grace-install.ts:42-50`) maps **every** `grace-*` dir → `mygrace-*`, so install-dsh installs 15 and `mygrace doctor` shows "0/15" (`src/grace-doctor.ts:99-106`). The `packages/dsh-skill-mygrace` assets contain the same 15 SKILL.md files (byte-identical to the canonical ones — verified by diff), and its test asserts `list() returns 15 MyGRACE skills` (`test/dsh-skill-mygrace.test.ts:26`).

**15 is the truth. Every "14" in the repo is stale — except where it is "12".**

## 1.4 Templates — 14 files, 7 of them dead

`templates/` contains 14 files. Only 7 are consumed by `init-dsh` (`src/grace-init.ts:30-41`): `graph-index`, `plan-index`, `verification-index`, `operational-packets`, `requirements`, `technology`, `AGENTS.dsh.md`. Never referenced anywhere in `src/`, `scripts/`, `test/`, or any skill:
`templates/knowledge-graph.xml.template`, `templates/development-plan.xml.template`, `templates/verification-plan.xml.template`, `templates/QWEN.md.template`, `templates/module/M-XXX.xml.template`, `templates/phase/Phase-N.xml.template`, `templates/verification/V-M-XXX.xml.template`. No skill ever says "copy `templates/module/M-XXX.xml.template`" — the skills embed their own abbreviated XML instead, which is how the module/verification schemas drifted.

---

# 2. Documented claim → verification table (59 claims)

Legend: ✅ verified · ❌ broken/false/contradicted · ⚠️ partial or misleading. `file:line` = the claim; evidence follows it.

## A. Skill-inventory claims (8)

| # | Doc claim (file:line) | Verdict | Evidence |
|---|---|---|---|
| A1 | `README.md:15` "bundle: MCP server + **15 skills** + status panel" | ✅ | bundle skill package bundles 15 assets; `test/dsh-skill-mygrace.test.ts:26` asserts 15 |
| A2 | `README.md:31` "**15 skills** (…) appear in the Web GUI skill picker" | ✅ | installer copies every `grace-*` dir (15) → `mygrace-*`; `mygrace doctor` counts 15 |
| A3 | `README.md:105` "## Skills (**14**, shared across platforms)" | ❌ | the table directly below has 15 rows (109-123); 15 dirs on disk |
| A4 | `src/grace-install.ts:406` install-dsh help: "MCP server + **14 skills** + status panel" | ❌ | `install-dsh --dry-run` lists 15 "would copy …" lines; `skillSourceDirs()` is dynamic |
| A5 | `scripts/validate-marketplace.ts:83-88` expects 14 skills and prints "Skills: 14 ✓" (`:102`) | ❌ | omits `grace-token-budget`; validator is green only because the 15th skill is never checked |
| A6 | `.claude-plugin/marketplace.json:18-75` lists 14 skill components | ❌ | 14 `source: skills/mygrace/grace-*` entries; `grace-token-budget` missing |
| A7 | `packages/dsh-skill-mygrace/package.json:3`, `packages/mygrace-dsh/package.json:3`, `packages/mygrace-dsh/README.md:3` "14 skills" | ❌ | 15 assets/bundled skills; same bundle README says "The **15** `mygrace-*` skills" at `:28` |
| A8 | `CHANGELOG.md:9` "provider returns 14 skills" (v1.0.1) | ❌ | same release note's first line (`CHANGELOG.md:6`) adds the "15th bundled skill" and the test asserts 15 |

## B. MCP-tool claims (6)

| # | Doc claim (file:line) | Verdict | Evidence |
|---|---|---|---|
| B1 | `README.md:32` "**15 MCP tools** (…15 names…)" | ✅ | exact 15/15 name match against `src/grace-mcp.ts:29-221` (diff of names empty) |
| B2 | `templates/AGENTS.dsh.md.template:39` lists 15 tools | ✅ | all 15 present |
| B3 | `AGENTS.md:39` lists **7** MCP tools as "the MCP tools" | ❌ | missing `mygrace_find_modules`, `mygrace_phase_index`, `mygrace_doctor`, `mygrace_test`, `mygrace_packet`, `mygrace_focus`, `mygrace_context_cost`, `mygrace_verify` |
| B4 | `skills/mygrace/grace-cli/SKILL.md:10-16` lists 7 tools (skill claims to be the "CLI/MCP reference", `README.md:120`) | ❌ | reference omits 8 existing tools |
| B5 | `skills/mygrace/grace-explainer/SKILL.md:38` (6 tools), `grace-setup-subagents/SKILL.md:22` (6 tools) | ⚠️ | subsets, not wrong per se, but inconsistent with the catalog they are supposed to document |
| B6 | `src/grace-mcp.ts:114` `compact: default true` for `mygrace_test` | ❌ | `src/grace-mcp-commands.ts:68` only forwards `--compact` when caller passes `true`; documented default is unreachable |

## C. CLI-command claims (11)

| # | Doc claim (file:line) | Verdict | Evidence |
|---|---|---|---|
| C1 | `README.md:129-146` CLI table documents `doctor`/`test`/`verify`/`packet`/`focus`/`context-cost` | ✅ | all six exist and run (`doctor`, `test`, `verify`, `packet`, `focus`, `context-cost` verified in `/tmp` project) |
| C2 | README's CLI table is complete | ❌ | **`mygrace status` is absent from README entirely** (0 grep hits), although `CHANGELOG.md:66` lists it as a new command, three skills use it, and `mygrace status` works |
| C3 | `README.md:134` `module show <id> --with-verification` | ✅ | works (citty alias `withVerification`); verified on demo |
| C4 | `README.md:35` `install-dsh --dry-run`, `--uninstall` | ✅ | verified (`DRY RUN — no changes will be written`, 15 would-copy lines) |
| C5 | `README.md:139` `packet` uses "40–120 lines" of context | ⚠️ | measured 38 lines for `packet M-API` on demo (i.e. below stated floor) |
| C6 | `README.md:140` `focus` "5 lines" | ⚠️ | measured 4 lines on demo (`=== FOCUS …`, Status, Contract, Deps) |
| C7 | `README.md:118` `mygrace-status` "reads **only** 3 index files (~230 lines)" | ❌ | `src/grace-status.ts:36` calls `collectLintIssues(root,true)`, which reads every file in `docs/modules`, `docs/plans`, `docs/verification` and walks `src`, `lib`, `apps`, `packages` (`src/grace-lint.ts:100,221-255`); on the demo project the 3 indexes total **39** lines, and the status command's own output is 8 lines |
| C8 | `README.md:145` `mygrace lint` "Context Used ~230 lines" | ⚠️ | lint prints ~9 lines; 230 is the *index size cap* for status, not lint's context |
| C9 | `README.md:137-138` `test` scoped from verification, `verify` → `.mygrace/last-failures.md` | ⚠️ | `verify` is accurate (`src/grace-verify.ts:38-48`); `test` takes `<test-files>` from the verification file but takes `<module-checks>` from the **module** file (`src/grace-test.ts:31-36,76`) — see Q3 |
| C10 | Root `AGENTS.md` is a complete instruction file | ❌ | contains **no** Wave-E commands at all (`doctor`, `test`, `verify`, `packet`, `focus`, `context-cost`); the template has a whole "Token budget & workflow" section (`templates/AGENTS.dsh.md.template:86-92`) that was deleted/never present here |
| C11 | `AGENTS.md:24-35` skill table references all skills | ❌ | 12 skills listed; `mygrace-explainer`, `mygrace-setup-subagents`, `mygrace-token-budget` missing (same in the template, `:24-35`) |
| C12 | `skills/mygrace/grace-cli/SKILL.md:18-40` CLI list is the reference | ❌ | missing `doctor`, `test`, `verify`, `packet`, `focus`, `context-cost`, `install-dsh`, `init-dsh` |
| C13 | `PLAN.md:13,62,109` document `mygrace init --ds` | ❌ | command does not exist; only `init-dsh` (`src/grace.ts:42`); deviation itself admitted only at `PLAN.md:4` |

## D. Install / packaging claims (5)

| # | Doc claim (file:line) | Verdict | Evidence |
|---|---|---|---|
| D1 | `README.md:12-14` "1. Install the CLI — `bun add -g @osovv/mygrace-cli`" | ❌ | npm registry returns **404** for `@osovv/mygrace-cli`, `@osovv/mygrace-dsh`, `@osovv/dsh-skill-mygrace`, `@osovv/dsh-mygrace-rtk`, `mygrace-status-panel`; registry search for "mygrace" → 0 objects. `PLAN.md:6` itself says "Публикация на npm — за владельцем (нужны креды)" |
| D2 | `package.json` ships everything the CLI imports | ❌ | `package.json:31-41` `files` omits `src/grace-doctor.ts`, `grace-test.ts`, `grace-packet.ts`, `grace-context.ts`, `grace-verify.ts`, all statically imported by `src/grace.ts:26-30`. An actual `npm pack` of this package (44 KB tarball) contains only **10** `package/src/*.ts` files — the 5 imported modules are absent. Simulated install of that file set: `error: Cannot find module './grace-doctor' from '.../src/grace.ts'` — i.e. the published package would not start at all |
| D3 | `README.md:16` `mygrace install-dsh --bundle` works from the installed package | ❌ | `packages/mygrace-dsh` is not in `package.json:files`; `bundleDir()` would `readFileSync` a nonexistent `package.json` |
| D4 | `README.md:7` "Current version: `1.0.1`" | ✅ | `package.json:3`, `extensions/mygrace/qwen-extension.json:3`, README agree; `bun run scripts/validate-marketplace.ts` prints "Version: 1.0.1 ✓" |
| D5 | `README.md:33` status card hot-applies with "No rebuild, no restart" | ⚠️ | not verifiable here (no installed panel, `pnpm` absent); the install requires pnpm and a pre-booted profile (`src/grace-install.ts:270-320`), neither documented in README |

## E. Savings claims (4)

| # | Doc claim (file:line) | Verdict | Evidence |
|---|---|---|---|
| E1 | `README.md:59-66` measured table (363/39/173/30/31/14/159/159; 89/83/55/0%) | ✅ | `bun run scripts/measure-context.ts --project examples/demo-store` reproduces **exactly** (module 12, phases 4) |
| E2 | `README.md:3` "cutting context usage per operation by **up to ~90%**" | ✅ | consistent with the measured 89% max |
| E3 | `rules/*`, `grace-explainer`, `grace-status`, `extensions/mygrace/QWEN.md` claim **96–97%** | ❌ | contradicts the repo's own measured 89/83/**55**/0%; e.g. `rules/cursor/.cursorrules:62-64`, `rules/codex/CODEX.md:59-60`, `skills/mygrace/grace-explainer/SKILL.md:67-69`, `skills/mygrace/grace-status/SKILL.md:42-43`, `extensions/mygrace/QWEN.md:13` — 7 files claim 96% |
| E4 | `skills/mygrace/grace-explainer/SKILL.md:67` "Status check ~6500 → ~230 lines (96%)"; `:68` single module 180 lines/97% | ❌ | demo measures 363→39 (89%) and 173→30 (83%); 6500 is an unqualified 50-module baseline while the shipped example is 12 modules (363 lines) |

## F. Platform / rules / plugin claims (7)

| # | Doc claim (file:line) | Verdict | Evidence |
|---|---|---|---|
| F1 | `README.md:161` Claude/Gemini/OpenCode "metadata stubs — context files not yet shipped" | ✅ | `plugins/*/plugin.json` contain only name/description/version/author/license; no context files |
| F2 | `README.md:160` Codex/Cursor/Windsurf/KiloCode/Copilot/Aider "Instruction files only" | ✅ | six files exist under `rules/` |
| F3 | `README.md:159` Qwen Code "⚠️ Maintained, not the focus" | ❌ | the extension is discarded classic-GRACE: `extensions/mygrace/hooks/grace-session-start.sh:12-14` detects only monolithic `knowledge-graph.xml`/`development-plan.xml`/`verification-plan.xml` (never triggers in a MyGRACE project); `commands/grace-lint.md:6` says `grace lint` (wrong binary); `commands/grace-refresh.md:6` "sync knowledge-graph.xml and verification-plan.xml"; `QWEN.md:24,31` still uses `/mygrace:*` slash syntax and a 14-skill list |
| F4 | `skills/mygrace/grace-init/SKILL.md:54` "Do not create platform-specific context files (QWEN.md, CLAUDE.md, etc.) — this distribution targets DSH only" vs shipped `templates/QWEN.md.template` + `extensions/mygrace/QWEN.md` + README platform matrix | ❌ | direct contradiction: the package ships Qwen context files and claims multi-platform packaging |
| F5 | `plugins/claude/.claude-plugin/plugin.json:4`, `plugins/gemini/.gemini-plugin/plugin.json:4`, `plugins/opencode/.opencode/plugin.json:4` version `0.1.0` | ⚠️ | package/README/Qwen extension are 1.0.1; three independent version lines |
| F6 | `.claude-plugin/marketplace.json:5` metadata version `0.3.0`; `:7` homepage `anyagixx/MyGrace`; `:16` plugin source `./extensions/mygrace` | ❌ | metadata version 0.3.0 vs 1.0.1 elsewhere; `extensions/mygrace` has no `.claude-plugin/`, it is the Qwen extension; nothing validates this file (`scripts/validate-marketplace.ts` never reads it) |
| F7 | `README.md:160` Aider/Codex instruction files are "instruction files" (implying auto-loaded) | ⚠️ | per vendor docs, Aider does not auto-read `.aider.instructions.md` (needs `/read CONVENTIONS.md` or `read:` in `.aider.conf.yml`), and Codex CLI reads `AGENTS.md`, not `CODEX.md`; users must wire these up manually |

## G. CHANGELOG / PLAN claims (8)

| # | Doc claim (file:line) | Verdict | Evidence |
|---|---|---|---|
| G1 | `CHANGELOG.md:26` "Tests: 80 → 86 (26 new: …)" | ❌ | `bun test test/` → **95 pass**, 10 files. The listed new tests sum to 20, not 26, and 80→86 is +6. Three mutually inconsistent numbers in one sentence |
| G2 | `CHANGELOG.md:55` "the MyGRACE repository itself ships an AGENTS.md (dogfooding …)" | ❌ | there is **no `docs/`** in the repo; `bun run src/grace.ts lint` exits 1 with "MyGRACE project not found"; `prepublishOnly` needs `--allow-missing-docs` (`package.json:59`) |
| G3 | `CHANGELOG.md:74` "`lefhook.yml` now runs `bun test` + marketplace validation" | ❌ | the file is named `lefhook.yml`; Lefthook only recognizes `lefthook.yml`/`.lefthook.yml`/`.config/lefthook.yml` (and yaml/toml/json variants) — **hooks never run**; even if renamed they would not run `lint` |
| G4 | Version history complete | ⚠️ | headers jump `v0.2.0` (line 34) → `v1.0.1` (line 3); no `v1.0.0` entry, no explanation |
| G5 | `PLAN.md:3` "**ВСЕ ФАЗЫ ВЫПОЛНЕНЫ** (v0.1.0)" | ❌ | Phase 2.5 ("Новый скилл `mygrace-install-dsh` (или секция в `grace-cli`)", `PLAN.md:42`) was never done: no such skill exists and `grace-cli` never mentions `install-dsh`; 2.3 criterion "skills don't mention other platforms" violated by `grace-explainer:13` and `grace-token-budget:25`; 2.2 criterion is scoped only to `skills/` (the CLI still prints `/mygrace:init` at `src/grace-module.ts:31`) |
| G6 | `PLAN.md:13,62,109` `mygrace init --ds` | ❌ | see C13 |
| G7 | `PLAN.md:84` Phase 6.3 "measured numbers instead of unfounded 96–97%" | ⚠️ | true for `README.md` (§E1) only; the 96–97% claims survive in `rules/*` (4 files), `grace-explainer`, `grace-status`, `QWEN.md` — see E3 |
| G8 | `PLAN.md:74` "fix dangling `~/.codex/RTK.md` reference in Codex instructions" | ✅ | no `RTK.md`/`.codex` reference remains anywhere (grep) |

## H. Repo self-consistency / dead artifacts (8)

| # | Doc claim (file:line) | Verdict | Evidence |
|---|---|---|---|
| H1 | `AGENTS.md:9-16` makes `docs/graph-index.xml` etc. mandatory and says monolithic files "do NOT exist here" | ❌ | this repo has **no `docs/`** at all and `mygrace lint` exits 1 (the file is not appropriate for this repo); secondarily, "non-existent" classic XML survives as `templates/{knowledge-graph,development-plan,verification-plan}.xml.template` |
| H2 | Root `AGENTS.md` is a current MyGRACE-generated file | ❌ | `diff` against `templates/AGENTS.dsh.md.template` shows exactly two divergences: MCP list 7 vs 15, and the whole "Token budget & workflow" section missing. 94 lines vs template 102 — a pre-Wave-E snapshot never regenerated |
| H3 | `templates/` content is live (14 files advertised as methodology assets) | ⚠️ | 7 unreferenced templates (3 classic monolithic, `QWEN.md`, and the 3 per-entity templates no skill mentions; §1.4) |
| H4 | `docs/operational-packets.xml` "execution packet templates" (`README.md:94`, `AGENTS.md:76`, created by `src/grace-init.ts:36`) | ❌ | no command and no skill reads or writes it; its schema (`ExecutionPacket`/`GraphDelta`/`VerificationDelta`, `templates/operational-packets.xml.template:1-110`) does not match `mygrace packet`'s Markdown output at all |
| H5 | `src/grace-module.ts:31` user-facing error: "Run **/mygrace:init** first." | ❌ | stale Qwen/Claude slash syntax in the current CLI (the v0.2.0 note said this class of stale reference was fixed, `CHANGELOG.md:42`) |
| H6 | `.mygrace/last-failures.md` hygiene (`AGENTS.dsh.md.template:89`, `grace-token-budget:15`) | ⚠️ | `.gitignore` has no `.mygrace/` entry; agents following the skill will commit failure artifacts |
| H7 | `extensions/mygrace/qwen-extension.json:24-39` settings `mygrace.autoLint`, `mygrace.lazyNavigation`, `mygrace.archiveAfterModules` | ❌ | no code reads any of these keys (grep across `src/`, `scripts/`, `packages/`) — aspirational config |
| H8 | `extensions/mygrace/QWEN.md:31` lists 14 skills and `/mygrace:*` commands; `:24,27` use `/mygrace:status`, `/mygrace:execute` | ❌ | 14 not 15 (missing token-budget); slash syntax was supposed to be eliminated (`PLAN.md:39`), and these command names do not exist in the current distribution |

**Tally: 59 claims checked → 34 ❌ broken, 12 ⚠️ misleading/partial, 13 ✅ verified.**
Broken share: 58%. The verified set is concentrated in exactly the places that were measured last (README's MCP list and context table), which suggests the docs are maintained only where a script forces it.

---

# 3. `AGENTS.md` vs `templates/AGENTS.dsh.md.template`

- **Self-consistent?** Almost — they are 96% the same file. The root `AGENTS.md` is an **older generation** of the template: identical except (a) MCP list 7 vs 15 tools, (b) the entire "Token budget & workflow" section (`templates/AGENTS.dsh.md.template:86-92`) missing in the root file. So the root file was generated from a template version that predates Wave E (2026-11-22) and never refreshed. The template is the better file, but it is not the one agents in this repo load.
- **Right skill names?** Skill *names* are correct (`mygrace-*`), but both files list only **12 of 15** skills (missing `mygrace-explainer`, `mygrace-setup-subagents`, `mygrace-token-budget`). A fresh user project therefore advertises a 12-skill subset in its always-loaded context while 15 exist in the catalog.
- **Appropriate for this repo?** **No.** `AGENTS.md:9-16` and `:71-84` instruct the agent to read `docs/graph-index.xml`, `docs/plan-index.xml`, `docs/verification-index.xml`, `docs/modules/…` — none exist in this repository. The mandatory self-lint fails (`exit 1`), and the only reason `prepublishOnly` passes is `--allow-missing-docs`. This is the single clearest "documentation vs reality" mismatch: the tool's own repository does not use the tool.
- The template's "Project status | Only the 3 index files | ~230 lines" row is repeated in root `AGENTS.md:14` and is not supportable as written (see Q6): 230 is the *cap sum*, the measured demo total is 39, and `mygrace status` also runs a full lint scan.

---

# 4. Methodology coherence audit (the important part)

## Q1 [High] The index caps mathematically forbid the advertised scale

`README.md:3` "large projects (20-200+ modules)", `CHANGELOG.md:119` "degrades at ~200+ modules", while `README.md:91` says `graph-index.xml` is "ALWAYS read first (**≤100 lines**)" and templates demand **one line per module** (`templates/graph-index.xml.template:5`). Fixed header/comments consume ~8 lines ⇒ practical ceiling ≈ **92 modules**, not 200. `verification-index.xml ≤80 lines` with one line per entry ⇒ ≈ **72 verification entries**, i.e. fewer than the module count. `plan-index.xml ≤50` is fine for phases. The three caps and the scale claim cannot both be true; no documented splitting strategy exists (e.g. sharded indexes).

## Q2 [High] Entity size contracts are violated by the shipped templates and by the official example — and the measured savings depend on that violation

Documented contract: module file **30–80** lines, phase file **50–200**, verification **20–60** (`README.md:53-55`, `AGENTS.md:79-81`, `templates/AGENTS.dsh.md.template:79-81`, `grace-plan/SKILL.md:19,21`).

Reality:
- `templates/phase/Phase-N.xml.template` = **8 lines** (a 4-step phase is ~6 lines; 50 lines would need ~48 steps).
- Flagship example (`examples/demo-store`, the one that "feeds `measure-context.ts`", `README.md:150`): modules **12–13 lines**, phases **4–6 lines**, verifications **11–12 lines** — 2–10× below the contract.
- Therefore the measured "savings" are an artifact of below-spec files. Sensitivity: classic baselines on demo are 173 (modules) / 31 (development plan) / 159 (verification). At the documented *minimum* entity sizes, single-module work = 17+30 = **47** lines vs 173 (≈73%, not 83%), and phase execution = 7+50 = **57** lines vs **31** classic ⇒ **−84% (i.e. MyGRACE is worse)**; at max sizes it is far worse still. `README.md:59` says "savings grow with project size" (fair), but the 55% phase row is presented flatly and the 96–97% claims elsewhere have no size qualification at all.

## Q3 [High] The verification-command contract is broken: `<module-checks>` is written where the tool does not read it

- `skills/mygrace/grace-verification/SKILL.md:39` and `templates/verification/V-M-XXX.xml.template:6-8` define `<module-checks>` **inside the verification file**.
- `src/grace-test.ts:31-36,76`: `parseCheckCommand(moduleContent)` reads `<module-checks>` from **`docs/modules/M-XXX.xml`**, where no template or skill puts it; the shipped demo modules do not have it either.
- Reproduced (`/tmp` project): with `echo FROM_VM_FILE` in `V-M-A.xml` and no module-checks in `M-A.xml`, `mygrace test --module M-A` ran the file list through the default `bun test` and never executed `echo`; after adding module-checks to `M-A.xml`, it executed `FROM_MODULE_FILE`.
- Consequence: the documented per-module verification command is dead code in every project that follows the skill; `mygrace test` silently always uses `bun test`. This directly negates Principle #5 ("Verification is architecture") and the README's "Run module tests scoped from verification files" claim as commonly read.

## Q4 [High] The archive policy cannot be followed (documented rule ⇒ lint error)

Five docs instruct archiving completed phases by moving the file: `grace-execute/SKILL.md:47`, `grace-multiagent-execute/SKILL.md:60`, `grace-refresh/SKILL.md:41-42`, `grace-explainer/SKILL.md:39`, `AGENTS.md:82`/template `:82`. `grace-explainer/SKILL.md:39` goes further: "they **stay in the index** but details move out".

Verified: move `docs/plans/Phase-1.xml` → `docs/archive/Phase-1.xml` while the `plan-index.xml` entry remains ⇒ `mygrace lint` reports **error** `Orphaned index entry: Phase-1 (no plans/Phase-1.xml)`. Nothing in any doc/CLI says "delete the index entry when archiving", and `lint` has no archive awareness. So the methodology's archive step is specified in a way that breaks its own primary invariant checker.

## Q5 [High] Drift detection is much weaker than the docs claim — "the knowledge graph is always current" is aspirational

Actual `lint` coverage (verified by code + experiments):

| Invariant | Automated? | Details |
|---|---|---|
| index entry ↔ entity file presence (both directions) | ✅ error | `src/grace-lint.ts:26-94`; both directions |
| module `STATUS` drift | ⚠️ **warning only, exit 0** | `src/grace-lint.ts:77-91` (uppercase `STATUS` in module file) |
| verification `STATUS` drift | ⚠️ warning only | same code path |
| **phase `status` drift** | ❌ **not detected** | phase files use lowercase `status=` (`templates/phase/Phase-N.xml.template:2`); drift regex only matches uppercase `STATUS="…"`. Reproduced: phase file `status="done"` + plan-index `status="pending"` ⇒ lint "✓ All checks passed" |
| `PATH` matches actual file location | ❌ not checked | yet `grace-refresh/SKILL.md:22` tells the agent to verify it and `grace-reviewer/SKILL.md:47` lists it as a check |
| `DEPENDS` matches imports | ❌ not checked | `grace-reviewer/SKILL.md:48` |
| phase step count matches | ❌ not checked | `grace-refresh/SKILL.md:30` |
| CrossLink bidirectionality | ❌ not checked | `grace-reviewer/SKILL.md:44` |
| index module ↔ source file with MODULE_CONTRACT | ❌ not checked | `grace-status/SKILL.md:22-23` claims it is ("Modules in graph-index vs source files with MODULE_CONTRACT"); lint only warns about >2 blocks with no contract inside a file (`src/grace-lint.ts:132-143`) |

Additionally, warnings never fail lint (`process.exit(errors.length > 0 ? 1 : 0)`, `src/grace-lint.ts:313`), so drift cannot gate CI. And this repo has **no CI gate at all**: `lefhook.yml` is inert (wrong filename, G3), `prepublishOnly` runs lint only with `--allow-missing-docs` and the repo currently fails plain lint. The methodology's most important invariant is enforced by willpower.

## Q6 [High] "Status can be computed from 3 indexes only" — false as implemented and self-contradictory as specified

- `README.md:118`, `AGENTS.md:14`, `templates/AGENTS.dsh.md.template:14`, `PLAN.md:15`, `grace-status/SKILL.md:3,9` all claim status comes from the 3 indexes (~230 lines).
- `mygrace status` does read the 3 indexes for counts, but also runs `collectLintIssues(root,true)` (`src/grace-status.ts:36`), which reads every per-entity file and walks source dirs (`src/grace-lint.ts:100,221-255`). The *agent-visible* output is tiny (8 lines), so the token claim is defensible; the *implementation* claim ("from the 3 indexes") is not.
- Worse, the skill itself asks for things only obtainable from source: "Codebase Metrics (fast scan) — Total source files; Files WITH MODULE_CONTRACT; …" (`grace-status/SKILL.md:16-21`) and "Recent Changes — list 5 most recent CHANGE_SUMMARY entries (scan source files quickly)" (`:31-35`), then concludes "This entire report uses ~230 lines of context" (`:42`). That is not index-only and not 230 lines — it is a full-codebase scan, exactly what the methodology forbids.
- Measured contradiction: on the demo project the three indexes total **39** lines (`context-cost` + `measure-context`), not 230; 230 is only the sum of the caps.

## Q7 [Medium] Dead artifacts and unimplemented templates inside the methodology

- `docs/operational-packets.xml` is created by `init-dsh` but read by nothing (see H4); its schema is a different packet format than `mygrace packet` produces. The skill `grace-multiagent-execute` describes packets but never references this file.
- `templates/module/M-XXX.xml.template`, `templates/phase/Phase-N.xml.template`, `templates/verification/V-M-XXX.xml.template` are never mentioned by any skill; the skills inline abbreviated XML instead, which is precisely how Q3 happened.
- Legacy classic-GRACE templates (`knowledge-graph`, `development-plan`, `verification-plan`) and `QWEN.md.template` ship in a package whose docs repeatedly say those artifacts "do NOT exist".

## Q8 [Medium] Cross-skill duplication and contradictions (LLM-agent perspective)

The 15 SKILL.md files total **41,728 bytes ≈ 10.4k tokens** (range 1.9–4.9 KB each; ≈480–1230 tokens/skill). Frontmatter is uniformly valid (all 15 have `name: mygrace-*`, `description`, `whenToUse`; `whenToUse` is a real optional DSH field per `SkillEntry` in `@deepseek-ai/dsh-api-session-controller/lib/types/types.d.ts:250-261`). But the bodies duplicate heavily:

- `graph-index.xml` is mentioned in **14/15** skills; the size caps are re-stated in 7/6/5/7/3/4 skills respectively; 46 occurrences of "100 lines" across the repo's docs.
- The "Six Principles" text appears verbatim in 9 files in the repo (root AGENTS, template AGENTS, QWEN template, both explainer copies, 4 rules files).
- Same operation, three different context figures: `grace-execute/SKILL.md:55` "~150 lines per step", `grace-multiagent-execute/SKILL.md:58` "~130 lines per worker", `grace-explainer/SKILL.md:69` "~280 lines" for phase execution — while the measurement says 14 lines for a phase on demo and ~57 lines for a contract-compliant 50-line phase. An agent has no way to know which to believe.
- Planning is described three times with different shapes: `grace-plan` (6 phases with user approval), `grace-multiagent-execute` (wave building+dispatch), `grace-explainer` (10-step workflow) — consistent in spirit, inconsistent in sequencing (e.g. explainer puts `mygrace-verification` before execution, execute's prerequisites say verification should exist, plan already creates verification files in Phase 5).
- `grace-status` contradicts itself (index-only claim vs source scans); `grace-init` says "DSH only" while the distribution ships 6 rules platforms + Qwen + 3 plugin stubs; `grace-explainer/SKILL.md:13` says other platforms "are optional and not part of this distribution" while they are literally directories in the distribution.
- `grace-setup-subagents` (29 lines) advertises "ready-to-use DSH subagent prompts for … (planner, implementer, reviewer, verifier, fixer)" but contains one shared prompt prefix plus five one-line role bullets — **no actual role prompts**. Its description is aspirational, and the Qwen hook message (`grace-session-start.sh:20`) advertises "Subagents: grace-planner, grace-implementer, …" as if agent files existed (the skill correctly says none do).
- `grace-token-budget` depends on external tools not shipped/tested here (`rtk`, `caveman`, vendor slash commands `/caveman-compress`, `/caveman`, `/ultracave`, `/megacave`, `npx skills add JuliusBrussee/caveman`) and one unverifiable marketing number ("121 tokens vs 15,704 for a 200-row table", `:33`). It also names `CLAUDE.md` (`:25`) in a distribution that says it targets DSH only.
- Unactionable instructions: `grace-verification/SKILL.md:59-61` "Apply Verification Levels … make explicit in the verification file" — but no field/element for levels exists in the V-M template; `grace-plan` never points to the per-entity templates; `grace-reviewer` requires manual checks (`PATH`, `DEPENDS`, CrossLinks) that lint cannot verify and provides no tool.

## Q9 [Medium] "Index-first" discipline itself: sound, but unenforced and partly contradicted

The positive case is real: 89% and 83% measured context reductions for status and single-module work are genuine and reproducible; per-entity files keep reads bounded; the demo project passes lint 0/0. This is a legitimate, useful methodology — not a buzzword.

The negatives are specification-level: (a) index limits conflict with scale (Q1); (b) index-first is *instructions*, not mechanism — nothing detects an agent that reads everything, and the official example cannot be distinguished from an agent that ignored the rule; (c) three of the six principles (#3 never drifts, #5 verification is architecture, #4 top-down) are not backed by enforcement; (d) the status skill itself instructs source scanning (Q6), i.e. the methodology's own "lazy" skill breaks the rule; (e) per-entity files duplicate index data (STATUS/PATH/DEPENDS), guaranteeing dual-write drift that the linter only partially detects (Q5).

---

# 5. Skill quality table (LLM-agent perspective)

`~tok` = bytes/4 (rough). All 15 have valid frontmatter (verified: `name`, `description`, `whenToUse`).

| Skill | Lines | Bytes | ~tok | Quality verdict |
|---|---|---|---|---|
| grace-ask | 46 | 2417 | 604 | Good; clear 6-step lazy flow. Minor: warns not to read `knowledge-graph.xml`, which doesn't exist in the target project. |
| grace-cli | 52 | 2762 | 690 | **Weakest reference**: claims to be CLI/MCP reference but lists 7/15 MCP tools and omits 8 CLI commands (test/verify/packet/focus/context-cost/doctor/install-dsh/init-dsh). |
| grace-execute | 63 | 2718 | 679 | Good sequencing; archive step contradicts lint (Q4); "~150 lines/step" unsupported. |
| grace-explainer | 82 | 4905 | 1226 | Duplicates README; 96/97% claims contradict measurements; archive "stay in index" is wrong; stale MCP subset. |
| grace-fix | 44 | 1937 | 484 | Good; actionable index→module→block→fix. |
| grace-init | 54 | 2919 | 729 | Good fast-path; "DSH only" claim contradicts the shipped multi-platform packaging. |
| grace-multiagent-execute | 60 | 3202 | 800 | Best DSH-native skill; "~130 lines/worker" differs from execute/explainer; archive caveat. |
| grace-plan | 84 | 3205 | 801 | Good flow; does not reference `templates/module` or `templates/phase`, so the agent must infer file schemas; states size contracts it never enforces. |
| grace-refactor | 50 | 2279 | 569 | Good; explicit "index updates mandatory". |
| grace-refresh | 55 | 2555 | 638 | Good manual checklist; recommends archiving to a directory lint rejects (Q4); PATH/step checks are manual-only. |
| grace-reviewer | 71 | 2776 | 694 | Good scoped/wave/full model; checklist items exceed lint's actual checks (Q5) but are framed as manual. |
| grace-setup-subagents | 29 | 2098 | 524 | **Aspirational**: 5 "roles" are one-liners; no complete prompts despite "ready-to-use" in description. |
| grace-status | 43 | 2152 | 538 | **Self-contradictory**: "reads only indexes — ~230 lines" then instructs source scans (Q6); 96% claim. |
| grace-token-budget | 37 | 2737 | 684 | Depends on third-party, unshipped tools (`rtk`, `caveman`); unverifiable numbers; names `CLAUDE.md` in a DSH-only package. |
| grace-verification | 73 | 3066 | 766 | Good intent; defines `<module-checks>` in the file the tool does not read (Q3); "verification levels" has no schema field. |

**Summary:** roughly half the skills are solid as-is; 4 need substantive fixes (`grace-cli`, `grace-status`, `grace-setup-subagents`, `grace-explainer`'s numbers), plus targeted fixes in `grace-execute`/`grace-refresh` (archive rule) and `grace-verification` (module-checks placement). Boilerplate is ~30–40% of total bytes; targeted loading keeps per-skill cost acceptable (≤1.3k tokens), but an agent trusting `grace-cli`/`grace-status` will be misinformed about the tool surface it operates.

---

# 6. Stale / aspirational claims (beyond the table)

1. **Packaging published-state**: README presents a global npm install as step 1; no package is published (D1). `PLAN.md:6` admits it. This is the highest-impact single defect in the docs.
2. **`--bundle` install path**: the bundle packages exist only in-repo and are excluded from the CLI package's `files` (D3). The bundle README itself says "Install (dev/in-repo)". README does not qualify this.
3. **Qwen Code "maintained"**: the extension's hook cannot detect a MyGRACE project (looks for classic monolithic XML), its `/grace:*` command files call a nonexistent `grace` binary and sync classic monolithic artifacts, and its context file uses 14 skills + slash syntax. Effectively unmaintained legacy from v0.0.2.
4. **Claude marketplace manifest**: `.claude-plugin/marketplace.json` is not referenced by README or any validator; version `0.3.0`, 14 skills, plugin source points at the Qwen extension dir. Dead/incorrect artifact at repo root.
5. **OpenPackage manifest**: `openpackage.yml:3` version 0.1.0; no script/test/README references it. Stale.
6. **Version drift**: 1.0.1 (package/README/Qwen extension/marketplace plugin) vs 0.3.0 (marketplace metadata) vs 0.1.0 (openpackage, 3 plugins, 4 workspace packages). `validate-marketplace.ts` checks only 3 of these.
7. **"10 platforms"** (`CHANGELOG.md:87-88`): of the 10 counted, 3 are empty metadata stubs (Claude Code, Gemini CLI, OpenCode), 1 (Qwen) is non-functional legacy, and 6 are instruction files (two of which, Aider and Codex, are not auto-loaded). Only DSH — which is not even in that count — is actually wired. The README matrix is more honest than the changelog.
8. **"Verified live" claims** (CHANGELOG passim: provider returns N skills, install/uninstall round-trips, panel served without restart) cannot be reproduced in this environment and at least two are now false at the current commit (N=14 → 15; "14 skills" install message). Any claim that a number was "verified live" is only true for the commit it was written against.
9. **Test-count inflation**: CHANGELOG's 86 vs actual 95 (`bun test test/`), and "26 new" vs 20 listed, and "+6" implied. Tests themselves pass — this is bookkeeping sloppiness, but it undermines "verified" claims.
10. **Measurement quirk**: `linesOf()` counts `split("\n").length` (`scripts/measure-context.ts:24`), so every file gains +1 for the trailing newline (demo status = 36 real lines reported as 39). Small, but the numbers are presented to the line ("363 / 39 / 89%") without noting this.

---

# 7. Credibility issues (typos, duplication, naming, language mixing, inflated claims)

- **Language mixing:** `PLAN.md` (117 lines) is entirely in Russian while README/CHANGELOG/AGENTS/skills are English; it is the only Russian file in the repo and contains the release/status claims ("ВСЕ ФАЗЫ ВЫПОЛНЕНЫ"). A public fork cannot use it as documentation.
- **Naming drift:** official name is "MyGRACE"; the repo also contains `MyGrace` (package homepage/repository URLs, `PLAN.md:8,92`, `.claude-plugin/marketplace.json:7`), `MyGRace` (typo, `scripts/gen-dsh-skill-mygrace.ts:6`), and four renderings of the CLI: `mygrace`, `grace` (extension command files: `grace lint`), `/mygrace:` slash commands (QWEN.md), `/grace:` commands (extension command frontmatter `name: grace:lint`). Skill dirs are `grace-*` while installed/skill names are `mygrace-*` — documented nowhere as a step.
- **Duplicated prose:** the six-principles block exists in 9 files; the project-structure block in ≥8; 6 rules files are near-copies (`cursor` vs `kilocode` differ by 8 lines out of 64; `cursor` vs `windsurf` by 41); the CLI/token-savings tables repeat across README, explainer, QWEN.md, and 4 rules files with differing numbers (96% vs 89%).
- **Typos/dead text:** `lefhook.yml` should be `lefthook.yml` (G3); `MyGRace` (above); `src/grace.ts:6-15` stale subcommand list; `src/grace-module.ts:31` `/mygrace:init`; `templates/operational-packets.xml.template:1` `VERSION="0.1.0"` inside a 1.0.1 package; `scripts/validate-marketplace.ts:83-88` stale expected skill list (prints "Skills: 14 ✓" while 15 exist).
- **Inflated claims not backed by tests:** "20-200+ modules" (caps allow ≈92); "96–97%" context savings (measured 55–89%); "saves 95%+ context tokens" (`grace-fix/SKILL.md:8`); "40 relevant lines outperform 5000" (`README.md:165`, rhetorical); "121 tokens vs 15,704" (`grace-token-budget:33`); "ready-to-use subagent prompts" (29-line skill); "10 platforms"; "up to 200 modules" (CHANGELOG:119); "the harness picked it up immediately" (CHANGELOG:55, no docs/ dir).
- **Verification of claims is not reproducible from the repo:** the validator checks versions, files, frontmatter, template placeholders, and skill→command references — but its command allowlist (`scripts/validate-marketplace.ts:145`) is stale (8 commands: `lint, module, phase, verification, file, status, install-dsh, init-dsh`), so if the 15th skill were added to `expectedSkills`, the validator would emit **6 false warnings** for legitimate commands (`doctor`, `test`, `verify`, `packet`, `focus`, `context-cost`). It never checks: skill counts vs disk, MCP tool names, marketplace.json, openpackage.yml, plugin versions, README numbers, or PLAN/CHANGELOG claims. That is why all of the above drift survived to v1.0.1.

---

# 8. Prioritized fix list (file:line → action)

**P0 — false or broken for users**
1. `README.md:13` — replace `bun add -g @osovv/mygrace-cli` with an honest install path (`bun add -g` from a git checkout, `bun link`, or "not yet on npm; publish pending"), or publish the packages. Cross-check `PLAN.md:6`.
2. `package.json:31-41` — add `src/grace-doctor.ts`, `grace-test.ts`, `grace-packet.ts`, `grace-context.ts`, `grace-verify.ts`; add `packages/mygrace-dsh` (or remove `--bundle` from README until publishable). Then re-simulate a `files`-only install; verify the `npm pack` tarball lists all 15 src modules.
3. Decide the canonical skill count = 15 and fix: `README.md:105`, `src/grace-install.ts:406`, `scripts/validate-marketplace.ts:83-88`, `.claude-plugin/marketplace.json:18-75`, `packages/dsh-skill-mygrace/package.json:3`, `packages/mygrace-dsh/package.json:3` + `README.md:3`, `CHANGELOG.md:9`, `templates/AGENTS.dsh.md.template:24-35`, `AGENTS.md:24-35`.
4. Make `scripts/validate-marketplace.ts` fail on count mismatch and extend `KNOWN_CLI_COMMANDS` (`:145`) to all 14 top-level commands (`doctor`, `test`, `packet`, `focus`, `context-cost`, `verify` are missing; `status` is already listed).
5. Fix the verification-command contract: either read `<module-checks>` from `docs/verification/V-M-XXX.xml` in `src/grace-test.ts:76` (matching `grace-verification/SKILL.md:39` and the V-M template) or move the element to `docs/modules/M-XXX.xml` in skill+template; add a test.

**P1 — self-contradictory methodology**
6. Archive: pick one rule. Minimal fix — document "archive = remove entry from `plan-index.xml` AND move file", make lint ignore `docs/archive/`, and update `grace-explainer/SKILL.md:39` ("stay in the index" is wrong).
7. Drift: make phase-status drift detectable (case-insensitive status match in `src/grace-lint.ts:77-91`), add `PATH`/`DEPENDS` checks or downgrade the claims in `grace-refresh/SKILL.md:22,30` and `grace-reviewer/SKILL.md:47-48`; make warnings configurable to fail.
8. Status: correct the "3 indexes only" claims (`README.md:118`, `AGENTS.md:14`, `PLAN.md:15`, `grace-status/SKILL.md:3,9,16-35`), and delete the source-scan steps from `grace-status` or stop calling it index-only.
9. Resolve scale vs caps: either raise/drop the ≤100/≤80 caps and document sharding, or lower the advertised scale from "20-200+ modules" to a number the caps permit (~90).
10. Align entity size contracts: fix `templates/phase/Phase-N.xml.template` (8 lines vs 50–200) and make `scripts/gen-example.ts` produce contract-compliant files; then regenerate `examples/demo-store` and re-measure. Until then, mark the 55% phase number as dependent on undersized files.
11. Fix the 96–97% claims in `rules/cursor/.cursorrules:62-64`, `rules/kilocode/.kilocoderules:68-70`, `rules/windsurf/.windsurfrules:46-47`, `rules/codex/CODEX.md:59-60`, `skills/mygrace/grace-explainer/SKILL.md:67-69`, `skills/mygrace/grace-status/SKILL.md:42-43`, `extensions/mygrace/QWEN.md:13` to the measured 89/83/55/0% with the project size stated.
12. Regenerate the root `AGENTS.md` from the current template (MCP 15, skills 15, Wave-E section) or replace this repo's `AGENTS.md` with `templates/AGENTS.dsh.md.template` verbatim.
13. Root `AGENTS.md`/template: add the 3 missing skills to the skills table (explainer, setup-subagents, token-budget); add `mygrace status` to README's CLI table.

**P2 — cleanup / credibility**
14. Delete or clearly label as legacy: the 7 unreferenced templates (`templates/knowledge-graph.xml.template`, `development-plan.xml.template`, `verification-plan.xml.template`, `QWEN.md.template`, `module/M-XXX.xml.template`, `phase/Phase-N.xml.template`, `verification/V-M-XXX.xml.template`), `docs/operational-packets.xml` creation + its template (or make `mygrace packet` use/emit it), `extensions/mygrace/` stale commands/hook (or rewrite for index detection), `openpackage.yml`, `.claude-plugin/marketplace.json` (or validate it and fix versions/counts/source dir).
15. `lefhook.yml` → `lefthook.yml`, and add `bun run src/grace.ts lint` for a real dogfooded project; or remove and document that there is no hook.
16. Fix `src/grace-module.ts:31` message, `src/grace.ts:6-15` comment, `scripts/gen-dsh-skill-mygrace.ts:6` "MyGRace".
17. `.gitignore`: add `.mygrace/`.
18. Translate `PLAN.md` to English and mark it historical (it claims "all phases done" with 2.5 unimplemented).
19. Reconcile CHANGELOG test counts (95 actual) and add the missing v1.0.0 heading or remove the version jump; fix duplicated `14 skills` descriptions in packages.
20. For `mygrace_test` MCP: honor the schema default (pass `--compact` unless `compact === false`).

---

# 9. Judgment for the lead

**Is the methodology genuinely sound or buzzword-driven?** Genuinely sound *in its core*: index-first navigation plus per-entity files is standard, effective context engineering, and this implementation proves the read layer works (89% status / 83% module reductions reproduced from the repo's own script; demo lint 0/0; 15 skills with valid DSH frontmatter). It is **not** buzzword-driven. However, as *specified and documented*, it is currently a set of aspirations with three critical enforcement holes (verification commands ignored, archive breaks lint, phase drift undetected), a scale claim its own line caps forbid, and a marketing layer (96–97%, "10 platforms", "verified live", "dogfooding") that the repository itself contradicts. The idea deserves a 6–7; the current specification/documentation deserves 4–5. Readers should treat the CLI/MCP surface and the measured README table as trustworthy, and treat every other number, count, and platform claim as unverified until fixed per §8.

---

# 10. Evidence log (reproducible)

All commands run from the repo root unless noted. `/tmp` scratch dirs were disposable; nothing under the repo was modified except this report.

```bash
# Surface inventory
bun run src/grace.ts <cmd> --help          # all 14 commands
grep -c ... src/grace-mcp.ts               # 15 ListTools entries; TOOL_NAMES 15
diff <(grep -o 'mygrace_[a-z_]*' README.md | sort -u) <(grep -o 'mygrace_[a-z_]*' src/grace-mcp-commands.ts | sort -u)
ls skills/mygrace | wc -l                  # 15
bun run scripts/validate-marketplace.ts    # "Version: 1.0.1 ✓ / Skills: 14 ✓"
# unique mygrace_* names per doc file: AGENTS.md 7, template 15, README 15, grace-cli 7,
#   grace-explainer 6, grace-setup-subagents 6, grace-ask 4, grace-status 4

# Skill format + size
python3 extract frontmatter                 # 15/15 valid name/description/whenToUse
wc -c skills/mygrace/*/SKILL.md             # 41,728 bytes total (~10.4k tok)
diff skills/mygrace/* → packages/dsh-skill-mygrace/assets/skills/*   # all SAME

# Behavior tests (temp projects under /tmp, one shell invocation each)
mygrace init-dsh --path . --name T
mygrace module show M-X --with-verification     # kebab alias accepted
mygrace install-dsh --dry-run                   # 15 "would copy" lines
mygrace verify / test / status / context-cost / lint / module|phase|verification index / doctor
mygrace packet M-API --path examples/demo-store # 38 lines
mygrace focus M-API --path examples/demo-store  # 4 lines
mygrace test --module M-A  (V-M has <module-checks>echo FROM_VM_FILE</…>)  # ignored → default bun test
mygrace test --module M-A  (module file has <module-checks>)             # FROM_MODULE_FILE executed

# Drift/archive experiments (temp project)
archive phase file (keep plan-index entry)      # lint ERROR: Orphaned index entry: Phase-1
phase status drift (file done / index pending)  # lint OK (0 warnings)  ← not detected
module status drift                             # lint warning (exit 0)  ← detected, non-blocking
wrong PATH in index                             # lint OK               ← not checked

# Repo self-check
bun run src/grace.ts lint                       # exit 1: MyGRACE project not found (no docs/)
bun test test/                                  # 95 pass, 10 files
bun test                                        # 179 pass incl. examples/demo-store (94 files)
bun run scripts/measure-context.ts --project examples/demo-store
  # 363/39 89% · 173/30 83% · 31/14 55% · 159/159 0%
wc -l examples/demo-store/docs/modules/*.xml    # 12–13 lines each (contract: 30–80)
wc -l examples/demo-store/docs/plans/*.xml      # 4–6 lines (contract: 50–200)
wc -l examples/demo-store/docs/verification/*.xml # 11–12 (contract: 20–60)
wc -l templates/phase/Phase-N.xml.template      # 8 (contract: 50–200)

# Packaging simulation
copy package.json "files" entries only to /tmp/pkgsim; symlink node_modules
bun run src/grace.ts lint --path .   # error: Cannot find module './grace-doctor'
# npm pack of the package (44 KB): contains only 10 package/src/*.ts; 5 imported modules absent
curl registry.npmjs.org/<pkg>        # 404 for all 5 @osovv/mygrace* names; search total 0

# External conventions (untrusted web, used only for Aider/Codex/lefthook facts)
# lefthook config filenames: lefthook.yml / .lefthook.yml / .config/lefthook.yml (+yaml/toml/json)
#   https://github.com/evilmartians/lefthook/blob/d97b10bd6e6d557fd9880914f2afeedcb999832a/docs/mdbook/configuration/README.md
# aider conventions: load via /read CONVENTIONS.md or `read:` in .aider.conf.yml
#   https://aider.chat/docs/usage/conventions.html
```

**Caveats on my own analysis:** (1) two external-tool claims (`rtk`, `caveman`, panel hot-apply) are unfalsifiable here because those tools/the panel are not installed — I marked them ⚠️, not ❌; (2) the npm 404 check reflects the registry state at audit time (2026-11-22T00:53Z) and could change if packages are published later; (3) the measured savings are the repo's own numbers, not an independent re-derivation of classic GRACE — I verified reproducibility of the script and its arithmetic, plus its baseline definition (`scripts/measure-context.ts:51-69`).
