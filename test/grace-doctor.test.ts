import { describe, test, expect } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildDoctorReport } from "../src/grace-doctor";

function makeTempProject(entries: string[], files: Record<string, string>) {
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

describe("buildDoctorReport", () => {
  test("clean project: project ok, counts match", () => {
    const root = makeTempProject([`<M-AUTH NAME="A" TYPE="CORE_LOGIC" STATUS="done" />`], {
      "M-AUTH.xml": "<M-AUTH NAME=\"A\" STATUS=\"done\">\n</M-AUTH>",
    });
    try {
      const r = buildDoctorReport(root);
      expect(r.project.ok).toBe(true);
      expect(r.project.status?.modules).toBe(1);
      expect(r.project.status?.errors).toBe(0);
      expect(r.errors).toBeGreaterThanOrEqual(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("broken project: project.ok false and errors >= 1", () => {
    const root = makeTempProject([`<M-ORPHAN NAME="O" TYPE="UTILITY" STATUS="pending" />`], {});
    try {
      const r = buildDoctorReport(root);
      expect(r.project.ok).toBe(false);
      expect(r.errors).toBeGreaterThanOrEqual(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("no docs/graph-index.xml: project.ok false", () => {
    const root = mkdtempSync(join(tmpdir(), "mygrace-doctor-nodocs-"));
    try {
      const r = buildDoctorReport(root);
      expect(r.project.ok).toBe(false);
      expect(r.project.error).toMatch(/graph-index/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("all checks are well-formed; errors/warnings are numbers", () => {
    const root = makeTempProject([`<M-AUTH NAME="A" TYPE="CORE_LOGIC" STATUS="done" />`], {});
    try {
      const r = buildDoctorReport(root);
      for (const key of ["dsh", "rtk", "caveman", "skills", "mcp", "panel", "devTools"] as const) {
        expect(typeof r[key].name).toBe("string");
        expect(typeof r[key].detail).toBe("string");
      }
      expect(typeof r.errors).toBe("number");
      expect(typeof r.warnings).toBe("number");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
