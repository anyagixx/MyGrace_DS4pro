#!/usr/bin/env bun
/**
 * MyGRACE — Verification loop command (`mygrace verify`).
 *
 * This is the agent-loop entry point: run the scoped checks for one module (or
 * every module in `docs/graph-index.xml`) and emit a compact digest. On real
 * failures the full output is written to `.mygrace/last-failures.md`; the file
 * is never created on success.
 *
 * Security/runtime contract (shared with `mygrace test`, see grace-test.ts):
 *   - commands come from the canonical verification file and never execute
 *     without a trust record / `allowCommands: true` / `--allow-commands`
 *     (ROADMAP ADR-1);
 *   - ids are validated against docs/ (ADR-4) and resolved through grace-paths;
 *   - `--format json` always emits the ADR-8 envelope and exits per ADR-3;
 *   - failures exit 1, usage/config/trust refusals exit 2, never a stack trace.
 */

// START_MODULE_CONTRACT
//   PURPOSE: Agent-loop verification digest: scoped module runs, trust gate, failure artifact, JSON envelope.
//   SCOPE: Orchestration only; planning/execution/trust live in grace-test.ts.
//   DEPENDS: grace-test (plans, authorization, runner), grace-errors, grace-common, grace-config
//   LINKS: ROADMAP.md (ADR-1 trust model, ADR-3 exit codes, ADR-4 ids, ADR-8 JSON)
// END_MODULE_CONTRACT

// START_MODULE_MAP
//   verifyCommand — `mygrace verify [--module M-X | --all] [--allow-commands] [--format json]`
//   writeFailureReport() — .mygrace/last-failures.md writer (failure path only)
// END_MODULE_MAP

import { defineCommand } from "citty";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { findProjectRoot } from "./grace-common";
import { createEnvelope, finding } from "./grace-errors";
import type { Finding } from "./grace-errors";
import { loadConfig } from "./grace-config";
import {
  authorizeCommands,
  formatPlannedCommands,
  parseOutputFormat,
  planAllModules,
  resolveModuleIds,
  runCommandOutcome,
  runModulePlans,
} from "./grace-test";
import type { CommandOutcome, ModuleTestResult } from "./grace-test";
import { TrustError } from "./grace-errors";

/** Directory and file used to persist the last failing digest (project-relative). */
export const FAILURE_REPORT_DIR = ".mygrace";
export const FAILURE_REPORT_FILENAME = "last-failures.md";

/**
 * Write the failure digest. Called only when at least one module failed, so a
 * stale artifact can never be mistaken for a passing run.
 */
