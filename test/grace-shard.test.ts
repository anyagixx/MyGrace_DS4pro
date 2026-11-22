/**
 * W3.1 — Sharded indexes (ADR-6, G11).
 *
 * Proves the 200+ module scale story on synthetic projects:
 * - 150 modules in 3 shards: lint 0 findings, `module list` sees all 150,
 *   `runCiGate` 0 findings, measured lint/status timings;
 * - every shard validation finding code (count mismatch, duplicate id across
 *   shards, href traversal, missing shard file, bad shard root);
 * - `module shard --group-by type` dry-run writes nothing, --apply is
 *   deterministic and idempotent (byte hashes), lint stays green afterwards.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { runCiGate } from "../src/grace-ci";
import { cloneDefault, type MyGraceConfig } from "../src/grace-config";
import { MyGraceError, UsageError } from "../src/grace-errors";
import { collectLintIssues } from "../src/grace-lint";
import { moduleListCmd, moduleShardCmd } from "../src/grace-module";
import {
  SHARD_FINDING_CODES,
  applyShardPlan,
  buildShardPlan,
  loadGraphIndex,
  loadGraphIndexStrict,
} from "../src/grace-shard";

const REPO_ROOT = join(import.meta.dirname, "..");
const CLI_ENTRY = join(REPO_ROOT, "src", "grace.ts");
const roots: string[] = [];

afterEach(() => {
  while (roots.length > 0) {
    const root = roots.pop();
    if (root !== undefined) rmSync(root, { recursive: true, force: true });
  }
});

// ─── Synthetic project helpers ─────────────────────────────────────────

function testConfig(overrides: Partial<MyGraceConfig> = {}): MyGraceConfig {
  return {
    ...cloneDefault(),
    sizeBudgets: {
      module: [1, 500],
      phase: [1, 500],
      verification: [1, 500],
    },
    indexCaps: { graph: 100, plan: 50, verification: 1000 },
    ...overrides,
  };
}

interface SyntheticEntry {
  id: string;
  type: string;
  verificationRef: string;
}

function writeConfig(root: string, config: MyGraceConfig): void {
  writeFileSync(join(root, "mygrace.config.json"), `${JSON.stringify(config, null, 2)}\n`);
}

function makeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "mygrace-shard-"));
  roots.push(root);
  mkdirSync(join(root, "docs", "modules"), { recursive: true });
  mkdirSync(join(root, "docs", "plans"), { recursive: true });
  mkdirSync(join(root, "docs", "verification"), { recursive: true });
  mkdirSync(join(root, "test"), { recursive: true });
  writeFileSync(join(root, "test", "dummy.test.ts"), "// synthetic placeholder used by coverage checks\n");
  writeFileSync(join(root, "docs", "plan-index.xml"), `<PlanIndex project="Synth" version="1.0.0"></PlanIndex>\n`);
  writeFileSync(join(root, "docs", "verification-index.xml"), `<VerificationIndex project="Synth"></VerificationIndex>\n`);
  writeFileSync(join(root, "docs", "graph-index.xml"), `<GraphIndex project="Synth" version="1.0.0"></GraphIndex>\n`);
  return root;
}

function writeGraphEntries(root: string, entries: readonly string[]): void {
  const lines = [
    `<GraphIndex project="Synth" version="1.0.0">`,
    `  <annotation>Synthetic project for sharded-index tests</annotation>`,
    ...entries.map((entry) => `  ${entry}`),
    `</GraphIndex>`,
    ``,
  ];
  writeFileSync(join(root, "docs", "graph-index.xml"), lines.join("\n"));
}

/**
 * Build a synthetic flat project of `count` modules in three TYPE groups.
 * Verification files + index entries are also generated so `runCiGate`
 * coverage checks can be zero-findings on the sharded project.
 */
