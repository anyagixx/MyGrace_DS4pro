# Demo Store (MyGRACE example)

A three-module, real-logic example project that MyGRACE is dogfooded on:

- `src/money` — parse/format amounts as integer cents, with validation.
- `src/catalog` — validated product catalog and product lookup.
- `src/cart` — validated cart composition and exact totals.

Generated deterministically by `scripts/gen-example.ts`; do not edit the
generated files by hand — change the generator instead and regenerate.

## Verify

```bash
cd examples/demo-store
bun test
bun run ../../src/grace.ts lint --path .
bun run ../../src/grace.ts measure  # not a command; use scripts/measure-context.ts from the repo root
```
