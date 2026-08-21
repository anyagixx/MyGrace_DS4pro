#!/usr/bin/env bun
/**
 * MyGRACE Module Command
 *
 * Subcommands:
 *   mygrace module index              — show graph-index.xml
 *   mygrace module find <query>       — search modules from index
 *   mygrace module show <id>          — show per-module file from docs/modules/
 *   mygrace module list [--status=X]  — list modules with filter
 *   mygrace phase index               — show plan-index.xml
 *   mygrace phase show <name>         — show per-phase file from docs/plans/
 *   mygrace verification index        — show verification-index.xml
 */

import { defineCommand } from "citty";
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

// ─── Helpers ────────────────────────────────────────────────────────────

function findProjectRoot(startDir: string): string {
  let dir = startDir;
  while (dir !== "/") {
    if (existsSync(join(dir, "docs", "graph-index.xml"))) return dir;
    dir = join(dir, "..");
  }
  throw new Error("MyGRACE project not found. Run in a project with docs/graph-index.xml");
}

function parseXmlAttributes(line: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  const regex = /(\w+)="([^"]*)"/g;
  let m: RegExpExecArray | null;
  while ((m = regex.exec(line)) !== null) {
    attrs[m[1]] = m[2];
  }
  return attrs;
}

function readIndexFile(path: string): { tag: string; attrs: Record<string, string>; raw: string }[] {
  if (!existsSync(path)) return [];
  const content = readFileSync(path, "utf-8");
  const results: { tag: string; attrs: Record<string, string>; raw: string }[] = [];
  // Match self-closing or opening+closing tags with unique names
  const tagRegex = /<(M-[\w-]+|V-M-[\w-]+|Phase-\d+)([^>]*?)(?:\/>|>([\s\S]*?)<\/\1>)/g;
  let m: RegExpExecArray | null;
  while ((m = tagRegex.exec(content)) !== null) {
    results.push({ tag: m[1], attrs: parseXmlAttributes(m[2]), raw: m[0] });
  }
  return results;
}

function readPerModuleFile(path: string): string | null {
  if (!existsSync(path)) return null;
  return readFileSync(path, "utf-8");
}

// ─── Subcommand: module index ───────────────────────────────────────────

const moduleIndexCmd = defineCommand({
  meta: { name: "index", description: "Show graph-index.xml (lightweight module index, ≤100 lines)" },
  args: {
    path: { type: "string", default: ".", description: "Project root" },
  },
  run: async ({ args }) => {
    const root = findProjectRoot(args.path);
    const indexPath = join(root, "docs", "graph-index.xml");
    if (!existsSync(indexPath)) {
      console.error("Error: docs/graph-index.xml not found. Run /mygrace:init first.");
      process.exit(1);
    }
    console.log(readFileSync(indexPath, "utf-8"));
  },
});

// ─── Subcommand: module find ────────────────────────────────────────────

const moduleFindCmd = defineCommand({
  meta: { name: "find", description: "Search modules by name, path, type, status, or dependency" },
  args: {
    query: { type: "positional", description: "Search query" },
    path: { type: "string", default: ".", description: "Project root" },
    status: { type: "string", description: "Filter by status (pending/wip/done)" },
    type: { type: "string", description: "Filter by module type" },
    format: { type: "string", default: "text", description: "Output format: text or json" },
  },
  run: async ({ args }) => {
    const root = findProjectRoot(args.path);
    const indexPath = join(root, "docs", "graph-index.xml");
    const entries = readIndexFile(indexPath);
    const query = (args.query || "").toLowerCase();

    let matches = entries.filter((e) => {
      const searchable = Object.values(e.attrs).join(" ").toLowerCase();
      const matchesQuery = !query || searchable.includes(query);
      const matchesStatus = !args.status || e.attrs.STATUS === args.status;
      const matchesType = !args.type || e.attrs.TYPE === args.type;
      return matchesQuery && matchesStatus && matchesType;
    });

    if (args.format === "json") {
      console.log(JSON.stringify(matches.map((m) => m.attrs), null, 2));
      return;
    }

    if (matches.length === 0) {
      console.log("No modules found.");
      return;
    }

    console.log(`Found ${matches.length} module(s):\n`);
    console.log(
      "ID".padEnd(16) +
        "NAME".padEnd(20) +
        "TYPE".padEnd(16) +
        "STATUS".padEnd(12) +
        "PATH"
    );
    console.log("-".repeat(90));
    for (const m of matches) {
      console.log(
        m.tag.padEnd(16) +
          (m.attrs.NAME || "").padEnd(20) +
          (m.attrs.TYPE || "").padEnd(16) +
          (m.attrs.STATUS || "").padEnd(12) +
          (m.attrs.PATH || "")
      );
    }
  },
});

// ─── Subcommand: module show ────────────────────────────────────────────

