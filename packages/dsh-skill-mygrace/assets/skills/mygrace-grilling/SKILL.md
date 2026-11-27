---
name: mygrace-grilling
description: "Stress-test a plan, design or idea with a relentless frontier-based interview before MyGRACE planning. Use for 'grill me', 'grill with docs', or when assumptions must be exposed before requirements are frozen."
whenToUse: "The user wants their thinking challenged before requirements/planning; not for implementing an approved plan or answering project questions."
---

# Grill the plan

A relentless interview to reach shared understanding **before** MyGRACE planning.
You are not writing the plan yet: you are exposing every decision the plan
depends on, one frontier at a time.

`grill-me` and `grill-with-docs` are triggers for this skill, not separate
methodologies: "grill me" runs the interview; "grill with docs" additionally
applies [Grill with docs](#grill-with-docs) and the `mygrace-domain-modeling`
skill.

## Relationship to other MyGRACE skills

- Use this skill **before** `mygrace-plan`; planning writes the artifacts.
- Use `mygrace-domain-modeling` when terminology or decisions need to be written
  down during the interview.
- Use `mygrace-reviewer` only after changes, not as a substitute for asking the
  user.
- Do not implement code during grilling. MyGRACE workflow is
  requirements → plan → verification → code.

## Non-negotiables

1. **Facts are your job.** Never ask the user for something you can inspect:
   filesystem, MyGRACE indexes, git history, tests, config, external docs.
   If a fact needs fresh-context exploration, dispatch a sub-agent and keep
   going; only questions downstream of that fact wait.
2. **Decisions are the user's job.** Ask, recommend, wait. Never silently assume
   an answer to keep the interview moving.
3. **One frontier per round.** Ask only questions whose prerequisites are
   already settled. A question that depends on another open question belongs to
   a later round.
4. **No artifacts before shared understanding.** Do not edit requirements,
   technology, plan, modules, code or ADRs except the glossary/ADR notes the user
   explicitly confirms during "grill with docs".
5. **MyGRACE is the source of truth.** If the user's claim contradicts the
   indexes or code, surface the contradiction instead of smoothing it over.

## Fact-finding with MyGRACE

Use the cheapest read-only surface that answers the question:

- `mygrace status` / `mygrace next` — project health and the real next action;
- `mygrace inspect module find|show` — module contracts, dependencies, paths;
- `mygrace trace <M-XXX>` — missing verification/requirement/phase links;
- `mygrace impact --files <paths>` — blast radius of a proposed change;
- `mygrace inspect file show` — contract, map and semantic blocks in one file;
- `mygrace-ask` skill — lazy index navigation for structural questions;
- tests, git history and config for behavioural facts.

Dispatch a **fresh-context sub-agent** when a frontier question needs a bounded
investigation (for example "which module owns retry policy?"). Do not ask the
user for facts and do not block the whole round on it: ask the rest of the
frontier now, and queue only the questions that depend on the result.

## The design tree

Model the discussion as a **design tree**: every decision branches into the
decisions that hang off it. The **frontier** is every decision whose
prerequisites are settled — the questions you can ask *now* without guessing at
answers you have not heard.

Run the tree in **rounds**:

1. Compute the current frontier from everything settled so far.
2. Ask the whole frontier in one round, numbered.
3. For each question, give **your recommended answer** and enough context to
   decide. Word it so "yes" accepts the recommendation.
4. Wait for the user's answers. Do not ask the next round early.
5. Fold the answers into the tree; settled decisions push the frontier outward.
6. Repeat until the frontier is empty.

Format a round exactly like this:

```
❓ **Q1** — **<question title>**: <question body; options and trade-offs if useful>

➡️ <your recommended answer, with the reason>

---

❓ **Q2** — **<question title>**: <question body>

➡️ <your recommended answer>
```

Keep questions concrete. "Should we use a queue?" is weak; "Should retries be
owned by `M-ORDER` or `M-DELIVERY`, given the current DEPENDS edge
`M-ORDER → M-DELIVERY`?" is strong.

## What to grill

- Scope and non-goals: what is explicitly *not* being built.
- Terminology: overloaded words, synonyms, words that conflict with the glossary.
- Boundaries: which module/context owns each behaviour and which only references it.
- Failure behaviour: retries, idempotency, partial failure, timeouts, recovery.
- Data and state: lifecycle, ownership, invariants, migration/backfill.
- Interfaces: contracts, versioning, error shapes, compatibility.
- Verification: what observable evidence would prove each decision.
- Trade-offs and reversibility: cost of changing the decision later.
- Constraints not visible in code: compliance, performance budgets, deadlines,
  compatibility with DSH/MCP/OS support.

Invent concrete edge-case scenarios and force a decision on them. Do not accept
"we'll figure it out later" unless the user explicitly makes deferral a decision
and records the trigger for revisiting.

## Grill with docs

When the user asked for **grill with docs**, or when decisions would otherwise be
lost:

1. Load the `mygrace-domain-modeling` skill alongside this one.
2. After each round, write only what the user confirmed:
   - `GLOSSARY.md` — resolved terms and `_Avoid_` synonyms, inline;
   - `docs/adr/ADR-<n>-<slug>.md` — only decisions that meet all three ADR
     criteria (hard to reverse, surprising without context, real trade-off).
3. Do not batch these writes to the end, and do not put implementation details
   in the glossary.
4. After the frontier is empty and the user confirms shared understanding, write
   settled decisions into `docs/requirements.xml` / `docs/technology.xml`, then
   move to `mygrace-plan` and its normal approval gate.
5. Run `mygrace lint --strict --path <root>` after artifact writes; glossary and
   ADR files are not indexed entities, so also check links and numbering by hand.

## Completion

Stop only when:

- every branch of the design tree has been visited;
- nothing is left silently assumed;
- deferred decisions are explicit, with an owner/trigger;
- the user confirms shared understanding.

Then report:

```
Grill summary
=============
Rounds: N
Settled decisions: ...
Open/deferred: ... (trigger to revisit)
Docs written: GLOSSARY.md / docs/adr/ADR-... (or "none")
Next MyGRACE skill: mygrace-plan
```

Do not act on the plan until the user confirms shared understanding.

## Anti-patterns

- Asking the user for facts you can inspect.
- Dumping every possible question instead of the current frontier.
- Multi-question dependency chains that require guessing at answers.
- Recommending nothing; "it depends" without a position.
- Writing code, modules or the plan during the interview.
- An ADR for every small reversal; ADRs are rare and load-bearing.
- Treating the interview as a checklist rather than a decision tree.

---

Adapted from Matt Pocock's `grilling` / `grill-me` / `grill-with-docs` skills
(MIT). See `THIRD_PARTY_NOTICES.md`.

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
