import { describe, test, expect } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { testCommand, trustCommand } from "../src/grace-test";
import { verifyCommand } from "../src/grace-verify";
import { focusCommand, packetCommand } from "../src/grace-packet";
import { UsageError } from "../src/grace-errors";
import { escapeXml } from "../src/grace-xml";

const GRAPH_INDEX = `<GraphIndex project="T" version="1.0.0">\n  <M-A NAME="A" TYPE="CORE" STATUS="done" PATH="src/a.ts" />\n</GraphIndex>\n`;
const MODULE = `<M-A NAME="A" TYPE="CORE" STATUS="done"><contract><purpose>Do A</purpose><path>src/a.ts</path></contract></M-A>`;

interface ProjectOptions {
  /** Command executed by the project (verbatim `<check-1>` content). */
  command?: string;
  /** `<file>` entries for the verification file. */
  files?: string[];
  /** Where to put <module-checks>: canonical verification (default), module (deprecated) or nowhere. */
  checksLocation?: "verification" | "module" | "none";
  config?: Record<string, unknown>;
}

/** Create a mini MyGRACE project with an attacker-controlled command. */
function makeProject(options: ProjectOptions = {}): string {
  const root = mkdtempSync(join(tmpdir(), "mygrace-sec-"));
  mkdirSync(join(root, "docs", "modules"), { recursive: true });
  mkdirSync(join(root, "docs", "verification"), { recursive: true });
  writeFileSync(join(root, "docs", "graph-index.xml"), GRAPH_INDEX);

  const command = options.command ?? "true";
  const files = options.files ?? ["x.test.ts"];
  const checks =
    options.checksLocation === "none" ? "" : `<module-checks><check-1>${escapeXml(command)}</check-1></module-checks>`;
  const verificationChecks = options.checksLocation === "module" || options.checksLocation === "none" ? "" : checks;
  const moduleChecks = options.checksLocation === "module" ? checks : "";

  writeFileSync(join(root, "docs", "modules", "M-A.xml"), `<M-A NAME="A" TYPE="CORE" STATUS="done">${moduleChecks}</M-A>`);
  writeFileSync(
    join(root, "docs", "verification", "V-M-A.xml"),
    `<V-M-A MODULE="M-A" PRIORITY="high" STATUS="pending"><test-files>${files
      .map((file) => `<file>${escapeXml(file)}</file>`)
      .join("")}</test-files>${verificationChecks}</V-M-A>`
  );
  if (options.config !== undefined) writeFileSync(join(root, "mygrace.config.json"), JSON.stringify(options.config));
  return root;
}

/** An attacker-controlled script: proves whether repository data got executed. */
function writeEvilScript(root: string, marker: string, scriptName = "evil.sh"): void {
  const path = join(root, scriptName);
  writeFileSync(path, `#!/bin/sh\necho PWNED > "$(dirname "$0")/${marker}"\n`);
  chmodSync(path, 0o755);
}

function markerExists(root: string, marker: string): boolean {
  return existsSync(join(root, marker));
}

class ExitSignal extends Error {}

interface Captured {
  stdout: string;
  stderr: string;
  exit: number;
  thrown: unknown;
}

/** Run a citty command body, capturing both streams and process.exit. */
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
  return { stdout: chunks.join(""), stderr: "", exit: exit ?? 0, thrown };
}

async function runTest(root: string, extra: Record<string, unknown> = {}): Promise<Captured> {
  return capture(() => testCommand.run!({ args: { path: root, ...extra } } as never));
}
async function runTrust(root: string, extra: Record<string, unknown> = {}): Promise<Captured> {
  return capture(() => trustCommand.run!({ args: { path: root, ...extra } } as never));
}
async function runVerify(root: string, extra: Record<string, unknown> = {}): Promise<Captured> {
  return capture(() => verifyCommand.run!({ args: { path: root, ...extra } } as never));
}

