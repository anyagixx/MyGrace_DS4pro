#!/usr/bin/env bun
/**
 * MyGRACE Verify Command
 *
 * Verification loop entry point: scoped module tests with a compact digest.
 *   mygrace verify [--module M-AUTH] [--all]
 *
 * Uses mygrace test's runner (scope from verification files, compact output).
 * On failures, full outputs are written to .mygrace/last-failures.md.
 * Exit code 1 when anything failed (for agent loops).
 */

import { defineCommand } from "citty";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { findProjectRoot, readIndexFile } from "./grace-common";
import { runModuleTests } from "./grace-test";

export const verifyCommand = defineCommand({
  meta: { name: "verify", description: "Scoped module tests with a compact digest; writes .mygrace/last-failures.md on failure (exit 1)" },
  args: {
    module: { type: "string", description: "Module ID (e.g. M-AUTH); omit = all modules" },
    all: { type: "boolean", default: false, description: "Run every module in graph-index.xml (default)" },
    path: { type: "string", default: ".", description: "Project root" },
  },
  run: async ({ args }) => {
    const root = findProjectRoot(args.path);
    const modules = args.module ? [args.module] : readIndexFile(join(root, "docs", "graph-index.xml")).map((e) => e.tag);
    const failures: string[] = [];
    const digestLines: string[] = [];
    for (const id of modules) {
      const r = runModuleTests(root, id, true);
      if (r.ok) continue;
      failures.push(id);
      digestLines.push(`=== ${id} — FAILED ===`);
      if (r.output) digestLines.push(r.output);
    }
    if (failures.length > 0) {
      const dir = join(root, ".mygrace");
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "last-failures.md"), digestLines.join("\n\n") + "\n");
    }
    for (const l of digestLines) console.log(l);
    console.log(
      failures.length > 0
        ? `Verify: ${modules.length - failures.length} ok, ${failures.length} failed — see .mygrace/last-failures.md`
        : `Verify: ${modules.length} ok`
    );
    process.exit(failures.length > 0 ? 1 : 0);
  },
});
