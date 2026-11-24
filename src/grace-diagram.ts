/**
 * MyGRACE — Diagram exporter (ROADMAP ADR-9, Wave 5 / v1.5).
 *
 * The docs graph is already a typed model (modules, declared dependencies,
 * verifications, phases). This module renders it deterministically:
 *
 *   docs/ ──► Archify architecture IR ──► (optional) archify validate/deliver
 *                                        ──► standalone HTML + JSON IR + receipt
 *
 * JSON and Mermaid output work without Archify; HTML requires the optional
 * Archify CLI (ADR-9: detected, version-pinned, scrubbed child env, untrusted
 * output parsed as data). Nothing runs during `lint`/`ci`.
 */

// START_MODULE_CONTRACT
//   PURPOSE: Export the MyGRACE docs graph as a deterministic Archify architecture IR, Mermaid diagram or standalone HTML built by the optional Archify CLI.
//   SCOPE: Reads docs/graph-index.xml, plan-index.xml, verification-index.xml and verification files; writes only explicit diagram artifacts (IR/HTML/receipt) under the configured output directory.
//   DEPENDS: grace-common (findProjectRoot/readIndexFileSafe), grace-config, grace-errors, grace-integrations (ADR-9 registry), grace-shard, grace-lint, grace-test, grace-xml, node:child_process, node:crypto, node:fs, node:os, node:path
//   LINKS: ROADMAP.md (ADR-9, Wave 5), INTEGRATION-PLAN.md §4, docs/modules/M-DIAGRAM.xml
// END_MODULE_CONTRACT

// START_MODULE_MAP
//   DIAGRAM_FINDING_CODES   — DIAGRAM_STALE / DIAGRAM_VALIDATION_FAILED / DIAGRAM_DELIVERY_FAILED / INTEGRATION_* reuse
//   DiagramIr               — Archify architecture JSON (schema_version 1, components, boundaries, connections, cards)
//   DiagramSummary          — deterministic counts used in text/JSON output and receipts
//   buildArchitectureDiagram() — docs graph → IR + summary + graph sha256
//   renderMermaid()         — dependency-free flowchart fallback
//   runArchifyValidate()    — optional `archify validate architecture … --json`
//   runArchifyDeliver()     — optional `archify deliver architecture … --json`
//   diagramCommand          — `mygrace diagram [--kind architecture] [--format text|json|html|mermaid] [--out] [--quality] [--check]`
// END_MODULE_MAP

// START_CHANGE_SUMMARY
//   v1.5.0 — introduced: deterministic architecture IR from the docs graph,
//   Mermaid fallback, optional Archify validate/deliver with a machine receipt,
//   `--check` staleness gate and the `mygrace diagram` command.
// END_CHANGE_SUMMARY

import { defineCommand } from "citty";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { findProjectRoot, readIndexFileSafe } from "./grace-common";
import { loadConfig } from "./grace-config";
import type { MyGraceConfig } from "./grace-config";
import { createEnvelope, finding, UsageError } from "./grace-errors";
import type { Finding } from "./grace-errors";
import { findExecutableOnPath, integrationChildEnv, resolveIntegration } from "./grace-integrations";
import type { IntegrationStatus } from "./grace-integrations";
import { collectLintIssues } from "./grace-lint";
import { loadGraphIndexStrict } from "./grace-shard";
import { runCommandOutcome } from "./grace-test";
import type { CommandOutcome } from "./grace-test";
import { tryParseXml } from "./grace-xml";
import type { XmlElement } from "./grace-xml";

// START_BLOCK_TYPES
/** Stable finding codes emitted by `mygrace diagram`. */
export const DIAGRAM_FINDING_CODES = {
  stale: "DIAGRAM_STALE",
  validationFailed: "DIAGRAM_VALIDATION_FAILED",
  deliveryFailed: "DIAGRAM_DELIVERY_FAILED",
} as const;

/** Archify architecture IR (subset emitted by MyGRACE; valid for schema_version 1). */
export type ArchifyComponentType = "frontend" | "backend" | "database" | "cloud" | "security" | "messagebus" | "external";
export type ArchifyDot = "cyan" | "emerald" | "violet" | "amber" | "rose" | "orange" | "slate";

export interface DiagramComponent {
  id: string;
  type: ArchifyComponentType;
  label: string;
  sublabel: string;
  tag: string;
  pos: [number, number];
  size: [number, number];
}

export interface DiagramConnection {
  id: string;
  from: string;
  to: string;
}

export interface DiagramBoundary {
  kind: "region";
  label: string;
  wraps: string[];
}

