import { describe, test, expect } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  compactOutput,
  inspectCheckCommand,
  parseCheckCommand,
  parseTestFiles,
  runModuleTests,
  tokenizeCommand,
  writeTrustRecord,
  checkTrust,
} from "../src/grace-test";
import { UsageError } from "../src/grace-errors";

const GRAPH_INDEX = `<GraphIndex project="T" version="1.0.0">\n  <M-A NAME="A" TYPE="T" STATUS="done" />\n</GraphIndex>\n`;

function makeProject(moduleContent: string, verContent: string | null, config?: Record<string, unknown>): string {
  const root = mkdtempSync(join(tmpdir(), "mygrace-test-"));
  mkdirSync(join(root, "docs", "modules"), { recursive: true });
  mkdirSync(join(root, "docs", "verification"), { recursive: true });
  writeFileSync(join(root, "docs", "graph-index.xml"), GRAPH_INDEX);
  writeFileSync(join(root, "docs", "modules", "M-A.xml"), moduleContent);
  if (verContent !== null) writeFileSync(join(root, "docs", "verification", "V-M-A.xml"), verContent);
  if (config !== undefined) writeFileSync(join(root, "mygrace.config.json"), JSON.stringify(config));
  return root;
}

const MODULE = `<M-A NAME="A" TYPE="T" STATUS="done"><contract><purpose>Do A</purpose><path>src/a.ts</path></contract></M-A>`;
const VERIFICATION = `<V-M-A MODULE="M-A" PRIORITY="high" STATUS="pending"><test-files><file>x.test.ts</file></test-files><module-checks><check-1>true</check-1></module-checks></V-M-A>`;

describe("parseTestFiles", () => {
  test("extracts <file> entries from verification content", () => {
    expect(parseTestFiles("<test-files><file>src/a.test.ts</file><file>src/b.test.ts</file></test-files>")).toEqual([
      "src/a.test.ts",
      "src/b.test.ts",
    ]);
  });
  test("returns [] for missing/empty content", () => {
    expect(parseTestFiles(null)).toEqual([]);
    expect(parseTestFiles("<test-files/>")).toEqual([]);
  });
  test("rejects malformed XML with a typed error (no silent regex pass)", () => {
    expect(() => parseTestFiles("<test-files><file>x.test.ts</test-files>")).toThrow();
  });
});

describe("parseCheckCommand", () => {
  test("first check-N wins", () => {
    expect(parseCheckCommand("<module-checks><check-1>bun test</check-1><check-2>echo ok</check-2></module-checks>")).toBe("bun test");
  });
  test("numeric order, not document order", () => {
    expect(parseCheckCommand("<module-checks><check-2>second</check-2><check-1>first</check-1></module-checks>")).toBe("first");
  });
  test("defaults to bun test", () => {
    expect(parseCheckCommand("<module-checks/>")).toBe("bun test");
    expect(parseCheckCommand("<contract></contract>")).toBe("bun test");
    expect(parseCheckCommand(null)).toBe("bun test");
  });
  test("honours an explicit fallback (config testRunner)", () => {
    expect(parseCheckCommand("<contract></contract>", "pytest -q")).toBe("pytest -q");
  });
  test("does not execute anything from the XML (pure data extraction)", () => {
    expect(parseCheckCommand('<module-checks><check-1>sh -c "touch /tmp/x"</check-1></module-checks>')).toBe('sh -c "touch /tmp/x"');
  });
});

describe("compactOutput", () => {
  test("keeps summary + failure lines, drops chatter", () => {
    const out = "  5 pass\n  2 fail\n [fail] auth: rejects bad token\n error: expected true\n";
    const compact = compactOutput(out);
    expect(compact).toContain("2 fail");
    expect(compact).toContain("auth: rejects bad token");
    expect(compact).toContain("error: expected true");
  });
  test("falls back to first lines when nothing matches", () => {
    const compact = compactOutput("  hello\n\n  world");
    expect(compact).toContain("hello");
    expect(compact).toContain("world");
  });
  test("strips ANSI escapes", () => {
    expect(compactOutput("\u001b[31m  0 fail\u001b[0m")).toBe("0 fail");
  });
});

