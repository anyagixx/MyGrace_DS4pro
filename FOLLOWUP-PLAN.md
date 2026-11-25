# MyGRACE — follow-up plan (post-v1.6.0)

Status: **proposed** (2026-11-24) · Owner: Lead · Releases touched: **v1.6.1**, **v1.7.0**, npm bootstrap, analysis report
Source facts were re-checked on 2026-11-24 (npm registry, GitHub releases, DSH session storage, Archify schemas).

Four tracks, ordered by dependency and risk:

| # | Track | Type | Effort | Release |
|---|---|---|---|---|
| A | npm publication (trusted publisher) | ops / owner action | 1–2 days (incl. bootstrap) | v1.6.0 publish + v1.7.0 OIDC |
| B | Octocode MCP startup diagnosis | investigation (timeboxed) | 2–4 days | v1.6.1 (docs/adapter hardening) |
| C | `--kind workflow\|tree` diagrams | feature | 4–6 days | v1.7.0 |
| D | Capsule measurement on real agent sessions | analysis / evidence | 3–5 days | none (report + decision) |

C shipped in v1.7.0 on 2026-11-24 (architecture/workflow/tree validated against Archify 3.2.0 and 3.3.x). Remaining: **A bootstrap → A trusted-publisher switch → B → D**. Original order was A bootstrap → C → A switch → B → D, because
D needs a stable CLI and C is the only user-visible feature left; B is independent and must not block releases.

---

## A. npm publication — `mygrace-cli`

### Verified state (2026-11-24)

- `package.json`: `name: "mygrace-cli"`, `version: "1.6.0"`, `publishConfig.access: "public"`,
  public GitHub repo, `repository` set.
- The project does **not** own the `@osovv` scope: `@osovv` is the third-party codebase this
  repository started from. The final unscoped package name is **`mygrace-cli`**, verified free on
  the npm registry (HTTP 404, 2026-11-25).
- `.github/workflows/release.yml` already has: `id-token: write`, npm ≥ 11.5.1 install, tag/version
  equality check, `release:check` + `publish:dry`, `npm publish --provenance --access public` gated by
  repository variable `NPM_PUBLISH_ENABLED == 'true'`, `NPM_TOKEN` fallback, manual `dry_run` dispatch.
- Tags v1.4.0–v1.6.0 already ran the workflow green with “publish skipped”.
- No local npm credentials; publication must stay CI-only.

### A1. Owner prerequisites (blocking, outside the repo)

1. Create/verify an npm account for the product owner; no custom scope is needed for the unscoped
   `mygrace-cli`. Enable 2FA.
2. Enable 2FA on the npm account; org requires 2FA for publishing.
3. Create a **granular npm automation token** (least privilege: publish `mygrace-cli` only, no org admin)
   and add it as repository secret `NPM_TOKEN`.
4. Set repository variable `NPM_PUBLISH_ENABLED=true`.
5. Add a protected GitHub **Environment** `npm-publish` (required reviewers = owner) and attach it to the
   publish job in `release.yml` — a tag push alone must not publish without approval.

### A2. Bootstrap the first version (one-time token path)

npm trusted publishing is configured on an **existing package** page, so the first version needs a
token. Publish the current release without a new tag:

```bash
# Actions → release → Run workflow → dry_run=false (workflow_dispatch, tag v1.6.0)
# or locally: nothing — publication is CI-only.
```

Acceptance for bootstrap:

- `npm view mygrace-cli@1.6.0 version dist.tarball dist.integrity time --json` succeeds;
- `npm install -g mygrace-cli@1.6.0` works on a clean Linux runner and prints `1.6.0`;
- npm page shows provenance attestation (OIDC via token publish does **not** produce provenance —
  expected for the bootstrap; the next release must).

### A3. Switch to trusted publishing (preferred steady state)

1. npmjs.com → package `mygrace-cli` → Settings → **Trusted publishing** → GitHub Actions:
   owner `anyagixx`, repo `MyGrace_DS4pro`, workflow `release.yml` (no environment, or the protected
   environment if npm supports it).
2. Remove the `NODE_AUTH_TOKEN`/`NPM_TOKEN` block from the publish step, delete the repository secret,
   keep `NPM_PUBLISH_ENABLED` as the explicit switch.
3. v1.7.0 is published through OIDC: verify provenance (`npm view … --json` → `dist.attestations`,
   `npm audit signatures` in a clean dir), then announce “install from npm” and update README.

### A4. Repo hardening (small, do with the first publish)

