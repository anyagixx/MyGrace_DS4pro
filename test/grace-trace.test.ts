import { describe, test, expect } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  TRACE_FINDING_CODES,
  enrichTraceWithCodeSymbols,
  formatTraceText,
  parseModuleMapNames,
  resolveTraceModuleId,
  traceCommand,
  traceModule,
} from "../src/grace-trace";
import { cloneDefault } from "../src/grace-config";
import { makeFakeOctocode } from "./fixtures/octocode/fake-octocode";
import { buildShardPlan, applyShardPlan } from "../src/grace-shard";
import { UsageError, XmlError } from "../src/grace-errors";

interface ProjectOptions {
  /** `VERIFICATION_REF` + contract ref; `null` omits both. */
  verificationRef?: string | null;
  /** Write docs/verification/V-M-A.xml (default true). */
  verificationFile?: boolean;
  /** Declared test files (default ["src/a.test.ts"]); files are created for real paths. */
  testFiles?: string[];
  /** Create the declared test file on disk (default true). */
  createTestFile?: boolean;
  /** PATH attr in the graph index (default "src/a.ts"). */
  modulePath?: string;
  /** Create the source file at modulePath (default true, non-traversal paths only). */
  createSourceFile?: boolean;
  /** `<module-checks>` command in the verification file; `null` omits the block. */
  command?: string | null;
  /** Write docs/requirements.xml (default true). */
  requirements?: boolean;
  /** Requirements body mentioning M-A (default true). */
  requirementsMention?: boolean;
  /** Write docs/plans/Phase-1.xml (default true). */
  phases?: boolean;
  /** Phase body mentioning M-A (default true). */
  phaseMention?: boolean;
  /** Add M-B (DEPENDS M-A) and M-C (DEPENDS M-B) index entries. */
  dependents?: boolean;
  /** Write a mygrace.config.json. */
  config?: Record<string, unknown>;
  /** Skip writing docs/modules/M-A.xml. */
  moduleFile?: boolean;
  /** Write malformed verification XML. */
  malformedVerification?: boolean;
  /** Write malformed graph-index XML. */
  malformedIndex?: boolean;
}

function escapeXml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}

