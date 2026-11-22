#!/usr/bin/env bun
/**
 * MyGRACE — `ci` gate command.
 *
 * One command that answers "is this project fit to merge?" for both humans and
 * agents (ROADMAP G3/G4/G5, Wave 3):
 *
 *   1. lint with `--strict` semantics   — structural XML, drift, caps, budgets, markup
 *   2. project status                   — module/phase/verification counts + index readability
 *   3. verification coverage            — every module has a verification file, declared test
 *                                         files exist, unsafe entries are rejected
 *   4. optional scoped tests            — trust-gated `<module-checks>` execution
 *
 * Exit codes follow ADR-3: 0 pass, 1 findings/test failures, 2 usage/config/project error.
 * Text mode is a compact human digest; `--format json` emits the ADR-8 envelope.
 */

// START_MODULE_CONTRACT
//   PURPOSE: Run the whole MyGRACE quality gate in one invocation and report a CI-suitable digest.
//   SCOPE: Read-only checks plus optional trust-gated test execution; no file mutation except the shared
//          `.mygrace/last-failures.md` failure report written by the verify runner.
//   DEPENDS: grace-common, grace-config, grace-errors, grace-lint, grace-status, grace-test, grace-verify
//   LINKS: docs/modules/M-CI.xml
// END_MODULE_CONTRACT

// START_MODULE_MAP
//   CoverageReport        — verification coverage counters + gaps
//   TestsReport           — scoped test-run counters/refusals
//   CiResult              — findings, status, coverage, optional tests, exit code
//   collectCoverage()     — coverage checks (module ↔ verification ↔ test files)
//   runCiGate()           — the gate itself (exported for tests and the MCP layer)
//   ciCommand             — `mygrace ci [--tests] [--module M-XXX] [--format json]`
// END_MODULE_MAP

import { defineCommand } from "citty";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { tryLoadConfig } from "./grace-config";
import type { MyGraceConfig } from "./grace-config";
import { EXIT, MyGraceError, TrustError, UsageError, createEnvelope, exitCodeForFindings, finding, printJson } from "./grace-errors";
import type { ExitCode, Finding } from "./grace-errors";
import { listEntityFiles, readFileOrNull, readIndexFileSafe, tryFindProjectRoot } from "./grace-common";
import { collectLintIssues } from "./grace-lint";
import { loadGraphIndex } from "./grace-shard";
import { buildStatusSnapshot, statusFindings } from "./grace-status";
import type { StatusSnapshot } from "./grace-status";
import {
  authorizeCommands,
  hasCheckCommand,
  parseOutputFormat,
  parseTestFiles,
  resolveModuleIds,
  runModuleTests,
  validateTestFileEntry,
} from "./grace-test";
import type { ModuleTestResult, OutputFormat } from "./grace-test";
import { writeFailureReport } from "./grace-verify";

// START_BLOCK_COVERAGE
export interface CoverageReport {
  modules: number;
  withVerification: number;
  withoutVerification: string[];
  verificationFiles: number;
  testFilesDeclared: number;
  testFilesMissing: string[];
  modulesWithoutTestFiles: string[];
  modulesWithoutDeclaredCommand: string[];
}

const MODULE_TAG_RE = /^M-[A-Za-z0-9][A-Za-z0-9_-]*$/;

/**
 * Verification coverage checks.
 *
 * Lint already enforces index↔entity integrity and `verification-ref`
 * existence; this layer answers the question lint cannot: does each module's
 * verification actually declare executable tests, and do those files exist?
 */
