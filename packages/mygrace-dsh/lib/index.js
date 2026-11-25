// MyGRACE DSH bundle — host plugin (UNPUBLISHED PREVIEW, see README.md).
//
// NOT installed by `mygrace install-dsh` in v1.1: `--bundle` was removed because
// this package needs unpublished preview packages (and a private panel) and a
// local `dsh plugin add` does not install its file: dependencies into the
// profile. Kept for a future release decision; do not document it as a
// supported path.
//
// Mounts the MyGRACE MCP server (`bun run src/grace-mcp.ts` of
// mygrace-cli) into the DSH session by mounting @deepseek-ai/dsh-mcp-client
// programmatically. Absolute paths are resolved at runtime, so the static
// bundle patch stays path-free.

import { createRequire } from "node:module";
import { existsSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";

const name = "mygrace-dsh";
const inject = ["tools"];

const ROOT_DIR = path.resolve(fileURLToPath(new URL("../../../", import.meta.url)));

/** Find an executable with the given name on PATH (absolute path), or undefined. */
function findOnPath(name) {
  for (const dir of (process.env.PATH || "").split(path.delimiter)) {
    const candidate = path.join(dir, name);
    try {
      const stat = statSync(candidate);
      if (stat.isFile() && (stat.mode & 0o111)) return candidate;
    } catch {
      // not here
    }
  }
  return undefined;
}

/** Resolve the `bun` binary: process.execPath if bun, else first found on PATH, else "bun". */
export function resolveBun() {
  try {
    if (process.execPath.endsWith("bun")) return process.execPath;
  } catch {
    // ignore
  }
  for (const name of ["bun", "bunx"]) {
    const found = findOnPath(name);
    if (found) return found;
    try {
      const result = spawnSync(name, ["--version"], { stdio: "ignore" });
      if (result.status === 0) return name;
    } catch {
      // not on PATH
    }
  }
  return "bun";
}

/** Resolve the MCP server entry: src/grace-mcp.ts of mygrace-cli. */
export function resolveMcpEntry() {
  const require = createRequire(import.meta.url);
  try {
    const pkgPath = require.resolve("mygrace-cli/package.json");
    const entry = path.join(path.dirname(pkgPath), "src", "grace-mcp.ts");
    if (existsSync(entry)) return entry;
  } catch {
    // not resolvable via node_modules — fall back to the checkout root
  }
  const entry = path.join(ROOT_DIR, "src", "grace-mcp.ts");
  return existsSync(entry) ? entry : undefined;
}

/** The config to mount @deepseek-ai/dsh-mcp-client with, or undefined when unresolvable. */
export function resolveMcpConfig() {
  const entry = resolveMcpEntry();
  if (!entry) return undefined;
  return {
    transport: "stdio",
    serverName: "mygrace",
    command: resolveBun(),
    args: ["run", entry],
  };
}

/** Locate the @deepseek-ai/dsh-mcp-client entry path (without importing it). */
function resolveMcpClientPath() {
  // 1. From the plugin's own tree (installed in the same node_modules).
  try {
    return createRequire(import.meta.url).resolve("@deepseek-ai/dsh-mcp-client");
  } catch {
    // not resolvable from the plugin — try the next strategy
  }
  // 2. From the DSH process entrypoint (global install trees).
  if (process.argv[1]) {
    try {
      return createRequire(process.argv[1]).resolve("@deepseek-ai/dsh-mcp-client");
    } catch {
      // not resolvable — give up
    }
  }
  return undefined;
}

/** Mount the MCP client with the computed config. */
async function mountMcp(ctx) {
  const config = resolveMcpConfig();
  if (!config) {
    ctx.logger?.warn?.("mygrace-dsh (preview): MCP server not mounted (grace-mcp.ts not found)");
    return false;
  }
  const clientPath = resolveMcpClientPath();
  if (!clientPath) {
    ctx.logger?.warn?.("mygrace-dsh (preview): @deepseek-ai/dsh-mcp-client not resolvable — MCP server not mounted");
    return false;
  }
  let McpClient;
  try {
    McpClient = await import(pathToFileURL(clientPath).href);
  } catch {
    ctx.logger?.warn?.("mygrace-dsh (preview): import of @deepseek-ai/dsh-mcp-client failed — MCP server not mounted");
    return false;
  }
  await ctx.plugin(McpClient, config);
  return true;
}

async function apply(ctx, _config) {
  await mountMcp(ctx);
}

export { apply, inject, name };
