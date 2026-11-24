/**
 * MyGRACE — `mygrace impact` tests.
 *
 * Two layers, matching the command's contract:
 *   - `computeImpact` / `resolveChangedFiles` on temporary fixture projects
 *     (explicit --files without git, real `git init` repos for --staged/--since/HEAD),
 *   - the citty command through a captured stdout/exit shim (text + JSON envelope).
 *
 * Covers: exact PATH mapping, module-directory prefix mapping, docs-entity
 * mapping, transitive reverse-DEPENDS dependents, verification/test-file blast
 * radius, phase mentions, suggested commands, usage errors (exit 2) and the
 * documented JSON data shape.
 */

import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { UsageError } from "../src/grace-errors";
import {
  computeImpact,
  enrichImpactWithCodeGraph,
  impactCommand,
  impactData,
  resolveChangedFiles,
  type ImpactResult,
} from "../src/grace-impact";
import { cloneDefault } from "../src/grace-config";
import { makeFakeOctocode } from "./fixtures/octocode/fake-octocode";

// ─── Fixture project ───────────────────────────────────────────────────

const GRAPH_INDEX = `<GraphIndex project="ImpactFixture" version="1.0.0">
  <M-A NAME="Alpha" TYPE="CORE_LOGIC" STATUS="done" PATH="src/a/index.ts" DEPENDS="" VERIFICATION_REF="V-M-A" />
  <M-B NAME="Beta" TYPE="CORE_LOGIC" STATUS="done" PATH="src/b/index.ts" DEPENDS="M-A" VERIFICATION_REF="V-M-B" />
  <M-C NAME="Gamma" TYPE="CORE_LOGIC" STATUS="done" PATH="src/c/index.ts" DEPENDS="M-B" VERIFICATION_REF="V-M-C" />
</GraphIndex>
`;

const PLAN_INDEX = `<PlanIndex project="ImpactFixture" version="1.0.0">
  <Phase-1 name="Foundation" status="wip" steps="1" />
</PlanIndex>
`;

const PHASE_ONE = `<Phase-1 name="Foundation" status="wip">
  <step-1 module="M-B">
    <description>Wire Beta on top of Alpha.</description>
  </step-1>
</Phase-1>
`;

function moduleFile(id: string, path: string, depends: string): string {
  return `<${id} NAME="${id}" TYPE="CORE_LOGIC" STATUS="done">
  <contract>
    <purpose>Fixture module ${id}.</purpose>
    <path>${path}</path>
    <depends>${depends}</depends>
    <verification-ref>V-${id}</verification-ref>
  </contract>
</${id}>
`;
}

function verificationFile(id: string, testFile: string): string {
  return `<V-${id} MODULE="${id}" PRIORITY="high" STATUS="done">
  <test-files>
    <file>${testFile}</file>
  </test-files>
  <module-checks>
    <check-1>true</check-1>
  </module-checks>
</V-${id}>
`;
}

function makeProject(): string {
  const root = mkdtempSync(join(tmpdir(), "mygrace-impact-"));
  mkdirSync(join(root, "docs", "modules"), { recursive: true });
  mkdirSync(join(root, "docs", "plans"), { recursive: true });
  mkdirSync(join(root, "docs", "verification"), { recursive: true });
  mkdirSync(join(root, "src", "a"), { recursive: true });
  mkdirSync(join(root, "src", "b"), { recursive: true });
  mkdirSync(join(root, "src", "c"), { recursive: true });
  writeFileSync(join(root, "docs", "graph-index.xml"), GRAPH_INDEX);
  writeFileSync(join(root, "docs", "plan-index.xml"), PLAN_INDEX);
  writeFileSync(join(root, "docs", "plans", "Phase-1.xml"), PHASE_ONE);
  for (const [id, path, depends, testFile] of [
    ["M-A", "src/a/index.ts", "", "src/a/index.test.ts"],
    ["M-B", "src/b/index.ts", "M-A", "src/b/index.test.ts"],
    ["M-C", "src/c/index.ts", "M-B", "src/c/index.test.ts"],
  ] as const) {
    writeFileSync(join(root, "docs", "modules", `${id}.xml`), moduleFile(id, path, depends));
    writeFileSync(join(root, "docs", "verification", `V-${id}.xml`), verificationFile(id, testFile));
    writeFileSync(join(root, path), `export const ${id.replace("-", "_")} = true;\n`);
    writeFileSync(join(root, testFile), "// fixture test\n");
  }
  return root;
}