export function collectCoverage(root: string, config: MyGraceConfig): { report: CoverageReport; findings: Finding[] } {
  const findings: Finding[] = [];
  const report: CoverageReport = {
    modules: 0,
    withVerification: 0,
    withoutVerification: [],
    verificationFiles: 0,
    testFilesDeclared: 0,
    testFilesMissing: [],
    modulesWithoutTestFiles: [],
    modulesWithoutDeclaredCommand: [],
  };

  // Shard-aware: coverage walks the union of flat module entries and shards.
  // Malformed/unreadable index problems are reported by lint with coded findings.
  const graph = loadGraphIndex(root);

  const verificationDir = join(root, "docs", "verification");
  const verificationFiles = new Set(listEntityFiles(verificationDir, "V-M-").map((file) => file.replace(/\.xml$/u, "")));
  report.verificationFiles = verificationFiles.size;

  for (const entry of graph.entries) {
    if (!MODULE_TAG_RE.test(entry.tag)) continue;
    report.modules += 1;

    const reference = (entry.attrs.VERIFICATION_REF ?? "").trim();
    const moduleFile = join(root, "docs", "modules", `${entry.tag}.xml`);
    const moduleContent = readFileOrNull(moduleFile);

    if (reference === "") {
      report.withoutVerification.push(entry.tag);
      findings.push(
        finding("error", "MODULE_WITHOUT_VERIFICATION", `${entry.tag} has no VERIFICATION_REF in graph-index.xml.`, {
          file: "docs/graph-index.xml",
          hint: "Add a verification file and set VERIFICATION_REF, then run `mygrace trust` again before tests.",
        })
      );
      continue;
    }

    if (!verificationFiles.has(reference)) {
      // Lint reports VERIFICATION_REF_NOT_IN_INDEX / missing file; keep CI output focused.
      continue;
    }

    report.withVerification += 1;
    const verificationContent = readFileOrNull(join(verificationDir, `${reference}.xml`));
    if (verificationContent === null) continue;

    if (!hasCheckCommand(verificationContent) && (moduleContent === null || !hasCheckCommand(moduleContent))) {
      report.modulesWithoutDeclaredCommand.push(entry.tag);
      findings.push(
        finding(
          "info",
          "MODULE_WITHOUT_DECLARED_COMMAND",
          `${entry.tag} declares no <module-checks>; the configured testRunner (${config.testRunner}) will be used.`,
          {
            file: `docs/verification/${reference}.xml`,
            hint: "Declare <module-checks><check-1>…</check-1></module-checks> to pin the verification command.",
          }
        )
      );
    }

    const testFiles = parseTestFiles(verificationContent);
    if (testFiles.length === 0) {
      report.modulesWithoutTestFiles.push(entry.tag);
      findings.push(
        finding("error", "VERIFICATION_WITHOUT_TEST_FILES", `${reference} declares no <test-files> entries.`, {
          file: `docs/verification/${reference}.xml`,
          hint: "List the test files that prove this module, then run `mygrace trust` again.",
        })
      );
      continue;
    }

    for (const testFile of testFiles) {
      let safeEntry: string;
      try {
        safeEntry = validateTestFileEntry(testFile);
      } catch (error) {
        const message = error instanceof MyGraceError ? error.message : String(error);
        findings.push(
          finding("error", "UNSAFE_TEST_FILE", `${reference} declares an unsafe test file "${testFile}": ${message}`, {
            file: `docs/verification/${reference}.xml`,
            hint: "Test file entries must be relative paths inside the project.",
          })
        );
        continue;
      }
      report.testFilesDeclared += 1;
      if (!existsSync(join(root, safeEntry))) {
        report.testFilesMissing.push(safeEntry);
        findings.push(
          finding("error", "TEST_FILE_MISSING", `${entry.tag} declares test file "${safeEntry}" but it does not exist.`, {
            file: `docs/verification/${reference}.xml`,
            hint: "Create the test file or fix the path in <test-files>.",
          })
        );
      }
    }
  }

  return { report, findings };
}
// END_BLOCK_COVERAGE

// START_BLOCK_TESTS
export interface TestsReport {
  requested: boolean;
  authorized: boolean;
  via?: string;
  modules: number;
  passed: number;
  failed: ModuleTestResult[];
  failureReport?: string;
}

