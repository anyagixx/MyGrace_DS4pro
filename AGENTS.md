# MyGRACE — Index-First Engineering Harness (DeepSeek Harness)

This project is governed by **MyGRACE**: a small, enforced repository map plus a
contract-first workflow. Navigate with **indexes first**; read only what you need.

## Navigation Rule #1 (CRITICAL)

**ALWAYS start with the index files. NEVER scan all per-entity files.**

| Action | 1. Read first | 2. Then |
|---|---|---|
| Learn modules | `docs/graph-index.xml` (cap 100) | the one `docs/modules/M-XXX.xml` you need |
| Development plan | `docs/plan-index.xml` (cap 50) | only the current `docs/plans/Phase-N.xml` |
| Verification | `docs/verification-index.xml` (cap 80) | the relevant `docs/verification/V-M-XXX.xml` |

Caps/budgets are configurable in `mygrace.config.json` (`indexCaps`, `sizeBudgets`;
default entity budgets: module 30–80 / phase 50–200 / verification 20–60 lines);
legacy monolithic XML is not used — do not create or read it.

## Trust model (CRITICAL)

Project-declared commands (`<module-checks>` in the canonical
`docs/verification/V-M-XXX.xml`) are **untrusted input**. `mygrace test` /
`mygrace verify` execute them only when one of these holds:

- `.mygrace/trust.json` is current — created by `mygrace trust` after review;
- `"allowCommands": true` is set in `mygrace.config.json`;
- the invocation passes `--allow-commands`.

`.mygrace/` is local state: **never commit it** (add it to `.gitignore`). Editing
`docs/modules/`, `docs/verification/` or the config invalidates the record — run
`mygrace trust` again. If a command is refused, report the refusal; do not
bypass it.

## Skills (15)

Prefer the matching skill (via the `skill` tool) over re-deriving the process:

| Skill | Purpose |
|---|---|
| `mygrace-init` | Bootstrap docs/ + AGENTS.md + config (`mygrace init-dsh`) |
| `mygrace-plan` | Design modules/phases/verification; write entities + indexes |
| `mygrace-verification` | Design scenarios, log markers and evidence |
| `mygrace-execute` | Implement the plan step by step (current phase + module) |
| `mygrace-multiagent-execute` | Parallel waves via DSH subagents |
| `mygrace-refactor` | Safe restructuring with atomic index updates |
| `mygrace-refresh` | Sync indexes with per-entity files after drift |
| `mygrace-reviewer` | Integrity audit (scoped / wave / full) |
| `mygrace-fix` | Debug: index → module → block |
| `mygrace-status` | Health report from indexes + lint summary |
| `mygrace-ask` | Q&A via lazy navigation |
| `mygrace-cli` | CLI/MCP reference |
| `mygrace-explainer` | Methodology reference and honest metrics |
| `mygrace-setup-subagents` | DSH subagent role prompts |
| `mygrace-token-budget` | Output-side token policy |

## MCP tools (25, when the mygrace MCP server is connected)

`mygrace_list_modules` · `mygrace_show_module` · `mygrace_show_phase` ·
`mygrace_find_modules` · `mygrace_phase_index` · `mygrace_doctor` ·
`mygrace_test` · `mygrace_trust` · `mygrace_ci` · `mygrace_packet` ·
`mygrace_focus` · `mygrace_context_cost` · `mygrace_verify` ·
`mygrace_list_verifications` · `mygrace_lint` · `mygrace_show_file` · `mygrace_status` · `mygrace_trace` · `mygrace_impact` · `mygrace_next` · `mygrace_projects` · `mygrace_integrations` · `mygrace_diagram` ·
`mygrace_capsule_list` · `mygrace_capsule_run`
DSH exposes them as `mcp__mygrace__<tool>` (e.g. `mcp__mygrace__lint`). `install-dsh --panel` also wires the optional LIVE sidebar card that reads `mygrace status`.

