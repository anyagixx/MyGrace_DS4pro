#!/usr/bin/env bun
/**
 * MyGRACE — `mygrace packet` and `mygrace focus`.
 *
 * Both commands are read-only context builders for an agent working on one
 * module. They read exactly three things: the module contract file, the
 * verification file (the canonical home of `<module-checks>`) and the
 * dependency rows from `docs/graph-index.xml`.
 *
 * Hardening (ROADMAP ADR-4): the module id is untrusted input from the CLI/MCP,
 * so it is validated with `assertEntityId` and resolved with `entityPath`; a
 * value like `../../etc/passwd` is rejected with a usage error (exit 2) before
 * any filesystem access. Malformed XML surfaces as a typed finding, not a
 * stack trace.
 */

// START_MODULE_CONTRACT
//   PURPOSE: Build the self-contained per-module worker prompt (packet) and minimal working set (focus),
//            with validated ids, structural XML reads and JSON envelopes.
//   SCOPE: Read-only: docs/modules/M-X.xml, docs/verification/V-M-X.xml, docs/graph-index.xml.
//   DEPENDS: grace-errors, grace-xml, grace-paths, grace-config, grace-common, grace-test
//   LINKS: ROADMAP.md (ADR-3 exit codes, ADR-4 untrusted ids, ADR-8 JSON output)
// END_MODULE_CONTRACT

// START_MODULE_MAP
//   depTable()            — dependency rows from the graph index (validated module id)
//   loadModuleDocument()  — validated + structurally parsed module file
//   packetCommand         — `mygrace packet <id> [--format json]`
//   focusCommand          — `mygrace focus <id> [--format json]`
// END_MODULE_MAP

import { defineCommand } from "citty";
import { join } from "node:path";
import { findProjectRoot, readFileOrNull } from "./grace-common";
import { loadGraphIndexStrict } from "./grace-shard";
import { createEnvelope, UsageError } from "./grace-errors";
import { loadConfig } from "./grace-config";
import { assertEntityId, entityPath } from "./grace-paths";
import { findElements, parseXml, textOf } from "./grace-xml";
import type { XmlDocument } from "./grace-xml";
import {
  parseOutputFormat,
  resolveDeclaredCommand,
  runCommandOutcome,
  tokenizeCommand,
} from "./grace-test";
import type { CommandOutcome, DeclaredCheckCommand } from "./grace-test";

interface ModuleDocument {
  module: string;
  /** Project-relative module file path, e.g. `docs/modules/M-AUTH.xml`. */
  file: string;
  content: string;
  document: XmlDocument;
}

/** First text of the first element with `tag` (structural, no regex scraping). */
function firstText(document: XmlDocument, tag: string): string {
  const element = findElements(document, (candidate) => candidate.tag === tag)[0];
  return element === undefined ? "" : textOf(element);
}

function depsOf(document: XmlDocument): string[] {
  const depends = findElements(document, (candidate) => candidate.tag === "depends")[0];
  if (depends === undefined) return [];
  return textOf(depends)
    .split(/[,\s]+/)
    .map((value) => value.trim())
    .filter((value) => value !== "");
}

function statusOf(root: string, moduleId: string): string {
  return loadGraphIndexStrict(root).entries.find((entry) => entry.tag === moduleId)?.attrs.STATUS ?? "unknown";
}

/** Read + structurally parse the module contract file (id already validated). */
export function loadModuleDocument(root: string, moduleId: string): ModuleDocument {
  const module = assertEntityId("module", moduleId);
  const file = `docs/modules/${module}.xml`;
  const content = readFileOrNull(entityPath(root, "module", module));
  if (content === null) {
    throw new UsageError(`Module "${module}" not found (${file} is missing).`, {
      hint: "Run `mygrace module list` to see indexed modules and `mygrace lint` to find drift.",
      file,
    });
  }
  return { module, file, content, document: parseXml(content, file) };
}

/**
 * Dependency table rows: `- M-DEP — <path> (<STATUS>)` resolved from the graph
 * index. Returns `[]` for a module whose file is missing (v1-compatible).
 */
export function depTable(root: string, moduleId: string): string[] {
  const module = assertEntityId("module", moduleId);
  const content = readFileOrNull(entityPath(root, "module", module));
  if (content === null) return [];
  const document = parseXml(content, `docs/modules/${module}.xml`);
  const entries = loadGraphIndexStrict(root).entries;
  return depsOf(document).map((id) => {
    const entry = entries.find((candidate) => candidate.tag === id);
    const status = entry?.attrs.STATUS || "unknown";
    const path = entry?.attrs.PATH || "?";
    return `- ${id} — ${path} (${status})`;
  });
}

/** Brief dep lines for focus: "M-CONFIG (done)". */
function depBriefs(root: string, moduleId: string): string[] {
  return depTable(root, moduleId).map((line) => {
    const match = line.match(/^- ([\w-]+).*\(([^)]+)\)$/);
    return match ? `${match[1]} (${match[2]})` : line;
  });
}

