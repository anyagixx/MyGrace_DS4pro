# MyGRACE quickstart (5 minutes)

MyGRACE gives a coding agent a small, enforced map of a repository: three
line-capped XML indexes, one contract per module and verification files that
connect intent → modules → tests. It is not another model; it is the **contract
layer** around the agent you already use.

## The two commands that matter

```bash
mygrace next --path .   # exactly one deterministic next action
mygrace ci   --path .   # the honest one-command gate (exit 0/1/2)
```

Everything else is reference material for when those two are not enough.

## New project

```bash
# 1. scaffold docs/, AGENTS.md and mygrace.config.json
mygrace init-dsh --path /tmp/my-project --name MyProject

# 2. describe requirements + technology, then use the mygrace-plan and
#    mygrace-verification skills to design modules/phases/verification
#    (the agent writes docs/modules/M-*.xml, docs/plans/Phase-*.xml,
#    docs/verification/V-M-*.xml and the three indexes)

# 3. integrity gate (safe: executes no project commands)
mygrace lint --strict --path /tmp/my-project
mygrace ci --path /tmp/my-project

# 4. review the declared <module-checks>, then allow execution
mygrace trust --check --path /tmp/my-project   # inspect only
mygrace trust --path /tmp/my-project           # record sha256 hashes
mygrace test --module M-CORE --path /tmp/my-project
mygrace verify --module M-CORE --path /tmp/my-project
```

## Existing project

```bash
mygrace init-dsh --path .          # additive; creates docs/ if missing
# design the module map with the mygrace-plan skill, then:
mygrace lint --strict --path .
mygrace next --path .
```

## Safety in one paragraph

Project-declared commands are untrusted input. `mygrace test/verify` refuse to
run them without a current `.mygrace/trust.json`, `allowCommands: true` or
`--allow-commands`. Dangerous patterns (privilege escalation, network tools,
destructive removal, eval/encoded payloads, device writes, publishing,
out-of-tree redirects) are refused even behind trust unless you pass
`--allow-unsafe-commands`; every execution/refusal is appended to
`.mygrace/audit.log`. Never commit `.mygrace/`.

## Optional depth

- `mygrace trace M-X` / `mygrace impact` — proof chain and change blast radius;
- `mygrace packet M-X` / `mygrace focus M-X` — compact worker context;
- `mygrace diagram` — architecture/workflow/tree IR (Archify optional);
- Octocode graph mode — see the setup section in README;
- capsules — experimental, no token/cost claims (see `analysis/capsule-eval/report.md`).

## Where to read next

- [`README.md`](../README.md) — full reference and honest limitations;
- [`AGENTS.md`](../AGENTS.md) — the contract an agent must follow;
- [`ROADMAP.md`](../ROADMAP.md) — what is shipped, planned or intentionally not done;
- [`analysis/benchmark.md`](../analysis/benchmark.md) — measured CLI performance.
