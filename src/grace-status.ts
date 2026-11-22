#!/usr/bin/env bun
/**
 * MyGRACE — `mygrace status`.
 *
 * Aggregated project health from the three index files plus the lint scan. The
 * point of the command is a *trustworthy* result: malformed index XML is
 * reported as a finding (never a stack trace), and the process exits non-zero
 * whenever the project has real errors — text and JSON alike (ROADMAP ADR-3).
 */

// START_MODULE_CONTRACT
//   PURPOSE: Honest project health snapshot: index counts, status breakdown, lint totals,
//            coded findings and an exit code that matches the result in text and JSON modes.
//   SCOPE: Read-only aggregation of docs/*.xml indexes and the lint scan; no writes.
//   DEPENDS: grace-common (readIndexFileSafe), grace-lint, grace-errors
//   LINKS: ROADMAP.md (ADR-3 exit codes, ADR-8 JSON output)
// END_MODULE_CONTRACT

// START_MODULE_MAP
//   StatusSnapshot     — counts, status breakdowns, lint totals, index read errors
//   buildStatusSnapshot() — safe aggregation (malformed index → indexErrors entry, no throw)
//   statusCommand      — `mygrace status [--format json]`
// END_MODULE_MAP

import { defineCommand } from "citty";
import { join } from "node:path";
import { findProjectRoot, readIndexFileSafe } from "./grace-common";
import { loadGraphIndex } from "./grace-shard";
import { createEnvelope, exitCodeForFindings, finding } from "./grace-errors";
import type { Finding } from "./grace-errors";
import { collectLintIssues } from "./grace-lint";
import { parseOutputFormat, runCommandOutcome } from "./grace-test";
import type { CommandOutcome } from "./grace-test";

export interface StatusIndexError {
  /** Project-relative index file path. */
  file: string;
  message: string;
}

export interface StatusSnapshot {
  project: string;
  modules: { total: number; byStatus: Record<string, number> };
  phases: { total: number; byStatus: Record<string, number> };
  verifications: { total: number; byPriority: Record<string, number>; byStatus: Record<string, number> };
  lint: { errors: number; warnings: number };
  /** Index files that could not be read/parsed (reported, never thrown). */
  indexErrors: StatusIndexError[];
}

function countBy(entries: { attrs: Record<string, string> }[], key: string): Record<string, number> {
  return entries.reduce<Record<string, number>>((accumulator, entry) => {
    // Templates use STATUS (modules/verifications) but lowercase status
    // (phases) — accept either spelling.
    const value = entry.attrs[key] || entry.attrs[key.toLowerCase()] || "unknown";
    accumulator[value] = (accumulator[value] || 0) + 1;
    return accumulator;
  }, {});
}

/** Read one index safely; a parse error becomes a coded entry instead of a crash. */
function countIndex(
  root: string,
  fileName: "graph-index.xml" | "plan-index.xml" | "verification-index.xml",
  errors: StatusIndexError[]
): { entries: { tag: string; attrs: Record<string, string> }[] } {
  const read = readIndexFileSafe(join(root, "docs", fileName));
  if (read.error !== undefined) errors.push({ file: `docs/${fileName}`, message: read.error.message });
  return { entries: read.entries };
}

/**
 * Build the status snapshot.
 *
 * Never throws for unreadable/malformed artifacts: the index errors and lint
 * scan are part of the snapshot so `status --format json` is always parseable.
 */