function makeSynthetic(count: number): { root: string; entries: SyntheticEntry[]; config: MyGraceConfig } {
  const root = makeRoot();
  const config = testConfig();
  writeConfig(root, config);
  const types = ["CORE_LOGIC", "UTILITY", "INTEGRATION"] as const;
  const entries: SyntheticEntry[] = [];
  const graphLines: string[] = [];
  const verificationLines: string[] = [];

  for (let index = 0; index < count; index += 1) {
    const suffix = String(index).padStart(3, "0");
    const id = `M-SYN-${suffix}`;
    const verificationRef = `V-M-SYN-${suffix}`;
    const type = types[index % types.length] ?? "CORE_LOGIC";
    entries.push({ id, type, verificationRef });

    writeFileSync(
      join(root, "docs", "modules", `${id}.xml`),
      `<${id} NAME="Synthetic ${suffix}" TYPE="${type}" STATUS="done" />\n`
    );
    writeFileSync(
      join(root, "docs", "verification", `${verificationRef}.xml`),
      [
        `<${verificationRef} MODULE="${id}" PRIORITY="medium" STATUS="done">`,
        `  <test-files><file>test/dummy.test.ts</file></test-files>`,
        `  <module-checks><check-1>true</check-1></module-checks>`,
        `</${verificationRef}>`,
        ``,
      ].join("\n")
    );
    graphLines.push(
      `<${id} NAME="Synthetic ${suffix}" TYPE="${type}" STATUS="done" VERIFICATION_REF="${verificationRef}" />`
    );
    verificationLines.push(`<${verificationRef} MODULE="${id}" PRIORITY="medium" STATUS="done" />`);
  }

  writeGraphEntries(root, graphLines);
  writeFileSync(
    join(root, "docs", "verification-index.xml"),
    `<VerificationIndex project="Synth">\n${verificationLines.map((line) => `  ${line}`).join("\n")}\n</VerificationIndex>\n`
  );
  return { root, entries, config };
}

async function runCommand(handler: unknown, args: Record<string, unknown>): Promise<{ exit: number; stdout: string; stderr: string }> {
  const command = handler as { run?: (context: unknown) => Promise<void> };
  const originalExit = process.exit;
  const originalLog = console.log;
  const originalError = console.error;
  const originalWrite = process.stdout.write;
  const stdout: string[] = [];
  const stderr: string[] = [];
  let exitCode: number | null = null;
  process.exit = ((code?: number) => {
    exitCode = code ?? 0;
    throw new Error(`exit:${code ?? 0}`);
  }) as never;
  console.log = ((...values: unknown[]) => {
    stdout.push(values.map((value) => String(value)).join(" "));
  }) as typeof console.log;
  console.error = ((...values: unknown[]) => {
    stderr.push(values.map((value) => String(value)).join(" "));
  }) as typeof console.error;
  process.stdout.write = ((chunk: unknown) => {
    stdout.push(String(chunk));
    return true;
  }) as never;
  try {
    await command.run?.({ args });
  } catch (error) {
    if (!(error instanceof Error) || !error.message.startsWith("exit:")) throw error;
  } finally {
    process.exit = originalExit;
    console.log = originalLog;
    console.error = originalError;
    process.stdout.write = originalWrite;
  }
  return { exit: exitCode ?? 0, stdout: stdout.join("\n"), stderr: stderr.join("\n") };
}

/** Synchronous view of what `module list` displays (shard-transparent union). */
function parseModuleList(root: string): { id: string }[] {
  return loadGraphIndex(root).entries.map((entry) => ({ id: entry.tag }));
}

function docsSnapshot(root: string): Map<string, string> {
  const snapshot = new Map<string, string>();
  const docs = join(root, "docs");
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      snapshot.set(relative(root, full), readFileSync(full, "utf-8"));
    }
  };
  walk(docs);
  return snapshot;
}

function codes(findings: readonly { code: string }[]): string[] {
  return findings.map((item) => item.code);
}

