#!/usr/bin/env bun
/**
 * MyGRACE Status Command
 *
 * Aggregated project health from the three index files plus lint results.
 * Machine-readable via --format json (used by tooling and the Web GUI panel).
 */

import { defineCommand } from "citty";
import { join } from "node:path";
import { findProjectRoot, readIndexFile } from "./grace-common";
import { collectLintIssues } from "./grace-lint";

export interface StatusSnapshot {
  project: string;
  modules: { total: number; byStatus: Record<string, number> };
  phases: { total: number; byStatus: Record<string, number> };
  verifications: { total: number; byPriority: Record<string, number>; byStatus: Record<string, number> };
  lint: { errors: number; warnings: number };
}

export function buildStatusSnapshot(root: string): StatusSnapshot {
  const modules = readIndexFile(join(root, "docs", "graph-index.xml"));
  const phases = readIndexFile(join(root, "docs", "plan-index.xml"));
  const verifications = readIndexFile(join(root, "docs", "verification-index.xml"));

  const count = (entries: { attrs: Record<string, string> }[], key: string) =>
    entries.reduce<Record<string, number>>((acc, e) => {
      // Templates use STATUS (modules/verifications) but lowercase status
      // (phases) — accept either spelling.
      const v = e.attrs[key] || e.attrs[key.toLowerCase()] || "unknown";
      acc[v] = (acc[v] || 0) + 1;
      return acc;
    }, {});

  const issues = collectLintIssues(root, true);

  return {
    project: root,
    modules: { total: modules.length, byStatus: count(modules, "STATUS") },
    phases: { total: phases.length, byStatus: count(phases, "STATUS") },
    verifications: {
      total: verifications.length,
      byPriority: count(verifications, "PRIORITY"),
      byStatus: count(verifications, "STATUS"),
    },
    lint: {
      errors: issues.filter((i) => i.severity === "error").length,
      warnings: issues.filter((i) => i.severity === "warning").length,
    },
  };
}

export const statusCommand = defineCommand({
  meta: { name: "status", description: "Aggregated project health from the 3 indexes + lint (text or json)" },
  args: {
    path: { type: "string", default: ".", description: "Project root" },
    format: { type: "string", default: "text", description: "Output format: text or json" },
  },
  run: async ({ args }) => {
    const root = findProjectRoot(args.path);
    const s = buildStatusSnapshot(root);

    if (args.format === "json") {
      console.log(JSON.stringify(s, null, 2));
      return;
    }

    const fmt = (r: Record<string, number>) =>
      Object.entries(r)
        .map(([k, v]) => `${k}=${v}`)
        .join(", ") || "—";

    console.log("MyGRACE Project Status");
    console.log("======================");
    console.log(`Modules:       ${s.modules.total} (${fmt(s.modules.byStatus)})`);
    console.log(`Phases:        ${s.phases.total} (${fmt(s.phases.byStatus)})`);
    console.log(`Verifications: ${s.verifications.total} (${fmt(s.verifications.byStatus)})`);
    console.log(`Lint:          ${s.lint.errors} errors, ${s.lint.warnings} warnings`);
    console.log();
    console.log(s.lint.errors === 0 ? "✓ Indexes are consistent." : "✗ Run `mygrace lint` for details.");
  },
});
