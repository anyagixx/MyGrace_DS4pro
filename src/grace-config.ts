/**
 * MyGRACE — Project configuration (ROADMAP ADR-5).
 *
 * v1 hardcoded the layout (`src`, `lib`, `apps`, `packages`) and every budget.
 * That makes the tool unusable outside its own conventions and blocks
 * "any complexity" projects (Python/Go/Rust repos, monorepos, unusual tree
 * shapes). A single optional JSON config now covers layout, budgets, runtimes
 * and the security policy, with defaults that reproduce v1 behaviour.
 */

// START_MODULE_CONTRACT
//   PURPOSE: Load, validate and expose project configuration with safe defaults.
//   SCOPE: JSON file in the project root named mygrace.config.json; no other sources.
//   DEPENDS: grace-errors (ConfigError), node:fs, node:path
//   LINKS: ROADMAP.md (ADR-5)
// END_MODULE_CONTRACT

// START_MODULE_MAP
//   CONFIG_FILENAME          — "mygrace.config.json"
//   MyGraceConfig            — fully resolved configuration (all fields required after load)
//   DEFAULT_CONFIG           — v1-compatible defaults
//   loadConfig()             — read + validate, throws ConfigError with all issues listed
//   tryLoadConfig()          — non-throwing variant
//   configPath()             — absolute config path for a project root
//   serializeConfig()        — stable JSON used by `mygrace init-dsh`
// END_MODULE_MAP

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { ConfigError } from "./grace-errors";

export const CONFIG_FILENAME = "mygrace.config.json";

export interface IndexCaps {
  graph: number;
  plan: number;
  verification: number;
}

export interface SizeBudgets {
  module: readonly [number, number];
  phase: readonly [number, number];
  verification: readonly [number, number];
}

export interface MyGraceConfig {
  /** Directories scanned for semantic markup (relative to the project root). */
  sourceDirs: string[];
  /** File extensions considered source code. */
  markupExts: string[];
  /** Directory names skipped while scanning (any depth). */
  ignoreDirs: string[];
  /** Maximum lines for index files; lint reports errors above them. */
  indexCaps: IndexCaps;
  /** Expected line ranges per entity file; lint reports warnings outside them. */
  sizeBudgets: SizeBudgets;
  /** Command used when a module does not declare its own checks. */
  testRunner: string;
  /**
   * When false (default), project-declared commands require a trust record
   * before `mygrace test`/`verify` will execute them (ROADMAP ADR-1).
   */
  allowCommands: boolean;
  /** Free-form project language label, used only in generated docs. */
  language: string;
}

/** Defaults reproduce v1 behaviour so existing projects keep working. */
export const DEFAULT_CONFIG: MyGraceConfig = {
  sourceDirs: ["src", "lib", "apps", "packages"],
  markupExts: [".ts", ".js", ".mjs", ".cjs", ".tsx", ".jsx", ".py", ".go", ".java", ".rs", ".rb"],
  ignoreDirs: [
    "node_modules",
    ".git",
    ".hg",
    ".svn",
    "dist",
    "build",
    "out",
    "target",
    "vendor",
    "coverage",
    ".next",
    ".nuxt",
    ".venv",
    "venv",
    "__pycache__",
    ".mypy_cache",
    ".pytest_cache",
    ".idea",
    ".vscode",
  ],
  indexCaps: { graph: 100, plan: 50, verification: 80 },
  sizeBudgets: { module: [30, 80], phase: [50, 200], verification: [20, 60] },
  testRunner: "bun test",
  allowCommands: false,
  language: "typescript",
};

/** Absolute path of the config file for a project root. */
export function configPath(projectRoot: string): string {
  return join(projectRoot, CONFIG_FILENAME);
}

export interface ConfigLoadResult {
  config: MyGraceConfig;
  /** Path the config was read from, or undefined when defaults are used. */
  path?: string;
  /** Raw user object (before defaults), for diagnostics. */
  raw?: Record<string, unknown>;
}

/**
 * Load configuration from `<root>/mygrace.config.json`.
 *
 * A missing file is not an error (defaults apply). A malformed or wrongly
 * typed file is a `ConfigError` that lists every problem at once, because
 * agents fix configs faster when they get the full list.
 */
export function loadConfig(projectRoot: string): ConfigLoadResult {
  const path = configPath(projectRoot);
  if (!existsSync(path)) return { config: cloneDefault(), path: undefined };

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf-8"));
  } catch (error) {
    throw new ConfigError(`Cannot parse ${CONFIG_FILENAME}: ${error instanceof Error ? error.message : String(error)}`, {
      file: CONFIG_FILENAME,
      hint: "The file must contain valid JSON; run `mygrace init-dsh --force` to regenerate defaults.",
    });
  }

  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new ConfigError(`${CONFIG_FILENAME} must contain a JSON object.`, { file: CONFIG_FILENAME });
  }

  const raw = parsed as Record<string, unknown>;
  const issues: string[] = [];
  const config = applyUserConfig(raw, issues);

  if (issues.length > 0) {
    throw new ConfigError(`Invalid ${CONFIG_FILENAME}: ${issues.length} problem(s).`, {
      file: CONFIG_FILENAME,
      hint: issues.join("; "),
    });
  }

  return { config, path, raw };
}

