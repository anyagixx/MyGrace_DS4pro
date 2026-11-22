# Audit 04 — DSH integration + npm packaging (empirical)

**Auditor:** integration-packaging-auditor (task-4)
**Date:** 2026-11-22
**Project:** `@osovv/mygrace-cli` v1.0.1 (MyGRACE)
**Reference implementation:** real DeepSeek Harness `@deepseek-ai/dsh` **0.2.1-rc.2** at `/usr/lib/node_modules/@deepseek-ai/dsh/` (`dsh/package.json:4`)
**Environment:** bun 1.4.5 (`/home/truffle/.bun/bin/bun`), node 26.13.1, npm 12.2.3, DSH web GUI live on 3080 (not restarted).

## Method / safety

* All install/dry-run/uninstall tests ran with a **sandboxed `HOME` + `DSH_HOME` under `/tmp`** (fresh tmpfs per bash call; some long sequences were done in a single call). The real `~/.dsh` was only ever read.
* Verified after all tests: real profile patch hash unchanged (`sha256 1d00ee4d…b27d7`, 0 rows containing `mcp-mygrace`), no `~/.dsh/skills` directory created. Nothing was written to `~/.dsh` or to the DSH installation.
* Environment quirk found while testing: `spawnSync("pnpm", …)` fails here with **ENOEXEC** because `/usr/bin/pnpm` is a shebang-less `sh` shim (documented pnpm 11.28.4 packaging issue). DSH's *own* `dsh plugin` fails identically on this box (PNPM log: `Command failed with ENOEXEC: pnpm add …`; `/usr/lib/node_modules/@deepseek-ai/dsh/lib/plugin-BiveYA7h.js:94` only special-cases exit 127). To separate environment faults from product faults, the affected tests were repeated with a shebang `#!/bin/sh → node /usr/lib/node_modules/pnpm/bin/pnpm.mjs` shim on PATH and a scrubbed env (`env -i`), which makes pnpm 12.11.2 work normally.
* DSH itself was exercised read-only through its own CLI: `dsh --profile web --dump-config` (composition + loader patch validation) and by reading the vendored sources. Full `dsh web` boot against a temp home was deliberately not done (would start a second GUI / collide with the live 3080 instance); the composed-config check plus source cross-checks are the strongest non-disruptive evidence.

---

## 1. Verdict (short)

| Question | Answer |
|---|---|
| Is `install-dsh` idempotent? | **YES for the legacy path** — proven empirically: byte-identical content snapshot after re-run, no duplicate loader rows, patch restored byte-identically by `--uninstall`. Caveats below (re-copy messages, panel retry, backup residue). |
| Does the written config match what DSH 0.2.1-rc.2 expects? | **Format yes, packaging no.** The `- insert:` row shape, `@deepseek-ai/dsh-mcp-client` name and `transport/serverName/command/args` config match the loader schema and DSH's own official templates exactly; `dsh --dump-config` accepts the patched profile. But the **`--bundle` path cannot work as shipped** (neither in a checkout nor from npm), and the host-plugin's runtime resolution of `@deepseek-ai/dsh-mcp-client` fails in a profile install. |
| Is "one-command install" credible on a clean machine? | **No, not as published.** The published tarball's CLI cannot even start (5 imported `src/` modules are excluded by `files`); `install-dsh --bundle` is impossible from the tarball (bundle package not shipped) and structurally broken even in a checkout. The **legacy** path (skills + MCP row, plus panel if pnpm works) does work **from a git checkout after `bun add -g .`**, but needs: DSH profile already booted, spawnable `pnpm`, and `mygrace` on DSH's PATH (MYGRACE_BIN is never set). |
| Are the four `packages/*` real plugins or stubs? | Mixed: `dsh-skill-mygrace` and `dsh-mygrace-rtk` are real and behave correctly (15 skills load, rtk rewrite works, correct `tools/execute` hook); `mygrace-dsh` (bundle host) is a real attempt but its MCP mount is broken in installed layouts; `mygrace-status-panel` host half is a no-op and its browser half is a **static decorative card**, not a status panel (no data, no API). |

**Scores (1–10):**
* install-dsh correctness: **5/10**
* DSH integration fidelity: **6/10**
* packaging / publishability: **2/10**
* docs match (install path only): **4/10**

---

## 2. Empirical install lifecycle (legacy path)

Temp env: `HOME=/tmp/…/home`, `DSH_HOME=$HOME/.dsh`, web profile patch/package.json copied read-only from the real profile.

### 2.1 Dry-runs — exact planned actions (exit 0, no writes)

`bun run src/grace.ts install-dsh --dry-run`:

```
DSH home:   /tmp/…/home/.dsh
Skills dir: /tmp/…/home/.dsh/skills
• would copy grace-ask → …/skills/mygrace-ask
… (15 skills: ask, cli, execute, explainer, fix, init, multiagent-execute,
   plan, refactor, refresh, reviewer, setup-subagents, status,
   token-budget, verification)
• would patch …/profiles/web/cordis.patch.yml with the mcp-mygrace MCP row
• would pnpm add file:/…/packages/mygrace-status-panel into profile web
• would patch …/profiles/web/cordis.patch.yml with the mygrace-status-panel row
```

