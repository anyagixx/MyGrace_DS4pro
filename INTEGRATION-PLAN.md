# MyGRACE Integration Plan — Octocode · Archify · SkillCache-style capsules

Status: **v1.4.0 ✅ shipped (integrations layer + Octocode adapter), v1.5.0 ✅ shipped (Archify architecture exporter); v1.6.0 planned** · Owner: Lead
Companion documents: `ROADMAP.md` (waves), `docs/architecture.md` (invariants), `SECURITY.md`.

## 0. Executive summary

| Candidate | What it is | Verdict for MyGRACE | Release |
|---|---|---|---|
| **Octocode** (`Muvon/octocode` 0.29.2, Apache-2.0, Rust) | Code-intelligence engine: always-on tree-sitter symbol graph (imports/calls/inheritance), structural search, signatures; optional embeddings/index; CLI + MCP | **Adopt the graph-only adapter.** Fills MyGRACE's weakest link: code-level truth for `trace`/`impact` and contract↔symbol drift. No embeddings, no index, no LLM. | v1.4.0 |
| **Archify** (`tt-a1i/archify` 3.3.0 + DSH plugin 1.2.0, Apache-2.0) | Skill + zero-dependency Node CLI that turns typed JSON IR into validated, standalone interactive HTML (architecture/workflow/tree/…); built-in code diagnosis | **Adopt as deterministic diagram exporter.** MyGRACE already owns a typed graph (`docs/graph-index.xml`); render it instead of hand-drawing. Validation + atomic delivery are mandatory. | v1.5.0 |
| **SkillCache** (arXiv:2611.10022) | Paper: one-trace compilation of skill orchestration into parameterised capsules, executor-driven replay, deopt to the source skill; −74…−81 % tokens | **Adopt the ideas, not an implementation** (no public code). Build MyGRACE-native capsules restricted to allowlisted `mygrace` commands; measure honestly before shipping a default. | v1.6.0 |

**Non-negotiable invariants (they decide every design choice below):**

1. `mygrace ci` / `mygrace lint` stay **deterministic, offline and dependency-free**. Integrations are opt-in, detected at runtime, and **never required** for the core gates.
2. Any unavailable/broken/non-conforming integration degrades to **info findings + actionable hint** (`INTEGRATION_UNAVAILABLE`), never to a failure — unless the user explicitly asks for strict mode.
3. External binaries are executed **argv-only, no shell, scrubbed env, timeouts, output caps** (ADR-9). Their output is **untrusted data**; it is parsed defensively and never executed.
4. **No LLM, no embeddings, no network** inside adapters. Anything non-deterministic stays outside the gates and outside the adapters.
5. Core distribution stays lightweight: **no new runtime dependencies** in `package.json`; the existing `@modelcontextprotocol/sdk` is reused for the Octocode MCP client.
6. Every new capability is additive (minor release). The release check `bun run release:check` must pass on a machine **without** any integration installed.

---

## 1. Re-analysis (fresh facts, 2026-11-24)

### 1.1 Facts

