#!/usr/bin/env bun
/**
 * MyGRACE — Verification runner, command trust model and `mygrace trust` command.
 *
 * This module owns the *execution* half of the verification contract:
 *
 *  1. Where commands live. The canonical location of `<module-checks>` is the
 *     verification file (`docs/verification/V-M-XXX.xml`), exactly where the
 *     templates, skills and demo put it. Reading it from the module file is a
 *     deprecated fallback kept for v1 projects.
 *  2. Whether a command may run. Commands are project data; in a cloned repo
 *     they are attacker-controlled. Nothing executes without one of:
 *       - an explicit `--allow-commands` flag (per invocation),
 *       - `allowCommands: true` in `mygrace.config.json` (project opt-in),
 *       - a *current* `.mygrace/trust.json` record whose sha256 hashes match
 *         every command-source file (ROADMAP ADR-1).
 *  3. How a command runs. argv-only `spawnSync`, never a shell. The command
 *     string is split by a quote-aware tokenizer; shell metacharacters and
 *     shell interpreters (`sh -c ...`) need the explicit `--allow-commands`
 *     opt-in, and `<file>` entries are never allowed to start with `-`
 *     (flag-injection guard) or to escape the project (path traversal guard).
 */

// START_MODULE_CONTRACT
//   PURPOSE: Execute project-declared verification commands safely: canonical command source,
//            trust record (ADR-1), argv-only execution, quote-aware splitting, plan/execute API,
//            `mygrace test` and `mygrace trust` commands.
//   SCOPE: docs/modules + docs/verification reads, .mygrace/trust.json, child_process spawnSync; no shell.
//   DEPENDS: grace-errors, grace-xml, grace-paths, grace-config, grace-common
//   LINKS: ROADMAP.md (ADR-1 trust model, ADR-3 exit codes, ADR-4 untrusted ids, ADR-8 JSON output)
// END_MODULE_CONTRACT

// START_MODULE_MAP
//   parseTestFiles/parseCheckCommands/parseCheckCommand — structural reads of verification/module XML
//   tokenizeCommand()            — quote-aware argv splitter (no shell)
//   inspectCheckCommand()        — flags commands that need the explicit --allow-commands opt-in
//   planModuleTest()             — pure plan: files, command, argv, source, validation errors
//   executeModulePlan()          — authorize + spawn one plan, never throws for findings
//   runModuleTests()             — plan+execute convenience used by verify and tests
//   TRUST_RECORD_VERSION         — current trust record schema version (1)
//   trustFilePath()/loadTrustRecord()/writeTrustRecord() — .mygrace/trust.json handling
//   commandSourceFiles()/computeTrustHashes() — files covered by the trust record (sorted rel paths)
//   checkTrust()                 — hash comparison with actionable stale/missing details
//   authorizeCommands()          — one place that answers "may this run?"
//   inspectUnsafeCommand()       — static deny policy for dangerous command patterns (defense in depth)
//   auditLogPath()/appendAuditRecord() — local .mygrace/audit.log JSONL for every execution attempt
//   runCommandOutcome()/parseOutputFormat()/envelopeErrorFor() — shared ADR-3/ADR-8 CLI contract
//   testCommand                  — `mygrace test [--module M-X] [--allow-commands] [--format json]`
//   trustCommand                 — `mygrace trust [--path .] [--format json]` (wired by grace.ts)
// END_MODULE_MAP

import { defineCommand } from "citty";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative, sep } from "node:path";
import { findProjectRoot, readFileOrNull, readIndexFileSafe, walkFiles } from "./grace-common";
import { loadGraphIndexStrict } from "./grace-shard";
import { ConfigError, EXIT, MyGraceError, TrustError, UsageError, XmlError, createEnvelope, finding, isMyGraceError, printJson } from "./grace-errors";
import type { Finding, ResultEnvelope, ResultMeta } from "./grace-errors";
import { DEFAULT_CONFIG, configPath, loadConfig, tryLoadConfig } from "./grace-config";
import type { MyGraceConfig } from "./grace-config";
import { assertEntityId, assertSafeRelativePath, entityPath } from "./grace-paths";
import { childElements, findElements, parseXml, textOf } from "./grace-xml";
import type { XmlDocument, XmlElement } from "./grace-xml";

// ─── Public constants ───────────────────────────────────────────────────

/** Trust record schema version written by `mygrace trust`. */
export const TRUST_RECORD_VERSION = 1;
/** Directory (project-relative) holding local, never-committed state. */
export const MYGRACE_STATE_DIR = ".mygrace";
/** Trust record file name inside {@link MYGRACE_STATE_DIR}. */
export const TRUST_RECORD_FILENAME = "trust.json";
/** Built-in fallback when neither the project nor the config declares a command. */
export const DEFAULT_TEST_COMMAND = DEFAULT_CONFIG.testRunner;

/** Canonical source directory for test scopes. */
export const VERIFICATION_DIR = join("docs", "verification");
/** Module contract directory (deprecated fallback source of `<module-checks>`). */
export const MODULES_DIR = join("docs", "modules");

// ─── Output contract shared by the verification-ish commands ───────────

export type OutputFormat = "text" | "json";

/** Parse/validate a `--format` value (ADR-8). */
export function parseOutputFormat(value: string | undefined): OutputFormat {
  if (value === undefined || value === "text") return "text";
  if (value === "json") return "json";
  throw new UsageError(`Invalid --format "${value}" — expected "text" or "json".`, {
    hint: 'Use `--format text` (default) or `--format json` for the machine-readable envelope.',
  });
}

/** Normalize an unknown thrown value for {@link createEnvelope}. */
export function envelopeErrorFor(error: unknown): MyGraceError | { code: string; message: string; hint?: string } {
  if (isMyGraceError(error)) return error;
  return { code: "INTERNAL", message: error instanceof Error ? error.message : String(error) };
}

/** A finished command: an ADR-8 envelope plus (text mode) lines to print. */
export interface CommandOutcome<T> {
  envelope: ResultEnvelope<T>;
  print?: () => void;
}

/**
 * Run a command body under the shared output/exit-code contract.
 *
 * - `--format json` always prints one envelope and exits with its `exitCode`;
 * - text mode prints the body's lines, then exits non-zero only when the
 *   envelope says so (success returns normally, so the runtime exits 0);
 * - typed errors thrown by the body become one readable line via the CLI guard
 *   (or an error envelope in JSON mode) — never a stack trace.
 */
export async function runCommandOutcome<T>(
  format: OutputFormat,
  meta: ResultMeta,
  build: () => CommandOutcome<T> | Promise<CommandOutcome<T>>
): Promise<void> {
  const startedAt = Date.now();
  let outcome: CommandOutcome<T>;
  try {
    outcome = await build();
  } catch (error) {
    if (format === "json") {
      const envelope = createEnvelope({
        error: envelopeErrorFor(error),
        meta: { ...meta, durationMs: Date.now() - startedAt },
      });
      printJson(envelope);
      process.exit(envelope.exitCode);
    }
    throw error;
  }

  outcome.envelope.meta = { ...meta, ...outcome.envelope.meta, durationMs: Date.now() - startedAt };
  if (format === "json") {
    printJson(outcome.envelope);
    process.exit(outcome.envelope.exitCode);
  }
  outcome.print?.();
  if (outcome.envelope.exitCode !== EXIT.OK) process.exit(outcome.envelope.exitCode);
}

// ─── Verification XML: test files and check commands ───────────────────

