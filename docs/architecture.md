# MyGRACE architecture

This page describes **how the repository is built today**: the module graph, the
data flow through the CLI and MCP server, and where each invariant is enforced.
Decisions and their rationale live in [`ROADMAP.md`](../ROADMAP.md) §4 (ADR-1 …
ADR-8); the change workflow lives in [`CONTRIBUTING.md`](../CONTRIBUTING.md); the
trust boundary lives in [`SECURITY.md`](../SECURITY.md).

> **Snapshot:** v1.3.0 source tree after Waves 0–5 (audit → foundation → safety →
> dogfooding → scale → release engineering): strict XML layer, typed errors/exit
> codes, safe ids/paths, project config, lint teeth (including incremental
> `--changed`), trust-gated command execution, hardened MCP runtime, installer
> hardening, validators/CI, sharded indexes (ADR-6), multi-language path
> (Python/Go fixtures + `language-matrix` CI job), traceability/impact/next-step
> query surface and monorepo discovery. **The repository governs itself:**
> `mygrace ci --path .` passes on `docs/` (25 modules, 4 phases, 25 verifications,
> 32 declared test files, lint 0/0) and the suite is 639 tests across 31 files.
> Since v1.3 the opt-in DSH status panel is **LIVE** (real data over
> `GET /api/mygrace.status`), and publishing is tag-driven via
> `.github/workflows/release.yml` (package publish-ready, not published yet). The
> CLI exposes 20 top-level commands (including `trace`, `impact`, `next`,
> `projects`); the MCP server exposes 21 tools. The enforcement table in §6 states
> the current truth for every invariant — update it whenever a wave lands.

## 1. Layering

```
mygrace (bin) ──► src/grace.ts          citty command tree (20 commands) + guard() error boundary
                     │
        ┌────────────┴─────────────┬───────────────────────┐
        ▼                          ▼                       ▼
   command modules           MCP surface              installer / init
   grace-lint.ts             grace-mcp.ts             grace-install.ts
   grace-module.ts           grace-mcp-commands.ts    grace-init.ts
   grace-file.ts
   grace-status.ts
   grace-doctor.ts
   grace-test.ts
   grace-verify.ts
   grace-packet.ts
   grace-context.ts
   grace-ci.ts
   grace-trace.ts
   grace-impact.ts
   grace-next.ts
   grace-projects.ts
        │
        ▼
   shared layer: grace-common.ts   (root discovery, index reads, file walking)
        │
        ▼
   foundation: grace-errors.ts · grace-xml.ts · grace-paths.ts · grace-config.ts
```

Dependency rules:

1. Imports point **downwards** only. Foundation modules (`grace-errors`,
   `grace-xml`, `grace-paths`, `grace-config`) import no command modules and no
   filesystem state beyond their own scope.
2. `grace-common.ts` is the filesystem layer commands use for reading project
   files; it delegates XML to `grace-xml.ts`.
3. `grace-mcp-commands.ts` never imports the MCP SDK — it is a pure
   catalog + argv-mapping module so every tool and mapping is unit-testable. The
   MCP server reaches command logic by spawning the CLI, not by importing command
   modules.
4. `grace-install.ts` and `grace-init.ts` are side-effectful boundary modules
   (they write outside `docs/`); keep their I/O isolated from read paths.

## 2. Module reference

