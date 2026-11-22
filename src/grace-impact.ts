#!/usr/bin/env bun
/**
 * MyGRACE — `mygrace impact`.
 *
 * Answers the question an agent asks before touching code: "what does this
 * change affect?" Changed files come from explicit `--files`, the git index
 * (`--staged`), or a git revision (`--since <ref>`, default `HEAD`). They are
 * mapped to modules through the index PATH (exact match or module-directory
 * prefix), and to modules/phases through `docs/` entities. From the direct
 * modules the command computes the transitive reverse-DEPENDS closure, the
 * verification/test-file blast radius, phases that mention the affected
 * modules, and the commands that prove the change.
 *
 * Everything here is read-only and PATH-free: git is spawned with an absolute
 * argv (no shell), a 2 s timeout, and a graceful `UsageError` fallback.
 */

// START_MODULE_CONTRACT
//   PURPOSE: Map changed files to affected modules/phases and print the verification blast radius (`mygrace impact`).
//   SCOPE: Read-only. Spawns `git diff` (argv-only, 2 s timeout) and reads docs/ through the foundation modules; never writes.
//   DEPENDS: grace-common, grace-config, grace-errors, grace-paths, grace-shard, grace-test
//   LINKS: docs/modules/M-IMPACT.xml
// END_MODULE_CONTRACT

// START_MODULE_MAP
//   ImpactFileSource        — where the changed files came from (files|staged|since|head)
//   ChangedFiles            — resolved project-relative files + skipped paths + source
//   FileMapping             — one changed file → modules/phases (with mapping reason)
//   VerificationImpact      — per-module verification ref, test files and missing files
//   AffectedPhase           — phase that changed directly or mentions an affected module
//   ImpactResult            — files, directModules, dependents, verificationStatus, phases, commands, notes, findings
//   resolveChangedFiles()   — --files > --staged > --since > git diff HEAD (UsageError fallback)
//   computeImpact()         — full read-only impact computation
//   impactCommand           — `mygrace impact [--files] [--since] [--staged] [--path] [--format]`
// END_MODULE_MAP

// START_CHANGE_SUMMARY
//   2026-11-22 — v1.3: git/explicit changed-file scope, PATH + dir-prefix + docs-entity mapping,
//                transitive dependents, verification blast radius, phase mentions, suggested commands.
// END_CHANGE_SUMMARY

import { defineCommand } from "citty";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { findProjectRoot, listEntityFiles, readFileOrNull, readIndexFileSafe } from "./grace-common";
import type { IndexEntry } from "./grace-common";
import { loadConfig } from "./grace-config";
import type { MyGraceConfig } from "./grace-config";
import { createEnvelope, finding, UsageError } from "./grace-errors";
import type { Finding } from "./grace-errors";
import { assertSafeRelativePath } from "./grace-paths";
import { loadGraphIndexStrict } from "./grace-shard";
import {
  authorizeCommands,
  collectDeclaredCommands,
  parseOutputFormat,
  parseTestFiles,
  runCommandOutcome,
} from "./grace-test";
import type { CommandOutcome } from "./grace-test";

// START_BLOCK_CONSTANTS
const MODULE_TAG_RE = /^M-[A-Za-z0-9][A-Za-z0-9_-]*$/;
const PHASE_TAG_RE = /^Phase-[0-9]+[A-Za-z]?$/;
const DOCS_INDEX_RE = /^docs\/(?:graph-index|plan-index|verification-index)\.xml$/;
const SHARD_FILE_RE = /^docs\/modules\/shard-[^/]+\.xml$/;
const GIT_TIMEOUT_MS = 2_000;
const GIT_MAX_BUFFER = 4 * 1024 * 1024;
/** Git revisions accepted by --since: no leading dash (option injection) and no control chars. */
const GIT_REF_RE = /^[A-Za-z0-9._/@{}~^+-]+$/u;
// END_BLOCK_CONSTANTS

// START_BLOCK_PATHS
/** Project-relative POSIX path (the form used by git and the docs indexes). */
function toPosix(value: string): string {
  return value.replaceAll("\\", "/");
}

