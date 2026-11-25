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
//   serializeConfig()        — stable JSON used by `mygrace setup init`
//   IntegrationsConfig       — optional external integrations (ADR-9), validated like every other field
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

export type IntegrationEnabled = "auto" | boolean;

/** One external integration entry (ROADMAP ADR-9). */
export interface IntegrationSettings {
  /** "auto" uses the tool when detected; true marks it required (warning when missing); false disables it. */
  enabled: IntegrationEnabled;
  /** Explicit executable/script path (absolute or project-relative); null means env/PATH detection. */
  bin: string | null;
  /** Tested version range, e.g. ">=0.29 <0.30". */
  versionRange: string;
  /** Child-process timeout for adapter probes/commands. */
  timeoutMs: number;
}

export interface ArchifyIntegrationSettings extends IntegrationSettings {
  /** Directory for generated diagram artifacts (relative to the project root). */
  outputDir: string;
}

export interface CapsuleIntegrationSettings {
  enabled: IntegrationEnabled;
  /** Directory holding capsule definitions (relative to the project root). */
  dir: string;
  /** Allow capsule programs that mutate project state (off by default). */
  allowMutatingPrograms: boolean;
}

export interface IntegrationsConfig {
  octocode: IntegrationSettings;
  archify: ArchifyIntegrationSettings;
  capsules: CapsuleIntegrationSettings;
  /** Optional web-platform guidance CLI (Modern Web Guidance); advisory detection only. */
  modernWebGuidance: IntegrationSettings;
}

/** Provider adapter shape for an external lint scanner (ADR-11). */
export type LintProviderAdapter = "legacy-scan" | "json-findings";

/** One optional external lint provider. */
export interface LintProviderSettings {
  /** Stable unique name used in findings and audit logs. */
  name: string;
  /** "auto"/true runs the provider when authorized; false disables it. */
  enabled: IntegrationEnabled;
  adapter: LintProviderAdapter;
  /** Command template; `{path}` is replaced with the project root (tokenized, no shell). */
  command: string;
  timeoutMs: number;
  /** Severity of provider findings: error fails lint, warning needs --strict, none reports info. */
  failOn: "error" | "warning" | "none";
}

/** Provider shape for a guidance pack (ADR-12). */
export type GuidancePackKind = "local" | "cli";

/** One optional guidance pack. */
export interface GuidancePackSettings {
  name: string;
  enabled: IntegrationEnabled;
  kind: GuidancePackKind;
  /** Local pack directory (contains guidance-pack.json); null for CLI packs. */
  path: string | null;
  /** CLI command prefix for search/retrieve; null for local packs. */
  command: string | null;
  timeoutMs: number;
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
  /** Optional external integrations (ADR-9); all default to disabled-by-detection. */
  integrations: IntegrationsConfig;
  /** Optional trust-gated external lint providers (ADR-11); empty by default. */
  lintProviders: LintProviderSettings[];
  /** Optional guidance packs (ADR-12); empty by default. */
  guidancePacks: GuidancePackSettings[];
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
  integrations: {
    octocode: { enabled: "auto", bin: null, versionRange: ">=0.29 <0.30", timeoutMs: 10_000 },
    archify: {
      enabled: "auto",
      bin: null,
      versionRange: ">=3.2 <4",
      timeoutMs: 30_000,
      outputDir: join("docs", "diagrams"),
    },
    capsules: { enabled: false, dir: "capsules", allowMutatingPrograms: false },
    modernWebGuidance: { enabled: "auto", bin: null, versionRange: ">=1.0 <2", timeoutMs: 20_000 },
  },
  lintProviders: [],
  guidancePacks: [],
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
      hint: "The file must contain valid JSON; run `mygrace setup init --force` to regenerate defaults.",
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

/** Stable serialization used when `setup init` writes the default config. */
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
    integrations: {
      octocode: { ...DEFAULT_CONFIG.integrations.octocode },
      archify: { ...DEFAULT_CONFIG.integrations.archify },
      capsules: { ...DEFAULT_CONFIG.integrations.capsules },
      modernWebGuidance: { ...DEFAULT_CONFIG.integrations.modernWebGuidance },
    },
    lintProviders: [],
    guidancePacks: [],
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
  "integrations",
  "lintProviders",
  "guidancePacks",
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
  applyIntegrations(raw.integrations, config, issues);
  applyLintProviders(raw.lintProviders, config, issues);
  applyGuidancePacks(raw.guidancePacks, config, issues);

