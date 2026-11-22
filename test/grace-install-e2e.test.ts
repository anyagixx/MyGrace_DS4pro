/**
 * End-to-end tests for `mygrace install-dsh` (ROADMAP W1.4 acceptance).
 *
 * These spawn the real CLI in a subprocess against throwaway DSH homes under
 * `analysis/_w1-install/` (never the real `~/.dsh`), and assert the behaviours
 * the audit found missing in v1:
 *
 *   - install → idempotent → uninstall → byte-identical cordis.patch.yml;
 *   - malformed YAML exits 2 and is never touched;
 *   - a read-only profile dir exits 1 and leaves the file intact;
 *   - the generated MCP row works with an EMPTY PATH (absolute runtime +
 *     MYGRACE_BIN launcher), listing tools and calling one;
 *   - `--bundle` is gone and says why;
 *   - the opt-in LIVE status panel goes through a (fake) package manager and
 *     an ENOEXEC pnpm is reported actionably.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import YAML from "yaml";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import {
  MCP_ENTRY_ID,
  PANEL_ENTRY_ID,
  launcherPath,
  parsePatchContent,
  patchHasRow,
  profilePatchPath,
} from "../src/grace-install";

const ROOT = join(import.meta.dirname, "..");
const CLI = join(ROOT, "src", "grace.ts");
const BUN = process.execPath;
const FIXTURE_PROJECT = join(ROOT, "test", "fixtures", "mygrace-project");
const WORK_ROOT = join(ROOT, "analysis", "_w1-install");

/**
 * Work dirs are unique per process: other agents/CI may run `bun test`
 * concurrently in the same checkout, and a shared scratch dir would let one
 * run delete another run's fixtures. Only our own `baseDir` is ever removed.
 */
let baseDir: string;

beforeAll(() => {
  mkdirSync(WORK_ROOT, { recursive: true });
  baseDir = mkdtempSync(join(WORK_ROOT, `e2e-${process.pid}-`));
});

afterAll(() => {
  rmSync(baseDir, { recursive: true, force: true });
});

interface CliRun {
  status: number;
  stdout: string;
  stderr: string;
}

/** Home whose DSH runtime lives in `<home>/.dsh`. */
function makeHome(patchContent = "[]\n", options: { profileManifest?: boolean } = {}): { home: string; dshHome: string } {
  const home = mkdtempSync(join(baseDir, "home-"));
  const dshHome = join(home, ".dsh");
  mkdirSync(join(dshHome, "profiles", "web"), { recursive: true });
  writeFileSync(join(dshHome, "profiles", "web", "cordis.patch.yml"), patchContent);
  if (options.profileManifest === true) {
    writeFileSync(join(dshHome, "profiles", "web", "package.json"), '{"name":"dsh-profile-web","private":true,"dependencies":{}}\n');
  }
  return { home, dshHome };
}

