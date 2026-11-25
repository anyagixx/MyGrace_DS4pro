#!/usr/bin/env bun
/**
 * MyGRACE File Command
 *
 * Shows file-local semantic markup: MODULE_CONTRACT, MODULE_MAP,
 * CHANGE_SUMMARY, function contracts and semantic blocks.
 *
 * Text markup is analyzed by the same `analyzeMarkup` implementation lint
 * uses (`src/grace-lint.ts`), so `file show --blocks` and `mygrace lint`
 * cannot disagree about pairing or contracts.
 */

// START_MODULE_CONTRACT
//   PURPOSE: Show file-local semantic markup (contract, map, change summary, contracts, block integrity) for one source file.
//   SCOPE: Reads one source file; text output only; no writes.
//   DEPENDS: grace-lint (markup analysis), grace-common, grace-errors
//   LINKS: ROADMAP.md (G3); src/grace-lint.ts
// END_MODULE_CONTRACT

// START_MODULE_MAP
//   fileCommand     — citty command group
//   fileShowCmd     — `file show <path> [--root] [--contracts] [--blocks]`
// END_MODULE_MAP

import { defineCommand } from "citty";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { readTextFileOrThrow } from "./grace-common";
import { UsageError } from "./grace-errors";
import { analyzeMarkup } from "./grace-lint";

export const fileShowCmd = defineCommand({
  meta: { name: "show", description: "Show file-local markup" },
  args: {
    path: { type: "positional", description: "File path to inspect" },
    root: { type: "string", default: ".", description: "Base directory for the path (absolute paths win)" },
    contracts: { type: "boolean", default: false, description: "Include function/type contracts" },
    blocks: { type: "boolean", default: false, description: "Include semantic block info" },
  },
  run: async ({ args }) => {
    if (typeof args.path !== "string" || args.path.trim() === "") {
      throw new UsageError("Missing file path to inspect.", {
        hint: "Usage: mygrace inspect file show <path> [--root <project-root>]",
      });
    }
    const root = typeof args.root === "string" && args.root !== "" ? args.root : ".";
    const filePath = resolve(root, args.path);
    if (!existsSync(filePath)) {
      console.error(`File not found: ${filePath}`);
      process.exit(1);
    }
    const content = readTextFileOrThrow(filePath, "source file");
    const analysis = analyzeMarkup(content);

    if (analysis.contract !== undefined) {
      console.log("=== MODULE_CONTRACT ===\n");
      console.log(analysis.contract.raw);
      console.log();
    }

    if (analysis.moduleMap !== undefined) {
      console.log("=== MODULE_MAP ===\n");
      console.log(analysis.moduleMap);
      console.log();
    }

    if (analysis.changeSummary !== undefined) {
      console.log("=== CHANGE_SUMMARY ===\n");
      console.log(analysis.changeSummary);
      console.log();
    }

    if (args.contracts === true && analysis.functionContracts.length > 0) {
      console.log(`=== CONTRACTS (${analysis.functionContracts.length}) ===\n`);
      for (const contract of analysis.functionContracts) console.log(`${contract}\n`);
    }

    if (args.blocks === true) {
      console.log("=== SEMANTIC BLOCKS ===\n");
      console.log(`START blocks: ${analysis.blockStarts}`);
      console.log(`END blocks:   ${analysis.blockEnds}`);
      console.log(`Status: ${analysis.blockIssues.length === 0 ? "✓ Paired" : "✗ UNPAIRED — integrity violation"}`);
      for (const issue of analysis.blockIssues) {
        console.log(`${issue.message} (${issue.code})`);
      }
    }
  },
});

export const fileCommand = defineCommand({
  meta: { name: "file", description: "File-local markup operations" },
  subCommands: {
    show: fileShowCmd,
  },
});
