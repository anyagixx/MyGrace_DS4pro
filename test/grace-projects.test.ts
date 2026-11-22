/**
 * W3.7 — monorepo discovery (`mygrace projects`).
 *
 * Proves bounded BFS discovery, per-project counts/lint/coverage summaries,
 * ignore rules, depth limits, scan truncation, exit codes (clean=0, lint
 * errors=1, --strict promotes warnings) and the JSON envelope shape.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cloneDefault, type MyGraceConfig } from "../src/grace-config";
import { UsageError } from "../src/grace-errors";
import {
  DEFAULT_MAX_DEPTH,
  PROJECT_MARKER,
  aggregateProjects,
  discoverProjects,
  projectsCommand,
  summarizeProject,
} from "../src/grace-projects";

const roots: string[] = [];
afterEach(() => {
  while (roots.length > 0) {
    const root = roots.pop();
    if (root !== undefined) rmSync(root, { recursive: true, force: true });
  }
});

// ─── Fixtures ──────────────────────────────────────────────────────────

function relaxedConfig(): MyGraceConfig {
  return {
    ...cloneDefault(),
    sizeBudgets: { module: [1, 500], phase: [1, 500], verification: [1, 500] },
    indexCaps: { graph: 100, plan: 50, verification: 100 },
  };
}

function tempRoot(prefix = "mygrace-projects-"): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

type ProjectMode = "clean" | "orphan" | "malformed" | "warning";

/**
 * Create a single project at `dir`.
 * - clean: zero lint/coverage findings (relaxed budgets);
 * - orphan: lint error (index entry without module file);
 * - malformed: malformed graph-index.xml (XML_INVALID error);
 * - warning: default budgets and a tiny module file (ENTITY_TOO_SMALL warning only).
 */
function makeProject(dir: string, name: string, mode: ProjectMode = "clean"): string {
  mkdirSync(join(dir, "docs", "modules"), { recursive: true });
  mkdirSync(join(dir, "docs", "plans"), { recursive: true });
  mkdirSync(join(dir, "docs", "verification"), { recursive: true });
  mkdirSync(join(dir, "src"), { recursive: true });
  mkdirSync(join(dir, "test"), { recursive: true });

  if (mode === "malformed") {
    writeFileSync(join(dir, "mygrace.config.json"), `${JSON.stringify(relaxedConfig(), null, 2)}\n`);
    writeFileSync(join(dir, "docs", "plan-index.xml"), `<PlanIndex project="${name}" version="1.0.0"></PlanIndex>\n`);
    writeFileSync(join(dir, "docs", "verification-index.xml"), `<VerificationIndex project="${name}"></VerificationIndex>\n`);
    writeFileSync(join(dir, "docs", "graph-index.xml"), `<GraphIndex project="${name}">\n  <M-BROKEN NAME="Broken"\n</GraphIndex>\n`);
    return dir;
  }

  if (mode !== "warning") {
    writeFileSync(join(dir, "mygrace.config.json"), `${JSON.stringify(relaxedConfig(), null, 2)}\n`);
  }
  writeFileSync(join(dir, "docs", "plan-index.xml"), `<PlanIndex project="${name}" version="1.0.0"></PlanIndex>\n`);
  const entries = [
    `<M-X NAME="X" TYPE="CORE_LOGIC" STATUS="done" PATH="src/x.ts" VERIFICATION_REF="V-M-X" />`,
  ];
  if (mode === "orphan") {
    entries.push(`<M-GHOST NAME="Ghost" TYPE="CORE_LOGIC" STATUS="done" PATH="src/ghost.ts" />`);
  }
  writeFileSync(
    join(dir, "docs", "graph-index.xml"),
    [`<GraphIndex project="${name}" version="1.0.0">`, ...entries.map((entry) => `  ${entry}`), `</GraphIndex>`, ``].join("\n")
  );
  writeFileSync(
    join(dir, "docs", "modules", "M-X.xml"),
    `<M-X NAME="X" TYPE="CORE_LOGIC" STATUS="done"><path>src/x.ts</path><verification-ref>V-M-X</verification-ref></M-X>\n`
  );
  writeFileSync(
    join(dir, "docs", "verification-index.xml"),
    `<VerificationIndex project="${name}">\n  <V-M-X MODULE="M-X" PRIORITY="medium" STATUS="done" />\n</VerificationIndex>\n`
  );
  writeFileSync(
    join(dir, "docs", "verification", "V-M-X.xml"),
    [
      `<V-M-X MODULE="M-X" PRIORITY="medium" STATUS="done">`,
      `  <test-files><file>test/x.test.ts</file></test-files>`,
      `  <module-checks><check-1>true</check-1></module-checks>`,
      `</V-M-X>`,
      ``,
    ].join("\n")
  );
  writeFileSync(join(dir, "src", "x.ts"), "export const x = 1;\n");
  writeFileSync(join(dir, "test", "x.test.ts"), "// placeholder\n");
  return dir;
}

