/**
 * MyGRACE — `mygrace diagram` tests (W5 / v1.5, ADR-9).
 *
 * Covers the deterministic architecture IR from the docs graph (components,
 * boundaries, primary-dependency backbone, full-edge JSON/Mermaid output), the
 * optional Archify validate/deliver path through a fake CLI, graceful
 * degradation without Archify, `--check` staleness and usage errors.
 */

import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cloneDefault } from "../src/grace-config";
import type { MyGraceConfig } from "../src/grace-config";
import {
  DIAGRAM_FINDING_CODES,
  buildArchitectureDiagram,
  diagramCommand,
  renderMermaid,
} from "../src/grace-diagram";
import { findExecutableOnPath } from "../src/grace-integrations";
import { makeFakeArchify } from "./fixtures/archify/fake-archify";

const POSIX_ONLY = process.platform !== "win32";
const INTEGRATIONS_DISABLED_BY_ENV = ["off", "0", "false", "disabled"].includes(
  (process.env.MYGRACE_INTEGRATIONS ?? "").trim().toLowerCase()
);
/** Fake-Archify tests need a POSIX shell wrapper and enabled integrations (G13). */
const runtimeTest = test.skipIf(!POSIX_ONLY || INTEGRATIONS_DISABLED_BY_ENV);

const GRAPH_INDEX = `<GraphIndex project="DiagramFixture" version="2.0.0">
  <M-A NAME="Alpha module" TYPE="FOUNDATION" STATUS="done" PATH="src/a.ts" DEPENDS="" VERIFICATION_REF="V-M-A" />
  <M-B NAME="Beta module" TYPE="CORE_LOGIC" STATUS="done" PATH="src/b.ts" DEPENDS="M-A" VERIFICATION_REF="V-M-B" />
  <M-C NAME="Gamma module" TYPE="INTEGRATION" STATUS="wip" PATH="src/c.ts" DEPENDS="M-A,M-B" VERIFICATION_REF="V-M-C" />
  <M-D NAME="Delta module" TYPE="UTILITY" STATUS="done" PATH="src/d.ts" DEPENDS="M-B" VERIFICATION_REF="" />
</GraphIndex>
`;

const PLAN_INDEX = `<PlanIndex project="DiagramFixture" version="2.0.0">
  <Phase-1 name="Foundation" status="done" steps="1" />
  <Phase-2 name="Delivery" status="wip" steps="1" />
</PlanIndex>
`;

function verificationFile(id: string, testFile: string): string {
  return `<${id} MODULE="${id.replace("V-", "")}" PRIORITY="high" STATUS="done">
  <test-files><file>${testFile}</file></test-files>
</${id}>
`;
}

function makeProject(): string {
  const root = mkdtempSync(join(tmpdir(), "mygrace-diagram-"));
  mkdirSync(join(root, "docs", "modules"), { recursive: true });
  mkdirSync(join(root, "docs", "plans"), { recursive: true });
  mkdirSync(join(root, "docs", "verification"), { recursive: true });
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, "docs", "graph-index.xml"), GRAPH_INDEX);
  writeFileSync(join(root, "docs", "plan-index.xml"), PLAN_INDEX);
  writeFileSync(
    join(root, "docs", "plans", "Phase-1.xml"),
    `<Phase-1 name="Foundation" status="done">
  <step-1 module="M-A" description="Write the contract" status="done" />
  <step-2 module="M-B" description="Implement the core" status="done" />
</Phase-1>
`
  );
  writeFileSync(
    join(root, "docs", "plans", "Phase-2.xml"),
    `<Phase-2 name="Delivery" status="wip">
  <step-1 module="M-C" description="Wire the integration" status="wip" />
</Phase-2>
`
  );
  writeFileSync(
    join(root, "docs", "verification-index.xml"),
    `<VerificationIndex project="DiagramFixture">
  <V-M-A MODULE="M-A" PRIORITY="high" STATUS="done" />
  <V-M-B MODULE="M-B" PRIORITY="high" STATUS="done" />
  <V-M-C MODULE="M-C" PRIORITY="medium" STATUS="done" />
</VerificationIndex>
`
  );
  for (const [id, testFile] of [
    ["V-M-A", "src/a.test.ts"],
    ["V-M-B", "src/b.test.ts"],
    ["V-M-C", "src/c.test.ts"],
  ] as const) {
    writeFileSync(join(root, "docs", "verification", `${id}.xml`), verificationFile(id, testFile));
  }
  for (const file of ["src/a.ts", "src/b.ts", "src/c.ts", "src/d.ts"]) {
    writeFileSync(join(root, file), "export const fixture = true;\n");
  }
  return root;
}

