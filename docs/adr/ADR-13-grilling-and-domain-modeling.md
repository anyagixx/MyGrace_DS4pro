# ADR-13 — Grilling and domain modeling are pre-planning skills

**Status:** accepted (v3.7.0)

## Context

MyGRACE plans are only as good as the decisions they encode, but the existing
skills start at requirements/planning: `mygrace-plan` assumes the problem and
vocabulary are already settled. Agents tend to jump to artifacts with hidden
assumptions, and domain terms drift between requirements, modules and code.

Two proven external techniques address this: a relentless frontier-based
interview (`grilling`) and a lightweight domain model (`GLOSSARY.md` + sparse
ADRs). The source skills are MIT-licensed and intentionally tool-agnostic.

## Decision

1. Add two substantive skills, `mygrace-grilling` and
   `mygrace-domain-modeling`, adapted to MyGRACE's indexes, trust model and
   artifact rules.
2. Do **not** ship the `grill-me` and `grill-with-docs` wrappers as separate
   skills: they are one-line aliases/orchestrations. Their trigger phrases and
   workflow are folded into `mygrace-grilling`; the docs-producing workflow
   explicitly loads `mygrace-domain-modeling`.
3. Grilling runs **before** `mygrace-plan`; it may write only the glossary and
   confirmed ADRs, never code, modules or the plan. Facts are found by the agent
   (including fresh-context subagents); decisions remain with the user.
4. Domain modeling uses the repository's existing ADR convention:
   `docs/adr/ADR-<n>-<slug>.md`, continuous numbering from the highest existing
   decision; historical ADR-1…10 in `ROADMAP.md` §4 are not renumbered or
   duplicated. Glossary files are lazy, project-specific and contain no
   implementation specs.
5. Attribution and the MIT notice live in `THIRD_PARTY_NOTICES.md`.

## Consequences

- The skill count becomes 14; generated DSH assets, marketplace metadata,
  README/AGENTS tables and validators must agree (enforced by CI).
- Grilling is optional; teams that already have a settled design can go straight
  to `mygrace-plan`.
- The glossary/ADR files are not indexed entities, so lint cannot validate them;
  the skill mandates manual link/numbering checks and keeps them out of the
  contract graph.
