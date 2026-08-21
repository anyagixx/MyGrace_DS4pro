#!/usr/bin/env bun
/**
 * MyGRACE DeepSeek Harness Installer
 *
 * `mygrace install-dsh` wires MyGRACE into a DeepSeek Harness installation:
 *   1. Copies the canonical skills (skills/mygrace/grace-*) into
 *      $DSH_HOME/skills/mygrace-* — the user-level skill root the harness
 *      discovers automatically (dsh-skill-filesystem, user-dsh rank 400).
 *   2. Adds an idempotent MCP row to the web profile's cordis.patch.yml
 *      so the harness spawns src/grace-mcp.ts as a stdio MCP server.
 *
 * Both steps are idempotent: re-running never duplicates entries. The
 * profile patch file is backed up before the first modification.
 */

import { defineCommand } from "citty";
import {
  existsSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  cpSync,
  rmSync,
  readdirSync,
  copyFileSync,
} from "node:fs";
import { join, dirname, basename } from "node:path";
import { homedir } from "node:os";

// ─── Paths ──────────────────────────────────────────────────────────────

function dshHome(): string {
  return process.env.DSH_HOME || join(homedir(), ".dsh");
}

/** Canonical skill sources shipped with this package (grace-* dirs). */
function skillsSourceDir(): string {
  return join(dirname(import.meta.dir), "skills", "mygrace");
}

export function skillSourceDirs(): { source: string; name: string }[] {
  if (!existsSync(skillsSourceDir())) return [];
  return readdirSync(skillsSourceDir(), { withFileTypes: true })
    .filter((d) => d.isDirectory() && d.name.startsWith("grace-"))
    .map((d) => ({
      source: join(skillsSourceDir(), d.name),
      name: d.name.replace(/^grace-/, "mygrace-"),
    }));
}

function profilePatchPath(profile: string): string {
  return join(dshHome(), "profiles", profile, "cordis.patch.yml");
}

/** YAML single-quote escaping for arbitrary filesystem paths. */
function yamlSingle(s: string): string {
  return `'${s.replace(/'/g, "''")}'`;
}

/**
 * The cordis patch layer (cordis.patch.yml) applies id-targeted overrides to
 * the composed bundle tree. NEW entries must be added via an `insert:` list —
 * a bare `- id: <new-id>` is rejected by the loader ("entry not found").
 * Without a target id, `insert:` appends to the root entry list.
 */
export function mcpPatchEntry(): string {
  const bunBinary = process.execPath;
  const mcpScript = join(import.meta.dir, "grace-mcp.ts");
  return [
    "- insert:",
    "    - id: mcp-mygrace",
    "      name: '@deepseek-ai/dsh-mcp-client'",
    "      config:",
    "        transport: stdio",
    "        serverName: mygrace",
    `        command: ${yamlSingle(bunBinary)}`,
    "        args:",
    "          - run",
    `          - ${yamlSingle(mcpScript)}`,
  ].join("\n");
}

// ─── Patch file editing ─────────────────────────────────────────────────

const ENTRY_ID = "mcp-mygrace";

export function patchFileHasEntry(content: string): boolean {
  return content.includes(`id: ${ENTRY_ID}`);
}

/**
 * Add the MyGRACE MCP row to a cordis.patch.yml loader array.
 * Returns the new content, or null when the entry is already present.
 */
export function addPatchEntry(content: string): string | null {
  if (patchFileHasEntry(content)) return null;

  // Empty array literal on its own line: replace that line with the entry.
  const lines = content.split("\n");
  const emptyIdx = lines.findIndex((l) => l.trim() === "[]");
  if (emptyIdx !== -1) {
    lines[emptyIdx] = mcpPatchEntry();
    return lines.join("\n");
  }

  // Non-empty array: append a top-level entry (entries sit at column 0).
  const body = content.endsWith("\n") ? content : content + "\n";
  return body + "\n" + mcpPatchEntry() + "\n";
}

/**
 * Remove the MyGRACE MCP row from a cordis.patch.yml loader array.
 * Handles both the canonical insert-wrapped form (`- insert:` block whose
 * first child is the mygrace entry) and the legacy bare `- id:` form.
 * Returns the new content, or null when the entry was not present.
 */
export function removePatchEntry(content: string): string | null {
  if (!patchFileHasEntry(content)) return null;

  const lines = content.split("\n");
  const out: string[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];

    // Canonical: `- insert:` block starting with our entry.
    if (line.trim() === "- insert:" && lines[i + 1]?.trim() === `- id: ${ENTRY_ID}`) {
      i++; // the "- insert:" line
      // Skip the indented children of the insert block.
      while (i < lines.length && (lines[i].trim() === "" || /^\s/.test(lines[i]))) i++;
      continue;
    }

    // Legacy (pre-0.1.0 format): bare top-level entry.
    if (line.trim() === `- id: ${ENTRY_ID}`) {
      i++;
      while (i < lines.length && /^\s/.test(lines[i]) && lines[i].trim() !== "") i++;
      continue;
    }

    out.push(line);
    i++;
  }
  // If no loader entries remain, keep the file a valid (empty) YAML array.
  if (!out.some((l) => /^- /.test(l))) out.push("[]");
  return out.join("\n");
}

