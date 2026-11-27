#!/usr/bin/env bun
/**
 * MyGRACE Marketplace / repository validation.
 *
 * v1 kept a hardcoded list of 14 skills and a stale allowlist of CLI commands,
 * so the 15th skill and six real commands were never validated and a sabotaged
 * repository still printed "✓ All checks passed" (audit report 02 §5).
 *
 * v2 derives the truth from the code and the filesystem:
 *   - skills      ← readdir(skills/mygrace) (exactly EXPECTED_SKILL_COUNT dirs)
 *   - CLI surface ← the citty command tree exported by src/grace.ts
 *   - MCP tools   ← TOOL_NAMES from src/grace-mcp-commands.ts
 *   - docs claims ← README.md / AGENTS.md cross-checks
 * Every mismatch is an ERROR and exits 1. Warnings do not exist any more.
 *
 * Usage:
 *   bun run scripts/validate-marketplace.ts [--root <repo>] [--json]
 *   bun run scripts/validate-marketplace.ts --self-test   # sabotage tests for this validator
 */

import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { parse as parseYaml } from "yaml";
import { walkFiles } from "../src/grace-common";
import { TOOL_NAMES } from "../src/grace-mcp-commands";
import {
  commandAcceptsFlag,
  extractCommandRefs,
  loadCommandTree,
  resolveCommand,
  skillNameFromDir,
} from "./lib/docs-scan";

// ─── options ────────────────────────────────────────────────────────────

interface Options {
  root: string;
  json: boolean;
  selfTest: boolean;
  quiet: boolean;
}

function parseOptions(argv: readonly string[]): Options {
  const options: Options = {
    root: resolve(process.env.MYGRACE_VALIDATE_ROOT ?? join(import.meta.dirname, "..")),
    json: false,
    selfTest: false,
    quiet: false,
  };
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index]!;
    if (argument === "--json") options.json = true;
    else if (argument === "--self-test") options.selfTest = true;
    else if (argument === "--quiet") options.quiet = true;
    else if (argument === "--root") {
      const next = argv[index + 1];
      if (next === undefined) throw new Error("--root requires a directory argument");
      options.root = resolve(next);
      index++;
    } else if (argument.startsWith("--root=")) {
      options.root = resolve(argument.slice("--root=".length));
    } else if (argument === "--help" || argument === "-h") {
      console.log(
        "Usage: bun run scripts/validate-marketplace.ts [--root <repo>] [--json] [--self-test]\n" +
          "Validates skills, CLI command references, MCP catalog, README claims and repository packaging."
      );
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${argument}`);
    }
  }
  return options;
}

// ─── findings ───────────────────────────────────────────────────────────

interface ValidationError {
  message: string;
  file?: string;
  line?: number;
}

class ValidationCollector {
  readonly errors: ValidationError[] = [];
  private readonly root: string;

  constructor(root: string) {
    this.root = root;
  }

  error(message: string, file?: string, line?: number): void {
    this.errors.push({ message, ...(file === undefined ? {} : { file }), ...(line === undefined ? {} : { line }) });
  }

  relative(path: string): string {
    const rel = relative(this.root, path);
    return rel === "" ? "." : rel;
  }
}

const EXPECTED_SKILL_COUNT = 14;

// ─── helpers ────────────────────────────────────────────────────────────

function readText(path: string): string | undefined {
  try {
    return readFileSync(path, "utf-8");
  } catch {
    return undefined;
  }
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function frontmatterOf(content: string): { ok: boolean; data?: Record<string, unknown>; reason?: string } {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (match === null) return { ok: false, reason: "missing YAML frontmatter (--- block at the top)" };
  try {
    const parsed: unknown = parseYaml(match[1]!);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { ok: false, reason: "frontmatter is not a YAML mapping" };
    }
    return { ok: true, data: parsed as Record<string, unknown> };
  } catch (error) {
    return { ok: false, reason: `frontmatter is not valid YAML: ${error instanceof Error ? error.message : String(error)}` };
  }
}

function uniqueSorted(values: Iterable<string>): string[] {
  return [...new Set(values)].sort();
}

function collectSkillDirs(root: string): string[] {
  const dir = join(root, "skills", "mygrace");
  if (!isDirectory(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name.startsWith("grace-"))
    .map((entry) => entry.name)
    .sort();
}

function tableSkillNames(content: string): string[] {
  const names: string[] = [];
  for (const line of content.split("\n")) {
    const match = line.match(/^\|\s*`(mygrace-[a-z0-9-]+)`\s*\|/);
    if (match !== null) names.push(match[1]!);
  }
  return uniqueSorted(names);
}

function countClaims(content: string, pattern: RegExp): Array<{ value: number; line: number; match: string }> {
  const claims: Array<{ value: number; line: number; match: string }> = [];
  content.split("\n").forEach((line, index) => {
    const flags = pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`;
    const regex = new RegExp(pattern.source, flags);
    for (const match of line.matchAll(regex)) {
      const value = Number(match[1]);
      if (Number.isFinite(value)) claims.push({ value, line: index + 1, match: match[0].trim() });
    }
  });
  return claims;
}