describe("tokenizeCommand", () => {
  test("splits on whitespace and honours quotes", () => {
    expect(tokenizeCommand("bun test src/a.test.ts")).toEqual(["bun", "test", "src/a.test.ts"]);
    expect(tokenizeCommand('bun test --grep "auth succeeds"')).toEqual(["bun", "test", "--grep", "auth succeeds"]);
    expect(tokenizeCommand("echo 'single quoted $HOME'")).toEqual(["echo", "single quoted $HOME"]);
  });
  test("supports escapes outside quotes", () => {
    expect(tokenizeCommand("echo a\\ b")).toEqual(["echo", "a b"]);
  });
  test("never invents a shell: pipes are just characters in one token", () => {
    expect(tokenizeCommand("echo hi | tee")).toEqual(["echo", "hi", "|", "tee"]);
  });
  test("unterminated quote is a UsageError", () => {
    expect(() => tokenizeCommand('echo "oops')).toThrow(UsageError);
  });
  test("empty command yields no tokens", () => {
    expect(tokenizeCommand("   ")).toEqual([]);
  });
});

describe("inspectCheckCommand", () => {
  test("plain project commands are argv-safe", () => {
    expect(inspectCheckCommand("bun test src/a.test.ts").requiresShellOptIn).toBe(false);
    expect(inspectCheckCommand("pytest -q tests/").requiresShellOptIn).toBe(false);
  });
  test("shell metacharacters require the explicit opt-in", () => {
    expect(inspectCheckCommand("echo hi; touch pwned").requiresShellOptIn).toBe(true);
    expect(inspectCheckCommand("echo hi && touch pwned").requiresShellOptIn).toBe(true);
    expect(inspectCheckCommand("echo $(id)").requiresShellOptIn).toBe(true);
  });
  test("shell interpreters require the explicit opt-in (sh -c)", () => {
    expect(inspectCheckCommand("sh -c 'true'").requiresShellOptIn).toBe(true);
    expect(inspectCheckCommand("/bin/bash -c 'true'").requiresShellOptIn).toBe(true);
    expect(inspectCheckCommand("pwsh -Command true").requiresShellOptIn).toBe(true);
  });
});

