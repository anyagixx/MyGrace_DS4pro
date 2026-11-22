/**
 * W1.1 — strict lint negative tests.
 *
 * Every drift/robustness class lint enforces is reproduced here on throwaway
 * projects; each test asserts the specific finding code, so stubbing a detector
 * out makes the suite fail. The shared fixture
 * `test/fixtures/mygrace-project/mygrace.config.json` deliberately relaxes
 * sizeBudgets: the committed fixture documents consistency, while default
 * caps/budgets are negative-tested below with explicit configs.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cloneDefault, type MyGraceConfig } from "../src/grace-config";
import { MyGraceError, UsageError, XmlError } from "../src/grace-errors";
import { analyzeMarkup, collectLintIssues, lintCommand } from "../src/grace-lint";
import { fileShowCmd } from "../src/grace-file";
import { moduleFindCmd, moduleListCmd, moduleShowCmd, phaseShowCmd } from "../src/grace-module";

// ─── Temp-project helpers ───────────────────────────────────────────────

interface ProjectSpec {
  graph?: string;
  plan?: string;
  verification?: string;
  modules?: Record<string, string>;
  plans?: Record<string, string>;
  verifications?: Record<string, string>;
  /** Extra files relative to the root, e.g. { "src/a.ts": "..." }. */
  files?: Record<string, string>;
  /** Written to mygrace.config.json when provided. */
  config?: unknown;
}

const roots: string[] = [];

function project(spec: ProjectSpec = {}): string {
  const root = mkdtempSync(join(tmpdir(), "mygrace-lintstrict-"));
  roots.push(root);
  mkdirSync(join(root, "docs", "modules"), { recursive: true });
  mkdirSync(join(root, "docs", "plans"), { recursive: true });
  mkdirSync(join(root, "docs", "verification"), { recursive: true });
  writeFileSync(
    join(root, "docs", "graph-index.xml"),
    spec.graph ?? `<GraphIndex project="T" version="1.0.0"></GraphIndex>\n`
  );
  writeFileSync(join(root, "docs", "plan-index.xml"), spec.plan ?? `<PlanIndex version="1.0.0"></PlanIndex>\n`);
  writeFileSync(
    join(root, "docs", "verification-index.xml"),
    spec.verification ?? `<VerificationIndex></VerificationIndex>\n`
  );
  for (const [name, content] of Object.entries(spec.modules ?? {})) {
    writeFileSync(join(root, "docs", "modules", name), content);
  }
  for (const [name, content] of Object.entries(spec.plans ?? {})) {
    writeFileSync(join(root, "docs", "plans", name), content);
  }
  for (const [name, content] of Object.entries(spec.verifications ?? {})) {
    writeFileSync(join(root, "docs", "verification", name), content);
  }
  for (const [name, content] of Object.entries(spec.files ?? {})) {
    const target = join(root, name);
    mkdirSync(join(target, ".."), { recursive: true });
    writeFileSync(target, content);
  }
  if (spec.config !== undefined) {
    writeFileSync(join(root, "mygrace.config.json"), `${JSON.stringify(spec.config, null, 2)}\n`);
  }
  return root;
}

/** Config with defaults, relaxed budgets so unrelated fixtures do not warn. */
function relaxedConfig(overrides: Partial<MyGraceConfig> = {}): MyGraceConfig {
  return {
    ...cloneDefault(),
    sizeBudgets: { module: [1, 500], phase: [1, 500], verification: [1, 500] },
    ...overrides,
  };
}

function codes(findings: readonly { code: string }[]): string[] {
  return findings.map((item) => item.code);
}

function findingsFor(root: string, config?: MyGraceConfig) {
  return config === undefined ? collectLintIssues(root, false) : collectLintIssues(root, false, config);
}

interface CapturedRun {
  exit: number;
  stdout: string;
  stderr: string;
}

/** Run a citty command with process.exit/console stubbed (no process death). */
async function runLint(args: Record<string, unknown>): Promise<CapturedRun> {
  const originalExit = process.exit;
  const originalLog = console.log;
  const originalError = console.error;
  const originalStdoutWrite = process.stdout.write;
  const originalStderrWrite = process.stderr.write;
  const stdout: string[] = [];
  const stderr: string[] = [];
  let exitCode: number | null = null;
  process.exit = ((code?: number) => {
    exitCode = code ?? 0;
    throw new Error(`exit:${code ?? 0}`);
  }) as never;
  console.log = ((...values: unknown[]) => {
    stdout.push(values.map((value) => String(value)).join(" "));
  }) as typeof console.log;
  console.error = ((...values: unknown[]) => {
    stderr.push(values.map((value) => String(value)).join(" "));
  }) as typeof console.error;
  process.stdout.write = ((chunk: unknown) => {
    stdout.push(String(chunk));
    return true;
  }) as never;
  process.stderr.write = ((chunk: unknown) => {
    stderr.push(String(chunk));
    return true;
  }) as never;
  try {
    await lintCommand.run!({ args } as never);
  } catch (error) {
    if (!(error instanceof Error) || !error.message.startsWith("exit:")) throw error;
  } finally {
    process.exit = originalExit;
    console.log = originalLog;
    console.error = originalError;
    process.stdout.write = originalStdoutWrite;
    process.stderr.write = originalStderrWrite;
  }
  return { exit: exitCode ?? 0, stdout: stdout.join("\n"), stderr: stderr.join("\n") };
}

