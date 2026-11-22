---
name: mygrace-verification
description: "Design verification for MyGRACE modules: scenarios, log markers, canonical <module-checks> and evidence in per-module verification files. Use before executing a module or when tests are weak, brittle or unactionable."
whenToUse: "Before first execution, when tests are too shallow, or when a bug needs reproducible evidence and actionable logs."
---

# Design verification

## Where things live

- One file per module: `docs/verification/V-M-XXX.xml` (20–60 lines; budget
  configurable in `mygrace.config.json`).
- One index line per entry: `docs/verification-index.xml`.
- **`<module-checks>` belongs in the verification file** — it is the canonical
  command source for `mygrace test` / `mygrace verify` (a module-file
  `<module-checks>` is a deprecated fallback). Do not duplicate it.
- Commands are trust-gated: after creating/editing verification files, the trust
  record is stale. Review the commands, then run `mygrace trust --path <root>`
  before running tests.

## Lazy process

1. Read `docs/graph-index.xml` (index only) → find the module.
2. Read that `docs/modules/M-XXX.xml` (contract) and the existing
   `docs/verification/V-M-XXX.xml` if present.
3. Do not scan other modules or the whole plan.

## Design the file

For the target module derive:

- **success scenarios** — observable outcomes for the main paths;
- **failure scenarios** — invalid input, missing dependency, timeout, failed
  assertion, and the error surface (typed error/finding code);
- **side effects / invariants** — state that must hold after the call;
- **log markers** — `[ModuleName][functionName][BLOCK_NAME] message`, on
  critical branches; never log secrets or payloads;
- **checks** — deterministic first: one or more `<check-N>` commands that fail
  on regressions (fast module-local command; broader wave/phase command only when
  it adds signal).

```xml
<V-M-XXX MODULE="M-XXX" PRIORITY="high" STATUS="pending">
  <test-files><file>src/module/index.test.ts</file></test-files>
  <module-checks><check-1>bun test src/module/index.test.ts</check-1></module-checks>
  <scenarios>
    <scenario-1 kind="success">...</scenario-1>
    <scenario-2 kind="failure">...</scenario-2>
  </scenarios>
  <required-log-markers><marker-1>[Module][fn][BLOCK]</marker-1></required-log-markers>
</V-M-XXX>
```

Then add/update the one-line entry in `docs/verification-index.xml` (sorted by
priority) and run `mygrace lint --strict --path <root>`.

## Evidence quality bar

- A scenario states an input, the expected observable result and the failure
  signal — not "it works".
- Every `<check-N>` is a real command that can fail; commands with shell
  metacharacters or interpreters need `--allow-commands` (explicit opt-in).
- Log markers must be actionable for an agent: enough to locate module/function/
  block, not a dump of all data.
- Keep the file contract-sized; if it grows past the budget, split scenarios into
  clearer checks instead of prose.

## Deliverables

Updated `docs/verification/V-M-XXX.xml` + index entry, a short verification
matrix (module | file | checks | markers), and the explicit next command
(`mygrace trust` then `mygrace verify --module M-XXX`).