/** Normalize a user/git path: POSIX separators, no leading `./`, no trailing slash. */
function normalizeChangedFile(value: string): string | null {
  const posix = toPosix(value.trim()).replace(/^\.\/+/, "").replace(/\/+$/, "");
  if (posix === "" || posix === ".") return null;
  try {
    assertSafeRelativePath(posix, "changed file");
  } catch {
    return null;
  }
  return posix;
}

function posixDirname(value: string): string {
  const index = value.lastIndexOf("/");
  return index <= 0 ? "." : value.slice(0, index);
}

/** Render a CLI path deterministically: "." when the target is the process cwd. */
function cliPath(target: string): string {
  return resolve(target) === resolve(process.cwd()) ? "." : resolve(target);
}

/** Minimal shell-style quoting for suggested commands shown to humans/agents. */
function quoteCli(value: string): string {
  return /^[A-Za-z0-9_./:=@%^+,-]+$/u.test(value) ? value : `'${value.replaceAll("'", `'\\''`)}'`;
}

function cliCommand(...parts: string[]): string {
  return ["mygrace", ...parts].map(quoteCli).join(" ");
}
// END_BLOCK_PATHS

// START_BLOCK_GIT
interface GitRun {
  ok: boolean;
  stdout: string;
  message: string;
}

/** First readable line of a failed git invocation (never a stack trace). */
function gitErrorMessage(error: unknown): string {
  if (error !== null && typeof error === "object") {
    const failure = error as { stderr?: string | Buffer; message?: string };
    const stderr = failure.stderr === undefined ? "" : failure.stderr.toString().trim();
    if (stderr !== "") {
      const first = stderr.split("\n").map((line) => line.trim()).find((line) => line !== "");
      if (first !== undefined) return first;
    }
    if (typeof failure.message === "string") {
      const first = failure.message.split("\n")[0];
      if (first !== undefined && first.trim() !== "") return first.trim();
    }
  }
  return String(error);
}

/**
 * Run one `git -C <root> …` command with a 2 s timeout and argv-only arguments.
 *
 * Graceful by design: a missing git binary, a non-repository directory or a bad
 * revision comes back as `{ ok: false, message }` so callers can raise a typed
 * `UsageError` with an actionable hint instead of leaking a stack trace.
 */
function runGit(root: string, args: readonly string[]): GitRun {
  try {
    const stdout = execFileSync("git", ["-C", root, "-c", "core.quotePath=false", ...args], {
      encoding: "utf-8",
      timeout: GIT_TIMEOUT_MS,
      maxBuffer: GIT_MAX_BUFFER,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    return { ok: true, stdout: typeof stdout === "string" ? stdout : String(stdout), message: "" };
  } catch (error) {
    return { ok: false, stdout: "", message: gitErrorMessage(error) };
  }
}

/** `git --show-prefix`: the project root's path inside the repository ("" at the repo root). */
function repositoryPrefix(root: string): string {
  const result = runGit(root, ["rev-parse", "--show-prefix"]);
  if (!result.ok) return "";
  return toPosix(result.stdout.trim()).replace(/\/+$/, "");
}
// END_BLOCK_GIT

// START_BLOCK_CHANGED_FILES
export type ImpactFileSource = "files" | "staged" | "since" | "head";

export interface SkippedChangedFile {
  file: string;
  reason: string;
}

export interface ChangedFiles {
  source: ImpactFileSource;
  /** Revision used by `--since` / `head`. */
  ref?: string;
  /** Project-relative POSIX paths, sorted and unique. */
  files: string[];
  /** Paths git reported but that cannot be used (outside the project, unsafe). */
  skipped: SkippedChangedFile[];
  /** Non-fatal note about how the scope was obtained. */
  note: string;
}

export interface ChangedFileOptions {
  /** Comma (or space/newline) separated explicit files. */
  files?: string;
  /** Git revision to diff against (`--since`). */
  since?: string;
  /** Use the git index (`git diff --cached`). */
  staged?: boolean;
}

function splitFileList(value: string): string[] {
  return value
    .split(/[,\n]/u)
    .map((entry) => entry.trim())
    .filter((entry) => entry !== "");
}

function parseExplicitFiles(value: string): string[] {
  const files: string[] = [];
  for (const entry of splitFileList(value)) {
    const safe = assertSafeRelativePath(entry, "changed file"); // throws UsageError on traversal/absolute
    const normalized = normalizeChangedFile(safe);
    if (normalized === null) {
      throw new UsageError(`Invalid changed file "${entry}".`, {
        hint: "Pass project-relative paths, e.g. --files src/a.ts,docs/graph-index.xml.",
      });
    }
    if (!files.includes(normalized)) files.push(normalized);
  }
  return files.sort();
}

function normalizeGitPaths(root: string, stdout: string): { files: string[]; skipped: SkippedChangedFile[] } {
  const prefix = repositoryPrefix(root);
  const files: string[] = [];
  const skipped: SkippedChangedFile[] = [];
  for (const line of stdout.split("\n")) {
    const repoPath = toPosix(line.trim());
    if (repoPath === "") continue;
    let projectPath = repoPath;
    if (prefix !== "" && repoPath !== prefix.replace(/\/+$/, "")) {
      if (!repoPath.startsWith(`${prefix}/`)) {
        skipped.push({ file: repoPath, reason: "outside the project root inside the git repository" });
        continue;
      }
      projectPath = repoPath.slice(prefix.length + 1);
    }
    const normalized = normalizeChangedFile(projectPath);
    if (normalized === null) {
      skipped.push({ file: repoPath, reason: "unsafe or empty project-relative path" });
      continue;
    }
    if (!files.includes(normalized)) files.push(normalized);
  }
  return { files: files.sort(), skipped };
}

/**
 * Resolve the changed-file set for impact.
 *
 * Precedence (documented in the tool help): explicit `--files` → `--staged` →
 * `--since <ref>` → `git diff HEAD` (working tree + index). Any git failure is
 * a typed `UsageError` with a `--files` fallback hint (exit 2), never a crash.
 */
export function resolveChangedFiles(root: string, options: ChangedFileOptions = {}): ChangedFiles {
  const explicit = (options.files ?? "").trim();
  if (explicit !== "") {
    return {
      source: "files",
      files: parseExplicitFiles(explicit),
      skipped: [],
      note: `Changed files resolved from --files (${splitFileList(explicit).length} entry/entries).`,
    };
  }

  if (options.staged === true) {
    const staged = runGit(root, ["diff", "--cached", "--name-only", "--"]);
    if (!staged.ok) {
      throw new UsageError(`git diff --cached failed: ${staged.message}`, {
        hint: "Run inside a git work tree with staged changes, or pass --files <a,b,c> explicitly.",
      });
    }
    const parsed = normalizeGitPaths(root, staged.stdout);
    return {
      source: "staged",
      files: parsed.files,
      skipped: parsed.skipped,
      note: `Changed files resolved from the git index (${parsed.files.length} file(s)).`,
    };
  }

  const since = (options.since ?? "").trim();
  if (since !== "") {
    if (since.startsWith("-") || !GIT_REF_RE.test(since)) {
      throw new UsageError(`Invalid --since revision "${since}".`, {
        hint: "Pass a git revision name, e.g. --since HEAD~1 or --since origin/main.",
      });
    }
    const diff = runGit(root, ["diff", "--name-only", since, "--"]);
    if (!diff.ok) {
      throw new UsageError(`git diff ${since} failed: ${diff.message}`, {
        hint: "Check the revision and that the repository has commits, or pass --files <a,b,c> explicitly.",
      });
    }
    const parsed = normalizeGitPaths(root, diff.stdout);
    return {
      source: "since",
      ref: since,
      files: parsed.files,
      skipped: parsed.skipped,
      note: `Changed files resolved from git diff ${since} (${parsed.files.length} file(s)).`,
    };
  }

  const workingTree = runGit(root, ["diff", "--name-only", "HEAD", "--"]);
  if (!workingTree.ok) {
    throw new UsageError(`No changed-file source available: git diff HEAD failed (${workingTree.message}).`, {
      hint: "Pass --files a,b,c (works without git), --staged for the git index, or --since <ref> for a revision range.",
    });
  }
  const parsed = normalizeGitPaths(root, workingTree.stdout);
  return {
    source: "head",
    ref: "HEAD",
    files: parsed.files,
    skipped: parsed.skipped,
    note: `Changed files resolved from git diff HEAD (${parsed.files.length} file(s)).`,
  };
}
// END_BLOCK_CHANGED_FILES

// START_BLOCK_MAPPING
export interface FileMapping {
  file: string;
  /** Modules this file maps to directly. */
  modules: string[];
  /** Phases this file maps to directly (docs/plans/Phase-N.xml edits). */
  phases: string[];
  reason: "exact-path" | "dir-prefix" | "docs-entity" | "none";
}

interface ModuleInfo {
  id: string;
  /** Project-relative POSIX PATH from graph-index.xml ("" when absent). */
  path: string;
  depends: string[];
  verificationRef: string;
  status: string;
}

const MODULE_ENTITY_RE = /^docs\/modules\/(M-[A-Za-z0-9][A-Za-z0-9_-]*)\.xml$/u;
const VERIFICATION_ENTITY_RE = /^docs\/verification\/(V-M-[A-Za-z0-9][A-Za-z0-9_-]*)\.xml$/u;
const PHASE_ENTITY_RE = /^docs\/plans\/(Phase-[0-9]+[A-Za-z]?)\.xml$/u;

function splitDepends(value: string): string[] {
  return value
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry !== "");
}

function moduleInfos(entries: readonly IndexEntry[]): ModuleInfo[] {
  const modules: ModuleInfo[] = [];
  for (const entry of entries) {
    if (!MODULE_TAG_RE.test(entry.tag)) continue;
    const path = (entry.attrs.PATH ?? "").trim();
    modules.push({
      id: entry.tag,
      path: path === "" ? "" : toPosix(path).replace(/^\.\/+/, ""),
      depends: splitDepends(entry.attrs.DEPENDS ?? ""),
      verificationRef: (entry.attrs.VERIFICATION_REF ?? "").trim(),
      status: (entry.attrs.STATUS ?? entry.attrs.status ?? "").toLowerCase(),
    });
  }
  return modules;
}

/**
 * Directory-prefix mapping: a module whose PATH lives in `dir` owns files under
 * `dir/`. Directories that are configured source roots (`src`, `lib`, …) are
 * skipped, otherwise a module at `src/index.ts` would claim the whole tree.
 */
function dirPrefixOwner(file: string, modules: readonly ModuleInfo[], sourceRoots: ReadonlySet<string>): string | undefined {
  for (const module of modules) {
    if (module.path === "") continue;
    const dir = posixDirname(module.path);
    if (dir === "." || dir === "" || sourceRoots.has(dir)) continue;
    if (file.startsWith(`${dir}/`)) return module.id;
  }
  return undefined;
}

function moduleOfDocsEntity(file: string): string | undefined {
  const moduleEntity = MODULE_ENTITY_RE.exec(file);
  if (moduleEntity !== null) return moduleEntity[1];
  const verificationEntity = VERIFICATION_ENTITY_RE.exec(file);
  if (verificationEntity !== null) return `M-${verificationEntity[1].slice("V-M-".length)}`;
  return undefined;
}

function phaseOfDocsEntity(file: string): string | undefined {
  const match = PHASE_ENTITY_RE.exec(file);
  return match === null ? undefined : match[1];
}

function sourceRootsOf(config: MyGraceConfig): Set<string> {
  return new Set(config.sourceDirs.map((dir) => toPosix(dir).replace(/^\.\/+/, "").replace(/\/+$/, "")));
}

/** Map every changed file to modules and phases; deterministic and order-independent. */
export function mapChangedFiles(
  files: readonly string[],
  modules: readonly ModuleInfo[],
  sourceRoots: ReadonlySet<string>
): FileMapping[] {
  return files.map((file) => {
    const modulesHit = new Set<string>();
    const phasesHit = new Set<string>();
    let exact = false;
    let dirPrefix = false;

    const entityModule = moduleOfDocsEntity(file);
    if (entityModule !== undefined) modulesHit.add(entityModule);

    const entityPhase = phaseOfDocsEntity(file);
    if (entityPhase !== undefined) phasesHit.add(entityPhase);

    for (const module of modules) {
      if (module.path !== "" && module.path === file) {
        modulesHit.add(module.id);
        exact = true;
      }
    }
    if (modulesHit.size === 0) {
      const owner = dirPrefixOwner(file, modules, sourceRoots);
      if (owner !== undefined) {
        modulesHit.add(owner);
        dirPrefix = true;
      }
    }

    const order = new Map(modules.map((module, index) => [module.id, index]));
    const sortedModules = [...modulesHit].sort((a, b) => {
      const left = order.get(a);
      const right = order.get(b);
      if (left === undefined || right === undefined) return left === undefined ? (right === undefined ? a.localeCompare(b) : -1) : 1;
      return left - right;
    });

    const reason: FileMapping["reason"] =
      entityModule !== undefined
        ? "docs-entity"
        : exact
          ? "exact-path"
          : dirPrefix
            ? "dir-prefix"
            : phasesHit.size > 0
              ? "docs-entity"
              : "none";

    return { file, modules: sortedModules, phases: [...phasesHit], reason };
  });
}

/** Transitive reverse-DEPENDS closure: every module that (directly or indirectly) depends on an affected one. */
export function collectDependents(modules: readonly ModuleInfo[], directModules: readonly string[]): string[] {
  const affected = new Set(directModules);
  const dependents: string[] = [];
  let grew = true;
  while (grew) {
    grew = false;
    for (const module of modules) {
      if (affected.has(module.id)) continue;
      if (module.depends.some((dependency) => affected.has(dependency))) {
        affected.add(module.id);
        dependents.push(module.id);
        grew = true;
      }
    }
  }
  return dependents;
}
// END_BLOCK_MAPPING

// START_BLOCK_IMPACT
export interface VerificationTestFile {
  file: string;
  exists: boolean;
}

export interface ModuleVerificationImpact {
  module: string;
  verificationRef: string;
  /** Project-relative verification file path, or null when the ref is missing. */
  file: string | null;
  fileExists: boolean;
  testFiles: VerificationTestFile[];
}

export interface VerificationImpactStatus {
  /** One entry per affected module, in index order. */
  modules: ModuleVerificationImpact[];
  modulesWithoutVerification: string[];
  modulesWithMissingTestFiles: string[];
  missingTestFiles: string[];
}

export interface AffectedPhase {
  id: string;
  file: string;
  reason: "direct" | "mentions";
  /** Affected modules mentioned by this phase (empty for a directly edited phase with no mention). */
  modules: string[];
  /** True when the phase file does not exist. */
  fileMissing: boolean;
}

export interface ImpactData {
  files: string[];
  directModules: string[];
  dependents: string[];
  verificationStatus: VerificationImpactStatus;
  affectedPhases: AffectedPhase[];
  suggestedCommands: string[];
  notes: string[];
}

export interface ImpactResult extends ImpactData {
  root: string;
  source: ImpactFileSource;
  skipped: SkippedChangedFile[];
  findings: Finding[];
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function mentionsAny(content: string, ids: readonly string[]): string[] {
  const mentioned: string[] = [];
  for (const id of ids) {
    if (new RegExp(`(^|[^A-Za-z0-9_-])${escapeRegExp(id)}([^A-Za-z0-9_-]|$)`, "u").test(content)) mentioned.push(id);
  }
  return mentioned;
}

function phaseNumber(id: string): number {
  const match = /^Phase-([0-9]+)/u.exec(id);
  return match === null ? Number.MAX_SAFE_INTEGER : Number(match[1]);
}

function verificationStatusOf(
  root: string,
  affectedModules: readonly string[],
  modules: readonly ModuleInfo[],
  notes: string[]
): VerificationImpactStatus {
  const byId = new Map(modules.map((module) => [module.id, module]));
  const status: VerificationImpactStatus = {
    modules: [],
    modulesWithoutVerification: [],
    modulesWithMissingTestFiles: [],
    missingTestFiles: [],
  };

  for (const moduleId of affectedModules) {
    const info = byId.get(moduleId);
    const verificationRef = info?.verificationRef ?? "";
    const file = verificationRef === "" ? null : `docs/verification/${verificationRef}.xml`;
    const fileExists = file !== null && existsSync(join(root, file));
    const entry: ModuleVerificationImpact = { module: moduleId, verificationRef, file, fileExists, testFiles: [] };

    if (file === null || !fileExists) {
      status.modulesWithoutVerification.push(moduleId);
      status.modules.push(entry);
      continue;
    }

    const content = readFileOrNull(join(root, file));
    if (content === null) {
      status.modulesWithoutVerification.push(moduleId);
      status.modules.push(entry);
      continue;
    }
    let declared: string[] = [];
    try {
      declared = parseTestFiles(content);
    } catch (error) {
      notes.push(`${file}: cannot parse <test-files> (${error instanceof Error ? error.message : String(error)}).`);
    }
    for (const testFile of declared) {
      let safe: string;
      try {
        safe = assertSafeRelativePath(testFile, "test file path");
      } catch {
        notes.push(`${file}: skipping unsafe <file> entry "${testFile}".`);
        continue;
      }
      const testFileExists = existsSync(join(root, safe));
      entry.testFiles.push({ file: safe, exists: testFileExists });
      if (!testFileExists) {
        status.missingTestFiles.push(safe);
        if (!status.modulesWithMissingTestFiles.includes(moduleId)) status.modulesWithMissingTestFiles.push(moduleId);
      }
    }
    status.modules.push(entry);
  }

  return status;
}

function affectedPhasesOf(
  root: string,
  affectedModules: readonly string[],
  directPhases: readonly string[],
  notes: string[]
): AffectedPhase[] {
  const planRead = readIndexFileSafe(join(root, "docs", "plan-index.xml"));
  if (planRead.error !== undefined) notes.push(`docs/plan-index.xml: ${planRead.error.message}; phase mentions were not scanned.`);
  const planIds = planRead.entries.filter((entry) => PHASE_TAG_RE.test(entry.tag)).map((entry) => entry.tag);
  // Include on-disk phase entities too: an unindexed Phase-N.xml still mentions modules
  // (missing index rows are a lint error, but impact should not silently ignore the file).
  const phaseFiles = listEntityFiles(join(root, "docs", "plans"), "Phase-").map((file) => file.replace(/\.xml$/u, ""));
  const candidates = new Set<string>([...planIds, ...phaseFiles, ...directPhases]);

  const phases: AffectedPhase[] = [];
  for (const id of candidates) {
    const file = `docs/plans/${id}.xml`;
    const content = readFileOrNull(join(root, file));
    const direct = directPhases.includes(id);
    if (content === null) {
      if (direct) {
        phases.push({ id, file, reason: "direct", modules: [], fileMissing: true });
        notes.push(`${file}: phase file is missing (referenced by docs/plan-index.xml or the change set).`);
      }
      continue;
    }
    const mentioned = mentionsAny(content, affectedModules);
    if (direct || mentioned.length > 0) {
      phases.push({ id, file, reason: direct ? "direct" : "mentions", modules: mentioned, fileMissing: false });
    }
  }

  phases.sort((left, right) => phaseNumber(left.id) - phaseNumber(right.id) || left.id.localeCompare(right.id));
  return phases;
}

function suggestedCommandsOf(root: string, config: MyGraceConfig, affectedModules: readonly string[], notes: string[]): string[] {
  const commands: string[] = [];
  const pathArg = cliPath(root);

  if (affectedModules.length > 0) {
    const declared = collectDeclaredCommands(root);
    const authorization = authorizeCommands(root, config, false);
    if (declared.commands.length > 0 && !authorization.authorized) {
      commands.push(cliCommand("trust", "--path", pathArg));
      notes.push("Project commands are not trusted yet: run `mygrace trust` before `mygrace verify` will execute them.");
    }
  }

  for (const moduleId of affectedModules) {
    commands.push(cliCommand("verify", "--module", moduleId, "--path", pathArg));
  }
  commands.push(cliCommand("ci", "--path", pathArg));
  return commands;
}

/**
 * Compute the full impact report for a project.
 *
 * Read-only; throws typed errors for usage/config problems (exit 2) and for a
 * malformed index (lint will explain it in detail). Info findings never make
 * the command fail — impact is advice, so a successful run exits 0.
 */
export function computeImpact(rootInput: string, options: ChangedFileOptions = {}): ImpactResult {
  const root = findProjectRoot(rootInput);
  const config = loadConfig(root).config;
  const notes: string[] = [];

  const changed = resolveChangedFiles(root, options);
  notes.push(changed.note);
  if (changed.skipped.length > 0) {
    for (const skipped of changed.skipped) notes.push(`Skipped "${skipped.file}": ${skipped.reason}.`);
  }
  if (changed.files.length === 0) notes.push("No changed files were reported for this scope.");

  const graph = loadGraphIndexStrict(root, config); // shard-aware module list
  const modules = moduleInfos(graph.entries);
  const mappings = mapChangedFiles(changed.files, modules, sourceRootsOf(config));

  const directModuleSet = new Set<string>();
  const directPhases = new Set<string>();
  for (const mapping of mappings) {
    for (const moduleId of mapping.modules) directModuleSet.add(moduleId);
    for (const phaseId of mapping.phases) directPhases.add(phaseId);
    if (mapping.reason === "none") {
      if (DOCS_INDEX_RE.test(mapping.file)) {
        notes.push(`${mapping.file}: a docs index changed — run \`mygrace lint --format json\` for the full index checks.`);
      } else if (SHARD_FILE_RE.test(mapping.file)) {
        notes.push(`${mapping.file}: a module shard changed — run \`mygrace lint --format json\` to validate shard counts.`);
      } else {
        notes.push(`No module PATH maps "${mapping.file}" (checked exact PATH and module directory prefixes).`);
      }
    }
  }

  // Deterministic direct-module order: index order first, then docs-only ids alphabetically.
  const moduleOrder = new Map(modules.map((module, index) => [module.id, index]));
  const directModules = [...directModuleSet].sort((left, right) => {
    const leftOrder = moduleOrder.get(left);
    const rightOrder = moduleOrder.get(right);
    if (leftOrder === undefined || rightOrder === undefined) {
      if (leftOrder === undefined && rightOrder === undefined) return left.localeCompare(right);
      return leftOrder === undefined ? 1 : -1;
    }
    return leftOrder - rightOrder;
  });
  const knownModuleIds = new Set(modules.map((module) => module.id));
  for (const moduleId of directModules) {
    if (!knownModuleIds.has(moduleId)) {
      notes.push(`${moduleId}: mapped from docs/ but not listed in docs/graph-index.xml — fix the index with \`mygrace lint\`.`);
    }
  }

  const dependents = collectDependents(modules, directModules);
  const affectedModules = [...directModules, ...dependents.filter((moduleId) => !directModules.includes(moduleId))];

  const verificationStatus = verificationStatusOf(root, affectedModules, modules, notes);
  const affectedPhases = affectedPhasesOf(root, affectedModules, [...directPhases], notes);
  const suggestedCommands = suggestedCommandsOf(root, config, affectedModules, notes);

  const findings: Finding[] = [];
  if (directModules.length === 0) {
    findings.push(
      finding("info", "NO_MODULES_AFFECTED", "No changed file maps to a module in docs/graph-index.xml.", {
        hint: "Pass --files <a,b,c> or --since <ref> to scope the change, or run `mygrace lint --format json` if only docs/ indexes changed.",
      })
    );
  }

  return {
    root,
    source: changed.source,
    files: changed.files,
    skipped: changed.skipped,
    directModules,
    dependents,
    verificationStatus,
    affectedPhases,
    suggestedCommands,
    notes,
    findings,
  };
}