| Module | Responsibility | Depends on |
|---|---|---|
| `src/grace.ts` | CLI entry: citty `defineCommand` tree (ci, lint, module, phase, verification, file, status, install-dsh, init-dsh, doctor, test, trust, verify, packet, focus, context-cost), `guard()` wrapper that turns a thrown `MyGraceError` into one readable line plus the documented exit code, `runMain()`. | all command modules, `grace-errors` |
| `src/grace-errors.ts` | Exit-code constants (`0/1/2/3`), `Finding` + `finding()`, typed errors (`UsageError`, `ConfigError`, `ProjectNotFoundError`, `XmlError`, `TrustError`), `exitCodeForFindings()`, JSON envelope (`createEnvelope`), `printJson()`, `handleCliError()`. Pure formatting; no filesystem. | none (leaf) |
| `src/grace-xml.ts` | Strict XML layer: well-formedness validation with line/column, element tree, structural index/entity parsing (`M-*`, `V-M-*`, `Phase-N`), accessors (`findElements`, `childElements`, `textOf`, `attr`, `elementAtPath`), serialization helpers. Malformed XML is an `XmlError`, never a silent empty result. | `grace-errors`, `fast-xml-parser` |
| `src/grace-paths.ts` | Id grammars (`M-…`, `V-M-…`, `Phase-N`), `assertEntityId`, `entityDir`/`entityPath`, `assertSafeRelativePath`, `resolveWithin`/`isWithin` containment. | `grace-errors`, `node:path` |
| `src/grace-config.ts` | Optional `mygrace.config.json`: `sourceDirs`, `markupExts`, `ignoreDirs`, `indexCaps`, `sizeBudgets`, `testRunner`, `allowCommands`, `language`; validated with every problem reported at once; defaults reproduce the v1 layout. | `grace-errors`, `node:fs` |
| `src/grace-common.ts` | Project-root discovery (`docs/graph-index.xml` marker), index reads (`readIndexFile`, `readIndexFileSafe`), deterministic file walk (`walkFiles`, ignores configured dirs, no symlink following), table formatting, line counting. | `grace-errors`, `grace-xml` |
| `src/grace-shard.ts` | Sharded module indexes (ADR-6): `<Shard href count/>` root references and `<ModuleShard project group count>` files; `resolveShardPath()` containment, `loadGraphIndex()`/`loadGraphIndexStrict()` union readers with coded findings, deterministic `buildShardPlan()`/`applyShardPlan()` (atomic writes, timestamped backups, idempotent). Deliberately imports no `grace-common` (no cycle). | `grace-errors`, `grace-xml`, `grace-paths` (config type only) |
| `src/grace-lint.ts` | Quality gate: structural XML validation for every `docs/*.xml`, index ↔ entity drift for all documented fields, duplicate entries, index caps and entity size budgets from config, markup checks over configured source dirs, incremental `--changed` scope, verification-ref integrity, and the shard layer (`SHARD_FILE_MISSING`, `SHARD_ROOT_INVALID`, `SHARD_COUNT_MISMATCH`, `PATH_UNSAFE`, `DUPLICATE_INDEX_ENTRY`, `INDEX_TOO_LARGE` per shard). `--strict` promotes warnings; `--format json` emits the envelope. Exports `collectLintIssues()` (used by `doctor`/`status`). | `grace-common`, `grace-xml`, `grace-config`, `grace-errors`, `grace-paths` |
| `src/grace-module.ts` | `module {index,find,show,list,shard}`, `phase {index,show}` and `verification index` read commands; `module index` prints a shard summary; reads are shard-transparent except `module show` (direct entity read); `module shard` delegates to `grace-shard.ts`; ids validated through `grace-paths`. | `grace-common`, `grace-shard`, `grace-paths` |
| `src/grace-file.ts` | `file show`: file-local `MODULE_CONTRACT`, `MODULE_MAP`, `CHANGE_SUMMARY`, function contracts and semantic blocks. | own file parsing |
| `src/grace-status.ts` | Aggregated health: counts per status/priority from the three indexes plus lint error/warning totals; config-aware; text and JSON envelope. | `grace-common`, `grace-lint`, `grace-config` |
| `src/grace-doctor.ts` | Environment/integration health: project lint summary, effective config (`sourceDirs`, `language`, `allowCommands`), DSH, rtk, caveman, `mygrace-*` skills, MCP row, status panel, dev tools; JSON envelope, exit 1 on errors. | `grace-common`, `grace-lint`, `grace-install` (skill list), `grace-config` |
| `src/grace-ci.ts` | Quality gate: runs strict lint + project status + verification coverage in one invocation, optionally the trust-gated scoped tests; exports `runCiGate()`/`collectCoverage()`; text digest or ADR-8 JSON envelope (contract: `docs/modules/M-CI.xml`). | `grace-lint`, `grace-status`, `grace-test`, `grace-verify` (failure report), `grace-config`, `grace-common`, `grace-errors` |
| `src/grace-trace.ts` | `trace`: read-only proof chain for one module/verification — entity file, verification, declared test files (existence/lines), command provenance (verification → module-deprecated → config → default, `requiresShellOptIn`), requirement links, phases, direct + transitive dependents; stable gaps (`MISSING_VERIFICATION_REF`, `VERIFICATION_FILE_MISSING`, `TEST_FILE_MISSING`, `MODULE_PATH_MISSING` are errors, optional links are info). Envelope or human tree (contract: `docs/modules/M-TRACE.xml`). | `grace-common`, `grace-config`, `grace-errors`, `grace-paths`, `grace-shard`, `grace-test`, `grace-xml` |
| `src/grace-impact.ts` | `impact`: changed files (`--files` → `--staged` → `--since` → `git diff HEAD`) → direct modules (exact PATH / module-dir prefix / docs entity) → transitive reverse-`DEPENDS` closure → verification/test blast radius → affected phases → suggested commands; git is argv-only with a 2 s timeout and degrades gracefully (contract: `docs/modules/M-IMPACT.xml`). | `grace-common`, `grace-config`, `grace-errors`, `grace-paths`, `grace-shard`, `grace-test` |
| `src/grace-next.ts` | `next`: deterministic nine-code advice ladder (`INIT_PROJECT`, `FIX_INDEX`, `FIX_LINT_ERRORS`, `ADD_VERIFICATION_COVERAGE`, `TRUST_COMMANDS`, `VERIFY_MODULE`, `REFRESH_WARNINGS`, `NEXT_PHASE`, `NOTHING_TO_DO`) over the same collectors as `ci`; read-only, exit 0 for any advice (contract: `docs/modules/M-NEXT.xml`). | `grace-common`, `grace-config`, `grace-errors`, `grace-ci`, `grace-lint`, `grace-shard`, `grace-test` |
| `src/grace-projects.ts` | `projects`: bounded BFS discovery by `docs/graph-index.xml` (depth 4, 2000-dir cap, `truncated`), per-project counts/lint/coverage/status via the same collectors, totals; exit 0 clean / 1 findings / `--strict` promotes warnings (contract: `docs/modules/M-PROJECTS.xml`). | `grace-common`, `grace-config`, `grace-errors`, `grace-status`, `grace-lint`, `grace-ci`, `grace-shard` |
| `src/grace-test.ts` | Execution contract: canonical `<module-checks>` (verification file, module fallback), `<test-files>`, trust model (`.mygrace/trust.json`), `authorizeCommands()`, quote-aware argv tokenizer, shell-metacharacter policy, plan/execute API, `mygrace test` and `mygrace trust`, shared `runCommandOutcome()` output/exit-code helper. | `grace-common`, `grace-xml`, `grace-paths`, `grace-config`, `grace-errors`, `node:child_process` |
| `src/grace-verify.ts` | Agent-loop verification: runs planned module checks under the same authorization as `test`, compact digest, `.mygrace/last-failures.md` only on failure, text/JSON envelopes. | `grace-test`, `grace-common`, `grace-config`, `grace-errors` |
| `src/grace-packet.ts` | `packet` (self-contained worker prompt: contract + verification + deps) and `focus` (minimal working set); ids validated, JSON envelope. | `grace-common`, `grace-paths` |
| `src/grace-context.ts` | `context-cost`: per-operation line/byte/token-estimate budget from the real project files (same line/byte model as `scripts/measure-context.ts`); config-aware; JSON envelope. | `grace-common`, `grace-config` |
| `src/grace-init.ts` | `init-dsh`: creates `docs/{modules,plans,verification,archive}`, writes scaffold files from `templates/` (`graph-index`, `plan-index`, `verification-index`, `operational-packets`, `requirements`, `technology`, `AGENTS.md`) and the default `mygrace.config.json`. Refuses to overwrite without `--force`. | `grace-config`, `node:fs`, `templates/` |
| `src/grace-install.ts` | `install-dsh`: copies `skills/mygrace/grace-*` → `$DSH_HOME/skills/mygrace-*`, inserts the `mcp-mygrace` row into the profile's `cordis.patch.yml` (launcher = `process.execPath` + absolute `grace-mcp.ts`), and, with `--panel`, installs the **LIVE** status-panel host route + browser card (private package; reads `mygrace status --format json` through the launcher). YAML is parsed and validated before/after each edit, writes are atomic, backups are timestamped, failed components exit non-zero. Flags: `--bundle`, `--source`, `--dryRun`, `--uninstall`, `--profile`, `--panel`, `--dshHome`. | `grace-errors`, `yaml`, `node:fs`, `node:child_process` |
| `src/grace-mcp.ts` | stdio MCP server (`@modelcontextprotocol/sdk`), 21 tools: derives `ListTools` from the catalog, validates arguments, launches the CLI without a `PATH` dependency (`MYGRACE_BIN` → package-local `src/grace.ts` via `process.execPath` → `mygrace` on `PATH`), preserves stdout/stderr on failure, configurable timeout (`MYGRACE_MCP_TIMEOUT_MS`, default 120 s). | `grace-mcp-commands`, MCP SDK |
| `src/grace-mcp-commands.ts` | Single source of truth for MCP tools: `TOOLS` (`name`, `description`, `inputSchema`, `rootArg`, `buildArgs`, optional `digestOutput`), `TOOL_NAMES`, `buildToolCommand()`, `validateToolArgs()`. No SDK imports. | `grace-errors` only (pure) |

