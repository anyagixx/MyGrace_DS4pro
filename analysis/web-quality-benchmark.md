# Web-quality benchmark — four artifact tasks (3 web + Python CLI)

Generated: 2026-11-26T08:29:04.005Z · reps: 1 · arms: plain / MyGRACE / MyGRACE+MWG.

## Aggregate quality

| Arm | N | files | mean quality % | median tokens | tool calls | wall s |
|---|---|---|---|---|---|---|
| plain | 4 | 4 | 96.9% | 22716 | 7 | 110.5 |
| grace | 4 | 4 | 96.9% | 9018 | 5 | 42.2 |
| grace+mwg | 3 | 3 | 90% | 53785 | 30 | 256.1 |

## Per task

| Arm | Task | N | score (median/max) | median tokens | tool calls | wall s |
|---|---|---|---|---|---|---|
| plain | dialog | 1 | 10/10 | 36611 | 7 | 166.6 |
| plain | form | 1 | 9/9 | 32853 | 14 | 163.9 |
| plain | tabs | 1 | 9/9 | 11906 | 7 | 56.6 |
| plain | python-cli | 1 | 7/8 | 12578 | 4 | 57.1 |
| grace | dialog | 1 | 10/10 | 32275 | 19 | 139.7 |
| grace | form | 1 | 9/9 | 8311 | 4 | 41 |
| grace | tabs | 1 | 9/9 | 9725 | 5 | 43.3 |
| grace | python-cli | 1 | 7/8 | 6951 | 3 | 17 |
| grace+mwg | dialog | 1 | 7/10 | 121485 | 65 | 482.1 |
| grace+mwg | form | 1 | 9/9 | 53785 | 30 | 256.1 |
| grace+mwg | tabs | 1 | 9/9 | 42538 | 22 | 112.7 |

Rubrics: dialog (10 checks), native form validation (9), accessible tabs (9), Python CLI (8); see JSON for check lists. Runtime proxies are static patterns, not browser execution.

Limitations:
- Static rubrics/runtime proxies check source patterns, not real browser accessibility behaviour; a perfect score is not proof of a good UI.
- Empty workspace, four tasks (3 web + Python CLI), N=1 per task/arm; no real browser execution or blinded human grading yet.
- The grace+mwg arm ran only web tasks and used npx @latest at run time; guidance version is not pinned by the harness.