function elementsWithTag(document: XmlDocument, tag: string): XmlElement[] {
  return findElements(document, (element) => element.tag === tag);
}

function testFilesOfDocument(document: XmlDocument): string[] {
  const blocks = elementsWithTag(document, "test-files");
  const nodes =
    blocks.length > 0
      ? blocks.flatMap((block) => childElements(block, "file"))
      : elementsWithTag(document, "file"); // v1 compatibility: bare <file> entries
  const files: string[] = [];
  for (const node of nodes) {
    const value = textOf(node);
    if (value !== "") files.push(value);
  }
  return files;
}

function checkCommandsOfDocument(document: XmlDocument): string[] {
  const block = elementsWithTag(document, "module-checks")[0];
  if (block === undefined) return [];
  const checks = childElements(block)
    .filter((child) => /^check-\d+$/.test(child.tag))
    .sort((a, b) => Number(a.tag.slice("check-".length)) - Number(b.tag.slice("check-".length)));
  return checks.map(textOf).filter((command) => command !== "");
}

/**
 * Extract `docs/verification/*.xml` `<test-files><file>` entries structurally.
 * Throws `XmlError` (a finding, exit 1) when the content is not well-formed XML.
 */
export function parseTestFiles(content: string | null): string[] {
  if (content === null) return [];
  return testFilesOfDocument(parseXml(content, "verification XML"));
}

/**
 * Extract every `<check-N>` command from `<module-checks>` (numeric order).
 * The canonical location is the verification file; module files only work as
 * a deprecated fallback for projects created before v2.
 */
export function parseCheckCommands(content: string | null): string[] {
  if (content === null) return [];
  return checkCommandsOfDocument(parseXml(content, "module/verification XML"));
}

/** First declared `<check-N>` command, or `fallback` (config testRunner by default). */
export function parseCheckCommand(content: string | null, fallback: string = DEFAULT_TEST_COMMAND): string {
  const commands = parseCheckCommands(content);
  return commands[0] ?? fallback;
}

/** True when a document declares at least one `<check-N>` command. */
export function hasCheckCommand(content: string | null): boolean {
  return parseCheckCommands(content).length > 0;
}

// ─── Command splitting and shell policy ────────────────────────────────

/**
 * Split a command string into argv with a hand-written, quote-aware tokenizer.
 *
 * No shell is involved anywhere: quoting only groups whitespace and escapes the
 * next character; the resulting tokens are passed to `spawnSync` verbatim.
 * Unterminated quotes are a typed `UsageError` (a finding the caller turns into
 * a plan error).
 */
export function tokenizeCommand(command: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let hasToken = false;
  let quote: "'" | '"' | null = null;
  const text = command;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index] as string;

    if (quote === "'") {
      if (char === "'") quote = null;
      else current += char;
      continue;
    }
    if (quote === '"') {
      if (char === '"') {
        quote = null;
      } else if (char === "\\" && index + 1 < text.length) {
        const next = text[index + 1] as string;
        if (next === '"' || next === "\\") {
          current += next;
          index += 1;
        } else {
          current += char;
        }
      } else {
        current += char;
      }
      continue;
    }

    if (char === "'" || char === '"') {
      quote = char;
      hasToken = true;
      continue;
    }
    if (char === " " || char === "\t" || char === "\n" || char === "\r") {
      if (hasToken || current !== "") {
        tokens.push(current);
        current = "";
        hasToken = false;
      }
      continue;
    }
    if (char === "\\" && index + 1 < text.length) {
      current += text[index + 1] as string;
      index += 1;
      hasToken = true;
      continue;
    }
    current += char;
    hasToken = true;
  }

  if (quote !== null) {
    throw new UsageError(
      `Unterminated ${quote === "'" ? "single" : "double"} quote in project check command "${command}".`,
      { hint: "Quote the command correctly in <module-checks> or check the XML manually." }
    );
  }
  if (hasToken || current !== "") tokens.push(current);
  return tokens;
}

/** Characters that only make sense when a shell would interpret the command. */
const SHELL_METACHARACTERS = /[;|&$`<>\r\n]/;
const SHELL_INTERPRETERS = new Set([
  "sh",
  "bash",
  "zsh",
  "dash",
  "ash",
  "ksh",
  "csh",
  "tcsh",
  "fish",
  "cmd",
  "cmd.exe",
  "powershell",
  "powershell.exe",
  "pwsh",
  "pwsh.exe",
]);

export interface CommandPolicy {
  /** True when the command needs the explicit `--allow-commands` opt-in. */
  requiresShellOptIn: boolean;
  reason?: string;
}

/**
 * Classify a declared command string.
 *
 * Execution is always argv-only, so a metacharacter is not an injection by
 * itself — but such commands were written for a shell and only run with the
 * explicit per-invocation opt-in (`--allow-commands`), which is also the only
 * way `sh -c ...` / `bash -c ...` may execute (ADR-1).
 */
export function inspectCheckCommand(command: string): CommandPolicy {
  if (SHELL_METACHARACTERS.test(command)) {
    return {
      requiresShellOptIn: true,
      reason: "contains shell metacharacters (; | & $ ` < > or a newline)",
    };
  }
  let argv: string[];
  try {
    argv = tokenizeCommand(command);
  } catch {
    return { requiresShellOptIn: false }; // the tokenizer error is reported by planModuleTest
  }
  const executable = basename(argv[0] ?? "").toLowerCase();
  if (SHELL_INTERPRETERS.has(executable)) {
    return { requiresShellOptIn: true, reason: `launches a shell interpreter (${executable})` };
  }
  return { requiresShellOptIn: false };
}

