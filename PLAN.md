# Historical plan — superseded by ROADMAP.md

> **Status: historical / superseded.** This was the DSH-first v1 plan that
> produced the `v0.1.0` line. The audit of `v1.0.1` and the current work are
> tracked in [`ROADMAP.md`](ROADMAP.md); do not use this file for current
> decisions. It is kept so the original intent stays traceable.

## What the v1 plan set out to do

- Make DeepSeek Harness the primary platform: skills installed into the DSH
  skills root, MCP wired into the profile, `AGENTS.md` auto-loaded.
- One-command install and bootstrap (`mygrace install-dsh`, `mygrace init-dsh`).
- Adapt the skill set to the DSH `skill` tool (frontmatter with `description` and
  `whenToUse`) and remove platform-specific slash-command syntax.
- Keep the index-first methodology (indexes + per-entity files) as the core idea.

## Deviations and follow-ups

- The planned `mygrace init --ds` became `mygrace init-dsh`.
- The "all phases done" v0.1.0 claim was too optimistic: an independent audit of
  `v1.0.1` found stalled CLI semantics, an unsafe execution model for
  project-declared commands, stale docs and unenforced invariants.
- Those findings became the Wave 0/1 work in `ROADMAP.md`: strict XML layer,
  typed errors and exit codes, safe ids/paths, project config, lint with teeth,
  trust-gated command execution, MCP runtime hardening, installer hardening and
  a documentation truth pass.

## Where to look now

- [`ROADMAP.md`](ROADMAP.md) — vision, ADRs, waves, release gates (current plan).
- [`CHANGELOG.md`](CHANGELOG.md) — what actually shipped.
- [`README.md`](README.md) — the current user-facing surface.

The original plan was written in Russian; this English summary replaces it so the
repository keeps a single documentation language.