## 3. Data flow

### 3.1 CLI read path (lint, ci, module, phase, verification, status, packet, focus, context-cost, doctor)

```
--path / cwd
   │
   ▼
findProjectRoot()            walk up until docs/graph-index.xml
   │                         (typed ProjectNotFoundError, exit 2)
   ▼
loadConfig()                 optional mygrace.config.json + defaults
   │                         (invalid config → ConfigError listing every issue)
   ▼
read docs/*.xml + sources    readIndexFile / readIndexFileSafe / walkFiles
   │
   ▼
parse via grace-xml.ts       well-formedness + element tree
   │                         malformed → XmlError (line/column, exit 1)
   ▼
command logic                entries + entities → data and findings (stable codes)
   │
   ▼
grace-errors.ts              exit code: 0 ok · 1 findings · 2 usage/config · 3 internal
   │                         --strict promotes warnings (ADR-3)
   ▼
output                       text (human) or JSON envelope
                             { ok, exitCode, data, findings[], meta }   (ADR-8)
```

`guard()` in `src/grace.ts` wraps every command (and nested subcommand), so an
uncaught typed error becomes a single `mygrace: CODE: message` line with a hint
and the correct exit code — no stack traces unless `MYGRACE_DEBUG=1`.

Index reads are shard-aware: `readIndexFileSafe` → `grace-shard.loadGraphIndex()`
returns the union of flat `<M-…/>` entries plus every `<Shard>` file's entries.
`module show` is the deliberate exception — it reads `docs/modules/M-XXX.xml`
directly, so a sharded index never hides the entity contract.

