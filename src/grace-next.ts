#!/usr/bin/env bun
/**
 * MyGRACE — `mygrace next`.
 *
 * One deterministic recommendation for the next unit of work, for an agent that
 * has no session memory. The ladder is fixed (never heuristic):
 *
 *   1. INIT_PROJECT        no MyGRACE project → `mygrace setup init`
 *   2. FIX_INDEX           unreadable/malformed index → `mygrace lint --format json`
 *   3. FIX_LINT_ERRORS     lint errors → `mygrace lint --format json` + mygrace-fix skill
 *   4. ADD_VERIFICATION_COVERAGE  coverage gaps → mygrace-verification skill
 *   5. TRUST_COMMANDS      untrusted/stale commands and work to verify → `mygrace trust`
 *   6. VERIFY_MODULE       pending/wip module with ready verification → `mygrace verify --module`
 *   7. REFRESH_WARNINGS    only strict-lint warnings left → mygrace-refresh skill
 *   8. NEXT_PHASE / NOTHING_TO_DO  next pending plan phase, or the project is done
 *
 * Advice never fails the build: a successful run exits 0 even when the advice
 * is "fix a lint error". Only usage/config errors exit non-zero (ADR-3/ADR-8).
 */

// START_MODULE_CONTRACT
//   PURPOSE: Deterministic "what should I do next?" advisor for agents (`mygrace next`), driven by the same gates CI uses.
//   SCOPE: Read-only checks (config, indexes, lint, coverage, trust, plan index); never executes project commands.
//   DEPENDS: grace-common, grace-config, grace-errors, grace-ci, grace-lint, grace-shard, grace-test
//   LINKS: docs/modules/M-NEXT.xml
// END_MODULE_CONTRACT

// START_MODULE_MAP
//   NextActionCode          — the nine deterministic action codes (priority ladder above)
//   NextAction              — {code, summary, why, command?, ids?}
//   NextResult              — {root, action}; root is null for a non-project directory
//   recommendNext()         — run the ladder for a path; throws only usage/config errors
//   nextCommand             — `mygrace next [--path] [--format]`
// END_MODULE_MAP

// START_CHANGE_SUMMARY
//   2026-11-22 — v1.3: fixed 8-step priority ladder, action codes, JSON envelope, text "NEXT/WHY/RUN" digest.
// END_CHANGE_SUMMARY

import { defineCommand } from "citty";
import { join, resolve } from "node:path";
import { readIndexFileSafe, tryFindProjectRoot } from "./grace-common";
import type { IndexEntry } from "./grace-common";
import { tryLoadConfig } from "./grace-config";
import type { MyGraceConfig } from "./grace-config";
import { collectCoverage } from "./grace-ci";
import { createEnvelope } from "./grace-errors";
import type { Finding } from "./grace-errors";
import { collectLintIssues } from "./grace-lint";
import { loadGraphIndex } from "./grace-shard";
import {
  authorizeCommands,
  parseOutputFormat,
  planModuleTest,
  runCommandOutcome,
} from "./grace-test";
import type { CommandOutcome } from "./grace-test";

// START_BLOCK_TYPES
export type NextActionCode =
  | "INIT_PROJECT"
  | "FIX_INDEX"
  | "FIX_LINT_ERRORS"
  | "ADD_VERIFICATION_COVERAGE"
  | "TRUST_COMMANDS"
  | "VERIFY_MODULE"
  | "REFRESH_WARNINGS"
  | "NEXT_PHASE"
  | "NOTHING_TO_DO";

export interface NextAction {
  /** Stable, machine-readable action identifier (see MODULE_CONTRACT ladder). */
  code: NextActionCode;
  /** One imperative line: what to do. */
  summary: string;
  /** Why this action won the ladder — evidence, not opinion. */
  why: string;
  /** Copy-pasteable CLI command, when the action maps to one. */
  command?: string;
  /** Entity ids, files or finding codes the action refers to, sorted deterministically. */
  ids?: string[];
}

export interface NextResult {
  /** Absolute project root, or null when the path is not inside a MyGRACE project. */
  root: string | null;
  action: NextAction;
  /** Info findings attached to the advice (never errors — advice exits 0). */
  findings: Finding[];
}
// END_BLOCK_TYPES

