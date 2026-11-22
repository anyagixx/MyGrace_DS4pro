import { describe, test, expect } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { verifyCommand } from "../src/grace-verify";
import { writeTrustRecord } from "../src/grace-test";
import { UsageError, XmlError } from "../src/grace-errors";

const GRAPH_INDEX = `<GraphIndex project="T" version="1.0.0">\n  <M-A NAME="A" TYPE="T" STATUS="done" />\n</GraphIndex>\n`;

function makeProject(checkCmd: string, options: { config?: Record<string, unknown> } = {}): string {
  const root = mkdtempSync(join(tmpdir(), "mygrace-verify-"));
  mkdirSync(join(root, "docs", "modules"), { recursive: true });
  mkdirSync(join(root, "docs", "verification"), { recursive: true });
  writeFileSync(join(root, "docs", "graph-index.xml"), GRAPH_INDEX);
  writeFileSync(join(root, "docs", "modules", "M-A.xml"), `<M-A NAME="A" TYPE="T" STATUS="done"></M-A>`);
  writeFileSync(
    join(root, "docs", "verification", "V-M-A.xml"),
    `<V-M-A><test-files><file>x.test.ts</file></test-files><module-checks><check-1>${checkCmd}</check-1></module-checks></V-M-A>`
  );
  if (options.config !== undefined) writeFileSync(join(root, "mygrace.config.json"), JSON.stringify(options.config));
  return root;
}

class ExitSignal extends Error {}

interface Captured {
  stdout: string;
  exit: number;
  thrown: unknown;
}

/** Run a citty command body, capturing stdout/console and process.exit. */
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

async function runVerify(root: string, extra: Record<string, unknown> = {}): Promise<Captured> {
  return capture(() => verifyCommand.run!({ args: { path: root, ...extra } } as never));
}

describe("verifyCommand", () => {
  test("ok module (trusted): prints Verify ok, no last-failures.md, exit 0", async () => {
    const root = makeProject("true");
    try {
      writeTrustRecord(root);
      const { stdout, exit, thrown } = await runVerify(root);
      expect(thrown).toBeUndefined();
      expect(stdout).toContain("Verify: 1 ok");
      expect(exit).toBe(0);
      expect(existsSync(join(root, ".mygrace", "last-failures.md"))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("failing module: prints digest + command, writes last-failures.md, exit 1", async () => {
    const root = makeProject("false");
    try {
      writeTrustRecord(root);
      const { stdout, exit } = await runVerify(root);
      expect(stdout).toContain("=== M-A — FAILED ===");
      expect(stdout).toContain("command: false");
      expect(exit).toBe(1);
      const report = readFileSync(join(root, ".mygrace", "last-failures.md"), "utf-8");
      expect(report).toContain("M-A");
      expect(report).toContain("false");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("untrusted project: refuses, lists the exact command, exits 2, no failure artifact", async () => {
    const root = makeProject("true");
    try {
      const { stdout, exit } = await runVerify(root);
      expect(stdout).toContain("Commands that WOULD run");
      expect(stdout).toContain("M-A: true x.test.ts");
      expect(stdout).toContain("UNTRUSTED_PROJECT");
      expect(stdout).toContain("mygrace trust");
      expect(exit).toBe(2);
      expect(existsSync(join(root, ".mygrace", "last-failures.md"))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("config.allowCommands:true runs without a trust record", async () => {
    const root = makeProject("true", { config: { allowCommands: true } });
    try {
      const { exit, stdout } = await runVerify(root);
      expect(exit).toBe(0);
      expect(stdout).toContain("Verify: 1 ok");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("--allow-commands runs an untrusted project", async () => {
    const root = makeProject("true");
    try {
      const { exit } = await runVerify(root, { allowCommands: true });
      expect(exit).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("--format json success envelope follows ADR-3/ADR-8", async () => {
    const root = makeProject("true");
    try {
      writeTrustRecord(root);
      const { stdout, exit } = await runVerify(root, { format: "json" });
      expect(exit).toBe(0);
      const envelope = JSON.parse(stdout);
      expect(envelope.ok).toBe(true);
      expect(envelope.exitCode).toBe(0);
      expect(envelope.meta.command).toBe("verify");
      expect(envelope.data.summary).toEqual({ total: 1, failed: 0, ok: 1 });
      expect(envelope.data.authorization.via).toBe("trust");
      expect(envelope.findings).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("--format json failure envelope exits 1 with coded findings", async () => {
    const root = makeProject("false");
    try {
      writeTrustRecord(root);
      const { stdout, exit } = await runVerify(root, { format: "json" });
      expect(exit).toBe(1);
      const envelope = JSON.parse(stdout);
      expect(envelope.ok).toBe(false);
      expect(envelope.exitCode).toBe(1);
      expect(envelope.findings.length).toBe(1);
      expect(envelope.findings[0].severity).toBe("error");
      expect(envelope.data.summary.failed).toBe(1);
      expect(envelope.data.failureReport).toBe(".mygrace/last-failures.md");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("--format json trust refusal is an UNTRUSTED_PROJECT envelope with exit 2", async () => {
    const root = makeProject("true");
    try {
      const { stdout, exit } = await runVerify(root, { format: "json" });
      expect(exit).toBe(2);
      const envelope = JSON.parse(stdout);
      expect(envelope.ok).toBe(false);
      expect(envelope.exitCode).toBe(2);
      expect(envelope.error.code).toBe("UNTRUSTED_PROJECT");
      expect(envelope.error.hint).toContain("docs/verification/V-M-XXX.xml");
      expect(envelope.data.planned[0].command).toBe("true");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("--module with --all is a usage error (exit 2)", async () => {
    const root = makeProject("true");
    try {
      const { thrown } = await runVerify(root, { module: "M-A", all: true, allowCommands: true });
      expect(thrown).toBeInstanceOf(UsageError);
      expect((thrown as UsageError).exitCode).toBe(2);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("traversal module id is rejected with USAGE (ADR-4)", async () => {
    const root = makeProject("true");
    try {
      const { thrown } = await runVerify(root, { module: "../../etc/passwd", allowCommands: true });
      expect(thrown).toBeInstanceOf(UsageError);
      expect((thrown as UsageError).exitCode).toBe(2);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("shell metacharacter command is refused without --allow-commands, exit 1", async () => {
    const root = makeProject("echo hi &amp;&amp; false");
    try {
      writeTrustRecord(root);
      const { stdout, exit } = await runVerify(root);
      expect(exit).toBe(1);
      expect(stdout).toContain("SHELL_COMMAND_REFUSED");
      const allowed = await runVerify(root, { allowCommands: true });
      // Executed as plain argv [echo, hi, &&, false]: echo exits 0 with the opt-in,
      // which proves there is no shell (`&&` was never an operator).
      expect(allowed.exit).toBe(0);
      expect(allowed.stdout).toContain("Verify: 1 ok");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("malformed index XML is a typed finding, not a crash", async () => {
    const root = makeProject("true");
    try {
      writeTrustRecord(root);
      writeFileSync(join(root, "docs", "graph-index.xml"), "<GraphIndex><broken></GraphIndex>");
      const { thrown } = await runVerify(root, { format: "text" });
      expect(thrown).toBeInstanceOf(XmlError);
      expect((thrown as XmlError).exitCode).toBe(1);
      const json = await runVerify(root, { format: "json" });
      expect(json.exit).toBe(1);
      const envelope = JSON.parse(json.stdout);
      expect(envelope.ok).toBe(false);
      expect(envelope.error.code).toBe("XML_INVALID");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
