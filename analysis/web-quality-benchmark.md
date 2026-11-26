# Web-quality benchmark — three artifact tasks

Generated: 2026-11-26T00:13:01.359Z · reps: 1 · arms: plain / MyGRACE / MyGRACE+MWG.

## Aggregate quality

| Arm | N | files | mean quality % | median tokens | tool calls | wall s |
|---|---|---|---|---|---|---|
| plain | 3 | 3 | 100% | 21219 | 6 | 80 |
| grace | 3 | 3 | 100% | 20738 | 7 | 75.5 |
| grace+mwg | 3 | 3 | 95.8% | 61028 | 26 | 151.1 |

## Per task

| Arm | Task | N | score (median/max) | median tokens | tool calls | wall s |
|---|---|---|---|---|---|---|
| plain | dialog | 1 | 8/8 | 73099 | 49 | 380.5 |
| plain | form | 1 | 8/8 | 21219 | 6 | 80 |
| plain | tabs | 1 | 8/8 | 8129 | 3 | 30.9 |
| grace | dialog | 1 | 8/8 | 100048 | 46 | 396.2 |
| grace | form | 1 | 8/8 | 20738 | 7 | 75.5 |
| grace | tabs | 1 | 8/8 | 12237 | 3 | 41.7 |
| grace+mwg | dialog | 1 | 7/8 | 74637 | 39 | 220.6 |
| grace+mwg | form | 1 | 8/8 | 61028 | 24 | 151.1 |
| grace+mwg | tabs | 1 | 8/8 | 47230 | 26 | 119.5 |

Rubrics: dialog (8 checks), native form validation (8), accessible tabs (8); see JSON for check lists.

Limitations:
- Static rubrics check source patterns, not runtime accessibility behaviour; a perfect score is not proof of a good UI.
- Empty workspace, three tasks, N=1 per task/arm (3 samples per arm); no second language or blinded human grading yet.
- The grace+mwg arm used npx @latest at run time; guidance version is not pinned by the harness.