  return config;
}

// START_BLOCK_INTEGRATIONS
const VERSION_RANGE_RE = /^(\s*(>=|<=|>|<|=)?\s*v?\d+(?:\.\d+){0,2})*\s*$/;
const INTEGRATION_KEYS = new Set(["octocode", "archify", "capsules", "modernWebGuidance"]);
const OCTOCODE_KEYS = new Set(["enabled", "bin", "versionRange", "timeoutMs"]);
const ARCHIFY_KEYS = new Set(["enabled", "bin", "versionRange", "timeoutMs", "outputDir"]);
const CAPSULE_KEYS = new Set(["enabled", "dir", "allowMutatingPrograms"]);
const MWG_KEYS = new Set(["enabled", "bin", "versionRange", "timeoutMs"]);

function applyIntegrations(value: unknown, config: MyGraceConfig, issues: string[]): void {
  if (value === undefined) return;
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    issues.push('"integrations" must be an object with octocode/archify/capsules/modernWebGuidance entries');
    return;
  }
  const sections = value as Record<string, unknown>;
  for (const key of Object.keys(sections)) {
    if (!INTEGRATION_KEYS.has(key)) issues.push(`unknown integrations key "${key}"`);
  }
  const readSection = (
    name: "octocode" | "archify" | "capsules" | "modernWebGuidance",
    allowed: Set<string>
  ): Record<string, unknown> | undefined => {
    const entry = sections[name];
    if (entry === undefined) return undefined;
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
      issues.push(`"integrations.${name}" must be an object`);
      return undefined;
    }
    for (const key of Object.keys(entry as Record<string, unknown>)) {
      if (!allowed.has(key)) issues.push(`unknown integrations.${name} key "${key}"`);
    }
    return entry as Record<string, unknown>;
  };

  const enabledFor = (section: Record<string, unknown>, label: string): void => {
    const enabled = section.enabled;
    if (enabled === undefined) return;
    if (enabled === true || enabled === false || enabled === "auto") {
      if (label === "archify") config.integrations.archify.enabled = enabled;
      else if (label === "octocode") config.integrations.octocode.enabled = enabled;
      else config.integrations.capsules.enabled = enabled;
      return;
    }
    issues.push(`"integrations.${label}.enabled" must be "auto", true or false`);
  };
  const binFor = (section: Record<string, unknown>, target: { bin: string | null }, label: string): void => {
    const bin = section.bin;
    if (bin === undefined) return;
    if (bin === null) {
      target.bin = null;
      return;
    }
    if (typeof bin !== "string" || bin.trim() === "") {
      issues.push(`"integrations.${label}.bin" must be a non-empty string or null`);
      return;
    }
    target.bin = bin.trim();
  };
  const rangeFor = (section: Record<string, unknown>, target: { versionRange: string }, label: string): void => {
    const range = section.versionRange;
    if (range === undefined) return;
    if (typeof range !== "string" || !VERSION_RANGE_RE.test(range) || !/\d+/.test(range)) {
      issues.push(`"integrations.${label}.versionRange" must be a range like ">=0.29 <0.30"`);
      return;
    }
    target.versionRange = range.trim();
  };
  const timeoutFor = (section: Record<string, unknown>, target: { timeoutMs: number }, label: string): void => {
    const timeout = section.timeoutMs;
    if (timeout === undefined) return;
    if (!positiveInteger(timeout) || timeout < 100 || timeout > 600_000) {
      issues.push(`"integrations.${label}.timeoutMs" must be an integer between 100 and 600000`);
      return;
    }
    target.timeoutMs = timeout;
  };

  const octocode = readSection("octocode", OCTOCODE_KEYS);
  if (octocode !== undefined) {
    enabledFor(octocode, "octocode");
    binFor(octocode, config.integrations.octocode, "octocode");
    rangeFor(octocode, config.integrations.octocode, "octocode");
    timeoutFor(octocode, config.integrations.octocode, "octocode");
  }

  const archify = readSection("archify", ARCHIFY_KEYS);
  if (archify !== undefined) {
    enabledFor(archify, "archify");
    binFor(archify, config.integrations.archify, "archify");
    rangeFor(archify, config.integrations.archify, "archify");
    timeoutFor(archify, config.integrations.archify, "archify");
    const outputDir = archify.outputDir;
    if (outputDir !== undefined) {
      if (typeof outputDir !== "string" || outputDir.trim() === "") {
        issues.push('"integrations.archify.outputDir" must be a non-empty string');
      } else {
        config.integrations.archify.outputDir = outputDir.trim();
      }
    }
  }

  const modernWebGuidance = readSection("modernWebGuidance", MWG_KEYS);
  if (modernWebGuidance !== undefined) {
    enabledFor(modernWebGuidance, "modernWebGuidance");
    binFor(modernWebGuidance, config.integrations.modernWebGuidance, "modernWebGuidance");
    rangeFor(modernWebGuidance, config.integrations.modernWebGuidance, "modernWebGuidance");
    timeoutFor(modernWebGuidance, config.integrations.modernWebGuidance, "modernWebGuidance");
  }

  const capsules = readSection("capsules", CAPSULE_KEYS);
  if (capsules !== undefined) {
    enabledFor(capsules, "capsules");
    const dir = capsules.dir;
    if (dir !== undefined) {
      if (typeof dir !== "string" || dir.trim() === "") issues.push('"integrations.capsules.dir" must be a non-empty string');
      else config.integrations.capsules.dir = dir.trim();
    }
    const allow = capsules.allowMutatingPrograms;
    if (allow !== undefined) {
      if (typeof allow !== "boolean") issues.push('"integrations.capsules.allowMutatingPrograms" must be a boolean');
      else config.integrations.capsules.allowMutatingPrograms = allow;
    }
  }
}

