# 02 — Tests, scripts, demo example: meaningful verification or theatre?

Auditor: tests-scripts-auditor · Shared task: `task-2` · Date: 2026-11-22
Project: `@osovv/mygrace-cli` v1.0.1, bun 1.4.5 (`/home/truffle/.bun/bin/bun`)
Method: full re-run of `bun test` (clean baseline), scoped re-runs, mutation testing on a `/tmp` copy, manual MCP-stdio client against `src/grace-mcp.ts`, synthetic scaling projects in `/tmp`, tampered copy of the marketplace validator, reproducibility diffs of both generators, CLI exit-code probes in `/tmp`. Project files were not modified; this report is the only artifact written.

---

## 0. Verdict in one paragraph

The suite is **real code with real assertions in its core, surrounded by theatre**: all 10 `test/` files import actual `src/` modules (zero mocking libraries) and the install/patch, lint-sync, verify/exit-code, MCP-mapping and rtk tests genuinely exercise behaviour. But 12 of the 107 "passing tests" are tautologies generated into `examples/demo-store` (`expect(fn()).toBe(true)` where `fn` is `return true`), several other tests assert only types or `>= 0`, three security-/correctness-relevant lint analyzers can be replaced with `return []` without failing a single test (mutation survivors), and the most integration-heavy surfaces — the MCP server runtime, `install-dsh` end-to-end/failure paths, `init-dsh`, `file show`, malformed XML, JSON exit codes, and the 15th skill — have no tests at all. The measurement script is a **line-count model presented as "Measured Token Savings"**: on the shipped example, line-based 89/83/55 becomes ~80/64/54 when converted to bytes/token-proxy, so the headline single-module figure is overstated by roughly 16–19 percentage points; the baseline is synthesized (disclosed, but inconsistent with README's own classic-GRACE size table by ~4×), the "savings grow with project size / index stays flat" claim is never measured and "flat" is false, and the 0% row is an identity by construction. The example project is a pure façade: 12 byte-identical stubs with no imports, no parameters, and generated tests that cannot fail.

### Scores (1–10, 10 = best)

| Dimension | Score | Justification summary |
|---|---|---|
| Test meaningfulness | **5/10** | Real `src/` imports, zero mocks, strong cases (install patch round-trip, lint-sync negatives, exit codes in verify, 15 MCP mappings). Offset by 12 tautological demo tests, `>=0`/typeof-only assertions, no negative tests for 3 lint analyzers (mutation score 10/15 = 67%), one vacuous conditional test, and an import of symbols that do not exist. |
| Coverage of critical paths | **4/10** | MCP stdio runtime, `install-dsh` bundle/panel/failure/timeout/concurrency, `init-dsh`, `file show`, malformed XML, `lint/doctor/status/test` CLI exit codes, and the templates↔CLI contract are untested. `src/grace-file.ts` and `src/grace-init.ts` are imported by **no** test. |
| Honesty / validity of measurement methodology | **3/10** | Reproducible deterministic line-count model, synthesis disclosed; but labelled "Measured Token Savings", overstates token reduction by up to ~19 pp on the shipped data, baseline inconsistent with README's own size table, growth claim unmeasured, "index stays flat" false, 0% row tautological, CHANGELOG claims 96–97%. |
| Example-project realism | **2/10** | 12 identical `return true` stubs, 0 cross-module imports, 0/12 functions accept arguments, tests assert the hard-coded constant, verification docs promise failure scenarios the code cannot exhibit, docs are below the project's own documented sizes, `module-checks` written where the CLI does not read it. |

---

## 1. Method and environment caveats

Clean baseline at audit start (before any peer scratch work appeared):

```
bun test → 107 pass, 0 fail, 340 expect() calls, 107 tests across 22 files (~1.3 s)
bun test test/                 → 95 pass, 0 fail, 328 expect() calls, 10 files
bun test examples/demo-store   → 12 pass, 0 fail,  12 expect() calls, 12 files
```

The 22 files = 10 real test files + 12 generated demo-store test files; **12/107 = 11% of the reported "passing tests" are `expect(true).toBe(true)`-class assertions**.

Caveat (verified environment artefact, not a product bug): while auditing, parallel teammates created scratch copies under `analysis/_scratch-*` containing `.test.ts` files. Because there is **no `bunfig.toml` and no test-root scoping**, a later `bun test` discovered 215 tests across 130 files. Any final CI count in this shared workspace must be taken from a clean checkout or with `bun test test/`. `prepublishOnly` would behave the same way.

---

## 2. Test-quality inventory

### 2.1 Classification (test/ = 10 files, 95 tests, 328 assertions)

| File | Tests | Asserts | Classification | Notes / strongest & weakest evidence |
|---|---|---|---|---|
| `grace-index.test.ts` | 42 | 52 | **Real behaviour, partly fixture-bound** | Most valuable file: `findProjectRoot` walk, `parseIndexEntries` comment stripping/paired tags, `lintIndexSync` orphan/missing/drift negatives, all 15 `buildToolCommand` mappings + unknown-throws, fuzzy module resolution/exit-1. Weak: fixture-only positive checks (`:139-146`, `:265-281`) and no negative tests for the analyzers it imports. |
| `grace-install.test.ts` | 12 | 44 | **Real behaviour (string-level)** | Patch add/remove/idempotency round-trips; fake-home `install-dsh` + `--uninstall` (`:148-169`) verifies patch text, skill dir and no duplicate row. Does not validate YAML, `--bundle`, panel/pnpm, dry-run, failure exit codes. |
| `grace-test.test.ts` | 9 | 17 | **Real behaviour** | Parser + real `spawnSync` execution (`check-1=true`), missing-test-files path. No failing-command case here (covered indirectly via verify), no quoted/multi-word command, no Windows. |
| `grace-verify.test.ts` | 2 | 6 | **Real behaviour** | Best exit-code coverage: success/failure, `.mygrace/last-failures.md` written/not written, exit 0/1 (`:38-61`). |
| `grace-packet.test.ts` | 4 | 13 | **Real behaviour** | depTable resolution and packet/focus output contracts. |
| `dsh-mygrace-rtk.test.ts` | 9 | 22 | **Real behaviour** | Pure-function rewrite + fake `ctx.on` capture; listener dispatch verified. |
| `grace-doctor.test.ts` | 4 | 12 | **Smoke** | `expect(r.errors).toBeGreaterThanOrEqual(0)` (`:31`) is always true; `:59-72` only checks `typeof` and presence, not check outcomes. |
| `dsh-skill-mygrace.test.ts` | 6 | 19 | **Mixed / test smell** | 15-skill list and `get()` content are real; line `:4` imports `resolveMcpEntry, resolveMcpConfig, resolveBun` **which `packages/dsh-skill-mygrace/lib/index.js` does not export** — Bun tolerates the unused missing named imports, Node ESM fails at load: `SyntaxError: ... does not provide an export named 'resolveMcpEntry'` (verified with node 26). Package shape assertion (`:49-53`) is shallow. |
| `grace-context.test.ts` | 1 | 7 | **Smoke** | Only `length === 4`, `typeof`, `> 0`. No expected numeric values; hard-coding `operations[0].lines = 1` survives (verified mutation). |
| `mygrace-dsh.test.ts` | 6 | 18 | **Mixed incl. vacuous** | `apply()` test (`:32-45`) asserts **inside `if (calls.length > 0)`** — in the repo environment `calls` is always empty, so the test asserts nothing and passes even if `apply` is a no-op. Patch test only greps for substrings. |
| `examples/demo-store/**/*.test.ts` (12) | 12 | 12 | **Tautology** | e.g. `examples/demo-store/src/cli/index.test.ts:6` `expect(runCommand()).toBe(true)` against `examples/demo-store/src/cli/index.ts:26` `return true;` — cannot fail for any implementation that returns `true`. |

No mocking library is used anywhere (`mock|spyOn|jest.fn` count = 0). Three files temporarily replace `console.log`/`process.exit` to capture output and restore them in `finally` — legitimate technique, not stubbing of product logic. So the README claim "unit tests (imports real src code)" is directionally **true**; the weaknesses are assertion substance and gaps, not mocks.

### 2.2 Mutation testing (hard evidence of weak assertions)

15 mutants applied one at a time to a `/tmp` copy (symlinked `node_modules`), full suite run, file restored:

| Mutant | Result |
|---|---|
| `lintMarkup()` → `return []` | **SURVIVED** (107 pass) |
| `lintVerificationRefs()` → `return []` | **SURVIVED** (107 pass) |
| `lintXmlTags()` → `return []` | **SURVIVED** (107 pass) |
| `buildContextTable` first row `lines: 1` | **SURVIVED** (107 pass) |
| doctor `warnings: 0` | **SURVIVED** (107 pass) |
| `parseIndexEntries` no comment stripping | killed (1 fail) |
| `mygrace_verify` maps to wrong command | killed |
| `addPatchEntry` loses idempotency | killed |
| `runModuleTests` treats non-zero exit as ok | killed |
| `buildStatusSnapshot` modules.total=0 | killed |
| `verify` writes wrong failures filename | killed |
| `moduleShow` fuzzy prefix disabled | killed |
| `packet` omits dependencies | killed |

**Mutation score 10/15 (67%).** The three lint analyzers are exactly the code that makes `mygrace lint` — the project's flagship quality gate — meaningful, yet replacing their bodies with `return []` passes the whole suite. That is the definition of "positive-only fixture tests": a broken detector looks identical to a working one when it is only ever fed clean data. Relatedly, no test invokes the `lintCommand` CLI handler itself, so the JSON/exit-code behaviour below is unguarded.

---

## 3. Untested critical paths (verified where stated)

### 3.1 MCP server runtime — none of it is tested — MEDIUM
`src/grace-mcp.ts` (247 lines, the entire MCP surface) is imported by **no test**; tests only cover `buildToolCommand` mapping (`test/grace-index.test.ts:178-261`). There is no ListTools/initialize/tool-call test, no assertion that the server exposes 15 tools, and `TOOL_NAMES` (`src/grace-mcp-commands.ts:112`) is dead code (defined, never used) while the server hard-codes its own list — so mapping tests do not guard the actual registration.
Verified manually with an `@modelcontextprotocol/sdk` stdio client: handshake OK, **15 tools** listed and `mygrace_list_modules`, `mygrace_status`, `mygrace_context_cost` calls succeed when `MYGRACE_BIN` points at a shim. But the server executes `MYGRACE_BIN` default `"mygrace"` (`src/grace-mcp.ts:22`, `:229`), and in an environment without a global CLI: `Executable not found in $PATH: "mygrace"` for every tool call. `mcpPatchEntry()` (`src/grace-install.ts:67-82`) never sets `MYGRACE_BIN`, and nothing tests or documents this coupling. Also stale: the file header lists 6 tools (`:5-11`) though 15 are registered.

### 3.2 Real `cordis.patch.yml` mutation end-to-end — only string heuristics tested — MEDIUM
`addPatchEntry`/`removePatchEntry` are tested as string transformations and one fake-home flow; there is **no YAML parse** anywhere, no test against the shipped 4-`insert:` bundle patch format in `packages/mygrace-dsh/cordis.patch.yml`, no test of `--bundle`, panel `pnpm add`, or `--dry-run` in the suite. Failure semantics are silent: verified `install-dsh` with no profile patch prints `WARNING: … cordis.patch.yml not found` and still exits **0** (`src/grace-install.ts:182-187`, `:423-467`, no `process.exit`). Ad-hoc 8-way parallel install on one fake home ended with 1 MCP row (idempotency held) but 7/8 runs silently skipped the panel (`WARNING: pnpm add failed (exit null)`) and there is no locking; `copyFileSync(..., ".mygrace-backup")` races under concurrency. No test, no CI exercise.

### 3.3 Malformed XML — silently accepted — MEDIUM
No XML parser exists anywhere; `parseIndexEntries` is a regex (`src/grace-common.ts:48-65`). Verified behaviour:
- unterminated tag → entry silently dropped; single-quoted attributes → `{}` attrs (STATUS/`DEPENDS` silently lost); attribute value containing `>` → entry dropped; lowercase/plain junk → empty.
- a project whose *module file* is invalid XML (`<M-A NAME=A STATUS="done" … <<<broken>>>`) but whose index/file names match → `mygrace lint` exit **0**, "Errors: 0, Warnings: 0" (verified).
- duplicate index entries for the same module → lint **passes** (verified).
Tests: `lintXmlTags` has no test at all; `lintMarkup`/`lintVerificationRefs` only get a known-clean fixture (`test/grace-index.test.ts:139-146`) — their broken-detection paths are unverified (see mutation survivors).

### 3.4 CLI exit codes and output formats — untested, and two are wrong — MEDIUM
Only `verifyCommand` and `moduleShowCmd` exit codes are tested. Verified:
- `mygrace lint --path <broken> --format json` exits **0** although the JSON contains an `error` (JSON branch `src/grace-lint.ts:283-286` returns before `process.exit(1)` at `:313`).
- `mygrace doctor --format json` on a failing project exits **0** (`src/grace-doctor.ts:205-208` returns before `process.exit(1)` at `:210`).
- `install-dsh` partial failure exits 0 (above).
`lint`/`doctor`/`status`/`test`/`context-cost`/`file`/`init-dsh` handlers have no test invoking them; scripts/agents relying on exit codes would silently treat failures as successes. **Verified.**

### 3.5 The 15th skill, `grace-token-budget` — invisible to the gate — HIGH (see §5)
Exists on disk and is exercised indirectly by `packages/dsh-skill-mygrace` tests, but `scripts/validate-marketplace.ts:83-88` hard-codes 14 and never validates it. Breaking this skill's frontmatter/commands leaves `validate-marketplace` green (verified by tampering). Its six real commands (`doctor`, `test`, `verify`, `packet`, `focus`, `context-cost`) are all absent from the validator's `KNOWN_CLI_COMMANDS` (`:145`) — if the skill were validated, it would emit six **false** warnings; warnings never fail the script (verified, exit 0).

### 3.6 `init-dsh` and `file show` — zero test imports — MEDIUM
`src/grace-init.ts` and `src/grace-file.ts` appear in **no** test import (verified loop over `src/*.ts` vs `test/*.test.ts`). These back the bootstrap command and the `mygrace_show_file` MCP tool. Only manual smoke was done (fresh `/tmp` project → `init-dsh` exit 0, lint 0/0).

### 3.7 Windows / quoted-command handling — suspected, untested
`runModuleTests` splits the check command on spaces (`src/grace-test.ts:76-78`) and calls `spawnSync(file, [...rest, ...files])` with no shell — quoted/multi-word check commands break, Windows `.cmd` resolution and backslash paths are unvalidated; no CI matrix or platform test exists. **Suspected** (not verified on Windows; verified that the parsing strategy ignores quoting).

### 3.8 Template ↔ CLI contract mismatch: `module-checks` is read from the wrong file — HIGH
The documentation, templates and generator put the custom test command in the **verification** file:
- `templates/verification/V-M-XXX.xml.template:6-8`
- `skills/mygrace/grace-verification/SKILL.md:39`
- `scripts/gen-example.ts:115`
- `src/grace-mcp.ts:109` describes "test-files + module-checks" as coming from "verification files".

The CLI reads it from the **module** file: `src/grace-test.ts:31-36` (`parseCheckCommand(moduleContent)` where `moduleContent` comes from `docs/modules/M-XXX.xml`, `:63`) and `src/grace-packet.ts:109`. Verified consequence: `examples/demo-store` has `module-checks` in 12/12 verification files and 0/12 module files, so `mygrace test`/`verify`/`focus` silently fall back to `bun test` instead of the documented command. No test catches it because fixtures put `module-checks` inside the module content (`test/grace-test.test.ts:61`, `test/grace-verify.test.ts:15`). For every project scaffolded by `init-dsh` + skills/templates, the custom check-command feature is effectively dead.

### 3.9 Regeneration / asset drift, type checking — MEDIUM/LOW
No test asserts `examples/demo-store` equals `gen-example.ts` output or that `packages/dsh-skill-mygrace/assets/skills` equals `skills/mygrace`; neither generator runs in `prepublishOnly`. There is **no `tsconfig.json` anywhere** (0 files outside `node_modules`), no `tsc`/typecheck script, and the `typescript` devDependency (`package.json:69`) is unused — bun strips types, so type regressions are invisible to the gate.

---

## 4. `scripts/measure-context.ts` — validating the 89/83/55/0% methodology

### 4.1 What the script actually computes
`linesOf()` counts newline-split lines (`scripts/measure-context.ts:22-25`). The "classic" files are synthesized in a temp dir by concatenating the index file with all per-entity files (`:51-65`, `writeFileSync(join(classic, title), parts.join("\n\n") + "\n")`), then line totals are compared per operation (`:87-95`). So it is a deterministic **line-count model** of an assumed workflow, not a token measurement. Re-run gives exactly README's numbers:

```
Status check (3 indexes)   363 / 39 / 89%   Single module work (M-API.xml) 173 / 30 / 83%
Phase execution            31 / 14 / 55%    Full verification audit        159 /159 / 0%
All artifacts at once      363 / 363 / 0%
```

### 4.2 Finding A — LINES are not TOKENS; the diff is material — HIGH
README heading is "### Measured Token Savings" (`README.md:57`) and the claim travels as token savings (`CHANGELOG.md:118`: "96–97% context token savings"), yet the cells literally say "363 lines / 39 lines" (`README.md:63-65`). I converted the same read-sets to bytes and to a token proxy (`word|[punct]` count; chars/4 agrees), using the script's own read sets:

| Operation | Line-count "savings" (README) | Byte savings | Token-proxy savings |
|---|---|---|---|
| Status check | 89% | ~80% | **~79–80%** |
| Single module work | 83% | **~67%** | **~64–67%** |
| Phase execution | 55% | ~55% | ~54% |
| Full verification audit | 0% | 0% | 0% |

Why: MyGRACE's read-set is dominated by index lines, and index lines are unusually dense — `graph-index.xml` ≈ 112–119 bytes/line (all 12 module records on 16 long attribute lines), demo module docs ≈ 33–36 B/line, synthesized classic merge ≈ 40 B/line. Line counting implicitly values an index line the same as a short module-doc line, which systematically flatters the MyGRACE side for the single-module operation. **The 83% headline is ~16–19 pp above a token-equivalent figure on the shipped example.**

### 4.3 Finding B — the "classic" baseline is synthetic and inconsistent with README's own classic-size table — HIGH
The synthesis is disclosed (`README.md:68`, script footer), which is honest, but the baseline is not a classic GRACE project and cannot be: it is MyGRACE's own terse artifacts re-concatenated. It is also **~4× smaller than what README's own problem table predicts**: README says classic monoliths at 5 modules are 150+200+100 = 450 lines and at 20 modules 800+1200+600 = 2600 (`README.md:41-46`); interpolating 12 modules gives ≈1500 lines, while the measured "classic" total is **363**. So the two tables in the same README are not consistent with each other. (Interesting direction: the synthesized baseline is *conservative* — a more realistic/verbose classic baseline would make savings larger. But then the 89/83/55 table is not "the measured" truth either; it is an upper-shares model of a hybrid project.)

### 4.4 Finding C — "savings grow with project size / the index stays flat" is neither measured in-repo nor true as stated — MEDIUM-HIGH
The script has a single 12-module data point and takes no size parameter; the growth claim (`README.md:68`) is unsupported by any measurement. I generated synthetic MyGRACE projects in `/tmp` and ran the **actual script**:

| Modules (demo-style docs) | Status | Single module | Phase exec | Index read-set lines |
|---|---|---|---|---|
| 12 | 91% | 84% | 62% | 38 |
| 20 | 92% | 88% | 73% | 57 |
| 50 | 93% | 91% | 82% | 127 |
| 100 | 93% | 93% | 85% | 244 |
| 200 | 93% | 93% | 87% | 477 |

| Modules (README-documented docs: module ~40 lines, phase ~70) | Status | Single module | Phase exec |
|---|---|---|---|
| 12 | 97% | 89% | 74% |
| 50 | 98% | 96% | 93% |
| 200 | 98% | 97% | 97% |

Two conclusions: (a) savings do rise and then **saturate** (~93% for the thin style; ~97–98% with realistic artifacts), so "grow with size" is directionally true in the model but nowhere demonstrated by the repo; (b) "the index stays flat while monolithic files grow linearly" is **false** — the MyGRACE index/read-set grows ≈2.3 lines per module (38 → 477 lines for 12 → 200 modules), just with a smaller slope than monoliths (~13–90 lines/module). Both grow linearly; the *ratio* saturates.

### 4.5 Finding D — the 0% row is an identity by construction and the "All artifacts" row compares a file with itself — MEDIUM
"Full verification audit" classic = `merge(verification-index, verification/)` and MyGRACE = `verification-index + all verification files` — the same byte content (`:63-65` vs `:91`), hence 0% by algebra, not by measurement. The script's final "All artifacts at once 363 / 363 / 0%" row equally compares content against itself (it is not in the README table). The README does explain the 0% row, which is honest, but it conveys no information and should not sit in a results table.

### 4.6 Finding E — fairness check: is it stacked in MyGRACE's favour?
Not in the way one might fear. With per-entity docs at the sizes the project itself documents (`README.md:53-55`: module 30–80, phase 50–200), the same script reports **higher** savings (97/89/73 at 12 modules) and token-proxy agrees with line savings (~97/87/74). The shipped `examples/demo-store` is *below* its own documented sizes (12-line modules, 5-line phases — §6), which depresses the line-based percentages and creates the wide line-vs-token divergence. So the demo is unrealistic, but the *direction* of the marketing claim is defensible: index-first navigation really does cut context cost dramatically. What is not defensible is presenting a synthetic line model on an undersized example as "Measured Token Savings 89/83/55" — the correct token-equivalent numbers for that example are ≈80/64/54, and the correct way to get ~90%+ is to measure a spec-conformant or larger project, which the repo never does.

### 4.7 Minor methodology nits
- `sampleModule`/`samplePhase` are the alphabetically first files (`:76-79`), not representative or averaged; harmless on the demo (all module docs identical), arbitrary elsewhere.
- `linesOf` counts the trailing empty element (`split("\n").length`), so file sums overcount by 1/file (script 363/39 vs concatenation-consistent 361/37; ~0.5% effect).
- Output is deterministic across runs (verified by diff) and the temp files are cleaned up (`:52`, `:119-121`) — good.
- No tokenizer, no real classic-GRACE corpus, no confidence intervals, and the measurement is not referenced by any test/CI job.

**Verdict on the marketing numbers:** the digits are reproducible and correctly reproduce *line counts*, and the underlying architectural claim is sound and even understated on realistic data. But "89% / 83% / 55% **measured token savings**" is **not defensible as stated**: no token measurement exists, the single-module figure overstates token savings by ~16–19 pp, the classic baseline is synthetic and 4× inconsistent with the README's own table, the growth claim is unmeasured and "index stays flat" is false. Defensible restatement: "In a line-count model of the demo project, reading indexes instead of monoliths cuts the read-set by 89/83/55%; token-equivalent savings on the same artifacts are ~80/64/54%, and ~87–98% on spec-conformant or larger projects."

---

## 5. `scripts/validate-marketplace.ts` — a validator that cannot fail on the things that matter

### 5.1 The 14-vs-15 hole — HIGH
`expectedSkills` hard-codes 14 names and omits `grace-token-budget` (`:83-88`), although 15 skill directories exist (`skills/mygrace/grace-token-budget/SKILL.md`). The success line prints the length of the hard-coded list, not what is on disk: `console.log(\`Skills: ${expectedSkills.length} ✓\`)` (`:102`) → **"Skills: 14 ✓"**. Consequences: the 15th skill's frontmatter, description and command references are never validated; a broken 15th skill ships silently. README itself is inconsistent — "Skills (14, shared across platforms)" with a 15-row table (`README.md:105-123`) while claiming "15 skills" at `:15` and `:31`. The same stale 14 appears in `src/grace-install.ts:406`, `scripts/gen-dsh-skill-mygrace.ts:6,67`, and the generated package description.

### 5.2 Tamper test — the gate passes sabotage — HIGH (verified)
I copied the repo to `/tmp`, then inside the copy: (a) broke `grace-token-budget/SKILL.md` (no frontmatter + bogus command), (b) added a 16th fake skill `grace-fake` with bogus content, (c) deleted the `mygrace_verify` MCP tool registration from `src/grace-mcp.ts`, (d) removed the `doctor` command registration from `src/grace.ts`. Result:

```
Version: 1.0.1 ✓
Skills: 14 ✓
✓ All MyGRACE validation checks passed.        EXIT=0
```

So the validator does not detect: wrong MCP tool count (README claims 15), removed CLI command, broken 15th skill, extra unexplained skills.

### 5.3 The command-reference check is stale and non-fatal — HIGH
`KNOWN_CLI_COMMANDS` (`:145`) lists only `lint, module, phase, verification, file, status, install-dsh, init-dsh` — missing six commands that really exist in `src/grace.ts:34-49`: `doctor, test, verify, packet, focus, context-cost`. The check also marks findings as warnings (`:150-154`, `isWarning = true`) and warnings never fail the run (`:194` exits 0 when `errors.length === 0`). Verified by temporarily adding the 15th skill to `expectedSkills`: six false "unknown CLI command" warnings, exit **0**. Adding a bogus command to a validated skill (grace-status) similarly yields a warning and exit **0**. So "Skills reference only existing CLI commands" (header claim) is advisory at best and inverted in practice (real commands flagged, bogus commands tolerated).

### 5.4 No MCP-tool / README / package-content validation — HIGH
- README claims "15 MCP tools" (`README.md:32`); the tools are hard-coded in `src/grace-mcp.ts:26-223`; `TOOL_NAMES` (`src/grace-mcp-commands.ts:112`) is dead code; the validator checks neither count nor names. A mismatch would pass.
- No check that README's skill table/count matches `skills/`; no check of CHANGELOG claims (`96-97% context token savings`, `all 7 MCP tool mappings`, `17→49 tests` — all stale vs current 89/83/55, 15 mappings, 95+12 tests).
- No `npm pack`-style check that `package.json` `files` entries exist, that `bin.mygrace` resolves inside the tarball, or that the published bundle's dependencies resolve (§7).

### 5.5 What the script does do correctly
Version consistency across `package.json`/README/extension manifest (`:26-40`) works and fails on mismatch; required dirs/files existence checks (`:44-78`) are real; the `check()` helper itself is correct (pushes errors/warnings, no bug — the danger is that callers mark important checks as warnings and that `expectedSkills` is hard-coded). Header claims are overstated: "Index templates exist and are parseable" (`:8-9`) only checks `content.includes("$")` (`:116`) — no XML parsing; "No hardcoded absolute paths" scans only top-level `src/` and `scripts/` (`:122-136`), misses `packages/`, `templates/`, `test/`, uses a narrow `/home/<word>/` regex, and reports only the basename.

---

## 6. `scripts/gen-example.ts` + `examples/demo-store` — façade, not a store

### 6.1 The generated "modules" are identical stubs — HIGH (for the realism/dogfooding claim)
`sourceFile()` produces the same body for all 12 modules (`gen-example.ts:130-164`):

```ts
const fnBody = `  console.log("[${m.name}][${m.fn}][BLOCK_VALIDATE] ${status}");\n  return true;`;
...
export function ${m.fn}(): boolean { ... }
```

Verified on the checked-in example: **0 imports** across `examples/demo-store/src`, **12/12** exported functions `return true`, **0/12** accept any argument, and no cross-module dependency exists even though `docs/modules/*.xml` declare `DEPENDS`. It is a documentation-shaped fixture, not a demo store.

### 6.2 The generated tests are tautologies — HIGH
`testFile()` (`gen-example.ts:166-179`) emits `expect(${m.fn}()).toBe(true)`; the function body is hard-coded `return true`. All 12 tests pass for the same reason `expect(1).toBe(1)` does. These 12 tests are 11% of the reported 107-test suite. Verified `mygrace verify --path examples/demo-store` → `Verify: 12 ok`, **including the five modules whose STATUS is `pending`** (e.g. M-NOTIFY, M-CLI), i.e. the dogfooding command reports verification success for code that was never written. That is the strongest available counterexample to "its tests pass" being meaningful evidence.

### 6.3 The verification documents describe behaviour the code cannot have — HIGH
Every generated verification file claims `<scenario-2 kind="failure">${m.fn} fails fast on invalid input</scenario-2>` (`gen-example.ts:117-118`) while the function takes no inputs and has no failure branch (`:133`). `gen-example.ts`'s own docstring calls the model "realistic" (`:5`), and README sells the example as a dogfooding project: "`mygrace lint` passes 0/0, its tests pass, and it feeds `scripts/measure-context.ts`" (`README.md:150`). Lint-at-0/0 and tests-pass are true only because the artifacts are generated and trivially consistent.

### 6.4 The example violates the project's own documented artifact sizes — MEDIUM
README documents module files 30–80 lines, phase files 50–200, verification 20–60, indices ≤100/50/80 (`README.md:53-55`); the checked-in demo has **12-line** module docs (12 files), **5-line** phase files, **11-line** verification files, 16/6/14-line indexes. The generator's own `moduleDoc()` (`gen-example.ts:71-87`) emits only contract/one export/one CrossLink. This directly feeds the measurement distortions in §4.2 (short, dense entity docs make index lines relatively expensive), and it means the example can never catch index-size regressions (the "≤100 lines" index ceiling is untested at real scale).

### 6.5 Generator ↔ CLI contract inconsistencies — MEDIUM
- `module-checks` is written into the verification file (`gen-example.ts:115`) but the CLI reads it from the module file (§3.8) — dead data in the example.
- `graphIndex()` sorts modules by status (`gen-example.ts:56-57`), so the example's index order is not authoring order; harmless but another sign it is synthetic output rather than a curated project.
- Reproducibility: regenerating in `/tmp` reproduces the checked-in files byte-for-byte except the empty `docs/archive/` directory (untracked by git); the generator is not run in `prepublishOnly`, so example drift is unguarded. The generator does `rmSync(EXAMPLE, {recursive:true})` (`:184`) with a ROOT-relative target — destructive by design, no `--check` mode.
- The only non-stub code shipped in the repo is the **test fixture** `test/fixtures/mygrace-project/src/auth/index.ts` (real validation/`throw AUTH_FAILED`/`randomUUID`), and it is never executed by any test (fixtures are only linted). The realistic sample is the unexecuted one.

---

## 7. `scripts/publish-prepare.ts`, `gen-dsh-skill-mygrace.ts`, and `prepublishOnly`

### 7.1 `publish-prepare.ts` is essential for the bundle but wired to nothing — HIGH
`packages/mygrace-dsh/package.json` declares `file:` deps; `publish-prepare.ts` rewrites them to versions (`:25-31`) so the bundle could be published. But:
- It is referenced by **zero** scripts/lifecycle hooks (`grep publish-prepare package.json packages/*/package.json` → 0); `prepublishOnly` (`package.json:59`) only runs `bun test && lint --allow-missing-docs && validate-marketplace`. `packages/mygrace-dsh` has no scripts at all, so publishing the bundle bypasses every check.
- It mutates the working-tree `package.json` in place (`:38`) with no backup/restore/`--check` mode — after `--apply` the repo's local `file:` install flow is broken until a human reverts it. Dry-run output: four swaps including `@osovv/mygrace-cli: file:../.. → @osovv/mygrace-cli@1.0.1`.
- It blindly swaps in versions of packages that are not publishable: `packages/mygrace-status-panel/package.json:6` has `"private": true`, yet `publish-prepare` would make the bundle depend on `mygrace-status-panel@0.1.0` (verified in dry-run output). Unless that package is published some other way, the published bundle references an unresolvable dependency; the sibling packages at 0.1.0 likewise have no publish orchestration.
- No tests; not part of the 107-test suite; no CI invocation.

### 7.2 `gen-dsh-skill-mygrace.ts` — works, with three real defects — MEDIUM/LOW
Regeneration is byte-identical to `packages/dsh-skill-mygrace` (verified `diff -r` → exit 0) and correctly picks up all **15** skills (`Generated … 15 skills`), so the "14" in its docstring (`:6`) and in the generated package description (`:67`, verified in the checked-in `packages/dsh-skill-mygrace/package.json:3`) is stale.
- Broken export map: generated `package.json` advertises `"types": "./lib/types/index.d.ts"` (`packages/dsh-skill-mygrace/package.json:9`) but the generator never creates `lib/types/` (verified absent; `files` doesn't include it) → TypeScript consumers get a missing-type entry.
- Latent runtime bug: candidates' locators use the skill **id** (`s.id`), but `provider.get(candidate)` reads `skillFileURL(candidate.name)` (generator line 131) — frontmatter `name` instead of directory-derived id. Verified in `/tmp`: a SKILL.md whose frontmatter `name` differs from its directory makes `provider.get()` throw `ENOENT … assets/skills/some-other-name/SKILL.md` while `list()` reports the mismatched name. Nothing validates that `name` equals the directory id.
- No test compares assets against `skills/mygrace` and the generator is not in `prepublishOnly`, so skill edits can ship stale bundle assets.

### 7.3 `prepublishOnly` — passes, but the gate is soft — MEDIUM
Current chain (`package.json:59`): `bun test && bun run ./src/grace.ts lint --path . --allow-missing-docs && bun run ./scripts/validate-marketplace.ts`. It passes today, but:
- `--allow-missing-docs` is required because **the repo has no `docs/` directory** (verified), despite `AGENTS.md` instructing index-first navigation; the package therefore does not dogfood its own lint consistency checks on itself.
- `bun test` includes the 12 tautological demo tests and (as observed) any stray `*.test.ts` anywhere in the workspace — no bunfig/test-root scoping.
- `validate-marketplace` cannot fail on MCP tool count, the 15th skill, command drift, README/CHANGELOG claims, or publish packaging (§5).
- No type checking at all (§3.9), no generator/example reproducibility check, no `publish-prepare --check`, no `npm pack` smoke test.
- Documentation the gate ignores is visibly drifting: README "Skills (14…)" vs 15 rows; CHANGELOG `96-97% context token savings` vs README 89/83/55; CHANGELOG `all 7 MCP tool mappings` / `17 → 49 tests` vs today's 15 mappings / 107 tests.

---

## 8. Findings summary (severity-tagged)

| # | Finding | Severity | Verified? |
|---|---|---|---|
| F1 | README "Measured Token Savings 89/83/55%" is line counting; token-equivalent ≈80/64/54 on the shipped example (single-module overstated ~16–19 pp) | HIGH | Verified |
| F2 | `validate-marketplace.ts` hard-codes 14 skills, ignores the 15th; sabotage of MCP tools/commands/broken skill still passes | HIGH | Verified |
| F3 | `module-checks` documented/template/generated into verification files, but CLI reads it from module files → custom test commands silently ignored | HIGH | Verified |
| F4 | Demo-store example is a façade: 12 identical `return true` stubs, no imports/params, tautological tests, fictional failure scenarios; `verify` reports 12 ok for 5 `pending` modules | HIGH | Verified |
| F5 | Classic baseline is synthetic (MyGRACE artifacts re-concatenated) and ~4× smaller than README's own classic-size table; growth claim unmeasured; "index stays flat" false (≈2.3 lines/module, 38→477) | HIGH/MED | Verified |
| F6 | MCP stdio server runtime untested (15 tools work manually; default `mygrace` PATH dependency breaks tool calls; 15-tool count unguarded) | MEDIUM | Verified (manual) |
| F7 | `install-dsh` failure paths exit 0; `--bundle`/panel/pnpm/dry-run/concurrency untested; no locking | MEDIUM | Verified |
| F8 | `lint --format json` and `doctor --format json` exit 0 on errors/failing project | MEDIUM | Verified |
| F9 | Malformed XML and duplicate index entries pass lint silently; no XML parser; three lint analyzers mutation-survive | MEDIUM | Verified |
| F10 | `init-dsh` and `file show` have zero test imports | MEDIUM | Verified |
| F11 | THREE lint analyzers (`lintMarkup`, `lintVerificationRefs`, `lintXmlTags`) can be `return []` and suite stays green (mutation score 10/15) | MEDIUM | Verified |
| F12 | `publish-prepare` not wired to any lifecycle; mutates tree in place; swaps private `mygrace-status-panel` into published deps | MEDIUM-HIGH | Verified (dry-run) |
| F13 | `dsh-skill` test imports 3 symbols the module doesn't export; Bun tolerates, Node ESM throws at load | LOW-MED | Verified |
| F14 | Generated package export map points at nonexistent `lib/types/index.d.ts`; provider `get()` confuses frontmatter name with directory id (ENOENT when they differ) | LOW-MED | Verified |
| F15 | No typecheck (no tsconfig, unused typescript dep); generators/example drift unguarded; no test-root scoping | MEDIUM | Verified |
| F16 | README/CHANGELOG count and metric drift (14 vs 15 skills; 96–97% vs 89/83/55; 7 vs 15 MCP mappings; 49 vs 107 tests) caught by nothing | LOW-MED | Verified |
| F17 | Windows/quoted check-command handling untested (`cmd.split(" ")`, no shell) | MEDIUM | Suspected |
| F18 | `measure-context` 0%/all-artifacts rows are algebraic identities; sample module/phase = alphabetically first | LOW | Verified |
| F19 | Empty triggered-tests: `expect(errors).toBeGreaterThanOrEqual(0)`, typeof-only doctor/context tests, vacuous conditional `apply` assertion | LOW | Verified |
| F20 | The only realistic code in the repo (fixture `src/auth/index.ts`) is never executed; fixtures only linted | LOW | Verified |

---

## 9. Required questions, direct answers

1. **Meaningful or tautological assertions?** Mixed: core `test/` files contain meaningful assertions against real code; 12/107 tests are literal tautologies, ~4 more are vacuous/type-only. What the demo tests prove: that `return true` returns `true` — nothing about CLI behaviour, and they cannot detect regression because they call generated stubs. The "107 passing tests" headline should be read as 95 substantive + 12 tautological.
2. **Real `src` imports or heavy mocks?** Real imports, zero mocking libraries; 3 files stub `console.log`/`process.exit` for capture (restored in `finally`); real subprocesses are spawned in `grace-test`/`grace-verify`. The problem is coverage, not mocking.
3. **`gen-example.ts` realistic or façade?** Façade: 12 identical hard-coded stubs (no imports, no parameters, no failure modes), tautological generated tests, fictional verification scenarios, docs below documented sizes, `module-checks` in the file the CLI doesn't read. It is deterministic and reproducible (good for a fixture), but calling it a "realistic demo store" and citing it as dogfooding evidence is misleading.
4. **Does `measure-context` measure what the README claims?** No. It counts lines, not tokens; the classic baseline is synthesized from MyGRACE's own files and is ~4× smaller than the README's own classic-size table; "savings grow / index stays flat" is neither measured nor literally true. Re-run is deterministic and reproduces the digits, and the architectural direction is real (with realistic artifacts savings are even higher), but the "Measured Token Savings" label and the 83% token figure are not defensible. Suggested honest wording in §4 verdict.
5. **Does `validate-marketplace` catch what it claims?** No. It misses the 15th skill entirely (hard-coded 14), has a stale non-fatal command allowlist, and does not check the advertised 15 MCP tools or README/CHANGELOG claims; a deliberately sabotaged copy still prints "✓ All checks passed", exit 0.
6. **`publish-prepare` / `prepublishOnly` / `gen-dsh-skill`?** `publish-prepare` is necessary for the bundle yet wired to nothing, mutates the tree destructively in place, and would publish a dependency on a `private: true` package. `prepublishOnly` runs and passes but is a soft gate (no typecheck, no MCP/skill-count/README checks, no regeneration checks). `gen-dsh-skill` regenerates byte-identically and picks up 15 skills but advertises 14, points at a nonexistent types file, and has a latent name/id bug in `provider.get()`.

---

## 10. Recommended fixes, in priority order

1. **`scripts/validate-marketplace.ts`**: derive the skill list from `readdirSync` (assert exactly 15 and cross-check README), make command-reference mismatches **errors**, derive `KNOWN_CLI_COMMANDS` from the citty command tree (or assert against `src/grace.ts`), assert the MCP tool list length/names against `TOOL_NAMES`, and fail on extras.
2. **Make the measurement honest**: rename to "line-count model", print per-row lines *and* an explicit tokenizer-derived count (or clearly say "lines, not tokens"), regenerate the baseline from a real classic-GRACE 5/20/50-module fixture rather than re-concatenating MyGRACE files, add a size sweep (12/50/200) to the script/README, and drop or clearly label the 0% row. Replace "savings grow / index stays flat" with measured slope numbers.
3. **Fix the `module-checks` contract**: pick one source of truth and align `src/grace-test.ts`, `src/grace-packet.ts`, `src/grace-mcp.ts:109`, templates, skill, and generator; add a test using a *template-shaped* project so the silent fallback can't recur.
4. **Add missing tests**: MCP initialize/ListTools/CallTool (spawn the server over stdio), negative `lintMarkup`/`lintVerificationRefs`/`lintXmlTags` cases + malformed/duplicate XML, CLI exit codes incl. `--format json`, `init-dsh` bootstrap, `file show`, `install-dsh --bundle`/dry-run/failure exit codes, a real-DSH-format patch test, and a `publish-prepare --check` + bundle `npm pack` smoke test.
5. **Make `examples/demo-store` non-tautological or relabel it** as a structure fixture: give 2–3 modules real logic + real failure tests, or regenerate tests from the verification scenarios; either way stop citing "tests pass" for `pending` modules as validation.
6. **Close the packaging/publishing gaps**: wire `publish-prepare` into the bundle's lifecycle with a restore/check mode, resolve the `private` status-panel dependency strategy, generate `lib/types` or remove the export entry, add a typecheck script (`tsc --noEmit`) and a CI job that runs `bun test test/` (scoped), regeneration diff, and the measurement script with checked-in expected numbers.
7. **Doc hygiene**: single source for skill count (15) and measurement metric across README/CHANGELOG/packages/meta strings; fix stale CHANGELOG claims (7 tools/49 tests/96–97%).
