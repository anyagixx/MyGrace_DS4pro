#!/usr/bin/env bun
/**
 * MyGRACE Shared Helpers
 *
 * Common filesystem and XML utilities used by the lint, module, phase,
 * verification, and file commands. Kept in one place so the implementations
 * cannot drift (the same findProjectRoot / parser logic must serve every
 * command).
 */

import { readFileSync, existsSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";

/**
 * Locate the MyGRACE project root by walking up from `startDir` until a
 * `docs/graph-index.xml` marker is found, or the filesystem root is reached.
 *
 * The walk is bounded: `resolve(dir, "..")` eventually returns the same
 * absolute path at the filesystem root, which terminates the loop. A missing
 * project therefore throws a readable error instead of hanging.
 */
export function findProjectRoot(startDir: string): string {
  let dir = resolve(startDir);
  for (;;) {
    if (existsSync(join(dir, "docs", "graph-index.xml"))) return dir;
    const parent = resolve(dir, "..");
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error("MyGRACE project not found. Run in a project with docs/graph-index.xml");
}

/** Parse double-quoted attributes from an XML tag body into a record. */
export function parseXmlAttributes(source: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  const regex = /(\w+)="([^"]*)"/g;
  let m: RegExpExecArray | null;
  while ((m = regex.exec(source)) !== null) attrs[m[1]] = m[2];
  return attrs;
}

export interface IndexEntry {
  tag: string;
  attrs: Record<string, string>;
  raw: string;
}

const INDEX_TAG_REGEX = /<(M-[\w-]+|V-M-[\w-]+|Phase-\d+)([^>]*?)(?:\/>|>([\s\S]*?)<\/\1>)/g;

/**
 * Parse index entries (`<M-XXX .../>`, `<V-M-XXX .../>`, `<Phase-N .../>`)
 * from an index file. Accepts both self-closing tags (index convention) and
 * paired tags (used in some per-entity files). XML comments are stripped
 * first so commented template examples never surface as real entries.
 */
export function parseIndexEntries(content: string): IndexEntry[] {
  const results: IndexEntry[] = [];
  const stripped = content.replace(/<!--[\s\S]*?-->/g, "");
  const regex = new RegExp(INDEX_TAG_REGEX.source, "g");
  let m: RegExpExecArray | null;
  while ((m = regex.exec(stripped)) !== null) {
    results.push({ tag: m[1], attrs: parseXmlAttributes(m[2]), raw: m[0] });
  }
  return results;
}

/** Read an index file into parsed entries; a missing file yields []. */
export function readIndexFile(path: string): IndexEntry[] {
  if (!existsSync(path)) return [];
  return parseIndexEntries(readFileSync(path, "utf-8"));
}

/** Read a file's full content, or null when it does not exist. */
export function readFileOrNull(path: string): string | null {
  if (!existsSync(path)) return null;
  return readFileSync(path, "utf-8");
}

/** List `.xml` files in a directory filtered by an ID prefix (e.g. "M-"). */
export function listEntityFiles(dirPath: string, prefix: string): string[] {
  if (!existsSync(dirPath)) return [];
  return readdirSync(dirPath).filter((f) => f.startsWith(prefix) && f.endsWith(".xml"));
}