function git(root: string, args: readonly string[]): string {
  return execFileSync("git", ["-C", root, ...args], { encoding: "utf-8" }).trim();
}

/** Fresh git repo containing the fixture project, committed as HEAD. */
function makeGitProject(): string {
  const root = makeProject();
  git(root, ["init", "-q"]);
  git(root, ["config", "user.name", "MyGRACE Test"]);
  git(root, ["config", "user.email", "test@example.com"]);
  git(root, ["config", "commit.gpgsign", "false"]);
  git(root, ["add", "-A"]);
  git(root, ["commit", "-q", "-m", "fixture"]);
  return root;
}

function impactOrThrow(root: string, options: Parameters<typeof computeImpact>[1] = {}): ImpactResult {
  return computeImpact(root, options);
}

async function expectUsageError(fn: () => unknown): Promise<UsageError> {
  try {
    await fn();
  } catch (error) {
    expect(error).toBeInstanceOf(UsageError);
    return error as UsageError;
  }
  throw new Error("expected a UsageError but the call succeeded");
}

// ─── stdout/exit capture for the citty command ─────────────────────────

class ExitSignal extends Error {}

interface Captured {
  stdout: string;
  exit: number;
  thrown: unknown;
}

async function capture(fn: () => Promise<unknown>): Promise<Captured> {
  const chunks: string[] = [];
  const originalWrite = process.stdout.write.bind(process.stdout);
  const originalLog = console.log;
  const originalExit = process.exit;
  let exit: number | undefined;
  let thrown: unknown;
  process.stdout.write = ((chunk: unknown) => {
    chunks.push(String(chunk));
    return true;
  }) as typeof process.stdout.write;
  console.log = ((...values: unknown[]) => {
    chunks.push(`${values.map((value) => String(value)).join(" ")}\n`);
  }) as typeof console.log;
  process.exit = ((code?: number) => {
    exit = code ?? 0;
    throw new ExitSignal(`exit:${code ?? 0}`);
  }) as never;
  try {
    await fn();
  } catch (error) {
    if (!(error instanceof ExitSignal)) thrown = error;
  } finally {
    process.stdout.write = originalWrite;
    console.log = originalLog;
    process.exit = originalExit;
  }
  return { stdout: chunks.join(""), exit: exit ?? 0, thrown };
}

// ─── Changed-file resolution ───────────────────────────────────────────

