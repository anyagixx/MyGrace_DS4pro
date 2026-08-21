import { describe, test, expect } from "bun:test";
import { existsSync, readFileSync, mkdirSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findProjectRoot, parseIndexEntries } from "../src/grace-common";
import { lintIndexSync, lintMarkup, lintVerificationRefs, collectLintIssues } from "../src/grace-lint";
import { buildToolCommand } from "../src/grace-mcp-commands";

const FIXTURE_ROOT = import.meta.dir + "/fixtures/mygrace-project";

// ─── findProjectRoot ────────────────────────────────────────────────────

describe("findProjectRoot", () => {
  test("resolves the project root from a nested directory", () => {
    expect(findProjectRoot(join(FIXTURE_ROOT, "docs", "modules"))).toBe(FIXTURE_ROOT);
  });

  test("resolves the project root from the root itself", () => {
    expect(findProjectRoot(FIXTURE_ROOT)).toBe(FIXTURE_ROOT);
  });

  test("fails fast on a non-MyGRACE directory (regression: no infinite loop)", () => {
    const outside = mkdtempSync(join(tmpdir(), "mygrace-noproject-"));
    try {
      const started = Date.now();
      expect(() => findProjectRoot(outside)).toThrow(/MyGRACE project not found/);
      expect(Date.now() - started).toBeLessThan(2000);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  }, 3000);
});

// ─── parseIndexEntries ──────────────────────────────────────────────────

describe("parseIndexEntries", () => {
  test("parses self-closing entries from an index file", () => {
    const content = readFileSync(join(FIXTURE_ROOT, "docs", "graph-index.xml"), "utf-8");
    const entries = parseIndexEntries(content);
    expect(entries.map((e) => e.tag).sort()).toEqual(["M-AUTH", "M-CONFIG"]);
    expect(entries.find((e) => e.tag === "M-AUTH")?.attrs.DEPENDS).toBe("M-CONFIG");
  });

  test("ignores commented template examples", () => {
    const content = [
      "<GraphIndex project=\"X\" version=\"1.0.0\">",
      "  <!-- <M-XXX NAME=\"Example\" TYPE=\"UTILITY\" STATUS=\"pending\" PATH=\"src/x.ts\" /> -->",
      "  <M-AUTH NAME=\"A\" TYPE=\"CORE_LOGIC\" STATUS=\"wip\" />",
      "</GraphIndex>",
    ].join("\n");
    const entries = parseIndexEntries(content);
    expect(entries.map((e) => e.tag)).toEqual(["M-AUTH"]);
  });

  test("parses paired tags too", () => {
    const content = "<V-M-AUTH MODULE=\"M-AUTH\"><scenarios/></V-M-AUTH>";
    expect(parseIndexEntries(content).map((e) => e.tag)).toEqual(["V-M-AUTH"]);
  });
});

// ─── lintIndexSync ──────────────────────────────────────────────────────

function makeTempProject(entries: string[], files: Record<string, string>) {
  const root = mkdtempSync(join(tmpdir(), "mygrace-lint-"));
  mkdirSync(join(root, "docs", "modules"), { recursive: true });
  writeFileSync(
    join(root, "docs", "graph-index.xml"),
    `<GraphIndex project="T" version="1.0.0">\n${entries.join("\n")}\n</GraphIndex>\n`
  );
  for (const [name, body] of Object.entries(files)) {
    writeFileSync(join(root, "docs", "modules", name), body);
  }
  return root;
}

describe("lintIndexSync", () => {
  test("synced index and files produce no issues", () => {
    const root = makeTempProject(
      [`<M-AUTH NAME="A" TYPE="CORE_LOGIC" STATUS="wip" />`],
      { "M-AUTH.xml": `<M-AUTH NAME="A" STATUS="wip">\n</M-AUTH>` }
    );
    try {
      expect(lintIndexSync(root, "graph-index.xml", "modules", "M-")).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("detects an orphaned index entry (no file)", () => {
    const root = makeTempProject(
      [`<M-ORPHAN NAME="O" TYPE="UTILITY" STATUS="pending" />`],
      {}
    );
    try {
      const issues = lintIndexSync(root, "graph-index.xml", "modules", "M-");
      expect(issues.some((i) => i.severity === "error" && i.message.includes("Orphaned index entry: M-ORPHAN"))).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("detects a file missing from the index", () => {
    const root = makeTempProject([], { "M-EXTRA.xml": "<M-EXTRA />" });
    try {
      const issues = lintIndexSync(root, "graph-index.xml", "modules", "M-");
      expect(issues.some((i) => i.severity === "error" && i.message.includes("Missing index entry: M-EXTRA"))).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("warns on STATUS drift between index and file", () => {
    const root = makeTempProject(
      [`<M-AUTH NAME="A" TYPE="CORE_LOGIC" STATUS="wip" />`],
      { "M-AUTH.xml": `<M-AUTH NAME="A" STATUS="done">\n</M-AUTH>` }
    );
    try {
      const issues = lintIndexSync(root, "graph-index.xml", "modules", "M-");
      expect(issues.some((i) => i.severity === "warning" && i.message.includes("STATUS drift: M-AUTH"))).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("reports a missing index file as an error", () => {
    const root = mkdtempSync(join(tmpdir(), "mygrace-nodocs-"));
    try {
      const issues = lintIndexSync(root, "graph-index.xml", "modules", "M-");
      expect(issues.some((i) => i.severity === "error" && i.message.includes("Missing docs/graph-index.xml"))).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

// ─── lintMarkup / lintVerificationRefs on the fixture ───────────────────

describe("source markup on the fixture", () => {
  test("fixture sources have paired semantic blocks and no lint issues", () => {
    expect(lintMarkup(FIXTURE_ROOT)).toEqual([]);
  });

  test("fixture verification references resolve", () => {
    expect(lintVerificationRefs(FIXTURE_ROOT)).toEqual([]);
  });
});

// ─── collectLintIssues ──────────────────────────────────────────────────

describe("collectLintIssues", () => {
  test("allowMissingDocs skips document checks on a bare directory", () => {
    const root = mkdtempSync(join(tmpdir(), "mygrace-bare-"));
    try {
      expect(collectLintIssues(root, true)).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("without allowMissingDocs a bare directory reports missing indexes", () => {
    const root = mkdtempSync(join(tmpdir(), "mygrace-bare2-"));
    try {
      const issues = collectLintIssues(root, false);
      expect(issues.some((i) => i.severity === "error" && i.message.includes("Missing docs/graph-index.xml"))).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("a full project passes with zero issues", () => {
    expect(collectLintIssues(FIXTURE_ROOT, false)).toEqual([]);
  });
});

// ─── buildToolCommand (MCP mapping) ─────────────────────────────────────

describe("buildToolCommand", () => {
  test("mygrace_list_modules maps to module list with filters", () => {
    expect(
      buildToolCommand("mygrace_list_modules", { path: "/p", status: "wip", type: "CORE_LOGIC", format: "json" })
    ).toEqual(["module", "list", "--path", "/p", "--status", "wip", "--type", "CORE_LOGIC", "--format", "json"]);
  });

  test("mygrace_show_module maps to module show", () => {
    expect(buildToolCommand("mygrace_show_module", { id: "M-AUTH", path: "/p", withVerification: true }))
      .toEqual(["module", "show", "M-AUTH", "--path", "/p", "--with-verification"]);
  });

  test("mygrace_show_phase maps to phase show (regression: was module show --phase)", () => {
    expect(buildToolCommand("mygrace_show_phase", { name: "Phase-1", path: "/p" }))
      .toEqual(["phase", "show", "Phase-1", "--path", "/p"]);
  });

  test("mygrace_list_verifications maps to verification index with filters", () => {
    expect(buildToolCommand("mygrace_list_verifications", { path: "/p", priority: "high", format: "json" }))
      .toEqual(["verification", "index", "--path", "/p", "--priority", "high", "--format", "json"]);
  });

  test("mygrace_lint maps to lint", () => {
    expect(buildToolCommand("mygrace_lint", { path: "/p", format: "json", allowMissingDocs: true }))
      .toEqual(["lint", "--path", "/p", "--format", "json", "--allow-missing-docs"]);
  });

  test("mygrace_show_file maps to file show with --root (regression: was --path)", () => {
    expect(buildToolCommand("mygrace_show_file", { path: "src/a.ts", projectRoot: "/p", contracts: true, blocks: true }))
      .toEqual(["file", "show", "src/a.ts", "--root", "/p", "--contracts", "--blocks"]);
  });

  test("unknown tool names throw", () => {
    expect(() => buildToolCommand("mygrace_bogus", {})).toThrow(/Unknown tool/);
  });
});

// ─── Fixture structure (kept from the original suite) ───────────────────

describe("fixture structure", () => {
  test("plan index entries have corresponding files", () => {
    const entries = parseIndexEntries(readFileSync(join(FIXTURE_ROOT, "docs", "plan-index.xml"), "utf-8"));
    expect(entries.length).toBeGreaterThan(0);
    for (const entry of entries) {
      expect(existsSync(join(FIXTURE_ROOT, "docs", "plans", `${entry.tag}.xml`)), `Phase file for ${entry.tag} should exist`).toBe(true);
    }
  });

  test("verification index entries have corresponding files", () => {
    const entries = parseIndexEntries(readFileSync(join(FIXTURE_ROOT, "docs", "verification-index.xml"), "utf-8"));
    expect(entries.length).toBeGreaterThan(0);
    for (const entry of entries) {
      expect(existsSync(join(FIXTURE_ROOT, "docs", "verification", `${entry.tag}.xml`)), `Verification file for ${entry.tag} should exist`).toBe(true);
    }
  });
});