function verificationInfo(root: string, moduleId: string): { file: string; content: string | null } {
  const file = `docs/verification/V-${moduleId}.xml`;
  const content = readFileOrNull(entityPath(root, "verification", `V-${moduleId}`));
  return { file, content };
}

/** Human-readable check source: verification file (canonical) vs module file (deprecated). */
function checkSourceLabel(source: DeclaredCheckCommand["source"]): string {
  switch (source) {
    case "verification":
      return "verification file";
    case "module":
      return "module file (deprecated; move <module-checks> to the verification file)";
    case "config":
      return "config testRunner (default)";
  }
}

/** Lines for the `Tests:` row of `focus`, showing argv shape without a shell. */
function testsLine(check: DeclaredCheckCommand): string {
  let argvShape = check.command;
  try {
    argvShape = tokenizeCommand(check.command).map((token) => (/^[A-Za-z0-9_./:=@+-]+$/.test(token) ? token : JSON.stringify(token))).join(" ");
  } catch {
    // keep the raw command; the actual run will report the malformed quoting
  }
  return `Tests: ${argvShape} [${checkSourceLabel(check.source)}]`;
}

export const packetCommand = defineCommand({
  meta: {
    name: "packet",
    description: "Generate a self-contained worker prompt for one module (contract + verification + deps); read-only, validated id",
  },
  args: {
    id: { type: "positional", description: "Module ID (e.g. M-AUTH)" },
    path: { type: "string", default: ".", description: "Project root" },
    format: { type: "string", default: "text", description: "Output format: text or json" },
  },
  run: async ({ args }) => {
    const format = parseOutputFormat(args.format);
    await runCommandOutcome<unknown>(format, { command: "packet" }, (): CommandOutcome<unknown> => {
      const root = findProjectRoot(args.path ?? ".");
      const moduleId = assertEntityId("module", args.id);
      const config = loadConfig(root).config;
      const module = loadModuleDocument(root, moduleId);
      const verification = verificationInfo(root, moduleId);
      const check = resolveDeclaredCommand(root, moduleId, config);
      const deps = depTable(root, moduleId);
      const status = statusOf(root, moduleId);

      const lines: string[] = [
        `=== PACKET ${moduleId} — ${status} ===`,
        "",
        `Status: ${status}`,
        "Scope: single module — read/write only this module + listed dependencies",
        "",
        `## Contract (${module.file})`,
        module.content,
        "",
        "## Verification (run now)",
      ];
      if (verification.content !== null) lines.push(verification.content);
      else lines.push(`(no ${verification.file})`);
      lines.push("", "## Check command (canonical: verification file)", `command: ${check.command}`, `source: ${checkSourceLabel(check.source)}`);
      lines.push("", "## Dependencies (read-only context)");
      if (deps.length > 0) lines.push(...deps);
      else lines.push("(none)");

      const envelope = createEnvelope({
        data: {
          module: moduleId,
          status,
          file: module.file,
          contract: module.content,
          purpose: firstText(module.document, "purpose"),
          path: firstText(module.document, "path"),
          deps,
          verification: { file: verification.file, content: verification.content },
          check: { command: check.command, source: check.source, file: check.file },
        },
        findings: [],
        meta: { command: "packet", root },
      });
      return { envelope, print: () => lines.forEach((line) => console.log(line)) };
    });
  },
});

export const focusCommand = defineCommand({
  meta: {
    name: "focus",
    description: "Print the minimal working set for one module (contract + deps + canonical test command); read-only, validated id",
  },
  args: {
    id: { type: "positional", description: "Module ID (e.g. M-AUTH)" },
    path: { type: "string", default: ".", description: "Project root" },
    format: { type: "string", default: "text", description: "Output format: text or json" },
  },
  run: async ({ args }) => {
    const format = parseOutputFormat(args.format);
    await runCommandOutcome<unknown>(format, { command: "focus" }, (): CommandOutcome<unknown> => {
      const root = findProjectRoot(args.path ?? ".");
      const moduleId = assertEntityId("module", args.id);
      const config = loadConfig(root).config;
      const module = loadModuleDocument(root, moduleId);
      const status = statusOf(root, moduleId);
      const purpose = firstText(module.document, "purpose");
      const path = firstText(module.document, "path");
      const deps = depBriefs(root, moduleId);
      const check = resolveDeclaredCommand(root, moduleId, config);

      const lines: string[] = [
        `=== FOCUS ${moduleId} — ${status} ===`,
        `Status: ${status}`,
        `Contract: ${[purpose, path].filter(Boolean).join(" — ")}`,
        `Deps: ${deps.length > 0 ? deps.join(", ") : "(none)"}`,
        testsLine(check),
      ];

      const envelope = createEnvelope({
        data: {
          module: moduleId,
          status,
          contract: { purpose, path },
          deps: [...deps],
          check: { command: check.command, source: check.source, file: check.file },
        },
        findings: [],
        meta: { command: "focus", root },
      });
      return { envelope, print: () => lines.forEach((line) => console.log(line)) };
    });
  },
});
