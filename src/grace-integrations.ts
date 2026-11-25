/**
 * MyGRACE — Optional external integrations registry (ROADMAP ADR-9).
 *
 * MyGRACE core stays deterministic, offline and dependency-free. Some optional
 * capabilities come from external tools: Octocode (code-level symbol/dependency
 * graph, v1.4) and Archify (typed-IR diagram rendering, v1.5). This module is
 * the single place that detects such tools, checks their tested version range
 * and produces actionable hints. It never makes an integration required and it
 * never executes integration features itself (adapters do that behind explicit
 * flags).
 *
 * Detection order (ADR-9): integrations.<id>.enabled=false / MYGRACE_INTEGRATIONS=off →
 * kill switch; then bin: config → MYGRACE_OCTOCODE_BIN / MYGRACE_ARCHIFY_BIN → PATH.
 */

// START_MODULE_CONTRACT
//   PURPOSE: Detect, version-check and describe optional external tools (Octocode, Archify, Modern Web Guidance) for the CLI, MCP and doctor surfaces.
//   SCOPE: read-only probes — PATH scan, `<bin> --version`; no project writes, no network, no execution of integration features.
//   DEPENDS: grace-config, grace-common, grace-errors, grace-test (output format/run outcome), node:child_process, node:fs, node:path
//   LINKS: ROADMAP.md (ADR-9), INTEGRATION-PLAN.md (Wave 5/6)
// END_MODULE_CONTRACT

// START_MODULE_MAP
//   INTEGRATION_ENV          — env var names (bins, global kill switch)
//   INTEGRATION_FINDING_CODES — stable finding codes for unavailable/unsupported tools
//   IntegrationId            — "octocode" | "archify"
//   IntegrationStatus        — detection result for one tool (available/supported/source/hint)
//   IntegrationsData         — payload of `mygrace integrations status`
//   parseVersionText()       — first semver in a --version output
//   parseVersionRange()      — comparators of a ">=0.29 <0.30" range
//   versionSatisfies()       — range membership check
//   findExecutableOnPath()   — PATH scan (POSIX exec bit, Windows extensions)
//   integrationChildEnv()    — scrubbed child environment for adapters (ADR-9)
//   resolveIntegration()     — per-tool detection + version validation
//   buildIntegrationsStatus()— status payload for a project root
//   integrationFindings()    — ADR-3 findings (info by default, warning when required)
//   integrationsCommand      — `mygrace integrations status [--path] [--format text|json]`
// END_MODULE_MAP

// START_CHANGE_SUMMARY
//   v1.4.0 (Wave 5) — introduced: ADR-9 registry, Octocode/Archify detection, version
//   ranges, scrubbed child env and `mygrace integrations status` (advisory, exit 0).
// END_CHANGE_SUMMARY