describe("runModuleTests — canonical contract + trust gate", () => {
  test("canonical docs/verification <module-checks> wins over the deprecated module file", () => {
    const root = makeProject(
      `<M-A><module-checks><check-1>false</check-1></module-checks></M-A>`,
      `<V-M-A><test-files><file>x.test.ts</file></test-files><module-checks><check-1>true</check-1></module-checks></V-M-A>`
    );
    try {
      writeTrustRecord(root);
      const result = runModuleTests(root, "M-A");
      expect(result.ok).toBe(true);
      expect(result.source).toBe("verification");
      expect(result.command).toBe("true");
      expect(result.files).toEqual(["x.test.ts"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("module-file <module-checks> still works as a deprecated fallback", () => {
    const root = makeProject(
      `<M-A><module-checks><check-1>true</check-1></module-checks></M-A>`,
      `<V-M-A><test-files><file>x.test.ts</file></test-files></V-M-A>`
    );
    try {
      writeTrustRecord(root);
      const result = runModuleTests(root, "M-A");
      expect(result.ok).toBe(true);
      expect(result.source).toBe("module");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("untrusted project is refused (no execution) and returns a stable code", () => {
    const root = makeProject(MODULE, VERIFICATION);
    try {
      const result = runModuleTests(root, "M-A");
      expect(result.ok).toBe(false);
      expect(result.refused).toBe(true);
      expect(result.error?.code).toBe("UNTRUSTED_PROJECT");
      expect(result.output).toContain("mygrace trust");
      expect(existsSync(join(root, ".mygrace", "trust.json"))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("executes after a trust record is written", () => {
    const root = makeProject(MODULE, VERIFICATION);
    try {
      writeTrustRecord(root);
      expect(checkTrust(root).trusted).toBe(true);
      const result = runModuleTests(root, "M-A");
      expect(result.ok).toBe(true);
      expect(result.error).toBeUndefined();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("config.allowCommands:true authorizes execution without a trust record", () => {
    const root = makeProject(MODULE, VERIFICATION, { allowCommands: true });
    try {
      const result = runModuleTests(root, "M-A");
      expect(result.ok).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("explicit allowCommands option authorizes execution without trust", () => {
    const root = makeProject(MODULE, VERIFICATION);
    try {
      const result = runModuleTests(root, "M-A", { allowCommands: true });
      expect(result.ok).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("reports error when no test-files defined (does not execute)", () => {
    const root = makeProject(`<M-A><module-checks><check-1>true</check-1></module-checks></M-A>`, `<V-M-A></V-M-A>`);
    try {
      const result = runModuleTests(root, "M-A", { allowCommands: true });
      expect(result.ok).toBe(false);
      expect(result.error?.code).toBe("NO_TEST_FILES");
      expect(result.output).toContain("no <test-files>");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("missing module file is a readable finding, not a crash", () => {
    const root = makeProject(MODULE, VERIFICATION);
    try {
      const result = runModuleTests(root, "M-MISSING", { allowCommands: true });
      expect(result.ok).toBe(false);
      expect(result.error?.code).toBe("MODULE_FILE_MISSING");
      expect(result.output).toContain("not found");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("malformed module XML is a typed XML_INVALID finding", () => {
    const root = makeProject("<M-A><contract></M-A>", VERIFICATION);
    try {
      const result = runModuleTests(root, "M-A", { allowCommands: true });
      expect(result.ok).toBe(false);
      expect(result.error?.code).toBe("XML_INVALID");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("unterminated quote in a declared command is a finding, not a crash", () => {
    const root = makeProject(
      MODULE,
      `<V-M-A><test-files><file>x.test.ts</file></test-files><module-checks><check-1>echo "oops</check-1></module-checks></V-M-A>`
    );
    try {
      const result = runModuleTests(root, "M-A", { allowCommands: true });
      expect(result.ok).toBe(false);
      expect(result.error?.code).toBe("CHECK_COMMAND_INVALID");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("test-file entries that look like flags are rejected (flag-injection guard)", () => {
    const root = makeProject(
      MODULE,
      `<V-M-A><test-files><file>-c</file></test-files><module-checks><check-1>true</check-1></module-checks></V-M-A>`
    );
    try {
      const result = runModuleTests(root, "M-A", { allowCommands: true });
      expect(result.ok).toBe(false);
      expect(result.error?.code).toBe("USAGE");
      expect(result.output).toContain('starting with "-"');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("test-file traversal is rejected", () => {
    const root = makeProject(
      MODULE,
      `<V-M-A><test-files><file>../../etc/passwd</file></test-files><module-checks><check-1>true</check-1></module-checks></V-M-A>`
    );
    try {
      const result = runModuleTests(root, "M-A", { allowCommands: true });
      expect(result.ok).toBe(false);
      expect(result.error?.code).toBe("USAGE");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("module ids with traversal are rejected before any filesystem access (ADR-4)", () => {
    const root = makeProject(MODULE, VERIFICATION);
    try {
      expect(() => runModuleTests(root, "../../etc/passwd", { allowCommands: true })).toThrow(UsageError);
      expect(() => runModuleTests(root, "M-../../etc/passwd", { allowCommands: true })).toThrow(UsageError);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("shell metacharacter commands are refused under trust unless --allow-commands", () => {
    const root = makeProject(
      MODULE,
      `<V-M-A><test-files><file>x.test.ts</file></test-files><module-checks><check-1>echo hi &amp;&amp; true</check-1></module-checks></V-M-A>`
    );
    try {
      writeTrustRecord(root);
      const refused = runModuleTests(root, "M-A");
      expect(refused.ok).toBe(false);
      expect(refused.error?.code).toBe("SHELL_COMMAND_REFUSED");
      const allowed = runModuleTests(root, "M-A", { allowCommands: true });
      expect(allowed.ok).toBe(true); // executed as argv: echo, 'hi', '&&', 'true'
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("sh -c is only allowed behind the explicit --allow-commands opt-in", () => {
    const root = makeProject(
      MODULE,
      `<V-M-A><test-files><file>x.test.ts</file></test-files><module-checks><check-1>sh -c "exit 0"</check-1></module-checks></V-M-A>`
    );
    try {
      writeTrustRecord(root);
      const refused = runModuleTests(root, "M-A");
      expect(refused.ok).toBe(false);
      expect(refused.error?.code).toBe("SHELL_COMMAND_REFUSED");
      expect(refused.output).toContain("shell interpreter");
      const allowed = runModuleTests(root, "M-A", { allowCommands: true });
      expect(allowed.ok).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("command output is captured and compacted only when asked", () => {
    const root = makeProject(
      MODULE,
      `<V-M-A><test-files><file>x.test.ts</file></test-files><module-checks><check-1>echo hello-from-check</check-1></module-checks></V-M-A>`
    );
    try {
      writeTrustRecord(root);
      const full = runModuleTests(root, "M-A");
      expect(full.output).toContain("hello-from-check");
      const compact = runModuleTests(root, "M-A", { compact: true });
      expect(compact.ok).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

// Keep chmodSync imported for future platform tests without failing the typecheck.
void chmodSync;