/** One dangerous command pattern; `inspectUnsafeCommand` returns the first match. */
export const UNSAFE_COMMAND_RULES: ReadonlyArray<{ label: string; pattern: RegExp }> = [
  { label: "privilege escalation", pattern: /\b(?:sudo|doas|pkexec)\b/i },
  { label: "destructive file removal", pattern: /\brm\s+(?:-[a-z]*[rf]|--recursive|--force)\b/i },
  { label: "network/download tool", pattern: /\b(?:curl|wget|nc|ncat|netcat|ssh|scp|socat|ftp)\b/i },
  { label: "dynamic shell evaluation", pattern: /\beval\b|\bexec\b|\$\(|`/i },
  { label: "encoded payload", pattern: /\bbase64\s+(?:-d|--decode|-D)\b/i },
  { label: "permission change", pattern: /\b(?:chmod|chown|chgrp|setfacl)\b/i },
  { label: "filesystem/device write", pattern: /\b(?:mkfs(?:\.[a-z0-9]+)?|fdisk|parted|dd|mount|umount)\b/i },
  { label: "system service control", pattern: /\b(?:systemctl|service|launchctl)\b/i },
  { label: "publishing/remote write", pattern: /\b(?:git\s+push|npm\s+publish|gh\s+release|docker\s+push)\b/i },
  { label: "out-of-tree redirect", pattern: />\s*(?:\/|~|\.\.\/)/i },
];

/** True when the declared command matches a deny-listed pattern (static defense in depth). */
export function inspectUnsafeCommand(command: string): { label: string } | null {
  for (const rule of UNSAFE_COMMAND_RULES) {
    if (rule.pattern.test(command)) return { label: rule.label };
  }
  return null;
}

/** Resolve the executable command for a module without needing a full plan. */
export interface DeclaredCheckCommand {
  command: string;
  source: CheckSource;
  /** Project-relative file that declares it (`mygrace.config.json` for the default). */
  file: string;
}

function resolveCommandFromDocuments(
  verificationDocument: XmlDocument | null,
  moduleDocument: XmlDocument,
  config: MyGraceConfig
): DeclaredCheckCommand {
  const verificationCommands = verificationDocument === null ? [] : checkCommandsOfDocument(verificationDocument);
  if (verificationCommands.length > 0) {
    return { command: verificationCommands[0] as string, source: "verification", file: "docs/verification" };
  }
  const moduleCommands = checkCommandsOfDocument(moduleDocument);
  if (moduleCommands.length > 0) {
    return { command: moduleCommands[0] as string, source: "module", file: "docs/modules" };
  }
  return { command: config.testRunner, source: "config", file: configRelativePath() };
}

/**
 * Read the declared command for one module (canonical verification first,
 * deprecated module fallback second, config testRunner last).
 *
 * Throws a typed `UsageError` when the module file is missing and `XmlError`
 * when either document is malformed — both are handled by the CLI guard.
 */
export function resolveDeclaredCommand(root: string, moduleId: string, config: MyGraceConfig): DeclaredCheckCommand {
  const module = assertEntityId("module", moduleId);
  const modulePath = entityPath(root, "module", module);
  const moduleRelative = `docs/modules/${module}.xml`;
  const moduleContent = readFileOrNull(modulePath);
  if (moduleContent === null) {
    throw new UsageError(`Module file ${moduleRelative} not found.`, {
      hint: "Run `mygrace inspect module list` to see indexed modules and `mygrace lint` to find drift.",
      file: moduleRelative,
    });
  }
  const moduleDocument = parseXml(moduleContent, moduleRelative);

  const verificationRelative = `docs/verification/V-${module}.xml`;
  const verificationContent = readFileOrNull(entityPath(root, "verification", `V-${module}`));
  const verificationDocument = verificationContent === null ? null : parseXml(verificationContent, verificationRelative);

  const resolved = resolveCommandFromDocuments(verificationDocument, moduleDocument, config);
  if (resolved.source === "verification") return { ...resolved, file: verificationRelative };
  if (resolved.source === "module") return { ...resolved, file: moduleRelative };
  return resolved;
}

// ─── Module plans ───────────────────────────────────────────────────────

export type CheckSource = "verification" | "module" | "config";

export interface PlanError {
  code: string;
  message: string;
  hint?: string;
  file?: string;
}

export interface ModulePlan {
  module: string;
  status: "ready" | "invalid";
  /** Where the executable command was declared. */
  source: CheckSource;
  command: string;
  /** Full argv (= executable + declared args + validated `<file>` entries). */
  argv: string[];
  files: string[];
  moduleFile: string;
  verificationFile: string | null;
  /** True when running this command needs the explicit --allow-commands opt-in. */
  requiresShellOptIn: boolean;
  optInReason?: string;
  error?: PlanError;
}

function projectRelative(root: string, absolutePath: string): string {
  return relative(root, absolutePath).split(sep).join("/");
}

function invalidPlan(plan: ModulePlan, error: PlanError): ModulePlan {
  return { ...plan, status: "invalid", argv: [], error };
}

/**
 * Validate one `<test-files>` entry before it is appended to argv.
 *
 * Rejects absolute paths, `..` segments and NUL bytes (traversal guard) as well
 * as entries starting with `-` (flag-injection guard, the C-5 exploit shape).
 */
export function validateTestFileEntry(entry: string): string {
  const safe = assertSafeRelativePath(entry, "test file path");
  if (safe.startsWith("-")) {
    throw new UsageError(
      `Refusing test file "${safe}": a <file> entry starting with "-" would be passed as a command-line flag.`,
      { hint: "List real project-relative test files in <test-files>, not flags." }
    );
  }
  if (SHELL_METACHARACTERS.test(safe)) {
    throw new UsageError(
      `Refusing test file "${safe}": contains shell metacharacters.`,
      { hint: "Use a plain project-relative path inside <test-files>." }
    );
  }
  return safe;
}

/**
 * Build (but do not execute) the plan for one module.
 *
 * Validation problems become `status: "invalid"` findings instead of crashes;
 * only an invalid *module id* throws (`UsageError`, exit 2) because that is
 * untrusted CLI/MCP input and must never reach the filesystem.
 */
export function planModuleTest(root: string, moduleId: string, config: MyGraceConfig): ModulePlan {
  const module = assertEntityId("module", moduleId);
  const modulePath = entityPath(root, "module", module);
  const verificationPath = entityPath(root, "verification", `V-${module}`);

  const plan: ModulePlan = {
    module,
    status: "ready",
    source: "config",
    command: config.testRunner,
    argv: [],
    files: [],
    moduleFile: projectRelative(root, modulePath),
    verificationFile: existsSync(verificationPath) ? projectRelative(root, verificationPath) : null,
    requiresShellOptIn: false,
  };

  const moduleContent = readFileOrNull(modulePath);
  if (moduleContent === null) {
    return invalidPlan(plan, {
      code: "MODULE_FILE_MISSING",
      message: `docs/modules/${module}.xml not found.`,
      hint: "Run `mygrace inspect module list` to see indexed modules, and `mygrace lint` to find drift.",
      file: plan.moduleFile,
    });
  }
  let moduleDocument: XmlDocument;
  try {
    moduleDocument = parseXml(moduleContent, plan.moduleFile);
  } catch (error) {
    return invalidPlan(plan, planErrorFromXml(error, plan.moduleFile));
  }

  const verificationContent = readFileOrNull(verificationPath);
  if (verificationContent === null) {
    return invalidPlan(plan, {
      code: "VERIFICATION_FILE_MISSING",
      message: `docs/verification/V-${module}.xml not found — cannot read the canonical <module-checks>.`,
      hint: "Run the mygrace-verification skill to create the verification file.",
      file: `docs/verification/V-${module}.xml`,
    });
  }
  let verificationDocument: XmlDocument;
  try {
    verificationDocument = parseXml(verificationContent, plan.verificationFile ?? "verification XML");
  } catch (error) {
    return invalidPlan(plan, planErrorFromXml(error, plan.verificationFile ?? "verification XML"));
  }

  const files = testFilesOfDocument(verificationDocument);
  if (files.length === 0) {
    return invalidPlan(plan, {
      code: "NO_TEST_FILES",
      message: `no <test-files> in docs/verification/V-${module}.xml — run the mygrace-verification skill to define tests.`,
      hint: "Add <test-files><file>path/to/test.ts</file></test-files> to the verification file.",
      file: plan.verificationFile ?? undefined,
    });
  }
  const validatedFiles: string[] = [];
  for (const file of files) {
    try {
      validatedFiles.push(validateTestFileEntry(file));
    } catch (error) {
      return invalidPlan(plan, planErrorFromUsage(error, plan.verificationFile ?? undefined));
    }
  }

  // Canonical: verification file; deprecated fallback: module file; last: config testRunner.
  const resolved = resolveCommandFromDocuments(verificationDocument, moduleDocument, config);
  const command = resolved.command;
  const source = resolved.source;

  let argv: string[];
  try {
    argv = tokenizeCommand(command);
  } catch (error) {
    return invalidPlan(plan, {
      ...planErrorFromUsage(error, plan.verificationFile ?? plan.moduleFile),
      code: "CHECK_COMMAND_INVALID",
    });
  }
  if (argv.length === 0 || (argv[0] ?? "") === "") {
    return invalidPlan(plan, {
      code: "CHECK_COMMAND_INVALID",
      message: "the declared check command is empty.",
      hint: "Set a real command in <module-checks><check-1>…</check-1></module-checks>.",
      file: source === "verification" ? (plan.verificationFile ?? undefined) : plan.moduleFile,
    });
  }

  const policy = inspectCheckCommand(command);
  return {
    ...plan,
    status: "ready",
    source,
    command,
    files: validatedFiles,
    argv: [...argv, ...validatedFiles],
    requiresShellOptIn: policy.requiresShellOptIn,
    ...(policy.reason === undefined ? {} : { optInReason: policy.reason }),
  };
}

function planErrorFromXml(error: unknown, file: string): PlanError {
  if (error instanceof XmlError) {
    return {
      code: "XML_INVALID",
      message: error.message,
      hint: error.hint ?? "Fix the XML, then re-run.",
      file: error.file ?? file,
    };
  }
  return { code: "XML_INVALID", message: error instanceof Error ? error.message : String(error), file };
}

function planErrorFromUsage(error: unknown, file: string | undefined): PlanError {
  if (isMyGraceError(error)) {
    return {
      code: error.code,
      message: error.message,
      ...(error.hint === undefined ? {} : { hint: error.hint }),
      ...(error.file !== undefined ? { file: error.file } : file === undefined ? {} : { file }),
    };
  }
  return {
    code: "INVALID_TEST_FILE",
    message: error instanceof Error ? error.message : String(error),
    ...(file === undefined ? {} : { file }),
  };
}

// ─── Trust record (ROADMAP ADR-1) ──────────────────────────────────────

export interface TrustRecord {
  version: typeof TRUST_RECORD_VERSION;
  generatedAt: string;
  /** Project-relative POSIX path -> sha256 hex of the file bytes. */
  files: Record<string, string>;
  /** Persisted opt-in for shell-metacharacter commands (written by `mygrace trust --allow-commands`). */
  allowCommands?: boolean;
}

export interface TrustLoadFailure {
  code: string;
  message: string;
  hint?: string;
}

export interface TrustCheck {
  trusted: boolean;
  /** Human-readable reason, safe to print (no stack). */
  reason: string;
  recordPath: string;
  recordFound: boolean;
  /** Current command-source files that the record does not cover. */
  missing: string[];
  /** Recorded files whose bytes changed (the dangerous case: command edited). */
  stale: string[];
  /** Recorded files that no longer exist (harmless, reported for hygiene). */
  removed: string[];
  /** Number of command-source files currently on disk. */
  fileCount: number;
  generatedAt?: string;
  allowCommands?: boolean;
  error?: TrustLoadFailure;
}

/** Absolute path of the local execution audit log (`<root>/.mygrace/audit.log`). */
export function auditLogPath(projectRoot: string): string {
  return join(projectRoot, MYGRACE_STATE_DIR, "audit.log");
}

/** Append one JSONL audit record; best effort — auditing must never break a run. */
export function appendAuditRecord(projectRoot: string, record: Record<string, unknown>): void {
  try {
    mkdirSync(join(projectRoot, MYGRACE_STATE_DIR), { recursive: true });
    appendFileSync(auditLogPath(projectRoot), `${JSON.stringify({ ts: new Date().toISOString(), ...record })}\n`);
  } catch {
    // Local audit is advisory; a read-only checkout must still run tests.
  }
}

/** Absolute path of `<root>/.mygrace/trust.json`. */
export function trustFilePath(projectRoot: string): string {
  return join(projectRoot, MYGRACE_STATE_DIR, TRUST_RECORD_FILENAME);
}

function configRelativePath(): string {
  return "mygrace.config.json";
}

/**
 * Every file whose content can declare or parameterise an executed command
 * (sorted project-relative POSIX paths):
 *   docs/modules/**\/*.xml, docs/verification/**\/*.xml and mygrace.config.json.
 *
 * The config file is included because `testRunner` is itself a command source:
 * changing it after `mygrace trust` must invalidate the record.
 */
export function commandSourceFiles(projectRoot: string): string[] {
  const roots = [join(projectRoot, MODULES_DIR), join(projectRoot, VERIFICATION_DIR)];
  const files: string[] = [];
  for (const dir of roots) {
    for (const absolute of walkFiles(dir, { exts: [".xml"], ignoreDirs: ["node_modules", ".git"] })) {
      files.push(projectRelative(projectRoot, absolute));
    }
  }
  const config = configPath(projectRoot);
  if (existsSync(config)) files.push(configRelativePath());
  return [...new Set(files)].sort();
}

function sha256Bytes(content: string | Uint8Array): string {
  return createHash("sha256").update(content).digest("hex");
}

/** Compute the current `{relpath: sha256}` map covered by the trust record. */
export function computeTrustHashes(projectRoot: string): Record<string, string> {
  const hashes: Record<string, string> = {};
  for (const relativePath of commandSourceFiles(projectRoot)) {
    hashes[relativePath] = sha256Bytes(readFileSync(join(projectRoot, relativePath)));
  }
  return hashes;
}

/**
 * Read and validate `.mygrace/trust.json`.
 *
 * Returns `null` when the file is absent. A present-but-invalid record throws a
 * typed `ConfigError` (exit 2): it is untrusted input, and silently ignoring it
 * would hide the real reason commands are refused.
 */
export function loadTrustRecord(projectRoot: string): TrustRecord | null {
  const path = trustFilePath(projectRoot);
  if (!existsSync(path)) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf-8"));
  } catch (error) {
    throw new ConfigError(
      `Invalid .mygrace/${TRUST_RECORD_FILENAME}: ${error instanceof Error ? error.message : String(error)}`,
      {
        file: `${MYGRACE_STATE_DIR}/${TRUST_RECORD_FILENAME}`,
        hint: `Delete the file and run \`mygrace trust\` to regenerate it.`,
      }
    );
  }
  return validateTrustRecord(parsed);
}