afterEach(() => {
  while (roots.length > 0) {
    const root = roots.pop();
    if (root !== undefined) rmSync(root, { recursive: true, force: true });
  }
});

// ─── 1. Structural XML validity ─────────────────────────────────────────

describe("XML validity", () => {
  test("malformed index XML is XML_INVALID with a line number", () => {
    const root = project({ graph: `<GraphIndex>\n  <M-A NAME="A"\n</GraphIndex>\n` });
    const xml = findingsFor(root).filter((item) => item.code === "XML_INVALID");
    expect(xml.length).toBeGreaterThan(0);
    expect(xml[0]?.file).toBe("docs/graph-index.xml");
    expect(xml[0]?.severity).toBe("error");
    expect(xml[0]?.line).toBeGreaterThan(0);
  });

  test("malformed entity XML is XML_INVALID pointing at the entity file", () => {
    const root = project({
      graph: `<GraphIndex>\n  <M-A NAME="A" STATUS="pending" />\n</GraphIndex>\n`,
      modules: { "M-A.xml": `<M-A NAME="A" STATUS="pending">\n  <purpose>oops\n</M-A>\n` },
    });
    const xml = findingsFor(root).filter((item) => item.code === "XML_INVALID");
    expect(xml.some((item) => item.file === "docs/modules/M-A.xml")).toBe(true);
  });

  test("wrong index root tag is INDEX_ROOT_TAG", () => {
    const root = project({ graph: `<KnowledgeGraph project="X"></KnowledgeGraph>\n` });
    expect(codes(findingsFor(root))).toContain("INDEX_ROOT_TAG");
  });

  test("entity root tag must match the entity id (ENTITY_TAG_MISMATCH)", () => {
    const root = project({
      graph: `<GraphIndex>\n  <M-A NAME="A" STATUS="pending" />\n</GraphIndex>\n`,
      modules: { "M-A.xml": `<M-B NAME="A" STATUS="pending" />\n` },
    });
    expect(codes(findingsFor(root))).toContain("ENTITY_TAG_MISMATCH");
  });

  test("invalid entity file name is INVALID_ENTITY_ID", () => {
    const root = project({
      graph: `<GraphIndex></GraphIndex>\n`,
      modules: { "M-BAD!.xml": `<M-BAD! />\n` },
    });
    expect(codes(findingsFor(root))).toContain("INVALID_ENTITY_ID");
  });
});

// ─── 2. Index ↔ entity drift ───────────────────────────────────────────

describe("module field drift", () => {
  test("STATUS drift (uppercase canonical attrs) is a coded warning", () => {
    const root = project({
      graph: `<GraphIndex>\n  <M-A NAME="A" TYPE="CORE" STATUS="wip" />\n</GraphIndex>\n`,
      modules: { "M-A.xml": `<M-A NAME="A" TYPE="CORE" STATUS="done" />\n` },
    });
    const drift = findingsFor(root).find((item) => item.code === "STATUS_DRIFT");
    expect(drift?.severity).toBe("warning");
    expect(drift?.message).toContain("STATUS drift: M-A");
  });

  test("lowercase status attribute on the entity side is compared too", () => {
    const root = project({
      graph: `<GraphIndex>\n  <M-A NAME="A" STATUS="pending" />\n</GraphIndex>\n`,
      modules: { "M-A.xml": `<M-A NAME="A" status="done" />\n` },
    });
    expect(codes(findingsFor(root, relaxedConfig()))).toContain("STATUS_DRIFT");
  });

  test("NAME, TYPE, PATH, DEPENDS and VERIFICATION_REF drift are all detected", () => {
    const root = project({
      graph: [
        `<GraphIndex>`,
        `  <M-A NAME="IndexName" TYPE="CORE" STATUS="wip" PATH="src/indexed.ts" DEPENDS="M-B" VERIFICATION_REF="V-M-A" />`,
        `  <M-B NAME="B" TYPE="UTIL" STATUS="done" PATH="src/b.ts" />`,
        `  <M-C NAME="C" TYPE="UTIL" STATUS="done" PATH="src/c.ts" />`,
        `</GraphIndex>`,
      ].join("\n"),
      verification: `<VerificationIndex>\n  <V-M-A MODULE="M-A" PRIORITY="high" STATUS="pending" />\n  <V-M-B MODULE="M-B" PRIORITY="low" STATUS="done" />\n</VerificationIndex>\n`,
      modules: {
        "M-A.xml": [
          `<M-A NAME="FileName" TYPE="ENTRY_POINT" STATUS="wip">`,
          `  <path>src/filed.ts</path>`,
          `  <depends>M-C</depends>`,
          `  <verification-ref>V-M-B</verification-ref>`,
          `</M-A>`,
        ].join("\n"),
        "M-B.xml": `<M-B NAME="B" TYPE="UTIL" STATUS="done"><path>src/b.ts</path></M-B>\n`,
        "M-C.xml": `<M-C NAME="C" TYPE="UTIL" STATUS="done"><path>src/c.ts</path></M-C>\n`,
      },
      files: { "src/indexed.ts": "export {};\n", "src/filed.ts": "export {};\n", "src/b.ts": "", "src/c.ts": "" },
      verifications: {
        "V-M-A.xml": `<V-M-A MODULE="M-A" PRIORITY="high" STATUS="pending" />\n`,
        "V-M-B.xml": `<V-M-B MODULE="M-B" PRIORITY="low" STATUS="done" />\n`,
      },
    });
    const found = codes(findingsFor(root, relaxedConfig()));
    for (const code of ["NAME_DRIFT", "TYPE_DRIFT", "PATH_DRIFT", "DEPENDS_DRIFT", "VERIFICATION_REF_DRIFT"]) {
      expect(found, `expected ${code}`).toContain(code);
    }
  });
});

