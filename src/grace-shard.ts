#!/usr/bin/env bun
/**
 * MyGRACE — Sharded module indexes (ROADMAP ADR-6, G11).
 *
 * The root `docs/graph-index.xml` has a line cap, which makes a flat one-line-
 * per-module index unpractical beyond ~90 modules. Sharding keeps the root
 * index small by replacing flat `<M-XXX …/>` entries with references:
 *
 *   <Shard href="modules/shard-core_logic.xml" count="50" />
 *
 * Shard files live under `docs/` (conventionally `docs/modules/`) and contain
 * normal `<M-XXX …/>` entry lines. Shards are **index shards**, not per-entity
 * files: `module show` still reads `docs/modules/M-XXX.xml` directly.
 *
 * This module is the single implementation of the shard format:
 * - `loadGraphIndex()` — lenient reader for lint/reporting: union of flat root
 *   entries and shard entries, plus coded findings for structural problems.
 * - `loadGraphIndexStrict()` — throwing reader for CLI paths that must fail
 *   loudly instead of silently seeing a partial index.
 * - `buildShardPlan()` / `applyShardPlan()` — deterministic generator used by
 *   `mygrace inspect module shard` (atomic writes, timestamped backups, idempotent).
 *
 * No imports from `grace-common` on purpose: foundation call sites
 * (status/ci/test/packet/context) can import this module without a cycle.
 */

// START_MODULE_CONTRACT
//   PURPOSE: Define, read, validate and generate sharded module indexes transparently (ADR-6).
//   SCOPE: docs/graph-index.xml plus docs/…/shard-*.xml; read helpers and atomic write helpers. No command wiring.
//   DEPENDS: grace-errors, grace-xml, grace-paths, node:fs, node:path, grace-config (type only)
//   LINKS: docs/modules/M-SHARD.xml, ROADMAP.md (ADR-6, G11)
// END_MODULE_CONTRACT

// START_MODULE_MAP
//   ShardRef/GraphLoadResult   — a validated shard reference and the union index view
//   SHARD_TAG/SHARD_ROOT_TAG   — `<Shard …/>` reference and `<ModuleShard …>` shard root
//   resolveShardPath()         — href → absolute path proven to stay inside docs/ (no .., no absolute)
//   loadGraphIndex()           — lenient union reader: entries + shards + coded findings
//   loadGraphIndexStrict()     — throwing reader for CLI resolution paths
//   graphEntriesFrom()         — convenience: union entries only
//   buildShardPlan()           — deterministic grouping plan (type/status/prefix), no writes
//   applyShardPlan()           — atomic writes, timestamped backups, idempotent no-op when unchanged
// END_MODULE_MAP

// START_CHANGE_SUMMARY
//   W3.1 — sharded index format, transparent union reads, lint-visible validation
//          findings, deterministic `module shard` generator with atomic apply.
// END_CHANGE_SUMMARY

import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative } from "node:path";
import type { MyGraceConfig } from "./grace-config";
import {
  EXIT,
  MyGraceError,
  UsageError,
  XmlError,
  finding,
  isMyGraceError,
  type Finding,
} from "./grace-errors";
import { isWithin, resolveWithin } from "./grace-paths";
import {
  INDEX_TAG_RE,
  childElements,
  escapeXml,
  indexEntriesFromDocument,
  serializeElement,
  tryParseXml,
  type IndexEntry,
} from "./grace-xml";

// ─── Format constants ───────────────────────────────────────────────────

/** Root-index reference element: `<Shard href="modules/shard-x.xml" count="12" />`. */
export const SHARD_TAG = "Shard";
/** Root element of a shard file. */
export const SHARD_ROOT_TAG = "ModuleShard";
/** File-name prefix used by `module shard` when generating shard files. */
export const SHARD_FILE_PREFIX = "shard-";
/** Stable finding codes produced by shard validation (documented for docs-impl). */
export const SHARD_FINDING_CODES = {
  xmlInvalid: "XML_INVALID",
  hrefUnsafe: "PATH_UNSAFE",
  fileMissing: "SHARD_FILE_MISSING",
  countMismatch: "SHARD_COUNT_MISMATCH",
  rootInvalid: "SHARD_ROOT_INVALID",
  capExceeded: "INDEX_TOO_LARGE",
  duplicateEntry: "DUPLICATE_INDEX_ENTRY",
  orphanedEntry: "ORPHANED_INDEX_ENTRY",
} as const;