export interface DiagramCard {
  dot: ArchifyDot;
  title: string;
  items: string[];
}

export interface DiagramMeta {
  title: string;
  subtitle: string;
  output: string;
  quality_profile: "standard" | "showcase";
}

export interface DiagramIr {
  schema_version: 1;
  diagram_type: "architecture";
  meta: DiagramMeta;
  components: DiagramComponent[];
  boundaries: DiagramBoundary[];
  connections: DiagramConnection[];
  cards: DiagramCard[];
}

export interface DiagramSummary {
  modules: number;
  /** All declared DEPENDS edges between indexed modules. */
  dependencies: number;
  /** Legible primary-dependency backbone rendered in the Archify IR. */
  depictedDependencies: number;
  boundaries: number;
  phases: number;
  verifications: number;
  testFiles: number;
  verifiedModules: number;
  lintErrors: number;
  lintWarnings: number;
}

export interface DiagramBuildResult {
  ir: DiagramIr;
  irText: string;
  summary: DiagramSummary;
  /** Every declared module dependency (full fidelity; Mermaid/json output uses it). */
  fullConnections: DiagramConnection[];
  /** sha256 of the canonical graph input (not of the rendered text). */
  graphSha256: string;
}

export interface ArchifyRun {
  ok: boolean;
  payload: Record<string, unknown> | null;
  error: string | null;
}

export type DiagramOutputFormat = "text" | "json" | "html" | "mermaid";
// END_BLOCK_TYPES

// START_BLOCK_MAPPING
const ACCEPTED_KINDS = ["architecture"] as const;
type DiagramKind = (typeof ACCEPTED_KINDS)[number];

const GROUP_LABELS: Record<string, string> = {
  FOUNDATION: "Foundation",
  CORE_LOGIC: "Core logic",
  ORCHESTRATOR: "Orchestration",
  UTILITY: "Utilities",
  INTEGRATION: "Integrations",
  ENTRY_POINT: "Entry point",
};

const ARCHIFY_TYPES: Record<string, ArchifyComponentType> = {
  FOUNDATION: "backend",
  CORE_LOGIC: "backend",
  ORCHESTRATOR: "backend",
  UTILITY: "backend",
  INTEGRATION: "external",
  ENTRY_POINT: "backend",
};

interface DiagramModule {
  id: string;
  name: string;
  type: string;
  status: string;
  path: string;
  verificationRef: string;
  depends: string[];
}

function graphModules(root: string, config: MyGraceConfig): DiagramModule[] {
  const graph = loadGraphIndexStrict(root, config);
  const modules: DiagramModule[] = [];
  for (const entry of graph.entries) {
    if (!/^M-[A-Za-z0-9][A-Za-z0-9_-]*$/.test(entry.tag)) continue;
    const path = (entry.attrs.PATH ?? "").trim().replace(/\\/g, "/");
    modules.push({
      id: entry.tag,
      name: (entry.attrs.NAME ?? entry.tag).trim(),
      type: (entry.attrs.TYPE ?? "CORE_LOGIC").trim().toUpperCase(),
      status: (entry.attrs.STATUS ?? entry.attrs.status ?? "").trim().toLowerCase(),
      path,
      verificationRef: (entry.attrs.VERIFICATION_REF ?? "").trim(),
      depends: (entry.attrs.DEPENDS ?? "")
        .split(",")
        .map((item) => item.trim())
        .filter((item) => item !== ""),
    });
  }
  return modules.sort((left, right) => left.id.localeCompare(right.id));
}

function projectNameOf(root: string): string {
  try {
    const parsed = tryParseXml(readFileSync(join(root, "docs", "graph-index.xml"), "utf-8"));
    if (parsed.ok) {
      const project = (parsed.document.root.attrs.project ?? "").trim();
      if (project !== "") return project;
    }
  } catch {
    // Fall through to the directory name.
  }
  return basename(root) || "MyGRACE project";
}

