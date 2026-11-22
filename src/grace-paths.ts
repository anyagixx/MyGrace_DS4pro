/**
 * MyGRACE — Entity ids and path safety (ROADMAP ADR-4).
 *
 * Module/phase/verification ids reach the filesystem (`docs/modules/<id>.xml`)
 * and the shell (`mygrace test --module <id>`). In a cloned repo those ids come
 * from attacker-controlled XML, so every id is validated and every resolved
 * path is proven to stay inside its docs directory before use.
 */

// START_MODULE_CONTRACT
//   PURPOSE: Validate entity ids and resolve entity/config paths without allowing traversal.
//   SCOPE: Path arithmetic and validation only; no reading/writing.
//   DEPENDS: node:path
//   LINKS: ROADMAP.md (ADR-4)
// END_MODULE_CONTRACT

// START_MODULE_MAP
//   EntityKind          — "module" | "verification" | "phase"
//   assertEntityId()    — validate + return id, or throw UsageError
//   entityDir()         — docs/{modules,plans,verification}
//   entityPath()        — validated entity file path
//   assertSafeRelativePath() — reject absolute paths, "..", empty segments
//   resolveWithin()     — resolve a candidate and prove it stays under a base dir
//   isWithin()          — containment test on normalized paths
// END_MODULE_MAP

import { isAbsolute, join, normalize, resolve, sep } from "node:path";
import { UsageError } from "./grace-errors";

export type EntityKind = "module" | "verification" | "phase";

const ID_PATTERNS: Record<EntityKind, RegExp> = {
  module: /^M-[A-Za-z0-9][A-Za-z0-9_-]*$/,
  verification: /^V-M-[A-Za-z0-9][A-Za-z0-9_-]*$/,
  phase: /^Phase-[0-9]+[A-Za-z]?$/,
};

const KIND_LABELS: Record<EntityKind, string> = {
  module: "module id (expected M-XXX, e.g. M-AUTH)",
  verification: "verification id (expected V-M-XXX, e.g. V-M-AUTH)",
  phase: "phase id (expected Phase-N, e.g. Phase-1)",
};

const ENTITY_DIRS: Record<EntityKind, string> = {
  module: join("docs", "modules"),
  verification: join("docs", "verification"),
  phase: join("docs", "plans"),
};

/**
 * Validate an entity id coming from a CLI argument, XML attribute or MCP call.
 *
 * Rejects traversal (`../`), absolute paths, separators, leading dashes and
 * anything outside the documented id grammar. Throws `UsageError` (exit 2).
 */
export function assertEntityId(kind: EntityKind, id: string | undefined | null): string {
  const value = (id ?? "").trim();
  if (value === "") {
    throw new UsageError(`Missing ${KIND_LABELS[kind]}.`, {
      hint: `Pass the id as an argument, e.g. \`mygrace ${commandFor(kind)} M-AUTH\`.`,
    });
  }
  if (!ID_PATTERNS[kind].test(value)) {
    throw new UsageError(`Invalid ${KIND_LABELS[kind]} — got "${value}".`, {
      hint: "Ids may contain only letters, digits, '_' and '-', and must match the documented shape.",
    });
  }
  return value;
}

function commandFor(kind: EntityKind): string {
  switch (kind) {
    case "module":
      return "module show";
    case "verification":
      return "verification index";
    case "phase":
      return "phase show";
  }
}

/** `docs/modules`, `docs/plans` or `docs/verification` relative to a project root. */
export function entityDir(projectRoot: string, kind: EntityKind): string {
  return join(projectRoot, ENTITY_DIRS[kind]);
}

/** Validated path of an entity file. */
export function entityPath(projectRoot: string, kind: EntityKind, id: string): string {
  const safeId = assertEntityId(kind, id);
  return join(entityDir(projectRoot, kind), `${safeId}.xml`);
}

/**
 * Reject paths that escape their base: absolute paths, `..` segments, empty
 * segments, NUL bytes and Windows drive/UNC prefixes.
 */
export function assertSafeRelativePath(candidate: string, label = "path"): string {
  const value = (candidate ?? "").trim();
  if (value === "") throw new UsageError(`Empty ${label}.`);
  if (value.includes("\0")) throw new UsageError(`Invalid ${label}: contains a NUL byte.`);
  if (isAbsolute(value) || /^[A-Za-z]:[\\/]/.test(value) || value.startsWith("\\\\")) {
    throw new UsageError(`Invalid ${label} "${value}": absolute paths are not allowed here.`, {
      hint: "Pass a path relative to the project root.",
    });
  }
  const segments = value.split(/[\\/]+/).filter((segment) => segment !== "" && segment !== ".");
  if (segments.some((segment) => segment === "..")) {
    throw new UsageError(`Invalid ${label} "${value}": parent directory segments ("..") are not allowed.`);
  }
  return value;
}

/** True when `child` is `parent` or lives underneath it (both normalized). */
export function isWithin(parent: string, child: string): boolean {
  const base = normalize(resolve(parent));
  const target = normalize(resolve(child));
  if (target === base) return true;
  return target.startsWith(base.endsWith(sep) ? base : `${base}${sep}`);
}

/**
 * Resolve `candidate` against `baseDir` and prove the result stays inside it.
 * `candidate` may be absolute only when it is already inside `baseDir`.
 */
export function resolveWithin(baseDir: string, candidate: string, label = "path"): string {
  const base = resolve(baseDir);
  const target = isAbsolute(candidate) ? normalize(resolve(candidate)) : normalize(resolve(base, candidate));
  if (!isWithin(base, target)) {
    throw new UsageError(
      `Refusing to use ${label} "${candidate}": it resolves outside "${base}".`,
      { hint: "Paths must stay inside the project directory." }
    );
  }
  return target;
}

/** `docs/<name>` relative path, for messages and lint findings. */
export function docsRelative(...segments: string[]): string {
  return join("docs", ...segments);
}