function invalidTrust(message: string): ConfigError {
  return new ConfigError(`Invalid .mygrace/${TRUST_RECORD_FILENAME}: ${message}`, {
    file: `${MYGRACE_STATE_DIR}/${TRUST_RECORD_FILENAME}`,
    hint: `Delete the file and run \`mygrace trust\` to regenerate it.`,
  });
}

function validateTrustRecord(value: unknown): TrustRecord {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw invalidTrust("expected a JSON object");
  }
  const raw = value as Record<string, unknown>;
  if (raw.version !== TRUST_RECORD_VERSION) {
    throw invalidTrust(`unsupported record version (expected ${TRUST_RECORD_VERSION})`);
  }
  if (typeof raw.generatedAt !== "string" || Number.isNaN(Date.parse(raw.generatedAt))) {
    throw invalidTrust("generatedAt must be an ISO-8601 timestamp");
  }
  if (raw.files === null || typeof raw.files !== "object" || Array.isArray(raw.files)) {
    throw invalidTrust("files must be an object mapping project-relative paths to sha256 hashes");
  }
  const files: Record<string, string> = {};
  for (const [rawPath, hash] of Object.entries(raw.files as Record<string, unknown>)) {
    if (typeof hash !== "string" || !/^[0-9a-f]{64}$/i.test(hash)) {
      throw invalidTrust(`entry for "${rawPath}" is not a sha256 hex digest`);
    }
    let relativePath: string;
    try {
      relativePath = assertSafeRelativePath(rawPath, "trust record path").split(sep).join("/");
    } catch {
      throw invalidTrust(`entry "${rawPath}" is not a safe project-relative path`);
    }
    files[relativePath] = hash.toLowerCase();
  }
  if (raw.allowCommands !== undefined && typeof raw.allowCommands !== "boolean") {
    throw invalidTrust("allowCommands must be a boolean when present");
  }
  return {
    version: TRUST_RECORD_VERSION,
    generatedAt: raw.generatedAt,
    files,
    ...(raw.allowCommands === true ? { allowCommands: true } : {}),
  };
}

