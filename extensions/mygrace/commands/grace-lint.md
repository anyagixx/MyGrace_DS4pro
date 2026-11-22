---
name: grace:lint
description: "Run the MyGRACE integrity gate"
---

Run `mygrace lint --strict --path <project-root>` for the release-quality gate.

It checks: structural XML validity, index ↔ entity field drift, duplicates,
missing PATH/DEPENDS/VERIFICATION_REF targets, phase status/steps drift, index
line caps, entity size budgets, semantic-block pairing and contract fields.
Warnings fail under `--strict`; `--format json` returns coded findings with the
documented exit codes (0 ok, 1 findings, 2 usage/config).

For the combined gate (lint + status + verification coverage) use
`mygrace ci --path <project-root>`.
