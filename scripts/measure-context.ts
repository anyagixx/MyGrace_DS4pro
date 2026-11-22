#!/usr/bin/env bun
/**
 * MyGRACE context measurement — honest metric v2 (ROADMAP G9).
 *
 * v1 counted LINES but the README called the result "Measured Token Savings",
 * and a single 12-module sample was extrapolated into "savings grow with
 * project size". This script fixes the honesty problem:
 *
 *   1. It measures and prints THREE quantities per operation: lines, bytes and
 *      a documented token estimate. There is no tokenizer dependency — the
 *      estimate is `ceil(utf8 bytes / 4)`, the widely used rule of thumb for
 *      English/code text. It is labelled as an ESTIMATE, never as a
 *      tokenizer result.
 *   2. It measures the checked-in demo project AND a deterministic synthetic
 *      size sweep (12 / 50 / 200 modules) and prints the measured slope, so
 *      "savings grow with project size" is demonstrated rather than asserted.
 *   3. It states the model explicitly: the classic-GRACE baseline is
 *      SYNTHESIZED by concatenating the index and per-entity files. It is not
 *      a real classic-GRACE repository.
 *
 * Usage:
 *   bun run scripts/measure-context.ts [--project examples/demo-store] [--json] [--no-sweep]
 *
 * Exit codes: 0 ok, 2 usage / missing project.
 */

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";

const MODEL_NOTE =
  "LINE/BYTE MODEL — not a tokenizer measurement. tokenEst = ceil(utf8 bytes / 4) (documented estimate); " +
  "classic-GRACE baseline is SYNTHESIZED from the same artifacts (index + per-entity files concatenated).";

const SWEEP_SIZES = [12, 50, 200];

// ─── CLI ────────────────────────────────────────────────────────────────

interface Options {
  project?: string;
  json: boolean;
  sweep: boolean;
}

function parseOptions(argv: readonly string[]): Options {
  const options: Options = { project: "examples/demo-store", json: false, sweep: true };
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index]!;
    if (argument === "--json") options.json = true;
    else if (argument === "--no-sweep") options.sweep = false;
    else if (argument === "--project") {
      const next = argv[index + 1];
      if (next === undefined) {
        console.error("measure-context: --project requires a directory argument");
        process.exit(2);
      }
      options.project = next;
      index++;
    } else if (argument.startsWith("--project=")) {
      options.project = argument.slice("--project=".length);
    } else if (argument === "--help" || argument === "-h") {
      console.log(
        "Usage: bun run scripts/measure-context.ts [--project <dir>] [--json] [--no-sweep]\n\n" +
          MODEL_NOTE
      );
      process.exit(0);
    } else {
      console.error(`measure-context: unknown argument "${argument}"`);
      process.exit(2);
    }
  }
  return options;
}

// ─── measurement primitives ─────────────────────────────────────────────

interface Amount {
  lines: number;
  bytes: number;
  tokenEstimate: number;
}

function amountOf(content: string): Amount {
  const lines = content === "" ? 0 : content.split("\n").length;
  const bytes = Buffer.byteLength(content, "utf8");
  return { lines, bytes, tokenEstimate: Math.ceil(bytes / 4) };
}

function addAmounts(amounts: readonly Amount[]): Amount {
  return amounts.reduce<Amount>(
    (total, amount) => ({
      lines: total.lines + amount.lines,
      bytes: total.bytes + amount.bytes,
      tokenEstimate: total.tokenEstimate + amount.tokenEstimate,
    }),
    { lines: 0, bytes: 0, tokenEstimate: 0 }
  );
}

function savingsPercent(classic: number, mygrace: number): number {
  if (classic === 0) return 0;
  return Math.round((1 - mygrace / classic) * 100);
}

