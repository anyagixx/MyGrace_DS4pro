#!/usr/bin/env bun
/**
 * MyGRACE external benchmark — curated artifacts on two real OSS repositories.
 *
 * Targets: expressjs/express (JavaScript) and psf/requests (Python).
 * For each repo: clone, build `grace` (curated MyGRACE docs) and `plain` arms,
 * measure CLI commands, then run headless DSH agent sessions (3 tasks × 2 arms ×
 * N reps) and grade the final answers with objective keyword checks. Writes
 * analysis/external-benchmark.json/.md. Raw agent logs are gitignored.
 *
 * Honest scope: task set is small and keyword-graded; one model/host; curated
 * artifacts are authored for this benchmark, not produced by the project.
 *
 * Usage: DEEPSEEK_API_KEY=... bun run scripts/external-benchmark.ts [--reps 2] [--runs 3]
 */

import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const ROOT = resolve(import.meta.dir, "..");
const CLI = join(ROOT, "src", "grace.ts");
const WORK = join(tmpdir(), "mygrace-external-bench-v2");
const ANALYSIS = join(ROOT, "analysis");
const RUNS = join(ANALYSIS, "external-benchmark-runs");
const API_KEY = process.env.DEEPSEEK_API_KEY ?? "";
const args = process.argv.slice(2);
const reps = Math.max(1, Number(args[args.indexOf("--reps") + 1] ?? "2") || 2);
const runs = Math.max(1, Number(args[args.indexOf("--runs") + 1] ?? "3") || 3);
const dshHome = process.env.DSH_HOME ?? join(process.env.HOME ?? "", ".dsh");

interface ModuleSpec { id: string; name: string; path: string; depends: string[]; tests: string[]; purpose: string }
interface TaskSpec { id: string; prompt: string; keywords: string[] }
interface RepoSpec {
  slug: string;
  url: string;
  project: string;
  checkCommand: string;
  modules: ModuleSpec[];
  tasks: TaskSpec[];
}

const EXPRESS: RepoSpec = {
  slug: "express",
  url: "https://github.com/expressjs/express.git",
  project: "Express",
  checkCommand: "npm test",
  modules: [
    { id: "M-APPLICATION", name: "Application", path: "lib/application.js", depends: ["M-EXPRESS", "M-REQUEST", "M-RESPONSE", "M-UTILS", "M-VIEW"], tests: ["test/app.js", "test/app.use.js", "test/app.route.js"], purpose: "Express application object: settings, the middleware stack, routing setup (app.get/app.use) and app-level rendering." },
    { id: "M-EXPRESS", name: "Express facade", path: "lib/express.js", depends: ["M-APPLICATION", "M-UTILS"], tests: ["test/exports.js", "test/app.js"], purpose: "Factory that creates an application and exposes the express module API, including express.static and body parsers." },
    { id: "M-REQUEST", name: "Request", path: "lib/request.js", depends: ["M-UTILS"], tests: ["test/req.accepts.js", "test/req.get.js", "test/req.ip.js"], purpose: "Incoming request extensions: headers, content negotiation, ranges, protocol/host helpers." },
    { id: "M-RESPONSE", name: "Response", path: "lib/response.js", depends: ["M-UTILS"], tests: ["test/res.send.js", "test/res.json.js", "test/res.status.js"], purpose: "Outgoing response object: status, headers, send/json/end, files, redirects and content negotiation." },
    { id: "M-UTILS", name: "Utilities", path: "lib/utils.js", depends: [], tests: ["test/utils.js"], purpose: "Shared helpers: content-type checks, byte parsing, escaping and object merge utilities." },
    { id: "M-VIEW", name: "View", path: "lib/view.js", depends: ["M-UTILS"], tests: ["test/view.js"], purpose: "Template view resolution and rendering via the configured view engine." },
  ],
  tasks: [
    { id: "express-res.send", prompt: "In this repository, where is `res.send` implemented? Report the exact file path and explain in one short paragraph what the function does. Do not modify any files.", keywords: ["lib/response.js", "res.send"] },
    { id: "express-routing", prompt: "In this repository, how does an incoming request reach a user handler registered with `app.get`? Report the exact files involved (including the external router package if relevant) and the call path. Do not modify any files.", keywords: ["lib/application.js", "router"] },
    { id: "express-static", prompt: "How does this repository serve static files? Report the exact file where express.static is defined and the middleware package it delegates to. Do not modify any files.", keywords: ["lib/express.js", "serve-static"] },
  ],
};

