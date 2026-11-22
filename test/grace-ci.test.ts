import { describe, test, expect } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

import { collectCoverage, runCiGate } from "../src/grace-ci";
import { loadConfig } from "../src/grace-config";
import { ciCommand } from "../src/grace-ci";

const REPO_ROOT = join(import.meta.dirname, "..");
const CLI = join(REPO_ROOT, "src", "grace.ts");
const DEMO = join(REPO_ROOT, "examples", "demo-store");

interface FixtureOptions {
  verificationRef?: string | null;
  testFiles?: string[];
  testFileExists?: boolean;
  verificationFile?: boolean;
  command?: string;
}

/** Build a minimal, budget-relaxed MyGRACE project for gate tests. */
function makeProject(options: FixtureOptions = {}): string {
  const root = mkdtempSync(join(tmpdir(), "mygrace-ci-"));
  mkdirSync(join(root, "docs", "modules"), { recursive: true });
  mkdirSync(join(root, "docs", "plans"), { recursive: true });
  mkdirSync(join(root, "docs", "verification"), { recursive: true });
  mkdirSync(join(root, "src"), { recursive: true });

  // Relaxed budgets so short fixtures never fail the strict gate for size reasons.
  writeFileSync(
    join(root, "mygrace.config.json"),
    JSON.stringify({ sizeBudgets: { module: [1, 400], phase: [1, 400], verification: [1, 400] } }, null, 2)
  );

  const ref = options.verificationRef === undefined ? "V-M-A" : options.verificationRef;
  const refAttr = ref === null ? "" : ` VERIFICATION_REF="${ref}"`;
  writeFileSync(
    join(root, "docs", "graph-index.xml"),
    `<GraphIndex project="Fixture" version="1.0.0">\n` +
      `  <M-A NAME="A" TYPE="UTILITY" STATUS="done" PATH="src/a.ts" DEPENDS=""${refAttr} />\n` +
      `</GraphIndex>\n`
  );
  writeFileSync(join(root, "docs", "plan-index.xml"), `<PlanIndex project="Fixture" version="1.0.0">\n</PlanIndex>\n`);
  writeFileSync(join(root, "docs", "modules", "M-A.xml"), `<M-A NAME="A" TYPE="UTILITY" STATUS="done" PATH="src/a.ts">\n  <contract><purpose>fixture</purpose><path>src/a.ts</path><depends></depends><verification-ref>${ref ?? ""}</verification-ref></contract>\n</M-A>\n`);

  const testFiles = options.testFiles ?? ["src/a.test.ts"];
  if (options.verificationFile !== false && ref !== null) {
    const files = testFiles.map((file) => `    <file>${file}</file>`).join("\n");
    const checks = options.command === undefined ? "" : `  <module-checks><check-1>${options.command}</check-1></module-checks>\n`;
    writeFileSync(
      join(root, "docs", "verification", `${ref}.xml`),
      `<${ref} MODULE="M-A" PRIORITY="medium" STATUS="done">\n` +
        `  <test-files>\n${files}\n  </test-files>\n` +
        checks +
        `  <scenarios><scenario-1 kind="success">a works</scenario-1></scenarios>\n` +
        `</${ref}>\n`
    );
    writeFileSync(
      join(root, "docs", "verification-index.xml"),
      `<VerificationIndex project="Fixture" version="1.0.0">\n  <${ref} MODULE="M-A" PRIORITY="medium" STATUS="done" />\n</VerificationIndex>\n`
    );
  } else {
    writeFileSync(join(root, "docs", "verification-index.xml"), `<VerificationIndex project="Fixture" version="1.0.0">\n</VerificationIndex>\n`);
  }

  writeFileSync(join(root, "src", "a.ts"), "export const a = 1;\n");
  if (options.testFileExists !== false) {
    for (const file of testFiles) {
      if (file.startsWith("..") || file.startsWith("/")) continue;
      mkdirSync(join(root, file, ".."), { recursive: true });
      writeFileSync(join(root, file), "// fixture test\n");
    }
  }
  return root;
}