// ─── checks ─────────────────────────────────────────────────────────────

function checkRequiredPaths(root: string, collector: ValidationCollector): void {
  const requiredDirs = [
    "skills/mygrace",
    "templates",
    "templates/module",
    "templates/phase",
    "templates/verification",
    "src",
    "scripts",
    "scripts/lib",
    ".github/workflows",
    "extensions/mygrace",
    "extensions/mygrace/commands",
    "extensions/mygrace/hooks",
  ];
  for (const dir of requiredDirs) {
    if (!isDirectory(join(root, dir))) collector.error(`Missing directory: ${dir}`);
  }

  const requiredFiles = [
    "package.json",
    "README.md",
    "AGENTS.md",
    "tsconfig.json",
    "bunfig.toml",
    "lefthook.yml",
    ".github/workflows/ci.yml",
    "src/grace.ts",
    "src/grace-errors.ts",
    "src/grace-xml.ts",
    "src/grace-paths.ts",
    "src/grace-config.ts",
    "src/grace-lint.ts",
    "src/grace-module.ts",
    "src/grace-file.ts",
    "src/grace-mcp.ts",
    "src/grace-mcp-commands.ts",
    "src/grace-common.ts",
    "scripts/validate-marketplace.ts",
    "scripts/validate-docs.ts",
    "scripts/measure-context.ts",
    "scripts/gen-example.ts",
    "scripts/gen-dsh-skill-mygrace.ts",
    "scripts/pack-smoke.ts",
    "extensions/mygrace/qwen-extension.json",
    "extensions/mygrace/QWEN.md",
    "templates/graph-index.xml.template",
    "templates/plan-index.xml.template",
    "templates/verification-index.xml.template",
  ];
  for (const file of requiredFiles) {
    if (!existsSync(join(root, file))) collector.error(`Missing file: ${file}`);
  }
}

