# MyGRACE Demo Store

A deliberately small but real example project used to dogfood MyGRACE on
DeepSeek Harness. It has three modules with actual logic and failure tests:

- **M-MONEY** (`src/money`) — integer-cent money parsing/formatting.
- **M-CATALOG** (`src/catalog`) — validated product catalog.
- **M-CART** (`src/cart`) — cart composition of the two modules.

Navigate index-first:

1. `docs/graph-index.xml` — modules and their contracts.
2. `docs/modules/M-XXX.xml` — per-module contract + annotations.
3. `docs/verification/V-M-XXX.xml` — test files, module-checks, scenarios.

Run the demo tests from this directory with `bun test` (its own bunfig.toml
scopes discovery to this project). Lint it with
`bun run ../../src/grace.ts lint --path .` or, from the repository root,
`bun run lint:demo`.
