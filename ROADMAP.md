# MyGRACE Roadmap — from audit findings to a professional agent engineering harness

> Status: **v3.3.0 shipped 2026-11-26** — guidance professionalization: lockfile/integrity, npx-cache detection and a three-task quality benchmark. Quality/token gains remain unproven; Wave 7 tracks the remaining harder-rubric/N work. Baseline: v1.0.1 as audited on 2026-11-22
> (see `analysis/00-EXECUTIVE-ASSESSMENT.md` and appendices 01–04).
> Target: a tool that AI coding agents can use with confidence on software of **any complexity** —
> from a 3-module script to a 500-module monorepo, on repos you do not fully trust.
> **v3.1.0 shipped evidence:** `bun run release:check` green (typecheck 0, **727 tests / 35 files**,
> demo lint, doc-truth gates, pack-smoke, **diagram IR freshness for all three kinds**, capsule validation),
> `mygrace ci --path .` PASS on this repository (**29 modules / 4 phases / 29 verifications /
> 39 declared test files**), and `bun run publish:dry` proves the publish artifact (68 files, 259 kB, 29 shipped src files, 137 relative + 28 bare imports). G13 green with
> `MYGRACE_INTEGRATIONS=off`; G14: recorded-payload + fake-Octocode/fake-Archify contract tests run
> in `bun test`, real-binary smokes stay manual; G15 checks **architecture, tree and workflow** IRs
> (all validated/delivered against real Archify 3.2.0 and 3.3.x); G16 shipped capsules validate and
> the capsule lifecycle is covered by fake-CLI tests. Real Octocode 0.29.2 graph session verified
> (warm FastEmbed cache: MCP initialize ~2.1 s; `trace --code` 8/9 symbols; `impact --code-graph`
> 4 module edges); the adapter now matches the real `graphrag` API.
> Surface: **15 CLI commands · 21 MCP tools · 12 skills** (v2.0 breaking consolidation; migration guide in `docs/migrations/v2.0.md`; quickstart keeps the daily path to `next` + `ci`). Committed deterministic diagram IRs for
> three kinds; experimental capsules with allowlisted read-only programs, replay qualification,
> judgment hand-back and deopt-to-skill (no token-savings claims; a 12-session
> pre-registered pilot was inconclusive, see analysis/capsule-eval/report.md).
> Distribution is GitHub Releases + source; npm publication is intentionally not
> used (owner decision 2026-11-25). v1.8.0 adds a deny-listed dangerous-command
> policy, `.mygrace/audit.log`, `trust --check/--revoke`, a benchmark harness
> (`analysis/benchmark.md`) and `docs/quickstart.md`.

## 1. Vision

MyGRACE is the **contract layer between human intent and AI-executed work**:

1. **Intent** (requirements) → **architecture** (modules/phases) → **verification** (scenarios,
   evidence) → **execution** (one module at a time) stays traceable at every step.
2. Agents navigate the repo through **small, stable, machine-readable indexes** instead of
   re-reading the codebase (the original — and correct — core idea).
3. Every invariant the tool sells is **enforced by `mygrace ci`**, not by discipline and not by
   prompt wording. If a rule is not enforced, it is not a rule — it is documentation.
4. Anything the tool executes is either **declared by the project owner** (trusted) or **requires
   explicit opt-in**. Repo data is never executable by default.
5. The tool works **without the author present**: idempotent install, verifiable exit codes,
   documented security model, honest metrics.

## 2. Definition of Done — "professional v2.0"

A release is professional when **all** of the following hold, verified by CI, not by claims:

