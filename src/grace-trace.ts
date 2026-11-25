#!/usr/bin/env bun
/**
 * MyGRACE — `mygrace trace`: requirement → module → verification → tests traceability.
 *
 * Answers the agent question "why does this module exist, what proves it, and
 * what breaks if I change it?" in one bounded read:
 *
 *   module (shard-aware graph index + docs/modules/M-XXX.xml contract)
 *     → verification file + declared test files (existence)
 *     → declared command source (verification → deprecated module → config/default)
 *     → requirement links (structural scan of docs/requirements.xml)
 *     → phases that mention the module (docs/plans/Phase-*.xml + plan index)
 *     → dependents (reverse DEPENDS, one level + transitive closure)
 *
 * Read-only. Missing links are coded findings: traceability errors (exit 1) for
 * a broken module→verification→tests chain, and info findings for optional
 * links (requirement/phase), so the command stays usable on partial projects.
 * Exit codes follow ADR-3; `--format json` emits the ADR-8 envelope.
 */

// START_MODULE_CONTRACT
//   PURPOSE: Trace one module's full traceability chain (requirement → module → verification → test files →
//            command → phases → dependents) with coded gaps, honest exit codes and a JSON envelope.
//   SCOPE: Read-only docs/ XML reads (graph/verification/plan/requirements indexes + entity files + source
//          test file existence). No command execution, no writes.
//   DEPENDS: grace-common, grace-config, grace-errors, grace-paths, grace-shard, grace-test, grace-xml
//   LINKS: docs/modules/M-TRACE.xml, ROADMAP.md (Wave 3, ADR-3, ADR-4, ADR-6, ADR-8)
// END_MODULE_CONTRACT

// START_MODULE_MAP
//   TRACE_FINDING_CODES      — stable codes for traceability gaps (errors) and optional links (info)
//   TraceModuleInfo/TraceVerification/TraceRequirement/TracePhase/TraceDependents — JSON data shape
//   TraceResult              — full result for library/MCP callers (data + findings + exitCode)
//   resolveTraceModuleId()   — positional id or --module; accepts a verification id too (ADR-4 validation)
//   traceModule()            — pure trace for one module (throws typed errors for usage/config problems)
//   formatTraceText()        — compact human tree used by the CLI
//   parseModuleMapNames()    — tolerant MODULE_MAP line parser (exported for tests)
//   enrichTraceWithCodeSymbols() — optional Octocode symbol check (--code, ADR-9)
//   traceCommand             — `mygrace trace <id> [--module M-XXX] [--path] [--format text|json]`
// END_MODULE_MAP

import { defineCommand } from "citty";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { countLines, findProjectRoot, listEntityFiles, readIndexFileSafe } from "./grace-common";
import { EXIT, UsageError, createEnvelope, exitCodeForFindings, finding } from "./grace-errors";
import type { ExitCode, Finding } from "./grace-errors";
import { loadConfig, tryLoadConfig } from "./grace-config";
import type { MyGraceConfig } from "./grace-config";
import { assertEntityId, assertSafeRelativePath, resolveWithin } from "./grace-paths";
import { loadGraphIndexStrict } from "./grace-shard";
import { collectFileSymbols } from "./grace-code-graph";
import type { GraphLoadResult } from "./grace-shard";
import { childElements, findElements, textOf, tryParseXml } from "./grace-xml";
import type { IndexEntry, XmlDocument, XmlElement } from "./grace-xml";
import {
  hasCheckCommand,
  inspectCheckCommand,
  parseCheckCommand,
  parseOutputFormat,
  parseTestFiles,
  runCommandOutcome,
  validateTestFileEntry,
} from "./grace-test";
import type { CommandOutcome } from "./grace-test";

// START_BLOCK_CODES
/**
 * Stable finding codes emitted by `mygrace trace` (documented for docs-impl).
 *
 * Errors break the module → verification → tests chain and exit 1:
 *   MISSING_VERIFICATION_REF, VERIFICATION_FILE_MISSING, TEST_FILE_MISSING,
 *   MODULE_PATH_MISSING, plus the generic robustness codes MODULE_FILE_MISSING
 *   (indexed module without docs/modules file) and XML_INVALID (a traceability
 *   input could not be parsed). Info findings never change the exit code:
 *   NO_DECLARED_COMMAND, NO_REQUIREMENT_LINK, NO_PHASE_LINK.
 */
export const TRACE_FINDING_CODES = {
  missingVerificationRef: "MISSING_VERIFICATION_REF",
  verificationFileMissing: "VERIFICATION_FILE_MISSING",
  testFileMissing: "TEST_FILE_MISSING",
  modulePathMissing: "MODULE_PATH_MISSING",
  noDeclaredCommand: "NO_DECLARED_COMMAND",
  noRequirementLink: "NO_REQUIREMENT_LINK",
  noPhaseLink: "NO_PHASE_LINK",
  /** Indexed module without its `docs/modules/M-XXX.xml` contract file. */
  moduleFileMissing: "MODULE_FILE_MISSING",
  /** One of the traceability inputs is not well-formed XML (never a crash). */
  xmlInvalid: "XML_INVALID",
  /** MODULE_MAP entry without a matching symbol in the module source file (--code). */
  contractSymbolMissing: "CONTRACT_SYMBOL_MISSING",
  /** Optional code-intelligence tool unavailable (--code degrades to info). */
  integrationUnavailable: "INTEGRATION_UNAVAILABLE",
} as const;

export const TRACE_REQUIREMENTS_FILE = join("docs", "requirements.xml");
export const TRACE_PLAN_INDEX_FILE = join("docs", "plan-index.xml");
export const TRACE_PLANS_DIR = join("docs", "plans");
export const TRACE_VERIFICATION_INDEX_FILE = join("docs", "verification-index.xml");
// END_BLOCK_CODES

