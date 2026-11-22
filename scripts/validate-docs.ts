#!/usr/bin/env bun
/**
 * MyGRACE documentation truth check (ROADMAP G8, audit report 02 §5/§7).
 *
 * Every documented `mygrace <command>` / `--flag` / `mygrace_<tool>` and every
 * numeric claim ("15 skills", "15 MCP tools") is resolved against the live code
 * surface and the filesystem. Stale marketing claims are explicit errors.
 *
 * Sources (default): README.md, AGENTS.md, skills/mygrace/star/SKILL.md.
 * `--all` additionally scans templates/, extensions/, rules/ and plugins/.
 *
 * Usage:
 *   bun run scripts/validate-docs.ts [--root <repo>] [--json] [--all]
 */

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
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
  all: boolean;
}

function parseOptions(argv: readonly string[]): Options {
  const options: Options = {
    root: resolve(process.env.MYGRACE_VALIDATE_ROOT ?? join(import.meta.dirname, "..")),
    json: false,
    all: false,
  };
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index]!;
    if (argument === "--json") options.json = true;
    else if (argument === "--all") options.all = true;
    else if (argument === "--root") {
      const next = argv[index + 1];
      if (next === undefined) throw new Error("--root requires a directory argument");
      options.root = resolve(next);
      index++;
    } else if (argument.startsWith("--root=")) {
      options.root = resolve(argument.slice("--root=".length));
    } else if (argument === "--help" || argument === "-h") {
      console.log(
        "Usage: bun run scripts/validate-docs.ts [--root <repo>] [--json] [--all]\n" +
          "Verifies documented commands, flags, MCP tools and counts against the code and filesystem."
      );
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${argument}`);
    }
  }
  return options;
}

// ─── findings ───────────────────────────────────────────────────────────

interface DocError {
  message: string;
  file: string;
  line: number;
}

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

function skillNamesFromDisk(root: string): string[] {
  const dir = join(root, "skills", "mygrace");
  if (!isDirectory(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name.startsWith("grace-"))
    .map((entry) => skillNameFromDir(entry.name))
    .sort();
}

function walkMarkdown(dir: string, output: string[]): void {
  if (!isDirectory(dir)) return;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walkMarkdown(full, output);
    else if (entry.name.endsWith(".md") || entry.name.endsWith(".template")) output.push(full);
  }
}

interface DocSource {
  absolute: string;
  relative: string;
  content: string;
}

function collectSources(root: string, includeAll: boolean): DocSource[] {
  const files: string[] = [];
  for (const filename of ["README.md", "AGENTS.md"]) {
    const full = join(root, filename);
    if (existsSync(full)) files.push(full);
  }
  const skillsRoot = join(root, "skills", "mygrace");
  if (isDirectory(skillsRoot)) {
    for (const entry of readdirSync(skillsRoot, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const skillFile = join(skillsRoot, entry.name, "SKILL.md");
      if (existsSync(skillFile)) files.push(skillFile);
    }
  }
  if (includeAll) {
    walkMarkdown(join(root, "templates"), files);
    walkMarkdown(join(root, "extensions"), files);
    walkMarkdown(join(root, "rules"), files);
    walkMarkdown(join(root, "plugins"), files);
  }
  const sources: DocSource[] = [];
  for (const absolute of files) {
    const content = readText(absolute);
    if (content === undefined) continue;
    sources.push({ absolute, relative: relative(root, absolute), content });
  }
  return sources;
}

// ─── checks ─────────────────────────────────────────────────────────────

/** Numeric claims that must match reality ("15 skills", "Skills (15, ...)", "15 MCP tools"). */
function countClaims(content: string, pattern: RegExp): Array<{ value: number; line: number; text: string }> {
  const claims: Array<{ value: number; line: number; text: string }> = [];
  content.split("\n").forEach((line, index) => {
    const flags = pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`;
    const regex = new RegExp(pattern.source, flags);
    for (const match of line.matchAll(regex)) {
      const value = Number(match[1]);
      if (Number.isFinite(value)) claims.push({ value, line: index + 1, text: match[0].trim() });
    }
  });
  return claims;
}

const STALE_CLAIM_PATTERNS: Array<{ pattern: RegExp; hint: string }> = [
  { pattern: /\b14 skills\b/i, hint: "the repository ships 15 skills; update the claim" },
  { pattern: /96[-–]97%/, hint: "superseded by the honest line+proxy metric (see scripts/measure-context.ts)" },
  { pattern: /\b7 MCP tools?\b/i, hint: "the MCP catalogue exposes the full tool set; count again from code" },
];

/** Package names that look like `mygrace-*` but are not skills. */
const NON_SKILL_MYGRACE_NAMES = new Set(["mygrace-status-panel", "mygrace-dsh"]);

/** The docs mention the DSH-prefixed form (`mcp__mygrace__lint`) — map it to the tool name. */
function normaliseToolName(raw: string): string {
  return raw.startsWith("mcp__mygrace__") ? `mygrace_${raw.slice("mcp__mygrace__".length)}` : raw;
}

function tableSkillNames(content: string): string[] {
  const names: string[] = [];
  for (const line of content.split("\n")) {
    const match = line.match(/^\|\s*`(mygrace-[a-z0-9-]+)`\s*\|/);
    if (match !== null) names.push(match[1]!);
  }
  return names;
}