function runCli(home: string, args: string[], extraEnv: Record<string, string> = {}): CliRun {
  const result = spawnSync(BUN, ["run", CLI, "install-dsh", "--dsh-home", join(home, ".dsh"), ...args], {
    cwd: ROOT,
    encoding: "utf-8",
    timeout: 120_000,
    env: {
      ...process.env,
      HOME: home,
      DSH_HOME: join(home, ".dsh"),
      ...extraEnv,
    },
  });
  return { status: result.status ?? -1, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

function sha256(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function readPatch(dshHome: string): string {
  return readFileSync(profilePatchPath(dshHome, "web"), "utf-8");
}

function extractMcpEntry(content: string): any {
  for (const row of parsePatchContent(content) as Array<Record<string, unknown>>) {
    if (row["id"] === MCP_ENTRY_ID) return row;
    const insert = row["insert"];
    if (Array.isArray(insert)) {
      for (const child of insert as Array<Record<string, any>>) if (child["id"] === MCP_ENTRY_ID) return child;
    }
  }
  throw new Error("mcp-mygrace row not found");
}

// ─── Lifecycle ──────────────────────────────────────────────────────────

describe("install-dsh lifecycle (subprocess)", () => {
  test("dry run plans actions without writing anything", () => {
    const original = "# patch\n[]\n";
    const { home, dshHome } = makeHome(original);
    const result = runCli(home, ["--dry-run"]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("would");
    expect(result.stdout).toContain("DRY RUN");
    expect(readPatch(dshHome)).toBe(original);
    expect(existsSync(join(dshHome, "skills"))).toBe(false);
    expect(existsSync(launcherPath(dshHome))).toBe(false);
  }, 60_000);

  test("install writes skills + PATH-free MCP row; the patch is valid YAML with the exact DSH row shape", () => {
    const { home, dshHome } = makeHome("# patch layer\n[]\n");
    const result = runCli(home, []);
    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");

    const patchPath = profilePatchPath(dshHome, "web");
    const content = readFileSync(patchPath, "utf-8");
    const rows = parsePatchContent(content);
    expect(patchHasRow(rows, MCP_ENTRY_ID)).toBe(true);
    const entry = extractMcpEntry(content);
    expect(entry.name).toBe("@deepseek-ai/dsh-mcp-client");
    expect(entry.config.transport).toBe("stdio");
    expect(entry.config.serverName).toBe("mygrace");
    expect(entry.config.command).toBe(BUN); // absolute, no bare "bun"/"mygrace"
    expect(entry.config.args[0]).toBe("run");
    expect(entry.config.args[1]).toBe(join(ROOT, "src", "grace-mcp.ts"));
    if (process.platform !== "win32") {
      const launcher = launcherPath(dshHome);
      expect(entry.config.env.MYGRACE_BIN).toBe(launcher);
      expect(existsSync(launcher)).toBe(true);
    }

    expect(existsSync(join(dshHome, "skills", "mygrace-status", "SKILL.md"))).toBe(true);
    expect(existsSync(join(dshHome, "skills", "mygrace-verification", "SKILL.md"))).toBe(true);
  }, 60_000);

  test("re-install is structurally idempotent (patch hash unchanged)", () => {
    const { home, dshHome } = makeHome();
    expect(runCli(home, []).status).toBe(0);
    const before = sha256(profilePatchPath(dshHome, "web"));
    const second = runCli(home, []);
    expect(second.status).toBe(0);
    expect(second.stdout).toContain("already present");
    expect(sha256(profilePatchPath(dshHome, "web"))).toBe(before);
    expect((readPatch(dshHome).match(/id: mcp-mygrace/gu) ?? []).length).toBe(1);
  }, 60_000);

  test("uninstall restores the patch byte-for-byte and removes skills/launcher/state/backups", () => {
    const original = "# profile patch\n- id: foreign\n  name: \"@example/foreign\"\n";
    const { home, dshHome } = makeHome(original);
    expect(runCli(home, []).status).toBe(0);
    expect(readPatch(dshHome)).not.toBe(original);

    const uninstall = runCli(home, ["--uninstall"]);
    expect(uninstall.status).toBe(0);
    expect(uninstall.stdout).toContain("Uninstall complete");
    expect(uninstall.stdout).not.toContain("restart the harness"); // no activation text after uninstall
    expect(sha256(profilePatchPath(dshHome, "web"))).toBe(sha256(join(dshHome, "profiles", "web", "cordis.patch.yml")));
    expect(readPatch(dshHome)).toBe(original);
    expect(existsSync(join(dshHome, "skills"))).toBe(false);
    if (process.platform !== "win32") expect(existsSync(join(dshHome, "mygrace"))).toBe(false);
    const residue = readFileSync(profilePatchPath(dshHome, "web"), "utf-8");
    expect(residue).toContain("foreign");
  }, 60_000);

  test("second uninstall is a calm no-op with exit 0", () => {
    const { home } = makeHome();
    expect(runCli(home, ["--uninstall"]).status).toBe(0);
  }, 60_000);
});

// ─── Failure honesty ────────────────────────────────────────────────────

describe("install-dsh failure honesty", () => {
  test("malformed user YAML exits 2 and the file is not touched", () => {
    const malformed = "not: [valid\n";
    const { home, dshHome } = makeHome(malformed);
    const result = runCli(home, []);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("CONFIG_INVALID");
    expect(readPatch(dshHome)).toBe(malformed);
    expect(existsSync(join(dshHome, "skills"))).toBe(false);
  }, 60_000);

  test("read-only profile dir exits 1 and leaves the patch unchanged", () => {
    if (process.platform === "win32") return;
    const { home, dshHome } = makeHome("[]\n");
    const profileDir = join(dshHome, "profiles", "web");
    chmodSync(profileDir, 0o555);
    try {
      const result = runCli(home, []);
      expect(result.status).toBe(1);
      // The backup is created before the write, so a read-only directory fails
      // at either step — both are honest, actionable errors.
      expect(result.stderr).toMatch(/CONFIG_(BACKUP|WRITE)_FAILED/u);
      expect(readPatch(dshHome)).toBe("[]\n");
    } finally {
      chmodSync(profileDir, 0o755);
    }
  }, 60_000);

  test("missing profile exits 1 with a PROFILE_NOT_FOUND hint (skills still installed)", () => {
    const home = mkdtempSync(join(baseDir, "home-"));
    mkdirSync(join(home, ".dsh"), { recursive: true });
    const result = runCli(home, []);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("PROFILE_NOT_FOUND");
    expect(existsSync(join(home, ".dsh", "skills", "mygrace-status"))).toBe(true);
  }, 60_000);

  test("--bundle is removed and explains why (exit 2)", () => {
    const { home } = makeHome();
    const result = runCli(home, ["--bundle"]);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("was removed in v1.1");
    expect(result.stderr).toContain("install-dsh");
  }, 60_000);
});

// ─── PATH-free MCP row (the point of the launcher) ──────────────────────

describe("generated MCP row runs with an empty PATH", () => {
  test("lists 15 tools and successfully calls mygrace_list_modules", async () => {
    const { home, dshHome } = makeHome();
    expect(runCli(home, []).status).toBe(0);

    const entry = extractMcpEntry(readPatch(dshHome));
    const transport = new StdioClientTransport({
      command: entry.config.command,
      args: entry.config.args,
      // Deliberately no PATH: the row must not depend on `mygrace`/`bun`.
      env: { ...(entry.config.env ?? {}), HOME: home, PATH: "" },
      stderr: "pipe",
    });
    const client = new Client({ name: "mygrace-e2e", version: "1.0.0" }, { capabilities: {} });
    try {
      await client.connect(transport);
      const tools = await client.listTools();
      // ADR-8: the MCP server grows over time (15+ tools); the installer only
      // has to guarantee the row works, not freeze the tool count.
      expect(tools.tools.length).toBeGreaterThanOrEqual(15);
      expect(tools.tools.map((tool) => tool.name)).toContain("mygrace_list_modules");
      const result = (await client.callTool({
        name: "mygrace_list_modules",
        arguments: { path: FIXTURE_PROJECT },
      })) as { isError?: boolean; content?: Array<{ type: string; text?: string }> };
      expect(result.isError).not.toBe(true);
      expect(result.content?.[0]?.text ?? "").toContain("Modules");
    } finally {
      await client.close().catch(() => {});
    }
  }, 60_000);
});

// ─── Decorative panel (opt-in, fake package manager) ────────────────────

const FAKE_PNPM = `#!/usr/bin/env bun
import { readFileSync, writeFileSync } from "node:fs";
const [command, spec] = process.argv.slice(2);
const manifestPath = process.cwd() + "/package.json";
const pkg = JSON.parse(readFileSync(manifestPath, "utf8"));
pkg.dependencies ??= {};
if (command === "add") {
  pkg.dependencies["mygrace-status-panel"] = spec;
  writeFileSync(manifestPath, JSON.stringify(pkg, null, 2) + "\\n");
  process.exit(0);
}
if (command === "remove") {
  delete pkg.dependencies["mygrace-status-panel"];
  writeFileSync(manifestPath, JSON.stringify(pkg, null, 2) + "\\n");
  process.exit(0);
}
process.exit(1);
`;

function makeFakeBin(script: string | null): string {
  const binDir = mkdtempSync(join(baseDir, "bin-"));
  if (script !== null) {
    const file = join(binDir, "pnpm");
    writeFileSync(file, script, { mode: 0o755 });
    chmodSync(file, 0o755);
  }
  // No real `dsh`/`pnpm`: only our fake bin dir and the bun runtime directory.
  return `${binDir}:${dirname(process.execPath)}`;
}

// The fake package manager is a POSIX shell script; covered on ubuntu/macos.
describe.skipIf(process.platform === "win32")("LIVE status panel (--panel)", () => {
  test("installs the package + row via the package manager; uninstall removes both and restores the patch", () => {
    const original = "# panel test\n[]\n";
    const { home, dshHome } = makeHome(original, { profileManifest: true });
    const env = { PATH: makeFakeBin(FAKE_PNPM) };
    const install = runCli(home, ["--panel"], env);
    expect(install.status).toBe(0);
    const content = readPatch(dshHome);
    expect(patchHasRow(parsePatchContent(content), PANEL_ENTRY_ID)).toBe(true);
    const manifest = JSON.parse(readFileSync(join(dshHome, "profiles", "web", "package.json"), "utf-8"));
    expect(manifest.dependencies["mygrace-status-panel"]).toContain("file:");
    // The mcp row is still there too.
    expect(patchHasRow(parsePatchContent(content), MCP_ENTRY_ID)).toBe(true);

    const uninstall = runCli(home, ["--uninstall"], env);
    expect(uninstall.status).toBe(0);
    expect(readPatch(dshHome)).toBe(original);
    const after = JSON.parse(readFileSync(join(dshHome, "profiles", "web", "package.json"), "utf-8"));
    expect(after.dependencies["mygrace-status-panel"]).toBeUndefined();
  }, 90_000);

  test("an ENOEXEC package manager fails the component (exit 1) with an actionable hint; no row is written", () => {
    const { home, dshHome } = makeHome("[]\n", { profileManifest: true });
    const env = { PATH: makeFakeBin("not an executable script") };
    const result = runCli(home, ["--panel"], env);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("PANEL_INSTALL_FAILED");
    expect(result.stderr).toContain("ENOEXEC");
    expect(patchHasRow(parsePatchContent(readPatch(dshHome)), PANEL_ENTRY_ID)).toBe(false);
  }, 90_000);
});
