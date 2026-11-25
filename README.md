# MyGRACE — index-first engineering harness for AI coding agents

**MyGRACE gives a coding agent a small, enforced map of a repository**: three
line-capped XML indexes, one contract file per module, and verification files
that connect intent → modules → tests. Agents read the index first and only the
entity they need, instead of re-reading the tree.

**Start here:** [`docs/quickstart.md`](docs/quickstart.md) — the two commands you need
and a five-minute path. Upgrading from v1.x? See
[`docs/migrations/v2.0.md`](docs/migrations/v2.0.md). Full reference is below.

It is a CLI (`mygrace`, 15 commands) plus an agent methodology (12 skills) and
an MCP server (21 tools). It does not generate code, call a model, or send telemetry — it
enforces traceability and context discipline for the agent you already use.

Current version: `3.2.2`

> Distribution is **GitHub Releases + source**: there is no npm publication
> (decision 2026-11-25). `@osovv` is a third-party scope (the project's starting
> point); this repository is not affiliated with it and never publishes there. The v2 hardening waves are tracked
> in [`ROADMAP.md`](ROADMAP.md).

## The model: indexes + per-entity files

| Classic GRACE artifact | MyGRACE replacement | Size budget (configurable) |
|---|---|---|
| monolithic `knowledge-graph.xml` | `docs/graph-index.xml` + one `docs/modules/M-XXX.xml` per module | index 100 lines; module 30–80 |
| monolithic `development-plan.xml` | `docs/plan-index.xml` + one `docs/plans/Phase-N.xml` per phase | index 50; phase 50–200 |
| monolithic `verification-plan.xml` | `docs/verification-index.xml` + one `docs/verification/V-M-XXX.xml` per module | index 80; verification 20–60 |

Navigation rule #1: **always read the index first, never scan all entity files.**
The caps and budgets live in `mygrace.config.json` (`indexCaps`, `sizeBudgets`)
and are enforced by lint, so they cannot silently rot.

## What the tool enforces

`mygrace lint` is the gate, not documentation about a gate. It reports stable,
machine-readable finding codes for:

- malformed project XML (line/column, never a silent empty index);
- index ↔ entity drift for every documented field (`NAME`, `TYPE`, `STATUS`,
  `PATH`, `DEPENDS`, `VERIFICATION_REF`, phase name/status/steps, verification
  module/priority/status), plus duplicates and orphaned/missing files;
- missing module `PATH`, unknown `DEPENDS`, dangling `VERIFICATION_REF`;
- index line caps and entity size budgets from config;
- incremental scope for `lint --changed`: changed files are classified (index →
  full index checks, entity → that entity, source → markup only) and the run
  prints `Scope: N changed file(s) (scanned: X, skipped: Y)`;
- sharded-index integrity: shard references must resolve under `docs/`, the
  declared counts must match the actual entries (both the root reference and the
  shard root), ids must not be duplicated across shards, and every shard must
  stay under the index cap (`SHARD_FILE_MISSING`, `SHARD_ROOT_INVALID`,
  `SHARD_COUNT_MISMATCH`, `PATH_UNSAFE`, `DUPLICATE_INDEX_ENTRY`, `INDEX_TOO_LARGE`,
  `XML_INVALID`);
- markup problems in any configured language: unpaired or mismatched semantic
  blocks, missing `MODULE_CONTRACT` fields, generic XML tags.

`--strict` converts warnings into a failing exit code (the CI gate), and
`--format json` returns the same exit code as text mode. Exit-code contract:
`0` ok · `1` findings · `2` usage/config/trust refusal · `3` internal error.

## Trust model (security)

Commands declared by a project (`<module-checks>` in the canonical
`docs/verification/V-M-XXX.xml`) are **repository data**, and a cloned repo can
be hostile. `mygrace verify` therefore prints the command and
refuse to execute it unless one of these holds:

- you created `.mygrace/trust.json` with `mygrace trust` after reviewing the
  printed commands (sha256 of every command source is recorded; editing docs
  invalidates it);
- the project config sets `"allowCommands": true`;
- the invocation passes `--allow-commands`.

Commands run argv-only (never through a shell), shell-style commands need an
extra explicit opt-in, and `.mygrace/` is local state: add it to your project's
`.gitignore` (a fresh `setup init` project has none; `mygrace trust` warns when the
record is not ignored).

Defense in depth beyond trust:

