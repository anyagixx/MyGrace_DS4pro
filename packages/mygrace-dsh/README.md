# MyGRACE DSH Bundle

The full MyGRACE project — MCP server, 14 skills, status panel — as a single DeepSeek Harness bundle.

## Install (dev/in-repo)

```bash
DSH_HOME=~/.dsh dsh plugin --profile web add "$PWD/packages/mygrace-dsh"
```

Install with the MyGRACE CLI helper (equivalent; resolves the same paths):

```bash
bun run src/grace.ts install-dsh --bundle
```

## Uninstall

```bash
DSH_HOME=~/.dsh dsh plugin --profile web remove @osovv/mygrace-dsh
```

## What the bundle provides

| Row | Plugin | What it does |
|---|---|---|
| `mygrace-host` | this package | Mounts `@deepseek-ai/dsh-mcp-client` with `bun run src/grace-mcp.ts` of `@osovv/mygrace-cli` — the `mygrace_*` MCP tools become available |
| `mygrace-skills` | `@osovv/dsh-skill-mygrace` | The 15 `mygrace-*` skills appear in the session skill catalog |
| `mygrace-rtk` | `@osovv/dsh-mygrace-rtk` | Rewrites noisy dev commands to `rtk` (token saver, if installed on PATH) |
| `mygrace-panel` | `mygrace-status-panel` | The MyGRACE card registers in the DSH web sidebar (`sidebar.footer.action`) |

Note: the bundle needs `bun` on PATH (the MCP server runs TS via `bun run`).

## Notes

- When publishing: swap `file:` deps to versioned deps (`@osovv/mygrace-cli: "1.0.1"`, etc.).
