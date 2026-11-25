#!/usr/bin/env bun
/**
 * MyGRACE capsule evaluation — headless session runner.
 *
 * Runs the pre-registered pilot protocol on two prepared worktrees (capsule arm
 * with qualified capsules + capsule config; skill arm with capsules disabled).
 * One task per fresh `dsh --profile headless` session; records the session id,
 * wall time and the raw JSONL run log into the manifest. The extractor
 * (`scripts/measure-capsules.ts`) joins the manifest with DSH session records.
 *
 * Usage:
 *   DEEPSEEK_API_KEY=... bun run scripts/run-capsule-eval.ts \
 *     --capsule-root /tmp/capsule-eval/capsule \
 *     --skill-root /tmp/capsule-eval/skill \
 *     --reps 3
 *
 * Writes analysis/capsule-eval/manifest.json and analysis/capsule-eval/runs/*.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

interface TaskDefinition {
  id: string;
  prompts: Record<"capsule" | "skill", string>;
}

const ROOT = resolve(import.meta.dir, "..");
const EVAL_DIR = join(ROOT, "analysis", "capsule-eval");
const RUNS_DIR = join(EVAL_DIR, "runs");

const args = process.argv.slice(2);
const option = (name: string, fallback: string): string => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 && args[index + 1] !== undefined ? args[index + 1]! : fallback;
};

const capsuleRoot = resolve(option("capsule-root", "/tmp/capsule-eval/capsule"));
const skillRoot = resolve(option("skill-root", "/tmp/capsule-eval/skill"));
const reps = Math.max(1, Number(option("reps", "3")));
const seed = Number(option("seed", "20261125"));
const timeoutMs = Number(option("timeout-ms", "600000"));
const manifestPath = resolve(ROOT, option("manifest", "analysis/capsule-eval/manifest.json"));
const apiKey = process.env.DEEPSEEK_API_KEY ?? "";

if (apiKey === "") {
  console.error("DEEPSEEK_API_KEY is not set in the launching environment.");
  process.exit(2);
}
for (const [label, root] of [["capsule", capsuleRoot], ["skill", skillRoot]] as const) {
  if (!existsSync(join(root, "src", "grace.ts"))) {
    console.error(`${label} worktree is missing src/grace.ts: ${root}`);
    process.exit(2);
  }
  const config = JSON.parse(readFileSync(join(root, "mygrace.config.json"), "utf8")) as { integrations?: { capsules?: { enabled?: boolean } } };
  const enabled = config.integrations?.capsules?.enabled === true;
  if ((label === "capsule") !== enabled) {
    console.error(`${label} worktree capsule config mismatch (enabled=${enabled}); expected ${label === "capsule" ? "enabled" : "disabled"}.`);
    process.exit(2);
  }
}

const tasks: TaskDefinition[] = [
  {
    id: "daily-check",
    prompts: {
      capsule:
        "You are working in a MyGRACE-governed repository. Run the daily health-check capsule and report its result concisely: status, lint, ci and the recommended next action. Execute exactly this command once: bun run src/grace.ts capsule run daily-check --path . If it stops at a judgment, report that instead. Do not modify any files.",
      skill:
        "You are working in a MyGRACE-governed repository. Perform the daily health check and report the result concisely: status, lint, ci and the recommended next action. Use the project MyGRACE CLI (bun run src/grace.ts ...). Do not modify any files.",
    },
  },
  {
    id: "module-onboarding",
    prompts: {
      capsule:
        "You are working in a MyGRACE-governed repository. Run the module-onboarding capsule for module M-CLI and report the briefing concisely: contract purpose, verification and key dependencies. Execute exactly this command once: bun run src/grace.ts capsule run module-onboarding --module M-CLI --path . If it stops at a judgment, report that instead. Do not modify any files.",
      skill:
        "You are working in a MyGRACE-governed repository. Onboard to module M-CLI and report a concise briefing: contract purpose, verification, key dependencies and the recommended worker packet. Use the project MyGRACE CLI (bun run src/grace.ts ...). Do not modify any files.",
    },
  },
];

// Deterministic shuffle (LCG) so the order is reproducible and balanced.
let state = seed >>> 0;
const random = (): number => {
  state = (state * 1664525 + 1013904223) >>> 0;
  return state / 0x1_0000_0000;
};
const plan: Array<{ task: TaskDefinition; arm: "capsule" | "skill"; rep: number }> = [];
for (const task of tasks) {
  for (const arm of ["capsule", "skill"] as const) {
    for (let rep = 1; rep <= reps; rep += 1) plan.push({ task, arm, rep });
  }
}
for (let index = plan.length - 1; index > 0; index -= 1) {
  const swap = Math.floor(random() * (index + 1));
  [plan[index], plan[swap]] = [plan[swap]!, plan[index]!];
}

mkdirSync(RUNS_DIR, { recursive: true });
const startedAt = new Date().toISOString();
const experiments: Array<Record<string, unknown>> = [];
console.log(`Capsule evaluation: ${plan.length} sessions (${tasks.length} tasks × 2 arms × ${reps} reps)`);
console.log(`capsule=${capsuleRoot}\nskill=${skillRoot}\n`);

for (const [index, item] of plan.entries()) {
  const root = item.arm === "capsule" ? capsuleRoot : skillRoot;
  const id = `${item.task.id}-${item.arm}-${item.rep}`;
  const runJsonl = join("analysis", "capsule-eval", "runs", `${id}.jsonl`);
  const absoluteJsonl = join(ROOT, runJsonl);
  const prompt = item.task.prompts[item.arm];
  const start = Date.now();
  console.log(`[${index + 1}/${plan.length}] ${id} …`);
  const result = spawnSync("dsh", ["--profile", "headless", "--json", prompt], {
    cwd: root,
    env: { ...process.env, DEEPSEEK_API_KEY: apiKey },
    encoding: "utf8",
    timeout: timeoutMs,
    maxBuffer: 32 * 1024 * 1024,
  });
  const wallSeconds = Math.round((Date.now() - start) / 100) / 10;
  const stdout = result.stdout ?? "";
  const stderr = result.stderr ?? "";
  writeFileSync(absoluteJsonl, stdout);
  if (stderr !== "") writeFileSync(join(EVAL_DIR, "runs", `${id}.stderr.log`), stderr);
  let sessionId: string | null = null;
  let finalChars: number | null = null;
  for (const line of stdout.split("\n")) {
    if (line.trim() === "") continue;
    try {
      const event = JSON.parse(line) as Record<string, unknown>;
      if (event.type === "session" && typeof event.sessionId === "string") sessionId = event.sessionId;
      if (event.type === "final" && typeof event.text === "string") finalChars = event.text.length;
    } catch {
      // ignore non-JSON diagnostics
    }
  }
  const changed = spawnSync("git", ["status", "--short"], { cwd: root, encoding: "utf8" });
  const changedFiles = (changed.stdout ?? "").split("\n").filter((line) => line.trim() !== "").length;
  experiments.push({
    id,
    arm: item.arm,
    task: item.task.id,
    rep: item.rep,
    sessionId: sessionId ?? "missing",
    runJsonl,
    startedAt: new Date(start).toISOString(),
    endedAt: new Date().toISOString(),
    wallSeconds,
    exitCode: result.status,
    finalChars,
    changedFiles,
    stderrChars: stderr.length,
  });
  console.log(`   → ${sessionId ?? "NO SESSION"} | ${wallSeconds}s | exit ${result.status} | changed ${changedFiles}`);
  if (sessionId === null) console.error(`   stderr: ${stderr.split("\n").slice(-2).join(" | ")}`);
}

// Objective gate outcome per arm (independent of the agent's report).
const gates: Record<string, { exit: number; output: string }> = {};
for (const [arm, root] of [["capsule", capsuleRoot], ["skill", skillRoot]] as const) {
  const gate = spawnSync("bun", ["run", "src/grace.ts", "ci", "--path", "."], { cwd: root, encoding: "utf8", timeout: 300_000 });
  gates[arm] = { exit: gate.status ?? -1, output: (gate.stdout ?? "").trim().split("\n").slice(-3).join("\n") };
  console.log(`gate ${arm}: exit ${gates[arm]!.exit}`);
}

const manifest = {
  schemaVersion: 1,
  protocol: "analysis/capsule-eval/protocol.md",
  model: "dsh headless default (DeepSeek route)",
  startedAt,
  finishedAt: new Date().toISOString(),
  order: plan.map((item) => `${item.task.id}:${item.arm}:${item.rep}`),
  gates,
  experiments,
};
writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`\nmanifest: ${manifestPath}`);
console.log("next: bun run scripts/measure-capsules.ts --markdown analysis/capsule-eval/report.md");
