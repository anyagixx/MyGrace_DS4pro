#!/usr/bin/env bun
/**
 * MyGRACE — `mygrace context-cost`.
 *
 * Reports how many lines (a stable proxy for context tokens) each workflow
 * costs an agent: the three indexes, one module's read-set, one phase's
 * read-set and the full verification audit. This is the runtime companion of
 * `scripts/measure-context.ts`; it is a *line* model, not a tokenizer model.
 *
 * Hardening: a project may legitimately be missing `docs/modules/` or
 * `docs/plans/` (fresh scaffold, partial migration); that must degrade to a
 * report, never crash. Index files are read with the non-throwing variant so a
 * malformed index becomes a coded finding instead of a stack trace, and the
 * effective `mygrace.config.json` supplies the index caps shown next to the
 * measured sizes.
 */

// START_MODULE_CONTRACT
//   PURPOSE: Honest per-workflow context cost (line model) with safe reads, config caps and JSON envelope.
//   SCOPE: Read-only line counting of docs/** plus config caps; never crashes on missing directories.
//   DEPENDS: grace-common, grace-config, grace-errors
//   LINKS: ROADMAP.md (ADR-3 exit codes, ADR-5 config, ADR-8 JSON output)
// END_MODULE_CONTRACT

// START_MODULE_MAP
//   ContextRow/ContextTable — per-operation line counts + config caps + index read errors
//   buildContextTable()    — safe aggregation (missing dirs → 0 lines, not a crash)
//   contextCostCommand     — `mygrace context-cost [--format json]`
// END_MODULE_MAP

import { defineCommand } from "citty";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { findProjectRoot, listEntityFiles, readIndexFileSafe } from "./grace-common";
import { loadGraphIndex } from "./grace-shard";
import { createEnvelope, finding } from "./grace-errors";
import type { Finding } from "./grace-errors";
import { configPath, loadConfig } from "./grace-config";
import type { IndexCaps, MyGraceConfig } from "./grace-config";
import { parseOutputFormat, runCommandOutcome } from "./grace-test";
import type { CommandOutcome } from "./grace-test";

export interface ContextRow {
  name: string;
  lines: number;
}

export interface ContextIndexError {
  /** Project-relative index path, e.g. `docs/graph-index.xml`. */
  file: string;
  message: string;
}

export interface ContextTable {
  project: string;
  modules: number;
  phases: number;
  verifications: number;
  operations: ContextRow[];
  /** Effective caps from mygrace.config.json (defaults reproduce v1). */
  indexCaps: IndexCaps;
  /** Config source, if the project has one. */
  configPath: string | null;
  /** Measured size of each index file (also the cap comparison input). */
  indexLines: { graph: number; plan: number; verification: number };
  /** Index files that could not be read/parsed (a finding, not a crash). */
  indexErrors: ContextIndexError[];
}

/** Line count of a file; unreadable/missing files contribute 0 to the report. */
function linesOf(path: string, errors: ContextIndexError[]): number {
  if (!existsSync(path)) return 0;
  try {
    return readFileSync(path, "utf-8").split("\n").length;
  } catch (error) {
    errors.push({ file: path, message: error instanceof Error ? error.message : String(error) });
    return 0;
  }
}

function linesOfDir(dirPath: string, prefix: string, errors: ContextIndexError[]): number {
  return listEntityFiles(dirPath, prefix).reduce((sum, file) => sum + linesOf(join(dirPath, file), errors), 0);
}

function indexLines(
  root: string,
  name: "graph-index.xml" | "plan-index.xml" | "verification-index.xml",
  errors: ContextIndexError[]
): { lines: number; count: number } {
  const path = join(root, "docs", name);
  const read = readIndexFileSafe(path);
  if (read.error !== undefined) errors.push({ file: `docs/${name}`, message: read.error.message });
  return { lines: linesOf(path, errors), count: read.entries.length };
}

/**
 * Build the context-cost table.
 *
 * `config` may be passed by the command (already validated); when omitted the
 * project config is loaded so direct callers and tests get identical numbers.
 */