| | Octocode | Archify | SkillCache |
|---|---|---|---|
| Kind | Rust CLI + MCP server | Agent Skill + Node CLI renderer (+ optional DSH plugin) | Research paper (35 pp., NeurIPS'26 AgenticOS workshop) |
| Version | 0.29.2 (2026-11-08) | 3.3.0 stable (2026-11-22); DSH plugin 1.2.0 | arXiv:2611.10022v1 (2026-11-05) |
| License | Apache-2.0 | Apache-2.0 (+ historical MIT) | CC BY 4.0 (paper); **no code released** |
| Footprint | 43 MB static binary; graph/lazy mode needs **no models**; index+embeddings = +1.2 GB models, 18 MB DB, ~16 min first index | npm skill bundle ~17–21 MB unpacked (3.x); repo ~1.8 GB; zero runtime deps for CLI; Node ≥18 | — |
| Interfaces | MCP (4 tools), CLI (`view`, `grep`, `graphrag`, `index`, `search`, …) | CLI (`validate`/`deliver`/`preview`/`guide`/`compare`, `--json`), typed JSON schema per diagram type | — |
| Determinism | Graph/lazy is AST-based; semantic search uses vectors; AI helpers are LLM | Renderer is deterministic given IR; authored IR is agent-produced | Compiler+executor; experimental, requires trace |
| Signed/tested for our DSH | Host-independent (MCP stdio) | Plugin 1.2.0 targets DSH **0.2.2-rc.5**; host is **0.2.1-rc.2** → compatible pin is **plugin 1.1.0** (we integrate the CLI, not the plugin, so this only affects optional direct use) | n/a |
| Integration shapes | MCP client (short-lived session) | Child process `node <skill>/bin/archify.mjs` | Our own implementation of the capsule idea |

### 1.2 What each fills, and what it does not

| Gap in MyGRACE today | Filled by | Notes |
|---|---|---|
| `impact` uses declared `DEPENDS` only; real imports/calls are unknown | Octocode graph (`get-relationships`, `find-path`, `references`) | Read-only; conservative edges; used to *enrich*, not to gate |
| `trace` proves docs→verification→tests, but not that `MODULE_MAP` symbols exist in code | Octocode `view_signatures` / `structural_search` | Warning-level by default; strict mode opt-in |
| No human-facing, explorable architecture artifact (`docs/architecture.md` is prose) | Archify architecture/workflow/tree HTML | Generated, never hand-authored → no drift |
| No coupling/cycle/hotspot diagnosis from real code | Archify Code Analysis (manual advisory) | HTML/LLM-advisory only → **not** a MyGRACE gate |
| Every session re-interprets 15 skills; orchestration tokens are paid repeatedly | SkillCache capsule model | Implemented for deterministic `mygrace` commands only; source skills remain the source of truth |

Rejected / explicitly out of scope:

- Octocode **embeddings + index** as a MyGRACE feature (1.2 GB models, non-deterministic, separate lifecycle). Document as "run Octocode separately if you want semantic search".
- Octocode `grep --rewrite` (writes source files) — never exposed through MyGRACE.
- Archify DSH plugin for our host (version mismatch + duplicate skill-root scanning warnings with our 15 skills). Optional direct use only; MyGRACE integrates the CLI renderer.
- Archify Code Analysis as a gate (non-deterministic, no machine-readable graph API).
- SkillCache's LLM compiler as shipped code (no public implementation; would introduce a second non-deterministic compiler). We implement its *architecture* (trace → capsule → replay → executor → deopt) over deterministic commands.

---

## 2. Target architecture: one integration layer, three adapters

### 2.1 ADR-9 — External tool integration contract (to be added to `ROADMAP.md` / `docs/architecture.md`)

1. **Allowlist only:** adapters may execute exactly `octocode` (graph/signature/structural read-only tools via MCP) and `node <archify-skill>/bin/archify.mjs` (validate/deliver). No other binaries, no `sh -c`, no shell interpolation.
2. **Read-only by default:** Octocode is used only in graph/structural/signature mode (never `index`, never `grep --rewrite`). Archify is invoked only from `mygrace diagram` with an explicit output path; it never runs during `lint`/`ci`.
3. **Untrusted output:** all external stdout/stderr is parsed as data. Unknown fields ignored; wrong shapes/versions → `INTEGRATION_INVALID_OUTPUT` (warning/info), adapter disabled for the command.
4. **Child process policy:** argv array, `shell: false`, cwd = project root, timeouts (`integrations.*.timeoutMs`, defaults 10 s graph / 30 s render), output cap (10 MB, same as MCP), env = `PATH`, `HOME`, `TMPDIR` + explicit vars only. For Archify set `ARCHIFY_UPDATE_CHECK_DISABLED=1` (no network). For Octocode set `RUST_LOG=error`.
5. **Version pinning:** adapters declare tested ranges (Octocode `>=0.29 <0.30`, Archify `>=3.3 <4`). Outside range → disabled with `INTEGRATION_UNSUPPORTED_VERSION` hint; `doctor` shows detected/expected.
6. **Consent:** detection is `auto` by default (binary found → used for *advisory* outputs only). Making an integration required in a specific command is explicit (`--code-graph`, `mygrace diagram`, `capsules.enabled`).
7. **No secrets, no telemetry, no network.** No environment is forwarded implicitly beyond the policy above.

### 2.2 Configuration (ADR-5 extension)

```json
"integrations": {
  "octocode": {
    "enabled": "auto",
    "bin": null,
    "versionRange": ">=0.29 <0.30",
    "timeoutMs": 10000
  },
  "archify": {
    "enabled": "auto",
    "bin": null,
    "versionRange": ">=3.3 <4",
    "timeoutMs": 30000,
    "outputDir": "docs/diagrams"
  },
  "capsules": {
    "enabled": false,
    "dir": "capsules",
    "allowMutatingPrograms": false
  }
}
```

- `enabled`: `"auto" | true | false`; `true` still degrades gracefully when the tool is missing (info finding + hint).
- Resolution order for `bin`: config → `MYGRACE_OCTOCODE_BIN` / `MYGRACE_ARCHIFY_BIN` → PATH.
- Global kill switch: `MYGRACE_INTEGRATIONS=off` (CI reproducibility; no adapter even detected).

### 2.3 New surface

| Surface | Change | Wave |
|---|---|---|
| CLI commands | `mygrace integrations status [--format json]` (new, read-only) | v1.4.0 |
| Flags | `mygrace impact --code-graph`; `mygrace trace <id> --code` | v1.4.0 |
| CLI commands | `mygrace diagram [--kind architecture|workflow|tree] [--format json|html|mermaid] [--out <file>] [--quality standard|showcase] [--check]` | v1.5.0 |
| CLI commands | `mygrace capsule list|show|run|continue|qualify` | v1.6.0 |
| MCP tools | +`mygrace_integrations` (22), +`mygrace_diagram` (23), +`mygrace_capsule_list`/`mygrace_capsule_run` (25) | per wave |
| `doctor` | new "Integrations" section: detected bins/versions/state + hints | v1.4.0 |
| Docs | README/AGENTS/skills/architecture/validators updated each wave (docs truth stays derived from code) | each wave |
| Release gates | G13 "core gates pass with integrations off/absent" and G14 "integration smoke (optional job)" | each wave |

### 2.4 Finding codes (stable, ADR-8 style)

`INTEGRATION_UNAVAILABLE` (info), `INTEGRATION_UNSUPPORTED_VERSION` (warning),
`INTEGRATION_INVALID_OUTPUT` (warning), `INTEGRATION_TIMEOUT` (warning),
`CODE_EDGE_UNDECLARED` (info), `DECLARED_EDGE_UNUSED` (info),
`CONTRACT_SYMBOL_MISSING` (warning; error under `--strict-contracts`),
`DIAGRAM_STALE` (warning, `mygrace diagram --check`),
`CAPSULE_UNQUALIFIED` (error), `CAPSULE_DRIFT` (error), `CAPSULE_DEOPT` (info).

---

## 3. Wave 5 (v1.4.0) — Octocode code-truth adapter

**Goal:** add real code relationships to the existing advisory commands without changing their
deterministic core path. Estimated effort: **4–6 days** (one implementer + reviewer + docs).

### 3.1 Interface

```bash
mygrace integrations status [--format json]        # detect + versions + capabilities + hints
mygrace impact --files src/a.ts --code-graph       # enrich blast radius with code edges
mygrace trace M-XML --code                         # verify MODULE_MAP symbols exist in code
```

### 3.2 How it works

1. `src/grace-integrations.ts` — registry: detection (config/env/PATH), `octocode --version` probe
   with timeout, range check, per-process cache, hint text, `resolveIntegration("octocode")`.
2. `src/grace-code-graph.ts` — one short-lived **MCP session**: spawn
   `octocode mcp --path <root>` (argv-only, scrubbed env), `initialize`, then read-only calls:
   `graphrag` (`get-relationships` / `find-path` / `overview`), `view_signatures`,
   `structural_search` (`references`). Close session after the command.
   - Graph is lazy/AST-based: **no index, no models, no network** (verified empirically: 5486 nodes,
     14504 relationships on this repo in <200 ms after warm-up).
   - Results cached in memory for the duration of one CLI invocation; one MCP spawn per command
     (~0.4–1 s cold).
3. Mapping:
   - `impact --code-graph`: file → module via existing `PATH`/module-dir mapping; then code
     importers/imports → module edges; output adds `codeGraph: { edges, direct, transitive, notes }`
     and findings: `CODE_EDGE_UNDECLARED` (code import exists between modules whose index
     `DEPENDS` does not declare it), `DECLARED_EDGE_UNUSED` (declared but no code edge — info only).
   - `trace --code`: read module `PATH` file(s) + signatures; for each `MODULE_MAP` entry, resolve a
     symbol; add chain section `symbols: [{name, kind, found, file}]` and
     `CONTRACT_SYMBOL_MISSING` warnings. Optional `--strict-contracts` promotes to error (exit 1).
4. Exit codes: unchanged. Enrichment findings are info/warning; only `--strict-contracts` can fail.
   Without Octocode: info `INTEGRATION_UNAVAILABLE` + hint, output identical to today's.
5. MCP: new `mygrace_integrations`; `mygrace_impact`/`mygrace_trace` gain optional boolean
   `codeGraph` / `code` (schemas updated, catalog count 21 → 22).

### 3.3 Tests / acceptance

- Unit: recorded JSON fixtures (`test/fixtures/octocode/*.json`) → mapping, findings, dedupe, ordering.
- Contract: optional `bun run test:integrations` — if `octocode` is on PATH (pinned 0.29.x), run the
  real MCP session on `examples/demo-store` and on this repo; skip with a clear message otherwise.
- Negative: missing binary, wrong version string, timeout, malformed JSON, non-project root.
- Acceptance: (a) `bun test` and `release:check` green **without** Octocode; (b) `impact --code-graph`
  on this repo finds the known importers of `src/grace-lint.ts` (`grace-ci/doctor/file`) and reports
  at least one genuine `CODE_EDGE_UNDECLARED`/`DECLARED_EDGE_UNUSED` candidate for review;
  (c) `trace M-XML --code` resolves ≥ 80 % of `MODULE_MAP` symbols on the demo project;
  (d) command latency < 2 s for a 25-module repo; (e) no network calls (verified with a black-hole
  proxy env in the contract test).

---

## 4. Wave 6 (v1.5.0) — Archify diagram exporter

**Goal:** make the machine graph human-explorable: deterministic IR from `docs/`, validated and
delivered as standalone HTML. Estimated effort: **3–5 days**.

### 4.1 Interface

```bash
mygrace diagram --kind architecture --format html [--out docs/diagrams/architecture.html]
mygrace diagram --kind architecture --format json        # IR only (works without Archify)
mygrace diagram --kind workflow --format mermaid         # dependency-free fallback
mygrace diagram --check                                  # regenerate + compare committed IR
```

### 4.2 Mapping (MyGRACE → Archify `architecture` JSON)

| MyGRACE | Archify IR |
|---|---|
| module id/name/type/status/path | `components[]` (`id`, `name`, `meta` labels, grouping hint) |
| index `DEPENDS` | `connections[]` (directed, `kind: "depends"`) |
| `sourceDirs` / module `TYPE` | `boundaries[]` (groups) |
| verification ref + priority/status + test files/checks | `cards[]` (per-component evidence summary) |
| lint findings per file | component badge / card counts |
| graph sha256 + tool versions + date | `meta` (title, source note, receipt fields) |

Pipeline: `docs` → IR → (if Archify available) `validate --json` → on pass `deliver --json` →
atomic HTML + sibling `.json` IR + `*.receipt.json` (our ADR-8 envelope: graph sha256, counts,
Archify version, rule codes, timestamp, git commit when available). On validation failure: keep the
last good artifact (Archify's own atomic-delivery guarantee), print the repair receipt, exit 1.
Without Archify: JSON/mermaid modes only; `INTEGRATION_UNAVAILABLE` info + hint (never a failure
for `--format json|mermaid`).

Artifacts policy: commit the **IR** (small, deterministic, reviewable; `--check` in CI optional);
generate HTML on demand (gitignored) or attach it to releases. No hand-editing of generated files.

### 4.3 Tests / acceptance

- Golden IR for `examples/demo-store` and this repo (sorted, stable serialisation; same sha256 on
  repeated runs and across machines).
- Schema conformance against the pinned Archify `architecture.schema.json` (bundled fixture copy,
  Apache-2.0 notice) in unit tests; optional real-binary validation in `test:integrations`.
- `--check` fails when the committed IR is stale; `mygrace ci` untouched by design.
- Acceptance: deterministic output, validation passes for `--quality standard` on the demo project,
  HTML opens offline and links back to module docs; core gates green without Archify.

---

## 5. Wave 7 (v1.6.0) — capsules (SkillCache ideas, MyGRACE-native)

**Goal:** compile recurring *MyGRACE orchestration* into replayable capsules while keeping the skills
as the source of truth. Estimated effort: **2–3 weeks**; feature is experimental, off by default.

### 5.1 Non-goals

- No arbitrary shell/code steps: **programs are allowlisted `mygrace` command templates only.**
- No LLM compiler in the product. Capsules are authored/qualified in-repo (like verification files);
  an agent may propose them, but they are reviewed and hashed like any trust-gated command.
- No mutating programs in v1 (`trust`, `install-dsh`, writes outside `.mygrace/` are not allowed).
- No replacement of skills; on any deopt the source skill runs exactly as today.

### 5.2 Capsule spec (typed, schema-validated)

```json
{
  "schemaVersion": 1,
  "name": "after-change",
  "description": "Post-edit gate: incremental lint → CI → impact summary.",
  "appliesWhen": { "changedFiles": ">=1" },
  "bindings": {
    "root": { "from": "workspace" },
    "files": { "from": "changedFiles" }
  },
  "steps": [
    { "program": "lint-changed" },
    { "program": "ci" },
    { "program": "impact", "bind": { "files": "$files" } },
    { "judge": "Read the impact/findings and decide whether to fix", "skill": "mygrace-fix" }
  ],
  "postconditions": [{ "program": "ci", "expect": { "exitCode": 0 } }],
  "qualified": { "sha256": "<hash>", "fixture": "examples/demo-store", "at": "<date>" }
}
```

Programs are an enum mapped to argv templates with typed arguments; the executor refuses anything
outside the enum, inside protected paths, or with `--allow-commands`-class mutations.

### 5.3 Executor protocol (paper-inspired, deterministic core)

- `mygrace capsule run <name> [--json]`: validates the capsule, runs programs back-to-back, passes
  JSON outputs through bindings, stops at `judge` steps and returns control with a state file
  (`.mygrace/capsules/<run-id>.json`, gitignored).
- `mygrace capsule continue <run-id> --bindings '<json>'` resumes after judgments; idempotent.
- Deopt: a failed program returns `CAPSULE_DEOPT` with stdout/stderr + the source skill name; the
  rest of the plan is not forced — the agent resumes with the skill (paper's rule).
- Qualification gates: (1) schema/dataflow validation (bindings read before write, allowlist only);
  (2) dry-run/read-only check (no mutating program unless `allowMutatingPrograms`); (3) replay on
  `examples/demo-store`/fixtures with all postconditions passing. A shipped capsule must be
  `qualified` and its file hash recorded in `.mygrace/trust.json` (same trust mechanism as
  `<module-checks>`).

### 5.4 Starter capsules (shipped, qualified)

1. `daily-check`: `status → lint → ci → next`
2. `after-change`: `lint --changed → ci → impact`
3. `module-onboarding`: `status → trace --code → packet → focus`

### 5.5 Skills integration

`mygrace-status`, `mygrace-execute`, `mygrace-reviewer` get a "fast path" section: if a qualified
capsule matches, start it with `capsule run`; otherwise follow the prose procedure. On deopt, fall
back to the existing skill instructions unchanged (skills remain canonical).

### 5.6 Metrics and kill criteria

Measure with a controlled A/B (10–15 repetitions on `examples/demo-store` + one larger fixture):
tool calls, agent turns, wall time, context bytes read (existing `measure-context` instrumentation),
gate pass rate. **Kill criterion:** < 15 % reduction in tool calls/turns or any regression in gate
pass rate → keep the model documented as experimental, do not advertise; **no token-savings claims**
(consistent with the honest-metrics rule).

---

## 6. Cross-cutting work

| Work | Detail | Wave |
|---|---|---|
| ADR-9 | External tool contract (above) in `ROADMAP.md` + `docs/architecture.md` | v1.4 |
| ADR-10 | Capsule execution model + trust integration | v1.6 |
| Config schema | `integrations.*` in `mygrace.config.json` + docs + tests | v1.4 |
| MCP catalog | +4 tools over three waves; README/AGENTS/skills counts derived | each |
| Validators | docs truth: new commands/flags/tools documented; counts auto-checked | each |
| CI | unit tests use fixtures only; `test:integrations` optional; new non-blocking job `integrations-smoke` (pinned Octocode binary download + pinned Archify skill) | each |
| Release gates | **G13**: core gates pass with `MYGRACE_INTEGRATIONS=off`; **G14**: adapter contract tests with pinned versions | each |
| Security | `SECURITY.md`: external-tool section (allowlist, read-only, no network, version pins) | v1.4 |
| Packaging | no new runtime deps; `files` unchanged; `install-dsh` untouched | — |
| Docs | README "Optional integrations", `mygrace-cli`/`mygrace-explainer` skills, `docs/architecture.md` data-flow — honest limits included | each |

---

## 7. Delivery schedule, ownership, effort

| Wave | Tasks (write scopes) | Owner | Estimate |
|---|---|---|---|
| **v1.4.0** | `grace-integrations.ts` + config/doctor (`src/`); `grace-code-graph.ts` (MCP client); `impact`/`trace` flags + findings; MCP tool; fixtures/tests; README/AGENTS/skills/ADR-9; release | core-impl + mcp-impl (adapters), quality-impl (tests/CI), docs-impl (docs), security-impl (review), Lead (wiring/release) | **4–6 days** |
| **v1.5.0** | `grace-diagram.ts` (IR generator + Archify runner + receipt), mermaid fallback, `diagram` command + MCP tool, golden IR tests, docs | core-impl (generator), mcp-impl (MCP), quality-impl (golden/schema tests), docs-impl, Lead | **3–5 days** |
| **v1.6.0** | capsule spec+validator, executor/state/deopt, qualification runner, trust integration, 3 capsules, skills fast path, metrics harness, docs/ADR-10 | security-impl (trust/allowlist), core-impl (executor), mcp-impl (MCP), quality-impl (qualification/metrics), docs-impl, Lead | **2–3 weeks** |

Release discipline per wave: feature branch → tests → `release:check` (with integrations **off**) →
`test:integrations` (pinned versions, optional job) → docs truth → version bump → tag → release
notes with exact pinned external versions and honest limitations.

---

## 8. Success metrics and kill criteria

| Wave | Success | Kill / revisit |
|---|---|---|
| v1.4 Octocode | ≥ 1 real `CODE_EDGE_UNDECLARED`/`DECLARED_EDGE_UNUSED` found on this repo's own graph; contract check catches a deliberately removed export; < 2 s; no new deps | Adapter causes flakiness or > 2 s overhead → keep behind explicit flag and document as experimental only |
| v1.5 Archify | deterministic IR (same sha256), validation passes, diagram regenerated in < 2 s, zero hand-edits | Archify schema churn > 1 breaking change per quarter → pin and freeze, fallback to mermaid |
| v1.6 Capsules | ≥ 15 % fewer tool calls/turns at equal gate pass rate; deopt path never bypasses trust | < 15 % or trust complexity grows → keep experimental, no default, no marketing |

---

## 9. Open decisions (defaults chosen; change before Wave 5 starts)

1. **Artifact policy:** commit Archify IR (default) vs commit HTML too (not default).
2. **`impact --code-graph` default:** opt-in flag (default) vs on-by-default when available
   (rejected: changes existing output contracts; breaking for ADR-8 consumers).
3. **Octocode install guidance:** document `install.sh`/release tarball + exact pin 0.29.2 (default);
   do not add an automated installer in v1.4.
4. **Capsules scope in v1.6:** read-only programs only (default); mutating programs behind
   `allowMutatingPrograms` in a later release.

## 10. Appendix — pinned tested versions and commands

```text
Octocode 0.29.2 (x86_64-unknown-linux-musl asset, sha256 from the release page)
  read-only tools: graphrag{overview,get-relationships,find-path}, view_signatures, structural_search
  never used: index, search (embeddings), grep --rewrite, review/diff/explain (LLM)

Archify 3.2.0 / 3.3.x (CLI: node archify/bin/archify.mjs; Node >=18; tested with archify-dsh 1.1.0 and 1.2.0)
  commands used: validate --json, deliver --json
  env: ARCHIFY_UPDATE_CHECK_DISABLED=1
  schema: architecture.schema.json (pinned fixture copy, Apache-2.0 notice)

DSH note: this plan integrates the Archify CLI, not the DSH plugin.
  If a user also wants the plugin: our host is 0.2.1-rc.2 → pin @tt-a1i/archify-dsh@1.1.0
  (1.2.0 targets 0.2.2-rc.5); expect duplicate-skill-root warnings with our 15 skills.

SkillCache: arXiv:2611.10022v1 — no public code; only the architectural ideas are adopted
  (one-trace capsule, replay qualification, executor-driven replay, deopt to source skill).
```