import { defineCommand } from "citty";
import { spawnSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { delimiter, isAbsolute, join, resolve } from "node:path";
import { tryFindProjectRoot } from "./grace-common";
import { tryLoadConfig } from "./grace-config";
import type { IntegrationSettings, MyGraceConfig } from "./grace-config";
import { EXIT, createEnvelope, finding } from "./grace-errors";
import type { Finding } from "./grace-errors";
import { parseOutputFormat, runCommandOutcome } from "./grace-test";

// START_BLOCK_TYPES
/** Environment knobs documented by ADR-9. */
export const INTEGRATION_ENV = {
  /** Global kill switch: "off"/"0"/"false" disables every adapter. */
  killSwitch: "MYGRACE_INTEGRATIONS",
  /** Explicit Octocode executable (overrides config and PATH). */
  octocodeBin: "MYGRACE_OCTOCODE_BIN",
  /** Explicit Archify CLI entry (node script or executable; overrides config and PATH). */
  archifyBin: "MYGRACE_ARCHIFY_BIN",
  /** Explicit Modern Web Guidance CLI entry (overrides config and PATH). */
  modernWebGuidanceBin: "MYGRACE_MODERN_WEB_GUIDANCE_BIN",
} as const;

/** Stable finding codes emitted by the integration layer. */
export const INTEGRATION_FINDING_CODES = {
  unavailable: "INTEGRATION_UNAVAILABLE",
  unsupportedVersion: "INTEGRATION_UNSUPPORTED_VERSION",
  invalidOutput: "INTEGRATION_INVALID_OUTPUT",
  timeout: "INTEGRATION_TIMEOUT",
} as const;

export type IntegrationId = "octocode" | "archify" | "modern-web-guidance";

export type IntegrationSource = "config" | "env" | "path";

/** How an integration executable was resolved: direct binary or the npx cache runner. */
export type IntegrationRunner = "bin" | "npx";

/** Detection result for one optional tool. */
export interface IntegrationStatus {
  id: IntegrationId;
  /** Effective enabled state after the kill switch and `integrations.<id>.enabled`. */
  enabled: boolean;
  /** `integrations.<id>.enabled === true` — missing/unsupported becomes a warning, not info. */
  required: boolean;
  available: boolean;
  /** Version falls inside the tested range (false also when the version is unknown). */
  supported: boolean;
  bin: string | null;
  source: IntegrationSource | null;
  runner: IntegrationRunner;
  version: string | null;
  expectedRange: string;
  timeoutMs: number;
  /** How the tool was verified: `--version` probe or file existence only. */
  checked: "version" | "exists";
  hint: string | null;
  error: string | null;
}

/** Payload of `mygrace integrations status`. */
export interface IntegrationsData {
  killSwitch: boolean;
  root: string;
  octocode: IntegrationStatus;
  archify: IntegrationStatus;
  modernWebGuidance: IntegrationStatus;
}
// END_BLOCK_TYPES

// START_BLOCK_VERSIONS
export type VersionTuple = readonly [number, number, number];

/** First `x.y.z` in a version banner (`octocode 0.29.2`, `3.3.0`), or null. */
export function parseVersionText(text: string): VersionTuple | null {
  const match = /(\d+)\.(\d+)\.(\d+)/.exec(text);
  if (match === null) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

export interface VersionComparator {
  op: ">=" | "<=" | ">" | "<" | "=";
  version: VersionTuple;
}

/** Parse a space-separated comparator list such as ">=0.29 <0.30". */
export function parseVersionRange(range: string): VersionComparator[] {
  const comparators: VersionComparator[] = [];
  const regex = /(>=|<=|>|<|=)?\s*v?(\d+)(?:\.(\d+))?(?:\.(\d+))?/g;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(range)) !== null) {
    comparators.push({
      op: (match[1] as VersionComparator["op"] | undefined) ?? "=",
      version: [Number(match[2]), Number(match[3] ?? 0), Number(match[4] ?? 0)],
    });
  }
  return comparators;
}

function compareVersions(left: VersionTuple, right: VersionTuple): number {
  for (let index = 0; index < 3; index += 1) {
    const a = left[index] ?? 0;
    const b = right[index] ?? 0;
    if (a !== b) return a < b ? -1 : 1;
  }
  return 0;
}

/** True when `version` satisfies every comparator of `range` (unknown version → false). */
export function versionSatisfies(version: VersionTuple | null, range: string): boolean {
  if (version === null) return false;
  const comparators = parseVersionRange(range);
  if (comparators.length === 0) return true;
  return comparators.every((comparator) => {
    const order = compareVersions(version, comparator.version);
    switch (comparator.op) {
      case ">=":
        return order >= 0;
      case "<=":
        return order <= 0;
      case ">":
        return order > 0;
      case "<":
        return order < 0;
      case "=":
        return order === 0;
    }
  });
}
// END_BLOCK_VERSIONS

// START_BLOCK_DETECTION
/** PATH separator split that also works on Windows. */
function pathDirs(pathValue: string): string[] {
  return pathValue.split(delimiter).filter((dir) => dir !== "");
}

/**
 * Find an executable by name on PATH.
 *
 * POSIX requires a file with any exec bit (same rule as `setup install`); Windows
 * additionally probes `.exe`, `.cmd` and `.bat`, because PATH entries are
 * directories and PATHEXT resolution is the shell's job.
 */
