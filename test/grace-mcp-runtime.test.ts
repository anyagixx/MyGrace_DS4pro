/**
 * MyGRACE MCP server — runtime regression tests (audit C-3, H-8, M-12, M-14).
 *
 * These tests exercise the real artifact: a child Bun process running
 * src/grace-mcp.ts, spoken to through a real @modelcontextprotocol/sdk Client
 * over stdio. The child gets a scrubbed environment with PATH="" — the exact
 * scenario in which the audited v1 server failed every tool call with
 * `Executable not found in $PATH: "mygrace"`.
 *
 * Covered:
 *   - initialize handshake and the exact documented tool list (17 baseline tools
 *     + trace/impact/next/projects = 21; docs are updated by the docs owner);
 *   - successful calls (status, lint, show_module) on examples/demo-store;
 *   - `mygrace_trust` on a disposable copy of the demo project (never mutates
 *     examples/demo-store);
 *   - `path` omitted → server working directory; `MYGRACE_PROJECT_ROOT` fallback;
 *   - structured errors for missing/typed/enum/unknown arguments, with no
 *     `undefined` ever reaching the CLI (`docs/modules/undefined.xml` regression);
 *   - a broken MYGRACE_BIN yields MYGRACE_LAUNCH_FAILED, never a stack trace;
 *   - launcher/timeout resolution logic driven by the same environment variables.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { cpSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  CLI_MAX_BUFFER,
  DEFAULT_TIMEOUT_MS,
  activeProjectFile,
  applyProjectMemory,
  createMcpServer,
  readActiveProject,
  rememberActiveProject,
  resolveLauncher,
  resolveTimeoutMs,
} from "../src/grace-mcp";
import {
  TOOL_NAMES,
  TOOLS,
  buildToolCommand,
  formatToolArgError,
  getToolDefinition,
  resolveProjectRoot,
  validateToolArgs,
} from "../src/grace-mcp-commands";

const ROOT = resolve(import.meta.dirname, "..");
const MCP_ENTRY = resolve(ROOT, "src", "grace-mcp.ts");
const DEMO = resolve(ROOT, "examples", "demo-store");
/** Isolated remembered-project state file: tests never touch the real ~/.mygrace. */
const MEMORY_FILE = join(tmpdir(), `mygrace-mcp-memory-${process.pid}.json`);
afterAll(() => rmSync(MEMORY_FILE, { force: true }));
/** buildToolCommand resolves project roots; use the platform-native spelling. */
const P = resolve("/p");

/**
 * The expected MCP surface: the 17 v1.2 tools plus trace/impact/next/projects
 * (W3.4/3.5 = 21, W5.1 = 22). Renaming one is a breaking change; docs updates are owned by
 * the docs owner.
 */
const DOCUMENTED_TOOL_NAMES = [
  "mygrace_list_modules",
  "mygrace_show_module",
  "mygrace_show_phase",
  "mygrace_find_modules",
  "mygrace_phase_index",
  "mygrace_doctor",
  "mygrace_test",
  "mygrace_packet",
  "mygrace_focus",
  "mygrace_context_cost",
  "mygrace_verify",
  "mygrace_list_verifications",
  "mygrace_lint",
  "mygrace_show_file",
  "mygrace_status",
  "mygrace_trust",
  "mygrace_ci",
  "mygrace_trace",
  "mygrace_impact",
  "mygrace_next",
  "mygrace_projects",
  "mygrace_integrations",
];

/** Minimal valid arguments per tool, used to prove no `undefined` reaches argv. */
const MINIMAL_CALL_ARGS: Record<string, Record<string, unknown>> = {
  mygrace_list_modules: { path: DEMO },
  mygrace_show_module: { id: "M-CART", path: DEMO },
  mygrace_show_phase: { name: "Phase-1", path: DEMO },
  mygrace_find_modules: { path: DEMO },
  mygrace_phase_index: { path: DEMO },
  mygrace_doctor: { path: DEMO },
  mygrace_test: { path: DEMO },
  mygrace_packet: { id: "M-CART", path: DEMO },
  mygrace_focus: { id: "M-CART", path: DEMO },
  mygrace_context_cost: { path: DEMO },
  mygrace_verify: { path: DEMO },
  mygrace_list_verifications: { path: DEMO },
  mygrace_lint: { path: DEMO },
  mygrace_show_file: { path: "AGENTS.md", projectRoot: DEMO },
  mygrace_status: { path: DEMO },
  mygrace_trust: { path: DEMO },
  mygrace_ci: { path: DEMO },
  mygrace_trace: { id: "M-CART", path: DEMO },
  mygrace_impact: { path: DEMO, files: "src/cart/index.ts" },
  mygrace_next: { path: DEMO },
  mygrace_projects: { path: DEMO },
  mygrace_integrations: { path: DEMO },
};