- `release.yml`: add post-publish verification step:
  `node -p "require('child_process').execSync('npm view mygrace-cli@' + process.env.VERSION + ' --json')"`
  asserting version/tarball/integrity, plus `npm install -g` smoke in a temp prefix.
- New `scripts/verify-npm-release.ts` (read-only): registry metadata, dist integrity, provenance
  attestation presence, tarball file list vs `publish:dry` expectations; exit 1 on mismatch.
- CI scheduled job (weekly): re-verify the published package and provenance; catches yanks/registry drift.
- README Install: replace “not published yet” with `npm install -g mygrace-cli` and keep the
  source-checkout path as an alternative; CONTRIBUTING: mark trusted publishing as the primary path.
- Rollback policy: **`npm deprecate`** the bad version with a message and publish a fix; never
  `npm unpublish` (breaks consumers, provenance stays). Keep the GitHub release asset regardless.

### A5. Acceptance / risks

- Acceptance: `npm install -g` on clean Ubuntu/macOS/Windows CI; provenance attestation present for
  v1.7.0+; secret removed; README/CONTRIBUTING updated; `publish skipped` notice no longer reachable
  when the variable is on.
- Risks: scope ownership unknown; first-publish bootstrap requires a token (unavoidable today); npm
  trusted-publisher UI changes; accidental publish on tag push — mitigated by the protected environment
  and the variable gate.

---

## B. Octocode MCP startup diagnosis (upstream)

### Verified state (2026-11-24)

- v1.4.0 adapter pins `octocode >=0.29 <0.30`; real-binary smoke is manual because the pinned binary
  never answered MCP `initialize` on this host (documented limitation).
- Re-checked today: **0.30.0 was released 2026-11-24** and **still hangs** before replying to
  `initialize` (15 s probe, x86_64 musl binary; the same happens with `mcp --bind` and the `graphrag`
  CLI). `--version`/`--help` work. Release notes for 0.30.0 mention temperature/config migration and
  “musl ONNX is fetched during builds” — no MCP fix.
- Earlier evidence from the audit: the binary starts and waits (`wait_woken`, single thread, no child
  processes at hang); network/HF reachable; fresh `HOME`/`XDG_DATA_HOME` still hangs; `--no-git`,
  `--debug` and an empty project directory do not help; **no matching open upstream issue** was found
  by title search (`MCP`, `hang`, `initialize`, `timeout`).
- Hypothesis ranking: (1) ONNX/embedding runtime initialisation blocks before the MCP loop
  (models absent — earlier sessions had the 1.2 GB models downloaded); (2) telemetry/update check at
  startup; (3) musl ONNX/dlopen quirk; (4) git/state lock. The “models absent” hypothesis is the most
  likely and is cheap to test.

### B1. Reproduction matrix (1 day)

Run each combination with a hard 20 s `initialize` probe and capture `/proc/<pid>/wchan`, `strace -f`,
`RUST_LOG=debug` logs:

| Variable | Values |
|---|---|
| version | 0.29.0, 0.29.2, **0.30.0** |
| model cache | absent (`~/.cache/octolib` removed) vs present (pre-downloaded 1.2 GB) |
| env | clean `HOME`/`XDG_DATA_HOME`; `HF_HUB_OFFLINE=1`; network blackhole (`HTTPS_PROXY=http://127.0.0.1:9`) |
| flags | `--debug`, `--no-git`, `--bind 127.0.0.1:PORT`, empty project |
| config | `[embedding]` models blank/remote, `mcp_index=false`, `[graphrag.llm]` disabled |

Decision point: if pre-downloaded models make `initialize` succeed, the adapter/docs must require the
model cache for MCP graph mode (and the “no models” claim is wrong — fix it honestly). If models do not
matter, continue to B2.

### B2. Diagnosis (1–2 days)

- Linux: `strace -f -e trace=network,read,write,futex,epoll_wait,openat`, `/proc/<pid>/stack`,
  `gdb -p <pid> -batch -ex "thread apply all bt"` (if gdb is allowed); `RUST_BACKTRACE=full`.
- Check dlopen/ONNX: `ldd` (musl static), missing `/dev/dri`/CPU features, `--bind` HTTP path, run in
  `docker run --network none`.
- Compare with an older version that worked in earlier sessions (0.28.x) to find the regression window.
- Search upstream issues/discussions by **body** (`MCP`, `initialize`, `embedding`, `ONNX`) and the
  changelog; open a minimal upstream issue with: OS, arch, binary checksum, exact command, timeout,
  strace/gdb excerpt, config, `octocode doctor` output, and the repro matrix.

