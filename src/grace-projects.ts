#!/usr/bin/env bun
/**
 * MyGRACE — `projects` command: monorepo discovery (ROADMAP W3.7).
 *
 * `mygrace projects` answers "what MyGRACE projects live in this tree and how
 * healthy are they?" without reading every per-entity file: a bounded BFS looks
 * for `docs/graph-index.xml` markers, then each project is summarized from the
 * same APIs used by `status`/`lint`/`ci` (counts, lint findings, verification
 * coverage). Read-only; the scan is capped and reports truncation.
 */

// START_MODULE_CONTRACT
//   PURPOSE: Discover MyGRACE sub-projects under a directory tree and report per-project health, lint findings and coverage.
//   SCOPE: Read-only bounded BFS over directories; no writes, no command execution.
//   DEPENDS: grace-common, grace-config, grace-errors, grace-status, grace-lint, grace-ci, grace-shard
//   LINKS: test/grace-projects.test.ts; ROADMAP.md (W3.7)
// END_MODULE_CONTRACT

// START_MODULE_MAP
//   DEFAULT_MAX_DEPTH        — default BFS depth (4)
//   DEFAULT_SCAN_CAP         — hard cap on scanned directories (2000) → truncated flag
//   PROJECT_MARKER           — docs/graph-index.xml
//   ProjectRoot              — discovered project root + display name + depth
//   ProjectSummary           — counts, lint/coverage totals, findings and clean/findings status
//   ProjectsDiscovery        — scanRoot, projects, scannedDirs, truncated
//   discoverProjects()       — bounded BFS; skips ignoreDirs/.git/node_modules/.bun*
//   summarizeProject()       — status snapshot + lint findings + coverage for one root
//   aggregateProjects()      — totals across discovered projects
//   projectsCommand          — citty command (--path/--depth/--format/--strict)
// END_MODULE_MAP

// START_CHANGE_SUMMARY
//   W3.7 — monorepo discovery with per-project health table/JSON, bounded scan and
//          strict exit promotion; reuses status/lint/ci collectors (no duplicated logic).
// END_CHANGE_SUMMARY

import { defineCommand } from "citty";
import { existsSync, readdirSync, statSync } from "node:fs";
import { basename, join, relative, resolve } from "node:path";
import { collectCoverage } from "./grace-ci";
import { formatTable } from "./grace-common";
import { cloneDefault, tryLoadConfig, type MyGraceConfig } from "./grace-config";
import {
  EXIT,
  UsageError,
  createEnvelope,
  exitCodeForFindings,
  finding,
  printJson,
  type Finding,
} from "./grace-errors";
import { collectLintIssues } from "./grace-lint";
import { loadGraphIndex } from "./grace-shard";
import { buildStatusSnapshot } from "./grace-status";

export const DEFAULT_MAX_DEPTH = 4;
export const DEFAULT_SCAN_CAP = 2000;
export const PROJECT_MARKER = join("docs", "graph-index.xml");

/** Directory names always skipped while scanning for projects. */
const ALWAYS_IGNORED = new Set([
  "node_modules",
  ".git",
  ".hg",
  ".svn",
  ".mygrace",
  ".next",
  ".nuxt",
  ".venv",
  "venv",
  "__pycache__",
  "coverage",
  "dist",
  "build",
]);

export interface ProjectRoot {
  /** Absolute project root directory. */
  root: string;
  /** Display name: the graph-index `project` attribute when present, else the directory name. */
  name: string;
  /** Depth below the scan root (0 = scan root itself). */
  depth: number;
}

export interface ProjectLintCounts {
  errors: number;
  warnings: number;
}

export interface ProjectCoverageCounts {
  modules: number;
  withVerification: number;
  testFilesDeclared: number;
  testFilesMissing: number;
}

export interface ProjectSummary {
  name: string;
  root: string;
  modules: number;
  phases: number;
  verifications: number;
  lint: ProjectLintCounts;
  coverage: ProjectCoverageCounts;
  status: "clean" | "findings";
  findings: Finding[];
}

export interface ProjectsDiscovery {
  scanRoot: string;
  projects: ProjectRoot[];
  scannedDirs: number;
  truncated: boolean;
}