// START_BLOCK_HELPERS
const MODULE_TAG_RE = /^M-[A-Za-z0-9][A-Za-z0-9_-]*$/;
const PHASE_TAG_RE = /^Phase-[0-9]+[A-Za-z]?$/;

function quoteCli(value: string): string {
  return /^[A-Za-z0-9_./:=@%^+,-]+$/u.test(value) ? value : `'${value.replaceAll("'", `'\\''`)}'`;
}

/** Render the project root for a suggested command: "." when it is the cwd. */
function cliPath(target: string): string {
  return resolve(target) === resolve(process.cwd()) ? "." : resolve(target);
}

function cliCommand(root: string, ...parts: string[]): string {
  return ["mygrace", ...parts, "--path", cliPath(root)].map(quoteCli).join(" ");
}

function formatList(values: readonly string[], limit = 8): string {
  if (values.length === 0) return "(none)";
  const shown = values.slice(0, limit).join(", ");
  return values.length > limit ? `${shown} (+${values.length - limit} more)` : shown;
}

function statusOf(entry: IndexEntry): string {
  return (entry.attrs.STATUS ?? entry.attrs.status ?? "").trim().toLowerCase();
}

function isWorkStatus(entry: IndexEntry): boolean {
  const status = statusOf(entry);
  return status === "pending" || status === "wip";
}

function firstLines(messages: readonly string[], count = 3): string {
  return messages.slice(0, count).join(" ");
}

/** Unreadable/malformed index problem from any of the three index files (shard findings included). */
interface IndexProblem {
  file: string;
  message: string;
}

function collectIndexProblems(root: string, config: MyGraceConfig): IndexProblem[] {
  const problems: IndexProblem[] = [];
  const graph = loadGraphIndex(root, config); // lenient: findings describe malformed/missing shards
  for (const item of graph.findings) {
    if (item.severity === "error") {
      problems.push({ file: item.file ?? "docs/graph-index.xml", message: `${item.code}: ${item.message}` });
    }
  }
  for (const name of ["plan-index.xml", "verification-index.xml"] as const) {
    const read = readIndexFileSafe(join(root, "docs", name));
    if (read.error !== undefined) problems.push({ file: `docs/${name}`, message: read.error.message });
  }
  return problems;
}

interface CoverageGap {
  modules: string[];
  missingTestFiles: string[];
  detail: string;
}

function collectCoverageGap(root: string, config: MyGraceConfig): CoverageGap | null {
  const { report, findings } = collectCoverage(root, config);
  const errorCodes = new Set(findings.filter((item) => item.severity === "error").map((item) => item.code));
  const modules = [...new Set([...report.withoutVerification, ...report.modulesWithoutTestFiles])].sort();
  const missingTestFiles = [...report.testFilesMissing].sort();
  if (modules.length === 0 && missingTestFiles.length === 0 && errorCodes.size === 0) return null;

  const parts: string[] = [];
  if (report.withoutVerification.length > 0) {
    parts.push(`${report.withoutVerification.length} module(s) have no VERIFICATION_REF`);
  }
  if (report.modulesWithoutTestFiles.length > 0) {
    parts.push(`${report.modulesWithoutTestFiles.length} verification file(s) declare no <test-files>`);
  }
  if (missingTestFiles.length > 0) {
    parts.push(`${missingTestFiles.length} declared test file(s) do not exist`);
  }
  if (parts.length === 0) parts.push(`coverage findings: ${[...errorCodes].sort().join(", ")}`);
  return { modules, missingTestFiles, detail: parts.join("; ") };
}

function action(code: NextActionCode, summary: string, why: string, extra: { command?: string; ids?: string[] } = {}): NextAction {
  return {
    code,
    summary,
    why,
    ...(extra.command === undefined ? {} : { command: extra.command }),
    ...(extra.ids === undefined ? {} : { ids: extra.ids }),
  };
}
// END_BLOCK_HELPERS

// START_BLOCK_LADDER
/**
 * Run the deterministic recommendation ladder for `projectPath`.
 *
 * Throws `ConfigError` (exit 2) when `mygrace.config.json` is invalid — a broken
 * configuration must be fixed before any advice is trustworthy.
 */
export function recommendNext(projectPath = "."): NextResult {
  const requested = resolve(projectPath);
  const root = tryFindProjectRoot(requested);

  // 1) Not a project: the only useful first step is bootstrapping docs/.
  if (root === null) {
    return {
      root: null,
      findings: [],
      action: action(
        "INIT_PROJECT",
        "Initialize MyGRACE in this repository",
        `No docs/graph-index.xml was found from "${requested}" — the project has no index to work against.`,
        { command: `mygrace setup init --path ${quoteCli(cliPath(requested))}` }
      ),
    };
  }

  const loaded = tryLoadConfig(root);
  if (!loaded.ok) throw loaded.error; // exit 2: advice without a valid config would be misleading
  const config = loaded.result.config;

  // 2) Unreadable/malformed index: nothing else can be trusted until docs/ parses.
  const indexProblems = collectIndexProblems(root, config);
  if (indexProblems.length > 0) {
    return {
      root,
      findings: [],
      action: action(
        "FIX_INDEX",
        "Fix the index files so MyGRACE can read the project",
        `${indexProblems.length} index problem(s): ${firstLines(indexProblems.map((problem) => problem.message))}`,
        {
          command: cliCommand(root, "lint", "--format", "json"),
          ids: indexProblems.map((problem) => problem.file).sort(),
        }
      ),
    };
  }

  const lintIssues = collectLintIssues(root, false, config);
  const lintErrors = lintIssues.filter((item) => item.severity === "error");

  // 3) Lint errors: the invariants the harness sells are broken.
  if (lintErrors.length > 0) {
    return {
      root,
      findings: [],
      action: action(
        "FIX_LINT_ERRORS",
        "Fix the lint errors before doing any other work",
        `${lintErrors.length} lint error(s) — e.g. ${firstLines(lintErrors.map((item) => `[${item.code}] ${item.message}`), 2)}. Use the mygrace-fix skill (index → module → block).`,
        {
          command: cliCommand(root, "lint", "--format", "json"),
          ids: [...new Set(lintErrors.map((item) => item.code))].sort(),
        }
      ),
    };
  }

  // 4) Verification coverage gaps: the plan is not provable yet.
  const coverageGap = collectCoverageGap(root, config);
  if (coverageGap !== null) {
    return {
      root,
      findings: [],
      action: action(
        "ADD_VERIFICATION_COVERAGE",
        "Close the verification coverage gaps",
        `${coverageGap.detail}. Use the mygrace-verification skill to add the verification files and <test-files> entries.`,
        {
          command: cliCommand(root, "ci", "--format", "json"),
          ids: [...coverageGap.modules, ...coverageGap.missingTestFiles].sort(),
        }
      ),
    };
  }

  const graph = loadGraphIndex(root, config);
  const pendingModules = graph.entries.filter((entry) => MODULE_TAG_RE.test(entry.tag) && isWorkStatus(entry));
  const pendingModuleIds = pendingModules.map((entry) => entry.tag);

  // 5) Project-declared commands are untrusted/stale while there is work to verify.
  if (pendingModuleIds.length > 0) {
    const authorization = authorizeCommands(root, config, false);
    if (!authorization.authorized) {
      const internals = authorization.trust;
      return {
        root,
        findings: [],
        action: action(
          "TRUST_COMMANDS",
          "Review and trust the project-declared commands",
          `${internals.recordFound ? internals.reason : "no valid .mygrace/trust.json record"} — ${pendingModuleIds.length} pending/wip module(s) need a scoped verify, which will not execute untrusted commands.`,
          {
            command: cliCommand(root, "trust"),
            ids: [...internals.stale, ...internals.missing].sort(),
          }
        ),
      };
    }
  }

  // 6) Pending/wip module whose verification plan is ready: the narrowest real work.
  const readyPlans = pendingModuleIds
    .map((moduleId) => ({ moduleId, plan: planModuleTest(root, moduleId, config) }))
    .filter((candidate) => candidate.plan.status === "ready");
  if (readyPlans.length > 0) {
    const first = readyPlans[0];
    if (first === undefined) throw new Error("unreachable: readyPlans is not empty");
    const firstId = first.moduleId;
    const firstEntry = pendingModules.find((entry) => entry.tag === firstId);
    return {
      root,
      findings: [],
      action: action(
        "VERIFY_MODULE",
        `Verify pending module ${firstId}`,
        `${firstId} is ${firstEntry === undefined ? "pending/wip" : statusOf(firstEntry)} in docs/graph-index.xml and its verification plan is ready (${first.plan.files.length} test file(s), command from ${first.plan.source}).`,
        {
          command: cliCommand(root, "verify", "--module", firstId),
          ids: readyPlans.map((candidate) => candidate.moduleId),
        }
      ),
    };
  }

  const lintWarnings = lintIssues.filter((item) => item.severity === "warning");

  // 7) Only warnings left: keep the indexes current (strict lint will fail on them).
  if (lintWarnings.length > 0) {
    return {
      root,
      findings: [],
      action: action(
        "REFRESH_WARNINGS",
        "Clear the remaining lint warnings",
        `${lintWarnings.length} strict-lint warning(s) — e.g. ${firstLines(lintWarnings.map((item) => `[${item.code}] ${item.message}`), 2)}. Use the mygrace-refresh skill to sync indexes with entities.`,
        {
          command: cliCommand(root, "lint", "--strict", "--format", "json"),
          ids: [...new Set(lintWarnings.map((item) => item.code))].sort(),
        }
      ),
    };
  }

  // 8) Clean: recommend the next planned phase, or say there is nothing to do.
  const planRead = readIndexFileSafe(join(root, "docs", "plan-index.xml"));
  const nextPhase = planRead.entries.find((entry) => PHASE_TAG_RE.test(entry.tag) && isWorkStatus(entry));
  if (nextPhase !== undefined) {
    return {
      root,
      findings: [],
      action: action(
        "NEXT_PHASE",
        `Start ${nextPhase.tag}`,
        `Every indexed module is verified and the indexes are current; ${nextPhase.tag} (${nextPhase.attrs.name ?? "unnamed phase"}) is the next planned phase.`,
        {
          command: cliCommand(root, "phase", "show", nextPhase.tag),
          ids: [nextPhase.tag],
        }
      ),
    };
  }

  return {
    root,
    findings: [],
    action: action(
      "NOTHING_TO_DO",
      "Nothing to do — the project is clean",
      "No index problems, no lint errors or warnings, verification coverage is complete, and every plan phase is done.",
      { ids: [] }
    ),
  };
}
// END_BLOCK_LADDER

// START_BLOCK_REPORT
function formatNextText(result: NextResult): string[] {
  const lines = [`NEXT: ${result.action.summary}`, `WHY: ${result.action.why}`];
  if (result.action.command !== undefined) lines.push(`RUN: ${result.action.command}`);
  if (result.action.ids !== undefined && result.action.ids.length > 0) {
    lines.push(`IDS: ${formatList(result.action.ids)}`);
  }
  lines.push(`CODE: ${result.action.code}`);
  return lines;
}

export const nextCommand = defineCommand({
  meta: {
    name: "next",
    description:
      "Deterministic next-step advice for agents: init → fix index → lint → coverage → trust → verify → warnings → next phase (text or json)",
  },
  args: {
    path: { type: "string", default: ".", description: "Project root" },
    format: { type: "string", default: "text", description: "Output format: text or json" },
  },
  run: async ({ args }) => {
    const format = parseOutputFormat(args.format);
    await runCommandOutcome<{ action: NextAction }>(format, { command: "next" }, (): CommandOutcome<{ action: NextAction }> => {
      const result = recommendNext(typeof args.path === "string" ? args.path : ".");
      const envelope = createEnvelope({
        data: { action: result.action },
        findings: result.findings,
        ...(result.root === null ? {} : { meta: { command: "next", root: result.root } }),
      });
      return { envelope, print: () => formatNextText(result).forEach((line) => console.log(line)) };
    });
  },
});
// END_BLOCK_REPORT