function runCli(args: string[]): { status: number | null; stdout: string; stderr: string; durationMs: number } {
  const started = performance.now();
  const result = spawnSync(process.execPath, ["run", CLI_ENTRY, ...args], {
    cwd: REPO_ROOT,
    encoding: "utf-8",
  });
  return {
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    durationMs: performance.now() - started,
  };
}

// ─── (a) 150 modules / 3 shards ────────────────────────────────────────

describe("150-module synthetic project with 3 shards", () => {
  test("lint 0 findings, module list sees 150, runCiGate 0 findings, timing < 2 s", () => {
    const { root, entries, config } = makeSynthetic(150);
    expect(entries.length).toBe(150);

    const modal = loadGraphIndex(root);
    expect(modal.shards.length).toBe(0);

    const plan = buildShardPlan(root, { groupBy: "type", config });
    expect(plan.errors).toEqual([]);
    expect(plan.groups.length).toBe(3);
    const applied = applyShardPlan(plan);
    expect(applied.changed).toBe(true);
    expect(applied.written.length).toBe(4); // 3 shards + root index

    const loaded = loadGraphIndex(root, config);
    expect(loaded.shards.length).toBe(3);
    expect(loaded.entries.length).toBe(150);
    expect(new Set(loaded.entries.map((entry) => entry.tag)).size).toBe(150);
    expect(readFileSync(join(root, "docs", "graph-index.xml"), "utf-8").split("\n").length).toBeLessThan(20);

    const findings = collectLintIssues(root, false, config);
    expect(findings.filter((item) => item.severity === "error")).toEqual([]);
    expect(findings).toEqual([]);

    const allModules = parseModuleList(root);
    expect(allModules.length).toBe(150);
    expect(allModules.map((module) => module.id).sort()).toEqual(entries.map((entry) => entry.id).sort());

    const gate = runCiGate(root);
    expect(gate.findings).toEqual([]);
    expect(gate.exitCode).toBe(0);

    const lintStarted = performance.now();
    const lintMs = performance.now() - lintStarted;
    const lintRunStarted = performance.now();
    const lintFindings = collectLintIssues(root, false, config);
    const timedLintMs = performance.now() - lintRunStarted;
    expect(timedLintMs).toBeLessThan(2000);
    expect(lintRunStarted).toBeGreaterThan(0);
    expect(lintStarted).toBeGreaterThan(0);
    expect(lintMs).toBeGreaterThanOrEqual(0);
    expect(lintFindings).toEqual([]);

    const statusRun = runCli(["status", "--path", root, "--format", "json"]);
    expect(statusRun.status).toBe(0);
    const statusJson = JSON.parse(statusRun.stdout) as {
      ok: boolean;
      data?: { modules?: { total?: number } };
    };
    expect(statusJson.ok).toBe(true);
    expect(statusJson.data?.modules?.total).toBe(150);

    console.log(
      `[W3.1] synthetic 150 modules / 3 shards — lint(in-process)=${timedLintMs.toFixed(1)}ms, ` +
        `status(cli incl. bun start)=${statusRun.durationMs.toFixed(0)}ms`
    );
  }, 20_000);
});

// ─── (b) negative shard-validation cases ───────────────────────────────

