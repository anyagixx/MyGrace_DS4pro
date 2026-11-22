/**
 * W3.6 — incremental `lint --changed`.
 *
 * Proves the changed-file scope end-to-end against real git repositories:
 * source-only markup findings, index-triggered full index checks, entity
 * drift/orphan scope, explicit `--files`, USAGE outside git, `--strict`
 * promotion and the JSON `data.scope {changed, scanned, skipped}` shape.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cloneDefault, type MyGraceConfig } from "../src/grace-config";
import { UsageError } from "../src/grace-errors";
import { lintCommand, resolveChangedFiles } from "../src/grace-lint";

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

const CLEAN_SOURCE = [
  "// START_MODULE_CONTRACT",
  "//   PURPOSE: fixture source",
  "//   SCOPE: fixture source",
  "//   DEPENDS: none",
  "//   LINKS: docs/modules/M-A.xml",
  "// END_MODULE_CONTRACT",
  "// START_BLOCK_A",
  "export const a = 1;",
  "// END_BLOCK_A",
  "",
].join("\n");

/** Minimal lint-clean single-module project (default config relaxed for budgets). */
function makeProject(options: { source?: string; moduleStatus?: string } = {}): string {
  const root = mkdtempSync(join(tmpdir(), "mygrace-changed-"));
  roots.push(root);
  mkdirSync(join(root, "docs", "modules"), { recursive: true });
  mkdirSync(join(root, "docs", "plans"), { recursive: true });
  mkdirSync(join(root, "docs", "verification"), { recursive: true });
  mkdirSync(join(root, "src"), { recursive: true });
  mkdirSync(join(root, "test"), { recursive: true });
  writeFileSync(join(root, "mygrace.config.json"), `${JSON.stringify(relaxedConfig(), null, 2)}\n`);
  writeFileSync(join(root, "docs", "plan-index.xml"), `<PlanIndex project="Fixture" version="1.0.0"></PlanIndex>\n`);
  writeFileSync(
    join(root, "docs", "graph-index.xml"),
    [
      `<GraphIndex project="Fixture" version="1.0.0">`,
      `  <M-A NAME="A" TYPE="CORE_LOGIC" STATUS="done" PATH="src/a.ts" VERIFICATION_REF="V-M-A" />`,
      `</GraphIndex>`,
      ``,
    ].join("\n")
  );
  const moduleStatus = options.moduleStatus ?? "done";
  writeFileSync(
    join(root, "docs", "modules", "M-A.xml"),
    `<M-A NAME="A" TYPE="CORE_LOGIC" STATUS="${moduleStatus}"><path>src/a.ts</path><verification-ref>V-M-A</verification-ref></M-A>\n`
  );
  writeFileSync(
    join(root, "docs", "verification-index.xml"),
    `<VerificationIndex project="Fixture">\n  <V-M-A MODULE="M-A" PRIORITY="medium" STATUS="done" />\n</VerificationIndex>\n`
  );
  writeFileSync(
    join(root, "docs", "verification", "V-M-A.xml"),
    [
      `<V-M-A MODULE="M-A" PRIORITY="medium" STATUS="done">`,
      `  <test-files><file>test/a.test.ts</file></test-files>`,
      `  <module-checks><check-1>true</check-1></module-checks>`,
      `</V-M-A>`,
      ``,
    ].join("\n")
  );
  writeFileSync(join(root, "src", "a.ts"), options.source ?? CLEAN_SOURCE);
  writeFileSync(join(root, "test", "a.test.ts"), "// placeholder\n");
  return root;
}

function git(root: string, args: readonly string[]): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync("git", ["-C", root, ...args], {
    encoding: "utf-8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "MyGRACE Test",
      GIT_AUTHOR_EMAIL: "test@example.com",
      GIT_COMMITTER_NAME: "MyGRACE Test",
      GIT_COMMITTER_EMAIL: "test@example.com",
    },
  });
  return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

