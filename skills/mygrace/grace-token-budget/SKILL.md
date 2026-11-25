---
name: mygrace-token-budget
description: "Keep agent context affordable on the output side: prefer compact MyGRACE commands and MCP reads, route noisy commands through optional rtk, compress memory files only when needed. Use when tests/logs are noisy, docs are large, or the agent reads too much."
whenToUse: "Verbose command output, large memory files, or repeated large reads are burning context."
---

# Token budget (output side)

MyGRACE reduces structural context (indexes first, bounded entity reads). This
skill covers what agents read and print.

## 1. Prefer the compact MyGRACE paths (built in)

- `mygrace status --format json` / `mygrace context-cost --path <root>` — small, bounded summaries.
- `mygrace module show <id> --path <root>` instead of reading raw entity XML.
- `mygrace test --module <M-XXX> --compact --path <root>` — failures + summary only (trust-gated).
- `mygrace verify --module <M-XXX> --path <root>` — digest; details go to `.mygrace/last-failures.md`.
- `mygrace packet <M-XXX>` — one self-contained worker prompt instead of several reads.
- Use the MCP tools when connected (`mygrace_status`, `mygrace_lint`,
  `mygrace_test`, …): same output, no shell noise, schema-validated arguments.

## 2. Noisy shell commands (optional rtk)

If `rtk` (https://github.com/rtk-ai/rtk) is installed and wired, use it for
noisy dev commands (`git status`, `bun test`, builds, linters):
`rtk <cmd>` filters output before it reaches the context; `rtk bypass <cmd>` runs
unfiltered. rtk is a third-party tool — if it is not installed, skip this
section; never depend on it.

The `dsh-mygrace-rtk` DSH middleware that rewrites commands automatically
ships only inside the unpublished preview bundle; do not assume it is active.

## 3. Large memory files (Caveman, optional)

If the Caveman skills are installed (`/caveman-compress`), compress large memory
files such as `AGENTS.md`. Caveats: the file's text is sent to the configured
model provider, and a human-readable `*.original.md` backup is kept. **Never
compress MyGRACE indexes or entity contracts** — they are the source of truth.

## 4. Large web pages

If the `caveman` CLI is installed, `caveman browse <url>` returns a compressed
page. Treat the compression as lossy; fetch the full page when exact text matters.

## 5. Never

- Never compress `docs/graph-index.xml`, `docs/plan-index.xml`,
  `docs/verification-index.xml`, module or verification files.
- Never replace an available MCP call with raw file scans — use the tool.
- Never paste whole test logs or entity trees into the conversation; use
  `--compact`, `mygrace packet` or a scoped read.
- Do not present estimates or line counts as "tokens"; this project does not use
  a tokenizer (see `scripts/measure-context.ts` for the documented line/byte
  model).
