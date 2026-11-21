import { describe, test, expect } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { depTable, packetCommand, focusCommand } from "../src/grace-packet";

function makeProject() {
  const root = mkdtempSync(join(tmpdir(), "mygrace-packet-"));
  mkdirSync(join(root, "docs", "modules"), { recursive: true });
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
  return root;
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
});

describe("packetCommand", () => {
  test("prints contract + verification + deps", async () => {
    const root = makeProject();
    const logs: string[] = [];
    const orig = console.log;
    console.log = ((m?: unknown) => logs.push(String(m))) as typeof console.log;
    try {
      await packetCommand.run!({ args: { id: "M-A", path: root } } as any);
    } finally {
      console.log = orig;
    }
    const out = logs.join("");
    expect(out).toContain("=== PACKET M-A");
    expect(out).toContain("Do A things");
    expect(out).toContain("- M-B — src/b/index.ts (done)");
    expect(out).toContain("## Contract");
    expect(out).toContain("## Dependencies");
  });
});

describe("focusCommand", () => {
  test("prints the minimal working set (contract + deps, no verification)", async () => {
    const root = makeProject();
    const logs: string[] = [];
    const orig = console.log;
    console.log = ((m?: unknown) => logs.push(String(m))) as typeof console.log;
    try {
      await focusCommand.run!({ args: { id: "M-A", path: root } } as any);
    } finally {
      console.log = orig;
    }
    const out = logs.join("");
    expect(out).toContain("=== FOCUS M-A — wip ===");
    expect(out).toContain("Status: wip");
    expect(out).toContain("Contract: Do A things — src/a/index.ts");
    expect(out).toContain("Deps: M-B (done)");
    expect(out).not.toContain("## Verification");
    expect(out).not.toContain("## Contract");
  });
});
