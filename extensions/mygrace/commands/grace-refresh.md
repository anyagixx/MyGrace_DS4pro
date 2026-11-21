---
name: grace:refresh
description: "Synchronize GRACE shared artifacts with the actual codebase"
---

Run a GRACE refresh to sync knowledge-graph.xml and verification-plan.xml with the actual codebase.

Choose scope:
- **targeted** (default) — scan only changed modules and affected surfaces
- **full** — scan whole source tree (after refactors or suspected drift)

Use the `/grace:refresh` skill for the full process.
