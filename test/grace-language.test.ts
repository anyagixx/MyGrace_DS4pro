/**
 * Multi-language proof (ROADMAP G12 / ADR-5).
 *
 * Proves that the markup/lint/status/CI/test-runner paths are driven by
 * `mygrace.config.json` (sourceDirs, markupExts, ignoreDirs, testRunner,
 * language) and are not TypeScript- or `src/`-specific:
 *
 *  - Python layout (`app`, `lib`, `.py`, `.venv` ignored) and Go layout
 *    (`cmd`, `internal`, `.go`, `vendor` ignored) are linted for real;
 *  - semantic markup using Python `#` and Go `//` comments is understood;
 *  - bad markup outside sourceDirs / inside ignoreDirs / outside markupExts is
 *    NOT reported;
 *  - a non-TS module PATH (`app/store.py`) resolves in lint and status;
 *  - the configured `testRunner` flows through plan → authorization → execution
 *    (`--allow-commands`) and through `runCiGate({tests:true})`;
 *  - index caps and size budgets behave identically in every language.
 *
 * Everything is created under `os.tmpdir()`; no network and no writes outside
 * the temporary project roots. Python execution tests skip when python3 is
 * unavailable.
 */

import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { analyzeMarkup, collectLintIssues } from "../src/grace-lint";
import { buildStatusSnapshot } from "../src/grace-status";
import { runCiGate } from "../src/grace-ci";
import { loadConfig } from "../src/grace-config";
import { planModuleTest, runModuleTests } from "../src/grace-test";
import { ConfigError } from "../src/grace-errors";
import type { Finding } from "../src/grace-errors";
import type { MyGraceConfig } from "../src/grace-config";

// ─── python availability ───────────────────────────────────────────────

function hasExecutable(name: string): boolean {
  const probe = spawnSync(name, ["--version"], { encoding: "utf-8" });
  return probe.status === 0;
}

const hasPython = hasExecutable("python3");
/** `test.skip` keeps the suite green on machines without python3 (CI-safe). */
const executeTest = hasPython ? test : test.skip;

// ─── temp project fixtures ─────────────────────────────────────────────

interface ModuleSpec {
  id: string;
  name: string;
  type: string;
  status: string;
  path: string;
  depends?: string;
}

interface VerificationSpec {
  id: string;
  priority?: string;
  status?: string;
  testFiles?: string[];
  /** Canonical `<module-checks>`; omitted to exercise the config testRunner. */
  command?: string;
}

interface PhaseSpec {
  number: number;
  name?: string;
  status?: string;
  steps?: number;
}

interface ProjectOptions {
  config: Record<string, unknown>;
  modules: ModuleSpec[];
  verifications: VerificationSpec[];
  phases?: PhaseSpec[];
}

function writeFile(root: string, relativePath: string, content: string): void {
  const absolute = join(root, relativePath);
  mkdirSync(dirname(absolute), { recursive: true });
  writeFileSync(absolute, content);
}

function moduleDoc(module: ModuleSpec): string {
  return [
    `<${module.id} NAME="${module.name}" TYPE="${module.type}" STATUS="${module.status}">`,
    `  <purpose>${module.name} module in the multi-language fixture</purpose>`,
    `  <path>${module.path}</path>`,
    `  <depends>${module.depends ?? "none"}</depends>`,
    `  <verification-ref>V-${module.id}</verification-ref>`,
    `  <contract><purpose>${module.name} contract</purpose></contract>`,
    `</${module.id}>`,
    "",
  ].join("\n");
}

function verificationDoc(verification: VerificationSpec, module: ModuleSpec): string {
  const lines = [
    `<V-${verification.id} MODULE="${verification.id}" PRIORITY="${verification.priority ?? "medium"}" STATUS="${verification.status ?? module.status}">`,
    "  <test-files>",
  ];
  for (const file of verification.testFiles ?? []) lines.push(`    <file>${file}</file>`);
  lines.push("  </test-files>");
  if (verification.command !== undefined) {
    lines.push("  <module-checks>", `    <check-1>${verification.command}</check-1>`, "  </module-checks>");
  }
  lines.push("  <scenarios>", '    <scenario-1 kind="success">works</scenario-1>', "  </scenarios>");
  lines.push(`</V-${verification.id}>`, "");
  return lines.join("\n");
}