function runTestsGate(
  root: string,
  config: MyGraceConfig,
  options: CiOptions
): { report: TestsReport; findings: Finding[] } {
  const findings: Finding[] = [];
  const authorization = authorizeCommands(root, config, options.allowCommands === true);
  const report: TestsReport = {
    requested: true,
    authorized: authorization.authorized,
    ...(authorization.authorized ? { via: String(authorization.via) } : {}),
    modules: 0,
    passed: 0,
    failed: [] as ModuleTestResult[],
  };

  if (!authorization.authorized) {
    findings.push(
      finding("error", "UNTRUSTED_PROJECT", "Project-declared test commands were not executed: no valid trust record.", {
        file: ".mygrace/trust.json",
        hint: "Review the commands with `mygrace trust --path .` (or pass --allow-commands), then re-run `mygrace ci --tests`.",
      })
    );
    return { report, findings };
  }

  const moduleIds = resolveModuleIds(root, options.module, undefined, "ci");
  for (const moduleId of moduleIds) {
    const result = runModuleTests(root, moduleId, { config, authorization, compact: true });
    report.modules += 1;
    if (result.ok) {
      report.passed += 1;
      continue;
    }
    report.failed.push(result);
    const detail = result.error?.message ?? result.output.split("\n").slice(0, 6).join(" ");
    findings.push(
      finding("error", "MODULE_CHECK_FAILED", `${moduleId}: verification failed — ${detail}`, {
        ...(result.error?.file === undefined ? {} : { file: result.error.file }),
        hint: `Run \`mygrace verify --module ${moduleId}\` for the full digest.`,
      })
    );
  }

  if (report.failed.length > 0) {
    const written = writeFailureReport(root, report.failed);
    if ("path" in written) report.failureReport = written.path;
  }

  return { report, findings };
}
// END_BLOCK_TESTS

// START_BLOCK_GATE
export interface CiOptions {
  path?: string;
  format?: OutputFormat;
  /** Run trust-gated scoped verification tests as part of the gate. */
  tests?: boolean;
  /** Limit the tests stage to one module. */
  module?: string;
  /** Explicit shell/command opt-in forwarded to the trust check. */
  allowCommands?: boolean;
}

export interface CiResult {
  root: string;
  findings: Finding[];
  status: StatusSnapshot | null;
  coverage: CoverageReport;
  tests?: TestsReport;
  /** Set when the gate could not run as requested (e.g. untrusted tests) — exit 2. */
  refusal?: MyGraceError;
  exitCode: ExitCode;
}

/** Run the full gate against a project root. Throws typed errors for usage/config failures. */
export function runCiGate(root: string, options: CiOptions = {}): CiResult {
  const loaded = tryLoadConfig(root);
  if (!loaded.ok) throw loaded.error;
  const config = loaded.result.config;

  const findings: Finding[] = [];
  findings.push(...collectLintIssues(root, false, config));

  const coverageResult = collectCoverage(root, config);
  findings.push(...coverageResult.findings);

  let status: StatusSnapshot | null = null;
  try {
    status = buildStatusSnapshot(root);
    // Lint already contributed detailed findings; status adds only unreadable-index errors.
    findings.push(...statusFindings(status).filter((item) => item.code === "INDEX_UNREADABLE"));
  } catch (error) {
    throw error instanceof MyGraceError ? error : new UsageError(`Cannot build project status: ${String(error)}`);
  }

  let tests: TestsReport | undefined;
  let refusal: MyGraceError | undefined;
  if (options.tests === true) {
    const testsGate = runTestsGate(root, config, options);
    tests = testsGate.report;
    findings.push(...testsGate.findings);
    if (!testsGate.report.authorized) {
      refusal = new TrustError(root, "trust-gated verification tests", {
        hint: "Review the commands with `mygrace trust --path .` (or pass --allow-commands), then re-run `mygrace ci --tests`.",
      });
    }
  }

  return {
    root,
    findings,
    status,
    coverage: coverageResult.report,
    ...(tests === undefined ? {} : { tests }),
    ...(refusal === undefined ? {} : { refusal }),
    exitCode: refusal !== undefined ? EXIT.USAGE : exitCodeForFindings(findings, true),
  };
}
// END_BLOCK_GATE