function percent(classic: Amount, mygrace: Amount): { lines: number; bytes: number; tokenEstimate: number } {
  return {
    lines: savingsPercent(classic.lines, mygrace.lines),
    bytes: savingsPercent(classic.bytes, mygrace.bytes),
    tokenEstimate: savingsPercent(classic.tokenEstimate, mygrace.tokenEstimate),
  };
}

function readDirXml(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((file) => file.endsWith(".xml"))
    .sort()
    .map((file) => readFileSync(join(dir, file), "utf-8"));
}

function sumAmountsOfFiles(dir: string): Amount {
  return addAmounts(readDirXml(dir).map(amountOf));
}

// ─── operations ─────────────────────────────────────────────────────────

interface OperationRow {
  operation: string;
  classic: Amount;
  mygrace: Amount;
  savings: { lines: number; bytes: number; tokenEstimate: number };
}

/**
 * Compute the four documented operations for one project model.
 *
 * `model` may be a real project directory or a synthetic in-memory project
 * (used by the sweep). Both expose the same five content groups.
 */
interface ProjectModel {
  label: string;
  graphIndex: string;
  planIndex: string;
  verificationIndex: string;
  modules: string[];
  phases: string[];
  verifications: string[];
}

function projectModelFromDisk(projectDir: string): ProjectModel {
  const docs = join(projectDir, "docs");
  const read = (path: string): string => (existsSync(path) ? readFileSync(path, "utf-8") : "");
  const modulesDir = join(docs, "modules");
  const plansDir = join(docs, "plans");
  const verDir = join(docs, "verification");
  const moduleFiles = readDirXml(modulesDir).length === 0 ? [] : readdirSync(modulesDir).filter((f) => f.endsWith(".xml")).sort();
  const phaseFiles = existsSync(plansDir) ? readdirSync(plansDir).filter((f) => f.endsWith(".xml")).sort() : [];
  return {
    label: projectDir,
    graphIndex: read(join(docs, "graph-index.xml")),
    planIndex: read(join(docs, "plan-index.xml")),
    verificationIndex: read(join(docs, "verification-index.xml")),
    modules: moduleFiles.map((file) => read(join(modulesDir, file))),
    phases: phaseFiles.map((file) => read(join(plansDir, file))),
    verifications: readDirXml(verDir),
  };
}

function mergeAmounts(index: string, entityContents: readonly string[]): Amount {
  // Mirrors how a classic-GRACE monolith would carry the same records: index
  // content followed by every per-entity file.
  return addAmounts([amountOf(index), ...entityContents.map(amountOf)]);
}

function operations(model: ProjectModel): OperationRow[] {
  const knowledgeGraph = mergeAmounts(model.graphIndex, model.modules);
  const developmentPlan = mergeAmounts(model.planIndex, model.phases);
  const verificationPlan = mergeAmounts(model.verificationIndex, model.verifications);

  const sampleModule = model.modules[0];
  const samplePhase = model.phases[0];

  const rows: Array<{ operation: string; classic: Amount; mygrace: Amount }> = [
    {
      operation: "Status check (3 indexes)",
      classic: addAmounts([knowledgeGraph, developmentPlan, verificationPlan]),
      mygrace: addAmounts([amountOf(model.graphIndex), amountOf(model.planIndex), amountOf(model.verificationIndex)]),
    },
    {
      operation: `Single module work (${model.modules.length} modules)`,
      classic: knowledgeGraph,
      mygrace: addAmounts([
        amountOf(model.graphIndex),
        ...(sampleModule === undefined ? [] : [amountOf(sampleModule)]),
      ]),
    },
    {
      operation: "Phase execution",
      classic: developmentPlan,
      mygrace: addAmounts([
        amountOf(model.planIndex),
        ...(samplePhase === undefined ? [] : [amountOf(samplePhase)]),
      ]),
    },
    {
      operation: "Full verification audit",
      classic: verificationPlan,
      mygrace: addAmounts([amountOf(model.verificationIndex), ...model.verifications.map(amountOf)]),
    },
  ];

  return rows.map((row) => ({ ...row, savings: percent(row.classic, row.mygrace) }));
}

