import { afterEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import YAML from "yaml";
import {
  MCP_ENTRY_ID,
  PANEL_ENTRY_ID,
  atomicWriteFile,
  beginMarker,
  cleanupBackups,
  createTimestampedBackup,
  endMarker,
  insertRowInPatch,
  launcherPath,
  launcherScript,
  listBackupFiles,
  mcpPatchRow,
  mcpServerEntryPath,
  panelPatchRow,
  parsePatchContent,
  patchHasRow,
  profilePatchPath,
  removeRowFromPatch,
  runInstall,
  skillSourceDirs,
  writeLauncherFile,
} from "../src/grace-install";
import { ConfigError, EXIT, MyGraceError } from "../src/grace-errors";

const created: string[] = [];

function tempDir(prefix = "mygrace-unit-"): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  created.push(dir);
  return dir;
}

/** Home with an initialized `web` profile (patch written by the caller). */
function tempHome(patchContent = "[]\n"): string {
  const home = tempDir("mygrace-home-");
  mkdirSync(join(home, "profiles", "web"), { recursive: true });
  writeFileSync(join(home, "profiles", "web", "cordis.patch.yml"), patchContent);
  return home;
}

afterEach(() => {
  for (const dir of created.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function extractRow(content: string, id: string): Record<string, any> {
  const rows = parsePatchContent(content);
  for (const row of rows as Array<Record<string, unknown>>) {
    if (row["id"] === id) return row as Record<string, any>;
    const insert = row["insert"];
    if (Array.isArray(insert)) {
      for (const child of insert as Array<Record<string, any>>) if (child["id"] === id) return child;
    }
  }
  throw new Error(`row ${id} not found`);
}

// ─── Patch parsing/validation ───────────────────────────────────────────

describe("parsePatchContent", () => {
  test("parses an array of loader rows", () => {
    const rows = parsePatchContent("- id: a\n  name: x\n- insert:\n    - id: b\n");
    expect(rows).toHaveLength(2);
    expect((rows[0] as any).id).toBe("a");
  });

  test("empty and comment-only documents count as an empty patch", () => {
    expect(parsePatchContent("")).toEqual([]);
    expect(parsePatchContent("# only comments\n\n")).toEqual([]);
    expect(parsePatchContent("[]\n")).toEqual([]);
  });

  test("malformed YAML throws a ConfigError with exit code 2 and a refusal hint", () => {
    let error: unknown;
    try {
      parsePatchContent("not: [valid\n", "cordis.patch.yml");
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(ConfigError);
    expect((error as ConfigError).exitCode).toBe(EXIT.USAGE);
    expect((error as ConfigError).message).toContain("Refusing to edit");
    expect((error as ConfigError).hint).toContain("never rewrites");
  });

  test("a non-array top-level value is refused", () => {
    expect(() => parsePatchContent("foo: bar\n")).toThrow(ConfigError);
  });
});

// ─── Structural idempotency ─────────────────────────────────────────────

describe("patchHasRow (structural, not substring)", () => {
  test("finds bare rows and insert-wrapped children", () => {
    const rows = parsePatchContent("- id: bare\n- insert:\n    - id: nested\n");
    expect(patchHasRow(rows, "bare")).toBe(true);
    expect(patchHasRow(rows, "nested")).toBe(true);
    expect(patchHasRow(rows, "missing")).toBe(false);
  });

  test("does not match a longer id that starts with ours (v1 substring bug)", () => {
    const rows = parsePatchContent("- insert:\n    - id: mcp-mygrace-extra\n");
    expect(patchHasRow(rows, MCP_ENTRY_ID)).toBe(false);
  });
});

// ─── Managed rows ───────────────────────────────────────────────────────

describe("mcpPatchRow", () => {
  test("has the exact DSH shape: insert / dsh-mcp-client / stdio transport", () => {
    const row = mcpPatchRow() as any;
    expect(Array.isArray(row.insert)).toBe(true);
    const entry = row.insert[0];
    expect(entry.id).toBe(MCP_ENTRY_ID);
    expect(entry.name).toBe("@deepseek-ai/dsh-mcp-client");
    expect(entry.config.transport).toBe("stdio");
    expect(entry.config.serverName).toBe("mygrace");
    // PATH-free: the command is the ABSOLUTE runtime that is executing us.
    expect(entry.config.command).toBe(process.execPath);
    expect(entry.config.args).toEqual(["run", mcpServerEntryPath()]);
    expect(entry.config.args[1].startsWith("/") || /^[A-Za-z]:\\/u.test(entry.config.args[1])).toBe(true);
  });

  test("adds MYGRACE_BIN when a launcher is supplied (POSIX)", () => {
    if (process.platform === "win32") return;
    const entry = (mcpPatchRow({ launcher: "/tmp/x/mygrace" }) as any).insert[0];
    expect(entry.config.env).toEqual({ MYGRACE_BIN: "/tmp/x/mygrace" });
  });

  test("panel row shape stays insert-wrapped", () => {
    const row = panelPatchRow() as any;
    expect(row.insert[0].id).toBe(PANEL_ENTRY_ID);
    expect(row.insert[0].name).toBe("mygrace-status-panel");
  });
});

describe("insertRowInPatch / removeRowFromPatch", () => {
  test("inserts into an empty array literal and keeps comments", () => {
    const original = "# profile patch\n[]\n";
    const edit = insertRowInPatch(original, mcpPatchRow(), MCP_ENTRY_ID);
    expect(edit.changed).toBe(true);
    expect(edit.content).toContain("# profile patch");
    expect(edit.content).toContain(beginMarker(MCP_ENTRY_ID));
    expect(edit.content).toContain(endMarker(MCP_ENTRY_ID));
    expect(patchHasRow(parsePatchContent(edit.content), MCP_ENTRY_ID)).toBe(true);
  });

  test("is structurally idempotent", () => {
    const once = insertRowInPatch("[]\n", mcpPatchRow(), MCP_ENTRY_ID).content;
    const twice = insertRowInPatch(once, mcpPatchRow(), MCP_ENTRY_ID);
    expect(twice.changed).toBe(false);
    expect(twice.content).toBe(once);
  });

  test("appends after foreign rows and preserves them", () => {
    const original = '- id: foreign\n  name: "@example/foreign"\n';
    const edit = insertRowInPatch(original, panelPatchRow(), PANEL_ENTRY_ID);
    expect(edit.content).toContain("foreign");
    expect(edit.content.indexOf("foreign")).toBeLessThan(edit.content.indexOf(PANEL_ENTRY_ID));
  });

  test.each([
    ["empty array literal", "[]\n"],
    ["array literal with comment", "# keep me\n[]\n"],
    ["foreign rows", '- id: foreign\n  name: "@example/x"\n'],
    ["foreign rows without trailing newline", '- id: foreign\n  name: "@example/x"'],
    ["DSH-like template", "# Your patch layer\n# a top-level YAML array\n[]\n"],
  ])("uninstall restores the original bytes exactly: %s", (_label, original) => {
    const added = insertRowInPatch(original, mcpPatchRow(), MCP_ENTRY_ID);
    expect(added.changed).toBe(true);
    const removed = removeRowFromPatch(added.content, MCP_ENTRY_ID);
    expect(removed.changed).toBe(true);
    expect(removed.content).toBe(original);
  });

  test("removes the MCP row and keeps the panel row independent", () => {
    let content = insertRowInPatch("[]\n", mcpPatchRow(), MCP_ENTRY_ID).content;
    content = insertRowInPatch(content, panelPatchRow(), PANEL_ENTRY_ID).content;
    const withoutMcp = removeRowFromPatch(content, MCP_ENTRY_ID);
    expect(patchHasRow(parsePatchContent(withoutMcp.content), MCP_ENTRY_ID)).toBe(false);
    expect(patchHasRow(parsePatchContent(withoutMcp.content), PANEL_ENTRY_ID)).toBe(true);
    const withoutPanel = removeRowFromPatch(content, PANEL_ENTRY_ID);
    expect(patchHasRow(parsePatchContent(withoutPanel.content), PANEL_ENTRY_ID)).toBe(false);
    expect(patchHasRow(parsePatchContent(withoutPanel.content), MCP_ENTRY_ID)).toBe(true);
  });

  test("removing an absent row is a no-op", () => {
    const edit = removeRowFromPatch("[]\n", MCP_ENTRY_ID);
    expect(edit.changed).toBe(false);
    expect(edit.content).toBe("[]\n");
  });

  test("removes a v1 marker-less row (legacy format) structurally", () => {
    const legacy = [
      "- id: other",
      "  name: x",
      "- insert:",
      "    - id: mcp-mygrace",
      "      name: '@deepseek-ai/dsh-mcp-client'",
      "      config:",
      "        transport: stdio",
      "",
    ].join("\n");
    const edit = removeRowFromPatch(legacy, MCP_ENTRY_ID);
    expect(edit.changed).toBe(true);
    expect(edit.content).toContain("other");
    expect(edit.content).not.toContain(MCP_ENTRY_ID);
    expect(patchHasRow(parsePatchContent(edit.content), MCP_ENTRY_ID)).toBe(false);
  });

  test("never writes when the input YAML is invalid", () => {
    expect(() => insertRowInPatch("not: [valid\n", mcpPatchRow(), MCP_ENTRY_ID)).toThrow(ConfigError);
    expect(() => removeRowFromPatch("not: [valid\n", MCP_ENTRY_ID)).toThrow(ConfigError);
  });
});

// ─── Atomic writes / backups ────────────────────────────────────────────

describe("atomicWriteFile", () => {
  // POSIX file-mode semantics (chmod bits) do not exist on Windows.
  test.skipIf(process.platform === "win32")("writes the content atomically and preserves the previous file mode", () => {
    const dir = tempDir();
    const file = join(dir, "cordis.patch.yml");
    writeFileSync(file, "[]\n", { mode: 0o600 });
    chmodSync(file, 0o600);
    atomicWriteFile(file, "- insert: []\n");
    expect(readFileSync(file, "utf-8")).toBe("- insert: []\n");
    expect(statSync(file).mode & 0o777).toBe(0o600);
    // No tmp files left behind.
    expect(readdirSync(dir).filter((name) => name.includes(".mygrace-tmp-"))).toHaveLength(0);
  });

  test.skipIf(process.platform === "win32")("throws a typed error (exit 1) and leaves the original intact when the directory is read-only", () => {
    const dir = tempDir();
    const sub = join(dir, "readonly");
    mkdirSync(sub);
    const file = join(sub, "cordis.patch.yml");
    writeFileSync(file, "[]\n");
    chmodSync(sub, 0o555);
    try {
      let error: unknown;
      try {
        atomicWriteFile(file, "changed\n");
      } catch (caught) {
        error = caught;
      }
      expect(error).toBeInstanceOf(MyGraceError);
      expect((error as MyGraceError).code).toBe("CONFIG_WRITE_FAILED");
      expect((error as MyGraceError).exitCode).toBe(EXIT.FINDINGS);
      expect(readFileSync(file, "utf-8")).toBe("[]\n");
    } finally {
      chmodSync(sub, 0o755);
    }
  });
});

describe("timestamped backups", () => {
  test("never overwrite an existing backup", () => {
    const dir = tempDir();
    const file = join(dir, "cordis.patch.yml");
    writeFileSync(file, "one\n");
    const first = createTimestampedBackup(file);
    writeFileSync(file, "two\n");
    const second = createTimestampedBackup(file);
    expect(first).not.toBe(second);
    expect(readFileSync(first, "utf-8")).toBe("one\n");
    expect(readFileSync(second, "utf-8")).toBe("two\n");
    expect(listBackupFiles(file)).toHaveLength(2);
    cleanupBackups(file);
    expect(listBackupFiles(file)).toHaveLength(0);
  });
});

// ─── PATH-free launcher ─────────────────────────────────────────────────

describe("PATH-free launcher", () => {
  test("script quotes the runtime and CLI entry and forwards arguments", () => {
    const script = launcherScript("/usr/bin/bun", "/repo/src/grace.ts");
    expect(script.startsWith("#!/bin/sh\n")).toBe(true);
    expect(script).toContain("exec '/usr/bin/bun' 'run' '/repo/src/grace.ts' \"$@\"");
  });

  test("writes an executable launcher that runs the CLI without PATH", () => {
    if (process.platform === "win32") return;
    const home = tempHome();
    const result = writeLauncherFile(home);
    expect(result.path).toBe(launcherPath(home));
    const path = launcherPath(home);
    expect(statSync(path).mode & 0o111).toBeGreaterThan(0);
    const run = spawnSync(path, ["--version"], {
      env: { PATH: "/nonexistent", HOME: home },
      encoding: "utf-8",
    });
    expect(run.status).toBe(0);
    expect(run.stdout.trim()).toMatch(/^\d+\.\d+\.\d+/u);
  });
});

// ─── runInstall (unit integration) ──────────────────────────────────────

describe("runInstall", () => {
  test("dry run is a true no-op", () => {
    const home = tempHome("# c\n[]\n");
    const patch = profilePatchPath(home, "web");
    const before = readFileSync(patch, "utf-8");
    const result = runInstall({ home, profile: "web", dryRun: true });
    expect(result.exitCode).toBe(EXIT.OK);
    expect(result.actions.some((a) => a.message.startsWith("would"))).toBe(true);
    expect(readFileSync(patch, "utf-8")).toBe(before);
    expect(existsSync(join(home, "skills"))).toBe(false);
    expect(existsSync(launcherPath(home))).toBe(false);
  });

  test("install → idempotent → uninstall restores the patch byte-for-byte", () => {
    const original = "# profile patch\n[]\n";
    const home = tempHome(original);
    const patch = profilePatchPath(home, "web");

    const install = runInstall({ home, profile: "web" });
    expect(install.exitCode).toBe(EXIT.OK);
    expect(install.problems).toEqual([]);
    const installed = readFileSync(patch, "utf-8");
    expect(patchHasRow(parsePatchContent(installed), MCP_ENTRY_ID)).toBe(true);
    expect(skillSourceDirs().length).toBeGreaterThan(0);
    expect(existsSync(join(home, "skills", "mygrace-status", "SKILL.md"))).toBe(true);
    if (process.platform !== "win32") expect(existsSync(launcherPath(home))).toBe(true);
    expect(existsSync(join(home, "mygrace", "state.json"))).toBe(true);

    const reinstall = runInstall({ home, profile: "web" });
    expect(reinstall.exitCode).toBe(EXIT.OK);
    expect(readFileSync(patch, "utf-8")).toBe(installed); // idempotent

    const uninstall = runInstall({ home, profile: "web", uninstall: true });
    expect(uninstall.exitCode).toBe(EXIT.OK);
    expect(readFileSync(patch, "utf-8")).toBe(original); // byte-identical
    expect(existsSync(join(home, "skills"))).toBe(false);
    if (process.platform !== "win32") expect(existsSync(join(home, "mygrace"))).toBe(false);
    expect(listBackupFiles(patch)).toHaveLength(0);

    // A second uninstall is a calm no-op.
    const again = runInstall({ home, profile: "web", uninstall: true });
    expect(again.exitCode).toBe(EXIT.OK);
  });

  test("missing profile is reported with exit 1 but skills/launcher are installed", () => {
    const home = tempDir("mygrace-home-");
    const result = runInstall({ home, profile: "web" });
    expect(result.exitCode).toBe(EXIT.FINDINGS);
    expect(result.problems.map((p) => p.code)).toContain("PROFILE_NOT_FOUND");
    expect(existsSync(join(home, "skills", "mygrace-status"))).toBe(true);
  });

  test("unparseable user YAML exits 2 and writes nothing (fatal preflight)", () => {
    const home = tempHome("not: [valid\n");
    const patch = profilePatchPath(home, "web");
    const before = readFileSync(patch, "utf-8");
    const result = runInstall({ home, profile: "web" });
    expect(result.exitCode).toBe(EXIT.USAGE);
    expect(result.problems[0]?.code).toBe("CONFIG_INVALID");
    expect(readFileSync(patch, "utf-8")).toBe(before);
    expect(existsSync(join(home, "skills"))).toBe(false);
  });

  test("read-only profile directory exits 1 and leaves the patch unchanged", () => {
    if (process.platform === "win32" || typeof process.getuid === "function" && process.getuid() === 0) return;
    const home = tempHome("[]\n");
    const profileDir = join(home, "profiles", "web");
    const patch = profilePatchPath(home, "web");
    chmodSync(profileDir, 0o555);
    try {
      const result = runInstall({ home, profile: "web" });
      expect(result.exitCode).toBe(EXIT.FINDINGS);
      const codes = result.problems.map((p) => p.code);
      // The backup is created before the write, so a read-only directory fails
      // at either step — both are honest, actionable errors.
      expect(codes.some((code) => code === "CONFIG_BACKUP_FAILED" || code === "CONFIG_WRITE_FAILED")).toBe(true);
      expect(readFileSync(patch, "utf-8")).toBe("[]\n");
    } finally {
      chmodSync(profileDir, 0o755);
    }
  });

  test("a patch edited by the user after install is not clobbered by uninstall", () => {
    const home = tempHome("# mine\n[]\n");
    const patch = profilePatchPath(home, "web");
    expect(runInstall({ home, profile: "web" }).exitCode).toBe(EXIT.OK);
    // The user appends their own row after installing MyGRACE.
    const edited = `${readFileSync(patch, "utf-8")}- id: user-row\n  name: "@me/thing"\n`;
    writeFileSync(patch, edited);
    const uninstall = runInstall({ home, profile: "web", uninstall: true });
    expect(uninstall.exitCode).toBe(EXIT.OK);
    const after = readFileSync(patch, "utf-8");
    expect(after).toContain("user-row"); // user edit preserved
    expect(after).not.toContain(MCP_ENTRY_ID); // our row removed
    expect(patchHasRow(parsePatchContent(after), MCP_ENTRY_ID)).toBe(false);
  });

  test("dry-run uninstall never writes installer state or files", () => {
    const home = tempHome("# c\n[]\n");
    const patch = profilePatchPath(home, "web");
    const stateFile = join(home, "mygrace", "state.json");
    expect(runInstall({ home, profile: "web" }).exitCode).toBe(EXIT.OK);
    const installed = readFileSync(patch, "utf-8");
    const state = readFileSync(stateFile, "utf-8");
    const dry = runInstall({ home, profile: "web", uninstall: true, dryRun: true });
    expect(dry.exitCode).toBe(EXIT.OK);
    expect(readFileSync(patch, "utf-8")).toBe(installed); // nothing restored
    expect(readFileSync(stateFile, "utf-8")).toBe(state); // state untouched
    expect(existsSync(join(home, "skills"))).toBe(true);
  });

  test("invalid profile name is a usage error", () => {
    const home = tempHome();
    expect(() => runInstall({ home, profile: "../evil" })).toThrow();
    try {
      runInstall({ home, profile: "../evil" });
    } catch (error) {
      expect(error).toBeInstanceOf(MyGraceError);
      expect((error as MyGraceError).exitCode).toBe(EXIT.USAGE);
    }
  });
});

// ─── Panel (opt-in) with a controllable fake package manager ────────────

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

function withFakePackageManager<T>(script: string | null, fn: () => T): T {
  const previousPath = process.env.PATH;
  const binDir = tempDir("mygrace-fakebin-");
  if (script !== null) {
    const file = join(binDir, "pnpm");
    writeFileSync(file, script, { mode: 0o755 });
    chmodSync(file, 0o755);
  }
  // Only the fake bin dir + the bun dir: no real `dsh`/`pnpm` can leak in.
  process.env.PATH = `${binDir}:${dirname(process.execPath)}`;
  try {
    return fn();
  } finally {
    process.env.PATH = previousPath;
  }
}

function manifestWithProfile(): string {
  const home = tempHome();
  writeFileSync(join(home, "profiles", "web", "package.json"), '{"name":"p","private":true,"dependencies":{}}\n');
  return home;
}

// The fake package manager is a POSIX shell script; covered on ubuntu/macos.
describe.skipIf(process.platform === "win32")("LIVE status panel (--panel)", () => {
  test("installs the package + row, then uninstall removes both and restores the patch", () => {
    const home = manifestWithProfile();
    const patch = profilePatchPath(home, "web");
    const original = readFileSync(patch, "utf-8");
    withFakePackageManager(FAKE_PNPM, () => {
      const install = runInstall({ home, profile: "web", panel: true });
      expect(install.exitCode).toBe(EXIT.OK);
      const content = readFileSync(patch, "utf-8");
      expect(patchHasRow(parsePatchContent(content), PANEL_ENTRY_ID)).toBe(true);
      const manifest = JSON.parse(readFileSync(join(home, "profiles", "web", "package.json"), "utf-8"));
      expect(manifest.dependencies["mygrace-status-panel"]).toContain("file:");

      const uninstall = runInstall({ home, profile: "web", uninstall: true });
      expect(uninstall.exitCode).toBe(EXIT.OK);
      expect(readFileSync(patch, "utf-8")).toBe(original);
      const after = JSON.parse(readFileSync(join(home, "profiles", "web", "package.json"), "utf-8"));
      expect(after.dependencies["mygrace-status-panel"]).toBeUndefined();
    });
  });

  test("ENOEXEC package manager fails the requested component with an actionable error", () => {
    const home = manifestWithProfile();
    withFakePackageManager("this is not an executable script", () => {
      const result = runInstall({ home, profile: "web", panel: true });
      expect(result.exitCode).toBe(EXIT.FINDINGS);
      const problem = result.problems.find((p) => p.code === "PANEL_INSTALL_FAILED");
      expect(problem).toBeDefined();
      expect(problem?.message).toContain("ENOEXEC");
      expect(problem?.hint).toContain("--panel");
      // A failed package step must not leave a dangling loader row behind.
      expect(patchHasRow(parsePatchContent(readFileSync(profilePatchPath(home, "web"), "utf-8")), PANEL_ENTRY_ID)).toBe(false);
    });
  });

  test("without --panel the panel is not installed", () => {
    const home = manifestWithProfile();
    withFakePackageManager(FAKE_PNPM, () => {
      const result = runInstall({ home, profile: "web" });
      expect(result.exitCode).toBe(EXIT.OK);
      expect(patchHasRow(parsePatchContent(readFileSync(profilePatchPath(home, "web"), "utf-8")), PANEL_ENTRY_ID)).toBe(false);
    });
  });
});

// ─── Existing status snapshot coverage (kept from v1 test file) ─────────

import { buildStatusSnapshot } from "../src/grace-status";

describe("buildStatusSnapshot", () => {
  test("summarizes the fixture project", () => {
    const snapshot = buildStatusSnapshot(join(import.meta.dirname, "fixtures", "mygrace-project"));
    expect(snapshot.modules.total).toBe(2);
    expect(snapshot.phases.total).toBeGreaterThan(0);
    expect(snapshot.verifications.total).toBeGreaterThan(0);
    expect(snapshot.lint.errors).toBe(0);
    expect(snapshot.lint.warnings).toBe(0);
    expect(snapshot.modules.byStatus["wip"]).toBe(1);
  });
});