### 3.2 Executed-command path (`test`, `verify`; ADR-1)

```
docs/verification/V-M-XXX.xml            canonical <module-checks> + <test-files>
docs/modules/M-XXX.xml                   deprecated fallback for <module-checks>
mygrace.config.json                      testRunner fallback + allowCommands
   │
   ▼
planModuleTest()             ids validated (grace-paths), XML parsed structurally,
   │                         <test-files> entries validated (no "-", no "..", no NUL,
   │                         no shell metacharacters), command tokenized quote-aware
   ▼
authorizeCommands()          precedence: --allow-commands flag > config.allowCommands
   │                         > current trust record (.mygrace/trust.json, sha256 of
   │                         docs/modules/**/*.xml, docs/verification/**/*.xml and
   │                         mygrace.config.json); shell-style commands additionally
   │                         need the explicit opt-in
   ▼
refused → TrustError         prints "Commands that WOULD run (not executed)", exit 2,
                             nothing is spawned
   │
   ▼
spawnSync(file, argv, { shell: false, cwd: projectRoot, timeout: 10 min })
   │
   ▼
compact digest               failures → .mygrace/last-failures.md; exit 1
```

Trust records are written by `mygrace trust`: it first prints every declared
command for review, then writes the record atomically (`0600`) and warns when
`.mygrace/` is not covered by `.gitignore`. Editing any command source makes the
record stale and the next run refuses again. `.mygrace/` is local state and must
never be committed — see [`SECURITY.md`](../SECURITY.md).

### 3.3 MCP path

```
MCP host (e.g. DSH) ──stdio──► grace-mcp.ts
                                 ├─ ListTools: derived from TOOLS in grace-mcp-commands
                                 └─ CallTool(name, args)
                                       │
                                       ▼
                                 validateToolArgs(name, args)
                                       │  required/type/enum/pattern/defaults checked
                                       ▼
                                 buildArgs(args, root) → argv
                                       │
                                       ▼
                                 spawn CLI (MYGRACE_BIN → process.execPath + src/grace.ts → PATH)
                                       │
                                       ▼
                                 text content back to the host; isError on failure
```

The MCP server is a **transport adapter**, not a second implementation: every
tool maps to a CLI command, so text-mode and MCP behaviour cannot diverge.
`path` is optional in the schemas; the project root resolves in the order
explicit argument → `MYGRACE_PROJECT_ROOT` → the process working directory.

