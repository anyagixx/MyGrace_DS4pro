#!/usr/bin/env bun
/**
 * MyGRACE — `mygrace doctor`.
 *
 * Environment + project health checks for the MyGRACE / DeepSeek Harness
 * integration. Every check is a row with a stable name, an honest detail line
 * and (when it fails) an actionable hint. The command is read-only.
 *
 * Contract fixes (ROADMAP ADR-3 / ADR-5 / ADR-8):
 *   - `--format json` emits the shared envelope and exits 1 when any error was
 *     found (v1 always exited 0 in JSON mode);
 *   - project counts are read with the non-throwing index reader, so a
 *     malformed index is a doctor error, not a stack trace;
 *   - the effective `mygrace.config.json` is validated and its `sourceDirs`
 *     are reported, so "any layout" projects can see what the tool will scan;
 *   - optional external tools (Octocode/Archify, ADR-9) get an honest
 *     "Integrations" section: detected bins/versions/state + hints only when
 *     the user marked a tool required. Missing optional tools never change the
 *     exit code and never throw.
 */

// START_MODULE_CONTRACT
//   PURPOSE: Honest health report for a MyGRACE project + DSH integration: project/docs, config,
//            environment tools, installed skills, MCP row, status panel, optional external integrations (ADR-9);
//            exit code matches findings.
//   SCOPE: Read-only probes (execFileSync for versions, `--version` integration probes, readFileSync); no writes.
//   DEPENDS: grace-common (findProjectRoot/readIndexFileSafe), grace-lint, grace-config, grace-install,
//            grace-integrations (ADR-9 registry), grace-errors
//   LINKS: ROADMAP.md (ADR-3 exit codes, ADR-5 config, ADR-8 JSON output)
// END_MODULE_CONTRACT

// START_MODULE_MAP
//   DoctorCheck/DoctorReport — typed check rows + error/warning totals + config and integrations rows
//   buildDoctorReport()      — safe report construction (never throws for unreadable project files/tools)
//   doctorFindings()         — map check rows + integration findings to ADR-3 findings (exit-code source)
//   printDoctorReport()      — human text rendering (incl. Integrations section)
//   doctorCommand            — `mygrace doctor [--format json]`
// END_MODULE_MAP

import { defineCommand } from "citty";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { findProjectRoot, readIndexFileSafe } from "./grace-common";
import { createEnvelope, finding } from "./grace-errors";
import type { Finding } from "./grace-errors";
import { cloneDefault, tryLoadConfig } from "./grace-config";
import type { ConfigLoadResult, MyGraceConfig } from "./grace-config";
import { buildIntegrationsStatus, integrationFindings } from "./grace-integrations";
import type { IntegrationsData } from "./grace-integrations";
import { collectLintIssues } from "./grace-lint";
import { skillSourceDirs } from "./grace-install";
import { parseOutputFormat, runCommandOutcome } from "./grace-test";
import type { CommandOutcome } from "./grace-test";

export interface DoctorCheck {
  name: string;
  ok: boolean;
  detail: string;
  hint?: string;
  warning?: boolean;
}

export interface ProjectStatus {
  modules: number;
  phases: number;
  verifications: number;
  errors: number;
  warnings: number;
  /** Index files that could not be read/parsed. */
  indexErrors: string[];
}

export interface DoctorReport {
  project: { ok: boolean; status?: ProjectStatus; error?: string };
  /** Effective project configuration (sourceDirs/language/env/allowCommands). */
  config: DoctorCheck;
  /** Optional external tools (Octocode/Archify, ADR-9): one honest summary row. */
  integrations: DoctorCheck;
  /** Raw detection payload behind the row (JSON consumers / tests). */
  integrationStatus: IntegrationsData | null;
  dsh: DoctorCheck;
  rtk: DoctorCheck;
  caveman: DoctorCheck;
  skills: DoctorCheck;
  mcp: DoctorCheck;
  panel: DoctorCheck;
  devTools: DoctorCheck;
  errors: number;
  warnings: number;
}