export function buildContextTable(root: string, config?: MyGraceConfig): ContextTable {
  const effective = config ?? loadConfig(root).config;
  const errors: ContextIndexError[] = [];

  const graph = indexLines(root, "graph-index.xml", errors);
  const plans = indexLines(root, "plan-index.xml", errors);
  const verifications = indexLines(root, "verification-index.xml", errors);

  const modulesDir = join(root, "docs", "modules");
  const plansDir = join(root, "docs", "plans");
  const verDir = join(root, "docs", "verification");

  const indexedModule = loadGraphIndex(root).entries.find((entry) => entry.tag.startsWith("M-"));
  const sampleModule =
    indexedModule !== undefined
      ? `${indexedModule.tag}.xml`
      : (listEntityFiles(modulesDir, "M-")[0] ?? "M-XXX.xml");
  const indexedPhase = readIndexFileSafe(join(root, "docs", "plan-index.xml")).entries.find((entry) =>
    entry.tag.startsWith("Phase-")
  );
  const samplePhase =
    indexedPhase !== undefined
      ? `${indexedPhase.tag}.xml`
      : (listEntityFiles(plansDir, "Phase-")[0] ?? "Phase-1.xml");

  const moduleLines = linesOf(join(modulesDir, sampleModule), errors);
  const phaseLines = linesOf(join(plansDir, samplePhase), errors);
  const verificationLines = linesOfDir(verDir, "V-M-", errors);

  const operations: ContextRow[] = [
    { name: "Status check (3 indexes)", lines: graph.lines + plans.lines + verifications.lines },
    { name: `Single module work (${sampleModule})`, lines: graph.lines + moduleLines },
    { name: `Phase execution (${samplePhase})`, lines: plans.lines + phaseLines },
    { name: "Full verification audit", lines: verifications.lines + verificationLines },
  ];

  return {
    project: root,
    modules: graph.count,
    phases: plans.count,
    verifications: verifications.count,
    operations,
    indexCaps: { ...effective.indexCaps },
    indexLines: { graph: graph.lines, plan: plans.lines, verification: verifications.lines },
    configPath: existsSync(configPath(root)) ? "mygrace.config.json" : null,
    indexErrors: errors,
  };
}

/** Findings for a table: unreadable indexes (errors) + caps exceeded (warnings). */
export function contextFindings(table: ContextTable): Finding[] {
  const findings: Finding[] = table.indexErrors.map((issue) =>
    finding("error", "INDEX_UNREADABLE", `Cannot read ${issue.file}: ${issue.message}`, { file: issue.file })
  );
  const caps: [keyof ContextTable["indexLines"], string, number][] = [
    ["graph", "docs/graph-index.xml", table.indexCaps.graph],
    ["plan", "docs/plan-index.xml", table.indexCaps.plan],
    ["verification", "docs/verification-index.xml", table.indexCaps.verification],
  ];
  for (const [kind, file, cap] of caps) {
    const lines = table.indexLines[kind];
    if (lines > cap) {
      findings.push(
        finding("warning", "INDEX_OVER_CAP", `${file} has ${lines} lines (cap ${cap}); run \`mygrace lint\`.`, { file })
      );
    }
  }
  return findings;
}

export const contextCostCommand = defineCommand({
  meta: {
    name: "context-cost",
    description: "Context budget per operation (line counts) — how much context each workflow costs (text or json)",
  },
  args: {
    path: { type: "string", default: ".", description: "Project root" },
    format: { type: "string", default: "text", description: "Output format: text or json" },
  },
  run: async ({ args }) => {
    const format = parseOutputFormat(args.format);
    await runCommandOutcome<unknown>(format, { command: "context-cost" }, (): CommandOutcome<unknown> => {
      const root = findProjectRoot(args.path ?? ".");
      const config = loadConfig(root).config;
      const table = buildContextTable(root, config);
      const findings = contextFindings(table);
      const lines = [
        "MyGRACE context cost",
        `Modules: ${table.modules}, phases: ${table.phases}, verifications: ${table.verifications}`,
        `Index caps: graph<=${table.indexCaps.graph}, plan<=${table.indexCaps.plan}, verification<=${table.indexCaps.verification}`,
        "",
        ...table.operations.map((operation) => `${operation.name.padEnd(38)} ${String(operation.lines).padStart(5)}`),
      ];
      if (findings.length > 0) {
        lines.push("");
        for (const item of findings) lines.push(`${item.severity === "error" ? "✗" : "⚠"} ${item.message}`);
      }
      const envelope = createEnvelope({ data: table, findings, meta: { command: "context-cost", root } });
      return { envelope, print: () => lines.forEach((line) => console.log(line)) };
    });
  },
});