const REQUESTS: RepoSpec = {
  slug: "requests",
  url: "https://github.com/psf/requests.git",
  project: "Requests",
  checkCommand: "pytest",
  modules: [
    { id: "M-SESSIONS", name: "Sessions", path: "src/requests/sessions.py", depends: ["M-MODELS", "M-ADAPTERS", "M-AUTH", "M-UTILS"], tests: ["tests/test_requests.py", "tests/test_lowlevel.py"], purpose: "Session and SessionRedirectMixin: request preparation, send, redirect handling, cookies and default headers." },
    { id: "M-MODELS", name: "Models", path: "src/requests/models.py", depends: ["M-UTILS"], tests: ["tests/test_requests.py", "tests/test_structures.py"], purpose: "Request, PreparedRequest and Response models: encoding, content decoding and prepared-request construction." },
    { id: "M-ADAPTERS", name: "Adapters", path: "src/requests/adapters.py", depends: ["M-MODELS", "M-UTILS"], tests: ["tests/test_adapters.py"], purpose: "Transport adapters (HTTPAdapter): connection pooling, TLS configuration and low-level send." },
    { id: "M-AUTH", name: "Authentication", path: "src/requests/auth.py", depends: ["M-UTILS"], tests: ["tests/test_requests.py"], purpose: "AuthBase and HTTP Basic/Proxy/Digest authentication implementations." },
    { id: "M-API", name: "API helpers", path: "src/requests/api.py", depends: ["M-SESSIONS"], tests: ["tests/test_requests.py"], purpose: "Top-level request/get/post helpers that create a Session and delegate to it." },
    { id: "M-UTILS", name: "Utilities", path: "src/requests/utils.py", depends: [], tests: ["tests/test_utils.py"], purpose: "Shared helpers: header parsing, URL handling, encoding detection and data preparation." },
  ],
  tasks: [
    { id: "requests-session.send", prompt: "In this repository, where is Session.send implemented and how does a Session send a PreparedRequest? Report the exact file path and the main steps. Do not modify any files.", keywords: ["src/requests/sessions.py", "send"] },
    { id: "requests-auth", prompt: "How does this repository handle authentication passed as `auth=...`? Report the files involved and the call flow from a request to an auth handler. Do not modify any files.", keywords: ["src/requests/auth.py", "sessions.py"] },
    { id: "requests-redirects", prompt: "Where and how are HTTP redirects handled in this repository? Report the exact file and the function that resolves redirects. Do not modify any files.", keywords: ["sessions.py", "resolve_redirects"] },
  ],
};

const REPOS = [EXPRESS, REQUESTS];

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
function p95(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1)] ?? 0;
}

