#!/usr/bin/env bun
/**
 * Merge per-arm web-quality benchmark reports (v3.6.0).
 *
 * The N=10 run is executed as three parallel arm processes to fit the network
 * budget; each writes a schema-v2 partial report. This script validates the
 * parts, concatenates sessions/aggregates and writes the canonical
 * analysis/web-quality-benchmark.{json,md}.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "..");
const ANALYSIS = join(ROOT, "analysis");
const inputs = process.argv.slice(2).filter((arg) => arg.endsWith(".json"));
if (inputs.length === 0) {
  console.error("usage: bun run scripts/merge-quality-benchmarks.ts <partial.json>...");
  process.exit(2);
}

interface Partial {
  schemaVersion: number;
  generatedAt: string;
  reps: number;
  runtime: boolean;
  arms: string[];
  tasks: { id: string; file: string; rubricKeys: string[] }[];
  aggregate: Record<string, unknown>[];
  rows: Record<string, unknown>[];
  sessions: Record<string, unknown>[];
  limitations: string[];
}

const parts = inputs.map((file) => {
  const path = resolve(file);
  if (!existsSync(path)) throw new Error(`missing partial report: ${path}`);
  const data = JSON.parse(readFileSync(path, "utf-8")) as Partial;
  if (data.schemaVersion !== 2 || !Array.isArray(data.sessions)) throw new Error(`invalid partial report: ${path}`);
  return data;
});
const arms = [...new Set(parts.flatMap((part) => part.arms))];
const expectedSessions = parts.reduce((sum, part) => sum + part.arms.length * part.reps * parts[0]!.tasks.length, 0);
const sessions = parts.flatMap((part) => part.sessions);
if (sessions.length !== expectedSessions) {
  throw new Error(`session count ${sessions.length} != expected ${expectedSessions}`);
}
const payload = {
  schemaVersion: 2,
  generatedAt: new Date().toISOString(),
  repository: "empty workspace (artifact tasks only; no repository context)",
  reps: parts[0]!.reps,
  runtime: parts.every((part) => part.runtime),
  arms,
  tasks: parts[0]!.tasks,
  aggregate: parts.flatMap((part) => part.aggregate).filter((row) => Number(row.n) > 0),
  rows: parts.flatMap((part) => part.rows).filter((row) => Number(row.n) > 0),
  sessions,
  limitations: [
    "Runtime checks exercise Chromium via Playwright; they do not replace assistive-technology testing or human review.",
    "Automated blind grading: rubrics are not shown to the agent; N=10 per arm on one dialog task with an empty workspace.",
    "The grace+mwg arm used npx @latest at run time; guidance version is not pinned by the harness.",
    "Results are arm medians/means on a single task, not a general product-quality claim.",
  ],
};
writeFileSync(join(ANALYSIS, "web-quality-benchmark.json"), `${JSON.stringify(payload, null, 2)}\n`);

const lines = [
  "# Web-quality benchmark — dialog task, N=10, runtime a11y",
  "",
  `Generated: ${payload.generatedAt} · reps: ${payload.reps} · runtime: ${payload.runtime} · arms: ${arms.join(" / ")}.`,
  "",
  "## Aggregate",
  "",
  "| Arm | N | files | mean quality % | mean runtime % | median tokens | tool calls | wall s |",
  "|---|---|---|---|---|---|---|---|",
  ...payload.aggregate.map((row) => {
    const item = row as Record<string, unknown>;
    return `| ${item.arm} | ${item.n} | ${item.files} | ${item.meanQuality}% | ${item.meanRuntime === null ? "—" : `${item.meanRuntime}%`} | ${item.medianTokens} | ${item.medianTools} | ${item.medianWall} |`;
  }),
  "",
  "## Per task",
  "",
  "| Arm | Task | N | score (median/max) | median tokens | tool calls | wall s |",
  "|---|---|---|---|---|---|---|",
  ...payload.rows.map((row) => {
    const item = row as Record<string, unknown>;
    return `| ${item.arm} | ${item.task} | ${item.n} | ${item.medianScore}/${item.medianMax} | ${item.medianTokens} | ${item.medianTools} | ${item.medianWall} |`;
  }),
  "",
  "Runtime checks: `dialogOpens`, `focusInside`, `escapeCloses` in headless Chromium; static rubric has 10 checks.",
  "",
  "Limitations:",
  ...payload.limitations.map((line) => `- ${line}`),
  "",
];
writeFileSync(join(ANALYSIS, "web-quality-benchmark.md"), `${lines.join("\n")}\n`);
console.log(lines.join("\n"));