const SHARD_GROUP_BYS = ["type", "status", "prefix"] as const;
export type ShardGroupBy = (typeof SHARD_GROUP_BYS)[number];

// ─── Public types ───────────────────────────────────────────────────────

export interface ShardRef {
  /** href as written in the root index, relative to docs/. */
  href: string;
  /** Declared count attribute (NaN when missing/invalid). */
  count: number;
  /** Absolute path of the shard file (validated). */
  file: string;
}

export interface GraphLoadResult {
  /** Union of flat root entries and shard entries, deterministic order. */
  entries: IndexEntry[];
  /** Root `<M-*>` entries only. */
  flatEntries: IndexEntry[];
  /** Validated shard references in root order. */
  shards: ShardRef[];
  /** Structural shard problems (errors are fatal for strict callers). */
  findings: Finding[];
  /** Root element attributes (used by the generator to preserve the header). */
  rootAttrs: Record<string, string>;
  /** Serialized non-entry root children (keywords/annotation/...) in source order. */
  rootChildren: string[];
}

export interface ShardPlanGroup {
  /** Group value as written to the shard root (`group` attribute). */
  key: string;
  /** href relative to docs/, e.g. `modules/shard-core_logic.xml`. */
  href: string;
  /** Absolute shard file path. */
  file: string;
  /** Number of entries in the shard. */
  count: number;
  /** Canonical shard file content. */
  content: string;
  /** True when the file already has exactly this content. */
  changed: boolean;
}

export interface ShardPlan {
  root: string;
  rootFile: string;
  rootContent: string;
  rootChanged: boolean;
  groups: ShardPlanGroup[];
  /** Existing `docs/modules/shard-*.xml` files the plan no longer references. */
  removals: string[];
  /** Plan-level problems (root cap exceeded, nothing to shard, ...). */
  errors: string[];
  /** Deterministic human-readable action list for `--dry-run`. */
  actions: string[];
  moduleCount: number;
}

export interface ShardApplyResult {
  changed: boolean;
  /** Directory that received the timestamped backup, or null when nothing changed. */
  backupDir: string | null;
  actions: string[];
  written: string[];
  removed: string[];
}

// ─── Small helpers ──────────────────────────────────────────────────────

function relPosix(root: string, file: string): string {
  return relative(root, file).split("\\").join("/");
}

function readText(path: string): { ok: true; content: string } | { ok: false; message: string } {
  try {
    return { ok: true, content: readFileSync(path, "utf-8") };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) };
  }
}

/** Physical line count (a trailing newline is not an extra line). */
function lineCount(content: string): number {
  if (content === "") return 0;
  const lines = content.split("\n").length;
  return content.endsWith("\n") ? lines - 1 : lines;
}

function rootFilePath(root: string): string {
  return join(root, "docs", "graph-index.xml");
}

function shardFinding(
  code: string,
  message: string,
  file: string,
  hint?: string,
  line?: number,
  column?: number
): Finding {
  return finding("error", code, message, {
    file,
    ...(line === undefined ? {} : { line }),
    ...(column === undefined ? {} : { column }),
    ...(hint === undefined ? {} : { hint }),
  });
}

function parseCount(attrs: Record<string, string>): number {
  const raw = (attrs.count ?? "").trim();
  if (raw === "") return Number.NaN;
  const value = Number.parseInt(raw, 10);
  return Number.isFinite(value) && value >= 0 ? value : Number.NaN;
}

