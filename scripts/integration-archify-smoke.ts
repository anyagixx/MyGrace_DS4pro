#!/usr/bin/env bun
/**
 * MyGRACE — Archify adapter contract smoke test (release gate G14, ADR-9).
 *
 * Proves the real `mygrace diagram --format html` path against a real Archify
 * CLI: IR validation, HTML delivery, receipt contents and the `--check` gate on
 * the committed IR. Without `MYGRACE_ARCHIFY_BIN` (or an `archify` executable on
 * PATH) the script prints a skip notice and exits 0, so it stays optional.
 *
 * Usage:
 *   MYGRACE_ARCHIFY_BIN=/path/to/archify/bin/archify.mjs bun run test:integrations:archify
 *   MYGRACE_ARCHIFY_BIN=… bun run test:integrations:archify --json
 */

import { existsSync, readFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { findExecutableOnPath } from "../src/grace-integrations";

const ROOT = resolve(import.meta.dir, "..");
const args = process.argv.slice(2);
const wantsJson = args.includes("--json");
const SMOKE_BASE = "docs/diagrams/smoke-architecture";

function report(ok: boolean, message: string, data: Record<string, unknown> = {}): never {
  cleanup();
  if (wantsJson) console.log(JSON.stringify({ ok, message, ...data }, null, 2));
  else console.log(`${ok ? "✓" : "✗"} ${message}`);
  process.exit(ok ? 0 : 1);
}

function cleanup(): void {
  for (const suffix of [".json", ".html", ".receipt.json", ".delivery.json"]) {
    rmSync(join(ROOT, `${SMOKE_BASE}${suffix}`), { force: true });
  }
}

const configured = process.env.MYGRACE_ARCHIFY_BIN?.trim();
const bin = configured !== undefined && configured !== "" ? configured : findExecutableOnPath("archify");
if (bin === null) {
  report(true, "SKIP: Archify is not configured; set MYGRACE_ARCHIFY_BIN to run the smoke.", { skipped: true });
}

function runCli(argv: string[]): { exit: number; stdout: string; stderr: string } {
  const result = Bun.spawnSync(["bun", "run", join(ROOT, "src", "grace.ts"), ...argv], {
    cwd: ROOT,
    env: { ...process.env, MYGRACE_ARCHIFY_BIN: bin as string },
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    exit: result.exitCode ?? 1,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
  };
}

cleanup();
try {
  const render = runCli(["diagram", "--format", "html", "--out", `${SMOKE_BASE}.html`]);
  if (render.exit !== 0) {
    report(false, `diagram --format html failed against Archify: ${render.stderr.trim() || render.stdout.trim()}`, { bin });
  }
  const artifacts = [".json", ".html", ".receipt.json"].map((suffix) => `${SMOKE_BASE}${suffix}`);
  const missing = artifacts.filter((file) => !existsSync(join(ROOT, file)));
  if (missing.length > 0) report(false, `missing artifacts: ${missing.join(", ")}`, { bin });
  const receipt = JSON.parse(readFileSync(join(ROOT, `${SMOKE_BASE}.receipt.json`), "utf-8")) as {
    graph?: { modules?: number; dependencies?: { declared?: number; depicted?: number } };
    archify?: { validation?: string };
  };
  if (receipt.archify?.validation !== "passed") report(false, "receipt does not record a passed Archify validation", { bin });

  const committedCheck = runCli(["diagram", "--check"]);
  if (committedCheck.exit !== 0) {
    report(false, `committed diagram IR is stale; run \`mygrace diagram --format html\`:\n${committedCheck.stdout}`, { bin });
  }

  report(true, "Archify adapter smoke passed (validate → deliver → receipt → committed IR current).", {
    bin,
    stdout: render.stdout.trim(),
    graph: receipt.graph,
    validation: receipt.archify?.validation,
  });
} finally {
  cleanup();
}
