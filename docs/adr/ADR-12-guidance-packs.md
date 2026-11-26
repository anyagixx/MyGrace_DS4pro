# ADR-12 — Guidance packs are an on-demand, untrusted knowledge SPI

**Status:** accepted (v3.1.0)

## Context

MyGRACE's methodology is domain-agnostic, but web/platform work benefits from
current best-practice guidance (Modern Web Guidance is one example). Loading a
large guidance corpus into every agent context contradicts MyGRACE's index-first,
bounded-read model. Forking the corpus into the repo would add a domain-specific
maintenance burden and update lag.

## Decision

1. Define a small **guidance pack** SPI with two providers in v3.1.0:
   - `local`: `guidance-pack.json` + markdown guides inside the project;
   - `cli`: a command prefix implementing `search "<query>" --json` and
     `retrieve "<id>"` (the Modern Web Guidance protocol).
2. Expose retrieval through `mygrace context guidance <query> [--id] [--pack]`
   and the existing `mygrace_context` MCP tool with `mode: "guidance"` — no new
   top-level command and no new MCP tool.
3. Local guide files must resolve inside their pack directory; traversal is
   rejected. CLI packs run only under the ADR-1 trust gate and are audited.
4. Retrieved text is printed/returned as data, never executed and never written
   into `docs/` automatically.
5. A committed `mygrace.guidance-lock.json` records local-pack SHA-256 digests and
   CLI command hashes/resolved versions. When present it is enforced
   automatically: changed/missing packs are skipped and `--check-lock` fails the
   command; `--lock` regenerates it after review.

## Consequences

- MyGRACE can pair methodology with curated domain packs without absorbing them.
- Untrusted guidance is a prompt-injection surface: agents must treat retrieved
  text as reference, not instructions, and pack versions should be pinned.
- The SPI is deliberately minimal; new protocols require an adapter, not a new
  command. The negative external-benchmark result means guidance is positioned as
  *quality input*, not a proven token/effort saver.