export interface ProjectsTotals {
  projects: number;
  clean: number;
  findings: number;
  errors: number;
  warnings: number;
  modules: number;
  phases: number;
  verifications: number;
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/** Display name for a project root. */
function projectName(root: string): string {
  const loaded = loadGraphIndex(root);
  const declared = (loaded.rootAttrs.project ?? "").trim();
  return declared === "" ? basename(root) : declared;
}

function ignoredDirectoryNames(scanRoot: string): Set<string> {
  const ignored = new Set(ALWAYS_IGNORED);
  const loaded = tryLoadConfig(scanRoot);
  const config = loaded.ok ? loaded.result.config : cloneDefault();
  for (const name of config.ignoreDirs) ignored.add(name);
  return ignored;
}

function skipDirectory(name: string, ignored: ReadonlySet<string>): boolean {
  if (ignored.has(name)) return true;
  // Bun's own bookkeeping dirs are never project roots (covers .bun-install/.bun-tmp/.bun-cache/...).
  return name.startsWith(".bun");
}

/**
 * Discover MyGRACE project roots with a bounded BFS.
 *
 * The scan root itself is included when it has the marker. Directory names in
 * the root project's config `ignoreDirs` (plus node_modules/.git/.bun*) are
 * skipped. After `scanCap` visited directories the result is marked truncated.
 */
export function discoverProjects(
  scanRoot: string,
  options: {
    maxDepth?: number;
    scanCap?: number;
    ignoreDirs?: Iterable<string>;
  } = {}
): ProjectsDiscovery {
  const rootAbs = resolve(scanRoot);
  const maxDepth = options.maxDepth ?? DEFAULT_MAX_DEPTH;
  const scanCap = options.scanCap ?? DEFAULT_SCAN_CAP;
  const ignored = ignoredDirectoryNames(rootAbs);
  for (const name of options.ignoreDirs ?? []) ignored.add(name);

  const projects: ProjectRoot[] = [];
  let scannedDirs = 0;
  let truncated = false;
  const queue: { dir: string; depth: number }[] = [{ dir: rootAbs, depth: 0 }];

  while (queue.length > 0) {
    const item = queue.shift();
    if (item === undefined) break;
    if (scannedDirs >= scanCap) {
      truncated = true;
      break;
    }
    scannedDirs += 1;

    if (existsSync(join(item.dir, PROJECT_MARKER))) {
      projects.push({ root: item.dir, name: projectName(item.dir), depth: item.depth });
    }
    if (item.depth >= maxDepth) continue;

    let entries: { name: string; isDirectory: () => boolean }[];
    try {
      entries = readdirSync(item.dir, { withFileTypes: true });
    } catch {
      continue;
    }
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (skipDirectory(entry.name, ignored)) continue;
      queue.push({ dir: join(item.dir, entry.name), depth: item.depth + 1 });
    }
  }

  projects.sort((left, right) => left.root.localeCompare(right.root));
  return { scanRoot: rootAbs, projects, scannedDirs, truncated };
}

/** Read-only health summary for one project root. */
export function summarizeProject(projectRoot: string): ProjectSummary {
  const root = resolve(projectRoot);
  const loadedConfig = tryLoadConfig(root);
  const config: MyGraceConfig = loadedConfig.ok ? loadedConfig.result.config : cloneDefault();
  const findings: Finding[] = [];
  if (!loadedConfig.ok) {
    findings.push(
      finding("error", "CONFIG_INVALID", loadedConfig.error.message, {
        file: loadedConfig.error.file,
        hint: loadedConfig.error.hint,
      })
    );
  }

  const snapshot = buildStatusSnapshot(root);
  findings.push(...collectLintIssues(root, true, config));

  let coverage: ProjectCoverageCounts = {
    modules: 0,
    withVerification: 0,
    testFilesDeclared: 0,
    testFilesMissing: 0,
  };
  try {
    const coverageResult = collectCoverage(root, config);
    coverage = {
      modules: coverageResult.report.modules,
      withVerification: coverageResult.report.withVerification,
      testFilesDeclared: coverageResult.report.testFilesDeclared,
      testFilesMissing: coverageResult.report.testFilesMissing.length,
    };
    findings.push(...coverageResult.findings);
  } catch (error) {
    findings.push(
      finding(
        "error",
        "COVERAGE_FAILED",
        `Cannot compute verification coverage: ${error instanceof Error ? error.message : String(error)}`,
        { file: "docs/graph-index.xml", hint: "Check the index and verification files; run `mygrace ci --path <root>` for details." }
      )
    );
  }

  const errors = findings.filter((item) => item.severity === "error").length;
  const warnings = findings.filter((item) => item.severity === "warning").length;
  return {
    name: projectName(root),
    root,
    modules: snapshot.modules.total,
    phases: snapshot.phases.total,
    verifications: snapshot.verifications.total,
    lint: { errors, warnings },
    coverage,
    status: errors === 0 && warnings === 0 ? "clean" : "findings",
    findings,
  };
}

/** Aggregate totals over summarized projects. */
export function aggregateProjects(projects: readonly ProjectSummary[]): ProjectsTotals {
  const totals: ProjectsTotals = {
    projects: projects.length,
    clean: 0,
    findings: 0,
    errors: 0,
    warnings: 0,
    modules: 0,
    phases: 0,
    verifications: 0,
  };
  for (const project of projects) {
    totals.errors += project.lint.errors;
    totals.warnings += project.lint.warnings;
    totals.modules += project.modules;
    totals.phases += project.phases;
    totals.verifications += project.verifications;
    if (project.status === "clean") totals.clean += 1;
    else totals.findings += 1;
  }
  return totals;
}