// ─── Install / uninstall ────────────────────────────────────────────────

function installSkills(targetRoot: string, dryRun: boolean): string[] {
  const actions: string[] = [];
  const sources = skillSourceDirs();
  if (sources.length === 0) {
    actions.push(`WARNING: no skills found in ${skillsSourceDir()} — package may be incomplete`);
    return actions;
  }
  if (!dryRun) mkdirSync(targetRoot, { recursive: true });
  for (const { source, name } of sources) {
    const dest = join(targetRoot, name);
    if (dryRun) {
      actions.push(`would copy ${basename(source)} → ${dest}`);
    } else {
      cpSync(source, dest, { recursive: true });
      actions.push(`installed ${name}`);
    }
  }
  return actions;
}

function installMcp(profile: string, dryRun: boolean): string[] {
  const actions: string[] = [];
  const patchPath = profilePatchPath(profile);

  if (!existsSync(patchPath)) {
    actions.push(
      `WARNING: ${patchPath} not found — boot the profile once (dsh web) so it is created, then re-run install-dsh`
    );
    return actions;
  }

  const content = readFileSync(patchPath, "utf-8");
  if (patchFileHasEntry(content)) {
    actions.push(`MCP row already present in ${patchPath} — skipping`);
    return actions;
  }

  const next = addPatchEntry(content);
  if (next === null) {
    actions.push(`MCP row already present in ${patchPath} — skipping`);
    return actions;
  }

  if (dryRun) {
    actions.push(`would patch ${patchPath} with the mcp-mygrace MCP row`);
    return actions;
  }

  copyFileSync(patchPath, `${patchPath}.mygrace-backup`);
  writeFileSync(patchPath, next);
  actions.push(`patched ${patchPath} (backup: ${basename(patchPath)}.mygrace-backup)`);
  return actions;
}

function uninstallSkills(targetRoot: string, dryRun: boolean): string[] {
  const actions: string[] = [];
  for (const { name } of skillSourceDirs()) {
    const dest = join(targetRoot, name);
    if (!existsSync(dest)) continue;
    if (dryRun) actions.push(`would remove ${dest}`);
    else {
      rmSync(dest, { recursive: true, force: true });
      actions.push(`removed ${dest}`);
    }
  }
  return actions;
}

function uninstallMcp(profile: string, dryRun: boolean): string[] {
  const actions: string[] = [];
  const patchPath = profilePatchPath(profile);
  if (!existsSync(patchPath)) {
    actions.push(`No profile patch file at ${patchPath} — nothing to remove`);
    return actions;
  }
  const content = readFileSync(patchPath, "utf-8");
  const next = removePatchEntry(content);
  if (next === null) {
    actions.push(`MCP row not present in ${patchPath} — nothing to remove`);
    return actions;
  }
  if (dryRun) {
    actions.push(`would remove the mcp-mygrace row from ${patchPath}`);
    return actions;
  }
  copyFileSync(patchPath, `${patchPath}.mygrace-backup`);
  writeFileSync(patchPath, next);
  actions.push(`removed mcp-mygrace row from ${patchPath}`);
  return actions;
}

// ─── Command ────────────────────────────────────────────────────────────

export const installDshCommand = defineCommand({
  meta: {
    name: "install-dsh",
    description: "Install MyGRACE into DeepSeek Harness: skills to $DSH_HOME/skills and an MCP row in the profile's cordis.patch.yml",
  },
  args: {
    profile: { type: "string", default: "web", description: "DSH profile to patch (default: web)" },
    dryRun: { type: "boolean", default: false, description: "Print planned actions without writing anything" },
    uninstall: { type: "boolean", default: false, description: "Remove skills and the MCP row instead of installing" },
    dshHome: { type: "string", description: "Override the DSH home (default: $DSH_HOME or ~/.dsh)" },
  },
  run: async ({ args }) => {
    const home = args.dshHome || dshHome();
    const skillsRoot = join(home, "skills");
    const uninstall = args.uninstall === true;

    console.log(`MyGRACE ${uninstall ? "uninstall" : "install"} for DeepSeek Harness`);
    console.log(`DSH home:   ${home}`);
    console.log(`Profile:    ${args.profile}`);
    console.log(`Skills dir: ${skillsRoot}`);
    console.log(`${args.dryRun ? "DRY RUN — no changes will be written" : ""}`);
    console.log();

    const actions = uninstall
      ? [...uninstallSkills(skillsRoot, args.dryRun === true), ...uninstallMcp(args.profile, args.dryRun === true)]
      : [...installSkills(skillsRoot, args.dryRun === true), ...installMcp(args.profile, args.dryRun === true)];

    for (const a of actions) console.log(`• ${a}`);
    console.log();

    if (args.dryRun) return;

    console.log("Done. To activate:");
    console.log("  1. Restart the harness (dsh web) so the MCP row loads.");
    console.log("  2. New skills appear in the skill catalog automatically (watched).");
    console.log("  3. Verify with: mygrace lint (CLI) or the mygrace_* tools in the session.");
    console.log("  4. In a project: ensure AGENTS.md exists so the agent follows MyGRACE automatically.");
  },
});