/**
 * Minimal environment for the server child process: a deliberately empty PATH.
 * The server must locate the CLI through `process.execPath` (absolute) instead.
 */
function scrubbedEnv(extra: Record<string, string> = {}): Record<string, string> {
  return {
    PATH: "",
    HOME: process.env.HOME ?? "/tmp",
    TMPDIR: process.env.TMPDIR ?? "/tmp",
    MYGRACE_MCP_TIMEOUT_MS: "60000",
    MYGRACE_ACTIVE_PROJECT_FILE: MEMORY_FILE,
    ...extra,
  };
}

async function connectServer(options: {
  cwd: string;
  env?: Record<string, string>;
}): Promise<Client> {
  const client = new Client({ name: "mygrace-runtime-test", version: "1.0.0" }, { capabilities: {} });
  const transport = new StdioClientTransport({
    command: process.execPath, // absolute bun — no PATH lookup for the server itself
    args: ["run", MCP_ENTRY],
    env: scrubbedEnv(options.env),
    cwd: options.cwd,
    stderr: "ignore",
  });
  await client.connect(transport);
  return client;
}

function textOf(result: { content?: Array<{ type: string; text?: string }> }): string {
  return (result.content ?? [])
    .filter((block) => block.type === "text")
    .map((block) => block.text ?? "")
    .join("\n");
}

// ─── Catalog invariants (no server process needed) ─────────────────────

describe("MCP catalog", () => {
  test("exposes exactly the 22 expected tool names, in a stable order", () => {
    expect(TOOL_NAMES.join(",")).toBe(DOCUMENTED_TOOL_NAMES.join(","));
    expect(new Set(TOOL_NAMES).size).toBe(DOCUMENTED_TOOL_NAMES.length);
    expect(TOOLS.length).toBe(DOCUMENTED_TOOL_NAMES.length);
  });

  test("every tool description documents the project-root resolution order", () => {
    for (const tool of TOOLS) {
      expect(tool.description).toContain("MYGRACE_PROJECT_ROOT");
      expect(tool.description).toContain("working directory");
    }
  });

  test("project-root `path` is optional everywhere; show_file uses projectRoot", () => {
    for (const tool of TOOLS) {
      expect(tool.rootArg).toBe(tool.name === "mygrace_show_file" ? "projectRoot" : "path");
      expect(tool.inputSchema.properties[tool.rootArg]).toBeDefined();
      expect(tool.inputSchema.required ?? []).not.toContain(tool.rootArg);
    }
  });

  test("schema metadata is internally consistent (required fields exist, defaults valid)", () => {
    for (const tool of TOOLS) {
      const properties = tool.inputSchema.properties;
      for (const field of tool.inputSchema.required ?? []) {
        expect(properties[field]).toBeDefined();
      }
      for (const [field, spec] of Object.entries(properties)) {
        expect(spec.description.length).toBeGreaterThan(0);
        if (spec.enum !== undefined && spec.default !== undefined && typeof spec.default === "string") {
          expect(spec.enum).toContain(spec.default);
        }
        if (spec.pattern !== undefined) {
          const pattern = spec.pattern;
          expect(() => new RegExp(pattern)).not.toThrow();
        }
      }
    }
  });
});

// ─── Launcher resolution: the C-3 regression at unit level ─────────────