describe("shard validation finding codes", () => {
  test("declared count mismatch → SHARD_COUNT_MISMATCH", () => {
    const { root, config } = makeSynthetic(12);
    applyShardPlan(buildShardPlan(root, { groupBy: "type", config }));
    const shardDir = join(root, "docs", "modules");
    const shardFile = readdirSync(shardDir).filter((file) => file.startsWith("shard-"))[0];
    expect(shardFile).toBeDefined();
    const path = join(shardDir, shardFile as string);
    const content = readFileSync(path, "utf-8").replace(/count="\d+"/u, 'count="999"');
    writeFileSync(path, content);

    const found = codes(collectLintIssues(root, false, config));
    expect(found).toContain(SHARD_FINDING_CODES.countMismatch);
  });

  test("duplicate id across shards → DUPLICATE_INDEX_ENTRY", () => {
    const { root, config } = makeSynthetic(12);
    applyShardPlan(buildShardPlan(root, { groupBy: "type", config }));
    const shardDir = join(root, "docs", "modules");
    const shardFiles = readdirSync(shardDir)
      .filter((file) => file.startsWith("shard-"))
      .sort();
    expect(shardFiles.length).toBe(3);
    const first = shardFiles[0] as string;
    const second = shardFiles[1] as string;
    const firstContent = readFileSync(join(shardDir, first), "utf-8");
    const duplicate = firstContent.split("\n").find((line) => line.trimStart().startsWith("<M-"));
    expect(duplicate).toBeDefined();
    const secondContent = readFileSync(join(shardDir, second), "utf-8");
    const countMatch = secondContent.match(/count="(\d+)"/u);
    const nextCount = Number(countMatch?.[1] ?? "0") + 1;
    writeFileSync(
      join(shardDir, second),
      secondContent
        .replace(/count="\d+"/u, `count="${nextCount}"`)
        .replace(`</ModuleShard>`, `  ${(duplicate as string).trim()}\n</ModuleShard>`)
    );

    const findings = collectLintIssues(root, false, config);
    expect(codes(findings)).toContain(SHARD_FINDING_CODES.duplicateEntry);
  });

  test("href traversal is PATH_UNSAFE and nothing outside docs/ is read", () => {
    const root = makeRoot();
    const outside = join(root, "..", `outside-${Date.now()}.xml`);
    writeFileSync(outside, `<ModuleShard project="X" count="1"><M-OUTSIDE NAME="Outside" TYPE="X" STATUS="done" /></ModuleShard>\n`);
    try {
      writeGraphEntries(root, [`<Shard href="../${relative(root, outside).split("\\").join("/")}" count="1" />`]);
      const loaded = loadGraphIndex(root);
      expect(codes(loaded.findings)).toContain(SHARD_FINDING_CODES.hrefUnsafe);
      expect(loaded.entries.some((entry) => entry.tag === "M-OUTSIDE")).toBe(false);
      expect(() => loadGraphIndexStrict(root)).toThrow(MyGraceError);
      try {
        loadGraphIndexStrict(root);
      } catch (error) {
        expect(error).toBeInstanceOf(MyGraceError);
        expect((error as MyGraceError).code).toBe(SHARD_FINDING_CODES.hrefUnsafe);
      }
    } finally {
      rmSync(outside, { force: true });
    }
  });

  test("missing shard file → SHARD_FILE_MISSING", () => {
    const { root, config } = makeSynthetic(12);
    applyShardPlan(buildShardPlan(root, { groupBy: "type", config }));
    const shardDir = join(root, "docs", "modules");
    const shardFile = readdirSync(shardDir).filter((file) => file.startsWith("shard-"))[0];
    expect(shardFile).toBeDefined();
    rmSync(join(shardDir, shardFile as string), { force: true });
    expect(codes(collectLintIssues(root, false, config))).toContain(SHARD_FINDING_CODES.fileMissing);
  });

  test("wrong shard root tag → SHARD_ROOT_INVALID", () => {
    const { root, config } = makeSynthetic(12);
    applyShardPlan(buildShardPlan(root, { groupBy: "type", config }));
    const shardDir = join(root, "docs", "modules");
    const shardFile = readdirSync(shardDir).filter((file) => file.startsWith("shard-"))[0];
    const path = join(shardDir, shardFile as string);
    writeFileSync(path, readFileSync(path, "utf-8").replace("<ModuleShard ", "<WrongRoot ").replace("</ModuleShard>", "</WrongRoot>"));
    expect(codes(collectLintIssues(root, false, config))).toContain(SHARD_FINDING_CODES.rootInvalid);
  });
});

// ─── (c) module shard dry-run / apply / idempotency ────────────────────

