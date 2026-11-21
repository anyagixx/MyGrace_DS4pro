#!/usr/bin/env bun
/**
 * MyGRACE Context Measurement
 *
 * Measures context lines for common operations on a MyGRACE project and
 * compares them against a classic-GRACE equivalent (all entities merged
 * into monolithic knowledge-graph.xml / development-plan.xml /
 * verification-plan.xml files).
 *
 * Usage: bun run scripts/measure-context.ts --project examples/demo-store
 *
 * The methodology behind the numbers:
 * - Classic GRACE: every operation starts by reading the monolithic files.
 * - MyGRACE: operations read the lightweight index, then only the
 *   per-entity file(s) they need.
 */

import { readFileSync, existsSync, readdirSync, mkdtempSync, writeFileSync, rmSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

function linesOf(path: string): number {
  if (!existsSync(path)) return 0;
  return readFileSync(path, "utf-8").split("\n").length;
}

function linesOfDir(dir: string): number {
  if (!existsSync(dir)) return 0;
  return readdirSync(dir)
    .filter((f) => f.endsWith(".xml"))
    .reduce((sum, f) => sum + linesOf(join(dir, f)), 0);
}

function main() {
  const projectArg = process.argv.find((a) => a === "--project");
  const project = projectArg ? process.argv[process.argv.indexOf("--project") + 1] : "examples/demo-store";
  const root = resolve(project);

  const graphIndex = join(root, "docs", "graph-index.xml");
  const planIndex = join(root, "docs", "plan-index.xml");
  const verIndex = join(root, "docs", "verification-index.xml");
  const modulesDir = join(root, "docs", "modules");
  const plansDir = join(root, "docs", "plans");
  const verDir = join(root, "docs", "verification");

  if (!existsSync(graphIndex)) {
    console.error(`MyGRACE project not found at ${root} (docs/graph-index.xml missing)`);
    process.exit(1);
  }

  // ── Build classic-GRACE equivalents (everything merged, as classic does) ──
  const classic = mkdtempSync(join(tmpdir(), "mygrace-classic-"));
  try {
    const merge = (title: string, index: string, dir: string) => {
      const parts = [readFileSync(index, "utf-8").trimEnd()];
      if (existsSync(dir)) {
        for (const f of readdirSync(dir).filter((f) => f.endsWith(".xml"))) {
          parts.push(readFileSync(join(dir, f), "utf-8").trimEnd());
        }
      }
      writeFileSync(join(classic, title), parts.join("\n\n") + "\n");
    };
    merge("knowledge-graph.xml", graphIndex, modulesDir);
    merge("development-plan.xml", planIndex, plansDir);
    merge("verification-plan.xml", verIndex, verDir);

    const kg = linesOf(join(classic, "knowledge-graph.xml"));
    const dp = linesOf(join(classic, "development-plan.xml"));
    const vp = linesOf(join(classic, "verification-plan.xml"));

    // ── Per-entity sizes (MyGRACE) ──
    const gi = linesOf(graphIndex);
    const pi = linesOf(planIndex);
    const vi = linesOf(verIndex);

    const moduleFiles = readdirSync(modulesDir).filter((f) => f.endsWith(".xml")).sort();
    const phaseFiles = readdirSync(plansDir).filter((f) => f.endsWith(".xml")).sort();
    const sampleModule = moduleFiles[0] || "M-XXX.xml";
    const samplePhase = phaseFiles[0] || "Phase-1.xml";

    interface Row {
      operation: string;
      classic: number;
      mygrace: number;
    }

    const rows: Row[] = [
      { operation: "Status check (3 indexes)", classic: kg + dp + vp, mygrace: gi + pi + vi },
      { operation: `Single module work (${sampleModule})`, classic: kg, mygrace: gi + linesOf(join(modulesDir, sampleModule)) },
      { operation: `Phase execution (${samplePhase})`, classic: dp, mygrace: pi + linesOf(join(plansDir, samplePhase)) },
      { operation: "Full verification audit", classic: vp, mygrace: vi + linesOfDir(verDir) },
    ];

    const totalClassic = kg + dp + vp;
    const totalMygrace = gi + pi + vi + linesOfDir(modulesDir) + linesOfDir(plansDir) + linesOfDir(verDir);

    console.log(`MyGRACE context measurement — ${root}`);
    console.log(`Modules: ${moduleFiles.length}, phases: ${phaseFiles.length}`);
    console.log();
    console.log(
      "Operation".padEnd(34) + "Classic GRACE".padStart(14) + "MyGRACE".padStart(9) + "Savings".padStart(9)
    );
    console.log("-".repeat(66));
    for (const r of rows) {
      const savings = Math.round((1 - r.mygrace / r.classic) * 100);
      console.log(
        r.operation.padEnd(34) + `${r.classic}`.padStart(14) + `${r.mygrace}`.padStart(9) + `${savings}%`.padStart(9)
      );
    }
    console.log("-".repeat(66));
    console.log(
      "All artifacts at once".padEnd(34) + `${totalClassic}`.padStart(14) + `${totalMygrace}`.padStart(9) +
        `${Math.round((1 - totalMygrace / totalClassic) * 100)}%`.padStart(9)
    );
    console.log();
    console.log("Methodology: classic reads full monolithic files per operation;");
    console.log("MyGRACE reads the index, then only the per-entity file it needs.");
    console.log("Classic equivalents were synthesized by merging index + per-entity files.");
  } finally {
    rmSync(classic, { recursive: true, force: true });
  }
}

main();
