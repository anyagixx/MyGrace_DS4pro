/**
 * MyGRACE — Capsules (ROADMAP ADR-10, Wave 5 / v1.6).
 *
 * SkillCache-style process compilation for deterministic routines: one typed
 * capsule file lists an allowlisted sequence of `mygrace` CLI programs, plus
 * optional judgment steps where the agent decides. Programs are never arbitrary
 * shell: a fixed registry maps each step to a read-only CLI argv template, so a
 * capsule cannot escape the trust model behind MyGRACE's backs.
 *
 * Lifecycle:
 *   validate → qualify (replay on a fixture, record the capsule hash) → run
 *   (stop at a judgment, save state) → continue; any failed program deopts to
 *   the capsule's source skill.
 *
 * Local state lives in `.mygrace/capsules/` (gitignored), like the trust record.
 */

// START_MODULE_CONTRACT
//   PURPOSE: Compile recurring MyGRACE orchestration into typed, allowlisted capsules with replay qualification, stateful execution, judgment hand-back and deopt to the source skill.
//   SCOPE: Reads/writes capsules/*.json and `.mygrace/capsules/` local state; spawns only allowlisted `mygrace` CLI programs (no shell, no arbitrary commands).
//   DEPENDS: grace-common (findProjectRoot), grace-config, grace-errors, grace-test, node:child_process, node:crypto, node:fs, node:path
//   LINKS: ROADMAP.md (ADR-10, Wave 5), INTEGRATION-PLAN.md §5, docs/modules/M-CAPSULE.xml
// END_MODULE_CONTRACT

// START_MODULE_MAP
//   CAPSULE_PROGRAMS        — read-only program registry (name → CLI argv template + placeholders)
//   CAPSULE_FINDING_CODES   — CAPSULE_INVALID/UNQUALIFIED/DEOPT/JUDGMENT_REQUIRED/DRIFT
//   CapsuleDefinition       — typed capsule (bindings, program/judge steps)
//   CapsuleValidation       — structural/dataflow validation result
//   validateCapsuleDefinition() — strict schema + allowlist + binding dataflow
//   executeCapsulePrograms()    — replay/run engine (state, judgment, deopt)
//   capsuleCommand          — `mygrace capsule list|show|validate|qualify|run|continue`
// END_MODULE_MAP

// START_CHANGE_SUMMARY
//   v1.6.0 — introduced: capsule format, allowlisted program registry, replay
//   qualification with capsule hashes, stateful run/continue, judgment hand-back,
//   deopt-to-skill and the `mygrace capsule` command family.
// END_CHANGE_SUMMARY

import { defineCommand } from "citty";
import { spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { findProjectRoot } from "./grace-common";
import { loadConfig } from "./grace-config";
import type { MyGraceConfig } from "./grace-config";
import { createEnvelope, finding, UsageError } from "./grace-errors";
import type { Finding } from "./grace-errors";
import { parseOutputFormat, runCommandOutcome } from "./grace-test";
import type { CommandOutcome } from "./grace-test";

// START_BLOCK_PROGRAMS
/** Read-only program registry: the ONLY commands a capsule may execute (ADR-10). */
export const CAPSULE_PROGRAMS = {
  status: { argv: ["status", "--path", "$root", "--format", "json"], placeholders: [] as const },
  lint: { argv: ["lint", "--path", "$root", "--format", "json"], placeholders: [] as const },
  "lint-changed": { argv: ["lint", "--changed", "--path", "$root", "--format", "json"], placeholders: [] as const },
  ci: { argv: ["ci", "--path", "$root", "--format", "json"], placeholders: [] as const },
  next: { argv: ["next", "--path", "$root", "--format", "json"], placeholders: [] as const },
  impact: { argv: ["impact", "--path", "$root", "--format", "json"], placeholders: [] as const },
  trace: { argv: ["trace", "$module", "--path", "$root", "--format", "json"], placeholders: ["module"] as const },
  packet: { argv: ["packet", "$module", "--path", "$root"], placeholders: ["module"] as const },
  focus: { argv: ["focus", "$module", "--path", "$root", "--format", "json"], placeholders: ["module"] as const },
} as const;

export type CapsuleProgramName = keyof typeof CAPSULE_PROGRAMS;
export const CAPSULE_PROGRAM_NAMES = Object.keys(CAPSULE_PROGRAMS).sort() as CapsuleProgramName[];

/** Stable finding codes emitted by the capsule layer. */
export const CAPSULE_FINDING_CODES = {
  invalid: "CAPSULE_INVALID",
  unqualified: "CAPSULE_UNQUALIFIED",
  deopt: "CAPSULE_DEOPT",
  drift: "CAPSULE_DRIFT",
  judgmentRequired: "CAPSULE_JUDGMENT_REQUIRED",
} as const;

/** Supported binding names (values come from explicit CLI flags, never env). */
export const CAPSULE_BINDING_NAMES = ["module", "files"] as const;
export type CapsuleBindingName = (typeof CAPSULE_BINDING_NAMES)[number];
// END_BLOCK_PROGRAMS

// START_BLOCK_TYPES
export interface CapsuleBinding {
  name: CapsuleBindingName;
  /** Where the value comes from; v1 supports explicit CLI arguments only. */
  from: `arg:${CapsuleBindingName}`;
  required: boolean;
  /** Optional ECMA-262 pattern applied to the bound value. */
  pattern?: string;
}

export interface CapsuleProgramStep {
  id?: string;
  program: CapsuleProgramName;
  /** Expected exit code; defaults to 0. */
  expectExitCode?: number;
}

export interface CapsuleJudgeStep {
  id?: string;
  judge: string;
  skill: string;
}

export type CapsuleStep = CapsuleProgramStep | CapsuleJudgeStep;

export interface CapsuleDefinition {
  schema_version: 1;
  name: string;
  title: string;
  description?: string;
  /** Skill to fall back to when a program deopts. */
  source_skill: string;
  bindings?: CapsuleBinding[];
  steps: CapsuleStep[];
}

export interface CapsuleValidationIssue {
  path: string;
  message: string;
}

export interface CapsuleValidation {
  valid: boolean;
  issues: CapsuleValidationIssue[];
}

export interface StepRecord {
  id: string;
  kind: "program" | "judge";
  program?: string;
  judge?: string;
  skill?: string;
  exitCode: number;
  ok: boolean;
  /** Bounded stdout preview; full outputs stay with the CLI/agent. */
  output?: string;
}

export type RunStatus = "waiting" | "completed" | "deopted";

export interface CapsuleExecution {
  status: RunStatus;
  steps: StepRecord[];
  /** Set when status = waiting: the judgment the agent must make. */
  judgment?: { stepId: string; message: string; skill: string; nextIndex: number };
  /** Set when status = deopted. */
  deopt?: { stepId: string; program: string; exitCode: number; output: string; sourceSkill: string; hint: string };
}

export interface CapsuleRunState {
  schemaVersion: 1;
  runId: string;
  capsuleName: string;
  capsuleHash: string;
  root: string;
  bindings: Record<string, string>;
  nextIndex: number;
  status: "waiting" | "deopted";
  steps: StepRecord[];
  createdAt: string;
}

export interface CapsuleListEntry {
  name: string;
  title: string;
  sourceSkill: string;
  steps: number;
  qualified: boolean;
  valid: boolean;
  issues: string[];
}

export interface QualificationRecord {
  hash: string;
  fixture: string;
  qualifiedAt: string;
  toolVersion: string;
  steps: number;
}

interface SpawnResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  parsed: unknown;
}
// END_BLOCK_TYPES