### B3. Deliverables

- Root cause (or a precise “environment prerequisite” conclusion) in `analysis/octocode-startup.md`.
- Adapter hardening regardless of the cause: dedicated `INTEGRATION_STARTUP_TIMEOUT` note/hint
  (“Octocode MCP did not answer initialize; pre-download models / check `octocode doctor`”),
  `MYGRACE_OCTOCODE_TIMEOUT_MS` override documented, smoke script prints the same guidance.
- README/known-limitation update; if fixed upstream: widen the pin, re-run the real smoke, and promote
  the optional pinned-binary CI job (G14) from manual to scheduled.
- **Exit criteria:** timebox 3 working days; either upstream fix/prerequisite documented, or a public
  issue with a reproducible case + workaround note. Do not claim the graph adapter is production-verified
  until the real smoke passes.

---

## C. `--kind workflow|tree` diagrams (v1.7.0)

### Verified state (2026-11-24)

Archify main branch ships `workflow.schema.json` and `tree.schema.json` (3.3.x):

- **workflow**: `schema_version` enum `[1, 2]` (v2 = current; `migrate workflow --to-schema 2`),
  required `meta`, `lanes` (`id`,`label`), `nodes` (`id`,`lane`,`col` 0–5,`type`,`label`),
  `edges` (`from`,`to`), optional `phases`, `groups`, `mainPath`, `cards`.
- **tree**: `schema_version` const `1`, required `meta` + `nodes` (`id`,`label`), optional `parent`,
  `sublabel`, `collapsed`, `layout` (`direction: down|right`, gaps, node sizes).
- Current `mygrace diagram` ships `architecture` only; the command/MCP schema already reject other
  kinds with a typed usage error (v1.5.0 scope cut, documented).

### C1. Mapping design (pilot before implementation)

**Tree (low risk, do first).**

- Nodes: project root → source directories (`config.sourceDirs`) → module groups (TYPE) →
  modules (leaf), `parent` links; `label` = module NAME; `sublabel` = `M-XXX · PATH`;
  `collapsed: false`; deterministic sort by id/path.
- Cards: counts, verification coverage, lint summary. `layout` fixed (`direction: "down"`).
- No edges → no clean-flow risk; validate against real Archify 3.2.0/3.3.x.
- Artifact: `docs/diagrams/tree.json` (+ local HTML), committed IR, `--check --kind tree`.

**Workflow (medium risk, needs a pilot).** Two candidate mappings; pick after real validation:

1. **Delivery plan** (preferred): lanes = plan phases (`docs/plans/Phase-N.xml`), nodes = phase steps
   (`<step-N>`, `status`, linked modules) at `col` = step order clamped to 0–5; edges = sequential
   steps + step→module references; `phases` = labelled columns; honest “first 6 steps, rest grouped”
   rule with a note.
2. **Dependency pipeline**: lanes = module TYPE groups, nodes = modules at `col` =
   `min(layer, 5)`, edges = primary backbone (same clean-flow discipline as architecture). Weaker
   semantics; keep as fallback only.

Pilot: generate both IRs for this repo in `/tmp`, run real `archify validate workflow --json` on
3.2.0/3.3.x, record validation errors (col/lane constraints, v2-only fields, layout rules); freeze
the mapping in `docs/modules/M-DIAGRAM.xml` before coding the CLI surface.

### C2. Implementation (feature branch → v1.7.0)

- `src/grace-diagram.ts`: `DiagramKind = "architecture" | "workflow" | "tree"`; per-kind builders
  `buildWorkflowDiagram`, `buildTreeDiagram`; shared layout/provenance/summary helpers; IR file
  naming `<kind>.json`, receipts `<kind>.receipt.json`; `--check --kind` checks the matching IR;
  `--out` default `<outputDir>/<kind>.html`; HTML/receipt gitignored, IRs committed.
- `diagram --check` default (no `--kind`) checks **all committed IRs** (release gate keeps working);
  add `--kind …` for one.
- Archify adapter: reuse validate/deliver; detect schema support (workflow v2 vs v1) from the CLI
  version/schema; fall back with `INTEGRATION_UNSUPPORTED_VERSION` if the installed CLI is too old
  (workflow v2 needs a recent Archify).
- MCP `mygrace_diagram`: extend `kind` enum and `--check` behavior.
- Tests: golden IRs for tree + workflow on the demo project; determinism; fake-Archify validate/deliver
  per kind; bad CLI output; `--check` per kind; MCP mapping; usage errors. Update the fake Archify
  fixture to answer per `type` argument.
