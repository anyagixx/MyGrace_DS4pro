#!/usr/bin/env bun
/**
 * MyGRACE Example Generator
 *
 * Builds examples/demo-store: a realistic 12-module MyGRACE project with
 * docs/ indexes, per-module contracts, phases, verification entries,
 * canonical source markup, and passing tests. Used for dogfooding the
 * CLI (lint), the DSH skills, and scripts/measure-context.ts.
 *
 * Run: bun run scripts/gen-example.ts
 */

import { mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");
const EXAMPLE = join(ROOT, "examples", "demo-store");

type Module = {
  id: string;
  name: string;
  type: string;
  status: string;
  path: string;
  depends: string;
  phase: number;
  purpose: string;
  fn: string;
};

const MODULES: Module[] = [
  { id: "M-CONFIG", name: "Config", type: "UTILITY", status: "done", path: "src/config/index.ts", depends: "", phase: 1, purpose: "Load and validate application configuration from env", fn: "loadConfig" },
  { id: "M-LOGGER", name: "Logger", type: "UTILITY", status: "done", path: "src/logger/index.ts", depends: "M-CONFIG", phase: 1, purpose: "Structured logging with [Module][fn][BLOCK] markers", fn: "log" },
  { id: "M-DB", name: "Database", type: "DATA_LAYER", status: "done", path: "src/db/index.ts", depends: "M-CONFIG", phase: 1, purpose: "Connection pool and query helper", fn: "query" },
  { id: "M-AUTH", name: "Authentication", type: "CORE_LOGIC", status: "done", path: "src/auth/index.ts", depends: "M-CONFIG,M-DB", phase: 1, purpose: "Authenticate users and manage sessions", fn: "authenticate" },
  { id: "M-USERS", name: "Users", type: "CORE_LOGIC", status: "wip", path: "src/users/index.ts", depends: "M-AUTH,M-DB", phase: 2, purpose: "User profiles and role checks", fn: "getUser" },
  { id: "M-PRODUCTS", name: "Products", type: "CORE_LOGIC", status: "wip", path: "src/products/index.ts", depends: "M-DB", phase: 2, purpose: "Product catalog queries and stock", fn: "listProducts" },
  { id: "M-CART", name: "Cart", type: "CORE_LOGIC", status: "pending", path: "src/cart/index.ts", depends: "M-PRODUCTS,M-USERS", phase: 3, purpose: "Shopping cart state and totals", fn: "addItem" },
  { id: "M-ORDERS", name: "Orders", type: "CORE_LOGIC", status: "pending", path: "src/orders/index.ts", depends: "M-CART,M-USERS,M-DB", phase: 3, purpose: "Order creation and lifecycle", fn: "createOrder" },
  { id: "M-PAYMENTS", name: "Payments", type: "INTEGRATION", status: "pending", path: "src/payments/index.ts", depends: "M-ORDERS", phase: 3, purpose: "Payment provider adapter", fn: "charge" },
  { id: "M-NOTIFY", name: "Notifications", type: "INTEGRATION", status: "pending", path: "src/notify/index.ts", depends: "M-CONFIG", phase: 4, purpose: "Email and webhook delivery", fn: "send" },
  { id: "M-API", name: "HTTP API", type: "ENTRY_POINT", status: "pending", path: "src/api/index.ts", depends: "M-AUTH,M-ORDERS,M-PRODUCTS", phase: 4, purpose: "REST endpoints over the domain", fn: "handleRequest" },
  { id: "M-CLI", name: "CLI", type: "ENTRY_POINT", status: "pending", path: "src/cli/index.ts", depends: "M-AUTH,M-ORDERS", phase: 4, purpose: "Admin command-line interface", fn: "runCommand" },
];

const PHASES = [
  { n: 1, name: "Foundation", status: "done", steps: [1, 2, 3, 4] },
  { n: 2, name: "Core Domain", status: "wip", steps: [5, 6] },
  { n: 3, name: "Commerce", status: "pending", steps: [7, 8, 9] },
  { n: 4, name: "Delivery", status: "pending", steps: [10, 11, 12] },
];

// ─── Document generation ────────────────────────────────────────────────

function graphIndex(): string {
  const byStatus: Record<string, number> = { wip: 0, pending: 1, done: 2 };
  const sorted = [...MODULES].sort((a, b) => byStatus[a.status] - byStatus[b.status]);
  const lines = sorted.map(
    (m) => `  <${m.id} NAME="${m.name}" TYPE="${m.type}" STATUS="${m.status}" PATH="${m.path}" DEPENDS="${m.depends}" VERIFICATION_REF="V-${m.id}" />`
  );
  return [
    `<GraphIndex project="DemoStore" version="1.0.0">`,
    "  <keywords>demo, ecommerce, mygrace, dogfood</keywords>",
    "  <annotation>A 12-module demo store used to dogfood MyGRACE on DeepSeek Harness</annotation>",
    ...lines,
    "</GraphIndex>",
    "",
  ].join("\n");
}

function moduleDoc(m: Module): string {
  return [
    `<${m.id} NAME="${m.name}" TYPE="${m.type}" STATUS="${m.status}">`,
    "  <contract>",
    `    <purpose>${m.purpose}</purpose>`,
    `    <path>${m.path}</path>`,
    `    <depends>${m.depends || "none"}</depends>`,
    `    <verification-ref>V-${m.id}</verification-ref>`,
    "  </contract>",
    "  <exports>",
    `    <export-1 name="${m.fn}">Primary public function of ${m.name}</export-1>`,
    "  </exports>",
    `  <CrossLink to="${m.depends.split(",")[0] || "M-CONFIG"}" kind="depends" />`,
    "</" + m.id + ">",
    "",
  ].join("\n");
}

function planIndex(): string {
  const lines = PHASES.map((p) => `  <Phase-${p.n} name="${p.name}" status="${p.status}" steps="${p.steps.length}" />`);
  return ["<PlanIndex project=\"DemoStore\" version=\"1.0.0\">", ...lines, "</PlanIndex>", ""].join("\n");
}

function phaseDoc(p: (typeof PHASES)[number]): string {
  const steps = p.steps
    .map((idx) => {
      const m = MODULES[idx - 1];
      return `  <step-${m.id} module="${m.id}" description="${m.purpose}" status="${m.status}" />`;
    })
    .join("\n");
  return [`<Phase-${p.n} name="${p.name}" status="${p.status}">`, steps, `</Phase-${p.n}>`, ""].join("\n");
}

function verificationIndex(): string {
  const lines = MODULES.map(
    (m) => `  <V-${m.id} MODULE="${m.id}" PRIORITY="${m.type === "CORE_LOGIC" ? "high" : "medium"}" STATUS="${m.status}" />`
  );
  return ["<VerificationIndex project=\"DemoStore\" version=\"1.0.0\">", ...lines, "</VerificationIndex>", ""].join("\n");
}

function verificationDoc(m: Module): string {
  return [
    `<V-${m.id} MODULE="${m.id}" PRIORITY="medium" STATUS="${m.status}">`,
    `  <test-files><file>${m.path.replace("index.ts", "index.test.ts")}</file></test-files>`,
    "  <module-checks><check-1>bun test</check-1></module-checks>",
    "  <scenarios>",
    `    <scenario-1 kind="success">${m.fn} succeeds on valid input</scenario-1>`,
    `    <scenario-2 kind="failure">${m.fn} fails fast on invalid input</scenario-2>`,
    "  </scenarios>",
    "  <required-log-markers>",
    `    <marker-1>[${m.name}][${m.fn}][BLOCK_VALIDATE]</marker-1>`,
    "  </required-log-markers>",
    `</V-${m.id}>`,
    "",
  ].join("\n");
}

// ─── Source generation ──────────────────────────────────────────────────

function sourceFile(m: Module): string {
  const pkg = m.path.split("/")[1];
  const status = m.status === "done" ? "implemented" : m.status === "wip" ? "in progress" : "planned";
  const fnBody = `  console.log("[${m.name}][${m.fn}][BLOCK_VALIDATE] ${status}");\n  return true;`;
  return [
    "// START_MODULE_CONTRACT",
    `//   PURPOSE: ${m.purpose}`,
    "//   SCOPE: Single-module responsibility, no cross-module imports beyond DEPENDS",
    `//   DEPENDS: ${m.depends || "none"}`,
    `//   LINKS: docs/modules/${m.id}.xml`,
    "// END_MODULE_CONTRACT",
    "",
    "// START_MODULE_MAP",
    `// Exports: ${m.fn}`,
    "// Locals: none",
    "// END_MODULE_MAP",
    "",
    "// START_CHANGE_SUMMARY",
    `// v1.0.0 — ${status}`,
    "// END_CHANGE_SUMMARY",
    "",
    `// START_CONTRACT: ${m.fn}`,
    "// PURPOSE: Demonstrates the module contract in action",
    "// INPUTS: none",
    "// OUTPUTS: boolean",
    "// SIDE_EFFECTS: logs one marker line",
    `// END_CONTRACT: ${m.fn}`,
    `export function ${m.fn}(): boolean {`,
    "  // START_BLOCK_VALIDATE",
    `  ${fnBody}`,
    "  // END_BLOCK_VALIDATE",
    "}",
    "",
  ].join("\n");
}

function testFile(m: Module): string {
  const pkg = m.path.split("/")[1];
  return [
    `import { describe, test, expect } from "bun:test";`,
    `import { ${m.fn} } from "./index";`,
    "",
    `describe("${m.id} ${m.name}", () => {`,
    `  test("${m.fn} runs and returns true", () => {`,
    `    expect(${m.fn}()).toBe(true);`,
    "  });",
    "});",
    "",
  ].join("\n");
}

// ─── Main ───────────────────────────────────────────────────────────────

function main() {
  if (existsSync(EXAMPLE)) rmSync(EXAMPLE, { recursive: true, force: true });

  for (const dir of ["docs/modules", "docs/plans", "docs/verification", "docs/archive", "src"]) {
    mkdirSync(join(EXAMPLE, dir), { recursive: true });
  }
  for (const m of MODULES) mkdirSync(join(EXAMPLE, m.path.replace("/index.ts", "")), { recursive: true });

  writeFileSync(join(EXAMPLE, "docs", "graph-index.xml"), graphIndex());
  writeFileSync(join(EXAMPLE, "docs", "plan-index.xml"), planIndex());
  writeFileSync(join(EXAMPLE, "docs", "verification-index.xml"), verificationIndex());
  writeFileSync(join(EXAMPLE, "AGENTS.md"), "# MyGRACE Demo Store\n\nDogfood example for MyGRACE on DeepSeek Harness. See docs/ indexes — always read them first.\n");

  for (const m of MODULES) {
    writeFileSync(join(EXAMPLE, "docs", "modules", `${m.id}.xml`), moduleDoc(m));
    writeFileSync(join(EXAMPLE, "docs", "verification", `V-${m.id}.xml`), verificationDoc(m));
    writeFileSync(join(EXAMPLE, m.path), sourceFile(m));
    writeFileSync(join(EXAMPLE, m.path.replace("index.ts", "index.test.ts")), testFile(m));
  }
  for (const p of PHASES) writeFileSync(join(EXAMPLE, "docs", "plans", `Phase-${p.n}.xml`), phaseDoc(p));

  writeFileSync(
    join(EXAMPLE, "package.json"),
    JSON.stringify({ name: "demo-store", private: true, type: "module", scripts: { test: "bun test" } }, null, 2) + "\n"
  );

  const files = 12 * 4 + 5 + 1;
  console.log(`Generated ${EXAMPLE} (${files} files)`);
}

main();