function withProject<T>(options: FixtureOptions, body: (root: string) => T): T {
  const root = makeProject(options);
  try {
    return body(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

describe("collectCoverage", () => {
  test("reports full coverage when verification and test files exist", () => {
    withProject({}, (root) => {
      const { report, findings } = collectCoverage(root, loadConfig(root).config);
      expect(report.modules).toBe(1);
      expect(report.withVerification).toBe(1);
      expect(report.testFilesDeclared).toBe(1);
      expect(report.testFilesMissing).toEqual([]);
      expect(findings.filter((f) => f.severity === "error")).toEqual([]);
    });
  });

  test("flags a module without VERIFICATION_REF", () => {
    withProject({ verificationRef: null, verificationFile: false }, (root) => {
      const { findings } = collectCoverage(root, loadConfig(root).config);
      expect(findings.some((f) => f.code === "MODULE_WITHOUT_VERIFICATION" && f.severity === "error")).toBe(true);
    });
  });

  test("flags a verification file without <test-files>", () => {
    withProject({ testFiles: [] }, (root) => {
      const { findings } = collectCoverage(root, loadConfig(root).config);
      expect(findings.some((f) => f.code === "VERIFICATION_WITHOUT_TEST_FILES")).toBe(true);
    });
  });

  test("flags a declared test file that does not exist", () => {
    withProject({ testFiles: ["src/ghost.test.ts"], testFileExists: false }, (root) => {
      const { report, findings } = collectCoverage(root, loadConfig(root).config);
      expect(report.testFilesMissing).toEqual(["src/ghost.test.ts"]);
      expect(findings.some((f) => f.code === "TEST_FILE_MISSING")).toBe(true);
    });
  });

  test("rejects unsafe (traversal) test file entries", () => {
    withProject({ testFiles: ["../../etc/passwd"] }, (root) => {
      const { findings } = collectCoverage(root, loadConfig(root).config);
      expect(findings.some((f) => f.code === "UNSAFE_TEST_FILE")).toBe(true);
    });
  });
});

describe("runCiGate", () => {
  test("passes a consistent project", () => {
    withProject({}, (root) => {
      const result = runCiGate(root);
      expect(result.exitCode).toBe(0);
      expect(result.findings.filter((f) => f.severity === "error")).toEqual([]);
      expect(result.tests).toBeUndefined();
    });
  });

  test("fails on a missing verification test file", () => {
    withProject({ testFiles: ["src/ghost.test.ts"], testFileExists: false }, (root) => {
      const result = runCiGate(root);
      expect(result.exitCode).toBe(1);
      expect(result.findings.some((f) => f.code === "TEST_FILE_MISSING")).toBe(true);
    });
  });

  test("fails on malformed index XML (lint finding, exit 1)", () => {
    withProject({}, (root) => {
      writeFileSync(join(root, "docs", "plan-index.xml"), '<PlanIndex project="F">\n  <Phase-1 name="x"\n</PlanIndex>\n');
      const result = runCiGate(root);
      expect(result.exitCode).toBe(1);
      expect(result.findings.some((f) => f.code === "XML_INVALID")).toBe(true);
    });
  });

  test("refuses trust-gated tests without trust and returns exit 2", () => {
    withProject({ command: "true" }, (root) => {
      const result = runCiGate(root, { tests: true });
      expect(result.exitCode).toBe(2);
      expect(result.refusal?.code).toBe("UNTRUSTED_PROJECT");
      expect(result.tests?.authorized).toBe(false);
      expect(result.tests?.failed).toEqual([]);
    });
  });

  test("runs trust-gated tests with an explicit --allow-commands opt-in", () => {
    withProject({ command: "true" }, (root) => {
      const result = runCiGate(root, { tests: true, allowCommands: true });
      expect(result.tests?.authorized).toBe(true);
      expect(result.tests?.modules).toBe(1);
      expect(result.tests?.passed).toBe(1);
      expect(result.exitCode).toBe(0);
    });
  });
});

describe("ciCommand", () => {
  test("is registered with the documented metadata", () => {
    const meta = typeof ciCommand.meta === "object" ? (ciCommand.meta as { name?: string }) : undefined;
    expect(meta?.name).toBe("ci");
    expect(typeof ciCommand.run).toBe("function");
  });

  test("end-to-end: `mygrace ci` on the shipped demo passes with exit 0", () => {
    const output = execFileSync(process.execPath, ["run", CLI, "ci", "--path", DEMO], {
      encoding: "utf-8",
      env: { ...process.env, MYGRACE_PROJECT_ROOT: DEMO },
    });
    expect(output).toContain("CI PASS");
    expect(output).toContain("0 errors, 0 warnings");
  }, 30_000);

  test("end-to-end: `mygrace ci --format json` returns a parseable PASS envelope", () => {
    const output = execFileSync(process.execPath, ["run", CLI, "ci", "--path", DEMO, "--format", "json"], {
      encoding: "utf-8",
      env: { ...process.env, MYGRACE_PROJECT_ROOT: DEMO },
    });
    const envelope = JSON.parse(output) as { ok: boolean; exitCode: number; findings: unknown[]; data: { coverage: { modules: number } } };
    expect(envelope.ok).toBe(true);
    expect(envelope.exitCode).toBe(0);
    expect(envelope.findings).toEqual([]);
    expect(envelope.data.coverage.modules).toBeGreaterThan(0);
  }, 30_000);
});