describe("resolveChangedFiles", () => {
  test("explicit --files works without git and is normalized/sorted", () => {
    const root = makeProject();
    try {
      const changed = resolveChangedFiles(root, { files: " ./src/c/index.ts , src/a/index.ts,src/c/index.ts " });
      expect(changed.source).toBe("files");
      expect(changed.files).toEqual(["src/a/index.ts", "src/c/index.ts"]);
      expect(changed.skipped).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("a non-git project without --files is a UsageError (exit 2) with a --files hint", async () => {
    const root = makeProject();
    try {
      const error = await expectUsageError(() => resolveChangedFiles(root, {}));
      expect(error.exitCode).toBe(2);
      expect(error.message).toContain("No changed-file source available");
      expect(error.hint).toContain("--files");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("traversal and absolute --files entries are rejected", async () => {
    const root = makeProject();
    try {
      await expectUsageError(() => resolveChangedFiles(root, { files: "../escape.ts" }));
      await expectUsageError(() => resolveChangedFiles(root, { files: "/etc/passwd" }));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("--staged without a git repository is a UsageError with a --files fallback", async () => {
    const root = makeProject();
    try {
      const error = await expectUsageError(() => resolveChangedFiles(root, { staged: true }));
      expect(error.exitCode).toBe(2);
      expect(error.message).toContain("git diff --cached failed");
      expect(error.hint).toContain("--files");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("invalid --since revisions are rejected before git sees them", async () => {
    const root = makeProject();
    try {
      await expectUsageError(() => resolveChangedFiles(root, { since: "--upload-pack=evil" }));
      await expectUsageError(() => resolveChangedFiles(root, { since: "HEAD; rm -rf /" }));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("git: working tree vs HEAD, staged, and --since resolve the same changed file", () => {
    const root = makeGitProject();
    try {
      writeFileSync(join(root, "src", "c", "index.ts"), "export const changed = true;\n");

      const working = resolveChangedFiles(root, {});
      expect(working.source).toBe("head");
      expect(working.files).toEqual(["src/c/index.ts"]);

      git(root, ["add", "-A"]);
      const staged = resolveChangedFiles(root, { staged: true });
      expect(staged.source).toBe("staged");
      expect(staged.files).toEqual(["src/c/index.ts"]);

      git(root, ["commit", "-q", "-m", "change C"]);
      const since = resolveChangedFiles(root, { since: "HEAD~1" });
      expect(since.source).toBe("since");
      expect(since.ref).toBe("HEAD~1");
      expect(since.files).toEqual(["src/c/index.ts"]);

      // Explicit --files wins over git sources.
      const explicit = resolveChangedFiles(root, { files: "src/a/index.ts", staged: true });
      expect(explicit.source).toBe("files");
      expect(explicit.files).toEqual(["src/a/index.ts"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("git: deleted files still map through the index (review must see them)", () => {
    const root = makeGitProject();
    try {
      rmSync(join(root, "src", "b", "index.ts"));
      const changed = resolveChangedFiles(root, {});
      expect(changed.files).toContain("src/b/index.ts");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

// ─── Impact computation ────────────────────────────────────────────────

describe("computeImpact", () => {
  test("exact PATH change maps the module and its transitive dependents", () => {
    const root = makeProject();
    try {
      const result = impactOrThrow(root, { files: "src/a/index.ts" });
      expect(result.directModules).toEqual(["M-A"]);
      expect(result.dependents).toEqual(["M-B", "M-C"]);
      expect(result.verificationStatus.modules.map((entry) => entry.module)).toEqual(["M-A", "M-B", "M-C"]);
      expect(result.verificationStatus.modulesWithoutVerification).toEqual([]);
      expect(result.verificationStatus.missingTestFiles).toEqual([]);
      // Phase-1 mentions M-B, which is an affected dependent.
      expect(result.affectedPhases).toHaveLength(1);
      expect(result.affectedPhases[0]?.id).toBe("Phase-1");
      expect(result.affectedPhases[0]?.reason).toBe("mentions");
      expect(result.affectedPhases[0]?.modules).toContain("M-B");
      expect(result.findings).toEqual([]);
      expect(result.notes.join("\n")).toContain("--files");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("module-directory prefix mapping covers files next to the module PATH", () => {
    const root = makeProject();
    try {
      const result = impactOrThrow(root, { files: "src/a/session.ts,src/a/deep/token.ts" });
      expect(result.directModules).toEqual(["M-A"]);
      expect(result.dependents).toEqual(["M-B", "M-C"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("docs entity edits map to module/verification modules and direct phases", () => {
    const root = makeProject();
    try {
      const result = impactOrThrow(root, {
        files: ["docs/modules/M-B.xml", "docs/verification/V-M-A.xml", "docs/plans/Phase-1.xml"].join(","),
      });
      expect(result.directModules).toEqual(["M-A", "M-B"]);
      expect(result.dependents).toEqual(["M-C"]);
      expect(result.affectedPhases[0]?.id).toBe("Phase-1");
      expect(result.affectedPhases[0]?.reason).toBe("direct");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("docs entity for an unindexed module is flagged instead of silently trusted", () => {
    const root = makeProject();
    try {
      const result = impactOrThrow(root, { files: "docs/modules/M-Z.xml" });
      expect(result.directModules).toEqual(["M-Z"]);
      expect(result.dependents).toEqual([]);
      expect(result.notes.join("\n")).toContain("M-Z");
      expect(result.notes.join("\n")).toContain("not listed in docs/graph-index.xml");
      expect(result.verificationStatus.modulesWithoutVerification).toEqual(["M-Z"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("a change outside every module PATH yields an info finding and no modules", () => {
    const root = makeProject();
    try {
      const result = impactOrThrow(root, { files: "README.md" });
      expect(result.directModules).toEqual([]);
      expect(result.dependents).toEqual([]);
      expect(result.findings).toHaveLength(1);
      expect(result.findings[0]?.severity).toBe("info");
      expect(result.findings[0]?.code).toBe("NO_MODULES_AFFECTED");
      expect(result.notes.join("\n")).toContain("No module PATH maps");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("missing verification refs and missing test files are reported, not thrown", () => {
    const root = makeProject();
    try {
      // The verification ref is authoritative in the index (shard-aware source).
      writeFileSync(
        join(root, "docs", "graph-index.xml"),
        GRAPH_INDEX.replace('VERIFICATION_REF="V-M-A"', 'VERIFICATION_REF=""')
      );
      rmSync(join(root, "src", "b", "index.test.ts"));
      const result = impactOrThrow(root, { files: "src/a/index.ts,src/b/index.ts" });
      expect(result.directModules).toEqual(["M-A", "M-B"]);
      expect(result.verificationStatus.modulesWithoutVerification).toContain("M-A");
      expect(result.verificationStatus.missingTestFiles).toContain("src/b/index.test.ts");
      expect(result.verificationStatus.modulesWithMissingTestFiles).toContain("M-B");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("suggested commands include a trust note, a verify per affected module, and ci", () => {
    const root = makeProject();
    try {
      const result = impactOrThrow(root, { files: "src/a/index.ts" });
      // Commands are shell-quoted on Windows (backslash paths); compare their content.
      const commands = result.suggestedCommands.map((command) => command.replaceAll("'", ""));
      expect(commands[0]).toContain("mygrace trust");
      expect(commands).toContain(`mygrace verify --module M-A --path ${root}`);
      expect(commands).toContain(`mygrace verify --module M-B --path ${root}`);
      expect(commands).toContain(`mygrace verify --module M-C --path ${root}`);
      expect(commands.at(-1)).toBe(`mygrace ci --path ${root}`);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("JSON data has exactly the documented keys", () => {
    const root = makeProject();
    try {
      const result = impactOrThrow(root, { files: "src/a/index.ts" });
      expect(Object.keys(impactData(result)).sort()).toEqual([
        "affectedPhases",
        "dependents",
        "directModules",
        "files",
        "notes",
        "suggestedCommands",
        "verificationStatus",
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

// ─── citty command (text + JSON envelope) ──────────────────────────────

describe("impactCommand", () => {
  test("is registered with the documented metadata", () => {
    const meta = typeof impactCommand.meta === "object" ? (impactCommand.meta as { name?: string }) : undefined;
    expect(meta?.name).toBe("impact");
    expect(typeof impactCommand.run).toBe("function");
  });

  test("JSON mode prints the ADR-8 envelope and exits 0", async () => {
    const root = makeProject();
    try {
      const { stdout, exit, thrown } = await capture(() =>
        impactCommand.run!({ args: { path: root, files: "src/a/index.ts", format: "json" } } as never)
      );
      expect(thrown).toBeUndefined();
      expect(exit).toBe(0);
      const envelope = JSON.parse(stdout) as {
        ok: boolean;
        exitCode: number;
        findings: unknown[];
        meta: { command: string; root: string };
        data: { directModules: string[]; dependents: string[] };
      };
      expect(envelope.ok).toBe(true);
      expect(envelope.exitCode).toBe(0);
      expect(envelope.meta.command).toBe("impact");
      expect(envelope.meta.root).toBe(root);
      expect(envelope.data.directModules).toEqual(["M-A"]);
      expect(envelope.data.dependents).toEqual(["M-B", "M-C"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("text mode prints the human digest", async () => {
    const root = makeProject();
    try {
      const { stdout, exit } = await capture(() =>
        impactCommand.run!({ args: { path: root, files: "src/a/index.ts" } } as never)
      );
      expect(exit).toBe(0);
      expect(stdout).toContain("MyGRACE impact");
      expect(stdout).toContain("Direct modules (1): M-A");
      expect(stdout).toContain("Dependents (2): M-B, M-C");
      expect(stdout).toContain("Suggested commands:");
      expect(stdout).toContain("mygrace verify --module M-A");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("an invalid --format value is a typed usage error", async () => {
    const root = makeProject();
    try {
      const { thrown } = await capture(() => impactCommand.run!({ args: { path: root, format: "xml" } } as never));
      expect(thrown).toBeInstanceOf(UsageError);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

// ─── Optional Octocode code-graph enrichment (--code-graph, ADR-9) ─────

const INTEGRATIONS_DISABLED_BY_ENV = ["off", "0", "false", "disabled"].includes(
  (process.env.MYGRACE_INTEGRATIONS ?? "").trim().toLowerCase()
);
const runtimeTest = test.skipIf(INTEGRATIONS_DISABLED_BY_ENV);

function fakeConfig(bin: string) {
  const config = cloneDefault();
  config.integrations.octocode.bin = bin;
  config.integrations.octocode.timeoutMs = 5_000;
  return config;
}

describe("enrichImpactWithCodeGraph", () => {
  test("without Octocode the baseline impact is unchanged and an info finding explains the gap", async () => {
    const root = makeProject();
    try {
      const result = computeImpact(root, { files: "src/a/index.ts" });
      const config = cloneDefault();
      const enrichment = await enrichImpactWithCodeGraph(result, config, { env: { PATH: "", HOME: root, TMPDIR: tmpdir() } });
      expect(enrichment.codeGraph.available).toBe(false);
      expect(enrichment.findings.map((item) => item.code)).toContain("INTEGRATION_UNAVAILABLE");
      expect(result.directModules).toEqual(["M-A"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("real import edges become module edges; undeclared imports are info findings", async () => {
    const fake = makeFakeOctocode({ mode: "ok" });
    const root = makeProject();
    try {
      const result = computeImpact(root, { files: "src/a/index.ts,src/b/index.ts" });
      const enrichment = await enrichImpactWithCodeGraph(result, fakeConfig(fake.bin), {
        env: { PATH: "", HOME: root, TMPDIR: tmpdir() },
      });
      expect(enrichment.codeGraph.available).toBe(true);
      expect(enrichment.codeGraph.version).toBe("0.29.2");
      expect(enrichment.codeGraph.edges).toEqual([
        { fromModule: "M-A", toModule: "M-B", declared: false },
        { fromModule: "M-B", toModule: "M-A", declared: true },
        { fromModule: "M-C", toModule: "M-A", declared: false },
      ]);
      const undeclared = enrichment.findings.filter((item) => item.code === "CODE_EDGE_UNDECLARED");
      expect(undeclared.map((item) => item.message)).toEqual([
        expect.stringContaining("M-A imports M-B"),
        expect.stringContaining("M-C imports M-A"),
      ]);
      expect(enrichment.findings.every((item) => item.severity === "info")).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
      fake.cleanup();
    }
  });

  test("a declared DEPENDS without a direct code edge is an info finding, never an error", async () => {
    const fake = makeFakeOctocode({ mode: "ok" });
    const root = makeProject();
    try {
      const result = computeImpact(root, { files: "src/c/index.ts" });
      const enrichment = await enrichImpactWithCodeGraph(result, fakeConfig(fake.bin), {
        env: { PATH: "", HOME: root, TMPDIR: tmpdir() },
      });
      expect(enrichment.codeGraph.edges).toEqual([]);
      expect(enrichment.findings.map((item) => item.code)).toContain("DECLARED_EDGE_UNUSED");
      expect(enrichment.findings.every((item) => item.severity === "info")).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
      fake.cleanup();
    }
  });

  runtimeTest("impact --code-graph JSON mode exposes the codeGraph payload and keeps exit 0", async () => {
    const fake = makeFakeOctocode({ mode: "ok" });
    const root = makeProject();
    try {
      writeFileSync(
        join(root, "mygrace.config.json"),
        JSON.stringify({ integrations: { octocode: { bin: fake.bin, timeoutMs: 5_000 } } })
      );
      const result = await capture(() =>
        impactCommand.run!({
          args: { files: "src/a/index.ts,src/b/index.ts", path: root, format: "json", codeGraph: true },
        } as never)
      );
      expect(result.exit).toBe(0);
      const envelope = JSON.parse(result.stdout) as {
        ok: boolean;
        data: { codeGraph?: { available: boolean; edges: unknown[] } };
        findings: Array<{ code: string; severity: string }>;
      };
      expect(envelope.ok).toBe(true);
      expect(envelope.data.codeGraph?.available).toBe(true);
      expect(envelope.data.codeGraph?.edges.length).toBe(3);
      expect(envelope.findings.map((item) => item.code)).toContain("CODE_EDGE_UNDECLARED");
      for (const finding of envelope.findings) expect(finding.severity).toBe("info");
    } finally {
      rmSync(root, { recursive: true, force: true });
      fake.cleanup();
    }
  });
});