export function writeFailureReport(root: string, results: readonly ModuleTestResult[]): { path: string } | { error: string } {
  const failed = results.filter((result) => !result.ok);
  if (failed.length === 0) return { error: "not called: no failures" };
  const lines: string[] = [];
  for (const result of failed) {
    lines.push(`=== ${result.module} — FAILED ===`);
    if (result.command !== undefined) lines.push(`command: ${result.command}`);
    if (result.files.length > 0) lines.push(`files: ${result.files.join(", ")}`);
    if (result.error !== undefined) lines.push(`error: [${result.error.code}] ${result.error.message}`);
    if (result.output) lines.push(result.output);
    lines.push("");
  }
  const path = join(root, FAILURE_REPORT_DIR, FAILURE_REPORT_FILENAME);
  try {
    mkdirSync(join(root, FAILURE_REPORT_DIR), { recursive: true });
    writeFileSync(path, `${lines.join("\n")}\n`);
    return { path };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

export const verifyCommand = defineCommand({
  meta: {
    name: "verify",
    description:
      "Scoped module tests with a compact digest; refuses untrusted commands, writes .mygrace/last-failures.md on failure, exits 1 on failures (text or json)",
  },
  args: {
    module: { type: "string", description: "Module ID (e.g. M-AUTH); omit with --all or alone = all modules" },
    all: { type: "boolean", default: false, description: "Run every module in docs/graph-index.xml (default when --module is omitted)" },
    path: { type: "string", default: ".", description: "Project root" },
    format: { type: "string", default: "text", description: "Output format: text or json" },
    allowCommands: {
      type: "boolean",
      default: false,
      description: "Execute project-declared commands for this run without a trust record (also enables shell-style commands; opt-in only)",
    },
    allowUnsafeCommands: {
      type: "boolean",
      default: false,
      description: "One-off opt-in for deny-listed dangerous command patterns (privilege escalation, network tools, destructive commands)",
    },
  },
  run: async ({ args }) => {
    const format = parseOutputFormat(args.format);
    await runCommandOutcome<unknown>(format, { command: "verify" }, (): CommandOutcome<unknown> => {
      const root = findProjectRoot(args.path ?? ".");
      const config = loadConfig(root).config;
      const modules = resolveModuleIds(root, args.module, args.all, "verify");
      const plans = planAllModules(root, modules, config);
      const authorization = authorizeCommands(root, config, args.allowCommands === true);
      const runnable = plans.filter((plan) => plan.status === "ready");
      const findings: Finding[] = [];

      if (!authorization.authorized && runnable.length > 0) {
        const commands = runnable.map((plan) => `${plan.module}: ${plan.command}`).join("; ");
        const trustError = new TrustError(root, commands, {
          hint:
            `Review the commands listed above in docs/verification/V-M-XXX.xml (canonical; docs/modules/*.xml is a deprecated fallback), ` +
            `then run \`mygrace trust --path ${root}\` or pass --allow-commands.`,
        });
        findings.push(...plans.filter((plan) => plan.status === "invalid").map((plan) => planFinding(plan.module, plan.error)));
        const lines = [
          "MyGRACE refused to run project commands (no trust).",
          ...formatPlannedCommands(plans),
          "",
          `reason: ${authorization.trust.reason}`,
          `mygrace: ${trustError.toLine()}`,
        ];
        const envelope = createEnvelope({
          data: {
            root,
            planned: runnable.map((plan) => ({ module: plan.module, command: plan.command, source: plan.source })),
            modules: plans.map((plan) => ({ module: plan.module, status: plan.status, command: plan.command })),
          },
          findings,
          error: trustError,
          meta: { command: "verify", root },
        });
        return { envelope, print: () => lines.forEach((line) => console.log(line)) };
      }

      const batch = runModulePlans(root, plans, authorization, true, args.allowUnsafeCommands === true);
      findings.push(...batch.findings);

      let reportNote = "";
      let reportPath: string | null = null;
      if (batch.failed > 0) {
        const report = writeFailureReport(root, batch.results);
        if ("error" in report) {
          findings.push(
            finding("warning", "FAILURE_REPORT_UNWRITABLE", `Could not write .mygrace/${FAILURE_REPORT_FILENAME}: ${report.error}`, {
              hint: "Check that the project directory is writable.",
            })
          );
          reportNote = ` (failure report not written: ${report.error})`;
        } else {
          reportPath = `${FAILURE_REPORT_DIR}/${FAILURE_REPORT_FILENAME}`;
          reportNote = ` — see ${reportPath}`;
        }
      }

      const lines: string[] = [];
      for (const result of batch.results) {
        if (result.ok) continue;
        lines.push(`=== ${result.module} — FAILED ===`);
        if (result.command !== undefined) lines.push(`command: ${result.command}`);
        if (result.error !== undefined) lines.push(`error: [${result.error.code}] ${result.error.message}`);
        if (result.output) lines.push(result.output);
        lines.push("");
      }
      lines.push(
        batch.failed > 0
          ? `Verify: ${batch.results.length - batch.failed} ok, ${batch.failed} failed${reportNote}`
          : `Verify: ${batch.results.length} ok`
      );

      const envelope = createEnvelope({
        data: {
          root,
          modules: batch.results.map((result) => ({
            module: result.module,
            ok: result.ok,
            command: result.command ?? null,
            source: result.source ?? null,
            files: result.files,
            ...(result.error === undefined ? {} : { error: result.error }),
          })),
          summary: { total: batch.results.length, failed: batch.failed, ok: batch.results.length - batch.failed },
          authorization: { via: authorization.via, trusted: authorization.trust.trusted },
          failureReport: reportPath,
        },
        findings,
        meta: { command: "verify", root },
      });
      return { envelope, print: () => lines.forEach((line) => console.log(line)) };
    });
  },
});

function planFinding(module: string, error: { code: string; message: string; hint?: string; file?: string } | undefined): Finding {
  return finding("error", error?.code ?? "INVALID_PLAN", `${module}: ${error?.message ?? "invalid plan"}`, {
    ...(error?.file === undefined ? {} : { file: error.file }),
    ...(error?.hint === undefined ? {} : { hint: error.hint }),
  });
}
