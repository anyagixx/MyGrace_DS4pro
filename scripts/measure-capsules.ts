#!/usr/bin/env bun
/**
 * MyGRACE capsule evaluation — metrics extractor and report.
 *
 * Reads the pre-registered manifest (analysis/capsule-eval/manifest.json), joins
 * every entry with its DSH session record and the headless JSONL run log, then
 * reports per-arm/task medians with bootstrap confidence intervals and the
 * pre-registered effect summary. Read-only; raw session files stay local.
 *
 * Usage:
 *   bun run scripts/measure-capsules.ts
 *   bun run scripts/measure-capsules.ts --json --manifest analysis/capsule-eval/manifest.json
 *   bun run scripts/measure-capsules.ts --markdown analysis/capsule-eval/report.md
 */

import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

interface ManifestEntry {
  id?: string;
  arm: "capsule" | "skill";
  task: string;
  rep?: number;
  sessionId: string;
  runJsonl?: string;
  startedAt?: string;
  endedAt?: string;
  wallSeconds?: number;
  notes?: string;
}

interface Manifest {
  protocol?: string;
  model?: string;
  startedAt?: string;
  gates?: Record<string, { exit: number; output: string }>;
  experiments: ManifestEntry[];
}

interface SessionMetrics {
  sessionId: string;
  arm: string;
  task: string;
  cwd: string | null;
  uncachedInputTokens: number;
  outputTokens: number;
  costTokens: number;
  cacheReadTokens: number;
  messageTokens: number | null;
  toolCalls: number | null;
  thinkingSteps: number | null;
  finalChars: number | null;
  wallSeconds: number | null;
  sessionFound: boolean;
}

interface SummaryRow {
  arm: string;
  task: string;
  n: number;
  metrics: Record<string, { median: number; mean: number; min: number; max: number; ci95: [number, number] | null }>;
  gate: string;
}

const ROOT = resolve(import.meta.dir, "..");
const args = process.argv.slice(2);
const option = (name: string, fallback: string): string => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 && args[index + 1] !== undefined ? args[index + 1]! : fallback;
};
const flagged = (name: string): boolean => args.includes(`--${name}`);

const manifestPath = resolve(ROOT, option("manifest", "analysis/capsule-eval/manifest.json"));
const dshHome = option("dsh-home", process.env.DSH_HOME ?? join(homedir(), ".dsh"));
const sessionsDir = join(dshHome, "storages", "session_projcache", "sessions");
const summaryPath = resolve(ROOT, option("json-out", "analysis/capsule-eval/summary.json"));
const markdownPath = option("markdown", "");

if (!existsSync(manifestPath)) {
  console.error(`manifest not found: ${manifestPath} — run scripts/run-capsule-eval.ts first.`);
  process.exit(2);
}
if (!existsSync(sessionsDir)) {
  console.error(`DSH sessions directory not found: ${sessionsDir}`);
  process.exit(2);
}

const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as Manifest;

function findSessionFile(sessionId: string): string | null {
  const candidates = [
    `${sessionId}.json`,
    `${sessionId.replace(/^session-/, "")}.json`,
    `session-${sessionId.replace(/^session-/, "")}.json`,
  ];
  const files = new Set(readdirSync(sessionsDir));
  for (const candidate of candidates) {
    if (files.has(candidate)) return join(sessionsDir, candidate);
  }
  const match = readdirSync(sessionsDir).find((file) => file.includes(sessionId.replace(/^session-/, "")));
  return match === undefined ? null : join(sessionsDir, match);
}

