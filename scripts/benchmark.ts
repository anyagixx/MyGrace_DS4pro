#!/usr/bin/env bun
/**
 * MyGRACE benchmark — core command latency and peak RSS on real and synthetic projects.
 *
 * Targets: this repository (29 modules), examples/demo-store (3 modules) and a
 * generated, lint-clean synthetic project (70 modules). Measures `status`,
 * `lint --strict` and `ci` with `/usr/bin/time` (GNU time) when available; falls
 * back to wall time only. Writes analysis/benchmark.json + analysis/benchmark.md.
 *
 * Honest scope: this is CLI/index performance, not agent-task success. There is
 * no external OSS repository with MyGRACE artifacts in this benchmark yet.
 *
 * Usage:
 *   bun run scripts/benchmark.ts [--runs 5] [--json]
 */

import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const ROOT = resolve(import.meta.dir, "..");
const cli = join(ROOT, "src", "grace.ts");
const timeBinary = existsSync("/usr/bin/time") ? "/usr/bin/time" : null;
const args = process.argv.slice(2);
const runs = Math.max(1, Number(args[args.indexOf("--runs") + 1] ?? "5") || 5);
const asJson = args.includes("--json");
const analysisDir = join(ROOT, "analysis");

interface BenchmarkRow {
  target: string;
  command: string;
  runs: number;
  medianWallMs: number;
  p95WallMs: number;
  medianRssMb: number | null;
  failures: number;
}

interface Sample {
  wallMs: number;
  rssMb: number | null;
  exit: number;
}

const median = (values: number[]): number => {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2 : sorted[middle] ?? 0;
};

/** Nearest-rank p95 for small samples. */
const percentile95 = (values: number[]): number => {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1)] ?? 0;
};

function runOnce(target: string, commandArgs: string[]): Sample {
  const timeFile = join(tmpdir(), `mygrace-bench-${process.pid}-${Math.random().toString(36).slice(2)}.txt`);
  const started = Date.now();
  const result = timeBinary === null
    ? spawnSync("bun", ["run", cli, ...commandArgs, "--path", target], { cwd: ROOT, encoding: "utf8", timeout: 300_000 })
    : spawnSync(timeBinary, ["-f", "%e %M", "-o", timeFile, "bun", "run", cli, ...commandArgs, "--path", target], {
        cwd: ROOT,
        encoding: "utf8",
        timeout: 300_000,
      });
  const wallMs = Date.now() - started;
  let rssMb: number | null = null;
  if (timeBinary !== null && existsSync(timeFile)) {
    const text = (() => {
      try {
        return timeBinary === null ? "" : require("node:fs").readFileSync(timeFile, "utf8");
      } catch {
        return "";
      }
    })();
    const match = /([0-9.]+)\s+(\d+)/.exec(text);
    if (match !== null) rssMb = Math.round((Number(match[2]) / 1024) * 10) / 10;
    rmSync(timeFile, { force: true });
  }
  return { wallMs, rssMb, exit: result.status ?? -1 };
}

function benchmark(targetName: string, target: string, commandName: string, commandArgs: string[]): BenchmarkRow {
  const samples: Sample[] = [];
  for (let index = 0; index <= runs; index += 1) {
    const sample = runOnce(target, commandArgs);
    if (index === 0) continue; // warm-up (module cache, OS page cache)
    samples.push(sample);
  }
  const walls = samples.map((sample) => sample.wallMs);
  const rss = samples.map((sample) => sample.rssMb).filter((value): value is number => value !== null);
  return {
    target: targetName,
    command: commandName,
    runs,
    medianWallMs: Math.round(median(walls)),
    p95WallMs: Math.round(percentile95(walls)),
    medianRssMb: rss.length === 0 ? null : Math.round(median(rss) * 10) / 10,
    failures: samples.filter((sample) => sample.exit !== 0).length,
  };
}