- Real smoke: extend `scripts/integration-archify-smoke.ts` to validate/deliver all three kinds with
  the installed real CLI; keep manual.
- Docs: README “Diagrams” section (three kinds, mapping rules, committed IRs), M-DIAGRAM contract,
  architecture doc, CHANGELOG, ROADMAP; counts stay 23 commands / 25 tools (no new command/tool).
- Release: v1.7.0, tag, release notes; `release:check` runs `diagram:check` for every committed kind.

### C3. Acceptance / risks

- Acceptance: all three kinds deterministic (same sha256), validate+deliver against Archify 3.2.0 and
  3.3.x, `--check` covers each, no new dependencies, core gates unaffected without Archify.
- Risks: workflow v2 schema churn (pin CLI tested versions; fake-CLI contract + real smoke), `col` cap
  5 and lane semantics (document the clamping/grouping rule), clean-flow not applicable to tree but
  lane/col validation may still complain (pilot first), IR size/determinism (sort everything).
- Effort: tree 1–2 days, workflow 2–4 days, docs/release 0.5–1 day.

---

## D. Capsule measurement on real agent sessions

### Verified state (2026-11-24)

- Capsules shipped in v1.6.0 are **experimental with no claims**; there is no measurement harness yet.
- DSH session records live at `$DSH_HOME/storages/session_projcache/sessions/*.json` and contain
  exactly the metrics needed, per `record.rows`:
  - `tokenUsage.val.totals`: `uncachedInputTokens`, `outputTokens`, `cacheReadTokens`, `cacheWriteTokens`
    (+ `last` per-step buckets),
  - `sessionStats.val`: `turns`, `steps`, `llmMs`, `toolMs`, `ttftMs`, `decodeTokens`,
  - `contextBreakdown.val`: system/tools/message tokens,
  - `turnOutline.val.turns`: prompt/response per turn,
  - `identity.cwd` + `createdAt` for joining runs to projects.
- `scripts/measure-context.ts` already exists as the repository’s measurement precedent.

### D1. Harness (1–2 days)

`scripts/measure-capsules.ts`:

- input: manifest (`analysis/capsule-eval/<date>/manifest.json`) with one entry per session:
  `{arm: "capsule"|"skill", task: "after-change"|"module-onboarding"|"daily-check", sessionId, cwd,
  startedAt, endedAt, gateResult, notes}`;
- reads the matching DSH session JSON (by `sessionId`, fallback cwd+createdAt), extracts totals for the
  task turn(s) from `tokenUsage`/`sessionStats`/`contextBreakdown`, derives `toolCalls ≈ steps`,
  `turns`, `cost = uncachedInputTokens + outputTokens`, `cacheReadTokens` reported separately,
  wall time `llmMs + toolMs`, and the final gate result;
- outputs per-arm medians, bootstrap 95% CI, Wilcoxon signed-rank / Mann–Whitney U, and a
  machine-readable summary; plus a Markdown report generator;
- no network, no writes outside `analysis/capsule-eval/`.

Pre-register the protocol **before** running sessions: hypotheses, tasks, prompts, N, model,
temperature, seeds, primary metrics, kill criterion (see D3), exclusions.

### D2. Session protocol (1–2 days)

- Tasks (2–3): T1 “run the post-edit gate and decide whether the change is safe”
  (capsule `after-change` vs `mygrace-reviewer` skill prose); T2 “onboard module M-X and begin
  implementation” (`module-onboarding` vs `mygrace-execute`); optional T3 session-start health
  (`daily-check` vs `mygrace-status`).
- Arms: **capsule** (project with qualified capsules, same capsule prompt) vs **skill** (capsule
  directory removed / skill procedure). Exactly one task per session; fresh session; same project
  commit; clean working tree; same DSH model/provider/params.
- N = 10 per arm per task (20/session/task ⇒ 40–60 sessions total); randomized order, counterbalanced;
  capsule arm requires the capsule to be `qualified` before the run.
- Feasibility check first: can DSH run these sessions non-interactively (headless/scripted turn)? If
  not, the Lead runs them manually through the GUI with a fixed script; record the limitation.
- Confound controls: same context cache age (report `cacheReadTokens` separately), same repo state,
  no background jobs, fixed prompt text, no user steering after the initial task.

### D3. Analysis and decision

