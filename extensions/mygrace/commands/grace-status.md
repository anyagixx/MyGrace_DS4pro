---
name: grace:status
description: "Show MyGRACE project health"
---

Run `mygrace status --path <project-root> --format json` for counts of modules,
phases and verifications plus the lint summary, then summarize:

1. Counts and status/priority distribution from the three indexes.
2. Integrity: `mygrace ci --path <project-root>` result and finding codes.
3. Blockers: missing requirements/technology, empty indexes, stale trust record.
4. Suggested next action (plan / verification / execute / refresh / done).

Use the `mygrace-status` skill for the full reporting process.
