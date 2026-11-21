import { describe, test, expect } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseTestFiles, parseCheckCommand, compactOutput, runModuleTests } from "../src/grace-test";

describe("parseTestFiles", () => {
  test("extracts <file> entries from verification content", () => {
    expect(parseTestFiles("<test-files><file>src/a.test.ts</file><file>src/b.test.ts</file></test-files>"))
      .toEqual(["src/a.test.ts", "src/b.test.ts"]);
  });
  test("returns [] for missing/empty content", () => {
    expect(parseTestFiles(null)).toEqual([]);
    expect(parseTestFiles("<test-files/>")).toEqual([]);
  });
});

describe("parseCheckCommand", () => {
  test("first check-N wins", () => {
    expect(parseCheckCommand("<module-checks><check-1>bun test</check-1><check-2>echo ok</check-2></module-checks>"))
      .toBe("bun test");
  });
  test("defaults to bun test", () => {
    expect(parseCheckCommand("<module-checks/>")).toBe("bun test");
    expect(parseCheckCommand("<contract></contract>")).toBe("bun test");
  });
});

describe("compactOutput", () => {
  test("keeps summary + failure lines, drops chatter", () => {
    const out = "  5 pass\n  2 fail\n [fail] auth: rejects bad token\n error: expected true\n";
    const c = compactOutput(out);
    expect(c).toContain("2 fail");
    expect(c).toContain("auth: rejects bad token");
    expect(c).toContain("error: expected true");
  });
  test("falls back to first lines when nothing matches", () => {
    const c = compactOutput("  hello\n\n  world");
    expect(c).toContain("hello");
    expect(c).toContain("world");
  });
  test("strips ANSI escapes", () => {
    const c = compactOutput("[31m  0 fail[0m");
    expect(c).toBe("0 fail");
  });
});

describe("runModuleTests", () => {
  function makeProject(moduleContent: string, verContent: string | null) {
    const root = mkdtempSync(join(tmpdir(), "mygrace-test-"));
    mkdirSync(join(root, "docs", "modules"), { recursive: true });
    mkdirSync(join(root, "docs", "verification"), { recursive: true });
    writeFileSync(join(root, "docs", "graph-index.xml"), `<GraphIndex project="T" version="1.0.0">\n  <M-A NAME="A" TYPE="T" STATUS="done" />\n</GraphIndex>\n`);
    writeFileSync(join(root, "docs", "modules", "M-A.xml"), moduleContent);
    if (verContent !== null) writeFileSync(join(root, "docs", "verification", "V-M-A.xml"), verContent);
    return root;
  }

  test("runs the scoped command and reports ok", () => {
    const root = makeProject(
      `<M-A><module-checks><check-1>true</check-1></module-checks></M-A>`,
      `<V-M-A><test-files><file>x.test.ts</file></test-files></V-M-A>`
    );
    try {
      const r = runModuleTests(root, "M-A");
      expect(r.ok).toBe(true);
      expect(r.files).toEqual(["x.test.ts"]);
      expect(r.module).toBe("M-A");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("reports error when no test-files defined", () => {
    const root = makeProject(`<M-A><module-checks><check-1>true</check-1></module-checks></M-A>`, null);
    try {
      const r = runModuleTests(root, "M-A");
      expect(r.ok).toBe(false);
      expect(r.output).toContain("no <test-files>");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
