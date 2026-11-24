#!/usr/bin/env bun
/**
 * MyGRACE MCP Tool → CLI Command Mapping
 *
 * Framework-free core of the MCP server. One catalog table (`TOOLS`) describes
 * every tool — name, agent-facing description, JSON input schema, argv builder
 * and an optional success digest. The same table drives `tools/list`, argument
 * validation and `TOOL_NAMES`, so the three can no longer drift apart (audit
 * M-14). No `@modelcontextprotocol/sdk` imports live here, so unit tests can
 * exercise every mapping without starting the server.
 *
 * Project-root rule (all tools except `mygrace_show_file`): the root comes from
 * the explicit `path` argument, then `MYGRACE_PROJECT_ROOT`, then the server's
 * working directory. The MCP server passes an absolute root to the CLI, so the
 * CLI never has to guess. `mygrace_show_file` keeps `path` for the inspected
 * file and uses `projectRoot` for the same root rule.
 */

// START_MODULE_CONTRACT
//   PURPOSE: Single source of truth for the MyGRACE MCP tool catalog — names, descriptions, JSON schemas, argv mapping and argument validation.
//   SCOPE: Pure data/formatting; reads env and cwd only for the project-root default; never spawns a process or touches the filesystem.
//   DEPENDS: grace-errors (UsageError), node:path
//   LINKS: ROADMAP.md (ADR-8, G6)
// END_MODULE_CONTRACT

// START_MODULE_MAP
//   ToolName              — union of the 21 MCP tool names (17 baseline + trace/impact/next/projects)
//   ToolDefinition        — {name, description, inputSchema, rootArg, buildArgs, digestOutput?}
//   TOOLS                 — the catalog; single source of truth
//   TOOL_NAMES            — tool names derived from TOOLS (exported for tests/docs)
//   getToolDefinition()   — catalog lookup by name
//   resolveProjectRoot()  — explicit arg → MYGRACE_PROJECT_ROOT → process.cwd()
//   validateToolArgs()    — type/required/enum/pattern validation + schema defaults
//   formatToolArgError()  — multi-field, structured error text for agents
//   formatUnknownToolError() — structured error for a name outside the catalog
//   buildToolCommand()    — (tool name, args) → `mygrace` argv (no binary, no PATH)
// END_MODULE_MAP

import { resolve } from "node:path";
import { UsageError } from "./grace-errors";

export type ToolName =
  | "mygrace_list_modules"
  | "mygrace_show_module"
  | "mygrace_show_phase"
  | "mygrace_find_modules"
  | "mygrace_phase_index"
  | "mygrace_doctor"
  | "mygrace_test"
  | "mygrace_packet"
  | "mygrace_focus"
  | "mygrace_context_cost"
  | "mygrace_verify"
  | "mygrace_list_verifications"
  | "mygrace_lint"
  | "mygrace_show_file"
  | "mygrace_status"
  | "mygrace_trust"
  | "mygrace_ci"
  | "mygrace_trace"
  | "mygrace_impact"
  | "mygrace_next"
  | "mygrace_projects"
  | "mygrace_integrations"
  | "mygrace_diagram"
  | "mygrace_capsule_list"
  | "mygrace_capsule_run";

export type ToolArgs = Record<string, unknown>;

export interface ToolPropertySchema {
  type: "string" | "boolean" | "number";
  description: string;
  enum?: string[];
  /** ECMA-262 pattern (JSON Schema `pattern`) enforced by validateToolArgs. */
  pattern?: string;
  default?: string | boolean | number;
  minLength?: number;
}

export interface ToolInputSchema {
  type: "object";
  properties: Record<string, ToolPropertySchema>;
  required?: string[];
}

export interface ToolDefinition {
  name: ToolName;
  /** Agent-facing description; every entry documents how the project root is chosen. */
  description: string;
  inputSchema: ToolInputSchema;
  /** Argument that carries the project root (`projectRoot` only for `mygrace_show_file`). */
  rootArg: "path" | "projectRoot";
  buildArgs: (args: ToolArgs, projectRoot: string) => string[];
  /**
   * Optional success-only digest. Applied by the server when the caller passes
   * `compact: true` (and the CLI exited 0 in text mode). Failure output is
   * always returned verbatim — agents need the details.
   */
  digestOutput?: (stdout: string) => string;
}

export interface ProjectRootOptions {
  /** Environment to read `MYGRACE_PROJECT_ROOT` from (defaults to process.env). */
  env?: NodeJS.ProcessEnv;
  /** Base directory for relative roots (defaults to process.cwd()). */
  cwd?: string;
}

// START_BLOCK_CONSTANTS
const MODULE_ID_PATTERN = "^M-[A-Za-z0-9][A-Za-z0-9_-]*$";
const PHASE_ID_PATTERN = "^Phase-[0-9]+[A-Za-z]?$";

