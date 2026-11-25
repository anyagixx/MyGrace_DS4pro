---
name: mygrace-ask
description: "Answer questions about the current MyGRACE project using lazy index navigation (index first, entities on demand, source only when needed). Use when the user asks what a module does, where something lives, or how artifacts relate."
whenToUse: "The user asks a question about project structure, modules, phases, verification, or code location."
---

# Answer a question about this project

## 1. Load the index only

Read `docs/graph-index.xml` (≤100 lines) — or use the MCP tool
`mygrace_find_modules` when connected. It tells you every module that exists.
Do not read all module files; do not look for legacy monolithic
`knowledge-graph.xml` (it does not exist in MyGRACE projects).

## 2. Identify candidates

From the index, match on `NAME`, `TYPE`, `PATH`, `DEPENDS`. Note module ids
(e.g. `M-AUTH`). If the question is about planning or verification, read only
`docs/plan-index.xml` / `docs/verification-index.xml` respectively.

## 3. Read one entity at a time

- `docs/modules/M-XXX.xml` (30–80 lines) for the contract.
- `docs/verification/V-M-XXX.xml` (20–60 lines) if the question is about
  behaviour/testing.
- Never read unrelated modules.

## 4. Use the CLI/MCP for structured reads

- `mygrace inspect module find <query> --path <root>` — resolve ids by name/path/type/status/dependency
- `mygrace inspect module show <id> --path <root>` — structured module view
- `mygrace inspect module show <id> --with-verification --path <root>` — plus its verification file
- `mygrace inspect phase show <Phase-N> --path <root>`, `mygrace inspect verification index --path <root>`
- `mygrace inspect file show <path> --root <root> --contracts --blocks` — file-local markup

Prefer the MCP equivalents (`mygrace_find_modules`, `mygrace_show_module`,
`mygrace_show_phase`, `mygrace_show_file`) when connected.

## 5. Code only if needed

Use the `PATH` from the index; read the `MODULE_CONTRACT` and the relevant
`START_BLOCK_*` section. Do not scan the repository.

## 6. Answer with evidence

Cite the files you used. If the artifacts do not answer the question, say so and
suggest the skill that would create/update them (`mygrace-plan`,
`mygrace-verification`, `mygrace-refresh`). Never invent module behaviour —
quote the contract or the code.
