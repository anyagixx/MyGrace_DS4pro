# Changelog

All notable changes to MyGRACE are recorded here. The v2 line follows
[Conventional Commits](https://www.conventionalcommits.org/): entries are
grouped by commit type and move from `[Unreleased]` into a versioned section at
release time (see `ROADMAP.md` §6, gate G10).

## [Unreleased]

Nothing yet.

## [3.6.1] — 2026-11-27

### Fixed

- Windows CI: the registry-provenance test now has a 20 s timeout. It starts a
  local `Bun.serve` fixture and performs two fetches; the default 5 s test
  timeout was too tight on the Windows runner, while the released Linux
  artifact and v3.6.0 release remained correct.

## [3.6.0] — 2026-11-27

### Verification and coverage

- **Hard coverage gate:** `bun run coverage:check` runs the suite with coverage and
  fails below 90% functions / 85% lines; wired into CI and `release:check`
  (current: 94.08% functions, 88.34% lines).
- **MCP in-process coverage:** an `InMemoryTransport` test exercises
  `createMcpServer`, `listTools`, argument validation and tool result mapping
  without a child process.
- **New module/verification entities:** extracted `M-INSTALL-FS` and
  `M-LINT-GIT`; installer/lint re-export the public API. 33 modules / 33
  verifications / 43 declared test files; trace gaps remain 0.

### Guidance

- **Registry provenance (opt-in network):** `--lock --registry` records npm
  version, `dist.integrity` and signature count; `--check-registry` re-fetches
  and reports `GUIDANCE_REGISTRY_DRIFT`. Normal retrieval stays offline; tests
  use a local registry fixture.

### Product evidence

- **Runtime accessibility:** Playwright/Chromium headless grader
  (`scripts/a11y-runtime.ts`) checks dialog open/focus/Escape, tab keyboard
  navigation and form validity; integrated into the quality benchmark.
- **N=10 blinded dialog benchmark** across plain / MyGRACE / MyGRACE+MWG arms
  with runtime grading: static mean quality 96% / 94% / 79%, runtime 3/3 all
  arms; MyGRACE used 44 641 median tokens and 14 tool calls vs plain 45 555/22;
  MWG used 81 182/45. No consistent quality gain over plain is claimed.
- **External adoption kit:** `docs/adoption.md` and an adoption-report issue
  template. No external production adoption is claimed.

### Maintainability

- `grace-install.ts` → `grace-install-fs.ts` (atomic writes/backups) and
  `grace-lint.ts` → `grace-lint-git.ts` (changed-scope resolution), both
  re-exported for compatibility.
- Coverage gate parser is a side-effect-free module with its own test.

### Remaining (Phase-5 wip)

- External production adoption and independent long-term usage evidence.
- Larger/multi-task N≥10 runtime benchmark and assistive-technology review.
- Registry provenance is metadata attestation, not cryptographic publisher
  signature verification.

## [3.5.0] — 2026-11-26

### Security

- **Production dependencies: 40 → 0 advisories.** `bun audit fix` updated the
  lockfile (`@modelcontextprotocol/sdk` 1.30.0 → 1.32.0, `zod` 4.4.3 → 4.6.6,
  express transitives), removing 1 critical, 11 high, 25 moderate and 3 low
  advisories. New `bun run audit:prod` gate (`--production --audit-level=high`)
  runs in CI and in `release:check`; the MCP stdio tests stay green.

### Release provenance

- Tag releases now produce `SHA256SUMS` next to the tarball and attach a GitHub
  build-provenance attestation (`actions/attest-build-provenance@v2`, with
  `id-token`/`attestations` permissions). Both are uploaded as workflow
  artifacts and release assets; README/CONTRIBUTING/ROADMAP claims match the
  actual workflow.

### Verification and traceability

- **All 31 module checks are scoped:** the 20 bare `<check-1>bun test</check-1>`
  entries now name their declared test files, so `mygrace verify --module M-X`
  runs only that module's tests (verified on M-XML). A policy test rejects bare
  commands in future.
- **Trace gaps: 13 → 0.** UC-007 covers the platform/tooling modules and Phase-5
  links every module to a step; a trace-link policy test enforces both.
- **Plan/next drift fixed:** Phase-4 closed, Phase-5 opened with the remaining
  product-evidence work; `mygrace next` now points at Phase-5.
- CI runs `bun test --coverage`; current coverage is **87.39% lines / 92.76%
  functions** (754→756 tests, 39 files; coverage output is reported, not a hard
  threshold yet).

### Remaining (tracked in Phase-5, status wip)

- External adoption and larger/blinded quality evidence (N≥10, browser a11y)
  require infrastructure/time outside deterministic CI; no new code claim.
- Registry-level provenance/signature for third-party CLI packs remains
  upstream-dependent.


## [3.4.0] — 2026-11-26

### Added

- **Ed25519 lock attestation + CLI package digests (C3 residual).**
  `mygrace context guidance --keygen` creates a local private key
  (`.mygrace/guidance-signing.key`) and a committed public key
  (`mygrace.guidance.pub`); `--lock --sign` signs the canonical lockfile;
  `--check-lock --require-signature` fails on a missing/invalid signature. CLI
  lock entries now also record an npx-cache package-content digest; changed
  package files are rejected (`lock-integrity`). Residual: this attests the
  signer, not registry-level publisher provenance.
- **C1 sandbox edge.** Detection through `MYGRACE_MODERN_WEB_GUIDANCE_BIN` (a
  wrapper with no global CLI/npx) is covered by a test; no network/child process.
- **C2 quality benchmark v3.** Four artifact tasks: accessible dialog (10 checks,
  including focus-trap/escape proxies), native form validation (9, including
  `aria-live`), accessible tabs (9, Home/End) and a **Python CLI** task (8).
  Pilot N=1/task/arm: plain 96.9%, MyGRACE 96.9%, MyGRACE+MWG 90%; MWG 53 785
  median tokens / 30 tools / 256 s vs plain 22 716 / 7 / 110.5 and MyGRACE
  9 018 / 5 / 42.2. Static/runtime-proxy rubrics are not browser execution;
  real browser a11y and N≥10 are explicitly out of deterministic CI scope.

### Changed

- Roadmap Wave 7: C1 and C3 closed, C2 remains an accepted deterministic-CI
  limitation with the remaining work documented.
- Docs/ADR-12 updated for keys, signatures and package digests.


## [3.3.1] — 2026-11-26

### Fixed

- Windows CI: the CLI-pack lockfile test executes a POSIX shell fixture; mark it
  POSIX-only like the other CLI-pack tests. Local-pack lock tests stay
  cross-platform. No runtime behavior changed; v3.3.0 remains valid.


## [3.3.0] — 2026-11-26

### Added

- **Guidance lockfile / integrity (C3 closed).** `mygrace context guidance --lock`
  writes `mygrace.guidance-lock.json` with local-pack SHA-256 digests and CLI
  command hashes + `--version`; when present it is enforced before retrieval
  (changed/missing packs are skipped with coded findings). `--check-lock` exits 1
  on drift. Docs and ADR-12 updated; local packs are hash-verified, CLI packs
  record command/version for audit. Residual: a mutable server-side CLI package
  can change after locking — attestation/signature remains future work.
- **Harder quality benchmark (C2, pilot).** `scripts/web-quality-benchmark.ts`
  now runs three artifact tasks (8-check dialog, native form validation,
  accessible tabs) in an empty workspace across plain/MyGRACE/MyGRACE+MWG arms.
  Pilot N=1/task/arm: plain and MyGRACE 100% mean quality, MyGRACE+MWG 95.8%;
  MyGRACE+MWG used 61 028 median tokens / 26 tools / 151 s vs plain 21 219 / 6 /
  80 s and MyGRACE 20 738 / 7 / 75.5 s. The rubric still saturates for two arms,
  so this remains a **quality signal, not a quality claim**; larger N/blinded
  grading stay in Wave 7.

### Changed

- Agent workflow: `mygrace-cli`/`mygrace-execute`, `AGENTS.md` and its template
  mention lockfile drift and review-before-relock.
- Roadmap Wave 7: limitation 1 and 3 closed; limitation 2 remains partial with a
  concrete hardening plan.


## [3.2.2] — 2026-11-26

### Fixed

- MWG npx-cache detection no longer spawns `npx`. It now reads npm's
  `_npx/<hash>/node_modules/modern-web-guidance/package.json` cache directly,
  so `integrations status`/`doctor` stay instant (the spawned probe added ~5 s
  on Windows and tripped the doctor test timeout). No network, no child process;
  `runner: "npx"` and the cached version are still reported.
- Regression test builds a fake npx cache instead of a fake npx executable, so
  the detection test runs on every platform.

No runtime API changed; v3.2.0/v3.2.1 releases stay valid.


## [3.2.1] — 2026-11-26

### Fixed

- Regenerated `packages/dsh-skill-mygrace` after the v3.2.0 skill text change
  (`mygrace-cli` guidance section); the CI generated-assets check caught the
  drift on the tag build.
- `bun run release:check` now runs `check:generated` (example + DSH skill assets)
  before pack-smoke, so local release gates catch generated drift like CI does.

No runtime behavior changed; the v3.2.0 GitHub Release stays valid and this patch
makes tag CI green.


## [3.2.0] — 2026-11-26

### Added

- **Agent guidance workflow.** `context packet`/`focus` now list configured
  guidance packs and the exact search/retrieve commands; `mygrace-execute` and
  `mygrace-cli` skills, `AGENTS.md` and its template require agents to consult
  relevant packs and cite the pack/id. Retrieved text remains untrusted; no
  corpus is vendored.
- **npx-cache detection for Modern Web Guidance (limitation 1 closed).**
  `integrations status`/`doctor` fall back to
  `npx --no-install modern-web-guidance --version` when no global binary exists,
  reporting `runner: "npx"` and the cached version without downloading anything.
- **Supply-chain pin warnings (limitation 3, partial).** Unpinned CLI specs in
  `lintProviders`/`guidancePacks` produce `LINT_PROVIDER_UNPINNED` /
  `GUIDANCE_PACK_UNPINNED`; examples and docs use pinned versions. `mygrace trust`
  continues to hash the config.
- **Web-quality benchmark pilot (limitation 2, partial).**
  `scripts/web-quality-benchmark.ts` asks plain/MyGRACE/MyGRACE+MWG agents to
  create an accessible `dialog-demo.html` and grades a six-point static rubric
  plus tokens/tools/wall. Pilot (N=2/arm): all arms scored 6/6 (rubric saturates),
  MyGRACE-only was cheapest (7 981 tokens / 5 tools / 27 s), plain 18 547 / 10 /
  73.1 s, MyGRACE+MWG 68 351 / 39 / 245.1 s. Reported honestly; quality remains
  unproven because the rubric ceiling was reached.

### Changed

- Wave 7 in `ROADMAP.md` tracks the three professionalization limitations with
  acceptance criteria; `FOLLOWUP-PLAN.md` C1–C4 mirrors them.

### Limitations

- The quality rubric is saturated at 6/6, so it cannot distinguish arms; a
  harder multi-file/a11y rubric and larger N are required before any quality
  claim.
- Pin warnings are not a lockfile/attestation: a mutable package can still change
  server-side; reviewed trust and pinned versions are the current mitigation.
- npx detection needs a cached package and a usable npx; sandboxes without npx
  fall back to the global binary/config/env path.


## [3.1.1] — 2026-11-26

### Fixed

- Windows CI: the new guidance CLI-pack and external-provider tests use POSIX
  shell fixtures; they are now skipped on `win32` like the existing POSIX-only
  tests. No runtime behavior changed; the v3.1.0 GitHub Release stays valid and
  this patch makes the tag CI green.


## [3.1.0] — 2026-11-26

### Added

- **Modern Web Guidance detection (P0).** `mygrace integrations status` and
  `mygrace doctor` now probe the optional `modern-web-guidance` CLI
  (`>=1.0 <2`) and report it with actionable hints; no new top-level command or
  MCP tool. Detection accepts config `integrations.modernWebGuidance`, the
  `MYGRACE_MODERN_WEB_GUIDANCE_BIN` env override and PATH.
- **External lint providers (ADR-11, P1).** `mygrace.config.json` may declare up
  to 16 trust-gated scanners (`lintProviders`) with `legacy-scan` or generic
  `json-findings` adapters, `{path}` command templates, `timeoutMs` and
  `failOn: error|warning|none`. They run only under the existing trust model,
  pass the dangerous-command deny list, are audited in `.mygrace/audit.log`, and
  map to coded findings. `mygrace lint`/`mygrace ci` gained
  `--allow-commands`/`--allow-unsafe-commands` (lint) and skip providers
  cleanly when unauthorized.
- **Guidance packs (ADR-12, P2).** New `mygrace context guidance "<query>"`
  command and `mygrace_context` MCP `mode: "guidance"` search/retrieve guidance
  from local markdown packs or trust-gated CLI packs implementing
  `search "<query>" --json` / `retrieve "<id>"`. Local files are path-confined;
  external text is untrusted and never executed or persisted automatically.
  Two original example packs ship in `examples/guidance-packs/`, and
  `docs/guidance-packs.md` documents the SPI.
- **Third benchmark arm.** The external express benchmark now includes a
  `grace+mwg` arm on a web-platform dialog task. Result: 31 455 median tokens /
  20 tool calls / 81.2 s vs MyGRACE-only 6 397 / 1 / 20.5 s and plain
  11 069 / 0 / 47.4 s, all keyword-correct. It is a **negative result for token
  efficiency** (quality of the resulting design was not graded); reported in
  `analysis/external-benchmark.md`.

### Docs

- README/AGENTS/architecture updated; ADR-11 and ADR-12 added; config reference
  includes `lintProviders`/`guidancePacks`; module docs M-LINT-PROVIDERS and
  M-GUIDANCE with verifications.
- Tests: 746 tests / 37 files (new lint-provider and guidance suites, MWG
  detection, MCP guidance mapping, CI provider integration).

### Limitations

- MWG detection sees a CLI on PATH/config/env; an npx-only install is not
  auto-detected (use a `guidancePacks` CLI entry or a wrapper binary).
- External providers/CLI packs are supply-chain surfaces: pin versions, review
  commands, keep the trust gate.
- The benchmark's guidance arm is small and did not demonstrate a productivity
  gain; treat guidance as quality input, not a measured token saver.


## [3.0.0] — 2026-11-25

### Breaking changes

- **CLI: 18 → 15 top-level commands.** The four lazy reader commands are grouped
  under `mygrace inspect`:
  `inspect module index|find|show|list|shard`, `inspect phase index|show`,
  `inspect verification index`, `inspect file show <path>`. No aliases; migration:
  [`docs/migrations/v3.0.md`](docs/migrations/v3.0.md). MCP tool names are
  unchanged; only their internal CLI mapping moved. Validators now resolve
  three-level commands (`inspect module index`) correctly.

### Added

- **Expanded external benchmark:** two real OSS repositories
  (expressjs/express, psf/requests), curated MyGRACE artifacts (6 modules each,
  real upstream test files), 3 tasks per repo × 2 arms × 2 reps = 24 headless
  agent sessions plus CLI measurements. CLI: 138–218 ms / 65–82 MB on both
  repos. Agent: correctness 2/2 everywhere; cost was higher with MyGRACE in 4/6
  tasks (express routing was −22 %), so the report documents a **negative
  result** for token/effort savings — no productivity claim. Harness:
  `scripts/external-benchmark.ts`; report: `analysis/external-benchmark.md`.

### Changed

- README/AGENTS/templates/skills updated to the 15-command surface; quickstart
  and migration guides kept truthful (two commands for daily work: `next`, `ci`).
- Tests: 729 tests / 35 files; docs validators, marketplace self-test and
  three-level command resolution updated.

### Limitations

- Benchmark tasks are shallow and keyword-graded; N=2/arm/task; one model/host;
  artifacts are curated for the benchmark, not produced by users. A definitive
  productivity claim needs larger N, deeper tasks and hand-curated project docs.
- The `inspect` grouping is intentionally breaking; old spellings fail.


## [2.1.0] — 2026-11-25

### Added

- **External benchmark on a real OSS repository (expressjs/express).**
  `scripts/external-benchmark.ts` clones express, generates lint-clean MyGRACE
  artifacts (6 modules from `lib/*.js` with real upstream test files) and
  measures both the CLI and agent sessions with/without the artifacts.
  CLI: `status` 169 ms / 81.5 MB, `lint --strict` 158 ms / 80.6 MB,
  `ci` 137 ms / 82.5 MB, `trace`/`context packet` ≈105 ms / ~66 MB (median,
  warm runs). Agent (N=2/arm/task, headless DSH, keyword-graded): both arms
  correct on both tasks; `res.send` lookup slightly cheaper with MyGRACE
  (6 243 vs 6 877 tokens; 5 vs 6 tool calls), routing/architecture task more
  expensive (31 812 vs 25 340; 20 vs 18). Directions conflict — reported as a
  harness + first data point, **not** a general productivity claim.
  Report: `analysis/external-benchmark.md`.
- CI fix for the v2.0.0 marketplace self-test baseline (12 skills; the control
  run previously normalized to 15).
- README "Measured performance" now links both the self-owned and external
  benchmarks.

### Limitations

- External artifacts are generated from file layout, not curated; two shallow
  tasks, one model/host, N=2 per arm/task, keyword grading only.
- The v2.0.0 tag's CI run failed on the validator self-test only; this release
  includes the fix on `main` (all gates green).
- No curated external MyGRACE adoption yet; that is the next benchmark step.


## [2.0.0] — 2026-11-25

### Breaking changes (surface consolidation)

- **CLI: 23 → 18 top-level commands.** `mygrace test` is merged into
  `mygrace verify` (always compact; full run is the default), `packet`/`focus`/
  `context-cost` moved under `mygrace context packet|focus|cost`, and
  `init-dsh`/`install-dsh`/`doctor` moved under `mygrace setup init|install|doctor`.
  There are **no deprecated aliases**; migration table:
  [`docs/migrations/v2.0.md`](docs/migrations/v2.0.md).
- **MCP: 25 → 21 tools.** `mygrace_test` → `mygrace_verify`
  (`allowUnsafeCommands` moved with it); `mygrace_packet`/`mygrace_focus`/
  `mygrace_context_cost` → `mygrace_context {mode: "packet"|"focus"|"cost"}`;
  `mygrace_list_modules` → `mygrace_find_modules` (no query lists all).
- **Skills: 15 → 12.** `mygrace-token-budget` merged into `mygrace-cli`,
  `mygrace-setup-subagents` into `mygrace-multiagent-execute`,
  `mygrace-refresh` into `mygrace-reviewer`.
- No capability was removed; behavior, trust/deny-list/audit, JSON envelopes and
  exit codes are unchanged. The public/docs validators now enforce
  18 commands / 21 tools / 12 skills.

### Changed

- Docs, AGENTS/templates, skills, quickstart, migration guide and validators
  rewritten for the smaller surface; the quickstart keeps the daily path at
  `mygrace next` and `mygrace ci`.
- Tests: **729 tests / 35 files** (MCP catalogue/mapping, CLI entry points,
  install e2e and skill provider updated); no runtime dependency changes.

### Limitations

- v2.0 is intentionally breaking: scripts pinned to the old command/tool names
  must migrate; there is no compatibility shim.
- Consolidation is not maximal: `module`/`phase`/`verification`/`file` readers
  remain separate commands; further reduction is a later major decision.
- Benchmarks and the external/agent measurement gap are unchanged from v1.8.0.


## [1.8.0] — 2026-11-25

### Added

- **Trust-model defense in depth.** Project commands matching dangerous patterns
  (privilege escalation, network/download tools, destructive removal,
  `eval`/`exec`, encoded payloads, permission changes, device writes, publishing,
  out-of-tree redirects) are refused even behind a current trust record;
  `--allow-unsafe-commands` is an explicit one-off override on `test`, `verify`,
  `ci` and the matching MCP tools. Every execution attempt and policy/shell
  refusal appends a JSONL record to `.mygrace/audit.log` (local, gitignored).
- **Trust inspection without mutation:** `mygrace trust --check` verifies the
  record, lists every declared command and warns about deny-listed declarations
  (exit 1 when missing/stale); `--revoke` deletes the local record. The MCP
  `mygrace_trust` tool exposes `check`/`revoke`.
- **Measured core-command benchmarks:** `scripts/benchmark.ts` measures
  `status`, `lint --strict` and `ci` (7 runs, GNU time) on this repository,
  `examples/demo-store` and a generated lint-clean 70-module project. Median
  `ci` ≈ 380 ms / 109 MB (29 modules) and ≈ 419 ms / 94 MB (70 modules);
  `status`/`lint` ≈ 155–260 ms. Report: `analysis/benchmark.md`; method and
  limitations are stated explicitly (no external OSS repo or agent-task claim).
- **Quickstart and surface guidance:** `docs/quickstart.md` (five-minute path and
  the two commands that matter), README/AGENTS links, measured-performance
  section, and a note that real CLI-surface consolidation is a separate,
  breaking-change task.

### Changed

- Trust contracts/docs (M-TEST, V-M-TEST, README, AGENTS, SECURITY) now describe
  the deny list, audit log and inspection commands.
- Tests: **733 tests / 35 files** (6 new trust/policy/audit/check/revoke tests);
  CLI/MCP counts unchanged (23 commands, 25 tools).

### Limitations

- The deny list is static defense in depth, **not an OS sandbox**: commands still
  run with the invoking user's privileges. Audit logging is best-effort and local.
- Benchmarks are CLI/index latency and peak RSS only, on generated/self-owned
  projects; they are not agent-task success or token-usage measurements.
- Broad surface consolidation (fewer commands/tools/skills) is **not** done here;
  the quickstart is the first step, and removing public commands would be a
  breaking-major change.


## [1.7.2] — 2026-11-25

### Changed

- **No npm publication (owner decision).** MyGRACE is distributed as GitHub
  Releases (packed `mygrace-cli-<version>.tgz`) plus the source checkout. The
  release workflow is now gate-only + artifact + GitHub Release: on a `v*` tag it
  runs `release:check` and `publish:dry`, refuses a tag/version mismatch, packs
  the tarball, uploads it as a workflow artifact and creates a GitHub Release
  with generated notes. All npm-specific machinery was removed (`NPM_TOKEN`,
  `NPM_PUBLISH_ENABLED`, trusted publishing, `verify:npm`,
  `scripts/verify-npm-release.ts`, `publishConfig`, `prepublishOnly`), and
  README/CONTRIBUTING/ROADMAP/Phase-4 state the decision.
- **Capsule evaluation executed and reported honestly.** A pre-registered pilot
  (2 tasks × 2 arms × 3 sessions, headless DSH) measured capsule vs skill-prose
  routines: `daily-check` was worse for the capsule arm on cost (+25 %) and wall
  time; `module-onboarding` showed 17.7 % lower cost but 11 % more tool calls;
  both arms passed the objective gate. The pre-registered kill criterion was not
  met, so **capsules stay experimental and no token/cost claims are made**; the
  full N=10 run was intentionally not started. Harness:
  `scripts/run-capsule-eval.ts` + `scripts/measure-capsules.ts`; report:
  `analysis/capsule-eval/report.md`.
- README/build docs mark the distribution decision explicitly; the release
  workflow no longer needs Node/npm setup or OIDC permissions.

### Removed

- npm publication steps, registry credentials path, `publishConfig`,
  `prepublishOnly` and the npm verification script (obsolete after the
  distribution decision).

### Limitations

- Distribution is tarball/source only; there is no npm one-liner and no
  auto-update channel.
- Capsule pilot is N=3 per arm/task, one model/repo/host, unblinded, with wide
  confidence intervals; it is evidence against token-savings claims, not proof
  that capsules can never help.
- No functional CLI changes in this release (23 commands, 25 MCP tools, 727 tests).


## [1.7.1] — 2026-11-25

### Changed

- **Renamed the package to the unscoped `mygrace-cli`.** `@osovv` is a
  third-party scope (the codebase this repository started from), not owned by
  this project, and nothing was ever published there. Internal workspace packages
  are now `mygrace-dsh`, `dsh-skill-mygrace` and `dsh-mygrace-rtk`; release
  assets are `mygrace-cli-<version>.tgz`. README/license attribution keeps the
  upstream GRACE credit and states explicitly that this repository is an
  independent derivative with no affiliation to the `@osovv` npm scope.
- **Octocode graph mode verified against the real binary (M-CODE-GRAPH).** The
  "MCP never answers initialize" limitation was misdiagnosed: Octocode
  initialises its local FastEmbed model before the handshake, and the default
  Jina code model is ~612 MB (downloaded before `initialize`). With a warm cache
  the session starts in ~2 s. Root cause, evidence and the small-model recipe
  are in `analysis/octocode-startup.md` and the README setup section.
- Adapter calls fixed from the real API: `graphrag` needs `node_id` and
  `format:"json"`; symbols are read from `graphrag search` nodes
  (`source_file.symbols` + symbol-node kinds). `view_signatures` is no longer
  called because the real binary returns full file text, not JSON.
  Real-binary verification on this repository: `trace --code` resolved 8/9
  MODULE_MAP entries; `impact --code-graph` produced 4 real cross-module import
  edges.
- **npm publication hardening:** new `scripts/verify-npm-release.ts`
  (`bun run verify:npm`, checks registry name/version, tarball, integrity and
  optional provenance) and a release-workflow step that verifies the published
  release after `npm publish`. Package name/owner prerequisites are documented
  in README/CONTRIBUTING/FOLLOWUP-PLAN.
- Tests: 727 tests / 35 files (fake-Octocode contract updated for the
  `graphrag search` symbols path); no CLI command/tool count changes.
- Known limitations: npm publication remains owner-gated (npm account, 2FA,
  `NPM_TOKEN` bootstrap, `NPM_PUBLISH_ENABLED`); `trace --code` may report a
  symbol as not found when Octocode's source-file inventory omits an exported
  const (8/9 in this repo, honestly reported); Octocode 0.29.x and 0.30 cannot
  share a config file (v4 vs v3).


## [1.7.0] — 2026-11-24

### Added

- **Three diagram kinds (`mygrace diagram --kind architecture|workflow|tree`).**
  - `architecture` (unchanged): module graph with the legible primary-dependency
    backbone; full graph in JSON/Mermaid.
  - `tree` (new): parent-linked capability hierarchy — project → module `TYPE`
    groups → modules; deterministic layout, no edges.
  - `workflow` (new): the delivery plan — one swimlane per `docs/plans/Phase-*.xml`,
    one node per phase in columns 1–5 (phases beyond five are aggregated into the
    last node and called out in the cards), sequential edges routed
    `fromSide: bottom` → `toSide: top`. Mapping was validated against the real
    Archify CLI (3.2.0 and 3.3.x) before implementation; both kinds validate and
    deliver cleanly.
- Committed deterministic IRs for all three kinds
  (`docs/diagrams/architecture.json`, `tree.json`, `workflow.json`); `--check`
  now verifies **every existing committed kind** (release gate covers all three),
  and `--check --kind …` limits the check to one.
- `--format json` carries the kind-specific IR (`data.ir`), dependencies only for
  architecture; Mermaid stays architecture-only with an explicit usage error for
  tree/workflow; HTML/receipts are per-kind and route through the same Archify
  validate/deliver path.
- MCP `mygrace_diagram` accepts `architecture|workflow|tree`; the fake-Archify
  contract tests cover validate/deliver/receipt for the new kinds, and
  `bun run test:integrations:archify` now smokes **all three kinds** against a
  real binary (manual).
- 6 new diagram tests (727 tests / 35 files total); docs/README/AGENTS/skills
  describe the three kinds and their mapping rules.

### Changed

- `docs/diagrams/*.json` now includes `tree.json` and `workflow.json`; HTML and
  receipts remain gitignored. CLI/MCP counts are unchanged (23 commands, 25 tools).

### Limitations

- Workflow shows at most five phases; later phases are aggregated into the last
  node with an explicit note (Archify columns are capped at 0–5).
- Tree groups modules by capability `TYPE`, not by source-directory nesting.
- Mermaid output is architecture-only; tree/workflow use JSON or HTML.
- HTML still requires the optional Archify CLI; JSON/IR and `--check` stay
  offline and deterministic.


## [1.6.0] — 2026-11-24

### Added

- **Capsule routines (`mygrace capsule`, ADR-10, experimental).** Typed capsule
  files compile recurring read-only orchestration into an allowlisted sequence of
  `mygrace` programs (`status`, `lint`, `lint-changed`, `ci`, `next`, `impact`,
  `trace`, `packet`, `focus`) plus optional judgment steps:
  `list`/`show`/`validate`/`qualify`/`run`/`continue`. A failed program **deopts**
  to the capsule's `source_skill`; a judgment step persists state in
  `.mygrace/capsules/state/` and hands control back with a continue id.
- **Replay qualification with hashes:** `capsule qualify --fixture <project>`
  executes every program through the real child-process path and records the
  capsule sha256 in `.mygrace/capsules/qualifications.json`; editing a capsule
  invalidates the record and `run` refuses until re-qualified
  (`--allow-unqualified` is development-only). Programs and bindings are strict:
  no shell, no env-sourced values, only explicit `--module`/`--files`.
- **Three shipped capsules:** `daily-check`, `after-change` (with a judgment to
  `mygrace-fix`) and `module-onboarding` (binding `--module M-XXX`).
- **MCP surface:** `mygrace_capsule_list` and `mygrace_capsule_run`
  (25 tools total); skills `mygrace-status`, `mygrace-reviewer` and
  `mygrace-execute` gained a capsule fast path with deopt fallback.
- **Dogfood modules** `M-CAPSULE` + `V-M-CAPSULE`, 17 new tests with a fake
  `MYGRACE_BIN` (validation, qualification, run/continue, deopt, drift,
  bindings, disabled config); repo config enables capsules for dogfooding while
  generated configs keep `integrations.capsules.enabled=false`.
- **`mygrace diagram --format json --out <html>`** now also refreshes the
  committed IR without Archify, so the `diagram --check` gate is maintainable on
  machines without the optional renderer.
- `release:check` now validates the shipped capsules (`capsule validate`) in
  addition to the diagram IR check.

### Changed

- README/AGENTS/skills/architecture document 23 CLI commands and 25 MCP tools.

### Limitations

- Capsules are **experimental**: no token-savings claims, read-only programs
  only. A production quality gate still needs `mygrace ci`; capsules reduce
  repeated orchestration, they do not replace verification.
- Qualification is local per project (`.mygrace/`, gitignored); there is no
  retrieval/invalidation/security layer from the SkillCache paper in v1.6.0.
- Diagram kinds `workflow`/`tree` and the Octocode 0.29.2 MCP-startup limitation
  from v1.4.0 remain follow-ups.


## [1.5.0] — 2026-11-24

### Added

- **Archify diagram exporter (`mygrace diagram`).** The docs graph renders itself:
  deterministic architecture IR (`--format json`), a dependency-free Mermaid
  flowchart (`--format mermaid`, full declared graph), and standalone HTML
  (`--format html`) through the optional Archify CLI (`validate` → `deliver`),
  with a machine receipt (graph sha256, declared/depicted counts, Archify
  validation) and a `--check` staleness gate for the committed IR.
- **`mygrace_diagram` MCP tool** (23 tools total) and diagram counts in README,
  AGENTS, skills and architecture docs; new dogfood modules `M-DIAGRAM` with
  `V-M-DIAGRAM` (13 tests, fake Archify CLI; no real Archify needed for tests).
- **Diagram artifacts policy:** the deterministic IR is committed at
  `docs/diagrams/architecture.json` and guarded by `bun run diagram:check`
  (also part of `release:check`); HTML, Archify delivery receipts and our
  receipt stay local/gitignored.
- **Archify integration smoke** (`bun run test:integrations:archify`) and
  `integrations.archify.versionRange` re-pinned to `>=3.2 <4` after validating
  the IR against Archify CLI 3.2.0 (bundled in `@tt-a1i/archify-dsh@1.1.0`) and
  3.3.x (1.2.0).
- **Layout honesty:** Archify's clean-flow validator cannot route a dense
  27-module graph without edge/node collisions, so the HTML shows a legible
  primary-dependency backbone (one edge per module, placed by dependency depth);
  JSON/Mermaid output and the diagram cards always carry the full declared
  dependency list (113 edges on this repository: 26 drawn, 113 available).

### Changed

- `mygrace ci` (and therefore `release:check`) now verifies that the committed
  diagram IR matches the current docs graph.
- README/AGENTS/skills/architecture document 22 CLI commands and 23 MCP tools.

### Limitations

- Diagram kinds `workflow` and `tree` remain follow-ups (v1.5.x); v1.5.0 ships
  `--kind architecture`.
- The Octocode 0.29.2 MCP-startup limitation from v1.4.0 is unchanged; the
  Octocode adapter contract stays covered by recorded-payload/fake-server tests.
- Real-binary diagram smoke is manual (`test:integrations:archify`) because it
  needs an Archify installation; the fake-CLI contract runs in `bun test`.


## [1.4.0] — 2026-11-24

### Added

- **Optional integrations layer (ADR-9).** Core gates stay deterministic, offline and
  dependency-free; external tools are detected, version-pinned and read-only. New
  `mygrace integrations status [--format json]` command, `integrations.*` block in
  `mygrace.config.json`, `MYGRACE_INTEGRATIONS=off` kill switch, and findings
  `INTEGRATION_UNAVAILABLE` / `INTEGRATION_UNSUPPORTED_VERSION` (info by default,
  warning when `enabled: true`). Missing or broken tools never change a core
  command's output or exit code.
- **Octocode code-graph adapter (v1.4).** `mygrace impact --code-graph` adds real
  file-level import edges and flags `CODE_EDGE_UNDECLARED` / `DECLARED_EDGE_UNUSED`
  (info-only); `mygrace trace <ID> --code [--strict-contracts]` verifies `MODULE_MAP`
  entries against real symbols and reports `CONTRACT_SYMBOL_MISSING`. The adapter
  uses one short-lived read-only MCP session (`graphrag`, `view_signatures`), a
  scrubbed child environment, timeouts and output caps; graph/structural mode needs
  no index, embeddings or network.
- **MCP surface:** `mygrace_integrations` tool (22 tools total) plus optional
  `codeGraph` / `code` arguments on `mygrace_impact` / `mygrace_trace`.
- **Doctor** reports an "Integrations (optional)" row (versions, source, ranges);
  only actionable required-tool problems can affect the exit code.
- **Dogfood modules** `M-INTEGRATIONS` and `M-CODE-GRAPH` with verification
  files, indexes and 40+ new tests (recorded payloads + fake MCP server; no real
  Octocode required for the test suite).
- **Manual contract smoke:** `bun run test:integrations [--download]`
  (pinned Octocode 0.29.2, graph mode) and `bun run release:check` evidence.

### Changed

- README, AGENTS.md, `mygrace-cli` skill and `docs/architecture.md` document the
  21-command / 22-tool surface, the integrations contract and its limits.
- CI gains the fixture/fake-MCP contract coverage by default; the real-binary
  smoke job is intentionally **not** a CI gate in this release (see Limitations).

### Limitations

- The real-binary contract for Octocode 0.29.2 is **unverified on our dev host**:
  the pinned Linux binary starts but did not answer MCP `initialize` (CLI
  `graphrag` likewise), so the adapter's MCP contract is proven by recorded-payload
  and fake-server tests, and `test:integrations` remains a manual smoke until the
  upstream issue is understood.
- Archify is detection-only in v1.4.0; the deterministic diagram exporter is
  planned for v1.5.0 (`mygrace diagram`).
- SkillCache-style capsules remain planned/experimental (v1.6.0); nothing is
  claimed beyond the paper's cited numbers.


## [1.3.3] — 2026-11-24

### Fixed

- **The status panel follows the active DSH session on a fresh start.** When no
  project was remembered yet (no MyGRACE MCP call since the harness started) and
  the harness was launched outside a project, the card now resolves the workspace
  from the newest DSH session record
  (`$DSH_HOME/storages/session_projcache/sessions/*.json`) before falling back to
  `cwd`, instead of showing "No MyGRACE project found".

## [1.3.2] — 2026-11-24

### Changed

- **MyGRACE follows the session workspace from any launch directory.** The MCP
  server instructions now require an explicit `path` (the absolute workspace
  root) because the harness starts the server in its launch directory, not the
  project; the server also remembers the last valid project root in
  `~/.mygrace/active-project` (override: `MYGRACE_ACTIVE_PROJECT_FILE`) and falls
  back to it when `path` is omitted. The LIVE status panel uses the same
  remembered root before walking up from its own cwd, so `dsh web` no longer has
  to be started inside the project.

## [1.3.1] — 2026-11-23

Windows/CRLF correctness and CI portability; publication is now opt-in in the
release pipeline. Supersedes v1.3.0 (no CLI/JSON contract changes).

### Fixed

- **CRLF checkouts no longer break contract validation.** On Windows (git
  `core.autocrlf`) the analysis normalises line endings before parsing, so
  `MODULE_CONTRACT` fields (`PURPOSE`/`SCOPE`/`DEPENDS`/`LINKS`) and block
  markers are detected exactly as on LF checkouts — previously they were
  reported as `CONTRACT_FIELD_MISSING` warnings and `mygrace ci` failed.
- **Test suite is portable.** Native path separators are used in expectations
  (no hardcoded `/p` or concatenated `/fixtures` paths), launch/location
  assertions normalise separators, the C-5 trust fixtures execute a portable
  bun script instead of a POSIX `#!/bin/sh` script, and the genuinely POSIX-only
  cases (file-mode bits, `sh`-shim package managers, the real-DSH composition
  smoke) are skipped on Windows with a documented reason. The `os-matrix` CI job
  (ubuntu/windows/macos) is green.

### Changed

- **Release publishing is opt-in.** `release.yml` now publishes npm only when the
  repository variable `NPM_PUBLISH_ENABLED=true` is set (after configuring npm
  trusted publishing or the `NPM_TOKEN` fallback). Tag pushes before that run
  every gate, print a "publish skipped" notice and stay green — no red release
  run just because credentials are not set up yet. `CONTRIBUTING.md` documents
  the one-time setup.
- Version bumped to 1.3.1 across `package.json`, README, marketplace/plugin
  manifests and the issue template.

## [1.3.0] — 2026-11-22

Agent-advisory commands, incremental/monorepo workflows, the real status panel,
and a publish-ready release pipeline. Closes what remained of Waves 3–4.

### Added

- **`mygrace trace <ID>`** (ADR-8 JSON + text) — the traceability chain for a module or verification:
  module contract → verification file → test files (existence, line counts) → declared command
  provenance (`verification` → deprecated `module` → `config` → `default`) → requirement links →
  plan phases → dependents (direct + transitive). Coded gaps: `MISSING_VERIFICATION_REF`,
  `VERIFICATION_FILE_MISSING`, `TEST_FILE_MISSING`, `MODULE_PATH_MISSING` (errors),
  `NO_DECLARED_COMMAND`, `NO_REQUIREMENT_LINK`, `NO_PHASE_LINK` (info), plus `MODULE_FILE_MISSING`
  and `XML_INVALID`. Exit 1 on errors, 0 on info-only, 2 on usage. Never executes anything.
- **`mygrace impact [--files|--staged|--since]`** — maps changed files (git or explicit list) to direct
  modules (exact PATH, module directory, docs-entity edits), transitive dependents, the verification
  blast radius (test files), affected phases, and trust-aware suggested commands. Info-only findings;
  exit 2 only for unusable input.
- **`mygrace next`** — deterministic advice ladder for agents: `INIT_PROJECT` → `FIX_INDEX` →
  `FIX_LINT_ERRORS` → `ADD_VERIFICATION_COVERAGE` → `TRUST_COMMANDS` → `VERIFY_MODULE` →
  `REFRESH_WARNINGS` → `NEXT_PHASE`/`NOTHING_TO_DO`; text (`NEXT/WHY/RUN/IDS/CODE`) + JSON. Advice
  never fails a build (exit 0; 2 only for usage/config).
- **`mygrace projects`** — bounded monorepo discovery (BFS for `docs/graph-index.xml`, depth/cap limits
  with `truncated`, config ignores): per-project counts, lint, verification coverage, status; totals and
  aggregated findings; exit 0 clean / 1 findings / `--strict` promotes warnings.
- **`mygrace lint --changed [--base <ref>] [--files …]`** — incremental lint: git diff (default `HEAD`)
  plus untracked files, or an explicit list without git; index changes run full index checks, entity
  changes report that entity, source changes report only their markup; adds
  `Scope: N changed file(s) (scanned, skipped)` and `data.scope` in JSON.
- **4 new MCP tools** (17 → 21): `mygrace_trace`, `mygrace_impact`, `mygrace_next`, `mygrace_projects`
  (single catalog, schema validation, document-relative JSON output).
- **LIVE DSH status panel** (`install-dsh --panel`): the host plugin registers `GET /api/mygrace.status`
  through the DSH `connection` service (disposed with the plugin, `cache-control: no-store`, 5 s timeout,
  always `200` JSON), computes data from `mygrace status --format json` via `MYGRACE_BIN` /
  `$DSH_HOME/mygrace/bin/mygrace`, and the browser card fetches `api/mygrace.status` on mount, every 30 s
  and on `visibilitychange` (counts, lint/trust badges, freshness, graceful "not connected" state).
- **Release engineering**: `scripts/publish-dry-run.ts` artifact gate (pack → manifest checks → static
  import completeness via `Bun.Transpiler.scanImports` → packaged CLI smoke → offline install),
  `.github/workflows/release.yml` (tag `v*`, release gates, `npm publish --provenance --access public`,
  OIDC trusted publishing preferred with `NPM_TOKEN` fallback, dry-run input), and an OS matrix CI job
  (`ubuntu`/`windows`/`macos`). `publish:dry` and `release:full` scripts added.

### Changed

- The status-panel card is no longer decorative: docs, installer messages and package README describe the
  live data path and its prerequisites (opt-in `--panel`, package still an unpublished preview).
- Dogfood graph grows to 25 modules / 3 phases / 25 verifications; new module docs and verification
  entries for trace/impact/next/projects; phase plans updated to reflect completed waves.
- Release gate chain unchanged for authors (`release:check`) and publish-ready for CI (`release:full`).

### Fixed

- Test fixture declares its verification test files (real tests for the `mygrace-project` fixture) so
  `mygrace projects` reports it clean.
- `scripts/validate-marketplace.ts` accepts npm's normalised `bin` path spelling (`src/grace.ts`).

## [1.2.0] — 2026-11-22

Scale and portability wave: index sharding for 200+ modules, and a proven,
config-driven multi-language path.

### Added

- **Sharded indexes (ADR-6, gate G11).** A root `docs/graph-index.xml` may reference
  `<Shard href="modules/shard-<slug>.xml" count="N" />` files; every reader is shard-transparent.
  New module `src/grace-shard.ts` (M-SHARD) with `loadGraphIndex` (lenient, coded findings),
  `loadGraphIndexStrict` (typed throw for CLI paths) and the shard planner/applier.
- **`mygrace module shard [--group-by type|status|prefix] [--apply | --dry-run] [--format text|json]`** —
  dry-run by default (writes nothing); `--apply` groups deterministically, writes
  `docs/modules/shard-<slug>.xml`, rewrites the root index atomically, keeps a timestamped backup
  under `.mygrace/backups/shard-<ISO>/`, removes stale generated shards and is byte-identical on re-run.
- **Shard-aware lint** — `PATH_UNSAFE`, `SHARD_FILE_MISSING`, `SHARD_ROOT_INVALID`,
  `SHARD_COUNT_MISMATCH` (root-ref *and* shard-root counts), cross-shard `DUPLICATE_INDEX_ENTRY`,
  per-shard `INDEX_TOO_LARGE`, plus all existing drift/orphan checks applied to the union.
- **Multi-language proof (gate G12)** — `test/grace-language.test.ts` proves Python and Go layouts:
  `sourceDirs`/`markupExts`/`ignoreDirs` are honoured (ignored trees are never scanned),
  `#`, `//`, `--`, `/*`, `<!--` markup dialects parse, non-TypeScript module `PATH`s resolve, and the
  configured `testRunner` flows through planning, trust gating and execution. New `language-matrix`
  CI job (Python 3.11/3.13).
- `mygrace init-dsh` now creates (or annotates) a `.gitignore` so the ADR-1 trust record is never
  committed; dedicated `test/grace-init.test.ts` covers create/skip/`--force`/gitignore behaviour.

### Changed

- Module resolution in `test`, `verify`, `packet`, `focus`, `context-cost`, `status`, `ci` and the MCP
  tools reads the sharded union; `module show` intentionally still reads the entity file directly, and
  `module index` prints a shard summary.
- Dogfooded on this repository: 21 modules / 3 phases / 21 verifications / 27 declared test files,
  `lint --strict` 0/0 and `ci --tests` 21/21 passing; architecture/docs updated for M-SHARD.
- Release gate now includes the repository's own `mygrace ci` (`bun run check`).

### Fixed

- Shard structural errors no longer mask duplicate-id detection (both are reported independently).

## [1.1.0] — 2026-11-22

First release after the full audit (`analysis/00-EXECUTIVE-ASSESSMENT.md`):
packaging, security, enforcement and documentation rebuilt around verifiable gates.
Release gates: `bun run release:check` (typecheck, tests, demo lint, doc truth
checks, pack-smoke) plus `mygrace ci --path .` on this repository.

### Added

- `mygrace trust` — review project-declared commands and record their sha256 hashes in `.mygrace/trust.json` (gitignored local state).
- `mygrace ci` — one-command quality gate: strict lint + status + verification coverage; `--tests` adds trust-gated scoped test runs.
- MCP server: single tool catalogue (17 tools, including `mygrace_trust` and `mygrace_ci`), schema validation of arguments, no `PATH` dependency, failure output passed through, configurable timeout.
- Project configuration `mygrace.config.json` (`sourceDirs`, `markupExts`, `ignoreDirs`, `indexCaps`, `sizeBudgets`, `testRunner`, `allowCommands`, `language`); `mygrace init-dsh` writes it.
- Foundation modules: strict XML layer (`grace-xml.ts`), typed errors/exit codes and JSON envelope (`grace-errors.ts`), id/path validation (`grace-paths.ts`), config (`grace-config.ts`).
- Truth gates and CI: `scripts/validate-docs.ts`, rewritten `scripts/validate-marketplace.ts`, `scripts/pack-smoke.ts`, `.github/workflows/ci.yml`, `lefthook.yml`, `bunfig.toml`.
- Project hygiene docs: `SECURITY.md`, `CONTRIBUTING.md`, `docs/architecture.md`, issue and pull-request templates.

### Changed

- CLI surface: 16 top-level commands; all verification-ish commands honour one exit-code contract (0 ok, 1 findings, 2 usage/config/trust, 3 internal) and emit the `{ ok, exitCode, data, findings[], meta }` envelope in `--format json` mode.
- `<module-checks>` is canonical in `docs/verification/V-M-XXX.xml`; reading it from a module file is a deprecated fallback.
- `mygrace lint` now enforces structural XML validity, full index/entity field drift, duplicates, missing `PATH`/`DEPENDS`/`VERIFICATION_REF` targets, phase status/steps drift, index caps, entity size budgets and markup/contract fields; `--strict` makes warnings fail.
- `mygrace install-dsh` writes YAML-validated atomic patch edits with timestamped backups, a PATH-free MCP row, a generated launcher/state under `$DSH_HOME/mygrace/`, and a byte-identical uninstall; `--panel` installs the decorative sidebar placeholder only when explicitly requested.
- `scripts/measure-context.ts` is an honest line/byte metric with a documented `ceil(bytes/4)` token **estimate** and a 12/50/200-module sweep; docs no longer claim measured "token savings".
- README, `AGENTS.md`, templates, skills, `rules/*`, `extensions/*`, `plugins/*`, `.claude-plugin/marketplace.json` and `openpackage.yml` were rewritten to match the implemented surface (16 commands, 17 MCP tools, 15 skills, trust model, canonical command source, project config).

### Fixed

- Project commands no longer execute without an explicit trust decision (`.mygrace/trust.json`, `config.allowCommands` or `--allow-commands`); argv-only execution, shell-style commands need an additional opt-in, and `<test-files>` entries are validated against traversal and flag injection.
- MCP calls work from a plain checkout and with `PATH=""`; unknown/invalid tool arguments return a structured error instead of reaching the CLI.
- Malformed project XML is reported with line/column instead of being silently ignored; all readers use the structural parser.
- The packaged tarball contains every runtime module and the packaged CLI is exercised by `pack:smoke` (gate G1).

### Removed

- `install-dsh --bundle` (now a stub that explains and exits 2); the DSH bundle is an unpublished preview, not a supported install path.
- Legacy monolithic templates (`knowledge-graph.xml`, `development-plan.xml`, `verification-plan.xml`) and the legacy Qwen context template.
- Stale slash-command syntax, the misleading "maintained" Qwen claim, the "all phases done" plan status, and the unsupported large-percentage savings claims.

### Security

- ADR-1 trust model for project-declared commands; `.mygrace/` never committed.
- ADR-4 id/path validation (grammar checks + containment) for CLI and MCP inputs.
- No telemetry and no network calls at runtime; no shell interpolation for executed commands.

### Documentation

- Documentation truth pass: every documented command, flag, MCP tool and count is checked by `scripts/validate-docs.ts` in CI.
- `SECURITY.md` documents the threat model, trust record, supported versions and reporting process; `CONTRIBUTING.md` documents the dev loop and release gates; `docs/architecture.md` documents the module graph, ADRs and enforcement table.
- `PLAN.md` replaced with an English historical note; the current plan lives in `ROADMAP.md`.

### Internal

- Strict TypeScript (`tsconfig.json`), foundation unit tests, integration tests for trust/MCP/install, deterministic demo generation and generated-asset drift checks in CI.

## v1.0.1 (2026-11-22)

## Wave H — Caveman adapter
- **`skills/mygrace/grace-token-budget` + `packages/dsh-skill-mygrace`** — 15th bundled skill (`mygrace-token-budget`): output-side token policy — RTK for noisy commands (the bundle plugin rewrites `git status`/`bun test`/etc. automatically), compact MyGRACE reads (`mygrace test --compact`, `mygrace packet`/`focus`, `context-cost`), `/caveman-compress` for memory files (sends file text to the provider — documented caveat), `caveman browse` for web. Caveman proxy/Auto/voice intentionally not integrated: DSH uses its own LLM client (`dsh-llm-pi-ai`), no Anthropic/OpenCode provider surface; the Caveman voice skill is installable for agents that support it.

## Wave F — DSH bundle (full project as a DSH plugin)
- **`packages/dsh-skill-mygrace`** — `dsh-skill-mygrace` — bundled DSH skill provider generated from `skills/mygrace/grace-*` → `mygrace-*`; generated by `scripts/gen-dsh-skill-mygrace.ts`, modeled on `@deepseek-ai/dsh-skill-badge`. Verified live: the provider returns the skill set and `get()` returns skill file content.
- **`packages/mygrace-dsh`** — `mygrace-dsh` — the full MyGRACE project as a DSH bundle: host plugin (`mygrace-dsh`) mounts `@deepseek-ai/dsh-mcp-client` programmatically — `bun run src/grace-mcp.ts` of `mygrace-cli`, paths resolved at runtime (absolute paths live in `lib/index.js`, bundle patch stays path-free). Rows: `mygrace-host` + `mygrace-skills` + `mygrace-rtk` + `mygrace-panel`.
- **`packages/dsh-mygrace-rtk`** — `dsh-mygrace-rtk` — DSH tool-middleware plugin (row `mygrace-rtk`): rewrites noisy dev commands to `rtk` via the `tools/execute` around-dispatch hook (`git status` → `rtk git status`); pass-through when rtk is missing. RTK tokens: git/npm/npx/pnpm/yarn/bun/bunx/deno/node/cargo/go/rustc/rustup/pytest/ruff/eslint/tsc/vitest/jest/make/docker/kubectl/ls/tree/grep/rg/find/fd/cat/head/tail/sed/awk/sort/uniq/wc/nl/tar/gzip/zip/unzip/ssh/scp/curl/wget/openssl/jq/pv/less/more.
- **`mygrace install-dsh --bundle [--source <dir>] [--dsh-home <dir>]`** — installs via `dsh plugin --profile <profile> add <dir>` (pnpm in the profile dir; `--uninstall` → `dsh plugin --profile <profile> remove`). Verified live on DSH 0.2.1-rc.2 with a fake home: `dsh plugin --profile web add` → rows in `dsh --profile web --dump-config` + packages in `profiles/web/node_modules/`; `install-dsh --bundle --uninstall` → rows + packages removed. `--dsh-home` now applies to the MCP patch and the panel (legacy path). `result.error` printed when `dsh` itself fails.
- Note: some environments install `pnpm` as a shebang-less npm shim (Node `spawnSync("pnpm")` → ENOEXEC); a Node-spawnable entrypoint (e.g. `#!/usr/bin/env node` re-executing `node <...>/pnpm.mjs`) fixes it.
- **`scripts/publish-prepare.ts`** — swaps `file:` deps in `packages/mygrace-dsh/package.json` to versioned deps (`--dry-run` / `--apply`); publish order: `dsh-skill-mygrace` → `dsh-mygrace-rtk` → `mygrace-status-panel` → `mygrace-dsh` → `mygrace-cli`.

---

### Native workflow features (Wave E)
- **`mygrace doctor`** — health checks: project (modules/phases/verifications + lint errors/warnings), environment (DSH, rtk, caveman), integration (user-dsh skills, MCP row, status panel), dev tools (bun/node/pnpm/node_modules). Exit 1 on errors. JSON mode.
- **`mygrace test [--module M-AUTH] [--compact]`** — scoped module tests: scope from verification `<test-files>`, command from `<module-checks>` (default `bun test`). `--compact` — failures + summary only. Exit 1 on failure.
- **`mygrace verify [--module M-AUTH]`** — verification loop entry: scoped tests with compact digest; on failure writes `.mygrace/last-failures.md`; exit 1 on failure.
- **`mygrace packet M-AUTH`** — self-contained worker prompt: module contract + verification excerpt + dependency table. For DSH subagents (smaller context than reading several files).
- **`mygrace focus M-AUTH`** — minimal working set: Status, Contract (purpose + path), Deps (id + STATUS), Tests command.
- **`mygrace context-cost`** — context budget per operation in lines (mirrors `measure-context.ts`): Status check / Single module work / Phase execution / Full verification audit. JSON mode.
- **MCP parity** — 6 new tools: `mygrace_doctor`, `mygrace_test`, `mygrace_packet`, `mygrace_focus`, `mygrace_context_cost`, `mygrace_verify` (15 total). `mygrace_doctor` returns the report even on non-zero exit.
- **Tests: 80 → 86** (26 new: doctor 4, test 4, packet 3, context 1, verify 2, mappings 6).

### DSH-first docs
- AGENTS.dsh.md.template: "Token budget & workflow" section (doctor, test, verify, packet, context-cost); MCP list updated to all 15 tools.
- README: `doctor`/`test`/`verify`/`packet`/`focus`/`context-cost` added to the CLI table; the MCP tool list was expanded.

---

## v0.2.0 (2026-11-21)

### DeepSeek Harness — full native adaptation
- **DSH-native status panel** — `install-dsh` panel flow: `pnpm add` into the profile (DSH plugin path) + a `sidebar.footer.action` slot row; verified the slot exists on the DSH side
- **MCP parity** — `mygrace_find_modules` and `mygrace_phase_index` added (9 tools total)
- **CLI fixes (R1–R7 research findings)** — `module list --type` filter (was silently ignored: `module list --type CORE_LOGIC` returned all 12 modules instead of the 5 CORE_LOGIC ones); `module find` without a query lists all modules; `module show <missing>` prints the error without a stray header line; `file show --root` now resolves relative paths against the root (the `--root` arg was declared but unused — relative paths were read against the process CWD)
- **Skills validated against DSH** — all 14 `mygrace-*` skills pass DSH frontmatter validation (`name`, `description`, `whenToUse` — the DSH-native fields); `grace-multiagent-execute` rewritten for DSH `subagent`/`workflow` patterns, indexes read via `mygrace_phase_index`/`mygrace_find_modules` MCP tools
- **Installer hardening (R5)** — `install-dsh --dsh-home <dir>` now applies to the MCP row and the panel too (previously only the skills dir was overridden; the patch files silently went to `$DSH_HOME` or `~/.dsh`)
- **Cleanup** — removed unused legacy `templates/AGENTS.md.template`; stale slash-command references replaced with `mygrace` commands; `mygrace_show_phase` description no longer mentions a non-existent index tool
- Tests: 49 → 57 (8 new: `--type` filter, status+type filter, `module find` without query, `module show` error without header, MCP mappings for `mygrace_find_modules`/`mygrace_phase_index`, `install-dsh --dsh-home` round-trip: install → idempotent → uninstall)
- Cosmetic: `module list`/`module find` tables now adapt column widths (long `DEPENDS` no longer misaligns the PATH column); `module show` accepts unique ID prefixes (`M-EXT` → `M-EXTRA`), errors on ambiguity listing candidates; status-card wording updated to reference the `mygrace-status` skill

---

## v0.1.0 (2026-08-21)

### DeepSeek Harness — primary platform
- **`mygrace install-dsh`** — one-command integration: copies the skill set to `$DSH_HOME/skills/` (auto-discovered, appears in the Web GUI skill picker without restart), adds an idempotent MCP row to the profile's `cordis.patch.yml` **in the loader's `insert:` form** (bare `- id:` rows are dead no-ops — verified against the cordis loader), links the status-panel package via pnpm, with `--dry-run` / `--uninstall` and automatic backups
- **`mygrace init-dsh`** — non-interactive project bootstrap: docs/ index structure from templates + an AGENTS.md that DSH auto-loads
- **Skill set adapted to DSH** — DSH frontmatter (`name` / `description` / `whenToUse`), no platform-specific syntax, `multiagent` rewritten on native DSH `subagent`/`workflow`, MCP tools preferred with file-read fallback
- **`mygrace-status-panel`** — dual-face cordis package rendering a MyGRACE card in the web sidebar (`sidebar.footer.action` slot); installed by `install-dsh`, hot-applied by the live patch watcher (verified: `/plugins/mygrace-status-panel/client.js` served by the running harness without restart — F5 activates it)
- **`templates/AGENTS.dsh.md.template`** — compact DSH context file (~100 lines); the MyGRACE repository itself ships an AGENTS.md (dogfooding — the live harness picked it up immediately)

### Core fixes
- **Fixed a critical hang**: `mygrace lint` outside a MyGRACE project now fails in milliseconds with a readable error instead of looping forever (`findProjectRoot` walk was unbounded)
- **Fixed broken MCP tools**: `mygrace_show_phase` (was calling `module show --phase`), `mygrace_list_verifications` (`--priority`/`--format` now implemented in `verification index`), `mygrace_show_file` (`--root` instead of ignored `--path`)
- **Real unit tests** — tests import the actual `src/` code (17 → 49 tests), including regression tests for the hang, commented-template entries, STATUS drift, all 7 MCP tool mappings, patch add/remove round-trips
- `@modelcontextprotocol/sdk` declared as a dependency; `typescript` moved to devDependencies
- Shared helpers extracted to `src/grace-common.ts` (single `findProjectRoot` / XML parsers); XML comments ignored when parsing index entries
- Honest `--allow-missing-docs`: skips document checks on uninitialized projects (prepublish gate green)

### New commands
- **`mygrace status`** — aggregated health from the 3 indexes + lint, `--format json` for dashboards
- **`mygrace install-dsh` / `mygrace init-dsh`** — see above

### Consistency
- Markup unified: canonical `START_MODULE_CONTRACT`, legacy `=== MODULE_CONTRACT ===` accepted by lint and `file show`
- `scripts/validate-marketplace.ts` extended: skills may only reference existing CLI commands; extension manifest paths must resolve
- Fixed dangling paths in `extensions/mygrace/qwen-extension.json`; fixed dangling RTK.md reference in the Codex instructions
- Rewritten `grace-markup-validation.sh` hook: no python3 dependency, no dead checks, correct JSON output (grep -c pitfall fixed)
- `lefhook.yml` now runs `bun test` + marketplace validation

### Product artifacts
- **`examples/demo-store`** — 12-module dogfood project (lint 0/0, tests pass), regenerable via `scripts/gen-example.ts`
- **`scripts/measure-context.ts`** — reproducible context measurements: status 89%, module work 83%, phase 55% on the demo project; README cites measured numbers with methodology
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
- Large context-reduction claims of that era (later replaced by the measured line/byte metric)
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