/** Shared wording required in every tool description (audit M2/M3). */
const ROOT_NOTE =
  "`path` MUST be the absolute project root of the session workspace you are working in. The harness " +
  "starts this server in its own launch directory, so pass it explicitly; when omitted, resolution falls " +
  "back to `MYGRACE_PROJECT_ROOT`, then the last project remembered from an explicit call, then the " +
  "server's working directory.";
const ROOT_NOTE_FILE =
  "`path` is the file to inspect; `projectRoot` MUST be the absolute session-workspace root (when omitted " +
  "it falls back like `path`: `MYGRACE_PROJECT_ROOT`, then the remembered project, then the server's " +
  "working directory).";
// END_BLOCK_CONSTANTS

// START_BLOCK_ARG_HELPERS
function stringArg(args: ToolArgs, key: string): string | undefined {
  const value = args[key];
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.trim() === "") {
    throw new UsageError(`Argument "${key}" must be a non-empty string.`, {
      hint: "Call arguments should be validated with validateToolArgs() before mapping.",
    });
  }
  return value;
}

function requiredStringArg(tool: ToolName, args: ToolArgs, key: string): string {
  const value = stringArg(args, key);
  if (value === undefined) {
    throw new UsageError(`Tool ${tool} is missing required argument "${key}".`, {
      hint: "Call arguments should be validated with validateToolArgs() before mapping.",
    });
  }
  return value;
}

function booleanFlag(args: ToolArgs, key: string): boolean {
  return args[key] === true;
}

function wantsJson(args: ToolArgs): boolean {
  return args.format === "json";
}
// END_BLOCK_ARG_HELPERS

// START_BLOCK_CATALOG
/**
 * The one and only tool catalog. Order is the order returned by `tools/list`
 * and documented in README.md — keep tools and their names stable.
 */