describe("module shard command round-trip", () => {
  test("dry-run writes nothing; apply is deterministic and idempotent; lint stays green", async () => {
    const { root, config } = makeSynthetic(12);
    const before = docsSnapshot(root);
    const dry = await runCommand(moduleShardCmd, { path: root, groupBy: "type", dryRun: true, format: "text" });
    expect(dry.exit).toBe(0);
    expect(dry.stdout).toContain("Dry run");
    expect(docsSnapshot(root)).toEqual(before);
    expect(existsSync(join(root, ".mygrace", "backups"))).toBe(false);

    const firstApply = await runCommand(moduleShardCmd, { path: root, groupBy: "type", apply: true, format: "text" });
    expect(firstApply.exit).toBe(0);
    expect(firstApply.stdout).toContain("Sharding applied");
    const afterFirst = docsSnapshot(root);
    expect(afterFirst.size).toBeGreaterThan(before.size);
    const rootIndex = readFileSync(join(root, "docs", "graph-index.xml"), "utf-8");
    expect(rootIndex).toContain("<Shard ");
    const shardFiles = readdirSync(join(root, "docs", "modules")).filter((file) => file.startsWith("shard-"));
    expect(shardFiles.length).toBe(3);
    expect(existsSync(join(root, ".mygrace", "backups"))).toBe(true);

    const lintAfter = collectLintIssues(root, false, config);
    expect(lintAfter).toEqual([]);

    const secondApply = await runCommand(moduleShardCmd, { path: root, groupBy: "type", apply: true, format: "text" });
    expect(secondApply.exit).toBe(0);
    expect(secondApply.stdout).toContain("No changes");
    expect(docsSnapshot(root)).toEqual(afterFirst);

    // plan-level determinism: two fresh plans produce identical bytes
    const planA = buildShardPlan(root, { groupBy: "type", config });
    const planB = buildShardPlan(root, { groupBy: "type", config });
    expect(planA.groups.map((group) => group.content)).toEqual(planB.groups.map((group) => group.content));
    expect(planA.rootContent).toBe(planB.rootContent);
    expect(applyShardPlan(planA).changed).toBe(false);

    // JSON envelope shape
    const json = await runCommand(moduleShardCmd, { path: root, groupBy: "type", format: "json" });
    expect(json.exit).toBe(0);
    const envelope = JSON.parse(json.stdout) as {
      ok: boolean;
      exitCode: number;
      data?: { dryRun?: boolean; moduleCount?: number; shards?: { href: string; count: number }[] };
    };
    expect(envelope.ok).toBe(true);
    expect(envelope.exitCode).toBe(0);
    expect(envelope.data?.dryRun).toBe(true);
    expect(envelope.data?.moduleCount).toBe(12);
    expect(envelope.data?.shards?.length).toBe(3);
  }, 20_000);

  test("--apply with --dry-run is a usage error", async () => {
    const { root } = makeSynthetic(3);
    await expect(
      moduleShardCmd.run!({ args: { path: root, groupBy: "type", apply: true, dryRun: true } } as never)
    ).rejects.toBeInstanceOf(UsageError);
  });
});

// ─── (d) strict loader semantics ───────────────────────────────────────

describe("loadGraphIndexStrict", () => {
  test("flat project returns the same union as the lenient reader", () => {
    const { root } = makeSynthetic(5);
    const lenient = loadGraphIndex(root);
    const strict = loadGraphIndexStrict(root);
    expect(strict.entries.map((entry) => entry.tag)).toEqual(lenient.entries.map((entry) => entry.tag));
  });

  test("malformed root index throws XmlError-compatible code", () => {
    const root = makeRoot();
    writeFileSync(join(root, "docs", "graph-index.xml"), `<GraphIndex>\n  <M-A NAME="A"\n</GraphIndex>\n`);
    try {
      loadGraphIndexStrict(root);
      throw new Error("expected throw");
    } catch (error) {
      expect(error).toBeInstanceOf(MyGraceError);
      expect((error as MyGraceError).code).toBe("XML_INVALID");
    }
  });
});
