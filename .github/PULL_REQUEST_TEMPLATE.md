# Pull request

## Summary

<!-- What changed and why. One paragraph is enough; link the audit finding or roadmap task if there is one. -->

## Type of change

- [ ] `feat` — new capability
- [ ] `fix` — bug fix
- [ ] `docs` — documentation only
- [ ] `refactor` — no behaviour change
- [ ] `test` — tests only
- [ ] `build` / `ci` — tooling, packaging, workflows
- [ ] `perf` — performance
- [ ] breaking change (add `!` to the commit subject and describe the migration)

## Linked issue

<!-- Closes #123, or "none" for trivial changes. -->

## What changed

<!-- Bullet points. Include behaviour changes, new commands/flags/MCP tools, and anything an agent or CI sees. -->

## How it was verified

Paste the commands you ran and a one-line result per command.

```bash
bun run typecheck
bun test
bun run lint:demo
bun run validate:marketplace
bun run pack:smoke        # when packaging, src imports or templates change
```

- [ ] `bun run typecheck` is clean
- [ ] `bun test` is green, and every behaviour fix has a test that fails without it
- [ ] `bun run lint:demo` is green
- [ ] `bun run pack:smoke` is green (required for `package.json`, `src/`, `templates/` changes)
- [ ] `bun run validate:marketplace` is green (required for skills/templates/version changes)

## Code conventions (v2)

- [ ] Typed errors from `src/grace-errors.ts`; no raw `process.exit(1)` or stack traces in new code
- [ ] Project XML parsed with `src/grace-xml.ts`; no regex scraping of `docs/*.xml`
- [ ] Entity ids and paths validated through `src/grace-paths.ts`
- [ ] Layout, budgets and runner taken from `src/grace-config.ts`; no hardcoded `src/` assumptions
- [ ] Command execution is argv-only (`spawnSync(file, args)`), never a shell string, and goes through the trust model (ADR-1)
- [ ] Machine-readable output uses the `--format json` envelope `{ ok, exitCode, data, findings, meta }`

## Security review

- [ ] No new network access or telemetry
- [ ] If this touches command execution, trust records, path resolution or MCP argument handling: negative tests are included (malicious command refused, traversal id rejected)
- [ ] No secrets, tokens or private filesystem paths in code, tests, fixtures or docs

## Docs and changelog

- [ ] `CHANGELOG.md` `[Unreleased]` entry added under the right category
- [ ] User-facing docs updated: `README.md` for CLI/MCP surface, `SKILL.md` for workflow changes, `docs/architecture.md` for module/ADR changes

## Release gates (full checklist: `ROADMAP.md` §6)

Check the gates this PR actually satisfies:

- [ ] G1 packaged CLI works from a tarball (`bun run pack:smoke`)
- [ ] G2 type-safe (`bun run typecheck`)
- [ ] G4 security negatives (untrusted commands, traversal ids)
- [ ] G5 test suite green
- [ ] G8 docs validator (`validate:marketplace` today; `scripts/validate-docs.ts` lands in W1.5)
- [ ] G10 CHANGELOG + version consistent

Gates that are not mechanically available yet are tracked in `ROADMAP.md`:
G3 `mygrace ci --strict` (Wave 3), G6 MCP integration tests (W1.3), G7 dogfooding
(W2.2), G9 token metrics (W1.5), G11 200-module scale (Wave 3), G12 language
matrix (Wave 3).

**Release PR:** additionally run the complete `ROADMAP.md` §6 checklist, state
the target version, and confirm `bun run release:check`.