export function buildStatusSnapshot(root: string): StatusSnapshot {
  const indexErrors: StatusIndexError[] = [];
  // Shard-aware module counts: union of flat entries and <Shard> references.
  const graphIndex = loadGraphIndex(root);
  for (const issue of graphIndex.findings) {
    if (issue.severity === "error") {
      indexErrors.push({ file: issue.file ?? "docs/graph-index.xml", message: `${issue.code}: ${issue.message}` });
    }
  }
  const modules = { entries: graphIndex.entries };
  const phases = countIndex(root, "plan-index.xml", indexErrors);
  const verifications = countIndex(root, "verification-index.xml", indexErrors);

  let lint: StatusSnapshot["lint"] = { errors: 0, warnings: 0 };
  try {
    const issues = collectLintIssues(root, true);
    lint = {
      errors: issues.filter((issue) => issue.severity === "error").length,
      warnings: issues.filter((issue) => issue.severity === "warning").length,
    };
  } catch (error) {
    // The lint scanner itself failed: that is an error the user must see, not
    // a reason to crash with a stack trace.
    indexErrors.push({ file: "docs/", message: error instanceof Error ? error.message : String(error) });
  }

  return {
    project: root,
    modules: { total: modules.entries.length, byStatus: countBy(modules.entries, "STATUS") },
    phases: { total: phases.entries.length, byStatus: countBy(phases.entries, "STATUS") },
    verifications: {
      total: verifications.entries.length,
      byPriority: countBy(verifications.entries, "PRIORITY"),
      byStatus: countBy(verifications.entries, "STATUS"),
    },
    lint,
    indexErrors,
  };
}

/** Findings derived from the snapshot (index errors and lint totals). */
export function statusFindings(snapshot: StatusSnapshot): Finding[] {
  const findings: Finding[] = snapshot.indexErrors.map((issue) =>
    finding("error", "INDEX_UNREADABLE", `Cannot read ${issue.file}: ${issue.message}`, { file: issue.file })
  );
  if (snapshot.lint.errors > 0) {
    findings.push(
      finding("error", "LINT_ERRORS", `${snapshot.lint.errors} lint error(s); run \`mygrace lint\` for details.`, {
        file: "docs/",
        hint: "Run `mygrace lint --format json` to get the full finding list.",
      })
    );
  }
  if (snapshot.lint.warnings > 0) {
    findings.push(
      finding("warning", "LINT_WARNINGS", `${snapshot.lint.warnings} lint warning(s); run \`mygrace lint\` for details.`, {
        file: "docs/",
      })
    );
  }
  return findings;
}

export const statusCommand = defineCommand({
  meta: {
    name: "status",
    description: "Aggregated project health from the 3 indexes + lint (text or json); exits 1 on errors",
  },
  args: {
    path: { type: "string", default: ".", description: "Project root" },
    format: { type: "string", default: "text", description: "Output format: text or json" },
  },
  run: async ({ args }) => {
    const format = parseOutputFormat(args.format);
    await runCommandOutcome<unknown>(format, { command: "status" }, (): CommandOutcome<unknown> => {
      const root = findProjectRoot(args.path ?? ".");
      const snapshot = buildStatusSnapshot(root);
      const findings = statusFindings(snapshot);

      const formatBreakdown = (record: Record<string, number>): string =>
        Object.entries(record)
          .map(([key, value]) => `${key}=${value}`)
          .join(", ") || "—";

      const lines = [
        "MyGRACE Project Status",
        "======================",
        `Modules:       ${snapshot.modules.total} (${formatBreakdown(snapshot.modules.byStatus)})`,
        `Phases:        ${snapshot.phases.total} (${formatBreakdown(snapshot.phases.byStatus)})`,
        `Verifications: ${snapshot.verifications.total} (${formatBreakdown(snapshot.verifications.byStatus)})`,
        `Lint:          ${snapshot.lint.errors} errors, ${snapshot.lint.warnings} warnings`,
      ];
      for (const issue of snapshot.indexErrors) {
        lines.push(`✗ ${issue.file}: ${issue.message}`);
      }
      lines.push("");
      const exitCode = exitCodeForFindings(findings);
      if (exitCode !== 0) {
        lines.push(
          snapshot.indexErrors.length > 0
            ? "✗ Some index files could not be read — run `mygrace lint` for details."
            : "✗ Run `mygrace lint` for details."
        );
      } else if (snapshot.lint.warnings > 0) {
        lines.push(`⚠ Indexes are consistent, but there are ${snapshot.lint.warnings} lint warning(s) — run \`mygrace lint\`.`);
      } else {
        lines.push("✓ Indexes are consistent.");
      }

      const envelope = createEnvelope({ data: snapshot, findings, meta: { command: "status", root } });
      return { envelope, print: () => lines.forEach((line) => console.log(line)) };
    });
  },
});
