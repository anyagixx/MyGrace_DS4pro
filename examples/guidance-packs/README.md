# Guidance pack examples

Two local guidance packs used by MyGRACE tests and docs:

- `web-basics` — native HTML, accessible dialogs, cancellable fetch;
- `security-basics` — output encoding and secure cookies.

Enable them in `mygrace.config.json`:

```json
{
  "guidancePacks": [
    { "name": "web-basics", "kind": "local", "path": "examples/guidance-packs/web-basics", "enabled": "auto" },
    { "name": "security-basics", "kind": "local", "path": "examples/guidance-packs/security-basics", "enabled": "auto" }
  ]
}
```

Then:

```bash
mygrace context guidance "accessible dialog"
mygrace context guidance "accessible dialog" --id accessible-dialog --pack web-basics
mygrace context guidance "session" --pack security-basics
```

For Modern Web Guidance as a CLI pack:

```json
{
  "guidancePacks": [
    { "name": "modern-web-guidance", "kind": "cli", "command": "npx -y modern-web-guidance@1.0.2", "enabled": "auto" }
  ],
  "allowCommands": true
}
```

Pin the CLI package version and keep the trust record current. CLI packs require trusted project commands (`mygrace trust` or
`--allow-commands`); MyGRACE prints retrieved text only and never executes it.
