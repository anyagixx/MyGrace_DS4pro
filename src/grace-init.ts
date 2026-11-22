#!/usr/bin/env bun
/**
 * MyGRACE init-dsh Command
 *
 * Non-interactive bootstrap of a MyGRACE project:
 * - creates the docs/ index structure from templates,
 * - writes an AGENTS.md the harness auto-loads,
 * - writes mygrace.config.json (ADR-5) so layout/budgets are visible and editable.
 * Interactive, question-driven bootstrap remains the job of the `mygrace-init` skill.
 */

// START_MODULE_CONTRACT
//   PURPOSE: Bootstrap a MyGRACE project (docs/ indexes, AGENTS.md, mygrace.config.json) from bundled templates.
//   SCOPE: Writes inside the target project; templates read from the package directory.
//   DEPENDS: grace-config (serializeConfig), node:fs, node:path
//   LINKS: ROADMAP.md (ADR-5); templates/
// END_MODULE_CONTRACT

// START_MODULE_MAP
//   templatesDir()   — bundled templates directory
//   substitute()     — $VAR placeholder replacement
//   buildSpecs()     — template → destination mapping
//   ensureGitignore()— keeps `.mygrace/` (local trust state) out of version control
//   initDshCommand   — citty command with --force/--path/… options
// END_MODULE_MAP

// START_CHANGE_SUMMARY
//   W1.1 — writes mygrace.config.json (ADR-5) and documents the generated layout.
//   W2.3 — ensures `.mygrace/` is gitignored so the ADR-1 trust record is never committed.
// END_CHANGE_SUMMARY

import { defineCommand } from "citty";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { CONFIG_FILENAME, cloneDefault, serializeConfig } from "./grace-config";

// ─── Helpers ────────────────────────────────────────────────────────────

function templatesDir(): string {
  return join(dirname(import.meta.dirname), "templates");
}

function substitute(content: string, vars: Record<string, string>): string {
  return content.replace(/\$(\w+)/g, (match, key: string) => vars[key] ?? match);
}

interface TemplateSpec {
  template: string;
  dest: string;
}

function buildSpecs(root: string): TemplateSpec[] {
  const templates = templatesDir();
  return [
    { template: "graph-index.xml.template", dest: "docs/graph-index.xml" },
    { template: "plan-index.xml.template", dest: "docs/plan-index.xml" },
    { template: "verification-index.xml.template", dest: "docs/verification-index.xml" },
    { template: "operational-packets.xml.template", dest: "docs/operational-packets.xml" },
    { template: "requirements.xml.template", dest: "docs/requirements.xml" },
    { template: "technology.xml.template", dest: "docs/technology.xml" },
    { template: "AGENTS.dsh.md.template", dest: "AGENTS.md" },
  ].map((spec) => ({ template: join(templates, spec.template), dest: join(root, spec.dest) }));
}

/**
 * Keep `.mygrace/` out of version control (ADR-1).
 *
 * Creates a `.gitignore` when the project has none; when one exists, only
 * informs the user — silently rewriting someone else's ignore rules would be
 * rude and is not required (the `trust` command warns as well).
 */
function ensureGitignore(root: string): { action: "created" | "listed" | "noted"; path: string } {
  const gitignorePath = join(root, ".gitignore");
  const entry = ".mygrace/";

  if (!existsSync(gitignorePath)) {
    writeFileSync(gitignorePath, `${entry}\n`);
    return { action: "created", path: gitignorePath };
  }

  const existing = readFileSync(gitignorePath, "utf-8");
  const alreadyIgnored = existing
    .split("\n")
    .map((line) => line.trim())
    .some((line) => line === entry || line === ".mygrace");
  return { action: alreadyIgnored ? "listed" : "noted", path: gitignorePath };
}

// ─── Command ────────────────────────────────────────────────────────────