function initGitProject(root: string): void {
  const init = git(root, ["init", "-q"]);
  expect(init.status).toBe(0);
  expect(git(root, ["add", "-A"]).status).toBe(0);
  const commit = git(root, ["commit", "-q", "-m", "baseline"]);
  expect(commit.status).toBe(0);
}

interface CommandResult {
  exit: number;
  stdout: string;
  stderr: string;
}

async function runLint(args: Record<string, unknown>): Promise<CommandResult> {
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
    await lintCommand.run!({ args } as never);
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

interface LintJson {
  ok: boolean;
  exitCode: number;
  findings: { severity: string; code: string; file?: string }[];
  data?: {
    scope?: { changed: string[]; scanned: string[]; skipped: string[] };
    counts?: { errors: number; warnings: number };
  };
}

function parseJson(result: CommandResult): LintJson {
  return JSON.parse(result.stdout) as LintJson;
}

// ─── Tests ─────────────────────────────────────────────────────────────

describe("lint --changed (git scope)", () => {
  test("changed source file: only its markup finding is in scope", async () => {
    const root = makeProject();
    initGitProject(root);
    writeFileSync(join(root, "src", "a.ts"), `${CLEAN_SOURCE}// START_BLOCK_ONLY_START\n`);

    const result = await runLint({ path: root, changed: true, format: "json" });
    expect(result.exit).toBe(1);
    const json = parseJson(result);
    expect(json.ok).toBe(false);
    expect(json.findings.length).toBe(1);
    expect(json.findings[0]?.code).toBe("UNPAIRED_BLOCK");
    expect(json.findings[0]?.file).toBe("src/a.ts");
    expect(json.data?.scope?.changed).toEqual(["src/a.ts"]);
    expect(json.data?.scope?.scanned).toEqual(["src/a.ts"]);
  });

  test("unchanged git project: zero findings, exit 0", async () => {
    const root = makeProject();
    initGitProject(root);
    const result = await runLint({ path: root, changed: true, format: "json" });
    expect(result.exit).toBe(0);
    const json = parseJson(result);
    expect(json.findings).toEqual([]);
    expect(json.data?.scope?.changed).toEqual([]);
  });

  test("changed index file: full index-level checks run", async () => {
    const root = makeProject();
    initGitProject(root);
    const index = readFileSync(join(root, "docs", "graph-index.xml"), "utf-8").replace(
      "</GraphIndex>",
      `  <M-GHOST NAME="Ghost" TYPE="CORE_LOGIC" STATUS="done" PATH="src/ghost.ts" />\n</GraphIndex>`
    );
    writeFileSync(join(root, "docs", "graph-index.xml"), index);

    const result = await runLint({ path: root, changed: true, format: "json" });
    expect(result.exit).toBe(1);
    const json = parseJson(result);
    const codes = json.findings.map((item) => item.code);
    expect(codes).toContain("ORPHANED_INDEX_ENTRY");
    expect(json.data?.scope?.scanned).toContain("docs/graph-index.xml");
    // Other entities that did not change are not reported as scoped findings.
    expect(json.findings.every((item) => item.file === "docs/graph-index.xml" || item.file === "docs/modules/M-GHOST.xml")).toBe(true);
  });

  test("changed entity file: drift for that entity is reported (warning, --strict promotes)", async () => {
    const root = makeProject();
    initGitProject(root);
    writeFileSync(join(root, "docs", "modules", "M-A.xml"), `<M-A NAME="A" TYPE="CORE_LOGIC" STATUS="wip"><path>src/a.ts</path><verification-ref>V-M-A</verification-ref></M-A>\n`);

    const normal = await runLint({ path: root, changed: true, format: "json" });
    expect(normal.exit).toBe(0);
    const normalJson = parseJson(normal);
    expect(normalJson.findings.some((item) => item.code === "STATUS_DRIFT")).toBe(true);
    expect(normalJson.data?.scope?.scanned).toEqual(["docs/modules/M-A.xml"]);

    const strict = await runLint({ path: root, changed: true, strict: true, format: "json" });
    expect(strict.exit).toBe(1);
  });

  test("--base reports changes committed after an older revision", async () => {
    const root = makeProject();
    initGitProject(root);
    writeFileSync(join(root, "src", "a.ts"), `${CLEAN_SOURCE}// START_BLOCK_ONLY_START\n`);
    expect(git(root, ["add", "-A"]).status).toBe(0);
    expect(git(root, ["commit", "-q", "-m", "bad block"]).status).toBe(0);

    const clean = await runLint({ path: root, changed: true, format: "json" });
    expect(clean.exit).toBe(0);
    expect(parseJson(clean).findings).toEqual([]);

    const withBase = await runLint({ path: root, changed: true, base: "HEAD~1", format: "json" });
    expect(withBase.exit).toBe(1);
    const json = parseJson(withBase);
    expect(json.data?.scope?.changed).toEqual(["src/a.ts"]);
    expect(json.findings.some((item) => item.code === "UNPAIRED_BLOCK")).toBe(true);
  });

  test("skipped files are reported in data.scope.skipped", async () => {
    const root = makeProject();
    initGitProject(root);
    writeFileSync(join(root, "README.md"), "# changed but not lint-scoped\n");
    writeFileSync(join(root, "src", "a.ts"), `${CLEAN_SOURCE}// START_BLOCK_ONLY_START\n`);

    const result = await runLint({ path: root, changed: true, format: "json" });
    const json = parseJson(result);
    expect(json.data?.scope?.changed).toEqual(["README.md", "src/a.ts"]);
    expect(json.data?.scope?.skipped).toEqual(["README.md"]);
  });
});

describe("lint --files (works without git)", () => {
  test("explicit --files scopes findings without a git repository", async () => {
    const root = makeProject();
    expect(existsSync(join(root, ".git"))).toBe(false);
    writeFileSync(join(root, "src", "a.ts"), `${CLEAN_SOURCE}// START_BLOCK_ONLY_START\n`);

    const result = await runLint({ path: root, files: "src/a.ts", format: "json" });
    expect(result.exit).toBe(1);
    const json = parseJson(result);
    expect(json.findings.length).toBe(1);
    expect(json.findings[0]?.code).toBe("UNPAIRED_BLOCK");
    expect(json.data?.scope?.changed).toEqual(["src/a.ts"]);
  });

  test("--files accepts comma-separated paths and ignores untouched files", async () => {
    const root = makeProject();
    writeFileSync(join(root, "src", "a.ts"), `${CLEAN_SOURCE}// START_BLOCK_ONLY_START\n`);
    writeFileSync(join(root, "README.md"), "# docs change that lint ignores\n");

    const result = await runLint({ path: root, files: "src/a.ts,README.md", format: "json" });
    expect(result.exit).toBe(1);
    const json = parseJson(result);
    expect(json.findings.map((item) => item.code)).toEqual(["UNPAIRED_BLOCK"]);
    expect(json.data?.scope?.changed).toEqual(["README.md", "src/a.ts"]);
    expect(json.data?.scope?.skipped).toEqual(["README.md"]);
  });

  test("--changed without git and without --files is USAGE exit 2", async () => {
    const root = makeProject();
    const result = await runLint({ path: root, changed: true });
    expect(result.exit).toBe(2);
    expect(result.stderr).toContain("USAGE");
    expect(result.stderr.toLowerCase()).toContain("git");
    expect(() => resolveChangedFiles(root, {})).toThrow(UsageError);
  });

  test("--base without --changed is USAGE exit 2", async () => {
    const root = makeProject();
    const result = await runLint({ path: root, base: "HEAD" });
    expect(result.exit).toBe(2);
    expect(result.stderr).toContain("--base requires --changed");
  });

  test("text mode prints the Scope line", async () => {
    const root = makeProject();
    writeFileSync(join(root, "src", "a.ts"), `${CLEAN_SOURCE}// START_BLOCK_ONLY_START\n`);
    const result = await runLint({ path: root, files: "src/a.ts" });
    expect(result.exit).toBe(1);
    expect(result.stdout).toContain("Scope:    1 changed file(s)");
  });
});
