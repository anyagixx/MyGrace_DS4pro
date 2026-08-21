#!/usr/bin/env bun
/**
 * MyGRACE Lint Command
 *
 * Validates:
 * - Index files exist and are parseable
 * - Index ↔ per-entity file consistency (orphaned, missing, drifted)
 * - Semantic markup in source files (MODULE_CONTRACT, paired blocks)
 * - Unique XML tag conventions in XML files
 * - Verification reference integrity
 */

import { defineCommand } from "citty";
import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

interface LintIssue {
  severity: "error" | "warning";
  message: string;
  file?: string;
}

// ─── Helpers ────────────────────────────────────────────────────────────

function findProjectRoot(startDir: string): string {
  let dir = startDir;
  while (dir !== "/") {
    if (existsSync(join(dir, "docs", "graph-index.xml"))) return dir;
    dir = join(dir, "..");
  }
  throw new Error("MyGRACE project not found. Run in a project with docs/graph-index.xml");
}

function parseIndexEntries(content: string): { tag: string; attrs: Record<string, string> }[] {
  const results: { tag: string; attrs: Record<string, string> }[] = [];
  const regex = /<(M-[\w-]+|V-M-[\w-]+|Phase-\d+)([^>]*?)(?:\/>)/g;
  let m: RegExpExecArray | null;
  while ((m = regex.exec(content)) !== null) {
    const attrs: Record<string, string> = {};
    const attrRegex = /(\w+)="([^"]*)"/g;
    let am: RegExpExecArray | null;
    while ((am = attrRegex.exec(m[2])) !== null) attrs[am[1]] = am[2];
    results.push({ tag: m[1], attrs });
  }
  return results;
}

// ─── Lint: Index ↔ Per-Entity File Consistency ──────────────────────────

function lintIndexSync(
  root: string,
  indexFile: string,
  entityDir: string,
  prefix: string
): LintIssue[] {
  const issues: LintIssue[] = [];
  const indexPath = join(root, "docs", indexFile);

  if (!existsSync(indexPath)) {
    issues.push({ severity: "error", message: `Missing docs/${indexFile} — run /mygrace:init`, file: indexFile });
    return issues;
  }

  const content = readFileSync(indexPath, "utf-8");
  const entries = parseIndexEntries(content);
  const dirPath = join(root, "docs", entityDir);

  if (!existsSync(dirPath)) {
    issues.push({ severity: "error", message: `Missing docs/${entityDir}/ directory` });
    return issues;
  }

  const files = readdirSync(dirPath).filter((f) => f.startsWith(prefix) && f.endsWith(".xml"));
  const fileSet = new Set(files.map((f) => f.replace(".xml", "")));
  const indexSet = new Set(entries.map((e) => e.tag));

  // Orphaned: in index but no file
  for (const entry of entries) {
    if (!fileSet.has(entry.tag)) {
      issues.push({
        severity: "error",
        message: `Orphaned index entry: ${entry.tag} (no ${entityDir}/${entry.tag}.xml)`,
        file: `docs/${indexFile}`,
      });
    }
  }

  // Missing: file exists but not in index
  for (const file of files) {
    const tag = file.replace(".xml", "");
    if (!indexSet.has(tag)) {
      issues.push({
        severity: "error",
        message: `Missing index entry: ${tag} (file exists in ${entityDir}/ but not in ${indexFile})`,
        file: `docs/${entityDir}/${file}`,
      });
    }
  }

  // STATUS drift: check if STATUS in index matches file
  for (const entry of entries) {
    const filePath = join(dirPath, `${entry.tag}.xml`);
    if (existsSync(filePath)) {
      const fileContent = readFileSync(filePath, "utf-8");
      const fileStatusMatch = fileContent.match(/STATUS="([^"]*)"/);
      const fileStatus = fileStatusMatch?.[1];
      if (fileStatus && entry.attrs.STATUS && fileStatus !== entry.attrs.STATUS) {
        issues.push({
          severity: "warning",
          message: `STATUS drift: ${entry.tag} has "${fileStatus}" in file but "${entry.attrs.STATUS}" in index`,
          file: `docs/${indexFile}`,
        });
      }
    }
  }

  return issues;
}

// ─── Lint: Markup in Source Files ───────────────────────────────────────

function lintMarkup(root: string): LintIssue[] {
  const issues: LintIssue[] = [];
  const srcDirs = ["src", "lib", "apps", "packages"];

  for (const srcDir of srcDirs) {
    const fullDir = join(root, srcDir);
    if (!existsSync(fullDir)) continue;

    function walk(dir: string) {
      try {
        const entries = readdirSync(dir);
        for (const entry of entries) {
          const fullPath = join(dir, entry);
          const stat = statSync(fullPath);
          if (stat.isDirectory()) {
            walk(fullPath);
            continue;
          }
          if (!/\.(ts|js|py|go|java|rs|rb)$/.test(entry)) continue;

          const content = readFileSync(fullPath, "utf-8");
          const relPath = relative(root, fullPath);

          // Check paired blocks
          const starts = (content.match(/START_BLOCK_\w+/g) || []).length;
          const ends = (content.match(/END_BLOCK_\w+/g) || []).length;
          if (starts !== ends && starts > 0) {
            issues.push({
              severity: "error",
              message: `Unpaired semantic blocks: ${starts} START vs ${ends} END`,
              file: relPath,
            });
          }

          // Check MODULE_CONTRACT presence (warning, not error — not all files need it)
          if (starts > 2 && !content.includes("START_MODULE_CONTRACT")) {
            issues.push({
              severity: "warning",
              message: `File has ${starts} semantic blocks but no MODULE_CONTRACT — consider adding one`,
              file: relPath,
            });
          }
        }
      } catch {
        // Skip unreadable directories
      }
    }
    walk(fullDir);
  }

  return issues;
}