function applyLintProviders(value: unknown, config: MyGraceConfig, issues: string[]): void {
  if (value === undefined) return;
  if (!Array.isArray(value)) {
    issues.push('"lintProviders" must be an array');
    return;
  }
  if (value.length > 16) {
    issues.push('"lintProviders" may contain at most 16 entries');
    return;
  }
  const names = new Set<string>();
  const providers: LintProviderSettings[] = [];
  value.forEach((raw, index) => {
    const label = `lintProviders[${index}]`;
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
      issues.push(`"${label}" must be an object`);
      return;
    }
    const entry = raw as Record<string, unknown>;
    const allowed = new Set(["name", "enabled", "adapter", "command", "timeoutMs", "failOn"]);
    for (const key of Object.keys(entry)) if (!allowed.has(key)) issues.push(`unknown ${label} key "${key}"`);
    const name = entry.name;
    const adapter = entry.adapter;
    const command = entry.command;
    if (typeof name !== "string" || !/^[a-z0-9][a-z0-9-]{1,39}$/.test(name)) {
      issues.push(`"${label}.name" must be a lowercase kebab-case name (2-40 chars)`);
      return;
    }
    if (names.has(name)) {
      issues.push(`duplicate lint provider name "${name}"`);
      return;
    }
    names.add(name);
    if (adapter !== "legacy-scan" && adapter !== "json-findings") {
      issues.push(`"${label}.adapter" must be "legacy-scan" or "json-findings"`);
      return;
    }
    if (typeof command !== "string" || command.trim() === "" || command.includes("\u0000")) {
      issues.push(`"${label}.command" must be a non-empty command template`);
      return;
    }
    const enabled = entry.enabled;
    if (enabled !== undefined && enabled !== true && enabled !== false && enabled !== "auto") {
      issues.push(`"${label}.enabled" must be "auto", true or false`);
      return;
    }
    const timeoutMs = entry.timeoutMs === undefined ? 30_000 : entry.timeoutMs;
    if (typeof timeoutMs !== "number" || !Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 600_000) {
      issues.push(`"${label}.timeoutMs" must be an integer between 100 and 600000`);
      return;
    }
    const failOn = entry.failOn === undefined ? "warning" : entry.failOn;
    if (failOn !== "error" && failOn !== "warning" && failOn !== "none") {
      issues.push(`"${label}.failOn" must be "error", "warning" or "none"`);
      return;
    }
    providers.push({
      name,
      enabled: enabled === undefined ? "auto" : enabled,
      adapter,
      command: command.trim(),
      timeoutMs,
      failOn,
    });
  });
  config.lintProviders = providers;
}