/** Generate a lint-clean 70-module project under a temp directory. */
function generateSyntheticProject(): string {
  const root = mkdtempSync(join(tmpdir(), "mygrace-bench-project-"));
  const write = (relative: string, content: string): void => {
    const absolute = join(root, relative);
    mkdirSync(join(absolute, ".."), { recursive: true });
    writeFileSync(absolute, content);
  };
  const moduleCount = 70;
  const graph: string[] = ['<GraphIndex project="Bench70" version="1.0.0">', "  <keywords>benchmark, synthetic</keywords>", "  <annotation>Generated 70-module fixture for MyGRACE benchmarks</annotation>"];
  const verificationIndex: string[] = ['<VerificationIndex project="Bench70" version="1.0.0">'];
  for (let index = 1; index <= moduleCount; index += 1) {
    const id = `M-${String(index).padStart(3, "0")}`;
    const previous = index === 1 ? "" : `M-${String(index - 1).padStart(3, "0")}`;
    graph.push(`  <${id} NAME="Module ${index}" TYPE="CORE_LOGIC" STATUS="done" PATH="src/m${String(index).padStart(3, "0")}.ts" DEPENDS="${previous}" VERIFICATION_REF="V-${id}" />`);
    verificationIndex.push(`  <V-${id} MODULE="${id}" PRIORITY="high" STATUS="done" />`);
    write(`docs/modules/${id}.xml`, `<${id} NAME="Module ${index}" TYPE="CORE_LOGIC" STATUS="done">
  <purpose>Synthetic benchmark module ${index}; no behaviour.</purpose>
  <path>src/m${String(index).padStart(3, "0")}.ts</path>
  <depends>${previous}</depends>
  <verification-ref>V-${id}</verification-ref>

  <annotations>
    <export-VALUE PURPOSE="Synthetic exported constant." />
  </annotations>

  <CrossLink to="M-COMMON" relation="synthetic benchmark dependency placeholder" />

  <contract>
    <purpose>Provide one deterministic constant so file-level verification has a target.</purpose>
    <inputs>
      <param name="none" type="none" description="No inputs." />
    </inputs>
    <outputs>
      <param name="value" type="number" description="Always 1." />
    </outputs>
    <errors>
      <error code="NONE" description="No error paths." />
    </errors>
  </contract>

  <notes>
    <note-1>Generated by scripts/benchmark.ts; not part of the product.</note-1>
    <note-2>Keep this file within the module size budget.</note-2>
  </notes>
</${id}>
`);
    write(`docs/verification/V-${id}.xml`, `<V-${id} MODULE="${id}" PRIORITY="high" STATUS="done">
  <test-files>
    <file>src/m${String(index).padStart(3, "0")}.test.ts</file>
  </test-files>

  <module-checks>
    <check-1>true</check-1>
  </module-checks>

  <scenarios>
    <scenario-1 kind="success">Synthetic module exports a constant.</scenario-1>
    <scenario-2 kind="success">Synthetic test-file entry exists.</scenario-2>
    <scenario-3 kind="success">Synthetic verification stays inside the size budget.</scenario-3>
  </scenarios>

  <required-log-markers>
    <marker-1>No runtime markers for the synthetic fixture.</marker-1>
  </required-log-markers>

  <notes>
    <note-1>Generated benchmark fixture; commands are not executed in this benchmark.</note-1>
    <note-2>Coverage counts one module with one declared test file.</note-2>
  </notes>
</V-${id}>
`);
    const source = `// START_MODULE_CONTRACT
//   PURPOSE: Synthetic benchmark module ${index}.
//   SCOPE: One exported constant.
//   DEPENDS: none
//   LINKS: none
// END_MODULE_CONTRACT

// START_MODULE_MAP
//   VALUE — synthetic constant
// END_MODULE_MAP

// START_CHANGE_SUMMARY
//   v1.0.0 — generated benchmark fixture.
// END_CHANGE_SUMMARY

export const VALUE = 1;

// START_BLOCK_EXPORT
// END_BLOCK_EXPORT
`;
    write(`src/m${String(index).padStart(3, "0")}.ts`, source);
    write(`src/m${String(index).padStart(3, "0")}.test.ts`, "// synthetic benchmark test file\n");
  }
  graph.push("</GraphIndex>", "");
  verificationIndex.push("</VerificationIndex>", "");
  write("docs/graph-index.xml", graph.join("\n"));
  write("docs/verification-index.xml", verificationIndex.join("\n"));
  write("docs/plan-index.xml", '<PlanIndex project="Bench70" version="1.0.0">\n  <Phase-1 name="Benchmark" status="done" steps="3" />\n</PlanIndex>\n');
  const phaseLines: string[] = ['<Phase-1 name="Benchmark" status="done">', "  <description>Generated phase for the 70-module benchmark fixture.</description>"];
  for (let step = 1; step <= 3; step += 1) phaseLines.push(`  <step-${step} module="M-${String(step).padStart(3, "0")}" description="Synthetic benchmark step ${step}." status="done" />`);
  phaseLines.push("", "  <outcome>");
  for (let item = 1; item <= 3; item += 1) phaseLines.push(`    <item-${item}>Synthetic benchmark outcome ${item}.</item-${item}>`);
  phaseLines.push("  </outcome>", "", "  <deliverables>");
  for (let item = 1; item <= 3; item += 1) phaseLines.push(`    <item-${item}>Synthetic benchmark deliverable ${item}.</item-${item}>`);
  phaseLines.push("  </deliverables>", "", "  <notes>");
  for (let item = 1; item <= 30; item += 1) phaseLines.push(`    <note-${item}>Generated benchmark note ${item} keeps the phase inside the 50-200 line budget.</note-${item}>`);
  phaseLines.push("  </notes>", "</Phase-1>", "");
  write("docs/plans/Phase-1.xml", phaseLines.join("\n"));
  return root;
}

