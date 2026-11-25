#!/usr/bin/env bun
/**
 * MyGRACE DeepSeek Harness Installer (Wave 1.4)
 *
 * `mygrace setup install` wires MyGRACE into a DeepSeek Harness installation:
 *
 *   1. copies the canonical skills (`skills/mygrace/grace-*`) into
 *      `$DSH_HOME/skills/mygrace-*` — the user-level skill root the harness
 *      discovers automatically (`@deepseek-ai/dsh-skill-filesystem`, user-dsh
 *      rank 400);
 *   2. writes a PATH-free launcher (`$DSH_HOME/mygrace/bin/mygrace`) used by
 *      the in-sandbox CLI calls of the MCP server;
 *   3. inserts an idempotent MCP row into the profile's `cordis.patch.yml` so
 *      the harness spawns `src/grace-mcp.ts` as a stdio MCP server;
 *   4. optionally (`--panel`) links the LIVE status card
 *      (`packages/mygrace-status-panel`: host route `/api/mygrace.status` +
 *      polling browser card) into the profile.
 *
 * Design rules (ROADMAP ADR-3/ADR-7, Wave 1.4):
 *   - user config is parsed with the `yaml` package BEFORE and AFTER every
 *     edit; a file whose YAML does not parse is never touched (exit 2);
 *   - writes are atomic (tmp file + rename in the same directory) and always
 *     preceded by a timestamped backup that is never overwritten;
 *   - idempotency is structural (parsed rows by `id`), never substring-based;
 *   - requested components that fail make the command exit non-zero and the
 *     "Done" banner is only printed when every step succeeded;
 *   - uninstall restores `cordis.patch.yml` byte-for-byte (marker-delimited
 *     blocks are the only bytes we add), removes its launcher, skills and
 *     backup files, and prints no activation instructions.
 *
 * `--bundle` was removed in v1.1: `packages/mygrace-dsh` is an unpublished
 * preview (it needs unpublished preview packages and a private panel), so
 * the CLI never pretends to install it. The flag is kept as a stub that fails
 * with an actionable explanation (ADR-7: one package, optional plugins).
 */

// START_MODULE_CONTRACT
//   PURPOSE: Install/uninstall MyGRACE into DeepSeek Harness with validated, atomic config edits and honest exit codes.
//   SCOPE: Writes only under $DSH_HOME (skills/, mygrace/bin/, profiles/<profile>/cordis.patch.yml and profile package manager for --panel). No network.
//   DEPENDS: grace-errors (typed errors/exit codes), yaml (structured patch parsing), node:fs, node:path, node:child_process
//   LINKS: ROADMAP.md (ADR-3, ADR-7, W1.4), analysis/04-integration-packaging.md
// END_MODULE_CONTRACT

// START_MODULE_MAP
//   dshHome()                          — resolve $DSH_HOME (honours the env var, falls back to ~/.dsh)
//   skillsSourceDir()/skillSourceDirs()— canonical grace-* skills shipped with this package
//   profilePatchPath()/launcherPath()  — managed paths inside $DSH_HOME
//   mcpPatchRow()/panelPatchRow()      — loader rows in the exact shape DSH 0.2.x expects
//   renderManagedBlock()               — marker-delimited YAML block (uninstall removes exactly these bytes)
//   parsePatchContent()                — YAML parse + top-level-array validation (ConfigError on bad input)
//   patchHasRow()                      — structural idempotency check (parsed rows, not substrings)
//   insertRowInPatch()/removeRowFromPatch() — text edits with before/after YAML validation (byte-identical undo)
//   atomicWriteFile()                  — tmp file + rename in the same directory, preserving file mode
//   createTimestampedBackup()/cleanupBackups() — never-overwritten backups + residue cleanup
//   writeLauncherFile()                — PATH-free launcher script for the MCP server's CLI calls
//   runInstall()                       — orchestrator returning actions + typed problems + exit code
//   installDshCommand                  — `mygrace setup install` citty command
// END_MODULE_MAP

// START_CHANGE_SUMMARY
//   v1.1 (Wave 1.4):
//   - replaced line/string surgery with YAML-parse/validate + marker-delimited blocks;
//   - atomic writes, timestamped never-overwritten backups, byte-identical uninstall;
//   - manifest-driven exit codes: failed components exit 1, invalid YAML/config exits 2;
//   - MCP row is PATH-free (absolute process.execPath + absolute server path + MYGRACE_BIN launcher);
//   - `--bundle` removed (honest error); bundle kept as unpublished preview;
//   - status panel is opt-in and LIVE (host route + polling card), documented in packages/mygrace-status-panel/README.md;
//   - package-manager failures produce actionable errors instead of silent skips.
// END_CHANGE_SUMMARY