const moduleShowCmd = defineCommand({
  meta: { name: "show", description: "Show per-module file from docs/modules/" },
  args: {
    id: { type: "positional", description: "Module ID (e.g. M-AUTH)" },
    path: { type: "string", default: ".", description: "Project root" },
    withVerification: { type: "boolean", default: false, description: "Include verification file" },
  },
  run: async ({ args }) => {
    const root = findProjectRoot(args.path);
    const moduleId = args.id;
    const modulePath = join(root, "docs", "modules", `${moduleId}.xml`);

    console.log(`=== ${moduleId} ===\n`);
    const content = readPerModuleFile(modulePath);
    if (!content) {
      console.error(`Error: docs/modules/${moduleId}.xml not found.`);
      console.error(`Check docs/graph-index.xml for the correct module ID and path.`);
      process.exit(1);
    }
    console.log(content);

    if (args.withVerification) {
      // Find verification-ref from module file
      const verRefMatch = content.match(/<verification-ref>(V-M-[\w-]+)<\/verification-ref>/);
      if (verRefMatch) {
        const verId = verRefMatch[1];
        const verPath = join(root, "docs", "verification", `${verId}.xml`);
        console.log(`\n=== ${verId} ===\n`);
        const verContent = readPerModuleFile(verPath);
        if (verContent) {
          console.log(verContent);
        } else {
          console.log(`(Verification file ${verId}.xml not found)`);
        }
      }
    }
  },
});

// ─── Subcommand: module list ────────────────────────────────────────────

const moduleListCmd = defineCommand({
  meta: { name: "list", description: "List all modules with optional status filter" },
  args: {
    path: { type: "string", default: ".", description: "Project root" },
    status: { type: "string", description: "Filter by status (pending/wip/done)" },
    format: { type: "string", default: "text", description: "Output format: text or json" },
  },
  run: async ({ args }) => {
    const root = findProjectRoot(args.path);
    const indexPath = join(root, "docs", "graph-index.xml");
    const entries = readIndexFile(indexPath);

    const filtered = args.status ? entries.filter((e) => e.attrs.STATUS === args.status) : entries;

    if (args.format === "json") {
      console.log(JSON.stringify(filtered.map((m) => m.attrs), null, 2));
      return;
    }

    console.log(`Modules (${filtered.length}):\n`);
    console.log(
      "ID".padEnd(16) +
        "NAME".padEnd(20) +
        "TYPE".padEnd(16) +
        "STATUS".padEnd(12) +
        "DEPENDS".padEnd(20) +
        "PATH"
    );
    console.log("-".repeat(110));
    for (const m of filtered) {
      console.log(
        m.tag.padEnd(16) +
          (m.attrs.NAME || "").padEnd(20) +
          (m.attrs.TYPE || "").padEnd(16) +
          (m.attrs.STATUS || "").padEnd(12) +
          (m.attrs.DEPENDS || "").padEnd(20) +
          (m.attrs.PATH || "")
      );
    }
  },
});

// ─── Subcommand: phase index ────────────────────────────────────────────

const phaseIndexCmd = defineCommand({
  meta: { name: "index", description: "Show plan-index.xml (lightweight phase index, ≤50 lines)", hidden: true },
  args: {
    path: { type: "string", default: ".", description: "Project root" },
  },
  run: async ({ args }) => {
    const root = findProjectRoot(args.path);
    const indexPath = join(root, "docs", "plan-index.xml");
    if (!existsSync(indexPath)) {
      console.error("Error: docs/plan-index.xml not found.");
      process.exit(1);
    }
    console.log(readFileSync(indexPath, "utf-8"));
  },
});

// ─── Subcommand: phase show ─────────────────────────────────────────────

const phaseShowCmd = defineCommand({
  meta: { name: "show", description: "Show per-phase file from docs/plans/", hidden: true },
  args: {
    name: { type: "positional", description: "Phase name (e.g. Phase-1)" },
    path: { type: "string", default: ".", description: "Project root" },
  },
  run: async ({ args }) => {
    const root = findProjectRoot(args.path);
    const phasePath = join(root, "docs", "plans", `${args.name}.xml`);
    if (!existsSync(phasePath)) {
      console.error(`Error: docs/plans/${args.name}.xml not found.`);
      process.exit(1);
    }
    console.log(readFileSync(phasePath, "utf-8"));
  },
});

// ─── Subcommand: verification index ─────────────────────────────────────

const verificationIndexCmd = defineCommand({
  meta: { name: "index", description: "Show verification-index.xml (lightweight verification index, ≤80 lines)", hidden: true },
  args: {
    path: { type: "string", default: ".", description: "Project root" },
  },
  run: async ({ args }) => {
    const root = findProjectRoot(args.path);
    const indexPath = join(root, "docs", "verification-index.xml");
    if (!existsSync(indexPath)) {
      console.error("Error: docs/verification-index.xml not found.");
      process.exit(1);
    }
    console.log(readFileSync(indexPath, "utf-8"));
  },
});

// ─── Main module command with subcommands ───────────────────────────────

export const moduleCommand = defineCommand({
  meta: { name: "module", description: "Module and phase operations (index-based, lazy-loading)" },
  subCommands: {
    index: moduleIndexCmd,
    find: moduleFindCmd,
    show: moduleShowCmd,
    list: moduleListCmd,
  },
});

// ─── Exports ────────────────────────────────────────────────────────────

export const phaseCommand = defineCommand({
  meta: { name: "phase", description: "Phase operations (index-based)" },
  subCommands: {
    index: phaseIndexCmd,
    show: phaseShowCmd,
  },
});

export const verificationCommand = defineCommand({
  meta: { name: "verification", description: "Verification operations (index-based)" },
  subCommands: {
    index: verificationIndexCmd,
  },
});
