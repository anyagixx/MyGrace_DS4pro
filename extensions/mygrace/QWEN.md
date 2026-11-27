# MyGRACE (legacy Qwen Code extension)

> This extension is a **legacy packaging** of MyGRACE. DeepSeek Harness is the
> primary platform (`mygrace install-dsh`); this file and the companion commands
> are kept for reference and are not maintained feature-for-feature.

If you use this project with Qwen Code, follow the same rules the CLI enforces:

## Navigation

- Read `docs/graph-index.xml` first (module index), then only the
  `docs/modules/M-XXX.xml` you need.
- Read `docs/plan-index.xml` before a phase file; `docs/verification-index.xml`
  before a verification file.
- Never read all entity files and never create legacy monolithic XML
  (`knowledge-graph.xml`, `development-plan.xml`, `verification-plan.xml`).

## Trust model

`<module-checks>` in `docs/verification/V-M-XXX.xml` is the canonical command
source. `mygrace test` / `mygrace verify` refuse to run those project-declared
commands unless `.mygrace/trust.json` is current (`mygrace trust` after review),
`mygrace.config.json` sets `allowCommands: true`, or you pass `--allow-commands`.
`.mygrace/` is local state and stays out of version control.

## Commands

- `mygrace ci --path .` — one-command quality gate (add `--tests` when trusted)
- `mygrace status --path .`, `mygrace lint --strict --path .`
- `mygrace module show <id> --path .`, `mygrace phase show <Phase-N> --path .`
- `mygrace trust --path .`, then `mygrace test --module <M-XXX>` / `mygrace verify --path .`
- `mygrace doctor --path .`

## Skills

The 14 shared skills live in `skills/mygrace/grace-*` and are installed as
`mygrace-*`; prefer them over re-deriving the process.

Configuration: `mygrace.config.json` (`sourceDirs`, `markupExts`, `ignoreDirs`,
`indexCaps`, `sizeBudgets`, `testRunner`, `allowCommands`, `language`).
