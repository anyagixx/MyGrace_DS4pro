#!/usr/bin/env bun
/**
 * MyGRACE Module Command
 *
 * Read-only navigation over the lazy-loading indexes:
 *   mygrace inspect module index              — show graph-index.xml
 *   mygrace inspect module find <query>       — search modules from the index
 *   mygrace inspect module show <id>          — show per-module file from docs/modules/
 *   mygrace inspect module list [--status=X]  — list modules with filters
 *   mygrace inspect phase index               — show plan-index.xml
 *   mygrace inspect phase show <name>         — show per-phase file from docs/plans/
 *   mygrace inspect verification index        — show verification-index.xml (with optional filters)
 *
 * Since v2 every id that reaches the filesystem is validated through
 * `grace-paths` (ADR-4: `..`, `/`, `\`, absolute and malformed ids are rejected)
 * and every index read goes through `readIndexFileSafe`, so malformed XML
 * becomes a readable typed error (exit 1) instead of a stack trace.
 */

// START_MODULE_CONTRACT
//   PURPOSE: Expose index-first navigation commands (module/phase/verification) with validated ids and readable XML errors.
//   SCOPE: Reads docs indexes/entity files; prints text or JSON; no writes.
//   DEPENDS: grace-common, grace-paths, grace-errors, grace-xml
//   LINKS: ROADMAP.md (ADR-2, ADR-4); templates/
// END_MODULE_CONTRACT

// START_MODULE_MAP
//   readIndexOrThrow()      — safe index read; throws typed XmlError on malformed XML
//   readIndexRawOrThrow()   — validate then return raw text (comments preserved for display)
//   moduleIndexCmd          — `module index`
//   moduleFindCmd           — `module find [query]` (flat + shard union)
//   moduleShardCmd          — `module shard [--group-by type|status|prefix] [--apply]` (dry-run default)
//   moduleShowCmd           — `module show <id>` (unique prefix resolution)
//   moduleListCmd           — `module list`
//   phaseIndexCmd/phaseShowCmd — `phase …`
//   verificationIndexCmd    — `verification index`
//   moduleCommand/phaseCommand/verificationCommand — citty groups
// END_MODULE_MAP

// START_CHANGE_SUMMARY
//   W1.1 — typed XML errors, id validation via grace-paths, structural
//          verification-ref resolution, JSON format validation.
// END_CHANGE_SUMMARY

import { defineCommand } from "citty";
import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  findProjectRoot,
  formatTable,
  readFileOrNull,
  readIndexFileSafe,
} from "./grace-common";
import { EXIT, MyGraceError, UsageError, XmlError, createEnvelope, printJson } from "./grace-errors";
import { assertEntityId, entityPath, type EntityKind } from "./grace-paths";
import { tryLoadConfig } from "./grace-config";
import {
  applyShardPlan,
  buildShardPlan,
  loadGraphIndex,
  loadGraphIndexStrict,
} from "./grace-shard";
import { findElements, textOf, tryParseXml } from "./grace-xml";
import type { IndexEntry } from "./grace-xml";

// ─── Safe index access ──────────────────────────────────────────────────

/** Read an index, surfacing malformed XML as a typed `XmlError` (guard prints one line, exit 1). */
function readIndexOrThrow(root: string, indexFile: string): IndexEntry[] {
  const result = readIndexFileSafe(join(root, "docs", indexFile));
  if (result.error !== undefined) throw result.error;
  return result.entries;
}

/** Validate an index (typed error on malformed XML), then return raw text for display. */
function readIndexRawOrThrow(root: string, indexFile: string): string {
  readIndexOrThrow(root, indexFile);
  const content = readFileOrNull(join(root, "docs", indexFile));
  if (content === null) {
    throw new UsageError(`Cannot read docs/${indexFile}.`, {
      hint: "Run `mygrace setup init` to create the index, or check its permissions.",
    });
  }
  return content;
}

/**
 * Shard-transparent module entries: flat root `<M-*>` plus every shard entry
 * (ADR-6). Strict: a broken shard layer throws a typed error instead of
 * silently returning a partial index.
 */