describe("phase drift (lowercase canonical attrs)", () => {
  test("phase name/status/steps drift are detected", () => {
    const root = project({
      plan: `<PlanIndex version="1.0.0">\n  <Phase-1 name="Foundation" status="wip" steps="2" />\n</PlanIndex>\n`,
      plans: {
        "Phase-1.xml": [
          `<Phase-1 name="Renamed" status="done">`,
          `  <step-1 module="M-A" description="only one" status="done" />`,
          `</Phase-1>`,
        ].join("\n"),
      },
    });
    const found = codes(findingsFor(root, relaxedConfig()));
    expect(found).toContain("PHASE_NAME_DRIFT");
    expect(found).toContain("PHASE_STATUS_DRIFT");
    expect(found).toContain("PHASE_STEPS_DRIFT");
  });
});

describe("verification drift", () => {
  test("verification MODULE/PRIORITY/STATUS drift are detected", () => {
    const root = project({
      verification: `<VerificationIndex>\n  <V-M-A MODULE="M-A" PRIORITY="high" STATUS="pending" />\n</VerificationIndex>\n`,
      verifications: { "V-M-A.xml": `<V-M-A MODULE="M-OTHER" PRIORITY="low" STATUS="done" />\n` },
    });
    const found = codes(findingsFor(root, relaxedConfig()));
    expect(found).toContain("VERIFICATION_MODULE_DRIFT");
    expect(found).toContain("VERIFICATION_PRIORITY_DRIFT");
    expect(found).toContain("VERIFICATION_STATUS_DRIFT");
  });
});

// ─── 3. Index presence, duplicates, dedup of index ids ──────────────────

describe("index presence and duplicates", () => {
  test("duplicate index entries are an error", () => {
    const root = project({
      graph: `<GraphIndex>\n  <M-A NAME="A" STATUS="pending" />\n  <M-A NAME="A2" STATUS="wip" />\n</GraphIndex>\n`,
      modules: { "M-A.xml": `<M-A NAME="A" STATUS="pending" />\n` },
      files: {},
    });
    const duplicates = findingsFor(root, relaxedConfig()).filter((item) => item.code === "DUPLICATE_INDEX_ENTRY");
    expect(duplicates.length).toBe(1);
    expect(duplicates[0]?.severity).toBe("error");
    expect(duplicates[0]?.message).toContain("M-A");
  });

  test("orphaned index entry and missing index entry are coded errors", () => {
    const root = project({
      graph: `<GraphIndex>\n  <M-ORPHAN NAME="O" STATUS="pending" />\n</GraphIndex>\n`,
      modules: { "M-EXTRA.xml": `<M-EXTRA NAME="E" STATUS="pending" />\n` },
    });
    const found = codes(findingsFor(root, relaxedConfig()));
    expect(found).toContain("ORPHANED_INDEX_ENTRY");
    expect(found).toContain("MISSING_INDEX_ENTRY");
  });

  test("missing index files are MISSING_INDEX_FILE errors", () => {
    const root = mkdtempSync(join(tmpdir(), "mygrace-lintstrict-"));
    roots.push(root);
    mkdirSync(join(root, "docs", "modules"), { recursive: true });
    const findings = collectLintIssues(root, false);
    expect(codes(findings).filter((code) => code === "MISSING_INDEX_FILE").length).toBe(3);
  });

  test("missing entity directory is MISSING_ENTITY_DIR", () => {
    const root = mkdtempSync(join(tmpdir(), "mygrace-lintstrict-"));
    roots.push(root);
    mkdirSync(join(root, "docs"), { recursive: true });
    writeFileSync(join(root, "docs", "graph-index.xml"), `<GraphIndex></GraphIndex>\n`);
    expect(codes(collectLintIssues(root, false))).toContain("MISSING_ENTITY_DIR");
  });

  test("invalid verification ref is INVALID_VERIFICATION_REF", () => {
    const root = project({
      graph: `<GraphIndex>\n  <M-A NAME="A" STATUS="pending" />\n</GraphIndex>\n`,
      modules: { "M-A.xml": `<M-A NAME="A"><verification-ref>../../etc/passwd</verification-ref></M-A>\n` },
    });
    expect(codes(findingsFor(root, relaxedConfig()))).toContain("INVALID_VERIFICATION_REF");
  });
});

// ─── 4. PATH and DEPENDS integrity ─────────────────────────────────────

