# External benchmark — expressjs/express + psf/requests

Generated: 2026-11-25T20:38:58.324Z · agent reps: 2 · curated MyGRACE artifacts (lint/ci clean on both repos)

## Repositories

| Repo | Commit | Modules | Tasks |
|---|---|---|---|
| express | `43fca52d28a4` | 6 | 3 |
| requests | `3c7baaa05ab4` | 6 | 3 |

## CLI

| Repo | Command | median wall | p95 wall | median peak RSS | failures |
|---|---|---|---|---|---|
| express | `status` | 186 ms | 210 ms | 79.7 MB | 0 |
| express | `lint --strict` | 175 ms | 187 ms | 81 MB | 0 |
| express | `ci` | 201 ms | 231 ms | 82.5 MB | 0 |
| express | `trace` | 164 ms | 168 ms | 66.6 MB | 0 |
| express | `context packet` | 142 ms | 146 ms | 65.8 MB | 0 |
| requests | `status` | 207 ms | 215 ms | 80.6 MB | 0 |
| requests | `lint --strict` | 180 ms | 196 ms | 80.1 MB | 0 |
| requests | `ci` | 218 ms | 219 ms | 81.4 MB | 0 |
| requests | `trace` | 158 ms | 193 ms | 68.1 MB | 0 |
| requests | `context packet` | 138 ms | 149 ms | 64.7 MB | 0 |

## Agent sessions (headless DSH, keyword-graded)

| Repo | Task | Arm | N | median cost tokens | median tool calls | median wall s | correct |
|---|---|---|---|---|---|---|---|
| express | express-res.send | grace | 2 | 4921 | 6 | 14.1 | 2/2 |
| express | express-res.send | plain | 2 | 4681 | 7 | 14.8 | 2/2 |
| express | express-routing | grace | 2 | 24165 | 27 | 68.7 | 2/2 |
| express | express-routing | plain | 2 | 31172 | 21 | 80.9 | 2/2 |
| express | express-static | grace | 2 | 6316 | 6 | 15.4 | 2/2 |
| express | express-static | plain | 2 | 4393 | 6 | 15.1 | 2/2 |
| requests | requests-session.send | grace | 2 | 11419 | 13 | 29.3 | 2/2 |
| requests | requests-session.send | plain | 2 | 9564 | 10 | 26.8 | 2/2 |
| requests | requests-auth | grace | 2 | 41983 | 35 | 75.4 | 2/2 |
| requests | requests-auth | plain | 2 | 29888 | 24 | 55.6 | 2/2 |
| requests | requests-redirects | grace | 2 | 12607 | 10 | 25.2 | 2/2 |
| requests | requests-redirects | plain | 2 | 9600 | 10 | 25.7 | 2/2 |

Limitations:
- Curated artifacts are authored for this benchmark, not produced by the project itself.
- Three tasks per repository; keyword grading only; one model/host; small N.
- CLI numbers include bun startup and are not a throughput benchmark.
- No blinded human evaluation; grading is automated and therefore blind to the arm.

## Interpretation (honest)

- **CLI:** the engine stays in the 138–218 ms / 65–82 MB range on both a
  JavaScript and a Python repository with curated artifacts; this is the useful
  external validation. Command startup dominates, not repo size.
- **Agent sessions:** all 12 arm/task combinations answered correctly
  (keyword-graded 2/2 each), so correctness did not differentiate the arms.
  Cost was **higher** with MyGRACE in 4 of 6 tasks:
  express static +44 %, requests auth +40 %, requests redirects +31 %,
  requests session.send +19 %; express routing was **−22 %** (24 165 vs 31 172)
  and express res.send +5 % (within noise at N=2). Tool calls were equal or
  higher with MyGRACE in most tasks.
- **Conclusion:** in this setup the generated/curated artifacts did not reduce
  agent effort; the value proposition remains governance/traceability, not token
  savings. This is a **negative result**, reported as such. Larger N, deeper
  tasks and real project-curated docs are required before any productivity claim.

