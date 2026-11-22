---
name: mygrace-reviewer
description: "Review MyGRACE integrity: run the codified lint gate, then check what tooling cannot (contract↔code match, verification quality, trust hygiene). Use before merging waves, after refactors, or at phase boundaries."
whenToUse: "Before merging a wave, after a refactor, at a phase boundary, or when drift or a stale trust record is suspected."
---

# Integrity review

## First pass — automated (do this first)

Run `mygrace ci --format json --path <root>` first — the umbrella gate that runs
strict lint, checks index readability and verification coverage, and (with
`--tests`, trust required) the scoped test suite. Then, when you need the raw
findings, `mygrace lint --strict --format json --path <root>`. Lint enforces:
XML validity, all field drift, duplicates, missing PATH/DEPENDS/VERIFICATION_REF,
phase status/steps drift, index caps, entity size budgets, name-aware block
pairing and contract fields. Report its finding codes; do not re-check by hand
what it already covers.

Then run the read-only query trio — `mygrace trace <M-XXX> --format json`
(chain gaps: MISSING_VERIFICATION_REF, VERIFICATION_FILE_MISSING,
TEST_FILE_MISSING, MODULE_PATH_MISSING), `mygrace impact --files <changed>`
(blast radius/dependents) and `mygrace next --path <root>` (does the tooling
agree with the review?).

Also check:

- `mygrace status --format json --path <root>` — counts and lint summary;
- `.mygrace/trust.json` — present, current (no stale/missing entries), and
  `.mygrace/` gitignored; otherwise `mygrace trust` is needed after review;
- `docs/verification/V-M-XXX.xml` — `<module-checks>` present in the canonical
  location (module-file fallback is deprecated and should be flagged to the owner).

## Modes

- **scoped-gate** (default): the changed module's index entry, its
  `docs/modules/M-XXX.xml`, changed source files, and its verification file.
- **wave-audit**: after a wave — all modified statuses, phase step counts,
  new verification entries, spot-check 2–3 entity files.
- **full-integrity**: at phase boundaries — every index entry ↔ file, no orphans,
  STATUS consistency, CrossLink bidirectionality, caps/budgets.

## What only a human/agent can check

- Contract ↔ code: does the implementation match PURPOSE/SCOPE/interfaces?
- Verification quality: do scenarios assert observable behaviour (not "returns
  true"), do failure paths have checks, are log markers actionable?
- Trust hygiene: were the executed commands reviewed before `mygrace trust`?
- Change discipline: indexes updated in the same change as the code.

## Output

```
MyGRACE Review Report
=====================
Mode: scoped-gate / wave-audit / full-integrity
Lint: N errors, M warnings (codes: ...)
Trust: current / stale / missing / not gitignored
Contract↔code: PASS / issues
Verification quality: PASS / issues
Summary: PASS / FAIL
```

Rules: smallest useful scope; index consistency is critical; never auto-fix
contracts or architecture — propose the change; escalate when a scoped check
reveals wider drift.