- **dangerous-command deny list** — commands matching privilege escalation,
  destructive removal, network/download tools, `eval`/`exec`, encoded payloads,
  permission changes, device writes, publishing or out-of-tree redirects are
  refused even in a trusted project; `--allow-unsafe-commands` is a one-off,
  explicit override (also available on `verify`, `ci` and MCP tools);
- **audit log** — every executed command (and every policy/shell refusal) appends
  a JSONL record to `.mygrace/audit.log` (timestamp, module, command, exit,
  authorization source, duration); the log is local and gitignored;
- **inspection commands** — `mygrace trust --check` verifies the record without
  writing (exit 1 when missing/stale) and warns about deny-listed declarations;
  `mygrace trust --revoke` deletes it.

The full threat model and the agent guidance for untrusted repositories are in
[`SECURITY.md`](SECURITY.md).

## Install

Requirements: **Bun ≥ 1.3.8** (`engines.bun`). Node.js support is a roadmap
target (Node ≥ 22.6 native type stripping) and is not declared in `engines` yet.

From a source checkout:

```bash
git clone https://github.com/anyagixx/MyGrace_DS4pro.git
cd MyGrace
bun install
bun run src/grace.ts --version
```

From a packed tarball (what `bun pm pack` ships):

```bash
bun pm pack                       # creates mygrace-cli-<version>.tgz
mkdir mygrace-cli && tar -xzf mygrace-cli-*.tgz -C mygrace-cli
cd mygrace-cli/package
bun install --production
bun run src/grace.ts --version
```

### DeepSeek Harness integration

```bash
# installs the 12 skills into $DSH_HOME/skills and a PATH-free MCP row
# into the profile's cordis.patch.yml (YAML-validated, atomic, backed up)
bun run src/grace.ts setup install --dry-run      # inspect planned actions
bun run src/grace.ts setup install                # apply (idempotent)

# optional, opt-in: the LIVE status card in the DSH web sidebar (private package)
bun run src/grace.ts setup install --panel

# remove everything setup install added (byte-identical config restore)
bun run src/grace.ts setup install --uninstall
```

The installer writes a launcher at `$DSH_HOME/mygrace/bin/mygrace`, records
state in `$DSH_HOME/mygrace/state.json`, and generates an MCP row with absolute
command/args plus `env.MYGRACE_BIN`, so MCP calls work even with `PATH=""`. A
failed step exits non-zero — no silent success. Restart the harness (or open a
new session) so the MCP row loads; skills are picked up from the skills root.

The `--panel` component is a **LIVE status card**, not a placeholder. The host
plugin registers `GET /api/mygrace.status` (disposed with the plugin, `cache-control:
no-store`, 5 s CLI timeout, never throws — failures become `{ok:false,error}`),
builds its payload from `mygrace status --format json` through the generated
`$DSH_HOME/mygrace/bin/mygrace` launcher (`MYGRACE_BIN` first), and resolves the
project from a validated `?path=` → `MYGRACE_PROJECT_ROOT` → cwd walk-up. The
browser card fetches on mount, every 30 s and on `visibilitychange`, renders
counts/badges/freshness and degrades to "MyGRACE: not connected — <reason>".
Payloads: `{ ok, project, modules, phases, verifications, lint, trust:
{authorized, via}, generatedAt, durationMs, error? }`. It is opt-in, private and
never writes to the project.

**Limits, stated honestly:** route registration/disposal, the payload builder and
the install/profile composition are covered by `test/grace-panel.test.ts` against
the real DSH 0.2.1-rc.2 loader, but a live `dsh web` browser session is **not**
exercised in CI; the card is a convenience, and the CLI remains the source of
truth.

`setup install --bundle` was **removed in v1.1** and exits `2`: `packages/mygrace-dsh`
is an unpublished optional preview (it needs unpublished preview packages and
a private panel package), not a supported install path.

## Quick start

These are the exact commands tested from a source checkout. **`mygrace ci` is the
honest one-command gate** (strict lint + project status + verification coverage;
`--tests` adds trust-gated scoped test runs), and **`mygrace trust` is the
security checkpoint** that must be passed before any project-supplied command may
execute.