describe("path and dependency integrity", () => {
  test("missing module PATH is MODULE_PATH_NOT_FOUND (error)", () => {
    const root = project({
      graph: `<GraphIndex>\n  <M-A NAME="A" STATUS="pending" PATH="src/does-not-exist.ts" />\n</GraphIndex>\n`,
      modules: { "M-A.xml": `<M-A NAME="A" STATUS="pending"><path>src/does-not-exist.ts</path></M-A>\n` },
    });
    const missing = findingsFor(root, relaxedConfig()).filter((item) => item.code === "MODULE_PATH_NOT_FOUND");
    expect(missing.length).toBe(1);
    expect(missing[0]?.severity).toBe("error");
  });

  test("PATH escaping the project root is PATH_UNSAFE (error)", () => {
    const root = project({
      graph: `<GraphIndex>\n  <M-A NAME="A" STATUS="pending" PATH="../outside.ts" />\n</GraphIndex>\n`,
      modules: { "M-A.xml": `<M-A NAME="A" STATUS="pending"></M-A>\n` },
    });
    expect(codes(findingsFor(root, relaxedConfig()))).toContain("PATH_UNSAFE");
  });

  test("malformed dependency id is INVALID_DEPENDENCY_ID (error)", () => {
    const root = project({
      graph: `<GraphIndex>\n  <M-A NAME="A" STATUS="pending" PATH="src/a.ts" DEPENDS="BROKEN" />\n</GraphIndex>\n`,
      modules: { "M-A.xml": `<M-A NAME="A" STATUS="pending"><depends>BROKEN</depends></M-A>\n` },
      files: { "src/a.ts": "export {};\n" },
    });
    expect(codes(findingsFor(root, relaxedConfig()))).toContain("INVALID_DEPENDENCY_ID");
  });

  test("unknown DEPENDS target is UNKNOWN_DEPENDENCY (error)", () => {
    const root = project({
      graph: `<GraphIndex>\n  <M-A NAME="A" STATUS="pending" PATH="src/a.ts" DEPENDS="M-GHOST" />\n</GraphIndex>\n`,
      modules: { "M-A.xml": `<M-A NAME="A" STATUS="pending"><depends>M-GHOST</depends></M-A>\n` },
      files: { "src/a.ts": "export {};\n" },
    });
    expect(codes(findingsFor(root, relaxedConfig()))).toContain("UNKNOWN_DEPENDENCY");
  });
});

// ─── 5. Caps and budgets from grace-config ─────────────────────────────

describe("index caps and entity budgets", () => {
  test("oversized index is INDEX_TOO_LARGE (error)", () => {
    const root = project({
      graph: [
        `<GraphIndex>`,
        `  <M-A NAME="A" STATUS="pending" />`,
        `  <M-B NAME="B" STATUS="pending" />`,
        `</GraphIndex>`,
        ``,
      ].join("\n"),
      modules: {
        "M-A.xml": `<M-A NAME="A" STATUS="pending" />\n`,
        "M-B.xml": `<M-B NAME="B" STATUS="pending" />\n`,
      },
    });
    const config = relaxedConfig({ indexCaps: { graph: 3, plan: 50, verification: 80 } });
    const oversized = findingsFor(root, config).filter((item) => item.code === "INDEX_TOO_LARGE");
    expect(oversized.length).toBe(1);
    expect(oversized[0]?.severity).toBe("error");
  });

  test("entity below the default minimum is ENTITY_TOO_SMALL (warning)", () => {
    const root = project({
      graph: `<GraphIndex>\n  <M-A NAME="A" STATUS="pending" />\n</GraphIndex>\n`,
      modules: { "M-A.xml": `<M-A NAME="A" STATUS="pending" />\n` },
    });
    const small = findingsFor(root).filter((item) => item.code === "ENTITY_TOO_SMALL");
    expect(small.length).toBe(1);
    expect(small[0]?.severity).toBe("warning");
    expect(small[0]?.hint).toContain("sizeBudgets");
  });

  test("entity above the configured maximum is ENTITY_TOO_LARGE (warning)", () => {
    const root = project({
      graph: `<GraphIndex>\n  <M-A NAME="A" STATUS="pending" />\n</GraphIndex>\n`,
      modules: {
        "M-A.xml": [`<M-A NAME="A" STATUS="pending">`, `  <purpose>p</purpose>`, `  <path>src/a.ts</path>`, `</M-A>`, ``].join("\n"),
      },
      files: { "src/a.ts": "export {};\n" },
    });
    const config = relaxedConfig({ sizeBudgets: { module: [1, 2], phase: [1, 500], verification: [1, 500] } });
    const large = findingsFor(root, config).filter((item) => item.code === "ENTITY_TOO_LARGE");
    expect(large.length).toBe(1);
    expect(large[0]?.severity).toBe("warning");
  });

  test("entity within the configured range has no budget finding", () => {
    const root = project({
      graph: `<GraphIndex>\n  <M-A NAME="A" STATUS="pending" />\n</GraphIndex>\n`,
      modules: {
        "M-A.xml": [`<M-A NAME="A" STATUS="pending">`, `  <purpose>p</purpose>`, `  <path>src/a.ts</path>`, `</M-A>`, ``].join("\n"),
      },
      files: { "src/a.ts": "export {};\n" },
      config: {
        sizeBudgets: { module: [1, 100], phase: [1, 500], verification: [1, 500] },
      },
    });
    const found = codes(findingsFor(root));
    expect(found.filter((code) => code.startsWith("ENTITY_TOO_"))).toEqual([]);
  });
});

