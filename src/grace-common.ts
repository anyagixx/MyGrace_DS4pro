/**
 * MyGRACE — Shared filesystem and index helpers.
 *
 * This module is the stable, low-level layer every command builds on. Since v2
 * it delegates XML work to `grace-xml` (structural parsing, no regex scraping)
 * and keeps only filesystem concerns here. Public API is backwards compatible
 * with v1 so commands can migrate incrementally.
 */

// START_MODULE_CONTRACT
//   PURPOSE: Project-root discovery, index reading, safe file walking and table formatting.
//   SCOPE: Filesystem reads only; no command-specific logic, no writes.
//   DEPENDS: grace-errors, grace-xml
//   LINKS: ROADMAP.md (ADR-2, ADR-5)
// END_MODULE_CONTRACT

// START_MODULE_MAP
//   findProjectRoot()      — walk up to docs/graph-index.xml, throw ProjectNotFoundError
//   tryFindProjectRoot()   — same, returns null instead of throwing
//   parseIndexEntries()    — re-exported from grace-xml (structural parser)
//   parseXmlAttributes()   — v1-compatible attribute helper
//   readIndexFile()        — missing file -> [], malformed file -> XmlError
//   readIndexFileSafe()    — non-throwing variant for lint-style callers
//   readFileOrNull()       — null when absent
//   readTextFileOrThrow()  — readable UsageError when unreadable
//   listEntityFiles()      — .xml files in a directory by id prefix
//   walkFiles()            — deterministic recursive walk with ignore dirs/exts, no symlink loops
//   formatTable()          — aligned text table (ragged rows tolerated)
//   countLines()           — line count used by size/index budgets
// END_MODULE_MAP

