# MyGRACE Roadmap — from audit findings to a professional agent engineering harness

> Status: **v1.3.3 shipped 2026-11-24** — Waves 0–3 complete, Wave 4 ready (publication
> pending owner credentials; the pipeline is wired and gated). Baseline: v1.0.1 as audited on 2026-11-22
> (see `analysis/00-EXECUTIVE-ASSESSMENT.md` and appendices 01–04).
> Target: a tool that AI coding agents can use with confidence on software of **any complexity** —
> from a 3-module script to a 500-module monorepo, on repos you do not fully trust.
> **v1.3.3 shipped evidence:** `bun run release:check` green (typecheck 0, **639 tests / 31 files**,
> demo lint, doc-truth gates, pack-smoke), `mygrace ci --path . --tests` PASS on this repository
> (**25 modules / 4 phases / 25 verifications / 32 declared test files / 25-25 module checks**),
> full-lifecycle `npm publish --dry-run` accepted the artifact (63 files, 208 kB), and
> `bun run publish:dry` proves the publish artifact (64 files, 25 shipped src files, 114 relative imports).
> Surface: **20 CLI commands · 21 MCP tools · 15 skills**; DSH status panel reads live data. Scale proven at 150 modules / 3 shards (lint 44 ms);
> Python/Go fixtures prove the multi-language path; `mygrace trace/impact/next/projects` and
> `lint --changed` close the agent-advisory set; the DSH status panel now reads live data.

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
| G10 | Release engineering | CHANGELOG generated from conventional commits, semver policy, npm trusted publishing, publish gate = G1+G7 |
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

### Wave 4 — Release engineering — ✅ **done except publication** (pipeline ready; npm publish needs owner credentials)
Version reset to a truthful `1.1.0` → `2.0.0` line; CHANGELOG automation; npm trusted publishing;
publish order (single package); DSH bundle release or removal; status panel real or removed;
Windows CI matrix; docs site optional.

### Wave 5 — Optional integrations (post-1.3) — *planned (v1.4.0 → v1.6.0)*

Three companion integrations, each **optional, opt-in, read-only and degradable**; the core gates
stay deterministic, offline and dependency-free (ADR-9). Full plan: `INTEGRATION-PLAN.md`.

- **v1.4.0 — Octocode code-truth adapter** *(planned, 4–6 days)*: `mygrace integrations`,
  `impact --code-graph`, `trace --code`. Graph-only MCP session (no embeddings/index, no network);
  new findings `CODE_EDGE_UNDECLARED` / `DECLARED_EDGE_UNUSED` / `CONTRACT_SYMBOL_MISSING`;
  core output contracts unchanged when the tool is absent (info `INTEGRATION_UNAVAILABLE`).
- **v1.5.0 — Archify diagram exporter** *(planned, 3–5 days)*: deterministic typed IR from
  `docs/graph-index.xml` → validated standalone HTML + sibling IR + machine receipt
  (`mygrace diagram`, `--check`); Mermaid fallback when Archify is not installed.
- **v1.6.0 — SkillCache-style capsules** *(planned, experimental, 2–3 weeks)*: allowlisted
  `mygrace` command programs with bindings, executor + state + deopt-to-skill, replay qualification,
  trust-gated hashes, 3 starter capsules, skills fast path; honest A/B metrics with a kill criterion
  (< 15 % tool-call/turn reduction → keep experimental, no claims).

Release gates added: **G13** core gates pass with `MYGRACE_INTEGRATIONS=off` (no tool installed);
**G14** adapter contract tests against pinned versions (Octocode 0.29.2, Archify 3.3.0).

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

## 7. Risk register

| Risk | Mitigation |
|---|---|
| Rewriting the parser changes behaviour used by tests | API-compatible `grace-common` re-exports; parser has its own unit tests; golden fixtures |
| Concurrent refactors collide | disjoint file scopes per task, Lead owns `package.json`/`grace.ts`/`grace-common` |
| Trust model annoys CI users | `--allow-commands` + `mygrace trust` + clear error text; trust file gitignored, never committed |
| DSH API instability (0.2.1-rc.2) | integration isolated in `grace-install.ts` + optional packages; CLI has no hard DSH dependency |
| Sharding complexity leaks to users | transparent by default; `module shard` generates; single-index projects unaffected |