export function findExecutableOnPath(name: string, env: NodeJS.ProcessEnv = process.env): string | null {
  const names = process.platform === "win32" ? [name, `${name}.exe`, `${name}.cmd`, `${name}.bat`] : [name];
  for (const dir of pathDirs(env.PATH ?? "")) {
    for (const candidateName of names) {
      const candidate = join(dir, candidateName);
      try {
        const stats = statSync(candidate);
        if (!stats.isFile()) continue;
        if (process.platform === "win32" || (stats.mode & 0o111) !== 0) return candidate;
      } catch {
        // Not in this directory.
      }
    }
  }
  return null;
}

/**
 * Scrubbed environment for integration child processes (ADR-9): only PATH,
 * HOME/TMPDIR and explicitly requested variables; no secrets, no proxy vars,
 * no provider keys.
 */
export function integrationChildEnv(extra: Record<string, string> = {}): Record<string, string> {
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? "",
    HOME: process.env.HOME ?? "",
    TMPDIR: process.env.TMPDIR ?? "",
    // Never phone home from a renderer/analyzer started by MyGRACE.
    ARCHIFY_UPDATE_CHECK_DISABLED: "1",
    RUST_LOG: "error",
    ...extra,
  };
  return env;
}

/** Positional version probe: `<bin> <args>` with a timeout. */
function probeVersionArgs(
  bin: string,
  args: string[],
  timeoutMs: number
): { version: VersionTuple | null; error: string | null } {
  const result = spawnSync(bin, args, {
    encoding: "utf-8",
    timeout: timeoutMs,
    shell: false,
    env: integrationChildEnv(),
  });
  if (result.error !== undefined) {
    const reason = result.error.message.includes("ETIMEDOUT") ? "timed out" : result.error.message;
    return { version: null, error: `Could not run "${bin} --version": ${reason}` };
  }
  const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
  const version = parseVersionText(output);
  if (version === null) {
    return { version: null, error: `Could not parse a version from "${bin} ${args.join(" ")}"` };
  }
  return { version, error: null };
}

function probeVersion(bin: string, timeoutMs: number): { version: VersionTuple | null; error: string | null } {
  return probeVersionArgs(bin, ["--version"], timeoutMs);
}

function isKillSwitchOn(env: NodeJS.ProcessEnv): boolean {
  const value = env[INTEGRATION_ENV.killSwitch]?.trim().toLowerCase();
  return value === "off" || value === "0" || value === "false" || value === "disabled";
}

function configBinPath(candidate: string, root: string, env: NodeJS.ProcessEnv): string | null {
  if (isAbsolute(candidate)) return existsSync(candidate) ? resolve(candidate) : null;
  if (candidate.includes("/") || candidate.includes("\\")) {
    const absolute = resolve(root, candidate);
    return existsSync(absolute) ? absolute : null;
  }
  return findExecutableOnPath(candidate, env);
}

function octocodeHint(settings: IntegrationSettings, error: string | null): string {
  const range = settings.versionRange;
  if (error !== null && error.includes("--version")) {
    return `Octocode was found but its version could not be read; MyGRACE needs ${range}.`;
  }
  return (
    `Install Octocode ${range} from https://github.com/Muvon/octocode/releases ` +
    `(single binary; graph mode needs no index or models), put it on PATH, ` +
    `or set ${INTEGRATION_ENV.octocodeBin}.`
  );
}

function archifyHint(settings: IntegrationSettings): string {
  return (
    `Install the Archify skill (https://github.com/tt-a1i/archify) and point ` +
    `${INTEGRATION_ENV.archifyBin} at its bin/archify.mjs; MyGRACE expects ${settings.versionRange}. ` +
    `Diagrams are optional — JSON/Mermaid output works without it.`
  );
}

function modernWebGuidanceHint(settings: IntegrationSettings, error: string | null): string {
  if (error !== null && error.includes("--version")) {
    return `Modern Web Guidance was found but its version could not be read; MyGRACE expects ${settings.versionRange}.`;
  }
  return (
    `Optional: install Modern Web Guidance ${settings.versionRange} ` +
    `(https://github.com/GoogleChrome/modern-web-guidance) with ` +
    `\`npx modern-web-guidance@latest install\` or put its CLI on PATH; ` +
    `set ${INTEGRATION_ENV.modernWebGuidanceBin} for a custom entry point.`
  );
}

function settingsFor(id: IntegrationId, config: MyGraceConfig): IntegrationSettings {
  if (id === "octocode") return config.integrations.octocode;
  if (id === "archify") return config.integrations.archify;
  return config.integrations.modernWebGuidance;
}