```bash
# 1. create a project (docs/ indexes + AGENTS.md + mygrace.config.json)
bun run src/grace.ts setup init --path /tmp/my-project --name MyProject

# 2. fill docs/requirements.xml + docs/technology.xml, then use the
#    mygrace-plan / mygrace-verification skills to build the module graph

# 3. one-command gate (safe before trust — it executes no project commands)
bun run src/grace.ts ci --path /tmp/my-project

# 4. review the declared <module-checks>, then record trust
#    (use `trust --check` to inspect, `trust --revoke` to remove)
bun run src/grace.ts trust --path /tmp/my-project

# 5. scoped verification, then the full gate including trust-gated tests
#    (requires at least one planned module)
bun run src/grace.ts verify --module M-AUTH --path /tmp/my-project
bun run src/grace.ts verify --path /tmp/my-project
bun run src/grace.ts ci --path /tmp/my-project --tests

# optional read-only checks
bun run src/grace.ts lint --path /tmp/my-project --strict
bun run src/grace.ts status --path /tmp/my-project --format json
bun run src/grace.ts setup doctor --path /tmp/my-project
```

With the CLI installed the same commands are `mygrace <command> ...`. In the
DeepSeek Harness the agent loads `AGENTS.md` automatically and invokes the
matching skill; see [`AGENTS.md`](AGENTS.md). Step 5 assumes the project has at
least one planned module: before that `verify` reports `0 ok` and `ci` reports
`0/0 modules verified` (both exit 0), while `step-5`'s `test --module <id>` on an
unplanned module reports a finding and exits 1.

The commands that do not require a planned module were executed in a scratch copy
of this repository (Bun 1.4.5): `setup init`, `ci`, `trust`, `verify`,
`ci --tests`, `lint --strict` and `status --format json` all exited 0. `setup doctor`
is environment-dependent: in a bare checkout without a DeepSeek Harness
integration it reports the missing DSH pieces and exits 1, with hints for each.

## CLI commands (15)

| Command | What it does |
|---|---|
| `mygrace ci` | One-command quality gate: strict lint + status + verification coverage (`--tests` adds trust-gated tests) |
| `mygrace lint` | Validate XML, index↔entity drift, caps/budgets, markup; `--strict`, `--format json`, incremental `--changed`/`--base`/`--files` |
| `mygrace status` | Health snapshot from the three indexes + lint summary; `--format json` |
| `mygrace verify` | Run verification-scoped tests with a compact digest; writes `.mygrace/last-failures.md` on failure; `--module`, `--allow-unsafe-commands` |
| `mygrace trust` | Review declared commands and write `.mygrace/trust.json`; `--check` verifies without writing, `--revoke` deletes the record |
| `mygrace inspect` | Index/entity readers: `module index|find|show|list|shard`, `phase index|show`, `verification index`, `file show <path>` |
| `mygrace context` | Worker context: `packet M-X` (self-contained prompt), `focus M-X` (minimal set), `cost` (read budget), `guidance <query>` (domain guidance packs) |
| `mygrace setup` | Setup: `init` (scaffold), `install` (DSH skills + MCP row), `doctor` (environment health) |
| `mygrace trace` | Trace one module end-to-end: verification → test files → command → phases → dependents, with coded gaps (`<ID>` = module or verification id); `--code` adds the optional MODULE_MAP↔symbol check (`--strict-contracts` fails on gaps) |
| `mygrace impact` | Map changed files (git, `--staged`, `--since`, or `--files`) to affected modules, dependents, verification blast radius and phases; `--code-graph` adds real import edges via optional Octocode |
| `mygrace next` | Deterministic nine-code advice ladder: init → index → lint → coverage → trust → verify → warnings → next phase |
| `mygrace projects` | Monorepo discovery: per-project counts, lint and coverage under a tree (`--depth`, `--strict`) |
| `mygrace integrations` | Detect optional external tools (Octocode, Archify, Modern Web Guidance), versions and tested ranges; advisory, never fails the core gates |
| `mygrace diagram` | Export the docs graph as deterministic Archify IR — `--kind architecture\|workflow\|tree` — as JSON, Mermaid (architecture) or standalone HTML (needs optional Archify); `--check` guards every committed IR |
| `mygrace capsule` | Local allowlisted routines: `list`/`show`/`validate`, `qualify` (replay + hash), `run` with judgment hand-back, `continue`; execution disabled by default (`integrations.capsules.enabled`) |

Every command accepts `--help`; `--format json` commands return the envelope
`{ ok, exitCode, data, findings[], meta }`.

## MCP tools (21)

The stdio server is a transport adapter over the CLI: every tool maps to a
command, arguments are schema-validated, and CLI failures keep their output in
the tool result. DSH exposes them as `mcp__mygrace__<tool>` — e.g. the
quality gate is `mcp__mygrace__ci`.