// ─── Public data shapes ────────────────────────────────────────────────

export interface TraceModuleInfo {
  id: string;
  name: string;
  type: string;
  status: string;
  /** Indexed source path (project-relative), empty when undeclared. */
  path: string;
  /** Direct dependencies from the shard-aware graph index. */
  depends: string[];
  verificationRef: string | null;
  /** Project-relative module contract file (`docs/modules/M-XXX.xml`). */
  file: string;
  /** False when the indexed module has no contract file. */
  contractFileExists: boolean;
}

export type TraceCommandSource = "verification" | "module" | "config" | "default";

export interface TraceCommand {
  source: TraceCommandSource;
  command: string;
  /** True when execution needs the explicit `--allow-commands` opt-in (ADR-1). */
  requiresShellOptIn: boolean;
  /** Why the opt-in is required (metacharacters, shell interpreter, …). */
  reason?: string;
  /** Project-relative file that declares the command. */
  file?: string;
}

export interface TraceTestFile {
  file: string;
  exists: boolean;
  /** Physical line count, only when the file exists and is readable. */
  lines?: number;
}

export interface TraceVerification {
  id: string | null;
  /** Project-relative verification file path. */
  file: string | null;
  exists: boolean;
  priority: string | null;
  status: string | null;
  testFiles: TraceTestFile[];
  command: TraceCommand;
}

export interface TraceRequirement {
  /** Tag of the deepest matching element in docs/requirements.xml. */
  tag: string;
  file: string;
  /** Collapsed text (or attribute) excerpt, ≤ {@link TRACE_EXCERPT_MAX} chars. */
  excerpt: string;
}

export interface TracePhase {
  id: string;
  /** Project-relative phase file path. */
  file: string;
  status: string | null;
  /** Matched `<step-N>` tag, when the plan links the module from a step. */
  matchedStep: string | null;
  /** Step description excerpt (≤120 chars), when available. */
  matchedStepDescription?: string;
}

export interface TraceDependents {
  /** Modules whose DEPENDS list contains this module (one level, sorted). */
  direct: string[];
  /** Full reverse-dependency closure (includes {@link direct}, sorted). */
  transitive: string[];
  transitiveCount: number;
}

export interface TraceResult {
  root: string;
  module: TraceModuleInfo;
  verification: TraceVerification;
  requirements: TraceRequirement[];
  phases: TracePhase[];
  dependents: TraceDependents;
  findings: Finding[];
  exitCode: ExitCode;
}

/** JSON `data` payload of the ADR-8 envelope (findings live at the envelope level). */
export interface TraceData {
  root: string;
  module: TraceModuleInfo;
  verification: TraceVerification;
  requirements: TraceRequirement[];
  phases: TracePhase[];
  dependents: TraceDependents;
  /** Code-level contract symbol check (only with --code; ADR-9 optional adapter). */
  symbols?: TraceSymbols;
}

/** One MODULE_MAP entry resolved against real code symbols. */
export interface TraceSymbolEntry {
  name: string;
  found: boolean;
  kind?: string;
}

export interface TraceSymbols {
  available: boolean;
  version: string | null;
  entries: TraceSymbolEntry[];
  notes: string[];
}

/** Maximum length of a requirement/step text excerpt. */
export const TRACE_EXCERPT_MAX = 120;

// ─── Small helpers ──────────────────────────────────────────────────────

function collapse(value: string): string {
  return value.replace(/\s+/gu, " ").trim();
}

/** Collapse whitespace and truncate to {@link TRACE_EXCERPT_MAX} chars. */
export function excerptOf(value: string, max = TRACE_EXCERPT_MAX): string {
  const text = collapse(value);
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
}

/** Split a comma/whitespace separated id list (DEPENDS, RelatedModules, …). */
export function splitIdList(value: string | null | undefined): string[] {
  return (value ?? "")
    .split(/[,\s]+/u)
    .map((item) => item.trim())
    .filter((item) => item !== "");
}

interface SafeRead {
  ok: boolean;
  content: string;
  missing: boolean;
  message: string;
}

