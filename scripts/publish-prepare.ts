#!/usr/bin/env bun
/**
 * MyGRACE Publish Prepare
 *
 * The mygrace-dsh bundle uses `file:` deps so the local install flow
 * works. For npm publish: swap the file: deps to versioned deps of the
 * sibling packages (from their package.json versions).
 *
 * Usage:
 *   bun run scripts/publish-prepare.ts          — dry run
 *   bun run scripts/publish-prepare.ts --apply  — write packages/mygrace-dsh/package.json
 */

import { readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";

const ROOT = join(import.meta.dirname, "..");
const BUNDLE_DIR = join(ROOT, "packages", "mygrace-dsh");
const BUNDLE_PKG = join(BUNDLE_DIR, "package.json");

function main() {
  const apply = process.argv.includes("--apply");
  const pkg = JSON.parse(readFileSync(BUNDLE_PKG, "utf-8"));
  const swaps: string[] = [];
  for (const [name, spec] of Object.entries<string>(pkg.dependencies ?? {})) {
    if (!spec.startsWith("file:")) continue;
    const rel = spec.slice("file:".length);
    const depPkg = JSON.parse(readFileSync(join(dirname(BUNDLE_PKG), rel, "package.json"), "utf-8"));
    pkg.dependencies[name] = depPkg.version;
    swaps.push(`${name}: ${spec} → ${depPkg.name}@${depPkg.version}`);
  }
  if (!swaps.length) {
    console.log("publish-prepare: no file: deps found in the bundle.");
  } else if (!apply) {
    console.log("publish-prepare (dry-run) — swaps:");
    for (const s of swaps) console.log(`  ${s}`);
  } else {
    writeFileSync(BUNDLE_PKG, JSON.stringify(pkg, null, 2) + "\n");
    console.log("publish-prepare applied:");
    for (const s of swaps) console.log(`  ${s}`);
  }
}

main();