function number(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function parseRunJsonl(path: string | undefined): { toolCalls: number | null; thinking: number | null; finalChars: number | null } {
  if (path === undefined || path === "") return { toolCalls: null, thinking: null, finalChars: null };
  const absolute = resolve(ROOT, path);
  if (!existsSync(absolute)) return { toolCalls: null, thinking: null, finalChars: null };
  let toolCalls = 0;
  let thinking = 0;
  let finalChars: number | null = null;
  for (const line of readFileSync(absolute, "utf8").split("\n")) {
    if (line.trim() === "") continue;
    let event: Record<string, unknown>;
    try {
      event = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (event.type === "tool_call") toolCalls += 1;
    if (event.type === "thinking") thinking += 1;
    if (event.type === "final" && typeof event.text === "string") finalChars = event.text.length;
  }
  return { toolCalls, thinking, finalChars };
}

function median(values: number[]): number {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2 : sorted[middle] ?? 0;
}

function mean(values: number[]): number {
  return values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length;
}

/** Deterministic percentile bootstrap of the median. */
function bootstrapMedianCi(values: number[], seed = 42, iterations = 2_000): [number, number] | null {
  if (values.length < 2) return null;
  let state = seed >>> 0;
  const random = (): number => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x1_0000_0000;
  };
  const medians: number[] = [];
  for (let iteration = 0; iteration < iterations; iteration += 1) {
    const sample: number[] = [];
    for (let index = 0; index < values.length; index += 1) {
      sample.push(values[Math.floor(random() * values.length)] ?? 0);
    }
    medians.push(median(sample));
  }
  medians.sort((left, right) => left - right);
  return [medians[Math.floor(iterations * 0.025)] ?? 0, medians[Math.floor(iterations * 0.975)] ?? 0];
}

const metrics: SessionMetrics[] = [];
for (const entry of manifest.experiments) {
  const sessionFile = findSessionFile(entry.sessionId);
  const run = parseRunJsonl(entry.runJsonl);
  if (sessionFile === null) {
    metrics.push({
      sessionId: entry.sessionId,
      arm: entry.arm,
      task: entry.task,
      cwd: null,
      uncachedInputTokens: 0,
      outputTokens: 0,
      costTokens: 0,
      cacheReadTokens: 0,
      messageTokens: null,
      toolCalls: run.toolCalls,
      thinkingSteps: run.thinking,
      finalChars: run.finalChars,
      wallSeconds: entry.wallSeconds ?? null,
      sessionFound: false,
    });
    continue;
  }
  const record = JSON.parse(readFileSync(sessionFile, "utf8")) as {
    record?: {
      identity?: { cwd?: string };
      rows?: Record<string, { val?: Record<string, unknown> }>;
    };
  };
  const rows = record.record?.rows ?? {};
  const totals = (rows["tokenUsage"]?.val?.["totals"] ?? {}) as Record<string, unknown>;
  const breakdown = (rows["contextBreakdown"]?.val?.["breakdown"] ?? {}) as Record<string, unknown>;
  const uncached = number(totals["uncachedInputTokens"]) ?? 0;
  const output = number(totals["outputTokens"]) ?? 0;
  metrics.push({
    sessionId: entry.sessionId,
    arm: entry.arm,
    task: entry.task,
    cwd: record.record?.identity?.cwd ?? null,
    uncachedInputTokens: uncached,
    outputTokens: output,
    costTokens: uncached + output,
    cacheReadTokens: number(totals["cacheReadTokens"]) ?? 0,
    messageTokens: number(breakdown["messageTokens"]),
    toolCalls: run.toolCalls,
    thinkingSteps: run.thinking,
    finalChars: run.finalChars ?? null,
    wallSeconds: entry.wallSeconds ?? null,
    sessionFound: true,
  });
}

const metricNames = ["costTokens", "uncachedInputTokens", "outputTokens", "cacheReadTokens", "toolCalls", "thinkingSteps", "messageTokens", "wallSeconds"] as const;
const groups = new Map<string, SessionMetrics[]>();
for (const item of metrics) {
  const key = `${item.task}\u0000${item.arm}`;
  const bucket = groups.get(key) ?? [];
  bucket.push(item);
  groups.set(key, bucket);
}

const rows: SummaryRow[] = [];
for (const [key, items] of [...groups.entries()].sort()) {
  const [task, arm] = key.split("\u0000");
  const rowMetrics: SummaryRow["metrics"] = {};
  for (const name of metricNames) {
    const values = items.map((item) => item[name]).filter((value): value is number => typeof value === "number");
    if (values.length === 0) continue;
    rowMetrics[name] = {
      median: median(values),
      mean: mean(values),
      min: Math.min(...values),
      max: Math.max(...values),
      ci95: bootstrapMedianCi(values),
    };
  }
  const gate = manifest.gates?.[arm];
  rows.push({ arm, task, n: items.length, metrics: rowMetrics, gate: gate === undefined ? "n/a" : gate.exit === 0 ? "pass" : `fail(${gate.exit})` });
}

const effects: Array<{ task: string; metric: string; capsule: number | null; skill: number | null; absoluteDelta: number | null; percentReduction: number | null }> = [];
for (const task of [...new Set(rows.map((row) => row.task))].sort()) {
  const capsule = rows.find((row) => row.task === task && row.arm === "capsule");
  const skill = rows.find((row) => row.task === task && row.arm === "skill");
  for (const metric of ["costTokens", "toolCalls", "wallSeconds", "cacheReadTokens"] as const) {
    const capsuleMedian = capsule?.metrics[metric]?.median ?? null;
    const skillMedian = skill?.metrics[metric]?.median ?? null;
    const delta = capsuleMedian !== null && skillMedian !== null ? capsuleMedian - skillMedian : null;
    const percent = delta !== null && skillMedian !== null && skillMedian !== 0 ? (delta / skillMedian) * 100 : null;
    effects.push({ task, metric, capsule: capsuleMedian, skill: skillMedian, absoluteDelta: delta, percentReduction: percent === null ? null : -percent });
  }
}

const summary = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  protocol: manifest.protocol ?? null,
  model: manifest.model ?? null,
  sessions: metrics.length,
  missingSessions: metrics.filter((item) => !item.sessionFound).map((item) => item.sessionId),
  metrics,
  rows,
  effects,
  gates: manifest.gates ?? {},
};
writeFileSync(summaryPath, `${JSON.stringify(summary, null, 2)}\n`);

