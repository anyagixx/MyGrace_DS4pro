# Web-quality benchmark — dialog task, N=10, runtime a11y

Generated: 2026-11-27T01:23:36.777Z · reps: 10 · runtime: true · arms: plain / grace / grace+mwg.

## Aggregate

| Arm | N | files | mean quality % | mean runtime % | median tokens | tool calls | wall s |
|---|---|---|---|---|---|---|---|
| plain | 10 | 10 | 96% | 100% | 45555 | 22 | 195.3 |
| grace | 10 | 10 | 94% | 100% | 44641 | 14 | 185.3 |
| grace+mwg | 10 | 10 | 79% | 100% | 81182 | 45 | 325.4 |

## Per task

| Arm | Task | N | score (median/max) | median tokens | tool calls | wall s |
|---|---|---|---|---|---|---|
| plain | dialog | 10 | 10/10 | 45555 | 22 | 195.3 |
| grace | dialog | 10 | 10/10 | 44641 | 14 | 185.3 |
| grace+mwg | dialog | 10 | 8/10 | 81182 | 45 | 325.4 |

Runtime checks: `dialogOpens`, `focusInside`, `escapeCloses` in headless Chromium; static rubric has 10 checks.

Limitations:
- Runtime checks exercise Chromium via Playwright; they do not replace assistive-technology testing or human review.
- Automated blind grading: rubrics are not shown to the agent; N=10 per arm on one dialog task with an empty workspace.
- The grace+mwg arm used npx @latest at run time; guidance version is not pinned by the harness.
- Results are arm medians/means on a single task, not a general product-quality claim.

