#!/usr/bin/env bun
/**
 * MyGRACE — optional external lint providers (ADR-11).
 *
 * A project may declare trust-gated external scanners in
 * `mygrace.config.json` (`lintProviders`). This module runs them only with a
 * current trust record / `allowCommands` / `--allow-commands`, applies the same
 * dangerous-command deny list and audit log as project checks, parses their
 * JSON through a small adapter SPI and returns ordinary MyGRACE findings.
 *
 * The tool never lets an external scanner change docs or code; findings are
 * advisory by default (`failOn: "warning"`), and a broken provider is a warning,
 * never a crash. Core MyGRACE gates stay deterministic and offline.
 */

// START_MODULE_CONTRACT
//   PURPOSE: Run trust-gated external lint providers, adapt their JSON to coded MyGRACE findings and audit every invocation.
//   SCOPE: reads config + spawns declared scanner commands; no network built in, no file writes except .mygrace/audit.log.
//   DEPENDS: grace-config, grace-errors, grace-test (tokenizer/authorization/audit), grace-integrations (scrubbed env), node:child_process
//   LINKS: docs/adr/ADR-11-guidance-and-lint-providers.md, docs/configuration.md
// END_MODULE_CONTRACT

// START_MODULE_MAP
//   LintProviderRun          — one provider invocation (authorized, findings, skip/failure reason)
//   LintProviderReport       — aggregate result for lint/ci JSON data
//   LINT_PROVIDER_CODES      — stable finding codes
//   runLintProviders()       — authorize + execute + adapt every enabled provider
//   adaptLegacyScan()        — Modern Web Guidance `legacy-scan --json` adapter
//   adaptJsonFindings()      — generic `{findings:[{file,line,code,message}]}` adapter
// END_MODULE_MAP

// START_CHANGE_SUMMARY
//   v3.1.0 — introduced ADR-11 external lint providers, MWG legacy-scan and generic JSON adapters.
// END_CHANGE_SUMMARY

import { spawnSync } from "node:child_process";
import type { LintProviderSettings, MyGraceConfig } from "./grace-config";
import { finding } from "./grace-errors";
import type { Finding } from "./grace-errors";
import { integrationChildEnv } from "./grace-integrations";
import {
  appendAuditRecord,
  authorizeCommands,
  inspectUnsafeCommand,
  tokenizeCommand,
  trustRefusalHint,
} from "./grace-test";
import type { CommandAuthorization } from "./grace-test";

export const LINT_PROVIDER_CODES = {
  refused: "LINT_PROVIDER_REFUSED",
  denied: "LINT_PROVIDER_DENIED",
  failed: "LINT_PROVIDER_FAILED",
  invalidOutput: "LINT_PROVIDER_INVALID_OUTPUT",
  truncated: "LINT_PROVIDER_TRUNCATED",
  unpinned: "LINT_PROVIDER_UNPINNED",
  finding: "LINT_PROVIDER_FINDING",
} as const;

export interface LintProviderRun {
  name: string;
  adapter: LintProviderSettings["adapter"];
  command: string;
  ran: boolean;
  authorized: boolean;
  exitCode: number | null;
  durationMs: number;
  findingCount: number;
  pinned: boolean;
  skippedReason: string | null;
  error: string | null;
}

export interface LintProviderReport {
  authorization: { authorized: boolean; via: CommandAuthorization["via"]; shellOptIn: boolean };
  providers: LintProviderRun[];
  findings: Finding[];
}

const MAX_PROVIDER_FINDINGS = 200;

/** Severity configured for a provider finding (`none` stays informational). */
function severityFor(settings: LintProviderSettings): Finding["severity"] {
  if (settings.failOn === "error") return "error";
  if (settings.failOn === "none") return "info";
  return "warning";
}

function providerFinding(settings: LintProviderSettings, message: string, extra: Partial<Finding> = {}): Finding {
  return finding(severityFor(settings), LINT_PROVIDER_CODES.finding, `${settings.name}: ${message}`, extra);
}

