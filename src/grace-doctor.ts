#!/usr/bin/env bun
/**
 * MyGRACE Doctor Command
 *
 * Health checks for the MyGRACE + DSH integration environment:
 *   - project: docs/graph-index.xml, lint errors/warnings
 *   - environment: dsh, rtk, caveman, bun, node, pnpm
 *   - integration: DSH user skills (mygrace-*), MCP row, status panel
 *   - dev tools: node_modules count
 */

import { defineCommand } from "citty";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { findProjectRoot, readIndexFile } from "./grace-common";
import { collectLintIssues } from "./grace-lint";
import { skillSourceDirs } from "./grace-install";

interface DoctorCheck {
  name: string;
  ok: boolean;
  detail: string;
  hint?: string;
  warning?: boolean;
}

interface ProjectStatus {
  modules: number;
  phases: number;
  verifications: number;
  errors: number;
  warnings: number;
}

export interface DoctorReport {
  project: { ok: boolean; status?: ProjectStatus; error?: string };
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

function countIndex(root: string, file: string): number {
  return readIndexFile(join(root, "docs", file)).length;
}

export function buildDoctorReport(startDir: string): DoctorReport {
  let root = resolve(startDir);
  try {
    root = findProjectRoot(startDir);
  } catch {
    // Not a MyGRACE project — record the failure instead of throwing.
  }
  const projectFound = existsSync(join(root, "docs", "graph-index.xml"));

  let project: DoctorReport["project"];
  if (!projectFound) {
    project = { ok: false, error: "docs/graph-index.xml not found — run mygrace init-dsh or create docs/" };
  } else {
    const issues = collectLintIssues(root, false);
    const errors = issues.filter((i) => i.severity === "error").length;
    const warnings = issues.filter((i) => i.severity === "warning").length;
    project = {
      ok: errors === 0,
      status: {
        modules: countIndex(root, "graph-index.xml"),
        phases: countIndex(root, "plan-index.xml"),
        verifications: countIndex(root, "verification-index.xml"),
        errors,
        warnings,
      },
    };
  }

  const dsh = probe("dsh", ["--version"]);
  const rtk = probe("rtk", ["--version"]);
  const caveman = probe("caveman", ["--version"]);

  // DSH user skill install path (user-dsh, rank 400).
  const dshHome = process.env.DSH_HOME || join(homedir(), ".dsh");
  const expectedSkills = skillSourceDirs().map((s) => s.name);
  const foundSkills = expectedSkills.filter((name) => existsSync(join(dshHome, "skills", name)));
  const skills: DoctorCheck = {
    name: "mygrace-* skills",
    ok: foundSkills.length === expectedSkills.length,
    detail: `${foundSkills.length}/${expectedSkills.length} installed in ${dshHome}/skills`,
    hint: "mygrace install-dsh (or dsh plugin --profile web add file:./packages/mygrace-dsh)",
  };

  const profilePatchPath = join(dshHome, "profiles", "web", "cordis.patch.yml");
  const mcpOk = existsSync(profilePatchPath) && readFileSync(profilePatchPath, "utf-8").includes("id: mcp-mygrace");
  const mcp: DoctorCheck = {
    name: "MCP row mcp-mygrace",
    ok: mcpOk,
    detail: mcpOk ? "present in cordis.patch.yml" : "missing",
    hint: "mygrace install-dsh",
  };

  const profilePkgPath = join(dshHome, "profiles", "web", "package.json");
  const panelOk = existsSync(profilePkgPath) && readFileSync(profilePkgPath, "utf-8").includes("mygrace-status-panel");
  const panel: DoctorCheck = {
    name: "status panel",
    ok: panelOk,
    detail: panelOk ? "installed in profile deps" : "missing",
    hint: "mygrace install-dsh (needs pnpm)",
  };

  const bun = probe("bun", ["--version"]);
  const node = probe("node", ["--version"]);
  const pnpm = probe("pnpm", ["--version"]);
  const nodeModules = existsSync(join(root, "node_modules")) ? readdirSync(join(root, "node_modules")).length : 0;
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

  const errorCount = [project.ok ? 0 : 1, dsh.found ? 0 : 1, skills.ok ? 0 : 1, mcp.ok ? 0 : 1, panel.ok ? 0 : 1].reduce(
    (a, b) => a + b,
    0
  );
  const warningCount = [!rtk.found, !caveman.found, devTools.warning].filter(Boolean).length;

  return {
    project,
    dsh: { name: "DSH", ok: dsh.found, detail: dsh.found ? dsh.version! : "not installed", hint: dsh.found ? undefined : "install https://github.com/deepseek-ai/deepseek-harness" },
    rtk: { name: "rtk (token saver)", ok: rtk.found, detail: rtk.found ? rtk.version! : "not installed", hint: rtk.found ? undefined : "install https://github.com/rtk-ai/rtk" },
    caveman: { name: "caveman (voice/compress)", ok: caveman.found, detail: caveman.found ? caveman.version! : "not installed", hint: caveman.found ? undefined : "install npx @caveman-ai/cli" },
    skills,
    mcp,
    panel,
    devTools,
    errors: errorCount,
    warnings: warningCount,
  };
}

function fmtCheck(c: DoctorCheck): string {
  const icon = c.warning ? "⚠️" : !c.ok ? "❌" : "✅";
  const hint = c.hint ? `  [hint: ${c.hint}]` : "";
  return `  ${icon} ${c.name} — ${c.detail}${hint}`;
}

export function printDoctorReport(r: DoctorReport): void {
  console.log("MyGRACE doctor");
  console.log("==============");
  console.log("");
  console.log("Project");
  if (r.project.status) {
    const s = r.project.status;
    const lintPart = s.errors ? ` — lint: ${s.errors} errors, ${s.warnings} warnings` : " — lint: 0 errors";
    console.log(`  ✅ modules=${s.modules} phases=${s.phases} verifications=${s.verifications}${lintPart}`);
  } else {
    console.log(`  ❌ ${r.project.error}`);
  }
  console.log("");
  console.log("Environment");
  console.log(fmtCheck(r.dsh));
  console.log(fmtCheck(r.rtk));
  console.log(fmtCheck(r.caveman));
  console.log("");
  console.log("Integration");
  console.log(fmtCheck(r.skills));
  console.log(fmtCheck(r.mcp));
  console.log(fmtCheck(r.panel));
  console.log("");
  console.log("Dev tools");
  console.log(fmtCheck(r.devTools));
  console.log("");
  console.log(`Summary: ${r.errors} error(s), ${r.warnings} warning(s)`);
}

export const doctorCommand = defineCommand({
  meta: { name: "doctor", description: "Health checks for the MyGRACE + DSH integration environment" },
  args: {
    path: { type: "string", default: ".", description: "Project root" },
    format: { type: "string", default: "text", description: "Output format: text or json" },
  },
  run: async ({ args }) => {
    const report = buildDoctorReport(args.path);
    if (args.format === "json") {
      console.log(JSON.stringify(report, null, 2));
      return;
    }
    printDoctorReport(report);
    if (report.errors > 0) process.exit(1);
  },
});