/** Non-throwing variant: on invalid config returns defaults plus the error. */
export function tryLoadConfig(
  projectRoot: string
): { ok: true; result: ConfigLoadResult } | { ok: false; error: ConfigError } {
  try {
    return { ok: true, result: loadConfig(projectRoot) };
  } catch (error) {
    if (error instanceof ConfigError) return { ok: false, error };
    throw error;
  }
}

/** Stable serialization used when `init-dsh` writes the default config. */
export function serializeConfig(config: MyGraceConfig): string {
  return `${JSON.stringify(config, null, 2)}\n`;
}

export function cloneDefault(): MyGraceConfig {
  return {
    ...DEFAULT_CONFIG,
    sourceDirs: [...DEFAULT_CONFIG.sourceDirs],
    markupExts: [...DEFAULT_CONFIG.markupExts],
    ignoreDirs: [...DEFAULT_CONFIG.ignoreDirs],
    indexCaps: { ...DEFAULT_CONFIG.indexCaps },
    sizeBudgets: {
      module: [...DEFAULT_CONFIG.sizeBudgets.module],
      phase: [...DEFAULT_CONFIG.sizeBudgets.phase],
      verification: [...DEFAULT_CONFIG.sizeBudgets.verification],
    },
  };
}

// START_BLOCK_USER_OVERRIDES
const KNOWN_KEYS = new Set<keyof MyGraceConfig>([
  "sourceDirs",
  "markupExts",
  "ignoreDirs",
  "indexCaps",
  "sizeBudgets",
  "testRunner",
  "allowCommands",
  "language",
]);

function applyUserConfig(raw: Record<string, unknown>, issues: string[]): MyGraceConfig {
  const config = cloneDefault();

  for (const key of Object.keys(raw)) {
    if (!KNOWN_KEYS.has(key as keyof MyGraceConfig)) {
      issues.push(`unknown key "${key}" (allowed: ${[...KNOWN_KEYS].join(", ")})`);
    }
  }

  const stringArray = (name: string, target: string[]): void => {
    const value = raw[name];
    if (value === undefined) return;
    if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || item.trim() === "")) {
      issues.push(`"${name}" must be an array of non-empty strings`);
      return;
    }
    target.length = 0;
    for (const item of value as string[]) target.push(item.trim());
  };

  stringArray("sourceDirs", config.sourceDirs);
  stringArray("markupExts", config.markupExts);
  stringArray("ignoreDirs", config.ignoreDirs);

  const testRunner = raw.testRunner;
  if (testRunner !== undefined) {
    if (typeof testRunner !== "string" || testRunner.trim() === "") {
      issues.push('"testRunner" must be a non-empty string');
    } else {
      config.testRunner = testRunner.trim();
    }
  }

  const allowCommands = raw.allowCommands;
  if (allowCommands !== undefined) {
    if (typeof allowCommands !== "boolean") issues.push('"allowCommands" must be a boolean');
    else config.allowCommands = allowCommands;
  }

  const language = raw.language;
  if (language !== undefined) {
    if (typeof language !== "string" || language.trim() === "") issues.push('"language" must be a non-empty string');
    else config.language = language.trim();
  }

  applyIndexCaps(raw.indexCaps, config, issues);
  applySizeBudgets(raw.sizeBudgets, config, issues);

  return config;
}

function positiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

function applyIndexCaps(value: unknown, config: MyGraceConfig, issues: string[]): void {
  if (value === undefined) return;
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    issues.push('"indexCaps" must be an object with graph/plan/verification numbers');
    return;
  }
  const caps = value as Record<string, unknown>;
  for (const key of Object.keys(caps)) {
    if (!["graph", "plan", "verification"].includes(key)) issues.push(`unknown indexCaps key "${key}"`);
  }
  for (const key of ["graph", "plan", "verification"] as const) {
    const cap = caps[key];
    if (cap === undefined) continue;
    if (!positiveInteger(cap)) issues.push(`"indexCaps.${key}" must be a positive integer`);
    else config.indexCaps[key] = cap;
  }
}

function applySizeBudgets(value: unknown, config: MyGraceConfig, issues: string[]): void {
  if (value === undefined) return;
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    issues.push('"sizeBudgets" must be an object with module/phase/verification [min,max] pairs');
    return;
  }
  const budgets = value as Record<string, unknown>;
  for (const key of Object.keys(budgets)) {
    if (!["module", "phase", "verification"].includes(key)) issues.push(`unknown sizeBudgets key "${key}"`);
  }
  for (const key of ["module", "phase", "verification"] as const) {
    const budget = budgets[key];
    if (budget === undefined) continue;
    if (
      !Array.isArray(budget) ||
      budget.length !== 2 ||
      !positiveInteger(budget[0]) ||
      !positiveInteger(budget[1]) ||
      budget[0] > budget[1]
    ) {
      issues.push(`"sizeBudgets.${key}" must be [min, max] positive integers with min <= max`);
      continue;
    }
    config.sizeBudgets[key] = [budget[0], budget[1]] as const;
  }
}
// END_BLOCK_USER_OVERRIDES