/** True when a provider command pins its package spec (no `@latest`/bare npx package). */
export function providerCommandPinned(command: string): boolean {
  if (/@latest\b/i.test(command)) return false;
  const match = /(?:^|\s)(?:npx|pnpx|bunx)\s+(?:-y\s+|--yes\s+)?([^\s-][^\s]*)/.exec(command);
  if (match === null) return true;
  const spec = match[1] ?? "";
  if (spec.startsWith(".") || spec.startsWith("/") || spec.startsWith("~")) return true;
  return /@\d/.test(spec) || /^[a-z][a-z0-9-]*$/i.test(spec) === false && /@\d/.test(spec);
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

function asLine(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : undefined;
}

/** Flatten the Modern Web Guidance `legacy-scan --json` payload (ADR-11). */
export function adaptLegacyScan(settings: LintProviderSettings, payload: unknown, root: string): Finding[] {
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("legacy-scan output must be a JSON object");
  }
  const raw = payload as Record<string, unknown>;
  const guides = raw.guides;
  if (!Array.isArray(guides)) throw new Error('legacy-scan output has no "guides" array');
  const findings: Finding[] = [];
  for (const guide of guides) {
    if (guide === null || typeof guide !== "object" || Array.isArray(guide)) continue;
    const guideRaw = guide as Record<string, unknown>;
    const guideId = asString(guideRaw.guideId) ?? "unknown-guide";
    const retrieve = asString(guideRaw.retrieveCommand) ?? `npx modern-web-guidance retrieve ${guideId}`;
    const rules = guideRaw.rules;
    if (!Array.isArray(rules)) continue;
    for (const rule of rules) {
      if (rule === null || typeof rule !== "object" || Array.isArray(rule)) continue;
      const ruleRaw = rule as Record<string, unknown>;
      const ruleId = asString(ruleRaw.ruleId) ?? "unknown-rule";
      const summary = asString(ruleRaw.summary) ?? "Legacy web-platform pattern.";
      const items = ruleRaw.findings;
      if (!Array.isArray(items)) continue;
      for (const item of items) {
        if (item === null || typeof item !== "object" || Array.isArray(item)) continue;
        const rawItem = item as Record<string, unknown>;
        const file = asString(rawItem.file);
        const line = asLine(rawItem.line);
        const lineContent = asString(rawItem.lineContent);
        const message = asString(rawItem.message) ?? summary;
        findings.push(
          providerFinding(settings, `[${guideId}/${ruleId}] ${message}`, {
            ...(file === null ? {} : { file }),
            ...(line === undefined ? {} : { line }),
            hint: `${lineContent === null ? "" : `Line: ${lineContent}. `}Retrieve guidance: ${retrieve}`,
          })
        );
      }
    }
  }
  // Some tools put a total but an empty guides list; that is a valid zero-finding scan.
  const total = raw.totalFindings;
  if (findings.length === 0 && typeof total === "number" && total > 0) {
    findings.push(
      providerFinding(settings, `reported ${total} finding(s) but emitted no details`, {
        file: "mygrace.config.json",
        hint: "The provider JSON shape may have changed; pin the provider version.",
      })
    );
  }
  return findings;
}

/** Generic adapter for scanners that emit `{findings:[{file,line,code,message}]}` or an array. */
export function adaptJsonFindings(settings: LintProviderSettings, payload: unknown, root: string): Finding[] {
  const list = Array.isArray(payload) ? payload : (payload as { findings?: unknown } | null)?.findings;
  if (!Array.isArray(list)) throw new Error('json-findings output must be an array or an object with a "findings" array');
  const findings: Finding[] = [];
  for (const item of list) {
    if (item === null || typeof item !== "object" || Array.isArray(item)) continue;
    const raw = item as Record<string, unknown>;
    const message = asString(raw.message);
    if (message === null) continue;
    const file = asString(raw.file);
    const line = asLine(raw.line);
    const code = asString(raw.code);
    findings.push(
      providerFinding(settings, message, {
        ...(file === null ? {} : { file }),
        ...(line === undefined ? {} : { line }),
        ...(code === null ? {} : { hint: `Provider code: ${code}` }),
      })
    );
  }
  return findings;
}

function parseProviderOutput(settings: LintProviderSettings, stdout: string, root: string): Finding[] {
  let payload: unknown;
  try {
    payload = JSON.parse(stdout);
  } catch {
    throw new Error("stdout is not valid JSON");
  }
  const adapted = settings.adapter === "legacy-scan" ? adaptLegacyScan(settings, payload, root) : adaptJsonFindings(settings, payload, root);
  return adapted;
}

/**
 * Run every enabled provider and return ordinary findings.
 *
 * The caller merges `report.findings` with lint findings. Authorization is
 * evaluated once for the whole run; a refusal is reported as an info finding so
 * agents can see why configured providers did not run.
 */