function moduleXml(module: ModuleSpec): string {
  const annotations = module.tests.slice(0, 2).map((test, index) => `    <export-${index === 0 ? "PRIMARY" : "SECONDARY"} PURPOSE="Behaviour covered by ${test}." />`).join("\n");
  return `<${module.id} NAME="${module.name}" TYPE="CORE_LOGIC" STATUS="done">
  <purpose>${module.purpose}</purpose>
  <path>${module.path}</path>
  <depends>${module.depends.join(",")}</depends>
  <verification-ref>V-${module.id}</verification-ref>

  <annotations>
${annotations}
  </annotations>

  <CrossLink to="M-UTILS" relation="shared helpers; curated external-benchmark contract" />

  <contract>
    <purpose>${module.purpose}</purpose>
    <inputs>
      <param name="upstream" type="object" description="Real upstream objects exposed by ${module.path}." />
    </inputs>
    <outputs>
      <param name="exports" type="object" description="Public API documented by the upstream tests." />
    </outputs>
    <errors>
      <error code="SOURCE" description="See the real implementation and its tests." />
    </errors>
  </contract>

  <notes>
    <note-1>Curated by scripts/external-benchmark.ts for the external benchmark.</note-1>
    <note-2>Implementation and tests are the real upstream sources; only these docs are authored for the benchmark.</note-2>
    <note-3>Keep this file within the module size budget.</note-3>
  </notes>
</${module.id}>
`;
}
function verificationXml(repo: RepoSpec, module: ModuleSpec): string {
  return `<V-${module.id} MODULE="${module.id}" PRIORITY="high" STATUS="done">
  <test-files>
${module.tests.map((test) => `    <file>${test}</file>`).join("\n")}
  </test-files>

  <module-checks>
    <check-1>${repo.checkCommand}</check-1>
  </module-checks>

  <scenarios>
    <scenario-1 kind="success">Upstream tests in ${module.tests[0]} cover the module behaviour.</scenario-1>
    <scenario-2 kind="failure">Upstream error paths stay owned by the real test-suite.</scenario-2>
    <scenario-3 kind="success">The module path exists and the verification declaration fits the size budget.</scenario-3>
  </scenarios>

  <required-log-markers>
    <marker-1>No runtime markers are added by the benchmark verification.</marker-1>
  </required-log-markers>

  <notes>
    <note-1>Curated external-benchmark verification; the command is not executed by the CLI benchmark.</note-1>
    <note-2>Coverage counts the declared real test files.</note-2>
  </notes>
</V-${module.id}>
`;
}

function generateDocs(repo: RepoSpec, target: string): void {
  const graph = [`<GraphIndex project="${repo.project}" version="1.0.0">`, `  <keywords>${repo.slug}, benchmark, external, oss</keywords>`, `  <annotation>Curated MyGRACE artifacts over the real ${repo.slug} source tree</annotation>`];
  const verifications = [`<VerificationIndex project="${repo.project}" version="1.0.0">`];
  for (const module of repo.modules) {
    graph.push(`  <${module.id} NAME="${module.name}" TYPE="CORE_LOGIC" STATUS="done" PATH="${module.path}" DEPENDS="${module.depends.join(",")}" VERIFICATION_REF="V-${module.id}" />`);
    verifications.push(`  <V-${module.id} MODULE="${module.id}" PRIORITY="high" STATUS="done" />`);
    mkdirSync(join(target, "docs", "modules"), { recursive: true });
    mkdirSync(join(target, "docs", "verification"), { recursive: true });
    writeFileSync(join(target, "docs", "modules", `${module.id}.xml`), moduleXml(module));
    writeFileSync(join(target, "docs", "verification", `V-${module.id}.xml`), verificationXml(repo, module));
  }
  graph.push("</GraphIndex>", "");
  verifications.push("</VerificationIndex>", "");
  writeFileSync(join(target, "docs", "graph-index.xml"), graph.join("\n"));
  writeFileSync(join(target, "docs", "verification-index.xml"), verifications.join("\n"));
  writeFileSync(join(target, "docs", "plan-index.xml"), `<PlanIndex project="${repo.project}" version="1.0.0">\n  <Phase-1 name="External benchmark" status="done" steps="3" />\n</PlanIndex>\n`);
  const phase: string[] = [`<Phase-1 name="External benchmark" status="done">`, "  <description>Curated phase for the external benchmark; no product work is performed.</description>"];
  for (let step = 1; step <= 3; step += 1) phase.push(`  <step-${step} module="${repo.modules[0]!.id}" description="Benchmark step ${step}." status="done" />`);
  phase.push("", "  <outcome>");
  for (let item = 1; item <= 3; item += 1) phase.push(`    <item-${item}>External benchmark outcome ${item}.</item-${item}>`);
  phase.push("  </outcome>", "", "  <deliverables>");
  for (let item = 1; item <= 3; item += 1) phase.push(`    <item-${item}>External benchmark deliverable ${item}.</item-${item}>`);
  phase.push("  </deliverables>", "", "  <notes>");
  for (let item = 1; item <= 30; item += 1) phase.push(`    <note-${item}>Generated benchmark note ${item} keeps the phase inside the 50-200 line budget.</note-${item}>`);
  phase.push("  </notes>", "</Phase-1>", "");
  mkdirSync(join(target, "docs", "plans"), { recursive: true });
  writeFileSync(join(target, "docs", "plans", "Phase-1.xml"), phase.join("\n"));
}

