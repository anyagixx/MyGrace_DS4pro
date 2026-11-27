#!/usr/bin/env bun
/**
 * Hard coverage gate (v3.6.0).
 *
 * Runs `bun test --coverage`, parses Bun's summary table and fails when line or
 * function coverage is below the configured thresholds. This replaces the
 * earlier "coverage is reported but not enforced" state.
 *
 * Usage: bun run scripts/check-coverage.ts [--lines 85] [--functions 90]
 * Env:   MYGRACE_COVERAGE_LINES / MYGRACE_COVERAGE_FUNCTIONS
 */

import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { parseCoverageSummary } from "./lib/coverage";

const ROOT = resolve(import.meta.dir, "..");
const args = process.argv.slice(2);
function numberArg(flag: string, fallback: number): number {
  const index = args.indexOf(flag);
  if (index === -1) return fallback;
  const value = Number(args[index + 1]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}
const linesThreshold = numberArg("--lines", Number(process.env.MYGRACE_COVERAGE_LINES ?? "85"));
const functionsThreshold = numberArg("--functions", Number(process.env.MYGRACE_COVERAGE_FUNCTIONS ?? "90"));

const result = spawnSync("bun", ["test", "--coverage"], {
  cwd: ROOT,
  encoding: "utf8",
  timeout: 600_000,
  maxBuffer: 64 * 1024 * 1024,
});
const report = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
const summary = parseCoverageSummary(report);
if (result.status !== 0 || summary === null) {
  console.error(report.slice(-4000));
  console.error("coverage gate: test run failed or the coverage summary was not found");
  process.exit(1);
}
console.log(`Coverage: ${summary.functions}% functions, ${summary.lines}% lines`);
console.log(`Thresholds: ${functionsThreshold}% functions, ${linesThreshold}% lines`);
if (summary.functions < functionsThreshold || summary.lines < linesThreshold) {
  console.error(
    `coverage gate FAILED: functions ${summary.functions}% (min ${functionsThreshold}%), lines ${summary.lines}% (min ${linesThreshold}%)`
  );
  process.exit(1);
}
console.log("coverage gate passed");