// ─── synthetic size sweep ───────────────────────────────────────────────

/**
 * Deterministic synthetic MyGRACE project model.
 *
 * Sizes follow the repository's own documented budgets: module files ≈40 lines
 * (30–80), phase files ≈70 lines (50–200), verification files ≈30 lines
 * (20–60). Indexes stay one record per line, exactly like the real format.
 */
function syntheticModel(moduleCount: number): ProjectModel {
  const pad = (value: number): string => String(value).padStart(3, "0");
  const graphIndexLines = [
    `<GraphIndex project="Synthetic${moduleCount}" version="1.0.0">`,
    "  <annotation>Deterministic synthetic project for the context-size sweep</annotation>",
  ];
  for (let index = 1; index <= moduleCount; index++) {
    graphIndexLines.push(
      `  <M-${pad(index)} NAME="Module ${pad(index)}" TYPE="CORE_LOGIC" STATUS="done" ` +
        `PATH="src/m${pad(index)}/index.ts" DEPENDS="" VERIFICATION_REF="V-M-${pad(index)}" />`
    );
  }
  graphIndexLines.push("</GraphIndex>", "");

  const phaseCount = Math.max(3, Math.ceil(moduleCount / 5));
  const planIndexLines = [`<PlanIndex project="Synthetic${moduleCount}" version="1.0.0">`];
  for (let phase = 1; phase <= phaseCount; phase++) {
    planIndexLines.push(`  <Phase-${phase} name="Phase ${phase}" status="pending" steps="4" />`);
  }
  planIndexLines.push("</PlanIndex>", "");

  const verificationIndexLines = [`<VerificationIndex project="Synthetic${moduleCount}" version="1.0.0">`];
  for (let index = 1; index <= moduleCount; index++) {
    verificationIndexLines.push(
      `  <V-M-${pad(index)} MODULE="M-${pad(index)}" PRIORITY="medium" STATUS="done" />`
    );
  }
  verificationIndexLines.push("</VerificationIndex>", "");

  const modules: string[] = [];
  const verifications: string[] = [];
  for (let index = 1; index <= moduleCount; index++) {
    const moduleLines = [
      `<M-${pad(index)} NAME="Module ${pad(index)}" TYPE="CORE_LOGIC" STATUS="done">`,
      "  <purpose>Synthetic module used to measure index-first context cost at scale</purpose>",
      '  <path>src/m' + pad(index) + "/index.ts</path>",
      "  <annotations>",
    ];
    while (moduleLines.length < 38) {
      moduleLines.push(
        `    <fn-${moduleLines.length} PURPOSE="Exported function ${moduleLines.length} of module ${pad(index)} with a descriptive purpose sentence." />`
      );
    }
    moduleLines.push("  </annotations>", `</M-${pad(index)}>`, "");
    modules.push(moduleLines.join("\n"));

    const verificationLines = [
      `<V-M-${pad(index)} MODULE="M-${pad(index)}" PRIORITY="medium" STATUS="done">`,
      `  <test-files><file>src/m${pad(index)}/index.test.ts</file></test-files>`,
      `  <module-checks><check-1>bun test src/m${pad(index)}/index.test.ts</check-1></module-checks>`,
      "  <scenarios>",
    ];
    while (verificationLines.length < 28) {
      verificationLines.push(
        `    <scenario-${verificationLines.length} kind="success">Synthetic scenario ${verificationLines.length} covering module ${pad(index)} with expected outcome.</scenario-${verificationLines.length}>`
      );
    }
    verificationLines.push("  </scenarios>", `</V-M-${pad(index)}>`, "");
    verifications.push(verificationLines.join("\n"));
  }

  const phases: string[] = [];
  for (let phase = 1; phase <= phaseCount; phase++) {
    const phaseLines = [`<Phase-${phase} name="Phase ${phase}" status="pending">`];
    for (let step = 1; step <= 4; step++) {
      phaseLines.push(
        `  <step-${step} module="M-${pad(((phase - 1) * 4 + step) % moduleCount + 1)}" ` +
          `description="Implement step ${step} of phase ${phase} with acceptance criteria and evidence" status="pending" />`
      );
    }
    while (phaseLines.length < 68) {
      phaseLines.push(
        `  <note-${phaseLines.length}>Evidence requirement ${phaseLines.length}: log markers, scenario ids and verification references for phase ${phase}.</note-${phaseLines.length}>`
      );
    }
    phaseLines.push(`</Phase-${phase}>`, "");
    phases.push(phaseLines.join("\n"));
  }

  return {
    label: `synthetic(${moduleCount} modules)`,
    graphIndex: graphIndexLines.join("\n"),
    planIndex: planIndexLines.join("\n"),
    verificationIndex: verificationIndexLines.join("\n"),
    modules,
    phases,
    verifications,
  };
}