function envBinFor(id: IntegrationId, env: NodeJS.ProcessEnv): string | undefined {
  if (id === "octocode") return env[INTEGRATION_ENV.octocodeBin];
  if (id === "archify") return env[INTEGRATION_ENV.archifyBin];
  return env[INTEGRATION_ENV.modernWebGuidanceBin];
}

function hintFor(id: IntegrationId, settings: IntegrationSettings, error: string | null): string {
  if (id === "octocode") return octocodeHint(settings, error);
  if (id === "archify") return archifyHint(settings);
  return modernWebGuidanceHint(settings, error);
}

/**
 * Resolve one integration: enabled state, executable, version and supported range.
 *
 * Never throws for a missing/broken tool: the caller turns the result into
 * info/warning findings and keeps the core command working.
 */
export function resolveIntegration(
  id: IntegrationId,
  config: MyGraceConfig,
  root: string,
  env: NodeJS.ProcessEnv = process.env
): IntegrationStatus {
  const settings: IntegrationSettings = settingsFor(id, config);
  const required = settings.enabled === true;
  const killSwitch = isKillSwitchOn(env);
  const enabled = killSwitch ? false : settings.enabled !== false;
  const base: IntegrationStatus = {
    id,
    enabled,
    required,
    available: false,
    supported: false,
    bin: null,
    source: null,
    runner: "bin",
    version: null,
    expectedRange: settings.versionRange,
    timeoutMs: settings.timeoutMs,
    checked: "version",
    hint: null,
    error: null,
  };
  if (!enabled) {
    return {
      ...base,
      hint: killSwitch
        ? `Integrations are disabled by ${INTEGRATION_ENV.killSwitch}=off.`
        : `Disabled by integrations.${id}.enabled=false.`,
    };
  }

  let bin: string | null = null;
  let source: IntegrationSource | null = null;
  if (settings.bin !== null && settings.bin !== "") {
    bin = configBinPath(settings.bin, root, env);
    source = "config";
  }
  if (bin === null) {
    const envBin = envBinFor(id, env);
    if (typeof envBin === "string" && envBin.trim() !== "") {
      bin = configBinPath(envBin.trim(), root, env);
      source = "env";
    }
  }
  if (bin === null) {
    bin = findExecutableOnPath(id, env);
    source = bin === null ? null : "path";
  }
  if (bin === null && id === "modern-web-guidance") {
    const npx = findExecutableOnPath("npx", env);
    if (npx !== null) {
      const probe = probeVersionArgs(npx, ["--no-install", "modern-web-guidance", "--version"], Math.min(settings.timeoutMs, 5_000));
      const supported = probe.version !== null && versionSatisfies(probe.version, settings.versionRange);
      return {
        ...base,
        available: probe.version !== null,
        supported,
        bin: npx,
        source: "path",
        runner: "npx",
        version: probe.version === null ? null : probe.version.join("."),
        error: probe.error,
        hint:
          probe.version !== null && supported
            ? null
            : `npx is available but a cached Modern Web Guidance ${settings.versionRange} was not found; ` +
              `run \`npx modern-web-guidance@latest install\` or configure a guidancePacks CLI entry.`,
      };
    }
  }

  if (bin === null) {
    return {
      ...base,
      hint: hintFor(id, settings, null),
    };
  }

  if (id !== "archify") {
    const probe = probeVersion(bin, settings.timeoutMs);
    const supported = probe.version !== null && versionSatisfies(probe.version, settings.versionRange);
    return {
      ...base,
      available: true,
      supported,
      bin,
      source,
      version: probe.version === null ? null : probe.version.join("."),
      error: probe.error,
      hint: supported
        ? null
        : probe.version === null
          ? hintFor(id, settings, probe.error)
          : `Detected ${id} ${probe.version.join(".")} but the tested range is ${settings.versionRange}; pin a supported version.`,
    };
  }

  // Archify: the entry point is a Node script; existence is the detection signal
  // (version probing arrives with the diagram adapter in v1.5).
  return {
    ...base,
    checked: "exists",
    available: true,
    supported: true,
    bin,
    source,
  };
}
// END_BLOCK_DETECTION

