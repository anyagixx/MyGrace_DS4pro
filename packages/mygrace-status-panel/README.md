# mygrace-status-panel — LIVE MyGRACE status card for the DSH web sidebar

A real, data-backed sidebar card for the DeepSeek Harness Web GUI. It shows the
current project's module/phase/verification counts, lint badges, the ADR-1
trust verdict ("trusted"/"untrusted") and a freshness timestamp, and refreshes
itself every 30 s and when the tab becomes visible again.

- **Data source:** one `mygrace status --format json` call per HTTP request.
  The panel does not parse `docs/` itself; `mygrace` stays the single source of
  truth.
- **Opt-in, private, unpublished:** installed only by
  `mygrace install-dsh --panel`; `private: true` keeps it off npm.
- **Never breaks the GUI:** a missing route (404), a dead CLI, a timeout, or a
  `{ok:false}` payload all render as a compact
  "MyGRACE: not connected — <reason>" line.

## How it works (DSH 0.2.x integration)

```
browser card (lib/client.js)                     host plugin (lib/index.js)
fetch("api/mygrace.status")  ───────────────▶  GET /api/mygrace.status
  every 30 s + on visibilitychange               connection.fetch.register({...})
                                                    │ buildStatusPayload()
                                                    ▼
                                        spawn (MYGRACE_BIN │
                                          $DSH_HOME/mygrace/bin/mygrace)
                                        "status --path <root> --format json"
                                                    │
                                                    ▼
                                        200 JSON, cache-control: no-store
```

- **Host route:** `GET /api/mygrace.status` registered via
  `ctx.connection.fetch.register({ path, methods: ["GET"],
  requestBody: "buffered", fetch })` — the same API DSH's own host plugins use
  (`dsh-client-ui-deliverables/lib/index.js`,
  `dsh-client-connection/lib/types/rpc.d.ts`). The route is disposed with the
  plugin through `ctx.effect`.
- **CLI resolution (no PATH-only fallback):**
  1. `MYGRACE_BIN` (absolute path to the CLI launcher/wrapper), else
  2. `$DSH_HOME/mygrace/bin/mygrace` — the launcher written by
     `mygrace install-dsh`, else
  3. `{ok:false, error}` telling the user to run `mygrace install-dsh`.
- **Project root resolution:** validated `?path=<absolute>` query → validated
  `MYGRACE_PROJECT_ROOT` env var → walk up from the harness process cwd to
  `docs/graph-index.xml`.
- **Timeout:** 5 s per `mygrace status` call. The request's `AbortSignal` is
  forwarded and aborts the subprocess.
- **Caching:** none — every response carries `cache-control: no-store`.

## Payload schema (`GET /api/mygrace.status`)

Success (`200`, `ok: true`):

```jsonc
{
  "ok": true,
  "project": "/abs/path/to/project",
  "modules":       { "total": 3, "byStatus": { "done": 3 } },
  "phases":        { "total": 2, "byStatus": { "done": 2 } },
  "verifications": { "total": 3, "byPriority": { "high": 3 }, "byStatus": { "done": 3 } },
  "lint":          { "errors": 0, "warnings": 0 },
  "trust":         { "authorized": true, "via": "config" | "trust" | null },
  "generatedAt":   "2026-11-22T12:00:00.000Z",
  "durationMs":    42
}
```

Failure (`200`, `ok: false` — never thrown, never a 5xx):

```jsonc
{
  "ok": false,
  "project": "/abs/path/to/project" | null,
  "trust": null,
  "generatedAt": "2026-11-22T12:00:00.000Z",
  "error": "No MyGRACE project found: pass ?path=… / set MYGRACE_PROJECT_ROOT / start inside a project."
}
```

Failure matrix verified by `test/grace-panel.test.ts`:

| Situation | `error` contains |
|---|---|
| no project (query/env/cwd) | `No MyGRACE project found` / `No MyGRACE project at …` |
| CLI not installed / missing launcher | `MyGRACE CLI not found: set MYGRACE_BIN` |
| `MYGRACE_BIN` points to a missing file | `MYGRACE_BIN points to a missing executable` |
| CLI spawn fails (ENOENT/EACCES) | `was not found or is not executable` |
| CLI exceeds 5 s | `timed out after 5000 ms` |
| CLI prints non-JSON | `returned invalid JSON` |
| CLI JSON envelope has no usable `data` | `unexpected shape` (or `no data object`) |
| request aborted | `aborted` |

## Install / uninstall

```bash
mygrace install-dsh --panel            # opt-in: skills + MCP row + LIVE card
mygrace install-dsh --panel --dry-run  # plan only, writes nothing
mygrace install-dsh --uninstall        # removes the card row + profile dependency
```

Prerequisites:

- a DeepSeek Harness **web** profile (`--profile web`, the default) that has
  been booted once so `profiles/<profile>/cordis.patch.yml` exists;
- a working package manager for the profile (`dsh plugin` or `pnpm`) so the
  package can be linked into the profile;
- the MyGRACE CLI launcher from `install-dsh` (or an explicit `MYGRACE_BIN`).

The card is opt-in on purpose: the CLI, skills and MCP row are independent of
it, and a broken package manager must not silently degrade a default install.

## Verification status

- **Verified in-repo:** the data builder (`lib/status-payload.js`) is covered by
  `test/grace-panel.test.ts` (success payload + the full failure matrix above);
  the host route registration shape is unit-tested against a fake context and
  cross-checked with DSH's `connection.fetch.register` types; the profile row
  composes in `dsh --profile web --dump-config`; the browser bundle passes
  `node --check`.
- **Not verified without a live `dsh web`:** an actual browser round-trip
  (route reachable from the page origin, slot rendering, 30 s refresh). The
  route/format follows DSH's own plugins and the payload is plain JSON, but a
  human should confirm once in a running GUI.

## Files

| File | Purpose |
|---|---|
| `lib/index.js` | host plugin: registers/disposes `GET /api/mygrace.status` |
| `lib/status-payload.js` | pure data layer: project discovery, CLI runner, status parsing, trust observation |
| `lib/client.js` | browser bundle: polling live card in `sidebar.footer.action` |
| `cordis.patch.yml` | loader row used by `dsh plugin add` / doubles as documentation |
