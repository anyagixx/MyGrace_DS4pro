#!/usr/bin/env bun
/**
 * MyGRACE installer — atomic file writes and timestamped backups.
 *
 * Extracted from grace-install.ts in v3.6.0 to keep the installer module below
 * the maintainability budget; the public functions are re-exported from
 * grace-install.ts so existing imports keep working.
 */

// START_MODULE_CONTRACT
//   PURPOSE: Atomic file writes (tmp+rename, mode preserving) and never-overwritten timestamped backups for installer config edits.
//   SCOPE: node:fs only; no network, no YAML, no CLI wiring.
//   DEPENDS: grace-errors, node:fs, node:path
//   LINKS: docs/modules/M-INSTALL.xml
// END_MODULE_CONTRACT

// START_MODULE_MAP
//   atomicWriteFile()          — tmp+rename write preserving mode
//   createTimestampedBackup()  — never-overwritten backup
//   listBackupFiles()/cleanupBackups() — residue discovery/removal
// END_MODULE_MAP

import {
  chmodSync, copyFileSync, constants as fsConstants, existsSync, readdirSync, renameSync, rmSync, statSync, writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import { EXIT, MyGraceError } from "./grace-errors";

const BACKUP_INFIX = ".mygrace-backup";
const LEGACY_BACKUP_SUFFIX = ".mygrace-backup";

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


