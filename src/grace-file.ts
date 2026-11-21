#!/usr/bin/env bun
/**
 * MyGRACE File Command
 * Show file-local MODULE_CONTRACT, MODULE_MAP, CHANGE_SUMMARY, contracts, and blocks.
 */

import { defineCommand } from "citty";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

export const fileCommand = defineCommand({
  meta: { name: "file", description: "File-local markup operations" },
  subCommands: {
    show: defineCommand({
      meta: { name: "show", description: "Show file-local markup" },
      args: {
        path: { type: "positional", description: "File path to inspect" },
        root: { type: "string", default: ".", description: "Base directory for the path (absolute paths win)" },
        contracts: { type: "boolean", default: false, description: "Include function/type contracts" },
        blocks: { type: "boolean", default: false, description: "Include semantic block info" },
      },
      run: async ({ args }) => {
        const filePath = resolve(args.root, args.path);
        if (!existsSync(filePath)) {
          console.error(`File not found: ${filePath}`);
          process.exit(1);
        }
        const content = readFileSync(filePath, "utf-8");

        // Canonical: START_MODULE_CONTRACT / END_MODULE_CONTRACT
        // Legacy (accepted for backwards compatibility): === MODULE_CONTRACT === / === END_MODULE_CONTRACT ===
        const c = `(?:START_MODULE_CONTRACT|===\\s*MODULE_CONTRACT\\s*===)`;
        const ce = `(?:END_MODULE_CONTRACT|===\\s*END_MODULE_CONTRACT\\s*===)`;

        // Extract MODULE_CONTRACT
        const contractMatch = content.match(new RegExp(`(\\/\\/|#|--)\\s*${c}[\\s\\S]*?(\\/\\/|#|--)\\s*${ce}`));
        if (contractMatch) {
          console.log("=== MODULE_CONTRACT ===\n");
          console.log(contractMatch[0]);
          console.log();
        }

        // Extract MODULE_MAP
        const mapMatch = content.match(/(\/\/|#|--)\s*START_MODULE_MAP[\s\S]*?(\/\/|#|--)\s*END_MODULE_MAP/);
        if (mapMatch) {
          console.log("=== MODULE_MAP ===\n");
          console.log(mapMatch[0]);
          console.log();
        }

        // Extract CHANGE_SUMMARY
        const changeMatch = content.match(/(\/\/|#|--)\s*START_CHANGE_SUMMARY[\s\S]*?(\/\/|#|--)\s*END_CHANGE_SUMMARY/);
        if (changeMatch) {
          console.log("=== CHANGE_SUMMARY ===\n");
          console.log(changeMatch[0]);
          console.log();
        }

        if (args.contracts) {
          const contracts = content.match(/(\/\/|#|--)\s*START_CONTRACT:\s*(\w+)[\s\S]*?(\/\/|#|--)\s*END_CONTRACT:\s*\2/g);
          if (contracts?.length) {
            console.log(`=== CONTRACTS (${contracts.length}) ===\n`);
            contracts.forEach((c) => console.log(c + "\n"));
          }
        }

        if (args.blocks) {
          const starts = (content.match(/START_BLOCK_\w+/g) || []).length;
          const ends = (content.match(/END_BLOCK_\w+/g) || []).length;
          console.log(`=== SEMANTIC BLOCKS ===\n`);
          console.log(`START blocks: ${starts}`);
          console.log(`END blocks:   ${ends}`);
          console.log(`Status: ${starts === ends ? "✓ Paired" : "✗ UNPAIRDED — integrity violation"}`);

          if (starts !== ends) {
            const startNames = content.match(/START_BLOCK_(\w+)/g) || [];
            const endNames = content.match(/END_BLOCK_(\w+)/g) || [];
            const startSet = new Set(startNames.map((s) => s.replace("START_BLOCK_", "")));
            const endSet = new Set(endNames.map((s) => s.replace("END_BLOCK_", "")));
            const missing = [...startSet].filter((n) => !endSet.has(n));
            const extra = [...endSet].filter((n) => !startSet.has(n));
            if (missing.length) console.log(`Missing END blocks: ${missing.join(", ")}`);
            if (extra.length) console.log(`Missing START blocks: ${extra.join(", ")}`);
          }
        }
      },
    }),
  },
});
