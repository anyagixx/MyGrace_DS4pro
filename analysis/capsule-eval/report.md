# Capsule evaluation — measured pilot report

Date: 2026-11-25 · Protocol: [`protocol.md`](protocol.md) (pre-registered before any measured session)
Harness: `scripts/run-capsule-eval.ts` + `scripts/measure-capsules.ts`
Raw session JSONL is local-only (`.gitignore`); this report contains aggregates.

## Setup

- Two disposable git worktrees of this repository at `v1.7.1` (`e43e4f1`):
  - **capsule arm**: repository config enables capsules and the copied
    `.mygrace/capsules/qualifications.json` provides a current hash for
    `daily-check` and `module-onboarding`;
  - **skill arm**: identical code, `integrations.capsules.enabled=false`.
- One task per fresh `dsh --profile headless --json` session, same model route,
  same commit, no source changes (git status stays clean apart from the
  `node_modules` symlink and the arm config).
- 12 sessions: 2 tasks × 2 arms × 3 reps, order randomized with a fixed seed.
- Objective gate: independent `mygrace ci --path .` after the sessions:
  **both arms exit 0** (no gate regression).

## Results

Medians with deterministic bootstrap 95 % CI of the median (N=3 — exploratory;
CIs are wide by construction).

| Task | Arm | N | cost tokens | tool calls | wall s | cache read | gate |
|---|---|---|---|---|---|---|---|
| daily-check | capsule | 3 | 4888 [1307, 15600] | 6 [1, 12] | 32 [12, 62] | 70528 [17152, 164352] | pass |
| daily-check | skill | 3 | 3897 [3150, 4523] | 7 [6, 8] | 19 [16, 20] | 49536 [38656, 61952] | pass |
| module-onboarding | capsule | 3 | 9717 [9558, 11179] | 10 [9, 12] | 30 [29, 49] | 76032 [67328, 154368] | pass |
| module-onboarding | skill | 3 | 11803 [10482, 15259] | 9 [8, 12] | 31 [29, 32] | 77568 [75264, 89088] | pass |

Pre-registered effect summary (positive = capsule lower than skill):

| Task | Metric | capsule median | skill median | reduction % |
|---|---|---|---|---|
| daily-check | cost tokens | 4888 | 3897 | **−25.4 %** (capsule worse) |
| daily-check | tool calls | 6 | 7 | +14.3 % |
| daily-check | wall seconds | 32 | 19 | −66.8 % (capacule slower) |
| daily-check | cache read | 70528 | 49536 | −42.4 % |
| module-onboarding | cost tokens | 9717 | 11803 | **+17.7 %** |
| module-onboarding | tool calls | 10 | 9 | −11.1 % |
| module-onboarding | wall seconds | 30 | 31 | +4.5 % |
| module-onboarding | cache read | 76032 | 77568 | +2.0 % |

Per-session cost/tool/wall ranges show one capsule outlier (daily-check rep 1:
15 600 tokens, 12 tool calls, 62 s); the other two capsule runs were cheap
(4 888 and 1 307 tokens). This variance is larger than any arm-level signal at
N=3.

## Decision (pre-registered rule)

The rule was: **< 15 % reduction in tool calls or cost, or any gate-pass
regression → capsules stay experimental, no token/cost claims.** The full
N=10/arm run is only justified if the pilot mechanics are sound *and* the effect
direction is consistent.

- daily-check: capsule is **worse** on cost and wall time; tool-call reduction
  14.3 % is below the bar.
- module-onboarding: capsule shows a 17.7 % cost reduction, but **more** tool
  calls (+11.1 %) and no wall-time benefit.
- Directions conflict across tasks; confidence intervals overlap heavily;
  both gates pass.

**Outcome: inconclusive — kill criterion not met. Capsules remain experimental
and no token/cost claims are made.** The full run was intentionally not
started: spending 10× the sessions on a conflicting pilot would not produce a
defensible claim. `mygrace ci` stays the production gate.

## Honest limitations

- N=3 per arm/task; one model (DSH headless default route), one repository, one host.
- Both arms can load the installed skill catalog; the capsule prompt names the
  exact command, which changes discovery cost versus the skill arm by design.
- `cacheReadTokens` dominates totals and depends on session/cache timing; it is
  reported separately, but the cache confound is real.
- The operator is not blinded to the arm; no post-launch steering was used.
- `tool calls` counts MCP/CLI tool invocations from the run log; steps are not
  directly comparable to arbitrary agent harnesses.
- The worktrees share `node_modules` through a symlink; source and config were
  identical except the capsule switch.
- Raw prompts/answers are local-only; only aggregates are committed.

## What this means for the product

1. **Keep capsules experimental** (as shipped in v1.6.0); do not advertise them
   as a token/cost optimization. The safe value remains: one command for a
   known routine, explicit deopt, and replay qualification.
2. The module-onboarding direction is worth one *separate* pre-registered,
   larger test before any claim; daily-check should not be marketed as a capsule
   win.
3. The real cost driver may be orchestration overhead (skill lookup + command
   reading) rather than the capsule itself; a follow-up should measure the
   capsule path with the command known but no skill lookup, and compare against
   a fully manual CLI route.
4. Harness and manifest are kept so the experiment can be repeated on other
   repositories/models without re-deriving the protocol.
