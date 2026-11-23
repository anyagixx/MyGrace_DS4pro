#!/usr/bin/env bun
/**
 * MyGRACE MCP Server — exposes the MyGRACE CLI to AI coding agents over the
 * Model Context Protocol (stdio).
 *
 * Runtime contract (ROADMAP ADR-7/ADR-8, gate G6):
 *   - No PATH dependency. A plain checkout works with an empty PATH: the CLI is
 *     launched as `process.execPath run <pkg>/src/grace.ts`, resolved from this
 *     file's own directory. `MYGRACE_BIN` overrides the executable; a `mygrace`
 *     binary on PATH is only the last-resort fallback.
 *   - No guessed arguments. Every call is validated against the catalog schema
 *     first; bad calls return a structured error naming the offending field and
 *     the CLI is never invoked (no more `docs/modules/undefined.xml`).
 *   - No lost diagnostics. CLI stdout AND stderr are returned for success and
 *     failure alike, with `isError: true` on a non-zero exit, timeout or launch
 *     failure — agents need the details to recover.
 *
 * stdout is reserved for the MCP protocol; all diagnostics go to stderr.
 */

// START_MODULE_CONTRACT
//   PURPOSE: Expose the MyGRACE tool catalog to MCP clients over stdio with a PATH-free CLI launcher, strict argument validation and full CLI output passthrough.
//   SCOPE: MCP protocol wiring, launcher resolution, CLI process supervision and result formatting; no project logic.
//   DEPENDS: @modelcontextprotocol/sdk, grace-mcp-commands, package.json (version), node:child_process, node:fs, node:path
//   LINKS: ROADMAP.md (ADR-7, ADR-8, G6)
// END_MODULE_CONTRACT

// START_MODULE_MAP
//   DEFAULT_TIMEOUT_MS   — default CLI budget (120 s); MYGRACE_MCP_TIMEOUT_MS overrides
//   CLI_MAX_BUFFER       — 10 MB stdout/stderr capture budget
//   CliLauncher          — {command, args, source, describe()}
//   resolveLauncher()    — MYGRACE_BIN → absolute src/grace.ts via process.execPath → mygrace on PATH
//   resolveTimeoutMs()   — parse MYGRACE_MCP_TIMEOUT_MS with a safe default
//   runCli()             — execFile the launcher; capture stdout/stderr, timeout, maxBuffer, spawn errors
//   createMcpServer()    — Server with ListTools/CallTool handlers driven by the catalog
//   applyProjectMemory() — last-project memory so sessions started outside a project still work
//   isEntryPoint()       — start the stdio server only when executed, never when imported by tests
//   main()               — connect the stdio transport
// END_MODULE_MAP

import { Server } from "@modelcontextprotocol/sdk/server";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolResult,
} from "@modelcontextprotocol/sdk/types.js";
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import pkg from "../package.json" with { type: "json" };
import {
  TOOLS,
  TOOL_NAMES,
  buildToolCommand,
  formatToolArgError,
  formatUnknownToolError,
  getToolDefinition,
  resolveProjectRoot,
  validateToolArgs,
  type ToolArgs,
  type ToolDefinition,
} from "./grace-mcp-commands";

// START_BLOCK_CONSTANTS
/** Default budget for one CLI call; raise with MYGRACE_MCP_TIMEOUT_MS. */
export const DEFAULT_TIMEOUT_MS = 120_000;
/** 10 MB is far beyond any legitimate index/lint/test digest (audit M-12). */
export const CLI_MAX_BUFFER = 10 * 1024 * 1024;
// END_BLOCK_CONSTANTS

// START_BLOCK_LAUNCHER
export type LauncherSource = "env" | "checkout" | "path";

export interface CliLauncher {
  /** Executable to spawn (absolute runtime path or a PATH-resolved binary name). */
  command: string;
  /** Fixed arguments inserted before the CLI argv — `["run", "<pkg>/src/grace.ts"]` for bun. */
  args: string[];
  source: LauncherSource;
  /** One-line description used in diagnostics and error messages. */
  describe(): string;
}

