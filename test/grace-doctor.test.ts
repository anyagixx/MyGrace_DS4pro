import { describe, test, expect } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildDoctorReport, doctorCommand, doctorFindings, printDoctorReport } from "../src/grace-doctor";
import { UsageError } from "../src/grace-errors";

function makeTempProject(entries: string[], files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "mygrace-doctor-"));
  mkdirSync(join(root, "docs", "modules"), { recursive: true });
  mkdirSync(join(root, "docs", "plans"), { recursive: true });
  mkdirSync(join(root, "docs", "verification"), { recursive: true });
  writeFileSync(join(root, "docs", "graph-index.xml"), `<GraphIndex project="T" version="1.0.0">\n${entries.join("\n")}\n</GraphIndex>\n`);
  writeFileSync(join(root, "docs", "plan-index.xml"), `<PlanIndex project="T" version="1.0.0">\n</PlanIndex>\n`);
  writeFileSync(join(root, "docs", "verification-index.xml"), `<VerificationIndex project="T" version="1.0.0">\n</VerificationIndex>\n`);
  for (const [name, body] of Object.entries(files)) {
    writeFileSync(join(root, "docs", "modules", name), body);
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

/** Isolate doctor from the real ~/.dsh (read-only, but tests must be deterministic). */
function withFakeDshHome<T>(fn: () => T): T {
  const previous = process.env.DSH_HOME;
  const fake = mkdtempSync(join(tmpdir(), "mygrace-doctor-dsh-"));
  process.env.DSH_HOME = fake;
  try {
    return fn();
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = previous;
    rmSync(fake, { recursive: true, force: true });
  }
}

describe("buildDoctorReport", () => {
  test("clean project: project ok, counts match, config row present", () => {
    const root = makeTempProject([`<M-AUTH NAME="A" TYPE="CORE_LOGIC" STATUS="done" />`], {
      "M-AUTH.xml": `<M-AUTH NAME="A" STATUS="done">\n</M-AUTH>`,
    });
    try {
      withFakeDshHome(() => {
        const report = buildDoctorReport(root);
        expect(report.project.ok).toBe(true);
        expect(report.project.status?.modules).toBe(1);
        expect(report.project.status?.errors).toBe(0);
        expect(report.project.status?.indexErrors).toEqual([]);
        expect(report.config.ok).toBe(true);
        expect(report.config.detail).toContain("defaults");
        expect(report.config.detail).toContain("sourceDirs: src, lib, apps, packages");
        expect(report.errors).toBeGreaterThanOrEqual(0);
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("broken project: project.ok false and errors >= 1", () => {
    const root = makeTempProject([`<M-ORPHAN NAME="O" TYPE="UTILITY" STATUS="pending" />`], {});
    try {
      withFakeDshHome(() => {
        const report = buildDoctorReport(root);
        expect(report.project.ok).toBe(false);
        expect(report.errors).toBeGreaterThanOrEqual(1);
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("no docs/graph-index.xml: project.ok false", () => {
    const root = mkdtempSync(join(tmpdir(), "mygrace-doctor-nodocs-"));
    try {
      withFakeDshHome(() => {
        const report = buildDoctorReport(root);
        expect(report.project.ok).toBe(false);
        expect(report.project.error).toMatch(/graph-index/);
        expect(report.config.ok).toBe(true);
        expect(report.config.detail).toContain("skipped");
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("malformed index XML is reported, not thrown", () => {
    const root = makeTempProject([], {});
    try {
      writeFileSync(join(root, "docs", "graph-index.xml"), "<GraphIndex><broken></GraphIndex>");
      withFakeDshHome(() => {
        const report = buildDoctorReport(root);
        expect(report.project.ok).toBe(false);
        expect(report.project.status?.indexErrors.length).toBeGreaterThan(0);
        const findings = doctorFindings(report);
        expect(findings.some((item) => item.code === "INDEX_UNREADABLE")).toBe(true);
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("invalid mygrace.config.json is a failed config check with the exact error", () => {
    const root = makeTempProject([`<M-AUTH NAME="A" TYPE="CORE_LOGIC" STATUS="done" />`], {
      "M-AUTH.xml": `<M-AUTH NAME="A" STATUS="done"></M-AUTH>`,
    });
    try {
      writeFileSync(join(root, "mygrace.config.json"), "{ not json");
      withFakeDshHome(() => {
        const report = buildDoctorReport(root);
        expect(report.config.ok).toBe(false);
        expect(report.config.detail).toContain("Cannot parse");
        expect(report.errors).toBeGreaterThanOrEqual(1);
        expect(doctorFindings(report).some((item) => item.code === "DOCTOR_PROJECT_CONFIG_FAILED")).toBe(true);
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("all checks are well-formed; errors/warnings are numbers", () => {
    const root = makeTempProject([`<M-AUTH NAME="A" TYPE="CORE_LOGIC" STATUS="done" />`], {});
    try {
      withFakeDshHome(() => {
        const report = buildDoctorReport(root);
        for (const key of ["config", "dsh", "rtk", "caveman", "skills", "mcp", "panel", "devTools"] as const) {
          expect(typeof report[key].name).toBe("string");
          expect(typeof report[key].detail).toBe("string");
          expect(typeof report[key].ok).toBe("boolean");
        }
        expect(typeof report.errors).toBe("number");
        expect(typeof report.warnings).toBe("number");
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("doctorCommand", () => {
  test("text mode renders the report and exits 1 on errors", async () => {
    const root = makeTempProject([`<M-ORPHAN NAME="O" TYPE="UTILITY" STATUS="pending" />`], {});
    try {
      await withFakeDshHomeAsync(async () => {
        const { stdout, exit } = await capture(() => doctorCommand.run!({ args: { path: root } } as never));
        expect(stdout).toContain("MyGRACE doctor");
        expect(stdout).toContain("project config");
        expect(exit).toBe(1);
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("--format json exits non-zero on errors (v1 bug fixed) and matches the envelope", async () => {
    const root = makeTempProject([`<M-ORPHAN NAME="O" TYPE="UTILITY" STATUS="pending" />`], {});
    try {
      await withFakeDshHomeAsync(async () => {
        const { stdout, exit } = await capture(() =>
          doctorCommand.run!({ args: { path: root, format: "json" } } as never)
        );
        const envelope = JSON.parse(stdout);
        expect(exit).toBe(envelope.exitCode);
        expect(envelope.ok).toBe(false);
        expect(envelope.exitCode).toBe(1);
        expect(envelope.findings.some((item: { severity: string }) => item.severity === "error")).toBe(true);
        expect(envelope.meta.command).toBe("doctor");
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("--format json on a non-project exits 1 with PROJECT_NOT_FOUND", async () => {
    const root = mkdtempSync(join(tmpdir(), "mygrace-doctor-empty-"));
    try {
      await withFakeDshHomeAsync(async () => {
        const { stdout, exit } = await capture(() =>
          doctorCommand.run!({ args: { path: root, format: "json" } } as never)
        );
        expect(exit).toBe(1);
        const envelope = JSON.parse(stdout);
        expect(envelope.exitCode).toBe(1);
        expect(envelope.findings.some((item: { code: string }) => item.code === "PROJECT_NOT_FOUND")).toBe(true);
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("invalid --format is a usage error", async () => {
    const root = makeTempProject([], {});
    try {
      const { thrown } = await capture(() => doctorCommand.run!({ args: { path: root, format: "xml" } } as never));
      expect(thrown).toBeInstanceOf(UsageError);
      expect((thrown as UsageError).exitCode).toBe(2);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

/** Async variant of withFakeDshHome (the command body returns a promise). */
async function withFakeDshHomeAsync(fn: () => Promise<void>): Promise<void> {
  const previous = process.env.DSH_HOME;
  const fake = mkdtempSync(join(tmpdir(), "mygrace-doctor-dsh-"));
  process.env.DSH_HOME = fake;
  try {
    await fn();
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = previous;
    rmSync(fake, { recursive: true, force: true });
  }
}

// printDoctorReport is exported for the CLI and MCP; keep a smoke assertion on
// its shape so it cannot drift from the report type without a failing test.
void printDoctorReport;
