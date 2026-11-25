#!/usr/bin/env bun
/**
 * MyGRACE Lint Command — the enforced quality gate (`mygrace lint`, `--strict`).
 *
 * Since v2 (ROADMAP G3, ADR-2/ADR-3) lint does not "scrape" docs XML anymore:
 * every docs/*.xml file is parsed structurally through `grace-xml`, every
 * index field is compared with its per-entity file, layout/budget policies come
 * from `mygrace.config.json`, and findings carry stable machine codes.
 *
 * Detected classes (each has a negative test in test/grace-lint-strict.test.ts):
 * - XML_INVALID / INDEX_ROOT_TAG / ENTITY_TAG_MISMATCH / INVALID_ENTITY_ID
 * - ORPHANED_INDEX_ENTRY / MISSING_INDEX_ENTRY / MISSING_INDEX_FILE /
 *   MISSING_ENTITY_DIR / DUPLICATE_INDEX_ENTRY
 * - NAME_DRIFT / TYPE_DRIFT / STATUS_DRIFT / PATH_DRIFT / DEPENDS_DRIFT /
 *   VERIFICATION_REF_DRIFT / PHASE_*_DRIFT / VERIFICATION_*_DRIFT
 * - MODULE_PATH_NOT_FOUND / PATH_UNSAFE / UNKNOWN_DEPENDENCY /
 *   INVALID_DEPENDENCY_ID
 * - INDEX_TOO_LARGE / ENTITY_TOO_SMALL / ENTITY_TOO_LARGE
 * - MISSING_VERIFICATION_REF / VERIFICATION_REF_NOT_IN_INDEX /
 *   INVALID_VERIFICATION_REF / MODULE_CHECKS_DEPRECATED_LOCATION
 * - UNPAIRED_BLOCK / BLOCK_NAME_MISMATCH / STRAY_END_BLOCK /
 *   MISSING_MODULE_CONTRACT / CONTRACT_FIELD_MISSING / FILE_UNREADABLE /
 *   GENERIC_XML_TAG / CONFIG_INVALID
 *
 * Exit codes follow `grace-errors` (ADR-3): 0 ok, 1 findings, 2 usage/config,
 * 3 internal. `--strict` promotes warnings to exit 1. `--format json` prints the
 * same `ResultEnvelope` as every other command and honours the exit code (the
 * v1 "JSON mode always exits 0" bug is fixed).
 */

// START_MODULE_CONTRACT
//   PURPOSE: Enforce MyGRACE invariants (XML validity, index/entity drift, path/dependency integrity, caps/budgets, markup discipline) and report coded findings.
//   SCOPE: reads docs/**/*.xml and configured source files; never writes. Command wiring + pure detector functions.
//   DEPENDS: grace-common, grace-xml, grace-config, grace-errors, grace-paths
//   LINKS: ROADMAP.md (G3, ADR-2, ADR-3, ADR-5); test/grace-lint-strict.test.ts
// END_MODULE_CONTRACT

// START_MODULE_MAP
//   LintIssue                      — Finding alias kept for v1 call sites (status/doctor/tests)
//   analyzeMarkup()                — text-markup analysis shared with `file show`
//   lintXmlFiles()                 — structural XML validity + root/tag checks for every docs/*.xml
//   lintIndexSync()                — index↔entity sync, drift, path and DEPENDS integrity for one flat index
//   lintGraphIndex()               — shard-aware graph-index validation (flat entries + <Shard> refs)
//   lintIndexCaps()                — index line caps from config
//   lintEntityBudgets()            — entity line budgets from config (warnings)
//   lintVerificationRefs()         — verification ref integrity (all refs, both directions)
//   lintDeprecatedModuleChecks()   — legacy <module-checks> in module files (warning)
//   lintXmlTags()                  — generic XML tag conventions (warning)
//   lintMarkup()                   — semantic markup over configured source dirs
//   collectLintIssues()            — aggregate every detector (compatible with v1 signature)
//   resolveChangedFiles()          — --changed scope from git or explicit --files
//   collectChangedLintIssues()     — full detectors, findings filtered to changed files/entities
//   ChangedScope                   — {changed, scanned, skipped} reported in text and JSON
//   lintCommand                    — citty command with --strict/--format/--allow-missing-docs
// END_MODULE_MAP

// START_CHANGE_SUMMARY
//   W1.1 — replaced regex scraping with structural XML access, added drift/caps/budgets/markup
//          detectors, stable finding codes, --strict and a correct JSON envelope/exit-code contract.
//   W3.6 — incremental `lint --changed [--base] [--files]`: git/untracked scope with a 2 s
//          timeout, index-level checks kept when an index changes, markup limited to changed
//          sources, Scope line + data.scope {changed, scanned, skipped} envelope.
//   v1.3.1 — CRLF-safe markup analysis: Windows checkouts (git core.autocrlf) no longer lose
//          MODULE_CONTRACT fields or block markers (the analysis normalises line endings).
// END_CHANGE_SUMMARY

import { defineCommand } from "citty";
import { existsSync, readFileSync, statSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join, relative, resolve } from "node:path";
import {
  countLines,
  findProjectRoot,
  listEntityFiles,
  readIndexFileSafe,
  walkFiles,
} from "./grace-common";
import { cloneDefault, tryLoadConfig, type MyGraceConfig } from "./grace-config";
import { runLintProviders, type LintProviderReport } from "./grace-lint-providers";
import {
  EXIT,
  MyGraceError,
  UsageError,
  createEnvelope,
  exitCodeForFindings,
  finding,
  isMyGraceError,
  printJson,
  type Finding,
} from "./grace-errors";
import { assertEntityId, assertSafeRelativePath, entityDir as entityDirPath, entityPath, resolveWithin } from "./grace-paths";
import { loadGraphIndex } from "./grace-shard";
import {
  childElements,
  findElements,
  textOf,
  tryParseXml,
  type XmlDocument,
  type XmlElement,
} from "./grace-xml";

/** v1 name kept for compatibility: a lint issue is a `Finding` (superset of the old shape). */
export type LintIssue = Finding;

// ─── Constants ──────────────────────────────────────────────────────────

interface EntityKindSpec {
  kind: "module" | "phase" | "verification";
  indexFile: string;
  entityDir: string;
  prefix: string;
  budget: "module" | "phase" | "verification";
  /** Element tag that is valid inside an index for this entity kind. */
  tagPattern: RegExp;
}

const KINDS: readonly EntityKindSpec[] = [
  { kind: "module", indexFile: "graph-index.xml", entityDir: "modules", prefix: "M-", budget: "module", tagPattern: /^M-/ },
  { kind: "phase", indexFile: "plan-index.xml", entityDir: "plans", prefix: "Phase-", budget: "phase", tagPattern: /^Phase-/ },
  {
    kind: "verification",
    indexFile: "verification-index.xml",
    entityDir: "verification",
    prefix: "V-M-",
    budget: "verification",
    tagPattern: /^V-M-/,
  },
];

/** Generic tags the methodology forbids in favour of unique id tags. */
const GENERIC_XML_TAGS: ReadonlySet<string> = new Set([
  "Module",
  "Phase",
  "Flow",
  "UseCase",
  "step",
  "export",
  "function",
  "type",
]);

const INDEX_ROOT_TAGS: Readonly<Record<string, string>> = {
  "graph-index.xml": "GraphIndex",
  "plan-index.xml": "PlanIndex",
  "verification-index.xml": "VerificationIndex",
};

const CONTRACT_FIELDS = ["PURPOSE", "SCOPE", "DEPENDS", "LINKS"] as const;
type ContractField = (typeof CONTRACT_FIELDS)[number];

const CONTRACT_HINT =
  "Add the missing line inside START_MODULE_CONTRACT / END_MODULE_CONTRACT (PURPOSE, SCOPE, DEPENDS, LINKS).";

// ─── Small helpers ──────────────────────────────────────────────────────

function kindForIndexFile(indexFile: string): EntityKindSpec | undefined {
  return KINDS.find((spec) => spec.indexFile === indexFile);
}

function relPath(root: string, filePath: string): string {
  return relative(root, filePath).split("\\").join("/");
}

function lineOf(content: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index && i < content.length; i += 1) {
    if (content.charCodeAt(i) === 10) line += 1;
  }
  return line;
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function readFileSafe(path: string): { ok: true; content: string } | { ok: false; message: string } {
  try {
    return { ok: true, content: readFileSync(path, "utf-8") };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, message };
  }
}

