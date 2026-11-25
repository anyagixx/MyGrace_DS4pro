---
name: mygrace-fix
description: "Debug using MyGRACE lazy navigation: index → module contract → semantic block → fix, then update metadata and re-verify. Use when a bug report or failing test needs tracing to a governed module."
whenToUse: "A bug, error or failing test must be traced and fixed inside a MyGRACE-governed project."
---

# Debug with lazy navigation

## 1. Locate via the index

Read `docs/graph-index.xml` (≤100 lines, or MCP `mygrace_find_modules`). Find the
module implied by the error/log marker. Note its `PATH` and `VERIFICATION_REF`.
Do not read all modules.

## 2. Read the contract and its verification

- `docs/modules/M-XXX.xml` (30–80 lines) — expected purpose, inputs/outputs, errors.
- `docs/verification/V-M-XXX.xml` (20–60 lines) — scenarios, `<module-checks>`,
  required log markers.

## 3. Navigate to the block

From a log line `[Module][function][BLOCK_NAME]`, find `START_BLOCK_BLOCK_NAME`
in the source at `PATH`. `mygrace inspect file show <path> --root <root> --contracts --blocks`
lists the file's contracts and blocks compactly. Read the enclosing function's
contract.

## 4. Compare and fix

Compare contract (expected) vs code (actual). Apply the smallest fix inside the
semantic block boundaries; update `CHANGE_SUMMARY`.

## 5. Narrow the scope first (optional)

- `mygrace next --path <root>` — deterministic recommendation and its code/WHY;
  follow it when the project has an obvious blocking state.
- `mygrace lint --changed [--base <ref>]` (or `--files a,b,c`) — lint only the
  files touched by the fix (index/entity/source classification).
- `mygrace trace <M-XXX> --path <root>` — confirm the module→verification→tests
  chain before and after the fix.

## 6. Update metadata and verify

- Contract changed → update `docs/modules/M-XXX.xml` and the index entry.
- Tests/markers changed → update the verification file, then re-run
  `mygrace trust --path <root>` (the trust record hashes command sources).
- Run `mygrace verify --module <M-XXX> --path <root>` (trust-gated) and
  `mygrace lint --strict --path <root>`.

## Rules

- Always start with the index; read only the target module (plus its verification).
- Never fix code without reading its contract.
- Never change a contract silently — propose it.
- If a verification command is refused by the trust gate, review it and re-run
  `mygrace trust`; do not bypass with ad-hoc execution.
