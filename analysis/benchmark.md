# MyGRACE benchmarks (core commands)

Generated: 2026-11-25T19:10:59.102Z · runs: 7 (one warm-up discarded) · measure: /usr/bin/time

| Target | Command | median wall | p95 wall | median peak RSS | failures |
|---|---|---|---|---|---|
| repo (29 modules) | `status` | 253 ms | 310 ms | 90 MB | 0 |
| repo (29 modules) | `lint --strict` | 260 ms | 297 ms | 87.8 MB | 0 |
| repo (29 modules) | `ci` | 380 ms | 422 ms | 108.6 MB | 0 |
| demo-store (3 modules) | `status` | 159 ms | 171 ms | 76.8 MB | 0 |
| demo-store (3 modules) | `lint --strict` | 155 ms | 170 ms | 77.3 MB | 0 |
| demo-store (3 modules) | `ci` | 183 ms | 227 ms | 80.3 MB | 0 |
| synthetic (70 modules) | `status` | 258 ms | 296 ms | 87 MB | 0 |
| synthetic (70 modules) | `lint --strict` | 258 ms | 296 ms | 87.7 MB | 0 |
| synthetic (70 modules) | `ci` | 419 ms | 430 ms | 93.7 MB | 0 |

Limitations:
- CLI/index performance only; not agent-task success or token usage.
- No external OSS repository with MyGRACE artifacts yet; targets are this repo, demo-store and a generated valid 70-module project.
- GNU time reports the child's peak RSS; wall time includes bun startup.

