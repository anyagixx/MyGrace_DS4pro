import { describe, test, expect } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildContextTable } from "../src/grace-context";

describe("buildContextTable", () => {
  test("returns the operations with line counts", () => {
    const root = mkdtempSync(join(tmpdir(), "mygrace-ctx-"));
    mkdirSync(join(root, "docs", "modules"), { recursive: true });
    mkdirSync(join(root, "docs", "plans"), { recursive: true });
    mkdirSync(join(root, "docs", "verification"), { recursive: true });
    writeFileSync(join(root, "docs", "graph-index.xml"), `<GraphIndex project="T" version="1.0.0">\n  <M-A NAME="A" TYPE="T" STATUS="done" />\n</GraphIndex>\n`);
    writeFileSync(join(root, "docs", "plan-index.xml"), `<PlanIndex project="T" version="1.0.0">\n</PlanIndex>\n`);
    writeFileSync(join(root, "docs", "verification-index.xml"), `<VerificationIndex project="T" version="1.0.0">\n</VerificationIndex>\n`);
    writeFileSync(join(root, "docs", "modules", "M-A.xml"), "<M-A></M-A>\n");
    try {
      const t = buildContextTable(root);
      expect(t.project).toBe(root);
      expect(t.modules).toBe(1);
      expect(t.operations.length).toBe(4);
      for (const op of t.operations) {
        expect(typeof op.name).toBe("string");
        expect(typeof op.lines).toBe("number");
        expect(op.lines).toBeGreaterThan(0);
      }
      expect(t.operations[0].lines).toBeGreaterThan(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
