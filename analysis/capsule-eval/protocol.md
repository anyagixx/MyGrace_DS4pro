# Capsule measurement — pre-registered protocol

Status: **pre-registered 2026-11-25, before any measured session was run.**
Results were recorded separately in [`report.md`](report.md); the protocol below was not changed after pre-registration.
Experiment: does the capsule fast path reduce agent effort versus re-deriving the
same routine from the skill/CLI prose, at equal gate-pass outcome?

## Hypotheses

- **H1 (primary):** the capsule arm uses fewer tool steps and fewer tokens
  (`uncachedInputTokens + outputTokens`) than the skill arm on the same task.
- **H2 (safety):** the capsule arm does not reduce the objective gate result
  (independent `mygrace ci` exit code after the session) or correctness of the
  reported outcome.
- **H0:** no material difference — capsules remain experimental and no
  token/cost claims are made.

## Design

- Tasks:
  - `T1 daily-check` — "run the daily health check and report the result";
    capsule arm runs `mygrace capsule run daily-check`; skill arm runs the
    documented `status → lint → ci → next` routine.
  - `T2 module-onboarding` — "onboard to module M-CLI and report the briefing";
    capsule arm runs `mygrace capsule run module-onboarding --module M-CLI`;
    skill arm runs `status/trace/packet/focus` manually.
- Arms: `capsule` (project config enables capsules, qualified) vs `skill`
  (same code, capsules disabled in config; prompt describes the objective without
  the capsule command).
- One task per fresh headless DSH session (`dsh --profile headless --json`),
  same model/provider (DeepSeek route from the launching environment), same
  project commit, clean tree except an identical uncommitted change (T1 only).
- Pilot: **3 sessions per arm per task** (12 sessions). Full run (N=10/arm/task)
  only if the pilot mechanics are sound and the effect direction justifies the
  spend.
- Order: randomized, balanced across tasks/arms; no user steering after launch.

## Metrics (from DSH session records)

Primary: `cost = uncachedInputTokens + outputTokens`; `steps` (agent steps) as
the tool-call proxy. Secondary: `turns`, `toolMs`, `llmMs`, cacheReadTokens,
wall time, final answer length, objective gate result.

Extraction: `scripts/measure-capsules.ts` reads
`$DSH_HOME/storages/session_projcache/sessions/*.json`, joins the manifest by
session id, and reports per-arm/task medians with bootstrap 95% CIs. Raw session
files stay local; only aggregates are published.

## Pre-registered decision rule

- If the capsule arm shows **< 15 % reduction** in steps or cost, or any gate-pass
  regression: keep capsules experimental, no token/cost claims.
- If ≥ 15 % reduction and no gate regression: report as a **pilot signal**
  (single model, small N, one repo family) — still no universal claim.
- Inconclusive is an acceptable result and is reported as such.

## Confounds and controls

Cache state (`cacheReadTokens` reported separately), identical commit/config
except the capsule switch, fixed prompt text, no post-launch steering, fresh
session per task, same host/model, no background jobs during runs. The operator
is not blinded (arm is visible to the launcher), which is a stated limitation.

## Non-goals

No claim about the SkillCache paper's numbers; no production gating change;
capsules do not replace `mygrace ci`.