function phaseDoc(phase: PhaseSpec, modules: readonly ModuleSpec[]): string {
  const status = phase.status ?? "done";
  const steps = modules.length === 0 ? 0 : (phase.steps ?? 1);
  const lines = [`<Phase-${phase.number} name="${phase.name ?? `Phase ${phase.number}`}" status="${status}">`];
  for (let index = 0; index < steps; index++) {
    const owner = modules[index % modules.length]!;
    lines.push(
      `  <step-${index + 1} module="${owner.id}" status="${status}">`,
      `    <description>Implement ${owner.name} for phase ${phase.number}</description>`,
      `  </step-${index + 1}>`
    );
  }
  lines.push(`</Phase-${phase.number}>`, "");
  return lines.join("\n");
}

function buildProject(root: string, options: ProjectOptions): void {
  writeFile(root, "mygrace.config.json", `${JSON.stringify(options.config, null, 2)}\n`);

  const graphLines = [
    '<GraphIndex project="MultiLang" version="1.0.0">',
    "  <keywords>multi-language, python, go, mygrace</keywords>",
  ];
  for (const module of options.modules) {
    graphLines.push(
      `  <${module.id} NAME="${module.name}" TYPE="${module.type}" STATUS="${module.status}" ` +
        `PATH="${module.path}" DEPENDS="${module.depends ?? ""}" VERIFICATION_REF="V-${module.id}" />`
    );
  }
  graphLines.push("</GraphIndex>", "");
  writeFile(root, "docs/graph-index.xml", graphLines.join("\n"));

  const phases = options.phases ?? [{ number: 1, status: "done", steps: 1 }];
  const planLines = ['<PlanIndex project="MultiLang" version="1.0.0">'];
  for (const phase of phases) {
    const steps = options.modules.length === 0 ? 0 : (phase.steps ?? 1);
    planLines.push(
      `  <Phase-${phase.number} name="${phase.name ?? `Phase ${phase.number}`}" status="${phase.status ?? "done"}" steps="${steps}" />`
    );
  }
  planLines.push("</PlanIndex>", "");
  writeFile(root, "docs/plan-index.xml", planLines.join("\n"));

  const verificationLines = ['<VerificationIndex project="MultiLang" version="1.0.0">'];
  for (const verification of options.verifications) {
    const module = options.modules.find((candidate) => candidate.id === verification.id);
    verificationLines.push(
      `  <V-${verification.id} MODULE="${verification.id}" PRIORITY="${verification.priority ?? "medium"}" STATUS="${verification.status ?? module?.status ?? "done"}" />`
    );
  }
  verificationLines.push("</VerificationIndex>", "");
  writeFile(root, "docs/verification-index.xml", verificationLines.join("\n"));

  for (const module of options.modules) {
    writeFile(root, `docs/modules/${module.id}.xml`, moduleDoc(module));
    const verification = options.verifications.find((candidate) => candidate.id === module.id);
    if (verification !== undefined) {
      writeFile(root, `docs/verification/V-${verification.id}.xml`, verificationDoc(verification, module));
    }
  }
  for (const phase of phases) {
    const steps = options.modules.length === 0 ? 0 : (phase.steps ?? 1);
    writeFile(root, `docs/plans/Phase-${phase.number}.xml`, phaseDoc({ ...phase, steps }, options.modules));
  }
}