// ─── 6. Verification contract / deprecation location ───────────────────

describe("verification refs and canonical command location", () => {
  test("missing verification ref target is MISSING_VERIFICATION_REF (error)", () => {
    const root = project({
      graph: `<GraphIndex>\n  <M-A NAME="A" STATUS="pending" VERIFICATION_REF="V-M-NOPE" />\n</GraphIndex>\n`,
      modules: { "M-A.xml": `<M-A NAME="A"><verification-ref>V-M-NOPE</verification-ref></M-A>\n` },
    });
    expect(codes(findingsFor(root, relaxedConfig()))).toContain("MISSING_VERIFICATION_REF");
  });

  test("verification ref not listed in verification-index.xml is VERIFICATION_REF_NOT_IN_INDEX", () => {
    const root = project({
      graph: `<GraphIndex>\n  <M-A NAME="A" STATUS="pending" VERIFICATION_REF="V-M-A" />\n</GraphIndex>\n`,
      modules: { "M-A.xml": `<M-A NAME="A"><verification-ref>V-M-A</verification-ref></M-A>\n` },
      verification: `<VerificationIndex>\n  <V-M-B MODULE="M-B" PRIORITY="low" STATUS="done" />\n</VerificationIndex>\n`,
      verifications: { "V-M-A.xml": `<V-M-A MODULE="M-A" PRIORITY="high" STATUS="pending" />\n` },
    });
    expect(codes(findingsFor(root, relaxedConfig()))).toContain("VERIFICATION_REF_NOT_IN_INDEX");
  });

  test("legacy <module-checks> in the module file is a deprecation warning", () => {
    const root = project({
      graph: `<GraphIndex>\n  <M-A NAME="A" STATUS="pending" VERIFICATION_REF="V-M-A" />\n</GraphIndex>\n`,
      modules: {
        "M-A.xml": `<M-A NAME="A"><module-checks><check-1>true</check-1></module-checks></M-A>\n`,
      },
      verification: `<VerificationIndex>\n  <V-M-A MODULE="M-A" PRIORITY="high" STATUS="pending" />\n</VerificationIndex>\n`,
      verifications: { "V-M-A.xml": `<V-M-A MODULE="M-A"><test-files><file>x.ts</file></test-files></V-M-A>\n` },
    });
    const deprecated = findingsFor(root, relaxedConfig()).filter((item) => item.code === "MODULE_CHECKS_DEPRECATED_LOCATION");
    expect(deprecated.length).toBe(1);
    expect(deprecated[0]?.severity).toBe("warning");
    expect(deprecated[0]?.message).toContain("docs/verification/V-M-A.xml");
  });

  test("canonical <module-checks> location produces no deprecation warning", () => {
    const root = project({
      graph: `<GraphIndex>\n  <M-A NAME="A" STATUS="pending" VERIFICATION_REF="V-M-A" />\n</GraphIndex>\n`,
      modules: { "M-A.xml": `<M-A NAME="A"></M-A>\n` },
      verification: `<VerificationIndex>\n  <V-M-A MODULE="M-A" PRIORITY="high" STATUS="pending" />\n</VerificationIndex>\n`,
      verifications: {
        "V-M-A.xml": `<V-M-A MODULE="M-A"><module-checks><check-1>true</check-1></module-checks></V-M-A>\n`,
      },
    });
    expect(codes(findingsFor(root, relaxedConfig()))).not.toContain("MODULE_CHECKS_DEPRECATED_LOCATION");
  });
});

// ─── 7. Generic XML tags ───────────────────────────────────────────────

describe("generic XML tags", () => {
  test("generic <Module>/<Phase> tags are GENERIC_XML_TAG warnings", () => {
    const root = project({
      graph: `<GraphIndex>\n  <M-A NAME="A" STATUS="pending" />\n</GraphIndex>\n`,
      modules: { "M-A.xml": `<M-A NAME="A"><Module name="generic" /><Phase name="generic" /></M-A>\n` },
    });
    const generic = findingsFor(root, relaxedConfig()).filter((item) => item.code === "GENERIC_XML_TAG");
    expect(generic.length).toBe(2);
    expect(generic[0]?.severity).toBe("warning");
  });
});

// ─── 8. Semantic markup ────────────────────────────────────────────────

