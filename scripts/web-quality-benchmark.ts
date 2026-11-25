#!/usr/bin/env bun
/**
 * MyGRACE web-quality benchmark — does guidance improve the produced artifact?
 *
 * The token benchmark cannot measure quality. Here three arms (plain, MyGRACE,
 * MyGRACE + Modern Web Guidance) are asked to create the same small accessible
 * dialog demo; the generated file is graded against an objective static rubric
 * (native dialog, showModal, accessible name, close control, reduced motion,
 * no ARIA-role fallback) plus token/tool/wall metrics.
 *
 * Honest scope: one repository shell, one task, small N, static rubric. It is a
 * quality signal, not a general productivity benchmark.
 *
 * Usage: DEEPSEEK_API_KEY=... bun run scripts/web-quality-benchmark.ts [--reps 2]
 */

import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const ROOT = resolve(import.meta.dir, "..");
const CLI = join(ROOT, "src", "grace.ts");
const WORK = join(tmpdir(), "mygrace-quality-bench");
const CLONE = join(WORK, "express");
const ANALYSIS = join(ROOT, "analysis");
const RUNS = join(ANALYSIS, "web-quality-benchmark-runs");
const API_KEY = process.env.DEEPSEEK_API_KEY ?? "";
const args = process.argv.slice(2);
const reps = Math.max(1, Number(args[args.indexOf("--reps") + 1] ?? "2") || 2);
const dshHome = process.env.DSH_HOME ?? join(process.env.HOME ?? "", ".dsh");
const dshSessions = join(dshHome, "storages", "session_projcache", "sessions");

type Arm = "plain" | "grace" | "grace+mwg";
const ARMS: Arm[] = ["plain", "grace", "grace+mwg"];

function run(command: string, commandArgs: string[], cwd: string, timeout = 900_000): { status: number; stdout: string; stderr: string } {
  const result = spawnSync(command, commandArgs, { cwd, encoding: "utf8", timeout, maxBuffer: 32 * 1024 * 1024 });
  return { status: result.status ?? -1, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}
function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2 : sorted[middle] ?? 0;
}

if (!existsSync(join(CLONE, "lib", "express.js"))) {
  rmSync(CLONE, { recursive: true, force: true });
  mkdirSync(WORK, { recursive: true });
  const cloned = run("git", ["clone", "--depth", "1", "https://github.com/expressjs/express.git", CLONE], WORK);
  if (cloned.status !== 0) {
    console.error(`clone failed: ${cloned.stderr}`);
    process.exit(2);
  }
}

const PROMPT = [
  "Create a file `dialog-demo.html` in the repository root with a complete, accessible modal dialog demo using modern web platform APIs.",
  "Requirements: native <dialog> with showModal(), an accessible name (aria-labelledby or aria-label), a visible close control,",
  "Escape/keyboard support, and CSS that respects prefers-reduced-motion. Use minimal CSS/JS and no libraries.",
  "Do not modify any other file. After writing, reply with the platform APIs you used.",
].join(" ");

interface Result {
  arm: Arm;
  rep: number;
  sessionId: string;
  wallSeconds: number;
  costTokens: number;
  toolCalls: number;
  fileCreated: boolean;
  score: number;
  checks: Record<string, boolean>;
  notes: string;
}