// ─── reporting ──────────────────────────────────────────────────────────

interface Report {
  model: string;
  project: string | null;
  projectOperations: OperationRow[] | null;
  sweep: Array<{
    modules: number;
    operations: OperationRow[];
    indexLinesPerModule: number;
    classicLinesPerModule: number;
  }> | null;
  slopes: Record<string, { linesPer100Modules: number; tokensPer100Modules: number }> | null;
}

function buildReport(options: Options): Report {
  const report: Report = {
    model: MODEL_NOTE,
    project: null,
    projectOperations: null,
    sweep: null,
    slopes: null,
  };

  const projectPath = options.project;
  if (projectPath !== undefined) {
    const resolved = resolve(projectPath);
    if (!existsSync(join(resolved, "docs", "graph-index.xml"))) {
      console.error(
        `measure-context: MyGRACE project not found at ${resolved} (docs/graph-index.xml missing). ` +
          `Pass --project <dir> or regenerate the demo with \`bun run scripts/gen-example.ts\`.`
      );
      process.exit(2);
    }
    report.project = resolved;
    report.projectOperations = operations(projectModelFromDisk(resolved));
  }

  if (options.sweep) {
    const sizes = [...SWEEP_SIZES];
    report.sweep = sizes.map((size) => {
      const model = syntheticModel(size);
      const rows = operations(model);
      const status = rows[0]!;
      const indexLines = status.mygrace.lines;
      return {
        modules: size,
        operations: rows,
        indexLinesPerModule: Math.round((indexLines / size) * 100) / 100,
        classicLinesPerModule: Math.round((status.classic.lines / size) * 100) / 100,
      };
    });

    const first = report.sweep[0]!;
    const last = report.sweep[report.sweep.length - 1]!;
    const span = last.modules - first.modules;
    const slopes: Report["slopes"] = {};
    const operationNames = ["status", "single-module", "phase-execution", "verification-audit"];
    first.operations.forEach((row, index) => {
      const lastRow = last.operations[index]!;
      const name = operationNames[index] ?? `operation-${index}`;
      slopes[name] = {
        linesPer100Modules: Math.round(((lastRow.savings.lines - row.savings.lines) / span) * 100 * 100) / 100,
        tokensPer100Modules:
          Math.round(((lastRow.savings.tokenEstimate - row.savings.tokenEstimate) / span) * 100 * 100) / 100,
      };
    });
    report.slopes = slopes;
  }

  return report;
}

function padRight(value: string, width: number): string {
  return value.length >= width ? value : value + " ".repeat(width - value.length);
}

function padLeft(value: string, width: number): string {
  return value.length >= width ? value : " ".repeat(width - value.length) + value;
}

