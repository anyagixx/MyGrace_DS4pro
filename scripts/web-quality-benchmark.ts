#!/usr/bin/env bun
/**
 * MyGRACE web-quality benchmark — does guidance improve produced artifacts?
 *
 * Three tasks (accessible dialog, native form validation, accessible tabs) are
 * executed by three arms (plain, MyGRACE, MyGRACE + Modern Web Guidance). Each
 * generated artifact is graded by a strict static rubric; results include score,
 * token/tool/wall metrics. This complements the token benchmark and is honest
 * about its limits: static rubrics cannot test runtime a11y behaviour.
 *
 * Usage: DEEPSEEK_API_KEY=... bun run scripts/web-quality-benchmark.ts [--reps 3]
 */

import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { gradeArtifactRuntime } from "./a11y-runtime";

const ROOT = resolve(import.meta.dir, "..");
const CLI = join(ROOT, "src", "grace.ts");
const WORK = join(tmpdir(), "mygrace-quality-bench-v2");
const ANALYSIS = join(ROOT, "analysis");
const RUNS = join(ANALYSIS, "web-quality-benchmark-runs");
const API_KEY = process.env.DEEPSEEK_API_KEY ?? "";
const args = process.argv.slice(2);
const reps = Math.max(1, Number(args[args.indexOf("--reps") + 1] ?? "3") || 3);
const dshHome = process.env.DSH_HOME ?? join(process.env.HOME ?? "", ".dsh");
const dshSessions = join(dshHome, "storages", "session_projcache", "sessions");

type Arm = "plain" | "grace" | "grace+mwg";
const ARMS: Arm[] = ["plain", "grace", "grace+mwg"];

interface TaskSpec {
  id: string;
  file: string;
  mwgQuery: string;
  prompt: string;
  arms?: Arm[];
  rubric: Record<string, { weight: number; test: (lower: string) => boolean }>;
}

