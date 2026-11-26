# Contributing to MyGRACE

Thanks for helping. MyGRACE is a **contract layer between human intent and AI-executed work**, so contributions are judged by the same standard the tool
sells: traceable intent, enforced invariants, honest output.

- Read [`ROADMAP.md`](ROADMAP.md) first — vision, ADRs and explicit non-goals.
- Read [`docs/architecture.md`](docs/architecture.md) for the module graph and the current enforcement status of each invariant.
- Security reports do **not** go through issues — see [`SECURITY.md`](SECURITY.md).

## Development setup

Prerequisite: **Bun ≥ 1.3.8** (`package.json` → `engines.bun`). The CLI runs via
Bun's TypeScript execution; Node.js support (≥ 22.6, native type stripping) is an
ADR-7 roadmap target and is not yet declared in `engines`.

```bash
git clone https://github.com/anyagixx/MyGrace_DS4pro.git
cd MyGrace
bun install
```

Run the CLI from the checkout (no global install needed):

```bash
bun run src/grace.ts --help
bun run src/grace.ts lint --path examples/demo-store
bun run src/grace.ts init-dsh --path /tmp/mygrace-sandbox
```

Daily loop:

| Command | What it does |
|---|---|
| `bun run typecheck` | `tsc --noEmit` with `strict` (G2) |
| `bun test` | test suite, scoped by `bunfig.toml` to `test/` |
| `bun test examples/demo-store` | demo integration tests (not picked up by `bun test`) |
| `bun run lint:demo` | `mygrace lint` on `examples/demo-store` (must stay 0 errors / 0 warnings) |
| `bun run validate:marketplace` | packaging/skills/version/docs-count consistency |
| `bun run validate:docs` | documentation truth check: documented commands/flags/MCP tools/counts vs source |
| `bun run pack:smoke` | packs the package, extracts it to a temp dir and runs the **packaged** CLI (G1) |
| `bun run ci` | typecheck + tests + demo lint + marketplace/docs truth + pack-smoke |
| `bun run release:check` | alias of `ci` (`prepublishOnly` runs it) |

`lefthook.yml` runs `bun run typecheck` and `bun test --bail` before each commit and `bun run ci` before a push (install the hooks once with `bunx lefthook install`).

## Repository layout

| Path | Purpose |
|---|---|
| `src/` | CLI source — one command module per top-level command plus the shared layers |
| `scripts/` | release and quality gates (`pack-smoke`, `validate-marketplace`, `validate-docs`, context measurement, demo generation) |
| `.github/` | CI workflow, issue templates, pull-request template |
| `test/` | unit and integration tests, fixtures |
| `examples/demo-store` | generated demo project used by `lint:demo` and the context metric |
| `skills/mygrace/` | canonical agent skills (installed as `mygrace-*` by `install-dsh`) |
| `templates/` | scaffolding written by `init-dsh` |
| `packages/` | optional DSH integration packages (bundle, skill provider, RTK plugin, status panel) |
| `extensions/`, `rules/`, `plugins/` | legacy multi-platform packaging — see `ROADMAP.md` W2.1 |
| `analysis/` | audit reports that motivated the v2 roadmap (not shipped) |

## Code conventions

The Wave-0 foundation is strict. When you touch a command, move it **towards**
the foundation rather than adding a second style:

1. **Contracts in code.** New modules start with `START_MODULE_CONTRACT` /
   `END_MODULE_CONTRACT` (PURPOSE, SCOPE, DEPENDS, LINKS), a `START_MODULE_MAP`
   listing exports, and `START_CHANGE_SUMMARY`. Semantic blocks
   (`START_BLOCK_*` / `END_BLOCK_*`) are navigation anchors and must stay paired.
   See `src/grace-errors.ts` for the reference shape.
2. **Typed errors, stable exit codes.** Use `src/grace-errors.ts`:
   `MyGraceError`, `UsageError`, `ConfigError`, `ProjectNotFoundError`,
   `XmlError`, `TrustError`, `finding()`, `exitCodeForFindings()`,
   `createEnvelope()`, `printJson()`, and — for commands with a body —
   `runCommandOutcome()`/`parseOutputFormat()` from `src/grace-test.ts`. The
   `guard()` wrapper in `src/grace.ts` already converts a thrown typed error into
   one readable line — new code must not print stack traces or call
   `process.exit(1)` ad hoc.

   | Exit code | Meaning |
   |---|---|
   | `0` | success |
   | `1` | the command ran and found problems (findings, failed tests, drift) |
   | `2` | the command could not run: bad arguments, bad config, not a project |
   | `3` | unexpected internal failure (a MyGRACE bug) |

   `--strict` promotes warnings to exit `1` (implemented on `lint`); JSON mode
   must return the same exit code as text mode.
