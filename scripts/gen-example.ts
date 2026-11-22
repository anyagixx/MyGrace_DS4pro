#!/usr/bin/env bun
/**
 * MyGRACE demo generator (ROADMAP G1/G7, audit report 02 §6).
 *
 * v1 generated twelve byte-identical `return true` stubs whose tests asserted
 * the hard-coded constant — a facade that made `lint` and `measure-context`
 * look good without exercising anything. v2 generates a small but REAL example:
 *
 *   - three modules with real logic (parameters, validation, imports between
 *     modules) and real failure tests that assert thrown errors;
 *   - docs within the configured size budgets (module 30-80, phase 50-200,
 *     verification 20-60 lines) and index caps;
 *   - `<module-checks>` only in docs/verification/V-M-*.xml (canonical location);
 *   - index/entity fields that are mutually consistent (NAME/TYPE/STATUS/PATH/
 *     DEPENDS/VERIFICATION_REF/PRIORITY/phase name/status/steps);
 *   - a self-contained `bunfig.toml` so `bun test` works from the demo root.
 *
 * Generation is deterministic: the same generator run always produces the same
 * bytes. `--check` generates into a temporary directory and diffs it against
 * `examples/demo-store`, exiting 1 on drift (used by CI instead of `git diff`).
 *
 * Usage:
 *   bun run scripts/gen-example.ts            # regenerate examples/demo-store
 *   bun run scripts/gen-example.ts --check    # verify the checkout is in sync
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
const EXAMPLE = join(ROOT, "examples", "demo-store");

// ─── model ──────────────────────────────────────────────────────────────

interface ModuleSpec {
  id: string;
  name: string;
  type: "UTILITY" | "CORE_LOGIC" | "ENTRY_POINT" | "INTEGRATION" | "DATA_LAYER";
  status: "done" | "wip" | "pending";
  path: string;
  depends: string;
  purpose: string;
  exports: string[];
  errors: string[];
  notes: string[];
}

const MODULES: readonly ModuleSpec[] = [
  {
    id: "M-MONEY",
    name: "Money",
    type: "UTILITY",
    status: "done",
    path: "src/money/index.ts",
    depends: "",
    purpose: "Parse and format monetary amounts as integer cents without floating-point drift.",
    exports: ["parseAmount", "formatAmount"],
    errors: ["MONEY_INVALID"],
    notes: [
      "All demo arithmetic is performed on integer cents so subtotals are exact.",
      "Floats are never used for storage; formatting is the only place decimals appear.",
    ],
  },
  {
    id: "M-CATALOG",
    name: "Catalog",
    type: "CORE_LOGIC",
    status: "done",
    path: "src/catalog/index.ts",
    depends: "M-MONEY",
    purpose: "Build a validated product catalog and resolve products by id.",
    exports: ["createCatalog", "findProduct", "describeProduct"],
    errors: ["CATALOG_INVALID"],
    notes: [
      "Catalog validation rejects duplicate ids, non-positive prices and negative stock.",
      "Unknown product lookups throw instead of returning undefined so callers cannot ignore them.",
    ],
  },
  {
    id: "M-CART",
    name: "Cart",
    type: "CORE_LOGIC",
    status: "done",
    path: "src/cart/index.ts",
    depends: "M-CATALOG,M-MONEY",
    purpose: "Maintain a shopping cart with validated quantities and exact totals.",
    exports: ["createCart", "addItem", "subtotalCents", "renderSubtotal"],
    errors: ["CART_INVALID"],
    notes: [
      "Cart mutations validate quantity and stock before storing an item.",
      "Totals are computed in cents through the money module, never with floats.",
    ],
  },
];

interface PhaseSpec {
  number: number;
  name: string;
  status: "done" | "wip" | "pending";
  goal: string;
  steps: Array<{ module: string; description: string; acceptance: string; verification: string }>;
  risks: string[];
  evidence: string[];
}

const PHASES: readonly PhaseSpec[] = [
  {
    number: 1,
    name: "Foundation",
    status: "done",
    goal: "Provide validated money primitives and the product catalog that the cart builds on.",
    steps: [
      {
        module: "M-MONEY",
        description: "Implement parseAmount/formatAmount with strict validation of empty, negative and over-precise amounts.",
        acceptance: "Valid decimal amounts round-trip; every malformed input throws a MoneyError with an actionable message.",
        verification: "V-M-MONEY",
      },
      {
        module: "M-CATALOG",
        description: "Implement createCatalog/findProduct with duplicate-id, price and stock validation.",
        acceptance: "Invalid catalogs are rejected; unknown product ids throw CatalogError instead of returning undefined.",
        verification: "V-M-CATALOG",
      },
    ],
    risks: [
      "Decimal handling is the classic source of money bugs; review rejects any float arithmetic.",
      "Catalog validation must reject duplicates before a cart can reference them.",
    ],
    evidence: [
      "bun test src/money/index.test.ts — happy path, malformed amount, negative amount.",
      "bun test src/catalog/index.test.ts — duplicate id, invalid price, unknown product.",
    ],
  },
  {
    number: 2,
    name: "Cart",
    status: "done",
    goal: "Compose money and catalog into a validated shopping cart with deterministic totals.",
    steps: [
      {
        module: "M-CART",
        description: "Implement addItem/subtotalCents/renderSubtotal with quantity and stock validation.",
        acceptance: "Cart totals are exact integer cents; invalid quantity, unknown product and insufficient stock all throw.",
        verification: "V-M-CART",
      },
    ],
    risks: [
      "Quantity accumulation can silently overflow stock if validation happens after storage.",
      "Totals must reuse the money module so formatting and arithmetic cannot drift.",
    ],
    evidence: ["bun test src/cart/index.test.ts — accumulation, three failure modes, end-to-end total."],
  },
];

// ─── documents ──────────────────────────────────────────────────────────

function graphIndex(): string {
  const lines = [
    '<GraphIndex project="DemoStore" version="1.0.0">',
    "  <keywords>demo, ecommerce, money, catalog, cart, mygrace, dogfood</keywords>",
    "  <annotation>A small but real three-module store used to dogfood MyGRACE end to end</annotation>",
  ];
  for (const module of MODULES) {
    lines.push(
      `  <${module.id} NAME="${module.name}" TYPE="${module.type}" STATUS="${module.status}" ` +
        `PATH="${module.path}" DEPENDS="${module.depends}" VERIFICATION_REF="V-${module.id}" />`
    );
  }
  lines.push("</GraphIndex>", "");
  return lines.join("\n");
}

function planIndex(): string {
  const lines = ['<PlanIndex project="DemoStore" version="1.0.0">'];
  for (const phase of PHASES) {
    lines.push(`  <Phase-${phase.number} name="${phase.name}" status="${phase.status}" steps="${phase.steps.length}" />`);
  }
  lines.push("</PlanIndex>", "");
  return lines.join("\n");
}

function verificationIndex(): string {
  const priorities: Record<string, string> = { "M-MONEY": "high", "M-CATALOG": "high", "M-CART": "high" };
  const lines = ['<VerificationIndex project="DemoStore" version="1.0.0">'];
  for (const module of MODULES) {
    lines.push(
      `  <V-${module.id} MODULE="${module.id}" PRIORITY="${priorities[module.id] ?? "medium"}" STATUS="${module.status}" />`
    );
  }
  lines.push("</VerificationIndex>", "");
  return lines.join("\n");
}

function moduleDoc(module: ModuleSpec): string {
  const lines: string[] = [`<${module.id} NAME="${module.name}" TYPE="${module.type}" STATUS="${module.status}">`];
  lines.push(`  <purpose>${module.purpose}</purpose>`);
  lines.push(`  <path>${module.path}</path>`);
  lines.push(`  <depends>${module.depends === "" ? "none" : module.depends}</depends>`);
  lines.push(`  <verification-ref>V-${module.id}</verification-ref>`);
  lines.push("");
  lines.push("  <annotations>");
  for (const exported of module.exports) {
    lines.push(`    <fn-${exported} PURPOSE="${module.name} exports ${exported} with validated inputs and explicit errors." />`);
  }
  for (const errorCode of module.errors) {
    lines.push(`    <type-${errorCode} PURPOSE="${module.name} validation error raised on invalid input." />`);
  }
  lines.push("  </annotations>");
  lines.push("");
  const crossLink = MODULES.find((candidate) => candidate.depends.split(",").includes(module.id));
  lines.push(
    `  <CrossLink to="${crossLink === undefined ? module.id : crossLink.id}" relation="${crossLink === undefined ? "self" : "used-by"}" />`
  );
  lines.push("");
  lines.push("  <contract>");
  lines.push(`    <purpose>${module.purpose}</purpose>`);
  lines.push("    <inputs>");
  lines.push(
    `      <param name="input" type="unknown" description="${module.name} validates every input before use and reports errors explicitly." />`
  );
  lines.push("    </inputs>");
  lines.push("    <outputs>");
  lines.push(
    `      <param name="result" type="unknown" description="${module.name} returns deterministic results; failures throw instead of returning sentinel values." />`
  );
  lines.push("    </outputs>");
  lines.push("    <errors>");
  for (const errorCode of module.errors) {
    lines.push(`      <error code="${errorCode}" description="Raised when ${module.name} receives invalid input." />`);
  }
  lines.push("    </errors>");
  lines.push("  </contract>");
  lines.push("");
  lines.push("  <notes>");
  for (const note of module.notes) lines.push(`    ${note}`);
  lines.push("  </notes>");
  lines.push(`</${module.id}>`, "");
  return lines.join("\n");
}

function verificationDoc(module: ModuleSpec, priority: string): string {
  const checks: Record<string, string[]> = {
    "M-MONEY": [
      'parseAmount("12.34") returns 1234 cents.',
      'parseAmount("abc") throws MoneyError.',
      'parseAmount("12.345") throws MoneyError.',
      'parseAmount("-1") throws MoneyError.',
      'formatAmount(1234) returns "12.34".',
    ],
    "M-CATALOG": [
      "createCatalog returns a catalog for valid products.",
      "duplicate product ids throw CatalogError.",
      "non-positive price throws CatalogError.",
      "findProduct('missing') throws CatalogError.",
      "describeProduct formats the price through the money module.",
    ],
    "M-CART": [
      "addItem accumulates quantity for an existing product.",
      "quantity 0 throws CartError.",
      "an unknown product id throws CatalogError.",
      "quantity above stock throws CartError.",
      "subtotalCents/renderSubtotal return exact integer-cent totals.",
    ],
  };
  const markers: Record<string, string[]> = {
    "M-MONEY": ["[Money][parseAmount][BLOCK_VALIDATE_AMOUNT]", "[Money][parseAmount][BLOCK_CONVERT_TO_CENTS]"],
    "M-CATALOG": ["[Catalog][createCatalog][BLOCK_VALIDATE_PRODUCTS]", "[Catalog][findProduct][BLOCK_RESOLVE_PRODUCT]"],
    "M-CART": ["[Cart][addItem][BLOCK_VALIDATE_QUANTITY]", "[Cart][addItem][BLOCK_RESOLVE_AND_STORE]"],
  };
  const lines: string[] = [`<V-${module.id} MODULE="${module.id}" PRIORITY="${priority}" STATUS="${module.status}">`];
  lines.push("  <test-files>");
  lines.push(`    <file>${module.path.replace(/index\.ts$/, "index.test.ts")}</file>`);
  lines.push("  </test-files>");
  lines.push("");
  lines.push("  <module-checks>");
  lines.push(`    <check-1>bun test ${module.path.replace(/index\.ts$/, "index.test.ts")}</check-1>`);
  lines.push("  </module-checks>");
  lines.push("");
  lines.push("  <scenarios>");
  (checks[module.id] ?? []).forEach((scenario, index) => {
    const kind = /throws/.test(scenario) ? "failure" : "success";
    lines.push(`    <scenario-${index + 1} kind="${kind}">${scenario}</scenario-${index + 1}>`);
  });
  lines.push("  </scenarios>");
  lines.push("");
  lines.push("  <required-log-markers>");
  (markers[module.id] ?? []).forEach((marker, index) => {
    lines.push(`    <marker-${index + 1}>${marker}</marker-${index + 1}>`);
  });
  lines.push("  </required-log-markers>");
  lines.push("");
  lines.push("  <notes>");
  lines.push("    Failure scenarios assert the exact error class so silent regressions cannot pass.");
  lines.push("    The module-checks block lives here (canonical location), never in docs/modules/.");
  lines.push("  </notes>");
  lines.push(`</V-${module.id}>`, "");
  return lines.join("\n");
}

function phaseDoc(phase: PhaseSpec): string {
  const lines: string[] = [`<Phase-${phase.number} name="${phase.name}" status="${phase.status}">`];
  lines.push(`  <goal>${phase.goal}</goal>`);
  lines.push("  <scope>");
  lines.push("    <in-scope>The modules listed in this phase and their verification files.</in-scope>");
  lines.push("    <out-of-scope>Modules owned by other phases; this phase must not edit them.</out-of-scope>");
  lines.push("  </scope>");
  lines.push("  <assumptions>");
  lines.push("    <assumption-1>The docs/graph-index.xml module list is the single source of truth for ids.</assumption-1>");
  lines.push("    <assumption-2>Every module in this phase has a verification file before implementation starts.</assumption-2>");
  lines.push("    <assumption-3>The previous phase is complete and its exit criteria are recorded as evidence.</assumption-3>");
  lines.push("  </assumptions>");
  lines.push("  <dependencies>");
  lines.push("    <dependency-1>docs/verification-index.xml entries for the phase modules.</dependency-1>");
  lines.push("    <dependency-2>Repository-level mygrace.config.json size budgets and index caps.</dependency-2>");
  lines.push("  </dependencies>");
  // Step elements must be direct children of the phase root: lint counts
  // top-level <step-*> elements against the index `steps` attribute.
  phase.steps.forEach((step, index) => {
    lines.push(`  <step-${index + 1} module="${step.module}" status="done">`);
    lines.push(`    <description>${step.description}</description>`);
    lines.push(`    <acceptance>${step.acceptance}</acceptance>`);
    lines.push(`    <verification-ref>${step.verification}</verification-ref>`);
    lines.push(`  </step-${index + 1}>`);
  });
  lines.push("  <verification-plan>");
  phase.steps.forEach((step, index) => {
    lines.push(`    <verification-${index + 1}>${step.verification} — run the module checks and record the digest.</verification-${index + 1}>`);
  });
  lines.push("    <verification-final>Phase exit: mygrace lint --path . reports 0 errors and 0 warnings.</verification-final>");
  lines.push("  </verification-plan>");
  lines.push("  <risks>");
  phase.risks.forEach((risk, index) => {
    lines.push(`    <risk-${index + 1}>${risk}</risk-${index + 1}>`);
  });
  lines.push("  </risks>");
  lines.push("  <observability>");
  lines.push("    <marker-rule>Every module logs [Module][function][BLOCK_NAME] on validation failures.</marker-rule>");
  lines.push("    <digest-rule>Verification failures are compacted into .mygrace/last-failures.md for the agent loop.</digest-rule>");
  lines.push("  </observability>");
  lines.push("  <evidence>");
  phase.evidence.forEach((evidence, index) => {
    lines.push(`    <evidence-${index + 1}>${evidence}</evidence-${index + 1}>`);
  });
  lines.push("  </evidence>");
  lines.push("  <exit-criteria>");
  lines.push("    <criterion-1>All listed module tests pass with failure paths covered.</criterion-1>");
  lines.push("    <criterion-2>mygrace lint reports 0 errors and 0 warnings for the touched artifacts.</criterion-2>");
  lines.push("    <criterion-3>Index and per-entity files agree on every field after the phase.</criterion-3>");
  lines.push("    <criterion-4>No generated file outside this phase's scope changed.</criterion-4>");
  lines.push("  </exit-criteria>");
  lines.push("  <rollback>");
  lines.push("    <rollback-1>Revert the phase commits; the indexes are the only cross-file coupling.</rollback-1>");
  lines.push("    <rollback-2>Re-run lint to confirm index/entity consistency after a rollback.</rollback-2>");
  lines.push("  </rollback>");
  lines.push("  <notes>");
  lines.push("    This phase is generated deterministically; edit scripts/gen-example.ts, not the output.");
  lines.push("    The demo exists to exercise lint, verify, measure-context and the MCP tools end to end.");
  lines.push("    Size budgets from mygrace.config.json defaults are respected deliberately.");
  lines.push("  </notes>");
  lines.push(`</Phase-${phase.number}>`, "");
  return lines.join("\n");
}

// ─── source files ───────────────────────────────────────────────────────

const SOURCE_FILES: Readonly<Record<string, string>> = {
  "src/money/index.ts": `// START_MODULE_CONTRACT
//   PURPOSE: Parse and format monetary amounts as integer cents without floating-point drift.
//   SCOPE: parseAmount() and formatAmount(); validates instead of coercing; throws MoneyError.
//   DEPENDS: none
//   LINKS: docs/modules/M-MONEY.xml
// END_MODULE_CONTRACT

// START_MODULE_MAP
//   parseAmount  — decimal string -> integer cents
//   formatAmount — integer cents -> two-decimal string
//   MoneyError   — validation error for malformed amounts
// END_MODULE_MAP

// START_CHANGE_SUMMARY
//   v1.0.0 — initial deterministic implementation used by the cart module
// END_CHANGE_SUMMARY

export class MoneyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MoneyError";
  }
}

// START_CONTRACT: parseAmount
//   PURPOSE: Parse a decimal amount into integer cents with explicit validation.
//   INPUTS: value — string such as "12.34" or "12,34"
//   OUTPUTS: integer cents (0 is allowed)
//   ERRORS: MoneyError for empty, negative, non-numeric or over-precise input
// END_CONTRACT: parseAmount
export function parseAmount(value: string): number {
  // START_BLOCK_VALIDATE_AMOUNT
  const text = value.trim().replace(/\\s+/g, "").replace(",", ".");
  if (text === "") throw new MoneyError("amount must not be empty");
  if (!/^-?\\d+(?:\\.\\d{1,2})?$/.test(text)) throw new MoneyError(\`invalid amount: \${value}\`);
  if (text.startsWith("-")) throw new MoneyError("amount must not be negative");
  // END_BLOCK_VALIDATE_AMOUNT

  // START_BLOCK_CONVERT_TO_CENTS
  const [whole, fraction = ""] = text.split(".");
  return Number.parseInt(whole!, 10) * 100 + Number.parseInt(fraction.padEnd(2, "0"), 10);
  // END_BLOCK_CONVERT_TO_CENTS
}

// START_CONTRACT: formatAmount
//   PURPOSE: Render integer cents as a fixed two-decimal string.
//   INPUTS: cents — non-negative integer
//   OUTPUTS: string such as "12.34"
//   ERRORS: MoneyError for negative or non-integer cents
// END_CONTRACT: formatAmount
export function formatAmount(cents: number): string {
  // START_BLOCK_VALIDATE_CENTS
  if (!Number.isInteger(cents) || cents < 0) throw new MoneyError(\`invalid cents: \${cents}\`);
  // END_BLOCK_VALIDATE_CENTS
  const whole = Math.floor(cents / 100);
  const fraction = \`\${cents % 100}\`.padStart(2, "0");
  return \`\${whole}.\${fraction}\`;
}
`,

  "src/money/index.test.ts": `import { describe, expect, test } from "bun:test";
import { MoneyError, formatAmount, parseAmount } from "./index";

describe("M-MONEY parseAmount", () => {
  test("parses whole and two-decimal amounts into integer cents", () => {
    expect(parseAmount("12")).toBe(1200);
    expect(parseAmount("12.34")).toBe(1234);
    expect(parseAmount("12,34")).toBe(1234);
    expect(parseAmount(" 0 ")).toBe(0);
  });

  test("rejects empty amounts", () => {
    expect(() => parseAmount("")).toThrow(MoneyError);
    expect(() => parseAmount("   ")).toThrow("amount must not be empty");
  });

  test("rejects non-numeric and over-precise amounts", () => {
    expect(() => parseAmount("abc")).toThrow(MoneyError);
    expect(() => parseAmount("12.345")).toThrow(MoneyError);
  });

  test("rejects negative amounts", () => {
    expect(() => parseAmount("-1")).toThrow("amount must not be negative");
  });
});

describe("M-MONEY formatAmount", () => {
  test("formats integer cents with two decimals", () => {
    expect(formatAmount(1234)).toBe("12.34");
    expect(formatAmount(5)).toBe("0.05");
    expect(formatAmount(0)).toBe("0.00");
  });

  test("rejects negative and fractional cents", () => {
    expect(() => formatAmount(-1)).toThrow(MoneyError);
    expect(() => formatAmount(1.5)).toThrow(MoneyError);
  });
});
`,

  "src/catalog/index.ts": `// START_MODULE_CONTRACT
//   PURPOSE: Build a validated product catalog and resolve products by id.
//   SCOPE: createCatalog(), findProduct(), describeProduct(); throws CatalogError on invalid input.
//   DEPENDS: M-MONEY
//   LINKS: docs/modules/M-CATALOG.xml
// END_MODULE_CONTRACT

// START_MODULE_MAP
//   createCatalog   — validate and freeze a product list
//   findProduct     — resolve one product or throw CatalogError
//   describeProduct — human-readable name + formatted price
// END_MODULE_MAP

// START_CHANGE_SUMMARY
//   v1.0.0 — initial implementation with duplicate/price/stock validation
// END_CHANGE_SUMMARY

import { formatAmount } from "../money/index";

export interface Product {
  id: string;
  name: string;
  priceCents: number;
  stock: number;
}

export interface Catalog {
  readonly products: readonly Product[];
}

export class CatalogError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CatalogError";
  }
}

// START_CONTRACT: createCatalog
//   PURPOSE: Validate a product list and return an immutable catalog.
//   INPUTS: products — product records supplied by the caller
//   OUTPUTS: Catalog
//   ERRORS: CatalogError for empty ids, duplicates, invalid prices or stock
// END_CONTRACT: createCatalog
export function createCatalog(products: readonly Product[]): Catalog {
  // START_BLOCK_VALIDATE_PRODUCTS
  const seen = new Set<string>();
  for (const product of products) {
    if (product.id.trim() === "") throw new CatalogError("product id is required");
    if (seen.has(product.id)) throw new CatalogError(\`duplicate product id: \${product.id}\`);
    if (!Number.isInteger(product.priceCents) || product.priceCents <= 0) {
      throw new CatalogError(\`invalid price for \${product.id}\`);
    }
    if (!Number.isInteger(product.stock) || product.stock < 0) {
      throw new CatalogError(\`invalid stock for \${product.id}\`);
    }
    seen.add(product.id);
  }
  // END_BLOCK_VALIDATE_PRODUCTS
  return { products: [...products] };
}

// START_CONTRACT: findProduct
//   PURPOSE: Resolve a product by id.
//   INPUTS: catalog — validated catalog; id — product id
//   OUTPUTS: Product
//   ERRORS: CatalogError when the id is unknown
// END_CONTRACT: findProduct
export function findProduct(catalog: Catalog, id: string): Product {
  // START_BLOCK_RESOLVE_PRODUCT
  const product = catalog.products.find((candidate) => candidate.id === id);
  if (product === undefined) throw new CatalogError(\`unknown product: \${id}\`);
  return product;
  // END_BLOCK_RESOLVE_PRODUCT
}

export function describeProduct(product: Product): string {
  return \`\${product.name} (\${formatAmount(product.priceCents)})\`;
}
`,

  "src/catalog/index.test.ts": `import { describe, expect, test } from "bun:test";
import { CatalogError, createCatalog, describeProduct, findProduct } from "./index";

const validProducts = [
  { id: "sku-1", name: "Keyboard", priceCents: 4900, stock: 3 },
  { id: "sku-2", name: "Mouse", priceCents: 1900, stock: 10 },
];

describe("M-CATALOG createCatalog", () => {
  test("accepts valid products", () => {
    const catalog = createCatalog(validProducts);
    expect(catalog.products).toHaveLength(2);
    expect(findProduct(catalog, "sku-1").name).toBe("Keyboard");
  });

  test("rejects duplicate ids", () => {
    expect(() => createCatalog([validProducts[0]!, validProducts[0]!])).toThrow("duplicate product id");
  });

  test("rejects non-positive prices and negative stock", () => {
    expect(() => createCatalog([{ id: "x", name: "Free", priceCents: 0, stock: 1 }])).toThrow(CatalogError);
    expect(() => createCatalog([{ id: "y", name: "Broken", priceCents: 100, stock: -1 }])).toThrow(CatalogError);
  });
});

describe("M-CATALOG findProduct / describeProduct", () => {
  test("throws for unknown product ids", () => {
    const catalog = createCatalog(validProducts);
    expect(() => findProduct(catalog, "missing")).toThrow("unknown product: missing");
  });

  test("formats the price through the money module", () => {
    const catalog = createCatalog(validProducts);
    expect(describeProduct(findProduct(catalog, "sku-1"))).toBe("Keyboard (49.00)");
  });
});
`,

  "src/cart/index.ts": `// START_MODULE_CONTRACT
//   PURPOSE: Maintain a shopping cart with validated quantities and exact totals.
//   SCOPE: createCart(), addItem(), subtotalCents(), renderSubtotal(); throws CartError on invalid input.
//   DEPENDS: M-CATALOG, M-MONEY
//   LINKS: docs/modules/M-CART.xml
// END_MODULE_CONTRACT

// START_MODULE_MAP
//   createCart    — empty cart
//   addItem       — validate quantity/stock and store an item
//   subtotalCents — exact integer-cent total
//   renderSubtotal — formatted total string
// END_MODULE_MAP

// START_CHANGE_SUMMARY
//   v1.0.0 — initial implementation; composes catalog + money modules
// END_CHANGE_SUMMARY

import { findProduct, type Catalog } from "../catalog/index";
import { formatAmount } from "../money/index";

export interface CartItem {
  productId: string;
  quantity: number;
  unitPriceCents: number;
}

export interface Cart {
  items: CartItem[];
}

export class CartError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CartError";
  }
}

export function createCart(): Cart {
  return { items: [] };
}

// START_CONTRACT: addItem
//   PURPOSE: Add a product to the cart after validating quantity and stock.
//   INPUTS: cart, catalog, productId, quantity
//   OUTPUTS: the same cart (mutated for convenience)
//   ERRORS: CartError for invalid quantity/stock; CatalogError for unknown products
// END_CONTRACT: addItem
export function addItem(cart: Cart, catalog: Catalog, productId: string, quantity: number): Cart {
  // START_BLOCK_VALIDATE_QUANTITY
  if (!Number.isInteger(quantity) || quantity <= 0) {
    throw new CartError(\`quantity must be a positive integer, got \${quantity}\`);
  }
  // END_BLOCK_VALIDATE_QUANTITY

  // START_BLOCK_RESOLVE_AND_STORE
  const product = findProduct(catalog, productId);
  if (quantity > product.stock) throw new CartError(\`not enough stock for \${productId}\`);
  const existing = cart.items.find((item) => item.productId === productId);
  if (existing !== undefined) existing.quantity += quantity;
  else cart.items.push({ productId, quantity, unitPriceCents: product.priceCents });
  return cart;
  // END_BLOCK_RESOLVE_AND_STORE
}

export function subtotalCents(cart: Cart): number {
  return cart.items.reduce((total, item) => total + item.unitPriceCents * item.quantity, 0);
}

export function renderSubtotal(cart: Cart): string {
  return formatAmount(subtotalCents(cart));
}
`,

  "src/cart/index.test.ts": `import { describe, expect, test } from "bun:test";
import { CatalogError, createCatalog } from "../catalog/index";
import { CartError, addItem, createCart, renderSubtotal, subtotalCents } from "./index";

const catalog = createCatalog([
  { id: "sku-1", name: "Keyboard", priceCents: 4900, stock: 3 },
  { id: "sku-2", name: "Mouse", priceCents: 1900, stock: 1 },
]);

describe("M-CART addItem", () => {
  test("stores items and accumulates quantity", () => {
    const cart = createCart();
    addItem(cart, catalog, "sku-1", 1);
    addItem(cart, catalog, "sku-1", 2);
    expect(cart.items).toEqual([{ productId: "sku-1", quantity: 3, unitPriceCents: 4900 }]);
  });

  test("rejects non-positive and fractional quantities", () => {
    const cart = createCart();
    expect(() => addItem(cart, catalog, "sku-1", 0)).toThrow(CartError);
    expect(() => addItem(cart, catalog, "sku-1", 1.5)).toThrow("quantity must be a positive integer");
  });

  test("rejects unknown products and insufficient stock", () => {
    const cart = createCart();
    expect(() => addItem(cart, catalog, "missing", 1)).toThrow(CatalogError);
    expect(() => addItem(cart, catalog, "sku-2", 2)).toThrow("not enough stock for sku-2");
  });
});

describe("M-CART totals", () => {
  test("computes exact integer-cent subtotals through the money module", () => {
    const cart = createCart();
    addItem(cart, catalog, "sku-1", 2);
    addItem(cart, catalog, "sku-2", 1);
    expect(subtotalCents(cart)).toBe(11700);
    expect(renderSubtotal(cart)).toBe("117.00");
  });

  test("an empty cart is exactly zero", () => {
    expect(subtotalCents(createCart())).toBe(0);
    expect(renderSubtotal(createCart())).toBe("0.00");
  });
});
`,
};

const AGENTS_MD = `# MyGRACE Demo Store

A deliberately small but real example project used to dogfood MyGRACE on
DeepSeek Harness. It has three modules with actual logic and failure tests:

- **M-MONEY** (\`src/money\`) — integer-cent money parsing/formatting.
- **M-CATALOG** (\`src/catalog\`) — validated product catalog.
- **M-CART** (\`src/cart\`) — cart composition of the two modules.

Navigate index-first:

1. \`docs/graph-index.xml\` — modules and their contracts.
2. \`docs/modules/M-XXX.xml\` — per-module contract + annotations.
3. \`docs/verification/V-M-XXX.xml\` — test files, module-checks, scenarios.

Run the demo tests from this directory with \`bun test\` (its own bunfig.toml
scopes discovery to this project). Lint it with
\`bun run ../../src/grace.ts lint --path .\` or, from the repository root,
\`bun run lint:demo\`.
`;

const DEMO_README = `# Demo Store (MyGRACE example)

A three-module, real-logic example project that MyGRACE is dogfooded on:

- \`src/money\` — parse/format amounts as integer cents, with validation.
- \`src/catalog\` — validated product catalog and product lookup.
- \`src/cart\` — validated cart composition and exact totals.

Generated deterministically by \`scripts/gen-example.ts\`; do not edit the
generated files by hand — change the generator instead and regenerate.

## Verify

\`\`\`bash
cd examples/demo-store
bun test
bun run ../../src/grace.ts lint --path .
bun run ../../src/grace.ts measure  # not a command; use scripts/measure-context.ts from the repo root
\`\`\`
`;

const DEMO_PACKAGE_JSON = {
  name: "mygrace-demo-store",
  private: true,
  type: "module",
  description: "Real-logic MyGRACE demo project (generated by scripts/gen-example.ts)",
  scripts: { test: "bun test" },
};

const DEMO_BUNFIG = `# Self-contained demo project: scope bun test discovery to this directory so
# the repository-level bunfig.toml (test root ./test) does not hide the demo tests.
[test]
root = "."
`;

// ─── generation ─────────────────────────────────────────────────────────

const BUDGETS = {
  module: [30, 80] as const,
  phase: [50, 200] as const,
  verification: [20, 60] as const,
  graphIndexMax: 100,
  planIndexMax: 50,
  verificationIndexMax: 80,
};

function physicalLines(content: string): number {
  return content.split("\n").length;
}

function buildFiles(): Map<string, string> {
  const files = new Map<string, string>();
  files.set("AGENTS.md", AGENTS_MD);
  files.set("README.md", DEMO_README);
  files.set("package.json", `${JSON.stringify(DEMO_PACKAGE_JSON, null, 2)}\n`);
  files.set("bunfig.toml", DEMO_BUNFIG);
  files.set("docs/archive/.gitkeep", "");

  files.set("docs/graph-index.xml", graphIndex());
  files.set("docs/plan-index.xml", planIndex());
  files.set("docs/verification-index.xml", verificationIndex());

  const priorities: Record<string, string> = { "M-MONEY": "high", "M-CATALOG": "high", "M-CART": "high" };
  for (const module of MODULES) {
    files.set(`docs/modules/${module.id}.xml`, moduleDoc(module));
    files.set(`docs/verification/V-${module.id}.xml`, verificationDoc(module, priorities[module.id] ?? "medium"));
  }
  for (const phase of PHASES) files.set(`docs/plans/Phase-${phase.number}.xml`, phaseDoc(phase));
  for (const [path, content] of Object.entries(SOURCE_FILES)) files.set(path, content);
  return files;
}

function assertWithinBudgets(files: Map<string, string>): void {
  const problems: string[] = [];
  const check = (label: string, content: string, min: number, max: number): void => {
    const lines = physicalLines(content);
    if (lines < min || lines > max) problems.push(`${label}: ${lines} lines, budget ${min}-${max}`);
  };
  for (const module of MODULES) {
    check(`docs/modules/${module.id}.xml`, files.get(`docs/modules/${module.id}.xml`)!, ...BUDGETS.module);
    check(
      `docs/verification/V-${module.id}.xml`,
      files.get(`docs/verification/V-${module.id}.xml`)!,
      ...BUDGETS.verification
    );
  }
  for (const phase of PHASES) {
    check(`docs/plans/Phase-${phase.number}.xml`, files.get(`docs/plans/Phase-${phase.number}.xml`)!, ...BUDGETS.phase);
  }
  const indexChecks: Array<[string, number]> = [
    ["docs/graph-index.xml", BUDGETS.graphIndexMax],
    ["docs/plan-index.xml", BUDGETS.planIndexMax],
    ["docs/verification-index.xml", BUDGETS.verificationIndexMax],
  ];
  for (const [path, cap] of indexChecks) {
    const lines = physicalLines(files.get(path)!);
    if (lines > cap) problems.push(`${path}: ${lines} lines, cap ${cap}`);
  }
  if (problems.length > 0) {
    throw new Error(`Generated demo violates its own budgets:\n  ${problems.join("\n  ")}`);
  }
}

function listFilesRecursive(root: string, base = root): string[] {
  if (!existsSync(root)) return [];
  const output: string[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const full = join(root, entry.name);
    if (entry.isDirectory()) output.push(...listFilesRecursive(full, base));
    else if (entry.isFile()) output.push(relative(base, full).split(sep).join("/"));
  }
  return output.sort();
}

function compareWithCheckout(files: Map<string, string>, exampleDir: string): string[] {
  const drift: string[] = [];
  const generated = [...files.keys()].sort();
  const onDisk = listFilesRecursive(exampleDir);
  const onDiskSet = new Set(onDisk);
  for (const path of generated) {
    if (!onDiskSet.has(path)) {
      drift.push(`missing from examples/demo-store: ${path}`);
      continue;
    }
    const expected = files.get(path)!;
    const actual = readFileSync(join(exampleDir, path), "utf-8");
    if (actual !== expected) drift.push(`content differs: examples/demo-store/${path}`);
  }
  for (const path of onDisk) {
    if (!files.has(path)) drift.push(`unexpected file in examples/demo-store: ${path}`);
  }
  return drift;
}

function writeFiles(targetDir: string, files: Map<string, string>): void {
  for (const [path, content] of files) {
    const absolute = join(targetDir, path);
    mkdirSync(dirname(absolute), { recursive: true });
    writeFileSync(absolute, content);
  }
}

function main(): void {
  const argv = process.argv.slice(2);
  const check = argv.includes("--check");
  if (argv.includes("--help") || argv.includes("-h")) {
    console.log(
      "Usage: bun run scripts/gen-example.ts [--check]\n" +
        "  (default) regenerate examples/demo-store deterministically\n" +
        "  --check   generate into a temporary directory and fail on drift"
    );
    process.exit(0);
  }
  const unknown = argv.filter((argument) => argument !== "--check");
  if (unknown.length > 0) {
    console.error(`gen-example: unknown argument(s): ${unknown.join(", ")}`);
    process.exit(2);
  }

  const files = buildFiles();
  assertWithinBudgets(files);

  if (check) {
    const drift = compareWithCheckout(files, EXAMPLE);
    if (drift.length === 0) {
      console.log(`✓ examples/demo-store is in sync with scripts/gen-example.ts (${files.size} files).`);
      process.exit(0);
    }
    console.log(`✗ examples/demo-store drift detected (${drift.length} file(s)):`);
    for (const line of drift.slice(0, 40)) console.log(`  - ${line}`);
    if (drift.length > 40) console.log(`  … and ${drift.length - 40} more`);
    console.log("Run `bun run scripts/gen-example.ts` to regenerate the demo.");
    process.exit(1);
  }

  // Build entirely in memory first (budgets validated above), then replace the
  // generated directory atomically enough for a generator.
  const resolvedExample = resolve(EXAMPLE);
  if (!resolvedExample.endsWith(join("examples", "demo-store"))) {
    throw new Error(`Refusing to write outside examples/demo-store: ${resolvedExample}`);
  }
  rmSync(resolvedExample, { recursive: true, force: true });
  writeFiles(resolvedExample, files);
  console.log(
    `Generated ${resolvedExample} (${files.size} files, ${MODULES.length} real modules, ${PHASES.length} phases)`
  );
}

try {
  main();
} catch (error) {
  console.error(`gen-example: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(error instanceof Error && /budgets/.test(error.message) ? 1 : 3);
}
