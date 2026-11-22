---
name: mygrace-init
description: "Bootstrap the MyGRACE project structure (docs/ indexes, per-entity dirs, AGENTS.md, mygrace.config.json) for a new project. Use once per project, before planning starts."
whenToUse: "A new project needs MyGRACE scaffolding before the plan/verification/execute skills run."
---

# Initialize a MyGRACE project

## Fast path (non-interactive)

```
mygrace init-dsh --path . --name <ProjectName> [--keywords k1,k2]   [--annotation "one line"] [--language typescript] [--runtime bun]   [--framework <name>] [--testRunner "bun test"] [--force]
```

It creates `docs/{modules,plans,verification,archive}`, the three index files,
`requirements.xml`, `technology.xml`, `operational-packets.xml`, `AGENTS.md`,
and **`mygrace.config.json`** with the effective defaults. Existing files are
skipped unless `--force` is passed.

## Then

1. Review `mygrace.config.json` (`sourceDirs`, `markupExts`, `ignoreDirs`,
   `indexCaps`, `sizeBudgets`, `testRunner`, `allowCommands`, `language`). A list
   you set replaces the default entirely (polyglot: enumerate all extensions);
   `testRunner` is only the fallback when no `<module-checks>` is declared.
2. Fill `docs/requirements.xml` (at least one use case) and
   `docs/technology.xml`.
3. Confirm the scaffold: `mygrace lint --strict --path .` (empty indexes should
   pass) and `mygrace status --path .`.
4. Continue with the `mygrace-plan` skill, then `mygrace-verification` and
   `mygrace-execute`.

## Rules

- Never create legacy monolithic `knowledge-graph.xml`, `development-plan.xml`
  or `verification-plan.xml`.
- Module data lives in `docs/modules/M-XXX.xml`, phases in
  `docs/plans/Phase-N.xml`, verification in `docs/verification/V-M-XXX.xml`.
- `AGENTS.md` is auto-loaded by DeepSeek Harness; keep it current (the template
  ships with `init-dsh`).
- This distribution is DSH-first; other platform files in the repository
  (`rules/`, `plugins/`, legacy `extensions/`) are reference material, not part
  of project scaffolding.
- Keep `.mygrace/` out of git — the trust record is local state.