const synthetic = generateSyntheticProject();
try {
  const rows: BenchmarkRow[] = [];
  const targets: Array<{ name: string; path: string; commands: Array<[string, string[]]> }> = [
    {
      name: "repo (29 modules)",
      path: ROOT,
      commands: [
        ["status", ["status"]],
        ["lint --strict", ["lint", "--strict"]],
        ["ci", ["ci"]],
      ],
    },
    {
      name: "demo-store (3 modules)",
      path: join(ROOT, "examples", "demo-store"),
      commands: [
        ["status", ["status"]],
        ["lint --strict", ["lint", "--strict"]],
        ["ci", ["ci"]],
      ],
    },
    {
      name: "synthetic (70 modules)",
      path: synthetic,
      commands: [
        ["status", ["status"]],
        ["lint --strict", ["lint", "--strict"]],
        ["ci", ["ci"]],
      ],
    },
  ];
  for (const target of targets) {
    for (const [name, commandArgs] of target.commands) {
      process.stderr.write(`benchmark ${target.name} :: ${name} … `);
      const row = benchmark(target.name, target.path, name, commandArgs);
      process.stderr.write(`${row.medianWallMs} ms${row.medianRssMb === null ? "" : ` / ${row.medianRssMb} MB`}\n`);
      rows.push(row);
    }
  }

  const payload = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    command: `bun run scripts/benchmark.ts --runs ${runs}`,
    runs,
    timeBinary: timeBinary ?? "fallback-wall-only",
    limitations: [
      "CLI/index performance only; not agent-task success or token usage.",
      "No external OSS repository with MyGRACE artifacts yet; targets are this repo, demo-store and a generated valid 70-module project.",
      "GNU time reports the child's peak RSS; wall time includes bun startup.",
    ],
    rows,
  };
  mkdirSync(analysisDir, { recursive: true });
  writeFileSync(join(analysisDir, "benchmark.json"), `${JSON.stringify(payload, null, 2)}\n`);
  const lines = [
    "# MyGRACE benchmarks (core commands)",
    "",
    `Generated: ${payload.generatedAt} · runs: ${runs} (one warm-up discarded) · measure: ${payload.timeBinary}`,
    "",
    "| Target | Command | median wall | p95 wall | median peak RSS | failures |",
    "|---|---|---|---|---|---|",
    ...rows.map(
      (row) =>
        `| ${row.target} | \`${row.command}\` | ${row.medianWallMs} ms | ${row.p95WallMs} ms | ${row.medianRssMb === null ? "—" : `${row.medianRssMb} MB`} | ${row.failures} |`
    ),
    "",
    "Limitations:",
    ...payload.limitations.map((line) => `- ${line}`),
    "",
  ];
  writeFileSync(join(analysisDir, "benchmark.md"), `${lines.join("\n")}\n`);
  if (asJson) console.log(JSON.stringify(payload, null, 2));
  else console.log(lines.join("\n"));
} finally {
  rmSync(synthetic, { recursive: true, force: true });
}
