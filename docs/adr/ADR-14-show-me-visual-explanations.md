# ADR-14 — Visual explanations are a user-invoked skill

**Status:** accepted (v3.8.0)

## Context

MyGRACE already owns deterministic project views (`mygrace diagram`) and textual
navigation (`mygrace ask`, `inspect file show`, `trace`). It has no compact way to
explain an ad-hoc algorithm, call path, component tree, diff or UI layout to a
human reviewer. HumanLayer's MIT-licensed `show-me` skill fills that gap, but its
upstream form uses a raw `Bash(open ...)` and writes HTML wherever convenient.

## Decision

1. Add `mygrace-show-me` as a **user-invoked** skill: its frontmatter sets
   `disable-model-invocation: true`, and the DSH provider reflects that as
   `modelInvocable: false` (userInvocable stays true).
2. Prefer text views first (pseudocode, call/component/file trees, Mermaid,
   focused diffs). Use `mygrace diagram` when the subject is the docs graph, and
   `inspect file show`/`trace` for facts; never invent structure.
3. Focused HTML artifacts are bounded and self-contained: no external assets or
   network, escaped labels, under ~256 KB, written to `.mygrace/show-me/` (local,
   gitignored) or temp; opened through `present` or a platform-safe argv opener,
   never a raw shell string.
4. Attribution and the MIT notice are in `THIRD_PARTY_NOTICES.md`; the skill body
   also embeds the license notice.

## Consequences

- Skill count becomes 15; generated DSH assets, marketplace metadata,
  README/AGENTS/template, tests and validators move together (CI-enforced).
- `show-me` is not part of the governance gate and its HTML is not linted; it
  remains an explanation aid, not a governed artifact.
- The generator now supports per-skill `modelInvocable`, so future skills can opt
  out of model invocation without special cases.