// START_BLOCK_STORAGE
const CAPSULE_STATE_DIR = join(".mygrace", "capsules");
const CAPSULE_QUALIFICATIONS = "qualifications.json";
const CAPSULE_RUNS_DIR = "state";
const SPAWN_TIMEOUT_MS = 120_000;
const OUTPUT_PREVIEW = 4_000;
const NAME_RE = /^[a-z][a-z0-9-]{1,39}$/;
const STEP_ID_RE = /^[a-z][a-z0-9-]{0,39}$/;

function capsuleDir(root: string, config: MyGraceConfig): string {
  const configured = config.integrations.capsules.dir;
  const absolute = resolve(root, configured);
  const rel = absolute === root ? "" : absolute.slice(root.length + 1);
  if (rel === "" || rel.startsWith("..") || /^[A-Za-z]:/.test(rel)) {
    throw new UsageError(`integrations.capsules.dir must stay inside the project root (got "${configured}").`);
  }
  return absolute;
}

function capsulePath(root: string, config: MyGraceConfig, name: string): string {
  if (!NAME_RE.test(name)) {
    throw new UsageError(`Invalid capsule name "${name}".`, { hint: "Use lowercase letters, digits and dashes (2-40 chars)." });
  }
  return join(capsuleDir(root, config), `${name}.json`);
}

function hashText(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function readCapsuleFile(path: string): { text: string; raw: unknown } {
  if (!existsSync(path)) {
    throw new UsageError(`Capsule file not found: ${path}`, { hint: "Run `mygrace capsule list` to see available capsules." });
  }
  const text = readFileSync(path, "utf-8");
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new UsageError(`Capsule file is not valid JSON: ${path}`);
  }
  return { text, raw };
}

function stateRoot(root: string): string {
  return join(root, CAPSULE_STATE_DIR);
}

function qualificationsPath(root: string): string {
  return join(stateRoot(root), CAPSULE_QUALIFICATIONS);
}

function loadQualifications(root: string): Record<string, QualificationRecord> {
  try {
    const parsed = JSON.parse(readFileSync(qualificationsPath(root), "utf-8")) as Record<string, QualificationRecord>;
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function writeQualifications(root: string, records: Record<string, QualificationRecord>): void {
  const dir = stateRoot(root);
  mkdirSync(dir, { recursive: true });
  writeFileSync(qualificationsPath(root), `${JSON.stringify(records, null, 2)}\n`);
}

function runStatePath(root: string, runId: string): string {
  return join(stateRoot(root), CAPSULE_RUNS_DIR, `${runId}.json`);
}

function toolVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(join(dirname(import.meta.dirname), "package.json"), "utf-8")) as { version?: unknown };
    return typeof pkg.version === "string" ? pkg.version : "dev";
  } catch {
    return "dev";
  }
}
// END_BLOCK_STORAGE