`--bundle --dry-run` prints `Would run: dsh plugin --profile web add /…/packages/mygrace-dsh`; `--uninstall --dry-run` correctly reports "MCP row not present … nothing to remove / panel not installed". All three switch environment variables overridable via `--dsh-home` (both `--dsh-home` and `--dshHome` are accepted; help prints camelCase — cosmetic).

### 2.2 Real install — files written

```
• installed mygrace-ask … mygrace-verification          (15 skill dirs, SKILL.md each)
• patched …/profiles/web/cordis.patch.yml (backup: cordis.patch.yml.mygrace-backup)
• WARNING: pnpm add failed (exit null) — panel skipped   ← see §2.5
EXIT=0
```

Patch tail after install (valid YAML; accepted by `dsh --profile web --dump-config`):

```yaml
- insert:
    - id: mcp-mygrace
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        transport: stdio
        serverName: mygrace
        command: '/home/truffle/.bun/bin/bun'
        args:
          - run
          - '/home/truffle/Downloads/MyGrace_DS4pro-main/src/grace-mcp.ts'
```

Only writes: 15 skill dirs, `cordis.patch.yml`, `cordis.patch.yml.mygrace-backup` (plus Bun's own `$HOME/.bun` cache caused by running bun under a temp HOME — not a product write). The pre-existing foreign rows were preserved.

### 2.3 Idempotency — PROVEN

Second, identical real install:

```
• installed mygrace-ask … mygrace-verification     (re-copied; outputs "installed" every time)
• MCP row already present in …/cordis.patch.yml — skipping
• WARNING: pnpm add failed (exit null) — panel skipped
EXIT=0
```

Content-hash snapshot of the whole temp home after run 1 vs run 2: **IDENTICAL** (files + directories); patch contains exactly one `mcp-mygrace` block; only one `.mygrace-backup` file. So idempotency claim (`src/grace-install.ts:12`, PLAN.md:50, PLAN.md:108) **holds** for the legacy path. Nuances: (a) every re-run re-copies all skills and prints "installed …", so it is operationally idempotent but not no-op; (b) if the panel step failed, it is retried (and fails) on every run; (c) backup is created only on the first successful mutation.

### 2.4 Uninstall — restores config, leaves small residue

```
• removed …/skills/mygrace-ask … mygrace-verification
• removed mcp-mygrace row from …/cordis.patch.yml
• panel not installed — nothing to remove
EXIT=0

diff original-patch vs after-uninstall: IDENTICAL (byte-for-byte; same sha256)
```

Residue (not "clean"): `cordis.patch.yml.mygrace-backup` is left behind; `$DSH_HOME/skills/` empty dir remains; with the panel actually installed, pnpm's normal `.pnpm/` metadata remains and the command still prints the **activation instructions** ("Done. To activate: …") after uninstalling (`src/grace-install.ts:462-466`), which is misleading.

### 2.5 Panel step on this environment (significant)

`pnpm add` is invoked directly (`src/grace-install.ts:284`). Here pnpm is the shebang-less shim → `spawnSync` fails with **ENOEXEC**; the code only reads `result.stderr`/`status`, reports `WARNING: pnpm add failed (exit null)` and **exits 0**. A user reading the output sees a successful install; the documented "status card" silently does not exist. The same failure hits DSH's own `dsh plugin` command on this box, so it is partly environment-level — but the installer chooses to treat a failed integration step as success, and its diagnostic ("exit null") is useless. With a Node-spawnable pnpm shim, the same install succeeded: panel added to profile `dependencies` as `"mygrace-status-panel": "file:/…/packages/mygrace-status-panel"`, `node_modules/mygrace-status-panel/{cordis.patch.yml,lib/client.js,lib/index.js,package.json}` installed, second `- insert:` row written, and `dsh --dump-config` then showed both `mcp-mygrace` and `mygrace-status-panel` rows:

```
1295:- id: mcp-mygrace
1299:    serverName: mygrace
1304:- id: mygrace-status-panel
1305:  name: mygrace-status-panel
```

### 2.6 Edge-case matrix

| Case | Observed | Verdict |
|---|---|---|
| `DSH_HOME` nonexistent | skills installed, MCP row **skipped with WARNING**, panel skipped, **exit 0** | Misleading success; needs "boot DSH profile once first" precondition (same for missing patch file) |
| `cordis.patch.yml` absent (profile exists) | warning only, skills installed, exit 0 | Partially installed, reported as success |
| malformed YAML patch (`- id: [unclosed`) | appended row; result still invalid; no error/validation | MEDIUM — installer does not validate YAML before/after write |
| foreign rows / `[]` empty array / empty file / no trailing newline | foreign rows preserved; install/uninstall round-trip clean (`FOREIGN PRESERVED + NO RESIDUE`); empty/full-array handling works | OK (verified incl. YAML parse of result) |
| `id: mcp-mygrace-extra` already present | installer says "MCP row already present — skipping" | **False positive**: substring check `content.includes("id: mcp-mygrace")` (`src/grace-install.ts:94-96,103`) |
| read-only `cordis.patch.yml` (0444) | uncaught `EACCES` Node stack trace from `writeFileSync`, exit 1; skills already written | MEDIUM — partial install, raw stack |
| no `dsh` on PATH for `--bundle` | `Failed: Executable not found in $PATH: "dsh"`, exit 1 | OK (clean message) |
| repeated `--bundle` installs | `dsh plugin add` via pnpm reports "Already up to date"; `dsh.profile.bundles` not duplicated; pnpm warns "Replaced … with … from a different source" on run 2 | Content-idempotent |
| `--bundle --uninstall` | exit 0, `package.json`/`dependencies`/`dsh.profile.bundles` cleaned, but **stale `node_modules/@osovv/mygrace-dsh` symlink + `.pnpm` metadata remain**; prints "Done. The bundle is installed" (`src/grace-install.ts:395`) | MEDIUM residue + wrong message |
| `--bundle` with no profile yet | DSH initializes an empty profile (base+web bundles), then pnpm step fails; leaves initialized profile behind | acceptable but unstated |
| `--source <dir>` for bundle | resolved and used; `readFileSync(source/package.json)` is **not guarded** → raw ENOENT stack when missing | see §4 |

---

## 3. Cross-check against real DSH 0.2.1-rc.2 — what matches and what does not

### 3.1 Matches (verified in DSH source + by running DSH)

| Integration point | Evidence | Status |
|---|---|---|
| Loader patch file format: new rows must be `- insert:` blocks (bare `- id:` for a new id is rejected/skipped) | `dsh/node_modules/@deepseek-ai/dsh-app-boot/lib/index.js:61-101` (`applyEntryPatches`: `insert` appends; non-insert without existing id warns at :92), schema `:3043-3044` ("An insert appends entries…"), template `:593-598` | ✅ installer writes exactly this form |
| Real DSH uses the same row shape in its own bundles | `…/dsh-base/cordis.patch.yml` (`- insert:` + `id`/`name` rows); official MCP template `…/dsh-agent-preset/skills/cordis-plugin-development/templates/mcp/cordis.patch.yml:1-3` uses `- insert: / - id: demo-mcp / name: '@deepseek-ai/dsh-mcp-client'` | ✅ |
| MCP client plugin name + config schema | `…/dsh-mcp-client/lib/index.js:781-784`: `transport: z.const("stdio"), serverName: z.string().required().pattern(...), command: z.string().required(), args: z.array(String).default([])`; export `{Config, apply, inject, name}` at `:835` | ✅ installer's `transport/serverName/command/args` are exact |
| Loader accepts the patched profile | `dsh --profile web --dump-config` (temp home) → exit 0, composed tree contains the inserted row (line 1295 of dump) | ✅ |
| Skills location/rank | `…/dsh-skill-filesystem/lib/index.js:21-26` (`USER_DSH_RANK = 400`), `:150-183` roots include `join(this.dshHome, "skills")` rank 400, source `user-dsh`; `$DSH_HOME` honoured (`@deepseek-ai/dsh-home-paths/lib/index.js:101-110`) | ✅ installer comment (`src/grace-install.ts:5-8`) is accurate |
| Skill format: directory bundle with `SKILL.md`, YAML frontmatter `name`/`description`/`whenToUse` | `…/dsh-skill-filesystem/lib/index.js:590-606` (directory + SKILL.md discovery), `:667-696` (frontmatter required, invalid files are warn-skipped); `…/dsh-skill/lib/index.js:474-497` (`whenToUse` supported as string) | ✅ (verified 15 installed dirs; bundle provider returns 15 skills and `get()` content) |
| `dsh plugin` semantics used by `--bundle` | `dsh/lib/bin.js:116-120` → forwards args to pnpm in profile dir; `dsh/lib/plugin-BiveYA7h.js:63-100` | ✅ command form `dsh plugin --profile web add <dir>` is correct |
| Client-plugin manifest/bundle contract (panel) | `…/dsh-client-modules/lib/index.js:54-72` (`dsh.client.platform`/`inject`/`immediately`), `:738` (requires `exports["./client"]`), `:900-903` (module id = package name); browser bundle wrapper `window.__ModuleLoader__.load({id, factory(require){…}})` identical to all real bundles; official minimal template `…/dsh-agent-preset/skills/cordis-plugin-development/templates/decoration/{package.json,client.js}` | ⚠️ format matches, but see 3.2 (stale inject entry, static stub) |
| Slots API (`ctx.slots.inject` / `ctx.slots.register`) | exact same pattern in DSH's own client bundles and its example: `…/dsh-cordis-client-runner/lib/client.js:5696`; template `templates/decoration/client.js` | ✅ panel API usage is correct |
| `tools/execute` hook used by rtk plugin | `…/dsh-tools/lib/index.js:3427` (waterfall `tools/execute`), types `dsh-tools/lib/types/index.d.ts:58`, real wrappers `dsh-session-checkpoint-policy/lib/index.js:66`, `dsh-tool-call-timeout-policy/lib/index.js:116` | ✅ hook is real |
| Skill provider rank/registration (bundle skill package) | `BUNDLED_SKILL_RANK = 600` in generated package matches `dsh-skill`'s bundled rank (`packages/dsh-skill-mygrace/lib/index.js:9`; same constant exported by `@deepseek-ai/dsh-skill`) | ✅ |

### 3.2 Mismatches / integration defects

1. **`--bundle` never installs the bundle's dependencies in a checkout** (CRITICAL for the bundle path). `dsh plugin add <dir>` → pnpm records `"@osovv/mygrace-dsh": "link:/…/packages/mygrace-dsh"` and adds it to `dsh.profile.bundles`, but **only links the source dir**; the bundle's `file:` dependencies (`packages/mygrace-dsh/package.json:15-20`) are not installed into the profile. Empirically, after a successful `install-dsh --bundle`, profile `node_modules/@osovv/` contains **only** the `mygrace-dsh` symlink — no `@osovv/mygrace-cli`, no `@osovv/dsh-skill-mygrace`, no `@osovv/dsh-mygrace-rtk`, no `mygrace-status-panel`, and no `@deepseek-ai/dsh-mcp-client`. `dsh --dump-config` lists four rows (`mygrace-host`, `mygrace-skills`, `mygrace-rtk`, `mygrace-panel`) that the loader cannot resolve at boot. The CHANGELOG "verified live" claim (`CHANGELOG.md:12`) checked only dump-config rows + `node_modules/@osovv/` presence — not resolvability or MCP tools.
2. **Bundle host plugin cannot resolve `@deepseek-ai/dsh-mcp-client` in an installed profile** (CRITICAL for bundle MCP). It uses `createRequire(import.meta.url).resolve(...)` / `createRequire(process.argv[1]).resolve(...)` (`packages/mygrace-dsh/lib/index.js:79-96`), then dynamically imports the resolved file. From the installed (symlinked or copied) bundle, no `@deepseek-ai/*` package is in the profile dependency graph (pnpm `autoInstallPeers:false`, `@deepseek-ai/dsh-mcp-client` is not declared in `packages/mygrace-dsh/package.json`). Empirically:
   * `createRequire(profile/node_modules/@osovv/mygrace-dsh/lib/index.js).resolve("@deepseek-ai/dsh-mcp-client")` → `MODULE_NOT_FOUND`
   * `createRequire("/usr/bin/dsh").resolve("@deepseek-ai/dsh-mcp-client")` → `MODULE_NOT_FOUND` (Node keeps the symlink path in `argv[1]` — probed: `argv1=/tmp/…/bin2/dshprobe` for a symlinked script; it does not realpath)
   * Only `createRequire("/usr/lib/node_modules/@deepseek-ai/dsh/lib/bin.js")` resolves it, i.e. the fallback works only when DSH is launched by the realpath of its entry, which is not how `dsh` (a symlink at `/usr/bin/dsh`) is normally invoked.
   Result: host plugin logs "MCP server not mounted" (`lib/index.js:102,107,114`) → no 15 MCP tools in the bundle path.
3. **`MYGRACE_BIN` is never set** (CRITICAL/HIGH for MCP usefulness). `src/grace-mcp.ts:22` `process.env.MYGRACE_BIN || "mygrace"` and `:229` `execFile(MYGRACE_BIN, …)`; a project-wide grep finds only those two mentions. Neither `install-dsh`'s generated row (`src/grace-install.ts:67-82`) nor the bundle host config (`packages/mygrace-dsh/lib/index.js:68-77`) sets an env var or absolute binary. Empirically, with a valid MyGRACE project:
   * MCP tools list/initialize correctly (15 tools), but with the checkout only on PATH every tool call fails: `MyGRACE MCP error: Executable not found in $PATH: "mygrace"`.
   * After `BUN_INSTALL=<tmp> bun add -g <checkout>` (symlink `mygrace` → `…/src/grace.ts`, runs, `--version` → 1.0.1) **and** that bin dir on the MCP child's PATH, all tested calls succeed: `mygrace_list_modules` → `isError:false`, `mygrace_status` JSON, `mygrace_lint` → "All checks passed".
   So on the *documented* path `bun add -g` it can work, **provided the DSH process PATH contains bun's global bin**; no install path guarantees or documents that.
4. **Status-panel manifest injects a nonexistent client module**: `packages/mygrace-status-panel/package.json:18-24` declares `dsh.client.inject: ["@deepseek-ai/dsh-client-runtime", "@deepseek-ai/dsh-client-ui-sidebar"]`; `@deepseek-ai/dsh-client-runtime` **does not exist anywhere** in the DSH 0.2.1-rc.2 installation (grep of the whole `node_modules/@deepseek-ai` tree is empty), while every one of the 54 real client plugins injects existing package/module ids. Likely a stale name from an older DSH API. Combined with the static card this makes the panel's contract “close but not validated against a real boot”.
5. **DSH prefixes MCP tool names**: `@deepseek-ai/dsh-mcp-client` exposes them as `mcp__<serverName>__<rawName>` (`…/dsh-mcp-client/lib/index.js:85-100,130-140`), i.e. `mcp__mygrace__mygrace_list_modules`. All skills/docs call them `mygrace_list_modules` etc. (`AGENTS.md:39`, `skills/mygrace/grace-cli/SKILL.md:10`, `README.md:32`, template `templates/AGENTS.dsh.md.template:39`) — the agent must infer the prefix; MEDIUM doc/integration mismatch.
6. **`path` argument**: every tool schema marks `path` as required (e.g. `src/grace-mcp.ts:39`), but `buildToolCommand` silently defaults to `"."` when absent (`src/grace-mcp-commands.ts:31-32`), and no skill tells the agent what value to pass for MCP `path` (skills only document CLI `--path <root>`, e.g. `grace-cli/SKILL.md:22-39`). In our test, omitting `path` "worked" only because the MCP child was spawned with `cwd=project`; under DSH the server's cwd is the host process cwd, not the session workspace. MEDIUM usability/robustness risk with multiple workspaces.

---

## 4. npm packaging / publishability (the biggest problem)

### 4.1 Tarball contents — verified with both packers

`bun pm pack` and `npm pack` produce the **same 46-file tarball** (`osovv-mygrace-cli-1.0.1.tgz`, 44.4 KB packed / 158 KB unpacked) driven by `package.json:31-46` (`files`). Shipped `src/` is **10 of 15 files**:

```
src/grace-common.ts  src/grace-file.ts  src/grace-init.ts  src/grace-install.ts
src/grace-lint.ts    src/grace-mcp-commands.ts  src/grace-mcp.ts  src/grace-module.ts
src/grace-status.ts  src/grace.ts
```

**Missing** (all statically imported by the entry point, `src/grace.ts:26-30`):
`src/grace-doctor.ts`, `src/grace-test.ts`, `src/grace-packet.ts`, `src/grace-context.ts`, `src/grace-verify.ts`.

Also missing from the tarball: `packages/mygrace-dsh`, `packages/dsh-skill-mygrace`, `packages/dsh-mygrace-rtk` (only `packages/mygrace-status-panel` is in `files`), `CHANGELOG.md`, `rules/`, `plugins/`, `scripts/`, `test/`, `examples/`.

### 4.2 The published package is non-functional (CRITICAL)

```
$ BUN_INSTALL=<tmp> bun add -g <tarball>        # exit 0
$ <tmp>/glob/bin/mygrace --version
error: Cannot find module './grace-doctor' from
  /tmp/…/glob/install/global/node_modules/@osovv/mygrace-cli/src/grace.ts
```

Same from the extracted tarball. **Controlled experiment proving the root cause:** re-adding just those 5 missing `src/*.ts` files to the extracted tarball makes `grace.ts --version` print `1.0.1` and makes the legacy `install-dsh --dry-run` work; `--bundle --dry-run` then fails with an uncaught `ENOENT` (`grace-install.ts:372`, `packages/mygrace-dsh/package.json` absent):

```
ENOENT: no such file or directory, open '/tmp/…/package/packages/mygrace-dsh/package.json'
  at installBundle (/…/package/src/grace-install.ts:372:30)
```

So **a v1.0.1 npm install never runs at all**, and even after fixing `files`, `--bundle` is dead on arrival from npm.

### 4.3 `--bundle` publish chain is broken

* `packages/mygrace-dsh/package.json:15-20` declares all four dependencies as `file:` paths (`file:../dsh-skill-mygrace`, `file:../dsh-mygrace-rtk`, `file:../..`, `file:../mygrace-status-panel`) → not resolvable for a registry consumer.
* `scripts/publish-prepare.ts` swaps them to versions (verified dry-run output: `@osovv/dsh-skill-mygrace@0.1.0`, `@osovv/dsh-mygrace-rtk@0.1.0`, `@osovv/mygrace-cli@1.0.1`, `mygrace-status-panel@0.1.0`), but:
  * it is **manual**, not wired into any `prepublishOnly`/`prepare` of the bundle package (`packages/mygrace-dsh/package.json` has no scripts at all);
  * it leaves `mygrace-status-panel` as **`"private": true`** (`packages/mygrace-status-panel/package.json:6`); npm refuses private packages (`/usr/lib/node_modules/npm/node_modules/libnpmpublish/lib/publish.js:17` — `EPRIVATE`). A published bundle would therefore depend on an unpublished package.
  * the CHANGELOG publish order explicitly includes `mygrace-status-panel` (`CHANGELOG.md:14`), i.e. a step that is supposed to fail.
* Even if everything were published, the bundle's MCP mount still relies on `@deepseek-ai/dsh-mcp-client` being resolvable from the *host* process (see §3.2.2) — the bundle does not declare it and `createRequire` does not go through DSH's loader/ESM hooks.

### 4.4 Versions / prepublish / docs

* Version consistency: root `1.0.1` (`package.json:3`), README `Current version: 1.0.1` (`README.md:7`), CHANGELOG `v1.0.1` — consistent. Four plugin packages are `0.1.0` (intentional independent semver, but nothing records/pins the compat matrix). Inconsistencies: MCP server reports `version: "0.1.0"` (`src/grace-mcp.ts:24`) while the CLI is 1.0.1; skill-count claims disagree — 15 real skills vs "14 skills" in `packages/mygrace-dsh/package.json:3`, `packages/dsh-skill-mygrace/package.json:3`, `src/grace-install.ts:406`, `CHANGELOG.md:9,51`, while README says 15 (`README.md:15,31`).
* `prepublishOnly` chain (`package.json:59`) **passes** (`bun test`: 179 pass; `lint`: 0 errors; `validate:marketplace`: pass) but it validates the **repo**, not the packed artifact, and `scripts/validate-marketplace.ts:83-89` has a stale list of **14** expected skills (omits `grace-token-budget`; it prints "Skills: 14 ✓"). Nothing checks `files` coverage, `npm pack` contents, `file:` deps, `private: true`, or that `packages/mygrace-status-panel` is publishable. That is why a completely broken tarball passes the release gate.
* Portability: `bin` = `./src/grace.ts` with `#!/usr/bin/env bun` and `engines.bun >= 1.3.8` (`package.json:50,61-63`) — **no Node support**. `bun add -g` from a working checkout does work (verified: global symlink, `mygrace --version` → 1.0.1; MCP end-to-end after PATH fix). `npm i -g` on a bun-less machine installs a shebang that fails. The legacy MCP row hard-codes `process.execPath` (the current bun) and the absolute checkout path of `grace-mcp.ts` (`src/grace-install.ts:67-82`); after `bun add -g` upgrades/moves the installation, the user's profile silently points at the old path. MEDIUM-HIGH.
* Root `files` omits `CHANGELOG.md` (npm page/README links) — LOW.

---

## 5. `packages/*` honesty assessment

| Package | What it is | Verdict |
|---|---|---|
| `dsh-skill-mygrace` | Generated skill provider (15 skills in `lib/index.js:13-29`, `assets/skills/*/SKILL.md`). Tested by direct import: `provider.list()` → 15 skills with descriptions; `provider.get()` reads the SKILL.md content; plugin shape `{name, inject:["skills"], apply(ctx){ctx.skills.registerProvider(...)}}` matches DSH's provider API. | **Real, works** (14-vs-15 description stale) |
| `dsh-mygrace-rtk` | Tool middleware replacing noisy bash commands with `rtk …`. Tested `rewriteForRtk`: `git status→rtk git status`, `bun test→rtk bun test`, `ls -la→rtk ls -la`, `echo hi→undefined`, already-rtk→undefined, `cd x→undefined`. Uses `ctx.on("tools/execute", …)` which is a real DSH waterfall hook. Silently disables itself when `rtk` is absent (correct). | **Real, works** |
| `mygrace-dsh` (bundle host) | Mounts `@deepseek-ai/dsh-mcp-client` programmatically, resolves bun + `src/grace-mcp.ts`. `resolveBun()`/`resolveMcpEntry()`/`resolveMcpConfig()` work when the package is symlinked from the checkout (ROOT_DIR fallback lands on the repo), config matches the MCP client schema. But MCP-client **resolution fails** in a profile install (§3.2.2) and the file: dep model breaks outside a checkout. | **Real attempt, not functional as installed/published** |
| `mygrace-status-panel` | Host half is `export function apply() {}` (`lib/index.js:1-8`). Browser half is a 93-line static card: monogram "MG" when collapsed, three lines of fixed text when expanded; no fetch/API/status data (`lib/client.js:20-72`). Bundle wrapper, package id, slots usage and dsh.client manifest all follow the real DSH contract (compared with DSH's official minimal `templates/decoration/` plugin) — but the `inject` list contains nonexistent `@deepseek-ai/dsh-client-runtime`, the package is `private:true`, install is silently skipped when pnpm fails, and it never reports project status. | **Cosmetic stub** — honest label would be "sidebar decoration", not "status panel"; README (`README.md:33`) and CHANGELOG (`CHANGELOG.md` v0.2.0 "DSH-native status panel") oversell it |

Bundle patch `packages/mygrace-dsh/cordis.patch.yml:6-17` is valid (`- insert:` rows) and DSH composes it (`dsh --dump-config` prints `# == @osovv/mygrace-dsh` + 4 rows), but the rows are unresolvable in the installed layout (§3.2.1).

---

## 6. Findings by severity

### CRITICAL
**C1. Published npm package cannot start at all.** `files` (`package.json:31-46`) omits 5 modules imported by the entry point (`src/grace.ts:26-30`). Tarball has 10/15 `src` files; `bun add -g <tarball>` + `mygrace --version` → `error: Cannot find module './grace-doctor'`. Proven by controlled experiment (restoring the 5 files fixes it). The release gate does not catch it (§4.4).

**C2. `install-dsh --bundle` cannot work from the published package, and the bundle cannot install its own dependencies.** Root `files` does not ship `packages/mygrace-dsh` (and the skill/rtk packages); tarball run → uncaught `ENOENT` at `src/grace-install.ts:372`. In a checkout, `dsh plugin add` records a `link:` and installs none of the bundle's `file:` dependencies (verified: profile `node_modules/@osovv` = only `mygrace-dsh` symlink), so the four bundle rows cannot resolve at boot. Bundle deps are `file:` (`packages/mygrace-dsh/package.json:15-20`) and one target is `private:true` (`mygrace-status-panel/package.json:6`), so a correct publish is also blocked. The "verified live" claim (`CHANGELOG.md:12`) covers only dump-config rows, not loading or MCP.

**C3. MCP server spawns `mygrace` from PATH, and no install path sets `MYGRACE_BIN`.** `src/grace-mcp.ts:22,229`; grep finds only that definition. Generated rows start `bun run …/grace-mcp.ts` without env (`src/grace-install.ts:67-82`; bundle: `packages/mygrace-dsh/lib/index.js:68-77`). Empirically: 15 tools list, **every call fails** `Executable not found in $PATH: "mygrace"` unless a `mygrace` binary is on the harness PATH; with `bun add -g` + PATH it works. Given the checkout-only dev path in README step 1 is `bun add -g`, this is fixable by docs, but the legacy-from-checkout install (and any `bunx`/local install) produces dead MCP tools.

**C4. Bundle host cannot resolve `@deepseek-ai/dsh-mcp-client` when installed in a profile.** `packages/mygrace-dsh/lib/index.js:79-96`; `@deepseek-ai/dsh-mcp-client` is not declared in the bundle's package.json, `createRequire` bypasses DSH's loader hooks, profile `node_modules` has no `@deepseek-ai/*` (autoInstallPeers:false), and the `process.argv[1]` fallback fails for the normal `/usr/bin/dsh` symlink launch (empirical `MODULE_NOT_FOUND`, symlink argv probe). Result: MCP server silently not mounted in the bundle path.

### HIGH
**H1. Panel step is best-effort but reported as success.** `install-dsh` requires a user `pnpm` on PATH (`src/grace-install.ts:284`), spawns it with `spawnSync`; on this (realistic, documented-in-CHANGELOG) shebang-less pnpm install it dies with ENOEXEC → `WARNING: pnpm add failed (exit null) — panel skipped`, **exit 0**, and the completion text still lists the status card as active. DSH's own `dsh plugin` reports the same ENOEXEC here (env-level), but the installer should (a) use DSH's package-manager path/`dsh plugin` instead of a bare `pnpm`, (b) not claim success on a failed integration step.

**H2. `cordis.patch.yml` editing is string-surgery without validation/atomicity.** `src/grace-install.ts:94-116` (`includes("id: mcp-mygrace")` substring, replaces first line whose `trim()==="[]"`, blind append), `:206-208` (backup then write; crash leaves no hint). Proven: malformed YAML is happily appended to; `id: mcp-mygrace-extra` causes a false "already present"; read-only file produces a raw EACCES stack after skills were already installed. `--uninstall` then leaves `.mygrace-backup` and an empty `skills/` dir.

**H3. Uninstall/cleanup is incomplete and its UX is wrong.** `.mygrace-backup` left behind; empty `$DSH_HOME/skills` left; bundle uninstall leaves `node_modules/@osovv/mygrace-dsh` symlink + `.pnpm` metadata; uninstall prints activation instructions (`src/grace-install.ts:462-466`); bundle uninstall prints "Done. The bundle is installed" (`:395`).

**H4. Clean-machine precondition not handled/documented.** Fresh `DSH_HOME` → installer writes skills, skips the MCP row (warn) and exits 0; README "one command" (`README.md:5`) implies a complete install. The profile must be booted once first (warning text does say so, but the overall result is reported as success).

**H5. Install bakes absolute paths and the current bun binary into the user's profile** (`src/grace-install.ts:68-81`). `bun add -g` upgrades/moves the package → the MCP row silently points at a stale/removed `grace-mcp.ts` and old bun; also `--bundle` uses a `link:` to the source dir. No post-install verification or repair path (`doctor` only hints at re-running, `src/grace-doctor.ts:105-123`).

### MEDIUM
**M1. Status panel is a static stub** (no data/API; `packages/mygrace-status-panel/lib/client.js:20-72`, host `lib/index.js:8`) but is documented as a "status card/status panel" (`README.md:33`, `CHANGELOG.md` v0.2.0, bundle description `packages/mygrace-dsh/package.json:3`). It also injects a nonexistent client module (`package.json:18-24`: `@deepseek-ai/dsh-client-runtime` absent in DSH 0.2.1-rc.2) and is `private:true` (blocks the bundle's publish chain).

**M2. MCP tool names are unprefixed in all docs/skills** while DSH registers `mcp__mygrace__<rawName>` (`@deepseek-ai/dsh-mcp-client/lib/index.js:85-100`). Affects `AGENTS.md:39`, `README.md:32`, 15 skill files, `templates/AGENTS.dsh.md.template:39`.

**M3. `path` is required by every MCP schema but defaults to `"."` in the mapper** (`src/grace-mcp.ts:39…`, `src/grace-mcp-commands.ts:31-32`), and skills never say what to pass for MCP `path`; correctness depends on the DSH host's cwd.

**M4. Version/skill-count/doc drift:** MCP server version `0.1.0` vs CLI `1.0.1` (`src/grace-mcp.ts:24`); "14 skills" in package descriptions, installer help (`src/grace-install.ts:406`) and CHANGELOG vs 15 actual (README is right); `validate-marketplace.ts:83-89` stale 14-skill list; changelog pre-1.0.1 claims reference "14 skills".

**M5. Docs describe legacy install as "skills + MCP row"** (`README.md:17-18`) but it also installs/reinstalls the status-panel package and writes a second row via pnpm; conversely docs present the bundle path as the primary one although it is the broken one.

### LOW
* `--bundle`/`--uninstall` message errors (H3), `--dryRun`/`--dshHome` camelCase in `--help`.
* `Resources/dry-run` output says "installed …" on every re-run (idempotent but noisy).
* Skill provider comment/description says 14 while code ships 15; a typo `@deepspeed-ai` in a comment (`packages/mygrace-dsh/lib/index.js:79`).
* `resources`/root tarball omits `CHANGELOG.md`, `rules/`, `plugins/` (product docs, not runtime).
* Duplicate skill names if both legacy (`$DSH_HOME/skills`, rank 400) and bundle provider (rank 600) are installed; docs never warn that the two paths are alternatives.

---

## 7. Direct answers to the Lead's questions

1. **Clean machine with only `bun add -g @osovv/mygrace-cli` (so `mygrace` is on PATH): does MCP work?** Yes *when the global bin dir is actually on the DSH process PATH*: verified `bun add -g <checkout>` → `mygrace --version` 1.0.1; MCP handshake 15 tools; `mygrace_list_modules`/`status`/`lint` all `isError:false` once the bin dir was added to the spawned server's PATH. Without it (checkout-only, `bunx`, local install), **every tool call fails** (C3). Note the published tarball can't even start (C1), so "only run bun add -g" today yields a broken binary.
2. **Does the dev/checkout or bundle path break because MYGRACE_BIN is never set?** YES. Checkout/legacy dev path: broken (all MCP calls error). Bundle path: also broken, but for a second, independent reason (C4: MCP client itself unresolvable) — and nothing in `packages/mygrace-dsh` or `packages/mygrace-status-panel` sets/reads `MYGRACE_BIN` (grep: only `src/grace-mcp.ts:22`).
3. **MCP `path` required vs cwd defaults:** schemas require `path` (`src/grace-mcp.ts:39` etc.); mapper defaults `"."` (`src/grace-mcp-commands.ts:31-32`); skills only give CLI `--path <root>` examples (`skills/mygrace/grace-cli/SKILL.md:22-39`), never say "pass the absolute project root as the MCP `path` argument". An empty-args call succeeds only when the MCP server's cwd is the project (verified in a controlled test); under DSH the subprocess cwd is the host cwd, not the session workspace → fragile with multi-workspace sessions.

---

## 8. What would make the claims true (brief)

1. Fix `files`: add `src/grace-context.ts`, `grace-doctor.ts`, `grace-packet.ts`, `grace-test.ts`, `grace-verify.ts`; add a `prepack`/CI check that installs the tarball and runs `mygrace --version` + `install-dsh --dry-run`. (`C1`)
2. Ship or drop `--bundle`: include the three package dirs in the root tarball, remove `file:` deps + `private:true` (or make the bundle a single self-contained package), declare `@deepseek-ai/dsh-mcp-client` as a peer/dependency and resolve it via the loader's module resolution (or use a normal patch row instead of a programmatic mount). Verify by actually booting a temp `DSH_HOME` and calling an MCP tool. (`C2`,`C4`)
3. Pass an explicit, portable MCP config: set `MYGRACE_BIN`/command to `bun run <abs grace.ts>` for the CLI sub-calls (or make `grace-mcp.ts` exec `process.execPath run <abs grace.ts>`); reject/report missing bin at install time. (`C3`)
4. Make `install-dsh` fail (nonzero) when a requested component fails, validate YAML before/after writing, use `dsh plugin`/DSH's package manager instead of bare `pnpm`, and clean up backups on uninstall. (`H1`,`H2`,`H3`)
5. Either implement the status panel data path (read `docs/graph-index.xml` via a host service/bridge) or rename it "sidebar decoration"; fix the stale `dsh.client.inject` entry and publish it (remove `private`). (`M1`)
6. Sync docs: 15 skills, prefixed MCP tool names, what to pass as `path`, legacy vs bundle alternatives, and drop "verified live" bundle claims until an end-to-end boot test exists. (`M2`,`M4`,`M5`)

---

## 9. Evidence artifacts / limitations

* All test homes were under `/tmp` (ephemeral tmpfs in this sandbox) and were not persisted; the key transcripts are quoted above. No repository files were modified except this report.
* The `pnpm` shim used to separate environment faults from product faults was a throwaway `/tmp` script (`#!/bin/sh` → `node /usr/lib/node_modules/pnpm/bin/pnpm.mjs`); it changed nothing in the real environment.
* Full `dsh web` boot with an installed bundle was not performed (would start a second server next to the live 3080 instance); validation used DSH's own `--dump-config` composition (loader patch application) plus source-level cross-checks against the vendored loader/MCP-client/client-modules code.
* Real `~/.dsh` verified untouched at the end: profile patch sha256 `1d00ee4d…b27d7` (unchanged from first read), no `skills/` dir, no `mcp-mygrace`/`mygrace-status-panel` rows.
