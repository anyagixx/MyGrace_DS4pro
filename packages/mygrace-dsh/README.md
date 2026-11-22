# MyGRACE DSH bundle — UNPUBLISHED OPTIONAL PREVIEW

> **Status in v1.1: not supported, not published, not installed by the CLI.**
> `mygrace install-dsh --bundle` was removed. `mygrace install-dsh` (the
> supported path) installs the skills + a PATH-free MCP row and, with
> `--panel`, the decorative sidebar placeholder. This package is kept as an
> optional preview for a future release decision (ROADMAP Wave 4).

## Why it is a preview

- It needs four packages that are **not published** (`@osovv/dsh-skill-mygrace`,
  `@osovv/dsh-mygrace-rtk`, `@osovv/mygrace-cli`, `mygrace-status-panel`) via
  `file:` dependencies, so `dsh plugin add` from a registry install cannot
  resolve them.
- The panel dependency is deliberately `private: true`.
- A local `dsh plugin add <this dir>` only records a `link:` and does not
  install the `file:` dependencies into the profile, so the four loader rows it
  contributes are unresolvable at boot.
- The host plugin resolves `@deepseek-ai/dsh-mcp-client` via
  `createRequire(...)`, which does not go through DSH's loader resolution in a
  profile install.

**This package is therefore marked `"private": true`** so it cannot be
published accidentally. Re-enabling it requires the Wave 4 decision: publish
all four dependency packages with real versions, declare
`@deepseek-ai/dsh-mcp-client` as a peer dependency, remove the panel's
`private` flag (or drop its row), and prove it end-to-end in a temp DSH home
with `dsh --profile web --dump-config` + a real MCP tool call.

## What it would provide (if it worked)

| Row | Plugin | What it does |
|---|---|---|
| `mygrace-host` | this package | Mounts `@deepseek-ai/dsh-mcp-client` with `bun run src/grace-mcp.ts` of `@osovv/mygrace-cli` |
| `mygrace-skills` | `@osovv/dsh-skill-mygrace` | The 15 `mygrace-*` skills in the session skill catalog |
| `mygrace-rtk` | `@osovv/dsh-mygrace-rtk` | Rewrites noisy dev commands to `rtk` (if installed on PATH) |
| `mygrace-panel` | `mygrace-status-panel` | The decorative sidebar placeholder card |

## Development-only inspection

```bash
# Read-only composition check (never proves MCP mount):
dsh --profile web --dump-config
```

Do **not** document this as a supported install path until the prerequisites
above are met.