export const TOOLS: readonly ToolDefinition[] = [
  {
    name: "mygrace_list_modules",
    description:
      "List modules from graph-index.xml (≤100 lines). Filter by status or type. " +
      "This is the lazy-loading entry point — always start here. " +
      ROOT_NOTE,
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Absolute session-workspace root; pass it explicitly (see server instructions).", minLength: 1 },
        status: { type: "string", enum: ["pending", "wip", "done"], description: "Filter by module STATUS." },
        type: { type: "string", description: "Filter by module TYPE (e.g. CORE_LOGIC)." },
        format: { type: "string", enum: ["text", "json"], default: "text", description: "Output format." },
      },
    },
    rootArg: "path",
    buildArgs(args, root) {
      const cmd = ["module", "list", "--path", root];
      const status = stringArg(args, "status");
      const type = stringArg(args, "type");
      if (status !== undefined) cmd.push("--status", status);
      if (type !== undefined) cmd.push("--type", type);
      if (wantsJson(args)) cmd.push("--format", "json");
      return cmd;
    },
  },
  {
    name: "mygrace_show_module",
    description:
      "Show the per-module file from docs/modules/M-XXX.xml (30-80 lines). " +
      "Use after mygrace_list_modules to find the module ID. " +
      ROOT_NOTE,
    inputSchema: {
      type: "object",
      properties: {
        id: {
          type: "string",
          pattern: MODULE_ID_PATTERN,
          description: "Module ID (e.g. M-AUTH; a unique ID prefix such as M-A is accepted by the CLI).",
        },
        path: { type: "string", description: "Absolute session-workspace root; pass it explicitly (see server instructions).", minLength: 1 },
        withVerification: { type: "boolean", default: false, description: "Append the matching verification file." },
      },
      required: ["id"],
    },
    rootArg: "path",
    buildArgs(args, root) {
      const cmd = ["module", "show", requiredStringArg("mygrace_show_module", args, "id"), "--path", root];
      if (booleanFlag(args, "withVerification")) cmd.push("--with-verification");
      return cmd;
    },
  },
  {
    name: "mygrace_show_phase",
    description:
      "Show the per-phase file from docs/plans/Phase-N.xml (50-200 lines). " +
      "Read the plan index first (mygrace_phase_index). " +
      ROOT_NOTE,
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", pattern: PHASE_ID_PATTERN, description: "Phase ID (e.g. Phase-1)." },
        path: { type: "string", description: "Absolute session-workspace root; pass it explicitly (see server instructions).", minLength: 1 },
      },
      required: ["name"],
    },
    rootArg: "path",
    buildArgs(args, root) {
      return ["phase", "show", requiredStringArg("mygrace_show_phase", args, "name"), "--path", root];
    },
  },
  {
    name: "mygrace_find_modules",
    description:
      "Search modules from graph-index.xml by query and filters (≤100 lines), as text or JSON. " +
      "Use it instead of mygrace_list_modules when you know part of a name, path or dependency. " +
      ROOT_NOTE,
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search query (matches ID, NAME, TYPE, STATUS, DEPENDS, PATH; empty = list all)." },
        path: { type: "string", description: "Absolute session-workspace root; pass it explicitly (see server instructions).", minLength: 1 },
        status: { type: "string", enum: ["pending", "wip", "done"], description: "Filter by module STATUS." },
        type: { type: "string", description: "Filter by module TYPE." },
        format: { type: "string", enum: ["text", "json"], default: "text", description: "Output format." },
      },
    },
    rootArg: "path",
    buildArgs(args, root) {
      const cmd = ["module", "find"];
      const query = stringArg(args, "query");
      if (query !== undefined) cmd.push(query);
      cmd.push("--path", root);
      const status = stringArg(args, "status");
      const type = stringArg(args, "type");
      if (status !== undefined) cmd.push("--status", status);
      if (type !== undefined) cmd.push("--type", type);
      if (wantsJson(args)) cmd.push("--format", "json");
      return cmd;
    },
  },
  {
    name: "mygrace_phase_index",
    description:
      "Show plan-index.xml (≤50 lines) — the phase index. Always read it before phase files. " + ROOT_NOTE,
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Absolute session-workspace root; pass it explicitly (see server instructions).", minLength: 1 },
      },
    },
    rootArg: "path",
    buildArgs(_args, root) {
      return ["phase", "index", "--path", root];
    },
  },
  {
    name: "mygrace_doctor",
    description:
      "Run MyGRACE health checks (project lint, DSH, rtk/caveman, mygrace-* skills, MCP row, dev tools). " +
      "Use at session start or when something is slow/broken. A non-zero exit still returns the full report. " +
      ROOT_NOTE,
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Absolute session-workspace root; pass it explicitly (see server instructions).", minLength: 1 },
      },
    },
    rootArg: "path",
    buildArgs(_args, root) {
      return ["doctor", "--path", root];
    },
  },
  {
    name: "mygrace_test",
    description:
      "Run module tests scoped from verification files (test-files + module-checks, default `bun test`). " +
      "compact (default true) keeps failures and the summary only; exit 1 on failure. " +
      ROOT_NOTE,
    inputSchema: {
      type: "object",
      properties: {
        module: { type: "string", pattern: MODULE_ID_PATTERN, description: "Module ID (e.g. M-AUTH); omit to run all modules in graph-index.xml." },
        compact: { type: "boolean", default: true, description: "Print only failures and the summary." },
        path: { type: "string", description: "Absolute session-workspace root; pass it explicitly (see server instructions).", minLength: 1 },
      },
    },
    rootArg: "path",
    buildArgs(args, root) {
      const cmd = ["test", "--path", root];
      const moduleId = stringArg(args, "module");
      if (moduleId !== undefined) cmd.push("--module", moduleId);
      if (booleanFlag(args, "compact")) cmd.push("--compact");
      return cmd;
    },
  },
  {
    name: "mygrace_packet",
    description:
      "Generate a self-contained worker prompt for one module (contract + verification excerpt + dependency list). " +
      "For DSH subagents — smaller context than reading several files. " +
      ROOT_NOTE,
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", pattern: MODULE_ID_PATTERN, description: "Module ID (e.g. M-AUTH)." },
        path: { type: "string", description: "Absolute session-workspace root; pass it explicitly (see server instructions).", minLength: 1 },
      },
      required: ["id"],
    },
    rootArg: "path",
    buildArgs(args, root) {
      return ["packet", requiredStringArg("mygrace_packet", args, "id"), "--path", root];
    },
  },
  {
    name: "mygrace_focus",
    description:
      "Print the minimal working set for one module (contract + deps + tests command). " +
      "Smaller than mygrace_show_module. " +
      ROOT_NOTE,
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", pattern: MODULE_ID_PATTERN, description: "Module ID (e.g. M-AUTH)." },
        path: { type: "string", description: "Absolute session-workspace root; pass it explicitly (see server instructions).", minLength: 1 },
      },
      required: ["id"],
    },
    rootArg: "path",
    buildArgs(args, root) {
      return ["focus", requiredStringArg("mygrace_focus", args, "id"), "--path", root];
    },
  },
  {
    name: "mygrace_context_cost",
    description:
      "Context budget per operation in lines (status, single module work, phase execution, verification audit). " +
      "Use it to budget how much an agent may read. JSON output. " +
      ROOT_NOTE,
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Absolute session-workspace root; pass it explicitly (see server instructions).", minLength: 1 },
      },
    },
    rootArg: "path",
    buildArgs(_args, root) {
      return ["context-cost", "--path", root, "--format", "json"];
    },
  },
  {
    name: "mygrace_verify",
    description:
      "Scoped module tests with a compact digest; on failure writes `.mygrace/last-failures.md`. " +
      "Exit 1 on failure — for agent loops. " +
      ROOT_NOTE,
    inputSchema: {
      type: "object",
      properties: {
        module: { type: "string", pattern: MODULE_ID_PATTERN, description: "Module ID (e.g. M-AUTH); omit = all modules in graph-index.xml." },
        path: { type: "string", description: "Absolute session-workspace root; pass it explicitly (see server instructions).", minLength: 1 },
      },
    },
    rootArg: "path",
    buildArgs(args, root) {
      const cmd = ["verify", "--path", root];
      const moduleId = stringArg(args, "module");
      if (moduleId !== undefined) cmd.push("--module", moduleId);
      return cmd;
    },
  },
  {
    name: "mygrace_list_verifications",
    description:
      "List verification entries from verification-index.xml (≤80 lines), as text or JSON. Filter by priority. " +
      ROOT_NOTE,
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Absolute session-workspace root; pass it explicitly (see server instructions).", minLength: 1 },
        priority: { type: "string", enum: ["high", "medium", "low"], description: "Filter by priority." },
        format: { type: "string", enum: ["text", "json"], default: "text", description: "Output format." },
      },
    },
    rootArg: "path",
    buildArgs(args, root) {
      const cmd = ["verification", "index", "--path", root];
      const priority = stringArg(args, "priority");
      if (priority !== undefined) cmd.push("--priority", priority);
      if (wantsJson(args)) cmd.push("--format", "json");
      return cmd;
    },
  },
  {
    name: "mygrace_lint",
    description:
      "Run MyGRACE integrity lint (index synchronization, semantic markup, XML conventions). " +
      "compact (default true) drops the banner on success but keeps every finding line; failures are returned in full. " +
      ROOT_NOTE,
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Absolute session-workspace root; pass it explicitly (see server instructions).", minLength: 1 },
        format: { type: "string", enum: ["text", "json"], default: "text", description: "Output format." },
        allowMissingDocs: { type: "boolean", default: false, description: "Treat a missing docs/ tree as an empty project." },
        compact: { type: "boolean", default: true, description: "Drop the report banner; keep counts, findings and the verdict." },
      },
    },
    rootArg: "path",
    buildArgs(args, root) {
      const cmd = ["lint", "--path", root];
      if (wantsJson(args)) cmd.push("--format", "json");
      if (booleanFlag(args, "allowMissingDocs")) cmd.push("--allow-missing-docs");
      return cmd;
    },
    digestOutput: compactLintOutput,
  },
  {
    name: "mygrace_show_file",
    description:
      "Show file-local MODULE_CONTRACT, MODULE_MAP, CHANGE_SUMMARY, contracts and semantic blocks. " +
      ROOT_NOTE_FILE,
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "File path to inspect, relative to the project root.", minLength: 1 },
        projectRoot: { type: "string", description: "Project root (optional; see tool description).", minLength: 1 },
        contracts: { type: "boolean", default: false, description: "Include START_CONTRACT blocks." },
        blocks: { type: "boolean", default: false, description: "Include START_BLOCK/END_BLOCK boundaries." },
      },
      required: ["path"],
    },
    rootArg: "projectRoot",
    buildArgs(args, root) {
      const cmd = ["file", "show", requiredStringArg("mygrace_show_file", args, "path"), "--root", root];
      if (booleanFlag(args, "contracts")) cmd.push("--contracts");
      if (booleanFlag(args, "blocks")) cmd.push("--blocks");
      return cmd;
    },
  },
  {
    name: "mygrace_status",
    description:
      "Aggregated project health from the 3 indexes + lint summary, as JSON. Use for status reports and dashboards. " +
      ROOT_NOTE,
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Absolute session-workspace root; pass it explicitly (see server instructions).", minLength: 1 },
      },
    },
    rootArg: "path",
    buildArgs(_args, root) {
      return ["status", "--path", root, "--format", "json"];
    },
  },
  {
    name: "mygrace_trust",
    description:
      "Write/refresh the project trust record (.mygrace/trust.json) after reviewing the project-declared commands, " +
      "so mygrace_test and mygrace_verify may execute them (ADR-1). Mutating but safe on an untrusted repo: it only " +
      "records sha256 hashes; never commit `.mygrace/`. JSON output by default. " +
      ROOT_NOTE,
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Project root to trust (optional).", minLength: 1 },
        format: {
          type: "string",
          enum: ["text", "json"],
          default: "json",
          description: "Output format; json returns the record summary envelope.",
        },
      },
    },
    rootArg: "path",
    buildArgs(args, root) {
      const cmd = ["trust", "--path", root];
      if (wantsJson(args)) cmd.push("--format", "json");
      return cmd;
    },
  },
  {
    name: "mygrace_ci",
    description:
      "Run the full quality gate in one call: strict lint + project status + verification coverage " +
      "(and trust-gated tests with `tests: true`). Returns a PASS/FAIL digest; exit 1 on findings, " +
      "2 when tests were requested but project commands are untrusted. Use before commit/merge. " +
      ROOT_NOTE,
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Project root to check (optional).", minLength: 1 },
        tests: {
          type: "boolean",
          default: false,
          description: "Also run trust-gated scoped verification tests (requires a trust record or allowCommands).",
        },
        module: {
          type: "string",
          description: "Limit the tests stage to one module id (e.g. M-AUTH).",
          pattern: "^M-[A-Za-z0-9][A-Za-z0-9_-]*$",
        },
        allowCommands: {
          type: "boolean",
          default: false,
          description: "Explicitly allow project-declared commands for this run (shell/metacharacter opt-in).",
        },
        format: { type: "string", enum: ["text", "json"], default: "text", description: "Output format." },
      },
    },
    rootArg: "path",
    buildArgs(args, root) {
      const cmd = ["ci", "--path", root];
      if (args.tests === true) cmd.push("--tests");
      const module = stringArg(args, "module");
      if (module !== undefined) cmd.push("--module", module);
      if (args.allowCommands === true) cmd.push("--allow-commands");
      if (wantsJson(args)) cmd.push("--format", "json");
      return cmd;
    },
  },
  {
    name: "mygrace_trace",
    description:
      "Trace an entity across the whole chain: requirements → module → verification → test files → command → phases → dependents. " +
      "Structural and grep-free; reports gaps (MISSING_VERIFICATION_REF, VERIFICATION_FILE_MISSING, TEST_FILE_MISSING, " +
      "MODULE_PATH_MISSING, NO_DECLARED_COMMAND, NO_REQUIREMENT_LINK, NO_PHASE_LINK) as findings. " +
      "Use before implementing or reviewing a module. JSON output by default. " +
      ROOT_NOTE,
    inputSchema: {
      type: "object",
      properties: {
        id: {
          type: "string",
          pattern: "^(?:M-|V-M-)[A-Za-z0-9][A-Za-z0-9_-]*$",
          description: "Module id (M-XXX) or verification id (V-M-XXX).",
        },
        path: { type: "string", description: "Absolute session-workspace root; pass it explicitly (see server instructions).", minLength: 1 },
        code: {
          type: "boolean",
          default: false,
          description: "Also verify MODULE_MAP symbols exist in code via Octocode (optional, ADR-9).",
        },
        format: { type: "string", enum: ["text", "json"], default: "json", description: "Output format." },
      },
      required: ["id"],
    },
    rootArg: "path",
    buildArgs(args, root) {
      const cmd = ["trace", requiredStringArg("mygrace_trace", args, "id"), "--path", root];
      if (booleanFlag(args, "code")) cmd.push("--code");
      if (wantsJson(args)) cmd.push("--format", "json");
      return cmd;
    },
  },
  {
    name: "mygrace_impact",
    description:
      "Map changed files to the modules, transitive dependents, verification/test files and plan phases they affect. " +
      "Changed files come from `files` (comma-separated, works without git) → `staged` → `since` (git revision) → git diff HEAD. " +
      "Read-only blast-radius advice; use before editing or to size a review. JSON output by default. " +
      ROOT_NOTE,
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Absolute session-workspace root; pass it explicitly (see server instructions).", minLength: 1 },
        files: {
          type: "string",
          description: "Comma-separated project-relative changed files (highest precedence; works without git).",
          minLength: 1,
        },
        staged: { type: "boolean", default: false, description: "Use the git index (git diff --cached) as the change source." },
        since: { type: "string", description: "Git revision to diff against (e.g. HEAD~1, origin/main).", minLength: 1 },
        codeGraph: {
          type: "boolean",
          default: false,
          description: "Also map real code import edges between affected modules via Octocode (optional, ADR-9).",
        },
        format: { type: "string", enum: ["text", "json"], default: "json", description: "Output format." },
      },
    },
    rootArg: "path",
    buildArgs(args, root) {
      const cmd = ["impact", "--path", root];
      const files = stringArg(args, "files");
      if (files !== undefined) cmd.push("--files", files);
      if (booleanFlag(args, "staged")) cmd.push("--staged");
      const since = stringArg(args, "since");
      if (since !== undefined) cmd.push("--since", since);
      if (booleanFlag(args, "codeGraph")) cmd.push("--code-graph");
      if (wantsJson(args)) cmd.push("--format", "json");
      return cmd;
    },
  },
  {
    name: "mygrace_next",
    description:
      "Deterministic next-step advice for an agent with no session memory: init project → fix index → fix lint errors → " +
      "close verification coverage gaps → trust commands → verify the first pending module → clear warnings → next phase. " +
      "Read-only; exits 0 even when it recommends work (advice never fails the build). JSON output by default. " +
      ROOT_NOTE,
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Absolute session-workspace root; pass it explicitly (see server instructions).", minLength: 1 },
        format: { type: "string", enum: ["text", "json"], default: "json", description: "Output format." },
      },
    },
    rootArg: "path",
    buildArgs(args, root) {
      const cmd = ["next", "--path", root];
      if (wantsJson(args)) cmd.push("--format", "json");
      return cmd;
    },
  },
  {
    name: "mygrace_projects",
    description:
      "Discover MyGRACE sub-projects (directories containing docs/graph-index.xml) under a monorepo root, with per-project " +
      "module/phase/verification counts, lint findings, verification coverage and aggregate totals. " +
      "`depth` caps the scan (CLI default 4). JSON output by default. " +
      ROOT_NOTE,
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Monorepo root to scan (optional).", minLength: 1 },
        depth: { type: "number", description: "Maximum directory depth to scan (CLI default 4)." },
        strict: { type: "boolean", default: false, description: "Promote lint warnings to a failing exit code." },
        format: { type: "string", enum: ["text", "json"], default: "json", description: "Output format." },
      },
    },
    rootArg: "path",
    buildArgs(args, root) {
      const cmd = ["projects", "--path", root];
      const depth = args.depth;
      if (typeof depth === "number") cmd.push("--depth", String(depth));
      if (booleanFlag(args, "strict")) cmd.push("--strict");
      if (wantsJson(args)) cmd.push("--format", "json");
      return cmd;
    },
  },
  {
    name: "mygrace_integrations",
    description:
      "Detect optional external tools (Octocode code graph, Archify diagrams): executable, source, version and tested range. " +
      "Advisory only: missing or unsupported tools never fail the core gates and produce info findings with install hints. JSON output by default. " +
      ROOT_NOTE,
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Absolute session-workspace root; pass it explicitly (see server instructions).", minLength: 1 },
        format: { type: "string", enum: ["text", "json"], default: "json", description: "Output format." },
      },
    },
    rootArg: "path",
    buildArgs(args, root) {
      const cmd = ["integrations", "status", "--path", root];
      if (wantsJson(args)) cmd.push("--format", "json");
      return cmd;
    },
  },
  {
    name: "mygrace_diagram",
    description:
      "Export the docs graph as deterministic Archify architecture IR: JSON IR (all declared dependencies), Mermaid flowchart, " +
      "or standalone HTML rendered by the optional Archify CLI (writes IR/HTML/receipt only when format=html). " +
      "`check:true` verifies the committed IR is current without writing. " +
      ROOT_NOTE,
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Absolute session-workspace root; pass it explicitly (see server instructions).", minLength: 1 },
        kind: { type: "string", enum: ["architecture"], default: "architecture", description: "Diagram kind (v1.5: architecture)." },
        format: { type: "string", enum: ["json", "html", "mermaid"], default: "json", description: "Output format." },
        out: { type: "string", description: "Project-relative HTML output path (format=html; default integrations.archify.outputDir/architecture.html).", minLength: 1 },
        quality: { type: "string", enum: ["standard", "showcase"], default: "standard", description: "Archify quality profile." },
        check: { type: "boolean", default: false, description: "Only verify that the committed IR matches the current docs graph." },
      },
    },
    rootArg: "path",
    buildArgs(args, root) {
      const kind = stringArg(args, "kind") ?? "architecture";
      const format = stringArg(args, "format") ?? "json";
      const cmd = ["diagram", "--path", root, "--kind", kind, "--format", format];
      const out = stringArg(args, "out");
      if (out !== undefined) cmd.push("--out", out);
      const quality = stringArg(args, "quality");
      if (quality !== undefined && quality !== "standard") cmd.push("--quality", quality);
      if (booleanFlag(args, "check")) cmd.push("--check");
      return cmd;
    },
  },
  {
    name: "mygrace_capsule_list",
    description:
      "List local MyGRACE capsules (allowlisted read-only routines): validity, step count and qualification state. " +
      "Capsule execution is opt-in via integrations.capsules.enabled=true. " +
      ROOT_NOTE,
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Absolute session-workspace root; pass it explicitly (see server instructions).", minLength: 1 },
        format: { type: "string", enum: ["text", "json"], default: "json", description: "Output format." },
      },
    },
    rootArg: "path",
    buildArgs(args, root) {
      const cmd = ["capsule", "list", "--path", root];
      if (wantsJson(args)) cmd.push("--format", "json");
      return cmd;
    },
  },
  {
    name: "mygrace_capsule_run",
    description:
      "Run a qualified capsule of allowlisted read-only mygrace programs; stops at a judgment step and prints the `capsule continue` run id. " +
      "Fails with CAPSULE_UNQUALIFIED until `mygrace capsule qualify <name> --fixture <project>` recorded the current capsule hash. " +
      ROOT_NOTE,
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", pattern: "^[a-z][a-z0-9-]{1,39}$", description: "Capsule name (see mygrace_capsule_list)." },
        module: { type: "string", pattern: "^M-[A-Za-z0-9][A-Za-z0-9_-]*$", description: "Value for the $module binding." },
        files: { type: "string", minLength: 1, description: "Comma-separated value for the $files binding." },
        allowUnqualified: { type: "boolean", default: false, description: "Development only: run without a qualification record." },
        path: { type: "string", description: "Absolute session-workspace root; pass it explicitly (see server instructions).", minLength: 1 },
        format: { type: "string", enum: ["text", "json"], default: "json", description: "Output format." },
      },
      required: ["name"],
    },
    rootArg: "path",
    buildArgs(args, root) {
      const cmd = ["capsule", "run", requiredStringArg("mygrace_capsule_run", args, "name"), "--path", root];
      const module = stringArg(args, "module");
      if (module !== undefined) cmd.push("--module", module);
      const files = stringArg(args, "files");
      if (files !== undefined) cmd.push("--files", files);
      if (booleanFlag(args, "allowUnqualified")) cmd.push("--allow-unqualified");
      if (wantsJson(args)) cmd.push("--format", "json");
      return cmd;
    },
  },
  // TODO(W3): `mygrace_config` (read the effective mygrace.config.json) can read grace-config
  // directly instead of spawning the CLI — add when the agent-first command set is designed.
];