`mygrace_show_module` · `mygrace_show_phase` · `mygrace_find_modules` ·
`mygrace_phase_index` · `mygrace_doctor` · `mygrace_context` · `mygrace_verify` ·
`mygrace_list_verifications` · `mygrace_lint` · `mygrace_show_file` ·
`mygrace_status` · `mygrace_trust` · `mygrace_ci` · `mygrace_trace` ·
`mygrace_impact` · `mygrace_next` · `mygrace_projects` · `mygrace_integrations` ·
`mygrace_diagram` · `mygrace_capsule_list` · `mygrace_capsule_run`

### Optional integrations (ADR-9)

The core gates are deterministic, offline and dependency-free. Three external tools
can add depth when they are installed — never required, always opt-in:

| Tool | Used for | Commands | Tested range |
|---|---|---|---|
| [Octocode](https://github.com/Muvon/octocode) | real import edges + MODULE_MAP↔symbol checks (read-only MCP graph; no index, no LLM) | `impact --code-graph`, `trace --code`, `integrations status` | `>=0.29 <0.30` |
| [Archify](https://github.com/tt-a1i/archify) | deterministic diagram rendering from the docs graph | `mygrace diagram`, `--check` | `>=3.2 <4` |
| [Modern Web Guidance](https://github.com/GoogleChrome/modern-web-guidance) | up-to-date web-platform guidance for agents (optional CLI guidance pack) | `integrations status`, `context guidance` (when configured as a pack) | `>=1.0 <2` |

MWG detection probes a `modern-web-guidance` executable on PATH (or `MYGRACE_MODERN_WEB_GUIDANCE_BIN`); npx-only users can still configure it as a `guidancePacks` CLI entry, which needs no global install.

Unavailable, disabled or unsupported tools produce `INTEGRATION_UNAVAILABLE` /
`INTEGRATION_UNSUPPORTED_VERSION` info/warning findings and the command keeps its
normal output and exit code. `MYGRACE_INTEGRATIONS=off` disables every adapter for
reproducible CI. Versions are pinned and checked; nothing is downloaded or sent.

### External lint providers (ADR-11)

Projects can declare trust-gated external scanners in `lintProviders` (for
example Modern Web Guidance `legacy-scan --json`). They run only with a current
trust record or `--allow-commands`, pass the same dangerous-command deny list and
are audited in `.mygrace/audit.log`; findings are ordinary MyGRACE findings with
`failOn: warning|error|none`; unpinned scanner commands get
`LINT_PROVIDER_UNPINNED`. See
[`docs/guidance-packs.md`](docs/guidance-packs.md) and
[ADR-11](docs/adr/ADR-11-guidance-and-lint-providers.md).

### Guidance packs (ADR-12)

`guidancePacks` wires local markdown packs or a CLI pack (Modern Web Guidance
implements the protocol) into `mygrace context guidance "<query>"` and the
existing `mygrace_context` MCP mode `guidance`. Remote text is untrusted data,
never executed; pin CLI package versions (unpinned specs get a
`GUIDANCE_PACK_UNPINNED` warning). See [`docs/guidance-packs.md`](docs/guidance-packs.md).
### Octocode setup (graph mode)

Octocode starts a **local FastEmbed/ONNX embedding model before it answers MCP
`initialize`**. The default Jina code model is ~612 MB and is downloaded on first
use; on a slow link that looks like a hang. Pre-warm the cache once (or configure
smaller FastEmbed models) and subsequent sessions start in ~2 s:

```bash
# smaller, verified model pair (~215 MB total cache, no API key):
octocode config \
  --code-embedding-model fastembed:Qdrant/bge-small-en-v1.5-onnx-Q \
  --text-embedding-model fastembed:Xenova/all-MiniLM-L6-v2
# then run any graph command once with a generous timeout; it warms the cache:
mygrace trace M-CLI --code --path .
```

Config lives in `~/.local/share/octocode/config.toml`. Octocode 0.30 migrates it
to config version 4, which the pinned adapter (0.29.x) refuses — keep one version
per machine, or restore the generated `config.toml.v3.*.bak`. Real-binary evidence
(2026-11-25): with a warm cache, `trace --code` resolved 8/9 MODULE_MAP entries and
`impact --code-graph` produced real cross-module import edges. The detailed
investigation is in [`analysis/octocode-startup.md`](analysis/octocode-startup.md).

## Traceability, impact and next-step advice

Four read-only commands answer the questions an agent actually has — "why does
this exist?", "what does this change affect?", "what should I do next?" and
"what lives in this monorepo?" — without reading per-entity files:

**`mygrace trace <ID>`** walks the proof chain for a module (or verification):
module contract → verification file → declared test files (with existence and
line counts) → command provenance (`verification` | `module-deprecated` |
`config` | `default`) → requirement links → phases → direct and transitive
dependents. A broken chain exits `1`; optional gaps are info findings:

```
M-CART — Cart [done] src/cart/index.ts
  → verification V-M-CART (done, high): src/cart/index.test.ts ✔ (45 lines)
  → command: bun test src/cart/index.test.ts [verification]
  → phases: Phase-2 (step-1)
  → dependents: (none; 0 transitive)
  ⓘ [NO_REQUIREMENT_LINK] no element in docs/requirements.xml mentions M-CART…
  ✓ traceable — no errors
```

Error codes: `MISSING_VERIFICATION_REF`, `VERIFICATION_FILE_MISSING`,
`TEST_FILE_MISSING`, `MODULE_PATH_MISSING` (plus `MODULE_FILE_MISSING`,
`XML_INVALID`); info codes: `NO_DECLARED_COMMAND`, `NO_REQUIREMENT_LINK`,
`NO_PHASE_LINK`.

**`mygrace impact`** maps changed files to direct modules (exact `PATH`,
module-directory prefix or docs entity edit), their transitive reverse-`DEPENDS`
closure, the verification/test blast radius, affected phases and the commands
that prove the change. Scope precedence: `--files` → `--staged` → `--since <ref>`
→ `git diff HEAD`; `--files` works without git, and no source at all is a usage
error (exit 2).

**`mygrace next`** returns exactly one recommendation from a fixed nine-code
ladder: `INIT_PROJECT`, `FIX_INDEX`, `FIX_LINT_ERRORS`,
`ADD_VERIFICATION_COVERAGE`, `TRUST_COMMANDS`, `VERIFY_MODULE`,
`REFRESH_WARNINGS`, `NEXT_PHASE`, `NOTHING_TO_DO` — with `NEXT` / `WHY` / `RUN` /
`IDS` / `CODE` text lines or a JSON action. Advice never fails the build (exit
`0`; usage/config errors exit `2`), and the same tree always yields the same
advice.

**`mygrace projects`** discovers projects by their `docs/graph-index.xml` marker
with a bounded BFS (default depth 4, hard cap 2000 directories, `truncated`
reported), then reports per-project counts, lint findings and verification
coverage with totals. Exit `0` clean, `1` any findings, `--strict` also fails on
warnings. On this repository: MyGRACE clean, DemoStore clean, TestProject clean.

**Incremental lint:** `mygrace lint --changed [--base <ref>] [--files a,b,c]`
scopes a run to git changes (or explicit files without git): index changes run
the full index checks, entity changes check that entity, source changes check
markup only. It prints the scope line and adds `data.scope` to the JSON envelope.

## Measured performance

Core command benchmarks (median wall time / peak RSS, 7 runs after a warm-up) on
this repository, `examples/demo-store` and a generated lint-clean 70-module
project: `mygrace ci` ≈ 380 ms / 109 MB on 29 modules and ≈ 419 ms / 94 MB on 70
modules; `status` and `lint --strict` ≈ 155–260 ms. On two real external repos (expressjs/express, psf/requests) the same
commands are 105–237 ms / 65–83 MB; curated agent sessions still show no
consistent token benefit, and the MyGRACE+MWG arm was more expensive
(negative results documented in the report). A separate
artifact-quality pilot (accessible dialog, six-point rubric) saturated at 6/6 for
all arms; MyGRACE-only used the fewest tokens (7 981) while MyGRACE+MWG used the
most (68 351) — see [`analysis/web-quality-benchmark.md`](analysis/web-quality-benchmark.md). Full table, method and
limitations: [`analysis/benchmark.md`](analysis/benchmark.md). This is CLI/index
performance only — agent-task success and token usage are measured separately
(capsule pilot: [`analysis/capsule-eval/report.md`](analysis/capsule-eval/report.md);
external express benchmark: [`analysis/external-benchmark.md`](analysis/external-benchmark.md)).

## Diagrams (optional)

`mygrace diagram` renders the machine graph for humans; nothing is hand-drawn.
Three deterministic kinds:

```bash
mygrace diagram                              # architecture summary
mygrace diagram --format json                # IR + full dependency list (offline)
mygrace diagram --format mermaid             # architecture flowchart (full graph)
mygrace diagram --format html                # Archify validate + deliver (needs Archify)
mygrace diagram --kind tree --format html    # capability hierarchy: project → groups → modules
mygrace diagram --kind workflow --format html # delivery plan: one lane per phase, sequential columns
mygrace diagram --check                      # fails when any committed IR is stale
```

Mapping rules: **architecture** shows modules with a legible primary-dependency
backbone (Archify clean-flow requires it; the full declared graph stays in
JSON/Mermaid and the cards); **tree** is a parent-linked hierarchy
(project → capability groups by module `TYPE` → modules); **workflow** uses plan
phases as swimlanes, one node per phase in columns 1–5 (phases beyond five are
aggregated into the last node with an explicit note), sequential edges routed
bottom→top. Every IR is committed under `docs/diagrams/<kind>.json`; HTML and
receipts are local/gitignored. `--check` (and `release:check`) verifies all three
committed IRs; `--format json --out <path>` refreshes an IR without Archify.
Tested against Archify CLI 3.2.0 and 3.3.x (fake-CLI contract in `bun test`,
real-binary smoke manual: `bun run test:integrations:archify`).

## Skills (12, shared from `skills/mygrace/`)

| Skill | Purpose |
|---|---|
| `mygrace-init` | Bootstrap docs/ + AGENTS.md + config |
| `mygrace-plan` | Design modules/phases/verification; write entities + indexes |
| `mygrace-verification` | Design scenarios, log markers and evidence per module |
| `mygrace-execute` | Implement a phase step by step (current phase + module only) |
| `mygrace-multiagent-execute` | Parallel waves via DSH subagents (includes role prompts, merged from setup-subagents) |
| `mygrace-refactor` | Safe restructuring with atomic index updates |
| `mygrace-reviewer` | Integrity audit (scoped / wave / full) + index-refresh recovery (merged from refresh) |
| `mygrace-fix` | Debug: index → module → block |
| `mygrace-status` | Health report from indexes + lint summary |
| `mygrace-ask` | Q&A via lazy navigation |
| `mygrace-cli` | CLI/MCP reference + output budget (merged from token-budget) |
| `mygrace-explainer` | Methodology reference and honest metrics |

## Project configuration

`mygrace.config.json` is optional; `mygrace setup init` writes it so the layout is
visible and editable. Unknown keys are rejected with every problem listed at
once; defaults reproduce the classic layout.

| Key | Default | Used by |
|---|---|---|
| `sourceDirs` | `["src", "lib", "apps", "packages"]` | lint markup scan, doctor |
| `markupExts` | `.ts .js .mjs .cjs .tsx .jsx .py .go .java .rs .rb` | lint markup scan |
| `ignoreDirs` | `node_modules .git dist build out target vendor …` | every file walk |
| `indexCaps` | graph `100`, plan `50`, verification `80` | lint (errors above cap) |
| `sizeBudgets` | module `[30,80]`, phase `[50,200]`, verification `[20,60]` | lint (warnings outside) |
| `testRunner` | `"bun test"` | fallback when no `<module-checks>` is declared |
| `allowCommands` | `false` | trust model: project-wide command opt-in |
| `language` | `"typescript"` | generated docs and diagnostics |
| `lintProviders` | `[]` | optional trust-gated external scanners (ADR-11) |
| `guidancePacks` | `[]` | optional local/CLI guidance packs (ADR-12) |

Semantics that matter when adapting MyGRACE to another layout:

- a list you set **replaces** the default entirely — `sourceDirs`,
  `markupExts` and `ignoreDirs` are not additive. A polyglot repository must
  enumerate every extension it uses (for example `[".ts", ".py", ".go"]`);
- `markupExts` also selects the comment dialect understood in markup checks
  (`//`, `#`, `--`, `/*`, `<!--`), so Python and Go sources are linted natively;
- `testRunner` is only the **fallback** used when a module has no canonical
  `<module-checks>` in its verification file;
- `language` is a label for generated docs and diagnostics, not a parser switch.

## Scaling past the index cap (sharded indexes)

`docs/graph-index.xml` is capped (`indexCaps.graph`, default 100 lines), which
makes a flat one-line-per-module index impractical beyond ~90 modules. Sharding
keeps the root small by replacing flat entries with references:

```xml
<!-- docs/graph-index.xml: 6 lines, any number of modules -->
<Shard href="modules/shard-core_logic.xml" count="7" />
<Shard href="modules/shard-entry_point.xml" count="1" />
```

```xml
<!-- docs/modules/shard-core_logic.xml -->
<ModuleShard project="MyProject" group="CORE_LOGIC" count="7">
  <M-COMMON NAME="Filesystem helpers" TYPE="CORE_LOGIC" STATUS="done" PATH="src/common.ts" DEPENDS="M-ERRORS" VERIFICATION_REF="V-M-COMMON" />
</ModuleShard>
```

The `href` is resolved relative to `docs/`, must stay inside `docs/` and end in
`.xml`. Shard files are **index shards**, not per-entity files: `module show`
still reads `docs/modules/M-XXX.xml` directly.

Generate shards deterministically:

```
mygrace inspect module shard [--group-by type|status|prefix] [--apply] [--path <root>] [--format text|json]
```

- **dry run is the default** — it prints the plan and writes nothing;
  combining `--apply` with `--dry-run` is a usage error (exit 2);
- `--apply` groups deterministically, writes `docs/modules/shard-<slug>.xml`,
  rewrites the root index atomically, keeps a timestamped backup under
  `.mygrace/backups/shard-<ISO>/`, removes stale generated shards (backed up
  first), and is idempotent — an unchanged plan prints "No changes";
- `module list`, `find`, `status`, `ci`, `test` and `verify` read the **union**
  of root + shard entries transparently; `module index` prints a shard summary.

Measured on the synthetic large-project fixture (150 modules in 3 shards):
`lint` ≈44 ms in-process, CLI `status` ≈137 ms, `module list` 150/150,
`runCiGate` 0 findings. This repository stays flat (29 modules) and keeps its
`0 errors / 0 warnings` result, so sharding is opt-in, not required.

## Multi-language projects

The markup/config layer is language-agnostic; a project opts in through
`mygrace.config.json` (see the replacement semantics above):

```json
{
  "sourceDirs": ["app", "lib"],
  "markupExts": [".py"],
  "ignoreDirs": ["node_modules", ".venv", "__pycache__"],
  "testRunner": "python3 -m pytest",
  "language": "python"
}
```

- `sourceDirs` overrides the default directory list **entirely** — an `app/`
  layout is scanned when configured, and nothing outside it is;
- `markupExts` replaces the default extension list; the configured comment
  dialect (`#` for Python, `//` for Go, `--` for SQL/Lua, `/*` and `<!--` for C
  and XML) is understood in `MODULE_CONTRACT` / block checks;
- `ignoreDirs` keeps virtualenvs/vendor trees out of walks;
- module `PATH` values may be non-TypeScript (for example `app/store.py`) and are
  resolved and reported like any other;
- `testRunner` is the fallback only when the canonical `<module-checks>` is
  absent; once commands are declared in verification files, those win (and stay
  trust-gated).

Python and Go fixtures live in `test/grace-language.test.ts`, and the CI
`language-matrix` job runs them against two Python versions.

## Measured context (honest metric)

`scripts/measure-context.ts` measures **lines, bytes, and a documented token
estimate** (`ceil(utf8 bytes / 4)`) — it is *not* a tokenizer result. The
classic-GRACE baseline is **synthesized** by concatenating the index and
per-entity files; it is a model, not a real classic repository. Reproduce with
`bun run scripts/measure-context.ts --json`.

Checked-in demo project (3 modules, 2 phases):

| Operation | Classic lines | MyGRACE lines | Line reduction | Classic estimate | MyGRACE estimate | Estimate reduction |
|---|---|---|---|---|---|---|
| Status check (3 indexes) | 316 | 19 | 94% | 3922 | 269 | 93% |
| Single module work | 110 | 43 | 61% | 1296 | 555 | 57% |
| Phase execution | 116 | 64 | 45% | 1738 | 964 | 45% |
| Full verification audit | 90 | 90 | 0% | 888 | 888 | 0% |

The same script runs a deterministic 12/50/200-module sweep: the index-first win
**grows with project size but saturates** (single-module line reduction 89% → 95%
→ high-90s; phase execution 65% → 88% → high-90s; status check flat at ~94%+;
full verification audit stays 0% because reading everything is reading
everything). Measured slope: +4.3 percentage points per 100 modules for
single-module work, +16.5 for phase execution. The 200-module point is a
synthetic model, not a benchmark of a real repository.

Runtime view for agents: `mygrace context cost --path <project>`.

## Project structure

```
docs/
  graph-index.xml          # module index (cap 100 lines) — read first
  plan-index.xml           # phase index (cap 50)
  verification-index.xml   # verification index (cap 80)
  modules/                 # one M-XXX.xml per module
  plans/                   # one Phase-N.xml per phase
  verification/            # one V-M-XXX.xml per module (<module-checks> canonical)
  operational-packets.xml  # execution-packet template (written by setup init)
  archive/                 # completed phases (remove their plan-index entry)
  requirements.xml, technology.xml
mygrace.config.json        # layout/budgets/runner/allowCommands
AGENTS.md                  # agent instructions (auto-loaded by DSH)
src/                       # source with MODULE_CONTRACT + semantic blocks
```

Archiving a phase means moving `docs/plans/Phase-N.xml` to `docs/archive/`
**and removing its `plan-index.xml` entry** — otherwise lint reports an orphaned
index entry.

## Development

```bash
bun run typecheck               # tsc --noEmit (strict)
bun test                        # unit/integration tests (639 tests / 31 files); use test:scoped for test/ only
bun run test:demo               # demo-store integration tests
bun run lint:demo               # lint the checked-in demo (must be 0/0)
bun run validate:marketplace    # packaging/skills/version truth gate
bun run validate:docs           # documented commands/flags/MCP names/counts vs code
bun run pack:smoke              # pack + install the tarball in a temp dir, run the packaged CLI
bun run publish:dry             # release-artifact gate: pack, import completeness, offline install, CLI smoke
bun run release:check           # release:check == ci (what a tag must pass before publish)
bun run ci                      # all of the above (release gate)

# repo self-check (dogfooding): the project's own docs/ graph
# (29 modules, 4 phases, 29 verifications, 39 declared test files; PASS)
bun run src/grace.ts ci --path .
```

Contributor workflow, code conventions and release gates:
[`CONTRIBUTING.md`](CONTRIBUTING.md).

## Release engineering and distribution

Distribution decision (2026-11-25): MyGRACE **is not published to npm**. It ships
as GitHub Releases with a packed tarball plus the source checkout. `@osovv` is a
third-party scope (the codebase this project started from) and is not used.

Tag-driven and CI-only: `.github/workflows/release.yml` runs on a `v*` tag (or
manually via workflow_dispatch for a gates-only run), executes
`bun run release:check` and `bun run publish:dry` (artifact packing, static
import completeness, offline install, packaged CLI smoke), refuses a tag that
does not match `package.json`, packs `mygrace-cli-<version>.tgz`, uploads it as a
workflow artifact and creates a GitHub Release with generated notes. CI runs the
same gates plus an OS matrix (Ubuntu, Windows, macOS).

- `bun run release:check` — the full gate: typecheck, tests, demo lint,
  `mygrace ci` self-check, truth validators, diagram/capsule gates, pack-smoke.
- `bun run publish:dry` — packs the tarball, checks static import completeness,
  installs it offline and runs the packaged CLI. It is an artifact gate; it does
  not contact any registry.
- Local install stays from source or a packed tarball (see [Install](#install)).
  There is no npm publication step, no `NPM_TOKEN`, and no trusted-publisher
  configuration.

## Platform support

| Platform | Packaging | Status |
|---|---|---|
| **DeepSeek Harness** | `mygrace setup install` (skills + MCP row; optional LIVE status panel) | ✅ primary, verified end-to-end |
| Claude Code / Gemini CLI / OpenCode | `plugins/*` | ⚠️ metadata stubs only — no context files shipped yet |
| Codex / Cursor / Windsurf / KiloCode / Copilot / Aider | `rules/*` instruction files | ⚠️ instruction files only (wire them into the tool yourself) |
| Qwen Code | `extensions/mygrace/` | ⚠️ legacy extension, not maintained; kept for reference |
| DSH bundle / LIVE sidebar card | `packages/mygrace-dsh`, `packages/mygrace-status-panel` | ⚠️ bundle is an unpublished preview; the status card is LIVE but opt-in/private and not exercised in a live GUI session |

## Documentation

- [`SECURITY.md`](SECURITY.md) — threat model, trust record, reporting a vulnerability
- [`CONTRIBUTING.md`](CONTRIBUTING.md) — dev setup, conventions, release gates
- [`docs/architecture.md`](docs/architecture.md) — module graph, ADRs, enforcement table
- [`ROADMAP.md`](ROADMAP.md) — vision, ADRs, waves and release gates
- [`CHANGELOG.md`](CHANGELOG.md) — released and unreleased changes
- [`docs/guidance-packs.md`](docs/guidance-packs.md) — guidance-pack SPI and examples
- [`AGENTS.md`](AGENTS.md) — the agent-facing instruction file (`setup init` writes it)

## License

MIT. Forked from [GRACE marketplace](https://github.com/osovv/grace-marketplace)
by osovv; the MyGRACE methodology was designed by Vladimir Ivanov. This repository
(`anyagixx/MyGrace_DS4pro`) is an independent derivative and is **not affiliated**
with the `@osovv` npm scope — the npm package is `mygrace-cli`.
([@turboplanner](https://t.me/turboplanner)).