## Six Principles

1. **Never write code without a contract** — `MODULE_CONTRACT` before code.
2. **Semantic markup is load-bearing** — blocks are anchors, not comments.
3. **The indexes are always current** — `mygrace lint --strict` proves it.
4. **Top-down synthesis** — Requirements → Technology → Plan → Verification → Contracts → Code.
5. **Verification is architecture** — tests, traces and `<module-checks>` count.
6. **Governed autonomy** — freedom in HOW, not in WHAT.

## Semantic Markup

```ts
// START_MODULE_CONTRACT (PURPOSE, SCOPE, DEPENDS, LINKS) ... END_MODULE_CONTRACT
// START_MODULE_MAP ... END_MODULE_MAP · START_CHANGE_SUMMARY ... END_CHANGE_SUMMARY
// START_CONTRACT: fnName ... END_CONTRACT: fnName
// START_BLOCK_VALIDATE ... END_BLOCK_VALIDATE
// Log: [ModuleName][functionName][BLOCK_NAME] message
```

## Project Structure

```
docs/
  graph-index.xml          # module index — read first
  plan-index.xml           # phase index
  verification-index.xml   # verification index
  modules/, plans/         # one M-XXX.xml / Phase-N.xml per entity
  verification/            # V-M-XXX.xml (canonical <module-checks>)
  archive/                 # completed phases (remove their plan-index entry)
  requirements.xml, technology.xml, operational-packets.xml
mygrace.config.json        # layout/budgets/runner/allowCommands (optional)
AGENTS.md                  # this file
```

## Scaling and languages

When `docs/graph-index.xml` approaches `indexCaps.graph`, shard it: `mygrace module shard` is a dry run, `--apply` writes `docs/modules/shard-<slug>.xml` + `<Shard href=.../>` refs and a backup; reads are shard-transparent except `module show`. `sourceDirs`/`markupExts` replace defaults, `testRunner` is only the no-`<module-checks>` fallback; `mygrace projects` covers monorepos.

## Commands (23 CLI)

- `mygrace status --path .` / `mygrace ci --path .` / `mygrace next --path .` — snapshot / one-command gate / deterministic next action
- `mygrace lint --strict --path .` — integrity gate; add `--changed --base <ref>` (or `--files`) for incremental scope
- `mygrace trace <M-XXX>` / `mygrace impact [--files a,b,c]` — proof chain / change blast radius (both read-only)
- `mygrace integrations status --path .` — detect optional external tools (Octocode/Archify) and tested versions; advisory only
- `mygrace diagram [--kind architecture|workflow|tree] [--format json|mermaid|html] [--check]` — render the docs graph as the module graph, the delivery plan or the capability hierarchy (IR/Mermaid always; HTML via optional Archify); `--check` verifies every committed IR
- `mygrace capsule list|validate|qualify|run|continue` — experimental allowlisted routines with replay qualification and judgment hand-back (disabled unless `integrations.capsules.enabled`)
- `mygrace trust --path .` — review + record project commands (before test/verify)
- `mygrace test --module M-XXX` / `mygrace verify --module M-XXX` — scoped tests
- `mygrace projects --path .` — monorepo health; `mygrace module index|find|show|list`, `mygrace phase index|show`, `mygrace verification index`
- `mygrace packet M-XXX` / `mygrace focus M-XXX` / `mygrace context-cost --path .` — worker prompt / set / budget; `mygrace doctor --path .` — environment

## Editing Rules

1. Preserve MODULE_CONTRACT, MODULE_MAP, CHANGE_SUMMARY and block boundaries; update CHANGE_SUMMARY after changes.
2. Update `docs/graph-index.xml` when public interfaces change.
3. Update verification files (`<module-checks>`) when tests change; re-run `mygrace trust`.
4. If a contract seems wrong — propose a change, do not deviate silently.
5. Run `mygrace lint --strict` before committing; keep `.mygrace/` out of git.