/** Names of every MCP tool this server exposes, derived from the catalog. */
export const TOOL_NAMES: readonly ToolName[] = TOOLS.map((tool) => tool.name);
// END_BLOCK_CATALOG

// START_BLOCK_ROOT_RESOLUTION
/**
 * Resolve the project root for one tool call (audit M2/M3).
 *
 * Order: explicit argument → `MYGRACE_PROJECT_ROOT` → `process.cwd()` (the host
 * usually sets it to the workspace). The result is always absolute, so the CLI
 * child process never depends on its own working directory.
 */
export function resolveProjectRoot(
  tool: ToolDefinition,
  args: ToolArgs = {},
  options: ProjectRootOptions = {}
): string {
  const env = options.env ?? process.env;
  const cwd = options.cwd ?? process.cwd();
  const explicit = args[tool.rootArg];
  const fromArgs = typeof explicit === "string" && explicit.trim() !== "" ? explicit.trim() : undefined;
  const fromEnv =
    typeof env.MYGRACE_PROJECT_ROOT === "string" && env.MYGRACE_PROJECT_ROOT.trim() !== ""
      ? env.MYGRACE_PROJECT_ROOT.trim()
      : undefined;
  return resolve(cwd, fromArgs ?? fromEnv ?? cwd);
}
// END_BLOCK_ROOT_RESOLUTION

