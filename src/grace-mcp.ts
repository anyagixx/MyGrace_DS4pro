#!/usr/bin/env bun
/**
 * MyGRACE MCP Server — exposes index-based grace-cli tools via Model Context Protocol.
 *
 * Tools:
 *   - mygrace_list_modules: List modules from graph-index.xml with optional status filter
 *   - mygrace_show_module: Show per-module file from docs/modules/
 *   - mygrace_show_phase: Show per-phase file from docs/plans/
 *   - mygrace_list_verifications: List verification entries from verification-index.xml
 *   - mygrace_lint: Integrity check including index synchronization
 *   - mygrace_show_file: File-local markup
 */

import { Server } from "@modelcontextprotocol/sdk/server";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { buildToolCommand, type ToolArgs } from "./grace-mcp-commands";

const exec = promisify(execFile);
const MYGRACE_BIN = process.env.MYGRACE_BIN || "mygrace";

const server = new Server({ name: "mygrace-mcp", version: "0.1.0" }, { capabilities: { tools: {} } });

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "mygrace_list_modules",
      description: "List modules from graph-index.xml (≤100 lines). Filter by status or type. This is the lazy-loading entry point — always start here.",
      inputSchema: {
        type: "object",
        properties: {
          path: { type: "string", description: "Project root path" },
          status: { type: "string", enum: ["pending", "wip", "done"], description: "Filter by status" },
          type: { type: "string", description: "Filter by module type" },
          format: { type: "string", enum: ["text", "json"], default: "text" },
        },
        required: ["path"],
      },
    },
    {
      name: "mygrace_show_module",
      description: "Show per-module file from docs/modules/M-XXX.xml (30-80 lines). Use after mygrace_list_modules to find the module ID.",
      inputSchema: {
        type: "object",
        properties: {
          id: { type: "string", description: "Module ID (e.g. M-AUTH)" },
          path: { type: "string", description: "Project root path" },
          withVerification: { type: "boolean", default: false, description: "Include verification file" },
        },
        required: ["id", "path"],
      },
    },
    {
      name: "mygrace_show_phase",
      description: "Show per-phase file from docs/plans/Phase-N.xml (50-200 lines). Use after mygrace_phase_index.",
      inputSchema: {
        type: "object",
        properties: {
          name: { type: "string", description: "Phase name (e.g. Phase-1)" },
          path: { type: "string", description: "Project root path" },
        },
        required: ["name", "path"],
      },
    },
    {
      name: "mygrace_list_verifications",
      description: "List verification entries from verification-index.xml (≤80 lines). Filter by priority.",
      inputSchema: {
        type: "object",
        properties: {
          path: { type: "string", description: "Project root path" },
          priority: { type: "string", enum: ["high", "medium", "low"], description: "Filter by priority" },
          format: { type: "string", enum: ["text", "json"], default: "text" },
        },
        required: ["path"],
      },
    },
    {
      name: "mygrace_lint",
      description: "Run MyGRACE integrity lint. Checks index synchronization, semantic markup, XML tag conventions.",
      inputSchema: {
        type: "object",
        properties: {
          path: { type: "string", description: "Project root path" },
          format: { type: "string", enum: ["text", "json"], default: "text" },
          allowMissingDocs: { type: "boolean", default: false },
        },
        required: ["path"],
      },
    },
    {
      name: "mygrace_show_file",
      description: "Show file-local MODULE_CONTRACT, MODULE_MAP, CHANGE_SUMMARY, contracts, and semantic blocks.",
      inputSchema: {
        type: "object",
        properties: {
          path: { type: "string", description: "File path to inspect" },
          projectRoot: { type: "string", description: "Project root" },
          contracts: { type: "boolean", default: false },
          blocks: { type: "boolean", default: false },
        },
        required: ["path", "projectRoot"],
      },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  try {
    const cmd = buildToolCommand(name, (args ?? {}) as ToolArgs);
    const { stdout, stderr } = await exec(MYGRACE_BIN, cmd, { env: { ...process.env }, timeout: 30_000 });
    if (stderr && !stdout) return { content: [{ type: "text", text: stderr }], isError: true };
    return { content: [{ type: "text", text: stdout.trim() }] };
  } catch (err: any) {
    return { content: [{ type: "text", text: `MyGRACE MCP error: ${err?.message || String(err)}` }], isError: true };
  }
});

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("MyGRACE MCP server running on stdio");
}

main().catch((err) => { console.error("MyGRACE MCP failed:", err); process.exit(1); });
