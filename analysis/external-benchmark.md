# External benchmark — expressjs/express

Generated: 2026-11-25T20:05:53.962Z · commit `43fca52d28a422c8be48fd489cbd4f2d6152bab6` · agent reps: 2

## Generated MyGRACE artifacts

Six modules (one per `lib/*.js`) with real upstream test files; `lint --strict` and `ci` pass on the fixture.

## CLI (grace arm)

| Command | median wall | p95 wall | median peak RSS | failures |
|---|---|---|---|---|
| `status` | 169 ms | 184 ms | 81.5 MB | 0 |
| `lint --strict` | 158 ms | 166 ms | 80.6 MB | 0 |
| `ci` | 137 ms | 157 ms | 82.5 MB | 0 |
| `trace M-RESPONSE` | 105 ms | 121 ms | 67.9 MB | 0 |
| `context packet M-RESPONSE` | 103 ms | 106 ms | 65.5 MB | 0 |

## Agent sessions (headless DSH, keyword-graded)

| Task | Arm | N | median cost tokens | median tool calls | median wall s | correct |
|---|---|---|---|---|---|---|
| res.send location | grace | 2 | 6243 | 5 | 15.05 | 2/2 |
| res.send location | plain | 2 | 6877 | 6 | 17.5 | 2/2 |
| routing path | grace | 2 | 31812 | 20 | 81.2 | 2/2 |
| routing path | plain | 2 | 25340 | 18 | 68.9 | 2/2 |

Limitations:
- MyGRACE artifacts are generated from file layout, not curated by a human.
- Two shallow retrieval/architecture tasks; keyword-graded correctness only.
- One model, one host, small N; not a general agent-productivity claim.
- CLI benchmark runs on a warm machine with bun startup included.


## Interpretation (honest)

- **CLI on a real repository:** generated MyGRACE artifacts over express cost
  105–169 ms per command (including bun startup) and ≈65–83 MB peak RSS;
  `ci` was the cheapest of the three whole-project commands because express'
  graph is small (6 modules). This validates the engine outside self-owned repos.
- **Agent sessions (N=2/arm/task, keyword-graded):** both arms answered both
  tasks correctly. The simple lookup (`res.send`) was slightly cheaper with
  MyGRACE (6 243 vs 6 877 median cost tokens; 5 vs 6 tool calls; 15.1 s vs 17.5 s),
  but the architecture/routing task was **more expensive** with MyGRACE
  (31 812 vs 25 340 tokens; 20 vs 18 tool calls; 81.2 s vs 68.9 s).
  Directions conflict; this is **not evidence of a general benefit**.
- The generated docs are layout-derived, not curated; tasks are shallow; a
  single model and two repetitions cannot support broad claims. Treat this as
  a harness + first data point, not a product verdict.

## Reproduce

```bash
DEEPSEEK_API_KEY=... bun run scripts/external-benchmark.ts --reps 2 --runs 5
```