describe("semantic markup detectors", () => {
  test("unclosed START_BLOCK is UNPAIRED_BLOCK (error)", () => {
    const root = project({
      files: { "src/a.ts": `// START_BLOCK_ONLY_START\nconst a = 1;\n` },
    });
    const findings = findingsFor(root, relaxedConfig()).filter((item) => item.file === "src/a.ts");
    expect(codes(findings)).toContain("UNPAIRED_BLOCK");
    expect(findings[0]?.severity).toBe("error");
  });

  test("START_BLOCK_X closed by END_BLOCK_Y is BLOCK_NAME_MISMATCH even when counts match", () => {
    const root = project({
      files: { "src/a.ts": `// START_BLOCK_ALPHA\nconst a = 1;\n// END_BLOCK_BETA\n` },
    });
    const findings = findingsFor(root, relaxedConfig()).filter((item) => item.file === "src/a.ts");
    expect(codes(findings)).toContain("BLOCK_NAME_MISMATCH");
    expect(codes(findings)).not.toContain("UNPAIRED_BLOCK");
  });

  test("stray END_BLOCK is STRAY_END_BLOCK (error)", () => {
    const root = project({ files: { "src/a.ts": `const a = 1;\n// END_BLOCK_NOTHING\n` } });
    expect(codes(findingsFor(root, relaxedConfig()).filter((item) => item.file === "src/a.ts"))).toContain(
      "STRAY_END_BLOCK"
    );
  });

  test("properly nested blocks are paired", () => {
    const analysis = analyzeMarkup("// START_BLOCK_A\n// START_BLOCK_B\n// END_BLOCK_B\n// END_BLOCK_A\n");
    expect(analysis.blockStarts).toBe(2);
    expect(analysis.blockEnds).toBe(2);
    expect(analysis.blockIssues).toEqual([]);
  });

  test("block markers inside string literals are ignored", () => {
    const root = project({ files: { "src/strings.ts": `const marker = "START_BLOCK_FAKE";\n` } });
    expect(codes(findingsFor(root, relaxedConfig()).filter((item) => item.file === "src/strings.ts"))).toEqual([]);
  });

  test(">2 blocks without MODULE_CONTRACT is MISSING_MODULE_CONTRACT (warning)", () => {
    const root = project({
      files: {
        "src/no-contract.ts": [
          `// START_BLOCK_A`,
          `// END_BLOCK_A`,
          `// START_BLOCK_B`,
          `// END_BLOCK_B`,
          `// START_BLOCK_C`,
          `// END_BLOCK_C`,
          ``,
        ].join("\n"),
      },
    });
    const warning = findingsFor(root, relaxedConfig()).find((item) => item.code === "MISSING_MODULE_CONTRACT");
    expect(warning?.severity).toBe("warning");
  });

  test("MODULE_CONTRACT missing fields are CONTRACT_FIELD_MISSING warnings", () => {
    const root = project({
      files: {
        "src/partial-contract.ts": [
          `// START_MODULE_CONTRACT`,
          `//   PURPOSE: does something`,
          `// END_MODULE_CONTRACT`,
          ``,
        ].join("\n"),
      },
    });
    const missing = findingsFor(root, relaxedConfig()).filter((item) => item.code === "CONTRACT_FIELD_MISSING");
    expect(missing.map((item) => item.message).sort()).toEqual([
      "MODULE_CONTRACT is missing field DEPENDS",
      "MODULE_CONTRACT is missing field LINKS",
      "MODULE_CONTRACT is missing field SCOPE",
    ]);
  });

  test("legacy === MODULE_CONTRACT === form is recognized", () => {
    const analysis = analyzeMarkup(
      ["// === MODULE_CONTRACT ===", "//   PURPOSE: legacy", "//   SCOPE: s", "//   DEPENDS: none", "//   LINKS: x", "// === END_MODULE_CONTRACT ==="].join("\n")
    );
    expect(analysis.contract?.legacy).toBe(true);
    expect(analysis.contract?.fields.PURPOSE).toBe("legacy");
  });

  test("ignoreDirs prevents scanning vendored node_modules", () => {
    const root = project({
      files: { "src/node_modules/dep/index.ts": `// START_BLOCK_VENDORED\n` },
    });
    const findings = findingsFor(root, relaxedConfig()).filter((item) => item.file?.includes("node_modules"));
    expect(findings).toEqual([]);
  });

  test("sourceDirs/markupExts come from mygrace.config.json (no hardcoded src/)", () => {
    const root = project({
      config: {
        sourceDirs: ["python_src"],
        markupExts: [".py"],
        sizeBudgets: { module: [1, 500], phase: [1, 500], verification: [1, 500] },
      },
      files: {
        "python_src/bad.py": `# START_BLOCK_PY_ONLY\nx = 1\n`,
        "src/ignored.ts": `// START_BLOCK_TS_IGNORED\n`,
      },
    });
    const findings = findingsFor(root);
    const unpaired = findings.filter((item) => item.code === "UNPAIRED_BLOCK");
    expect(unpaired.map((item) => item.file)).toEqual(["python_src/bad.py"]);
  });
});

// ─── 9. Config errors ──────────────────────────────────────────────────

describe("config errors", () => {
  test("invalid mygrace.config.json is CONFIG_INVALID (finding, not crash)", () => {
    const root = project({ files: {} });
    writeFileSync(join(root, "mygrace.config.json"), "{ not json");
    const invalid = collectLintIssues(root, false).filter((item) => item.code === "CONFIG_INVALID");
    expect(invalid.length).toBe(1);
    expect(invalid[0]?.severity).toBe("error");
  });
});

// ─── 10. Command contract: --strict, JSON envelope, exit codes ─────────