- Primary: `cost = uncachedInput + output` per task; secondary: tool calls/steps, turns, wall time,
  gate pass rate; report medians + 95% CI and the raw numbers (no cherry-picking).
- Kill criterion (pre-registered): **< 15 % reduction in tool calls/turns or any gate-pass
  regression → keep capsules experimental, make no token/cost claims**. Even if the target is met,
  publish with limitations (single agent/model, small N, one repo family).
- Artifacts: `analysis/capsule-eval/<date>/{protocol.md,manifest.json,summary.json,report.md}`;
  session IDs referenced, prompts/responses not republished; CHANGELOG/README capsule section updated
  only after the report.
- Effort: harness 1–2 days, sessions 1–2 days, analysis 0.5–1 day.
- Risks: small N and model drift; GUI/headless availability; prompt ambiguity — mitigate with
  pre-registration, fixed order randomization, and an honest “inconclusive” outcome as an acceptable
  result.

---

## E. Sequencing, releases, and ownership

| Order | Work | Owner | Effort | Output |
|---|---|---|---|---|
| 1 | A1 owner prerequisites + A4 hardening | owner + Lead | 0.5–1 day | secrets/variable/environment; workflow verification step |
| 2 | A2 bootstrap publish of v1.6.0 (token) | owner + Lead | 0.5 day | package on npm; `npm view`/install smoke |
| 3 | C pilot (tree + both workflow mappings) | Lead | 1 day | validation notes; frozen mapping |
| 4 | C implementation + tests | Lead | 3–5 days | v1.7.0 diagrams |
| 5 | A3 trusted publisher switch on v1.7.0 | owner + Lead | 0.5 day | OIDC + provenance; token retired |
| 6 | B repro matrix + diagnosis (parallel with 3–5) | Lead | 2–4 days (timeboxed) | analysis + upstream issue + adapter hardening (v1.6.1 if code changes) |
| 7 | D harness + sessions + report (after v1.7.0) | Lead + owner as operator | 3–5 days | measurement report + decision |

Release notes:
- **v1.6.1** (only if B produces code/docs changes): adapter startup-timeout hints, README limitation
  update; no CLI surface change.
- **v1.7.0**: `--kind tree|workflow` + first OIDC npm publication (if A3 ready; otherwise publish v1.6.0
  first and switch on v1.7.0).
- **No release for D**: analysis artifacts only; decide by kill criterion whether capsules remain
  experimental (default) or get a careful, caveated mention.

## F. Risks and mitigations

| Risk | Mitigation |
|---|---|
| npm account/name availability | resolved: no third-party scope is used; final name is the free unscoped `mygrace-cli`. Remaining risk is the owner's npm account/2FA/token setup |
| First npm publish needs a token | one-time granular token, least privilege, rotate/remove immediately after OIDC works; protected environment approval |
| Accidental publish on tag push | `NPM_PUBLISH_ENABLED` variable + protected environment with required reviewer |
| Workflow schema v2/col-cap constraints force a bad mapping | pilot with real CLI first; prefer the delivery-plan mapping; document clamping/grouping; fall back to “architecture + tree only, workflow deferred” if validation cannot be satisfied honestly |
| Octocode never answers initialization | timebox B; keep adapter manual-smoke + fake-contract; update docs to “unverified”; reopen only when a real smoke passes |
| Capsule measurement shows no effect | report honestly, keep experimental, no marketing claims (pre-registered kill criterion) |
| Measurement sessions contaminate each other | one task per fresh session, fixed commit, randomized order, report cacheRead separately |

## G. Explicit non-goals

- No `npm unpublish`, no publishing from laptops, no long-lived token committed to the repo.
- No workflow/tree IR that hides aggregation rules; every clamped/grouped element is documented.
- No capsule performance claims before D completes; no “SkillCache numbers” borrowed from the paper.
- No changes to the core gates’ determinism/offline guarantees; all new diagrams/capsules stay optional.

## H. Open questions for the owner

1. Which npm account will own `mygrace-cli`, and can you add the one-time `NPM_TOKEN` + repository variable + protected environment? (No custom scope needed.)
2. Is a protected GitHub Environment with manual approval acceptable for npm publication?
3. Priority: C (new diagram kinds) before B (Octocode), or run B first if upstream responsiveness matters?
4. For D: are you willing to run ~40–60 controlled DSH sessions as the operator, or should the Lead
   automate headless runs if DSH supports them?
5. If workflow v2 cannot be mapped without dishonest clamping, is “architecture + tree only” an
   acceptable v1.7.0 scope cut?
