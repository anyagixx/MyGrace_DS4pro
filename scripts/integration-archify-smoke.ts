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
const KINDS = ["architecture", "tree", "workflow"] as const;

function report(ok: boolean, message: string, data: Record<string, unknown> = {}): never {
  cleanup();
  if (wantsJson) console.log(JSON.stringify({ ok, message, ...data }, null, 2));
  else console.log(`${ok ? "✓" : "✗"} ${message}`);
  process.exit(ok ? 0 : 1);
}

function smokeBase(kind: string): string {
  return `docs/diagrams/smoke-${kind}`;
}

function cleanup(): void {
  for (const kind of KINDS) {
    for (const suffix of [".json", ".html", ".receipt.json", ".delivery.json"]) {
      rmSync(join(ROOT, `${smokeBase(kind)}${suffix}`), { force: true });
    }
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
  const receipts: Record<string, unknown> = {};
  for (const kind of KINDS) {
    const base = smokeBase(kind);
    const render = runCli(["diagram", "--kind", kind, "--format", "html", "--out", `${base}.html`]);
    if (render.exit !== 0) {
      report(false, `diagram --kind ${kind} --format html failed against Archify: ${render.stderr.trim() || render.stdout.trim()}`, { bin, kind });
    }
    const missing = [".json", ".html", ".receipt.json"].filter((suffix) => !existsSync(join(ROOT, `${base}${suffix}`)));
    if (missing.length > 0) report(false, `${kind}: missing artifacts: ${missing.join(", ")}`, { bin, kind });
    const receipt = JSON.parse(readFileSync(join(ROOT, `${base}.receipt.json`), "utf-8")) as {
      kind?: string;
      graph?: { modules?: number };
      archify?: { validation?: string };
    };
    if (receipt.kind !== kind) report(false, `${kind}: receipt kind mismatch (${String(receipt.kind)})`, { bin });
    if (receipt.archify?.validation !== "passed") report(false, `${kind}: receipt does not record a passed Archify validation`, { bin, kind });
    receipts[kind] = { kind: receipt.kind, graph: receipt.graph, validation: receipt.archify?.validation };
  }

  const committedCheck = runCli(["diagram", "--check"]);
  if (committedCheck.exit !== 0) {
    report(false, `committed diagram IRs are stale; run the matching \`mygrace diagram --kind <kind> --format html\`:\n${committedCheck.stdout}`, { bin });
  }

  report(true, "Archify adapter smoke passed for architecture/tree/workflow (validate → deliver → receipts → committed IRs current).", {
    bin,
    receipts,
  });
} finally {
  cleanup();
}