// START_BLOCK_VALIDATION
export interface ToolArgIssue {
  /** Argument name (or "arguments"/"tool" for whole-call problems). */
  field: string;
  message: string;
}

export type ToolArgValidation =
  | { ok: true; args: ToolArgs }
  | { ok: false; issues: ToolArgIssue[] };

/** Catalog lookup; `undefined` for names outside the documented surface. */
export function getToolDefinition(name: string): ToolDefinition | undefined {
  return TOOLS.find((tool) => tool.name === name);
}

function matchesType(value: unknown, type: ToolPropertySchema["type"]): boolean {
  if (type === "number") return typeof value === "number" && Number.isFinite(value);
  return typeof value === type;
}

function describeValue(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "an array";
  if (typeof value === "object") return "an object";
  if (typeof value === "string") {
    return JSON.stringify(value.length > 80 ? `${value.slice(0, 77)}...` : value);
  }
  return String(value);
}

function describeExpected(spec: ToolPropertySchema): string {
  const parts = [`a ${spec.type}`];
  if (spec.enum !== undefined) parts.push(`one of ${spec.enum.map((value) => JSON.stringify(value)).join(", ")}`);
  if (spec.pattern !== undefined) parts.push(`matching ${spec.pattern}`);
  return parts.join(" ");
}

