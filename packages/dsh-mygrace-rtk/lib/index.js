// @osovv/dsh-mygrace-rtk — DSH tool-middleware plugin: prefix noisy commands with `rtk`.
//
// Wraps the `bash` tool via DSH's `tools/execute` around-dispatch hook:
// `git status` → `rtk git status` (RTK compresses test/log/git/ls/grep output
// before the agent reads it). Pass-through when rtk is missing or the
// command doesn't match. RTK itself preserves exit codes and never prints
// more than the raw command did.

import { statSync } from "node:fs";
import path from "node:path";

const name = "dsh-mygrace-rtk";
const inject = ["tools"];

/** Common dev commands RTK wraps (subset; see the RTK filter for the full list). */
const RTK_TOKENS = new Set([
  "git", "npm", "npx", "pnpm", "yarn", "bun", "bunx", "deno", "node",
  "cargo", "go", "rustc", "rustup", "pytest", "ruff", "eslint", "tsc",
  "vitest", "jest", "make", "docker", "kubectl", "ls", "tree", "grep", "rg",
  "find", "fd", "cat", "head", "tail", "sed", "awk", "sort", "uniq", "wc",
  "nl", "tar", "gzip", "zip", "unzip", "ssh", "scp", "curl", "wget", "openssl",
  "jq", "pv", "less", "more",
]);

/** Find an executable with the given name on PATH (absolute path), or undefined. */
function findOnPath(bin) {
  for (const dir of (process.env.PATH || "").split(path.delimiter)) {
    const candidate = path.join(dir, bin);
    try {
      const stat = statSync(candidate);
      if (stat.isFile() && (stat.mode & 0o111)) return candidate;
    } catch {
      // not here
    }
  }
  return undefined;
}

/**
 * Return the command rewritten with the rtk prefix, or undefined when not
 * applicable: non-string, already `rtk …`, or a command whose leading token
 * (basename, so absolute paths like /usr/bin/git are accepted) is not in
 * RTK_TOKENS.
 */
export function rewriteForRtk(command, rtkName = "rtk") {
  if (typeof command !== "string") return undefined;
  const trimmed = command.trim();
  if (!trimmed || trimmed.startsWith(`${rtkName} `)) return undefined;
  const m = trimmed.match(/^(\S+)\s/);
  if (!m) return undefined;
  if (!RTK_TOKENS.has(path.basename(m[1]))) return undefined;
  return `${rtkName} ${trimmed}`;
}

function apply(ctx, config = {}) {
  if (config.enabled === false) return;
  // rtkBinary: explicit binary path (tests/manual); rtkName: the command
  // prefix in the rewritten command (default: the binary basename or "rtk").
  const rtkBinary = config.rtkBinary || findOnPath(config.rtkName || "rtk");
  if (!rtkBinary) {
    ctx.logger?.warn?.("dsh-mygrace-rtk: rtk not on PATH — plugin inactive");
    return;
  }
  const rtkName = config.rtkName || path.basename(rtkBinary);
  ctx.on("tools/execute", async (exec, next) => {
    if (exec.name !== "bash") return next();
    const args = exec.arguments;
    const rewritten = rewriteForRtk(args?.command, rtkName);
    if (!rewritten) return next();
    exec.arguments = { ...args, command: rewritten };
    return next();
  });
}

export { apply, inject, name };