function withProject<T>(build: (root: string) => void, run: (root: string) => T): T {
  const root = mkdtempSync(join(tmpdir(), "mygrace-lang-"));
  try {
    build(root);
    return run(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function findingsForFile(findings: readonly Finding[], file: string): Finding[] {
  return findings.filter((finding) => finding.file === file);
}

function codesOf(findings: readonly Finding[]): Set<string> {
  return new Set(findings.map((finding) => finding.code));
}

function filesOfCode(findings: readonly Finding[], code: string): string[] {
  return findings.filter((finding) => finding.code === code).map((finding) => finding.file ?? "<project>").sort();
}

// ─── Python / Go fixture content ───────────────────────────────────────

const PYTHON_CONTRACT = [
  "# START_MODULE_CONTRACT",
  "#   PURPOSE: Serve storefront requests",
  "#   SCOPE: HTTP handlers only",
  "#   DEPENDS: none",
  "#   LINKS: docs/modules/M-STORE.xml",
  "# END_MODULE_CONTRACT",
  "# START_MODULE_MAP",
  "#   store - storefront entry point",
  "# END_MODULE_MAP",
  "",
].join("\n");

const PYTHON_CLEAN = `${PYTHON_CONTRACT}${[
  "# START_BLOCK_VALIDATE",
  "def store():",
  '    return {"ok": True}',
  "# END_BLOCK_VALIDATE",
  "",
].join("\n")}`;

const PYTHON_UNPAIRED = `${PYTHON_CONTRACT}${[
  "# START_BLOCK_VALIDATE",
  "def store():",
  '    return {"ok": True}',
  "",
].join("\n")}`;

const GO_CONTRACT = [
  "// START_MODULE_CONTRACT",
  "//   PURPOSE: Serve API requests",
  "//   SCOPE: command and internal packages",
  "//   DEPENDS: none",
  "//   LINKS: docs/modules/M-APP.xml",
  "// END_MODULE_CONTRACT",
  "// START_MODULE_MAP",
  "//   main - API entry point",
  "// END_MODULE_MAP",
  "",
].join("\n");

const GO_CLEAN = `${GO_CONTRACT}${[
  "// START_BLOCK_HANDLE",
  "func handle() int {",
  "\treturn 0",
  "}",
  "// END_BLOCK_HANDLE",
  "",
].join("\n")}`;

const GO_UNPAIRED = `${GO_CONTRACT}${[
  "// START_BLOCK_HANDLE",
  "func handle() int {",
  "\treturn 0",
  "}",
  "",
].join("\n")}`;

const RELAXED_BUDGETS = {
  module: [3, 200],
  phase: [3, 400],
  verification: [3, 200],
};

function pythonConfig(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    sourceDirs: ["app", "lib"],
    markupExts: [".py"],
    ignoreDirs: ["node_modules", ".venv", "__pycache__", "generated_py", ".git"],
    sizeBudgets: RELAXED_BUDGETS,
    indexCaps: { graph: 100, plan: 50, verification: 80 },
    testRunner: `python3 -c "print('RUNNER-OK')"`,
    language: "python",
    ...overrides,
  };
}

function goConfig(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    sourceDirs: ["cmd", "internal"],
    markupExts: [".go"],
    ignoreDirs: ["vendor", "testdata", "node_modules", ".git"],
    sizeBudgets: RELAXED_BUDGETS,
    indexCaps: { graph: 100, plan: 50, verification: 80 },
    testRunner: "go test ./...",
    language: "go",
    ...overrides,
  };
}

// ─── 1. Python layout ──────────────────────────────────────────────────

describe("python project layout", () => {
  const module: ModuleSpec = {
    id: "M-STORE",
    name: "Store",
    type: "CORE_LOGIC",
    status: "done",
    path: "app/store.py",
  };
  const verification: VerificationSpec = {
    id: "M-STORE",
    priority: "high",
    testFiles: ["app/test_store.py"],
  };

  test("sourceDirs/markupExts/ignoreDirs gate what the markup scanner sees", () => {
    withProject(
      (root) => {
        buildProject(root, { config: pythonConfig(), modules: [module], verifications: [verification] });
        writeFile(root, "app/store.py", PYTHON_UNPAIRED);
        writeFile(root, "app/test_store.py", "# python test file\n");
        writeFile(root, "lib/utils.py", PYTHON_CLEAN);
        writeFile(root, ".venv/lib/site.py", PYTHON_UNPAIRED);
        writeFile(root, "node_modules/pkg/index.py", PYTHON_UNPAIRED);
        writeFile(root, "__pycache__/store.py", PYTHON_UNPAIRED);
        writeFile(root, "packages/outside.py", PYTHON_UNPAIRED);
        writeFile(root, "app/generated_py/bad.py", PYTHON_UNPAIRED);
        writeFile(root, "app/notes.txt", PYTHON_UNPAIRED);
        writeFile(root, "app/legacy.ts", "// START_BLOCK_TS_LEGACY\nconst x = 1;\n");
      },
      (root) => {
        const findings = collectLintIssues(root, false);

        // The configured python source file is flagged …
        const unpaired = findings.filter((finding) => finding.code === "UNPAIRED_BLOCK");
        expect(unpaired.map((finding) => finding.file)).toEqual(["app/store.py"]);
        expect(unpaired[0]?.severity).toBe("error");
        expect(unpaired[0]?.message).toContain("START_BLOCK_VALIDATE");
        expect(unpaired[0]?.message).toMatch(/line \d+/);

        // … while ignored dirs, paths outside sourceDirs, non-markupExts files
        // and non-sourceDirs siblings are NOT scanned.
        for (const prefix of [
          ".venv/",
          "node_modules/",
          "__pycache__/",
          "generated_py/",
          "app/generated_py/",
          "packages/",
          "app/legacy.ts",
          "app/notes.txt",
        ]) {
          expect(findings.some((finding) => finding.file?.startsWith(prefix))).toBe(false);
        }
        expect(findingsForFile(findings, "lib/utils.py")).toEqual([]);

        // The CI gate honours the same config-driven scan boundaries.
        const gate = runCiGate(root, {});
        expect(gate.findings.some((finding) => finding.code === "UNPAIRED_BLOCK")).toBe(true);
        expect(gate.findings.some((finding) => finding.file === "app/store.py")).toBe(true);
        expect(gate.findings.some((finding) => finding.file?.startsWith(".venv/") || finding.file?.startsWith("packages/"))).toBe(false);
        expect(gate.status?.modules.total).toBe(1);
        expect(gate.exitCode).toBe(1);

        // Python `#` comments are recognised as markup and contract comments.
        const analysis = analyzeMarkup(PYTHON_UNPAIRED);
        expect(analysis.blockIssues.map((issue) => issue.code)).toEqual(["UNPAIRED_BLOCK"]);
        expect(analysis.contract?.fields.PURPOSE).toBe("Serve storefront requests");
        expect(analysis.contract?.fields.SCOPE).toBe("HTTP handlers only");
        expect(analysis.contract?.fields.DEPENDS).toBe("none");
        expect(analysis.contract?.fields.LINKS).toBe("docs/modules/M-STORE.xml");

        // Findings are deterministic across repeated runs.
        expect(collectLintIssues(root, false)).toEqual(findings);
      }
    );
  });

  test("module PATH app/store.py resolves in lint and is counted by status", () => {
    withProject(
      (root) => {
        buildProject(root, { config: pythonConfig(), modules: [module], verifications: [verification] });
        writeFile(root, "app/store.py", PYTHON_CLEAN);
        writeFile(root, "app/test_store.py", "# python test file\n");
      },
      (root) => {
        const findings = collectLintIssues(root, false);
        expect(filesOfCode(findings, "MODULE_PATH_NOT_FOUND")).toEqual([]);
        expect(findings.filter((finding) => finding.severity === "error")).toEqual([]);

        const status = buildStatusSnapshot(root);
        expect(status.modules.total).toBe(1);
        expect(status.modules.byStatus.done).toBe(1);
        expect(status.lint.errors).toBe(0);
        expect(status.indexErrors).toEqual([]);
      }
    );
  });

  test("a missing non-TS module PATH is still reported (language-independent check)", () => {
    const missing: ModuleSpec = { ...module, id: "M-GHOST", name: "Ghost", path: "app/ghost.py" };
    withProject(
      (root) => {
        buildProject(root, {
          config: pythonConfig(),
          modules: [missing],
          verifications: [{ id: "M-GHOST", testFiles: ["app/test_ghost.py"] }],
        });
        writeFile(root, "app/test_ghost.py", "# python test file\n");
      },
      (root) => {
        const findings = collectLintIssues(root, false);
        const pathFindings = findings.filter((finding) => finding.code === "MODULE_PATH_NOT_FOUND");
        expect(pathFindings).toHaveLength(1);
        expect(pathFindings[0]?.severity).toBe("error");
        expect(pathFindings[0]?.message).toContain("app/ghost.py");
      }
    );
  });
});

// ─── 2. Go layout ──────────────────────────────────────────────────────

describe("go project layout", () => {
  test("cmd/internal are scanned, vendor/ and non-.go files are ignored", () => {
    const module: ModuleSpec = {
      id: "M-APP",
      name: "App",
      type: "ENTRY_POINT",
      status: "done",
      path: "cmd/main.go",
    };
    withProject(
      (root) => {
        buildProject(root, {
          config: goConfig(),
          modules: [module],
          verifications: [{ id: "M-APP", testFiles: ["cmd/main_test.go"] }],
        });
        writeFile(root, "cmd/main.go", GO_UNPAIRED);
        writeFile(root, "cmd/main_test.go", "package main\n");
        writeFile(root, "internal/clean.go", GO_CLEAN);
        writeFile(root, "vendor/dep/evil.go", GO_UNPAIRED);
        writeFile(root, "internal/testdata/evil.go", GO_UNPAIRED);
        writeFile(root, "apps/outside.go", GO_UNPAIRED);
        writeFile(root, "src/outside.go", GO_UNPAIRED);
        writeFile(root, "cmd/notes.txt", GO_UNPAIRED);
      },
      (root) => {
        const findings = collectLintIssues(root, false);
        expect(filesOfCode(findings, "UNPAIRED_BLOCK")).toEqual(["cmd/main.go"]);
        for (const prefix of ["vendor/", "internal/testdata/", "apps/", "src/", "cmd/notes.txt"]) {
          expect(findings.some((finding) => finding.file?.startsWith(prefix))).toBe(false);
        }
        expect(findingsForFile(findings, "internal/clean.go")).toEqual([]);

        const analysis = analyzeMarkup(GO_UNPAIRED);
        expect(analysis.blockIssues.map((issue) => issue.code)).toEqual(["UNPAIRED_BLOCK"]);
        expect(analysis.contract?.fields.PURPOSE).toBe("Serve API requests");
        expect(analysis.contract?.fields.LINKS).toBe("docs/modules/M-APP.xml");
      }
    );
  });
});

// ─── 3. Configured testRunner ──────────────────────────────────────────

describe("configured testRunner", () => {
  const module: ModuleSpec = {
    id: "M-STORE",
    name: "Store",
    type: "CORE_LOGIC",
    status: "done",
    path: "app/store.py",
  };

  function buildRunnerProject(root: string): void {
    buildProject(root, {
      config: pythonConfig(),
      modules: [module],
      // No <module-checks>: the config testRunner is the declared command.
      verifications: [{ id: "M-STORE", priority: "high", testFiles: ["app/test_store.py"] }],
    });
    writeFile(root, "app/store.py", PYTHON_CLEAN);
    writeFile(root, "app/test_store.py", "# python test file\n");
  }

  test("plan resolves the command from config, not from `bun test`", () => {
    withProject(buildRunnerProject, (root) => {
      const config = loadConfig(root).config;
      expect(config.language).toBe("python");
      expect(config.testRunner).toBe(`python3 -c "print('RUNNER-OK')"`);

      const plan = planModuleTest(root, "M-STORE", config);
      expect(plan.status).toBe("ready");
      expect(plan.source).toBe("config");
      expect(plan.command).toBe(config.testRunner);
      expect(plan.command).not.toContain("bun");
      expect(plan.files).toEqual(["app/test_store.py"]);
      expect(plan.argv[0]).toBe("python3");
      // argv-only execution: the runner token plus the validated <file> entry.
      expect(plan.argv).toEqual(["python3", "-c", "print('RUNNER-OK')", "app/test_store.py"]);
      expect(plan.argv).toContain("app/test_store.py");
      expect(plan.requiresShellOptIn).toBe(false);
    });
  });

  test("execution is refused without --allow-commands (trust model)", () => {
    withProject(buildRunnerProject, (root) => {
      const result = runModuleTests(root, "M-STORE");
      expect(result.ok).toBe(false);
      expect(result.refused).toBe(true);
      expect(result.output).toContain("Refusing to execute project command");
      expect(result.output).toContain("mygrace trust");
    });
  });

  executeTest("--allow-commands executes the configured runner and the CI gate reports it", () => {
    withProject(buildRunnerProject, (root) => {
      const result = runModuleTests(root, "M-STORE", { allowCommands: true });
      expect(result.ok).toBe(true);
      expect(result.source).toBe("config");
      expect(result.command).toBe(`python3 -c "print('RUNNER-OK')"`);
      expect(result.output).toContain("RUNNER-OK");
      expect(result.files).toEqual(["app/test_store.py"]);

      const gate = runCiGate(root, { tests: true, allowCommands: true });
      expect(gate.tests?.requested).toBe(true);
      expect(gate.tests?.authorized).toBe(true);
      expect(gate.tests?.via).toBe("flag");
      expect(gate.tests?.modules).toBe(1);
      expect(gate.tests?.passed).toBe(1);
      expect(gate.tests?.failed).toEqual([]);
      expect(gate.exitCode).toBe(0);
      // The configured runner (not bun test) is the one that was executed.
      expect(codesOf(gate.findings).has("MODULE_CHECK_FAILED")).toBe(false);
    });
  });

  executeTest("a failing runner (non-zero exit) is reported as a failed module", () => {
    withProject(buildRunnerProject, (root) => {
      const config = loadConfig(root).config as MyGraceConfig;
      writeFile(
        root,
        "mygrace.config.json",
        `${JSON.stringify({ ...config, testRunner: `python3 -c "raise SystemExit(7)"` }, null, 2)}\n`
      );
      const result = runModuleTests(root, "M-STORE", { allowCommands: true });
      expect(result.ok).toBe(false);
      expect(result.refused).toBeUndefined();
      expect(result.command).toBe(`python3 -c "raise SystemExit(7)"`);
      expect(result.error?.code ?? "none").not.toBe("UNTRUSTED_PROJECT");
    });
  });
});

// ─── 4. Caps and budgets are language-independent ──────────────────────

describe("caps and budgets are language-independent", () => {
  function buildTinyProject(
    root: string,
    language: "python" | "go",
    overrides: Record<string, unknown>,
    options: { defaultBudgets?: boolean } = {}
  ): void {
    const python = language === "python";
    const module: ModuleSpec = python
      ? { id: "M-STORE", name: "Store", type: "CORE_LOGIC", status: "done", path: "app/store.py" }
      : { id: "M-APP", name: "App", type: "ENTRY_POINT", status: "done", path: "cmd/main.go" };
    const baseConfig = python ? pythonConfig(overrides) : goConfig(overrides);
    const config = options.defaultBudgets === true
      ? Object.fromEntries(Object.entries(baseConfig).filter(([key]) => key !== "sizeBudgets"))
      : baseConfig;
    buildProject(root, {
      config,
      modules: [module],
      verifications: [{ id: module.id, testFiles: [python ? "app/test_store.py" : "cmd/main_test.go"] }],
    });
    if (python) {
      writeFile(root, "app/store.py", PYTHON_CLEAN);
      writeFile(root, "app/test_store.py", "# python test file\n");
    } else {
      writeFile(root, "cmd/main.go", GO_CLEAN);
      writeFile(root, "cmd/main_test.go", "package main\n");
    }
  }

  test("default size budgets apply to Python and Go artifacts identically", () => {
    const budgetFindings = (language: "python" | "go") =>
      withProject(
        (root) => buildTinyProject(root, language, {}, { defaultBudgets: true }),
        (root) => {
          const findings = collectLintIssues(root, false);
          return {
            small: findings.filter((finding) => finding.code === "ENTITY_TOO_SMALL"),
            codes: codesOf(findings),
          };
        }
      );

    const python = budgetFindings("python");
    const go = budgetFindings("go");

    // Tiny module docs violate the default 30-line minimum in both languages.
    expect(python.small.length).toBeGreaterThan(0);
    expect(go.small.length).toBeGreaterThan(0);
    expect(python.small.filter((finding) => finding.file === "docs/modules/M-STORE.xml").length).toBe(1);
    expect(go.small.filter((finding) => finding.file === "docs/modules/M-APP.xml").length).toBe(1);
    expect(python.small.every((finding) => finding.severity === "warning")).toBe(true);
    expect(go.small.every((finding) => finding.severity === "warning")).toBe(true);
  });

  test("configured index caps and size budgets are honoured in both languages", () => {
    const capped = (language: "python" | "go") =>
      withProject(
        (root) =>
          buildTinyProject(root, language, {
            indexCaps: { graph: 3, plan: 50, verification: 80 },
            sizeBudgets: { module: [1, 2], phase: [1, 2], verification: [1, 2] },
          }),
        (root) => {
          const findings = collectLintIssues(root, false);
          return {
            indexTooLarge: findings.filter((finding) => finding.code === "INDEX_TOO_LARGE"),
            entityTooLarge: findings.filter((finding) => finding.code === "ENTITY_TOO_LARGE"),
            codes: codesOf(findings),
          };
        }
      );

    const python = capped("python");
    const go = capped("go");
    for (const result of [python, go]) {
      expect(result.codes.has("INDEX_TOO_LARGE")).toBe(true);
      expect(result.codes.has("ENTITY_TOO_LARGE")).toBe(true);
      expect(result.indexTooLarge.length).toBeGreaterThan(0);
      expect(result.entityTooLarge.length).toBeGreaterThan(0);
      expect(result.indexTooLarge.every((finding) => finding.severity === "error")).toBe(true);
      expect(result.entityTooLarge.every((finding) => finding.severity === "warning")).toBe(true);
    }
    // Same configuration → same documented rule, regardless of language.
    expect(python.indexTooLarge[0]?.code).toBe(go.indexTooLarge[0]?.code);
    expect(python.entityTooLarge[0]?.code).toBe(go.entityTooLarge[0]?.code);
  });

  test("the config `language` label is loaded for non-TS projects", () => {
    for (const [language, config] of [
      ["python", pythonConfig()],
      ["go", goConfig()],
    ] as const) {
      withProject(
        (root) => buildProject(root, { config, modules: [], verifications: [] }),
        (root) => {
          const loaded = loadConfig(root).config;
          expect(loaded.language).toBe(language);
          expect(loaded.markupExts.some((ext) => ext === (language === "python" ? ".py" : ".go"))).toBe(true);
          expect(loaded.sourceDirs).not.toContain("src");
        }
      );
    }
  });
});

// ─── 5. Config errors stay language-independent ────────────────────────

describe("config validation", () => {
  test("a non-TS project with an invalid config still throws ConfigError", () => {
    withProject(
      (root) => writeFile(root, "mygrace.config.json", '{"sourceDirs":["app"],"markupExts":"py"}'),
      (root) => {
        expect(() => loadConfig(root)).toThrow(ConfigError);
      }
    );
  });
});