export function runLintProviders(
  root: string,
  config: MyGraceConfig,
  options: { allowCommands: boolean; allowUnsafeCommands: boolean }
): LintProviderReport {
  const authorization = authorizeCommands(root, config, options.allowCommands);
  const runs: LintProviderRun[] = [];
  const findings: Finding[] = [];

  for (const settings of config.lintProviders) {
    if (settings.enabled === false) continue;
    const started = Date.now();
    const base: LintProviderRun = {
      name: settings.name,
      adapter: settings.adapter,
      command: settings.command,
      ran: false,
      authorized: authorization.authorized,
      exitCode: null,
      durationMs: 0,
      findingCount: 0,
      pinned: providerCommandPinned(settings.command),
      skippedReason: null,
      error: null,
    };

    if (!authorization.authorized) {
      base.skippedReason = "untrusted";
      runs.push({ ...base, durationMs: Date.now() - started });
      findings.push(
        finding("info", LINT_PROVIDER_CODES.refused, `Lint provider "${settings.name}" was not run: project commands are not trusted.`, {
          hint: trustRefusalHint(root, authorization),
        })
      );
      continue;
    }

    if (!base.pinned) {
      findings.push(
        finding("warning", LINT_PROVIDER_CODES.unpinned, `Lint provider "${settings.name}" uses an unpinned command; pin the package version for reproducible CI.`, {
          hint: "Replace @latest/bare npx specs with an exact version and re-run `mygrace trust`.",
        })
      );
    }
    const expanded = settings.command.replaceAll("{path}", root);
    let argv: string[];
    try {
      argv = tokenizeCommand(expanded);
    } catch (error) {
      base.skippedReason = "invalid-command";
      base.error = error instanceof Error ? error.message : String(error);
      runs.push({ ...base, durationMs: Date.now() - started });
      findings.push(finding("warning", LINT_PROVIDER_CODES.failed, `Lint provider "${settings.name}" has an invalid command: ${base.error}`));
      continue;
    }
    if (argv.length === 0) {
      base.skippedReason = "empty-command";
      runs.push({ ...base, durationMs: Date.now() - started });
      findings.push(finding("warning", LINT_PROVIDER_CODES.failed, `Lint provider "${settings.name}" has an empty command.`));
      continue;
    }
    const unsafe = inspectUnsafeCommand(expanded);
    if (unsafe !== null && !options.allowUnsafeCommands) {
      base.skippedReason = "denied";
      base.error = unsafe.label;
      runs.push({ ...base, durationMs: Date.now() - started });
      findings.push(
        finding("warning", LINT_PROVIDER_CODES.denied, `Lint provider "${settings.name}" was denied by the dangerous-command policy (${unsafe.label}).`, {
          hint: "Review the provider command; pass --allow-unsafe-commands only if it is intentional.",
        })
      );
      continue;
    }

    const result = spawnSync(argv[0] as string, argv.slice(1), {
      cwd: root,
      encoding: "utf8",
      timeout: settings.timeoutMs,
      shell: false,
      env: integrationChildEnv({ NO_COLOR: "1", CI: "1", npm_config_yes: "true" }),
    });
    const durationMs = Date.now() - started;
    const exitCode = result.status ?? null;
    const stdout = result.stdout ?? "";
    const stderr = result.stderr ?? "";
    base.ran = true;
    base.exitCode = exitCode;
    base.durationMs = durationMs;

    appendAuditRecord(root, {
      action: "lint-provider",
      provider: settings.name,
      command: expanded,
      exitCode,
      durationMs,
      authorizedVia: authorization.via,
    });

    if (result.error !== undefined) {
      base.error = result.error.message;
      findings.push(
        finding("warning", LINT_PROVIDER_CODES.failed, `Lint provider "${settings.name}" failed to start: ${result.error.message}`, {
          hint: `Check the command in mygrace.config.json (timeout ${settings.timeoutMs} ms).`,
        })
      );
      runs.push({ ...base });
      continue;
    }

    let adapted: Finding[];
    try {
      if (stdout.trim() === "") throw new Error("produced no JSON on stdout");
      adapted = parseProviderOutput(settings, stdout, root);
    } catch (error) {
      base.error = error instanceof Error ? error.message : String(error);
      const detail = base.error;
      findings.push(
        finding("warning", LINT_PROVIDER_CODES.invalidOutput, `Lint provider "${settings.name}" output could not be parsed: ${detail}`, {
          ...(stderr.trim() === "" ? {} : { hint: stderr.trim().split("\n").slice(0, 3).join(" ") }),
        })
      );
      runs.push({ ...base });
      continue;
    }

    if (adapted.length > MAX_PROVIDER_FINDINGS) {
      findings.push(
        finding("warning", LINT_PROVIDER_CODES.truncated, `Lint provider "${settings.name}" reported ${adapted.length} findings; only the first ${MAX_PROVIDER_FINDINGS} are shown.`, {
          hint: "Fix the biggest classes first or narrow the provider scope.",
        })
      );
      adapted = adapted.slice(0, MAX_PROVIDER_FINDINGS);
    }
    base.findingCount = adapted.length;
    findings.push(...adapted);
    runs.push({ ...base });
  }

  return {
    authorization: { authorized: authorization.authorized, via: authorization.via, shellOptIn: authorization.shellOptIn },
    providers: runs,
    findings,
  };
}