// ─── Lint: Unique XML Tag Conventions ───────────────────────────────────

function lintXmlTags(root: string): LintIssue[] {
  const issues: LintIssue[] = [];
  const xmlDirs = ["docs", "docs/modules", "docs/plans", "docs/verification"];

  const genericTags = [
    { pattern: "<Module ", fix: "M-XXX" },
    { pattern: "<Phase ", fix: "Phase-N" },
    { pattern: "<Flow ", fix: "DF-XXX" },
    { pattern: "<UseCase ", fix: "UC-XXX" },
    { pattern: "<step ", fix: "step-N" },
    { pattern: "<export ", fix: "export-name" },
    { pattern: "<function ", fix: "fn-name" },
    { pattern: "<type ", fix: "type-Name" },
  ];

  for (const xmlDir of xmlDirs) {
    const fullPath = join(root, xmlDir);
    if (!existsSync(fullPath)) continue;

    for (const file of readdirSync(fullPath).filter((f) => f.endsWith(".xml"))) {
      const content = readFileSync(join(fullPath, file), "utf-8");
      for (const gt of genericTags) {
        if (content.includes(gt.pattern)) {
          issues.push({
            severity: "warning",
            message: `Generic XML tag detected: "${gt.pattern.trim()}". Use unique tag ${gt.fix} instead.`,
            file: `${xmlDir}/${file}`,
          });
        }
      }
    }
  }

  return issues;
}

// ─── Lint: Verification Reference Integrity ─────────────────────────────

function lintVerificationRefs(root: string): LintIssue[] {
  const issues: LintIssue[] = [];
  const modulesDir = join(root, "docs", "modules");
  if (!existsSync(modulesDir)) return issues;

  for (const file of readdirSync(modulesDir).filter((f) => f.startsWith("M-") && f.endsWith(".xml"))) {
    const content = readFileSync(join(modulesDir, file), "utf-8");
    const verRefMatch = content.match(/<verification-ref>(V-M-[\w-]+)<\/verification-ref>/);
    if (verRefMatch) {
      const verId = verRefMatch[1];
      const verPath = join(root, "docs", "verification", `${verId}.xml`);
      if (!existsSync(verPath)) {
        issues.push({
          severity: "error",
          message: `Verification ref ${verId} in ${file} points to non-existent file`,
          file: `docs/modules/${file}`,
        });
      }
    }
  }

  return issues;
}

// ─── Lint Command Export ────────────────────────────────────────────────

export const lintCommand = defineCommand({
  meta: { name: "lint", description: "Validate MyGRACE artifacts, index sync, semantic markup, and XML tag conventions" },
  args: {
    path: { type: "string", default: ".", description: "Project root" },
    format: { type: "string", default: "text", description: "Output format: text or json" },
    allowMissingDocs: { type: "boolean", default: false, description: "Skip required document checks" },
  },
  run: async ({ args }) => {
    const issues: LintIssue[] = [];

    try {
      const root = findProjectRoot(args.path);

      // 1. Index ↔ per-entity file consistency
      issues.push(...lintIndexSync(root, "graph-index.xml", "modules", "M-"));
      issues.push(...lintIndexSync(root, "plan-index.xml", "plans", "Phase-"));
      issues.push(...lintIndexSync(root, "verification-index.xml", "verification", "V-M-"));

      // 2. Verification reference integrity
      issues.push(...lintVerificationRefs(root));

      // 3. Markup in source files
      issues.push(...lintMarkup(root));

      // 4. Unique XML tag conventions
      issues.push(...lintXmlTags(root));

      // 5. Required index files exist
      if (!args.allowMissingDocs) {
        for (const idx of ["graph-index.xml", "plan-index.xml", "verification-index.xml"]) {
          if (!existsSync(join(root, "docs", idx))) {
            issues.push({ severity: "error", message: `Missing docs/${idx}`, file: idx });
          }
        }
      }
    } catch (err: any) {
      issues.push({ severity: "error", message: err.message });
    }

    if (args.format === "json") {
      console.log(JSON.stringify(issues, null, 2));
      return;
    }

    const errors = issues.filter((i) => i.severity === "error");
    const warnings = issues.filter((i) => i.severity === "warning");

    console.log("MyGRACE Lint Report");
    console.log("===================");
    console.log(`Errors:   ${errors.length}`);
    console.log(`Warnings: ${warnings.length}`);
    console.log();

    if (errors.length > 0) {
      console.log("Errors:");
      for (const e of errors) console.log(`  ✗ [${e.file || "project"}] ${e.message}`);
      console.log();
    }

    if (warnings.length > 0) {
      console.log("Warnings:");
      for (const w of warnings) console.log(`  ⚠ [${w.file || "project"}] ${w.message}`);
      console.log();
    }

    if (issues.length === 0) {
      console.log("✓ All checks passed. MyGRACE artifacts are consistent.");
    }

    process.exit(errors.length > 0 ? 1 : 0);
  },
});
