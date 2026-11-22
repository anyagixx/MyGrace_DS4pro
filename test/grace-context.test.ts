import { describe, test, expect } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildContextTable, contextCostCommand, contextFindings } from "../src/grace-context";
import { UsageError } from "../src/grace-errors";

const GRAPH = `<GraphIndex project="T" version="1.0.0">\n  <M-A NAME="A" TYPE="T" STATUS="done" />\n</GraphIndex>\n`;
const PLANS = `<PlanIndex project="T" version="1.0.0">\n  <Phase-1 name="P" status="wip" steps="1" />\n</PlanIndex>\n`;
const VERS = `<VerificationIndex project="T" version="1.0.0">\n  <V-M-A MODULE="M-A" PRIORITY="high" STATUS="pending" />\n</VerificationIndex>\n`;

function makeProject(options: { withEntityDirs?: boolean; withConfig?: Record<string, unknown> } = {}): string {
  const root = mkdtempSync(join(tmpdir(), "mygrace-ctx-"));
  mkdirSync(join(root, "docs"), { recursive: true });
  writeFileSync(join(root, "docs", "graph-index.xml"), GRAPH);
  writeFileSync(join(root, "docs", "plan-index.xml"), PLANS);
  writeFileSync(join(root, "docs", "verification-index.xml"), VERS);
  if (options.withEntityDirs !== false) {
    mkdirSync(join(root, "docs", "modules"), { recursive: true });
    mkdirSync(join(root, "docs", "plans"), { recursive: true });
    mkdirSync(join(root, "docs", "verification"), { recursive: true });
    writeFileSync(join(root, "docs", "modules", "M-A.xml"), "<M-A></M-A>\n");
    writeFileSync(join(root, "docs", "plans", "Phase-1.xml"), "<Phase-1></Phase-1>\n");
    writeFileSync(join(root, "docs", "verification", "V-M-A.xml"), "<V-M-A></V-M-A>\n");
  }
  if (options.withConfig !== undefined) {
    writeFileSync(join(root, "mygrace.config.json"), JSON.stringify(options.withConfig));
  }
  return root;
}

class ExitSignal extends Error {}

interface Captured {
  stdout: string;
  exit: number;
  thrown: unknown;
}

async function capture(fn: () => Promise<unknown>): Promise<Captured> {
  const chunks: string[] = [];
  const originalWrite = process.stdout.write.bind(process.stdout);
  const originalLog = console.log;
  const originalExit = process.exit;
  let exit: number | undefined;
  let thrown: unknown;
  process.stdout.write = ((chunk: unknown) => {
    chunks.push(String(chunk));
    return true;
  }) as typeof process.stdout.write;
  console.log = ((...values: unknown[]) => {
    chunks.push(`${values.map((value) => String(value)).join(" ")}\n`);
  }) as typeof console.log;
  process.exit = ((code?: number) => {
    exit = code ?? 0;
    throw new ExitSignal(`exit:${code ?? 0}`);
  }) as never;
  try {
    await fn();
  } catch (error) {
    if (!(error instanceof ExitSignal)) thrown = error;
  } finally {
    process.stdout.write = originalWrite;
    console.log = originalLog;
    process.exit = originalExit;
  }
  return { stdout: chunks.join(""), exit: exit ?? 0, thrown };
}

describe("buildContextTable", () => {
  test("returns the operations with line counts", () => {
    const root = makeProject();
    try {
      const table = buildContextTable(root);
      expect(table.project).toBe(root);
      expect(table.modules).toBe(1);
      expect(table.phases).toBe(1);
      expect(table.verifications).toBe(1);
      expect(table.operations.length).toBe(4);
      for (const operation of table.operations) {
        expect(typeof operation.name).toBe("string");
        expect(typeof operation.lines).toBe("number");
        expect(operation.lines).toBeGreaterThan(0);
      }
      expect(table.operations[0]?.lines).toBeGreaterThan(0);
      expect(table.indexCaps).toEqual({ graph: 100, plan: 50, verification: 80 });
      expect(table.indexErrors).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("does not crash when docs/modules and docs/plans are missing", () => {
    const root = makeProject({ withEntityDirs: false });
    try {
      const table = buildContextTable(root);
      expect(table.modules).toBe(1);
      expect(table.operations.length).toBe(4);
      expect(table.operations[1]?.name).toContain("M-A.xml");
      expect(table.operations[2]?.name).toContain("Phase-1.xml");
      expect(table.indexErrors).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("uses config caps and reports an unreadable index as a finding, not a crash", () => {
    const root = makeProject({ withConfig: { indexCaps: { graph: 1, plan: 50, verification: 80 } } });
    try {
      writeFileSync(join(root, "docs", "graph-index.xml"), "<GraphIndex><broken></GraphIndex>");
      const table = buildContextTable(root);
      expect(table.indexErrors.length).toBe(1);
      expect(table.indexErrors[0]?.file).toContain("graph-index.xml");
      const findings = contextFindings(table);
      expect(findings.some((item) => item.code === "INDEX_UNREADABLE" && item.severity === "error")).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("warns when the graph index exceeds the configured cap", () => {
    const root = makeProject({ withConfig: { indexCaps: { graph: 1, plan: 50, verification: 80 } } });
    try {
      const findings = contextFindings(buildContextTable(root));
      expect(findings.some((item) => item.code === "INDEX_OVER_CAP" && item.severity === "warning")).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("contextCostCommand", () => {
  test("text mode prints the operation table and exits 0", async () => {
    const root = makeProject();
    try {
      const { stdout, exit, thrown } = await capture(() => contextCostCommand.run!({ args: { path: root } } as never));
      expect(thrown).toBeUndefined();
      expect(exit).toBe(0);
      expect(stdout).toContain("MyGRACE context cost");
      expect(stdout).toContain("Status check (3 indexes)");
      expect(stdout).toContain("Index caps: graph<=100");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("--format json emits the ADR-8 envelope", async () => {
    const root = makeProject({ withConfig: { language: "python" } });
    try {
      const { stdout, exit } = await capture(() =>
        contextCostCommand.run!({ args: { path: root, format: "json" } } as never)
      );
      expect(exit).toBe(0);
      const envelope = JSON.parse(stdout);
      expect(envelope.ok).toBe(true);
      expect(envelope.exitCode).toBe(0);
      expect(envelope.data.operations.length).toBe(4);
      expect(envelope.data.indexCaps.graph).toBe(100);
      expect(envelope.data.configPath).toContain("mygrace.config.json");
      expect(envelope.findings).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("malformed index XML exits 1 through the JSON envelope (no stack trace)", async () => {
    const root = makeProject();
    try {
      writeFileSync(join(root, "docs", "verification-index.xml"), "<VerificationIndex><broken>");
      const { stdout, exit } = await capture(() =>
        contextCostCommand.run!({ args: { path: root, format: "json" } } as never)
      );
      expect(exit).toBe(1);
      const envelope = JSON.parse(stdout);
      expect(envelope.ok).toBe(false);
      expect(envelope.exitCode).toBe(1);
      expect(envelope.findings.some((item: { code: string }) => item.code === "INDEX_UNREADABLE")).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("invalid --format is a usage error (exit 2)", async () => {
    const root = makeProject();
    try {
      const { thrown } = await capture(() =>
        contextCostCommand.run!({ args: { path: root, format: "yaml" } } as never)
      );
      expect(thrown).toBeInstanceOf(UsageError);
      expect((thrown as UsageError).exitCode).toBe(2);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