// START_BLOCK_REPORT
function formatFindings(findings: readonly Finding[]): string[] {
  const lines: string[] = [];
  for (const severity of ["error", "warning"] as const) {
    const group = findings.filter((item) => item.severity === severity);
    if (group.length === 0) continue;
    lines.push(`${severity === "error" ? "Errors" : "Warnings"}:`);
    for (const item of group) {
      const location = item.file === undefined ? "" : ` [${item.file}]`;
      lines.push(`  ${severity === "error" ? "✗" : "⚠"} ${item.code}: ${item.message}${location}`);
      if (item.hint !== undefined) lines.push(`      → ${item.hint}`);
    }
    lines.push("");
  }
  return lines;
}

function formatTextReport(result: CiResult): string {
  const lines: string[] = ["MyGRACE CI Report", "=================", `Project: ${result.root}`, ""];
  const status = result.status;
  if (status !== null) {
    lines.push(
      `Modules:       ${status.modules.total}`,
      `Phases:        ${status.phases.total}`,
      `Verifications: ${status.verifications.total}`,
      ""
    );
  }

  const errors = result.findings.filter((item) => item.severity === "error").length;
  const warnings = result.findings.filter((item) => item.severity === "warning").length;
  lines.push(`Lint & integrity: ${errors} errors, ${warnings} warnings`);

  const coverage = result.coverage;
  lines.push(
    `Coverage:         ${coverage.withVerification}/${coverage.modules} modules verified, ` +
      `${coverage.testFilesDeclared} test files declared, ${coverage.testFilesMissing.length} missing`
  );

  if (result.tests !== undefined) {
    const tests = result.tests;
    if (!tests.authorized) {
      lines.push("Tests:            not run (project commands are untrusted)");
    } else {
      lines.push(`Tests:            ${tests.modules} module(s), ${tests.passed} passed, ${tests.failed.length} failed`);
      if (tests.failureReport !== undefined) lines.push(`Failure report:   ${tests.failureReport}`);
    }
  }
  lines.push("");

  const details = formatFindings(result.findings);
  if (details.length > 0) lines.push(...details);

  lines.push(result.exitCode === EXIT.OK ? "✓ CI PASS — the project is consistent and verified." : "✗ CI FAIL — see findings above.");
  return `${lines.join("\n")}\n`;
}

export const ciCommand = defineCommand({
  meta: {
    name: "ci",
    description:
      "One-command quality gate: strict lint + status + verification coverage (+ optional trust-gated tests). Exit 0 pass, 1 findings, 2 usage.",
  },
  args: {
    path: { type: "string", default: ".", description: "Project root" },
    format: { type: "string", default: "text", description: "Output format: text or json" },
    tests: { type: "boolean", default: false, description: "Also run trust-gated scoped verification tests" },
    module: { type: "string", description: "Limit the tests stage to one module id (e.g. M-AUTH)" },
    allowCommands: {
      type: "boolean",
      default: false,
      description: "Explicitly allow project-declared commands for this run (shell/metacharacter opt-in)",
    },
  },
  run: async ({ args }) => {
    const root = tryFindProjectRoot(args.path);
    if (root === null) {
      throw new UsageError(`MyGRACE project not found from "${args.path}".`, {
        hint: "Run in a project with docs/graph-index.xml, or pass --path <project-root>.",
      });
    }

    const format = parseOutputFormat(args.format);
    const result = runCiGate(root, {
      ...(typeof args.module === "string" ? { module: args.module } : {}),
      tests: args.tests === true,
      allowCommands: args.allowCommands === true,
    });

    if (format === "json") {
      printJson(
        createEnvelope({
          data: {
            root: result.root,
            status: result.status,
            coverage: result.coverage,
            ...(result.tests === undefined ? {} : { tests: result.tests }),
          },
          findings: result.findings,
          ...(result.refusal === undefined ? {} : { error: result.refusal }),
          strict: true,
          meta: { command: "ci", root: result.root },
        })
      );
    } else {
      process.stdout.write(formatTextReport(result));
    }

    process.exit(result.exitCode);
  },
});
// END_BLOCK_REPORT
