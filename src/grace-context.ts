#!/usr/bin/env bun
/**
 * MyGRACE Context-Cost Command
 *
 * Context budget report per operation (line counts) — the runtime view of
 * scripts/measure-context.ts, for agents deciding how much they may read.
 */

import { defineCommand } from "citty";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { findProjectRoot, readIndexFile } from "./grace-common";

function linesOf(path: string): number {
  if (!existsSync(path)) return 0;
  return readFileSync(path, "utf-8").split("\n").length;
}

function linesOfDir(dirPath: string): number {
  if (!existsSync(dirPath)) return 0;
  return readdirSync(dirPath).filter((f) => f.endsWith(".xml")).reduce((sum, f) => sum + linesOf(join(dirPath, f)), 0);
}

export interface ContextRow {
  name: string;
  lines: number;
}

export interface ContextTable {
  project: string;
  modules: number;
  phases: number;
  verifications: number;
  operations: ContextRow[];
}

export function buildContextTable(root: string): ContextTable {
  const graph = readIndexFile(join(root, "docs", "graph-index.xml"));
  const plans = readIndexFile(join(root, "docs", "plan-index.xml"));
  const vers = readIndexFile(join(root, "docs", "verification-index.xml"));
  const modulesDir = join(root, "docs", "modules");
  const plansDir = join(root, "docs", "plans");
  const verDir = join(root, "docs", "verification");
  const sampleModule = readdirSync(modulesDir).filter((f) => f.endsWith(".xml")).sort()[0] || "M-XXX.xml";
  const samplePhase = readdirSync(plansDir).filter((f) => f.endsWith(".xml")).sort()[0] || "Phase-1.xml";
  const gi = linesOf(join(root, "docs", "graph-index.xml"));
  const pi = linesOf(join(root, "docs", "plan-index.xml"));
  const vi = linesOf(join(root, "docs", "verification-index.xml"));
  const operations: ContextRow[] = [
    { name: "Status check (3 indexes)", lines: gi + pi + vi },
    { name: `Single module work (${sampleModule})`, lines: gi + linesOf(join(modulesDir, sampleModule)) },
    { name: `Phase execution (${samplePhase})`, lines: pi + linesOf(join(plansDir, samplePhase)) },
    { name: "Full verification audit", lines: vi + linesOfDir(verDir) },
  ];
  return { project: root, modules: graph.length, phases: plans.length, verifications: vers.length, operations };
}

export const contextCostCommand = defineCommand({
  meta: { name: "context-cost", description: "Context budget per operation (line counts) — how much context each workflow costs" },
  args: {
    path: { type: "string", default: ".", description: "Project root" },
    format: { type: "string", default: "text", description: "Output format: text or json" },
  },
  run: async ({ args }) => {
    const root = findProjectRoot(args.path);
    const t = buildContextTable(root);
    if (args.format === "json") {
      console.log(JSON.stringify(t, null, 2));
      return;
    }
    console.log("MyGRACE context cost");
    console.log(`Modules: ${t.modules}, phases: ${t.phases}, verifications: ${t.verifications}`);
    console.log("");
    for (const op of t.operations) {
      console.log(`${op.name.padEnd(38)} ${String(op.lines).padStart(5)}`);
    }
  },
});
