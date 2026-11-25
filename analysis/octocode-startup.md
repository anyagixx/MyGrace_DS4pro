# Octocode MCP startup investigation (2026-11-25)

Status: **root cause found, graph mode verified against the real binary**.
Related: ADR-9, M-CODE-GRAPH, `FOLLOWUP-PLAN.md` track B.

## Symptom (v1.4.0–v1.7.0)

`octocode mcp --path <root>` never answered the MCP `initialize` request on the
dev host (Linux x86_64, CachyOS). `--version`/`--help` worked; the process
appeared idle (`wait_woken`), with no child processes, and a clean `HOME`/`XDG`
did not help. This was documented as an upstream limitation and the adapter was
tested against recorded payloads + a fake MCP server.

## Root cause

Octocode initialises its local FastEmbed embedding provider **before** it starts
answering MCP. The default code model is
`fastembed:jinaai/jina-embeddings-v2-base-code`, whose `onnx/model.onnx` is
**641,517,466 bytes (~612 MB)** on HuggingFace. The binary downloads/validates
that file first, and on this network the HuggingFace Xet CDN is very slow
(~76 KB/s measured), so the handshake is delayed for hours — it looks like a
hang, not a protocol bug.

Evidence:

- `strace -f` during `initialize`: one HTTPS connection, then all threads blocked
  in `epoll_wait`/`futex` waiting on the download.
- Proxy-blackhole test (`HTTPS_PROXY=http://127.0.0.1:9`) fails fast with
  `Failed to initialize FastEmbed model ... Failed to retrieve model file
  'onnx/model.onnx' ... Connection refused` — confirming the startup dependency.
- Cache state: `~/.cache/octolib/huggingface/models--jinaai--jina-embeddings-v2-base-code/blobs/<sha>.part`
  was 116 MB after ~20 h of a stalled download (full file is 612 MB).
- Octocode's HF mirror endpoint (`HF_ENDPOINT=https://hf-mirror.com`) fails with
  `Header etag is missing`; it cannot satisfy the hf-hub cache protocol.
- With a warm cache the MCP handshake takes **~2.1 s**.

## Resolution (applied locally)

1. Backed up the config migrated by Octocode 0.30
   (`config.toml.v4.<ts>.bak`) and restored the v3 backup, because the pinned
   adapter supports 0.29.x only (`configuration version 4 is newer than ...
  supports (3)`).
2. Configured two small FastEmbed models (~215 MB total):
   `fastembed:Qdrant/bge-small-en-v1.5-onnx-Q` (code) and
   `fastembed:Xenova/all-MiniLM-L6-v2` (text); copied the once-downloaded cache
   into `~/.cache/octolib`.
3. Verified the real binary end-to-end:
   - MCP `initialize` + `tools/list` in ~2.1 s;
   - `mygrace trace M-CODE-GRAPH --code` → 8/9 MODULE_MAP symbols resolved;
   - `mygrace impact --files src/grace-code-graph.ts --code-graph` → 4 real
     module import edges.

## Adapter API fixes found by the real session

- `graphrag` requires `node_id` (not `file`) and `format:"json"`; returns an
  array of relations (`relation_type: "imports"`, `contains`, ...).
- `view_signatures` returns **plain text file content**, not JSON; the adapter
  now uses `graphrag` `{operation:"search", format:"json"}` instead and parses
  `source_file.symbols` inventories plus symbol-node kinds.

## Remaining risks / recommendations

- First use on a fresh machine still downloads hundreds of MB; treat the first
  MCP start as a provisioning step (README setup section).
- Octocode 0.30 migrates the config to v4 and breaks 0.29.x. The adapter pin is
  `>=0.29 <0.30`; re-test and widen only after validating 0.30 MCP with the same
  warm-cache recipe.
- The ~612 MB default model is a poor default for agent tooling; recommending a
  smaller quantized FastEmbed model is the practical workaround.
- Optional upstream issue: "MCP server blocks on embedding-model download before
  answering initialize; no progress output/timeout" — repro and evidence are in
  this document. Not required for MyGRACE (documented + configurable), but would
  help other integrators.