// ─── Href resolution (ADR-4: untrusted input) ──────────────────────────

export type ShardPathResult =
  | { ok: true; path: string }
  | { ok: false; finding: Finding };

/**
 * Resolve a `<Shard href>` against `docs/` and prove it stays inside.
 *
 * Rejects absolute paths, NUL bytes, non-`.xml` targets and any `..` escape.
 * The returned finding uses the stable `PATH_UNSAFE` code.
 */
export function resolveShardPath(root: string, href: string): ShardPathResult {
  const refFile = "docs/graph-index.xml";
  const value = (href ?? "").trim();
  const unsafe = (message: string): ShardPathResult => ({
    ok: false,
    finding: shardFinding(
      SHARD_FINDING_CODES.hrefUnsafe,
      message,
      refFile,
      "Shard hrefs must be relative to docs/, end with .xml and must not use .. segments."
    ),
  });

  if (value === "") return unsafe("Shard reference has an empty href.");
  if (value.includes("\0")) return unsafe(`Shard href "${value}" contains a NUL byte.`);
  if (isAbsolute(value) || /^[A-Za-z]:[\\/]/.test(value) || value.startsWith("\\\\")) {
    return unsafe(`Shard href "${value}" is absolute; hrefs must be relative to docs/.`);
  }
  if (!value.endsWith(".xml")) return unsafe(`Shard href "${value}" must point to an .xml file.`);

  const docsDir = join(root, "docs");
  let resolved: string;
  try {
    resolved = resolveWithin(docsDir, value, "shard href");
  } catch (error) {
    return unsafe(
      isMyGraceError(error) ? error.message : `Shard href "${value}" resolves outside docs/.`
    );
  }
  if (!isWithin(docsDir, resolved)) {
    return unsafe(`Shard href "${value}" resolves outside docs/.`);
  }
  return { ok: true, path: resolved };
}

// ─── Lenient reader (lint / reporting) ─────────────────────────────────

/**
 * Load the module index as a transparent union of flat root entries and shard
 * entries.
 *
 * Structural problems (unsafe href, missing/malformed shard, count mismatch,
 * wrong shard root, shard over its cap) are returned as coded findings so lint
 * can report them; callers that cannot continue silently use
 * `loadGraphIndexStrict`.
 */
export function loadGraphIndex(root: string, config?: MyGraceConfig): GraphLoadResult {
  const result: GraphLoadResult = {
    entries: [],
    flatEntries: [],
    shards: [],
    findings: [],
    rootAttrs: {},
    rootChildren: [],
  };

  const indexPath = rootFilePath(root);
  if (!existsSync(indexPath)) return result;

  const read = readText(indexPath);
  if (!read.ok) {
    result.findings.push(
      shardFinding(
        SHARD_FINDING_CODES.xmlInvalid,
        `Cannot read docs/graph-index.xml: ${read.message}`,
        "docs/graph-index.xml",
        "Check file permissions; the index cannot be validated."
      )
    );
    return result;
  }

  const parsed = tryParseXml(read.content, indexPath);
  if (!parsed.ok) {
    result.findings.push(
      shardFinding(
        SHARD_FINDING_CODES.xmlInvalid,
        `Invalid XML: ${parsed.issue.message}`,
        "docs/graph-index.xml",
        "Fix the root index XML and re-run.",
        parsed.issue.line,
        parsed.issue.column
      )
    );
    return result;
  }

  const document = parsed.document;
  result.rootAttrs = { ...document.root.attrs };
  const children = childElements(document.root);
  for (const child of children) {
    if (child.tag === SHARD_TAG) {
      // Expand below, keeping root order.
      const refResult = readShardRef(root, child.attrs, config, result);
      if (refResult !== null) {
        result.shards.push(refResult.ref);
        result.entries.push(...refResult.entries);
      }
      continue;
    }
    if (INDEX_TAG_RE.test(child.tag)) {
      result.flatEntries.push({
        tag: child.tag,
        attrs: { ...child.attrs },
        raw: renderEntry({ tag: child.tag, attrs: child.attrs, raw: "" }),
      });
      result.entries.push(result.flatEntries[result.flatEntries.length - 1] as IndexEntry);
      continue;
    }
    result.rootChildren.push(serializeElement(child));
  }

  return result;
}