function parseDepth(value: unknown): number {
  const raw = String(value ?? `${DEFAULT_MAX_DEPTH}`).trim();
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new UsageError(`Invalid --depth "${raw}".`, {
      hint: "Pass a non-negative integer (0 = scan the given path only).",
    });
  }
  return parsed;
}

function assertFormat(value: unknown): "text" | "json" {
  const format = String(value ?? "text");
  if (format !== "text" && format !== "json") {
    throw new UsageError(`Unknown --format "${format}".`, { hint: "Use --format text or --format json." });
  }
  return format;
}

export const projectsCommand = defineCommand({
  meta: {
    name: "projects",
    description:
      "Discover MyGRACE projects under a directory tree and report per-project counts, lint findings and verification coverage (monorepo view)",
  },
  args: {
    path: { type: "string", default: ".", description: "Directory to scan (may contain several projects)" },
    depth: { type: "string", default: String(DEFAULT_MAX_DEPTH), description: `Maximum directory depth (default ${DEFAULT_MAX_DEPTH})` },
    format: { type: "string", default: "text", description: "Output format: text or json" },
    strict: { type: "boolean", default: false, description: "Fail (exit 1) when only warnings are found in any project" },
  },
  run: async ({ args }) => {
    const format = assertFormat(args.format);
    const maxDepth = parseDepth(args.depth);
    const scanRoot = resolve(args.path);
    if (!existsSync(scanRoot) || !isDirectory(scanRoot)) {
      throw new UsageError(`Scan path does not exist or is not a directory: ${scanRoot}`, {
        hint: "Pass an existing directory (a monorepo root or a single MyGRACE project).",
      });
    }

    const discovery = discoverProjects(scanRoot, { maxDepth });
    const projects = discovery.projects.map((project) => summarizeProject(project.root));
    const totals = aggregateProjects(projects);
    const allFindings = projects.flatMap((project) => project.findings);
    const strict = args.strict === true;
    const exitCode = exitCodeForFindings(allFindings, strict);

    if (format === "json") {
      const envelope = createEnvelope({
        data: {
          root: discovery.scanRoot,
          depth: maxDepth,
          scannedDirs: discovery.scannedDirs,
          truncated: discovery.truncated,
          projects: projects.map((project) => ({
            name: project.name,
            root: project.root,
            modules: project.modules,
            phases: project.phases,
            verifications: project.verifications,
            lint: project.lint,
            coverage: project.coverage,
            status: project.status,
          })),
          totals,
        },
        findings: allFindings,
        strict,
        meta: { command: "projects", root: discovery.scanRoot },
      });
      printJson(envelope);
      process.exit(envelope.exitCode);
    }

    if (projects.length === 0) {
      console.log("MyGRACE projects");
      console.log("================");
      console.log(`No MyGRACE projects found under ${discovery.scanRoot} (scanned ${discovery.scannedDirs} director${discovery.scannedDirs === 1 ? "y" : "ies"}).`);
      process.exit(exitCode);
    }

    console.log("MyGRACE projects");
    console.log("================");
    console.log(`Scan root: ${discovery.scanRoot} (depth ${maxDepth}, ${discovery.scannedDirs} dirs scanned${discovery.truncated ? ", TRUNCATED at scan cap" : ""})`);
    console.log();
    const rows = projects.map((project) => [
      project.name,
      relative(discovery.scanRoot, project.root) === "" ? "." : relative(discovery.scanRoot, project.root),
      String(project.modules),
      String(project.phases),
      String(project.verifications),
      `${project.lint.errors}e/${project.lint.warnings}w`,
      `${project.coverage.withVerification}/${project.coverage.modules}`,
      project.status,
    ]);
    for (const line of formatTable(["PROJECT", "ROOT", "MODULES", "PHASES", "VERIF", "LINT", "COVERAGE", "STATUS"], rows)) {
      console.log(line);
    }
    console.log();
    console.log(
      `Totals: ${totals.projects} project(s), ${totals.clean} clean, ${totals.findings} with findings; ` +
        `${totals.modules} modules, ${totals.phases} phases, ${totals.verifications} verifications.`
    );
    if (totals.errors > 0 || totals.warnings > 0) {
      console.log(`Lint: ${totals.errors} error(s), ${totals.warnings} warning(s)${strict ? " (strict: warnings fail)" : ""}.`);
    }
    if (discovery.truncated) {
      console.log(`Note: scan stopped at the ${DEFAULT_SCAN_CAP}-directory cap; narrow --path or --depth for a complete view.`);
    }
    if (allFindings.length > 0) {
      console.log();
      console.log("Findings:");
      for (const project of projects) {
        for (const item of project.findings) {
          const location = item.file === undefined ? "" : ` [${item.file}]`;
          console.log(`  ${item.severity === "error" ? "✗" : "⚠"} ${project.name}: ${item.code}: ${item.message}${location}`);
        }
      }
    }
    process.exit(exitCode);
  },
});
