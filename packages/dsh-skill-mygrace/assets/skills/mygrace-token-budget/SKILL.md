---
name: mygrace-token-budget
description: "Use when minimizing LLM token consumption: route noisy commands to rtk, use compact MyGRACE reads, compress memory files, read web pages compressed. MyGRACE reduces structural context; this skill covers the output side."
whenToUse: "Tests, logs, git status, or build output are noisy; AGENTS.md or docs are large; need to read a web page; want cheaper agent output. Before any verbose read or noisy command."
---

# Token Budget — output-side policy

MyGRACE already minimizes structural context (indexes first, lazy navigation). This skill covers the output side: keep reading and writing cheap — without losing truth.

## 1. Noisy commands — `rtk` (installed by the `mygrace-dsh` bundle via `@osovv/dsh-mygrace-rtk`)
If `rtk` is on PATH (the bundle plugin rewrites `git status`, `bun test`, `npm run build`, `eslint`, … automatically — check with `rtk gain`), prefer the DSH `bash` tool for: test runs, builds, lint, logs, git status/diff/log, ls/grep/find.
If the plugin is not active, use `rtk <cmd>` explicitly for the same effect.
- `rtk bypass <cmd>` — run a command unfiltered.
- Never let `rtk` break the prompt cache — it filters once, before the conversation.

## 2. Compact MyGRACE reads — built in
- `mygrace test --module M-XXX --compact` — run only this module's tests, compact output
- `mygrace verify [--module M-XXX]` — scoped tests, compact digest; `.mygrace/last-failures.md` on failure
- `mygrace packet M-XXX` — self-contained worker prompt (contract + verification + deps)
- `mygrace focus M-XXX` — minimal working set
- `mygrace context-cost` — context budget per operation in lines
- `mygrace doctor` — health checks

## 3. Big memory files (AGENTS.md, CLAUDE.md) — Caveman
If Caveman is installed (`/caveman-compress` skill available; `caveman` CLI with `npx @caveman-ai/cli` or `caveman`/`cave` on PATH):
- Compress with the agent command `/caveman-compress <file>` — e.g. AGENTS.md — human-readable backup is saved (`<file>.original.md`).
- **Caveat:** `/caveman-compress` sends the file's text to the configured model provider.
- Never compress MyGRACE indexes or module contracts — the indexes are the truth.
- (Voice: install the voice skills — `/caveman`, `/ultracave`, `/megacave` — e.g. `npx skills add JuliusBrussee/caveman -g` into `~/.dsh/skills`.)

## 4. Web reads
If the `caveman` CLI is installed: `caveman browse <url>` — compressed page (121 tokens vs 15,704 for a 200-row table).

## 5. Never
- Compress MyGRACE index files (`docs/*.xml`) — they are the source of truth.
- Replace a `mygrace_*` MCP call with raw file reads when the MCP server is connected — the MCP tools are the token-efficient path.
