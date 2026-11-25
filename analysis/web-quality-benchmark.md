# Web-quality benchmark — accessible dialog artifact

Generated: 2026-11-25T22:40:57.167Z · reps: 2 · task: one generated `dialog-demo.html` graded by a six-point static rubric.

| Arm | N | files | median score /6 | median tokens | tool calls | wall s |
|---|---|---|---|---|---|---|
| plain | 2 | 2 | 6 | 18547 | 10 | 73.1 |
| grace | 2 | 2 | 6 | 7981 | 5 | 27 |
| grace+mwg | 2 | 2 | 6 | 68351 | 39 | 245.1 |

Rubric: native `<dialog>`, `showModal()`, accessible name, visible close control, `prefers-reduced-motion`, no ARIA `role="dialog"` fallback.

Limitations:
- One task, static six-point rubric, small N; not a general quality benchmark.
- The grace+mwg arm used npx @latest at run time; guidance version is not pinned by the harness.
- File creation/quality depends on the agent following the write instruction; missing files score 0 and are reported.

