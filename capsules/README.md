# MyGRACE capsules (ADR-10, experimental)

Capsules compile recurring **read-only MyGRACE routines** into typed files that
an agent runs with `mygrace capsule run` instead of re-deriving the sequence:

| Capsule | Routine | Binding |
|---|---|---|
| `daily-check` | status → lint → ci → next | — |
| `after-change` | lint --changed → ci → impact → judgment (`mygrace-fix`) | — |
| `module-onboarding` | status → trace → packet → focus | `--module M-XXX` |

```bash
mygrace capsule list                 # validity + qualification state
mygrace capsule validate             # schema/allowlist/binding checks
mygrace capsule qualify after-change --fixture examples/demo-store
mygrace capsule run after-change     # stops at the judgment, prints continue id
mygrace capsule continue <run-id>    # resume after the judgment
```

Rules (enforced by `mygrace capsule validate` and the executor):

- programs are allowlisted `mygrace` CLI templates only (`status`, `lint`,
  `lint-changed`, `ci`, `next`, `impact`, `trace`, `packet`, `focus`) — never
  shell, never arbitrary commands;
- values come from explicit CLI flags (`--module`, `--files`), never from env;
- a capsule must be **qualified** (replayed on a fixture and hash-recorded in
  `.mygrace/capsules/`) before `run`; `--allow-unqualified` is development-only;
- a failed program deopts back to the capsule's `source_skill`; a judgment step
  hands control back to the agent and persists state in `.mygrace/capsules/`.

Execution is disabled by default: set `"integrations": { "capsules":
{ "enabled": true } }` in `mygrace.config.json`. `.mygrace/` stays gitignored.
