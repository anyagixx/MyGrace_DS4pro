#!/usr/bin/env bun
/**
 * MyGRACE Marketplace Validation
 *
 * Checks:
 * 1. Version consistency across package.json, README.md, extension manifest
 * 2. Required files exist in skills/, templates/, src/, extensions/
 * 3. Skills have valid SKILL.md with frontmatter
 * 4. Index templates exist and are parseable
 * 5. No hardcoded absolute paths
 */

import { readFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

const ROOT = import.meta.dir + "/..";
let errors: string[] = [];
let warnings: string[] = [];

function check(condition: boolean, msg: string, isWarning = false) {
  if (!condition) {
    (isWarning ? warnings : errors).push(msg);
  }
}

// ─── 1. Version consistency ─────────────────────────────────────────────

const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf-8"));
const readme = readFileSync(join(ROOT, "README.md"), "utf-8");
const extManifest = JSON.parse(readFileSync(join(ROOT, "extensions/mygrace/qwen-extension.json"), "utf-8"));

const pkgVersion = pkg.version;
const readmeVersionMatch = readme.match(/Current version:\s*`([^`]+)`/);
const readmeVersion = readmeVersionMatch?.[1];
const extVersion = extManifest.version;

check(pkgVersion === readmeVersion, `Version mismatch: package.json=${pkgVersion}, README.md=${readmeVersion}`);
check(pkgVersion === extVersion, `Version mismatch: package.json=${pkgVersion}, extension=${extVersion}`);

console.log(`Version: ${pkgVersion} ✓`);

// ─── 2. Required directories and files ──────────────────────────────────

const requiredDirs = [
  "skills/mygrace",
  "templates",
  "templates/module",
  "templates/phase",
  "templates/verification",
  "src",
  "scripts",
  "extensions/mygrace",
  "extensions/mygrace/commands",
  "extensions/mygrace/hooks",
];

for (const dir of requiredDirs) {
  check(existsSync(join(ROOT, dir)), `Missing directory: ${dir}`);
}

const requiredFiles = [
  "package.json",
  "README.md",
  "src/grace.ts",
  "src/grace-lint.ts",
  "src/grace-module.ts",
  "src/grace-file.ts",
  "src/grace-mcp.ts",
  "extensions/mygrace/qwen-extension.json",
  "extensions/mygrace/QWEN.md",
  "templates/graph-index.xml.template",
  "templates/plan-index.xml.template",
  "templates/verification-index.xml.template",
];

for (const file of requiredFiles) {
  check(existsSync(join(ROOT, file)), `Missing file: ${file}`);
}

// ─── 3. Skills validation ───────────────────────────────────────────────

const skillsDir = join(ROOT, "skills/mygrace");
const expectedSkills = [
  "grace-ask", "grace-cli", "grace-execute", "grace-explainer",
  "grace-fix", "grace-init", "grace-multiagent-execute", "grace-plan",
  "grace-refactor", "grace-refresh", "grace-reviewer", "grace-setup-subagents",
  "grace-status", "grace-verification",
];

for (const skill of expectedSkills) {
  const skillPath = join(skillsDir, skill, "SKILL.md");
  check(existsSync(skillPath), `Missing skill: ${skill} (no SKILL.md)`);

  if (existsSync(skillPath)) {
    const content = readFileSync(skillPath, "utf-8");
    check(content.startsWith("---"), `Skill ${skill}: SKILL.md missing YAML frontmatter`, true);
    check(content.includes("name:"), `Skill ${skill}: SKILL.md missing name in frontmatter`);
    check(content.includes("description:"), `Skill ${skill}: SKILL.md missing description in frontmatter`);
  }
}

console.log(`Skills: ${expectedSkills.length} ✓`);

// ─── 4. Index templates validation ──────────────────────────────────────

const indexTemplates = [
  "templates/graph-index.xml.template",
  "templates/plan-index.xml.template",
  "templates/verification-index.xml.template",
];

for (const tpl of indexTemplates) {
  const path = join(ROOT, tpl);
  if (existsSync(path)) {
    const content = readFileSync(path, "utf-8");
    check(content.includes("$"), `Template ${tpl}: no placeholders found`, true);
  }
}

// ─── 5. No hardcoded absolute paths ─────────────────────────────────────

function checkAbsolutePaths(dir: string) {
  if (!existsSync(dir)) return;
  for (const file of readdirSync(dir)) {
    const fullPath = join(dir, file);
    try {
      const content = readFileSync(fullPath, "utf-8");
      if (/\b\/home\/\w+\//.test(content) || /\b\/Users\/\w+\//.test(content)) {
        check(false, `Hardcoded absolute path in: ${file}`, true);
      }
    } catch { /* binary file, skip */ }
  }
}

checkAbsolutePaths(join(ROOT, "src"));
checkAbsolutePaths(join(ROOT, "scripts"));

// ─── 6. Package.json validation ─────────────────────────────────────────

check(pkg.name === "@osovv/mygrace-cli", `package.json name should be @osovv/mygrace-cli, got ${pkg.name}`);
check(pkg.bin?.mygrace === "./src/grace.ts", "package.json bin should map 'mygrace' to ./src/grace.ts");

// ─── 7. Skills reference only existing CLI commands ─────────────────────

const KNOWN_CLI_COMMANDS = new Set(["lint", "module", "phase", "verification", "file", "status", "install-dsh", "init-dsh"]);
for (const skill of expectedSkills) {
  const skillPath = join(skillsDir, skill, "SKILL.md");
  if (!existsSync(skillPath)) continue;
  const content = readFileSync(skillPath, "utf-8");
  for (const m of content.matchAll(/\bmygrace\s+([a-z][a-z-]*)/g)) {
    const cmd = m[1];
    if (!KNOWN_CLI_COMMANDS.has(cmd)) {
      check(false, `Skill ${skill}: references unknown CLI command 'mygrace ${cmd}'`, true);
    }
  }
}

// ─── 8. Extension manifest paths resolve ────────────────────────────────

const extDir = join(ROOT, "extensions", "mygrace");
const extManifestPath = join(extDir, "qwen-extension.json");
if (existsSync(extManifestPath)) {
  const manifest = JSON.parse(readFileSync(extManifestPath, "utf-8"));
  for (const p of [manifest.skills, manifest.agents, manifest.commands].filter(Boolean)) {
    check(existsSync(join(extDir, p)), `Extension manifest path missing: ${p} (relative to extensions/mygrace/)`);
  }
  for (const srv of manifest.mcpServers ?? []) {
    for (const a of srv.args ?? []) {
      const resolved = a.replace(/\$\{extensionDir\}/g, extDir);
      if (resolved.endsWith(".ts")) {
        check(existsSync(resolved), `Extension MCP script missing: ${resolved}`);
      }
    }
  }
}

// ─── Report ─────────────────────────────────────────────────────────────

console.log("");
if (errors.length === 0 && warnings.length === 0) {
  console.log("✓ All MyGRACE validation checks passed.");
  process.exit(0);
} else {
  if (errors.length > 0) {
    console.log(`Errors: ${errors.length}`);
    for (const e of errors) console.log(`  ✗ ${e}`);
    console.log("");
  }
  if (warnings.length > 0) {
    console.log(`Warnings: ${warnings.length}`);
    for (const w of warnings) console.log(`  ⚠ ${w}`);
    console.log("");
  }
  process.exit(errors.length > 0 ? 1 : 0);
}