describe("CLI launcher resolution (no PATH dependency)", () => {
  test("a plain checkout runs src/grace.ts through the current runtime, not PATH", () => {
    const launcher = resolveLauncher({
      env: {},
      execPath: "/fake/bin/bun",
      moduleDir: join(ROOT, "src"),
      exists: (path) => path.replaceAll("\\", "/").endsWith("/src/grace.ts"),
      isBun: true,
    });
    expect(launcher.source).toBe("checkout");
    expect(launcher.command).toBe("/fake/bin/bun");
    expect(launcher.args).toEqual(["run", resolve(ROOT, "src", "grace.ts")]);
    expect(launcher.command).not.toBe("mygrace");
  });

  test("without bun, the same checkout is run with the runtime's native TS support", () => {
    const launcher = resolveLauncher({
      env: {},
      execPath: "/fake/bin/node",
      moduleDir: join(ROOT, "src"),
      exists: (path) => path.replaceAll("\\", "/").endsWith("/src/grace.ts"),
      isBun: false,
    });
    expect(launcher.command).toBe("/fake/bin/node");
    expect(launcher.args).toEqual([resolve(ROOT, "src", "grace.ts")]);
  });

  test("MYGRACE_BIN overrides the launcher", () => {
    const binary = resolveLauncher({ env: { MYGRACE_BIN: "/opt/mygrace/bin/mygrace" } });
    expect(binary).toMatchObject({ command: "/opt/mygrace/bin/mygrace", args: [], source: "env" });

    const script = resolveLauncher({
      env: { MYGRACE_BIN: resolve(ROOT, "src", "grace.ts") },
      execPath: "/fake/bin/bun",
      exists: () => true,
      isBun: true,
    });
    expect(script.command).toBe("/fake/bin/bun");
    expect(script.args).toEqual(["run", resolve(ROOT, "src", "grace.ts")]);
    expect(script.source).toBe("env");
  });

  test("falls back to `mygrace` on PATH only when no local CLI exists", () => {
    const launcher = resolveLauncher({
      env: {},
      moduleDir: "/nonexistent/mygrace/src",
      exists: () => false,
    });
    expect(launcher.command).toBe("mygrace");
    expect(launcher.args).toEqual([]);
    expect(launcher.source).toBe("path");
  });

  test("timeout is configurable via MYGRACE_MCP_TIMEOUT_MS and defaults to 120 s", () => {
    expect(resolveTimeoutMs({})).toBe(DEFAULT_TIMEOUT_MS);
    expect(DEFAULT_TIMEOUT_MS).toBe(120_000);
    expect(resolveTimeoutMs({ MYGRACE_MCP_TIMEOUT_MS: "2500" })).toBe(2500);
    expect(resolveTimeoutMs({ MYGRACE_MCP_TIMEOUT_MS: "0" })).toBe(DEFAULT_TIMEOUT_MS);
    expect(resolveTimeoutMs({ MYGRACE_MCP_TIMEOUT_MS: "-5" })).toBe(DEFAULT_TIMEOUT_MS);
    expect(resolveTimeoutMs({ MYGRACE_MCP_TIMEOUT_MS: "soon" })).toBe(DEFAULT_TIMEOUT_MS);
    expect(CLI_MAX_BUFFER).toBe(10 * 1024 * 1024);
  });
});

// ─── Argument validation: never emit `undefined` ───────────────────────