export interface ResolveLauncherOptions {
  env?: NodeJS.ProcessEnv;
  execPath?: string;
  /** Directory of this module (`import.meta.dirname`), overridable for tests. */
  moduleDir?: string;
  exists?: (path: string) => boolean;
  isBun?: boolean;
}

const SCRIPT_FILE = /\.(?:[cm]?[jt]s)$/i;
/** Candidate CLI entries next to this module; source-only package today, JS build later. */
const CLI_ENTRY_CANDIDATES = ["grace.ts", "grace.js", "grace.mjs"];

function runtimeIsBun(): boolean {
  return typeof (process.versions as { bun?: string }).bun === "string";
}

/**
 * Decide how to launch the MyGRACE CLI (audit C-3 — the old server relied on a
 * `mygrace` binary on PATH and every call failed from a plain checkout).
 *
 * 1. `MYGRACE_BIN` — explicit override. A TypeScript/JS script is run through
 *    the current runtime (`process.execPath`); anything else is spawned as-is.
 * 2. Checkout / installed package — `<this dir>/grace.ts` executed by
 *    `process.execPath` (bun: `run <file>`, node ≥22.6: `<file>`). This branch
 *    makes an empty PATH sufficient.
 * 3. Globally installed `mygrace` on PATH — last resort only.
 */
export function resolveLauncher(options: ResolveLauncherOptions = {}): CliLauncher {
  const env = options.env ?? process.env;
  const execPath = options.execPath ?? process.execPath;
  const moduleDir = options.moduleDir ?? import.meta.dirname;
  const exists = options.exists ?? existsSync;
  const isBun = options.isBun ?? runtimeIsBun();
  const scriptArgs = (script: string): string[] => (isBun ? ["run", script] : [script]);

  const override = env.MYGRACE_BIN?.trim();
  if (override !== undefined && override !== "") {
    if (SCRIPT_FILE.test(override) && exists(override)) {
      const script = resolve(override);
      return {
        command: execPath,
        args: scriptArgs(script),
        source: "env",
        describe: () => `MYGRACE_BIN script ${script} via ${execPath}`,
      };
    }
    return {
      command: override,
      args: [],
      source: "env",
      describe: () => `MYGRACE_BIN ${override}`,
    };
  }

  for (const candidate of CLI_ENTRY_CANDIDATES) {
    const cliEntry = resolve(moduleDir, candidate);
    if (exists(cliEntry)) {
      return {
        command: execPath,
        args: scriptArgs(cliEntry),
        source: "checkout",
        describe: () => `${execPath} ${[...scriptArgs(cliEntry)].join(" ")}`,
      };
    }
  }

  return {
    command: "mygrace",
    args: [],
    source: "path",
    describe: () => "mygrace (resolved through PATH)",
  };
}
// END_BLOCK_LAUNCHER

// START_BLOCK_PROCESS
/** Parse `MYGRACE_MCP_TIMEOUT_MS`; ignore unset/invalid/non-positive values. */
export function resolveTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.MYGRACE_MCP_TIMEOUT_MS;
  if (raw === undefined || raw.trim() === "") return DEFAULT_TIMEOUT_MS;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_TIMEOUT_MS;
  return Math.floor(parsed);
}

export interface CliRunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  /** The child was killed because it exceeded the CLI budget. */
  timedOut: boolean;
  /** The child could not be started at all (ENOENT/EACCES). */
  launchError?: Error;
  /** Output exceeded CLI_MAX_BUFFER and was cut off. */
  outputTruncated?: boolean;
}

interface CliRunOptions {
  /** Working directory for the CLI child. Omitted when the project root is unreadable. */
  cwd?: string;
  timeoutMs?: number;
}

/**
 * Run the MyGRACE CLI once, capturing both streams.
 *
 * Follows `execFile` semantics: argv is an array (no shell, no interpolation),
 * which also keeps ids from being interpreted by a shell.
 */
