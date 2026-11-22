# MyGRACE CLI — Core Source Audit (`src/*.ts`)

**Project:** `@osovv/mygrace-cli` v1.0.1 (bun CLI). **Scope:** all 15 files in `src/` (2,450 lines), `package.json`, templates/tests/example where needed to establish intended contracts.
**Method:** full read of every source file; ~80 empirical probes run against throwaway projects in `/tmp` (malformed XML, missing dirs, unreadable files, hostile XML, fake DSH homes, MCP JSON-RPC over stdio, packed-tarball inspection). Every finding marked **VERIFIED** was reproduced with the actual CLI/MCP server; code-level only items are marked **SMELL**. Environment: Linux, bun 1.4.5. Windows behavior assessed statically (not executable here).

**Premise corrections (verified, relevant to the review):**
- `bun run src/grace.ts lint --path .` does **not** pass in this repo. There is no `docs/` tree, so it exits 1 with `MyGRACE project not found`. It passes only with `--allow-missing-docs` (the variant used in `prepublishOnly`, package.json:59).
- `bun test` = **107 pass, 0 fail, 22 files** (`bun test test/ examples/demo-store`) in a clean tree. (The live `bun test` currently reports 179/94 files only because other teammates' `analysis/_scratch-*/src/*.test.ts` are being auto-discovered; not a project defect.)
- `mygrace status --path <no docs/>` emits a raw Bun stack trace (confirmed; see H-6).

---

## 0. Findings at a glance

| # | Severity | Verified | Finding | Location |
|---|---|---|---|---|
| C-1 | **CRITICAL** | VERIFIED | Published package omits 5 of 15 `src/` modules (`grace-doctor/test/verify/packet/context`) and `packages/mygrace-dsh`; installed CLI dies on startup, `install-dsh --bundle` path is dead | package.json:31–47 vs src/grace.ts:26–30; grace-install.ts:359–361 |
| H-1 | **HIGH** | VERIFIED | Arbitrary shell execution from repo-controlled XML in `test`/`verify` (`bash -c …` built from `<check-1>` + `<file>` entries) | grace-test.ts:25–36, 76–78 |
| H-2 | **HIGH** | VERIFIED | `lint --format json` **always exits 0** even with errors (`return` before `process.exit`); MCP `mygrace_lint` JSON lies | grace-lint.ts:283–286 vs :313 |
| H-3 | **HIGH** | VERIFIED | Canonical `<module-checks>` (verification files per templates/skills/demo) is ignored; command read from module file → silent fallback to `bun test` | grace-test.ts:31–36, 63, 76; templates/verification/V-M-XXX.xml.template:5–7 |
| H-4 | **HIGH** | VERIFIED | Regex XML "parser": `>` in an attribute silently drops entries; single-quoted attrs yield `{}`; `Phase-1a` truncated to `Phase-1`; malformed XML passes lint as "All checks passed" | grace-common.ts:34–40, 48; grace-lint.ts:6, 26–94 |
| H-5 | **HIGH** | VERIFIED | Path traversal read primitive: unsanitized module id in `packet`/`focus`/`test`/`verify` reads `*.xml` outside the project (`../../../../tmp/traversed`) | grace-packet.ts:61, 66, 96; grace-test.ts:63 |
| H-6 | **HIGH** | VERIFIED | Unhandled stack traces for most commands outside a project / on I/O errors; only `lint` converts errors gracefully | grace-status.ts:61; grace-context.ts:44–45, 65; grace-module.ts:28, 153; grace-common.ts:30, 74–77 |
| H-7 | **HIGH** | VERIFIED | `install-dsh` can corrupt or lose the user's config: no atomic write, backup overwritten on every mutation, no YAML validation, uninstall false-success | grace-install.ts:102–116, 124–154, 206–207, 243–244 |
| H-8 | **HIGH** | VERIFIED | MCP loses failure diagnostics: `test`/`verify`/text-`lint` failures return only `Command failed: …`; `err.stdout` special-cased only for doctor | grace-mcp.ts:225–238 |
| M-1 | MEDIUM | VERIFIED | Phase STATUS drift never detected (regex requires uppercase `STATUS=`, canonical phase attr is lowercase `status`) | grace-lint.ts:81 |
| M-2 | MEDIUM | VERIFIED | Only the first `<verification-ref>` per module is checked | grace-lint.ts:202 |
| M-3 | MEDIUM | VERIFIED | Block pairing is count-only: `START_BLOCK_ALPHA`+`END_BLOCK_BETA` reports "✓ Paired"/lint clean; markers inside strings cause false "unpaired" errors | grace-lint.ts:122–130; grace-file.ts:68–84 |
| M-4 | MEDIUM | VERIFIED | `lint --path <nonexistent> --allow-missing-docs` reports "All checks passed", exit 0 | grace-lint.ts:272–278 |
| M-5 | MEDIUM | VERIFIED | `doctor --format json` exits 0 with 4 errors; text mode exits 1 | grace-doctor.ts:203–210 |
| M-6 | MEDIUM | VERIFIED | `status` always exits 0 even with lint errors | grace-status.ts:60–82 |
| M-7 | MEDIUM | VERIFIED | Uncaught spawn errors swallowed in test runs: missing executable → module "failed" with empty output | grace-test.ts:78–80 |
| M-8 | MEDIUM | VERIFIED | Substring idempotency: an entry `id: mcp-mygrace-extra` suppresses installation; same check in doctor gives false "present" | grace-install.ts:94–96, 103; grace-doctor.ts:109 |
| M-9 | MEDIUM | VERIFIED | `install-dsh --profile ../../evil` writes outside `$DSH_HOME` (path traversal on a CLI arg) | grace-install.ts:52–54, 180 |
| M-10 | MEDIUM | VERIFIED | `init-dsh --force` silently overwrites existing `AGENTS.md`/index files with no backup | grace-init.ts:105–113 |
| M-11 | MEDIUM | SMELL | Windows: `spawnSync("pnpm"/"dsh")` cannot execute `.cmd` shims; failure reported as "exit null" (result.error ignored) | grace-install.ts:284, 288, 344, 385–390 |
| M-12 | MEDIUM | SMELL | MCP `execFile` timeout of 30 s will kill real `test`/`verify` runs; default 1 MiB maxBuffer can truncate large reads | grace-mcp.ts:229 |
| M-13 | MEDIUM | VERIFIED | Module-id prefix resolution only in `module show`; `focus`/`packet`/`test`/`verify` require exact IDs (`M-AU` works for show, fails for focus) | grace-module.ts:96–112 vs grace-packet.ts:60, 95; grace-test.ts:92 |
| M-14 | MEDIUM | SMELL | MCP tool catalog triplicated (server list, `ToolName` union, switch); `TOOL_NAMES` exported but referenced nowhere in `src/` | grace-mcp.ts:26–223; grace-mcp-commands.ts:10–26, 112–128 |
| M-15 | MEDIUM | SMELL | Markup knowledge duplicated (verification-ref regex ×2, block/contract logic ×2, module selection ×2) — the two copies already differ in scope | grace-lint.ts:122–143, 202; grace-file.ts:32–84; grace-module.ts:126; grace-test.ts:92; grace-verify.ts:28 |
| M-16 | MEDIUM | VERIFIED | No type-checking at all: no `tsconfig.json`, `typescript` devDep unused, no `@types/node`, no typecheck script; `tsc` cannot even start (`TS2688`) | package.json:59, 68–70 |
| M-17 | MEDIUM | VERIFIED | `lintMarkup` walks `src/lib/apps/packages` with no `node_modules`/`dist`/`.git` exclusion; vendored file with a marker produces an error | grace-lint.ts:100–118, 145–147 |
| M-18 | MEDIUM | SMELL | Documented index line budgets (≤100/≤50/≤80) are never enforced by lint; nothing checks index size or module-file shape | grace-lint.ts:221–256 (no size checks) |
| M-19 | MEDIUM | VERIFIED | Misleading error text: missing `V-M-A.xml` reported as "no `<test-files>` in V-M-A.xml"; missing plan-index reported twice; `docs/modules` as a file surfaces raw `ENOTDIR` | grace-test.ts:67–75; grace-lint.ts:36 + 239–245 |
| L-1 | LOW | VERIFIED | Self-documentation drift: entry header lists 8 of 15 commands; stale `Run /mygrace:init first`; `"14 skills"` vs 15; MCP serverInfo `0.1.0` vs package `1.0.1` | grace.ts:6–16; grace-module.ts:31; grace-install.ts:406; grace-mcp.ts:24 |
| L-2 | LOW | VERIFIED | Header claim "index files … parseable" / "unique XML tag conventions" not implemented (duplicates unflagged, malformed XML unflagged) | grace-lint.ts:5–10 |
| L-3 | LOW | VERIFIED | Duplicate index entries not flagged and double-counted (list/status), double-run (test/verify) | grace-lint.ts:26–94 |
| L-4 | LOW | VERIFIED | `formatTable` breaks on multi-line attribute values; typos ("UNPAIRDED") | grace-common.ts:86–93; grace-file.ts:73 |
| L-5 | LOW | VERIFIED | Dead code/args: `verify --all` declared never read; dead existence check in `module index`; MCP `TOOL_NAMES` unused | grace-verify.ts:23; grace-module.ts:30–33; grace-mcp-commands.ts:112 |
| L-6 | LOW | SMELL | "Both steps are idempotent" claim: MCP row is, skills are blindly re-copied (overwrites user edits); stale old-version skill dirs never removed | grace-install.ts:12–13, 158–176, 212–224 |
| L-7 | LOW | SMELL | Doctor quality: 0/0 skills counts as OK when package incomplete; `node_modules` count is entries not packages; probes have no timeout; panel "installed" is a substring test | grace-doctor.ts:99–104, 118, 129–139 |
| L-8 | LOW | VERIFIED | `parseCheckCommand` naive `split(" ")` (quoted commands unsupported); only first `check-N` used | grace-test.ts:31–36, 77 |
| L-9 | LOW | VERIFIED | Unknown flags silently ignored (`lint --pth <dir>` runs default root); bogus `--format jsno` silently treated as text | citty args + grace-lint.ts:267–286 |
| L-10 | LOW | SMELL | No consistent exit-code contract across commands (0/1 matrix varies by command *and* by output format) | all `run()` bodies |
| L-11 | LOW | VERIFIED | `mcpPatchEntry` bakes `process.execPath` + absolute `import.meta.dir` into the user's config; breaks if bun/package moves (no re-resolution) | grace-install.ts:67–82 |

Severity key: **CRITICAL** = broken shipped artifact / release blocker; **HIGH** = wrong results, code execution, data loss, or major contract violation; **MEDIUM** = edge-case correctness, portability, misleading behavior; **LOW** = cosmetic/dead code/error-text quality.

---

## 1. Architecture

### 1.1 Module layout (what is good)

- `src/grace.ts` is a thin entry point: one `defineCommand` with a flat `subCommands` map + `runMain` (grace.ts:32–52). This is idiomatic citty.
- `grace-common.ts` genuinely centralizes root discovery, index parsing, table formatting (grace-common.ts:14–93). The `findProjectRoot` bug described in CHANGELOG:58 ("unbounded walk") **is fixed correctly**: `resolve(dir,"..")` and the `parent === dir` terminator are right (grace-common.ts:22–31), it terminates in ~30 ms at `/`, and there is a regression test (test/grace-index.test.ts:14–27). Credit where due.
- `grace-mcp-commands.ts` is a pure tool→argv mapping, SDK-free and unit-testable (grace-mcp-commands.ts:1–128) — the best-factored file in the tree.
- `grace-verify` reuses `runModuleTests` from `grace-test` instead of duplicating it (grace-verify.ts:17, 32) — correct dependency direction.

### 1.2 Problems

1. **MCP executes its own CLI as a subprocess instead of importing the command logic** (grace-mcp.ts:22, 225–239). This is a second, out-of-process execution path with its own failure semantics. Every resulting defect (H-2 through H-8, M-12, M-13) is payable to this one decision: it needs `mygrace` on `PATH` (`MYGRACE_BIN = "mygrace"`, grace-mcp.ts:22 — not installed in this environment, so **every MCP call fails** until a global install exists), discards stdout on non-zero exit, re-implements argument mapping, and caps runs at 30 s. The command modules already export reusable functions (`collectLintIssues`, `buildStatusSnapshot`, `runModuleTests`, …), so this coupling is avoidable.
2. **Layering leaks.** `grace-status` imports the whole lint engine (grace-status.ts:12) just to get two counters; `grace-doctor` imports lint *and* the installer (`skillSourceDirs`) (grace-doctor.ts:17–19), so a health check pulls in `child_process`, `homedir`, pnpm spawning and YAML mutation. Installer/OS-integration concerns live in the same module as command UX.
3. **Duplication / single-source-of-truth violations** (all confirmed in code):
   - verification-ref extraction: grace-lint.ts:202 vs grace-module.ts:126 (same regex, two files; only lint's copy checks existence).
   - semantic-markup grammar: "canonical + legacy contract" and START/END counting appear in both lint and `file show` with subtly different semantics (grace-lint.ts:122–143 vs grace-file.ts:32–84).
   - module selection for test/verify (grace-test.ts:92 vs grace-verify.ts:28).
   - MCP catalog: names/args in the 200-line `tools` literal (grace-mcp.ts:26–223), again in the `ToolName` union and switch (grace-mcp-commands.ts:10–108), and a third copy in `TOOL_NAMES` (grace-mcp-commands.ts:112–128) that is **never referenced** from `src/`. Adding a tool requires 3–4 edits and already left `mygrace_doctor`-style special cases in the handler.
   - The string `graph-index.xml` occurs **37 times across 12 src files**; `docs/…` paths are re-derived everywhere rather than from a constants/entity-descriptor module.
4. **Inconsistent granularity:** module+phase+verification (7 subcommands) share one 292-line file; tiny commands each get a file; `grace-install.ts` (468 lines) mixes path resolution, YAML editing, pnpm/dsh spawning, skill copying, and CLI UX in one module.
5. **Methodology self-application fails at the architecture level:** the project's stated principle #1 is "Never write code without a contract", yet no `src/` file has a module contract (see §4). There are no module boundaries, no `MODULE_MAP`, no barrels — only legends in comments.

**citty idiom verdict:** idiomatic in structure (subcommands, positional/option args, kebab-cased `withVerification`), but not in discipline: no shared argument validation (bad `--format` accepted silently), unknown flags ignored (citty `strict:false`), mixed error styles (`throw` vs `console.error`+`process.exit`), inconsistent exit codes, and `async` handlers for purely synchronous work. Description strings are used as a documentation channel (grace-install.ts:403–407) and are already stale.

---

## 2. Correctness (verified bugs)

Unless marked SMELL, each item was reproduced with the CLI/MCP in `/tmp`.

### C-1 (CRITICAL, VERIFIED) The packaged CLI is dead on arrival

`package.json` `files` lists 10 source files, but `src/grace.ts` imports 11 local modules (5 of which are missing from the list):

```json
"files": [ "src/grace.ts", "src/grace-lint.ts", "src/grace-module.ts", "src/grace-file.ts",
  "src/grace-mcp.ts", "src/grace-mcp-commands.ts", "src/grace-common.ts", "src/grace-install.ts",
  "src/grace-status.ts", "src/grace-init.ts", … ]        // package.json:31–47
```
```ts
import { doctorCommand } from "./grace-doctor";           // src/grace.ts:26
import { testCommand } from "./grace-test";               // :27
import { packetCommand, focusCommand } from "./grace-packet"; // :28
import { contextCostCommand } from "./grace-context";     // :29
import { verifyCommand } from "./grace-verify";           // :30
```
Packing is decisive: `bun pm pack --dry-run` lists only the 10 files above (`0` matches for the 5 missing ones), and running the simulated installed package prints
`error: Cannot find module './grace-doctor' from '/tmp/pkgtest/src/grace.ts'` (exit 1).
The same `files` array also omits `packages/mygrace-dsh`, while `installBundle()` defaults to exactly that directory (`bundleDir()` = `<pkg>/packages/mygrace-dsh`, grace-install.ts:359–361, 371–372) — so the README's primary quick-start `mygrace install-dsh --bundle` (README.md:15–16) cannot work in an installed copy. `prepublishOnly` (package.json:59) runs tests/lint/marketplace checks but **nothing validates the tarball**, and `scripts/validate-marketplace.ts` only checks that repo files exist, not that npm would ship them. Registry probe returned HTTP 404 for `@osovv/mygrace-cli` at audit time (may be unpublished/sandboxed; treated as external signal, not proof).

### H-1 (HIGH, VERIFIED) Repo-controlled XML executes arbitrary commands

```ts
const cmd = parseCheckCommand(moduleContent);                       // grace-test.ts:76
const [file, ...rest] = cmd.split(" ").filter(Boolean);             // :77
const result = spawnSync(file, [...rest, ...files], { cwd: root }); // :78
```
`files` comes from `<test-files><file>…` in `docs/verification/V-M-*.xml` (grace-test.ts:25–29, 67). `<file>` entries are appended as raw argv, so the attacker controls both the executable (`<check-1>`) and arbitrary options (e.g. two `<file>` nodes). Reproduction (all state under `/tmp`):

```
docs/modules/M-A.xml        <module-checks><check-1>bash</check-1></module-checks>
docs/verification/V-M-A.xml <test-files><file>-c</file><file>id > /tmp/PWNED_SHELL.txt; echo hacked</file></test-files>
$ mygrace test --path /tmp/pv  --module M-A     →  prints "hacked", exit 0
$ cat /tmp/PWNED_SHELL.txt                       →  uid=1000(truffle) …
```
`mygrace verify` takes the same path (grace-verify.ts:32 → grace-test.ts:62). With no `--module`, `test`/`verify` iterate **every** module in `graph-index.xml` (grace-test.ts:92), so one malicious repo file runs without any per-module opt-in. Trust boundary: `docs/` is attacker-controlled data in a cloned repository, and the tool's own methodology tells agents to run these commands; no allowlist, confirmation, or `--dry-run` exists. (Tests in a repo are inherently executable code — but here the *command line itself* is data from XML, so even a repo with no tests inherits arbitrary command execution.)

### H-2 (HIGH, VERIFIED) `lint --format json` always exits 0

```ts
if (args.format === "json") {
  console.log(JSON.stringify(issues, null, 2));
  return;                                  // grace-lint.ts:283–286 — exits run() here
}
…
process.exit(errors.length > 0 ? 1 : 0);   // :313 never reached in JSON mode
```
Same 3-error project, back-to-back: text format → exit **1**; `--format json` → exit **0** while printing three `"severity": "error"` entries. Any CI/agent loop using the machine-readable format records success on failure. Through MCP, `mygrace_lint {format:"json"}` returns a normal (non-`isError`) result with the error JSON; other formats return `MyGRACE MCP error: Command failed: …` (no detail) — the failure signal is inverted depending on format.

### H-3 (HIGH, VERIFIED) The documented `<module-checks>` contract is ignored

Templates, the skill docs and the demo project all place the command in the **verification** file:
```
templates/verification/V-M-XXX.xml.template:5–7   <module-checks><check-1>$VERIFICATION_COMMAND</check-1></module-checks>
skills/mygrace/grace-verification/SKILL.md:39      <module-checks><check-1>$COMMAND</check-1></module-checks>
examples/demo-store/docs/verification/V-M-AUTH.xml:3
```
The implementation reads it from the **module** file instead:
```ts
const moduleContent = readFileOrNull(join(root,"docs","modules",`${moduleId}.xml`)); // grace-test.ts:63
const cmd = parseCheckCommand(moduleContent);                                        // :76
```
Because module files contain no `module-checks` (templates/module/M-XXX.xml.template), the default `"bun test"` is **always** used. Verified: a project whose verification file says `echo SHOULD_HAVE_RUN` ran `bun test AAAA` instead (exit 1); moving the same block into the module file made `echo` run. Consequence: every project following the docs silently loses its scoped/custom test command; `focus`'s promised "Tests:" line can never appear either (grace-packet.ts:109 reads the module file). The unit tests cement the bug by writing `module-checks` into the module fixture (test/grace-test.test.ts:62–80).

### H-4 (HIGH, VERIFIED) Regex "XML parsing" silently corrupts data and validates nothing

Attributes: `/(\w+)="([^"]*)"/g` (grace-common.ts:36–38) and entry regex `/<(M-[\w-]+|V-M-[\w-]+|Phase-\d+)([^>]*?)(?:\/>|>…)/` (grace-common.ts:48). Probes:

| Input (valid or plausible XML) | Actual result |
|---|---|
| `<M-GT NAME="A > B comparison" … />` | entry **dropped**: module missing from list/lint, lint then reports a false "Missing index entry: M-GT" |
| `<M-SQ NAME='Single Quoted' TYPE='UTIL' STATUS='done' />` | tag matched, `attrs = {}` → blank table row, status counted as `unknown` |
| `<Phase-1a name="Alpha" status="pending" />` | parsed as `Phase-1` plus garbage attr → lint reports both "Orphaned index entry: Phase-1" and "Missing index entry: Phase-1a" |
| `<M-DUP …/>` twice | both entries kept; duplicates never flagged, counted twice in status |
| unclosed `<M-A NAME="A" STATUS="pending"` | 0 entries, **lint: 0 errors, "✓ All checks passed"**, exit 0 |
| `<!-- broken comment <M-GHOST … />` (unterminated) | ghost entry parsed and displayed in `module list` |
| `<![CDATA[ <M-FAKE …/> ]]>` | fake entry parsed and displayed |
| attribute with newline | parsed, then `formatTable` row wraps/misaligns (cosmetic) |

The file header claims the lint "Validates index files exist and are parseable" (grace-lint.ts:5–10); no XML validation exists — the tool cannot distinguish a corrupt index from an empty one (see M-4). Note that 3 of 15 repo `src` files "contain MODULE_CONTRACT" only because detection regexes/Tool descriptions include the literal (grace-file.ts:32–36, grace-lint.ts:135–136, grace-mcp.ts:199) — the same substring-counting weakness that makes lint blind to real markup.

### H-5 (HIGH, VERIFIED) Path traversal through module IDs (`packet`, `focus`, `test`, `verify`)

```ts
const moduleContent = readFileOrNull(join(root,"docs","modules",`${moduleId}.xml`)); // grace-packet.ts:61
const verContent     = readFileOrNull(join(root,"docs","verification",`V-${moduleId}.xml`)); // :66
```
`moduleId` is `args.id` used verbatim (grace-packet.ts:60,95; same in runModuleTests, grace-test.ts:63). Unlike `module show`, there is no index/prefix validation. Verified over MCP JSON-RPC:

```
mygrace_packet {"path":"/tmp/packroot","id":"../../../../tmp/traversed"}
→ "=== PACKET ../../../../tmp/traversed — unknown === … <X>SECRET-XML-DATA</X>"
```
So an agent is one tool call away from reading any `*.xml` file on the host through a "packet"/"focus" request (the content is printed raw under "## Contract"). `test`/`verify` can additionally aim the spawn machinery at a file outside the project. Mitigation today is accidental: the `.xml` suffix must exist.

### H-6 (HIGH, VERIFIED) Stack traces and crash paths

Only `lint` wraps `findProjectRoot` and scan errors (grace-lint.ts:270–281). Every other command lets the plain `Error` (grace-common.ts:30) or Node `EACCES/EISDIR/ENOENT` escape to citty, which prints a full source-snippet + stack (`console.error(error)` in citty's `runMain`). Reproduced for `status`, `module list`, `module show` (unreadable module file), `context-cost`:
- `status --path /tmp/nonexistent` → raw stack (grace-status.ts:61).
- `mygrace module show M-A` where `docs/modules/M-A.xml` is chmod 000 → raw EACCES stack (`existsSync` passes, `readFileSync` throws, grace-common.ts:74–76).
- `context-cost` on a valid project (`docs/graph-index.xml` present) with no `docs/modules/` or `docs/plans/` **crashes**, because the guarded `linesOf()` helpers are bypassed by a bare `readdirSync`:
```ts
const sampleModule = readdirSync(modulesDir).filter(…)[0] || "M-XXX.xml";  // grace-context.ts:44
const samplePhase  = readdirSync(plansDir).filter(…)[0] || "Phase-1.xml";  // :45
```
This violates the CLI's own contract of readable errors ("MyGRACE project not found. Run in a project with docs/graph-index.xml") and the CHANGELOG's "fails in milliseconds with a readable error" claim — true for `lint`, false for most other command groups.

### H-8 (HIGH, VERIFIED) MCP swallows the payload of failed runs

```ts
const { stdout, stderr } = await exec(MYGRACE_BIN, cmd, { env, timeout: 30_000 }); // grace-mcp.ts:229
if (stderr && !stdout) return { … text: stderr …, isError: true };                  // :230
… catch (err:any) {
  if (name === "mygrace_doctor" && err?.stdout) return { … text: err.stdout.trim() }; // :234
  return { content:[{type:"text", text:`MyGRACE MCP error: ${err?.message || String(err)}`}], isError:true };
```
Verified: `mygrace_test` failing → `"MyGRACE MCP error: Command failed: /tmp/mcpwrap/mygrace test --path /tmp/pv2 --module M-A --compact"`; `mygrace_verify` same; `mygrace_lint` (text) same. The test digest, the lint report and the `.mygrace/last-failures.md` hint never reach the client, contradicting tool descriptions that advertise a digest and "Exit 1 on failure — for agent loops" (grace-mcp.ts:159–169). `doctor` is the only command allowed its output, which is backwards: doctor is a *health report*, tests are the *loop signal*.

### XML/index correctness (additional verified MEDIUM items)

- **M-1 STATUS drift blind spot.** Drift check reads `fileContent.match(/STATUS="([^"]*)"/)` (grace-lint.ts:81), but the canonical `plan-index`/phase attribute is lowercase `status` (templates/plan-index.xml.template:3). Verified: index `status="pending"` vs file `status="done"` → **0 warnings, exit 0**. (Uppercase module drift is detected — as a warning, exit 0.)
- **M-2** `content.match(/<verification-ref>…/)` (grace-lint.ts:202) is non-global: with two refs and a valid index, the broken second ref produced **0 errors**.
- **M-3 pairing is count-only.** `START_BLOCK_ALPHA` + `END_BLOCK_BETA` → `file show --blocks` prints "✓ Paired" and lint exits 0. Conversely, `const msg = "START_BLOCK_DOCSTRING_ONLY"` yields a false "Unpaired semantic blocks: 1 START vs 0 END" error (both verified). The name-sets logic in grace-file.ts:75–84 only runs when counts already differ, so it can never diagnose the mismatched-name case.
- **M-19 misleading errors:** absent `V-M-A.xml` is reported as `no <test-files> in V-M-A.xml` (file does not exist; verified); a missing `plan-index.xml` yields two errors, one from `lintIndexSync` (grace-lint.ts:36 "… — run mygrace-init") and one from the required-index loop (grace-lint.ts:239–245) (verified); `docs/modules` as a regular file surfaces `✗ [project] ENOTDIR: not a directory, scandir …` in the lint report and a raw stack from `status`.
- **M-13 inconsistent id handling** (`M-AU` → module show resolves M-AUTH; focus/packet fail with "not found"), verified.
- **M-6 status always exits 0** even with 3 lint errors (verified, both formats) — documented as a panel feed, but it is also a CLI command and `status` is what agents/scripts are told to run.
- **M-5 doctor** JSON mode exits 0 with `errors: 4` (verified); text mode exits 1.

### Lint capability gaps (LOW/MEDIUM)

- `lintMarkup` scans only `src/lib/apps/packages` (grace-lint.ts:100) — governed files in e.g. `scripts/` are never checked; it does not exclude `node_modules`, `dist`, or `.git`, so a vendored file with a marker inside `packages/*/node_modules` produced a lint **error** (verified). Its catch-all swallows every read error silently (grace-lint.ts:145–147).
- `lintXmlTags` only scans 4 hard-coded dirs, non-recursively (grace-lint.ts:157–191); commented-out template examples are not stripped, so docs that ship commented examples can emit false "Generic XML tag" warnings; `docs/archive` is unchecked.
- Documented index budgets ("≤100 lines", "≤50", "≤80" in AGENTS/README) are not enforced anywhere in lint; `context-cost` merely reports.
- `parseIndexEntries` strips comments but not CDATA/PIs (verified CDATA ghost entry).

### Other verified command bugs

- **Test runner ambiguity:** `spawnSync` result errors are ignored — a missing executable yields `ok:false` with an empty body (`grace-test.ts:78–80`), so the user sees `files: x.ts` then blank then "1 failed" with no cause (verified Q). `result.error` should be surfaced.
- **`test` on a project with empty `graph-index.xml`** prints "Summary: 0 module(s), 0 failed" and exits 0; `verify` prints "Verify: 0 ok" exit 0 — a broken/empty project reads as success (verified).
- **`lint --allow-missing-docs --path <nonexistent>`** prints "✓ All checks passed. MyGRACE artifacts are consistent." exit 0 (verified M-4) — the flag turns off the only guard without requiring the path to exist.
- **Command-line parse laxity:** `mygrace lint --pth examples/demo-store` silently ignores the typo and lints `.` (verified); `--format jsno` silently falls back to text (verified). Both should be rejected.
- **`module index` dead branch/message:** the `existsSync` check can never fire because `findProjectRoot` requires `docs/graph-index.xml`; the error text still says `Run /mygrace:init first.` (grace-module.ts:30–33) — stale slash-command syntax, contradicting CHANGELOG:42's stale-reference cleanup claim while showing the check is unreachable dead code.
- **`verify --all`** is declared (grace-verify.ts:23) and mentioned in the docstring (`[--all]`, :6) but never read — dead arg.
- **`test`/`verify` duplicate index entries** run a module twice (L-3, implied by regex parse; verified duplicate entries are kept).

---

## 3. Security & robustness

### 3.1 Trust-boundary model assumed by the code

There is no explicit trust model. The tool treats `docs/**/*.xml` as *configuration* while it is really *content from whatever repo got cloned*. This produces three attack surfaces:

1. **Command execution (H-1, HIGH, verified).** Arbitrary executable/option injection via `module-checks`/`test-files`. Worst-case verification: `bash -c 'id > /tmp/PWNED_SHELL.txt; echo hacked'`, exit 0, no prompt.
2. **Path traversal reads (H-5, verified).** `packet`/`focus`/`test`/`verify` interpolate the module id into paths unvalidated; over MCP an agent can lift `/…/anything.xml` content into the conversation. `show_file` also accepts any absolute path (grace-file.ts:22–28) but only prints extracted markup blocks, which bounds that primitive.
3. **Installer writes (M-9, verified; H-7).** `--profile` is joined into the home path without validation (`join(home,"profiles",profile,"cordis.patch.yml")`, grace-install.ts:52–54); `--profile ../../evil` patched `/tmp/evil/cordis.patch.yml`. `--dsh-home`/`--source` are similarly unvalidated, and `installBundle` `JSON.parse(readFileSync(<source>/package.json))` throws a raw stack even under `--dry-run` (verified: grace-install.ts:372).

### 3.2 Positives

- Fixed commands are spawned as argv arrays, never via a shell (`execFile`, `spawnSync(…, args)`) — no shell-string injection in `doctor`, `install-dsh` or MCP dispatch itself (`buildToolCommand` returns discrete argv, grace-mcp-commands.ts:30–109).
- YAML path quoting uses proper single-quote doubling (`yamlSingle`, grace-install.ts:57–59); patch entry does not interpolate user strings unquoted except the fixed `name:` values.
- No `eval`, no `new Function`, no dynamic `require` of user data.
- MCP tool schemas constrain `status`/`priority`/`format` enums client-side (grace-mcp.ts:35–38 etc.), and `mygrace_show_module` path traversal is blocked by index lookup before path use.

### 3.3 Config-mutation robustness (H-7, all verified)

- **No atomic write:** `writeFileSync(patchPath, next)` directly on the user's harness config (grace-install.ts:207, 244, 317). A crash/disk-full mid-write corrupts the config; the only safety net is a copy made immediately before.
- **Backup is single-slot and overwritten every mutation:** install writes `.mygrace-backup`, later install/uninstall overwrites it. Verified numeric test: pristine `[]` → install → uninstall ⇒ backup contains `id: mcp-mygrace` (the pre-uninstall content), pristine `[]` is unrecoverable.
- **No YAML validation before/after edit:** `addPatchEntry` is line-surgery. Verified: on a mapping-root document (`some:\n  key: value`) it appends a top-level sequence → invalid YAML; on a nested empty list (`wrapper:\n  []`) it replaces the nested line with a top-level `- insert:` block → structure destroyed. `readme/CHANGELOG` claim "idempotent" applies only to exact-substring detection.
- **Uninstall false success (verified):** `removePatchEntry` only recognizes the canonical form when `- insert:` is immediately followed by a line `trim() === "- id: mcp-mygrace"` (grace-install.ts:134–139). With the `id` as a non-first child (valid YAML, reordered), removal is skipped, the unchanged content is returned (`next !== null`), and `uninstallMcp` writes it back and claims `removed mcp-mygrace row from …`. CLI-level diff confirmed: file unchanged, message says removed.
- **Idempotency false positive (verified):** `content.includes("id: mcp-mygrace")` (grace-install.ts:94–96, 103) matches `- id: mcp-mygrace-extra`; `install-dsh` then says "already present", patches nothing, exit 0. Same substring check gives `doctor` false "MCP row present" (grace-doctor.ts:109) and false "status panel installed" (grace-doctor.ts:118).
- **`init-dsh --force` data loss (verified):** existing `AGENTS.md` replaced by the template with no backup (grace-init.ts:105–113); index files would be clobbered the same way.
- **Windows `spawnSync` smell (M-11):** `pnpm`/`dsh` are invoked by bare name without `shell:true` (grace-install.ts:284, 344, 385–390). Windows `.cmd` shims are not executable via CreateProcess; failure is then reported as `exit null` because `result.error` is ignored (verified the `exit null` message path in this environment where pnpm is genuinely missing — it should say ENOENT).

### 3.4 MCP-specific robustness

- **`MYGRACE_BIN` defaults to `"mygrace"`** (grace-mcp.ts:22). Verified: with no global binary, initialize succeeds but every `tools/call` returns `MyGRACE MCP error: Executable not found in $PATH: "mygrace"`. The legacy installer writes an MCP row that starts `bun run <abs>/grace-mcp.ts`, so the server does not know its own CLI's location and relies on the user's `PATH`; the error text gives no hint. Should resolve to `process.execPath` + `grace.ts`/package path (or `MYGRACE_BIN` default to the sibling entry).
- **Fixed 30 s timeout and default 1 MiB `maxBuffer`** (grace-mcp.ts:229, smell): real `test`/`verify` suites and large `module show`/`packet` outputs will fail through MCP even though the CLI works.
- **Version drift in `serverInfo`** `"0.1.0"` (grace-mcp.ts:24) vs package `1.0.1`.
- **No root containment for `path`:** `mygrace_show_file`/`list_modules` accept any path; combined with the agent context this is an arbitrary-directory read surface (bounded for `show_file` by markup extraction; unbounded for `packet` via H-5).
- **Unbounded reads generally:** index/module/file reads have no size cap; a multi-GB XML would OOM the process (LOW, smell).

### 3.5 Shell-exec / crash-path inventory

| Location | Command source | Shell? | Risk |
|---|---|---|---|
| grace-test.ts:78 | executable+args from repo XML | no, but **attacker-chosen executable and argv** | H-1 RCE |
| grace-install.ts:284/344 | fixed `pnpm` | no | .cmd portability (M-11) |
| grace-install.ts:385–390 | fixed `dsh` | no | .cmd portability; `--source` user path |
| grace-doctor.ts:51–59 | fixed `dsh/rtk/caveman/bun/node/pnpm --version` | no | no timeout → hang risk; runs on every MCP doctor call |
| grace-mcp.ts:229 | `MYGRACE_BIN` + mapped argv | no (`execFile`) | env-controlled binary; argv values beginning with `-` can be reinterpreted as flags by citty (verified: `--path --format` consumes the flag as a path) |

---

## 4. Dogfooding: does the project follow its own methodology?

**Short answer: no, and the gap is structural rather than incidental.**

### 4.1 `src/` semantic markup coverage

| Metric | Count |
|---|---|
| `src/*.ts` files | **15** |
| Files with a real `START_MODULE_CONTRACT` comment block | **0 (0%)** |
| Files with `START_MODULE_MAP` / `START_CHANGE_SUMMARY` | **0** |
| Files with a real `START_BLOCK_*`/`END_BLOCK_*` pair | **0** |
| Files containing the string `MODULE_CONTRACT` only as detection code/tool text | 3 — grace-file.ts:32–36 (regex), grace-lint.ts:135–136 (`.includes`), grace-mcp.ts:199 (tool description) |
| `[Module][fn][BLOCK]` log lines (AGENTS.md "Log format") | **0** |

The methodology's first principle is "Never write code without a contract — every governed file has `MODULE_CONTRACT` (PURPOSE, SCOPE, DEPENDS, LINKS) before code" (AGENTS.md:26–31). None of the 15 core files carries one. `grace-lint` cannot enforce its own principle: the only contract check is a *warning* when a file has **more than two** block markers and no contract (grace-lint.ts:132–143), so a file with zero markers (the common case here) is completely ignored. This is why running `mygrace lint` on its own repo passes once docs are bypassed: the contract rule is unenforced.

### 4.2 The repository itself is not a MyGRACE project

- There is **no `docs/` directory** at the repo root. Default `mygrace lint --path .` exits 1 "MyGRACE project not found" (verified). The passing invocation used by the project is `lint --path . --allow-missing-docs` in `prepublishOnly` (package.json:59).
- Root `AGENTS.md` says "This project is governed by MyGRACE" and prescribes navigation over `docs/graph-index.xml`, `docs/plan-index.xml`, `docs/verification-index.xml` (AGENTS.md:5–13) — none exist. So agents following the shipped instructions are sent to missing files.
- Root `AGENTS.md` is a **stale copy** of the template: it lists 7 MCP tools (AGENTS.md:39) vs the template's 15 (templates/AGENTS.dsh.md.template:39), and lacks the template's "Token budget & workflow" section (templates/AGENTS.dsh.md.template:86). CHANGELOG:55 nevertheless calls the AGENTS.md shipment "dogfooding".
- The real dogfood target is `examples/demo-store`: lint 0/0 passes (verified) and its 12 tests pass (verified), but only **12 of its 24 source files (50%)** carry contracts and its lint reports 0 warnings — because of the vacuous enforcement above. "Dogfooding passes 0/0" is therefore true but does not demonstrate compliance with principle #1.
- Lint's own advertised checks are stronger than its implementation: header claims "index files … parseable" and "unique XML tag conventions" (grace-lint.ts:5–10), yet malformed XML passes as success and duplicate entries are unflagged (H-4/L-2). Index size budgets in the methodology are never checked (M-18).
- Cross-manifest version drift (not src, but it undermines the "single knowledge graph" story): `package.json` 1.0.1, `openpackage.yml` 0.1.0, `.claude-plugin/marketplace.json` metadata 0.3.0, MCP `serverInfo` 0.1.0.

### 4.3 Stale self-claims vs. code (contradictions found)

| Claim | Reality |
|---|---|
| Task premise: "`bun run src/grace.ts lint --path .` passes" | Fails (exit 1, no docs/); only `--allow-missing-docs` passes |
| CHANGELOG:58 "lint outside a project fails in ms with a readable error instead of looping forever" | Loop fix is genuine, but only `lint` is readable; `status`, `module list`, `context-cost`, `file` print raw stacks (H-6) |
| CHANGELOG:42 stale `/mygrace:init` references fixed | Still present in grace-module.ts:31 |
| CHANGELOG:9,51,53 / grace-install.ts:406 "14 skills" | 15 skill dirs exist and README:31/15 says 15 |
| grace-test.ts:9–10 "run command comes from docs/modules/M-XXX.xml" | Code and comment agree, but templates/skills/demo put it in the verification file (H-3) — the documented workflow is broken |
| grace-lint.ts:5–10 "Validates … parseable" | No XML parse validation (H-4) |
| README.md:13 `bun add -g @osovv/mygrace-cli` | Package as configured would not start if published (C-1); registry returned 404 at audit time |
| AGENTS.md:5–13 project-governed-by-MyGRACE navigation | No docs/ tree in the repo |
| `mygrace_test` description "digest, exit 1 on failure" (grace-mcp.ts:109) | MCP returns a generic `Command failed` error, no digest (H-8) |
| grace-install docstring "Both steps are idempotent" (grace-install.ts:12–13) | MCP row: yes; skills: re-copied every run, overwriting user edits; blind to `mcp-mygrace-*` ids (M-8/L-6) |

---

## 5. Error-handling quality (summary inventory)

- **Swallowed exceptions:** `grace-lint.ts:145–147` (`catch {}` around the whole source walk — read/stat errors vanish, symlink loops are silently clipped); `grace-doctor.ts:55–57` (probe failure indistinguishable from not-installed, acceptable); `grace-install.ts:262–267` (JSON parse failure → "panel not installed", hides corrupt package.json); `grace-install.ts:392–398` (spawn `result.error` printed but exit based only on `status`); `grace-test.ts:78–80` (`result.error` ignored entirely).
- **Unchecked I/O:** `readFileSync` at grace-common.ts:70/76, grace-lint.ts:40/80/118/177/201, grace-context.ts:16, grace-doctor.ts:109/118, grace-file.ts:28, grace-install.ts:189/233/263/302/327/372, grace-init.ts:110 — all after `existsSync` (TOCTOU) or with no guard; unreadable/directory targets become stack traces (H-6).
- **Inconsistent error channel:** some commands `console.error` + `process.exit(1)` (grace-module.ts:31, 103–119, 196, 216, 239), some `throw` (grace-common.ts:30), `lint` collects issues, `doctor` encodes in report (`project.error`). Exit codes therefore vary by command *and* output format (H-2, M-5, M-6, L-10).
- **Missing validation:** `--format` values, status/priority/type filters in `module find/list` (case-sensitive while verification priority is case-insensitive), `--profile`/`--dsh-home`/`--source` paths, numeric/positional args, module IDs (H-5). `flag` typos are silently ignored (L-9).
- **Positive:** `runMain` catch gives exit 1 on any throw; MCP handler wraps every tool call in try/catch; `findProjectRoot` has a bounded loop + readable message; `lint` converts scan failures into an error list instead of crashing; install functions return action lists that make dry runs possible.
- **Non-null assertions / loose typing:** `dsh.version!` etc. guarded by `found` (safe but avoidable), `catch (err: any)` (grace-lint.ts:279, grace-mcp.ts:232), `(args ?? {}) as ToolArgs` (grace-mcp.ts:228), citty `args` used without runtime validation. With no `tsconfig`/strict mode these are not even compiler-visible (M-16).

---

## 6. Scores (1–10, brutally honest)

| Dimension | Score | Justification |
|---|---|---|
| **Architecture** | **5/10** | Command-per-file split, a genuinely shared `grace-common`, a pure MCP mapping layer and correct `verify→test` reuse are decent; but the MCP server shelling out to its own CLI is a second execution path that causes H-2/H-8/M-12/M-13; layering leaks (`status→lint`, `doctor→lint+install`); the same grammar/catalog is written 2–4 times; 15 flat files with zero module contracts in a project whose thesis is contracts; packaging `files` omission makes the published architecture nonfunctional (C-1). |
| **Error handling** | **3/10** | Only `lint` handles errors gracefully; the other command groups leak raw stack traces on ordinary conditions (no project, EACCES, missing dirs); injected `catch {}`s swallow read/spawn errors; exit codes are wrong in JSON mode (H-2) and inconsistent by format (M-5/M-6); error messages are sometimes actively misleading (ENOTDIR surfaced as a lint issue, "no `<test-files>`" for a missing file, "off by exit null"). Credit for the bounded root walk + regression test and MCP try/catch, but the discipline is absent. |
| **Security** | **3/10** | Two verified exploit primitives: unattended arbitrary shell execution from repo XML (H-1) and path-traversal reads via module IDs, exposed over MCP (H-5); unvalidated `--profile` traversal writing config files (M-9); installer can corrupt/lose user config (H-7). Mitigations exist (argv-only exec for fixed commands, YAML quote escaping, no eval, markup-only `show_file`), which keeps it above 2, but a tool that hands a cloned repo command execution and tells agents to run it is a serious trust-boundary failure. |
| **Testability** | **5/10** | 107 passing tests across 22 files with temp-dir isolation; good exports (`buildToolCommand`, parsers, patch helpers, report builders) and a specific regression test for the historical hang; `verify→test` reuse. But `run()` handlers, exit codes, malformed-XML behavior, MCP handler and installer file flows are untested; no coverage tooling; no typecheck (M-16); and the fixtures encode the wrong `<module-checks>` location, cementing H-3. |
| **Maintainability** | **4/10** | Reads well, consistent style, useful commentary; but stale comments as documentation (L-1), duplicated regexes/catalogs, dead code (`TOOL_NAMES`, `verify --all`, unreachable branch), 468-line installer mixing four concerns, no formatter/linter/tsconfig/CI typecheck, no module boundaries, and a tests/lint suite that would not catch the release-blocking packaging omission. |

**Weighted overall: ~4/10** — a promising, genuinely useful tool at prototype quality. The happy path (demo-store lint/status/test, findProjectRoot) works and is tested; the release, security and error-handling engineering is not production-ready.

---

## 7. What was probed (repro summary)

All scratch state in `/tmp` (throwaway projects): valid/invalid index XML variants (`>`, quotes, comments, CDATA, duplicates, multiline attrs, non-numeric phases, empty/unclosed); missing `docs/*` dirs and files-as-dirs; chmod-000 files; nested/bad project roots (timing at `/`); symlink loop under `src/`; 4 lint source trees incl. vendored `node_modules`; malicious `module-checks`/`test-files` (bash `-c` command execution confirmed); path-traversal ids over CLI and MCP; MCP stdio JSON-RPC sessions (initialize/list/call) against working and broken projects, with/without `mygrace` on `PATH`; fake `$DSH_HOME` profiles for install/dry-run/idempotency/uninstall/backup/path-traversal/reordered-block tests; `init-dsh` fresh + `--force` runs; `bun pm pack` tarball inspection + simulated installed package; clean `bun test` state.

**Limitations:** Windows behavior is static analysis only; `/tmp` is not persistent across separate tool calls in this harness (each multi-step repro was executed within a single invocation); npm registry returned 404 for the package (external, possibly sandboxed; C-1 stands on the tarball evidence). No project files were modified; analysis only.