| # | Gate | Verification |
|---|---|---|
| G1 | Packaged CLI works from a clean machine | `bun pm pack` → install tarball in temp dir → `mygrace --version`, `mygrace init-dsh`, `mygrace ci` all exit 0 |
| G2 | Type-safe codebase | `tsc --noEmit` (strict) green, `tsconfig.json` committed |
| G3 | Enforced invariants | `mygrace lint --strict` detects all drift classes listed in §4.2; every class has a negative test |
| G4 | Enforced security model | arbitrary command execution impossible without trust file; path traversal impossible; negative tests exist |
| G5 | Test suite proves behaviour | unit + integration (MCP stdio, install e2e, init e2e, CLI exit codes); mutation score ≥ 85% |
| G6 | Agent integration works end-to-end | MCP server: 15+ tools, every tool call succeeds from a checkout and from a tarball install; DSH bundle path works or is removed from docs |
| G7 | Dogfooding | this repo has `docs/` and passes `mygrace ci --strict` on itself |
| G8 | Docs are true | every documented command/flag/MCP tool/count auto-verified by `scripts/validate-docs.ts` in CI |
| G9 | Honest metrics | savings measured in tokens with a tokenizer + size sweep (12/50/200 modules), reproducible by script |
| G10 | Release engineering | CHANGELOG + semver policy, tag-driven gates and GitHub Release artifact; npm publication intentionally not used |
| G11 | Scale proven | ✅ synthetic 150-module / 3-shard project: `lint` 44 ms, indexes under caps via sharding, `ci` green (200+ supported by design) |
| G12 | Any-language support | ✅ Python/Go fixtures prove configurable `sourceDirs`, markup dialect per language, and per-project test runner (`test/grace-language.test.ts`, `language-matrix` CI job) |

## 3. Non-goals (explicitly out of scope)

- Not an IDE/editor; not a code generator; not a model provider.
- Not a replacement for existing test frameworks — it **orchestrates** them and enforces traceability.
- No telemetry, no network calls at runtime (except the explicitly invoked install/doctor probes).
- Not multi-tenant: one repo = one MyGRACE project (monorepo = several sub-projects discovered by config).

## 4. Architecture decisions (ADR summary)

### ADR-1 — Trust model for executed commands (security)
`mygrace test`/`verify` may execute the project's configured command. Commands come from repo files
(`docs/`), which are attacker-controlled in a cloned repo. Therefore:
- commands live in **one place**: `docs/verification/V-M-XXX.xml` `<module-checks>` (canonical — this is
  where templates, skills and the demo already put them), read from there everywhere
  (test/verify/packet/mcp); reading `<module-checks>` from the module file stays supported as a
  deprecated fallback but is never propagated to new projects;
- execution requires a **trust record**: `.mygrace/trust.json` (gitignored) containing project root `sha256`
  of the command-source files. Commands are printed and **not executed** when trust is absent/stale
  (`--allow-commands` overrides for CI, `mygrace trust` writes the record);
- default in agent context: never silently execute; the error text tells the agent exactly what to run.

### ADR-2 — XML is a serialization, not a language
Docs XML is parsed with a real parser (`fast-xml-parser`) behind `src/grace-xml.ts`; malformed XML is
a **lint error** (P0), attributes are read structurally, and no new behaviour may depend on regex
scraping. Unknown tags produce warnings, not silent passes. Size/shape budgets are enforced.

### ADR-3 — Exit-code contract (single source of truth)
`src/grace-errors.ts`: `0` ok, `1` findings/negative result, `2` usage/config error, `3` internal error.
All commands (text and JSON, all formats) honour it. `--strict` promotes warnings to exit 1.