import { defineCommand } from "citty";
import {
  chmodSync,
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
  constants as fsConstants,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { homedir } from "node:os";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import YAML from "yaml";
import { ConfigError, EXIT, MyGraceError, UsageError, type ExitCode } from "./grace-errors";

// ─── Constants ──────────────────────────────────────────────────────────

/** Loader row id of the MyGRACE MCP server. */
export const MCP_ENTRY_ID = "mcp-mygrace";
/** Loader row id of the LIVE status panel (host route + browser card). */
export const PANEL_ENTRY_ID = "mygrace-status-panel";
/** Package name of the optional LIVE status panel. */
const PANEL_PACKAGE = "mygrace-status-panel";
/** Prefix of the timestamped backups this module creates. */
const BACKUP_INFIX = ".mygrace-backup";
/** Backup suffix written by v1 installers (cleaned up on uninstall). */
const LEGACY_BACKUP_SUFFIX = ".mygrace-backup";
/** Marker id used in the DSH MCP-client config (must match the row). */
const MCP_SERVER_NAME = "mygrace";

const PROFILE_NAME_PATTERN = /^[A-Za-z0-9_-]+$/u;

// ─── Paths ──────────────────────────────────────────────────────────────

/** Absolute DSH home: `$DSH_HOME` when set (whitespace-only counts as unset), else `~/.dsh`. */
export function dshHome(): string {
  const explicit = process.env.DSH_HOME?.trim();
  if (explicit !== undefined && explicit !== "") return resolve(explicit);
  return join(homedir(), ".dsh");
}

/** Canonical skill sources shipped with this package (`grace-*` directories). */
export function skillsSourceDir(): string {
  return join(dirname(import.meta.dirname), "skills", "mygrace");
}

export interface SkillSource {
  /** Absolute source directory. */
  source: string;
  /** Installed directory name (`mygrace-<skill>`). */
  name: string;
}

/** List the shipped `grace-*` skills mapped to their installed `mygrace-*` names. */
export function skillSourceDirs(): SkillSource[] {
  const root = skillsSourceDir();
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name.startsWith("grace-"))
    .map((entry) => ({
      source: join(root, entry.name),
      name: entry.name.replace(/^grace-/u, "mygrace-"),
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** Absolute patch-file path for one DSH profile. */
export function profilePatchPath(home: string, profile: string): string {
  return join(home, "profiles", profile, "cordis.patch.yml");
}

/** Absolute profile directory. */
export function profileDir(home: string, profile: string): string {
  return join(home, "profiles", profile);
}

/** Absolute path of the installed CLI entry point (`src/grace.ts`). */
export function cliEntryPath(): string {
  return join(import.meta.dirname, "grace.ts");
}

/** Absolute path of the MCP server entry point (`src/grace-mcp.ts`). */
export function mcpServerEntryPath(): string {
  return join(import.meta.dirname, "grace-mcp.ts");
}

/** PATH-free CLI launcher written by `setup install` (POSIX only). */
export function launcherPath(home: string): string {
  return join(home, "mygrace", "bin", process.platform === "win32" ? "mygrace.cmd" : "mygrace");
}

// ─── Loader rows (exact DSH shape) ──────────────────────────────────────

/** One loader row as a plain YAML-serializable object. */
export type PatchRow = Record<string, unknown>;

export interface McpPatchRowOptions {
  /** Absolute CLI launcher used for the in-sandbox CLI calls (`MYGRACE_BIN`). */
  launcher?: string;
  /** Runtime binary that runs the MCP server (defaults to `process.execPath`). */
  bunBinary?: string;
  /** MCP server script (defaults to this package's `src/grace-mcp.ts`). */
  serverEntry?: string;
}

/**
 * The MCP row in the exact shape DeepSeek Harness 0.2.x expects.
 *
 * The command is an ABSOLUTE path to the runtime that is executing this
 * installer (`process.execPath`), so DSH does not need `bun`/`mygrace` on
 * PATH to start the server. `env.MYGRACE_BIN` points at the generated
 * launcher so the server's own CLI sub-calls are PATH-free too (W1.3/MCP
 * server uses the same convention; when the launcher is unavailable the key
 * is omitted and the server's own fallback applies).
 */
export function mcpPatchRow(options: McpPatchRowOptions = {}): PatchRow {
  const bunBinary = options.bunBinary ?? process.execPath;
  const serverEntry = options.serverEntry ?? mcpServerEntryPath();
  const config: PatchRow = {
    transport: "stdio",
    serverName: MCP_SERVER_NAME,
    command: bunBinary,
    args: ["run", serverEntry],
  };
  if (options.launcher !== undefined && process.platform !== "win32") {
    config.env = { MYGRACE_BIN: options.launcher };
  }
  return {
    insert: [{ id: MCP_ENTRY_ID, name: "@deepseek-ai/dsh-mcp-client", config }],
  };
}

/** The LIVE status-panel row (`--panel` opt-in: host route + polling card). */
export function panelPatchRow(): PatchRow {
  return { insert: [{ id: PANEL_ENTRY_ID, name: PANEL_PACKAGE }] };
}

/** Begin marker of a managed block; the exact string is used for removal. */
export function beginMarker(id: string): string {
  return `# >>> mygrace:${id} (managed by \`mygrace setup install\`; do not edit) >>>`;
}

/** End marker of a managed block. */
export function endMarker(id: string): string {
  return `# <<< mygrace:${id} <<<`;
}

/**
 * Render one loader row as a marker-delimited YAML block.
 *
 * The block always starts with a newline so appending it to any file is one
 * pure insertion: removing the exact marker-to-marker bytes restores the file
 * byte-for-byte (used by uninstall).
 */
export function renderManagedBlock(row: PatchRow, id: string): string {
  const yamlText = YAML.stringify([row], { indent: 4, lineWidth: 0, singleQuote: true }).trimEnd();
  return `\n${beginMarker(id)}\n${yamlText}\n${endMarker(id)}\n`;
}

// ─── Patch parsing / validation ─────────────────────────────────────────

/** Parse a patch file body. Empty/comment-only files count as an empty patch. */
export function parsePatchContent(content: string, file = "cordis.patch.yml"): unknown[] {
  const document = YAML.parseDocument(content);
  if (document.errors.length > 0) {
    const first = document.errors[0];
    throw new ConfigError(`Refusing to edit ${file}: the YAML does not parse (${first?.message ?? "unknown error"}).`, {
      file,
      hint: "Fix the YAML by hand (or restore a backup) and re-run. MyGRACE never rewrites an unparseable config.",
    });
  }
  const value: unknown = document.toJS();
  if (value === null || value === undefined) return [];
  if (!Array.isArray(value)) {
    throw new ConfigError(`Refusing to edit ${file}: the top-level YAML value must be an array of loader rows.`, {
      file,
      hint: "cordis.patch.yml is a YAML sequence (`- id: …` rows). Restore the profile template if it was replaced.",
    });
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** True when one parsed row targets `id` (bare row or an `insert:` child). */
function rowHasId(row: unknown, id: string): boolean {
  if (!isRecord(row)) return false;
  if (row.id === id) return true;
  const insert = row.insert;
  if (!Array.isArray(insert)) return false;
  return insert.some((child) => isRecord(child) && child.id === id);
}

/** Structural idempotency check: does the parsed patch already contain `id`? */
export function patchHasRow(rows: readonly unknown[], id: string): boolean {
  return rows.some((row) => rowHasId(row, id));
}

export interface PatchEditResult {
  /** New file body (identical to the input when `changed` is false). */
  content: string;
  /** True when the edit modified the file body. */
  changed: boolean;
}

/** Locate the byte range of a standalone `[]` document body (empty patch layer). */
function emptyArrayLiteralRange(content: string, rows: readonly unknown[]): { start: number; end: number } | null {
  if (rows.length !== 0) return null;
  const match = /^[ \t]*\[\][ \t]*$/mu.exec(content);
  if (match === null) return null;
  const start = match.index + match[0].indexOf("[]");
  return { start, end: start + 2 };
}

/**
 * Insert one managed row into a patch file body.
 *
 * - parses + validates the current body first (throws `ConfigError` when invalid);
 * - returns `changed: false` when the row is already present (structural check);
 * - appends a marker-delimited block, or replaces a standalone empty-array
 *   literal, so the surrounding bytes/comments are preserved;
 * - parses + validates the result before returning it.
 */
export function insertRowInPatch(content: string, row: PatchRow, id: string, file = "cordis.patch.yml"): PatchEditResult {
  const rows = parsePatchContent(content, file);
  if (patchHasRow(rows, id)) return { content, changed: false };

  const block = renderManagedBlock(row, id);
  const emptyLiteral = emptyArrayLiteralRange(content, rows);
  const next =
    emptyLiteral === null
      ? `${content}${block}`
      : `${content.slice(0, emptyLiteral.start)}${block}${content.slice(emptyLiteral.end)}`;

  const after = parsePatchContent(next, file);
  if (!patchHasRow(after, id)) {
    throw new ConfigError(`Internal error: inserted row "${id}" is not detectable in ${file}.`, { file });
  }
  if (after.length !== rows.length + 1) {
    throw new ConfigError(`Internal error: ${file} gained ${after.length - rows.length} rows instead of 1.`, { file });
  }
  return { content: next, changed: true };
}

interface MarkerRange {
  start: number;
  end: number;
}

/** Byte range of the marker-delimited block for `id`, including its leading newline. */
function markerBlockRange(content: string, id: string): MarkerRange | null {
  const begin = content.indexOf(beginMarker(id));
  if (begin === -1) return null;
  const endMarkerIndex = content.indexOf(endMarker(id), begin);
  if (endMarkerIndex === -1) return null;
  const endMarkerEnd = endMarkerIndex + endMarker(id).length;
  const lineEnd = content.indexOf("\n", endMarkerEnd);
  const end = lineEnd === -1 ? content.length : lineEnd + 1;
  const start = begin > 0 && content[begin - 1] === "\n" ? begin - 1 : begin;
  return { start, end };
}

/** Best-effort removal of a v1 (marker-less) row: locate its top-level item lines. */
function removeLegacyRowByText(content: string, id: string, file: string): string {
  const lines = content.split("\n");
  const out: string[] = [];
  let removed = false;
  for (let index = 0; index < lines.length; ) {
    const line = lines[index] ?? "";
    const isTopLevelItem = /^-[ \t]/u.test(line);
    if (!isTopLevelItem) {
      out.push(line);
      index += 1;
      continue;
    }
    // A top-level item spans its own line(s) plus indented/blank continuation lines.
    let end = index + 1;
    while (end < lines.length) {
      const candidate = lines[end] ?? "";
      if (candidate.trim() === "" || /^[ \t]/u.test(candidate)) {
        end += 1;
        continue;
      }
      break;
    }
    const itemText = lines.slice(index, end).join("\n");
    let item: unknown;
    try {
      item = parsePatchContent(itemText, file)[0];
    } catch {
      item = undefined;
    }
    if (item !== undefined && rowHasId(item, id)) {
      removed = true;
      index = end;
      continue;
    }
    out.push(...lines.slice(index, end));
    index = end;
  }
  if (!removed) return content;
  const candidate = out.join("\n");
  const rows = parsePatchContent(candidate, file);
  if (patchHasRow(rows, id)) return content; // could not isolate: caller reports "not removed"
  return rows.length === 0 ? "[]\n" : candidate;
}

/**
 * Remove one managed row from a patch file body.
 *
 * Marker-delimited blocks are removed byte-exactly; v1 marker-less rows are
 * removed by locating their top-level YAML item (validated afterwards). When
 * the patch becomes empty the canonical `[]\n` body is restored.
 */
export function removeRowFromPatch(content: string, id: string, file = "cordis.patch.yml"): PatchEditResult {
  const rows = parsePatchContent(content, file);
  if (!patchHasRow(rows, id)) return { content, changed: false };

  const range = markerBlockRange(content, id);
  if (range !== null) {
    const before = content.slice(0, range.start);
    const after = content.slice(range.end);
    const cut = `${before}${after}`;
    const cutRows = tryParseRows(cut, file);
    if (cutRows !== null && !patchHasRow(cutRows, id)) {
      if (cutRows.length > 0) return { content: cut, changed: true };
      // The block was the only root entry: put the canonical empty literal back
      // in the exact byte position the block occupied (comments/trailing
      // newlines around it are preserved, so the undo is byte-identical).
      const withLiteral = `${before}[]${after}`;
      const literalRows = tryParseRows(withLiteral, file);
      if (literalRows !== null && !patchHasRow(literalRows, id)) return { content: withLiteral, changed: true };
    }
    throw new ConfigError(`Refusing to edit ${file}: could not remove row "${id}" without corrupting the file.`, { file });
  }

  const next = removeLegacyRowByText(content, id, file);
  if (next === content) {
    throw new ConfigError(`Refusing to edit ${file}: row "${id}" was detected but its block could not be isolated.`, {
      file,
      hint: "Remove the row by hand (it is the `id: " + id + "` loader entry) and re-run.",
    });
  }
  const nextRows = parsePatchContent(next, file);
  if (patchHasRow(nextRows, id)) {
    throw new ConfigError(`Refusing to edit ${file}: row "${id}" is still present after the edit.`, { file });
  }
  return { content: next, changed: true };
}

function tryParseRows(content: string, file: string): unknown[] | null {
  try {
    return parsePatchContent(content, file);
  } catch {
    return null;
  }
}

// ─── Atomic writes and backups ──────────────────────────────────────────

/**
 * Write `content` to `path` atomically: tmp file in the same directory, then
 * rename. The previous file mode is preserved (DSH profiles use 0600).
 */
export function atomicWriteFile(path: string, content: string): void {
  const dir = dirname(path);
  const tmp = join(dir, `.${basename(path)}.mygrace-tmp-${process.pid}-${Date.now()}`);
  let mode = 0o644;
  try {
    mode = statSync(path).mode & 0o777;
  } catch {
    // New file: keep the default mode.
  }
  try {
    writeFileSync(tmp, content, { encoding: "utf-8", mode });
    chmodSync(tmp, mode);
    renameSync(tmp, path);
  } catch (error) {
    try {
      rmSync(tmp, { force: true });
    } catch {
      // The tmp file may not exist; nothing else to clean.
    }
    throw new MyGraceError(
      "CONFIG_WRITE_FAILED",
      `Cannot write "${path}": ${error instanceof Error ? error.message : String(error)}`,
      {
        exitCode: EXIT.FINDINGS,
        file: path,
        hint: "Check that the profile directory (and the file) are writable by your user, then re-run.",
        cause: error,
      }
    );
  }
}

/** Timestamp suitable for backup file names (UTC, filesystem-safe). */
function backupStamp(): string {
  return new Date().toISOString().replace(/\.\d+Z$/u, "Z").replace(/[:]/gu, "");
}

/**
 * Copy `path` to a timestamped backup next to it. Existing backups are NEVER
 * overwritten: a numeric suffix is appended when the timestamp collides.
 */
export function createTimestampedBackup(path: string): string {
  const dir = dirname(path);
  const stem = `${basename(path)}${BACKUP_INFIX}-${backupStamp()}`;
  for (let attempt = 0; ; attempt += 1) {
    const candidate = join(dir, attempt === 0 ? stem : `${stem}-${attempt}`);
    if (existsSync(candidate)) continue;
    try {
      copyFileSync(path, candidate, fsConstants.COPYFILE_EXCL);
      return candidate;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") continue;
      throw new MyGraceError(
        "CONFIG_BACKUP_FAILED",
        `Cannot back up "${path}" before editing it: ${error instanceof Error ? error.message : String(error)}`,
        {
          exitCode: EXIT.FINDINGS,
          hint: "MyGRACE will not edit a user config without a backup. Check permissions/disk space.",
          cause: error,
        }
      );
    }
  }
}

/** Every MyGRACE backup file next to `path` (timestamped and v1 legacy suffix). */
export function listBackupFiles(path: string): string[] {
  const dir = dirname(path);
  if (!existsSync(dir)) return [];
  const prefix = `${basename(path)}${BACKUP_INFIX}`;
  const legacy = `${basename(path)}${LEGACY_BACKUP_SUFFIX}`;
  return readdirSync(dir)
    .filter((name) => name.startsWith(prefix) || name === legacy)
    .map((name) => join(dir, name))
    .sort();
}

/** Remove residue backup files created by MyGRACE (best effort). */
export function cleanupBackups(path: string): string[] {
  const removed: string[] = [];
  for (const file of listBackupFiles(path)) {
    try {
      rmSync(file, { force: true });
      removed.push(file);
    } catch {
      // Best effort: leftover backups are reported by the uninstall summary.
    }
  }
  return removed;
}

// ─── PATH-free launcher ─────────────────────────────────────────────────

/** Shell-quote a path for a POSIX `sh` script. */
function shellQuote(value: string): string {
  return `'${value.replace(/'/gu, `'\\''`)}'`;
}

/** Body of the generated POSIX launcher script. */
export function launcherScript(bunBinary: string, cliEntry: string): string {
  return [
    "#!/bin/sh",
    "# MyGRACE launcher generated by `mygrace setup install` — do not edit.",
    "# The MCP server uses this launcher for its CLI sub-calls so that no",
    "# `mygrace`/`bun` binary has to be on the harness PATH.",
    `exec ${shellQuote(bunBinary)} 'run' ${shellQuote(cliEntry)} "$@"`,
    "",
  ].join("\n");
}

export interface LauncherResult {
  /** Absolute launcher path, or null when this platform is not supported. */
  path: string | null;
  changed: boolean;
}

/**
 * Install (or refresh) the PATH-free launcher. POSIX only: Windows has no
 * shebang execution for `execFile`, so the MCP server's own runtime fallback
 * (W1.3 `process.execPath` launcher) applies there instead.
 */
export function writeLauncherFile(home: string, options: { bunBinary?: string; cliEntry?: string } = {}): LauncherResult {
  if (process.platform === "win32") return { path: null, changed: false };
  const path = launcherPath(home);
  const content = launcherScript(options.bunBinary ?? process.execPath, options.cliEntry ?? cliEntryPath());
  const previous = existsSync(path) ? readFileSync(path, "utf-8") : null;
  if (previous === content) {
    chmodSync(path, 0o755);
    return { path, changed: false };
  }
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
  try {
    writeFileSync(tmp, content, { encoding: "utf-8", mode: 0o755 });
    chmodSync(tmp, 0o755);
    renameSync(tmp, path);
  } catch (error) {
    try {
      rmSync(tmp, { force: true });
    } catch {
      // ignore
    }
    throw new MyGraceError(
      "LAUNCHER_WRITE_FAILED",
      `Cannot write the MyGRACE launcher "${path}": ${error instanceof Error ? error.message : String(error)}`,
      { exitCode: EXIT.FINDINGS, file: path, cause: error }
    );
  }
  return { path, changed: true };
}

/** Remove the launcher and its now-empty directories (best effort). */
function removeLauncher(home: string): string[] {
  const removed: string[] = [];
  const path = launcherPath(home);
  if (existsSync(path)) {
    rmSync(path, { force: true });
    removed.push(path);
  }
  return [...removed, ...removeEmptyLauncherDirs(home)];
}

/** Remove `$DSH_HOME/mygrace/{bin}` when empty (after the launcher/state are gone). */
function removeEmptyLauncherDirs(home: string): string[] {
  const removed: string[] = [];
  const path = launcherPath(home);
  for (const dir of [dirname(path), dirname(dirname(path))]) {
    try {
      if (existsSync(dir) && readdirSync(dir).length === 0) {
        rmSync(dir, { recursive: true, force: true });
        removed.push(dir);
      }
    } catch {
      // A non-empty directory is left alone.
    }
  }
  return removed;
}

// ─── Package manager (optional LIVE status panel) ───────────────────────

/** Find an executable on PATH (POSIX: file + any exec bit). */
function findExecutable(name: string): string | undefined {
  const pathValue = process.env.PATH ?? "";
  for (const dir of pathValue.split(":")) {
    if (dir === "") continue;
    const candidate = join(dir, name);
    try {
      const stats = statSync(candidate);
      if (stats.isFile() && (stats.mode & 0o111) !== 0) return candidate;
    } catch {
      // Not here.
    }
  }
  return undefined;
}

interface SpawnOutcome {
  ok: boolean;
  /** Actionable failure description (already user-facing). */
  reason?: string;
  /** True when the binary could not be executed at all (ENOEXEC/ENOENT). */
  notExecutable?: boolean;
  via?: string;
}

function spawnProfileCommand(
  command: string,
  args: string[],
  options: { cwd: string; env?: NodeJS.ProcessEnv }
): SpawnOutcome {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    encoding: "utf-8",
    env: { ...process.env, ...options.env },
  });
  if (result.error !== undefined) {
    const code = (result.error as NodeJS.ErrnoException).code ?? "unknown";
    const notExecutable = code === "ENOEXEC" || code === "ENOENT" || code === "EACCES";
    return {
      ok: false,
      notExecutable,
      reason:
        code === "ENOEXEC"
          ? `${command} cannot be executed from Node/Bun (ENOEXEC: it is a shebang-less shim on this system).`
          : `${command} could not be started (${code}: ${result.error.message}).`,
    };
  }
  if (result.status !== 0) {
    const stderr = (result.stderr ?? "").trim().split("\n").filter((line) => line.trim() !== "");
    return {
      ok: false,
      reason: `${command} exited with ${result.status ?? "null"}${stderr.length > 0 ? `: ${stderr[stderr.length - 1] ?? ""}` : ""}`,
    };
  }
  return { ok: true };
}

function profileManifestPath(home: string, profile: string): string {
  return join(profileDir(home, profile), "package.json");
}

function profileManifest(home: string, profile: string): Record<string, unknown> | null {
  const path = profileManifestPath(home, profile);
  if (!existsSync(path)) return null;
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf-8"));
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function profileHasDependency(home: string, profile: string, name: string): boolean {
  const manifest = profileManifest(home, profile);
  const deps = manifest?.dependencies;
  return isRecord(deps) && typeof deps[name] === "string";
}

/**
 * Link the status-panel package (live host route + browser card) into the profile.
 *
 * Prefers DSH's own package-management path (`dsh plugin add`) when the DSH
 * CLI is available; falls back to a raw `pnpm add`. Both are reported exactly
 * — no silent skip — and an ENOEXEC pnpm produces an actionable message
 * instead of `exit null`.
 */
function addPanelPackage(home: string, profile: string, source: string): SpawnOutcome {
  const dir = profileDir(home, profile);
  if (!existsSync(profileManifestPath(home, profile))) {
    return { ok: false, reason: `Profile "${profile}" is not initialized (no package.json) — boot DSH once first.` };
  }
  const dsh = findExecutable("dsh");
  if (dsh !== undefined) {
    const viaDsh = spawnProfileCommand(dsh, ["plugin", "--profile", profile, "add", `file:${source}`], {
      cwd: dir,
      env: { DSH_HOME: home },
    });
    if (viaDsh.ok && profileHasDependency(home, profile, PANEL_PACKAGE)) return { ok: true, via: "dsh plugin" };
  }
  const pnpm = findExecutable("pnpm");
  if (pnpm === undefined) {
    return {
      ok: false,
      notExecutable: true,
      reason: "pnpm was not found on PATH and the DSH CLI could not add the package.",
    };
  }
  const viaPnpm = spawnProfileCommand(pnpm, ["add", `file:${source}`, "--silent"], { cwd: dir });
  if (!viaPnpm.ok) return { ...viaPnpm, reason: viaPnpm.reason };
  if (!profileHasDependency(home, profile, PANEL_PACKAGE)) {
    return { ok: false, reason: `${basename(pnpm)} reported success but the profile manifest has no ${PANEL_PACKAGE} dependency.` };
  }
  return { ok: true, via: "pnpm" };
}

function removePanelPackage(home: string, profile: string): SpawnOutcome {
  const dir = profileDir(home, profile);
  const dsh = findExecutable("dsh");
  if (dsh !== undefined) {
    const viaDsh = spawnProfileCommand(dsh, ["plugin", "--profile", profile, "remove", PANEL_PACKAGE], {
      cwd: dir,
      env: { DSH_HOME: home },
    });
    if (viaDsh.ok && !profileHasDependency(home, profile, PANEL_PACKAGE)) return { ok: true, via: "dsh plugin" };
  }
  const pnpm = findExecutable("pnpm");
  if (pnpm === undefined) {
    return {
      ok: false,
      notExecutable: true,
      reason: "pnpm was not found on PATH and the DSH CLI could not remove the package.",
    };
  }
  const viaPnpm = spawnProfileCommand(pnpm, ["remove", PANEL_PACKAGE, "--silent"], { cwd: dir });
  if (!viaPnpm.ok) return viaPnpm;
  if (profileHasDependency(home, profile, PANEL_PACKAGE)) {
    return { ok: false, reason: `${basename(pnpm)} reported success but the profile manifest still lists ${PANEL_PACKAGE}.` };
  }
  return { ok: true, via: "pnpm" };
}

// ─── Installer state (byte-identical uninstall) ────────────────────────

/**
 * State file under `$DSH_HOME/mygrace/state.json`.
 *
 * It records the pristine bytes of `cordis.patch.yml` captured before the
 * first managed edit plus the hash of the file after our last edit. When the
 * file is unchanged at uninstall time, the original bytes are restored
 * verbatim — which is the only reliable way to undo marker blocks across
 * multiple installs/edits and user comments. If the user edited the file in
 * between, MyGRACE falls back to removing only its own rows (never clobbers
 * user edits).
 */
interface PatchStateEntry {
  patch: string;
  /** Base64 of the file body before the first managed edit. */
  originalB64: string;
  /** sha256 of the file body after our last successful edit. */
  installedHash: string;
  installedAt: string;
}

interface InstallerState {
  version: 1;
  profiles: Record<string, PatchStateEntry>;
}

const STATE_VERSION = 1 as const;

function stateFilePath(home: string): string {
  return join(home, "mygrace", "state.json");
}

function sha256(content: string): string {
  return createHash("sha256").update(content, "utf-8").digest("hex");
}

function loadState(home: string): InstallerState {
  const path = stateFilePath(home);
  if (!existsSync(path)) return { version: STATE_VERSION, profiles: {} };
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf-8"));
    if (!isRecord(parsed) || !isRecord(parsed.profiles)) return { version: STATE_VERSION, profiles: {} };
    const profiles: Record<string, PatchStateEntry> = {};
    for (const [name, value] of Object.entries(parsed.profiles)) {
      if (!isRecord(value)) continue;
      const { patch, originalB64, installedHash, installedAt } = value;
      if (typeof patch !== "string" || typeof originalB64 !== "string" || typeof installedHash !== "string") continue;
      profiles[name] = {
        patch,
        originalB64,
        installedHash,
        installedAt: typeof installedAt === "string" ? installedAt : new Date(0).toISOString(),
      };
    }
    return { version: STATE_VERSION, profiles };
  } catch {
    return { version: STATE_VERSION, profiles: {} };
  }
}

function saveState(home: string, state: InstallerState): void {
  const path = stateFilePath(home);
  mkdirSync(dirname(path), { recursive: true });
  const content = `${JSON.stringify(state, null, 2)}\n`;
  if (existsSync(path) && readFileSync(path, "utf-8") === content) return;
  try {
    writeFileSync(path, content, { encoding: "utf-8", mode: 0o600 });
    chmodSync(path, 0o600);
  } catch (error) {
    throw new MyGraceError(
      "STATE_WRITE_FAILED",
      `Cannot persist installer state "${path}": ${error instanceof Error ? error.message : String(error)}`,
      { exitCode: EXIT.FINDINGS, file: path, cause: error }
    );
  }
}

function deleteStateFileIfEmpty(home: string): void {
  const state = loadState(home);
  if (Object.keys(state.profiles).length > 0) return;
  rmSync(stateFilePath(home), { force: true });
}

/**
 * Capture the pristine patch body before the first managed edit and remember
 * the post-edit hash afterwards. Idempotent: an existing record is kept.
 */
function recordPatchEdit(home: string, profile: string, patchPath: string, original: string | null, current: string): void {
  const state = loadState(home);
  const existing = state.profiles[profile];
  const installedHash = sha256(current);
  if (existing === undefined) {
    state.profiles[profile] = {
      patch: patchPath,
      originalB64: Buffer.from(original ?? "", "utf-8").toString("base64"),
      installedHash,
      installedAt: new Date().toISOString(),
    };
  } else {
    existing.installedHash = installedHash;
    existing.patch = patchPath;
  }
  saveState(home, state);
}

interface RestoreOutcome {
  restored: boolean;
}

/**
 * Uninstall step 0: when the profile patch is byte-identical to what the last
 * install left behind, restore the pristine pre-install bytes verbatim.
 * Returns `restored: true` when that happened (row removal is then unnecessary).
 */
function restoreOriginalPatch(
  home: string,
  profile: string,
  dryRun: boolean,
  actions: InstallAction[],
  problems: InstallProblem[]
): RestoreOutcome {
  const state = loadState(home);
  const entry = state.profiles[profile];
  if (entry === undefined) return { restored: false };
  const patchPath = profilePatchPath(home, profile);
  if (!existsSync(patchPath)) {
    actions.push({ status: "info", message: `profile patch ${patchPath} is already gone — nothing to restore` });
    if (!dryRun) {
      delete state.profiles[profile];
      saveState(home, state);
    }
    return { restored: false };
  }
  let current: string;
  try {
    current = readFileSync(patchPath, "utf-8");
  } catch (error) {
    problems.push(problem("PATCH_READ_FAILED", `Cannot read "${patchPath}": ${error instanceof Error ? error.message : String(error)}`));
    return { restored: false };
  }
  if (sha256(current) !== entry.installedHash) {
    actions.push({
      status: "info",
      message: `${patchPath} changed since install — removing only MyGRACE rows (your edits are preserved)`,
    });
    if (!dryRun) {
      delete state.profiles[profile];
      saveState(home, state);
    }
    return { restored: false };
  }
  const original = Buffer.from(entry.originalB64, "base64").toString("utf-8");
  if (dryRun) {
    actions.push({ status: "planned", message: `would restore the original ${patchPath} byte-for-byte` });
    return { restored: true };
  }
  try {
    if (original !== current) {
      atomicWriteFile(patchPath, original);
      actions.push({ status: "done", message: `restored the original ${patchPath} byte-for-byte` });
    } else {
      actions.push({ status: "info", message: `${patchPath} already matches the original bytes` });
    }
    parsePatchContent(original, patchPath);
  } catch (error) {
    const message = error instanceof MyGraceError ? error.message : `Cannot restore "${patchPath}": ${error instanceof Error ? error.message : String(error)}`;
    problems.push({
      code: error instanceof MyGraceError ? error.code : "PATCH_RESTORE_FAILED",
      message,
      exitCode: error instanceof MyGraceError ? error.exitCode : EXIT.FINDINGS,
      hint: "Restore the file from a backup or by hand, then re-run setup install --uninstall.",
    });
    return { restored: false };
  }
  delete state.profiles[profile];
  saveState(home, state);
  return { restored: true };
}

/** Remember the post-install patch body (creates the state entry on first install). */
function rememberInstall(
  home: string,
  profile: string,
  patchPath: string,
  before: string | null,
  actions: InstallAction[],
  problems: InstallProblem[]
): void {
  if (!existsSync(patchPath)) return;
  try {
    const current = readFileSync(patchPath, "utf-8");
    if (before !== null && current === before) return; // no edit happened
    recordPatchEdit(home, profile, patchPath, before, current);
  } catch (error) {
    problems.push(
      problem("STATE_WRITE_FAILED", `Cannot remember the installer state: ${error instanceof Error ? error.message : String(error)}`, {
        hint: "Re-run setup install (it is idempotent); uninstall may fall back to row removal instead of a byte-identical restore.",
      })
    );
  }
}

// ─── Installer orchestration ────────────────────────────────────────────

export type ActionStatus = "done" | "planned" | "skipped" | "info";

export interface InstallAction {
  status: ActionStatus;
  message: string;
}

export interface InstallProblem {
  code: string;
  message: string;
  hint?: string;
  exitCode: ExitCode;
}

export interface InstallResult {
  exitCode: ExitCode;
  actions: InstallAction[];
  problems: InstallProblem[];
  dryRun: boolean;
  uninstall: boolean;
}

export interface InstallOptions {
  home: string;
  profile: string;
  dryRun?: boolean;
  uninstall?: boolean;
  /** Install the opt-in LIVE status card (host route + polling sidebar card; requires a package manager). */
  panel?: boolean;
}

function problem(code: string, message: string, options: { hint?: string; exitCode?: ExitCode } = {}): InstallProblem {
  return { code, message, exitCode: options.exitCode ?? EXIT.FINDINGS, ...(options.hint === undefined ? {} : { hint: options.hint }) };
}

function validateProfileName(profile: string): void {
  if (!PROFILE_NAME_PATTERN.test(profile)) {
    throw new UsageError(`Invalid DSH profile name "${profile}".`, {
      hint: "Use a profile name such as `web`, `tui` or `headless` (letters, digits, `_`, `-`).",
    });
  }
}

function installSkills(skillsRoot: string, dryRun: boolean, actions: InstallAction[], problems: InstallProblem[]): void {
  const sources = skillSourceDirs();
  if (sources.length === 0) {
    problems.push(
      problem("SKILLS_MISSING", `No MyGRACE skills found in "${skillsSourceDir()}".`, {
        hint: "The package is incomplete; reinstall mygrace-cli (the shipped tarball must contain skills/mygrace/grace-*).",
      })
    );
    return;
  }
  for (const { source, name } of sources) {
    const dest = join(skillsRoot, name);
    if (dryRun) {
      actions.push({ status: "planned", message: `would copy ${basename(source)} → ${dest}` });
      continue;
    }
    try {
      cpSync(source, dest, { recursive: true });
      actions.push({ status: "done", message: `installed ${name}` });
    } catch (error) {
      problems.push(
        problem("SKILLS_COPY_FAILED", `Cannot install skill "${name}" to "${dest}": ${error instanceof Error ? error.message : String(error)}`)
      );
    }
  }
}

function uninstallSkills(skillsRoot: string, dryRun: boolean, actions: InstallAction[], problems: InstallProblem[]): void {
  let removed = 0;
  for (const { name } of skillSourceDirs()) {
    const dest = join(skillsRoot, name);
    if (!existsSync(dest)) continue;
    if (dryRun) {
      actions.push({ status: "planned", message: `would remove ${dest}` });
      continue;
    }
    try {
      rmSync(dest, { recursive: true, force: true });
      actions.push({ status: "done", message: `removed ${dest}` });
      removed += 1;
    } catch (error) {
      problems.push(
        problem("SKILLS_REMOVE_FAILED", `Cannot remove "${dest}": ${error instanceof Error ? error.message : String(error)}`)
      );
    }
  }
  if (removed > 0 && !dryRun && existsSync(skillsRoot)) {
    try {
      if (readdirSync(skillsRoot).length === 0) {
        rmSync(skillsRoot, { recursive: true, force: true });
        actions.push({ status: "done", message: `removed empty ${skillsRoot}` });
      }
    } catch {
      // Leaving an empty directory behind is harmless.
    }
  }
  const planned = actions.some((action) => action.status === "planned" && action.message.includes(skillsRoot));
  if (removed === 0 && !planned) actions.push({ status: "info", message: `no MyGRACE skills in ${skillsRoot} — nothing to remove` });
}

function installLauncher(home: string, dryRun: boolean, actions: InstallAction[], problems: InstallProblem[]): void {
  if (process.platform === "win32") {
    actions.push({
      status: "info",
      message: "Windows: PATH-free launcher is not generated; MCP CLI calls rely on the server's own runtime fallback.",
    });
    return;
  }
  if (dryRun) {
    actions.push({ status: "planned", message: `would write PATH-free launcher ${launcherPath(home)}` });
    return;
  }
  try {
    const result = writeLauncherFile(home);
    if (result.path !== null) {
      actions.push({
        status: "done",
        message: result.changed ? `installed launcher ${result.path}` : `launcher up to date: ${result.path}`,
      });
    }
  } catch (error) {
    problems.push(
      problem("LAUNCHER_WRITE_FAILED", error instanceof Error ? error.message : String(error), {
        hint: "The MCP row is still usable for the server itself (absolute command), but its CLI sub-calls need this launcher.",
      })
    );
  }
}

function uninstallLauncher(home: string, dryRun: boolean, actions: InstallAction[], problems: InstallProblem[]): void {
  if (process.platform === "win32") return;
  const path = launcherPath(home);
  if (dryRun) {
    if (existsSync(path)) actions.push({ status: "planned", message: `would remove ${path}` });
    else actions.push({ status: "info", message: `no launcher at ${path} — nothing to remove` });
    return;
  }
  try {
    const removed = removeLauncher(home);
    if (removed.length === 0) actions.push({ status: "info", message: `no launcher at ${path} — nothing to remove` });
    for (const entry of removed) actions.push({ status: "done", message: `removed ${entry}` });
  } catch (error) {
    problems.push(problem("LAUNCHER_REMOVE_FAILED", `Cannot remove "${path}": ${error instanceof Error ? error.message : String(error)}`));
  }
}

function readPatchForEdit(
  patchPath: string,
  actions: InstallAction[],
  problems: InstallProblem[]
): { content: string; editable: boolean } {
  if (!existsSync(patchPath)) {
    problems.push(
      problem("PROFILE_NOT_FOUND", `DSH profile patch not found at "${patchPath}".`, {
        hint: "Boot the DSH profile once (`dsh web`) so it creates profiles/<profile>/cordis.patch.yml, then re-run install-dsh.",
      })
    );
    return { content: "", editable: false };
  }
  try {
    const content = readFileSync(patchPath, "utf-8");
    parsePatchContent(content, patchPath); // validate before offering to edit
    return { content, editable: true };
  } catch (error) {
    if (error instanceof MyGraceError) {
      problems.push({ code: error.code, message: error.message, exitCode: error.exitCode, ...(error.hint === undefined ? {} : { hint: error.hint }) });
    } else {
      problems.push(problem("PATCH_READ_FAILED", `Cannot read "${patchPath}": ${error instanceof Error ? error.message : String(error)}`));
    }
    return { content: "", editable: false };
  }
}

function applyPatchEdit(
  patchPath: string,
  edit: PatchEditResult,
  dryRun: boolean,
  wording: { present: string; planned: string; done: string },
  actions: InstallAction[],
  problems: InstallProblem[]
): void {
  if (!edit.changed) {
    actions.push({ status: "skipped", message: `${wording.present} in ${patchPath} — skipping` });
    return;
  }
  if (dryRun) {
    actions.push({ status: "planned", message: `would ${wording.planned} ${patchPath}` });
    return;
  }
  let backup: string | null = null;
  try {
    backup = createTimestampedBackup(patchPath);
    atomicWriteFile(patchPath, edit.content);
    // Post-write validation: the file must still parse and contain the requested row.
    parsePatchContent(readFileSync(patchPath, "utf-8"), patchPath);
    actions.push({
      status: "done",
      message: `${wording.done} ${patchPath} (backup: ${basename(backup)})`,
    });
  } catch (error) {
    // Restore the pre-edit bytes when the atomic write or its validation failed.
    if (backup !== null && existsSync(backup)) {
      try {
        atomicWriteFile(patchPath, readFileSync(backup, "utf-8"));
        actions.push({ status: "info", message: `restored ${patchPath} from ${basename(backup)} after a failed edit` });
      } catch {
        // The restore itself failing is reported through the original problem below.
      }
    }
    const message = error instanceof MyGraceError ? error.message : `Cannot edit "${patchPath}": ${error instanceof Error ? error.message : String(error)}`;
    problems.push({
      code: error instanceof MyGraceError ? error.code : "PATCH_EDIT_FAILED",
      message,
      exitCode: error instanceof MyGraceError ? error.exitCode : EXIT.FINDINGS,
      ...(error instanceof MyGraceError && error.hint !== undefined ? { hint: error.hint } : {}),
    });
  }
}

function installMcpRow(
  home: string,
  profile: string,
  dryRun: boolean,
  actions: InstallAction[],
  problems: InstallProblem[]
): void {
  const patchPath = profilePatchPath(home, profile);
  const { content, editable } = readPatchForEdit(patchPath, actions, problems);
  if (!editable) return;
  const launcher = process.platform === "win32" ? undefined : launcherPath(home);
  let edit: PatchEditResult;
  try {
    edit = insertRowInPatch(content, mcpPatchRow({ launcher }), MCP_ENTRY_ID, patchPath);
  } catch (error) {
    if (error instanceof MyGraceError) {
      problems.push({ code: error.code, message: error.message, exitCode: error.exitCode, ...(error.hint === undefined ? {} : { hint: error.hint }) });
    } else {
      problems.push(problem("PATCH_EDIT_FAILED", `Cannot prepare the MCP row edit: ${error instanceof Error ? error.message : String(error)}`));
    }
    return;
  }
  applyPatchEdit(
    patchPath,
    edit,
    dryRun,
    { present: "MCP row already present", planned: `insert the ${MCP_ENTRY_ID} MCP row into`, done: `wrote the ${MCP_ENTRY_ID} MCP row into` },
    actions,
    problems
  );
}

function uninstallMcpRow(
  home: string,
  profile: string,
  dryRun: boolean,
  actions: InstallAction[],
  problems: InstallProblem[]
): void {
  const patchPath = profilePatchPath(home, profile);
  if (!existsSync(patchPath)) {
    actions.push({ status: "info", message: `no profile patch at ${patchPath} — nothing to remove` });
    return;
  }
  let content: string;
  try {
    content = readFileSync(patchPath, "utf-8");
  } catch (error) {
    problems.push(problem("PATCH_READ_FAILED", `Cannot read "${patchPath}": ${error instanceof Error ? error.message : String(error)}`));
    return;
  }
  let edit: PatchEditResult;
  try {
    edit = removeRowFromPatch(content, MCP_ENTRY_ID, patchPath);
  } catch (error) {
    if (error instanceof MyGraceError) {
      problems.push({ code: error.code, message: error.message, exitCode: error.exitCode, ...(error.hint === undefined ? {} : { hint: error.hint }) });
    } else {
      problems.push(problem("PATCH_EDIT_FAILED", `Cannot remove the ${MCP_ENTRY_ID} row: ${error instanceof Error ? error.message : String(error)}`));
    }
    return;
  }
  applyPatchEdit(
    patchPath,
    edit,
    dryRun,
    { present: "MCP row already absent", planned: `remove the ${MCP_ENTRY_ID} MCP row from`, done: `removed the ${MCP_ENTRY_ID} MCP row from` },
    actions,
    problems
  );
}

function installPanel(
  home: string,
  profile: string,
  dryRun: boolean,
  actions: InstallAction[],
  problems: InstallProblem[]
): void {
  const source = join(dirname(import.meta.dirname), "packages", PANEL_PACKAGE);
  if (!existsSync(source)) {
    problems.push(
      problem("PANEL_PACKAGE_MISSING", `Panel package not found at "${source}".`, {
        hint: "Reinstall mygrace-cli (the tarball ships packages/mygrace-status-panel).",
      })
    );
    return;
  }
  const patchPath = profilePatchPath(home, profile);
  const { content, editable } = readPatchForEdit(patchPath, actions, problems);

  if (profileHasDependency(home, profile, PANEL_PACKAGE)) {
    actions.push({ status: "skipped", message: `${PANEL_PACKAGE} already in profile ${profile} dependencies — skipping package step` });
  } else if (dryRun) {
    actions.push({ status: "planned", message: `would add file:${source} to DSH profile ${profile} (dsh plugin / pnpm) — LIVE status card` });
  } else {
    const outcome = addPanelPackage(home, profile, source);
    if (!outcome.ok) {
      problems.push(
        problem("PANEL_INSTALL_FAILED", `Cannot install ${PANEL_PACKAGE} into profile ${profile}: ${outcome.reason ?? "unknown error"}`, {
          hint: "The status panel is optional. Install a working pnpm, or run setup install without --panel.",
        })
      );
      return; // Do not write a loader row for a package that is not installed.
    }
    actions.push({
      status: "done",
      message: `installed ${PANEL_PACKAGE} into profile ${profile} (${outcome.via ?? "package manager"}) — LIVE status card via /api/mygrace.status`,
    });
  }

  if (!editable) return;
  let edit: PatchEditResult;
  try {
    edit = insertRowInPatch(content, panelPatchRow(), PANEL_ENTRY_ID, patchPath);
  } catch (error) {
    if (error instanceof MyGraceError) {
      problems.push({ code: error.code, message: error.message, exitCode: error.exitCode, ...(error.hint === undefined ? {} : { hint: error.hint }) });
    } else {
      problems.push(problem("PATCH_EDIT_FAILED", `Cannot prepare the panel row edit: ${error instanceof Error ? error.message : String(error)}`));
    }
    return;
  }
  applyPatchEdit(
    patchPath,
    edit,
    dryRun,
    { present: "panel row already present", planned: `insert the ${PANEL_ENTRY_ID} panel row into`, done: `wrote the ${PANEL_ENTRY_ID} panel row into` },
    actions,
    problems
  );
}

function uninstallPanel(
  home: string,
  profile: string,
  dryRun: boolean,
  actions: InstallAction[],
  problems: InstallProblem[],
  patchAlreadyRestored = false
): void {
  const patchPath = profilePatchPath(home, profile);
  const hasRow = !patchAlreadyRestored && existsSync(patchPath) && patchHasRowSafe(patchPath);
  const hasDep = profileHasDependency(home, profile, PANEL_PACKAGE);

  if (!hasRow && !hasDep) {
    actions.push({ status: "info", message: `panel (${PANEL_PACKAGE}) not installed — nothing to remove` });
    return;
  }

  if (hasRow) {
    let edit: PatchEditResult | null = null;
    try {
      edit = removeRowFromPatch(readFileSync(patchPath, "utf-8"), PANEL_ENTRY_ID, patchPath);
    } catch (error) {
      if (error instanceof MyGraceError) {
        problems.push({ code: error.code, message: error.message, exitCode: error.exitCode, ...(error.hint === undefined ? {} : { hint: error.hint }) });
      } else {
        problems.push(problem("PATCH_EDIT_FAILED", `Cannot remove the ${PANEL_ENTRY_ID} row: ${error instanceof Error ? error.message : String(error)}`));
      }
      return;
    }
    applyPatchEdit(
      patchPath,
      edit,
      dryRun,
      { present: "panel row already absent", planned: `remove the ${PANEL_ENTRY_ID} panel row from`, done: `removed the ${PANEL_ENTRY_ID} panel row from` },
      actions,
      problems
    );
  }

  if (hasDep) {
    if (dryRun) {
      actions.push({ status: "planned", message: `would remove ${PANEL_PACKAGE} from profile ${profile} (dsh plugin / pnpm)` });
      return;
    }
    const outcome = removePanelPackage(home, profile);
    if (!outcome.ok) {
      problems.push(
        problem("PANEL_REMOVE_FAILED", `Cannot remove ${PANEL_PACKAGE} from profile ${profile}: ${outcome.reason ?? "unknown error"}`, {
          hint: "Remove it manually (`dsh plugin --profile <p> remove mygrace-status-panel`), then re-run.",
        })
      );
      return;
    }
    actions.push({ status: "done", message: `removed ${PANEL_PACKAGE} from profile ${profile} (${outcome.via ?? "package manager"})` });
  }
}

/** Non-throwing structural row probe used by uninstall decisions. */
function patchHasRowSafe(file: string): boolean {
  try {
    return patchHasRow(parsePatchContent(readFileSync(file, "utf-8"), file), PANEL_ENTRY_ID);
  } catch {
    return false;
  }
}

function cleanupPatchBackups(
  home: string,
  profile: string,
  dryRun: boolean,
  actions: InstallAction[],
  problems: InstallProblem[]
): void {
  const patchPath = profilePatchPath(home, profile);
  if (!existsSync(patchPath)) return;
  const backups = listBackupFiles(patchPath);
  if (backups.length === 0) return;
  for (const backup of backups) {
    if (dryRun) {
      actions.push({ status: "planned", message: `would remove backup residue ${backup}` });
      continue;
    }
    try {
      rmSync(backup, { force: true });
      actions.push({ status: "done", message: `removed backup residue ${backup}` });
    } catch (error) {
      problems.push(problem("BACKUP_CLEANUP_FAILED", `Cannot remove "${backup}": ${error instanceof Error ? error.message : String(error)}`));
    }
  }
}

/**
 * Read-only preflight: refuse the whole operation (exit 2) when the user config
 * exists but does not parse, so no skills/launcher are written against a config
 * that can never be patched.
 */
function preflightProblems(home: string, profile: string): InstallProblem[] {
  const problems: InstallProblem[] = [];
  if (skillSourceDirs().length === 0) {
    problems.push(
      problem("SKILLS_MISSING", `No MyGRACE skills found in "${skillsSourceDir()}".`, {
        hint: "The package is incomplete; reinstall mygrace-cli (the shipped tarball must contain skills/mygrace/grace-*).",
      })
    );
  }
  const patchPath = profilePatchPath(home, profile);
  if (existsSync(patchPath)) {
    try {
      parsePatchContent(readFileSync(patchPath, "utf-8"), patchPath);
    } catch (error) {
      if (error instanceof MyGraceError) {
        problems.push({
          code: error.code,
          message: error.message,
          exitCode: error.exitCode,
          ...(error.hint === undefined ? {} : { hint: error.hint }),
        });
      } else {
        problems.push(problem("PATCH_READ_FAILED", `Cannot read "${patchPath}": ${error instanceof Error ? error.message : String(error)}`));
      }
    }
  }
  return problems;
}

function finalExitCode(problems: readonly InstallProblem[]): ExitCode {
  if (problems.some((entry) => entry.exitCode === EXIT.INTERNAL)) return EXIT.INTERNAL;
  if (problems.some((entry) => entry.exitCode === EXIT.USAGE)) return EXIT.USAGE;
  if (problems.length > 0) return EXIT.FINDINGS;
  return EXIT.OK;
}

/**
 * Run the installer without printing: returns the actions performed and the
 * typed problems that make the command exit non-zero. `dryRun` never writes.
 */
export function runInstall(options: InstallOptions): InstallResult {
  validateProfileName(options.profile);
  const home = resolve(options.home);
  const dryRun = options.dryRun === true;
  const uninstall = options.uninstall === true;
  const actions: InstallAction[] = [];
  const problems: InstallProblem[] = [];
  const patchPath = profilePatchPath(home, options.profile);

  // Fatal preflight (invalid user YAML => exit 2, nothing written at all).
  const preflight = preflightProblems(home, options.profile);
  const fatal = preflight.filter((entry) => entry.exitCode === EXIT.USAGE);
  if (fatal.length > 0) {
    actions.push({ status: "info", message: "nothing was written — the DSH profile config must be fixed first" });
    return { exitCode: EXIT.USAGE, actions, problems: fatal, dryRun, uninstall };
  }
  problems.push(...preflight);

  if (uninstall) {
    // 1. Restore the pristine patch first when nobody edited it since install.
    const outcome = restoreOriginalPatch(home, options.profile, dryRun, actions, problems);
    uninstallSkills(join(home, "skills"), dryRun, actions, problems);
    // Drop the (now empty) state file before cleaning the launcher directories.
    if (!dryRun) deleteStateFileIfEmpty(home);
    uninstallLauncher(home, dryRun, actions, problems);
    if (!outcome.restored) {
      uninstallMcpRow(home, options.profile, dryRun, actions, problems);
    }
    // Panel row/package removal always runs: the package dependency is not part
    // of the patch original, and row removal is a no-op once restored.
    uninstallPanel(home, options.profile, dryRun, actions, problems, outcome.restored);
    // Keep backups when an edit failed: they are the only reliable restore point.
    if (problems.length === 0 || dryRun) cleanupPatchBackups(home, options.profile, dryRun, actions, problems);
    if (!dryRun) {
      deleteStateFileIfEmpty(home);
      for (const entry of removeEmptyLauncherDirs(home)) actions.push({ status: "done", message: `removed ${entry}` });
    }
  } else {
    const before = existsSync(patchPath) ? readFileSync(patchPath, "utf-8") : null;
    // A stale baseline (the user edited the patch since our last install) must
    // not be used for a byte-identical restore: fall back to structural removal
    // so the user's edits survive the next uninstall.
    const state = loadState(home);
    const stateEntry = state.profiles[options.profile];
    if (stateEntry !== undefined && before !== null && sha256(before) !== stateEntry.installedHash) {
      actions.push({
        status: "info",
        message: `${patchPath} changed since the last install — uninstall will remove only MyGRACE rows (your edits are preserved)`,
      });
      if (!dryRun) {
        delete state.profiles[options.profile];
        saveState(home, state);
      }
    }
    installSkills(join(home, "skills"), dryRun, actions, problems);
    installLauncher(home, dryRun, actions, problems);
    installMcpRow(home, options.profile, dryRun, actions, problems);
    if (options.panel === true) installPanel(home, options.profile, dryRun, actions, problems);
    if (!dryRun) rememberInstall(home, options.profile, patchPath, before, actions, problems);
  }

  return { exitCode: finalExitCode(problems), actions, problems, dryRun, uninstall };
}

// ─── Command ────────────────────────────────────────────────────────────

export const installDshCommand = defineCommand({
  meta: {
    name: "install",
    description:
      "Install MyGRACE into DeepSeek Harness: skills to $DSH_HOME/skills, a PATH-free MCP row in the profile's cordis.patch.yml, and (with --panel) the opt-in LIVE MyGRACE status card (host route /api/mygrace.status + polling sidebar card). --dry-run/--uninstall supported; --bundle was removed in v1.1.",
  },
  args: {
    profile: { type: "string", default: "web", description: "DSH profile to patch (default: web)" },
    dryRun: { type: "boolean", default: false, description: "Print planned actions without writing anything" },
    uninstall: { type: "boolean", default: false, description: "Remove the installation instead of installing" },
    panel: {
      type: "boolean",
      default: false,
      description: "Also install the opt-in LIVE MyGRACE status card (reads `mygrace status` via /api/mygrace.status; needs a working package manager)",
    },
    bundle: {
      type: "boolean",
      default: false,
      description: "Removed in v1.1: the mygrace-dsh bundle is an unpublished optional preview",
    },
    dshHome: { type: "string", description: "Override the DSH home (default: $DSH_HOME or ~/.dsh)" },
  },
  run: async ({ args }) => {
    if (args.bundle === true) {
      throw new UsageError(
        "`install-dsh --bundle` was removed in v1.1: the mygrace-dsh bundle is an unpublished optional preview (it needs unpublished preview packages and a private panel package).",
        {
          hint: "Use `mygrace setup install` (skills + PATH-free MCP row) or `mygrace setup install --panel` for the LIVE status card.",
        }
      );
    }

    const home = resolve(args.dshHome ?? dshHome());
    const uninstall = args.uninstall === true;
    const dryRun = args.dryRun === true;
    const result = runInstall({
      home,
      profile: args.profile,
      dryRun,
      uninstall,
      panel: args.panel === true,
    });

    console.log(`MyGRACE ${uninstall ? "uninstall" : "install"} for DeepSeek Harness`);
    console.log(`DSH home:   ${home}`);
    console.log(`Profile:    ${args.profile}`);
    console.log(`Skills dir: ${join(home, "skills")}`);
    if (dryRun) console.log("DRY RUN — no changes will be written");
    console.log();

    for (const action of result.actions) console.log(`• ${action.message}`);
    for (const entry of result.problems) {
      console.error(`• ERROR ${entry.code}: ${entry.message}`);
      if (entry.hint !== undefined) console.error(`  → ${entry.hint}`);
    }
    console.log();

    if (result.problems.length > 0) {
      throw new MyGraceError(
        "INSTALL_INCOMPLETE",
        `${result.problems.length} install step(s) failed — the steps listed above did complete, nothing else was written.`,
        {
          exitCode: result.exitCode,
          hint: uninstall
            ? "Fix the errors above and re-run `mygrace setup install --uninstall` to finish removing the integration."
            : "Fix the errors above and re-run `mygrace setup install`; it is idempotent.",
        }
      );
    }

    if (dryRun) {
      console.log("Dry run complete — no changes were written.");
      return;
    }

    if (uninstall) {
      console.log("Uninstall complete: skills, launcher, MCP row, panel and backup residue removed.");
      return;
    }

    console.log("Done. To activate:");
    console.log("  1. MCP tools: restart the harness (dsh web) or open a new session so the row loads.");
    console.log("  2. Skills appear in the skill catalog automatically (watched).");
    let activationStep = 3;
    if (args.panel === true) console.log(`  ${activationStep++}. LIVE MyGRACE status card: refresh the web page (F5) — the host route /api/mygrace.status computes fresh data from \`mygrace status\`.`);
    console.log(`  ${activationStep}. In a project: ensure AGENTS.md exists so the agent follows MyGRACE automatically.`);
  },
});