function describeInputSchema(schema: ToolInputSchema): string {
  const required = new Set(schema.required ?? []);
  const parts = Object.entries(schema.properties).map(([key, spec]) => {
    const optional = required.has(key) ? "" : "?";
    const values = spec.enum === undefined ? spec.type : spec.enum.map((value) => JSON.stringify(value)).join(" | ");
    return `${key}${optional}: ${values}`;
  });
  return `{ ${parts.join(", ")} }`;
}

/**
 * Validate raw MCP tool arguments against the catalog schema and apply declared
 * defaults. Rejects instead of silently inventing arguments, which is how
 * `docs/modules/undefined.xml` used to happen (audit M2/M3).
 */
export function validateToolArgs(name: string, rawArgs: unknown = {}): ToolArgValidation {
  const tool = getToolDefinition(name);
  if (tool === undefined) {
    return { ok: false, issues: [{ field: "tool", message: `unknown tool "${name}"` }] };
  }
  if (rawArgs !== null && rawArgs !== undefined && (typeof rawArgs !== "object" || Array.isArray(rawArgs))) {
    return { ok: false, issues: [{ field: "arguments", message: "arguments must be a JSON object" }] };
  }

  const input = (rawArgs ?? {}) as Record<string, unknown>;
  const required = new Set(tool.inputSchema.required ?? []);
  const issues: ToolArgIssue[] = [];
  const normalized: ToolArgs = {};

  for (const [key, spec] of Object.entries(tool.inputSchema.properties)) {
    const value = input[key];
    if (value === undefined) {
      if (required.has(key)) {
        issues.push({ field: key, message: `required argument is missing (expected ${describeExpected(spec)})` });
      } else if (spec.default !== undefined) {
        normalized[key] = spec.default;
      }
      continue;
    }

    if (!matchesType(value, spec.type)) {
      issues.push({ field: key, message: `expected a ${spec.type}, got ${describeValue(value)}` });
      continue;
    }
    if (spec.enum !== undefined && !spec.enum.includes(value as string)) {
      issues.push({
        field: key,
        message: `must be one of ${spec.enum.map((option) => JSON.stringify(option)).join(", ")} (got ${describeValue(value)})`,
      });
      continue;
    }
    if (spec.pattern !== undefined && typeof value === "string" && !new RegExp(spec.pattern).test(value)) {
      issues.push({ field: key, message: `must match ${spec.pattern} (got ${describeValue(value)})` });
      continue;
    }
    if (spec.minLength !== undefined && typeof value === "string" && value.trim().length < spec.minLength) {
      issues.push({ field: key, message: "must be a non-empty string" });
      continue;
    }
    normalized[key] = value;
  }

  for (const key of Object.keys(input)) {
    if (input[key] !== undefined && !(key in tool.inputSchema.properties)) {
      issues.push({ field: key, message: `unknown argument for ${tool.name}` });
    }
  }

  return issues.length > 0 ? { ok: false, issues } : { ok: true, args: normalized };
}