export function runCli(
  launcher: CliLauncher,
  argv: readonly string[],
  options: CliRunOptions = {}
): Promise<CliRunResult> {
  const timeoutMs = options.timeoutMs ?? resolveTimeoutMs();
  return new Promise((settle) => {
    execFile(
      launcher.command,
      [...launcher.args, ...argv],
      {
        timeout: timeoutMs,
        maxBuffer: CLI_MAX_BUFFER,
        encoding: "utf8",
        env: { ...process.env },
        windowsHide: true,
        ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
      },
      (error, stdout, stderr) => {
        const out = typeof stdout === "string" ? stdout : "";
        const err = typeof stderr === "string" ? stderr : "";
        if (error === null || error === undefined) {
          settle({ exitCode: 0, stdout: out, stderr: err, timedOut: false });
          return;
        }
        const failure = error as NodeJS.ErrnoException & {
          code?: number | string;
          killed?: boolean;
        };
        if (failure.code === "ENOENT" || failure.code === "EACCES") {
          settle({ exitCode: 127, stdout: out, stderr: err, timedOut: false, launchError: failure });
          return;
        }
        if (failure.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") {
          settle({ exitCode: 1, stdout: out, stderr: err, timedOut: false, outputTruncated: true });
          return;
        }
        settle({
          exitCode: typeof failure.code === "number" ? failure.code : 1,
          stdout: out,
          stderr: err,
          timedOut: failure.killed === true,
        });
      }
    );
  });
}
// END_BLOCK_PROCESS


// START_BLOCK_PROJECT_MEMORY
/**
 * Which project do tool calls refer to when launched from outside a project?
 *
 * The harness spawns this stdio server with the harness launch directory, not
 * the session workspace. The instructions therefore require an explicit
 * `path`; to make later calls and the status panel follow the workspace, the
 * server remembers the last project root that an explicit call resolved to
 * (state file, best-effort, never fails a tool call).
 */
/** Override for tests/alternate profiles; default `$HOME/.mygrace/active-project`. */
export const ACTIVE_PROJECT_FILE_ENV = "MYGRACE_ACTIVE_PROJECT_FILE";

/** Path of the remembered-project state file (override via `MYGRACE_ACTIVE_PROJECT_FILE`). */
export function activeProjectFile(env: NodeJS.ProcessEnv = process.env): string {
  const override = env[ACTIVE_PROJECT_FILE_ENV];
  if (typeof override === "string" && override.trim() !== "") return resolve(override.trim());
  const home = typeof env.HOME === "string" && env.HOME.trim() !== "" ? env.HOME.trim() : homedir();
  return join(home, ".mygrace", "active-project");
}

/** The remembered project root, or undefined when absent/stale/not a MyGRACE project. */
export function readActiveProject(env: NodeJS.ProcessEnv = process.env): string | undefined {
  try {
    const value = readFileSync(activeProjectFile(env), "utf-8").trim();
    if (value === "") return undefined;
    const root = resolve(value);
    return existsSync(join(root, "docs", "graph-index.xml")) ? root : undefined;
  } catch {
    return undefined;
  }
}

/** Remember a valid project root (no-op for anything that is not a MyGRACE project). */
export function rememberActiveProject(root: string, env: NodeJS.ProcessEnv = process.env): void {
  try {
    const absolute = resolve(root);
    if (!existsSync(join(absolute, "docs", "graph-index.xml"))) return;
    const file = activeProjectFile(env);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, `${absolute}\n`, "utf-8");
  } catch {
    // The state file is an optimization; a failure must never fail a tool call.
  }
}

/**
 * Inject the remembered project when the caller omitted the root, and remember
 * an explicitly supplied valid root. Explicit arguments always win.
 */
export function applyProjectMemory(
  tool: ToolDefinition,
  args: ToolArgs,
  env: NodeJS.ProcessEnv = process.env
): ToolArgs {
  const explicit = args[tool.rootArg];
  if (typeof explicit === "string" && explicit.trim() !== "") {
    const root = resolve(explicit);
    if (existsSync(join(root, "docs", "graph-index.xml"))) rememberActiveProject(root, env);
    return args;
  }
  const remembered = readActiveProject(env);
  return remembered === undefined ? args : { ...args, [tool.rootArg]: remembered };
}
// END_BLOCK_PROJECT_MEMORY

