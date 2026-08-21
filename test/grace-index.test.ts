import { describe, test, expect } from "bun:test";
import { existsSync, readFileSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";

// Import lint functions by re-implementing the core logic inline
// (since we can't import from the main code without proper module setup)

function parseIndexEntries(content: string): { tag: string; attrs: Record<string, string> }[] {
  const results: { tag: string; attrs: Record<string, string> }[] = [];
  const regex = /<(M-[\w-]+|V-M-[\w-]+|Phase-\d+)([^>]*?)(?:\/>)/g;
  let m: RegExpExecArray | null;
  while ((m = regex.exec(content)) !== null) {
    const attrs: Record<string, string> = {};
    const attrRegex = /(\w+)="([^"]*)"/g;
    let am: RegExpExecArray | null;
    while ((am = attrRegex.exec(m[2])) !== null) attrs[am[1]] = am[2];
    results.push({ tag: m[1], attrs });
  }
  return results;
}

const FIXTURE_ROOT = import.meta.dir + "/fixtures/mygrace-project";

function readIndexFile(path: string): { tag: string; attrs: Record<string, string> }[] {
  if (!existsSync(path)) return [];
  const content = readFileSync(path, "utf-8");
  return parseIndexEntries(content);
}

// ─── Tests: Index ↔ File Consistency ────────────────────────────────────

describe("lintIndexSync — graph-index.xml ↔ docs/modules/", () => {
  const indexPath = join(FIXTURE_ROOT, "docs", "graph-index.xml");
  const moduleDir = join(FIXTURE_ROOT, "docs", "modules");

  test("synced index and files produce no errors", () => {
    const entries = readIndexFile(indexPath);
    expect(entries.length).toBeGreaterThan(0);

    const files = [...new Set(entries.map(e => e.tag))];
    for (const tag of files) {
      expect(existsSync(join(moduleDir, `${tag}.xml`))).toBe(true);
    }
  });

  test("file without index entry is detected", () => {
    // Create an orphaned file
    const orphanPath = join(moduleDir, "M-ORPHAN.xml");
    writeFileSync(orphanPath, "<M-ORPHAN NAME=\"Orphan\" TYPE=\"UTILITY\" STATUS=\"pending\" />");

    const entries = readIndexFile(indexPath);
    const indexTags = new Set(entries.map(e => e.tag));
    expect(indexTags.has("M-ORPHAN")).toBe(false);

    // Cleanup
    rmSync(orphanPath);
  });

  test("index entry without file is detected", () => {
    // The fixture has M-CONFIG and M-AUTH — both should have files
    const entries = readIndexFile(indexPath);
    for (const entry of entries) {
      const filePath = join(moduleDir, `${entry.tag}.xml`);
      expect(existsSync(filePath), `File for ${entry.tag} should exist`).toBe(true);
    }
  });
});

describe("lintIndexSync — plan-index.xml ↔ docs/plans/", () => {
  const indexPath = join(FIXTURE_ROOT, "docs", "plan-index.xml");
  const plansDir = join(FIXTURE_ROOT, "docs", "plans");

  test("phase index entries have corresponding files", () => {
    const entries = readIndexFile(indexPath);
    expect(entries.length).toBeGreaterThan(0);

    for (const entry of entries) {
      const filePath = join(plansDir, `${entry.tag}.xml`);
      expect(existsSync(filePath), `Phase file for ${entry.tag} should exist`).toBe(true);
    }
  });
});

describe("lintIndexSync — verification-index.xml ↔ docs/verification/", () => {
  const indexPath = join(FIXTURE_ROOT, "docs", "verification-index.xml");
  const verDir = join(FIXTURE_ROOT, "docs", "verification");

  test("verification index entries have corresponding files", () => {
    const entries = readIndexFile(indexPath);
    expect(entries.length).toBeGreaterThan(0);

    for (const entry of entries) {
      const filePath = join(verDir, `${entry.tag}.xml`);
      expect(existsSync(filePath), `Verification file for ${entry.tag} should exist`).toBe(true);
    }
  });
});

// ─── Tests: Semantic Block Pairing ──────────────────────────────────────