describe("MCP argument validation", () => {
  test("missing required arguments produce a structured issue naming the field", () => {
    const result = validateToolArgs("mygrace_show_module", { path: DEMO });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.issues.map((issue) => issue.field)).toContain("id");
    expect(result.issues[0]?.message).toContain("required argument is missing");

    const tool = getToolDefinition("mygrace_show_module");
    expect(tool).toBeDefined();
    const text = formatToolArgError(tool!, result.issues);
    expect(text).toContain("INVALID_TOOL_ARGUMENTS");
    expect(text).toContain("id");
    expect(text).toContain("Accepted arguments");
    expect(text).not.toContain("undefined");
  });

  test("wrong types, bad enums, bad id patterns and unknown fields are rejected", () => {
    const wrongType = validateToolArgs("mygrace_status", { path: 42 });
    expect(wrongType.ok).toBe(false);
    if (!wrongType.ok) expect(wrongType.issues[0]?.field).toBe("path");

    const badEnum = validateToolArgs("mygrace_list_modules", { path: DEMO, status: "maybe" });
    expect(badEnum.ok).toBe(false);
    if (!badEnum.ok) expect(badEnum.issues[0]?.message).toContain("must be one of");

    const traversal = validateToolArgs("mygrace_packet", { id: "../outside-secret" });
    expect(traversal.ok).toBe(false);
    if (!traversal.ok) expect(traversal.issues[0]?.field).toBe("id");

    const unknown = validateToolArgs("mygrace_status", { path: DEMO, bogus: true });
    expect(unknown.ok).toBe(false);
    if (!unknown.ok) expect(unknown.issues.map((issue) => issue.field)).toContain("bogus");
  });

  test("defaults are applied so declared schema defaults are real (audit M-14)", () => {
    const testResult = validateToolArgs("mygrace_test", { path: DEMO });
    expect(testResult.ok).toBe(true);
    if (testResult.ok) expect(testResult.args.compact).toBe(true);

    const lintResult = validateToolArgs("mygrace_lint", { path: DEMO });
    expect(lintResult.ok).toBe(true);
    if (lintResult.ok) expect(lintResult.args.compact).toBe(true);

    const listResult = validateToolArgs("mygrace_list_modules", { path: DEMO });
    expect(listResult.ok).toBe(true);
    if (listResult.ok) expect(listResult.args.format).toBe("text");

    const trustDefault = validateToolArgs("mygrace_trust", { path: DEMO });
    expect(trustDefault.ok).toBe(true);
    if (trustDefault.ok) expect(trustDefault.args.format).toBe("json");
  });

  test("mygrace_trust maps to the CLI trust command (json by default, text on request)", () => {
    const validated = validateToolArgs("mygrace_trust", { path: P });
    expect(validated.ok).toBe(true);
    if (!validated.ok) return;
    expect(buildToolCommand("mygrace_trust", validated.args)).toEqual(["trust", "--path", P, "--format", "json"]);
    expect(buildToolCommand("mygrace_trust", { path: P, format: "text" })).toEqual(["trust", "--path", P]);
  });

  test("buildToolCommand never emits `undefined` or a literal 'undefined' id", () => {
    for (const tool of TOOLS) {
      const args = MINIMAL_CALL_ARGS[tool.name];
      expect(args).toBeDefined();
      const argv = buildToolCommand(tool.name, args!);
      for (const value of argv) {
        expect(typeof value).toBe("string");
        expect(value).not.toBe("undefined");
        expect(value).not.toContain("undefined");
        expect(value).not.toContain("[object Object]");
      }
    }
    expect(() => buildToolCommand("mygrace_show_module", { path: DEMO })).toThrow(/missing required argument "id"/);
    expect(() => buildToolCommand("mygrace_bogus", {})).toThrow(/Unknown tool/);
  });

  test("advisory tools map to their CLI commands (trace/impact/next/projects)", () => {
    const map = (name: string, raw: Record<string, unknown>): string[] => {
      const validated = validateToolArgs(name, raw);
      expect(validated.ok).toBe(true);
      if (!validated.ok) return [];
      return buildToolCommand(name, validated.args);
    };

    expect(map("mygrace_trace", { id: "M-CART", path: P })).toEqual([
      "trace",
      "M-CART",
      "--path",
      P,
      "--format",
      "json",
    ]);
    expect(map("mygrace_trace", { id: "M-CART", path: P, code: true })).toEqual([
      "trace",
      "M-CART",
      "--path",
      P,
      "--code",
      "--format",
      "json",
    ]);
    expect(map("mygrace_impact", { path: P })).toEqual(["impact", "--path", P, "--format", "json"]);
    expect(map("mygrace_impact", { path: P, files: "src/a.ts", codeGraph: true })).toEqual([
      "impact",
      "--path",
      P,
      "--files",
      "src/a.ts",
      "--code-graph",
      "--format",
      "json",
    ]);
    expect(map("mygrace_integrations", { path: P })).toEqual([
      "integrations",
      "status",
      "--path",
      P,
      "--format",
      "json",
    ]);
    expect(map("mygrace_impact", { path: P, files: "src/a.ts,src/b.ts" })).toEqual([
      "impact",
      "--path",
      P,
      "--files",
      "src/a.ts,src/b.ts",
      "--format",
      "json",
    ]);
    expect(map("mygrace_impact", { path: P, staged: true, since: "HEAD~1", format: "text" })).toEqual([
      "impact",
      "--path",
      P,
      "--staged",
      "--since",
      "HEAD~1",
    ]);
    expect(map("mygrace_next", { path: P })).toEqual(["next", "--path", P, "--format", "json"]);
    expect(map("mygrace_projects", { path: P, depth: 3, strict: true })).toEqual([
      "projects",
      "--path",
      P,
      "--depth",
      "3",
      "--strict",
      "--format",
      "json",
    ]);
  });

  test("project root resolves explicit path → MYGRACE_PROJECT_ROOT → cwd", () => {
    const tool = getToolDefinition("mygrace_lint")!;
    expect(resolveProjectRoot(tool, { path: resolve("/explicit/root") }, { env: { MYGRACE_PROJECT_ROOT: "/env/root" }, cwd: "/cwd" })).toBe(
      resolve("/explicit/root")
    );
    // resolveProjectRoot resolves every source against cwd (platform-native).
    expect(resolveProjectRoot(tool, {}, { env: { MYGRACE_PROJECT_ROOT: "/env/root" }, cwd: "/cwd" })).toBe(
      resolve("/cwd", "/env/root")
    );
    expect(resolveProjectRoot(tool, {}, { env: {}, cwd: "/cwd" })).toBe(resolve("/cwd"));

    const showFile = getToolDefinition("mygrace_show_file")!;
    expect(
      resolveProjectRoot(showFile, { path: "src/a.ts", projectRoot: resolve("/explicit/root") }, { env: {}, cwd: "/cwd" })
    ).toBe(resolve("/explicit/root"));
  });
});