// START_BLOCK_RESULTS
/** Join captured streams; keep them distinguishable when both are present. */
function outputSections(stdout: string, stderr: string): string {
  const out = stdout.trim();
  const err = stderr.trim();
  if (out !== "" && err !== "") return `${out}\n\n[stderr]\n${err}`;
  if (out !== "") return out;
  if (err !== "") return err;
  return "(no output)";
}

function textResult(text: string): CallToolResult {
  return { content: [{ type: "text", text }] };
}

function errorResult(text: string, error: Record<string, unknown>): CallToolResult {
  return {
    content: [{ type: "text", text }],
    isError: true,
    structuredContent: { ok: false, error },
  };
}

/** Success path: CLI stdout (+ stderr when present), plus the optional compact digest. */
function successResult(tool: ToolDefinition, args: ToolArgs, run: CliRunResult): CallToolResult {
  const useDigest =
    tool.digestOutput !== undefined && args.compact === true && args.format !== "json";
  if (!useDigest) return textResult(outputSections(run.stdout, run.stderr));

  const stdout = run.stdout.trim();
  if (stdout === "") return textResult(outputSections(run.stdout, run.stderr));
  const stderr = run.stderr.trim();
  const digest = (tool.digestOutput as (value: string) => string)(stdout);
  return textResult(stderr === "" ? digest : `${digest}\n\n[stderr]\n${stderr}`);
}

/** Failure path: classifier line + the full stdout/stderr so agents can recover (audit H-8). */
function failureResult(
  tool: ToolDefinition,
  argv: readonly string[],
  run: CliRunResult,
  launcher: CliLauncher
): CallToolResult {
  if (run.launchError !== undefined) {
    return errorResult(
      [
        `MYGRACE_LAUNCH_FAILED: cannot start the MyGRACE CLI via ${launcher.describe()}: ${run.launchError.message}`,
        "The MCP server found no usable MyGRACE executable.",
        "Fix: set MYGRACE_BIN to the mygrace executable, or run the server from a checkout/install that contains src/grace.ts.",
        `Command: mygrace ${argv.join(" ")}`,
      ].join("\n"),
      {
        code: "MYGRACE_LAUNCH_FAILED",
        tool: tool.name,
        command: launcher.command,
        message: run.launchError.message,
      }
    );
  }

  const header = run.timedOut
    ? `MYGRACE_TIMEOUT: the MyGRACE CLI did not finish within ${resolveTimeoutMs()} ms (raise MYGRACE_MCP_TIMEOUT_MS for long test runs).`
    : run.outputTruncated === true
      ? `MYGRACE_OUTPUT_TOO_LARGE: CLI output exceeded ${CLI_MAX_BUFFER} bytes and was truncated; run the CLI directly for the full log.`
      : `MYGRACE_EXIT_${run.exitCode}: ${tool.name} exited with code ${run.exitCode}.`;

  const text = [
    header,
    `Command: mygrace ${argv.join(" ")}`,
    "",
    outputSections(run.stdout, run.stderr),
  ].join("\n");

  const code = run.timedOut ? "MYGRACE_TIMEOUT" : run.outputTruncated === true ? "MYGRACE_OUTPUT_TOO_LARGE" : "MYGRACE_EXIT_NONZERO";
  return errorResult(text, {
    code,
    tool: tool.name,
    exitCode: run.exitCode,
    ...(run.timedOut ? { timeoutMs: resolveTimeoutMs() } : {}),
  });
}
// END_BLOCK_RESULTS

// START_BLOCK_SERVER
/**
 * Build the MCP server. The catalog in grace-mcp-commands.ts is the only source
 * of tool names, descriptions and schemas, so `tools/list`, validation and the
 * argv mapping cannot drift apart (audit M-14).
 */