function makeMonorepo(): { root: string; alpha: string; beta: string; broken: string; ignored: string } {
  const root = tempRoot("mygrace-monorepo-");
  writeFileSync(
    join(root, "mygrace.config.json"),
    `${JSON.stringify({ ignoreDirs: ["ignored_dir"] }, null, 2)}\n`
  );
  const alpha = makeProject(join(root, "alpha"), "Alpha", "clean");
  const beta = makeProject(join(root, "apps", "beta"), "Beta", "orphan");
  const broken = makeProject(join(root, "Broken"), "Broken", "malformed");
  const ignored = makeProject(join(root, "ignored_dir", "gamma"), "Gamma", "clean");
  makeProject(join(root, "node_modules", "delta"), "Delta", "clean");
  makeProject(join(root, ".bun-tmp", "epsilon"), "Epsilon", "clean");
  makeProject(join(root, "deep", "a", "b", "c", "deepclean"), "Deep", "clean");
  return { root, alpha, beta, broken, ignored };
}

interface CommandResult {
  exit: number;
  stdout: string;
  stderr: string;
}

async function runProjects(args: Record<string, unknown>): Promise<CommandResult> {
  const originalExit = process.exit;
  const originalLog = console.log;
  const originalError = console.error;
  const originalWrite = process.stdout.write;
  const originalErrorWrite = process.stderr.write;
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
    await projectsCommand.run!({ args } as never);
  } catch (error) {
    if (!(error instanceof Error) || !error.message.startsWith("exit:")) throw error;
  } finally {
    process.exit = originalExit;
    console.log = originalLog;
    console.error = originalError;
    process.stdout.write = originalWrite;
    process.stderr.write = originalErrorWrite;
  }
  return { exit: exitCode ?? 0, stdout: stdout.join("\n"), stderr: stderr.join("\n") };
}

interface ProjectsJson {
  ok: boolean;
  exitCode: number;
  findings: { severity: string; code: string }[];
  data?: {
    root: string;
    depth: number;
    truncated: boolean;
    projects: {
      name: string;
      root: string;
      modules: number;
      phases: number;
      verifications: number;
      lint: { errors: number; warnings: number };
      coverage: { modules: number; withVerification: number };
      status: string;
    }[];
    totals: {
      projects: number;
      clean: number;
      findings: number;
      errors: number;
      warnings: number;
      modules: number;
    };
  };
}

function parseJson(result: CommandResult): ProjectsJson {
  return JSON.parse(result.stdout) as ProjectsJson;
}

// ─── Tests ─────────────────────────────────────────────────────────────