// ─── Real stdio server: handshake, tools, calls, errors ────────────────

describe("MCP server over stdio with an empty PATH (C-3 regression)", () => {
  let client: Client;

  beforeAll(async () => {
    // Scrubbed PATH: the old `execFile("mygrace", …)` implementation cannot work.
    // Working directory = demo project, so a call without `path` proves cwd default.
    client = await connectServer({ cwd: DEMO });
  }, 60_000);

  afterAll(async () => {
    await client?.close();
  });

  test("initialize handshake reports the mygrace-mcp server and tools capability", () => {
    const version = client.getServerVersion();
    expect(version?.name).toBe("mygrace-mcp");
    expect(version?.version).toMatch(/^\d+\.\d+\.\d+/);
    expect(client.getServerCapabilities()?.tools).toBeDefined();
  });

  test("tools/list returns the exact 22 expected tools with non-empty descriptions", async () => {
    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name)).toEqual(DOCUMENTED_TOOL_NAMES);
    for (const tool of tools) {
      expect(tool.description?.length ?? 0).toBeGreaterThan(20);
      expect(tool.inputSchema.type).toBe("object");
      expect(tool.inputSchema.properties).toBeDefined();
    }
  }, 30_000);

  test("mygrace_status succeeds and returns the project JSON", async () => {
    const result = await client.callTool({ name: "mygrace_status", arguments: { path: DEMO } });
    expect(result.isError).toBeFalsy();
    const text = textOf(result as { content?: Array<{ type: string; text?: string }> });
    expect(text).toContain("modules");
    const parsed = JSON.parse(text) as unknown;
    expect(parsed).toBeTruthy();
  }, 30_000);

  test("mygrace_lint succeeds and returns a compact digest (banner dropped, findings kept)", async () => {
    const result = await client.callTool({ name: "mygrace_lint", arguments: { path: DEMO } });
    expect(result.isError).toBeFalsy();
    const text = textOf(result as { content?: Array<{ type: string; text?: string }> });
    // The demo may legitimately carry warnings; the contract is: counts and
    // every finding come back, the decorative banner does not (compact: true).
    expect(text).toContain("Errors:");
    expect(text).toContain("Warnings:");
    expect(text).not.toContain("===================");
    expect(text).not.toContain("MyGRACE Lint Report");

    const full = await client.callTool({
      name: "mygrace_lint",
      arguments: { path: DEMO, compact: false },
    });
    expect(full.isError).toBeFalsy();
    const fullText = textOf(full as { content?: Array<{ type: string; text?: string }> });
    expect(fullText).toContain("MyGRACE Lint Report");
  }, 60_000);

  test("mygrace_show_module succeeds with an explicit id and path", async () => {
    const result = await client.callTool({
      name: "mygrace_show_module",
      arguments: { id: "M-CART", path: DEMO },
    });
    expect(result.isError).toBeFalsy();
    const text = textOf(result as { content?: Array<{ type: string; text?: string }> });
    expect(text).toContain("M-CART");
    expect(text.length).toBeGreaterThan(50);
  }, 30_000);

  test("omitting `path` falls back to the MCP server working directory", async () => {
    // The transport starts the server with cwd = examples/demo-store.
    const result = await client.callTool({ name: "mygrace_show_module", arguments: { id: "M-CART" } });
    expect(result.isError).toBeFalsy();
    const text = textOf(result as { content?: Array<{ type: string; text?: string }> });
    expect(text).toContain("M-CART");
  }, 30_000);

  test("missing required argument → structured INVALID_TOOL_ARGUMENTS, no undefined CLI call", async () => {
    const result = await client.callTool({ name: "mygrace_show_module", arguments: { path: DEMO } });
    expect(result.isError).toBe(true);
    const text = textOf(result as { content?: Array<{ type: string; text?: string }> });
    expect(text).toContain("INVALID_TOOL_ARGUMENTS");
    expect(text).toContain("id");
    expect(text).toContain("required argument is missing");
    // The audited failure mode: the mapper stringified the missing id and the
    // CLI was asked for docs/modules/undefined.xml.
    expect(text).not.toContain("undefined");
    expect(text).not.toContain("docs/modules/undefined.xml");

    const structured = (result as { structuredContent?: { error?: { code?: string; issues?: Array<{ field?: string }> } } })
      .structuredContent;
    expect(structured?.error?.code).toBe("INVALID_TOOL_ARGUMENTS");
    expect(structured?.error?.issues?.map((issue) => issue.field)).toContain("id");
  }, 30_000);

  test("wrong argument types are rejected before the CLI runs", async () => {
    const result = await client.callTool({ name: "mygrace_status", arguments: { path: 42 } });
    expect(result.isError).toBe(true);
    const text = textOf(result as { content?: Array<{ type: string; text?: string }> });
    expect(text).toContain("INVALID_TOOL_ARGUMENTS");
    expect(text).toContain("path");
    expect(text).toContain("expected a string");
  }, 30_000);

  test("unknown argument names are rejected with the offending field", async () => {
    const result = await client.callTool({ name: "mygrace_status", arguments: { path: DEMO, quoted: true } });
    expect(result.isError).toBe(true);
    const text = textOf(result as { content?: Array<{ type: string; text?: string }> });
    expect(text).toContain("INVALID_TOOL_ARGUMENTS");
    expect(text).toContain("quoted");
    expect(text).toContain("unknown argument");
  }, 30_000);

  test("unknown tool names return a structured UNKNOWN_TOOL error", async () => {
    const result = await client.callTool({ name: "mygrace_not_a_tool", arguments: {} });
    expect(result.isError).toBe(true);
    const text = textOf(result as { content?: Array<{ type: string; text?: string }> });
    expect(text).toContain("UNKNOWN_TOOL");
    expect(text).toContain("mygrace_status");
  }, 30_000);

  test("CLI failures keep stdout/stderr details and the exit code (H-8)", async () => {
    // M-NOPE is a valid id shape, so the request reaches the CLI, which exits 1.
    const result = await client.callTool({
      name: "mygrace_show_module",
      arguments: { id: "M-NOPE", path: DEMO },
    });
    expect(result.isError).toBe(true);
    const text = textOf(result as { content?: Array<{ type: string; text?: string }> });
    expect(text).toContain("MYGRACE_EXIT_1");
    expect(text).toContain("M-NOPE");
    // The old server replaced this with "Command failed"; the real diagnostics
    // (stderr from the CLI) must survive.
    expect(text).toContain("not found");
    const structured = (result as { structuredContent?: { error?: { code?: string; exitCode?: number } } })
      .structuredContent;
    expect(structured?.error?.code).toBe("MYGRACE_EXIT_NONZERO");
    expect(structured?.error?.exitCode).toBe(1);
  }, 30_000);

  test("mygrace_trust writes the record on a disposable copy (examples/demo-store untouched)", async () => {
    const scratch = mkdtempSync(join(ROOT, ".tmp-mcp-trust-"));
    const project = join(scratch, "demo-store");
    try {
      cpSync(DEMO, project, { recursive: true });
      const result = await client.callTool({ name: "mygrace_trust", arguments: { path: project } });
      expect(result.isError).toBeFalsy();
      const text = textOf(result as { content?: Array<{ type: string; text?: string }> });
      const envelope = JSON.parse(text) as {
        ok: boolean;
        exitCode: number;
        data?: { trusted?: boolean; recordPath?: string };
      };
      expect(envelope.ok).toBe(true);
      expect(envelope.exitCode).toBe(0);
      expect(envelope.data?.trusted).toBe(true);
      expect(existsSync(join(project, ".mygrace", "trust.json"))).toBe(true);
      // Never mutate the checked-in fixture.
      expect(existsSync(join(DEMO, ".mygrace"))).toBe(false);
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  }, 60_000);
});

