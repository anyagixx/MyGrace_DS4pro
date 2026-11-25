# External benchmark — expressjs/express + psf/requests

Generated: 2026-11-25T21:59:04.418Z · agent reps: 2 · curated MyGRACE artifacts (lint/ci clean on both repos)

## Repositories

| Repo | Commit | Modules | Tasks |
|---|---|---|---|
| express | `43fca52d28a4` | 6 | 4 |
| requests | `3c7baaa05ab4` | 6 | 3 |

## CLI

| Repo | Command | median wall | p95 wall | median peak RSS | failures |
|---|---|---|---|---|---|
| express | `status` | 209 ms | 216 ms | 80 MB | 0 |
| express | `lint --strict` | 237 ms | 237 ms | 80.5 MB | 0 |
| express | `ci` | 234 ms | 314 ms | 80.9 MB | 0 |
| express | `trace` | 179 ms | 200 ms | 66.9 MB | 0 |
| express | `context packet` | 167 ms | 178 ms | 65.5 MB | 0 |
| requests | `status` | 115 ms | 115 ms | 82.1 MB | 0 |
| requests | `lint --strict` | 116 ms | 121 ms | 81.1 MB | 0 |
| requests | `ci` | 140 ms | 144 ms | 83.1 MB | 0 |
| requests | `trace` | 105 ms | 106 ms | 68.5 MB | 0 |
| requests | `context packet` | 131 ms | 136 ms | 65.9 MB | 0 |

## Agent sessions (headless DSH, keyword-graded)

| Repo | Task | Arm | N | median cost tokens | median tool calls | median wall s | correct |
|---|---|---|---|---|---|---|---|
| express | express-res.send | grace | 2 | 4935 | 6 | 12.5 | 2/2 |
| express | express-res.send | plain | 2 | 4402 | 6 | 13.1 | 2/2 |
| express | express-routing | grace | 2 | 24550 | 19 | 49.1 | 2/2 |
| express | express-routing | plain | 2 | 25808 | 24 | 75.9 | 2/2 |
| express | express-static | grace | 2 | 5851 | 8 | 12.2 | 2/2 |
| express | express-static | plain | 2 | 4608 | 8 | 13.5 | 2/2 |
| express | express-web-dialog | grace | 2 | 6397 | 1 | 20.5 | 2/2 |
| express | express-web-dialog | plain | 2 | 11069 | 0 | 47.4 | 2/2 |
| express | express-web-dialog | grace+mwg | 2 | 31455 | 20 | 81.2 | 2/2 |
| requests | requests-session.send | grace | 2 | 7830 | 11 | 19 | 2/2 |
| requests | requests-session.send | plain | 2 | 14195 | 15 | 25.1 | 2/2 |
| requests | requests-auth | grace | 2 | 33775 | 39 | 50.5 | 2/2 |
| requests | requests-auth | plain | 2 | 41213 | 27 | 67.3 | 2/2 |
| requests | requests-redirects | grace | 2 | 9791 | 9 | 17.1 | 2/2 |
| requests | requests-redirects | plain | 2 | 11772 | 11 | 19.9 | 2/2 |

Limitations:
- Curated artifacts are authored for this benchmark, not produced by the project itself.
- Three navigation tasks per repository plus one web-dialog task for express; keyword grading only; one model/host; small N.
- CLI numbers include bun startup and are not a throughput benchmark.
- No blinded human evaluation; grading is automated and therefore blind to the arm.
- The grace+mwg arm runs only for express-web-dialog and uses npx @latest at session time; network and guidance version are not pinned by the harness.

## Interpretation (honest, v3.1 run)

- **CLI:** 105–237 ms / 65–83 MB across both repos; the new modules did not move
  the startup-dominated envelope.
- **Agent sessions:** all 30 sessions (2 reps per applicable arm/task) answered
  correctly under keyword grading. Token results remain mixed and unstable:
  MyGRACE was cheaper on routing (−5 %), requests session.send (−45 %), auth
  (−18 %) and redirects (−17 %), but more expensive on res.send (+12 %) and
  static (+27 %); these directions flipped between v3.0 and v3.1 runs, so no
  stable token benefit is claimed.
- **MyGRACE + MWG dialog arm:** 31 455 median tokens / 20 tool calls / 81.2 s
  versus MyGRACE-only 6 397 / 1 / 20.5 s and plain 11 069 / 0 / 47.4 s. The
  guidance arm spent heavily on retrieving guidance and did **not** improve the
  keyword-graded answer. This is a **negative result for token efficiency**;
  keyword grading cannot measure whether the dialog design is more modern or
  accessible, so quality remains unmeasured rather than disproven.
- Curated artifacts, shallow tasks, one model/host, N=2 — a harness and honesty
  check, not a productivity benchmark.

