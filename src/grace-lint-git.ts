#!/usr/bin/env bun
/**
 * MyGRACE lint — changed-file scope (git/--files).
 *
 * Extracted from grace-lint.ts in v3.6.0 to keep the lint module below the
 * maintainability budget; grace-lint.ts re-exports these functions so existing
 * imports keep working.
 */

// START_MODULE_CONTRACT
//   PURPOSE: Resolve `lint --changed` scope from git (base/untracked) or explicit --files with path-safety checks.
//   SCOPE: spawns read-only git commands; no docs reads, no writes.
//   DEPENDS: grace-errors, grace-paths, node:child_process
//   LINKS: docs/modules/M-LINT.xml
// END_MODULE_CONTRACT

// START_MODULE_MAP
//   ChangedScope/ChangedFileOptions — public types re-exported by grace-lint
//   runGit()/resolveChangedFiles()/parseChangedFilesArg() — scope resolution
// END_MODULE_MAP

import { spawnSync } from "node:child_process";
import { UsageError } from "./grace-errors";
import { assertSafeRelativePath } from "./grace-paths";

const GIT_TIMEOUT_MS = 2000;

export interface ChangedScope {
  /** Every changed file, project-relative and sorted. */
  changed: string[];
  /** Changed files that fall inside the lint scope (index, entity, docs XML or configured source). */
  scanned: string[];
  /** Changed files that are outside the lint scope (unknown type/extension, outside the project). */
  skipped: string[];
}

export interface ChangedFileOptions {
  /** Git revision to diff against (default HEAD). */
  base?: string;
  /** Explicit comma/space separated file list; works without git. */
  files?: string;
}

interface GitResult {
  ok: boolean;
  stdout: string;
  message: string;
}

function runGit(root: string, args: readonly string[]): GitResult {
  const result = spawnSync("git", ["-C", root, ...args], {
    encoding: "utf-8",
    timeout: GIT_TIMEOUT_MS,
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.error !== undefined) {
    return { ok: false, stdout: "", message: result.error.message };
  }
  if (result.status !== 0) {
    return {
      ok: false,
      stdout: result.stdout ?? "",
      message: (result.stderr ?? "").trim() || `git ${args.join(" ")} exited ${result.status ?? "?"}`,
    };
  }
  return { ok: true, stdout: result.stdout ?? "", message: "" };
}

function normalizeChangedPath(value: string): string | null {
  const candidate = value.trim().replaceAll("\\", "/");
  if (candidate === "") return null;
  try {
    assertSafeRelativePath(candidate, "changed file path");
  } catch {
    return null;
  }
  return candidate;
}

/** Parse `--files a,b,c` (comma and/or whitespace separated); unsafe paths are rejected. */
export function parseChangedFilesArg(value: string): string[] {
  const parsed: string[] = [];
  for (const part of value.split(/[,\s]+/u)) {
    const normalized = normalizeChangedPath(part);
    if (normalized !== null && !parsed.includes(normalized)) parsed.push(normalized);
  }
  return parsed.sort();
}

/**
 * Resolve the changed-file set for `lint --changed`.
 *
 * `--files` takes precedence and needs no git. Otherwise the project must be a
 * git work tree: `git diff --name-only <base>` (default `HEAD`) runs with a 2 s
 * timeout and untracked files are added best-effort. Paths are made relative to
 * the project root (works for subdirectories of a larger repository) and
 * validated against the project path grammar.
 */
export function resolveChangedFiles(
  root: string,
  options: ChangedFileOptions = {}
): { source: "files" | "git"; scope: ChangedScope } {
  const explicit = (options.files ?? "").trim();
  if (explicit !== "") {
    const changed = parseChangedFilesArg(explicit);
    return {
      source: "files",
      scope: { changed, scanned: [], skipped: [] },
    };
  }

  const inside = runGit(root, ["rev-parse", "--is-inside-work-tree"]);
  if (!inside.ok || inside.stdout.trim() !== "true") {
    throw new UsageError("--changed needs a git repository (or explicit --files).", {
      hint: "Run inside a git work tree, or pass changed files explicitly: mygrace lint --changed --files src/a.ts,docs/graph-index.xml.",
    });
  }

  const base = ((options.base ?? "HEAD").trim() || "HEAD") as string;
  if (base.startsWith("-") || !/^[A-Za-z0-9._/@{}~^-]+$/u.test(base)) {
    throw new UsageError(`Invalid --base revision "${base}".`, {
      hint: "Pass a git revision name (default HEAD).",
    });
  }

  const prefixResult = runGit(root, ["rev-parse", "--show-prefix"]);
  const prefix = prefixResult.ok ? prefixResult.stdout.trim() : "";

  const diff = runGit(root, ["diff", "--name-only", base, "--"]);
  if (!diff.ok) {
    throw new UsageError(`git diff failed: ${diff.message}`, {
      hint: "Check --base (default HEAD) and that the repository has at least one commit.",
    });
  }
  const untracked = runGit(root, ["ls-files", "--others", "--exclude-standard"]);

  const rawLines = [
    ...diff.stdout.split("\n"),
    ...(untracked.ok ? untracked.stdout.split("\n") : []),
  ];
  const changed: string[] = [];
  const skipped: string[] = [];
  for (const line of rawLines) {
    const repoPath = line.trim().replaceAll("\\", "/");
    if (repoPath === "") continue;
    let projectPath = repoPath;
    if (prefix !== "") {
      if (!repoPath.startsWith(prefix)) {
        skipped.push(repoPath);
        continue;
      }
      projectPath = repoPath.slice(prefix.length);
    }
    const normalized = normalizeChangedPath(projectPath);
    if (normalized === null) {
      skipped.push(repoPath);
      continue;
    }
    if (!changed.includes(normalized)) changed.push(normalized);
  }
  changed.sort();
  return { source: "git", scope: { changed, scanned: [], skipped: skipped.sort() } };
}