/**
 * Write/refresh the trust record.
 *
 * The record hashes every command-source file byte for byte; JSON is stable
 * (sorted paths, fixed field order) so diffs are reviewable. Writes are atomic
 * (temp file in `.mygrace/` + rename), and the file is created with mode 0600.
 */
export function writeTrustRecord(projectRoot: string, options: { allowCommands?: boolean } = {}): TrustRecord {
  let files: Record<string, string>;
  try {
    files = computeTrustHashes(projectRoot);
  } catch (error) {
    throw new ConfigError(
      `Cannot hash the project command sources: ${error instanceof Error ? error.message : String(error)}`,
      { hint: "Check that docs/modules/ and docs/verification/ are readable." }
    );
  }

  let allowCommands = options.allowCommands;
  if (allowCommands === undefined) {
    try {
      allowCommands = loadTrustRecord(projectRoot)?.allowCommands === true;
    } catch {
      allowCommands = false; // corrupt record: regenerate from scratch
    }
  }

  const record: TrustRecord = {
    version: TRUST_RECORD_VERSION,
    generatedAt: new Date().toISOString(),
    files,
    ...(allowCommands === true ? { allowCommands: true } : {}),
  };

  const path = trustFilePath(projectRoot);
  const temporary = `${path}.tmp-${process.pid}-${Date.now()}`;
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(temporary, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
    renameSync(temporary, path);
  } catch (error) {
    try {
      unlinkSync(temporary); // never leave a half-written record behind
    } catch {
      // the temp file was never created or is already gone
    }
    throw new ConfigError(
      `Cannot write .mygrace/${TRUST_RECORD_FILENAME}: ${error instanceof Error ? error.message : String(error)}`,
      {
        file: `${MYGRACE_STATE_DIR}/${TRUST_RECORD_FILENAME}`,
        hint: "Check that the project directory is writable.",
      }
    );
  }
  return record;
}

/**
 * Compare the trust record with the files on disk.
 *
 * Never throws: every failure becomes an untrusted verdict with a readable
 * reason, so `test`/`verify` can print the exact commands and the fix.
 */
export function checkTrust(projectRoot: string): TrustCheck {
  const recordPath = trustFilePath(projectRoot);
  const base: TrustCheck = {
    trusted: false,
    reason: "",
    recordPath,
    recordFound: false,
    missing: [],
    stale: [],
    removed: [],
    fileCount: 0,
  };

  let record: TrustRecord | null;
  try {
    record = loadTrustRecord(projectRoot);
  } catch (error) {
    return {
      ...base,
      reason: `the trust record is invalid — ${error instanceof Error ? error.message : String(error)}`,
      error: {
        code: "TRUST_RECORD_INVALID",
        message: error instanceof Error ? error.message : String(error),
        ...(isMyGraceError(error) && error.hint !== undefined ? { hint: error.hint } : {}),
      },
    };
  }
  if (record === null) {
    return { ...base, reason: "no trust record (.mygrace/trust.json not found)" };
  }

  let hashes: Record<string, string>;
  try {
    hashes = computeTrustHashes(projectRoot);
  } catch (error) {
    return {
      ...base,
      recordFound: true,
      reason: `cannot hash the command sources — ${error instanceof Error ? error.message : String(error)}`,
      error: { code: "TRUST_HASH_FAILED", message: error instanceof Error ? error.message : String(error) },
    };
  }

  const current = Object.keys(hashes);
  const recorded = Object.keys(record.files);
  const missing = current.filter((file) => record.files[file] === undefined);
  const stale = current.filter((file) => record.files[file] !== undefined && record.files[file] !== hashes[file]);
  const removed = recorded.filter((file) => hashes[file] === undefined);
  const trusted = missing.length === 0 && stale.length === 0;

  return {
    trusted,
    reason: trusted
      ? "trust record is current"
      : `trust record is stale (${[...stale, ...missing].join(", ") || "unknown reasons"})`,
    recordPath,
    recordFound: true,
    missing,
    stale,
    removed,
    fileCount: current.length,
    generatedAt: record.generatedAt,
    ...(record.allowCommands === true ? { allowCommands: true } : {}),
  };
}

export type AuthorizationVia = "flag" | "config" | "trust" | null;

export interface CommandAuthorization {
  authorized: boolean;
  via: AuthorizationVia;
  /**
   * True when shell-ish commands (metacharacters, `sh -c`) may run: only the
   * explicit `--allow-commands` flag (or a persisted `trust.allowCommands`)
   * grants this, per ADR-1.
   */
  shellOptIn: boolean;
  trust: TrustCheck;
}

/**
 * The single place that answers "may project-declared commands run?".
 *
 * Precedence: `--allow-commands` flag > `config.allowCommands` > current trust
 * record. With no authorization the commands are printed but never executed.
 */
export function authorizeCommands(
  projectRoot: string,
  config: MyGraceConfig,
  allowCommandsFlag: boolean
): CommandAuthorization {
  const trust = checkTrust(projectRoot);
  if (allowCommandsFlag) {
    return { authorized: true, via: "flag", shellOptIn: true, trust };
  }
  if (config.allowCommands) {
    return { authorized: true, via: "config", shellOptIn: trust.allowCommands === true, trust };
  }
  if (trust.trusted) {
    return { authorized: true, via: "trust", shellOptIn: trust.allowCommands === true, trust };
  }
  return { authorized: false, via: null, shellOptIn: false, trust };
}

/** One-line reason for a refusal, with the actionable next step. */
export function trustRefusalHint(projectRoot: string, authorization: CommandAuthorization): string {
  const trust = authorization.trust;
  const reason = trust.recordFound
    ? trust.reason
    : "no valid trust record — commands come from docs/ files, which are attacker-controlled in a clone";
  return (
    `Refusing to execute project command(s): ${reason}. ` +
    `Review them first, then run \`mygrace trust --path ${projectRoot}\` ` +
    `or pass --allow-commands for a one-off run.`
  );
}

/** Lines that show exactly which commands would run (used by the refusal path). */
export function formatPlannedCommands(plans: readonly ModulePlan[]): string[] {
  const ready = plans.filter((plan) => plan.status === "ready");
  const invalid = plans.filter((plan) => plan.status === "invalid");
  if (ready.length === 0 && invalid.length === 0) return ["(no runnable commands were planned)"];
  const lines = ["Commands that WOULD run (not executed):"];
  for (const plan of ready) {
    const source = plan.source === "verification" ? "verification file" : plan.source === "module" ? "module file (deprecated)" : "config testRunner";
    lines.push(`  ${plan.module}: ${plan.argv.map(quoteArg).join(" ")}  [${source}]`);
  }
  for (const plan of invalid) {
    lines.push(`  ${plan.module}: INVALID — ${plan.error?.message ?? "invalid plan"}`);
  }
  if (ready.length === 0) lines.push("  (no executable commands — see the invalid entries above)");
  return lines;
}