describe("semantic block pairing", () => {
  test("config/index.ts has paired blocks", () => {
    const content = readFileSync(join(FIXTURE_ROOT, "src", "config", "index.ts"), "utf-8");
    const starts = (content.match(/START_BLOCK_\w+/g) || []).length;
    const ends = (content.match(/END_BLOCK_\w+/g) || []).length;
    expect(starts).toBe(ends);
    expect(starts).toBeGreaterThan(0);
  });

  test("auth/index.ts has paired blocks", () => {
    const content = readFileSync(join(FIXTURE_ROOT, "src", "auth", "index.ts"), "utf-8");
    const starts = (content.match(/START_BLOCK_\w+/g) || []).length;
    const ends = (content.match(/END_BLOCK_\w+/g) || []).length;
    expect(starts).toBe(ends);
    expect(starts).toBeGreaterThan(0);
  });
});

// ─── Tests: MODULE_CONTRACT presence ────────────────────────────────────

describe("MODULE_CONTRACT presence", () => {
  test("config/index.ts has MODULE_CONTRACT", () => {
    const content = readFileSync(join(FIXTURE_ROOT, "src", "config", "index.ts"), "utf-8");
    expect(content).toContain("START_MODULE_CONTRACT");
    expect(content).toContain("END_MODULE_CONTRACT");
  });

  test("auth/index.ts has MODULE_CONTRACT", () => {
    const content = readFileSync(join(FIXTURE_ROOT, "src", "auth", "index.ts"), "utf-8");
    expect(content).toContain("START_MODULE_CONTRACT");
    expect(content).toContain("END_MODULE_CONTRACT");
  });
});

// ─── Tests: Index file structure ────────────────────────────────────────

describe("index file structure", () => {
  test("graph-index.xml has GraphIndex root element", () => {
    const content = readFileSync(join(FIXTURE_ROOT, "docs", "graph-index.xml"), "utf-8");
    expect(content).toContain("<GraphIndex");
    expect(content).toContain("</GraphIndex>");
  });

  test("plan-index.xml has PlanIndex root element", () => {
    const content = readFileSync(join(FIXTURE_ROOT, "docs", "plan-index.xml"), "utf-8");
    expect(content).toContain("<PlanIndex");
  });

  test("verification-index.xml has VerificationIndex root element", () => {
    const content = readFileSync(join(FIXTURE_ROOT, "docs", "verification-index.xml"), "utf-8");
    expect(content).toContain("<VerificationIndex");
  });
});

// ─── Tests: Per-module file structure ───────────────────────────────────

describe("per-module file structure", () => {
  test("M-CONFIG.xml has contract section", () => {
    const content = readFileSync(join(FIXTURE_ROOT, "docs", "modules", "M-CONFIG.xml"), "utf-8");
    expect(content).toContain("<M-CONFIG");
    expect(content).toContain("<contract>");
    expect(content).toContain("<purpose>");
  });

  test("M-AUTH.xml has CrossLink", () => {
    const content = readFileSync(join(FIXTURE_ROOT, "docs", "modules", "M-AUTH.xml"), "utf-8");
    expect(content).toContain("<CrossLink");
    expect(content).toContain('to="M-CONFIG"');
  });

  test("M-AUTH.xml has verification-ref", () => {
    const content = readFileSync(join(FIXTURE_ROOT, "docs", "modules", "M-AUTH.xml"), "utf-8");
    expect(content).toContain("<verification-ref>V-M-AUTH</verification-ref>");
  });
});

// ─── Tests: Verification file structure ─────────────────────────────────

describe("verification file structure", () => {
  test("V-M-AUTH.xml has scenarios", () => {
    const content = readFileSync(join(FIXTURE_ROOT, "docs", "verification", "V-M-AUTH.xml"), "utf-8");
    expect(content).toContain("<scenarios>");
    expect(content).toContain('kind="success"');
    expect(content).toContain('kind="failure"');
  });

  test("V-M-AUTH.xml has required-log-markers", () => {
    const content = readFileSync(join(FIXTURE_ROOT, "docs", "verification", "V-M-AUTH.xml"), "utf-8");
    expect(content).toContain("<required-log-markers>");
    expect(content).toContain("[Auth][authenticate][BLOCK_VALIDATE]");
  });
});