describe("discoverProjects", () => {
  test("finds projects inside the depth limit and skips ignored/vendor directories", () => {
    const { root, alpha, broken } = makeMonorepo();
    const discovery = discoverProjects(root, { maxDepth: 2 });
    const found = discovery.projects.map((project) => project.name).sort();
    expect(found).toEqual(["Alpha", "Beta", "Broken"]);
    expect(discovery.projects.some((project) => project.root === alpha)).toBe(true);
    expect(discovery.projects.some((project) => project.root === broken)).toBe(true);
    expect(discovery.projects.some((project) => project.name === "Gamma")).toBe(false);
    expect(discovery.projects.some((project) => project.name === "Delta")).toBe(false);
    expect(discovery.projects.some((project) => project.name === "Epsilon")).toBe(false);
    expect(discovery.projects.some((project) => project.name === "Deep")).toBe(false);
    expect(discovery.truncated).toBe(false);
  });

  test("depth 1 does not descend into apps/beta", () => {
    const { root } = makeMonorepo();
    const names = discoverProjects(root, { maxDepth: 1 }).projects.map((project) => project.name).sort();
    expect(names).toEqual(["Alpha", "Broken"]);
  });

  test("scan cap reports truncation", () => {
    const { root } = makeMonorepo();
    const discovery = discoverProjects(root, { maxDepth: 6, scanCap: 2 });
    expect(discovery.truncated).toBe(true);
    expect(discovery.scannedDirs).toBe(2);
  });

  test("includes the scan root when it is itself a project", () => {
    const root = tempRoot();
    makeProject(join(root, "solo"), "Solo", "clean");
    const discovery = discoverProjects(join(root, "solo"), { maxDepth: 4 });
    expect(discovery.projects.length).toBe(1);
    expect(discovery.projects[0]?.name).toBe("Solo");
    expect(discovery.projects[0]?.depth).toBe(0);
  });
});

describe("summarizeProject / aggregateProjects", () => {
  test("clean project has zero findings and clean status", () => {
    const root = tempRoot();
    makeProject(join(root, "clean"), "Clean", "clean");
    const summary = summarizeProject(join(root, "clean"));
    expect(summary.findings).toEqual([]);
    expect(summary.status).toBe("clean");
    expect(summary.modules).toBe(1);
    expect(summary.phases).toBe(0);
    expect(summary.verifications).toBe(1);
    expect(summary.coverage.withVerification).toBe(1);
  });

  test("orphan project reports lint errors and findings status", () => {
    const root = tempRoot();
    makeProject(join(root, "orphan"), "Orphan", "orphan");
    const summary = summarizeProject(join(root, "orphan"));
    expect(summary.lint.errors).toBeGreaterThan(0);
    expect(summary.findings.some((item) => item.code === "ORPHANED_INDEX_ENTRY")).toBe(true);
    expect(summary.status).toBe("findings");
  });

  test("aggregate totals sum project counts", () => {
    const root = tempRoot();
    makeProject(join(root, "clean"), "Clean", "clean");
    makeProject(join(root, "orphan"), "Orphan", "orphan");
    const summaries = [summarizeProject(join(root, "clean")), summarizeProject(join(root, "orphan"))];
    const totals = aggregateProjects(summaries);
    expect(totals.projects).toBe(2);
    expect(totals.clean).toBe(1);
    expect(totals.findings).toBe(1);
    expect(totals.errors).toBeGreaterThan(0);
    expect(totals.modules).toBe(3);
  });
});