// START_BLOCK_VALIDATE
function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Strict capsule schema + allowlist + binding dataflow validation (ADR-10). */
export function validateCapsuleDefinition(raw: unknown): CapsuleValidation {
  const issues: CapsuleValidationIssue[] = [];
  const issue = (path: string, message: string): void => {
    issues.push({ path, message });
  };
  if (!isRecord(raw)) {
    return { valid: false, issues: [{ path: "/", message: "capsule must be a JSON object" }] };
  }
  const allowed = new Set(["schema_version", "name", "title", "description", "source_skill", "bindings", "steps"]);
  for (const key of Object.keys(raw)) if (!allowed.has(key)) issue(`/${key}`, `unknown capsule key "${key}"`);
  if (raw.schema_version !== 1) issue("/schema_version", "must be 1");
  if (typeof raw.name !== "string" || !NAME_RE.test(raw.name)) issue("/name", "must match ^[a-z][a-z0-9-]{1,39}$");
  if (typeof raw.title !== "string" || raw.title.trim() === "") issue("/title", "must be a non-empty string");
  if (raw.description !== undefined && (typeof raw.description !== "string" || raw.description.trim() === "")) {
    issue("/description", "must be a non-empty string when present");
  }
  if (typeof raw.source_skill !== "string" || raw.source_skill.trim() === "") {
    issue("/source_skill", "must be a non-empty skill name (the deopt fallback)");
  }

  const declaredBindings = new Map<string, CapsuleBinding>();
  if (raw.bindings !== undefined) {
    if (!Array.isArray(raw.bindings)) {
      issue("/bindings", "must be an array");
    } else {
      raw.bindings.forEach((entry, index) => {
        const path = `/bindings/${index}`;
        if (!isRecord(entry)) {
          issue(path, "must be an object");
          return;
        }
        const keys = new Set(["name", "from", "required", "pattern"]);
        for (const key of Object.keys(entry)) if (!keys.has(key)) issue(`${path}/${key}`, `unknown binding key "${key}"`);
        const name = entry.name;
        if (typeof name !== "string" || !(CAPSULE_BINDING_NAMES as readonly string[]).includes(name)) {
          issue(`${path}/name`, `must be one of ${CAPSULE_BINDING_NAMES.join(", ")}`);
          return;
        }
        if (declaredBindings.has(name)) issue(`${path}/name`, `duplicate binding "${name}"`);
        if (entry.from !== `arg:${name}`) issue(`${path}/from`, `must be "arg:${name}" (values come from explicit CLI flags only)`);
        if (entry.required !== true) issue(`${path}/required`, "must be true for v1 capsules (used placeholders cannot be optional)");
        if (entry.pattern !== undefined) {
          if (typeof entry.pattern !== "string") {
            issue(`${path}/pattern`, "must be a string");
          } else {
            try {
              void new RegExp(entry.pattern);
            } catch {
              issue(`${path}/pattern`, "must be a valid ECMA-262 regular expression");
            }
          }
        }
        declaredBindings.set(name, {
          name: name as CapsuleBindingName,
          from: `arg:${name}` as CapsuleBinding["from"],
          required: true,
          ...(typeof entry.pattern === "string" ? { pattern: entry.pattern } : {}),
        });
      });
    }
  }

  if (!Array.isArray(raw.steps) || raw.steps.length === 0) {
    issue("/steps", "must be a non-empty array");
  } else {
    if (raw.steps.length > 12) issue("/steps", "capsules are limited to 12 steps");
    const ids = new Set<string>();
    raw.steps.forEach((entry, index) => {
      const path = `/steps/${index}`;
      if (!isRecord(entry)) {
        issue(path, "must be an object");
        return;
      }
      const kind = typeof entry.program === "string" ? "program" : typeof entry.judge === "string" ? "judge" : null;
      if (kind === null) {
        issue(path, 'must be a program step ("program") or a judgment step ("judge")');
        return;
      }
      const keys = new Set(kind === "program" ? ["id", "program", "expectExitCode"] : ["id", "judge", "skill"]);
      for (const key of Object.keys(entry)) if (!keys.has(key)) issue(`${path}/${key}`, `unknown step key "${key}"`);
      const id = entry.id;
      if (id !== undefined) {
        if (typeof id !== "string" || !STEP_ID_RE.test(id)) issue(`${path}/id`, "must match ^[a-z][a-z0-9-]{0,39}$");
        else if (ids.has(id)) issue(`${path}/id`, `duplicate step id "${id}"`);
        else ids.add(id);
      }
      if (kind === "program") {
        const program = entry.program as string;
        if (!(program in CAPSULE_PROGRAMS)) {
          issue(`${path}/program`, `unknown program "${program}" (allowlist: ${CAPSULE_PROGRAM_NAMES.join(", ")})`);
          return;
        }
        if (entry.expectExitCode !== undefined && (!Number.isInteger(entry.expectExitCode) || (entry.expectExitCode as number) < 0)) {
          issue(`${path}/expectExitCode`, "must be a non-negative integer");
        }
        for (const placeholder of CAPSULE_PROGRAMS[program as CapsuleProgramName].placeholders) {
          if (!declaredBindings.has(placeholder)) {
            issue(path, `program "${program}" needs binding "${placeholder}" declared in /bindings`);
          }
        }
      } else {
        if (typeof entry.judge !== "string" || entry.judge.trim() === "") issue(`${path}/judge`, "must be a non-empty question");
        if (typeof entry.skill !== "string" || entry.skill.trim() === "") issue(`${path}/skill`, "must be a non-empty source skill");
      }
    });
  }

  return { valid: issues.length === 0, issues };
}
// END_BLOCK_VALIDATE

