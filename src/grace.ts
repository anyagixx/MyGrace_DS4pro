#!/usr/bin/env bun
/**
 * MyGRACE CLI — entry point (`mygrace`).
 *
 * All commands are wrapped with the shared error boundary so a typed
 * `MyGraceError` becomes one readable line plus the documented exit code
 * (ROADMAP ADR-3) instead of a stack trace.
 *
 * Command surface (v2.0, see `mygrace <cmd> --help`):
 *   ci, lint, status, verify, trust, inspect {module,phase,verification,file},
 *   context {packet,focus,cost}, setup {init,install,doctor},
 *   trace, impact, next, projects, integrations, diagram, capsule
 */

// START_MODULE_CONTRACT
//   PURPOSE: Compose the `mygrace` command tree and report failures through the ADR-3 error boundary.
//   SCOPE: Entry point only — imports command modules, wraps every command with the shared error guard,
//          and runs citty when executed directly (never on import, so scripts/tests can load the tree).
//   DEPENDS: grace-errors, grace-lint, grace-module, grace-file, grace-install, grace-init, grace-status,
//            grace-doctor, grace-test, grace-verify, grace-packet, grace-context, citty
//   LINKS: docs/modules/M-CLI.xml
// END_MODULE_CONTRACT

// START_MODULE_MAP
//   main               — the root CommandDef (exported for validators/tests/MCP parity checks)
//   guard()            — recursive error boundary around every command and subcommand
//   isDirectInvocation() — true only when this file is the process entry point
// END_MODULE_MAP

// START_CHANGE_SUMMARY
//   2026-11-22 — v2: typed-error guard on the whole tree, import-safe entry point, module contract.
// END_CHANGE_SUMMARY

import { defineCommand, runMain, type ArgsDef, type CommandContext, type CommandDef, type SubCommandsDef } from "citty";
import pkg from "../package.json" with { type: "json" };
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { handleCliError } from "./grace-errors";
import { ciCommand } from "./grace-ci";
import { traceCommand } from "./grace-trace";
import { impactCommand } from "./grace-impact";
import { nextCommand } from "./grace-next";
import { projectsCommand } from "./grace-projects";
import { integrationsCommand } from "./grace-integrations";
import { diagramCommand } from "./grace-diagram";
import { capsuleCommand } from "./grace-capsule";
import { lintCommand } from "./grace-lint";
import { moduleCommand, phaseCommand, verificationCommand } from "./grace-module";
import { fileCommand } from "./grace-file";
import { installDshCommand } from "./grace-install";
import { initDshCommand } from "./grace-init";
import { statusCommand } from "./grace-status";
import { doctorCommand } from "./grace-doctor";
import { trustCommand } from "./grace-test";
import { packetCommand, focusCommand } from "./grace-packet";
import { contextCostCommand } from "./grace-context";
import { guidanceCommand } from "./grace-guidance";
import { verifyCommand } from "./grace-verify";

/**
 * Wrap a command (and every nested subcommand) so thrown errors are reported
 * through the shared contract. Commands that already handle their own errors
 * are unaffected — only uncaught throws are intercepted.
 */
function guard<A extends ArgsDef>(command: CommandDef<A>): CommandDef<A> {
  const wrapped: CommandDef<A> = { ...command };

  const originalRun = command.run;
  if (typeof originalRun === "function") {
    wrapped.run = async (context: CommandContext<A>): Promise<void> => {
      try {
        await originalRun(context);
      } catch (error) {
        process.exit(handleCliError(error));
      }
    };
  }

  const rawSubCommands = command.subCommands;
  if (rawSubCommands !== undefined && typeof rawSubCommands === "object" && !(rawSubCommands instanceof Promise)) {
    const guarded: SubCommandsDef = {};
    for (const [name, subCommand] of Object.entries(rawSubCommands as SubCommandsDef)) {
      // Lazy subcommand resolvers are left untouched: wrapping them would force
      // eager evaluation, and MyGRACE commands are always plain definitions.
      guarded[name] =
        typeof subCommand === "function" || subCommand instanceof Promise
          ? subCommand
          : guard(subCommand as CommandDef<ArgsDef>);
    }
    wrapped.subCommands = guarded;
  }

  return wrapped;
}

/** `mygrace inspect` — lazy index/entity readers (module, phase, verification, file). */
const inspectCommand = defineCommand({
  meta: { name: "inspect", description: "Index and entity readers: module, phase, verification, file" },
  subCommands: {
    module: moduleCommand,
    phase: phaseCommand,
    verification: verificationCommand,
    file: fileCommand,
  },
});

/** `mygrace context` — worker-context commands (packet, focus, cost, guidance). */
const contextCommand = defineCommand({
  meta: { name: "context", description: "Worker context: packet, focus, cost, guidance" },
  subCommands: {
    packet: packetCommand,
    focus: focusCommand,
    cost: contextCostCommand,
    guidance: guidanceCommand,
  },
});

/** `mygrace setup` — bootstrap/install/diagnostics for DSH environments. */
const setupCommand = defineCommand({
  meta: { name: "setup", description: "Setup: init (scaffold), install (DSH), doctor (diagnostics)" },
  subCommands: {
    init: initDshCommand,
    install: installDshCommand,
    doctor: doctorCommand,
  },
});

export const main = defineCommand({
  meta: {
    name: "mygrace",
    version: pkg.version,
    description: "MyGRACE — index-first engineering harness for AI coding agents",
  },
  subCommands: {
    ci: guard(ciCommand),
    lint: guard(lintCommand),
    status: guard(statusCommand),
    verify: guard(verifyCommand),
    trust: guard(trustCommand),
    inspect: guard(inspectCommand),
    context: guard(contextCommand),
    setup: guard(setupCommand),
    trace: guard(traceCommand),
    impact: guard(impactCommand),
    next: guard(nextCommand),
    projects: guard(projectsCommand),
    integrations: guard(integrationsCommand),
    diagram: guard(diagramCommand),
    capsule: guard(capsuleCommand),
  },
});

/**
 * Run the CLI only when this module is the process entry point. Importing
 * `src/grace.ts` (scripts, validators, tests) must not execute a command.
 */
function isDirectInvocation(): boolean {
  const meta = import.meta as ImportMeta & { main?: boolean };
  if (typeof meta.main === "boolean") return meta.main;
  const entry = process.argv[1];
  if (entry === undefined) return false;
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isDirectInvocation()) runMain(main);