/** The exact JSON `data` payload documented for `mygrace impact --format json`. */
export function impactData(result: ImpactResult): ImpactData {
  return {
    files: result.files,
    directModules: result.directModules,
    dependents: result.dependents,
    verificationStatus: result.verificationStatus,
    affectedPhases: result.affectedPhases,
    suggestedCommands: result.suggestedCommands,
    notes: result.notes,
  };
}

function formatImpactText(result: ImpactResult): string[] {
  const lines: string[] = [
    "MyGRACE impact",
    "==============",
    `Changed files: ${result.files.length}`,
    ...result.files.map((file) => `  ${file}`),
    "",
    `Direct modules (${result.directModules.length}): ${result.directModules.join(", ") || "(none)"}`,
    `Dependents (${result.dependents.length}): ${result.dependents.join(", ") || "(none)"}`,
  ];

  if (result.verificationStatus.modules.length > 0) {
    lines.push("", "Verification blast radius:");
    for (const entry of result.verificationStatus.modules) {
      const ref = entry.verificationRef === "" ? "(no VERIFICATION_REF)" : entry.verificationRef;
      const file = entry.file === null ? "" : ` ${entry.file}${entry.fileExists ? "" : " (missing)"}`;
      lines.push(`  ${entry.module}: ${ref}${file} — ${entry.testFiles.length} test file(s)`);
    }
    if (result.verificationStatus.modulesWithoutVerification.length > 0) {
      lines.push(`  Without verification: ${result.verificationStatus.modulesWithoutVerification.join(", ")}`);
    }
    if (result.verificationStatus.missingTestFiles.length > 0) {
      lines.push(`  Missing test files: ${result.verificationStatus.missingTestFiles.join(", ")}`);
    }
  }

  if (result.affectedPhases.length > 0) {
    lines.push(
      "",
      `Affected phases: ${result.affectedPhases.map((phase) => `${phase.id} (${phase.reason})`).join(", ")}`
    );
  }

  lines.push("", "Suggested commands:");
  for (const command of result.suggestedCommands) lines.push(`  ${command}`);

  if (result.notes.length > 0) {
    lines.push("", "Notes:");
    for (const note of result.notes) lines.push(`  - ${note}`);
  }
  for (const item of result.findings) lines.push(`ℹ [${item.code}] ${item.message}`);
  return lines;
}
// END_BLOCK_IMPACT

