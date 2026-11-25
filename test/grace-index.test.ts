import { describe, test, expect } from "bun:test";
import { existsSync, readFileSync, mkdirSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { findProjectRoot, parseIndexEntries } from "../src/grace-common";
import { lintIndexSync, lintMarkup, lintVerificationRefs, collectLintIssues } from "../src/grace-lint";
import { buildToolCommand } from "../src/grace-mcp-commands";
import { moduleListCmd, moduleFindCmd, moduleShowCmd } from "../src/grace-module";

const FIXTURE_ROOT = join(import.meta.dirname, "fixtures", "mygrace-project");
/** buildToolCommand resolves project roots; use the platform-native spelling. */
const P = resolve("/p");

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
      expect(issues.some((i) => i.code === "ORPHANED_INDEX_ENTRY" && i.file === "docs/graph-index.xml")).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("detects a file missing from the index", () => {
    const root = makeTempProject([], { "M-EXTRA.xml": "<M-EXTRA />" });
    try {
      const issues = lintIndexSync(root, "graph-index.xml", "modules", "M-");
      expect(issues.some((i) => i.severity === "error" && i.message.includes("Missing index entry: M-EXTRA"))).toBe(true);
      expect(issues.some((i) => i.code === "MISSING_INDEX_ENTRY" && i.file === "docs/modules/M-EXTRA.xml")).toBe(true);
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
      expect(issues.some((i) => i.code === "STATUS_DRIFT" && i.severity === "warning")).toBe(true);
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
  test("mygrace_show_module maps to module show", () => {
    expect(buildToolCommand("mygrace_show_module", { id: "M-AUTH", path: P, withVerification: true }))
      .toEqual(["inspect", "module", "show", "M-AUTH", "--path", P, "--with-verification"]);
  });

  test("mygrace_show_phase maps to phase show (regression: was module show --phase)", () => {
    expect(buildToolCommand("mygrace_show_phase", { name: "Phase-1", path: P }))
      .toEqual(["inspect", "phase", "show", "Phase-1", "--path", P]);
  });

  test("mygrace_list_verifications maps to verification index with filters", () => {
    expect(buildToolCommand("mygrace_list_verifications", { path: P, priority: "high", format: "json" }))
      .toEqual(["inspect", "verification", "index", "--path", P, "--priority", "high", "--format", "json"]);
  });

  test("mygrace_lint maps to lint", () => {
    expect(buildToolCommand("mygrace_lint", { path: P, format: "json", allowMissingDocs: true }))
      .toEqual(["lint", "--path", P, "--format", "json", "--allow-missing-docs"]);
  });

  test("mygrace_show_file maps to file show with --root (regression: was --path)", () => {
    expect(buildToolCommand("mygrace_show_file", { path: "src/a.ts", projectRoot: P, contracts: true, blocks: true }))
      .toEqual(["inspect", "file", "show", "src/a.ts", "--root", P, "--contracts", "--blocks"]);
  });

  test("mygrace_status maps to status --format json", () => {
    expect(buildToolCommand("mygrace_status", { path: P }))
      .toEqual(["status", "--path", P, "--format", "json"]);
  });

  test("mygrace_find_modules maps to module find with filters", () => {
    expect(
      buildToolCommand("mygrace_find_modules", { path: P, query: "auth", status: "wip", type: "CORE_LOGIC", format: "json" })
    ).toEqual(["inspect", "module", "find", "auth", "--path", P, "--status", "wip", "--type", "CORE_LOGIC", "--format", "json"]);
  });

  test("mygrace_find_modules without query omits the positional", () => {
    expect(buildToolCommand("mygrace_find_modules", { path: P })).toEqual(["inspect", "module", "find", "--path", P]);
  });

  test("mygrace_phase_index maps to phase index", () => {
    expect(buildToolCommand("mygrace_phase_index", { path: P })).toEqual(["inspect", "phase", "index", "--path", P]);
  });

  test("mygrace_doctor maps to doctor", () => {
    expect(buildToolCommand("mygrace_doctor", { path: P })).toEqual(["doctor", "--path", P]);
  });

  test("mygrace_context maps packet/focus/cost to the grouped CLI", () => {
    expect(buildToolCommand("mygrace_context", { mode: "packet", id: "M-AUTH", path: P }))
      .toEqual(["context", "packet", "M-AUTH", "--path", P]);
    expect(buildToolCommand("mygrace_context", { mode: "focus", id: "M-AUTH", path: P }))
      .toEqual(["context", "focus", "M-AUTH", "--path", P]);
    expect(buildToolCommand("mygrace_context", { mode: "cost", path: P }))
      .toEqual(["context", "cost", "--path", P, "--format", "json"]);
  });

  test("mygrace_verify maps to verify", () => {
    expect(buildToolCommand("mygrace_verify", { path: P, module: "M-AUTH" }))
      .toEqual(["verify", "--path", P, "--module", "M-AUTH"]);
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

// ─── moduleListCmd --type filter (R1 regression) ─────────────────────────

describe("moduleListCmd --type filter (R1)", () => {
  test("filters by TYPE attribute when --type is given", async () => {
    const root = makeTempProject(
      [`<M-A TYPE="CORE_LOGIC" STATUS="done" />`, `<M-B TYPE="UTILITY" STATUS="pending" />`],
      {}
    );
    const logs: string[] = [];
    const origLog = console.log;
    console.log = ((m?: unknown) => { logs.push(String(m)); }) as typeof console.log;
    try {
      await moduleListCmd.run!({ args: { path: root, type: "CORE_LOGIC", format: "json" } } as any);
    } finally {
      console.log = origLog;
    }
    const parsed = JSON.parse(logs.join(""));
    expect(parsed.map((m: { id: string }) => m.id)).toEqual(["M-A"]);
  });

  test("combines status and type filters", async () => {
    const root = makeTempProject(
      [`<M-A TYPE="CORE_LOGIC" STATUS="wip" />`, `<M-B TYPE="CORE_LOGIC" STATUS="done" />`],
      {}
    );
    const logs: string[] = [];
    const origLog = console.log;
    console.log = ((m?: unknown) => { logs.push(String(m)); }) as typeof console.log;
    try {
      await moduleListCmd.run!({ args: { path: root, status: "wip", type: "CORE_LOGIC", format: "json" } } as any);
    } finally {
      console.log = origLog;
    }
    const parsed = JSON.parse(logs.join(""));
    expect(parsed.map((m: { id: string }) => m.id)).toEqual(["M-A"]);
  });
});

describe("moduleFindCmd without query", () => {
  test("returns all modules", async () => {
    const root = makeTempProject(
      [`<M-A TYPE="CORE_LOGIC" STATUS="wip" />`, `<M-B TYPE="UTILITY" STATUS="pending" />`],
      {}
    );
    const logs: string[] = [];
    const origLog = console.log;
    console.log = ((m?: unknown) => { logs.push(String(m)); }) as typeof console.log;
    try {
      await moduleFindCmd.run!({ args: { path: root, format: "json" } } as any);
    } finally {
      console.log = origLog;
    }
    const parsed = JSON.parse(logs.join(""));
    expect(parsed.map((m: { id: string }) => m.id).sort()).toEqual(["M-A", "M-B"]);
  });
});

describe("moduleShowCmd on missing file (R6)", () => {
  test("prints the error without a header", async () => {
    const root = makeTempProject([], {});
    const origExit = process.exit;
    const origLog = console.log;
    const origErr = console.error;
    process.exit = ((code?: number) => { throw new Error(`exit:${code}`); }) as never;
    const logs: string[] = [];
    const errs: string[] = [];
    console.log = ((m?: unknown) => { logs.push(String(m)); }) as typeof console.log;
    console.error = ((m?: unknown) => { errs.push(String(m)); }) as typeof console.error;
    let caught: Error | null = null;
    try {
      await moduleShowCmd.run!({ args: { id: "M-NOPE", path: root } } as any);
    } catch (e) {
      caught = e as Error;
    } finally {
      process.exit = origExit;
      console.log = origLog;
      console.error = origErr;
    }
    expect(caught?.message).toBe("exit:1");
    expect(logs).toEqual([]);
    expect(errs.some((e) => e.includes("docs/modules/M-NOPE.xml not found"))).toBe(true);
  });
});

describe("moduleShowCmd fuzzy resolution", () => {
  test("resolves a unique ID prefix to the full id", async () => {
    const root = makeTempProject(
      [`<M-AUTH NAME="A" TYPE="CORE_LOGIC" STATUS="done" />`, `<M-EXTRA NAME="E" TYPE="UTILITY" STATUS="pending" />`],
      { "M-EXTRA.xml": "<M-EXTRA NAME=\"E\">\n</M-EXTRA>" }
    );
    const logs: string[] = [];
    const origLog = console.log;
    console.log = ((m?: unknown) => { logs.push(String(m)); }) as typeof console.log;
    try {
      await moduleShowCmd.run!({ args: { id: "M-EXT", path: root } } as any);
    } finally {
      console.log = origLog;
    }
    expect(logs.join("")).toContain("=== M-EXTRA ===");
  });

  test("errors on an ambiguous prefix, listing the candidates", async () => {
    const root = makeTempProject([`<M-AUTH NAME="A" TYPE="CORE_LOGIC" STATUS="done" />`, `<M-API NAME="API" TYPE="ENTRY_POINT" STATUS="pending" />`], {});
    const origExit = process.exit;
    const origErr = console.error;
    process.exit = ((code?: number) => { throw new Error(`exit:${code}`); }) as never;
    const errs: string[] = [];
    console.error = ((m?: unknown) => { errs.push(String(m)); }) as typeof console.error;
    let caught: Error | null = null;
    try {
      await moduleShowCmd.run!({ args: { id: "M-A", path: root } } as any);
    } catch (e) {
      caught = e as Error;
    } finally {
      process.exit = origExit;
      console.error = origErr;
    }
    expect(caught?.message).toBe("exit:1");
    expect(errs.some((e) => e.includes("ambiguous module prefix \"M-A\""))).toBe(true);
    expect(errs.some((e) => e.includes("M-AUTH"))).toBe(true);
    expect(errs.some((e) => e.includes("M-API"))).toBe(true);
  });

  test("errors when the id matches nothing", async () => {
    const root = makeTempProject([`<M-AUTH NAME="A" TYPE="CORE_LOGIC" STATUS="done" />`], {});
    const origExit = process.exit;
    const origErr = console.error;
    process.exit = ((code?: number) => { throw new Error(`exit:${code}`); }) as never;
    const errs: string[] = [];
    console.error = ((m?: unknown) => { errs.push(String(m)); }) as typeof console.error;
    let caught: Error | null = null;
    try {
      await moduleShowCmd.run!({ args: { id: "M-ZZZ", path: root } } as any);
    } catch (e) {
      caught = e as Error;
    } finally {
      process.exit = origExit;
      console.error = origErr;
    }
    expect(caught?.message).toBe("exit:1");
    expect(errs.some((e) => e.includes("docs/modules/M-ZZZ.xml not found"))).toBe(true);
  });
});