function readShardRef(
  root: string,
  attrs: Record<string, string>,
  config: MyGraceConfig | undefined,
  sink: GraphLoadResult
): { ref: ShardRef; entries: IndexEntry[] } | null {
  const href = (attrs.href ?? "").trim();
  const resolved = resolveShardPath(root, href);
  if (!resolved.ok) {
    sink.findings.push(resolved.finding);
    return null;
  }

  const fileRel = relPosix(root, resolved.path);
  if (!existsSync(resolved.path)) {
    sink.findings.push(
      shardFinding(
        SHARD_FINDING_CODES.fileMissing,
        `Shard file ${fileRel} does not exist (referenced by docs/graph-index.xml).`,
        fileRel,
        "Regenerate shards with `mygrace inspect module shard --apply` or fix the href."
      )
    );
    return null;
  }

  const read = readText(resolved.path);
  if (!read.ok) {
    sink.findings.push(
      shardFinding(
        SHARD_FINDING_CODES.xmlInvalid,
        `Cannot read shard file ${fileRel}: ${read.message}`,
        fileRel,
        "Check file permissions; the shard cannot be validated."
      )
    );
    return null;
  }

  const parsed = tryParseXml(read.content, resolved.path);
  if (!parsed.ok) {
    sink.findings.push(
      shardFinding(
        SHARD_FINDING_CODES.xmlInvalid,
        `Invalid XML: ${parsed.issue.message}`,
        fileRel,
        "Fix the shard XML and re-run.",
        parsed.issue.line,
        parsed.issue.column
      )
    );
    return null;
  }

  if (parsed.document.root.tag !== SHARD_ROOT_TAG) {
    sink.findings.push(
      shardFinding(
        SHARD_FINDING_CODES.rootInvalid,
        `Expected shard root <${SHARD_ROOT_TAG}> but found <${parsed.document.root.tag}>.`,
        fileRel,
        `Shard files must use <${SHARD_ROOT_TAG} group="…" count="…"> as the root element.`
      )
    );
    return null;
  }

  const entries = childElements(parsed.document.root)
    .filter((element) => INDEX_TAG_RE.test(element.tag))
    .map((element) => ({
      tag: element.tag,
      attrs: { ...element.attrs },
      raw: renderEntry({ tag: element.tag, attrs: element.attrs, raw: "" }),
    }));
  const declared = parseCount(attrs);
  const declaredInShard = parseCount(parsed.document.root.attrs);
  const entryWord = entries.length === 1 ? "entry" : "entries";
  if (!Number.isFinite(declared) || declared !== entries.length) {
    sink.findings.push(
      shardFinding(
        SHARD_FINDING_CODES.countMismatch,
        `Shard reference to ${fileRel} declares count="${attrs.count ?? ""}" but the shard contains ${entries.length} ${entryWord}.`,
        "docs/graph-index.xml",
        "Fix the <Shard> count attribute or regenerate shards with `mygrace inspect module shard --apply`."
      )
    );
  }
  if (!Number.isFinite(declaredInShard) || declaredInShard !== entries.length) {
    sink.findings.push(
      shardFinding(
        SHARD_FINDING_CODES.countMismatch,
        `Shard ${fileRel} declares count="${parsed.document.root.attrs.count ?? ""}" but contains ${entries.length} ${entryWord}.`,
        fileRel,
        "Restore the count attribute or regenerate shards with `mygrace inspect module shard --apply`."
      )
    );
  }

  if (config !== undefined && lineCount(read.content) > config.indexCaps.graph) {
    sink.findings.push(
      shardFinding(
        SHARD_FINDING_CODES.capExceeded,
        `Shard ${fileRel} has ${lineCount(read.content)} lines (index cap ${config.indexCaps.graph}).`,
        fileRel,
        "Split this shard further (more groups) or raise indexCaps.graph in mygrace.config.json."
      )
    );
  }

  return { ref: { href, count: declared, file: resolved.path }, entries };
}