// ─── MYGRACE_PROJECT_ROOT fallback over a second real server ───────────

describe("MCP server path resolution via MYGRACE_PROJECT_ROOT", () => {
  let client: Client;
  let emptyCwd: string;

  beforeAll(async () => {
    // An empty cwd with no docs/ tree: only the env var points at the demo project.
    emptyCwd = mkdtempSync(join(ROOT, ".tmp-mcp-root-"));
    client = await connectServer({ cwd: emptyCwd, env: { MYGRACE_PROJECT_ROOT: DEMO } });
  }, 60_000);

  afterAll(async () => {
    await client?.close();
    rmSync(emptyCwd, { recursive: true, force: true });
  });

  test("calls without `path` use MYGRACE_PROJECT_ROOT", async () => {
    // cwd is the repo root; only MYGRACE_PROJECT_ROOT points at the demo project.
    const result = await client.callTool({ name: "mygrace_show_module", arguments: { id: "M-CART" } });
    expect(result.isError).toBeFalsy();
    const text = textOf(result as { content?: Array<{ type: string; text?: string }> });
    expect(text).toContain("M-CART");
  }, 30_000);
});

// ─── Session workspace following (harness started outside a project) ───

describe("MCP server project memory (session started outside a project)", () => {
  test("remembers an explicit project root and reuses it when `path` is omitted", async () => {
    const memory = join(mkdtempSync(join(tmpdir(), "mygrace-mem-")), "active-project");
    const outside = mkdtempSync(join(tmpdir(), "mygrace-outside-"));
    const client = await connectServer({
      cwd: outside,
      env: { MYGRACE_ACTIVE_PROJECT_FILE: memory },
    });
    try {
      const first = await client.callTool({
        name: "mygrace_status",
        arguments: { path: DEMO },
      });
      expect(first.isError).toBeFalsy();
      // No `path`: the server must follow the remembered session workspace.
      const second = await client.callTool({ name: "mygrace_status", arguments: {} });
      expect(second.isError).toBeFalsy();
      const text = textOf(second as { content?: Array<{ type: string; text?: string }> });
      // Parse the envelope: JSON escapes Windows backslashes, so a substring
      // comparison against the native path would fail on Windows.
      const envelope = JSON.parse(text) as { data?: { project?: string } };
      expect(envelope.data?.project).toBe(resolve(DEMO));
    } finally {
      await client.close();
      rmSync(outside, { recursive: true, force: true });
      rmSync(memory, { force: true });
    }
  }, 60_000);
});