### 3.4 Install / bootstrap path (side effects)

- `init-dsh`: reads `templates/`, substitutes project variables, creates
  `docs/{modules,plans,verification,archive}` (with `.gitkeep`), writes the
  scaffold files listed in §2 plus `mygrace.config.json` with the effective
  defaults. Safe: skips existing files, `--force` to overwrite.
- `install-dsh`: writes only under `$DSH_HOME` (or `--dshHome`), parses and
  validates `cordis.patch.yml` with the `yaml` package before and after each
  edit, performs atomic writes, keeps timestamped backups, is idempotent, and
  supports `--dryRun` (no writes) and `--uninstall`.

### 3.5 Query paths (`trace`, `impact`, `next`, `projects`)

All four are read-only and never execute project commands:

```
docs/ (shard union) ─► trace: entity → verification → test files → command → requirements → phases → dependents
                    ─► impact: git/--files → modules → transitive dependents → blast radius → phases → suggested commands
                    ─► next: config + indexes + lint + coverage + trust + plan-index → one fixed-ladder action
                    ─► projects: bounded BFS for docs/graph-index.xml → per-project status/lint/coverage → totals
```

- `trace` errors mean a broken chain (`MISSING_VERIFICATION_REF`,
  `VERIFICATION_FILE_MISSING`, `TEST_FILE_MISSING`, `MODULE_PATH_MISSING`); optional
  gaps (`NO_DECLARED_COMMAND`, `NO_REQUIREMENT_LINK`, `NO_PHASE_LINK`) are info and
  keep exit 0. Module lookups are shard-transparent; `module show` stays direct.
- `impact` never guesses: no changed-file source is a usage error (exit 2), and
  files that map to nothing produce a `NO_MODULES_AFFECTED` info finding.
- `next` is deterministic (fixed ladder, sorted ids, no heuristics/model calls) and
  never fails a build (exit 0; usage/config exit 2).
- `projects` scans with a hard directory cap and reports `truncated` instead of
  hanging; it reuses the status/lint/coverage collectors, not duplicate logic.

### 3.6 LIVE status panel data path

```
browser card (packages/mygrace-status-panel/lib/client.js)
  fetch("api/mygrace.status") on mount + every 30 s + visibilitychange
        │
        ▼
host plugin (lib/index.js)  GET /api/mygrace.status  (ctx.connection.fetch.register,
        │                    disposed with the plugin, cache-control: no-store)
        ▼
buildStatusPayload()  root: validated ?path= → MYGRACE_PROJECT_ROOT → cwd walk-up
        │             CLI: MYGRACE_BIN → $DSH_HOME/mygrace/bin/mygrace
        ▼
spawn "status --path <root> --format json"  (5 s timeout, never throws)
        │
        ▼
{ ok, project, modules, phases, verifications, lint, trust: {authorized, via},
  generatedAt, durationMs, error? }   →  failure: { ok:false, error }
```

The panel is opt-in (`install-dsh --panel`), private/unpublished and read-only.
Route registration/disposal, payload building and profile composition are tested
against the real DSH 0.2.1-rc.2 loader (`test/grace-panel.test.ts`); a live
`dsh web` browser session is not exercised in CI — a documented limit.

### 3.7 Release pipeline

```
push tag v*  (or workflow_dispatch dry_run=true)
   │
   ▼
release.yml — ubuntu-latest
   ├─ tag version == package.json version        (refuse otherwise)
   ├─ bun install --frozen-lockfile
   ├─ bun run release:check                      (typecheck, tests, demo lint, self-ci, truth validators, pack-smoke)
   ├─ bun run publish:dry                        (pack → import completeness → offline install → packaged CLI smoke)
   └─ npm publish --provenance --access public   (trusted publishing/OIDC; NPM_TOKEN fallback)
```

CI additionally runs the same gates on an Ubuntu/Windows/macOS matrix. Local
publication is impossible (no credentials) and `publish:dry` is the artifact
gate; the package is publish-ready but not published yet.

## 4. Project configuration

`mygrace.config.json` is optional; `init-dsh` writes it so the layout is visible
and editable. Unknown keys are rejected (every problem is listed at once), and
the defaults reproduce the v1 layout.