### ADR-4 — Ids and paths are untrusted input
All module/phase/verification ids validated against `^(M|V-M)-[A-Za-z0-9_-]+$` / `^Phase-[0-9]+[a-z]?$`
and resolved strictly inside `docs/{modules,plans,verification}`; `..`, `/`, `\`, absolute, empty and
leading-dash ids are rejected with a readable error (CLI + MCP).

### ADR-5 — Project configuration, not hardcoded layout
`mygrace.config.json` (optional; `mygrace init-dsh` writes it): `sourceDirs`, `markupExts`,
`ignoreGlobs` (default: node_modules, dist, build, vendor, .git, target), `indexCaps`, `sizeBudgets`,
`testRunner`, `commands.trusted`. Defaults reproduce current behaviour; nothing hardcodes `src/`.

### ADR-6 — Scale via sharded indexes
`graph-index.xml` keeps a flat fast path ≤ cap; when exceeded, modules are grouped into
`docs/modules/<group>/index.xml` shards, referenced from the root index (`<Shard href=... count=.../>`).
`lint`/`module list --all` follow shards transparently; `module find` stays O(index). Caps are enforced
and sharding is generated by `mygrace module shard` (wave 3). Verification index gets the same treatment.

### ADR-7 — Distribution: one package, optional plugins
The CLI ships as a **single npm package** containing all runtime sources; DSH bundle/panel/skill packages
are optional and published separately, never required by the CLI. `prepack` + `pack-smoke` gate the
release. Bun-first, Node ≥ 22.6 supported (native type stripping) — no Bun-only APIs.

### ADR-8 — Agent-first output
Every command supports `--format json` with a stable envelope `{ ok, exitCode, data, findings[], meta }`;
text mode stays human-oriented. MCP tools return compact text/JSON and never a raw stack trace.
Documented MCP names include the DSH prefix (`mcp__mygrace__<tool>`).

### ADR-9 — External tools are optional, read-only and pinned
Optional capabilities (Octocode code graph in v1.4, Archify diagrams in v1.5) run as **external
processes behind an explicit flag**, never as a required dependency of the core gates:

- **allowlist only** — `octocode` (read-only MCP tools: `graphrag`, `view_signatures`,
  `structural_search`) and `node <archify>/bin/archify.mjs` (`validate`/`deliver`); no shell, argv-only,
  scrubbed env (`PATH`/`HOME`/`TMPDIR` + explicit vars), timeouts and output caps;
- **read-only** — Octocode is never indexed or run in embedding/LLM modes; Archify only renders from
  a MyGRACE-generated IR and only from `mygrace diagram` with an explicit output path;
- **untrusted output** — external stdout/stderr is parsed as data; shape/version mismatches become
  `INTEGRATION_INVALID_OUTPUT` notes, never crashes;
- **pinned tested ranges** (`octocode >=0.29 <0.30`, `archify >=3.3 <4`) with `mygrace integrations
  status` / `doctor` showing detected vs expected versions; unsupported versions degrade with a hint;
- **degradation** — missing/broken/disabled tools produce info findings (`INTEGRATION_UNAVAILABLE`)
  and the core command keeps its deterministic output and exit code; `MYGRACE_INTEGRATIONS=off` is the
  reproducible-CI kill switch;
- **no LLM, no embeddings, no network** inside adapters (release gate G13: core gates green with
  integrations off; G14: adapter contract tests against the pinned versions).

## 5. Waves

### Wave 0 — Foundation (Lead) — ✅ **done (2026-11-22)**
`tsconfig.json` (strict); deps (`fast-xml-parser`, `yaml`, `@types/node`); `src/grace-errors.ts`
(exit codes / typed errors / envelopes), `src/grace-xml.ts` (structural parser + validation),
`src/grace-paths.ts` (safe ids), `src/grace-config.ts` (project config); `grace-common.ts` rewired
(API-compatible, still 107/107 tests); `package.json` `files` fixed (tarball now starts);
dual-runtime cleanups (`import.meta.dirname`, JSON import attributes); `scripts/pack-smoke.ts` release gate.
**Verified:** 107/107 tests, demo lint 0/0, `pack:smoke` passes (packed CLI runs, `init-dsh` from the
tarball lints clean, `install-dsh --dry-run` plans actions). Remaining typecheck errors (31) are
explicitly assigned as acceptance criteria to Wave 1 owners.

### Wave 1 — Core correctness & safety (parallel owners) — ✅ **done (v1.1.0)**
| Task | Scope | Owner |
|---|---|---|
| W1.1 Lint with teeth | `src/grace-lint.ts`, `src/grace-file.ts` — structural XML validation, field drift, path existence, DEPENDS cross-check, phase-status drift, duplicates, index/entity size budgets, generic-tag rules, `--strict`, JSON exit codes, shard awareness | core-impl |
| W1.2 Verification contract & security | `src/grace-test.ts`, `grace-verify.ts`, `grace-packet.ts`, `grace-context.ts`, `grace-status.ts`, `grace-doctor.ts` — canonical `<module-checks>`, trust record, no shell interpolation, path safety, graceful errors, JSON contract | security-impl |
| W1.3 MCP parity & runtime | `src/grace-mcp.ts`, `grace-mcp-commands.ts` — `process.execPath` launcher (no PATH dependency), schema validation of args, `path` default from cwd/workspace, stdout on failures, compact digests, 15+ tools | mcp-impl |
| W1.4 Installer hardening | `src/grace-install.ts`, `packages/**` — atomic writes, YAML validate before/after, correct backups, full uninstall, non-zero on failed step, `MYGRACE_BIN`/absolute launcher in generated row, bundle path either fixed or removed | install-impl |
| W1.5 Tests, CI, scripts | `test/**` (new integration tests), `.github/workflows/ci.yml`, `bunfig.toml`, `lefthook.yml`, `scripts/validate-marketplace.ts` → `scripts/validate-docs.ts`, `scripts/measure-context.ts` (tokenizer + sweep), `scripts/gen-example.ts` (realistic) | quality-impl |

**Gate W1 — met:** typecheck 0 errors (from 202 at audit), 461 tests / 20 files, MCP tools work with `PATH=""`,
`mygrace verify` refuses untrusted commands (exit 2), lint has 38 coded drift classes with negative tests, pack-smoke green.

### Wave 2 — Truth pass & dogfooding — ✅ **done (v1.1.0)**
- W2.1 Docs/skills/templates truth pass — ✅ validators derive counts from code and pass (at that time 16 commands / 17 MCP tools; final v1.3.0 surface is 20 / 21).
- W2.2 Dogfood — ✅ this repo has `docs/` (20 modules, 3 phases, 20 verifications), contracts in all
  `src/` files, `lint --strict` 0/0, `mygrace ci --path .` PASS, trust+verify proven.
- W2.3 Realistic demo — ✅ 3 real-logic modules with failure tests, generated deterministically
  (`gen-example --check` in CI); honest metric: lines + `ceil(bytes/4)` estimate + 12/50/200 sweep.
- W2.4 Agent-first commands — `mygrace ci` shipped early (Wave 3); `trace`/`impact`/`next` remain.

### Wave 3 — Scale & agent workflows — ✅ **done (v1.3.0)**
✅ `mygrace ci` (single gate: strict lint + status + verification coverage + trust-gated tests;
MCP `mygrace_ci`). ✅ **Index sharding** (ADR-6): `<Shard>` format, shard-transparent reads,
`mygrace module shard` generator, shard-aware lint; proven at 150 modules / 3 shards (lint 44 ms).
✅ **Multi-language proof** (G12): Python/Go fixtures for `sourceDirs`/`markupExts`/`ignoreDirs`/`testRunner`
plus a `language-matrix` CI job.
✅ **Agent-advisory commands** (v1.3.0): `mygrace trace` (requirement → module → verification → test),
`mygrace impact` (git diff / explicit files → affected modules, dependents, tests, phases),
`mygrace next` (deterministic next action), `mygrace projects` (monorepo), `lint --changed` (incremental),
plus MCP tools `mygrace_trace/impact/next/projects` (21 tools total).
✅ **Live DSH status panel**: host `GET /api/mygrace.status` + live sidebar card (opt-in `--panel`).
✅ **Release engineering**: `publish:dry` artifact gate, tag-driven `release.yml` with provenance/OIDC,
OS matrix (ubuntu/windows/macos). Publication itself is pending npm credentials/trusted-publisher setup.

### Wave 4 — Release engineering — ✅ done (GitHub Releases; npm publication cancelled 2026-11-25)
Version reset to a truthful `1.1.0` → `2.0.0` line; CHANGELOG automation; tag-driven gates and GitHub Release artifacts (npm publication intentionally not used);
publish order (single package); DSH bundle release or removal; status panel real or removed;
Windows CI matrix; docs site optional.

### Wave 5 — Optional integrations (post-1.3) — *v1.4.0 ✅ shipped (2026-11-24); v1.5.0/v1.6.0 planned*

Three companion integrations, each **optional, opt-in, read-only and degradable**; the core gates
stay deterministic, offline and dependency-free (ADR-9). Full plan: `INTEGRATION-PLAN.md`.

- **v1.4.0 — Octocode code-truth adapter** ✅ *(shipped 2026-11-24)*: `mygrace integrations`,
  `impact --code-graph`, `trace --code`. Graph-only MCP session (no embeddings/index, no network);
  new findings `CODE_EDGE_UNDECLARED` / `DECLARED_EDGE_UNUSED` / `CONTRACT_SYMBOL_MISSING`;
  core output contracts unchanged when the tool is absent (info `INTEGRATION_UNAVAILABLE`).
- **v1.5.0 — Archify diagram exporter** ✅ *(shipped 2026-11-24; architecture kind)*: deterministic typed IR from
  `docs/graph-index.xml` → validated standalone HTML + sibling IR + machine receipt
  (`mygrace diagram`, `--check`); Mermaid fallback when Archify is not installed; HTML shows a
  primary-dependency backbone (Archify clean-flow), full graph in JSON/Mermaid; workflow/tree kinds
  remain v1.5.x follow-ups.
- **v1.6.0 — SkillCache-style capsules** ✅ *(shipped 2026-11-24, experimental; read-only v1)*: allowlisted
  `mygrace` command programs with bindings, executor + state + deopt-to-skill, replay qualification,
  trust-gated hashes, 3 starter capsules, skills fast path; honest A/B metrics with a kill criterion
  (< 15 % tool-call/turn reduction → keep experimental, no claims). Shipped: capsule format +
  allowlisted program registry, replay qualification with hashes, stateful run/continue with
  judgment hand-back, deopt to the source skill, 3 capsules (`daily-check`, `after-change`,
  `module-onboarding`), MCP tools, skills fast path. Honest limitation: no token/call measurements
  are claimed yet; production gating stays `mygrace ci`.

Release gates added: **G13** core gates pass with `MYGRACE_INTEGRATIONS=off` (no tool installed);
**G14** adapter contract tests against pinned versions (Octocode 0.29.2, Archify 3.3.0).

### Wave 6 — Post-v1.6 follow-ups — *planned (full plan: `FOLLOWUP-PLAN.md`)*

- **A. npm publication** *(ops, owner-gated)*: `mygrace-cli` is still unpublished (registry 404).
  Bootstrap the first version with a one-time granular token, then switch `release.yml` to GitHub OIDC
  tag-driven gates, packed GitHub Release artifacts and registry checks were prepared, then npm publication was
  cancelled by the owner (2026-11-25): distribution stays GitHub Releases + source. Original plan note:
- **B. Octocode MCP startup** *(v1.7.1 ✅ root cause + real-binary graph verified)*: the pinned 0.29.2 and the new
  0.30.0 both hang before answering MCP `initialize` on this host; reproduce across versions/models/
  env/flags, diagnose (ONNX/models vs startup I/O), open an upstream issue with the repro, harden the
  adapter’s startup-timeout hint/docs; claim “graph verified” only after a real smoke passes.
- **C. `--kind workflow|tree` diagrams** *(v1.7.0 ✅ shipped 2026-11-24)*: validated the mapping against real Archify 3.2.0/3.3.x first (tree: parent-linked hierarchy; workflow: plan-phase lanes, columns 1–5, bottom→top edges, >5 aggregation), then shipped `--kind`, per-kind committed IRs, `--check` across all kinds and the all-kind smoke. Remaining details in the bullet below; Archify workflow (schema v1/v2: lanes,
  nodes with `col` 0–5, edges, phases) and tree (parent-linked nodes, layout) schemas; pilot real
  validation first, ship tree (low risk) and the delivery-plan workflow mapping, `--check` per kind,
  commit deterministic IRs, extend the fake/real Archify smoke and MCP `kind` enum.
- **D. Capsule measurement** *(✅ pilot executed 2026-11-25 — inconclusive; capsules stay experimental, no claims; full N=10 not justified by conflicting direction)*: harness over DSH session records
  (`tokenUsage`, `sessionStats`, `contextBreakdown`), pre-registered capsule-vs-skill A/B on 2–3 tasks,
  N=10 per arm, medians + bootstrap CI; kill criterion < 15 % tool-call/turn reduction or gate
  regression → keep capsules experimental without token/cost claims.

### Wave 7 — Guidance professionalization — *v3.2.x*

The v3.1 guidance integration is functional but not yet production-grade. Three
limitations are tracked explicitly:

| # | Limitation | Status | Acceptance |
|---|---|---|---|
| 1 | MWG was detected only as a global CLI; npx-only installs were invisible | ✅ v3.2.0 — `integrations` falls back to `npx --no-install modern-web-guidance --version` (npx cache), reports `runner: "npx"`; no network download | Detection covered by tests; no global install required |
| 2 | The external benchmark graded token usage, not artifact quality | 🟡 v3.3.0 pilot: 3 tasks × 8-check rubrics, N=1/task/arm; plain/MyGRACE 100%, MWG 95.8%; MWG 61 028 tokens vs 21 219/20 738 | Rubric still saturates two arms; N=1 too small — larger N, runtime a11y checks, second language, blinded grading |
| 3 | CLI packs/providers can use mutable `@latest`; no pin attestation | ✅ v3.3.0: `mygrace.guidance-lock.json` (local SHA-256, CLI command hash + `--version`), enforced automatically; `--lock`/`--check-lock`; plus pin warnings | Residual: server-side package mutation after lock is still trusted — attestation/signature is future work |

Wave 6→7 also adds the agent workflow: `context packet`/`focus` list configured
packs and the exact `context guidance` commands; `mygrace-execute`, `mygrace-cli`,
`AGENTS.md` and its template require agents to consult relevant packs and cite
them, without vendoring the corpus.

## 6. Release gates checklist (copy into every release PR)

- [ ] G1 pack-smoke on fresh temp dir
- [ ] G2 `bun run typecheck`
- [ ] G3 `mygrace ci --strict` on demo + on this repo
- [ ] G4 security negative tests (untrusted commands, traversal ids)
- [ ] G5 test suite + mutation ≥ 85%
- [ ] G6 MCP handshake + all tools succeed (checkout & packaged)
- [ ] G7 dogfooding green
- [ ] G8 docs validator green
- [ ] G9 metrics script reproduces documented numbers
- [ ] G10 CHANGELOG + version consistent across files
- [ ] G11 200-module synthetic: lint < 2 s
- [ ] G12 language matrix: TS + Python fixtures
- [ ] G13 core gates green with `MYGRACE_INTEGRATIONS=off` (no external tool installed; integration-specific tests auto-skip)
- [ ] G14 integration contract tests: recorded-payload/fake-MCP + fake-Archify suites in `bun test`; real-binary smokes (`bun run test:integrations --download`, `bun run test:integrations:archify`) stay manual (Octocode MCP startup issue; Archify needs an installation)
- [ ] G15 committed diagram IR is current (`bun run diagram:check`, part of `release:check`)
- [ ] G16 shipped capsules validate (`bun run capsule:validate`) and the capsule lifecycle (qualify → run → judgment → continue → deopt/drift) is covered by fake-CLI tests (part of `release:check`)

## 7. Risk register

| Risk | Mitigation |
|---|---|
| Rewriting the parser changes behaviour used by tests | API-compatible `grace-common` re-exports; parser has its own unit tests; golden fixtures |
| Concurrent refactors collide | disjoint file scopes per task, Lead owns `package.json`/`grace.ts`/`grace-common` |
| Trust model annoys CI users | `--allow-commands` + `mygrace trust` + clear error text; trust file gitignored, never committed |
| DSH API instability (0.2.1-rc.2) | integration isolated in `grace-install.ts` + optional packages; CLI has no hard DSH dependency |
| Sharding complexity leaks to users | transparent by default; `module shard` generates; single-index projects unaffected |