function portableOutputName(outHtml: string): string {
  const name = basename(outHtml).replace(/[\\<>:"|?*\u0000-\u001F\u007F-\u009F]/g, "-");
  const withHtml = /\.html$/i.test(name) ? name : `${name}.html`;
  return withHtml.replace(/^[. ]+/, "diagram-");
}

function countTestFiles(root: string): number {
  const verificationIndex = readIndexFileSafe(join(root, "docs", "verification-index.xml"));
  let files = 0;
  for (const entry of verificationIndex.entries) {
    if (!/^V-M-[A-Za-z0-9][A-Za-z0-9_-]*$/.test(entry.tag)) continue;
    const file = join(root, "docs", "verification", `${entry.tag}.xml`);
    if (!existsSync(file)) continue;
    try {
      const parsed = tryParseXml(readFileSync(file, "utf-8"), file);
      if (!parsed.ok) continue;
      files += parsed.document.elements.filter((element: XmlElement) => element.tag === "file").length;
    } catch {
      // An unreadable verification file is not a diagram failure.
    }
  }
  return files;
}

/**
 * Dependency-depth layering (longest path over the full declared graph).
 *
 * Archify validates "clean flow": edges may not pass through unrelated nodes.
 * A dense module graph cannot satisfy that, so the HTML view shows a legible
 * primary-dependency backbone (one edge per module) placed by dependency depth;
 * the complete edge list stays available in JSON/Mermaid output and receipts.
 */
function dependencyLayers(modules: DiagramModule[], connections: DiagramConnection[]): Map<string, number> {
  const deps = new Map<string, string[]>(modules.map((module) => [module.id, []]));
  for (const connection of connections) deps.get(connection.from)?.push(connection.to);
  const layers = new Map<string, number>();
  const visiting = new Set<string>();
  const depth = (id: string): number => {
    const known = layers.get(id);
    if (known !== undefined) return known;
    if (visiting.has(id)) return 0; // defensive for accidental cycles
    visiting.add(id);
    let value = 0;
    for (const dependency of deps.get(id) ?? []) value = Math.max(value, depth(dependency) + 1);
    visiting.delete(id);
    layers.set(id, value);
    return value;
  };
  for (const module of modules) depth(module.id);
  return layers;
}

/** One primary dependency per module — the edge that best explains its depth. */
function primaryBackbone(
  modules: DiagramModule[],
  connections: DiagramConnection[],
  layers: ReadonlyMap<string, number>
): DiagramConnection[] {
  const candidates = new Map<string, string[]>();
  for (const connection of connections) {
    candidates.set(connection.from, [...(candidates.get(connection.from) ?? []), connection.to]);
  }
  const backbone: DiagramConnection[] = [];
  for (const module of modules) {
    const deps = candidates.get(module.id);
    if (deps === undefined || deps.length === 0) continue;
    const sorted = [...deps].sort(
      (left, right) => (layers.get(right) ?? 0) - (layers.get(left) ?? 0) || left.localeCompare(right)
    );
    const chosen = sorted[0];
    if (chosen === undefined) continue;
    backbone.push({ id: `${module.id}-to-${chosen}`, from: module.id, to: chosen });
  }
  backbone.sort((left, right) => left.from.localeCompare(right.from) || left.to.localeCompare(right.to));
  return backbone;
}

/** Layered deterministic layout: uniform cells sized by the widest label. */
function layoutComponents(
  modules: DiagramModule[],
  layers: ReadonlyMap<string, number>
): DiagramComponent[] {
  const widest = modules.reduce((max, module) => Math.max(max, module.name.length), 0);
  const cellW = Math.max(180, Math.ceil(widest * 7.5) + 40);
  const byLayer = new Map<number, DiagramModule[]>();
  for (const module of modules) {
    const layer = layers.get(module.id) ?? 0;
    byLayer.set(layer, [...(byLayer.get(layer) ?? []), module]);
  }
  const positions = new Map<string, [number, number]>();
  for (const [layer, layerModules] of [...byLayer.entries()].sort((left, right) => left[0] - right[0])) {
    layerModules.sort((left, right) => left.id.localeCompare(right.id));
    layerModules.forEach((module, index) => {
      positions.set(module.id, [160 + layer * (cellW + 120), 180 + index * 152]);
    });
  }
  return modules.map((module) => {
    const position = positions.get(module.id) ?? [160, 180];
    return {
      id: module.id,
      type: ARCHIFY_TYPES[module.type] ?? "backend",
      label: module.name,
      sublabel: `${module.type}${module.status === "" ? "" : ` · ${module.status}`}`,
      tag: module.verificationRef === "" ? module.id : module.verificationRef,
      pos: position,
      size: [cellW, 72] as [number, number],
    };
  });
}

/**
 * Build the deterministic architecture IR for a project.
 *
 * `outputHtml` only influences `meta.output` (a portable relative HTML name), so
 * the graph part stays stable across hosts and output choices.
 */
export function buildArchitectureDiagram(
  root: string,
  config: MyGraceConfig,
  options: { outputHtml: string; quality?: "standard" | "showcase" }
): DiagramBuildResult {
  const modules = graphModules(root, config);
  const byId = new Map(modules.map((module) => [module.id, module]));
  const fullConnections: DiagramConnection[] = [];
  const seen = new Set<string>();
  for (const module of modules) {
    for (const dependency of module.depends) {
      if (!byId.has(dependency) || dependency === module.id) continue;
      const key = `${module.id}\u0000${dependency}`;
      if (seen.has(key)) continue;
      seen.add(key);
      fullConnections.push({ id: `${module.id}-to-${dependency}`, from: module.id, to: dependency });
    }
  }
  fullConnections.sort((left, right) => left.from.localeCompare(right.from) || left.to.localeCompare(right.to));
  const layers = dependencyLayers(modules, fullConnections);
  const connections = primaryBackbone(modules, fullConnections, layers);

  const boundaries: DiagramBoundary[] = [];
  const groups = new Map<string, string[]>();
  for (const module of modules) {
    const label = GROUP_LABELS[module.type] ?? module.type;
    const bucket = groups.get(label) ?? [];
    bucket.push(module.id);
    groups.set(label, bucket);
  }
  for (const [label, wraps] of [...groups.entries()].sort((left, right) => left[0].localeCompare(right[0]))) {
    boundaries.push({ kind: "region", label, wraps: [...wraps].sort((a, b) => a.localeCompare(b)) });
  }

  const phases = readIndexFileSafe(join(root, "docs", "plan-index.xml")).entries.length;
  const verifications = readIndexFileSafe(join(root, "docs", "verification-index.xml")).entries.length;
  const testFiles = countTestFiles(root);
  const verifiedModules = modules.filter((module) => module.verificationRef !== "").length;
  let lintErrors = 0;
  let lintWarnings = 0;
  try {
    const issues = collectLintIssues(root, false, config);
    lintErrors = issues.filter((issue) => issue.severity === "error").length;
    lintWarnings = issues.filter((issue) => issue.severity === "warning").length;
  } catch {
    // Lint is a nice card, not a diagram precondition.
  }

  const summary: DiagramSummary = {
    modules: modules.length,
    dependencies: fullConnections.length,
    depictedDependencies: connections.length,
    boundaries: boundaries.length,
    phases,
    verifications,
    testFiles,
    verifiedModules,
    lintErrors,
    lintWarnings,
  };

  const cards: DiagramCard[] = [
    {
      dot: "cyan",
      title: "Graph",
      items: [
        `${summary.modules} modules · ${summary.dependencies} declared dependencies`,
        `${summary.depictedDependencies} primary edges drawn · ${summary.phases} phases · ${summary.verifications} verifications`,
      ],
    },
    {
      dot: summary.verifiedModules === summary.modules ? "emerald" : "amber",
      title: "Verification",
      items: [
        `${summary.verifiedModules}/${summary.modules} modules reference a verification file`,
        `${summary.testFiles} declared test files`,
      ],
    },
    {
      dot: summary.lintErrors > 0 ? "rose" : summary.lintWarnings > 0 ? "amber" : "emerald",
      title: "Gates",
      items: [`lint: ${summary.lintErrors} errors, ${summary.lintWarnings} warnings`],
    },
  ];

  const ir: DiagramIr = {
    schema_version: 1,
    diagram_type: "architecture",
    meta: {
      title: `MyGRACE — ${projectNameOf(root)}`,
      subtitle: `${summary.modules} modules · ${summary.dependencies} dependencies · ${summary.verifications} verifications`,
      output: portableOutputName(options.outputHtml),
      quality_profile: options.quality ?? "standard",
    },
    components: layoutComponents(modules, layers),
    boundaries,
    connections,
    cards,
  };

  const graphInput = {
    modules: modules.map((module) => ({
      id: module.id,
      name: module.name,
      type: module.type,
      status: module.status,
      path: module.path,
      verificationRef: module.verificationRef,
      depends: [...module.depends].sort((a, b) => a.localeCompare(b)),
    })),
    connections: fullConnections,
    phases,
    verifications,
    testFiles,
    lintErrors,
    lintWarnings,
  };
  const graphSha256 = createHash("sha256").update(JSON.stringify(graphInput)).digest("hex");

  return { ir, irText: `${JSON.stringify(ir, null, 2)}\n`, summary, fullConnections, graphSha256 };
}

/** Dependency-free Mermaid flowchart (used when Archify is not installed). */
export function renderMermaid(ir: DiagramIr, connections: readonly DiagramConnection[] = ir.connections): string {
  const lines: string[] = ["flowchart LR"];
  for (const boundary of ir.boundaries) {
    lines.push(`  subgraph ${mermaidId(boundary.label)}["${escapeMermaidLabel(boundary.label)}"]`);
    for (const id of boundary.wraps) {
      const component = ir.components.find((candidate) => candidate.id === id);
      if (component === undefined) continue;
      lines.push(`    ${mermaidId(component.id)}["${escapeMermaidLabel(component.label)}"]`);
    }
    lines.push("  end");
  }
  for (const connection of connections) {
    lines.push(`  ${mermaidId(connection.from)} --> ${mermaidId(connection.to)}`);
  }
  return `${lines.join("\n")}\n`;
}

function mermaidId(value: string): string {
  const sanitized = value.replace(/[^A-Za-z0-9_]/g, "_");
  return /^[0-9]/.test(sanitized) ? `n_${sanitized}` : sanitized;
}

function escapeMermaidLabel(value: string): string {
  return value.replace(/["\\]/g, " ");
}
// END_BLOCK_MAPPING

// START_BLOCK_ARCHIFY
function isNodeScript(bin: string): boolean {
  return /\.(?:mjs|cjs|js)$/i.test(bin);
}

function tail(text: string, limit = 320): string {
  const collapsed = text.replace(/\s+/g, " ").trim();
  return collapsed.length <= limit ? collapsed : `${collapsed.slice(0, limit)}…`;
}

/** Run one Archify CLI call with ADR-9 process rules; output is untrusted data. */
function spawnArchify(
  root: string,
  config: MyGraceConfig,
  bin: string,
  nodeRunner: string | null,
  args: string[]
): ArchifyRun {
  const timeout = config.integrations.archify.timeoutMs;
  const command = nodeRunner ?? bin;
  const argv = nodeRunner === null ? args : [bin, ...args];
  const result = spawnSync(command, argv, {
    cwd: root,
    encoding: "utf-8",
    timeout,
    shell: false,
    env: integrationChildEnv(),
    maxBuffer: 16 * 1024 * 1024,
  });
  if (result.error !== undefined) {
    const timedOut = result.error.message.includes("ETIMEDOUT") || result.error.message.includes("timed out");
    return { ok: false, payload: null, error: timedOut ? `archify timed out after ${timeout} ms` : `archify failed: ${result.error.message}` };
  }
  const stdout = result.stdout ?? "";
  const stderr = result.stderr ?? "";
  if (typeof result.status === "number" && result.status !== 0 && stdout.trim() === "") {
    return { ok: false, payload: null, error: `archify exited ${result.status}: ${tail(stderr)}` };
  }
  try {
    const payload = JSON.parse(stdout.trim()) as Record<string, unknown>;
    return { ok: true, payload, error: null };
  } catch {
    return { ok: false, payload: null, error: `archify returned non-JSON output: ${tail(stderr === "" ? stdout : stderr)}` };
  }
}

function payloadOk(run: ArchifyRun): boolean {
  return run.ok && run.payload !== null && run.payload.ok === true;
}

function payloadError(run: ArchifyRun): string {
  if (run.error !== null) return run.error;
  if (run.payload === null) return "archify returned no payload";
  const error = run.payload.error;
  return typeof error === "string" && error !== "" ? tail(error, 500) : "archify reported ok=false";
}

/** Resolve the Archify CLI (config → env → PATH) and the Node runner for .mjs entries. */
function archifyExecutable(
  root: string,
  config: MyGraceConfig
): { status: IntegrationStatus; bin: string; nodeRunner: string | null } | { error: string; hint?: string } {
  const status = resolveIntegration("archify", config, root);
  if (!status.available || status.bin === null) {
    return { error: "Archify is required for --format html but was not found.", hint: status.hint ?? undefined };
  }
  if (isNodeScript(status.bin)) {
    const node = findExecutableOnPath("node");
    if (node === null) {
      return {
        error: "Archify is a Node script, but `node` was not found on PATH.",
        hint: "Install Node >= 18 (Archify requirement) or point MYGRACE_ARCHIFY_BIN at an executable wrapper.",
      };
    }
    return { status, bin: status.bin, nodeRunner: node };
  }
  return { status, bin: status.bin, nodeRunner: null };
}

function readJsonIfExists(path: string): Record<string, unknown> | null {
  try {
    return JSON.parse(readFileSync(path, "utf-8")) as Record<string, unknown>;
  } catch {
    return null;
  }
}

interface DeliveredArchitecture {
  status: IntegrationStatus;
  validation: Record<string, unknown> | null;
  delivery: Record<string, unknown> | null;
}
// END_BLOCK_ARCHIFY

// START_BLOCK_COMMAND
function parseDiagramFormat(value: string): DiagramOutputFormat {
  if (value === "text" || value === "json" || value === "html" || value === "mermaid") return value;
  throw new UsageError(`Invalid --format "${value}" for diagram — expected text, json, html or mermaid.`, {
    hint: "text prints a summary; json returns the IR envelope; html renders through Archify; mermaid prints a flowchart.",
  });
}

function parseDiagramKind(value: string): DiagramKind {
  if ((ACCEPTED_KINDS as readonly string[]).includes(value)) return value as DiagramKind;
  throw new UsageError(
    `Unsupported diagram kind "${value}" — v1.5.0 ships "architecture" (workflow/tree are planned follow-ups).`,
    { hint: "Use --kind architecture. Mermaid/JSON output also covers the dependency graph for other view types." }
  );
}

function relativeToRoot(root: string, absolute: string): string {
  const rel = relative(root, absolute).replace(/\\/g, "/");
  return rel === "" ? "." : rel;
}

function resolveOutputPath(root: string, config: MyGraceConfig, requested: string | undefined): string {
  const defaultPath = join(root, config.integrations.archify.outputDir, "architecture.html");
  if (requested === undefined || requested.trim() === "") return defaultPath;
  const value = requested.trim();
  if (!/\.html$/i.test(value)) {
    throw new UsageError(`--out must end with .html (got "${value}").`, {
      hint: "Example: mygrace diagram --format html --out docs/diagrams/architecture.html",
    });
  }
  const absolute = isAbsolute(value) ? resolve(value) : resolve(root, value);
  const rel = relative(root, absolute);
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) {
    throw new UsageError("--out must stay inside the project root.", {
      hint: "Pass a project-relative path such as docs/diagrams/architecture.html.",
    });
  }
  return absolute;
}

function ensureDirectory(path: string): void {
  const parent = dirname(path);
  if (!existsSync(parent)) mkdirSync(parent, { recursive: true });
  else if (!statSync(parent).isDirectory()) {
    throw new UsageError(`Diagram output parent is not a directory: ${parent}`);
  }
}

interface DiagramData {
  kind: DiagramKind;
  format: DiagramOutputFormat;
  summary: DiagramSummary;
  graphSha256: string;
  ir?: DiagramIr;
  dependencies?: DiagramConnection[];
  mermaid?: string;
  artifacts?: { ir: string; html: string; receipt: string };
  archify?: { bin: string; source: string | null; quality: string; validation: string };
  check?: { ir: string; stale: boolean; expectedSha256: string; actualSha256: string | null };
}

/** Compute one diagram request; returns the envelope plus optional human lines. */
function computeDiagram(rootInput: string, args: Record<string, unknown>): CommandOutcome<DiagramData> | Promise<CommandOutcome<DiagramData>> {
  const root = findProjectRoot(typeof args.path === "string" ? args.path : ".");
  const config = loadConfig(root).config;
  const kind = parseDiagramKind(typeof args.kind === "string" ? args.kind : "architecture");
  const format = parseDiagramFormat(typeof args.format === "string" ? args.format : "text");
  const quality = args.quality === "showcase" ? "showcase" : "standard";
  const outHtml = resolveOutputPath(root, config, typeof args.out === "string" ? args.out : undefined);
  const built = buildArchitectureDiagram(root, config, { outputHtml: outHtml, quality });
  const irPath = outHtml.replace(/\.html$/i, ".json");
  const receiptPath = outHtml.replace(/\.html$/i, ".receipt.json");

  if (args.check === true) {
    const expectedSha = createHash("sha256").update(built.irText).digest("hex");
    const actualText = existsSync(irPath) ? readFileSync(irPath, "utf-8") : null;
    const actualSha = actualText === null ? null : createHash("sha256").update(actualText).digest("hex");
    const stale = actualSha !== expectedSha;
    const findings: Finding[] = stale
      ? [
          finding(
            "error",
            DIAGRAM_FINDING_CODES.stale,
            actualText === null ? `Diagram IR is missing at ${relativeToRoot(root, irPath)}.` : `Diagram IR is stale at ${relativeToRoot(root, irPath)}.`,
            { hint: "Run `mygrace diagram --format html` (or `--format json` to inspect) and commit the refreshed IR." }
          ),
        ]
      : [];
    const data: DiagramData = {
      kind,
      format,
      summary: built.summary,
      graphSha256: built.graphSha256,
      check: { ir: relativeToRoot(root, irPath), stale, expectedSha256: expectedSha, actualSha256: actualSha },
    };
    const envelope = createEnvelope({ data, findings, meta: { command: "diagram", root } });
    const lines = [
      `Diagram check (${kind}): ${stale ? "STALE" : "up to date"}`,
      `  IR: ${relativeToRoot(root, irPath)}`,
      ...(stale ? [`  expected sha256: ${expectedSha}`, `  actual sha256:   ${actualSha ?? "(missing)"}`] : []),
    ];
    return { envelope, print: () => lines.forEach((line) => console.log(line)) };
  }

  if (format === "mermaid") {
    const mermaid = renderMermaid(built.ir, built.fullConnections);
    const data: DiagramData = { kind, format, summary: built.summary, graphSha256: built.graphSha256, mermaid };
    const envelope = createEnvelope({ data, findings: [], meta: { command: "diagram", root } });
    return { envelope, print: () => console.log(mermaid.trimEnd()) };
  }

  if (format === "json") {
    const data: DiagramData = {
      kind,
      format,
      summary: built.summary,
      graphSha256: built.graphSha256,
      ir: built.ir,
      dependencies: built.fullConnections,
    };
    const envelope = createEnvelope({ data, findings: [], meta: { command: "diagram", root } });
    return {
      envelope,
      print: () => {
        console.log(`Diagram (${kind}): ${built.summary.modules} modules · ${built.summary.dependencies} dependencies`);
        console.log(`Graph sha256: ${built.graphSha256}`);
        console.log("IR is available under data.ir in `--format json` output.");
      },
    };
  }

  if (format === "html") {
    const resolved = archifyExecutable(root, config);
    if ("error" in resolved) {
      const findings = [
        finding("error", "INTEGRATION_UNAVAILABLE", resolved.error, resolved.hint === undefined ? {} : { hint: resolved.hint }),
      ];
      const data: DiagramData = { kind, format, summary: built.summary, graphSha256: built.graphSha256 };
      const envelope = createEnvelope({ data, findings, meta: { command: "diagram", root } });
      return { envelope, print: () => console.error(`✗ ${resolved.error}${resolved.hint === undefined ? "" : `\n  → ${resolved.hint}`}`) };
    }
    ensureDirectory(outHtml);
    const tempDir = mkdtempSync(join(tmpdir(), "mygrace-diagram-"));
    const tempIr = join(tempDir, "architecture.json");
    writeFileSync(tempIr, built.irText);
    try {
      const validateRun = spawnArchify(root, config, resolved.bin, resolved.nodeRunner, [
        "validate",
        "architecture",
        tempIr,
        "--json",
        "--quality",
        quality,
      ]);
      if (!payloadOk(validateRun)) {
        const message = payloadError(validateRun);
        const findings = [
          finding("error", DIAGRAM_FINDING_CODES.validationFailed, `Archify rejected the generated IR: ${message}`, {
            hint: "This is a MyGRACE bug or an Archify schema/version mismatch; run `mygrace integrations status` and report it.",
          }),
        ];
        const data: DiagramData = { kind, format, summary: built.summary, graphSha256: built.graphSha256 };
        const envelope = createEnvelope({ data, findings, meta: { command: "diagram", root } });
        return { envelope, print: () => console.error(`✗ Archify rejected the generated IR: ${message}`) };
      }

      writeFileSync(irPath, built.irText);
      const deliverRun = spawnArchify(root, config, resolved.bin, resolved.nodeRunner, [
        "deliver",
        "architecture",
        tempIr,
        outHtml,
        "--json",
        "--quality",
        quality,
      ]);
      if (!payloadOk(deliverRun)) {
        const message = payloadError(deliverRun);
        const findings = [
          finding("error", DIAGRAM_FINDING_CODES.deliveryFailed, `Archify could not deliver ${relativeToRoot(root, outHtml)}: ${message}`, {
            hint: "The IR was refreshed; check the Archify installation/version and re-run.",
          }),
        ];
        const data: DiagramData = { kind, format, summary: built.summary, graphSha256: built.graphSha256, artifacts: { ir: relativeToRoot(root, irPath), html: relativeToRoot(root, outHtml), receipt: relativeToRoot(root, receiptPath) } };
        const envelope = createEnvelope({ data, findings, meta: { command: "diagram", root } });
        return { envelope, print: () => console.error(`✗ Archify delivery failed: ${message}`) };
      }

      const deliverySidecar = readJsonIfExists(
        outHtml.replace(/\.html$/i, ".delivery.json")
      );
      const receipt = {
        schemaVersion: 1,
        kind,
        quality,
        graph: {
          sha256: built.graphSha256,
          modules: built.summary.modules,
          dependencies: { declared: built.summary.dependencies, depicted: built.summary.depictedDependencies },
          boundaries: built.summary.boundaries,
          phases: built.summary.phases,
          verifications: built.summary.verifications,
          testFiles: built.summary.testFiles,
          verifiedModules: built.summary.verifiedModules,
          lintErrors: built.summary.lintErrors,
          lintWarnings: built.summary.lintWarnings,
        },
        archify: {
          bin: resolved.bin,
          source: resolved.status.source,
          version: resolved.status.version,
          quality,
          validation: "passed",
          delivery: deliverySidecar,
        },
        outputs: {
          ir: relativeToRoot(root, irPath),
          html: relativeToRoot(root, outHtml),
          receipt: relativeToRoot(root, receiptPath),
        },
        generatedAt: new Date().toISOString(),
      };
      writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`);

      const delivered: DeliveredArchitecture = {
        status: resolved.status,
        validation: validateRun.payload,
        delivery: deliverRun.payload,
      };
      const data: DiagramData = {
        kind,
        format,
        summary: built.summary,
        graphSha256: built.graphSha256,
        artifacts: { ir: relativeToRoot(root, irPath), html: relativeToRoot(root, outHtml), receipt: relativeToRoot(root, receiptPath) },
        archify: {
          bin: resolved.bin,
          source: resolved.status.source,
          quality,
          validation: payloadOk(validateRun) ? "passed" : "failed",
        },
      };
      const envelope = createEnvelope({ data, findings: [], meta: { command: "diagram", root } });
      const lines = [
        `Diagram delivered (${kind}, ${quality})`,
        `  modules:      ${built.summary.modules}`,
        `  dependencies: ${built.summary.dependencies} declared, ${built.summary.depictedDependencies} primary drawn`,
        `  boundaries:   ${built.summary.boundaries}`,
        `  graph sha256: ${built.graphSha256}`,
        `  IR:           ${relativeToRoot(root, irPath)}`,
        `  HTML:         ${relativeToRoot(root, outHtml)}`,
        `  receipt:      ${relativeToRoot(root, receiptPath)}`,
      ];
      void delivered;
      return { envelope, print: () => lines.forEach((line) => console.log(line)) };
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  }

  const data: DiagramData = { kind, format, summary: built.summary, graphSha256: built.graphSha256 };
  const envelope = createEnvelope({ data, findings: [], meta: { command: "diagram", root } });
  const lines = [
    `Diagram (${kind}): ${built.summary.modules} modules · ${built.summary.dependencies} declared dependencies · ${built.summary.boundaries} boundaries`,
    `  primary edges: ${built.summary.depictedDependencies} drawn (Archify clean-flow backbone)`,
    `  phases:        ${built.summary.phases}`,
    `  verifications: ${built.summary.verifications} (${built.summary.testFiles} declared test files)`,
    `  verified:      ${built.summary.verifiedModules}/${built.summary.modules} modules`,
    `  lint:          ${built.summary.lintErrors} errors, ${built.summary.lintWarnings} warnings`,
    `  graph sha256:  ${built.graphSha256}`,
    "",
    "Use --format mermaid (dependency-free), --format html (Archify validate/deliver), or --format json for the IR.",
  ];
  return { envelope, print: () => lines.forEach((line) => console.log(line)) };
}

export const diagramCommand = defineCommand({
  meta: {
    name: "diagram",
    description:
      "Export the docs graph as deterministic Archify architecture IR: text summary, JSON IR, Mermaid flowchart, or standalone HTML rendered by the optional Archify CLI (ADR-9); --check guards committed IR",
  },
  args: {
    path: { type: "string", default: ".", description: "Project root" },
    kind: { type: "string", default: "architecture", description: "Diagram kind (v1.5.0: architecture)" },
    format: { type: "string", default: "text", description: "Output format: text, json, html or mermaid" },
    out: { type: "string", description: "HTML output path (project-relative; defaults to integrations.archify.outputDir/architecture.html)" },
    quality: { type: "string", default: "standard", description: "Archify quality profile: standard or showcase" },
    check: { type: "boolean", default: false, description: "Only verify that the committed IR matches the current docs graph" },
  },
  run: async ({ args }) => {
    const format = parseDiagramFormat(typeof args.format === "string" ? args.format : "text");
    const envelopeFormat = format === "json" ? "json" : "text";
    await runCommandOutcome<DiagramData>(envelopeFormat, { command: "diagram" }, () =>
      computeDiagram(typeof args.path === "string" ? args.path : ".", args as unknown as Record<string, unknown>)
    );
  },
});
// END_BLOCK_COMMAND

// Re-exported for callers that need the format parser without importing the command.
export { parseDiagramFormat };