describe("lint command exit-code contract", () => {
  test("warnings-only project: exit 0 normally, exit 1 with --strict", async () => {
    const root = project({
      graph: `<GraphIndex>\n  <M-A NAME="A" STATUS="pending" />\n</GraphIndex>\n`,
      modules: { "M-A.xml": `<M-A NAME="A" STATUS="pending" />\n` },
    });
    const normal = await runLint({ path: root });
    expect(normal.exit).toBe(0);
    expect(normal.stdout).toContain("ENTITY_TOO_SMALL");

    const strict = await runLint({ path: root, strict: true });
    expect(strict.exit).toBe(1);
  });

  test("JSON mode honours the exit code for errors (v1 H-2 regression)", async () => {
    const root = project({ graph: `<GraphIndex>\n  <M-A NAME="A"\n</GraphIndex>\n` });
    const result = await runLint({ path: root, format: "json" });
    expect(result.exit).toBe(1);
    const envelope = JSON.parse(result.stdout) as {
      ok: boolean;
      exitCode: number;
      findings: { severity: string; code: string }[];
    };
    expect(envelope.ok).toBe(false);
    expect(envelope.exitCode).toBe(1);
    expect(envelope.findings.some((item) => item.code === "XML_INVALID")).toBe(true);
  });

  test("JSON warnings-only is ok:true / exitCode 0 without --strict and fails with --strict", async () => {
    const root = project({
      graph: `<GraphIndex>\n  <M-A NAME="A" STATUS="pending" />\n</GraphIndex>\n`,
      modules: { "M-A.xml": `<M-A NAME="A" STATUS="pending" />\n` },
    });
    const normal = await runLint({ path: root, format: "json" });
    expect(normal.exit).toBe(0);
    const normalEnvelope = JSON.parse(normal.stdout) as { ok: boolean; exitCode: number; findings: unknown[] };
    expect(normalEnvelope.ok).toBe(true);
    expect(normalEnvelope.exitCode).toBe(0);
    expect(normalEnvelope.findings.length).toBeGreaterThan(0);

    const strict = await runLint({ path: root, format: "json", strict: true });
    expect(strict.exit).toBe(1);
    const strictEnvelope = JSON.parse(strict.stdout) as { ok: boolean; exitCode: number };
    expect(strictEnvelope.ok).toBe(false);
  });

  test("clean project: ok:true, no findings, exit 0", async () => {
    const root = project({
      graph: `<GraphIndex>\n  <M-A NAME="A" STATUS="pending" PATH="src/a.ts" />\n</GraphIndex>\n`,
      modules: { "M-A.xml": `<M-A NAME="A" STATUS="pending"><path>src/a.ts</path></M-A>\n` },
      files: { "src/a.ts": "export {};\n" },
      config: { sizeBudgets: { module: [1, 500], phase: [1, 500], verification: [1, 500] } },
    });
    const result = await runLint({ path: root, format: "json", strict: true });
    expect(result.exit).toBe(0);
    const envelope = JSON.parse(result.stdout) as { ok: boolean; exitCode: number; findings: unknown[] };
    expect(envelope.ok).toBe(true);
    expect(envelope.findings).toEqual([]);
  });

  test("not-a-project JSON mode is exit 2 with PROJECT_NOT_FOUND (no stack)", async () => {
    const root = mkdtempSync(join(tmpdir(), "mygrace-lintstrict-"));
    roots.push(root);
    const result = await runLint({ path: root, format: "json" });
    expect(result.exit).toBe(2);
    const envelope = JSON.parse(result.stdout) as { ok: boolean; exitCode: number; error?: { code: string } };
    expect(envelope.ok).toBe(false);
    expect(envelope.exitCode).toBe(2);
    expect(envelope.error?.code).toBe("PROJECT_NOT_FOUND");
  });

  test("unknown --format is a usage error", async () => {
    const root = project();
    await expect(runLint({ path: root, format: "yaml" })).rejects.toBeInstanceOf(UsageError);
  });

  test("--allow-missing-docs on a nonexistent path is a usage error (v1 false pass)", async () => {
    const result = await runLint({ path: "/tmp/mygrace-does-not-exist-w1", allowMissingDocs: true });
    expect(result.exit).toBe(2);
    expect(result.stderr).toContain("USAGE");
    expect(result.stderr).toContain("does not exist");
  });
});

// ─── 11. Module / file commands: ids, typed XML errors, markup view ─────

async function captureCommand(
  handler: unknown,
  args: Record<string, unknown>
): Promise<{ exit: number; stdout: string; stderr: string }> {
  const command = handler as { run?: (context: unknown) => Promise<void> };
  const originalExit = process.exit;
  const originalLog = console.log;
  const originalError = console.error;
  const originalStdoutWrite = process.stdout.write;
  const originalStderrWrite = process.stderr.write;
  const stdout: string[] = [];
  const stderr: string[] = [];
  let exitCode: number | null = null;
  process.exit = ((code?: number) => {
    exitCode = code ?? 0;
    throw new Error(`exit:${code ?? 0}`);
  }) as never;
  console.log = ((...values: unknown[]) => {
    stdout.push(values.map((value) => String(value)).join(" "));
  }) as typeof console.log;
  console.error = ((...values: unknown[]) => {
    stderr.push(values.map((value) => String(value)).join(" "));
  }) as typeof console.error;
  process.stdout.write = ((chunk: unknown) => {
    stdout.push(String(chunk));
    return true;
  }) as never;
  process.stderr.write = ((chunk: unknown) => {
    stderr.push(String(chunk));
    return true;
  }) as never;
  try {
    await command.run?.({ args });
  } catch (error) {
    if (!(error instanceof Error) || !error.message.startsWith("exit:")) throw error;
  } finally {
    process.exit = originalExit;
    console.log = originalLog;
    console.error = originalError;
    process.stdout.write = originalStdoutWrite;
    process.stderr.write = originalStderrWrite;
  }
  return { exit: exitCode ?? 0, stdout: stdout.join("\n"), stderr: stderr.join("\n") };
}