function writeConfig(root: string, archifyBin: string | null, extra: Record<string, unknown> = {}): void {
  writeFileSync(
    join(root, "mygrace.config.json"),
    JSON.stringify({ integrations: { archify: { bin: archifyBin, ...extra } } })
  );
}

function diagramConfig(root: string | null = null): MyGraceConfig {
  const config = cloneDefault();
  if (root !== null) config.integrations.archify.outputDir = join(root, "docs", "diagrams");
  return config;
}

class ExitSignal extends Error {}

async function capture(fn: () => Promise<unknown>): Promise<{ stdout: string; exit: number }> {
  const chunks: string[] = [];
  const originalWrite = process.stdout.write.bind(process.stdout);
  const originalLog = console.log;
  const originalError = console.error;
  const originalExit = process.exit;
  let exit: number | undefined;
  process.stdout.write = ((chunk: unknown) => {
    chunks.push(String(chunk));
    return true;
  }) as typeof process.stdout.write;
  console.log = ((...values: unknown[]) => {
    chunks.push(`${values.map((value) => String(value)).join(" ")}\n`);
  }) as typeof console.log;
  console.error = ((...values: unknown[]) => {
    chunks.push(`${values.map((value) => String(value)).join(" ")}\n`);
  }) as typeof console.error;
  process.exit = ((code?: number) => {
    exit = code ?? 0;
    throw new ExitSignal(`exit:${code ?? 0}`);
  }) as never;
  try {
    await fn();
  } catch (error) {
    if (!(error instanceof ExitSignal)) throw error;
  } finally {
    process.stdout.write = originalWrite;
    console.log = originalLog;
    console.error = originalError;
    process.exit = originalExit;
  }
  return { stdout: chunks.join(""), exit: exit ?? 0 };
}

function runDiagram(args: Record<string, unknown>) {
  return capture(() => diagramCommand.run!({ args } as never));
}

// ─── Deterministic IR from the docs graph ──────────────────────────────