describe("projectsCommand", () => {
  test("JSON discovery: 3 projects (clean/orphan/malformed), exit 1, shape complete", async () => {
    const { root } = makeMonorepo();
    const result = await runProjects({ path: root, depth: "2", format: "json" });
    expect(result.exit).toBe(1);
    const json = parseJson(result);
    expect(json.ok).toBe(false);
    expect(json.exitCode).toBe(1);
    expect(json.data?.root).toBe(root);
    expect(json.data?.depth).toBe(2);
    expect(json.data?.truncated).toBe(false);
    const names = json.data?.projects.map((project) => project.name).sort();
    expect(names).toEqual(["Alpha", "Beta", "Broken"]);
    expect(json.data?.totals.projects).toBe(3);
    expect(json.data?.totals.clean).toBe(1);
    expect(json.data?.totals.errors).toBeGreaterThan(0);
    const broken = json.data?.projects.find((project) => project.name === "Broken");
    expect(broken?.lint.errors).toBeGreaterThan(0);
    const alpha = json.data?.projects.find((project) => project.name === "Alpha");
    expect(alpha?.modules).toBe(1);
    expect(alpha?.coverage.withVerification).toBe(1);
    expect(json.findings.length).toBeGreaterThan(0);
  });

  test("clean single project: exit 0, ok true, no findings", async () => {
    const root = tempRoot();
    makeProject(join(root, "clean"), "CleanOne", "clean");
    const result = await runProjects({ path: join(root, "clean"), format: "json" });
    expect(result.exit).toBe(0);
    const json = parseJson(result);
    expect(json.ok).toBe(true);
    expect(json.data?.projects.length).toBe(1);
    expect(json.data?.projects[0]?.name).toBe("CleanOne");
    expect(json.data?.totals.clean).toBe(1);
    expect(json.findings).toEqual([]);
  });

  test("--strict promotes warnings to exit 1", async () => {
    const root = tempRoot();
    makeProject(join(root, "warning"), "Warning", "warning");
    const normal = await runProjects({ path: join(root, "warning"), format: "json" });
    expect(normal.exit).toBe(0);
    const normalJson = parseJson(normal);
    expect(normalJson.data?.projects[0]?.lint.warnings).toBeGreaterThan(0);
    expect(normalJson.findings.some((item) => item.code === "ENTITY_TOO_SMALL")).toBe(true);

    const strict = await runProjects({ path: join(root, "warning"), format: "json", strict: true });
    expect(strict.exit).toBe(1);
  });

  test("depth flag limits discovery in text mode", async () => {
    const { root } = makeMonorepo();
    const shallow = await runProjects({ path: root, depth: "1" });
    expect(shallow.exit).toBe(1);
    expect(shallow.stdout).toContain("Alpha");
    expect(shallow.stdout).not.toContain("Beta");
    expect(shallow.stdout).toContain("Totals:");

    const deeper = await runProjects({ path: root, depth: "2" });
    expect(deeper.stdout).toContain("Beta");
  });

  test("no projects found: exit 0 and an explicit message", async () => {
    const empty = tempRoot();
    const text = await runProjects({ path: empty });
    expect(text.exit).toBe(0);
    expect(text.stdout).toContain("No MyGRACE projects found");

    const json = await runProjects({ path: empty, format: "json" });
    expect(json.exit).toBe(0);
    const parsed = parseJson(json);
    expect(parsed.data?.projects).toEqual([]);
    expect(parsed.data?.totals.projects).toBe(0);
    expect(parsed.ok).toBe(true);
  });

  test("invalid scan path and depth are usage errors", async () => {
    const empty = tempRoot();
    await expect(runProjects({ path: join(empty, "missing") })).rejects.toBeInstanceOf(UsageError);
    await expect(runProjects({ path: empty, depth: "not-a-number" })).rejects.toBeInstanceOf(UsageError);
    await expect(runProjects({ path: empty, format: "yaml" })).rejects.toBeInstanceOf(UsageError);
  });

  test("text table contains per-project rows, totals and findings", async () => {
    const { root } = makeMonorepo();
    const result = await runProjects({ path: root, depth: "2" });
    expect(result.exit).toBe(1);
    expect(result.stdout).toContain("MyGRACE projects");
    expect(result.stdout).toContain("PROJECT");
    expect(result.stdout).toContain("ORPHANED_INDEX_ENTRY");
    expect(result.stdout).toContain("Totals:");
    expect(result.stdout).toContain("Alpha");
  });

  test("defaults and constants are exported for tooling", () => {
    expect(DEFAULT_MAX_DEPTH).toBe(4);
    expect(PROJECT_MARKER).toBe(join("docs", "graph-index.xml"));
  });
});