| Key | Default | Used by |
|---|---|---|
| `sourceDirs` | `["src", "lib", "apps", "packages"]` | lint markup scan, doctor, migration paths |
| `markupExts` | `.ts .js .mjs .cjs .tsx .jsx .py .go .java .rs .rb` | lint markup scan |
| `ignoreDirs` | `node_modules .git .hg .svn dist build out target vendor coverage .next .nuxt .venv venv __pycache__ .mypy_cache .pytest_cache .idea .vscode` | every file walk |
| `indexCaps` | graph `100`, plan `50`, verification `80` | lint (errors above cap) |
| `sizeBudgets` | module `[30, 80]`, phase `[50, 200]`, verification `[20, 60]` | lint (warnings outside range) |
| `testRunner` | `"bun test"` | `test`/`verify` when no `<module-checks>` is declared |
| `allowCommands` | `false` | trust model: project-wide command opt-in |
| `language` | `"typescript"` | generated docs and diagnostics |

`mygrace.config.json` is hashed into the trust record: changing `testRunner` or
`allowCommands` invalidates a previously trusted checkout.

Semantics: a list you set **replaces** the default entirely (`sourceDirs`,
`markupExts`, `ignoreDirs` are not additive); `markupExts` also selects the
comment dialect understood by markup checks (`//`, `#`, `--`, `/*`, `<!--`);
`testRunner` is only the fallback when a module has no canonical
`<module-checks>`; `language` is a label for generated docs/diagnostics, not a
parser switch.

## 5. Architecture decisions (ADR summary)

Full text: [`ROADMAP.md`](../ROADMAP.md) §4.

| ADR | Decision | Where it lives in code |
|---|---|---|
| ADR-1 | Project-declared commands execute only behind a trust record (`.mygrace/trust.json`) or an explicit opt-in; one canonical command source; refusals print the command instead of running it. | `grace-test.ts` (`planModuleTest`, `authorizeCommands`, `checkTrust`, `trustCommand`), `grace-verify.ts`, `grace-errors.ts` (`TrustError`), `.gitignore` (`.mygrace/`) |
| ADR-2 | XML is a serialization, not a language: real parser, structural access, malformed XML is a finding, no regex scraping. | `grace-xml.ts`, consumed by `grace-common.ts`, `grace-lint.ts`, `grace-test.ts` |
| ADR-3 | One exit-code contract: `0` ok, `1` findings, `2` usage/config, `3` internal; `--strict` promotes warnings; same codes in text and JSON. | `grace-errors.ts` (`EXIT`, `exitCodeForFindings`), `grace-test.ts` (`runCommandOutcome`), `grace.ts` (`guard()`) |
| ADR-4 | Ids and paths are untrusted: grammar-check every entity id, resolve entity paths strictly inside `docs/{modules,plans,verification}`, reject `..`/absolute/NUL. | `grace-paths.ts` (`assertEntityId`, `entityPath`, `resolveWithin`), used by lint/module/test/verify/packet |
| ADR-5 | Project configuration replaces hardcoded layout: `mygrace.config.json` with safe v1-compatible defaults. | `grace-config.ts` (`loadConfig`, `DEFAULT_CONFIG`), written by `grace-init.ts`, consumed by lint/status/doctor/context/test/verify |
| ADR-6 | Scale via sharded indexes: the root index keeps `<Shard href count/>` references, shard files start with `<ModuleShard project group count>`, reads are the union of flat + shard entries, and generation is deterministic, atomic and idempotent. | `grace-shard.ts` (format, union readers, `buildShardPlan`/`applyShardPlan`), `grace-module.ts` (`module shard`, `module index` summary), `grace-lint.ts` (shard findings) |
| ADR-7 | One npm package with all runtime sources; `pack` + pack-smoke gate releases; Bun-first, Node ≥ 22.6 target. | `package.json` (`files`, `pack:smoke`, `ci`), `scripts/pack-smoke.ts`, `grace-mcp.ts` launcher |
| ADR-8 | Agent-first output: `--format json` envelope, stable finding codes, documented MCP names with host prefix (`mcp__mygrace__<tool>`). | `grace-errors.ts` (`createEnvelope`), `grace-test.ts` (`runCommandOutcome`), `grace-mcp-commands.ts` (catalog + schemas) |

## 6. Invariants and where they are enforced

The tool's credibility depends on this table being true.