export const initDshCommand = defineCommand({
  meta: {
    name: "init-dsh",
    description: "Bootstrap docs/ index structure, AGENTS.md and mygrace.config.json from templates (non-interactive)",
  },
  args: {
    path: { type: "string", default: ".", description: "Project root to initialize" },
    name: { type: "string", description: "Project name (default: directory name)" },
    keywords: { type: "string", description: "Comma-separated project keywords" },
    annotation: { type: "string", description: "One-line project annotation" },
    language: { type: "string", default: "typescript", description: "Primary language" },
    runtime: { type: "string", default: "bun", description: "Runtime" },
    framework: { type: "string", default: "", description: "Framework (optional)" },
    testRunner: { type: "string", default: "bun test", description: "Test runner" },
    force: { type: "boolean", default: false, description: "Overwrite existing files" },
  },
  run: async ({ args }) => {
    const root = resolve(args.path);
    const name = typeof args.name === "string" && args.name !== "" ? args.name : basename(root);
    const language = typeof args.language === "string" && args.language !== "" ? args.language : "typescript";
    const testRunner = typeof args.testRunner === "string" && args.testRunner !== "" ? args.testRunner : "bun test";
    const framework = typeof args.framework === "string" ? args.framework : "";
    const vars: Record<string, string> = {
      PROJECT_NAME: name,
      KEYWORDS: typeof args.keywords === "string" && args.keywords !== "" ? args.keywords : "mygrace",
      ANNOTATION: typeof args.annotation === "string" && args.annotation !== "" ? args.annotation : "MyGRACE project",
      LANGUAGE: language,
      LANGUAGE_VERSION: "latest",
      RUNTIME: typeof args.runtime === "string" ? args.runtime : "bun",
      RUNTIME_VERSION: "latest",
      FRAMEWORK: framework === "" ? "none" : framework,
      FRAMEWORK_VERSION: framework === "" ? "" : "latest",
      TEST_RUNNER: testRunner,
      TEST_RUNNER_VERSION: "latest",
      LOGGER_STACK: "console",
    };

    console.log("MyGRACE init-dsh");
    console.log(`Project: ${name}`);
    console.log(`Root:    ${root}`);
    console.log();

    if (!existsSync(templatesDir())) {
      console.error(`Error: templates not found at ${templatesDir()} — package may be incomplete.`);
      process.exit(1);
    }

    mkdirSync(root, { recursive: true });
    for (const dir of ["docs", "docs/modules", "docs/plans", "docs/verification", "docs/archive"]) {
      mkdirSync(join(root, dir), { recursive: true });
    }
    for (const dir of ["docs/modules", "docs/plans", "docs/verification", "docs/archive"]) {
      const keep = join(root, dir, ".gitkeep");
      if (!existsSync(keep)) writeFileSync(keep, "");
    }

    let created = 0;
    let skipped = 0;
    const force = args.force === true;
    for (const spec of buildSpecs(root)) {
      if (!existsSync(spec.template)) {
        console.log(`• WARNING: template missing: ${spec.template}`);
        continue;
      }
      if (existsSync(spec.dest) && !force) {
        console.log(`• skipped (exists, use --force to overwrite): ${spec.dest}`);
        skipped += 1;
        continue;
      }
      const content = substitute(readFileSync(spec.template, "utf-8"), vars);
      writeFileSync(spec.dest, content);
      console.log(`• created: ${spec.dest}`);
      created += 1;
    }

    // ADR-5: surface layout/budget defaults in an editable config file.
    const configFile = join(root, CONFIG_FILENAME);
    if (existsSync(configFile) && !force) {
      console.log(`• skipped (exists, use --force to overwrite): ${configFile}`);
      skipped += 1;
    } else {
      writeFileSync(
        configFile,
        serializeConfig({
          ...cloneDefault(),
          language,
          testRunner,
        })
      );
      console.log(`• created: ${configFile}`);
      created += 1;
    }

    // ADR-1: local trust state must never be committed.
    const gitignore = ensureGitignore(root);
    if (gitignore.action === "created") {
      console.log(`• created: ${gitignore.path} (ignores .mygrace/)`);
      created += 1;
    } else if (gitignore.action === "noted") {
      console.log(`• note: add \`.mygrace/\` to ${gitignore.path} — the trust record is local state`);
    }

    console.log();
    console.log(`Done: ${created} created, ${skipped} skipped.`);
    console.log();
    console.log("Next steps:");
    console.log("  1. Fill docs/requirements.xml and docs/technology.xml.");
    console.log("  2. Invoke the mygrace-plan skill to design modules and phases.");
    console.log("  3. Invoke mygrace-verification, then mygrace-execute.");
    console.log(`  4. Adjust ${CONFIG_FILENAME} (sourceDirs, indexCaps, sizeBudgets, testRunner) if the defaults do not fit.`);
    console.log("  The DSH agent auto-loads AGENTS.md — no further setup needed.");
  },
});