// START_BLOCK_STATUS
/** Build the status payload used by the CLI, MCP and doctor surfaces. */
export function buildIntegrationsStatus(
  root: string,
  config: MyGraceConfig,
  env: NodeJS.ProcessEnv = process.env
): IntegrationsData {
  return {
    killSwitch: isKillSwitchOn(env),
    root,
    octocode: resolveIntegration("octocode", config, root, env),
    archify: resolveIntegration("archify", config, root, env),
    modernWebGuidance: resolveIntegration("modern-web-guidance", config, root, env),
  };
}

/** ADR-3 findings for the status payload (info by default, warning when required). */
export function integrationFindings(data: IntegrationsData): Finding[] {
  const findings: Finding[] = [];
  for (const entry of [data.octocode, data.archify, data.modernWebGuidance] as const) {
    if (!entry.enabled) continue;
    if (!entry.available) {
      findings.push(
        finding(entry.required ? "warning" : "info", INTEGRATION_FINDING_CODES.unavailable, `${entry.id} is not available.`, {
          hint: entry.hint ?? undefined,
        })
      );
      continue;
    }
    if (!entry.supported) {
      findings.push(
        finding(
          "warning",
          INTEGRATION_FINDING_CODES.unsupportedVersion,
          `${entry.id} ${entry.version ?? "(unknown version)"} is outside the tested range ${entry.expectedRange}.`,
          { hint: entry.hint ?? undefined }
        )
      );
    }
  }
  return findings;
}

function describeEntry(entry: IntegrationStatus): string {
  if (!entry.enabled) return `disabled${entry.hint === null ? "" : ` (${entry.hint})`}`;
  if (!entry.available) return `not found — ${entry.hint ?? "no hint"}`;
  const version = entry.version ?? "(version unknown)";
  const source = entry.runner === "npx" ? "npx cache" : entry.source === null ? "unknown" : entry.source;
  const supported = entry.supported ? "supported" : `UNSUPPORTED (expected ${entry.expectedRange})`;
  return `${version} (${source}) — ${supported}`;
}

/** `mygrace integrations status [--path] [--format text|json]` — advisory, exit 0. */
export const integrationsCommand = defineCommand({
  meta: {
    name: "integrations",
    description:
      "Detect optional external tools (Octocode, Archify, Modern Web Guidance), check tested version ranges and print actionable hints (text or json; never fails the core gates)",
  },
  args: {
    path: { type: "string", default: ".", description: "Project root (optional; defaults to the nearest MyGRACE project)" },
    format: { type: "string", default: "text", description: "Output format: text or json" },
  },
  run: async ({ args }) => {
    const format = parseOutputFormat(args.format);
    await runCommandOutcome<IntegrationsData>(format, { command: "integrations" }, () => {
      const input = typeof args.path === "string" ? args.path : ".";
      const root = tryFindProjectRoot(input) ?? resolve(input);
      const loaded = tryLoadConfig(root);
      if (!loaded.ok) throw loaded.error;
      const data = buildIntegrationsStatus(root, loaded.result.config);
      const findings = integrationFindings(data);
      const envelope = createEnvelope({
        data,
        findings,
        meta: { command: "integrations", root },
      });
      // Advisory surface: findings are reported, but status never fails a build.
      envelope.exitCode = EXIT.OK;
      const lines = [
        "MyGRACE integrations",
        "====================",
        `Project:     ${root}`,
        `Kill switch: ${data.killSwitch ? "ON (all integrations disabled)" : "off"}`,
        "",
        `octocode  ${describeEntry(data.octocode)}`,
        `archify   ${describeEntry(data.archify)}`,
        `modern-web-guidance  ${describeEntry(data.modernWebGuidance)}`,
      ];
      if (findings.length > 0) {
        lines.push("");
        for (const item of findings) {
          lines.push(`${item.severity === "error" ? "✗" : item.severity === "warning" ? "⚠" : "ⓘ"} [${item.code}] ${item.message}`);
          if (item.hint !== undefined) lines.push(`    → ${item.hint}`);
        }
      }
      return { envelope, print: () => lines.forEach((line) => console.log(line)) };
    });
  },
});
// END_BLOCK_STATUS