/** Read a UTF-8 file without throwing (unreadable/missing become data). */
function readTextSafe(path: string): SafeRead {
  try {
    return { ok: true, content: readFileSync(path, "utf-8"), missing: false, message: "" };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | undefined)?.code;
    return {
      ok: false,
      content: "",
      missing: code === "ENOENT",
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

type PathState = "file" | "directory" | "missing" | "unsafe";

/** Classify a project-relative path without ever escaping the project root. */
function classifyPath(root: string, candidate: string): PathState {
  try {
    const safe = assertSafeRelativePath(candidate, "project path");
    const absolute = resolveWithin(root, safe);
    if (!existsSync(absolute)) return "missing";
    return statSync(absolute).isDirectory() ? "directory" : "file";
  } catch {
    return "unsafe";
  }
}

function moduleRelativeFile(moduleId: string): string {
  return join("docs", "modules", `${moduleId}.xml`);
}

// ─── Id resolution (ADR-4: ids are untrusted input) ────────────────────

/**
 * Resolve the requested entity to a module id.
 *
 * Accepts a positional module id (`M-XXX`), a positional verification id
 * (`V-M-XXX`, resolves to its module) and `--module M-XXX`. A conflicting pair
 * or an invalid id is a typed `UsageError` (exit 2).
 */
export function resolveTraceModuleId(positionalId: string | undefined, moduleArg: string | undefined): string {
  const positional = (positionalId ?? "").trim();
  const flag = (moduleArg ?? "").trim();

  let fromPositional: string | null = null;
  if (positional !== "") {
    if (/^V-M-/u.test(positional)) {
      const verificationId = assertEntityId("verification", positional);
      fromPositional = assertEntityId("module", verificationId.slice("V-".length));
    } else {
      fromPositional = assertEntityId("module", positional);
    }
  }

  if (flag !== "") {
    const moduleId = assertEntityId("module", flag);
    if (fromPositional !== null && fromPositional !== moduleId) {
      throw new UsageError(
        `Conflicting ids: positional "${positional}" resolves to ${fromPositional} but --module is ${moduleId}.`,
        { hint: "Pass one id only (positional M-XXX/V-M-XXX or --module M-XXX)." }
      );
    }
    return moduleId;
  }
  if (fromPositional !== null) return fromPositional;
  return assertEntityId("module", undefined);
}

// ─── Structural XML helpers ────────────────────────────────────────────

/** Concatenated descendant text of an element, whitespace-collapsed. */
export function recursiveTextOf(element: XmlElement): string {
  const parts: string[] = [];
  const walk = (node: XmlElement | string): void => {
    if (typeof node === "string") {
      parts.push(node);
      return;
    }
    for (const child of node.children) walk(child);
  };
  for (const child of element.children) walk(child);
  return collapse(parts.join(" "));
}

function elementMentions(element: XmlElement, needles: readonly string[]): boolean {
  const text = recursiveTextOf(element);
  if (needles.some((needle) => text.includes(needle))) return true;
  return Object.values(element.attrs).some((value) => needles.some((needle) => value.includes(needle)));
}

/**
 * Deepest elements whose text or attribute values mention one of the needles.
 *
 * Deepest-only keeps the output actionable: a `<RelatedModules>` leaf is
 * reported instead of every ancestor that transitively contains it.
 */
export function collectDeepestMatches(document: XmlDocument, needles: readonly string[]): XmlElement[] {
  const matches: XmlElement[] = [];
  const visit = (element: XmlElement): boolean => {
    let descendantMatched = false;
    for (const child of childElements(element)) {
      if (visit(child)) descendantMatched = true;
    }
    const selfMatched = elementMentions(element, needles);
    if (selfMatched && !descendantMatched) matches.push(element);
    return selfMatched || descendantMatched;
  };
  for (const child of childElements(document.root)) {
    visit(child);
  }
  return matches;
}

/** Text (or attributes when the element has no text) of a matched element. */
function matchedExcerpt(element: XmlElement): string {
  const text = recursiveTextOf(element);
  if (text !== "") return excerptOf(text);
  const attrs = Object.entries(element.attrs)
    .map(([name, value]) => `${name}="${value}"`)
    .join(" ");
  return excerptOf(attrs);
}

function firstElementText(document: XmlDocument, tag: string): string {
  const element = findElements(document, (candidate) => candidate.tag === tag)[0];
  return element === undefined ? "" : textOf(element).trim();
}

function parseDocumentSafe(content: string, file: string): { document: XmlDocument | null; error?: string } {
  const parsed = tryParseXml(content, file);
  if (parsed.ok) return { document: parsed.document };
  return { document: null, error: parsed.issue.message };
}

// ─── Module + command resolution ───────────────────────────────────────

function findModuleEntry(loaded: GraphLoadResult, moduleId: string): IndexEntry {
  const entry = loaded.entries.find((candidate) => candidate.tag === moduleId);
  if (entry === undefined) {
    throw new UsageError(`Module "${moduleId}" is not present in docs/graph-index.xml.`, {
      hint: "Run `mygrace inspect module list` to see indexed ids, and `mygrace lint` to find index drift.",
    });
  }
  return entry;
}

/**
 * Resolve the declared command and its provenance.
 *
 * Canonical source is the verification file, then the deprecated module file,
 * then the config `testRunner` (source `config`) or the built-in default
 * (source `default`). Malformed XML never throws here: both documents were
 * already parsed by the caller, and the fallback keeps the trace useful.
 */
export function resolveTraceCommand(
  root: string,
  config: MyGraceConfig,
  verification: { content: string | null; file: string | null },
  module: { content: string | null; file: string }
): TraceCommand {
  const fromDocument = (
    content: string | null,
    source: "verification" | "module",
    file: string | null
  ): TraceCommand | null => {
    if (content === null) return null;
    try {
      if (!hasCheckCommand(content)) return null;
      const command = parseCheckCommand(content, "");
      if (command === "") return null;
      const policy = inspectCheckCommand(command);
      return {
        source,
        command,
        requiresShellOptIn: policy.requiresShellOptIn,
        ...(policy.reason === undefined ? {} : { reason: policy.reason }),
        ...(file === null ? {} : { file }),
      };
    } catch {
      return null; // malformed XML is reported as XML_INVALID by the caller
    }
  };

  const fromVerification = fromDocument(verification.content, "verification", verification.file);
  if (fromVerification !== null) return fromVerification;
  const fromModule = fromDocument(module.content, "module", module.file);
  if (fromModule !== null) return fromModule;

  const loadedConfig = tryLoadConfig(root);
  const configDeclaresRunner = loadedConfig.ok && loadedConfig.result.raw?.testRunner !== undefined;
  const policy = inspectCheckCommand(config.testRunner);
  return {
    source: configDeclaresRunner ? "config" : "default",
    command: config.testRunner,
    requiresShellOptIn: policy.requiresShellOptIn,
    ...(policy.reason === undefined ? {} : { reason: policy.reason }),
    ...(configDeclaresRunner ? { file: "mygrace.config.json" } : {}),
  };
}

// ─── Verification stage ────────────────────────────────────────────────

interface VerificationBuild {
  verification: TraceVerification;
  findings: Finding[];
}

function buildVerification(
  root: string,
  config: MyGraceConfig,
  moduleId: string,
  verificationRef: string | null,
  moduleContent: string | null
): VerificationBuild {
  const findings: Finding[] = [];
  const moduleFile = moduleRelativeFile(moduleId);
  const fallbackCommand = resolveTraceCommand(root, config, { content: null, file: null }, { content: moduleContent, file: moduleFile });
  const base: TraceVerification = {
    id: null,
    file: null,
    exists: false,
    priority: null,
    status: null,
    testFiles: [],
    command: fallbackCommand,
  };

  if (verificationRef === null) {
    findings.push(
      finding("error", TRACE_FINDING_CODES.missingVerificationRef, `${moduleId} has no VERIFICATION_REF.`, {
        file: "docs/graph-index.xml",
        hint: "Create docs/verification/V-M-XXX.xml and set VERIFICATION_REF on the module index entry.",
      })
    );
    return { verification: base, findings };
  }

  let verificationId: string;
  try {
    verificationId = assertEntityId("verification", verificationRef);
  } catch {
    findings.push(
      finding(
        "error",
        TRACE_FINDING_CODES.missingVerificationRef,
        `${moduleId} declares an invalid VERIFICATION_REF "${verificationRef}" — it is not a safe verification id.`,
        {
          file: "docs/graph-index.xml",
          hint: "Verification ids match ^V-M-[A-Za-z0-9_-]+$ and must stay inside docs/verification/.",
        }
      )
    );
    return { verification: base, findings };
  }

  const verificationFile = `${join("docs", "verification", `${verificationId}.xml`).split("\\").join("/")}`;
  const parsedRef: TraceVerification = { ...base, id: verificationId, file: verificationFile };
  const state = classifyPath(root, verificationFile);
  if (state !== "file") {
    findings.push(
      finding("error", TRACE_FINDING_CODES.verificationFileMissing, `${verificationId} is declared but ${verificationFile} does not exist.`, {
        file: "docs/graph-index.xml",
        hint: "Create the verification file (mygrace-verification skill) or fix VERIFICATION_REF.",
      })
    );
    return { verification: parsedRef, findings };
  }

  // Priority/status can come from the verification index even if the file body is broken.
  let indexPriority: string | null = null;
  let indexStatus: string | null = null;
  const verificationIndex = readIndexFileSafe(join(root, TRACE_VERIFICATION_INDEX_FILE));
  if (verificationIndex.error !== undefined) {
    findings.push(
      finding("error", TRACE_FINDING_CODES.xmlInvalid, `Cannot read ${TRACE_VERIFICATION_INDEX_FILE}: ${verificationIndex.error.message}`, {
        file: TRACE_VERIFICATION_INDEX_FILE,
        hint: "Fix the verification index XML and re-run.",
      })
    );
  } else {
    const indexEntry = verificationIndex.entries.find((entry) => entry.tag === verificationId);
    indexPriority = (indexEntry?.attrs.PRIORITY ?? "").trim() || null;
    indexStatus = (indexEntry?.attrs.STATUS ?? "").trim() || null;
  }

  const read = readTextSafe(join(root, verificationFile));
  if (!read.ok) {
    findings.push(
      finding("error", TRACE_FINDING_CODES.xmlInvalid, `Cannot read ${verificationFile}: ${read.message}`, {
        file: verificationFile,
        hint: "Check file permissions; the verification contract cannot be traced.",
      })
    );
    return { verification: { ...parsedRef, priority: indexPriority, status: indexStatus }, findings };
  }

  const parsed = parseDocumentSafe(read.content, verificationFile);
  if (parsed.document === null) {
    findings.push(
      finding("error", TRACE_FINDING_CODES.xmlInvalid, `Invalid XML in ${verificationFile}: ${parsed.error ?? "unknown error"}`, {
        file: verificationFile,
        hint: "Fix the XML (every tag must be closed, attributes quoted) and re-run.",
      })
    );
    return { verification: { ...parsedRef, priority: indexPriority, status: indexStatus }, findings };
  }

  const verificationDocument = parsed.document;
  const priority = indexPriority ?? ((verificationDocument.root.attrs.PRIORITY ?? "").trim() || null);
  const status = indexStatus ?? ((verificationDocument.root.attrs.STATUS ?? "").trim() || null);

  // Test files: validate untrusted paths, then check existence and size.
  let declaredTestFiles: string[] = [];
  try {
    declaredTestFiles = parseTestFiles(read.content);
  } catch {
    declaredTestFiles = []; // already unreachable: document parsed successfully
  }
  const testFiles: TraceTestFile[] = [];
  for (const declared of declaredTestFiles) {
    let safeEntry: string;
    try {
      safeEntry = validateTestFileEntry(declared);
    } catch (error) {
      findings.push(
        finding(
          "error",
          TRACE_FINDING_CODES.testFileMissing,
          `${verificationId} declares an unsafe test file "${declared}": ${error instanceof Error ? error.message : String(error)}`,
          {
            file: verificationFile,
            hint: "Test file entries must be plain project-relative paths (no .., absolute paths or leading dashes).",
          }
        )
      );
      testFiles.push({ file: declared, exists: false });
      continue;
    }
    const fileState = classifyPath(root, safeEntry);
    const exists = fileState === "file";
    if (!exists) {
      findings.push(
        finding(
          "error",
          TRACE_FINDING_CODES.testFileMissing,
          `${moduleId} declares test file "${safeEntry}" but it does not exist.`,
          {
            file: verificationFile,
            hint: "Create the test file or fix the path in <test-files>.",
          }
        )
      );
      testFiles.push({ file: safeEntry, exists: false });
      continue;
    }
    const testRead = readTextSafe(join(root, safeEntry));
    testFiles.push({
      file: safeEntry,
      exists: true,
      ...(testRead.ok ? { lines: countLines(testRead.content) } : {}),
    });
  }

  const command = resolveTraceCommand(
    root,
    config,
    { content: read.content, file: verificationFile },
    { content: moduleContent, file: moduleFile }
  );
  if (command.source === "config" || command.source === "default") {
    findings.push(
      finding(
        "info",
        TRACE_FINDING_CODES.noDeclaredCommand,
        `${moduleId} declares no <module-checks>; ${command.source === "config" ? "the config testRunner" : "the default testRunner"} (${command.command}) will be used.`,
        {
          file: verificationFile,
          hint: "Declare <module-checks><check-1>…</check-1></module-checks> to pin the verification command.",
        }
      )
    );
  }

  return {
    verification: {
      id: verificationId,
      file: verificationFile,
      exists: true,
      priority,
      status,
      testFiles,
      command,
    },
    findings,
  };
}

// ─── Requirement + phase stages ────────────────────────────────────────

/** Match requirements whose text/attributes mention the module id or its PATH. */
export function scanRequirements(
  root: string,
  moduleId: string,
  modulePath: string
): { requirements: TraceRequirement[]; findings: Finding[] } {
  const findings: Finding[] = [];
  const file = TRACE_REQUIREMENTS_FILE.split("\\").join("/");
  const absolute = join(root, TRACE_REQUIREMENTS_FILE);
  if (!existsSync(absolute)) {
    findings.push(
      finding("info", TRACE_FINDING_CODES.noRequirementLink, `docs/requirements.xml not found — no requirement link can be recorded.`, {
        file: "docs/requirements.xml",
        hint: "Add docs/requirements.xml (mygrace-plan skill) to trace modules back to requirements.",
      })
    );
    return { requirements: [], findings };
  }

  const read = readTextSafe(absolute);
  if (!read.ok) {
    findings.push(
      finding("error", TRACE_FINDING_CODES.xmlInvalid, `Cannot read ${file}: ${read.message}`, {
        file,
        hint: "Check file permissions; requirement traceability cannot be verified.",
      })
    );
    return { requirements: [], findings };
  }
  const parsed = parseDocumentSafe(read.content, file);
  if (parsed.document === null) {
    findings.push(
      finding("error", TRACE_FINDING_CODES.xmlInvalid, `Invalid XML in ${file}: ${parsed.error ?? "unknown error"}`, {
        file,
        hint: "Fix the requirements XML and re-run.",
      })
    );
    return { requirements: [], findings };
  }

  const needles = [moduleId, ...(modulePath.trim() === "" ? [] : [modulePath.trim()])];
  const matches = collectDeepestMatches(parsed.document, needles);
  if (matches.length === 0) {
    findings.push(
      finding(
        "info",
        TRACE_FINDING_CODES.noRequirementLink,
        `no element in ${file} mentions ${moduleId}${modulePath.trim() === "" ? "" : ` or ${modulePath}`}.`,
        {
          file,
          hint: "Link the module from a requirement (e.g. <RelatedModules>) to keep intent traceable.",
        }
      )
    );
    return { requirements: [], findings };
  }

  return {
    requirements: matches.map((element) => ({ tag: element.tag, file, excerpt: matchedExcerpt(element) })),
    findings,
  };
}

/** Phases whose plan file mentions the module (prefers an explicit `<step-N module=…>`). */
export function scanPhases(root: string, moduleId: string): { phases: TracePhase[]; findings: Finding[] } {
  const findings: Finding[] = [];
  const planIndexFile = TRACE_PLAN_INDEX_FILE.split("\\").join("/");
  const planIndex = readIndexFileSafe(join(root, TRACE_PLAN_INDEX_FILE));
  const planMeta = new Map<string, Record<string, string>>();
  if (planIndex.error !== undefined) {
    findings.push(
      finding("error", TRACE_FINDING_CODES.xmlInvalid, `Cannot read ${planIndexFile}: ${planIndex.error.message}`, {
        file: planIndexFile,
        hint: "Fix the plan index XML and re-run.",
      })
    );
  } else {
    for (const entry of planIndex.entries) {
      if (/^Phase-/u.test(entry.tag)) planMeta.set(entry.tag, entry.attrs);
    }
  }

  const phaseFiles = listEntityFiles(join(root, TRACE_PLANS_DIR), "Phase-").map((name) => name.replace(/\.xml$/u, ""));
  const ordered = [...planMeta.keys(), ...phaseFiles.filter((id) => !planMeta.has(id)).sort()];
  const phases: TracePhase[] = [];

  for (const phaseId of ordered) {
    const file = `${join("docs", "plans", `${phaseId}.xml`).split("\\").join("/")}`;
    const absolute = join(root, file);
    if (!existsSync(absolute)) continue; // lint reports index↔entity drift; trace stays read-only
    const read = readTextSafe(absolute);
    if (!read.ok) {
      findings.push(
        finding("error", TRACE_FINDING_CODES.xmlInvalid, `Cannot read ${file}: ${read.message}`, {
          file,
          hint: "Check file permissions; the phase link cannot be traced.",
        })
      );
      continue;
    }
    const parsed = parseDocumentSafe(read.content, file);
    if (parsed.document === null) {
      findings.push(
        finding("error", TRACE_FINDING_CODES.xmlInvalid, `Invalid XML in ${file}: ${parsed.error ?? "unknown error"}`, {
          file,
          hint: "Fix the phase XML and re-run.",
        })
      );
      continue;
    }

    const document = parsed.document;
    const meta = planMeta.get(phaseId) ?? {};
    const status =
      ((meta.STATUS ?? meta.status ?? "").trim() || "").length > 0
        ? ((meta.STATUS ?? meta.status) as string).trim()
        : ((document.root.attrs.STATUS ?? document.root.attrs.status ?? "").trim() || null);

    const steps = findElements(document, (element) => /^step-\d+$/u.test(element.tag));
    const explicitStep = steps.find((step) => (step.attrs.module ?? "").trim() === moduleId);
    const matches = collectDeepestMatches(document, [moduleId]);
    if (explicitStep === undefined && matches.length === 0) continue;

    let matchedStep: string | null = null;
    let matchedStepDescription: string | undefined;
    const step = explicitStep ?? matches.find((element) => /^step-\d+$/u.test(element.tag));
    if (step !== undefined) {
      matchedStep = step.tag;
      const description = childElements(step, "description")[0];
      const text = description === undefined ? recursiveTextOf(step) : textOf(description);
      if (text.trim() !== "") matchedStepDescription = excerptOf(text);
    }
    phases.push({
      id: phaseId,
      file,
      status,
      matchedStep,
      ...(matchedStepDescription === undefined ? {} : { matchedStepDescription }),
    });
  }

  if (phases.length === 0) {
    findings.push(
      finding("info", TRACE_FINDING_CODES.noPhaseLink, `no phase or step in ${TRACE_PLANS_DIR.split("\\").join("/")} mentions ${moduleId}.`, {
        file: planIndexFile,
        hint: "Reference the module from a phase step to keep the execution plan traceable.",
      })
    );
  }
  return { phases, findings };
}

// ─── Dependents stage ──────────────────────────────────────────────────

/** Reverse-DEPENDS: direct dependents plus the transitive closure (sorted). */
export function computeDependents(entries: readonly IndexEntry[], moduleId: string): TraceDependents {
  const reverse = new Map<string, string[]>();
  for (const entry of entries) {
    if (!entry.tag.startsWith("M-")) continue;
    for (const dependency of splitIdList(entry.attrs.DEPENDS)) {
      const list = reverse.get(dependency);
      if (list === undefined) reverse.set(dependency, [entry.tag]);
      else if (!list.includes(entry.tag)) list.push(entry.tag);
    }
  }

  const direct = [...(reverse.get(moduleId) ?? [])].sort((a, b) => a.localeCompare(b));
  const visited = new Set<string>();
  const queue = [...direct];
  while (queue.length > 0) {
    const current = queue.shift() as string;
    if (current === moduleId || visited.has(current)) continue;
    visited.add(current);
    for (const next of reverse.get(current) ?? []) {
      if (!visited.has(next)) queue.push(next);
    }
  }
  const transitive = [...visited].filter((id) => id !== moduleId).sort((a, b) => a.localeCompare(b));
  return { direct, transitive, transitiveCount: transitive.length };
}

// ─── The trace itself ──────────────────────────────────────────────────

/**
 * Trace one module.
 *
 * Usage problems (invalid id, module absent from the index, malformed root
 * index, invalid config) throw typed errors (exit 2/1 via the CLI guard).
 * Traceability gaps are returned as findings: errors for the required
 * module→verification→tests chain, info for optional requirement/phase links.
 */
export function traceModule(root: string, requestedId: string, options: { config?: MyGraceConfig } = {}): TraceResult {
  const config = options.config ?? loadConfig(root).config;
  const moduleId = resolveTraceModuleId(requestedId, undefined);
  const findings: Finding[] = [];

  const loaded = loadGraphIndexStrict(root, config);
  const entry = findModuleEntry(loaded, moduleId);

  const moduleFile = moduleRelativeFile(moduleId).split("\\").join("/");
  const moduleRead = readTextSafe(join(root, moduleFile));
  let moduleDocument: XmlDocument | null = null;

  if (moduleRead.missing) {
    findings.push(
      finding("error", TRACE_FINDING_CODES.moduleFileMissing, `${moduleId} is indexed but ${moduleFile} does not exist.`, {
        file: "docs/graph-index.xml",
        hint: "Create the module contract file or remove the index entry (run `mygrace lint`).",
      })
    );
  } else if (!moduleRead.ok) {
    findings.push(
      finding("error", TRACE_FINDING_CODES.xmlInvalid, `Cannot read ${moduleFile}: ${moduleRead.message}`, {
        file: moduleFile,
        hint: "Check file permissions; the module contract cannot be traced.",
      })
    );
  } else {
    const parsed = parseDocumentSafe(moduleRead.content, moduleFile);
    if (parsed.document === null) {
      findings.push(
        finding("error", TRACE_FINDING_CODES.xmlInvalid, `Invalid XML in ${moduleFile}: ${parsed.error ?? "unknown error"}`, {
          file: moduleFile,
          hint: "Fix the module XML and re-run.",
        })
      );
    } else {
      moduleDocument = parsed.document;
    }
  }

  const moduleRootAttrs = moduleDocument?.root.attrs ?? {};
  const contractPath = moduleDocument === null ? "" : firstElementText(moduleDocument, "path");
  const contractDepends = moduleDocument === null ? "" : firstElementText(moduleDocument, "depends");
  const contractVerificationRef = moduleDocument === null ? "" : firstElementText(moduleDocument, "verification-ref");

  const name = (entry.attrs.NAME ?? "").trim() || (moduleRootAttrs.NAME ?? "").trim() || "unknown";
  const type = (entry.attrs.TYPE ?? "").trim() || (moduleRootAttrs.TYPE ?? "").trim() || "unknown";
  const status = (entry.attrs.STATUS ?? "").trim() || (moduleRootAttrs.STATUS ?? "").trim() || "unknown";
  const modulePath = ((entry.attrs.PATH ?? "").trim() || contractPath).trim();
  const depends = splitIdList(entry.attrs.DEPENDS ?? contractDepends);
  const declaredRef = ((entry.attrs.VERIFICATION_REF ?? "").trim() || contractVerificationRef).trim();
  const verificationRef = declaredRef === "" ? null : declaredRef;

  // MODULE_PATH_MISSING — the declared source path must exist and stay inside the project.
  if (modulePath === "") {
    findings.push(
      finding("error", TRACE_FINDING_CODES.modulePathMissing, `${moduleId} declares no PATH in docs/graph-index.xml.`, {
        file: "docs/graph-index.xml",
        hint: "Set PATH on the module index entry to the module's source file.",
      })
    );
  } else {
    const state = classifyPath(root, modulePath);
    if (state === "unsafe") {
      findings.push(
        finding("error", TRACE_FINDING_CODES.modulePathMissing, `${moduleId} declares PATH "${modulePath}" which escapes the project root.`, {
          file: "docs/graph-index.xml",
          hint: "PATH must be a project-relative path inside the repository.",
        })
      );
    } else if (state === "missing") {
      findings.push(
        finding("error", TRACE_FINDING_CODES.modulePathMissing, `${moduleId} declares PATH "${modulePath}" but the file does not exist.`, {
          file: "docs/graph-index.xml",
          hint: "Create the source file or fix PATH (run `mygrace lint`).",
        })
      );
    }
  }

  const verificationBuild = buildVerification(root, config, moduleId, verificationRef, moduleRead.ok ? moduleRead.content : null);
  findings.push(...verificationBuild.findings);

  const requirementScan = scanRequirements(root, moduleId, modulePath);
  findings.push(...requirementScan.findings);

  const phaseScan = scanPhases(root, moduleId);
  findings.push(...phaseScan.findings);

  const dependents = computeDependents(loaded.entries, moduleId);

  return {
    root,
    module: {
      id: moduleId,
      name,
      type,
      status,
      path: modulePath,
      depends,
      verificationRef,
      file: moduleFile,
      contractFileExists: moduleDocument !== null,
    },
    verification: verificationBuild.verification,
    requirements: requirementScan.requirements,
    phases: phaseScan.phases,
    dependents,
    findings,
    exitCode: exitCodeForFindings(findings),
  };
}

/** JSON `data` payload for the envelope (drops findings/exitCode, keeps data). */
export function traceData(result: TraceResult): TraceData {
  return {
    root: result.root,
    module: result.module,
    verification: result.verification,
    requirements: result.requirements,
    phases: result.phases,
    dependents: result.dependents,
  };
}

// ─── Text rendering ────────────────────────────────────────────────────

function formatDependents(dependents: TraceDependents): string {
  if (dependents.direct.length === 0) return "(none; 0 transitive)";
  const extra = dependents.transitiveCount - dependents.direct.length;
  const suffix = extra > 0 ? ` (+${extra} transitive)` : "";
  return `${dependents.direct.join(", ")}${suffix}`;
}

function formatVerification(verification: TraceVerification): string {
  if (verification.id === null) return "  → verification: (none — no VERIFICATION_REF)";
  if (!verification.exists) return `  → verification ${verification.id}: ${verification.file ?? "?"} (file missing)`;
  const meta = [verification.status ?? "unknown", verification.priority ?? "unknown"].join(", ");
  const files =
    verification.testFiles.length === 0
      ? "(no test files)"
      : verification.testFiles
          .map((testFile) => `${testFile.file} ${testFile.exists ? "✔" : "✗"}${testFile.lines === undefined ? "" : ` (${testFile.lines} lines)`}`)
          .join(", ");
  return `  → verification ${verification.id} (${meta}): ${files}`;
}

/** Compact human tree for `--format text`. */
// START_BLOCK_CODE_SYMBOLS
/** Extract the raw MODULE_MAP section of a module contract file (empty when absent). */
function moduleMapRawOf(contractFile: string): string {
  try {
    const content = readFileSync(contractFile, "utf-8");
    const match = /START_MODULE_MAP([\s\S]*?)END_MODULE_MAP/u.exec(content);
    return match === null ? "" : match[1];
  } catch {
    return "";
  }
}

/**
 * Parse `MODULE_MAP` entries (`NAME   — description`, one per line).
 *
 * Exported for tests and for other tools that need the contract surface without
 * reimplementing the (tolerant) line syntax.
 */
export function parseModuleMapNames(raw: string): string[] {
  const names: string[] = [];
  const seen = new Set<string>();
  for (const line of raw.split(/\r?\n/u)) {
    const trimmed = line.replace(/^\s*(?:\/\/|\/\*|\*+|#)\s*/u, "").trim();
    if (trimmed === "" || trimmed.startsWith("START_") || trimmed.startsWith("END_")) continue;
    const match = /^([A-Za-z0-9_$#.-]+)(?:\(\))?\s*(?:[—–-]|:)\s*(.*)$/u.exec(trimmed);
    if (match === null) continue;
    const name = match[1] ?? "";
    if (name === "" || seen.has(name)) continue;
    seen.add(name);
    names.push(name);
  }
  return names;
}

/**
 * Verify the module's MODULE_MAP entries exist as code symbols (Octocode, ADR-9).
 * Advisory: missing symbols are warnings; `--strict-contracts` promotes them in
 * the command layer. A missing integration is info-level and never fails.
 */
export async function enrichTraceWithCodeSymbols(
  result: TraceResult,
  config: MyGraceConfig,
  options: { env?: NodeJS.ProcessEnv } = {}
): Promise<{ symbols: TraceSymbols; findings: Finding[] }> {
  if (result.module.path === "") {
    return {
      symbols: {
        available: false,
        version: null,
        entries: [],
        notes: ["Module PATH is missing, so no code symbols can be inspected."],
      },
      findings: [],
    };
  }
  const sourceFile = join(result.root, result.module.path);
  const names = parseModuleMapNames(moduleMapRawOf(sourceFile));
  if (names.length === 0) {
    return {
      symbols: { available: false, version: null, entries: [], notes: [`No MODULE_MAP entries to verify in ${result.module.path}.`] },
      findings: [],
    };
  }

  const collected = await collectFileSymbols({
    root: result.root,
    config,
    files: [result.module.path],
    ...(options.env === undefined ? {} : { env: options.env }),
  });
  if (!collected.available) {
    const hint = collected.notes[0];
    return {
      symbols: {
        available: false,
        version: collected.version,
        entries: names.map((name) => ({ name, found: false })),
        notes: collected.notes,
      },
      findings: [
        finding(
          "info",
          TRACE_FINDING_CODES.integrationUnavailable,
          "Octocode is not available; contract symbols were not verified.",
          hint === undefined ? {} : { hint }
        ),
      ],
    };
  }

  const fileSymbols = collected.files[result.module.path] ?? [];
  const byName = new Map(fileSymbols.map((symbol) => [symbol.name, symbol]));
  const entries: TraceSymbolEntry[] = names.map((name) => {
    const symbol = byName.get(name);
    return symbol === undefined ? { name, found: false } : { name, found: true, kind: symbol.kind };
  });
  const findings: Finding[] = [];
  for (const entry of entries) {
    if (entry.found) continue;
    findings.push(
      finding(
        "warning",
        TRACE_FINDING_CODES.contractSymbolMissing,
        `${result.module.id}: MODULE_MAP entry "${entry.name}" is not present in ${result.module.path}.`,
        { file: result.module.file, hint: "Add/rename the symbol in code, or update MODULE_MAP and docs/graph-index.xml." }
      )
    );
  }
  return {
    symbols: { available: true, version: collected.version, entries, notes: collected.notes },
    findings,
  };
}

function formatTraceSymbolsSection(symbols: TraceSymbols): string {
  const found = symbols.entries.filter((entry) => entry.found).length;
  const lines = [
    "",
    `Symbols (Octocode): ${symbols.available ? "available" : "unavailable"} — ${found}/${symbols.entries.length} MODULE_MAP entries resolved`,
  ];
  for (const entry of symbols.entries) {
    if (entry.found) continue;
    lines.push(`  ✗ ${entry.name} (not found)`);
  }
  for (const note of symbols.notes) lines.push(`  - ${note}`);
  return lines.join("\n");
}
// END_BLOCK_CODE_SYMBOLS

export function formatTraceText(result: TraceResult): string {
  const { module, verification, requirements, phases, dependents } = result;
  const lines: string[] = [];
  lines.push(`${module.id} — ${module.name} [${module.status}] ${module.path === "" ? "(no PATH)" : module.path}`);
  lines.push(`  → module file: ${module.file}${module.contractFileExists ? "" : " (missing)"}`);
  lines.push(formatVerification(verification));
  const optIn = verification.command.requiresShellOptIn ? " (needs --allow-commands)" : "";
  lines.push(`  → command: ${verification.command.command} [${verification.command.source}]${optIn}`);
  lines.push(
    `  → requirements: ${
      requirements.length === 0
        ? "(none)"
        : requirements.map((requirement) => `${requirement.tag}: ${requirement.excerpt}`).join("; ")
    }`
  );
  lines.push(
    `  → phases: ${
      phases.length === 0
        ? "(none)"
        : phases
            .map(
              (phase) =>
                `${phase.id}${phase.matchedStep === null ? "" : ` (${phase.matchedStep}${phase.matchedStepDescription === undefined ? "" : `: ${phase.matchedStepDescription}`})`}`
            )
            .join(", ")
    }`
  );
  lines.push(`  → dependents: ${formatDependents(dependents)}`);

  const errors = result.findings.filter((item) => item.severity === "error");
  const infos = result.findings.filter((item) => item.severity !== "error");
  if (errors.length === 0 && infos.length === 0) {
    lines.push("  ✓ traceable — no gaps");
  } else {
    for (const item of errors) lines.push(`  ✗ [${item.code}] ${item.message}`);
    for (const item of infos) lines.push(`  ⓘ [${item.code}] ${item.message}`);
    lines.push(errors.length > 0 ? `  ✗ trace gaps: ${errors.length} error(s)` : "  ✓ traceable — no errors");
  }
  return lines.join("\n");
}

// ─── Command ───────────────────────────────────────────────────────────

export const traceCommand = defineCommand({
  meta: {
    name: "trace",
    description:
      "Trace one module end to end: requirement → module → verification → test files → command → phases → dependents (text or json); exit 1 on traceability errors",
  },
  args: {
    id: { type: "positional", description: "Module id (M-XXX) or verification id (V-M-XXX)" },
    module: { type: "string", description: "Module id (M-XXX); alternative to the positional id" },
    path: { type: "string", default: ".", description: "Project root" },
    code: { type: "boolean", default: false, description: "Verify MODULE_MAP symbols in code via Octocode (optional, ADR-9)" },
    strictContracts: {
      type: "boolean",
      default: false,
      description: "Promote CONTRACT_SYMBOL_MISSING warnings to errors (exit 1)",
    },
    format: { type: "string", default: "text", description: "Output format: text or json" },
  },
  run: async ({ args }) => {
    const format = parseOutputFormat(args.format);
    await runCommandOutcome<unknown>(format, { command: "trace" }, async (): Promise<CommandOutcome<unknown>> => {
      const root = findProjectRoot(args.path ?? ".");
      const moduleId = resolveTraceModuleId(args.id, args.module);
      const result = traceModule(root, moduleId);
      const data = traceData(result);
      const findings = [...result.findings];
      let text = formatTraceText(result);
      if (args.code === true) {
        const config = loadConfig(root).config;
        const enrichment = await enrichTraceWithCodeSymbols(result, config);
        data.symbols = enrichment.symbols;
        findings.push(...enrichment.findings);
        text += `\n${formatTraceSymbolsSection(enrichment.symbols)}`;
      }
      if (args.strictContracts === true) {
        for (const item of findings) {
          if (item.code === TRACE_FINDING_CODES.contractSymbolMissing && item.severity === "warning") item.severity = "error";
        }
      }
      const envelope = createEnvelope({
        data,
        findings,
        meta: { command: "trace", root },
      });
      return { envelope, print: () => console.log(text) };
    });
  },
});

// EXIT is re-exported for callers that map TraceResult.exitCode without
// importing grace-errors (keeps MCP wiring a one-import change).
export { EXIT };