3. **XML is parsed, never scraped.** All project XML goes through
   `src/grace-xml.ts` (`parseXml`, `validateXml`, `tryParseXml`,
   `parseIndexEntries`, accessors). No new `content.match(/<tag>/ )` regexes on
   `docs/*.xml`: malformed XML is a finding (`XML_INVALID`) with line/column, not
   a silent empty index.
4. **Ids and paths are untrusted input.** Validate through `src/grace-paths.ts`
   (`assertEntityId`, `entityPath`, `resolveWithin`, `assertSafeRelativePath`).
   Ids may only match the documented grammars (`M-…`, `V-M-…`, `Phase-N`), and
   resolved paths must stay inside `docs/{modules,plans,verification}`.
5. **No hardcoded layout.** Read `sourceDirs`, `markupExts`, `ignoreDirs`,
   `indexCaps`, `sizeBudgets`, `testRunner` from `src/grace-config.ts`
   (`mygrace.config.json`, optional, defaults reproduce the classic layout).
6. **Command execution is argv-only and goes through the trust gate.** Plan with
   `planModuleTest()`, authorize with `authorizeCommands()`, execute with
   `executeModulePlan()` (all in `src/grace-test.ts`); never call `spawnSync` on a
   project-declared command directly, never build a shell string, and never
   bypass the ADR-1 trust decision (`mygrace trust` / `--allow-commands` /
   `config.allowCommands`).
7. **Machine-readable output uses the envelope.** `--format json` commands emit
   `{ ok, exitCode, data, findings[], meta }` (ADR-8) and exit with
   `envelope.exitCode`. Text mode stays human-oriented. `docs/architecture.md` §6
   tracks the enforcement status of each invariant.
8. **Empty or partial input is a finding, not a crash.** Catch filesystem and
   parse failures at the boundary (`tryParseXml`, `readIndexFileSafe`) and report
   them with an actionable `hint`.
9. **Docs and code change together.** `scripts/validate-docs.ts` runs in CI and
   fails on stale counts, unknown commands/flags and undocumented MCP tools. If a
   PR changes the CLI/MCP surface, update `README.md`, `AGENTS.md`, `docs/` and
   the catalog in the same PR — or the truth gate stays red.

## How to add a CLI command

1. Create `src/grace-<name>.ts` exporting `<name>Command` built with citty's
   `defineCommand`: `meta.name`, `meta.description`, a typed `args` record with
   descriptions and defaults, and a `run`.
2. Throw typed errors instead of printing; return exit codes per ADR-3. Add a
   `--format` argument and run the body through `runCommandOutcome()` (which
   prints the envelope, prints the text lines, and exits with the contract code).
3. Register it in `src/grace.ts` under `subCommands` **wrapped in `guard()`**,
   and update the command list in that file's header comment and the `USAGE`
   surface the docs validator checks.
4. Add the MCP counterpart if agents need it (next section).
5. Update the docs: `CHANGELOG.md` `[Unreleased]`, `docs/architecture.md` (§2/§6)
   if the module graph or an invariant changed, and the user-facing command tables
   (`README.md`, `AGENTS.md`) so `validate:docs` stays green.
6. Add tests that fail without the change: success path, bad argument, missing
   project, malformed XML, and the exit code for each.

## How to add an MCP tool

There is exactly **one** catalog: `TOOLS` in `src/grace-mcp-commands.ts`.
`src/grace-mcp.ts` derives `ListTools` from it, so names, schemas and mappings
cannot drift.

1. Add a `ToolDefinition` to `TOOLS` in `src/grace-mcp-commands.ts`:
   `name`, `description`, `inputSchema`, `rootArg: "path"`, and `buildArgs(args,
   root)` returning the CLI argv. Keep the module SDK-free (pure mapping) so
   unit tests cover every tool. Descriptions are read by models: say when to use
   the tool and what it returns.