/** Union module entries only (convenience for callers that do not need findings). */
export function graphEntriesFrom(root: string, config?: MyGraceConfig): IndexEntry[] {
  return loadGraphIndex(root, config).entries;
}

/**
 * Strict reader for CLI resolution paths.
 *
 * Fails loudly instead of returning a partial index: malformed XML throws
 * `XmlError`; unsafe href, missing/malformed/wrong-root shard, count mismatch
 * and over-cap shard throw a `MyGraceError` carrying the finding code, message
 * and `USAGE` exit code.
 */
export function loadGraphIndexStrict(root: string, config?: MyGraceConfig): GraphLoadResult {
  const loaded = loadGraphIndex(root, config);
  const errorFinding = loaded.findings.find((item) => item.severity === "error");
  if (errorFinding === undefined) return loaded;

  if (errorFinding.code === SHARD_FINDING_CODES.xmlInvalid) {
    throw new XmlError(
      errorFinding.file ?? "docs/graph-index.xml",
      errorFinding.message.replace(/^Invalid XML:\s*/u, ""),
      {
        ...(errorFinding.line === undefined ? {} : { line: errorFinding.line }),
        ...(errorFinding.column === undefined ? {} : { column: errorFinding.column }),
        ...(errorFinding.hint === undefined ? {} : { hint: errorFinding.hint }),
      }
    );
  }

  throw new MyGraceError(errorFinding.code, errorFinding.message, {
    exitCode: EXIT.USAGE,
    ...(errorFinding.file === undefined ? {} : { file: errorFinding.file }),
    ...(errorFinding.line === undefined ? {} : { line: errorFinding.line }),
    ...(errorFinding.hint === undefined ? {} : { hint: errorFinding.hint }),
  });
}

// ─── Deterministic serialization ───────────────────────────────────────

function renderEntry(entry: IndexEntry): string {
  const attrs = Object.entries(entry.attrs)
    .map(([name, value]) => `${name}="${escapeXml(value)}"`)
    .join(" ");
  return attrs === "" ? `<${entry.tag} />` : `<${entry.tag} ${attrs} />`;
}

function renderRootIndex(rootAttrs: Record<string, string>, rootChildren: string[], shards: readonly { href: string; count: number }[]): string {
  const attrs = Object.entries(rootAttrs)
    .map(([name, value]) => `${name}="${escapeXml(value)}"`)
    .join(" ");
  const lines: string[] = [attrs === "" ? "<GraphIndex>" : `<GraphIndex ${attrs}>`];
  for (const child of rootChildren) lines.push(`  ${child}`);
  for (const shard of shards) {
    lines.push(`  <${SHARD_TAG} href="${escapeXml(shard.href)}" count="${shard.count}" />`);
  }
  lines.push("</GraphIndex>");
  return `${lines.join("\n")}\n`;
}

function renderShardFile(project: string | undefined, group: string, entries: readonly IndexEntry[]): string {
  const rootAttrs: Array<[string, string]> = [];
  if (project !== undefined && project !== "") rootAttrs.push(["project", project]);
  rootAttrs.push(["group", group]);
  rootAttrs.push(["count", String(entries.length)]);
  const attrs = rootAttrs.map(([name, value]) => `${name}="${escapeXml(value)}"`).join(" ");
  const lines: string[] = [`<${SHARD_ROOT_TAG} ${attrs}>`];
  for (const entry of entries) lines.push(`  ${renderEntry(entry)}`);
  lines.push(`</${SHARD_ROOT_TAG}>`);
  return `${lines.join("\n")}\n`;
}

// ─── Generator ─────────────────────────────────────────────────────────