const TASKS: TaskSpec[] = [
  {
    id: "dialog",
    file: "dialog-demo.html",
    mwgQuery: "accessible modal dialog",
    prompt:
      "Create `dialog-demo.html` in the repository root: a complete accessible modal dialog demo. Use native <dialog> + showModal(), an accessible name (aria-labelledby/aria-label), a visible close control, Escape support, prefers-reduced-motion CSS, backdrop/@starting-style styling, and explicit focus management. No libraries. Do not modify other files; reply with the APIs used.",
    rubric: {
      nativeDialog: { weight: 1, test: (c) => /<dialog[\s>]/.test(c) },
      showModal: { weight: 1, test: (c) => c.includes("showmodal(") },
      accessibleName: { weight: 1, test: (c) => c.includes("aria-labelledby") || c.includes("aria-label") },
      closeControl: { weight: 1, test: (c) => c.includes("method=\"dialog\"") || c.includes("<button") },
      reducedMotion: { weight: 1, test: (c) => c.includes("prefers-reduced-motion") },
      noAriaDialogRole: { weight: 1, test: (c) => !/role\s*=\s*["']dialog/.test(c) },
      backdropOrStartingStyle: { weight: 1, test: (c) => c.includes("::backdrop") || c.includes("@starting-style") },
      focusManagement: { weight: 1, test: (c) => c.includes("autofocus") || /\.focus\(/.test(c) },
      focusTrapProxy: { weight: 1, test: (c) => c.includes("keydown") && (c.includes("tab") || c.includes("inert")) },
      escapeHandling: { weight: 1, test: (c) => c.includes("keydown") && c.includes("escape") },
    },
  },
  {
    id: "form",
    file: "profile-form.html",
    mwgQuery: "native form validation user-invalid",
    prompt:
      "Create `profile-form.html` in the repository root: a small profile form (name + email) using native HTML validation. Use labels with for/id, required and type=email, autocomplete, aria-describedby for help/error text, :user-invalid (not only :invalid) for error styling, the Constraint Validation API (checkValidity/reportValidity) with a submit handler, and no alert()/inline onclick. No libraries. Do not modify other files; reply with the APIs used.",
    rubric: {
      form: { weight: 1, test: (c) => /<form[\s>]/.test(c) },
      labels: { weight: 1, test: (c) => c.includes("<label") && c.includes("for=") },
      emailRequired: { weight: 1, test: (c) => c.includes("type=\"email\"") && c.includes("required") },
      autocomplete: { weight: 1, test: (c) => c.includes("autocomplete") },
      describedBy: { weight: 1, test: (c) => c.includes("aria-describedby") },
      userInvalid: { weight: 1, test: (c) => c.includes(":user-invalid") },
      constraintApi: { weight: 1, test: (c) => c.includes("checkvalidity") || c.includes("reportvalidity") },
      noAlert: { weight: 1, test: (c) => !/\balert\s*\(/.test(c) },
      ariaLive: { weight: 1, test: (c) => c.includes("aria-live") || c.includes("aria-errormessage") },
    },
  },
  {
    id: "tabs",
    file: "tabs.html",
    mwgQuery: "accessible tabs keyboard navigation",
    prompt:
      "Create `tabs.html` in the repository root: an accessible tabs component with three tabs and panels. Use role=tablist/tab/tabpanel, aria-selected, aria-controls/aria-labelledby, roving tabindex (active tab 0, others -1), ArrowLeft/ArrowRight/Home/End keyboard handling with focus() and activation. No libraries. Do not modify other files; reply with the APIs used.",
    rubric: {
      tablist: { weight: 1, test: (c) => c.includes("role=\"tablist\"") || c.includes("role='tablist'") },
      tabRole: { weight: 1, test: (c) => c.includes("role=\"tab\"") || c.includes("role='tab'") },
      tabpanel: { weight: 1, test: (c) => c.includes("role=\"tabpanel\"") || c.includes("role='tabpanel'") },
      ariaSelected: { weight: 1, test: (c) => c.includes("aria-selected") },
      ariaControls: { weight: 1, test: (c) => c.includes("aria-controls") && (c.includes("aria-labelledby") || c.includes("aria-label")) },
      rovingTabindex: { weight: 1, test: (c) => c.includes("tabindex=\"-1\"") || c.includes("tabindex='-1'") },
      arrowKeys: { weight: 1, test: (c) => c.includes("arrowleft") || c.includes("arrowright") },
      focusManagement: { weight: 1, test: (c) => /\.focus\(/.test(c) },
      homeEndKeys: { weight: 1, test: (c) => c.includes("home") && c.includes("end") },
    },
  },
  {
    id: "python-cli",
    file: "config_tool.py",
    mwgQuery: "not applicable",
    arms: ["plain", "grace"],
    prompt:
      "Create `config_tool.py` in the workspace: a small CLI that reads a JSON config path and prints normalized settings. Use argparse, a docstring, type hints, pathlib, explicit error handling (missing/invalid file -> non-zero exit via SystemExit), a main() guarded by if __name__ == '__main__', and no eval/exec. No third-party libraries. Do not modify other files; reply with the APIs used.",
    rubric: {
      argparse: { weight: 1, test: (c) => c.includes("argparse") },
      docstring: { weight: 1, test: (c) => c.includes('"""') },
      typeHints: { weight: 1, test: (c) => /def\s+\w+\([^)]*:\s*[A-Za-z]/.test(c) && c.includes("->") },
      pathlib: { weight: 1, test: (c) => c.includes("from pathlib") || c.includes("import pathlib") },
      mainGuard: { weight: 1, test: (c) => c.includes("if __name__") },
      errorHandling: { weight: 1, test: (c) => c.includes("try:") && c.includes("except") },
      noEvalExec: { weight: 1, test: (c) => !/\b(eval|exec)\s*\(/.test(c) },
      systemExit: { weight: 1, test: (c) => c.includes("SystemExit") || c.includes("sys.exit") },
    },
  },
];

function listArg(flag: string): string[] | null {
  const index = args.indexOf(flag);
  if (index === -1) return null;
  const value = args[index + 1];
  return typeof value === "string" && value !== "" ? value.split(",").map((item) => item.trim()).filter(Boolean) : null;
}
const taskFilter = listArg("--tasks");
const armFilter = listArg("--arms");
const runtimeEnabled = args.includes("--runtime");
const resume = args.includes("--resume");
function stringArg(flag: string): string | null {
  const index = args.indexOf(flag);
  const value = index === -1 ? undefined : args[index + 1];
  return typeof value === "string" && value !== "" ? value : null;
}
const outBase = stringArg("--out") ?? join(ANALYSIS, "web-quality-benchmark");
const selectedTasks = TASKS.filter((task) => taskFilter === null || taskFilter.includes(task.id));
const selectedArms = ARMS.filter((arm) => armFilter === null || armFilter.includes(arm));

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
function grade(task: TaskSpec, content: string): { score: number; max: number; checks: Record<string, boolean>; notes: string } {
  const lower = content.toLowerCase();
  const checks: Record<string, boolean> = {};
  let score = 0;
  let max = 0;
  for (const [key, rule] of Object.entries(task.rubric)) {
    const ok = content !== "" && rule.test(lower);
    checks[key] = ok;
    max += rule.weight;
    if (ok) score += rule.weight;
  }
  return { score, max, checks, notes: Object.entries(checks).filter(([, ok]) => !ok).map(([key]) => `missing:${key}`).join(",") };
}

/** Artifact tasks run in an empty workspace: the repo is irrelevant, only the produced file is graded. */
function freshArmDir(arm: Arm): string {
  const dir = join(WORK, `workspace-${arm.replace("+", "-")}`);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  return dir;
}

interface Result {
  arm: Arm;
  task: string;
  rep: number;
  sessionId: string;
  wallSeconds: number;
  costTokens: number;
  toolCalls: number;
  fileCreated: boolean;
  score: number;
  max: number;
  checks: Record<string, boolean>;
  notes: string;
  runtime?: { score: number; max: number; checks: Record<string, boolean>; error: string | null };
}

mkdirSync(RUNS, { recursive: true });
const results: Result[] = [];
for (const arm of selectedArms) {
  const armDir = freshArmDir(arm);
  if (arm !== "plain") {
    const init = run("bun", ["run", CLI, "setup", "init", "--path", armDir, "--name", "Express"], armDir);
    if (init.status !== 0) {
      console.error(`setup init failed for ${arm}: ${init.stderr || init.stdout}`);
      process.exit(2);
    }
  }
  for (const task of selectedTasks) {
    const taskArms = task.arms ?? ARMS;
    if (!taskArms.includes(arm)) continue;
    for (let rep = 1; rep <= reps; rep += 1) {
      const armSlug = arm.replace("+", "-");
      const resultFile = join(RUNS, `${armSlug}-${task.id}-${rep}.result.json`);
      if (resume && existsSync(resultFile)) {
        try {
          results.push(JSON.parse(readFileSync(resultFile, "utf8")) as Result);
          continue;
        } catch {
          // Corrupt cache: rerun this rep.
        }
      }
      const file = join(armDir, task.file);
      rmSync(file, { force: true });
      const basePrompt = `Work in an empty workspace. Do not explore or depend on any repository; create the requested file directly. ${task.prompt}`;
      const prompt =
        arm === "grace+mwg"
          ? `First consult Modern Web Guidance: run \`npx -y modern-web-guidance@latest search "${task.mwgQuery}"\` and retrieve the relevant guide(s), then implement. ${basePrompt}`
          : basePrompt;
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
      writeFileSync(join(RUNS, `${arm.replace("+", "-")}-${task.id}-${rep}.jsonl`), stdout);
      let sessionId = "missing";
      let toolCalls = 0;
      for (const line of stdout.split("\n")) {
        if (line.trim() === "") continue;
        try {
          const event = JSON.parse(line) as Record<string, unknown>;
          if (event.type === "session" && typeof event.sessionId === "string") sessionId = event.sessionId;
          if (event.type === "tool_call") toolCalls += 1;
        } catch {
          // ignore diagnostics
        }
      }
      let content = "";
      if (existsSync(file)) {
        try {
          content = readFileSync(file, "utf8");
        } catch {
          content = "";
        }
      }
      const graded = grade(task, content);
      const runtime = runtimeEnabled && content !== "" && task.id !== "python-cli" ? await gradeArtifactRuntime(file, task.id) : undefined;
      let costTokens = 0;
      const sessionFile = sessionId === "missing" ? "" : join(dshSessions, `${sessionId}.json`);
      if (sessionFile !== "" && existsSync(sessionFile)) {
        const record = JSON.parse(readFileSync(sessionFile, "utf8")) as { record?: { rows?: Record<string, { val?: Record<string, unknown> }> } };
        const totals = (record.record?.rows?.["tokenUsage"]?.val?.["totals"] ?? {}) as Record<string, unknown>;
        costTokens = (Number(totals.uncachedInputTokens) || 0) + (Number(totals.outputTokens) || 0);
      }
      results.push({
        arm,
        task: task.id,
        rep,
        sessionId,
        wallSeconds,
        costTokens,
        toolCalls,
        fileCreated: content !== "",
        score: graded.score,
        max: graded.max,
        checks: graded.checks,
        notes: graded.notes,
        ...(runtime === undefined ? {} : { runtime }),
      });
      const lastResult = results[results.length - 1];
      if (lastResult !== undefined) writeFileSync(resultFile, `${JSON.stringify(lastResult, null, 2)}\n`);
      process.stderr.write(`quality ${arm}/${task.id}/rep${rep}: ${graded.score}/${graded.max} tokens=${costTokens} tools=${toolCalls} wall=${wallSeconds}s\n`);
    }
  }
}

interface Row { arm: Arm; task: string; n: number; files: number; medianScore: number; medianMax: number; medianTokens: number; medianTools: number; medianWall: number }
const rows: Row[] = [];
for (const arm of selectedArms) {
  for (const task of selectedTasks) {
    const items = results.filter((item) => item.arm === arm && item.task === task.id);
    if (items.length === 0) continue;
    rows.push({
      arm,
      task: task.id,
      n: items.length,
      files: items.filter((item) => item.fileCreated).length,
      medianScore: Math.round(median(items.map((item) => item.score)) * 10) / 10,
      medianMax: items[0]?.max ?? 0,
      medianTokens: Math.round(median(items.map((item) => item.costTokens))),
      medianTools: Math.round(median(items.map((item) => item.toolCalls))),
      medianWall: Math.round(median(items.map((item) => item.wallSeconds)) * 10) / 10,
    });
  }
}
const aggregate = selectedArms.map((arm) => {
  const items = results.filter((item) => item.arm === arm);
  const normalised = items.map((item) => (item.max === 0 ? 0 : item.score / item.max));
  const runtimeItems = items.filter((item) => item.runtime !== undefined && item.runtime.max > 0);
  return {
    arm,
    n: items.length,
    files: items.filter((item) => item.fileCreated).length,
    meanQuality: Math.round((normalised.reduce((sum, value) => sum + value, 0) / Math.max(1, normalised.length)) * 1000) / 10,
    meanRuntime: runtimeItems.length === 0 ? null : Math.round((runtimeItems.reduce((sum, item) => sum + (item.runtime?.score ?? 0) / (item.runtime?.max ?? 1), 0) / runtimeItems.length) * 1000) / 10,
    medianTokens: Math.round(median(items.map((item) => item.costTokens))),
    medianTools: Math.round(median(items.map((item) => item.toolCalls))),
    medianWall: Math.round(median(items.map((item) => item.wallSeconds)) * 10) / 10,
  };
});

const payload = {
  schemaVersion: 2,
  generatedAt: new Date().toISOString(),
  repository: "empty workspace (artifact tasks only; no repository context)",
  reps,
  tasks: selectedTasks.map((task) => ({ id: task.id, file: task.file, rubricKeys: Object.keys(task.rubric) })),
  runtime: runtimeEnabled,
  arms: selectedArms,
  aggregate,
  rows,
  sessions: results,
  limitations: [
    runtimeEnabled
      ? "Runtime checks exercise Chromium via Playwright; they still do not cover every accessibility rule or assistive technology."
      : "Static rubrics/runtime proxies check source patterns, not real browser accessibility behaviour.",
    "Tasks/rubrics are hidden from the agent prompt (automated blind grading), but N and scope remain limited; see the report header.",
    "The grace+mwg arm ran only web tasks and used npx @latest at run time; guidance version is not pinned by the harness.",
  ],
};
writeFileSync(`${outBase}.json`, `${JSON.stringify(payload, null, 2)}\n`);
const lines = [
  "# Web-quality benchmark — artifact tasks",
  "",
  `Generated: ${payload.generatedAt} · reps: ${reps} · runtime: ${runtimeEnabled} · tasks: ${selectedTasks.map((task) => task.id).join(", ")} · arms: ${selectedArms.join(", ")}.`,
  "",
  "## Aggregate quality",
  "",
  "| Arm | N | files | mean quality % | mean runtime % | median tokens | tool calls | wall s |",
  "|---|---|---|---|---|---|---|---|",
  ...aggregate.map((row) => `| ${row.arm} | ${row.n} | ${row.files} | ${row.meanQuality}% | ${row.meanRuntime === null ? "—" : `${row.meanRuntime}%`} | ${row.medianTokens} | ${row.medianTools} | ${row.medianWall} |`),
  "",
  "## Per task",
  "",
  "| Arm | Task | N | score (median/max) | median tokens | tool calls | wall s |",
  "|---|---|---|---|---|---|---|",
  ...rows.map((row) => `| ${row.arm} | ${row.task} | ${row.n} | ${row.medianScore}/${row.medianMax} | ${row.medianTokens} | ${row.medianTools} | ${row.medianWall} |`),
  "",
  "Rubrics: dialog (10 checks), native form validation (9), accessible tabs (9), Python CLI (8); see JSON for check lists. Runtime proxies are static patterns, not browser execution.",
  "",
  "Limitations:",
  ...payload.limitations.map((line) => `- ${line}`),
  "",
];
writeFileSync(`${outBase}.md`, `${lines.join("\n")}\n`);
console.log(lines.join("\n"));