| Invariant | Contract | Enforced today by | State |
|---|---|---|---|
| Project XML is well-formed | Malformed XML is a finding (`XML_INVALID`) with line/column, never a silent empty index | `grace-xml.ts` (`validateXml`/`parseXml`) through every reader; `grace-lint.ts` validates every `docs/*.xml` | **enforced** |
| Exit codes are stable | `0/1/2/3` everywhere; identical in text and JSON; `--strict` promotes warnings | `grace-errors.ts`, `runCommandOutcome()`; `guard()` in `grace.ts` | **enforced** for all migrated commands (lint, ci, test, trust, verify, packet, doctor, status, context-cost) |
| Findings are machine-readable | Stable `code`, `severity`, `file`/`line`, actionable `hint` | `grace-errors.ts` (`Finding`, `finding()`), `grace-lint.ts` detectors | **enforced** |
| JSON output is one envelope | `{ ok, exitCode, data, findings[], meta }` for every `--format json` | `grace-errors.ts` (`createEnvelope`), command modules | **enforced** for the migrated commands; MCP returns text content by design |
| Entity ids are validated | Only `M-…`, `V-M-…`, `Phase-N`; empty/absolute/leading-dash/`..` rejected with a hint | `grace-paths.ts` (`assertEntityId`), wired in lint/module/test/verify/packet and MCP `pattern` | **enforced** on the execution and query paths |
| Paths stay inside the project | Entity paths resolved under `docs/{modules,plans,verification}`; test-file entries cannot escape or start with `-` | `grace-paths.ts` (`entityPath`, `resolveWithin`, `assertSafeRelativePath`), `grace-test.ts` | **enforced** for entity and test paths |
| Project commands require trust | No project-declared command executes without trust record, `--allow-commands` or `config.allowCommands` (ADR-1) | `grace-test.ts` (`authorizeCommands`, `checkTrust`), `grace-verify.ts` | **enforced** |
| No shell interpolation | Commands run argv-only; shell-style commands additionally need explicit opt-in | `grace-test.ts` (`tokenizeCommand`, `inspectCheckCommand`, `spawnSync(..., { shell: false })`) | **enforced** |
| Layout and budgets are configurable | No hardcoded `src/` in new code; caps/budgets/runner from config | `grace-config.ts`; lint caps/budgets detectors; doctor/status/context/test/verify | **enforced** |
| Index caps and size budgets are enforced | Index line caps = errors (per shard: `indexCaps.graph`), entity size ranges = warnings, both from config | `grace-lint.ts` (`lintIndexCaps`, `lintEntityBudgets`), `grace-shard.ts` | **enforced** |
| Sharded indexes stay valid and transparent | Root references resolve inside `docs/`, declared counts match actual entries, ids are unique across shards, every shard respects the cap; `list`/`find`/`status`/`ci`/`test`/`verify` read the same union; `module show` reads the entity directly | `grace-shard.ts` (`loadGraphIndex*`, `resolveShardPath`), `grace-lint.ts`, `grace-module.ts`; scale test `test/grace-shard.test.ts` (150 modules / 3 shards) | **enforced** (unit + synthetic-scale test; repo flat 25 modules 0/0) |
| Any configured language works | Layout, extensions, ignores and fallback runner come from config; a non-TS module `PATH` resolves; Python `#` / Go `//` dialects are understood | `grace-config.ts`, `grace-lint.ts`, `grace-status.ts`, `grace-ci.ts`, `grace-test.ts`; `test/grace-language.test.ts` + CI `language-matrix` job | **enforced** (Python/Go fixtures) |
| MCP catalog cannot drift | One catalog for names, schemas and mappings; arguments validated | `grace-mcp-commands.ts` (`TOOLS`, `TOOL_NAMES`, `validateToolArgs`), `grace-mcp.ts` | **enforced**: 21 tools, including `mygrace_trust`, `mygrace_ci`, `mygrace_trace`, `mygrace_impact`, `mygrace_next`, `mygrace_projects` |
| Traceability is queryable | `mygrace trace <ID>` returns the chain module/verification → tests → command provenance → requirements → phases → dependents, with stable codes: chain breaks are errors (exit 1), optional links are info (exit 0) | `grace-trace.ts` (`traceModule`, `TRACE_FINDING_CODES`, `formatTraceText`); `test/grace-trace.test.ts` | **enforced** (tested gap matrix on a fixture project) |
| Change impact is computed, not guessed | `mygrace impact` maps changed files to modules/dependents/blast radius; no file source is a usage error, unmapped files are an info finding | `grace-impact.ts` (`resolveChangedFiles`, `computeImpact`); `test/grace-impact.test.ts` | **enforced** (explicit files without git + staged/since paths) |
| Advice is deterministic | `mygrace next` follows a fixed nine-code ladder over live gates; same tree → same action; any advice exits 0 | `grace-next.ts` (`recommendNext`, `NextActionCode`); `test/grace-next.test.ts` | **enforced** (all nine codes + ordering tests) |
| Monorepo discovery is bounded | `mygrace projects` scans with depth/cap limits, reports `truncated`, and reuses status/lint/coverage collectors | `grace-projects.ts` (`discoverProjects`, `summarizeProject`, `aggregateProjects`); `test/grace-projects.test.ts` | **enforced** |
| Incremental scope is honest | `lint --changed` classifies changed files (index → full index checks, entity → that entity, source → markup only) and reports scanned/skipped counts | `grace-lint.ts` (changed-scope path); `test/grace-lint-strict.test.ts` scope tests | **enforced** |
| The LIVE panel reads real data | The host route shells out to `mygrace status --format json` (never parses `docs/` itself), has a 5 s timeout, sets `cache-control: no-store`, and degrades to `{ok:false,error}`/“not connected” instead of throwing | `packages/mygrace-status-panel/lib/index.js`, `status-payload.js`, `client.js`; `test/grace-panel.test.ts` | **enforced** (route/payload/install tests against the real DSH loader; live GUI session is a documented gap) |
| One-command gate agrees with the individual checks | `mygrace ci` runs the same strict-lint/status/coverage logic (and the same trust-gated test runner) and must return the same verdict as the individual commands | `grace-ci.ts` (`runCiGate`, `collectCoverage`), composed from `grace-lint.ts`, `grace-status.ts`, `grace-test.ts`/`grace-verify.ts` | **enforced** (unit-tested gate + self-check on this repo: `mygrace ci --path .` PASS) |
| The packaged CLI works | Every runtime file is in the tarball and the packaged CLI starts | `scripts/pack-smoke.ts` via `bun run pack:smoke` (`ci`, `release:check`) | **enforced** |
| Documented surface matches the code | Counts, commands, flags and MCP names checked against source in CI | `scripts/validate-docs.ts`, `scripts/validate-marketplace.ts`, `.github/workflows/ci.yml` | **enforced** by CI — both validators pass; counted claims come from source (20 commands, 21 MCP tools, 15 skills) |

