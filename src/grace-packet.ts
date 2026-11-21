#!/usr/bin/env bun
/**
 * MyGRACE Packet & Focus Commands
 *
 * `mygrace packet <module>` — a self-contained worker prompt ("packet"):
 * module contract + verification excerpt + dependency list, in one block.
 * `mygrace focus <module>` — minimal working set (contract + deps + tests).
 */

import { defineCommand } from "citty";
import { readFileOrNull, readIndexFile } from "./grace-common";
import { join } from "node:path";
import { findProjectRoot } from "./grace-common";

function parseDeps(moduleContent: string): string[] {
  const m = moduleContent.match(/<depends>([^<]*)<\/depends>/);
  if (!m) return [];
  return m[1].split(",").map((s) => s.trim()).filter(Boolean);
}

/** Dependency table rows: "- M-DEP — <path> (<STATUS>)" resolved from the graph index. */
export function depTable(root: string, moduleId: string): string[] {
  const indexEntries = readIndexFile(join(root, "docs", "graph-index.xml"));
  return parseDeps(readFileOrNull(join(root, "docs", "modules", `${moduleId}.xml`)) || "").map((id) => {
    const entry = indexEntries.find((e) => e.tag === id);
    const status = entry?.attrs.STATUS || "unknown";
    const path = entry?.attrs.PATH || "?";
    return `- ${id} — ${path} (${status})`;
  });
}

function statusOf(root: string, moduleId: string): string {
  return readIndexFile(join(root, "docs", "graph-index.xml")).find((e) => e.tag === moduleId)?.attrs.STATUS || "unknown";
}

/** Brief dep lines for focus: "M-CONFIG (done)". */
function depBriefs(root: string, moduleId: string): string[] {
  return depTable(root, moduleId).map((line) => {
    const m = line.match(/^- ([\w-]+).*\(([^)]+)\)$/);
    return m ? `${m[1]} (${m[2]})` : line;
  });
}

function purposeOf(moduleContent: string): string {
  return moduleContent.match(/<purpose>([^<]*)<\/purpose>/)?.[1] || "";
}

function pathOf(moduleContent: string): string {
  return moduleContent.match(/<path>([^<]*)<\/path>/)?.[1] || "";
}

export const packetCommand = defineCommand({
  meta: { name: "packet", description: "Generate a self-contained worker prompt for one module (contract + verification + deps)" },
  args: {
    id: { type: "positional", description: "Module ID (e.g. M-AUTH)" },
    path: { type: "string", default: ".", description: "Project root" },
  },
  run: async ({ args }) => {
    const root = findProjectRoot(args.path);
    const moduleId = args.id;
    const moduleContent = readFileOrNull(join(root, "docs", "modules", `${moduleId}.xml`));
    if (!moduleContent) {
      console.error(`Error: docs/modules/${moduleId}.xml not found.`);
      process.exit(1);
    }
    const verContent = readFileOrNull(join(root, "docs", "verification", `V-${moduleId}.xml`));
    const deps = depTable(root, moduleId);

    console.log(`=== PACKET ${moduleId} — ${statusOf(root, moduleId)} ===`);
    console.log("");
    console.log(`Status: ${statusOf(root, moduleId)}`);
    console.log("Scope: single module — read/write only this module + listed dependencies");
    console.log("");
    console.log(`## Contract (docs/modules/${moduleId}.xml)`);
    console.log(moduleContent);
    console.log("");
    console.log("## Verification (run now)");
    if (verContent) console.log(verContent);
    else console.log(`(no docs/verification/V-${moduleId}.xml)`);
    console.log("");
    console.log("## Dependencies (read-only context)");
    if (deps.length) deps.forEach((d) => console.log(d));
    else console.log("(none)");
  },
});

export const focusCommand = defineCommand({
  meta: { name: "focus", description: "Print the minimal working set for one module (contract + deps + tests)" },
  args: {
    id: { type: "positional", description: "Module ID (e.g. M-AUTH)" },
    path: { type: "string", default: ".", description: "Project root" },
  },
  run: async ({ args }) => {
    const root = findProjectRoot(args.path);
    const moduleId = args.id;
    const moduleContent = readFileOrNull(join(root, "docs", "modules", `${moduleId}.xml`));
    if (!moduleContent) {
      console.error(`Error: docs/modules/${moduleId}.xml not found.`);
      process.exit(1);
    }
    const status = statusOf(root, moduleId);
    const purpose = purposeOf(moduleContent);
    const path = pathOf(moduleContent);
    const deps = depBriefs(root, moduleId);
    console.log(`=== FOCUS ${moduleId} — ${status} ===`);
    console.log(`Status: ${status}`);
    console.log(`Contract: ${[purpose, path].filter(Boolean).join(" — ")}`);
    console.log(`Deps: ${deps.length ? deps.join(", ") : "(none)"}`);
    const check = moduleContent.match(/<module-checks>.*?<check-1>([^<]*)<\/check-1>/)?.[1];
    if (check) console.log(`Tests: ${check}`);
  },
});
