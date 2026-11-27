---
name: mygrace-domain-modeling
description: "Build and sharpen a governed project's domain model: challenge terminology, maintain GLOSSARY.md and record sparse ADRs in docs/adr/. Use when resolving language, writing an ADR, or running 'grill with docs'."
whenToUse: "Terms are fuzzy or overloaded, a decision is hard to reverse/surprising, or the user asks which word/decision should be authoritative."
---

# Domain modeling

Actively build the project's **domain model** while designing: challenge terms,
invent edge-case scenarios, and write the glossary and decisions down when they
crystallise. Merely reading `GLOSSARY.md` for vocabulary is not this skill; this
skill is for *changing* the model.

## Relationship to other MyGRACE skills

- Use during `mygrace-grilling` (especially the "grill with docs" workflow) and
  before `mygrace-plan` freezes names and boundaries.
- Use `mygrace-refactor` for module/file renames; this skill records language and
  decisions, it does not restructure code.
- `mygrace-reviewer` checks contracts and verification; it is not a terminology
  review.
- Do not put implementation details in the glossary and do not turn ADRs into
  specs.

## Files

Most MyGRACE projects have one context:

```
/
├── GLOSSARY.md
├── docs/
│   ├── adr/
│   │   ├── ADR-11-guidance-and-lint-providers.md
│   │   └── ADR-12-guidance-packs.md
│   └── requirements.xml
└── src/
```

If a `GLOSSARY-MAP.md` exists at the root, the repo has multiple contexts; it
points to each context's glossary and ADRs. Use `mygrace projects --path <root>`
to discover governed projects before choosing a context.

Create files lazily: only when the first term/decision is resolved.

### ADR numbering and format in MyGRACE

Historical decisions **ADR-1 … ADR-10** live in `ROADMAP.md` §4. ADR-11 and
ADR-12 are files under `docs/adr/`. Do not renumber, move or duplicate any
existing decision.

For a new ADR:

- file: `docs/adr/ADR-<n>-<slug>.md`, e.g. `ADR-13-grilling-and-domain-modeling.md`;
- `<n>` is the highest existing `ADR-<n>` across `docs/adr/` and `ROADMAP.md` §4
  plus one; keep it continuous;
- heading `# ADR-<n> — <title>`, then `**Status:** accepted (vX.Y.Z)`, then the
  smallest useful Context / Decision / Consequences sections (a single
  paragraph is allowed);
- supersede by adding a new ADR and marking the old status `superseded by
  ADR-<n>`; never rewrite an accepted decision in place.

Do not introduce a second ADR directory, zero-padded `0001-…` numbering, or a
competing template. The repository's existing convention wins.

## Glossary format

```md
# {Context Name}

{One or two sentences: what this context is and why it exists.}

## Language

**Order**:
A request from a **Customer** to deliver goods.
_Avoid_: Purchase, transaction

**Invoice**:
A request for payment for an **Order**, sent to its **Customer** after delivery.
_Avoid_: Bill, payment request
```

Rules:

- **Be opinionated.** Pick the best word and list rejected synonyms under
  `_Avoid_`.
- **Keep definitions tight.** One or two sentences; define what it *is*, not what
  it does.
- **Bold other glossary terms** inside definitions; the surrounding sentence
  states the relationship.
- **Only project-specific concepts.** Timeouts, generic error types and utility
  patterns do not belong, even if used heavily.
- **No specs, scratch pads or implementation decisions.** The glossary is a
  glossary and nothing else.
- Group terms under subheadings only when natural clusters emerge.
- Single-context repos use root `GLOSSARY.md`; multi-context repos use
  `GLOSSARY-MAP.md` with each context's path and relationships.

## During a session

### Challenge against the glossary

When the user's usage conflicts with `GLOSSARY.md`, call it out immediately:
"Your glossary defines 'cancellation' as X, but you seem to mean Y. Which is it?"

### Sharpen fuzzy language

When a term is vague or overloaded, propose a precise canonical term and the
synonyms to avoid: "You're saying 'account': do you mean **Customer** or
**User**? Those are different things."

### Stress-test with concrete scenarios

When relationships are discussed, invent edge cases that force precision about
boundaries: partial failure, retries, cancellation, ownership hand-off,
duplicated events, historical data.

### Cross-check with code and indexes

When the user states how something works, verify it before recording it:

- `mygrace inspect module find|show` — module purposes, paths, DEPENDS;
- `mygrace trace <M-XXX>` — requirement/verification/phase links;
- `mygrace inspect file show` — contracts and semantic blocks;
- `mygrace-ask` skill — lazy navigation to the owning module;
- source/tests for actual behaviour.

If code and the stated model disagree, surface the contradiction and make the
user decide which one changes. Do not silently record a fiction.

### Update the glossary inline

When a term is resolved and the user confirms the definition, update
`GLOSSARY.md` immediately. Do not batch terms to the end of the session.
If a term maps to a governed module, mention the module id next to it; do not
rename modules here (that is `mygrace-refactor`).

### Offer ADRs sparingly

Offer an ADR only when **all three** are true:

1. **Hard to reverse** — changing your mind later has meaningful cost.
2. **Surprising without context** — a future reader will ask "why is it like this?".
3. **A real trade-off** — genuine alternatives existed and one was chosen for
   reasons worth recording.

If any criterion is missing, skip the ADR. Typical qualifiers: architectural
shape, integration pattern between contexts, lock-in technology choices,
boundary/ownership decisions, deliberate deviations from the obvious path,
invisible constraints, and non-obvious rejected alternatives.

## Integration with grilling and planning

- In `mygrace-grilling`, apply this skill after each **settled** decision; write
  only what the user confirmed.
- Before `mygrace-plan`, ensure requirements/technology use the canonical terms;
  the plan's module names should match the glossary.
- Never let glossary/ADR writes become a reason to skip the user's approval gate.
- After writing, check links, ADR numbering and that no existing decision was
  rewritten. `mygrace lint --strict` does not validate glossaries/ADRs (they are
  not indexed entities), so this manual check is mandatory.

## Output

```
Domain model update
===================
Glossary: <path> — added/changed terms: ...
ADRs: <path> — accepted/ superseded/ none
Conflicts surfaced: ...
Open terminology questions: ...
Next action: <mygrace-plan | continue grilling | mygrace-refactor>
```

## Anti-patterns

- Recording implementation detail or a full spec in `GLOSSARY.md`.
- Inventing a term the user did not agree to.
- Rewriting or renumbering accepted ADRs.
- An ADR for every reversible choice.
- Duplicating `ROADMAP.md` architecture decisions instead of linking them.
- Letting code and glossary silently diverge.

---

Adapted from Matt Pocock's `domain-modeling` skill (MIT), including its
`GLOSSARY-FORMAT.md` and `ADR-FORMAT.md` guidance. See
`THIRD_PARTY_NOTICES.md`.

## License notice

MIT License

Copyright (c) 2026 Matt Pocock

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
