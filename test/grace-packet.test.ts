import { describe, test, expect } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { depTable, packetCommand, focusCommand } from "../src/grace-packet";
import { UsageError } from "../src/grace-errors";

function makeProject(options: { withVerificationChecks?: boolean } = {}): string {
  const root = mkdtempSync(join(tmpdir(), "mygrace-packet-"));
  mkdirSync(join(root, "docs", "modules"), { recursive: true });
  mkdirSync(join(root, "docs", "verification"), { recursive: true });
  writeFileSync(
    join(root, "docs", "graph-index.xml"),
    `<GraphIndex project="T" version="1.0.0">\n  <M-B NAME="B" TYPE="T" STATUS="done" PATH="src/b/index.ts" />\n  <M-A NAME="A" TYPE="T" STATUS="wip" PATH="src/a/index.ts" DEPENDS="M-B" />\n</GraphIndex>\n`
  );
  writeFileSync(
    join(root, "docs", "modules", "M-A.xml"),
    `<M-A NAME="A" TYPE="T" STATUS="wip"><contract><purpose>Do A things</purpose><path>src/a/index.ts</path><depends>M-B</depends></contract></M-A>`
  );
  writeFileSync(
    join(root, "docs", "modules", "M-B.xml"),
    `<M-B NAME="B" TYPE="T" STATUS="done"><contract><purpose>Do B things</purpose><path>src/b/index.ts</path></contract></M-B>`
  );
  const checks =
    options.withVerificationChecks === true
      ? `<module-checks><check-1>bun test src/a/index.test.ts</check-1></module-checks>`
      : "";
  writeFileSync(
    join(root, "docs", "verification", "V-M-A.xml"),
    `<V-M-A MODULE="M-A" PRIORITY="high" STATUS="wip"><test-files><file>src/a/index.test.ts</file></test-files>${checks}</V-M-A>`
  );
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

describe("depTable", () => {
  test("resolves deps from graph-index", () => {
    const root = makeProject();
    try {
      expect(depTable(root, "M-A")).toEqual(["- M-B — src/b/index.ts (done)"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
  test("returns [] when module file is missing", () => {
    const root = makeProject();
    try {
      expect(depTable(root, "M-NOPE")).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
  test("rejects a traversal id before touching the filesystem", () => {
    const root = makeProject();
    try {
      expect(() => depTable(root, "../../etc/passwd")).toThrow(UsageError);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("packetCommand", () => {
  test("prints contract + verification + canonical check command + deps", async () => {
    const root = makeProject({ withVerificationChecks: true });
    try {
      const { stdout, exit, thrown } = await capture(() => packetCommand.run!({ args: { id: "M-A", path: root } } as never));
      expect(thrown).toBeUndefined();
      expect(exit).toBe(0);
      expect(stdout).toContain("=== PACKET M-A");
      expect(stdout).toContain("Do A things");
      expect(stdout).toContain("- M-B — src/b/index.ts (done)");
      expect(stdout).toContain("## Contract");
      expect(stdout).toContain("## Verification");
      expect(stdout).toContain("## Check command");
      expect(stdout).toContain("canonical: verification file");
      expect(stdout).toContain("command: bun test src/a/index.test.ts");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("missing module is a usage error (exit 2), not a crash", async () => {
    const root = makeProject();
    try {
      const { thrown } = await capture(() => packetCommand.run!({ args: { id: "M-NOPE", path: root } } as never));
      expect(thrown).toBeInstanceOf(UsageError);
      expect((thrown as UsageError).exitCode).toBe(2);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("path traversal id is rejected with USAGE (ADR-4)", async () => {
    const root = makeProject();
    try {
      for (const id of ["../../etc/passwd", "../M-A", "/etc/passwd", "M-A/../../x"]) {
        const { thrown } = await capture(() => packetCommand.run!({ args: { id, path: root } } as never));
        expect(thrown).toBeInstanceOf(UsageError);
        expect((thrown as UsageError).exitCode).toBe(2);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("--format json emits the ADR-8 packet envelope", async () => {
    const root = makeProject({ withVerificationChecks: true });
    try {
      const { stdout, exit } = await capture(() =>
        packetCommand.run!({ args: { id: "M-A", path: root, format: "json" } } as never)
      );
      expect(exit).toBe(0);
      const envelope = JSON.parse(stdout);
      expect(envelope.ok).toBe(true);
      expect(envelope.exitCode).toBe(0);
      expect(envelope.data.module).toBe("M-A");
      expect(envelope.data.status).toBe("wip");
      expect(envelope.data.deps).toEqual(["- M-B — src/b/index.ts (done)"]);
      expect(envelope.data.check).toEqual({
        command: "bun test src/a/index.test.ts",
        source: "verification",
        file: "docs/verification/V-M-A.xml",
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("focusCommand", () => {
  test("prints the minimal working set (contract + deps + canonical tests, no verification dump)", async () => {
    const root = makeProject({ withVerificationChecks: true });
    try {
      const { stdout, exit } = await capture(() => focusCommand.run!({ args: { id: "M-A", path: root } } as never));
      expect(exit).toBe(0);
      expect(stdout).toContain("=== FOCUS M-A — wip ===");
      expect(stdout).toContain("Status: wip");
      expect(stdout).toContain("Contract: Do A things — src/a/index.ts");
      expect(stdout).toContain("Deps: M-B (done)");
      expect(stdout).toContain("Tests: bun test src/a/index.test.ts [verification file]");
      expect(stdout).not.toContain("## Verification");
      expect(stdout).not.toContain("## Contract");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("falls back to the config testRunner when no command is declared", async () => {
    const root = makeProject();
    try {
      const { stdout } = await capture(() => focusCommand.run!({ args: { id: "M-A", path: root } } as never));
      expect(stdout).toContain("Tests: bun test [config testRunner (default)]");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("focus traversal id is rejected with USAGE (ADR-4)", async () => {
    const root = makeProject();
    try {
      const { thrown } = await capture(() => focusCommand.run!({ args: { id: "../../etc/passwd", path: root } } as never));
      expect(thrown).toBeInstanceOf(UsageError);
      expect((thrown as UsageError).exitCode).toBe(2);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("--format json emits the focus envelope", async () => {
    const root = makeProject({ withVerificationChecks: true });
    try {
      const { stdout, exit } = await capture(() => focusCommand.run!({ args: { id: "M-A", path: root, format: "json" } } as never));
      expect(exit).toBe(0);
      const envelope = JSON.parse(stdout);
      expect(envelope.data.module).toBe("M-A");
      expect(envelope.data.deps).toEqual(["M-B (done)"]);
      expect(envelope.data.check.source).toBe("verification");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