const table = (row: SummaryRow): string => {
  const cell = (name: string): string => {
    const metric = row.metrics[name];
    if (metric === undefined) return "—";
    const ci = metric.ci95 === null ? "" : ` [${metric.ci95[0].toFixed(0)}, ${metric.ci95[1].toFixed(0)}]`;
    return `${metric.median.toFixed(0)}${ci}`;
  };
  return `| ${row.task} | ${row.arm} | ${row.n} | ${cell("costTokens")} | ${cell("toolCalls")} | ${cell("wallSeconds")} | ${cell("cacheReadTokens")} | ${row.gate} |`;
};

const lines = [
  "# Capsule evaluation — measured summary",
  "",
  `Generated: ${summary.generatedAt}`,
  `Protocol: ${summary.protocol ?? "(missing)"}`,
  `Sessions joined: ${metrics.filter((item) => item.sessionFound).length}/${metrics.length}${summary.missingSessions.length === 0 ? "" : ` (missing: ${summary.missingSessions.join(", ")})`}`,
  "",
  "Medians with deterministic bootstrap 95 % CI of the median (small N — exploratory).",
  "",
  "| Task | Arm | N | cost tokens | tool calls | wall s | cache read | gate |",
  "|---|---|---|---|---|---|---|---|",
  ...rows.map(table),
  "",
  "## Pre-registered effect summary",
  "",
  "Positive reduction = capsule arm lower than skill arm.",
  "",
  "| Task | Metric | capsule median | skill median | reduction % |",
  "|---|---|---|---|---|",
  ...effects.map(
    (effect) =>
      `| ${effect.task} | ${effect.metric} | ${effect.capsule === null ? "—" : effect.capsule.toFixed(0)} | ${effect.skill === null ? "—" : effect.skill.toFixed(0)} | ${effect.percentReduction === null ? "—" : `${effect.percentReduction.toFixed(1)} %`} |`
  ),
  "",
  "Decision rule (pre-registered): < 15 % reduction in tool calls or cost, or any gate-pass regression → capsules stay experimental with no token/cost claims.",
  "",
];
const markdown = lines.join("\n");
if (markdownPath !== "") writeFileSync(resolve(ROOT, markdownPath), markdown);

if (flagged("json")) console.log(JSON.stringify(summary, null, 2));
else console.log(markdown);