function validateDocumentation(options: Options): DocError[] {
  const errors: DocError[] = [];
  const tree = loadCommandTree();
  const toolNames = new Set<string>(TOOL_NAMES);
  const diskSkills = skillNamesFromDisk(options.root);
  const diskSkillSet = new Set(diskSkills);
  const sources = collectSources(options.root, options.all);

  if (diskSkills.length === 0) {
    errors.push({ message: "No skills found under skills/mygrace (cannot validate skill claims)", file: "skills/mygrace", line: 1 });
  }

  for (const source of sources) {
    const { file, line } = { file: source.relative, line: 1 };

    // 1. Documented CLI commands and flags.
    for (const ref of extractCommandRefs(source.content, source.relative)) {
      const command = resolveCommand(tree, ref.commandPath);
      if (command === undefined) {
        errors.push({
          message: `Unknown CLI command "mygrace ${ref.commandPath.join(" ")}"`,
          file: source.relative,
          line: ref.line,
        });
        continue;
      }
      for (const flag of ref.flags) {
        if (!commandAcceptsFlag(command, flag)) {
          errors.push({
            message: `Unknown flag "--${flag}" for "mygrace ${command.path.join(" ")}"`,
            file: source.relative,
            line: ref.line,
          });
        }
      }
    }

    // 2. Documented MCP tool names (including the mcp__mygrace__<tool> form).
    for (const match of source.content.matchAll(/(?:mcp__mygrace__[a-z][a-z0-9_]*|mygrace_[a-z][a-z0-9_]*)/g)) {
      const raw = match[0];
      const name = normaliseToolName(raw);
      if (!toolNames.has(name)) {
        const lineOfMatch = source.content.slice(0, match.index).split("\n").length;
        errors.push({ message: `Unknown MCP tool "${raw}"`, file: source.relative, line: lineOfMatch });
      }
    }

    // 3. Skill names in documented tables must exist on disk.
    for (const name of tableSkillNames(source.content)) {
      if (!diskSkillSet.has(name) && !NON_SKILL_MYGRACE_NAMES.has(name)) {
        errors.push({ message: `Documents unknown skill "${name}"`, file: source.relative, line: 1 });
      }
    }

    // 4. Numeric claims must match the code/filesystem.
    for (const claim of [
      ...countClaims(source.content, /Skills \((\d+)/i),
      ...countClaims(source.content, /(\d+)\s+skills\b/i),
    ]) {
      if (claim.value !== diskSkills.length) {
        errors.push({
          message: `Claims ${claim.value} skills ("${claim.text}") but filesystem has ${diskSkills.length}`,
          file: source.relative,
          line: claim.line,
        });
      }
    }
    for (const claim of countClaims(source.content, /(\d+)\s+MCP tools?\b/i)) {
      if (claim.value !== TOOL_NAMES.length) {
        errors.push({
          message: `Claims ${claim.value} MCP tools ("${claim.text}") but catalogue has ${TOOL_NAMES.length}`,
          file: source.relative,
          line: claim.line,
        });
      }
    }

    // 5. Known-stale marketing claims are hard failures.
    source.content.split("\n").forEach((text, index) => {
      for (const stale of STALE_CLAIM_PATTERNS) {
        if (stale.pattern.test(text)) {
          errors.push({
            message: `Stale documented claim "${text.trim()}": ${stale.hint}`,
            file: source.relative,
            line: index + 1,
          });
        }
      }
    });
  }

  // 6. README CLI Commands table must document every top-level command in the
  //    imported citty tree (15 commands as of Wave 1: includes `trust`).
  const readmeCommands = readText(join(options.root, "README.md"));
  if (readmeCommands !== undefined) {
    const documentedRoots = new Set<string>();
    for (const line of readmeCommands.split("\n")) {
      const match = line.match(/^\|\s*`mygrace\s+([a-z][a-z0-9-]*)/);
      if (match !== null) documentedRoots.add(match[1]!);
    }
    const codeRoots = [...tree.roots.keys()].sort();
    for (const command of codeRoots) {
      if (!documentedRoots.has(command)) {
        errors.push({
          message:
            `README CLI Commands table does not document top-level command "mygrace ${command}" — ` +
            "add the row or remove the command; the validator derives this list from src/grace.ts",
          file: "README.md",
          line: 1,
        });
      }
    }
    for (const command of documentedRoots) {
      if (!tree.roots.has(command)) {
        errors.push({
          message: `README CLI Commands table documents unknown command "mygrace ${command}"`,
          file: "README.md",
          line: 1,
        });
      }
    }
  }

  // 7. README skill table must list every skill shipped on disk.
  const readmePath = join(options.root, "README.md");
  const readme = readText(readmePath);
  if (readme !== undefined) {
    const documented = new Set(tableSkillNames(readme));
    for (const skill of diskSkills) {
      if (!documented.has(skill)) {
        errors.push({ message: `README skill table is missing "${skill}"`, file: "README.md", line: 1 });
      }
    }
  }

  return errors;
}

// ─── report ─────────────────────────────────────────────────────────────

function main(): void {
  const options = parseOptions(process.argv.slice(2));
  const errors = validateDocumentation(options);

  if (options.json) {
    console.log(JSON.stringify({ ok: errors.length === 0, errors }, null, 2));
  } else if (errors.length === 0) {
    console.log(`✓ Docs are true: every documented command/flag/MCP tool/count matches the code (${TOOL_NAMES.length} tools).`);
  } else {
    console.log(`✗ Documentation truth check failed: ${errors.length} problem(s).`);
    for (const error of errors) console.log(`  ✗ [${error.file}:${error.line}] ${error.message}`);
    console.log("");
    console.log("Docs may not outrun the implementation (ROADMAP G8). Fix the docs or the code, never the validator.");
  }
  process.exit(errors.length === 0 ? 0 : 1);
}

try {
  main();
} catch (error) {
  console.error(`validate-docs: internal error: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(3);
}