/** Create a small temp MyGRACE project exercising the full trace chain. */
function makeProject(options: ProjectOptions = {}): string {
  const root = mkdtempSync(join(tmpdir(), "mygrace-trace-"));
  mkdirSync(join(root, "docs", "modules"), { recursive: true });
  mkdirSync(join(root, "docs", "verification"), { recursive: true });
  mkdirSync(join(root, "docs", "plans"), { recursive: true });
  mkdirSync(join(root, "src"), { recursive: true });

  const verificationRef = options.verificationRef === undefined ? "V-M-A" : options.verificationRef;
  const modulePath = options.modulePath ?? "src/a.ts";
  const testFiles = options.testFiles ?? ["src/a.test.ts"];
  const command = options.command === undefined ? "bun test src/a.test.ts" : options.command;

  const entries = [
    `<M-A NAME="Auth" TYPE="CORE_LOGIC" STATUS="done" PATH="${escapeXml(modulePath)}" DEPENDS="" ${
      verificationRef === null ? "" : `VERIFICATION_REF="${escapeXml(verificationRef)}" `
    }/>`,
  ];
  if (options.dependents === true) {
    entries.push(`<M-B NAME="B" TYPE="CORE_LOGIC" STATUS="wip" PATH="src/b.ts" DEPENDS="M-A" VERIFICATION_REF="V-M-B" />`);
    entries.push(`<M-C NAME="C" TYPE="ENTRY_POINT" STATUS="pending" PATH="src/c.ts" DEPENDS="M-B" VERIFICATION_REF="V-M-C" />`);
  }
  const graphIndex = options.malformedIndex === true
    ? `<GraphIndex project="T"><broken></GraphIndex>`
    : `<GraphIndex project="T" version="1.0.0">\n  ${entries.join("\n  ")}\n</GraphIndex>\n`;
  writeFileSync(join(root, "docs", "graph-index.xml"), graphIndex);
  writeFileSync(join(root, "docs", "plan-index.xml"), `<PlanIndex project="T" version="1.0.0">\n  <Phase-1 name="Foundation" status="done" steps="1" />\n</PlanIndex>\n`);
  writeFileSync(join(root, "docs", "verification-index.xml"), `<VerificationIndex project="T" version="1.0.0">\n  <V-M-A MODULE="M-A" PRIORITY="high" STATUS="done" />\n</VerificationIndex>\n`);

  if (options.moduleFile !== false) {
    writeFileSync(
      join(root, "docs", "modules", "M-A.xml"),
      `<M-A NAME="Auth" TYPE="CORE_LOGIC" STATUS="done">
  <purpose>Authenticate users and manage sessions</purpose>
  <path>${escapeXml(modulePath)}</path>
  <depends></depends>
  <verification-ref>${verificationRef === null ? "" : escapeXml(verificationRef)}</verification-ref>
</M-A>
`
    );
  }

  if (options.verificationFile !== false) {
    const body = options.malformedVerification === true
      ? "<V-M-A><test-files><file>src/a.test.ts</file></test-files>"
      : `<V-M-A MODULE="M-A" PRIORITY="high" STATUS="done">
  <test-files>${testFiles.map((file) => `<file>${escapeXml(file)}</file>`).join("")}</test-files>
  ${command === null ? "" : `<module-checks><check-1>${escapeXml(command)}</check-1></module-checks>`}
</V-M-A>
`;
    writeFileSync(join(root, "docs", "verification", "V-M-A.xml"), body);
  }

  if (options.createSourceFile !== false && modulePath !== "" && !modulePath.includes("..") && !modulePath.startsWith("/")) {
    mkdirSync(join(root, modulePath, ".."), { recursive: true });
    writeFileSync(join(root, modulePath), "export const a = 1;\n");
  }
  if (options.createTestFile !== false) {
    for (const file of testFiles) {
      if (file.includes("..") || file.startsWith("/") || file.startsWith("-")) continue;
      mkdirSync(join(root, file, ".."), { recursive: true });
      writeFileSync(join(root, file), "// test file\nimport { a } from \"./a\";\n");
    }
  }

  if (options.requirements !== false) {
    const related = options.requirementsMention === false ? "M-OTHER" : "M-A,M-B";
    writeFileSync(
      join(root, "docs", "requirements.xml"),
      `<RequirementsAnalysis VERSION="1.0.0">
  <Project><name>Trace test</name></Project>
  <UseCases>
    <UC-001>
      <Actor>AIAgent</Actor>
      <Action>Authenticates a user</Action>
      <RelatedModules>${related}</RelatedModules>
    </UC-001>
  </UseCases>
</RequirementsAnalysis>
`
    );
  }

  if (options.phases !== false) {
    const step =
      options.phaseMention === false
        ? `<step-1 module="M-OTHER"><description>Unrelated step</description></step-1>`
        : `<step-1 module="M-A"><description>Implement authentication</description></step-1>`;
    writeFileSync(
      join(root, "docs", "plans", "Phase-1.xml"),
      `<Phase-1 name="Foundation" status="done">\n  ${step}\n</Phase-1>\n`
    );
  }

  if (options.config !== undefined) {
    writeFileSync(join(root, "mygrace.config.json"), JSON.stringify(options.config));
  }
  return root;
}

class ExitSignal extends Error {}

interface Captured {
  stdout: string;
  exit: number;
  thrown: unknown;
}

/** Run a citty command body, capturing stdout/console and process.exit. */
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

async function runTrace(root: string, extra: Record<string, unknown> = {}): Promise<Captured> {
  return capture(() => traceCommand.run!({ args: { path: root, ...extra } } as never));
}