import { existsSync, lstatSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { ProjectNotFoundError, UsageError, XmlError } from "./grace-errors";
import { indexEntriesFromDocument, parseAttributes, parseIndexEntries, tryParseXml } from "./grace-xml";
import type { IndexEntry } from "./grace-xml";

export { parseIndexEntries };
export type { IndexEntry };

const INDEX_MARKER = join("docs", "graph-index.xml");

/**
 * Locate the MyGRACE project root by walking up from `startDir` until a
 * `docs/graph-index.xml` marker is found, or the filesystem root is reached.
 *
 * The walk is bounded: `resolve(dir, "..")` eventually returns the same
 * absolute path at the filesystem root, which terminates the loop.
 */
export function findProjectRoot(startDir: string): string {
  const root = tryFindProjectRoot(startDir);
  if (root === null) throw new ProjectNotFoundError(startDir);
  return root;
}

/** Non-throwing project-root discovery; `null` when no project marker exists. */
export function tryFindProjectRoot(startDir: string): string | null {
  let dir = resolve(startDir);
  for (;;) {
    if (existsSync(join(dir, INDEX_MARKER))) return dir;
    const parent = resolve(dir, "..");
    if (parent === dir) return null;
    dir = parent;
  }
}

/** v1-compatible helper: parse attributes from a raw tag body string. */
export function parseXmlAttributes(source: string): Record<string, string> {
  return parseAttributes(source);
}

/**
 * Read and parse an index file.
 *
 * A missing file yields an empty list (callers decide whether that is an
 * error); malformed XML throws a typed `XmlError` so it cannot be mistaken for
 * an empty index.
 */
export function readIndexFile(path: string): IndexEntry[] {
  if (!existsSync(path)) return [];
  return parseIndexEntries(readFileSync(path, "utf-8"), path);
}

export interface IndexReadResult {
  entries: IndexEntry[];
  error?: XmlError;
}

/** Non-throwing index read for lint/reporting call sites. */
export function readIndexFileSafe(path: string): IndexReadResult {
  if (!existsSync(path)) return { entries: [] };
  let content: string;
  try {
    content = readFileSync(path, "utf-8");
  } catch (error) {
    return { entries: [], error: new XmlError(path, `cannot read file: ${error instanceof Error ? error.message : String(error)}`) };
  }
  const parsed = tryParseXml(content, path);
  if (!parsed.ok) {
    const { issue } = parsed;
    return {
      entries: [],
      error: new XmlError(path, issue.message, {
        ...(issue.line === undefined ? {} : { line: issue.line }),
        ...(issue.column === undefined ? {} : { column: issue.column }),
      }),
    };
  }
  return { entries: indexEntriesFromDocument(parsed.document) };
}

/** Read a file's full content, or null when it does not exist. */
export function readFileOrNull(path: string): string | null {
  if (!existsSync(path)) return null;
  return readFileSync(path, "utf-8");
}

/** Read a text file; an unreadable file becomes a readable `UsageError`. */
export function readTextFileOrThrow(path: string, label = "file"): string {
  try {
    return readFileSync(path, "utf-8");
  } catch (error) {
    throw new UsageError(`Cannot read ${label} "${path}": ${error instanceof Error ? error.message : String(error)}`, {
      hint: "Check that the path exists and is readable.",
    });
  }
}

/** List `.xml` files in a directory filtered by an ID prefix (e.g. "M-"). */
export function listEntityFiles(dirPath: string, prefix: string): string[] {
  if (!existsSync(dirPath)) return [];
  try {
    return readdirSync(dirPath)
      .filter((file) => file.startsWith(prefix) && file.endsWith(".xml"))
      .sort();
  } catch {
    return [];
  }
}

// START_BLOCK_WALK
export interface WalkFilesOptions {
  /** Directory names skipped at any depth (e.g. node_modules, dist). */
  ignoreDirs?: readonly string[];
  /** Lower-case extensions to include (e.g. [".ts", ".py"]); all files when omitted. */
  exts?: readonly string[];
  /** Hard cap to keep lint bounded on pathological trees. */
  maxFiles?: number;
}

/**
 * Deterministic recursive file walk.
 *
 * - skips ignored directory names at any depth,
 * - never follows symlinks (avoids loops and escaping the project),
 * - returns absolute paths sorted lexicographically,
 * - swallows unreadable directories instead of crashing a lint run.
 */
export function walkFiles(baseDir: string, options: WalkFilesOptions = {}): string[] {
  const ignore = new Set(options.ignoreDirs ?? []);
  const exts = options.exts === undefined ? undefined : new Set(options.exts.map((ext) => ext.toLowerCase()));
  const maxFiles = options.maxFiles ?? 200_000;
  const results: string[] = [];
  const stack: string[] = [resolve(baseDir)];

  while (stack.length > 0 && results.length < maxFiles) {
    const dir = stack.pop();
    if (dir === undefined) break;

    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      continue;
    }

    for (const entry of entries) {
      if (ignore.has(entry)) continue;
      const fullPath = join(dir, entry);
      let stats;
      try {
        stats = lstatSync(fullPath);
      } catch {
        continue;
      }
      if (stats.isSymbolicLink()) continue;
      if (stats.isDirectory()) {
        stack.push(fullPath);
        continue;
      }
      if (!stats.isFile()) continue;
      if (exts !== undefined) {
        const dot = entry.lastIndexOf(".");
        const ext = dot === -1 ? "" : entry.slice(dot).toLowerCase();
        if (!exts.has(ext)) continue;
      }
      results.push(fullPath);
      if (results.length >= maxFiles) break;
    }
  }

  results.sort();
  return results;
}
// END_BLOCK_WALK

/** Format a simple text table with dynamically computed column widths. */
export function formatTable(headers: string[], rows: string[][]): string[] {
  const widths = headers.map((header, index) =>
    Math.max(header.length, ...rows.map((row) => (row[index] ?? "").length))
  );
  const line = (cells: string[]): string =>
    cells.map((cell, index) => (cell ?? "").padEnd(widths[index] ?? 0)).join("  ").trimEnd();
  const headerLine = line(headers);
  const lines = [headerLine, "-".repeat(headerLine.length)];
  for (const row of rows) lines.push(line(row));
  return lines;
}

/** Line count used by index caps and size budgets (1 for non-empty files). */
export function countLines(content: string): number {
  if (content === "") return 0;
  return content.split("\n").length;
}