export const impactCommand = defineCommand({
  meta: {
    name: "impact",
    description:
      "Map changed files (git --staged/--since or --files) to affected modules, dependents, verification/tests and phases (text or json)",
  },
  args: {
    path: { type: "string", default: ".", description: "Project root" },
    files: { type: "string", description: "Comma-separated changed files (project-relative; works without git)" },
    since: { type: "string", description: "Git revision to diff against (e.g. HEAD~1, origin/main)" },
    staged: { type: "boolean", default: false, description: "Use staged changes (git diff --cached)" },
    format: { type: "string", default: "text", description: "Output format: text or json" },
  },
  run: async ({ args }) => {
    const format = parseOutputFormat(args.format);
    await runCommandOutcome<ImpactData>(format, { command: "impact" }, (): CommandOutcome<ImpactData> => {
      const result = computeImpact(typeof args.path === "string" ? args.path : ".", {
        ...(typeof args.files === "string" ? { files: args.files } : {}),
        ...(typeof args.since === "string" ? { since: args.since } : {}),
        ...(args.staged === true ? { staged: true } : {}),
      });
      const envelope = createEnvelope({
        data: impactData(result),
        findings: result.findings,
        meta: { command: "impact", root: result.root },
      });
      return { envelope, print: () => formatImpactText(result).forEach((line) => console.log(line)) };
    });
  },
});