describe("C-5 regression: repo-controlled XML cannot execute commands without trust", () => {
  test("untrusted project: malicious ./evil.sh is listed but NOT executed", async () => {
    const root = makeProject({ command: "./evil.sh" });
    writeEvilScript(root, "PWNED_MARKER.txt");
    try {
      const { stdout, exit } = await runTest(root, { module: "M-A" });
      expect(markerExists(root, "PWNED_MARKER.txt")).toBe(false);
      expect(exit).toBe(2);
      expect(stdout).toContain("Commands that WOULD run");
      expect(stdout).toContain("./evil.sh x.test.ts");
      expect(stdout).toContain("UNTRUSTED_PROJECT");
      expect(stdout).toContain("mygrace trust");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("trust round-trip: refusal → `mygrace trust` → execution → tamper → refusal again", async () => {
    const root = makeProject({ command: "./evil.sh" });
    writeEvilScript(root, "PWNED_MARKER.txt");
    try {
      // 1. refusal
      const refused = await runTest(root, { module: "M-A" });
      expect(refused.exit).toBe(2);
      expect(markerExists(root, "PWNED_MARKER.txt")).toBe(false);

      // 2. explicit review + trust (the `mygrace trust` command)
      const trusted = await runTrust(root);
      expect(trusted.exit).toBe(0);
      expect(existsSync(join(root, ".mygrace", "trust.json"))).toBe(true);

      // 3. execution is now allowed
      const executed = await runTest(root, { module: "M-A" });
      expect(executed.exit).toBe(0);
      expect(markerExists(root, "PWNED_MARKER.txt")).toBe(true);

      // 4. a changed command invalidates the record: back to refusal
      rmSync(join(root, "PWNED_MARKER.txt"));
      writeEvilScript(root, "PWNED_MARKER_2.txt", "evil2.sh");
      writeFileSync(
        join(root, "docs", "verification", "V-M-A.xml"),
        `<V-M-A><test-files><file>x.test.ts</file></test-files><module-checks><check-1>./evil2.sh</check-1></module-checks></V-M-A>`
      );
      const tampered = await runTest(root, { module: "M-A" });
      expect(tampered.exit).toBe(2);
      expect(tampered.stdout).toContain("stale");
      expect(markerExists(root, "PWNED_MARKER_2.txt")).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("tampering the trust record itself does not bypass the gate", async () => {
    const root = makeProject({ command: "./evil.sh" });
    writeEvilScript(root, "PWNED_MARKER.txt");
    try {
      await runTrust(root);
      const path = join(root, ".mygrace", "trust.json");
      const record = JSON.parse(readFileSync(path, "utf-8"));
      record.files["docs/verification/V-M-A.xml"] = "0".repeat(64);
      writeFileSync(path, JSON.stringify(record, null, 2));

      const { exit, stdout } = await runTest(root, { module: "M-A" });
      expect(exit).toBe(2);
      expect(stdout).toContain("UNTRUSTED_PROJECT");
      expect(markerExists(root, "PWNED_MARKER.txt")).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("--allow-commands is the deliberate one-off opt-in", async () => {
    const root = makeProject({ command: "./evil.sh" });
    writeEvilScript(root, "PWNED_MARKER.txt");
    try {
      const { exit } = await runTest(root, { module: "M-A", allowCommands: true });
      expect(exit).toBe(0);
      expect(markerExists(root, "PWNED_MARKER.txt")).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("config.allowCommands:true is the documented project-level opt-in", async () => {
    const root = makeProject({ command: "./evil.sh", config: { allowCommands: true } });
    writeEvilScript(root, "PWNED_MARKER.txt");
    try {
      const { exit } = await runTest(root, { module: "M-A" });
      expect(exit).toBe(0);
      expect(markerExists(root, "PWNED_MARKER.txt")).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("argv injection and shell semantics", () => {
  test("flag injection through <file> entries is rejected (the original C-5 payload shape)", async () => {
    // Attacker tries: <check-1>bash</check-1> + <file>-c</file> + <file>id > marker</file>
    const root = makeProject({
      command: "bash",
      files: ["-c", "touch PWNED_MARKER.txt"],
      config: { allowCommands: true },
    });
    try {
      const { exit, stdout } = await runTest(root, { module: "M-A" });
      expect(exit).toBe(1);
      expect(markerExists(root, "PWNED_MARKER.txt")).toBe(false);
      expect(stdout).toContain('starting with "-"');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("test-file traversal entries are rejected", async () => {
    const root = makeProject({ command: "true", files: ["../../etc/passwd"] });
    try {
      const { exit, stdout } = await runTest(root, { module: "M-A", allowCommands: true });
      expect(exit).toBe(1);
      expect(stdout).toContain("parent directory segments");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("shell metacharacters never reach a shell: argv-only execution under the explicit opt-in", async () => {
    const root = makeProject({ command: "echo hi && touch PWNED_MARKER.txt" });
    try {
      // Trusted project, but shell-style command: requires --allow-commands.
      await runTrust(root);
      const refused = await runTest(root, { module: "M-A" });
      expect(refused.exit).toBe(1);
      expect(refused.stdout).toContain("SHELL_COMMAND_REFUSED");
      expect(markerExists(root, "PWNED_MARKER.txt")).toBe(false);

      const allowed = await runTest(root, { module: "M-A", allowCommands: true });
      expect(allowed.exit).toBe(0); // argv: [echo, hi, &&, touch, PWNED_MARKER.txt]
      expect(allowed.stdout).toContain("hi && touch PWNED_MARKER.txt");
      expect(markerExists(root, "PWNED_MARKER.txt")).toBe(false); // no shell → no touch
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("sh -c is only allowed behind the explicit opt-in", async () => {
    const root = makeProject({ command: 'sh -c "touch PWNED_MARKER.txt"' });
    try {
      await runTrust(root);
      const refused = await runTest(root, { module: "M-A" });
      expect(refused.exit).toBe(1);
      expect(refused.stdout).toContain("shell interpreter");
      expect(markerExists(root, "PWNED_MARKER.txt")).toBe(false);

      const allowed = await runTest(root, { module: "M-A", allowCommands: true });
      expect(allowed.exit).toBe(0);
      expect(markerExists(root, "PWNED_MARKER.txt")).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("H-5 regression: ids are untrusted input (ADR-4)", () => {
  test("packet ../../etc/passwd is rejected with USAGE before reading anything", async () => {
    const root = makeProject();
    // The traversal target actually exists just outside the project.
    writeFileSync(join(dirname(root), "outside-secret.xml"), "<SECRET>do not read me</SECRET>");
    try {
      for (const id of ["../../etc/passwd", "../outside-secret", "/etc/passwd"]) {
        const { thrown, stdout } = await capture(() => packetCommand.run!({ args: { id, path: root } } as never));
        expect(thrown).toBeInstanceOf(UsageError);
        expect((thrown as UsageError).exitCode).toBe(2);
        expect(stdout).not.toContain("SECRET");
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(join(dirname(root), "outside-secret.xml"), { force: true });
    }
  });

  test("test/verify/focus reject traversal module ids with USAGE", async () => {
    const root = makeProject();
    try {
      const cases = [
        () => runTest(root, { module: "../../etc/passwd" }),
        () => runVerify(root, { module: "../../etc/passwd" }),
        () => capture(() => focusCommand.run!({ args: { id: "../../etc/passwd", path: root } } as never)),
      ];
      for (const run of cases) {
        const { thrown } = await run();
        expect(thrown).toBeInstanceOf(UsageError);
        expect((thrown as UsageError).exitCode).toBe(2);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("H-6 regression: malformed project data is a finding, never a stack trace", () => {
  test("malformed verification XML → exit 1 coded finding, no crash", async () => {
    const root = makeProject();
    try {
      writeFileSync(join(root, "docs", "verification", "V-M-A.xml"), "<V-M-A><module-checks><check-1>true</check-1></V-M-A>");
      const { stdout, exit, thrown } = await runTest(root, { module: "M-A", allowCommands: true });
      expect(thrown).toBeUndefined();
      expect(exit).toBe(1);
      expect(stdout).toContain("XML_INVALID");
      expect(stdout).not.toContain("    at "); // no stack frames
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("unreadable/malformed index XML → typed XML_INVALID, not a crash", async () => {
    const root = makeProject();
    try {
      writeFileSync(join(root, "docs", "graph-index.xml"), "<GraphIndex><broken></GraphIndex>");
      const { thrown } = await runTest(root);
      expect(thrown).toBeDefined();
      expect((thrown as { code?: string }).code).toBe("XML_INVALID");
      const json = await runTest(root, { format: "json" });
      expect(json.exit).toBe(1);
      expect(JSON.parse(json.stdout).error.code).toBe("XML_INVALID");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("unterminated quote in the command → coded finding, no crash", async () => {
    const root = makeProject({ command: 'echo "oops' });
    try {
      await runTrust(root);
      const { stdout, exit, thrown } = await runTest(root, { module: "M-A" });
      expect(thrown).toBeUndefined();
      expect(exit).toBe(1);
      expect(stdout).toContain("CHECK_COMMAND_INVALID");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("verify writes .mygrace/last-failures.md only on failure, never on trust refusal", async () => {
    const untrusted = makeProject({ command: "true" });
    const failing = makeProject({ command: "false" });
    try {
      const refused = await runVerify(untrusted);
      expect(refused.exit).toBe(2);
      expect(existsSync(join(untrusted, ".mygrace", "last-failures.md"))).toBe(false);

      await runTrust(failing);
      const failed = await runVerify(failing);
      expect(failed.exit).toBe(1);
      expect(existsSync(join(failing, ".mygrace", "last-failures.md"))).toBe(true);
    } finally {
      rmSync(untrusted, { recursive: true, force: true });
      rmSync(failing, { recursive: true, force: true });
    }
  });
});

describe("ADR-8: JSON envelopes carry the exit-code contract", () => {
  test("trust refusal envelope: ok=false, exitCode=2, error UNTRUSTED_PROJECT, planned commands", async () => {
    const root = makeProject({ command: "./evil.sh" });
    writeEvilScript(root, "PWNED_MARKER.txt");
    try {
      const { stdout, exit } = await runTest(root, { module: "M-A", format: "json" });
      expect(exit).toBe(2);
      const envelope = JSON.parse(stdout);
      expect(envelope.ok).toBe(false);
      expect(envelope.exitCode).toBe(2);
      expect(envelope.error.code).toBe("UNTRUSTED_PROJECT");
      expect(envelope.data.modules[0].command).toBe("./evil.sh");
      expect(markerExists(root, "PWNED_MARKER.txt")).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("successful JSON run after trust: ok=true, exitCode=0, authorization via trust", async () => {
    const root = makeProject({ command: "true" });
    try {
      await runTrust(root);
      const { stdout, exit } = await runTest(root, { module: "M-A", format: "json" });
      expect(exit).toBe(0);
      const envelope = JSON.parse(stdout);
      expect(envelope.ok).toBe(true);
      expect(envelope.exitCode).toBe(0);
      expect(envelope.data.summary).toEqual({ total: 1, failed: 0 });
      expect(envelope.data.authorization.via).toBe("trust");
      expect(envelope.data.modules[0].source).toBe("verification");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("verify JSON trust refusal stays an envelope (no raw error text)", async () => {
    const root = makeProject();
    try {
      const { stdout, exit } = await runVerify(root, { format: "json" });
      expect(exit).toBe(2);
      const envelope = JSON.parse(stdout);
      expect(envelope.error.code).toBe("UNTRUSTED_PROJECT");
      expect(envelope.data.planned.length).toBe(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
