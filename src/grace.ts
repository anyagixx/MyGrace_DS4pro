#!/usr/bin/env bun
/**
 * MyGRACE CLI Entry Point
 * Command: mygrace
 *
 * Subcommands:
 *   mygrace lint                      — integrity check including index sync
 *   mygrace module index              — show graph-index.xml
 *   mygrace module find <query>       — resolve module IDs
 *   mygrace module show <id>          — show per-module file
 *   mygrace module list [--status=X]  — list modules with filter
 *   mygrace phase index               — show plan-index.xml
 *   mygrace phase show <name>         — show per-phase file
 *   mygrace verification index        — show verification-index.xml
 *   mygrace file show <path>          — file-local markup
 */

import { defineCommand, runMain } from "citty";
import { version } from "../package.json";
import { lintCommand } from "./grace-lint";
import { moduleCommand, phaseCommand, verificationCommand } from "./grace-module";
import { fileCommand } from "./grace-file";
import { installDshCommand } from "./grace-install";
import { initDshCommand } from "./grace-init";

const main = defineCommand({
  meta: { name: "mygrace", version, description: "MyGRACE CLI — scalable GRACE with lazy-loading indexes" },
  subCommands: {
    lint: lintCommand,
    module: moduleCommand,
    phase: phaseCommand,
    verification: verificationCommand,
    file: fileCommand,
    "install-dsh": installDshCommand,
    "init-dsh": initDshCommand,
  },
});

runMain(main);