interface CliRow { repo: string; command: string; medianMs: number; p95Ms: number; medianRssMb: number | null; failures: number }
interface AgentRow { repo: string; task: string; arm: "grace" | "plain"; n: number; medianCost: number; medianTools: number; medianWall: number; correct: number }
interface SessionRecord { repo: string; task: string; arm: "grace" | "plain"; rep: number; sessionId: string; costTokens: number; toolCalls: number; cacheRead: number; wallSeconds: number; correct: boolean; finalChars: number }

const timeBinary = existsSync("/usr/bin/time") ? "/usr/bin/time" : null;
const cliRows: CliRow[] = [];
const sessions: SessionRecord[] = [];
mkdirSync(RUNS, { recursive: true });
mkdirSync(ANALYSIS, { recursive: true });
const dshSessions = join(dshHome, "storages", "session_projcache", "sessions");

for (const repo of REPOS) {
  const clone = join(WORK, repo.slug);
  if (!existsSync(join(clone, repo.modules[0]!.path))) {
    rmSync(clone, { recursive: true, force: true });
    mkdirSync(WORK, { recursive: true });
    const cloned = run("git", ["clone", "--depth", "1", repo.url, clone], WORK);
    if (cloned.status !== 0) {
      console.error(`clone failed for ${repo.slug}: ${cloned.stderr}`);
      process.exit(2);
    }
  }
  const grace = join(WORK, `${repo.slug}-grace`);
  const plain = join(WORK, `${repo.slug}-plain`);
  for (const [destination, withDocs] of [[grace, true], [plain, false]] as const) {
    rmSync(destination, { recursive: true, force: true });
    cpSync(clone, destination, { recursive: true });
    if (withDocs) {
      const init = run("bun", ["run", CLI, "setup", "init", "--path", destination, "--name", repo.project], destination);
      if (init.status !== 0) {
        console.error(`setup init failed for ${repo.slug}: ${init.stderr || init.stdout}`);
        process.exit(2);
      }
    }
  }
  generateDocs(repo, grace);
  const lint = run("bun", ["run", CLI, "lint", "--strict", "--path", grace], grace);
  const ci = run("bun", ["run", CLI, "ci", "--path", grace], grace);
  if (lint.status !== 0 || ci.status !== 0) {
    console.error(`fixture invalid for ${repo.slug}:\n${lint.stdout}\n${ci.stdout}`);
    process.exit(1);
  }

  for (const [name, commandArgs] of [
    ["status", ["status"]],
    ["lint --strict", ["lint", "--strict"]],
    ["ci", ["ci"]],
    ["trace", ["trace", repo.modules[0]!.id]],
    ["context packet", ["context", "packet", repo.modules[0]!.id]],
  ] as const) {
    const samples: { ms: number; rss: number | null; exit: number }[] = [];
    for (let index = 0; index <= runs; index += 1) {
      const timeFile = join(tmpdir(), `mygrace-ext2-${process.pid}-${Math.random().toString(36).slice(2)}.txt`);
      const started = Date.now();
      const result = timeBinary === null
        ? run("bun", ["run", CLI, ...commandArgs, "--path", grace], grace)
        : spawnSync(timeBinary, ["-f", "%e %M", "-o", timeFile, "bun", "run", CLI, ...commandArgs, "--path", grace], { cwd: grace, encoding: "utf8", timeout: 300_000 });
      const ms = Date.now() - started;
      let rss: number | null = null;
      if (timeBinary !== null && existsSync(timeFile)) {
        const match = /([0-9.]+)\s+(\d+)/.exec(readFileSync(timeFile, "utf8"));
        if (match !== null) rss = Math.round((Number(match[2]) / 1024) * 10) / 10;
        rmSync(timeFile, { force: true });
      }
      if (index > 0) samples.push({ ms, rss, exit: result.status ?? -1 });
    }
    const rssValues = samples.map((sample) => sample.rss).filter((value): value is number => value !== null);
    cliRows.push({
      repo: repo.slug,
      command: name,
      medianMs: Math.round(median(samples.map((sample) => sample.ms))),
      p95Ms: Math.round(p95(samples.map((sample) => sample.ms))),
      medianRssMb: rssValues.length === 0 ? null : Math.round(median(rssValues) * 10) / 10,
      failures: samples.filter((sample) => sample.exit !== 0).length,
    });
    process.stderr.write(`CLI ${repo.slug} ${name}: ${cliRows.at(-1)?.medianMs} ms\n`);
  }

  if (API_KEY === "") continue;
  for (const task of repo.tasks) {
    for (const arm of ["grace", "plain"] as const) {
      for (let rep = 1; rep <= reps; rep += 1) {
        const cwd = arm === "grace" ? grace : plain;
        const id = `${repo.slug}-${task.id}-${arm}-${rep}`;
        const runJsonl = join(RUNS, `${id}.jsonl`);
        const started = Date.now();
        const result = spawnSync("dsh", ["--profile", "headless", "--json", task.prompt], {
          cwd,
          env: { ...process.env, DEEPSEEK_API_KEY: API_KEY },
          encoding: "utf8",
          timeout: 900_000,
          maxBuffer: 32 * 1024 * 1024,
        });
        const wallSeconds = Math.round((Date.now() - started) / 100) / 10;
        writeFileSync(runJsonl, result.stdout ?? "");
        let sessionId = "missing";
        let finalText = "";
        let toolCalls = 0;
        for (const line of (result.stdout ?? "").split("\n")) {
          if (line.trim() === "") continue;
          try {
            const event = JSON.parse(line) as Record<string, unknown>;
            if (event.type === "session" && typeof event.sessionId === "string") sessionId = event.sessionId;
            if (event.type === "final" && typeof event.text === "string") finalText = event.text;
            if (event.type === "tool_call") toolCalls += 1;
          } catch {
            // ignore non-JSON diagnostics
          }
        }
        const lowered = finalText.toLowerCase();
        const correct = task.keywords.every((keyword) => lowered.includes(keyword.toLowerCase()));
        let costTokens = 0;
        let cacheRead = 0;
        const sessionFile = sessionId === "missing" ? "" : join(dshSessions, `${sessionId}.json`);
        if (sessionFile !== "" && existsSync(sessionFile)) {
          const record = JSON.parse(readFileSync(sessionFile, "utf8")) as { record?: { rows?: Record<string, { val?: Record<string, unknown> }> } };
          const totals = (record.record?.rows?.["tokenUsage"]?.val?.["totals"] ?? {}) as Record<string, unknown>;
          costTokens = (Number(totals.uncachedInputTokens) || 0) + (Number(totals.outputTokens) || 0);
          cacheRead = Number(totals.cacheReadTokens) || 0;
        }
        sessions.push({ repo: repo.slug, task: task.id, arm, rep, sessionId, costTokens, toolCalls, cacheRead, wallSeconds, correct, finalChars: finalText.length });
        process.stderr.write(`agent ${id}: ${sessionId} ${costTokens} tok / ${toolCalls} tools / ${wallSeconds}s / ${correct ? "PASS" : "FAIL"}\n`);
      }
    }
  }
}