function quoteArg(value: string): string {
  return /^[A-Za-z0-9_./:=@+-]+$/.test(value) ? value : JSON.stringify(value);
}

// ─── Executing a plan ──────────────────────────────────────────────────

export interface ModuleTestResult {
  module: string;
  ok: boolean;
  files: string[];
  output: string;
  /** Exact command (before `<file>` entries were appended). */
  command?: string;
  source?: CheckSource;
  /** Stable finding code when the module could not be validated/executed. */
  error?: { code: string; message: string; hint?: string; file?: string };
  /** True when the run was refused for trust reasons (no execution happened). */
  refused?: boolean;
  durationMs?: number;
}

export interface ExecutePlanOptions {
  compact?: boolean;
  authorization: CommandAuthorization;
  /** Explicit one-off opt-in for deny-listed dangerous command patterns. */
  allowUnsafeCommands?: boolean;
}

function resultFromPlan(plan: ModulePlan): ModuleTestResult {
  return {
    module: plan.module,
    ok: false,
    files: plan.files,
    command: plan.command,
    source: plan.source,
    output: "",
  };
}

/**
 * Execute one plan under an authorization decision.
 *
 * Findings never throw: validate/authorize failures become `ok: false` results
 * with a stable `error.code`. Usage errors are impossible here because the plan
 * is already validated.
 */
export function executeModulePlan(root: string, plan: ModulePlan, options: ExecutePlanOptions): ModuleTestResult {
  const base = resultFromPlan(plan);

  if (plan.status === "invalid" || plan.error !== undefined) {
    const error = plan.error ?? { code: "INVALID_PLAN", message: "invalid module plan" };
    return { ...base, error, output: `Error: ${error.message}` };
  }
  if (!options.authorization.authorized) {
    const hint = trustRefusalHint(root, options.authorization);
    return {
      ...base,
      refused: true,
      error: { code: "UNTRUSTED_PROJECT", message: hint },
      output: hint,
    };
  }
  if (plan.requiresShellOptIn && !options.authorization.shellOptIn) {
    const reason = plan.optInReason ?? "needs a shell-style command";
    const hint =
      `The check command for ${plan.module} ${reason}; argv-only execution is the default. ` +
      `Pass --allow-commands to run it (review the command first).`;
    appendAuditRecord(root, { event: "shell_refused", module: plan.module, command: plan.command, reason: "shell-opt-in-required" });
    return {
      ...base,
      error: { code: "SHELL_COMMAND_REFUSED", message: hint },
      output: hint,
    };
  }
  if (options.allowUnsafeCommands !== true) {
    const unsafe = inspectUnsafeCommand(plan.command);
    if (unsafe !== null) {
      const hint =
        `Refusing dangerous command for ${plan.module}: it matches "${unsafe.label}". ` +
        `Review it; pass --allow-unsafe-commands only if you really need it.`;
      appendAuditRecord(root, { event: "policy_refused", module: plan.module, command: plan.command, reason: unsafe.label });
      return {
        ...base,
        error: { code: "COMMAND_POLICY_DENIED", message: hint },
        output: hint,
      };
    }
  }

  const startedAt = Date.now();
  const [executable, ...argv] = plan.argv;
  if (executable === undefined) {
    return {
      ...base,
      error: { code: "CHECK_COMMAND_INVALID", message: "the declared check command is empty." },
      output: "Error: the declared check command is empty.",
    };
  }

  const result = spawnSync(executable, argv, {
    cwd: root,
    encoding: "utf-8",
    shell: false, // never a shell: argv is passed verbatim
    timeout: 10 * 60_000,
    maxBuffer: 16 * 1024 * 1024,
    env: process.env,
  });

  const output = ((result.stdout ?? "") + (result.stderr ?? "")).trim();
  if (result.error !== undefined) {
    const message = `cannot run "${executable}": ${result.error.message}`;
    return {
      ...base,
      durationMs: Date.now() - startedAt,
      error: { code: "CHECK_COMMAND_FAILED", message },
      output: (options.compact ? compactOutput(message) : message) || message,
    };
  }

  const durationMs = Date.now() - startedAt;
  appendAuditRecord(root, {
    event: "command_run",
    module: plan.module,
    command: plan.command,
    exitCode: result.status,
    durationMs,
    authorization: options.authorization.via,
    shellOptIn: options.authorization.shellOptIn,
  });
  return {
    ...base,
    ok: result.status === 0,
    durationMs,
    output: options.compact === true ? compactOutput(output) : output,
  };
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

/** Run one module's tests (plan + authorize + execute). */
export interface RunModuleTestsOptions {
  compact?: boolean;
  /** Explicit per-invocation opt-in (`--allow-commands`). */
  allowCommands?: boolean;
  /** Explicit one-off opt-in for deny-listed dangerous command patterns. */
  allowUnsafeCommands?: boolean;
  config?: MyGraceConfig;
  /** Precomputed authorization, so a multi-module run hashes files only once. */
  authorization?: CommandAuthorization;
}

export function runModuleTests(root: string, moduleId: string, options: RunModuleTestsOptions = {}): ModuleTestResult {
  const config = options.config ?? loadConfig(root).config;
  const authorization = options.authorization ?? authorizeCommands(root, config, options.allowCommands === true);
  const plan = planModuleTest(root, moduleId, config);
  return executeModulePlan(root, plan, {
    compact: options.compact === true,
    authorization,
    allowUnsafeCommands: options.allowUnsafeCommands === true,
  });
}

/** Run a batch of plans and aggregate the ADR-3 findings. */
export interface BatchRunResult {
  results: ModuleTestResult[];
  findings: Finding[];
  failed: number;
}

export function runModulePlans(
  root: string,
  plans: readonly ModulePlan[],
  authorization: CommandAuthorization,
  compact: boolean,
  allowUnsafeCommands = false
): BatchRunResult {
  const results = plans.map((plan) => executeModulePlan(root, plan, { compact, authorization, allowUnsafeCommands }));
  const findings: Finding[] = [];
  for (const result of results) {
    if (result.ok) continue;
    const problem = result.error;
    const code = problem?.code ?? "MODULE_TESTS_FAILED";
    findings.push(
      finding("error", code, `${result.module}: ${problem?.message ?? "tests failed"}`, {
        ...(problem?.file === undefined ? {} : { file: problem.file }),
        ...(problem?.hint === undefined ? {} : { hint: problem.hint }),
      })
    );
  }
  return { results, findings, failed: results.filter((result) => !result.ok).length };
}

/** Serialize a result for `--format json` (stable, no internal fields). */
export function serializeModuleResult(result: ModuleTestResult): Record<string, unknown> {
  return {
    module: result.module,
    ok: result.ok,
    command: result.command ?? null,
    source: result.source ?? null,
    files: result.files,
    output: result.output,
    ...(result.error === undefined ? {} : { error: result.error }),
    ...(result.durationMs === undefined ? {} : { durationMs: result.durationMs }),
  };
}

// ─── Module id selection shared by test/verify ─────────────────────────

/**
 * Turn `--module <id>` / default `--all` into a validated id list.
 * An explicit invalid id is a `UsageError` (exit 2, ADR-4); ids from the index
 * are validated again by `planModuleTest`.
 */
export function resolveModuleIds(root: string, moduleArg: string | undefined, all: boolean | undefined, commandName: string): string[] {
  if (moduleArg !== undefined && all === true) {
    throw new UsageError(`Use either --module <id> or --all, not both.`, {
      hint: `Run \`mygrace ${commandName} --module M-AUTH\` for one module, or \`mygrace ${commandName} --all\` for every module.`,
    });
  }
  if (moduleArg !== undefined) {
    return [assertEntityId("module", moduleArg)];
  }
  // Shard-aware: a graph index may reference <Shard href=…> entries.
  return loadGraphIndexStrict(root)
    .entries.map((entry) => entry.tag)
    .filter((tag) => tag.startsWith("M-"));
}

/** Plan every module, turning invalid index ids into invalid plans instead of crashes. */
export function planAllModules(root: string, modules: readonly string[], config: MyGraceConfig): ModulePlan[] {
  return modules.map((moduleId) => {
    try {
      return planModuleTest(root, moduleId, config);
    } catch (error) {
      if (!isMyGraceError(error)) throw error;
      const invalid: ModulePlan = {
        module: moduleId,
        status: "invalid",
        source: "config",
        command: config.testRunner,
        argv: [],
        files: [],
        moduleFile: `docs/modules/${moduleId}.xml`,
        verificationFile: null,
        requiresShellOptIn: false,
        error: {
          code: error.code,
          message: error.message,
          ...(error.hint === undefined ? {} : { hint: error.hint }),
        },
      };
      return invalid;
    }
  });
}

// ─── `mygrace trust` support ───────────────────────────────────────────

export interface DeclaredCommand {
  /** Verification/module file that declares it (project-relative). */
  file: string;
  module?: string;
  command: string;
  source: "verification" | "module" | "config";
}

/**
 * Review view for `mygrace trust`: every command the project declares, plus
 * findings for files that cannot be parsed (so a user never trusts blind).
 */
export function collectDeclaredCommands(root: string): { commands: DeclaredCommand[]; findings: Finding[] } {
  const commands: DeclaredCommand[] = [];
  const findings: Finding[] = [];
  const config = tryLoadConfig(root);
  if (!config.ok) {
    findings.push(
      finding("error", config.error.code, config.error.message, {
        file: configRelativePath(),
        ...(config.error.hint === undefined ? {} : { hint: config.error.hint }),
      })
    );
  }

  for (const relativePath of commandSourceFiles(root)) {
    if (!relativePath.startsWith(`${MODULES_DIR.split(sep).join("/")}/`) &&
        !relativePath.startsWith(`${VERIFICATION_DIR.split(sep).join("/")}/`)) {
      continue;
    }
    let document: XmlDocument;
    try {
      document = parseXml(readFileSync(join(root, relativePath), "utf-8"), relativePath);
    } catch (error) {
      findings.push(
        finding("error", "XML_INVALID", `Cannot parse ${relativePath}: ${error instanceof Error ? error.message : String(error)}`, {
          file: relativePath,
        })
      );
      continue;
    }
    const declared = checkCommandsOfDocument(document);
    if (declared.length === 0) continue;
    const isVerification = relativePath.startsWith(`${VERIFICATION_DIR.split(sep).join("/")}/`);
    const stem = basename(relativePath, ".xml");
    for (const command of declared) {
      commands.push({
        file: relativePath,
        module: isVerification ? stem.replace(/^V-/, "") : stem,
        command,
        source: isVerification ? "verification" : "module",
      });
    }
  }

  const configResult = tryLoadConfig(root);
  if (configResult.ok && configResult.result.raw?.testRunner !== undefined) {
    commands.push({ file: configRelativePath(), command: configResult.result.config.testRunner, source: "config" });
  }
  commands.sort((a, b) => a.file.localeCompare(b.file) || a.command.localeCompare(b.command));
  return { commands, findings };
}

/** Whether `.mygrace/` is ignored by the project's `.gitignore` (ADR-1). */
export function trustRecordGitignoreStatus(root: string): { gitignorePath: string; exists: boolean; ignored: boolean } {
  const gitignorePath = join(root, ".gitignore");
  if (!existsSync(gitignorePath)) return { gitignorePath, exists: false, ignored: false };
  let content: string;
  try {
    content = readFileSync(gitignorePath, "utf-8");
  } catch {
    return { gitignorePath, exists: true, ignored: false };
  }
  const ignored = content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== "" && !line.startsWith("#"))
    .some((line) => /^\/?\.mygrace(\/(\*{1,2})?)?$/.test(line));
  return { gitignorePath, exists: true, ignored };
}

