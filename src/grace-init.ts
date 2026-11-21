#!/usr/bin/env bun
/**
 * MyGRACE init-dsh Command
 *
 * Non-interactive bootstrap of a MyGRACE project for DeepSeek Harness:
 * creates the docs/ index structure from templates plus an AGENTS.md the
 * harness auto-loads. Interactive, question-driven bootstrap remains the
 * job of the `mygrace-init` skill.
 */

import { defineCommand } from "citty";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, resolve, basename, dirname } from "node:path";

// ─── Helpers ────────────────────────────────────────────────────────────

function templatesDir(): string {
  return join(dirname(import.meta.dir), "templates");
}

function substitute(content: string, vars: Record<string, string>): string {
  return content.replace(/\$(\w+)/g, (match, key: string) => vars[key] ?? match);
}

interface TemplateSpec {
  template: string;
  dest: string;
}

function buildSpecs(root: string, vars: Record<string, string>): TemplateSpec[] {
  const t = templatesDir();
  return [
    { template: "graph-index.xml.template", dest: "docs/graph-index.xml" },
    { template: "plan-index.xml.template", dest: "docs/plan-index.xml" },
    { template: "verification-index.xml.template", dest: "docs/verification-index.xml" },
    { template: "operational-packets.xml.template", dest: "docs/operational-packets.xml" },
    { template: "requirements.xml.template", dest: "docs/requirements.xml" },
    { template: "technology.xml.template", dest: "docs/technology.xml" },
    { template: "AGENTS.dsh.md.template", dest: "AGENTS.md" },
  ].map((s) => ({ template: join(t, s.template), dest: join(root, s.dest) }));
}

// ─── Command ────────────────────────────────────────────────────────────

export const initDshCommand = defineCommand({
  meta: {
    name: "init-dsh",
    description: "Bootstrap docs/ index structure and a DSH AGENTS.md from templates (non-interactive)",
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
    const name = args.name || basename(root);
    const vars: Record<string, string> = {
      PROJECT_NAME: name,
      KEYWORDS: args.keywords || "mygrace",
      ANNOTATION: args.annotation || "MyGRACE project",
      LANGUAGE: args.language,
      LANGUAGE_VERSION: "latest",
      RUNTIME: args.runtime,
      RUNTIME_VERSION: "latest",
      FRAMEWORK: args.framework || "none",
      FRAMEWORK_VERSION: args.framework ? "latest" : "",
      TEST_RUNNER: args.testRunner,
      TEST_RUNNER_VERSION: "latest",
      LOGGER_STACK: "console",
    };

    console.log(`MyGRACE init-dsh`);
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
    for (const spec of buildSpecs(root, vars)) {
      if (!existsSync(spec.template)) {
        console.log(`• WARNING: template missing: ${spec.template}`);
        continue;
      }
      if (existsSync(spec.dest) && !args.force) {
        console.log(`• skipped (exists, use --force to overwrite): ${spec.dest}`);
        skipped++;
        continue;
      }
      const content = substitute(readFileSync(spec.template, "utf-8"), vars);
      writeFileSync(spec.dest, content);
      console.log(`• created: ${spec.dest}`);
      created++;
    }

    console.log();
    console.log(`Done: ${created} created, ${skipped} skipped.`);
    console.log();
    console.log("Next steps:");
    console.log("  1. Fill docs/requirements.xml and docs/technology.xml.");
    console.log("  2. Invoke the mygrace-plan skill to design modules and phases.");
    console.log("  3. Invoke mygrace-verification, then mygrace-execute.");
    console.log("  The DSH agent auto-loads AGENTS.md — no further setup needed.");
  },
});