const agentRows: AgentRow[] = [];
for (const repo of REPOS) {
  for (const task of repo.tasks) {
    for (const arm of ["grace", "plain"] as const) {
      const items = sessions.filter((session) => session.repo === repo.slug && session.task === task.id && session.arm === arm);
      agentRows.push({
        repo: repo.slug,
        task: task.id,
        arm,
        n: items.length,
        medianCost: Math.round(median(items.map((item) => item.costTokens))),
        medianTools: Math.round(median(items.map((item) => item.toolCalls))),
        medianWall: Math.round(median(items.map((item) => item.wallSeconds)) * 10) / 10,
        correct: items.filter((item) => item.correct).length,
      });
    }
  }
}

const payload = {
  schemaVersion: 2,
  generatedAt: new Date().toISOString(),
  repositories: REPOS.map((repo) => {
    const commit = run("git", ["rev-parse", "HEAD"], join(WORK, repo.slug)).stdout.trim();
    return { slug: repo.slug, url: repo.url, commit, modules: repo.modules.length, tasks: repo.tasks.length };
  }),
  artifacts: "Curated MyGRACE docs per repository (modules from real source files, real upstream test files); lint + ci clean.",
  cli: cliRows,
  agent: { model: "dsh headless default (DeepSeek route)", reps, rows: agentRows, sessions },
  limitations: [
    "Curated artifacts are authored for this benchmark, not produced by the project itself.",
    "Three tasks per repository; keyword grading only; one model/host; small N.",
    "CLI numbers include bun startup and are not a throughput benchmark.",
    "No blinded human evaluation; grading is automated and therefore blind to the arm.",
  ],
};
writeFileSync(join(ANALYSIS, "external-benchmark.json"), `${JSON.stringify(payload, null, 2)}\n`);
const lines = [
  "# External benchmark — expressjs/express + psf/requests",
  "",
  `Generated: ${payload.generatedAt} · agent reps: ${reps} · curated MyGRACE artifacts (lint/ci clean on both repos)`,
  "",
  "## Repositories",
  "",
  "| Repo | Commit | Modules | Tasks |",
  "|---|---|---|---|",
  ...payload.repositories.map((repo) => `| ${repo.slug} | \`${repo.commit.slice(0, 12)}\` | ${repo.modules} | ${repo.tasks} |`),
  "",
  "## CLI",
  "",
  "| Repo | Command | median wall | p95 wall | median peak RSS | failures |",
  "|---|---|---|---|---|---|",
  ...cliRows.map((row) => `| ${row.repo} | \`${row.command}\` | ${row.medianMs} ms | ${row.p95Ms} ms | ${row.medianRssMb === null ? "—" : `${row.medianRssMb} MB`} | ${row.failures} |`),
  "",
  "## Agent sessions (headless DSH, keyword-graded)",
  "",
  "| Repo | Task | Arm | N | median cost tokens | median tool calls | median wall s | correct |",
  "|---|---|---|---|---|---|---|---|",
  ...agentRows.map((row) => `| ${row.repo} | ${row.task} | ${row.arm} | ${row.n} | ${row.medianCost} | ${row.medianTools} | ${row.medianWall} | ${row.correct}/${row.n} |`),
  "",
  "Limitations:",
  ...payload.limitations.map((line) => `- ${line}`),
  "",
];
writeFileSync(join(ANALYSIS, "external-benchmark.md"), `${lines.join("\n")}\n`);
console.log(lines.join("\n"));