2. Mark the project-root argument with `rootArg` (its value resolves as explicit
   argument → `MYGRACE_PROJECT_ROOT` → the server's working directory). Schema
   types/enums/patterns/`required` are enforced by `validateToolArgs()` before
   mapping; add `digestOutput` for noisy tools (`test`, `verify`, `lint`).
3. Add the name to the `ToolName` union — `TOOL_NAMES` is derived from `TOOLS`
   automatically (the docs validator reads it).
4. Test the mapping (arguments → argv) and, for runtime changes, exercise the tool
   through a real stdio client (`test/grace-mcp-runtime.test.ts`).
5. Tool names are stable public API; when documenting them in agent-facing
   markdown, also show the host prefix (`mcp__mygrace__<tool>`, ADR-8).

If the tool writes state (for example a future trust action), it follows the same
security rules as the CLI command it maps to — see `SECURITY.md`.

## Commit conventions

Commits follow [Conventional Commits](https://www.conventionalcommits.org/):

```
<type>(<scope>): <imperative summary>

[optional body: why, not what]
[BREAKING CHANGE: migration notes]
```

Types: `feat`, `fix`, `docs`, `refactor`, `test`, `build`, `ci`, `perf`,
`chore`, `revert`. Scopes are module names: `cli`, `lint`, `module`, `mcp`,
`test`, `trust`, `install`, `init`, `docs`, `skills`, `templates`, `examples`.

Examples:

```
fix(lint): detect phase status drift in lowercase attributes
feat(cli)!: require a trust record before executing project commands
docs(security): document the trust boundary for cloned repos
```

The `CHANGELOG.md` `[Unreleased]` sections map one-to-one: `feat` → Added,
`fix` → Fixed, `docs` → Documentation, `security` → Security, internal changes
to Internal.

Rules that keep history useful:

- one logical change per commit; no "fix stuff" commits;
- do not reformat unrelated files;
- do not commit generated artifacts (`examples/demo-store` is generated by
  `scripts/gen-example.ts`; `.mygrace/` and pack-smoke temp dirs are ignored);
- never commit secrets, tokens, or absolute personal paths.

## Release gates

Production dependencies must pass `bun run audit:prod` (no high/critical
advisories); the release workflow attests the packed tarball with GitHub build
provenance.

`ROADMAP.md` §6 is the authoritative list. This is how it maps to the repo today:

| Gate | Verify with | Status |
|---|---|---|
| G1 packaged CLI works | `bun run pack:smoke` | available |
| G2 type-safe | `bun run typecheck` | available |
| G3 enforced invariants | `bun run lint:demo` + `mygrace lint --strict` on a tampered fixture | available (`--strict` on lint; `mygrace ci` is the one-command gate) |
| G4 security negatives | `bun test` (trust refusal, traversal, flag-injection cases) | available |
| G5 test suite | `bun test` (mutation score is still a Wave 1.5+ gate) | available |
| G6 agent integration (MCP) | stdio client test (`test/grace-mcp-runtime.test.ts`), PATH-less launch | available |
| G7 dogfooding | `bun run lint:self` / `bun run check` on this repo | available — `mygrace ci --path .` PASS on 25 modules / 4 phases / 25 verifications |
| G8 docs are true | `bun run validate:marketplace && bun run validate:docs` (CI `truth-checks` job) | available |
| G9 honest metrics | `bun run scripts/measure-context.ts` | reports lines + bytes + a documented `ceil(bytes/4)` token **estimate** and a 12/50/200-module sweep; never present the estimate as tokenizer output |
| G10 release engineering | `CHANGELOG.md` `[Unreleased]` + version consistency | available |
| G11 scale (200 modules) | synthetic fixture | available — `mygrace module shard` + 150-module/3-shard proof test |
| G12 any-language support | language fixtures | available — Python/Go fixtures + CI `language-matrix` job |

A release PR must run the full §6 checklist and state the version.


### Releasing `mygrace-cli` (GitHub Releases, no npm)

Version policy: semver; 1.x while release gates are green. Patch = fixes/docs
only; minor = additive commands/flags/MCP tools; major = breaking
CLI/JSON/envelope changes. Update CHANGELOG `[Unreleased]` → `[X.Y.Z]`, bump
`package.json` version, commit, create and push a tag `vX.Y.Z`.

`release.yml` is tag-driven and gate-only: on a `v*` push it installs with the
frozen lockfile, runs `bun run release:check` (typecheck, full tests, demo lint,
`mygrace ci` self-check, marketplace/docs truth validators, diagram/capsule gates,
pack-smoke) and `bun run publish:dry` (pack the tarball, static import
completeness, offline install, packaged CLI `--version`/`--help`), refuses a tag
that does not match `package.json`, then packs `mygrace-cli-<version>.tgz`,
writes `SHA256SUMS` and a GitHub build-provenance attestation, uploads them as workflow artifacts and creates a GitHub Release with generated
notes. Manual: Actions → release → Run workflow for a gates-only run.

**No npm publication.** Distribution decision 2026-11-25: the project does not
publish to npm (`@osovv` is a third-party scope and is not used). Do not add
`NPM_TOKEN`, trusted-publisher configuration or `npm publish` steps; installs
come from the GitHub Release tarball or a source checkout. `publish:dry` remains
an artifact-verification gate only and never contacts a registry.

## Licensing

By contributing you agree that your contribution is licensed under the
repository's [MIT License](LICENSE). There is no CLA.

## If you are an AI agent

- Prefer non-interactive commands; never run destructive git operations.
- Report the exact command, exit code and relevant output — CI and maintainers
  read those, not summaries.
- Do not attempt to bypass `SECURITY.md` rules; if a command is refused by the
  trust model, report the refusal instead of forcing execution.