// START_BLOCK_BINDINGS
function resolveBindings(
  capsule: CapsuleDefinition,
  args: { module?: string; files?: string }
): Record<string, string> {
  const bindings: Record<string, string> = {};
  for (const binding of capsule.bindings ?? []) {
    const value = binding.name === "module" ? args.module : args.files;
    if (value === undefined || value.trim() === "") {
      if (binding.required) {
        throw new UsageError(`Capsule "${capsule.name}" requires --${binding.name}.`, {
          hint: `Run: mygrace capsule run ${capsule.name} --${binding.name} <value>`,
        });
      }
      continue;
    }
    if (binding.pattern !== undefined && !new RegExp(binding.pattern, "u").test(value.trim())) {
      throw new UsageError(`--${binding.name} "${value}" does not match ${binding.pattern}.`);
    }
    bindings[binding.name] = value.trim();
  }
  return bindings;
}

/** Expand one program argv template against root + resolved bindings. */
export function capsuleProgramArgv(
  program: CapsuleProgramName,
  root: string,
  bindings: Record<string, string>
): string[] {
  return CAPSULE_PROGRAMS[program].argv.map((token) => {
    if (token === "$root") return root;
    if (token.startsWith("$")) {
      const name = token.slice(1);
      const value = bindings[name];
      if (value === undefined) {
        throw new UsageError(`Program "${program}" needs binding "${name}", but the capsule run did not provide it.`);
      }
      return value;
    }
    return token;
  });
}
// END_BLOCK_BINDINGS

// START_BLOCK_SPAWN
function cliLaunch(): { command: string; prefix: string[] } {
  const bin = process.env.MYGRACE_BIN?.trim();
  if (bin !== undefined && bin !== "") return { command: bin, prefix: [] };
  return { command: process.execPath, prefix: ["run", join(import.meta.dirname, "grace.ts")] };
}

/** Spawn one allowlisted MyGRACE program; argv-only, no shell, bounded output. */
function spawnProgram(root: string, argv: string[]): SpawnResult {
  const launch = cliLaunch();
  const result = spawnSync(launch.command, [...launch.prefix, ...argv], {
    cwd: root,
    encoding: "utf-8",
    timeout: SPAWN_TIMEOUT_MS,
    shell: false,
    env: process.env,
    maxBuffer: 8 * 1024 * 1024,
  });
  if (result.error !== undefined) {
    const timedOut = result.error.message.includes("ETIMEDOUT") || result.error.message.includes("timed out");
    return {
      exitCode: 124,
      stdout: "",
      stderr: `${timedOut ? "program timed out" : "program failed to start"}: ${result.error.message}`,
      parsed: null,
    };
  }
  const stdout = result.stdout ?? "";
  let parsed: unknown = null;
  try {
    parsed = JSON.parse(stdout.trim());
  } catch {
    parsed = null;
  }
  return {
    exitCode: typeof result.status === "number" ? result.status : 1,
    stdout,
    stderr: result.stderr ?? "",
    parsed,
  };
}

function previewOf(result: SpawnResult): string {
  const text = (result.stdout !== "" ? result.stdout : result.stderr).replace(/\s+/g, " ").trim();
  if (text === "") return "";
  return text.length <= OUTPUT_PREVIEW ? text : `${text.slice(0, OUTPUT_PREVIEW)}… (truncated)`;
}

function stepIdOf(step: CapsuleStep, index: number): string {
  return step.id ?? `step-${index + 1}`;
}
// END_BLOCK_SPAWN