describe("module commands: id safety and typed XML errors", () => {
  test("module show rejects a traversal id with UsageError", async () => {
    const root = project();
    await expect(moduleShowCmd.run!({ args: { id: "../../../etc/passwd", path: root } } as never)).rejects.toBeInstanceOf(
      UsageError
    );
  });

  test("phase show rejects a traversal id with UsageError", async () => {
    const root = project();
    await expect(
      phaseShowCmd.run!({ args: { name: "../../../etc/passwd", path: root } } as never)
    ).rejects.toBeInstanceOf(UsageError);
  });

  test("module show surfaces malformed XML as a typed XmlError (not a stack)", async () => {
    const root = project({ graph: `<GraphIndex>\n  <M-A NAME="A"\n</GraphIndex>\n` });
    const run = moduleShowCmd.run!({ args: { id: "M-A", path: root } } as never);
    await expect(run).rejects.toBeInstanceOf(XmlError);
    await expect(moduleShowCmd.run!({ args: { id: "M-A", path: root } } as never)).rejects.toMatchObject({
      code: "XML_INVALID",
    });
  });

  test("module find/list surface malformed XML as typed errors", async () => {
    const root = project({ graph: `<GraphIndex>\n  <M-A NAME="A"\n</GraphIndex>\n` });
    await expect(moduleFindCmd.run!({ args: { path: root } } as never)).rejects.toBeInstanceOf(XmlError);
    await expect(moduleListCmd.run!({ args: { path: root } } as never)).rejects.toBeInstanceOf(XmlError);
  });
});

describe("file show markup view", () => {
  test("reports MODULE_CONTRACT and block pairing by name", async () => {
    const root = project({
      files: {
        "src/sample.ts": [
          `// START_MODULE_CONTRACT`,
          `//   PURPOSE: sample`,
          `//   SCOPE: sample scope`,
          `//   DEPENDS: none`,
          `//   LINKS: M-SAMPLE`,
          `// END_MODULE_CONTRACT`,
          `// START_BLOCK_ALPHA`,
          `// END_BLOCK_BETA`,
          ``,
        ].join("\n"),
      },
    });
    const result = await captureCommand(fileShowCmd, { path: "src/sample.ts", root, blocks: true, contracts: true });
    expect(result.stdout).toContain("=== MODULE_CONTRACT ===");
    expect(result.stdout).toContain("PURPOSE: sample");
    expect(result.stdout).toContain("UNPAIRED");
    expect(result.stdout).toContain("BLOCK_NAME_MISMATCH");
  });

  test("missing positional path is a UsageError", async () => {
    await expect(fileShowCmd.run!({ args: { root: "." } } as never)).rejects.toBeInstanceOf(UsageError);
  });
});

// ─── 12. Backwards compatibility for status/doctor ─────────────────────

describe("collectLintIssues compatibility contract", () => {
  test("2-arg call returns findings with severity/code/message and honors allowMissingDocs", () => {
    const root = mkdtempSync(join(tmpdir(), "mygrace-lintstrict-"));
    roots.push(root);
    const findings = collectLintIssues(root, true);
    expect(findings).toEqual([]);

    const missing = collectLintIssues(root, false);
    expect(missing.length).toBeGreaterThan(0);
    for (const item of missing) {
      expect(["error", "warning", "info"]).toContain(item.severity);
      expect(typeof item.code).toBe("string");
      expect(typeof item.message).toBe("string");
    }
    expect(missing.some((item) => item.code === "MISSING_INDEX_FILE")).toBe(true);
  });

  test("finding helper fields stay backwards compatible (file/line/hint only added)", () => {
    const root = project({ graph: `<GraphIndex>\n  <M-A NAME="A" STATUS="pending" />\n</GraphIndex>\n` });
    const findingWithDrift = collectLintIssues(root, false, relaxedConfig()).find((item) => item.code === "ENTITY_TOO_SMALL");
    expect(findingWithDrift).toBeUndefined();
    const malformed = project({ graph: `<GraphIndex>\n  <M-A NAME="A"\n</GraphIndex>\n` });
    const issue = collectLintIssues(malformed, false).find((item) => item.code === "XML_INVALID");
    expect(issue).toBeDefined();
    expect(issue?.severity).toBe("error");
    expect(issue?.message.includes("Invalid XML")).toBe(true);
    expect(issue?.file).toBe("docs/graph-index.xml");
    expect(issue?.line).toBeGreaterThan(0);
    expect(issue?.hint).toBeTruthy();
  });
});

// ─── 13. MyGraceError typing sanity ────────────────────────────────────

describe("typed errors", () => {
  test("UsageError and XmlError carry stable codes and exit codes", () => {
    const usage = new UsageError("bad");
    expect(usage.code).toBe("USAGE");
    expect(usage.exitCode).toBe(2);
    const xml = new XmlError("docs/x.xml", "unclosed tag", { line: 3 });
    expect(xml.code).toBe("XML_INVALID");
    expect(xml.exitCode).toBe(1);
    expect(xml).toBeInstanceOf(MyGraceError);
  });
});