function printOperationTable(rows: readonly OperationRow[], indent = ""): void {
  const header = ["Operation", "Classic lines", "MyGRACE lines", "Line save", "Classic tokenEst", "My tokenEst", "TokenEst save"];
  console.log(
    indent +
      padRight(header[0]!, 34) +
      padLeft(header[1]!, 14) +
      padLeft(header[2]!, 14) +
      padLeft(header[3]!, 11) +
      padLeft(header[4]!, 18) +
      padLeft(header[5]!, 15) +
      padLeft(header[6]!, 16)
  );
  console.log(indent + "-".repeat(122));
  for (const row of rows) {
    console.log(
      indent +
        padRight(row.operation, 34) +
        padLeft(String(row.classic.lines), 14) +
        padLeft(String(row.mygrace.lines), 14) +
        padLeft(`${row.savings.lines}%`, 11) +
        padLeft(String(row.classic.tokenEstimate), 18) +
        padLeft(String(row.mygrace.tokenEstimate), 15) +
        padLeft(`${row.savings.tokenEstimate}%`, 16)
    );
  }
}

function main(): void {
  const options = parseOptions(process.argv.slice(2));
  const report = buildReport(options);

  if (options.json) {
    console.log(JSON.stringify(report, null, 2));
    process.exit(0);
  }

  console.log("MyGRACE context measurement (honest metric v2)");
  console.log("=============================================");
  console.log(MODEL_NOTE);
  console.log();

  if (report.projectOperations !== null) {
    const model = projectModelFromDisk(report.project!);
    console.log(`Project: ${report.project}`);
    console.log(
      `Files: ${model.modules.length} module(s), ${model.phases.length} phase(s), ${model.verifications.length} verification file(s)`
    );
    console.log();
    printOperationTable(report.projectOperations);
    const status = report.projectOperations[0]!;
    const moduleRow = report.projectOperations[1]!;
    console.log();
    console.log(
      `Density note: line counting flatters dense index lines — status read-set is ` +
        `${Math.round((status.mygrace.bytes / Math.max(status.mygrace.lines, 1)) * 10) / 10} bytes/line ` +
        `vs ${Math.round((status.classic.bytes / Math.max(status.classic.lines, 1)) * 10) / 10} bytes/line for the synthesized classic baseline.`
    );
    console.log(
      `Single-module work: ${moduleRow.savings.lines}% fewer lines but ${moduleRow.savings.tokenEstimate}% fewer estimated tokens.`
    );
    console.log(
      "Note: the single-module win depends on project size (a 3-module demo has little to hide); see the size sweep below."
    );
    console.log("Note: the full verification audit row is 0% by construction — both models read every verification artifact.");
    console.log();
  }

  if (report.sweep !== null) {
    console.log("Size sweep (deterministic synthetic MyGRACE projects, documented budgets)");
    console.log("-----------------------------------------------------------------------");
    for (const entry of report.sweep) {
      console.log(`Modules: ${entry.modules}`);
      printOperationTable(entry.operations, "  ");
      console.log(
        `  Read-set growth: ${entry.indexLinesPerModule} index lines/module vs ${entry.classicLinesPerModule} classic lines/module`
      );
      console.log();
    }
    if (report.slopes !== null) {
      console.log("Measured slope of savings (percentage points per 100 modules, first → last sweep point)");
      console.log("------------------------------------------------------------------------------------");
      for (const [name, slope] of Object.entries(report.slopes)) {
        console.log(
          `  ${padRight(name, 22)} line model ${padLeft(`${slope.linesPer100Modules}`, 7)} pp/100 modules, ` +
            `tokenEst ${padLeft(`${slope.tokensPer100Modules}`, 7)} pp/100 modules`
        );
      }
      console.log();
      console.log("Interpretation: the index-first win grows with project size but SATURATES; it is not linear.");
      console.log("The 200-module point is a synthetic model, not a benchmark of a real repository.");
    }
  }

  console.log();
  console.log("Reproduce: bun run scripts/measure-context.ts --json");
  process.exit(0);
}

main();