// ─── Launcher failure: broken MYGRACE_BIN → structured error, no stack ──

describe("MCP server launcher failure (broken MYGRACE_BIN)", () => {
  let client: Client;

  beforeAll(async () => {
    client = await connectServer({
      cwd: DEMO,
      env: { MYGRACE_BIN: join(ROOT, ".missing-mygrace-launcher", "mygrace") },
    });
  }, 60_000);

  afterAll(async () => {
    await client?.close();
  });

  test("returns structured MYGRACE_LAUNCH_FAILED without a stack trace", async () => {
    const result = await client.callTool({ name: "mygrace_status", arguments: { path: DEMO } });
    expect(result.isError).toBe(true);
    const text = textOf(result as { content?: Array<{ type: string; text?: string }> });
    expect(text).toContain("MYGRACE_LAUNCH_FAILED");
    expect(text).toContain("MYGRACE_BIN");
    expect(text).not.toContain("    at "); // no stack frames
    expect(text).not.toContain("Error: spawn");
    const structured = (result as { structuredContent?: { error?: { code?: string } } }).structuredContent;
    expect(structured?.error?.code).toBe("MYGRACE_LAUNCH_FAILED");
  }, 30_000);
});

// ─── Timeout: configurable CLI budget, structured error (M-12) ─────────

