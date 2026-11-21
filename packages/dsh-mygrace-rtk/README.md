# @osovv/dsh-mygrace-rtk

DSH tool-middleware plugin: prefixes noisy dev commands with `rtk` (token saver).

Wraps the `bash` tool via DSH's `tools/execute` around-dispatch hook: `git status` → `rtk git status`.

- Pass-through when `rtk` is not on PATH or the command doesn't match.
- Installed as part of the `@osovv/mygrace-dsh` bundle; row: `mygrace-rtk`.
- Install/remove `rtk` (https://github.com/rtk-ai/rtk) to activate; install RTK first, then restart the session.

Config via the cordis row: `config.enabled: false` disables; `config.rtkName` overrides the prefix (e.g. `./rtk`).
