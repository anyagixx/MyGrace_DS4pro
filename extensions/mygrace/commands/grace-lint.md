---
name: grace:lint
description: "Run grace lint to check semantic markup, XML artifacts, and export drift"
---

Run `grace lint --path <project-root>` for a fast integrity snapshot.

This checks:
- GRACE semantic markup pairing and completeness
- Unique-tag convention anti-patterns in XML
- Graph/plan/verification reference mismatches
- MODULE_MAP vs export drift in supported source files

Use `--format json` for machine-readable output.
Use `--allow-missing-docs` to skip required document checks.