/** Run `file args` and return the first non-empty stdout line, or not-found. */
function probe(file: string, args: string[]): { found: boolean; version?: string } {
  try {
    const out = execFileSync(file, args, { encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    if (out) return { found: true, version: out.split("\n")[0] };
  } catch {
    // not installed or exited non-zero — fall through to not-found
  }
  return { found: false };
}

function readIfExists(path: string): string | null {
  if (!existsSync(path)) return null;
  try {
    return readFileSync(path, "utf-8");
  } catch {
    return null;
  }
}

function countIndex(
  root: string,
  fileName: "graph-index.xml" | "plan-index.xml" | "verification-index.xml",
  indexErrors: string[]
): number {
  const read = readIndexFileSafe(join(root, "docs", fileName));
  if (read.error !== undefined) indexErrors.push(`${fileName}: ${read.error.message}`);
  return read.entries.length;
}

function buildConfigCheck(root: string, projectFound: boolean): DoctorCheck {
  if (!projectFound) {
    return { name: "project config", ok: true, detail: "skipped — not a MyGRACE project" };
  }
  const loaded = tryLoadConfig(root);
  if (!loaded.ok) {
    return {
      name: "project config",
      ok: false,
      detail: loaded.error.message,
      hint: "Fix mygrace.config.json (or delete it to use defaults); `mygrace doctor --format json` shows the exact error.",
    };
  }
  const { config, path } = loaded.result;
  const source = path === undefined ? "defaults" : path.replace(root, ".").replace(/\\/g, "/");
  return {
    name: "project config",
    ok: true,
    detail:
      `${source} (sourceDirs: ${config.sourceDirs.join(", ")}; ` +
      `markupExts: ${config.markupExts.length}; language: ${config.language}; ` +
      `allowCommands: ${config.allowCommands}; testRunner: ${config.testRunner})`,
  };
}

/** Human detail for one optional integration entry. */
function describeIntegration(entry: IntegrationsData["octocode"]): string {
  if (!entry.enabled) return `${entry.id}: disabled`;
  if (!entry.available) return `${entry.id}: not found (optional)`;
  const version = entry.version ?? (entry.checked === "exists" ? "detected" : "version unknown");
  const source = entry.source ?? "unknown";
  const state = entry.supported ? "" : ` UNSUPPORTED (expected ${entry.expectedRange})`;
  return `${entry.id}: ${version} (${source})${state}`;
}

/** One honest integrations row; a probe failure is a warning, never an exception. */
function buildIntegrationsCheck(
  root: string,
  config: MyGraceConfig
): { check: DoctorCheck; status: IntegrationsData | null } {
  try {
    const status = buildIntegrationsStatus(root, config);
    const entries = [status.octocode, status.archify, status.modernWebGuidance];
    const requiredProblems = entries.filter((entry) => entry.enabled && entry.required && (!entry.available || !entry.supported));
    const hint = requiredProblems
      .map((entry) => entry.hint)
      .filter((value): value is string => typeof value === "string" && value !== "")
      .join(" ");
    const check: DoctorCheck = {
      name: "integrations (optional)",
      ok: requiredProblems.length === 0,
      detail: entries.map(describeIntegration).join(" · "),
      ...(hint === "" ? {} : { hint }),
      ...(requiredProblems.length === 0 ? {} : { warning: true }),
    };
    return { check, status };
  } catch (error) {
    return {
      check: {
        name: "integrations (optional)",
        ok: false,
        detail: `probe failed: ${error instanceof Error ? error.message : String(error)}`,
        warning: true,
      },
      status: null,
    };
  }
}

/** Build the doctor report. Read-only; unreadable project files become check details. */
export function buildDoctorReport(startDir: string): DoctorReport {
  let projectRoot = resolve(startDir);
  try {
    projectRoot = findProjectRoot(startDir);
  } catch {
    // Not a MyGRACE project — record the failure instead of throwing.
  }
  const projectFound = existsSync(join(projectRoot, "docs", "graph-index.xml"));

  let project: DoctorReport["project"];
  if (!projectFound) {
    project = { ok: false, error: "docs/graph-index.xml not found — run mygrace setup init or create docs/" };
  } else {
    const indexErrors: string[] = [];
    const modules = countIndex(projectRoot, "graph-index.xml", indexErrors);
    const phases = countIndex(projectRoot, "plan-index.xml", indexErrors);
    const verifications = countIndex(projectRoot, "verification-index.xml", indexErrors);

    let lintErrors = 0;
    let lintWarnings = 0;
    try {
      const issues = collectLintIssues(projectRoot, false);
      lintErrors = issues.filter((issue) => issue.severity === "error").length;
      lintWarnings = issues.filter((issue) => issue.severity === "warning").length;
    } catch (error) {
      indexErrors.push(`lint: ${error instanceof Error ? error.message : String(error)}`);
    }

    const errors = lintErrors + indexErrors.length;
    project = {
      ok: errors === 0,
      status: { modules, phases, verifications, errors, warnings: lintWarnings, indexErrors },
    };
  }

  const config = buildConfigCheck(projectRoot, projectFound);
  const loadedForIntegrations = tryLoadConfig(projectRoot);
  const integrationsConfig = loadedForIntegrations.ok ? loadedForIntegrations.result.config : cloneDefault();
  const { check: integrations, status: integrationStatus } = buildIntegrationsCheck(projectRoot, integrationsConfig);
  const dsh = probe("dsh", ["--version"]);
  const rtk = probe("rtk", ["--version"]);
  const caveman = probe("caveman", ["--version"]);

  // DSH user skill install path (user-dsh, rank 400).
  const dshHome = process.env.DSH_HOME || join(homedir(), ".dsh");
  const expectedSkills = skillSourceDirs().map((skill) => skill.name);
  const foundSkills = expectedSkills.filter((name) => existsSync(join(dshHome, "skills", name)));
  const skills: DoctorCheck = {
    name: "mygrace-* skills",
    ok: foundSkills.length === expectedSkills.length,
    detail: `${foundSkills.length}/${expectedSkills.length} installed in ${dshHome}/skills`,
    hint: "mygrace setup install (or dsh plugin --profile web add file:./packages/mygrace-dsh)",
  };

  const profilePatchPath = join(dshHome, "profiles", "web", "cordis.patch.yml");
  const patchContent = readIfExists(profilePatchPath);
  const mcpOk = patchContent !== null && patchContent.includes("id: mcp-mygrace");
  const mcp: DoctorCheck = {
    name: "MCP row mcp-mygrace",
    ok: mcpOk,
    detail: mcpOk ? "present in cordis.patch.yml" : "missing",
    hint: "mygrace setup install",
  };

  const profilePkgPath = join(dshHome, "profiles", "web", "package.json");
  const profilePkg = readIfExists(profilePkgPath);
  const panelOk = profilePkg !== null && profilePkg.includes("mygrace-status-panel");
  const panel: DoctorCheck = {
    name: "status panel",
    ok: panelOk,
    detail: panelOk ? "installed in profile deps" : "missing",
    hint: "mygrace setup install (needs pnpm)",
  };

  const bun = probe("bun", ["--version"]);
  const node = probe("node", ["--version"]);
  const pnpm = probe("pnpm", ["--version"]);
  let nodeModules = 0;
  try {
    nodeModules = existsSync(join(projectRoot, "node_modules")) ? readdirSync(join(projectRoot, "node_modules")).length : 0;
  } catch {
    // unreadable node_modules is not a doctor failure: report 0
  }
  const devTools: DoctorCheck = {
    name: "dev tools",
    ok: bun.found && node.found,
    detail: [
      bun.found ? `bun ${bun.version}` : "bun missing",
      node.found ? `node ${node.version}` : "node missing",
      pnpm.found ? `pnpm ${pnpm.version}` : "pnpm missing",
      `node_modules: ${nodeModules}`,
    ].join(" · "),
    warning: !pnpm.found,
  };

  const dshCheck: DoctorCheck = {
    name: "DSH",
    ok: dsh.found,
    detail: dsh.found ? (dsh.version as string) : "not installed",
    hint: dsh.found ? undefined : "install https://github.com/deepseek-ai/deepseek-harness",
  };
  const rtkCheck: DoctorCheck = {
    name: "rtk (token saver)",
    ok: rtk.found,
    detail: rtk.found ? (rtk.version as string) : "not installed",
    hint: rtk.found ? undefined : "install https://github.com/rtk-ai/rtk",
  };
  const cavemanCheck: DoctorCheck = {
    name: "caveman (voice/compress)",
    ok: caveman.found,
    detail: caveman.found ? (caveman.version as string) : "not installed",
    hint: caveman.found ? undefined : "install npx @caveman-ai/cli",
  };

  const hardChecks: DoctorCheck[] = [dshCheck, config, skills, mcp, panel];
  const projectErrorCount = projectFound ? (project.status?.errors ?? 0) : 1;
  const errorCount = projectErrorCount + hardChecks.filter((check) => !check.ok && check.warning !== true).length;
  const warningCount =
    (projectFound ? (project.status?.warnings ?? 0) : 0) +
    [rtkCheck, cavemanCheck, devTools].filter((check) => !check.ok).length +
    hardChecks.filter((check) => check.warning === true).length;

  return {
    project,
    config,
    integrations,
    integrationStatus,
    dsh: dshCheck,
    rtk: rtkCheck,
    caveman: cavemanCheck,
    skills,
    mcp,
    panel,
    devTools,
    errors: errorCount,
    warnings: warningCount,
  };
}

/**
 * Map the report to findings. This is the single source of the doctor exit
 * code: hard failures are errors (exit 1), optional tools are warnings (0).
 */
export function doctorFindings(report: DoctorReport): Finding[] {
  const findings: Finding[] = [];
  if (!report.project.ok) {
    if (report.project.status === undefined) {
      findings.push(
        finding("error", "PROJECT_NOT_FOUND", report.project.error ?? "docs/graph-index.xml not found.", {
          hint: "Run `mygrace setup init` in the project root, or pass --path <project-root>.",
        })
      );
    }
  }
  if (report.project.status !== undefined) {
    for (const issue of report.project.status.indexErrors) {
      findings.push(finding("error", "INDEX_UNREADABLE", issue, { file: "docs/" }));
    }
    if (report.project.status.errors > report.project.status.indexErrors.length) {
      findings.push(
        finding("error", "LINT_ERRORS", `${report.project.status.errors} project error(s); run \`mygrace lint\` for details.`, {
          file: "docs/",
        })
      );
    }
    if (report.project.status.warnings > 0) {
      findings.push(
        finding("warning", "LINT_WARNINGS", `${report.project.status.warnings} lint warning(s); run \`mygrace lint\` for details.`, {
          file: "docs/",
        })
      );
    }
  }

  const hardChecks: DoctorCheck[] = [report.config, report.dsh, report.skills, report.mcp, report.panel];
  for (const check of hardChecks) {
    if (check.ok) continue;
    findings.push(
      finding(check.warning === true ? "warning" : "error", checkCode(check.name), `${check.name}: ${check.detail}`, {
        ...(check.hint === undefined ? {} : { hint: check.hint }),
      })
    );
  }
  const softChecks: DoctorCheck[] = [report.rtk, report.caveman, report.devTools];
  for (const check of softChecks) {
    if (check.ok) continue;
    findings.push(
      finding("warning", checkCode(check.name), `${check.name}: ${check.detail}`, {
        ...(check.hint === undefined ? {} : { hint: check.hint }),
      })
    );
  }

  // Optional external tools: only their actionable (warning/error) findings reach
  // the exit-code source; info-level "tool not installed" stays out of doctor.
  if (report.integrationStatus !== null) {
    for (const item of integrationFindings(report.integrationStatus)) {
      if (item.severity !== "info") findings.push(item);
    }
  } else if (!report.integrations.ok) {
    findings.push(
      finding(
        report.integrations.warning === true ? "warning" : "error",
        checkCode(report.integrations.name),
        `${report.integrations.name}: ${report.integrations.detail}`,
        { ...(report.integrations.hint === undefined ? {} : { hint: report.integrations.hint }) }
      )
    );
  }

  return findings;
}

function checkCode(name: string): string {
  return `DOCTOR_${name.replace(/[^A-Za-z0-9]+/g, "_").replace(/^_+|_+$/g, "").toUpperCase() || "CHECK"}_FAILED`;
}

function fmtCheck(check: DoctorCheck): string {
  const icon = check.warning ? "⚠️" : !check.ok ? "❌" : "✅";
  const hint = check.hint ? `  [hint: ${check.hint}]` : "";
  return `  ${icon} ${check.name} — ${check.detail}${hint}`;
}

export function printDoctorReport(report: DoctorReport): void {
  console.log("MyGRACE doctor");
  console.log("==============");
  console.log("");
  console.log("Project");
  if (report.project.status) {
    const status = report.project.status;
    const lintPart = status.errors ? ` — lint: ${status.errors} errors, ${status.warnings} warnings` : " — lint: 0 errors";
    console.log(`  ✅ modules=${status.modules} phases=${status.phases} verifications=${status.verifications}${lintPart}`);
    for (const issue of status.indexErrors) console.log(`  ❌ ${issue}`);
  } else {
    console.log(`  ❌ ${report.project.error}`);
  }
  console.log(fmtCheck(report.config));
  console.log("");
  console.log("Environment");
  console.log(fmtCheck(report.dsh));
  console.log(fmtCheck(report.rtk));
  console.log(fmtCheck(report.caveman));
  console.log("");
  console.log("Integration");
  console.log(fmtCheck(report.skills));
  console.log(fmtCheck(report.mcp));
  console.log(fmtCheck(report.panel));
  console.log("");
  console.log("Integrations (optional)");
  console.log(fmtCheck(report.integrations));
  console.log("");
  console.log("Dev tools");
  console.log(fmtCheck(report.devTools));
  console.log("");
  console.log(`Summary: ${report.errors} error(s), ${report.warnings} warning(s)`);
}

export const doctorCommand = defineCommand({
  meta: {
    name: "doctor",
    description: "Health checks for the MyGRACE + DSH integration environment (text or json; exits 1 on errors)",
  },
  args: {
    path: { type: "string", default: ".", description: "Project root" },
    format: { type: "string", default: "text", description: "Output format: text or json" },
  },
  run: async ({ args }) => {
    const format = parseOutputFormat(args.format);
    await runCommandOutcome<unknown>(format, { command: "doctor" }, (): CommandOutcome<unknown> => {
      const report = buildDoctorReport(args.path ?? ".");
      const findings = doctorFindings(report);
      const envelope = createEnvelope({ data: report, findings, meta: { command: "doctor" } });
      return { envelope, print: () => printDoctorReport(report) };
    });
  },
});