/**
 * Line count used by index caps / entity budgets.
 *
 * `countLines` (grace-common) counts `split("\n")` segments, so a file ending in
 * a newline would report one line more than `wc -l`/editors show. Budgets are
 * documented in editor lines, so the trailing empty segment is not counted.
 */
function physicalLines(content: string): number {
  if (content === "") return 0;
  const lines = countLines(content);
  return content.endsWith("\n") ? lines - 1 : lines;
}

function readEntityDocument(path: string): XmlDocument | null {
  const read = readFileSafe(path);
  if (!read.ok) return null;
  const parsed = tryParseXml(read.content, path);
  return parsed.ok ? parsed.document : null;
}

function attrFromRecord(attrs: Record<string, string>, ...names: string[]): string | undefined {
  for (const name of names) {
    const value = attrs[name];
    if (value !== undefined) return value;
  }
  return undefined;
}

function attrFromElement(element: XmlElement, ...names: string[]): string | undefined {
  for (const name of names) {
    const value = element.attrs[name];
    if (value !== undefined) return value;
  }
  return undefined;
}

/** First text of the first descendant with the given tag, or undefined when absent. */
function descendantText(document: XmlDocument, tag: string): string | undefined {
  const element = findElements(document, (candidate) => candidate.tag === tag)[0];
  return element === undefined ? undefined : textOf(element);
}

function dedupeFindings(findings: readonly Finding[]): Finding[] {
  const seen = new Set<string>();
  const output: Finding[] = [];
  for (const item of findings) {
    const key = [item.severity, item.code, item.file ?? "", item.line ?? "", item.message].join("\u0000");
    if (seen.has(key)) continue;
    seen.add(key);
    output.push(item);
  }
  return output;
}

function xmlInvalidFinding(root: string, filePath: string, detail: string, line?: number, column?: number): Finding {
  return finding("error", "XML_INVALID", `Invalid XML: ${detail}`, {
    file: relPath(root, filePath),
    ...(line === undefined ? {} : { line }),
    ...(column === undefined ? {} : { column }),
    hint: "Fix the XML (every tag must be closed, attributes quoted and unique) and re-run.",
  });
}