// ─── `mygrace test` ────────────────────────────────────────────────────

function textForResults(results: readonly ModuleTestResult[]): string[] {
  const lines: string[] = [];
  for (const result of results) {
    lines.push(`=== ${result.module} ===`);
    if (result.command !== undefined) lines.push(`command: ${result.command}`);
    if (result.error !== undefined) lines.push(`error: [${result.error.code}] ${result.error.message}`);
    lines.push(`files: ${result.files.join(", ") || "(none)"}`);
    if (result.output) lines.push(result.output);
    lines.push("");
  }
  return lines;
}

export const testCommand = defineCommand({
  meta: {
    name: "test",
    description:
      "Run module tests scoped from verification files (canonical <module-checks> in docs/verification, exit 1 on failures; commands require trust/--allow-commands)",
  },
  args: {
    module: { type: "string", description: "Module ID (e.g. M-AUTH); omit = all modules" },
    compact: { type: "boolean", default: false, description: "Print only failures and the summary" },
    path: { type: "string", default: ".", description: "Project root" },
    format: { type: "string", default: "text", description: "Output format: text or json" },
    allowCommands: {
      type: "boolean",
      default: false,
      description: "Execute project-declared commands for this run without a trust record (also enables shell-style commands; opt-in only)",
    },
    allowUnsafeCommands: {
      type: "boolean",
      default: false,
      description: "One-off opt-in for deny-listed dangerous command patterns (privilege escalation, network tools, destructive commands)",
    },
  },
  run: async ({ args }) => {
    const format = parseOutputFormat(args.format);
    await runCommandOutcome<unknown>(format, { command: "test" }, (): CommandOutcome<unknown> => {
      const root = findProjectRoot(args.path ?? ".");
      const config = loadConfig(root).config;
      const modules = resolveModuleIds(root, args.module, undefined, "test");
      const plans = planAllModules(root, modules, config);
      const authorization = authorizeCommands(root, config, args.allowCommands === true);
      const runnable = plans.filter((plan) => plan.status === "ready");

      if (!authorization.authorized && runnable.length > 0) {
        const commands = runnable.map((plan) => `${plan.module}: ${plan.command}`).join("; ");
        const trustError = new TrustError(root, commands, {
          hint:
            `Review the commands listed above in docs/verification/V-M-XXX.xml (canonical; docs/modules/*.xml is a deprecated fallback), ` +
            `then run \`mygrace trust --path ${root}\` or pass --allow-commands.`,
        });
        const lines = [
          "MyGRACE refused to run project commands (no trust).",
          ...formatPlannedCommands(plans),
          "",
          `reason: ${authorization.trust.reason}`,
          `mygrace: ${trustError.toLine()}`,
        ];
        const findings = plans
          .filter((plan) => plan.status === "invalid")
          .map((plan) =>
            finding("error", plan.error?.code ?? "INVALID_PLAN", `${plan.module}: ${plan.error?.message ?? "invalid plan"}`, {
              ...(plan.error?.file === undefined ? {} : { file: plan.error.file }),
              ...(plan.error?.hint === undefined ? {} : { hint: plan.error.hint }),
            })
          );
        const envelope = createEnvelope({
          error: trustError,
          data: { root, modules: plans.map((plan) => ({ module: plan.module, command: plan.command, source: plan.source, files: plan.files })) },
          findings,
          meta: { command: "test", root },
        });
        return { envelope, print: () => lines.forEach((line) => console.log(line)) };
      }

      const batch = runModulePlans(root, plans, authorization, args.compact === true, args.allowUnsafeCommands === true);
      const lines = textForResults(batch.results);
      lines.push(`Summary: ${batch.results.length} module(s), ${batch.failed} failed`);
      const envelope = createEnvelope({
        data: {
          root,
          modules: batch.results.map(serializeModuleResult),
          summary: { total: batch.results.length, failed: batch.failed },
          authorization: { via: authorization.via, trusted: authorization.trust.trusted },
        },
        findings: batch.findings,
        meta: { command: "test", root },
      });
      return { envelope, print: () => lines.forEach((line) => console.log(line)) };
    });
  },
});

