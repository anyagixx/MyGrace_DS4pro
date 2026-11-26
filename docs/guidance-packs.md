# Guidance packs (ADR-12)

MyGRACE governs *how* work is done. A **guidance pack** supplies domain
expertise — modern web platform patterns, security rules, framework conventions —
without bloating the core repository or the always-loaded context.

Packs are opt-in, retrieved on demand and treated as **untrusted text**. MyGRACE
never executes pack content and never writes it into `docs/`.

## Configure packs

```json
{
  "guidancePacks": [
    {
      "name": "web-basics",
      "enabled": "auto",
      "kind": "local",
      "path": "examples/guidance-packs/web-basics"
    },
    {
      "name": "modern-web-guidance",
      "enabled": "auto",
      "kind": "cli",
      "command": "npx -y modern-web-guidance@1.0.2",
      "timeoutMs": 30000
    }
  ]
}
```

- `kind: "local"` — a directory inside the project with `guidance-pack.json`:
  ```json
  {
    "name": "web-basics",
    "version": "1.0.0",
    "license": "MIT",
    "description": "Short domain guidance.",
    "guides": [
      {
        "id": "accessible-dialog",
        "title": "Accessible modal dialog",
        "description": "Use native <dialog> + showModal().",
        "file": "guides/accessible-dialog.md",
        "tags": ["dialog", "accessibility"]
      }
    ]
  }
  ```
  Guide files must stay inside the pack directory (traversal is rejected).
- `kind: "cli"` — a command prefix implementing the Modern Web Guidance
  protocol:
  - `"<command>" search "<query>" --json` → `[{"id","description"}, ...]`
  - `"<command>" retrieve "<id>"` → markdown text on stdout

Pin the CLI package version (`@1.0.2`, not `@latest`): MyGRACE emits `GUIDANCE_PACK_UNPINNED` for mutable specs, and the trust record covers the config. CLI packs run only when project commands are trusted (`mygrace trust`,
`allowCommands: true`, or `--allow-commands`) and every invocation is appended to
`.mygrace/audit.log`. Untrusted packs are skipped, not executed.

## Use them

```bash
mygrace context guidance "accessible dialog"
mygrace context guidance "accessible dialog" --pack web-basics
mygrace context guidance "accessible dialog" --id accessible-dialog --pack web-basics --format json
```

The MCP surface is the existing `mygrace_context` tool:

```json
{ "mode": "guidance", "query": "accessible dialog", "pack": "web-basics" }
```

## Lockfile and integrity

Commit a lockfile so a changed pack is visible and cannot silently alter what
agents retrieve:

```bash
mygrace context guidance --lock          # writes mygrace.guidance-lock.json
mygrace context guidance --check-lock "dialog"   # exit 1 on missing/mismatched packs
```

- **Local packs:** SHA-256 over every file in the pack directory; any edit is a
  `GUIDANCE_LOCK_MISMATCH` and the pack is skipped until re-locked after review.
- **CLI packs:** SHA-256 of the command plus the version reported by
  `<command> --version` at lock time; a changed command is skipped. The version
  is recorded for audit but runtime retrieval still trusts the pinned command.
- Lock enforcement is automatic when the file exists; a configured pack missing
  from the lock is treated as `lock-missing` (skipped). Re-run `--lock` after an
  intentional change and commit the lockfile.

### Signing (Ed25519)

```bash
mygrace context guidance --keygen                 # private key in .mygrace/, public key in repo root
mygrace context guidance --lock --sign            # sign the lockfile
mygrace context guidance --check-lock --require-signature "dialog"   # fail if unsigned/invalid
```

The signature covers the canonical lockfile JSON. A tampered lock is rejected and
all packs are skipped (`lock-signature-invalid`); the public key
(`mygrace.guidance.pub`) is committed, the private key stays local and gitignored.
This is local content attestation — it proves the lockfile was signed by the key
owner, not that a third-party package was published by its upstream maintainer.

## Examples and limits

- [`examples/guidance-packs/`](../examples/guidance-packs/) contains two
  original local packs used by the test suite.
- Retrieval is bounded by the pack's own CLI timeout; output is not indexed,
  cached or trusted.
- A pack is not a dependency: missing/invalid/untrusted packs are reported as
  `GUIDANCE_PACK_SKIPPED` info findings and the core gates stay green.
- This SPI is intentionally small. Request adapters for other pack protocols
  via an issue rather than adding a new top-level command.