// START_BLOCK_ENGINE
function saveState(root: string, state: CapsuleRunState): void {
  const path = runStatePath(root, state.runId);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(state, null, 2)}\n`);
}

function deleteState(root: string, runId: string): void {
  rmSync(runStatePath(root, runId), { force: true });
}

function newRunId(): string {
  return `run-${Date.now().toString(36)}-${randomBytes(3).toString("hex")}`;
}

interface ExecuteOptions {
  root: string;
  capsule: CapsuleDefinition;
  capsuleHash: string;
  bindings: Record<string, string>;
  startIndex: number;
  runId?: string;
  steps?: StepRecord[];
  /** Qualify mode: skip judgments, run every program and report failures. */
  qualify?: boolean;
}

/** Run capsule programs from `startIndex`, persisting state at judgments/deopts. */
export function executeCapsulePrograms(options: ExecuteOptions): CapsuleExecution & { runId: string; statePath?: string } {
  const { root, capsule, capsuleHash, bindings, startIndex } = options;
  const runId = options.runId ?? newRunId();
  const steps: StepRecord[] = options.steps === undefined ? [] : [...options.steps];
  const qualify = options.qualify === true;

  for (let index = startIndex; index < capsule.steps.length; index += 1) {
    const step = capsule.steps[index];
    if (step === undefined) break;
    const id = stepIdOf(step, index);
    if ("judge" in step) {
      if (qualify) continue;
      const state: CapsuleRunState = {
        schemaVersion: 1,
        runId,
        capsuleName: capsule.name,
        capsuleHash,
        root,
        bindings,
        nextIndex: index + 1,
        status: "waiting",
        steps,
        createdAt: new Date().toISOString(),
      };
      saveState(root, state);
      return {
        status: "waiting",
        steps,
        judgment: { stepId: id, message: step.judge, skill: step.skill, nextIndex: index + 1 },
        runId,
        statePath: runStatePath(root, runId),
      };
    }

    const argv = capsuleProgramArgv(step.program, root, bindings);
    const result = spawnProgram(root, argv);
    const expected = step.expectExitCode ?? 0;
    const ok = result.exitCode === expected;
    steps.push({
      id,
      kind: "program",
      program: step.program,
      exitCode: result.exitCode,
      ok,
      output: previewOf(result),
    });
    if (!ok) {
      const output = previewOf(result);
      if (!qualify) {
        const state: CapsuleRunState = {
          schemaVersion: 1,
          runId,
          capsuleName: capsule.name,
          capsuleHash,
          root,
          bindings,
          nextIndex: index,
          status: "deopted",
          steps,
          createdAt: new Date().toISOString(),
        };
        saveState(root, state);
      }
      return {
        status: "deopted",
        steps,
        deopt: {
          stepId: id,
          program: step.program,
          exitCode: result.exitCode,
          output,
          sourceSkill: capsule.source_skill,
          hint: `Step "${id}" exited ${result.exitCode} (expected ${expected}); fall back to the ${capsule.source_skill} skill.`,
        },
        runId,
      };
    }
  }

  deleteState(root, runId);
  return { status: "completed", steps, runId };
}
// END_BLOCK_ENGINE

// START_BLOCK_COMMANDS
function capsuleDirOf(root: string): { config: MyGraceConfig; dir: string } {
  const config = loadConfig(root).config;
  return { config, dir: capsuleDir(root, config) };
}

function loadCapsule(root: string, name: string): { capsule: CapsuleDefinition; hash: string; path: string } {
  const { config, dir } = capsuleDirOf(root);
  const path = capsulePath(root, config, name);
  const { text, raw } = readCapsuleFile(path);
  const validation = validateCapsuleDefinition(raw);
  if (!validation.valid) {
    throw new UsageError(`Capsule "${name}" is invalid: ${validation.issues.map((item) => `${item.path} ${item.message}`).join("; ")}`);
  }
  return { capsule: raw as CapsuleDefinition, hash: hashText(text), path };
}

function qualifiedFor(root: string, name: string, hash: string): QualificationRecord | null {
  const record = loadQualifications(root)[name];
  return record !== undefined && record.hash === hash ? record : null;
}

function assertCapsulesEnabled(config: MyGraceConfig): void {
  if (config.integrations.capsules.enabled === false) {
    throw new UsageError("Capsule execution is disabled in this project.", {
      hint: "Set integrations.capsules.enabled=true in mygrace.config.json (local state lives in .mygrace/capsules/).",
    });
  }
}

function listCapsules(root: string): CapsuleListEntry[] {
  const { dir } = capsuleDirOf(root);
  if (!existsSync(dir)) return [];
  const records = loadQualifications(root);
  const entries: CapsuleListEntry[] = [];
  for (const file of readdirSync(dir).filter((name) => name.endsWith(".json")).sort()) {
    const name = file.slice(0, -".json".length);
    const path = join(dir, file);
    let raw: unknown;
    let text: string;
    try {
      text = readFileSync(path, "utf-8");
      raw = JSON.parse(text);
    } catch {
      entries.push({ name, title: "(unreadable)", sourceSkill: "?", steps: 0, qualified: false, valid: false, issues: ["invalid JSON"] });
      continue;
    }
    const validation = validateCapsuleDefinition(raw);
    const capsule = raw as Partial<CapsuleDefinition>;
    entries.push({
      name,
      title: typeof capsule.title === "string" ? capsule.title : "(untitled)",
      sourceSkill: typeof capsule.source_skill === "string" ? capsule.source_skill : "?",
      steps: Array.isArray(capsule.steps) ? capsule.steps.length : 0,
      qualified: records[name]?.hash === hashText(text),
      valid: validation.valid,
      issues: validation.issues.map((item) => `${item.path} ${item.message}`),
    });
  }
  return entries;
}

function listCommand() {
  return defineCommand({
    meta: { name: "list", description: "List capsules, their steps and qualification state (text or json)" },
    args: {
      path: { type: "string", default: ".", description: "Project root" },
      format: { type: "string", default: "text", description: "Output format: text or json" },
    },
    run: async ({ args }) => {
      const format = parseOutputFormat(args.format);
      await runCommandOutcome<{ root: string; capsules: CapsuleListEntry[] }>(format, { command: "capsule list" }, () => {
        const root = findProjectRoot(args.path ?? ".");
        const capsules = listCapsules(root);
        const findings: Finding[] = [];
        for (const entry of capsules) {
          if (entry.valid) continue;
          findings.push(finding("warning", CAPSULE_FINDING_CODES.invalid, `${entry.name}: ${entry.issues.join("; ")}`));
        }
        const envelope = createEnvelope({ data: { root, capsules }, findings, meta: { command: "capsule list", root } });
        const lines = [
          `Capsules in ${root}`,
          ...(capsules.length === 0 ? ["  (none — create capsules/<name>.json)"] : []),
          ...capsules.map(
            (entry) =>
              `  ${entry.valid ? "✓" : "✗"} ${entry.name} — ${entry.title} · ${entry.steps} steps · ${entry.qualified ? "qualified" : "not qualified"}`
          ),
        ];
        return { envelope, print: () => lines.forEach((line) => console.log(line)) };
      });
    },
  });
}

function showCommand() {
  return defineCommand({
    meta: { name: "show", description: "Print one capsule definition and its expanded program previews" },
    args: {
      name: { type: "positional", description: "Capsule name" },
      path: { type: "string", default: ".", description: "Project root" },
      format: { type: "string", default: "text", description: "Output format: text or json" },
    },
    run: async ({ args }) => {
      const format = parseOutputFormat(args.format);
      await runCommandOutcome<{ root: string; name: string; capsule: CapsuleDefinition; hash: string; qualified: boolean; programs: string[][] }>(
        format,
        { command: "capsule show" },
        () => {
          const root = findProjectRoot(args.path ?? ".");
          const name = String(args.name ?? "");
          const loaded = loadCapsule(root, name);
          const qualified = qualifiedFor(root, name, loaded.hash) !== null;
          const programs = loaded.capsule.steps.flatMap((step) =>
            "program" in step ? [capsuleProgramArgv(step.program, root, {})] : []
          );
          const data = { root, name, capsule: loaded.capsule, hash: loaded.hash, qualified, programs };
          const envelope = createEnvelope({ data, findings: [], meta: { command: "capsule show", root } });
          const lines = [
            `Capsule ${name} — ${loaded.capsule.title}`,
            `  source skill: ${loaded.capsule.source_skill}`,
            `  hash:         ${loaded.hash}`,
            `  qualified:    ${qualified ? "yes" : "no (run: mygrace capsule qualify " + name + " --fixture <project>)"}`,
            "  steps:",
            ...loaded.capsule.steps.map((step, index) =>
              "program" in step
                ? `    ${index + 1}. program ${step.program} → mygrace ${capsuleProgramArgv(step.program, root, { module: "$module", files: "$files" }).join(" ")}`
                : `    ${index + 1}. judge → ${step.judge} (skill: ${step.skill})`
            ),
          ];
          return { envelope, print: () => lines.forEach((line) => console.log(line)) };
        }
      );
    },
  });
}

function validateCommand() {
  return defineCommand({
    meta: { name: "validate", description: "Validate capsule files (schema, allowlist, bindings); exit 1 on any invalid capsule" },
    args: {
      name: { type: "positional", description: "Capsule name (optional; omit to validate all)", required: false },
      path: { type: "string", default: ".", description: "Project root" },
      format: { type: "string", default: "text", description: "Output format: text or json" },
    },
    run: async ({ args }) => {
      const format = parseOutputFormat(args.format);
      await runCommandOutcome<{ root: string; results: Array<{ name: string; valid: boolean; issues: CapsuleValidationIssue[] }> }>(
        format,
        { command: "capsule validate" },
        () => {
          const root = findProjectRoot(args.path ?? ".");
          const { dir } = capsuleDirOf(root);
          const requested = typeof args.name === "string" && args.name !== "" ? args.name : undefined;
          const results: Array<{ name: string; valid: boolean; issues: CapsuleValidationIssue[] }> = [];
          if (requested !== undefined) {
            const { raw } = readCapsuleFile(capsulePath(root, loadConfig(root).config, requested));
            const validation = validateCapsuleDefinition(raw);
            results.push({ name: requested, valid: validation.valid, issues: validation.issues });
          } else if (existsSync(dir)) {
            for (const file of readdirSync(dir).filter((entry) => entry.endsWith(".json")).sort()) {
              const name = file.slice(0, -".json".length);
              try {
                const { raw } = readCapsuleFile(join(dir, file));
                const validation = validateCapsuleDefinition(raw);
                results.push({ name, valid: validation.valid, issues: validation.issues });
              } catch (error) {
                results.push({ name, valid: false, issues: [{ path: "/", message: error instanceof Error ? error.message : String(error) }] });
              }
            }
          }
          const findings = results
            .filter((result) => !result.valid)
            .map((result) =>
              finding("error", CAPSULE_FINDING_CODES.invalid, `${result.name}: ${result.issues.map((item) => `${item.path} ${item.message}`).join("; ")}`)
            );
          const envelope = createEnvelope({ data: { root, results }, findings, meta: { command: "capsule validate", root } });
          const lines = [
            `Capsule validation: ${results.filter((result) => result.valid).length}/${results.length} valid`,
            ...results.map((result) => `  ${result.valid ? "✓" : "✗"} ${result.name}${result.valid ? "" : ` — ${result.issues.length} issue(s)`}`),
            ...results.flatMap((result) => result.issues.map((item) => `      ${result.name}${item.path}: ${item.message}`)),
          ];
          return { envelope, print: () => lines.forEach((line) => console.log(line)) };
        }
      );
    },
  });
}

function qualifyCommand() {
  return defineCommand({
    meta: { name: "qualify", description: "Replay a capsule on a fixture project and record its qualification hash (ADR-10)" },
    args: {
      name: { type: "positional", description: "Capsule name" },
      fixture: { type: "string", required: true, description: "Fixture project root to replay on" },
      module: { type: "string", description: "Binding value for $module while replaying (e.g. a fixture module id)" },
      files: { type: "string", description: "Binding value for $files while replaying" },
      path: { type: "string", default: ".", description: "Project root that owns the capsule" },
      format: { type: "string", default: "text", description: "Output format: text or json" },
    },
    run: async ({ args }) => {
      const format = parseOutputFormat(args.format);
      await runCommandOutcome<{ root: string; name: string; hash: string; fixture: string; steps: StepRecord[]; qualified: boolean }>(
        format,
        { command: "capsule qualify" },
        () => {
          const root = findProjectRoot(args.path ?? ".");
          const loaded = loadCapsule(root, String(args.name ?? ""));
          const config = loadConfig(root).config;
          assertCapsulesEnabled(config);
          const fixture = findProjectRoot(String(args.fixture));
          const execution = executeCapsulePrograms({
            root: fixture,
            capsule: loaded.capsule,
            capsuleHash: loaded.hash,
            bindings: resolveBindings(loaded.capsule, {
              ...(typeof args.module === "string" ? { module: args.module } : {}),
              ...(typeof args.files === "string" ? { files: args.files } : {}),
            }),
            startIndex: 0,
            qualify: true,
          });
          const steps = execution.steps;
          if (execution.status !== "completed") {
            const deopt = execution.deopt;
            const findings = [
              finding("error", CAPSULE_FINDING_CODES.unqualified, `Capsule "${loaded.capsule.name}" failed replay on ${fixture}.`, {
                hint: deopt?.hint ?? "Fix the failing step or fall back to the source skill.",
              }),
            ];
            const envelope = createEnvelope({
              data: { root, name: loaded.capsule.name, hash: loaded.hash, fixture, steps, qualified: false },
              findings,
              meta: { command: "capsule qualify", root },
            });
            return { envelope, print: () => console.error(`✗ Capsule did not qualify: ${deopt?.hint ?? "replay failed"}`) };
          }
          const records = loadQualifications(root);
          records[loaded.capsule.name] = {
            hash: loaded.hash,
            fixture,
            qualifiedAt: new Date().toISOString(),
            toolVersion: toolVersion(),
            steps: steps.filter((step) => step.kind === "program").length,
          };
          writeQualifications(root, records);
          const envelope = createEnvelope({
            data: { root, name: loaded.capsule.name, hash: loaded.hash, fixture, steps, qualified: true },
            findings: [],
            meta: { command: "capsule qualify", root },
          });
          return {
            envelope,
            print: () => console.log(`✓ Capsule "${loaded.capsule.name}" qualified on ${fixture} (${steps.length} program steps, hash ${loaded.hash.slice(0, 12)}…)`),
          };
        }
      );
    },
  });
}

function runCommandCapsule() {
  return defineCommand({
    meta: { name: "run", description: "Run a qualified capsule; stops at a judgment step and prints the continue command (ADR-10)" },
    args: {
      name: { type: "positional", description: "Capsule name" },
      module: { type: "string", description: "Binding value for $module (e.g. M-LINT)" },
      files: { type: "string", description: "Binding value for $files (comma-separated paths)" },
      allowUnqualified: { type: "boolean", default: false, description: "Run even without a matching qualification record (development only)" },
      path: { type: "string", default: ".", description: "Project root" },
      format: { type: "string", default: "text", description: "Output format: text or json" },
    },
    run: async ({ args }) => {
      const format = parseOutputFormat(args.format);
      await runCommandOutcome<{
        root: string;
        name: string;
        hash: string;
        status: RunStatus;
        steps: StepRecord[];
        runId: string;
        judgment?: CapsuleExecution["judgment"];
      }>(format, { command: "capsule run" }, () => {
        const root = findProjectRoot(args.path ?? ".");
        const name = String(args.name ?? "");
        const loaded = loadCapsule(root, name);
        const config = loadConfig(root).config;
        assertCapsulesEnabled(config);
        const record = qualifiedFor(root, name, loaded.hash);
        const allowUnqualified = args.allowUnqualified === true;
        if (record === null && !allowUnqualified) {
          const findings = [
            finding(
              "error",
              CAPSULE_FINDING_CODES.unqualified,
              `Capsule "${name}" is not qualified for its current hash (${loaded.hash.slice(0, 12)}…).`,
              { hint: `Run: mygrace capsule qualify ${name} --fixture <project>  (or pass --allow-unqualified for development)` }
            ),
          ];
          const envelope = createEnvelope({
            data: { root, name, hash: loaded.hash, status: "deopted" as RunStatus, steps: [], runId: "" },
            findings,
            meta: { command: "capsule run", root },
          });
          return { envelope, print: () => console.error(`✗ Capsule "${name}" is not qualified; run \`mygrace capsule qualify ${name} --fixture <project>\`.`) };
        }
        const bindings = resolveBindings(loaded.capsule, {
          ...(typeof args.module === "string" ? { module: args.module } : {}),
          ...(typeof args.files === "string" ? { files: args.files } : {}),
        });
        const execution = executeCapsulePrograms({
          root,
          capsule: loaded.capsule,
          capsuleHash: loaded.hash,
          bindings,
          startIndex: 0,
        });
        const findings: Finding[] = [];
        if (record === null && allowUnqualified) {
          findings.push(
            finding("warning", CAPSULE_FINDING_CODES.unqualified, `Capsule "${name}" ran without a qualification record (--allow-unqualified).`, {
              hint: `Qualify it: mygrace capsule qualify ${name} --fixture <project>`,
            })
          );
        }
        if (execution.status === "deopted") {
          findings.push(
            finding("error", CAPSULE_FINDING_CODES.deopt, execution.deopt?.hint ?? `Capsule "${name}" deopted.`, {
              hint: `Fall back to the ${loaded.capsule.source_skill} skill.`,
            })
          );
        }
        if (execution.status === "waiting" && execution.judgment !== undefined) {
          findings.push(
            finding("info", CAPSULE_FINDING_CODES.judgmentRequired, `Capsule "${name}" waits for a judgment.`, {
              hint: `mygrace capsule continue ${execution.runId}  (${execution.judgment.skill})`,
            })
          );
        }
        const envelope = createEnvelope({
          data: {
            root,
            name,
            hash: loaded.hash,
            status: execution.status,
            steps: execution.steps,
            runId: execution.runId,
            ...(execution.judgment === undefined ? {} : { judgment: execution.judgment }),
          },
          findings,
          meta: { command: "capsule run", root },
        });
        const lines = [
          `Capsule ${name} (${execution.status})`,
          ...execution.steps.map(
            (step) =>
              `  ${step.ok ? "✓" : "✗"} ${step.id}${step.program === undefined ? "" : ` (${step.program}, exit ${step.exitCode})`}`
          ),
          ...(execution.judgment === undefined
            ? []
            : [
                `  ⏸ judge: ${execution.judgment.message}`,
                `     skill: ${execution.judgment.skill}`,
                `  CONTINUE: mygrace capsule continue ${execution.runId}`,
              ]),
          ...(execution.deopt === undefined ? [] : [`  ✗ deopt: ${execution.deopt.hint}`]),
        ];
        return { envelope, print: () => lines.forEach((line) => console.log(line)) };
      });
    },
  });
}