function loadGraphEntriesOrThrow(root: string): IndexEntry[] {
  return loadGraphIndexStrict(root).entries;
}

/**
 * Defensive check for ids printed from an index (ADR-4).
 *
 * `grace-xml` already restricts index tags to the documented grammar, but find/
 * list output is a trust boundary for other tools, so it is asserted here too.
 */
function assertIndexIds(entries: readonly IndexEntry[], kind: EntityKind, indexFile: string): void {
  for (const entry of entries) {
    try {
      assertEntityId(kind, entry.tag);
    } catch (error) {
      throw new MyGraceError(
        "INVALID_INDEX_ENTRY_ID",
        `docs/${indexFile} contains an invalid ${kind} id "${entry.tag}"`,
        {
          exitCode: EXIT.FINDINGS,
          file: `docs/${indexFile}`,
          hint: error instanceof MyGraceError ? error.message : "Fix the id in the index.",
        }
      );
    }
  }
}

function assertFormat(format: unknown): "text" | "json" {
  const value = String(format ?? "text");
  if (value !== "text" && value !== "json") {
    throw new UsageError(`Unknown --format "${value}".`, { hint: "Use --format text or --format json." });
  }
  return value;
}

// ─── Subcommand: module index ───────────────────────────────────────────

const moduleIndexCmd = defineCommand({
  meta: { name: "index", description: "Show graph-index.xml (lightweight module index, ≤100 lines)" },
  args: {
    path: { type: "string", default: ".", description: "Project root" },
  },
  run: async ({ args }) => {
    const root = findProjectRoot(args.path);
    console.log(readIndexRawOrThrow(root, "graph-index.xml"));
    const loaded = loadGraphIndex(root);
    if (loaded.shards.length > 0) {
      console.log(`Shards (${loaded.shards.length}):`);
      for (const shard of loaded.shards) {
        const declared = Number.isFinite(shard.count) ? String(shard.count) : "?";
        const actual = loaded.entries.length;
        console.log(`  ${shard.href} — ${declared} declared module(s); ${actual} total entries in the union`);
      }
      console.log("Read modules transparently with `mygrace inspect module list` (flat + shard entries).");
    }
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
    const format = assertFormat(args.format);
    const root = findProjectRoot(args.path);
    const entries = loadGraphEntriesOrThrow(root);
    assertIndexIds(entries, "module", "graph-index.xml");
    const query = (typeof args.query === "string" ? args.query : "").toLowerCase();

    const matches = entries.filter((entry) => {
      const searchable = Object.values(entry.attrs).join(" ").toLowerCase();
      const matchesQuery = !query || searchable.includes(query);
      const matchesStatus = !args.status || entry.attrs.STATUS === args.status;
      const matchesType = !args.type || entry.attrs.TYPE === args.type;
      return matchesQuery && matchesStatus && matchesType;
    });

    if (format === "json") {
      console.log(JSON.stringify(matches.map((match) => ({ id: match.tag, ...match.attrs })), null, 2));
      return;
    }

    if (matches.length === 0) {
      console.log("No modules found.");
      return;
    }

    console.log(`Found ${matches.length} module(s):\n`);
    for (const line of formatTable(
      ["ID", "NAME", "TYPE", "STATUS", "PATH"],
      matches.map((match) => [
        match.tag,
        match.attrs.NAME || "",
        match.attrs.TYPE || "",
        match.attrs.STATUS || "",
        match.attrs.PATH || "",
      ])
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
    const requested = assertEntityId("module", typeof args.id === "string" ? args.id : "");
    const entries = loadGraphEntriesOrThrow(root);
    assertIndexIds(entries, "module", "graph-index.xml");

    let moduleId = requested;
    const exact = entries.some((entry) => entry.tag === requested);
    if (!exact) {
      const prefixMatches = entries.filter((entry) => entry.tag.startsWith(requested));
      if (prefixMatches.length === 1) {
        const [resolved] = prefixMatches;
        if (resolved === undefined) {
          throw new UsageError(`Cannot resolve module prefix "${requested}".`);
        }
        moduleId = assertEntityId("module", resolved.tag);
      } else if (prefixMatches.length === 0) {
        console.error(`Error: docs/modules/${requested}.xml not found.`);
        console.error("Check docs/graph-index.xml for the correct module ID and path.");
        process.exit(1);
      } else {
        console.error(
          `Error: ambiguous module prefix "${requested}": ${prefixMatches.map((match) => match.tag).join(", ")}. Use the full ID.`
        );
        process.exit(1);
      }
    }

    const modulePath = entityPath(root, "module", moduleId);
    const content = readFileOrNull(modulePath);
    if (content === null) {
      console.error(`Error: docs/modules/${moduleId}.xml not found.`);
      console.error("Check docs/graph-index.xml for the correct module ID and path.");
      process.exit(1);
    }
    console.log(`=== ${moduleId} ===\n`);
    console.log(content);

    if (args.withVerification === true) {
      const parsed = tryParseXml(content, modulePath);
      if (!parsed.ok) {
        throw new XmlError(modulePath, parsed.issue.message, {
          ...(parsed.issue.line === undefined ? {} : { line: parsed.issue.line }),
          ...(parsed.issue.column === undefined ? {} : { column: parsed.issue.column }),
        });
      }
      const refs = findElements(parsed.document, (element) => element.tag === "verification-ref")
        .map((element) => textOf(element))
        .filter((ref) => ref !== "");
      for (const ref of refs) {
        let verId: string;
        try {
          verId = assertEntityId("verification", ref);
        } catch {
          console.error(`(Invalid verification-ref "${ref}" in docs/modules/${moduleId}.xml)`);
          continue;
        }
        console.log(`\n=== ${verId} ===\n`);
        const verContent = readFileOrNull(entityPath(root, "verification", verId));
        console.log(verContent === null ? `(Verification file ${verId}.xml not found)` : verContent);
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
    const format = assertFormat(args.format);
    const root = findProjectRoot(args.path);
    const entries = loadGraphEntriesOrThrow(root);
    assertIndexIds(entries, "module", "graph-index.xml");

    const filtered = entries.filter((entry) => {
      const matchesStatus = !args.status || entry.attrs.STATUS === args.status;
      const matchesType = !args.type || entry.attrs.TYPE === args.type;
      return matchesStatus && matchesType;
    });

    if (format === "json") {
      console.log(JSON.stringify(filtered.map((match) => ({ id: match.tag, ...match.attrs })), null, 2));
      return;
    }

    console.log(`Modules (${filtered.length}):\n`);
    for (const line of formatTable(
      ["ID", "NAME", "TYPE", "STATUS", "DEPENDS", "PATH"],
      filtered.map((match) => [
        match.tag,
        match.attrs.NAME || "",
        match.attrs.TYPE || "",
        match.attrs.STATUS || "",
        match.attrs.DEPENDS || "",
        match.attrs.PATH || "",
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
    const entries = readIndexOrThrow(root, "plan-index.xml");
    assertIndexIds(entries, "phase", "plan-index.xml");
    const indexPath = join(root, "docs", "plan-index.xml");
    const raw = readFileOrNull(indexPath);
    if (raw === null) throw new UsageError("Cannot read docs/plan-index.xml.");
    console.log(raw);
  },
});

// ─── Subcommand: phase show ─────────────────────────────────────────────

export const phaseShowCmd = defineCommand({
  meta: { name: "show", description: "Show per-phase file from docs/plans/", hidden: true },
  args: {
    name: { type: "positional", description: "Phase name (e.g. Phase-1)" },
    path: { type: "string", default: ".", description: "Project root" },
  },
  run: async ({ args }) => {
    const root = findProjectRoot(args.path);
    const phaseId = assertEntityId("phase", typeof args.name === "string" ? args.name : "");
    const phasePath = entityPath(root, "phase", phaseId);
    if (!existsSync(phasePath)) {
      console.error(`Error: docs/plans/${phaseId}.xml not found.`);
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
    const format = assertFormat(args.format);
    const root = findProjectRoot(args.path);
    const entries = readIndexOrThrow(root, "verification-index.xml");
    assertIndexIds(entries, "verification", "verification-index.xml");
    const priority = typeof args.priority === "string" ? args.priority.toLowerCase() : undefined;

    // No filters: preserve the raw-file behavior (fastest, shows comments).
    if (priority === undefined && format === "text") {
      const raw = readFileOrNull(join(root, "docs", "verification-index.xml"));
      if (raw === null) throw new UsageError("Cannot read docs/verification-index.xml.");
      console.log(raw);
      return;
    }

    const filtered =
      priority === undefined
        ? entries
        : entries.filter((entry) => (entry.attrs.PRIORITY || entry.attrs.priority || "").toLowerCase() === priority);

    if (format === "json") {
      console.log(JSON.stringify(filtered.map((entry) => ({ id: entry.tag, ...entry.attrs })), null, 2));
      return;
    }

    for (const entry of filtered) {
      console.log(entry.raw.replace(/^\s+|\s+$/g, ""));
    }
  },
});

// ─── Subcommand: module shard (ADR-6) ───────────────────────────────────

export const moduleShardCmd = defineCommand({
  meta: {
    name: "shard",
    description:
      "Generate docs/modules/shard-<group>.xml index shards and rewrite docs/graph-index.xml (dry-run by default, --apply to write)",
  },
  args: {
    path: { type: "string", default: ".", description: "Project root" },
    groupBy: { type: "string", default: "type", description: "Grouping strategy: type | status | prefix" },
    apply: { type: "boolean", default: false, description: "Write the plan (atomic writes + timestamped backup); default is dry-run" },
    dryRun: { type: "boolean", default: false, description: "Explicit dry run (default when --apply is absent)" },
    format: { type: "string", default: "text", description: "Output format: text or json" },
  },
  run: async ({ args }) => {
    const format = assertFormat(args.format);
    if (args.apply === true && args.dryRun === true) {
      throw new UsageError("Use either --apply or --dry-run, not both.", {
        hint: "Dry-run is the default; pass --apply to write shards.",
      });
    }
    const root = findProjectRoot(args.path);
    const loadedConfig = tryLoadConfig(root);
    if (!loadedConfig.ok) throw loadedConfig.error;
    const plan = buildShardPlan(root, {
      groupBy: typeof args.groupBy === "string" ? args.groupBy : "type",
      config: loadedConfig.result.config,
    });
    if (plan.errors.length > 0) {
      throw new UsageError(`Cannot shard: ${plan.errors.join("; ")}`, {
        hint: "Run without --apply to inspect the plan; choose a coarser --group-by.",
      });
    }

    const dryRun = args.apply !== true;
    const result = dryRun ? null : applyShardPlan(plan);
    const actions = dryRun ? plan.actions : (result?.actions ?? []);
    const envelope = createEnvelope({
      data: {
        root,
        dryRun,
        groupBy: typeof args.groupBy === "string" ? args.groupBy : "type",
        moduleCount: plan.moduleCount,
        shards: plan.groups.map((group) => ({ href: group.href, group: group.key, count: group.count })),
        removals: plan.removals.map((file) => file.replace(`${root}/`, "")),
        changed: result?.changed ?? false,
        backupDir: result?.backupDir ?? null,
        actions,
      },
      meta: { command: "module shard", root },
    });

    if (format === "json") {
      printJson(envelope);
      process.exit(envelope.exitCode);
    }

    console.log(`MyGRACE module shard (group-by: ${envelope.data?.groupBy ?? "type"})`);
    console.log("==================");
    console.log(`Project: ${root}`);
    console.log(`Modules: ${plan.moduleCount} in ${plan.groups.length} shard(s)`);
    console.log("");
    for (const action of actions) console.log(`  • ${action}`);
    console.log("");
    if (dryRun) {
      console.log("Dry run — no files were written. Pass --apply to generate the shards.");
    } else if (result?.changed === false) {
      console.log("No changes — the project already matches this sharding plan (idempotent).");
    } else {
      console.log(`Sharding applied. Backup: ${result?.backupDir ?? "(none)"}`);
      console.log("Next: run `mygrace lint --path . --strict` to verify the sharded index.");
    }
    process.exit(envelope.exitCode);
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
    shard: moduleShardCmd,
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