describe("resolveTraceModuleId", () => {
  test("accepts module ids, verification ids and --module", () => {
    expect(resolveTraceModuleId("M-AUTH", undefined)).toBe("M-AUTH");
    expect(resolveTraceModuleId("V-M-AUTH", undefined)).toBe("M-AUTH");
    expect(resolveTraceModuleId(undefined, "M-AUTH")).toBe("M-AUTH");
    expect(resolveTraceModuleId("M-AUTH", "M-AUTH")).toBe("M-AUTH");
  });
  test("rejects traversal/invalid ids with USAGE (ADR-4)", () => {
    for (const bad of ["../../etc/passwd", "/etc/passwd", "M-A/../../x", "", "M_AUTH"]) {
      expect(() => resolveTraceModuleId(bad, undefined)).toThrow(UsageError);
    }
    expect(() => resolveTraceModuleId(undefined, undefined)).toThrow(UsageError);
  });
  test("conflicting positional and --module ids are a usage error", () => {
    expect(() => resolveTraceModuleId("M-A", "M-B")).toThrow(UsageError);
  });
});

describe("traceModule — full clean chain", () => {
  test("returns the whole chain with no errors", () => {
    const root = makeProject({ dependents: true });
    try {
      const result = traceModule(root, "M-A");
      expect(result.exitCode).toBe(0);
      expect(result.findings.filter((item) => item.severity === "error")).toEqual([]);

      expect(result.module.id).toBe("M-A");
      expect(result.module.name).toBe("Auth");
      expect(result.module.type).toBe("CORE_LOGIC");
      expect(result.module.status).toBe("done");
      expect(result.module.path).toBe("src/a.ts");
      expect(result.module.file).toBe("docs/modules/M-A.xml");
      expect(result.module.contractFileExists).toBe(true);

      expect(result.verification.id).toBe("V-M-A");
      expect(result.verification.exists).toBe(true);
      expect(result.verification.priority).toBe("high");
      expect(result.verification.status).toBe("done");
      expect(result.verification.testFiles).toEqual([{ file: "src/a.test.ts", exists: true, lines: 3 }]);
      expect(result.verification.command).toMatchObject({
        source: "verification",
        command: "bun test src/a.test.ts",
        requiresShellOptIn: false,
        file: "docs/verification/V-M-A.xml",
      });

      expect(result.requirements).toEqual([{ tag: "RelatedModules", file: "docs/requirements.xml", excerpt: "M-A,M-B" }]);
      expect(result.phases).toEqual([
        {
          id: "Phase-1",
          file: "docs/plans/Phase-1.xml",
          status: "done",
          matchedStep: "step-1",
          matchedStepDescription: "Implement authentication",
        },
      ]);
      expect(result.dependents).toEqual({ direct: ["M-B"], transitive: ["M-B", "M-C"], transitiveCount: 2 });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("verification id input resolves to its module", () => {
    const root = makeProject();
    try {
      expect(traceModule(root, "V-M-A").module.id).toBe("M-A");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("text rendering is a compact tree with the expected marks", () => {
    const root = makeProject({ dependents: true });
    try {
      const text = formatTraceText(traceModule(root, "M-A"));
      expect(text).toContain("M-A — Auth [done] src/a.ts");
      expect(text).toContain("→ verification V-M-A (done, high): src/a.test.ts ✔");
      expect(text).toContain("→ command: bun test src/a.test.ts [verification]");
      expect(text).toContain("→ requirements: RelatedModules: M-A,M-B");
      expect(text).toContain("→ phases: Phase-1 (step-1: Implement authentication)");
      expect(text).toContain("→ dependents: M-B (+1 transitive)");
      expect(text).toContain("✓ traceable — no gaps");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("traceCommand — JSON envelope (ADR-8)", () => {
  test("emits ok/exitCode/findings/meta/data with the documented shape", async () => {
    const root = makeProject();
    try {
      const { stdout, exit, thrown } = await runTrace(root, { id: "M-A", format: "json" });
      expect(thrown).toBeUndefined();
      expect(exit).toBe(0);
      const envelope = JSON.parse(stdout);
      expect(Object.keys(envelope)).toEqual(["ok", "exitCode", "findings", "meta", "data"]);
      expect(envelope.ok).toBe(true);
      expect(envelope.exitCode).toBe(0);
      expect(envelope.findings).toEqual([]);
      expect(envelope.meta.command).toBe("trace");
      expect(envelope.meta.root).toBe(root);
      const data = envelope.data;
      expect(Object.keys(data)).toEqual(["root", "module", "verification", "requirements", "phases", "dependents"]);
      expect(data.module).toMatchObject({ id: "M-A", name: "Auth", type: "CORE_LOGIC", status: "done", path: "src/a.ts" });
      expect(data.verification.command.source).toBe("verification");
      expect(data.verification.testFiles).toEqual([{ file: "src/a.test.ts", exists: true, lines: 3 }]);
      expect(data.requirements[0].tag).toBe("RelatedModules");
      expect(data.phases[0].id).toBe("Phase-1");
      expect(data.dependents.transitiveCount).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("--module is accepted as an alternative to the positional id", async () => {
    const root = makeProject();
    try {
      const { stdout, exit } = await runTrace(root, { module: "M-A", format: "json" });
      expect(exit).toBe(0);
      expect(JSON.parse(stdout).data.module.id).toBe("M-A");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("invalid --format is a usage error (exit 2)", async () => {
    const root = makeProject();
    try {
      const { thrown } = await runTrace(root, { id: "M-A", format: "yaml" });
      expect(thrown).toBeInstanceOf(UsageError);
      expect((thrown as UsageError).exitCode).toBe(2);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("trace gaps — required chain (errors, exit 1)", () => {
  test("MISSING_VERIFICATION_REF when the index and contract declare none", async () => {
    const root = makeProject({ verificationRef: null });
    try {
      const result = traceModule(root, "M-A");
      expect(result.exitCode).toBe(1);
      expect(result.findings.some((item) => item.code === TRACE_FINDING_CODES.missingVerificationRef && item.severity === "error")).toBe(true);
      expect(result.verification.id).toBeNull();
      const command = await runTrace(root, { id: "M-A" });
      expect(command.exit).toBe(1);
      expect(command.stdout).toContain("✗ [MISSING_VERIFICATION_REF]");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("MISSING_VERIFICATION_REF (unsafe value) never touches the filesystem", () => {
    const root = makeProject({ verificationRef: "../../etc/passwd" });
    try {
      const result = traceModule(root, "M-A");
      expect(result.exitCode).toBe(1);
      expect(result.findings.some((item) => item.code === TRACE_FINDING_CODES.missingVerificationRef)).toBe(true);
      expect(result.verification.id).toBeNull();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("VERIFICATION_FILE_MISSING when the ref points at an absent file", async () => {
    const root = makeProject({ verificationFile: false });
    try {
      const result = traceModule(root, "M-A");
      expect(result.exitCode).toBe(1);
      expect(result.verification.exists).toBe(false);
      expect(result.findings.some((item) => item.code === TRACE_FINDING_CODES.verificationFileMissing)).toBe(true);
      const command = await runTrace(root, { id: "M-A" });
      expect(command.exit).toBe(1);
      expect(command.stdout).toContain("(file missing)");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("TEST_FILE_MISSING when a declared test file does not exist", async () => {
    const root = makeProject({ testFiles: ["src/missing.test.ts"], createTestFile: false });
    try {
      const result = traceModule(root, "M-A");
      expect(result.exitCode).toBe(1);
      expect(result.verification.testFiles).toEqual([{ file: "src/missing.test.ts", exists: false }]);
      expect(result.findings.some((item) => item.code === TRACE_FINDING_CODES.testFileMissing)).toBe(true);
      const command = await runTrace(root, { id: "M-A" });
      expect(command.exit).toBe(1);
      expect(command.stdout).toContain("✗");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("unsafe test-file entries are rejected as TEST_FILE_MISSING (no traversal)", () => {
    const root = makeProject({ testFiles: ["../../etc/passwd"] });
    try {
      const result = traceModule(root, "M-A");
      expect(result.exitCode).toBe(1);
      expect(result.findings.some((item) => item.code === TRACE_FINDING_CODES.testFileMissing && /unsafe/u.test(item.message))).toBe(true);
      expect(result.verification.testFiles).toEqual([{ file: "../../etc/passwd", exists: false }]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("MODULE_PATH_MISSING for absent, empty and unsafe path declarations", () => {
    const missing = makeProject({ modulePath: "src/absent.ts", createSourceFile: false });
    const empty = makeProject({ modulePath: "" });
    const unsafe = makeProject({ modulePath: "../../etc/passwd" });
    try {
      for (const root of [missing, empty, unsafe]) {
        const result = traceModule(root, "M-A");
        expect(result.exitCode).toBe(1);
        expect(result.findings.some((item) => item.code === TRACE_FINDING_CODES.modulePathMissing)).toBe(true);
      }
      expect(traceModule(missing, "M-A").findings[0]?.message).toContain("does not exist");
      expect(traceModule(unsafe, "M-A").findings[0]?.message).toContain("escapes the project");
    } finally {
      rmSync(missing, { recursive: true, force: true });
      rmSync(empty, { recursive: true, force: true });
      rmSync(unsafe, { recursive: true, force: true });
    }
  });

  test("MODULE_FILE_MISSING when an indexed module has no contract file", () => {
    const root = makeProject({ moduleFile: false });
    try {
      const result = traceModule(root, "M-A");
      expect(result.exitCode).toBe(1);
      expect(result.module.contractFileExists).toBe(false);
      expect(result.findings.some((item) => item.code === TRACE_FINDING_CODES.moduleFileMissing)).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("malformed verification XML is a typed finding, not a crash", () => {
    const root = makeProject({ malformedVerification: true });
    try {
      const result = traceModule(root, "M-A");
      expect(result.exitCode).toBe(1);
      expect(result.findings.some((item) => item.code === TRACE_FINDING_CODES.xmlInvalid)).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("trace gaps — optional links (info, exit 0)", () => {
  test("NO_DECLARED_COMMAND info only; default source without config", async () => {
    const root = makeProject({ command: null });
    try {
      const result = traceModule(root, "M-A");
      expect(result.exitCode).toBe(0);
      expect(result.verification.command.source).toBe("default");
      expect(result.findings.some((item) => item.code === TRACE_FINDING_CODES.noDeclaredCommand && item.severity === "info")).toBe(true);
      const command = await runTrace(root, { id: "M-A" });
      expect(command.exit).toBe(0);
      expect(command.stdout).toContain("ⓘ [NO_DECLARED_COMMAND]");
      expect(command.stdout).toContain("✓ traceable — no errors");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("config testRunner is reported as source config", () => {
    const root = makeProject({ command: null, config: { testRunner: "pytest -q" } });
    try {
      const result = traceModule(root, "M-A");
      expect(result.exitCode).toBe(0);
      expect(result.verification.command).toMatchObject({ source: "config", command: "pytest -q" });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("absent docs/requirements.xml is graceful (info, exit 0)", () => {
    const root = makeProject({ requirements: false });
    try {
      const result = traceModule(root, "M-A");
      expect(result.exitCode).toBe(0);
      expect(result.requirements).toEqual([]);
      expect(result.findings.some((item) => item.code === TRACE_FINDING_CODES.noRequirementLink && item.severity === "info")).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("requirements without a matching mention → NO_REQUIREMENT_LINK info", () => {
    const root = makeProject({ requirementsMention: false });
    try {
      const result = traceModule(root, "M-A");
      expect(result.exitCode).toBe(0);
      expect(result.requirements).toEqual([]);
      expect(result.findings.some((item) => item.code === TRACE_FINDING_CODES.noRequirementLink)).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("no matching phase/step → NO_PHASE_LINK info, exit 0", () => {
    const root = makeProject({ phaseMention: false });
    try {
      const result = traceModule(root, "M-A");
      expect(result.exitCode).toBe(0);
      expect(result.phases).toEqual([]);
      expect(result.findings.some((item) => item.code === TRACE_FINDING_CODES.noPhaseLink && item.severity === "info")).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("all info gaps together still exit 0", async () => {
    const root = makeProject({ command: null, requirements: false, phases: false });
    try {
      const { exit } = await runTrace(root, { id: "M-A", format: "json" });
      expect(exit).toBe(0);
      const result = traceModule(root, "M-A");
      expect(result.findings.every((item) => item.severity === "info")).toBe(true);
      expect(result.exitCode).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("command policy", () => {
  test("shell-style declared commands are flagged as requiring --allow-commands", () => {
    const root = makeProject({ command: 'sh -c "true"' });
    try {
      const result = traceModule(root, "M-A");
      expect(result.verification.command.requiresShellOptIn).toBe(true);
      expect(result.verification.command.reason).toContain("shell interpreter");
      expect(formatTraceText(result)).toContain("(needs --allow-commands)");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("metacharacter commands are flagged too", () => {
    const root = makeProject({ command: "echo hi && true" });
    try {
      expect(traceModule(root, "M-A").verification.command.requiresShellOptIn).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("index resolution (shard-aware, ADR-6)", () => {
  test("traces a module that lives in a generated shard", () => {
    const root = makeProject({ dependents: true });
    try {
      const plan = buildShardPlan(root, { groupBy: "type" });
      const applied = applyShardPlan(plan);
      expect(applied.changed).toBe(true);
      const result = traceModule(root, "M-A");
      expect(result.exitCode).toBe(0);
      expect(result.module.id).toBe("M-A");
      expect(result.dependents.direct).toEqual(["M-B"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("malformed graph index is a typed XML_INVALID error (no partial trace)", async () => {
    const root = makeProject({ malformedIndex: true });
    try {
      expect(() => traceModule(root, "M-A")).toThrow(XmlError);
      const { stdout, exit } = await runTrace(root, { id: "M-A", format: "json" });
      expect(exit).toBe(1);
      const envelope = JSON.parse(stdout);
      expect(envelope.ok).toBe(false);
      expect(envelope.error.code).toBe("XML_INVALID");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("a module absent from the index is a usage error (exit 2)", async () => {
    const root = makeProject();
    try {
      expect(() => traceModule(root, "M-NOPE")).toThrow(UsageError);
      const { thrown } = await runTrace(root, { id: "M-NOPE" });
      expect(thrown).toBeInstanceOf(UsageError);
      expect((thrown as UsageError).exitCode).toBe(2);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

// ─── MODULE_MAP symbol verification (--code, ADR-9) ────────────────────

const INTEGRATIONS_DISABLED_BY_ENV = ["off", "0", "false", "disabled"].includes(
  (process.env.MYGRACE_INTEGRATIONS ?? "").trim().toLowerCase()
);
const runtimeTest = test.skipIf(process.platform === "win32" || INTEGRATIONS_DISABLED_BY_ENV);

const MODULE_MAP_SOURCE = `/**
 * Fixture module.
 */

// START_MODULE_CONTRACT
//   PURPOSE: Fixture.
//   SCOPE: Fixture.
//   DEPENDS: none.
//   LINKS: none.
// END_MODULE_CONTRACT

// START_MODULE_MAP
//   alpha          — first exported symbol
//   alphaHelper    — second exported symbol
//   missingThing   — declared but absent from code
// END_MODULE_MAP

export function alpha(): number {
  return 1;
}
export function alphaHelper(): number {
  return alpha() + 1;
}
`;

describe("parseModuleMapNames", () => {
  test("strips comment markers, separators and () suffixes; dedupes", () => {
    const names = parseModuleMapNames(`
// START_MODULE_MAP
//   CONFIG_FILENAME          — "mygrace.config.json"
//   loadConfig()             — read + validate
//   DEFAULT_CONFIG: defaults
//   snake-name - dashes work
//   CONFIG_FILENAME          — duplicate ignored
// END_MODULE_MAP
`);
    expect(names).toEqual(["CONFIG_FILENAME", "loadConfig", "DEFAULT_CONFIG", "snake-name"]);
  });

  test("blank input and plain prose produce no names", () => {
    expect(parseModuleMapNames("")).toEqual([]);
    expect(parseModuleMapNames("just a sentence without a separator")).toEqual([]);
  });
});

function makeTraceProject(): string {
  return makeProject({
    modulePath: "src/a/index.ts",
    createSourceFile: true,
    testFiles: ["src/a/index.test.ts"],
    createTestFile: true,
  });
}

describe("enrichTraceWithCodeSymbols", () => {
  runtimeTest("resolves MODULE_MAP entries and reports missing symbols as warnings", async () => {
    const fake = makeFakeOctocode({ mode: "ok" });
    const root = makeTraceProject();
    try {
      mkdirSync(join(root, "src", "a"), { recursive: true });
      writeFileSync(join(root, "src/a/index.ts"), MODULE_MAP_SOURCE);
      const result = traceModule(root, "M-A");
      const config = cloneDefault();
      config.integrations.octocode.bin = fake.bin;
      config.integrations.octocode.timeoutMs = 5_000;
      const enrichment = await enrichTraceWithCodeSymbols(result, config, { env: { PATH: "", HOME: root, TMPDIR: tmpdir() } });
      expect(enrichment.symbols.available).toBe(true);
      expect(enrichment.symbols.version).toBe("0.29.2");
      expect(enrichment.symbols.entries).toEqual([
        { name: "alpha", found: true, kind: "function" },
        { name: "alphaHelper", found: true, kind: "function" },
        { name: "missingThing", found: false },
      ]);
      expect(enrichment.findings).toHaveLength(1);
      expect(enrichment.findings[0]?.code).toBe(TRACE_FINDING_CODES.contractSymbolMissing);
      expect(enrichment.findings[0]?.severity).toBe("warning");
    } finally {
      rmSync(root, { recursive: true, force: true });
      fake.cleanup();
    }
  });

  test("without Octocode the check degrades to an info finding", async () => {
    const root = makeTraceProject();
    try {
      mkdirSync(join(root, "src", "a"), { recursive: true });
      writeFileSync(join(root, "src/a/index.ts"), MODULE_MAP_SOURCE);
      const result = traceModule(root, "M-A");
      const enrichment = await enrichTraceWithCodeSymbols(result, cloneDefault());
      expect(enrichment.symbols.available).toBe(false);
      expect(enrichment.symbols.entries).toHaveLength(3);
      expect(enrichment.findings.map((item) => item.code)).toEqual([TRACE_FINDING_CODES.integrationUnavailable]);
      expect(enrichment.findings[0]?.severity).toBe("info");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  runtimeTest("trace --code --strict-contracts promotes missing symbols to errors (exit 1)", async () => {
    const fake = makeFakeOctocode({ mode: "ok" });
    const root = makeTraceProject();
    try {
      mkdirSync(join(root, "src", "a"), { recursive: true });
      writeFileSync(join(root, "src/a/index.ts"), MODULE_MAP_SOURCE);
      writeFileSync(
        join(root, "mygrace.config.json"),
        JSON.stringify({ integrations: { octocode: { bin: fake.bin, timeoutMs: 5_000 } } })
      );
      const result = await capture(() =>
        traceCommand.run!({
          args: { id: "M-A", path: root, code: true, strictContracts: true, format: "json" },
        } as never)
      );
      expect(result.exit).toBe(1);
      const envelope = JSON.parse(result.stdout) as {
        ok: boolean;
        data: { symbols?: { available: boolean; entries: Array<{ name: string; found: boolean }> } };
        findings: Array<{ code: string; severity: string }>;
      };
      expect(envelope.ok).toBe(false);
      expect(envelope.data.symbols?.available).toBe(true);
      const missing = envelope.findings.filter((item) => item.code === TRACE_FINDING_CODES.contractSymbolMissing);
      expect(missing).toHaveLength(1);
      expect(missing[0]?.severity).toBe("error");
    } finally {
      rmSync(root, { recursive: true, force: true });
      fake.cleanup();
    }
  });

  test("trace without --code keeps the documented chain and exit code", async () => {
    const root = makeTraceProject();
    try {
      mkdirSync(join(root, "src", "a"), { recursive: true });
      writeFileSync(join(root, "src/a/index.ts"), MODULE_MAP_SOURCE);
      const result = await capture(() =>
        traceCommand.run!({ args: { id: "M-A", path: root, format: "json" } } as never)
      );
      expect(result.exit).toBe(0);
      const envelope = JSON.parse(result.stdout) as { data: { symbols?: unknown } };
      expect(envelope.data.symbols).toBeUndefined();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
