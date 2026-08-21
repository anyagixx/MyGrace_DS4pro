#!/usr/bin/env bun
/**
 * MyGRACE MCP Tool → CLI Command Mapping
 *
 * Pure mapping from MCP tool names and arguments to `mygrace` CLI argv.
 * Kept free of @modelcontextprotocol/sdk imports so unit tests can cover
 * every mapping without resolving the MCP SDK.
 */

export type ToolName =
  | "mygrace_list_modules"
  | "mygrace_show_module"
  | "mygrace_show_phase"
  | "mygrace_list_verifications"
  | "mygrace_lint"
  | "mygrace_show_file";

export type ToolArgs = Record<string, unknown>;

/** Build the `mygrace` CLI argv (without the binary) for one MCP tool call. */
export function buildToolCommand(name: string, args: ToolArgs): string[] {
  const path = typeof args.path === "string" ? args.path : ".";
  const projectRoot = typeof args.projectRoot === "string" ? args.projectRoot : ".";

  switch (name) {
    case "mygrace_list_modules": {
      const cmd = ["module", "list", "--path", path];
      if (typeof args.status === "string") cmd.push("--status", args.status);
      if (typeof args.type === "string") cmd.push("--type", args.type);
      if (args.format === "json") cmd.push("--format", "json");
      return cmd;
    }
    case "mygrace_show_module": {
      const cmd = ["module", "show", String(args.id), "--path", path];
      if (args.withVerification === true) cmd.push("--with-verification");
      return cmd;
    }
    case "mygrace_show_phase": {
      return ["phase", "show", String(args.name), "--path", path];
    }
    case "mygrace_list_verifications": {
      const cmd = ["verification", "index", "--path", path];
      if (typeof args.priority === "string") cmd.push("--priority", args.priority);
      if (args.format === "json") cmd.push("--format", "json");
      return cmd;
    }
    case "mygrace_lint": {
      const cmd = ["lint", "--path", path];
      if (args.format === "json") cmd.push("--format", "json");
      if (args.allowMissingDocs === true) cmd.push("--allow-missing-docs");
      return cmd;
    }
    case "mygrace_show_file": {
      const cmd = ["file", "show", String(args.path), "--root", projectRoot];
      if (args.contracts === true) cmd.push("--contracts");
      if (args.blocks === true) cmd.push("--blocks");
      return cmd;
    }
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

/** Names of every MCP tool this server exposes (for the ListTools handler). */
export const TOOL_NAMES: ToolName[] = [
  "mygrace_list_modules",
  "mygrace_show_module",
  "mygrace_show_phase",
  "mygrace_list_verifications",
  "mygrace_lint",
  "mygrace_show_file",
];