/** Comment-aware marker detection: markers inside string literals do not count. */
function isCommentMarker(content: string, index: number): boolean {
  const lineStart = content.lastIndexOf("\n", index - 1) + 1;
  const prefix = content.slice(lineStart, index);
  return /(?:\/\/|#|--|\/\*|<!--|\*)\s*$/.test(prefix);
}

// ─── Semantic markup analysis (shared by lint and `file show`) ──────────

export type BlockFindingCode = "UNPAIRED_BLOCK" | "BLOCK_NAME_MISMATCH" | "STRAY_END_BLOCK";

export interface MarkupBlockIssue {
  code: BlockFindingCode;
  message: string;
  line: number;
}

export interface MarkupContract {
  /** Raw source text from START_MODULE_CONTRACT/FIRST comment token through END_MODULE_CONTRACT. */
  raw: string;
  legacy: boolean;
  fields: Record<ContractField, string | undefined>;
}

export interface MarkupAnalysis {
  blockStarts: number;
  blockEnds: number;
  blockIssues: MarkupBlockIssue[];
  contract?: MarkupContract;
  moduleMap?: string;
  changeSummary?: string;
  functionContracts: string[];
}

interface MarkerMatch {
  kind: "start" | "end";
  name: string;
  index: number;
}

function collectBlockMarkers(content: string): MarkerMatch[] {
  const regex = /(START|END)_BLOCK_([A-Za-z0-9_]+)/g;
  const markers: MarkerMatch[] = [];
  let match: RegExpExecArray | null;
  while ((match = regex.exec(content)) !== null) {
    if (!isCommentMarker(content, match.index)) continue;
    const name = match[2];
    if (name === undefined) continue;
    markers.push({ kind: match[1] === "START" ? "start" : "end", name, index: match.index });
  }
  return markers;
}

function parseContract(content: string): MarkupContract | undefined {
  const canonicalStart = content.indexOf("START_MODULE_CONTRACT");
  let startIndex = -1;
  let endIndex = -1;
  let legacy = false;

  if (canonicalStart >= 0) {
    startIndex = content.lastIndexOf("\n", canonicalStart - 1) + 1;
    const endMarker = content.indexOf("END_MODULE_CONTRACT", canonicalStart);
    if (endMarker >= 0) endIndex = endMarker + "END_MODULE_CONTRACT".length;
  } else {
    const legacyStart = content.indexOf("=== MODULE_CONTRACT ===");
    if (legacyStart >= 0) {
      legacy = true;
      startIndex = content.lastIndexOf("\n", legacyStart - 1) + 1;
      const legacyEnd = content.indexOf("=== END_MODULE_CONTRACT ===", legacyStart);
      if (legacyEnd >= 0) endIndex = legacyEnd + "=== END_MODULE_CONTRACT ===".length;
    }
  }

  if (startIndex < 0 || endIndex <= startIndex) return undefined;

  const raw = content.slice(startIndex, endIndex);
  const fields: Record<ContractField, string | undefined> = {
    PURPOSE: undefined,
    SCOPE: undefined,
    DEPENDS: undefined,
    LINKS: undefined,
  };
  for (const line of raw.split("\n")) {
    const match = line.match(/(PURPOSE|SCOPE|DEPENDS|LINKS)\s*:\s*(.*)$/);
    if (match?.[1] === undefined || match[2] === undefined) continue;
    const field = match[1] as ContractField;
    if (fields[field] !== undefined) continue;
    fields[field] = match[2].trim();
  }
  return { raw, legacy, fields };
}

function extractSection(content: string, startToken: string, endToken: string): string | undefined {
  const start = content.indexOf(startToken);
  if (start < 0) return undefined;
  const end = content.indexOf(endToken, start + startToken.length);
  if (end < 0) return undefined;
  const startIndex = content.lastIndexOf("\n", start - 1) + 1;
  return content.slice(startIndex, end + endToken.length);
}

function extractFunctionContracts(content: string): string[] {
  const regex = /(?:^|\n)[^\n]*(START_CONTRACT:\s*(\w+))[\s\S]*?END_CONTRACT:\s*\2[^\n]*/g;
  const contracts: string[] = [];
  let match: RegExpExecArray | null;
  while ((match = regex.exec(content)) !== null) {
    contracts.push(match[0].trim());
  }
  return contracts;
}

/**
 * Analyze semantic markup in one source file.
 *
 * Block pairing is checked by NAME with a stack (nested blocks must close in
 * order), not by counting START/END occurrences: `START_BLOCK_A … END_BLOCK_B`
 * is an error here (v1 reported "✓ Paired").
 */
export function analyzeMarkup(content: string): MarkupAnalysis {
  // Windows checkouts (git core.autocrlf, some editors) deliver CRLF files.
  // Line-oriented regexes that rely on `.`/`$` would otherwise stop at the `\r`
  // and silently miss contract fields and block markers, so analyse a
  // normalised copy (line numbering is preserved because only `\r` is dropped).
  const source = content.includes("\r") ? content.replace(/\r\n?/g, "\n") : content;
  const markers = collectBlockMarkers(source);
  const blockIssues: MarkupBlockIssue[] = [];
  const stack: { name: string; line: number }[] = [];
  let blockStarts = 0;
  let blockEnds = 0;

  for (const marker of markers) {
    const line = lineOf(source, marker.index);
    if (marker.kind === "start") {
      blockStarts += 1;
      stack.push({ name: marker.name, line });
      continue;
    }
    blockEnds += 1;
    const top = stack.pop();
    if (top === undefined) {
      blockIssues.push({
        code: "STRAY_END_BLOCK",
        message: `END_BLOCK_${marker.name} (line ${line}) has no matching START_BLOCK_${marker.name}`,
        line,
      });
      continue;
    }
    if (top.name !== marker.name) {
      blockIssues.push({
        code: "BLOCK_NAME_MISMATCH",
        message: `END_BLOCK_${marker.name} (line ${line}) closes START_BLOCK_${top.name} (line ${top.line}); block names must match`,
        line,
      });
    }
  }
  for (const open of stack) {
    blockIssues.push({
      code: "UNPAIRED_BLOCK",
      message: `START_BLOCK_${open.name} (line ${open.line}) has no matching END_BLOCK_${open.name}`,
      line: open.line,
    });
  }

  return {
    blockStarts,
    blockEnds,
    blockIssues,
    contract: parseContract(source),
    moduleMap: extractSection(source, "START_MODULE_MAP", "END_MODULE_MAP"),
    changeSummary: extractSection(source, "START_CHANGE_SUMMARY", "END_CHANGE_SUMMARY"),
    functionContracts: extractFunctionContracts(source),
  };
}

// ─── Detector: structural XML validity for every docs/*.xml ─────────────

/**
 * Validate every `docs/**\/*.xml` structurally. Malformed XML is an error with
 * file/line/column; known index roots and entity tag names are checked too.
 */
export function lintXmlFiles(root: string, config: MyGraceConfig): LintIssue[] {
  const issues: LintIssue[] = [];
  const docsDir = join(root, "docs");
  if (!isDirectory(docsDir)) return issues;

  const files = walkFiles(docsDir, { exts: [".xml"], ignoreDirs: config.ignoreDirs });
  for (const filePath of files) {
    const rel = relPath(root, filePath);
    const read = readFileSafe(filePath);
    if (!read.ok) {
      issues.push(
        finding("error", "FILE_UNREADABLE", `Cannot read file: ${read.message}`, {
          file: rel,
          hint: "Check file permissions; lint cannot verify this artifact.",
        })
      );
      continue;
    }

    const parsed = tryParseXml(read.content, filePath);
    if (!parsed.ok) {
      issues.push(xmlInvalidFinding(root, filePath, parsed.issue.message, parsed.issue.line, parsed.issue.column));
      continue;
    }

    const parts = rel.split("/");
    const rootTag = parsed.document.root.tag;

    // `docs/<known-index>.xml` must use the documented root element.
    if (parts.length === 2 && parts[1] !== undefined) {
      const expected = INDEX_ROOT_TAGS[parts[1]];
      if (expected !== undefined && rootTag !== expected) {
        issues.push(
          finding("error", "INDEX_ROOT_TAG", `Expected root <${expected}> but found <${rootTag}>`, {
            file: rel,
            hint: `Rewrite the file so its root element is <${expected}> or restore it from templates/.`,
          })
        );
      }
      continue;
    }

    // `docs/{modules,plans,verification}/<ID>.xml` must contain that ID as root.
    if (parts.length === 3 && parts[1] !== undefined && parts[2] !== undefined) {
      const spec = KINDS.find((candidate) => candidate.entityDir === parts[1]);
      if (spec === undefined) continue;
      const fileName = parts[2];
      if (!fileName.endsWith(".xml") || !fileName.startsWith(spec.prefix)) continue;
      const id = fileName.slice(0, -".xml".length);
      try {
        assertEntityId(spec.kind, id);
      } catch (error) {
        issues.push(
          finding("error", "INVALID_ENTITY_ID", `Invalid ${spec.kind} file name "${fileName}"`, {
            file: rel,
            hint: `Rename the file to match the documented id grammar (see grace-paths).${
              isMyGraceError(error) ? ` ${error.message}` : ""
            }`,
          })
        );
        continue;
      }
      if (rootTag !== id) {
        issues.push(
          finding("error", "ENTITY_TAG_MISMATCH", `Expected root <${id}> but found <${rootTag}>`, {
            file: rel,
            hint: `The root element name must equal the entity id (${id}).`,
          })
        );
      }
    }
  }
  return issues;
}

// ─── Detector: index ↔ entity sync, drift, paths, dependencies ──────────

function pushDrift(
  issues: LintIssue[],
  severity: "error" | "warning",
  code: string,
  message: string,
  file: string,
  hint?: string
): void {
  issues.push(finding(severity, code, message, { file, ...(hint === undefined ? {} : { hint }) }));
}

function compareSimpleField(
  issues: LintIssue[],
  code: string,
  label: string,
  tag: string,
  indexFileRel: string,
  indexValue: string | undefined,
  fileValue: string | undefined
): void {
  if (indexValue === undefined || fileValue === undefined) return;
  if (indexValue.trim() === fileValue.trim()) return;
  pushDrift(
    issues,
    "warning",
    code,
    `${label} drift: ${tag} has "${fileValue.trim()}" in file but "${indexValue.trim()}" in index`,
    indexFileRel,
    `Update either docs/${indexFileRel} or the entity file so ${label} matches.`
  );
}

function compareDependsField(
  issues: LintIssue[],
  tag: string,
  indexFileRel: string,
  indexValue: string | undefined,
  fileValue: string | undefined
): void {
  if (indexValue === undefined || fileValue === undefined) return;
  const normalize = (value: string): string =>
    value
      .split(/[,;]/)
      .map((part) => part.trim())
      .filter((part) => part !== "" && !/^(?:none|n\/a|-|—|empty)$/i.test(part))
      .sort()
      .join(",");
  if (normalize(indexValue) === normalize(fileValue)) return;
  pushDrift(
    issues,
    "warning",
    "DEPENDS_DRIFT",
    `DEPENDS drift: ${tag} has "${fileValue.trim()}" in file but "${indexValue.trim()}" in index`,
    indexFileRel,
    "Update either the index DEPENDS attribute or the file <depends> element."
  );
}

function lintModuleEntry(
  issues: LintIssue[],
  root: string,
  indexFileRel: string,
  entry: { tag: string; attrs: Record<string, string> },
  document: XmlDocument,
  indexSet: ReadonlySet<string>
): void {
  const tag = entry.tag;
  const entity = document.root;
  compareSimpleField(issues, "NAME_DRIFT", "NAME", tag, indexFileRel, attrFromRecord(entry.attrs, "NAME", "name"), attrFromElement(entity, "NAME", "name"));
  compareSimpleField(issues, "TYPE_DRIFT", "TYPE", tag, indexFileRel, attrFromRecord(entry.attrs, "TYPE", "type"), attrFromElement(entity, "TYPE", "type"));
  compareSimpleField(
    issues,
    "STATUS_DRIFT",
    "STATUS",
    tag,
    indexFileRel,
    attrFromRecord(entry.attrs, "STATUS", "status"),
    attrFromElement(entity, "STATUS", "status")
  );
  compareSimpleField(issues, "PATH_DRIFT", "PATH", tag, indexFileRel, attrFromRecord(entry.attrs, "PATH", "path"), descendantText(document, "path"));
  compareDependsField(issues, tag, indexFileRel, attrFromRecord(entry.attrs, "DEPENDS", "depends"), descendantText(document, "depends"));
  compareSimpleField(
    issues,
    "VERIFICATION_REF_DRIFT",
    "VERIFICATION_REF",
    tag,
    indexFileRel,
    attrFromRecord(entry.attrs, "VERIFICATION_REF", "verification_ref", "verification-ref"),
    descendantText(document, "verification-ref")
  );

  // PATH existence + containment (requirement: error when the module source is missing).
  const declaredPath = attrFromRecord(entry.attrs, "PATH", "path")?.trim() ?? "";
  if (declaredPath !== "") {
    let resolvedPath: string | null = null;
    try {
      resolvedPath = resolveWithin(root, declaredPath, "module PATH");
    } catch (error) {
      issues.push(
        finding(
          "error",
          "PATH_UNSAFE",
          `Module ${tag} PATH "${declaredPath}" escapes the project root`,
          {
            file: indexFileRel,
            hint: isMyGraceError(error) ? error.hint ?? error.message : "Use a project-relative path.",
          }
        )
      );
    }
    if (resolvedPath !== null && !existsSync(resolvedPath)) {
      issues.push(
        finding("error", "MODULE_PATH_NOT_FOUND", `Module ${tag} PATH "${declaredPath}" does not exist`, {
          file: indexFileRel,
          hint: "Create the source file or fix PATH in graph-index.xml.",
        })
      );
    }
  }

  // DEPENDS cross-check: every declared dependency must exist in the index.
  // An import-vs-DEPENDS heuristic is intentionally NOT implemented: parsing
  // imports for 10+ languages would be noisy/unreliable; index integrity is the
  // enforceable invariant here (see ROADMAP G3).
  const dependsRaw = attrFromRecord(entry.attrs, "DEPENDS", "depends")?.trim() ?? "";
  if (dependsRaw !== "") {
    const dependencies = dependsRaw
      .split(/[,;]/)
      .map((part) => part.trim())
      .filter((part) => part !== "");
    for (const dependency of dependencies) {
      try {
        assertEntityId("module", dependency);
      } catch (error) {
        issues.push(
          finding("error", "INVALID_DEPENDENCY_ID", `Module ${tag} has an invalid dependency id "${dependency}"`, {
            file: indexFileRel,
            hint: isMyGraceError(error) ? error.message : "Dependency ids must look like M-XXX.",
          })
        );
        continue;
      }
      if (!indexSet.has(dependency)) {
        issues.push(
          finding("error", "UNKNOWN_DEPENDENCY", `Module ${tag} depends on ${dependency}, which is not in ${indexFileRel}`, {
            file: indexFileRel,
            hint: `Add module ${dependency} to the index (and its file), or remove it from DEPENDS.`,
          })
        );
      }
    }
  }
}

function lintPhaseEntry(
  issues: LintIssue[],
  indexFileRel: string,
  entry: { tag: string; attrs: Record<string, string> },
  document: XmlDocument
): void {
  const tag = entry.tag;
  compareSimpleField(issues, "PHASE_NAME_DRIFT", "Phase name", tag, indexFileRel, attrFromRecord(entry.attrs, "name", "NAME"), attrFromElement(document.root, "name", "NAME"));
  compareSimpleField(
    issues,
    "PHASE_STATUS_DRIFT",
    "Phase status",
    tag,
    indexFileRel,
    attrFromRecord(entry.attrs, "status", "STATUS"),
    attrFromElement(document.root, "status", "STATUS")
  );
  const declaredSteps = attrFromRecord(entry.attrs, "steps", "STEPS");
  if (declaredSteps !== undefined) {
    const expected = Number.parseInt(declaredSteps, 10);
    const actual = childElements(document.root).filter((child) => /^step-/.test(child.tag)).length;
    if (Number.isFinite(expected) && expected !== actual) {
      pushDrift(
        issues,
        "warning",
        "PHASE_STEPS_DRIFT",
        `Phase steps drift: ${tag} index declares ${expected} step(s) but the file has ${actual}`,
        indexFileRel,
        "Update the steps attribute or add/remove <step-*> elements."
      );
    }
  }
}

function lintVerificationEntry(
  issues: LintIssue[],
  indexFileRel: string,
  entry: { tag: string; attrs: Record<string, string> },
  document: XmlDocument
): void {
  const tag = entry.tag;
  compareSimpleField(
    issues,
    "VERIFICATION_MODULE_DRIFT",
    "Verification MODULE",
    tag,
    indexFileRel,
    attrFromRecord(entry.attrs, "MODULE", "module"),
    attrFromElement(document.root, "MODULE", "module")
  );
  compareSimpleField(
    issues,
    "VERIFICATION_PRIORITY_DRIFT",
    "Verification PRIORITY",
    tag,
    indexFileRel,
    attrFromRecord(entry.attrs, "PRIORITY", "priority"),
    attrFromElement(document.root, "PRIORITY", "priority")
  );
  compareSimpleField(
    issues,
    "VERIFICATION_STATUS_DRIFT",
    "Verification STATUS",
    tag,
    indexFileRel,
    attrFromRecord(entry.attrs, "STATUS", "status"),
    attrFromElement(document.root, "STATUS", "status")
  );
}

/**
 * Index ↔ per-entity file consistency for one index.
 *
 * Kept intentionally narrow (no budgets/caps, those have their own detectors)
 * and signature-compatible with v1 (4 args, optional config 5th).
 */
export function lintIndexSync(
  root: string,
  indexFile: string,
  entityDirName: string,
  prefix: string,
  _config?: MyGraceConfig
): LintIssue[] {
  const issues: LintIssue[] = [];
  const spec = kindForIndexFile(indexFile);
  const indexFileRel = `docs/${indexFile}`;
  const indexPath = join(root, "docs", indexFile);

  if (!existsSync(indexPath)) {
    issues.push(
      finding("error", "MISSING_INDEX_FILE", `Missing ${indexFileRel} — run mygrace setup init`, {
        file: indexFileRel,
        hint: "Run `mygrace setup init --path .` to create the index from templates.",
      })
    );
    return issues;
  }

  const indexRead = readIndexFileSafe(indexPath);
  if (indexRead.error !== undefined) {
    issues.push(
      xmlInvalidFinding(
        root,
        indexPath,
        indexRead.error.message.replace(/^Invalid XML:\s*/, ""),
        indexRead.error.line,
        indexRead.error.column
      )
    );
    return issues;
  }

  return lintEntityEntries(root, indexFileRel, entityDirName, prefix, indexRead.entries, spec);
}

/** Duplicate ids across a resolved entry list (flat index or flat+shards union). */
function lintDuplicateEntries(
  entries: readonly { tag: string }[],
  indexFileRel: string
): LintIssue[] {
  const issues: LintIssue[] = [];
  const seen = new Map<string, number>();
  for (const entry of entries) seen.set(entry.tag, (seen.get(entry.tag) ?? 0) + 1);
  for (const [tag, count] of seen) {
    if (count <= 1) continue;
    issues.push(
      finding("error", "DUPLICATE_INDEX_ENTRY", `Duplicate index entry: ${tag} appears ${count} times in ${indexFileRel}`, {
        file: indexFileRel,
        hint: "Keep exactly one entry per id; merge the attributes (flat and sharded indexes count together).",
      })
    );
  }
  return issues;
}

/**
 * Shared index↔entity consistency logic for a resolved entry list.
 *
 * Used by `lintIndexSync` for flat indexes and by `lintGraphIndex` for the
 * transparent union of flat root entries and shard entries, so a sharded
 * project is validated exactly like a flat one (duplicates, orphan/missing
 * entities, field drift, PATH existence and DEPENDS integrity).
 */
function lintEntityEntries(
  root: string,
  indexFileRel: string,
  entityDirName: string,
  prefix: string,
  entries: readonly { tag: string; attrs: Record<string, string> }[],
  spec: EntityKindSpec | undefined
): LintIssue[] {
  const issues: LintIssue[] = [];

  const entityDirAbs = join(root, "docs", entityDirName);
  if (!existsSync(entityDirAbs)) {
    issues.push(
      finding("error", "MISSING_ENTITY_DIR", `Missing docs/${entityDirName}/ directory`, {
        file: `docs/${entityDirName}`,
        hint: "Create the directory (and its .gitkeep) or run `mygrace setup init`.",
      })
    );
    return issues;
  }
  if (!isDirectory(entityDirAbs)) {
    issues.push(
      finding("error", "MISSING_ENTITY_DIR", `docs/${entityDirName} is not a directory`, {
        file: `docs/${entityDirName}`,
        hint: "Remove the file and create the directory instead.",
      })
    );
    return issues;
  }

  const indexSet = new Set(entries.map((entry) => entry.tag));

  // Duplicate index entries are always an error (ambiguous id resolution).
  issues.push(...lintDuplicateEntries(entries, indexFileRel));

  // Entity files on disk (validated against the id grammar).
  const files = listEntityFiles(entityDirAbs, prefix);
  const validFiles: string[] = [];
  const fileSet = new Set<string>();
  for (const fileName of files) {
    const id = fileName.replace(/\.xml$/, "");
    let valid = true;
    try {
      if (spec !== undefined) assertEntityId(spec.kind, id);
    } catch {
      valid = false;
    }
    if (!valid) {
      issues.push(
        finding("error", "INVALID_ENTITY_ID", `Invalid ${entityDirName} file name "${fileName}"`, {
          file: `docs/${entityDirName}/${fileName}`,
          hint: "Rename the file to match the documented id grammar." + (spec === undefined ? "" : ` (${spec.kind} id)`),
        })
      );
      continue;
    }
    validFiles.push(fileName);
    fileSet.add(id);
  }

  for (const entry of entries) {
    if (!fileSet.has(entry.tag)) {
      issues.push(
        finding("error", "ORPHANED_INDEX_ENTRY", `Orphaned index entry: ${entry.tag} (no ${entityDirName}/${entry.tag}.xml)`, {
          file: indexFileRel,
          hint: `Create docs/${entityDirName}/${entry.tag}.xml or remove the entry.`,
        })
      );
    }
  }
  for (const fileName of validFiles) {
    const id = fileName.replace(/\.xml$/, "");
    if (!indexSet.has(id)) {
      issues.push(
        finding("error", "MISSING_INDEX_ENTRY", `Missing index entry: ${id} (file exists in ${entityDirName}/ but not in docs/${indexFileRel})`, {
          file: `docs/${entityDirName}/${fileName}`,
          hint: `Add <${id} …/> to docs/${indexFileRel}.`,
        })
      );
    }
  }

  // Field drift for entities that have a file.
  for (const entry of entries) {
    if (!fileSet.has(entry.tag)) continue;
    const filePath = join(entityDirAbs, `${entry.tag}.xml`);
    if (!existsSync(filePath)) continue;
    const document = readEntityDocument(filePath);
    if (document === null) continue; // XML_INVALID is reported by lintXmlFiles
    if (spec === undefined) continue;
    switch (spec.kind) {
      case "module":
        lintModuleEntry(issues, root, indexFileRel, entry, document, indexSet);
        break;
      case "phase":
        lintPhaseEntry(issues, indexFileRel, entry, document);
        break;
      case "verification":
        lintVerificationEntry(issues, indexFileRel, entry, document);
        break;
    }
  }

  return issues;
}

/**
 * Shard-aware validation of `docs/graph-index.xml` (ADR-6).
 *
 * Structural shard findings come from `loadGraphIndex`; when the shard layer is
 * broken the entity-level checks are skipped to avoid a cascade of false
 * orphan/missing findings. When it is healthy, the union of flat + shard
 * entries is validated with the same rules as a flat index.
 */
export function lintGraphIndex(root: string, config?: MyGraceConfig): LintIssue[] {
  const issues: LintIssue[] = [];
  const indexPath = join(root, "docs", "graph-index.xml");
  if (!existsSync(indexPath)) {
    issues.push(
      finding("error", "MISSING_INDEX_FILE", "Missing docs/graph-index.xml — run mygrace setup init", {
        file: "docs/graph-index.xml",
        hint: "Run `mygrace setup init --path .` to create the index from templates.",
      })
    );
    return issues;
  }

  const loaded = loadGraphIndex(root, config);
  issues.push(...loaded.findings);
  if (loaded.findings.some((item) => item.severity === "error")) {
    // Structural shard problems are fatal for drift checks, but duplicate ids
    // are still meaningful across whatever entries could be read.
    issues.push(...lintDuplicateEntries(loaded.entries, "docs/graph-index.xml"));
    return issues;
  }

  const spec = kindForIndexFile("graph-index.xml");
  issues.push(...lintEntityEntries(root, "docs/graph-index.xml", "modules", "M-", loaded.entries, spec));
  return issues;
}


// ─── Detectors: caps and budgets from mygrace.config.json ──────────────

/** Index line caps (ADR-5) — exceeding a cap is an ERROR, not a warning. */
export function lintIndexCaps(root: string, config: MyGraceConfig): LintIssue[] {
  const issues: LintIssue[] = [];
  const caps: readonly [string, number][] = [
    ["graph-index.xml", config.indexCaps.graph],
    ["plan-index.xml", config.indexCaps.plan],
    ["verification-index.xml", config.indexCaps.verification],
  ];
  for (const [fileName, cap] of caps) {
    const filePath = join(root, "docs", fileName);
    if (!existsSync(filePath)) continue;
    const read = readFileSafe(filePath);
    if (!read.ok) continue; // FILE_UNREADABLE reported by lintXmlFiles
    const lines = physicalLines(read.content);
    if (lines > cap) {
      issues.push(
        finding("error", "INDEX_TOO_LARGE", `docs/${fileName} has ${lines} lines (index cap ${cap})`, {
          file: `docs/${fileName}`,
          hint: "Split entries into per-entity files and shard this index, or raise indexCaps in mygrace.config.json.",
        })
      );
    }
  }
  return issues;
}

/** Entity line budgets (ADR-2/ADR-5) — outside [min, max] is a WARNING. */
export function lintEntityBudgets(root: string, config: MyGraceConfig): LintIssue[] {
  const issues: LintIssue[] = [];
  for (const spec of KINDS) {
    const [min, max] = config.sizeBudgets[spec.budget];
    const read = readIndexFileSafe(join(root, "docs", spec.indexFile));
    if (read.error !== undefined || read.entries.length === 0) continue;
    const dirAbs = join(root, "docs", spec.entityDir);
    const seen = new Set<string>();
    for (const entry of read.entries) {
      if (seen.has(entry.tag)) continue;
      seen.add(entry.tag);
      const filePath = join(dirAbs, `${entry.tag}.xml`);
      if (!existsSync(filePath)) continue;
      const content = readFileSafe(filePath);
      if (!content.ok) continue;
      const lines = physicalLines(content.content);
      if (lines < min) {
        issues.push(
          finding(
            "warning",
            "ENTITY_TOO_SMALL",
            `docs/${spec.entityDir}/${entry.tag}.xml has ${lines} lines, below the ${min}-line minimum (sizeBudgets.${spec.budget} = [${min}, ${max}])`,
            {
              file: `docs/${spec.entityDir}/${entry.tag}.xml`,
              hint: `Add the contract/annotations the methodology expects, or adjust sizeBudgets.${spec.budget} in mygrace.config.json.`,
            }
          )
        );
      } else if (lines > max) {
        issues.push(
          finding(
            "warning",
            "ENTITY_TOO_LARGE",
            `docs/${spec.entityDir}/${entry.tag}.xml has ${lines} lines, above the ${max}-line maximum (sizeBudgets.${spec.budget} = [${min}, ${max}])`,
            {
              file: `docs/${spec.entityDir}/${entry.tag}.xml`,
              hint: `Move detail into the source/verification artifacts or split the entity, or adjust sizeBudgets.${spec.budget} in mygrace.config.json.`,
            }
          )
        );
      }
    }
  }
  return issues;
}

// ─── Detectors: verification contract / refs / tags ─────────────────────

/** Verification reference integrity in both directions (all refs, not only the first). */
export function lintVerificationRefs(root: string): LintIssue[] {
  const issues: LintIssue[] = [];
  const moduleEntries = loadGraphIndex(root).entries;
  const verificationsIndex = readIndexFileSafe(join(root, "docs", "verification-index.xml"));
  const verificationIds = new Set(verificationsIndex.entries.map((entry) => entry.tag));
  const verDirRel = "docs/verification";
  const verDirAbs = join(root, "docs", "verification");

  const checkRef = (ref: string, sourceRel: string): void => {
    try {
      assertEntityId("verification", ref);
    } catch (error) {
      issues.push(
        finding("error", "INVALID_VERIFICATION_REF", `Invalid verification ref "${ref}"`, {
          file: sourceRel,
          hint: isMyGraceError(error) ? error.message : "Refs must look like V-M-XXX.",
        })
      );
      return;
    }
    if (!existsSync(join(verDirAbs, `${ref}.xml`))) {
      issues.push(
        finding("error", "MISSING_VERIFICATION_REF", `Verification ref ${ref} points to a non-existent file (${verDirRel}/${ref}.xml)`, {
          file: sourceRel,
          hint: "Create the verification file or fix the ref.",
        })
      );
      return;
    }
    if (verificationIds.size > 0 && !verificationIds.has(ref)) {
      issues.push(
        finding("error", "VERIFICATION_REF_NOT_IN_INDEX", `Verification ref ${ref} is not listed in docs/verification-index.xml`, {
          file: sourceRel,
          hint: `Add <${ref} …/> to docs/verification-index.xml.`,
        })
      );
    }
  };

  for (const entry of moduleEntries) {
    const modulePath = join(root, "docs", "modules", `${entry.tag}.xml`);
    if (!existsSync(modulePath)) continue;
    const document = readEntityDocument(modulePath);
    if (document === null) continue;
    const moduleRel = `docs/modules/${entry.tag}.xml`;
    const refs = findElements(document, (element) => element.tag === "verification-ref")
      .map((element) => textOf(element))
      .filter((value) => value !== "");
    for (const ref of refs) checkRef(ref, moduleRel);

    const indexRef = attrFromRecord(entry.attrs, "VERIFICATION_REF", "verification_ref");
    if (indexRef !== undefined && indexRef.trim() !== "") checkRef(indexRef.trim(), "docs/graph-index.xml");
  }
  return issues;
}

/**
 * Legacy placement: `<module-checks>` belongs in docs/verification/V-M-XXX.xml
 * (canonical per templates/skills/ADR-1). A module-file copy is a deprecation
 * warning, never an error (security-impl's grace-test still falls back to it).
 */
export function lintDeprecatedModuleChecks(root: string): LintIssue[] {
  const issues: LintIssue[] = [];
  const moduleEntries = loadGraphIndex(root).entries;
  const verIndex = readIndexFileSafe(join(root, "docs", "verification-index.xml"));
  const verificationIds = new Set(verIndex.entries.map((entry) => entry.tag));

  for (const entry of moduleEntries) {
    const modulePath = join(root, "docs", "modules", `${entry.tag}.xml`);
    if (!existsSync(modulePath)) continue;
    const document = readEntityDocument(modulePath);
    if (document === null) continue;
    const hasChecks = findElements(document, (element) => element.tag === "module-checks").length > 0;
    if (!hasChecks) continue;

    const declaredRef = attrFromRecord(entry.attrs, "VERIFICATION_REF", "verification_ref")
      ?? descendantText(document, "verification-ref")
      ?? "";
    const candidateRefs = [
      declaredRef.trim(),
      `V-${entry.tag}`,
    ].filter((ref) => ref !== "");
    const verificationRef = candidateRefs.find(
      (ref) => verificationIds.size === 0 || verificationIds.has(ref)
    ) ?? candidateRefs[0] ?? `V-${entry.tag}`;
    const verificationPath = join(root, "docs", "verification", `${verificationRef}.xml`);

    let locationOk = false;
    if (existsSync(verificationPath)) {
      const verificationDocument = readEntityDocument(verificationPath);
      locationOk =
        verificationDocument !== null &&
        findElements(verificationDocument, (element) => element.tag === "module-checks").length > 0;
    }
    if (locationOk) continue;

    issues.push(
      finding(
        "warning",
        "MODULE_CHECKS_DEPRECATED_LOCATION",
        `Deprecated <module-checks> location: ${entry.tag} defines checks in docs/modules/${entry.tag}.xml; canonical location is docs/verification/${verificationRef}.xml`,
        {
          file: `docs/modules/${entry.tag}.xml`,
          hint: `Move the <module-checks> block to docs/verification/${verificationRef}.xml (module-file checks are a legacy fallback).`,
        }
      )
    );
  }
  return issues;
}

/** Generic tag conventions: id tags (M-XXX, Phase-N, V-M-XXX) instead of <Module>/<Phase>/... */
export function lintXmlTags(root: string, config?: MyGraceConfig): LintIssue[] {
  const issues: LintIssue[] = [];
  const docsDir = join(root, "docs");
  if (!isDirectory(docsDir)) return issues;
  const ignoreDirs = config?.ignoreDirs ?? cloneDefault().ignoreDirs;
  for (const filePath of walkFiles(docsDir, { exts: [".xml"], ignoreDirs })) {
    const read = readFileSafe(filePath);
    if (!read.ok) continue;
    const parsed = tryParseXml(read.content, filePath);
    if (!parsed.ok) continue; // XML_INVALID reported by lintXmlFiles
    const rel = relPath(root, filePath);
    const reported = new Set<string>();
    for (const element of parsed.document.elements) {
      if (!GENERIC_XML_TAGS.has(element.tag) || reported.has(element.tag)) continue;
      reported.add(element.tag);
      issues.push(
        finding("warning", "GENERIC_XML_TAG", `Generic XML tag <${element.tag}> detected; use a unique id tag instead`, {
          file: rel,
          hint: "Use M-XXX for modules, Phase-N for phases, V-M-XXX for verifications (see templates/).",
        })
      );
    }
  }
  return issues;
}

// ─── Detector: semantic markup in source files ──────────────────────────

function resolveConfig(root: string, config?: MyGraceConfig): MyGraceConfig {
  if (config !== undefined) return config;
  const loaded = tryLoadConfig(root);
  return loaded.ok ? loaded.result.config : cloneDefault();
}

/** Semantic markup over configured source dirs (ADR-5: no hardcoded `src/`). */
export function lintMarkup(root: string, config?: MyGraceConfig): LintIssue[] {
  const issues: LintIssue[] = [];
  const cfg = resolveConfig(root, config);

  for (const sourceDir of cfg.sourceDirs) {
    const fullDir = join(root, sourceDir);
    if (!existsSync(fullDir) || !isDirectory(fullDir)) continue;
    const files = walkFiles(fullDir, { ignoreDirs: cfg.ignoreDirs, exts: cfg.markupExts });
    for (const filePath of files) {
      const rel = relPath(root, filePath);
      const read = readFileSafe(filePath);
      if (!read.ok) {
        issues.push(
          finding("error", "FILE_UNREADABLE", `Cannot read source file: ${read.message}`, {
            file: rel,
            hint: "Check file permissions; lint cannot verify this file's markup.",
          })
        );
        continue;
      }
      const analysis = analyzeMarkup(read.content);
      for (const blockIssue of analysis.blockIssues) {
        issues.push(
          finding("error", blockIssue.code, blockIssue.message, {
            file: rel,
            line: blockIssue.line,
            hint: "Every START_BLOCK_X needs a matching END_BLOCK_X with the same name, properly nested.",
          })
        );
      }
      if (analysis.blockStarts > 2 && analysis.contract === undefined) {
        issues.push(
          finding("warning", "MISSING_MODULE_CONTRACT", `File has ${analysis.blockStarts} semantic blocks but no MODULE_CONTRACT — consider adding one`, {
            file: rel,
            hint: "Add START_MODULE_CONTRACT … END_MODULE_CONTRACT with PURPOSE, SCOPE, DEPENDS and LINKS.",
          })
        );
      }
      if (analysis.contract !== undefined) {
        for (const field of CONTRACT_FIELDS) {
          const value = analysis.contract.fields[field];
          if (value !== undefined && value.trim() !== "") continue;
          issues.push(
            finding("warning", "CONTRACT_FIELD_MISSING", `MODULE_CONTRACT is missing field ${field}`, {
              file: rel,
              hint: CONTRACT_HINT,
            })
          );
        }
      }
    }
  }
  return issues;
}

// ─── Aggregation ────────────────────────────────────────────────────────

/**
 * Collect every lint finding for a project.
 *
 * Backwards compatible signature used by `grace-status`/`grace-doctor`:
 * `(root, allowMissingDocs)`. Findings are `grace-errors` `Finding` objects
 * (superset of the v1 `{severity,message,file}` shape). An optional explicit
 * config (3rd argument) is mainly for tests.
 */
export function collectLintIssues(
  root: string,
  allowMissingDocs: boolean,
  config?: MyGraceConfig
): LintIssue[] {
  const issues: LintIssue[] = [];
  let cfg: MyGraceConfig;

  if (config !== undefined) {
    cfg = config;
  } else {
    const loaded = tryLoadConfig(root);
    if (loaded.ok) {
      cfg = loaded.result.config;
    } else {
      cfg = cloneDefault();
      issues.push(
        finding("error", "CONFIG_INVALID", loaded.error.message, {
          file: loaded.error.file,
          hint: loaded.error.hint,
        })
      );
    }
  }

  const docsExist = existsSync(join(root, "docs", "graph-index.xml"));
  if (docsExist) {
    issues.push(...lintXmlFiles(root, cfg));
    issues.push(...lintGraphIndex(root, cfg));
    issues.push(...lintIndexSync(root, "plan-index.xml", "plans", "Phase-", cfg));
    issues.push(...lintIndexSync(root, "verification-index.xml", "verification", "V-M-", cfg));
    issues.push(...lintIndexCaps(root, cfg));
    issues.push(...lintEntityBudgets(root, cfg));
    issues.push(...lintVerificationRefs(root));
    issues.push(...lintDeprecatedModuleChecks(root));
    issues.push(...lintXmlTags(root, cfg));
  } else if (!allowMissingDocs) {
    for (const indexFile of ["graph-index.xml", "plan-index.xml", "verification-index.xml"]) {
      issues.push(
        finding("error", "MISSING_INDEX_FILE", `Missing docs/${indexFile} — run mygrace setup init`, {
          file: indexFile,
          hint: "Run `mygrace setup init --path .` to bootstrap the docs/ structure.",
        })
      );
    }
  } else if (!isDirectory(root)) {
    issues.push(
      finding("error", "PATH_NOT_FOUND", `Lint path does not exist or is not a directory: ${root}`, {
        file: root,
        hint: "Pass an existing project directory to --path.",
      })
    );
  }

  // Markup is checked independently of docs/ (source trees can exist first).
  issues.push(...lintMarkup(root, cfg));

  return dedupeFindings(issues);
}

// ─── Incremental lint scope (--changed) ────────────────────────────────

/** Index-layer files: changing one means the full index checks must run. */
const INDEX_LAYER_FILES: readonly string[] = [
  "docs/graph-index.xml",
  "docs/plan-index.xml",
  "docs/verification-index.xml",
];

/** Generated index shards are index-layer files too (ADR-6). */
const SHARD_FILE_RE = /^docs\/(?:modules|verification|plans)\/shard-[^/]+\.xml$/u;

const MODULE_ENTITY_RE = /^docs\/modules\/([A-Za-z0-9_-]+)\.xml$/u;
const VERIFICATION_ENTITY_RE = /^docs\/verification\/(V-M-[A-Za-z0-9_-]+)\.xml$/u;
const PHASE_ENTITY_RE = /^docs\/plans\/(Phase-[0-9]+[A-Za-z]?)\.xml$/u;

const GIT_TIMEOUT_MS = 2000;

/** Findings produced by the source-markup scanner (as opposed to index/entity checks). */
const MARKUP_CODES: ReadonlySet<string> = new Set([
  "UNPAIRED_BLOCK",
  "BLOCK_NAME_MISMATCH",
  "STRAY_END_BLOCK",
  "MISSING_MODULE_CONTRACT",
  "CONTRACT_FIELD_MISSING",
]);

export interface ChangedScope {
  /** Every changed file, project-relative and sorted. */
  changed: string[];
  /** Changed files that fall inside the lint scope (index, entity, docs XML or configured source). */
  scanned: string[];
  /** Changed files that are outside the lint scope (unknown type/extension, outside the project). */
  skipped: string[];
}

export interface ChangedFileOptions {
  /** Git revision to diff against (default HEAD). */
  base?: string;
  /** Explicit comma/space separated file list; works without git. */
  files?: string;
}

interface GitResult {
  ok: boolean;
  stdout: string;
  message: string;
}

function runGit(root: string, args: readonly string[]): GitResult {
  const result = spawnSync("git", ["-C", root, ...args], {
    encoding: "utf-8",
    timeout: GIT_TIMEOUT_MS,
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.error !== undefined) {
    return { ok: false, stdout: "", message: result.error.message };
  }
  if (result.status !== 0) {
    return {
      ok: false,
      stdout: result.stdout ?? "",
      message: (result.stderr ?? "").trim() || `git ${args.join(" ")} exited ${result.status ?? "?"}`,
    };
  }
  return { ok: true, stdout: result.stdout ?? "", message: "" };
}

function normalizeChangedPath(value: string): string | null {
  const candidate = value.trim().replaceAll("\\", "/");
  if (candidate === "") return null;
  try {
    assertSafeRelativePath(candidate, "changed file path");
  } catch {
    return null;
  }
  return candidate;
}

/** Parse `--files a,b,c` (comma and/or whitespace separated); unsafe paths are rejected. */
export function parseChangedFilesArg(value: string): string[] {
  const parsed: string[] = [];
  for (const part of value.split(/[,\s]+/u)) {
    const normalized = normalizeChangedPath(part);
    if (normalized !== null && !parsed.includes(normalized)) parsed.push(normalized);
  }
  return parsed.sort();
}

function isIndexLayerFile(file: string): boolean {
  return INDEX_LAYER_FILES.includes(file) || SHARD_FILE_RE.test(file);
}

function classifyEntityFile(file: string): { id: string; kind: "module" | "verification" | "phase" } | null {
  const moduleMatch = file.match(MODULE_ENTITY_RE);
  if (moduleMatch?.[1] !== undefined && moduleMatch[1].startsWith("M-")) {
    return { id: moduleMatch[1], kind: "module" };
  }
  const verificationMatch = file.match(VERIFICATION_ENTITY_RE);
  if (verificationMatch?.[1] !== undefined) return { id: verificationMatch[1], kind: "verification" };
  const phaseMatch = file.match(PHASE_ENTITY_RE);
  if (phaseMatch?.[1] !== undefined) return { id: phaseMatch[1], kind: "phase" };
  return null;
}

function isSourceFile(file: string, config: MyGraceConfig): boolean {
  for (const sourceDir of config.sourceDirs) {
    const prefix = `${sourceDir.replace(/\/+$/u, "")}/`;
    if (!file.startsWith(prefix)) continue;
    if (config.markupExts.some((extension) => file.endsWith(extension))) return true;
  }
  return false;
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

/**
 * Resolve the changed-file set for `lint --changed`.
 *
 * `--files` takes precedence and needs no git. Otherwise the project must be a
 * git work tree: `git diff --name-only <base>` (default `HEAD`) runs with a 2 s
 * timeout and untracked files are added best-effort. Paths are made relative to
 * the project root (works for subdirectories of a larger repository) and
 * validated against the project path grammar.
 */
export function resolveChangedFiles(
  root: string,
  options: ChangedFileOptions = {}
): { source: "files" | "git"; scope: ChangedScope } {
  const explicit = (options.files ?? "").trim();
  if (explicit !== "") {
    const changed = parseChangedFilesArg(explicit);
    return {
      source: "files",
      scope: { changed, scanned: [], skipped: [] },
    };
  }

  const inside = runGit(root, ["rev-parse", "--is-inside-work-tree"]);
  if (!inside.ok || inside.stdout.trim() !== "true") {
    throw new UsageError("--changed needs a git repository (or explicit --files).", {
      hint: "Run inside a git work tree, or pass changed files explicitly: mygrace lint --changed --files src/a.ts,docs/graph-index.xml.",
    });
  }

  const base = ((options.base ?? "HEAD").trim() || "HEAD") as string;
  if (base.startsWith("-") || !/^[A-Za-z0-9._/@{}~^-]+$/u.test(base)) {
    throw new UsageError(`Invalid --base revision "${base}".`, {
      hint: "Pass a git revision name (default HEAD).",
    });
  }

  const prefixResult = runGit(root, ["rev-parse", "--show-prefix"]);
  const prefix = prefixResult.ok ? prefixResult.stdout.trim() : "";

  const diff = runGit(root, ["diff", "--name-only", base, "--"]);
  if (!diff.ok) {
    throw new UsageError(`git diff failed: ${diff.message}`, {
      hint: "Check --base (default HEAD) and that the repository has at least one commit.",
    });
  }
  const untracked = runGit(root, ["ls-files", "--others", "--exclude-standard"]);

  const rawLines = [
    ...diff.stdout.split("\n"),
    ...(untracked.ok ? untracked.stdout.split("\n") : []),
  ];
  const changed: string[] = [];
  const skipped: string[] = [];
  for (const line of rawLines) {
    const repoPath = line.trim().replaceAll("\\", "/");
    if (repoPath === "") continue;
    let projectPath = repoPath;
    if (prefix !== "") {
      if (!repoPath.startsWith(prefix)) {
        skipped.push(repoPath);
        continue;
      }
      projectPath = repoPath.slice(prefix.length);
    }
    const normalized = normalizeChangedPath(projectPath);
    if (normalized === null) {
      skipped.push(repoPath);
      continue;
    }
    if (!changed.includes(normalized)) changed.push(normalized);
  }
  changed.sort();
  return { source: "git", scope: { changed, scanned: [], skipped: skipped.sort() } };
}

/**
 * Run the full detector set (single source of truth) and keep only findings in
 * the changed scope:
 *
 * - an index-layer file changed → every index/entity-level finding is kept
 *   (full index checks), while markup findings are kept only for changed sources;
 * - only entity files changed → findings for those files plus index findings
 *   that name the changed entity id (drift/orphan/missing/path/depends/refs);
 * - only source files changed → markup findings for exactly those files;
 * - everything else is skipped (a changed README produces no lint findings).
 */
export function collectChangedLintIssues(
  root: string,
  allowMissingDocs: boolean,
  changed: readonly string[],
  config?: MyGraceConfig
): { findings: LintIssue[]; scope: ChangedScope } {
  const cfg = resolveConfig(root, config);
  const full = collectLintIssues(root, allowMissingDocs, cfg);
  const changedSet = new Set(changed);
  const entityIds = new Map<string, "module" | "verification" | "phase">();
  const scanned: string[] = [];
  const skipped: string[] = [];
  let indexChanged = false;

  for (const file of changed) {
    if (isIndexLayerFile(file)) {
      indexChanged = true;
      scanned.push(file);
      continue;
    }
    const entity = classifyEntityFile(file);
    if (entity !== null) {
      entityIds.set(entity.id, entity.kind);
      scanned.push(file);
      continue;
    }
    if (isSourceFile(file, cfg)) {
      scanned.push(file);
      continue;
    }
    if (file.startsWith("docs/") && file.endsWith(".xml")) {
      // Other docs artifacts (requirements/technology/operational-packets/...):
      // structural XML findings for that file are still relevant.
      scanned.push(file);
      continue;
    }
    skipped.push(file);
  }

  const entityTokenMatches = (finding: Finding): boolean => {
    const message = finding.message;
    for (const id of entityIds.keys()) {
      if (new RegExp(`(?:^|[^A-Za-z0-9_-])${escapeRegex(id)}(?:$|[^A-Za-z0-9_-])`, "u").test(message)) return true;
    }
    return false;
  };

  const findings = full.filter((item) => {
    const file = item.file ?? "";
    if (indexChanged) {
      // Full index-level checks; markup only for changed sources.
      if (MARKUP_CODES.has(item.code) && !changedSet.has(file)) return false;
      return true;
    }
    if (changedSet.has(file)) return true;
    if (entityTokenMatches(item)) return true;
    return false;
  });

  return {
    findings,
    scope: {
      changed: [...changed].sort(),
      scanned: scanned.sort(),
      skipped: skipped.sort(),
    },
  };
}

// ─── Command ────────────────────────────────────────────────────────────

function asTypedError(error: unknown): MyGraceError {
  if (isMyGraceError(error)) return error;
  const message = error instanceof Error ? error.message : String(error);
  return new MyGraceError("INTERNAL", message, { exitCode: EXIT.INTERNAL, cause: error });
}

export const lintCommand = defineCommand({
  meta: {
    name: "lint",
    description: "Validate MyGRACE artifacts: XML validity, index↔entity drift, caps/budgets, markup, verification refs (--strict for CI)",
  },
  args: {
    path: { type: "string", default: ".", description: "Project root" },
    format: { type: "string", default: "text", description: "Output format: text or json" },
    allowMissingDocs: { type: "boolean", default: false, description: "Skip document checks when docs/ is absent" },
    strict: { type: "boolean", default: false, description: "Fail (exit 1) when only warnings are found — CI gate" },
    changed: { type: "boolean", default: false, description: "Scope findings to files changed since --base (git) or --files" },
    base: { type: "string", description: "Git revision for --changed (default HEAD)" },
    files: { type: "string", description: "Explicit changed files for --changed (comma separated; works without git)" },
    allowCommands: {
      type: "boolean",
      default: false,
      description: "Explicitly allow configured lint-provider commands for this run (trust-gated)",
    },
    allowUnsafeCommands: {
      type: "boolean",
      default: false,
      description: "One-off opt-in for deny-listed dangerous provider command patterns",
    },
    withoutProviders: {
      type: "boolean",
      default: false,
      description: "Skip configured external lint providers even when trusted",
    },
  },
  run: async ({ args }) => {
    const startedAt = Date.now();
    const format = String(args.format ?? "text");
    if (format !== "text" && format !== "json") {
      throw new UsageError(`Unknown --format "${format}".`, { hint: "Use --format text or --format json." });
    }
    const strict = args.strict === true;
    const allowMissingDocs = args.allowMissingDocs === true;
    const meta = { command: "lint", durationMs: Date.now() - startedAt };
    const changedMode = args.changed === true || typeof args.files === "string";

    let root: string;
    let issues: Finding[] = [];
    let changedScope: ChangedScope | undefined;
    let providerReport: LintProviderReport | null = null;
    try {
      try {
        root = findProjectRoot(args.path);
      } catch (error) {
        if (!allowMissingDocs) throw error;
        root = resolve(args.path);
        if (!existsSync(root) || !isDirectory(root)) {
          throw new UsageError(`Lint path does not exist or is not a directory: ${root}`, {
            hint: "Pass an existing project directory to --path.",
          });
        }
      }
      if (typeof args.base === "string" && args.base !== "" && !changedMode) {
        throw new UsageError("--base requires --changed.", {
          hint: "Use `mygrace lint --changed --base <git-ref>` (or omit --base to use HEAD).",
        });
      }
      const loadedConfig = tryLoadConfig(root);
      if (!loadedConfig.ok) throw loadedConfig.error;
      const config = loadedConfig.result.config;
      providerReport =
        args.withoutProviders === true || config.lintProviders.length === 0
          ? null
          : runLintProviders(root, config, {
              allowCommands: args.allowCommands === true,
              allowUnsafeCommands: args.allowUnsafeCommands === true,
            });
      if (changedMode) {
        const resolved = resolveChangedFiles(root, {
          ...(typeof args.base === "string" ? { base: args.base } : {}),
          ...(typeof args.files === "string" ? { files: args.files } : {}),
        });
        const scoped = collectChangedLintIssues(root, allowMissingDocs, resolved.scope.changed, config);
        issues = scoped.findings;
        changedScope = scoped.scope;
      } else {
        issues = collectLintIssues(root, allowMissingDocs, config);
      }
      if (providerReport !== null) issues.push(...providerReport.findings);
    } catch (error) {
      const typed = asTypedError(error);
      if (format === "json") {
        printJson(createEnvelope({ error: typed, meta: { ...meta, durationMs: Date.now() - startedAt } }));
        process.exit(typed.exitCode);
      }
      process.stderr.write(`mygrace: ${typed.toLine()}\n`);
      process.exit(typed.exitCode);
    }

    meta.durationMs = Date.now() - startedAt;

    if (format === "json") {
      const envelope = createEnvelope({
        data: {
          root,
          strict,
          changed: changedScope !== undefined,
          ...(changedScope !== undefined ? { scope: changedScope } : {}),
          counts: {
            errors: issues.filter((issue) => issue.severity === "error").length,
            warnings: issues.filter((issue) => issue.severity === "warning").length,
          },
          ...(providerReport === null
            ? {}
            : {
                providers: {
                  authorization: providerReport.authorization,
                  runs: providerReport.providers.map((run) => ({
                    name: run.name,
                    adapter: run.adapter,
                    ran: run.ran,
                    authorized: run.authorized,
                    exitCode: run.exitCode,
                    durationMs: run.durationMs,
                    findingCount: run.findingCount,
                    skippedReason: run.skippedReason,
                    error: run.error,
                  })),
                },
              }),
        },
        findings: issues,
        strict,
        meta: { ...meta, root },
      });
      printJson(envelope);
      process.exit(envelope.exitCode);
    }

    const errors = issues.filter((issue) => issue.severity === "error");
    const warnings = issues.filter((issue) => issue.severity === "warning");

    console.log("MyGRACE Lint Report");
    console.log("===================");
    console.log(`Errors:   ${errors.length}`);
    console.log(`Warnings: ${warnings.length}`);
    if (changedScope !== undefined) {
      console.log(`Scope:    ${changedScope.changed.length} changed file(s) (scanned: ${changedScope.scanned.length}, skipped: ${changedScope.skipped.length})`);
    }
    console.log();

    const formatFinding = (issue: Finding): string => {
      const location = issue.line === undefined ? issue.file ?? "project" : `${issue.file ?? "project"}:${issue.line}`;
      return `  ${issue.severity === "error" ? "✗" : "⚠"} [${location}] ${issue.message} [${issue.code}]`;
    };

    if (providerReport !== null && providerReport.providers.length > 0) {
      const ran = providerReport.providers.filter((run) => run.ran).length;
      const skipped = providerReport.providers.length - ran;
      console.log(`Providers: ${ran} ran, ${skipped} skipped (trust: ${providerReport.authorization.authorized ? "authorized" : "not authorized"})`);
      console.log();
    }
    if (errors.length > 0) {
      console.log("Errors:");
      for (const issue of errors) console.log(formatFinding(issue));
      console.log();
    }
    if (warnings.length > 0) {
      console.log("Warnings:");
      for (const issue of warnings) console.log(formatFinding(issue));
      console.log();
    }
    if (issues.length === 0) {
      console.log("✓ All checks passed. MyGRACE artifacts are consistent.");
    } else if (warnings.length > 0 && errors.length === 0 && !strict) {
      console.log("Warnings do not fail the run; re-run with --strict to enforce them in CI.");
    }

    process.exit(exitCodeForFindings(issues, strict));
  },
});