function continueCommand() {
  return defineCommand({
    meta: { name: "continue", description: "Resume a capsule run after a judgment step" },
    args: {
      runId: { type: "positional", description: "Run id printed by `capsule run`" },
      path: { type: "string", default: ".", description: "Project root" },
      format: { type: "string", default: "text", description: "Output format: text or json" },
    },
    run: async ({ args }) => {
      const format = parseOutputFormat(args.format);
      await runCommandOutcome<{
        root: string;
        name: string;
        hash: string;
        status: RunStatus;
        steps: StepRecord[];
        runId: string;
        judgment?: CapsuleExecution["judgment"];
      }>(format, { command: "capsule continue" }, () => {
        const root = findProjectRoot(args.path ?? ".");
        const runId = String(args.runId ?? "");
        const statePath = runStatePath(root, runId);
        if (!existsSync(statePath)) {
          throw new UsageError(`Capsule run not found: ${runId}`, { hint: "Run ids are printed by `mygrace capsule run`; state lives in .mygrace/capsules/state/." });
        }
        let state: CapsuleRunState;
        try {
          state = JSON.parse(readFileSync(statePath, "utf-8")) as CapsuleRunState;
        } catch {
          throw new UsageError(`Capsule run state is unreadable: ${statePath}`);
        }
        if (state.status !== "waiting") {
          throw new UsageError(`Capsule run ${runId} is not waiting for a judgment (status: ${state.status}).`);
        }
        const config = loadConfig(root).config;
        assertCapsulesEnabled(config);
        const loaded = loadCapsule(root, state.capsuleName);
        if (loaded.hash !== state.capsuleHash) {
          const findings = [
            finding("error", CAPSULE_FINDING_CODES.drift, `Capsule "${state.capsuleName}" changed after the run started.`, {
              hint: "Re-qualify and start a new run (mygrace capsule qualify … && mygrace capsule run …).",
            }),
          ];
          const envelope = createEnvelope({
            data: { root, name: state.capsuleName, hash: loaded.hash, status: "deopted" as RunStatus, steps: state.steps, runId },
            findings,
            meta: { command: "capsule continue", root },
          });
          return { envelope, print: () => console.error(`✗ Capsule "${state.capsuleName}" drifted; start a new run.`) };
        }
        const execution = executeCapsulePrograms({
          root,
          capsule: loaded.capsule,
          capsuleHash: loaded.hash,
          bindings: state.bindings,
          startIndex: state.nextIndex,
          runId,
          steps: state.steps,
        });
        const findings: Finding[] = [];
        if (execution.status === "deopted") {
          findings.push(
            finding("error", CAPSULE_FINDING_CODES.deopt, execution.deopt?.hint ?? `Capsule "${state.capsuleName}" deopted.`, {
              hint: `Fall back to the ${loaded.capsule.source_skill} skill.`,
            })
          );
        }
        if (execution.status === "waiting" && execution.judgment !== undefined) {
          findings.push(
            finding("info", CAPSULE_FINDING_CODES.judgmentRequired, `Capsule "${state.capsuleName}" waits for another judgment.`, {
              hint: `mygrace capsule continue ${execution.runId}`,
            })
          );
        }
        const envelope = createEnvelope({
          data: {
            root,
            name: state.capsuleName,
            hash: loaded.hash,
            status: execution.status,
            steps: execution.steps,
            runId,
            ...(execution.judgment === undefined ? {} : { judgment: execution.judgment }),
          },
          findings,
          meta: { command: "capsule continue", root },
        });
        const lines = [
          `Capsule ${state.capsuleName} (${execution.status})`,
          ...execution.steps.map(
            (step) =>
              `  ${step.ok ? "✓" : "✗"} ${step.id}${step.program === undefined ? "" : ` (${step.program}, exit ${step.exitCode})`}`
          ),
          ...(execution.judgment === undefined
            ? execution.status === "completed"
              ? ["  completed"]
              : []
            : [`  ⏸ judge: ${execution.judgment.message}`, `  CONTINUE: mygrace capsule continue ${runId}`]),
          ...(execution.deopt === undefined ? [] : [`  ✗ deopt: ${execution.deopt.hint}`]),
        ];
        return { envelope, print: () => lines.forEach((line) => console.log(line)) };
      });
    },
  });
}

export const capsuleCommand = defineCommand({
  meta: {
    name: "capsule",
    description:
      "Local, allowlisted MyGRACE routines: list/show/validate capsule files, qualify them by replay, run with judgment hand-back and continue; execution is disabled unless integrations.capsules.enabled=true",
  },
  subCommands: {
    list: listCommand(),
    show: showCommand(),
    validate: validateCommand(),
    qualify: qualifyCommand(),
    run: runCommandCapsule(),
    continue: continueCommand(),
  },
});
// END_BLOCK_COMMANDS