describe("buildArchitectureDiagram", () => {
  test("is deterministic and keeps the graph hash stable across calls", () => {
    const root = makeProject();
    try {
      const config = diagramConfig(root);
      const first = buildArchitectureDiagram(root, config, { outputHtml: join(root, "docs", "diagrams", "architecture.html") });
      const second = buildArchitectureDiagram(root, config, { outputHtml: join(root, "docs", "diagrams", "architecture.html") });
      expect(second.irText).toBe(first.irText);
      expect(second.graphSha256).toBe(first.graphSha256);
      expect(first.summary).toEqual({
        modules: 4,
        dependencies: 4,
        depictedDependencies: 3,
        boundaries: 4,
        phases: 2,
        verifications: 3,
        testFiles: 3,
        verifiedModules: 3,
        lintErrors: expect.any(Number),
        lintWarnings: expect.any(Number),
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("maps modules, Archify types, boundaries and cards deterministically", () => {
    const root = makeProject();
    try {
      const built = buildArchitectureDiagram(root, diagramConfig(), { outputHtml: "architecture.html" });
      const ir = built.ir;
      expect(ir.schema_version).toBe(1);
      expect(ir.diagram_type).toBe("architecture");
      expect(ir.meta.title).toBe("MyGRACE — DiagramFixture");
      expect(ir.meta.output).toBe("architecture.html");
      expect(ir.meta.quality_profile).toBe("standard");
      expect(ir.components.map((component) => component.id)).toEqual(["M-A", "M-B", "M-C", "M-D"]);
      expect(ir.components.map((component) => component.type)).toEqual(["backend", "backend", "external", "backend"]);
      expect(ir.components[0]).toMatchObject({ label: "Alpha module", sublabel: "FOUNDATION · done", tag: "V-M-A" });
      expect(ir.boundaries.map((boundary) => boundary.label)).toEqual([
        "Core logic",
        "Foundation",
        "Integrations",
        "Utilities",
      ]);
      expect(ir.boundaries.map((boundary) => boundary.wraps)).toEqual([["M-B"], ["M-A"], ["M-C"], ["M-D"]]);
      expect(ir.connections).toEqual([
        { id: "M-B-to-M-A", from: "M-B", to: "M-A" },
        { id: "M-C-to-M-B", from: "M-C", to: "M-B" },
        { id: "M-D-to-M-B", from: "M-D", to: "M-B" },
      ]);
      expect(ir.cards).toHaveLength(3);
      expect(ir.cards[0]?.items[0]).toBe("4 modules · 4 declared dependencies");
      expect(ir.cards[0]?.items[1]).toContain("3 primary edges drawn");
      expect(built.fullConnections).toHaveLength(4);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("renderMermaid covers every declared dependency (not only the backbone)", () => {
    const root = makeProject();
    try {
      const built = buildArchitectureDiagram(root, diagramConfig(), { outputHtml: "architecture.html" });
      const mermaid = renderMermaid(built.ir, built.fullConnections);
      expect(mermaid.startsWith("flowchart LR")).toBe(true);
      expect(mermaid).toContain('subgraph Core_logic["Core logic"]');
      expect(mermaid).toContain('M_B["Beta module"]');
      expect(mermaid.match(/-->/g)?.length).toBe(4);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

// ─── Command contract ──────────────────────────────────────────────────

describe("diagramCommand", () => {
  test("--format json returns the IR, the full dependency list and exit 0", async () => {
    const root = makeProject();
    try {
      writeConfig(root, null);
      const result = await runDiagram({ path: root, format: "json" });
      expect(result.exit).toBe(0);
      const envelope = JSON.parse(result.stdout) as {
        ok: boolean;
        data: { ir: { components: unknown[] }; dependencies: unknown[]; summary: { depictedDependencies: number } };
      };
      expect(envelope.ok).toBe(true);
      expect(envelope.data.ir.components).toHaveLength(4);
      expect(envelope.data.dependencies).toHaveLength(4);
      expect(envelope.data.summary.depictedDependencies).toBe(3);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("--format json with --out refreshes the committed IR without Archify", async () => {
    const root = makeProject();
    try {
      writeConfig(root, null, { enabled: false });
      const result = await runDiagram({ path: root, format: "json", out: "docs/diagrams/architecture.html" });
      expect(result.exit).toBe(0);
      expect(existsSync(join(root, "docs", "diagrams", "architecture.json"))).toBe(true);
      const check = await runDiagram({ path: root, check: true });
      expect(check.exit).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("--format html fails honestly when Archify is disabled", async () => {
    const root = makeProject();
    try {
      writeConfig(root, null, { enabled: false });
      const result = await runDiagram({ path: root, format: "html" });
      expect(result.exit).toBe(1);
      expect(result.stdout).toContain("Archify is required for --format html");
      expect(existsSync(join(root, "docs", "diagrams", "architecture.json"))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  runtimeTest("--format html delivers IR + HTML + receipt through Archify", async () => {
    const fake = makeFakeArchify({ mode: "ok" });
    const root = makeProject();
    try {
      writeConfig(root, fake.bin);
      const result = await runDiagram({ path: root, format: "html" });
      expect(result.exit).toBe(0);
      const files = ["architecture.json", "architecture.html", "architecture.receipt.json", "architecture.delivery.json"];
      for (const file of files) {
        expect(existsSync(join(root, "docs", "diagrams", file))).toBe(true);
      }
      const receipt = JSON.parse(readFileSync(join(root, "docs", "diagrams", "architecture.receipt.json"), "utf-8")) as {
        graph: { sha256: string; modules: number; dependencies: { declared: number; depicted: number } };
        archify: { validation: string; delivery: { receiptId?: string } | null };
        outputs: { html: string; ir: string };
      };
      expect(receipt.graph.modules).toBe(4);
      expect(receipt.graph.dependencies).toEqual({ declared: 4, depicted: 3 });
      expect(receipt.archify.validation).toBe("passed");
      expect(receipt.outputs.html).toBe("docs/diagrams/architecture.html");
      expect(readFileSync(join(root, "docs", "diagrams", "architecture.html"), "utf-8")).toContain("fake archify");
      expect(result.stdout).toContain("Diagram delivered (architecture, standard)");
      expect(result.stdout).toContain("docs/diagrams/architecture.html");
    } finally {
      rmSync(root, { recursive: true, force: true });
      fake.cleanup();
    }
  });

  runtimeTest("a schema rejection is an error and writes no artifacts", async () => {
    const fake = makeFakeArchify({ mode: "invalid" });
    const root = makeProject();
    try {
      writeConfig(root, fake.bin);
      const result = await runDiagram({ path: root, format: "html" });
      expect(result.exit).toBe(1);
      expect(result.stdout).toContain("Archify rejected the generated");
      expect(existsSync(join(root, "docs", "diagrams", "architecture.json"))).toBe(false);
      expect(existsSync(join(root, "docs", "diagrams", "architecture.html"))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
      fake.cleanup();
    }
  });

  runtimeTest("a delivery failure keeps the refreshed IR but exits 1", async () => {
    const fake = makeFakeArchify({ mode: "deliver-fail" });
    const root = makeProject();
    try {
      writeConfig(root, fake.bin);
      const result = await runDiagram({ path: root, format: "html" });
      expect(result.exit).toBe(1);
      expect(result.stdout).toContain("Archify delivery failed");
      expect(existsSync(join(root, "docs", "diagrams", "architecture.json"))).toBe(true);
      expect(existsSync(join(root, "docs", "diagrams", "architecture.html"))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
      fake.cleanup();
    }
  });

  runtimeTest("non-JSON Archify output is a validation error, not a crash", async () => {
    const fake = makeFakeArchify({ mode: "crash" });
    const root = makeProject();
    try {
      writeConfig(root, fake.bin);
      const result = await runDiagram({ path: root, format: "html" });
      expect(result.exit).toBe(1);
      expect(result.stdout).toContain("Archify rejected the generated");
      expect(result.stdout).toContain("fake archify internal error");
    } finally {
      rmSync(root, { recursive: true, force: true });
      fake.cleanup();
    }
  });

  runtimeTest("--check fails on missing/stale IR and passes on a current artifact", async () => {
    const fake = makeFakeArchify({ mode: "ok" });
    const root = makeProject();
    try {
      writeConfig(root, fake.bin);
      const missing = await runDiagram({ path: root, check: true });
      expect(missing.exit).toBe(1);
      expect(missing.stdout).toContain("STALE");

      const generated = await runDiagram({ path: root, format: "html" });
      expect(generated.exit).toBe(0);
      const current = await runDiagram({ path: root, check: true });
      expect(current.exit).toBe(0);
      expect(current.stdout).toContain("up to date");

      const irPath = join(root, "docs", "diagrams", "architecture.json");
      writeFileSync(irPath, readFileSync(irPath, "utf-8").replace('"title": "MyGRACE — DiagramFixture"', '"title": "tampered"'));
      const stale = await runDiagram({ path: root, check: true });
      expect(stale.exit).toBe(1);
      expect(stale.stdout).toContain("STALE");
    } finally {
      rmSync(root, { recursive: true, force: true });
      fake.cleanup();
    }
  });

  async function usageError(args: Record<string, unknown>): Promise<number> {
    try {
      await diagramCommand.run!({ args } as never);
    } catch (error) {
      const exitCode = (error as { exitCode?: number }).exitCode;
      if (exitCode !== undefined) return exitCode;
      throw error;
    }
    throw new Error("expected a typed UsageError");
  }

  test("--out stays inside the project root and must be HTML", async () => {
    const root = makeProject();
    try {
      writeConfig(root, null);
      expect(await usageError({ path: root, format: "html", out: "../escape.html" })).toBe(2);
      expect(await usageError({ path: root, format: "html", out: "docs/diagrams/architecture.png" })).toBe(2);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("invalid format and unsupported kinds are usage errors (exit 2)", async () => {
    const root = makeProject();
    try {
      writeConfig(root, null);
      expect(await usageError({ path: root, format: "svg" })).toBe(2);
      expect(await usageError({ path: root, kind: "sequence" })).toBe(2);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("--kind tree emits a deterministic hierarchy with parent links", async () => {
    const root = makeProject();
    try {
      writeConfig(root, null);
      const result = await runDiagram({ path: root, kind: "tree", format: "json" });
      expect(result.exit).toBe(0);
      const envelope = JSON.parse(result.stdout) as {
        data: { kind: string; ir: { schema_version: number; diagram_type: string; nodes: Array<{ id: string; parent?: string }> } };
      };
      expect(envelope.data.kind).toBe("tree");
      expect(envelope.data.ir.schema_version).toBe(1);
      expect(envelope.data.ir.diagram_type).toBe("tree");
      const nodes = envelope.data.ir.nodes;
      expect(nodes[0]?.id).toBe("root");
      expect(nodes.find((node) => node.id === "group-core-logic")?.parent).toBe("root");
      expect(nodes.find((node) => node.id === "M-B")?.parent).toBe("group-core-logic");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test.skipIf(!POSIX_ONLY || INTEGRATIONS_DISABLED_BY_ENV)("--kind tree --format html delivers through Archify", async () => {
    const fake = makeFakeArchify({ mode: "ok" });
    const root = makeProject();
    try {
      writeConfig(root, fake.bin);
      const result = await runDiagram({ path: root, kind: "tree", format: "html" });
      expect(result.exit).toBe(0);
      expect(existsSync(join(root, "docs", "diagrams", "tree.html"))).toBe(true);
      const receipt = JSON.parse(readFileSync(join(root, "docs", "diagrams", "tree.receipt.json"), "utf-8")) as { kind: string; archify: { validation: string } };
      expect(receipt.kind).toBe("tree");
      expect(receipt.archify.validation).toBe("passed");
    } finally {
      rmSync(root, { recursive: true, force: true });
      fake.cleanup();
    }
  });

  test("--kind workflow maps plan phases to lanes and sequential nodes", async () => {
    const root = makeProject();
    try {
      writeConfig(root, null);
      const result = await runDiagram({ path: root, kind: "workflow", format: "json" });
      expect(result.exit).toBe(0);
      const envelope = JSON.parse(result.stdout) as {
        data: {
          kind: string;
          ir: {
            title?: string;
            lanes: Array<{ id: string; label: string }>;
            nodes: Array<{ id: string; lane: string; col: number }>;
            edges: Array<{ id: string; from: string; to: string; fromSide?: string; toSide?: string }>;
          };
        };
      };
      expect(envelope.data.kind).toBe("workflow");
      expect(envelope.data.ir.lanes.map((lane) => lane.id)).toEqual(["phase-1", "phase-2"]);
      expect(envelope.data.ir.nodes.map((node) => node.col)).toEqual([1, 2]);
      expect(envelope.data.ir.edges).toEqual([
        { id: "edge-1", from: "node-phase-1", to: "node-phase-2", fromSide: "bottom", toSide: "top" },
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test.skipIf(!POSIX_ONLY || INTEGRATIONS_DISABLED_BY_ENV)("--kind workflow --format html delivers through Archify", async () => {
    const fake = makeFakeArchify({ mode: "ok" });
    const root = makeProject();
    try {
      writeConfig(root, fake.bin);
      const result = await runDiagram({ path: root, kind: "workflow", format: "html" });
      expect(result.exit).toBe(0);
      expect(existsSync(join(root, "docs", "diagrams", "workflow.html"))).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
      fake.cleanup();
    }
  });

  test("--check covers every committed kind and reports the stale one", async () => {
    const root = makeProject();
    try {
      writeConfig(root, null);
      for (const kind of ["architecture", "tree", "workflow"]) {
        const refresh = await runDiagram({ path: root, kind, format: "json", out: `docs/diagrams/${kind}.html` });
        expect(refresh.exit).toBe(0);
      }
      const current = await runDiagram({ path: root, check: true });
      expect(current.exit).toBe(0);
      expect(current.stdout).toContain("up to date (3 kind(s))");

      const workflowIr = join(root, "docs", "diagrams", "workflow.json");
      writeFileSync(workflowIr, readFileSync(workflowIr, "utf-8").replace('"title": "MyGRACE — DiagramFixture delivery plan"', '"title": "tampered"'));
      const stale = await runDiagram({ path: root, check: true });
      expect(stale.exit).toBe(1);
      expect(stale.stdout).toContain("STALE");
      expect(stale.stdout).toContain("workflow");
      const single = await runDiagram({ path: root, kind: "tree", check: true });
      expect(single.exit).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("Mermaid output is architecture-only", async () => {
    const root = makeProject();
    try {
      writeConfig(root, null);
      expect(await usageError({ path: root, kind: "tree", format: "mermaid" })).toBe(2);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test.skipIf(!POSIX_ONLY || INTEGRATIONS_DISABLED_BY_ENV)("a Node-script Archify entry (.mjs) runs through the node runner", async () => {
    if (findExecutableOnPath("node") === null) return;
    const fake = makeFakeArchify({ mode: "ok" });
    const root = makeProject();
    try {
      writeConfig(root, fake.mjs);
      const result = await runDiagram({ path: root, format: "html" });
      expect(result.exit).toBe(0);
      expect(existsSync(join(root, "docs", "diagrams", "architecture.html"))).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
      fake.cleanup();
    }
  });
});