function assertGroupBy(value: string): ShardGroupBy {
  if ((SHARD_GROUP_BYS as readonly string[]).includes(value)) return value as ShardGroupBy;
  throw new UsageError(`Unknown --group-by "${value}".`, {
    hint: `Use one of: ${SHARD_GROUP_BYS.join(", ")}.`,
  });
}

function groupValue(entry: IndexEntry, groupBy: ShardGroupBy): string {
  switch (groupBy) {
    case "type": {
      const value = (entry.attrs.TYPE ?? "").trim();
      return value === "" ? "UNKNOWN" : value;
    }
    case "status": {
      const value = (entry.attrs.STATUS ?? "").trim();
      return value === "" ? "UNKNOWN" : value;
    }
    case "prefix": {
      const suffix = entry.tag.replace(/^M-/u, "");
      const first = suffix.charAt(0).toUpperCase();
      return /^[A-Z0-9]$/u.test(first) ? first : "OTHER";
    }
  }
}

function slugify(value: string): string {
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/gu, "-")
    .replace(/^-+/u, "")
    .replace(/-+$/u, "");
  return slug === "" ? "other" : slug;
}

/** Files currently recognised as generated shards under docs/modules/. */
function existingShardFiles(root: string): string[] {
  const modulesDir = join(root, "docs", "modules");
  if (!existsSync(modulesDir)) return [];
  try {
    return readdirSync(modulesDir)
      .filter((file) => file.startsWith(SHARD_FILE_PREFIX) && file.endsWith(".xml"))
      .sort()
      .map((file) => join(modulesDir, file));
  } catch {
    return [];
  }
}

/**
 * Build a deterministic sharding plan. Never writes anything.
 *
 * Determinism: groups are sorted by group key, entries keep their union-index
 * order, file names are derived from a sanitized lower-case key, and the root
 * index is rewritten canonically. Re-running on the result is a no-op.
 */
export function buildShardPlan(
  root: string,
  options: { groupBy?: string | ShardGroupBy; config?: MyGraceConfig } = {}
): ShardPlan {
  const groupBy = assertGroupBy(options.groupBy ?? "type");
  const loaded = loadGraphIndex(root, options.config);

  const plan: ShardPlan = {
    root,
    rootFile: rootFilePath(root),
    rootContent: "",
    rootChanged: false,
    groups: [],
    removals: [],
    errors: [],
    actions: [],
    moduleCount: 0,
  };

  // Only M-* entries are module index entries; other index tags are left out of
  // the shard plan (they are normally absent from graph-index.xml).
  const entries = loaded.entries.filter((entry) => entry.tag.startsWith("M-"));
  plan.moduleCount = entries.length;
  if (entries.length === 0) {
    plan.errors.push("No module entries found in docs/graph-index.xml (flat entries or shards).");
    return plan;
  }

  const groups = new Map<string, IndexEntry[]>();
  for (const entry of entries) {
    const key = groupValue(entry, groupBy);
    const bucket = groups.get(key);
    if (bucket === undefined) groups.set(key, [entry]);
    else bucket.push(entry);
  }

  const usedSlugs = new Set<string>();
  const usedHrefs = new Set<string>();
  for (const key of [...groups.keys()].sort((a, b) => a.localeCompare(b))) {
    const bucket = groups.get(key) ?? [];
    const base = slugify(key);
    let slug = base;
    let index = 2;
    while (usedSlugs.has(slug) || usedHrefs.has(`modules/shard-${slug}.xml`)) {
      slug = `${base}-${index}`;
      index += 1;
    }
    usedSlugs.add(slug);
    const href = `modules/shard-${slug}.xml`;
    usedHrefs.add(href);
    const file = join(root, "docs", href);
    const content = renderShardFile(loaded.rootAttrs.project, key, bucket);
    const current = readText(file);
    plan.groups.push({
      key,
      href,
      file,
      count: bucket.length,
      content,
      changed: !current.ok || current.content !== content,
    });
    plan.actions.push(
      `${plan.groups[plan.groups.length - 1]?.changed === true ? "write" : "unchanged"} docs/${href} (${bucket.length} ${key} module${bucket.length === 1 ? "" : "s"})`
    );
  }

  plan.rootContent = renderRootIndex(
    loaded.rootAttrs,
    loaded.rootChildren,
    plan.groups.map((group) => ({ href: group.href, count: group.count }))
  );
  const currentRoot = readText(plan.rootFile);
  if (!currentRoot.ok) {
    plan.errors.push("docs/graph-index.xml is missing or unreadable; nothing to shard.");
    return plan;
  }
  plan.rootChanged = currentRoot.content !== plan.rootContent;

  if (options.config !== undefined) {
    const rootLines = lineCount(plan.rootContent);
    if (rootLines > options.config.indexCaps.graph) {
      plan.errors.push(
        `Generated root index would have ${rootLines} lines (cap ${options.config.indexCaps.graph}); ` +
          "choose a coarser --group-by (type/status group less than prefix)."
      );
    }
  }

  // Stale generated shard files that the new plan no longer references.
  const plannedFiles = new Set(plan.groups.map((group) => group.file));
  for (const file of existingShardFiles(root)) {
    if (plannedFiles.has(file)) continue;
    plan.removals.push(file);
    plan.actions.push(`remove stale shard docs/${relPosix(root, file)}`);
  }
  if (!plan.rootChanged) plan.actions.unshift("unchanged docs/graph-index.xml");
  else plan.actions.unshift(`rewrite docs/graph-index.xml (${plan.groups.length} shard reference${plan.groups.length === 1 ? "" : "s"}, ${entries.length} modules)`);

  return plan;
}