describe("MCP server CLI timeout", () => {
  let client: Client;

  beforeAll(async () => {
    client = await connectServer({ cwd: DEMO, env: { MYGRACE_MCP_TIMEOUT_MS: "1" } });
  }, 60_000);

  afterAll(async () => {
    await client?.close();
  });

  test("a CLI run exceeding MYGRACE_MCP_TIMEOUT_MS returns MYGRACE_TIMEOUT", async () => {
    const result = await client.callTool({ name: "mygrace_status", arguments: { path: DEMO } });
    expect(result.isError).toBe(true);
    const text = textOf(result as { content?: Array<{ type: string; text?: string }> });
    expect(text).toContain("MYGRACE_TIMEOUT");
    expect(text).toContain("MYGRACE_MCP_TIMEOUT_MS");
  }, 30_000);
});

// Keep `createMcpServer` covered as an API (the stdio tests already exercise it).
describe("createMcpServer", () => {
  test("returns a server instance with the mygrace-mcp identity", () => {
    const launcher = resolveLauncher({
      env: {},
      moduleDir: join(ROOT, "src"),
      exists: (path) => path.replaceAll("\\", "/").endsWith("/src/grace.ts"),
    });
    const server = createMcpServer(launcher);
    expect(server).toBeDefined();
    expect(typeof server.connect).toBe("function");
  });
});

// ─── Project memory helpers (unit) ─────────────────────────────────────

describe("project memory helpers", () => {
  const envFor = (file: string): NodeJS.ProcessEnv => ({ MYGRACE_ACTIVE_PROJECT_FILE: file });

  test("activeProjectFile honours the env override and defaults to $HOME/.mygrace/active-project", () => {
    expect(activeProjectFile(envFor("/tmp/state.json"))).toBe(resolve("/tmp/state.json"));
    const file = activeProjectFile({ HOME: "/home/example" });
    expect(file).toBe(join("/home/example", ".mygrace", "active-project"));
  });

  test("rememberActiveProject stores only real projects; readActiveProject rejects stale entries", () => {
    const file = join(mkdtempSync(join(tmpdir(), "mygrace-mem-unit-")), "active-project");
    try {
      rememberActiveProject(DEMO, envFor(file));
      expect(readActiveProject(envFor(file))).toBe(resolve(DEMO));

      writeFileSync(file, `${join(tmpdir(), "no-such-project")}\n`);
      expect(readActiveProject(envFor(file))).toBeUndefined();

      rememberActiveProject(join(tmpdir(), "no-such-project"), envFor(file));
      expect(readActiveProject(envFor(file))).toBeUndefined();
    } finally {
      rmSync(file, { force: true });
    }
  });

  test("applyProjectMemory prefers explicit args and injects the remembered root otherwise", () => {
    const file = join(mkdtempSync(join(tmpdir(), "mygrace-mem-apply-")), "active-project");
    const tool = getToolDefinition("mygrace_status")!;
    try {
      rememberActiveProject(DEMO, envFor(file));
      expect(applyProjectMemory(tool, {}, envFor(file)).path).toBe(resolve(DEMO));
      expect(applyProjectMemory(tool, { path: resolve("/explicit/root") }, envFor(file)).path).toBe(
        resolve("/explicit/root")
      );
      // A non-project explicit root does not replace the remembered valid one.
      applyProjectMemory(tool, { path: join(tmpdir(), "no-such-project") }, envFor(file));
      expect(readActiveProject(envFor(file))).toBe(resolve(DEMO));
    } finally {
      rmSync(file, { force: true });
    }
  });
});