// ─── `mygrace trust` ───────────────────────────────────────────────────

export const trustCommand = defineCommand({
  meta: {
    name: "trust",
    description:
      "Review project-declared commands and record their sha256 hashes in .mygrace/trust.json so mygrace test/verify may execute them (never commit the record)",
  },
  args: {
    path: { type: "string", default: ".", description: "Project root" },
    format: { type: "string", default: "text", description: "Output format: text or json" },
    allowCommands: {
      type: "boolean",
      default: false,
      description: "Persist shell-command opt-in in the trust record (enables metacharacter/sh -c commands until re-trusted)",
    },
    check: {
      type: "boolean",
      default: false,
      description: "Check whether the current trust record is valid without writing anything (exit 1 when missing/stale)",
    },
    revoke: {
      type: "boolean",
      default: false,
      description: "Delete the local trust record so project commands are refused again",
    },
  },
  run: async ({ args }) => {
    const format = parseOutputFormat(args.format);
    await runCommandOutcome<unknown>(format, { command: "trust" }, (): CommandOutcome<unknown> => {
      const root = findProjectRoot(args.path ?? ".");
      if (args.check === true && args.revoke === true) {
        throw new UsageError("--check and --revoke are mutually exclusive.", {
          hint: "Use --check to inspect the record or --revoke to delete it.",
        });
      }
      if (args.revoke === true) {
        const recordPath = trustFilePath(root);
        if (existsSync(recordPath)) {
          unlinkSync(recordPath);
          appendAuditRecord(root, { event: "trust_revoked", recordPath });
        }
        const lines = [
          existsSync(recordPath) ? "Could not revoke the trust record." : `Revoked ${recordPath}`,
          "Project commands are refused again until `mygrace trust` is re-run.",
        ];
        const envelope = createEnvelope({
          data: { root, recordPath, revoked: true },
          findings: [],
          meta: { command: "trust", root },
        });
        return { envelope, print: () => lines.forEach((line) => console.log(line)) };
      }
      const gathered = collectDeclaredCommands(root);
      if (args.check === true) {
        const trust = checkTrust(root);
        const findings: Finding[] = [...gathered.findings];
        for (const declared of gathered.commands) {
          const unsafe = inspectUnsafeCommand(declared.command);
          if (unsafe !== null) {
            findings.push(
              finding("warning", "UNSAFE_COMMAND_DECLARED", `${declared.file}: command matches "${unsafe.label}" and will require --allow-unsafe-commands.`, {
                file: declared.file,
                hint: "Edit the command or review it before running with the unsafe opt-in.",
              })
            );
          }
        }
        if (!trust.trusted) {
          findings.push(
            finding("error", "TRUST_RECORD_STALE", `Trust record is not current: ${trust.reason}.`, {
              hint: "Review declared commands, then run `mygrace trust` to record hashes.",
            })
          );
        }
        const lines = [
          "MyGRACE trust --check",
          "=====================",
          "",
          `Record: ${trust.recordPath}`,
          `Status: ${trust.trusted ? "current" : "MISSING/STALE"} — ${trust.reason}`,
          `Command sources: ${trust.fileCount} file(s)`,
          "",
          ...(gathered.commands.length === 0
            ? ["  (no <module-checks> declared — default testRunner will be used)"]
            : gathered.commands.map((declared) => `  ${declared.file} — ${declared.module ?? "config"}: ${declared.command}`)),
          "",
          ...findings.map((item) => `${item.severity === "error" ? "✗" : "⚠"} [${item.code}] ${item.message}`),
        ];
        const envelope = createEnvelope({
          data: { root, trusted: trust.trusted, reason: trust.reason, recordPath: trust.recordPath, commands: gathered.commands },
          findings,
          meta: { command: "trust", root },
        });
        return { envelope, print: () => lines.forEach((line) => console.log(line)) };
      }
      const record = writeTrustRecord(root, { allowCommands: args.allowCommands === true });
      const gitignore = trustRecordGitignoreStatus(root);
      const findings = [...gathered.findings];
      for (const declared of gathered.commands) {
        const unsafe = inspectUnsafeCommand(declared.command);
        if (unsafe !== null) {
          findings.push(
            finding("warning", "UNSAFE_COMMAND_DECLARED", `${declared.file}: command matches "${unsafe.label}"; execution will require --allow-unsafe-commands.`, {
              file: declared.file,
              hint: "Edit the command or review it before using the unsafe opt-in.",
            })
          );
        }
      }
      if (!gitignore.exists) {
        findings.push(
          finding("warning", "TRUST_RECORD_NOT_GITIGNORED", "no .gitignore found — make sure .mygrace/ is never committed.", {
            file: ".gitignore",
            hint: "Add `.mygrace/` to .gitignore before committing.",
          })
        );
      } else if (!gitignore.ignored) {
        findings.push(
          finding("warning", "TRUST_RECORD_NOT_GITIGNORED", ".mygrace/ is not ignored by .gitignore.", {
            file: ".gitignore",
            hint: "Add `.mygrace/` to .gitignore: a committed trust record would defeat the trust model.",
          })
        );
      }

      const lines = [
        "MyGRACE trust",
        "=============",
        "",
        `Command sources (${Object.keys(record.files).length} file(s) hashed):`,
      ];
      if (gathered.commands.length === 0) {
        lines.push("  (no <module-checks> declared — default testRunner will be used)");
      } else {
        for (const declared of gathered.commands) {
          const where = declared.source === "module" ? "module file (deprecated location)" : declared.source;
          lines.push(`  ${declared.file} — ${declared.module ?? "config"}: ${declared.command}  [${where}]`);
        }
      }
      lines.push("", `Wrote ${trustFilePath(root)}`);
      if (record.allowCommands === true) lines.push("Recorded shell-command opt-in (allowCommands: true).");
      for (const item of findings) {
        lines.push(`${item.severity === "error" ? "✗" : "⚠"} [${item.code}] ${item.message}`);
      }
      lines.push("");
      lines.push(`Next: \`mygrace test --path ${root}\` (or verify) will now execute these commands.`);
      lines.push(`Re-run \`mygrace trust\` after editing docs/modules/, docs/verification/ or mygrace.config.json.`);

      const envelope = createEnvelope({
        data: {
          root,
          recordPath: trustFilePath(root),
          trusted: true,
          generatedAt: record.generatedAt,
          files: Object.keys(record.files),
          commands: gathered.commands,
          gitignore,
        },
        findings,
        meta: { command: "trust", root },
      });
      return { envelope, print: () => lines.forEach((line) => console.log(line)) };
    });
  },
});