## 7. Where to change things

- **New CLI command / MCP tool:** [`CONTRIBUTING.md`](../CONTRIBUTING.md) §"How to
  add a CLI command" / §"How to add an MCP tool".
- **A new invariant or drift class:** add it to `grace-lint.ts` (or the owning
  command) with a stable finding code, a negative test, a row in §6, and surface
  it through `grace-ci.ts` so the one-command gate reports it too.
- **Trace/impact/next/projects logic:** `src/grace-trace.ts`, `src/grace-impact.ts`,
  `src/grace-next.ts`, `src/grace-projects.ts` — keep them read-only, reuse the
  shared collectors (no duplicated lint/status logic), and add a row to §6 when a
  new invariant appears.
- **LIVE panel:** `packages/mygrace-status-panel` is private and opt-in; the host
  route must stay a thin adapter over `mygrace status --format json`, never a
  second parser of `docs/`.
- **Release pipeline:** `.github/workflows/release.yml` + `scripts/publish-dry-run.ts`;
  version/tag consistency is enforced before publish, and publishing stays
  CI-only (see `CONTRIBUTING.md` §"Releasing").
- **Shard format or generator:** `src/grace-shard.ts` is the single implementation
  (format constants, union readers, plan/apply); commands and lint must import it
  instead of re-parsing shards, and the generator must stay deterministic and
  idempotent.
- **Project layout, budgets, runtimes:** `src/grace-config.ts` — never hardcode a
  new directory name in a command.
- **Security boundary:** read [`SECURITY.md`](../SECURITY.md) before touching
  command execution, trust records, path resolution or MCP argument handling.

## 8. Related documents

- [`ROADMAP.md`](../ROADMAP.md) — vision, ADRs, waves, release gates (§6).
- [`CONTRIBUTING.md`](../CONTRIBUTING.md) — dev setup, conventions, commit rules.
- [`SECURITY.md`](../SECURITY.md) — threat model, trust record, reporting.
- [`CHANGELOG.md`](../CHANGELOG.md) — released and unreleased changes.