function checkSkills(root: string, collector: ValidationCollector): string[] {
  const skillDirs = collectSkillDirs(root);
  const skillNames = skillDirs.map(skillNameFromDir);

  if (skillDirs.length !== EXPECTED_SKILL_COUNT) {
    collector.error(
      `Expected exactly ${EXPECTED_SKILL_COUNT} skills in skills/mygrace, found ${skillDirs.length}` +
        (skillDirs.length === 0 ? "" : ` (${skillDirs.join(", ")})`),
      "skills/mygrace"
    );
  }

  const names = new Set<string>();
  for (const dirName of skillDirs) {
    const expectedName = skillNameFromDir(dirName);
    const skillPath = join(root, "skills", "mygrace", dirName, "SKILL.md");
    const content = readText(skillPath);
    if (content === undefined) {
      collector.error(`Skill ${dirName}: missing SKILL.md`, `skills/mygrace/${dirName}`);
      continue;
    }
    if (names.has(expectedName)) collector.error(`Duplicate skill name: ${expectedName}`);
    names.add(expectedName);

    const frontmatter = frontmatterOf(content);
    if (!frontmatter.ok) {
      collector.error(`Skill ${dirName}: ${frontmatter.reason ?? "invalid frontmatter"}`, `skills/mygrace/${dirName}/SKILL.md`);
      continue;
    }
    const data = frontmatter.data ?? {};
    const name = data.name;
    const description = data.description;
    const whenToUse = data.whenToUse;
    if (typeof name !== "string" || name.trim() === "") {
      collector.error(`Skill ${dirName}: frontmatter "name" must be a non-empty string`, `skills/mygrace/${dirName}/SKILL.md`);
    } else {
      if (name !== expectedName) {
        collector.error(
          `Skill ${dirName}: frontmatter name "${name}" does not match directory mapping "${expectedName}"`,
          `skills/mygrace/${dirName}/SKILL.md`
        );
      }
      if (!/^mygrace-[a-z0-9-]+$/.test(name)) {
        collector.error(`Skill ${dirName}: invalid skill name "${name}"`, `skills/mygrace/${dirName}/SKILL.md`);
      }
    }
    if (typeof description !== "string" || description.trim().length < 10) {
      collector.error(
        `Skill ${dirName}: frontmatter "description" must be a descriptive string (>=10 chars)`,
        `skills/mygrace/${dirName}/SKILL.md`
      );
    }
    if (typeof whenToUse !== "string" || whenToUse.trim() === "") {
      collector.error(
        `Skill ${dirName}: frontmatter "whenToUse" must be a non-empty string`,
        `skills/mygrace/${dirName}/SKILL.md`
      );
    }
  }

  return uniqueSorted(skillNames);
}