/** Structured, agent-readable error text for invalid tool arguments. */
export function formatToolArgError(tool: ToolDefinition, issues: readonly ToolArgIssue[]): string {
  const count = issues.length;
  const lines = [
    `INVALID_TOOL_ARGUMENTS: ${tool.name} — ${count} invalid argument${count === 1 ? "" : "s"}.`,
    ...issues.map((issue) => `  • ${issue.field}: ${issue.message}`),
    "",
    `Accepted arguments: ${describeInputSchema(tool.inputSchema)}`,
    `Project root: explicit ${tool.rootArg} → MYGRACE_PROJECT_ROOT → remembered project → the MCP server's working directory.`,
    `The mygrace CLI was not called. Fix the argument(s) above and retry ${tool.name}.`,
  ];
  return lines.join("\n");
}

/** Structured error text for a tool name that is not in the catalog. */
export function formatUnknownToolError(name: string): string {
  return [
    `UNKNOWN_TOOL: "${name}" is not a MyGRACE MCP tool.`,
    `Known tools (${TOOL_NAMES.length}): ${TOOL_NAMES.join(", ")}.`,
    "Call tools with the exact name from tools/list.",
  ].join("\n");
}
// END_BLOCK_VALIDATION

// START_BLOCK_MAPPING
/**
 * Build the `mygrace` CLI argv (without the executable) for one MCP tool call.
 *
 * Pure and PATH-free: the server decides how to launch the CLI (see
 * src/grace-mcp.ts). Throws `UsageError` for unknown tools or — defensively —
 * for missing required arguments when the caller skipped validation.
 */
