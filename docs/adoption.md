# External adoption and validation kit

MyGRACE's product claim is governance, not magic: contracts, indexes, scoped
verification and explicit trust. That claim needs external evidence, not only
self-owned benchmarks.

## Validate on a real repository (read-only)

1. Clone a real OSS project you do not own (for example `expressjs/express` or
   `psf/requests`) into a scratch directory.
2. Generate artifacts over the real layout:
   ```bash
   mygrace setup init --path /tmp/oss-project --name OSSProject
   # add module/phase/verification entities for the real source tree
   mygrace lint --strict --path /tmp/oss-project
   mygrace ci --path /tmp/oss-project
   ```
3. Run the benchmark harnesses:
   ```bash
   DEEPSEEK_API_KEY=... bun run scripts/external-benchmark.ts --reps 2
   DEEPSEEK_API_KEY=... bun run scripts/web-quality-benchmark.ts --tasks dialog --reps 10 --runtime
   ```
4. Record results and limitations in an issue using the "Adoption report"
   template.

## Current evidence (v3.6.0)

- CLI on real OSS: 105–237 ms / 65–83 MB (express, requests); see
  `analysis/external-benchmark.md`.
- Artifact quality: N=10 per arm on the dialog task with Chromium runtime
  checks — plain 96%, MyGRACE 94%, MWG 79% static; runtime 3/3 all arms.
  MyGRACE used fewer tokens/tools than plain; MWG was more expensive. See
  `analysis/web-quality-benchmark.md`.
- No external production user has adopted MyGRACE yet. Until one does, claims are
  limited to measured benchmarks and reproducible gates — do not present them as
  market validation.

## What to report

- repository/commit, language, size;
- commands run and timings;
- lint/CI findings (coded);
- whether artifacts were generated or hand-curated;
- trust/security observations and any blockers.