function checkReadmeSkills(root: string, collector: ValidationCollector, diskSkills: string[]): void {
  const readme = readText(join(root, "README.md"));
  if (readme === undefined) return;

  const documented = tableSkillNames(readme);
  const diskSet = new Set(diskSkills);
  const documentedSet = new Set(documented);

  for (const name of diskSkills) {
    if (!documentedSet.has(name)) collector.error(`README skill table is missing "${name}"`, "README.md", 1);
  }
  for (const name of documented) {
    if (!diskSet.has(name)) collector.error(`README documents unknown skill "${name}"`, "README.md", 1);
  }

  const claims = [...countClaims(readme, /Skills \((\d+)/i), ...countClaims(readme, /(\d+)\s+skills\b/i)];
  for (const claim of claims) {
    if (claim.value !== diskSkills.length) {
      collector.error(
        `README claims ${claim.value} skills ("${claim.match}") but skills/mygrace has ${diskSkills.length} — update the docs or the filesystem`,
        "README.md",
        claim.line
      );
    }
  }
}

function checkAgentsSkills(root: string, collector: ValidationCollector, diskSkills: string[]): void {
  const agents = readText(join(root, "AGENTS.md"));
  if (agents === undefined) {
    collector.error("Missing AGENTS.md", "AGENTS.md");
    return;
  }
  const diskSet = new Set(diskSkills);
  for (const name of tableSkillNames(agents)) {
    if (!diskSet.has(name)) collector.error(`AGENTS.md documents unknown skill "${name}"`, "AGENTS.md", 1);
  }
}

function checkSkillCommandReferences(root: string, collector: ValidationCollector): void {
  const tree = loadCommandTree();
  const mcpTools = new Set<string>(TOOL_NAMES);
  for (const dirName of collectSkillDirs(root)) {
    const relativePath = `skills/mygrace/${dirName}/SKILL.md`;
    const content = readText(join(root, relativePath));
    if (content === undefined) continue;

    for (const ref of extractCommandRefs(content, relativePath)) {
      const command = resolveCommand(tree, ref.commandPath);
      if (command === undefined) {
        collector.error(`Skill ${dirName}: unknown CLI command "mygrace ${ref.commandPath.join(" ")}"`, relativePath, ref.line);
        continue;
      }
      for (const flag of ref.flags) {
        if (!commandAcceptsFlag(command, flag)) {
          collector.error(
            `Skill ${dirName}: unknown flag "--${flag}" for "mygrace ${command.path.join(" ")}"`,
            relativePath,
            ref.line
          );
        }
      }
    }

    for (const match of content.matchAll(/mygrace_[a-z][a-z0-9_]*/g)) {
      const tool = match[0];
      if (!mcpTools.has(tool)) {
        collector.error(`Skill ${dirName}: unknown MCP tool "${tool}"`, relativePath, 1);
      }
    }
  }
}

function checkMcpCatalog(root: string, collector: ValidationCollector): void {
  if (TOOL_NAMES.length === 0) {
    collector.error("MCP tool catalog is empty (TOOL_NAMES)", "src/grace-mcp-commands.ts");
    return;
  }
  const duplicateNames = TOOL_NAMES.filter((name, index) => TOOL_NAMES.indexOf(name) !== index);
  for (const name of uniqueSorted(duplicateNames)) {
    collector.error(`Duplicate MCP tool name: ${name}`, "src/grace-mcp-commands.ts");
  }

  const readme = readText(join(root, "README.md"));
  if (readme === undefined) return;
  const documented = uniqueSorted(readme.match(/mygrace_[a-z][a-z0-9_]*/g) ?? []);
  const code = new Set<string>(TOOL_NAMES);
  const docs = new Set(documented);

  for (const name of TOOL_NAMES) {
    if (!docs.has(name)) collector.error(
      `README does not document MCP tool "${name}" — update README.md or the code; the validator derives the catalogue from src/grace-mcp-commands.ts`,
      "README.md",
      1
    );
  }
  for (const name of documented) {
    if (!code.has(name)) collector.error(
      `README documents unknown MCP tool "${name}" — remove it or add it to src/grace-mcp-commands.ts`,
      "README.md",
      1
    );
  }

  for (const claim of countClaims(readme, /(\d+)\s+MCP tools?\b/i)) {
    if (claim.value !== TOOL_NAMES.length) {
      collector.error(
        `README claims ${claim.value} MCP tools ("${claim.match}") but the code catalogue (TOOL_NAMES) has ${TOOL_NAMES.length} — update the docs or the catalogue`,
        "README.md",
        claim.line
      );
    }
  }

  const agents = readText(join(root, "AGENTS.md"));
  if (agents !== undefined) {
    for (const name of agents.match(/mygrace_[a-z][a-z0-9_]*/g) ?? []) {
      if (!code.has(name)) collector.error(`AGENTS.md documents unknown MCP tool "${name}"`, "AGENTS.md", 1);
    }
  }
}

function checkVersionConsistency(root: string, collector: ValidationCollector): void {
  const pkgText = readText(join(root, "package.json"));
  if (pkgText === undefined) return;
  let pkg: { version?: string; name?: string };
  try {
    pkg = JSON.parse(pkgText) as { version?: string; name?: string };
  } catch {
    collector.error("package.json is not valid JSON", "package.json");
    return;
  }
  if (typeof pkg.version !== "string") collector.error("package.json has no version", "package.json");

  const readme = readText(join(root, "README.md"));
  if (readme !== undefined) {
    const match = readme.match(/Current version:\s*`([^`]+)`/);
    if (match === null) {
      collector.error("README.md has no `Current version: `x.y.z`` marker", "README.md", 1);
    } else if (match[1] !== pkg.version) {
      collector.error(`Version mismatch: package.json=${String(pkg.version)}, README.md=${String(match[1])}`, "README.md");
    }
  }

  const extensionText = readText(join(root, "extensions/mygrace/qwen-extension.json"));
  if (extensionText !== undefined) {
    try {
      const extension = JSON.parse(extensionText) as { version?: string };
      if (extension.version !== pkg.version) {
        collector.error(
          `Version mismatch: package.json=${String(pkg.version)}, extension=${String(extension.version)}`,
          "extensions/mygrace/qwen-extension.json"
        );
      }
    } catch {
      collector.error("extension manifest is not valid JSON", "extensions/mygrace/qwen-extension.json");
    }
  }
}

function checkPackageManifest(root: string, collector: ValidationCollector): void {
  const pkgText = readText(join(root, "package.json"));
  if (pkgText === undefined) return;
  let pkg: {
    name?: string;
    bin?: Record<string, string>;
    files?: string[];
    scripts?: Record<string, string>;
    devDependencies?: Record<string, string>;
  };
  try {
    pkg = JSON.parse(pkgText) as typeof pkg;
  } catch {
    return; // reported by checkVersionConsistency
  }
  if (pkg.name !== "mygrace-cli") {
    collector.error(`package.json name should be mygrace-cli, got ${String(pkg.name)}`, "package.json");
  }
  // npm normalises a "./" prefix at publish time; accept both spellings.
  const binTarget = String(pkg.bin?.mygrace ?? "").replace(/^\.\//, "");
  if (binTarget !== "src/grace.ts") {
    collector.error("package.json bin should map 'mygrace' to src/grace.ts", "package.json");
  }
  const files = pkg.files ?? [];
  for (const required of ["src", "templates", "skills/mygrace", "README.md", "LICENSE"]) {
    if (!files.includes(required)) collector.error(`package.json "files" is missing "${required}"`, "package.json");
  }
  const scripts = pkg.scripts ?? {};
  const requiredScripts = [
    "typecheck",
    "test",
    "test:demo",
    "test:all",
    "lint:demo",
    "pack:smoke",
    "validate:marketplace",
    "validate:docs",
    "ci",
  ];
  for (const script of requiredScripts) {
    const value = scripts[script];
    if (typeof value !== "string" || value.trim() === "") {
      collector.error(`package.json is missing the "${script}" script`, "package.json");
    }
  }
  // npm publication is intentionally not used (GitHub Releases distribution), so
  // prepublishOnly/publishConfig are not required. `release:check` still runs in CI
  // and in the tag-driven release workflow.
  for (const dependency of ["typescript", "@types/bun"]) {
    if (typeof pkg.devDependencies?.[dependency] !== "string") {
      collector.error(`package.json devDependencies is missing ${dependency}`, "package.json");
    }
  }
}

function checkExtensionManifest(root: string, collector: ValidationCollector): void {
  const extDir = join(root, "extensions", "mygrace");
  const manifestPath = join(extDir, "qwen-extension.json");
  const text = readText(manifestPath);
  if (text === undefined) return; // reported as missing required file
  let manifest: {
    skills?: string;
    agents?: string;
    commands?: string;
    mcpServers?: Array<{ args?: string[] }>;
  };
  try {
    manifest = JSON.parse(text) as typeof manifest;
  } catch {
    return; // reported by version check
  }
  for (const value of [manifest.skills, manifest.agents, manifest.commands].filter(
    (entry): entry is string => typeof entry === "string"
  )) {
    if (!existsSync(resolve(extDir, value))) {
      collector.error(`Extension manifest path missing: ${value} (relative to extensions/mygrace/)`, "extensions/mygrace/qwen-extension.json");
    }
  }
  for (const server of manifest.mcpServers ?? []) {
    for (const argument of server.args ?? []) {
      const resolved = argument.replace(/\$\{extensionDir\}/g, extDir);
      if (resolved.endsWith(".ts") && !existsSync(resolved)) {
        collector.error(`Extension MCP script missing: ${resolved}`, "extensions/mygrace/qwen-extension.json");
      }
    }
  }
}

const ABSOLUTE_PATH_PATTERN = /(?:\/home\/[A-Za-z0-9._-]+\/|\/Users\/[A-Za-z0-9._-]+\/|[A-Za-z]:\\Users\\[^\\]+)/;
const SCANNED_SOURCE_EXTS = [".ts", ".js", ".mjs", ".cjs", ".json", ".md", ".xml", ".yml", ".yaml", ".sh", ".py", ".template", ".txt"];

/**
 * Check for hardcoded home-directory paths in shipped artifacts.
 *
 * `scripts/` is excluded on purpose: this validator legitimately contains path
 * *patterns*. Binary/large files are skipped.
 */
function checkHardcodedPaths(root: string, collector: ValidationCollector): void {
  const targets = ["src", "packages", "templates", "skills", ".github", "examples", "rules", "plugins"];
  const ignoreDirs = ["node_modules", ".git", "dist", "build", "vendor", ".bun-tmp", ".bun-install", ".pack-smoke"];
  for (const target of targets) {
    const dir = join(root, target);
    if (!isDirectory(dir)) continue;
    for (const absoluteFile of walkFiles(dir, { ignoreDirs, exts: SCANNED_SOURCE_EXTS, maxFiles: 50_000 })) {
      let content: string;
      try {
        if (statSync(absoluteFile).size > 512 * 1024) continue;
        content = readFileSync(absoluteFile, "utf-8");
      } catch {
        continue;
      }
      const match = content.match(ABSOLUTE_PATH_PATTERN);
      if (match !== null) {
        collector.error(
          `Hardcoded absolute path "${match[0]}" in ${collector.relative(absoluteFile)}`,
          collector.relative(absoluteFile)
        );
      }
    }
  }
}

// ─── report ─────────────────────────────────────────────────────────────

function formatError(error: ValidationError): string {
  const location = error.file === undefined ? "" : ` [${error.file}${error.line === undefined ? "" : `:${error.line}`}]`;
  return `${location} ${error.message}`.trim();
}

function runValidation(root: string): ValidationCollector {
  const collector = new ValidationCollector(root);
  checkRequiredPaths(root, collector);
  const skills = checkSkills(root, collector);
  checkReadmeSkills(root, collector, skills);
  checkAgentsSkills(root, collector, skills);
  checkSkillCommandReferences(root, collector);
  checkMcpCatalog(root, collector);
  checkVersionConsistency(root, collector);
  checkPackageManifest(root, collector);
  checkExtensionManifest(root, collector);
  checkHardcodedPaths(root, collector);
  return collector;
}

function main(): void {
  const argv = process.argv.slice(2);
  const options = parseOptions(argv);

  if (options.selfTest) {
    process.exit(runSelfTest(options));
  }

  const collector = runValidation(options.root);
  if (options.json) {
    console.log(JSON.stringify({ ok: collector.errors.length === 0, errors: collector.errors }, null, 2));
  } else if (collector.errors.length === 0) {
    console.log(
      `✓ Marketplace validation passed (${collectSkillDirs(options.root).length} skills, ${TOOL_NAMES.length} MCP tools from code).`
    );
  } else {
    console.log(`✗ Marketplace validation failed: ${collector.errors.length} error(s).`);
    for (const error of collector.errors) console.log(`  ✗ ${formatError(error)}`);
    console.log("");
    console.log("Fix the drift above; this script is a release gate and never passes silently.");
  }
  process.exit(collector.errors.length === 0 ? 0 : 1);
}

// ─── sabotage self-test ─────────────────────────────────────────────────

interface SelfTestCase {
  name: string;
  expected: RegExp;
  mutate: (root: string) => void;
}

function copyRepositorySubset(source: string, target: string): void {
  mkdirSync(target, { recursive: true });
  for (const file of ["package.json", "README.md", "AGENTS.md", "tsconfig.json", "bunfig.toml", "lefthook.yml"]) {
    if (existsSync(join(source, file))) cpSync(join(source, file), join(target, file));
  }
  for (const dir of ["skills", "templates", "src", "scripts", "extensions", ".github"]) {
    if (existsSync(join(source, dir))) cpSync(join(source, dir), join(target, dir), { recursive: true });
  }
}

function normalizeBaselineCopy(root: string): void {
  // The self-test proves the validator catches sabotage; pre-existing docs drift
  // (fixed by the docs truth pass) is normalised so the control run can pass.
  // The injected tool comment is what the sabotage cases then remove/alter.
  const readmePath = join(root, "README.md");
  const readme = readText(readmePath);
  if (readme === undefined) return;
  const normalized = readme
    .replace(/Skills \(\d+/g, "Skills (14")
    .replace(/\b\d+ skills\b/g, "14 skills")
    .replace(/\b\d+ MCP tools\b/g, `${TOOL_NAMES.length} MCP tools`);
  writeFileSync(readmePath, `${normalized}\n<!-- validator self-test tool catalogue: ${TOOL_NAMES.join(" ")} -->\n`);
}

function runSelfTest(options: Options): number {
  const base = mkdtempSync(join(tmpdir(), "mygrace-validate-selftest-"));
  const pristine = join(base, "pristine");
  const work = join(base, "work");
  const scriptPath = join(import.meta.dirname, "validate-marketplace.ts");
  const cases: SelfTestCase[] = [
    {
      name: "removed skill directory is detected",
      expected: /Expected exactly 14 skills/,
      mutate: (root) => rmSync(join(root, "skills", "mygrace", "grace-status"), { recursive: true, force: true }),
    },
    {
      name: "extra (15th) skill directory is detected",
      expected: /Expected exactly 14 skills/,
      mutate: (root) => {
        const dir = join(root, "skills", "mygrace", "grace-extra");
        mkdirSync(join(dir), { recursive: true });
        writeFileSync(
          join(dir, "SKILL.md"),
          '---\nname: mygrace-extra\ndescription: "An undeclared extra skill used by the validator self-test."\nwhenToUse: "never"\n---\n'
        );
      },
    },
    {
      name: "README skill count drift is detected",
      expected: /claims 15 skills/,
      mutate: (root) => {
        const readmePath = join(root, "README.md");
        writeFileSync(readmePath, readText(readmePath)!.replace("Skills (14", "Skills (15"));
      },
    },
    {
      name: "README MCP tool drift is detected",
      expected: /MCP tool/,
      mutate: (root) => {
        const readmePath = join(root, "README.md");
        writeFileSync(readmePath, readText(readmePath)!.replace(/`?mygrace_verify`?[,]?\s*/g, ""));
      },
    },
    {
      name: "unknown CLI command in a skill is detected",
      expected: /unknown CLI command "mygrace totally-bogus"/,
      mutate: (root) => {
        const skillPath = join(root, "skills", "mygrace", "grace-status", "SKILL.md");
        writeFileSync(skillPath, `${readText(skillPath)!}\nRun \`mygrace totally-bogus\` to test the validator.\n`);
      },
    },
    {
      name: "unknown flag in a skill is detected",
      expected: /unknown flag "--totally-bogus"/,
      mutate: (root) => {
        const skillPath = join(root, "skills", "mygrace", "grace-status", "SKILL.md");
        writeFileSync(skillPath, `${readText(skillPath)!}\nRun \`mygrace lint --totally-bogus\` to test the validator.\n`);
      },
    },
  ];

  try {
    copyRepositorySubset(options.root, pristine);
    normalizeBaselineCopy(pristine);

    const control = spawnSync(process.execPath, [scriptPath, "--root", pristine, "--quiet"], {
      encoding: "utf-8",
      env: { ...process.env, MYGRACE_VALIDATE_ROOT: "" },
    });
    const controlOutput = `${control.stdout ?? ""}${control.stderr ?? ""}`;
    if (control.status !== 0) {
      console.log("✗ self-test control run failed — the repository has unrelated validation drift:");
      console.log(controlOutput.trim());
      return 1;
    }

    let failures = 0;
    for (const testCase of cases) {
      rmSync(work, { recursive: true, force: true });
      cpSync(pristine, work, { recursive: true });
      testCase.mutate(work);
      const run = spawnSync(process.execPath, [scriptPath, "--root", work, "--quiet"], {
        encoding: "utf-8",
        env: { ...process.env, MYGRACE_VALIDATE_ROOT: "" },
      });
      const output = `${run.stdout ?? ""}${run.stderr ?? ""}`;
      const detected = run.status !== 0 && testCase.expected.test(output);
      console.log(`${detected ? "✓" : "✗"} self-test: ${testCase.name}${detected ? "" : " — NOT DETECTED"}`);
      if (!detected) {
        failures++;
        console.log(output.trim().split("\n").slice(0, 6).join("\n"));
      }
    }
    console.log(
      failures === 0
        ? `✓ Marketplace validator self-test passed (${cases.length} sabotage cases detected).`
        : `✗ Marketplace validator self-test failed (${failures}/${cases.length} sabotage cases missed).`
    );
    return failures === 0 ? 0 : 1;
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
}

try {
  main();
} catch (error) {
  console.error(`validate-marketplace: internal error: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(3);
}