export function buildToolCommand(name: string, args: ToolArgs = {}, options: ProjectRootOptions = {}): string[] {
  const tool = getToolDefinition(name);
  if (tool === undefined) {
    throw new UsageError(`Unknown tool "${name}".`, {
      hint: `Available tools: ${TOOL_NAMES.join(", ")}.`,
    });
  }
  const projectRoot = resolveProjectRoot(tool, args, options);
  return tool.buildArgs(args, projectRoot);
}
// END_BLOCK_MAPPING

// START_BLOCK_COMPACT
/**
 * Lint digest for `compact: true`: drop the banner, blank lines and the
 * underline; keep counts, every finding and the final verdict. Returns the
 * original text when nothing matches, so a new output format can never be
 * silently swallowed.
 */
export function compactLintOutput(stdout: string): string {
  const kept: string[] = [];
  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "" || /^=+$/.test(trimmed) || trimmed === "MyGRACE Lint Report") continue;
    if (/^(Errors:|Warnings:)/.test(trimmed)) {
      kept.push(trimmed);
      continue;
    }
    if (/^(Errors|Warnings):$/.test(trimmed)) {
      kept.push(trimmed);
      continue;
    }
    if (/^[✓✗⚠]/.test(trimmed)) {
      kept.push(trimmed);
    }
  }
  return kept.length === 0 ? stdout.trim() : kept.join("\n");
}
// END_BLOCK_COMPACT