function writeAtomic(file: string, content: string): void {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  writeFileSync(tmp, content);
  renameSync(tmp, file);
}

/**
 * Apply a plan: timestamped backup of every file that changes, atomic
 * write/rename, and a strict no-op when the project already matches the plan
 * (hashes stay equal across re-runs).
 */
export function applyShardPlan(plan: ShardPlan): ShardApplyResult {
  if (plan.errors.length > 0) {
    throw new UsageError(`Cannot shard: ${plan.errors.join("; ")}`, {
      hint: "Run `mygrace inspect module shard` without --apply to inspect the plan.",
    });
  }

  const changedGroups = plan.groups.filter((group) => group.changed);
  const changed = plan.rootChanged || changedGroups.length > 0 || plan.removals.length > 0;
  if (!changed) {
    return {
      changed: false,
      backupDir: null,
      actions: ["No changes — the project already matches this sharding plan."],
      written: [],
      removed: [],
    };
  }

  const timestamp = new Date().toISOString().replace(/[:.]/gu, "-");
  const backupDir = join(plan.root, ".mygrace", "backups", `shard-${timestamp}`);
  const written: string[] = [];
  const removed: string[] = [];
  const actions: string[] = [];

  const backup = (file: string): void => {
    if (!existsSync(file)) return;
    const target = join(backupDir, relPosix(plan.root, file));
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(file, target);
  };

  if (plan.rootChanged) {
    backup(plan.rootFile);
    writeAtomic(plan.rootFile, plan.rootContent);
    written.push(relPosix(plan.root, plan.rootFile));
    actions.push(`rewrote docs/graph-index.xml (${plan.groups.length} shard references)`);
  }
  for (const group of changedGroups) {
    backup(group.file);
    writeAtomic(group.file, group.content);
    written.push(relPosix(plan.root, group.file));
    actions.push(`wrote docs/${group.href} (${group.count} entries)`);
  }
  for (const file of plan.removals) {
    backup(file);
    rmSync(file, { force: true });
    removed.push(relPosix(plan.root, file));
    actions.push(`removed stale shard docs/${relPosix(plan.root, file)}`);
  }
  actions.push(`backup: ${relPosix(plan.root, backupDir)}`);

  return { changed: true, backupDir, actions, written, removed };
}
