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
 *   mygrace verification index        — show verification-index.xml (with optional filter)
 */

import { defineCommand } from "citty";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { findProjectRoot, readFileOrNull, readIndexFile, formatTable } from "./grace-common";

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
    console.log(readFileOrNull(indexPath));
  },
});

// ─── Subcommand: module find ────────────────────────────────────────────

export const moduleFindCmd = defineCommand({
  meta: { name: "find", description: "Search modules by name, path, type, status, or dependency" },
  args: {
    query: { type: "positional", default: "", description: "Search query (empty = list all)" },
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

    const matches = entries.filter((e) => {
      const searchable = Object.values(e.attrs).join(" ").toLowerCase();
      const matchesQuery = !query || searchable.includes(query);
      const matchesStatus = !args.status || e.attrs.STATUS === args.status;
      const matchesType = !args.type || e.attrs.TYPE === args.type;
      return matchesQuery && matchesStatus && matchesType;
    });

    if (args.format === "json") {
      console.log(JSON.stringify(matches.map((m) => ({ id: m.tag, ...m.attrs })), null, 2));
      return;
    }

    if (matches.length === 0) {
      console.log("No modules found.");
      return;
    }

    console.log(`Found ${matches.length} module(s):\n`);
    for (const line of formatTable(
      ["ID", "NAME", "TYPE", "STATUS", "PATH"],
      matches.map((m) => [m.tag, m.attrs.NAME || "", m.attrs.TYPE || "", m.attrs.STATUS || "", m.attrs.PATH || ""])
    )) {
      console.log(line);
    }
  },
});

// ─── Subcommand: module show ────────────────────────────────────────────

export const moduleShowCmd = defineCommand({
  meta: { name: "show", description: "Show per-module file from docs/modules/ (unique ID prefix allowed)" },
  args: {
    id: { type: "positional", description: "Module ID or unique ID prefix (e.g. M-AUTH, M-A)" },
    path: { type: "string", default: ".", description: "Project root" },
    withVerification: { type: "boolean", default: false, description: "Include verification file" },
  },
  run: async ({ args }) => {
    const root = findProjectRoot(args.path);
    const entries = readIndexFile(join(root, "docs", "graph-index.xml"));
    const want = String(args.id);
    const exact = entries.find((e) => e.tag === want);
    let moduleId = want;
    if (!exact) {
      const prefixMatches = entries.filter((e) => e.tag.startsWith(want));
      if (prefixMatches.length === 1) {
        moduleId = prefixMatches[0].tag;
      } else if (prefixMatches.length === 0) {
        console.error(`Error: docs/modules/${want}.xml not found.`);
        console.error(`Check docs/graph-index.xml for the correct module ID and path.`);
        process.exit(1);
      } else {
        console.error(
          `Error: ambiguous module prefix "${want}": ${prefixMatches.map((m) => m.tag).join(", ")}. Use the full ID.`
        );
        process.exit(1);
      }
    }
    const modulePath = join(root, "docs", "modules", `${moduleId}.xml`);

    const content = readFileOrNull(modulePath);
    if (!content) {
      console.error(`Error: docs/modules/${moduleId}.xml not found.`);
      console.error(`Check docs/graph-index.xml for the correct module ID and path.`);
      process.exit(1);
    }
    console.log(`=== ${moduleId} ===\n`);
    console.log(content);

    if (args.withVerification) {
      // Find verification-ref from module file
      const verRefMatch = content.match(/<verification-ref>(V-M-[\w-]+)<\/verification-ref>/);
      if (verRefMatch) {
        const verId = verRefMatch[1];
        const verPath = join(root, "docs", "verification", `${verId}.xml`);
        console.log(`\n=== ${verId} ===\n`);
        const verContent = readFileOrNull(verPath);
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

export const moduleListCmd = defineCommand({
  meta: { name: "list", description: "List modules with optional status/type filter" },
  args: {
    path: { type: "string", default: ".", description: "Project root" },
    status: { type: "string", description: "Filter by status (pending/wip/done)" },
    type: { type: "string", description: "Filter by module type" },
    format: { type: "string", default: "text", description: "Output format: text or json" },
  },
  run: async ({ args }) => {
    const root = findProjectRoot(args.path);
    const indexPath = join(root, "docs", "graph-index.xml");
    const entries = readIndexFile(indexPath);

    const filtered = entries.filter((e) => {
      const matchesStatus = !args.status || e.attrs.STATUS === args.status;
      const matchesType = !args.type || e.attrs.TYPE === args.type;
      return matchesStatus && matchesType;
    });

    if (args.format === "json") {
      console.log(JSON.stringify(filtered.map((m) => ({ id: m.tag, ...m.attrs })), null, 2));
      return;
    }

    console.log(`Modules (${filtered.length}):\n`);
    for (const line of formatTable(
      ["ID", "NAME", "TYPE", "STATUS", "DEPENDS", "PATH"],
      filtered.map((m) => [
        m.tag,
        m.attrs.NAME || "",
        m.attrs.TYPE || "",
        m.attrs.STATUS || "",
        m.attrs.DEPENDS || "",
        m.attrs.PATH || "",
      ])
    )) {
      console.log(line);
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
    console.log(readFileOrNull(indexPath));
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
    console.log(readFileOrNull(phasePath));
  },
});

// ─── Subcommand: verification index ─────────────────────────────────────

const verificationIndexCmd = defineCommand({
  meta: {
    name: "index",
    description: "Show verification-index.xml (lightweight verification index, ≤80 lines); --priority/--format filters apply",
    hidden: true,
  },
  args: {
    path: { type: "string", default: ".", description: "Project root" },
    priority: { type: "string", description: "Filter by priority (high/medium/low)" },
    format: { type: "string", default: "text", description: "Output format: text or json" },
  },
  run: async ({ args }) => {
    const root = findProjectRoot(args.path);
    const indexPath = join(root, "docs", "verification-index.xml");
    if (!existsSync(indexPath)) {
      console.error("Error: docs/verification-index.xml not found.");
      process.exit(1);
    }

    // No filters: preserve the raw-file behavior (fastest, shows comments).
    if (!args.priority && args.format === "text") {
      console.log(readFileOrNull(indexPath));
      return;
    }

    const entries = readIndexFile(indexPath);
    const filtered = args.priority
      ? entries.filter((e) => (e.attrs.PRIORITY || "").toLowerCase() === args.priority.toLowerCase())
      : entries;

    if (args.format === "json") {
      console.log(JSON.stringify(filtered.map((e) => ({ id: e.tag, ...e.attrs })), null, 2));
      return;
    }

    for (const e of filtered) {
      console.log(e.raw.replace(/^\s+|\s+$/g, ""));
    }
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
