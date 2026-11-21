#!/usr/bin/env bun
/**
 * MyGRACE Test Command
 *
 * Scoped module test runs for MyGRACE projects:
 *   mygrace test --module M-AUTH [--compact]  — run one module's tests
 *   mygrace test [--compact]                 — run every module's tests (default)
 *
 * Scope comes from docs/verification/V-M-XXX.xml <test-files>; the run command
 * comes from docs/modules/M-XXX.xml <module-checks> (default: `bun test`).
 */

import { defineCommand } from "citty";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { findProjectRoot, readFileOrNull, readIndexFile } from "./grace-common";

export interface ModuleTestResult {
  module: string;
  ok: boolean;
  files: string[];
  output: string;
}

export function parseTestFiles(content: string | null): string[] {
  return (content?.match(/<file>([^<]+)<\/file>/g) || [])
    .map((m) => m.slice("<file>".length, -"</file>".length).trim())
    .filter(Boolean);
}

export function parseCheckCommand(moduleContent: string): string {
  const m = moduleContent.match(/<module-checks>([\s\S]*?)<\/module-checks>/);
  if (!m) return "bun test";
  const first = m[1].match(/<check-\d+>([^<]*)<\/check-\d+>/);
  return (first?.[1] || "").trim() || "bun test";
}

/**
 * Compact test output: keep the summary lines and failure details,
 * drop blank lines and passing-test chatter. Best effort; on no matches
 * falls back to the first lines of the raw output.
 */
export function compactOutput(out: string): string {
  const lines = out.replace(/\u001b\[[\d;]*m/g, "").split("\n");
  const keep = new Set<string>();
  for (const line of lines) {
    const t = line.trim();
    if (!t) continue;
    if (/^Ran \d+ tests/.test(t)) {
      keep.add(t);
    } else if (/^\d+ (pass|fail|error)\s*$/.test(t)) {
      keep.add(t);
    } else if (/\b(fail|error|✗|✘)\b/i.test(t)) {
      keep.add(line.replace(/\s+$/, ""));
    }
  }
  const kept = [...keep].filter((l) => l.trim() !== "");
  if (kept.length === 0) return lines.map((l) => l.trim()).filter(Boolean).slice(0, 5).join("\n");
  return kept.join("\n");
}

export function runModuleTests(root: string, moduleId: string, compact = false): ModuleTestResult {
  const moduleContent = readFileOrNull(join(root, "docs", "modules", `${moduleId}.xml`));
  if (!moduleContent) {
    return { module: moduleId, ok: false, files: [], output: `Error: docs/modules/${moduleId}.xml not found.` };
  }
  const files = parseTestFiles(readFileOrNull(join(root, "docs", "verification", `V-${moduleId}.xml`)));
  if (files.length === 0) {
    return {
      module: moduleId,
      ok: false,
      files,
      output: `Error: no <test-files> in V-${moduleId}.xml — run the mygrace-verification skill to define tests.`,
    };
  }
  const cmd = parseCheckCommand(moduleContent);
  const [file, ...rest] = cmd.split(" ").filter(Boolean);
  const result = spawnSync(file, [...rest, ...files], { cwd: root, encoding: "utf-8" });
  const out = ((result.stdout ?? "") + (result.stderr ?? "")).trim();
  return { module: moduleId, ok: result.status === 0, files, output: compact ? compactOutput(out) : out };
}

export const testCommand = defineCommand({
  meta: { name: "test", description: "Run module tests scoped from verification files (bun test by default)" },
  args: {
    module: { type: "string", description: "Module ID (e.g. M-AUTH); omit = all modules" },
    compact: { type: "boolean", default: false, description: "Print only failures and the summary" },
    path: { type: "string", default: ".", description: "Project root" },
  },
  run: async ({ args }) => {
    const root = findProjectRoot(args.path);
    const modules = args.module ? [args.module] : readIndexFile(join(root, "docs", "graph-index.xml")).map((e) => e.tag);
    let failed = 0;
    for (const id of modules) {
      const r = runModuleTests(root, id, args.compact === true);
      console.log(`=== ${id} ===`);
      console.log(`files: ${r.files.join(", ") || "(none)"}`);
      if (r.output) console.log(r.output);
      if (!r.ok) failed++;
      console.log();
    }
    console.log(`Summary: ${modules.length} module(s), ${failed} failed`);
    if (failed > 0) process.exit(1);
  },
});