function applyGuidancePacks(value: unknown, config: MyGraceConfig, issues: string[]): void {
  if (value === undefined) return;
  if (!Array.isArray(value)) {
    issues.push('"guidancePacks" must be an array');
    return;
  }
  if (value.length > 8) {
    issues.push('"guidancePacks" may contain at most 8 entries');
    return;
  }
  const names = new Set<string>();
  const packs: GuidancePackSettings[] = [];
  value.forEach((raw, index) => {
    const label = `guidancePacks[${index}]`;
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
      issues.push(`"${label}" must be an object`);
      return;
    }
    const entry = raw as Record<string, unknown>;
    const allowed = new Set(["name", "enabled", "kind", "path", "command", "timeoutMs"]);
    for (const key of Object.keys(entry)) if (!allowed.has(key)) issues.push(`unknown ${label} key "${key}"`);
    const name = entry.name;
    const kind = entry.kind;
    if (typeof name !== "string" || !/^[a-z0-9][a-z0-9-]{1,39}$/.test(name)) {
      issues.push(`"${label}.name" must be a lowercase kebab-case name (2-40 chars)`);
      return;
    }
    if (names.has(name)) {
      issues.push(`duplicate guidance pack name "${name}"`);
      return;
    }
    names.add(name);
    if (kind !== "local" && kind !== "cli") {
      issues.push(`"${label}.kind" must be "local" or "cli"`);
      return;
    }
    const path = entry.path;
    const command = entry.command;
    if (kind === "local") {
      if (typeof path !== "string" || path.trim() === "") issues.push(`"${label}.path" must be a non-empty string for local packs`);
      if (command !== undefined && command !== null) issues.push(`"${label}.command" is only valid for cli packs`);
    } else {
      if (typeof command !== "string" || command.trim() === "") issues.push(`"${label}.command" must be a non-empty string for cli packs`);
      if (path !== undefined && path !== null) issues.push(`"${label}.path" is only valid for local packs`);
    }
    const enabled = entry.enabled;
    if (enabled !== undefined && enabled !== true && enabled !== false && enabled !== "auto") {
      issues.push(`"${label}.enabled" must be "auto", true or false`);
      return;
    }
    const timeoutMs = entry.timeoutMs === undefined ? 30_000 : entry.timeoutMs;
    if (typeof timeoutMs !== "number" || !Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 600_000) {
      issues.push(`"${label}.timeoutMs" must be an integer between 100 and 600000`);
      return;
    }
    packs.push({
      name,
      enabled: enabled === undefined ? "auto" : enabled,
      kind,
      path: kind === "local" ? (path as string).trim() : null,
      command: kind === "cli" ? (command as string).trim() : null,
      timeoutMs,
    });
  });
  config.guidancePacks = packs;
}

// END_BLOCK_INTEGRATIONS

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