export function createMcpServer(launcher: CliLauncher = resolveLauncher()): Server {
  const server = new Server(
    { name: "mygrace-mcp", version: pkg.version },
    {
      capabilities: { tools: {} },
      instructions:
        "MyGRACE exposes an index-first view of a MyGRACE project. ALWAYS pass the absolute project root " +
        "of the session workspace you are working in (`path`, or `projectRoot` for mygrace_show_file): the " +
        "harness starts this server in its launch directory, so an omitted root may point at the wrong " +
        "place. When omitted, resolution falls back to MYGRACE_PROJECT_ROOT, then the last project " +
        "remembered from an explicit call, then the server's working directory. The same rule applies to " +
        "the mygrace CLI: pass `--path <workspace>`. Tool errors return the full CLI stdout/stderr with " +
        "isError=true.",
    }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: TOOLS.map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
    })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request): Promise<CallToolResult> => {
    try {
      return await handleCallTool(launcher, request);
    } catch (error) {
      // ADR-8: an internal failure is one readable line, never a raw stack trace.
      return errorResult(
        `MYGRACE_MCP_INTERNAL: ${error instanceof Error ? error.message : String(error)}`,
        { code: "MYGRACE_MCP_INTERNAL" }
      );
    }
  });

  return server;
}

/** One `tools/call` request: validate → map → launch → format. */
async function handleCallTool(
  launcher: CliLauncher,
  request: { params: { name: string; arguments?: Record<string, unknown> } }
): Promise<CallToolResult> {
  const requestedName = request.params.name;
  const tool = getToolDefinition(requestedName);
  if (tool === undefined) {
    return errorResult(formatUnknownToolError(requestedName), {
      code: "UNKNOWN_TOOL",
      tool: requestedName,
      knownTools: TOOL_NAMES,
    });
  }

  // Validate before mapping: required arguments, types, enums, patterns,
  // unknown fields and schema defaults. This is what keeps `undefined` out of
  // the argv (audit M2/M3; `docs/modules/undefined.xml` regression).
  const validation = validateToolArgs(requestedName, request.params.arguments);
  if (!validation.ok) {
    return errorResult(formatToolArgError(tool, validation.issues), {
      code: "INVALID_TOOL_ARGUMENTS",
      tool: tool.name,
      issues: validation.issues,
    });
  }

  const args = applyProjectMemory(tool, validation.args);
  let argv: string[];
  try {
    argv = buildToolCommand(requestedName, args);
  } catch (error) {
    // Defensive only: validated arguments should always map. Never a stack trace.
    return errorResult(
      `MYGRACE_MAPPING_FAILED: ${tool.name}: ${error instanceof Error ? error.message : String(error)}`,
      { code: "MYGRACE_MAPPING_FAILED", tool: tool.name }
    );
  }

  const projectRoot = resolveProjectRoot(tool, args);
  const cwd = existsSync(projectRoot) ? projectRoot : undefined;
  const run = await runCli(launcher, argv, { cwd });

  if (run.launchError !== undefined || run.timedOut || run.outputTruncated === true || run.exitCode !== 0) {
    return failureResult(tool, argv, run, launcher);
  }
  return successResult(tool, args, run);
}
// END_BLOCK_SERVER

// START_BLOCK_ENTRY
function isEntryPoint(): boolean {
  const meta = import.meta as ImportMeta & { main?: boolean };
  if (typeof meta.main === "boolean") return meta.main;
  const entry = process.argv[1];
  return entry !== undefined && resolve(entry) === resolve(import.meta.dirname, "grace-mcp.ts");
}

async function main(): Promise<void> {
  const launcher = resolveLauncher();
  const server = createMcpServer(launcher);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // stderr only: stdout carries the MCP protocol.
  console.error(`MyGRACE MCP server v${pkg.version} on stdio (CLI launcher: ${launcher.describe()})`);
}

if (isEntryPoint()) {
  main().catch((error: unknown) => {
    console.error(`MyGRACE MCP failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  });
}
// END_BLOCK_ENTRY