function grade(content: string): { score: number; checks: Record<string, boolean>; notes: string } {
  const lower = content.toLowerCase();
  const checks: Record<string, boolean> = {
    nativeDialog: /<dialog[\s>]/.test(lower),
    showModal: lower.includes("showmodal("),
    accessibleName: lower.includes("aria-labelledby") || lower.includes("aria-label"),
    closeControl: lower.includes("method=\"dialog\"") || lower.includes("<button"),
    reducedMotion: lower.includes("prefers-reduced-motion"),
    noAriaDialogRole: !/role\s*=\s*["']dialog/.test(lower),
  };
  const score = Object.values(checks).filter(Boolean).length;
  const notes = Object.entries(checks).filter(([, ok]) => !ok).map(([key]) => `missing:${key}`).join(",");
  return { score, checks, notes };
}

mkdirSync(RUNS, { recursive: true });
const results: Result[] = [];
for (const arm of ARMS) {
  const armDir = join(WORK, `express-${arm.replace("+", "-")}`);
  rmSync(armDir, { recursive: true, force: true });
  cpSync(CLONE, armDir, { recursive: true });
  if (arm !== "plain") {
    const init = run("bun", ["run", CLI, "setup", "init", "--path", armDir, "--name", "Express"], armDir);
    if (init.status !== 0) {
      console.error(`setup init failed for ${arm}: ${init.stderr || init.stdout}`);
      process.exit(2);
    }
  }
  for (let rep = 1; rep <= reps; rep += 1) {
    const file = join(armDir, "dialog-demo.html");
    rmSync(file, { force: true });
    const prompt =
      arm === "grace+mwg"
        ? `First consult Modern Web Guidance: run \`npx -y modern-web-guidance@latest search "accessible modal dialog"\` and retrieve the relevant guide(s), then implement. ${PROMPT}`
        : PROMPT;
    const started = Date.now();
    const result = spawnSync("dsh", ["--profile", "headless", "--json", prompt], {
      cwd: armDir,
      env: { ...process.env, DEEPSEEK_API_KEY: API_KEY },
      encoding: "utf8",
      timeout: 900_000,
      maxBuffer: 32 * 1024 * 1024,
    });
    const wallSeconds = Math.round((Date.now() - started) / 100) / 10;
    const stdout = result.stdout ?? "";
    writeFileSync(join(RUNS, `${arm.replace("+", "-")}-${rep}.jsonl`), stdout);
    let sessionId = "missing";
    let finalText = "";
    let toolCalls = 0;
    for (const line of stdout.split("\n")) {
      if (line.trim() === "") continue;
      try {
        const event = JSON.parse(line) as Record<string, unknown>;
        if (event.type === "session" && typeof event.sessionId === "string") sessionId = event.sessionId;
        if (event.type === "final" && typeof event.text === "string") finalText = event.text;
        if (event.type === "tool_call") toolCalls += 1;
      } catch {
        // ignore diagnostics
      }
    }
    void finalText;
    let content = "";
    if (existsSync(file)) {
      try {
        content = readFileSync(file, "utf8");
      } catch {
        content = "";
      }
    }
    const graded = content === "" ? { score: 0, checks: {}, notes: "file-missing" } : grade(content);
    let costTokens = 0;
    const sessionFile = sessionId === "missing" ? "" : join(dshSessions, `${sessionId}.json`);
    if (sessionFile !== "" && existsSync(sessionFile)) {
      const record = JSON.parse(readFileSync(sessionFile, "utf8")) as { record?: { rows?: Record<string, { val?: Record<string, unknown> }> } };
      const totals = (record.record?.rows?.["tokenUsage"]?.val?.["totals"] ?? {}) as Record<string, unknown>;
      costTokens = (Number(totals.uncachedInputTokens) || 0) + (Number(totals.outputTokens) || 0);
    }
    results.push({
      arm,
      rep,
      sessionId,
      wallSeconds,
      costTokens,
      toolCalls,
      fileCreated: content !== "",
      score: graded.score,
      checks: graded.checks,
      notes: graded.notes,
    });
    process.stderr.write(`quality ${arm} rep${rep}: score=${graded.score}/6 tokens=${costTokens} tools=${toolCalls} wall=${wallSeconds}s\n`);
  }
}

const rows = ARMS.map((arm) => {
  const items = results.filter((result) => result.arm === arm);
  return {
    arm,
    n: items.length,
    files: items.filter((item) => item.fileCreated).length,
    medianScore: Math.round(median(items.map((item) => item.score)) * 10) / 10,
    medianTokens: Math.round(median(items.map((item) => item.costTokens))),
    medianTools: Math.round(median(items.map((item) => item.toolCalls))),
    medianWall: Math.round(median(items.map((item) => item.wallSeconds)) * 10) / 10,
  };
});

const payload = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  repository: "expressjs/express (artifact task; no repo code modified)",
  task: PROMPT,
  rubric: ["nativeDialog", "showModal", "accessibleName", "closeControl", "reducedMotion", "noAriaDialogRole"],
  reps,
  rows,
  sessions: results,
  limitations: [
    "One task, static six-point rubric, small N; not a general quality benchmark.",
    "The grace+mwg arm used npx @latest at run time; guidance version is not pinned by the harness.",
    "File creation/quality depends on the agent following the write instruction; missing files score 0 and are reported.",
  ],
};
writeFileSync(join(ANALYSIS, "web-quality-benchmark.json"), `${JSON.stringify(payload, null, 2)}\n`);
const lines = [
  "# Web-quality benchmark — accessible dialog artifact",
  "",
  `Generated: ${payload.generatedAt} · reps: ${reps} · task: one generated \`dialog-demo.html\` graded by a six-point static rubric.`,
  "",
  "| Arm | N | files | median score /6 | median tokens | tool calls | wall s |",
  "|---|---|---|---|---|---|---|",
  ...rows.map((row) => `| ${row.arm} | ${row.n} | ${row.files} | ${row.medianScore} | ${row.medianTokens} | ${row.medianTools} | ${row.medianWall} |`),
  "",
  "Rubric: native `<dialog>`, `showModal()`, accessible name, visible close control, `prefers-reduced-motion`, no ARIA `role=\"dialog\"` fallback.",
  "",
  "Limitations:",
  ...payload.limitations.map((line) => `- ${line}`),
  "",
];
writeFileSync(join(ANALYSIS, "web-quality-benchmark.md"), `${lines.join("\n")}\n`);
console.log(lines.join("\n"));
