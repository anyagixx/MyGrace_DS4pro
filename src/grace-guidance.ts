#!/usr/bin/env bun
/**
 * MyGRACE — guidance packs (`mygrace context guidance`, ADR-12).
 *
 * A guidance pack is an optional, project-local or external source of domain
 * best practices. MyGRACE only *retrieves* text: it never executes pack
 * content, never writes it into docs/ and never treats it as trusted input.
 *
 * Two provider kinds ship in v3.1.0:
 *   - `local`: a directory with `guidance-pack.json` + markdown guides;
 *   - `cli`: a command prefix implementing the Modern Web Guidance protocol
 *     (`<cmd> search "<query>" --json`, `<cmd> retrieve <id>`).
 *
 * CLI packs run only when project commands are trusted (same ADR-1 gate as
 * verification/lint providers) and every invocation is audited.
 */

// START_MODULE_CONTRACT
//   PURPOSE: Search/retrieve guidance from configured packs with trust-gated CLI execution and path-safe local reads.
//   SCOPE: reads local pack manifests/guides; optionally runs configured CLI packs; no writes, no network logic of its own.
//   DEPENDS: grace-config, grace-common, grace-errors, grace-test (authorization/audit/tokenizer)
//   LINKS: docs/guidance-packs.md, docs/adr/ADR-12-guidance-packs.md
// END_MODULE_CONTRACT

// START_MODULE_MAP
//   GuidancePackStatus   — resolved pack (kind, availability, version, skipped reason)
//   GuidanceHit          — one search result (pack, id, title, description)
//   GuidancePackManifest — local `guidance-pack.json` shape
//   loadGuidancePacks()  — resolve local manifests and CLI availability/trust
//   searchGuidance()     — search across enabled packs
//   retrieveGuidance()   — retrieve one guide (local file read or CLI stdout)
//   guidanceCommand      — `mygrace context guidance <query> [--id]`
// END_MODULE_MAP

// START_CHANGE_SUMMARY
//   v3.1.0 — introduced ADR-12 guidance-pack SPI and the `context guidance` command.
// END_CHANGE_SUMMARY

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { isAbsolute, join, resolve, sep } from "node:path";
import { defineCommand } from "citty";
import { tryFindProjectRoot } from "./grace-common";
import { tryLoadConfig } from "./grace-config";
import type { GuidancePackSettings, MyGraceConfig } from "./grace-config";
import { createEnvelope, finding, UsageError } from "./grace-errors";
import type { Finding } from "./grace-errors";
import {
  appendAuditRecord,
  authorizeCommands,
  inspectUnsafeCommand,
  parseOutputFormat,
  runCommandOutcome,
  tokenizeCommand,
  trustRefusalHint,
} from "./grace-test";
import { integrationChildEnv } from "./grace-integrations";
import type { CommandOutcome } from "./grace-test";

export interface GuidancePackManifest {
  name: string;
  version: string;
  license: string;
  description?: string;
  guides: { id: string; title: string; description: string; file: string; tags?: string[] }[];
}

export interface GuidancePackStatus {
  name: string;
  kind: GuidancePackSettings["kind"];
  enabled: boolean;
  available: boolean;
  version: string | null;
  license: string | null;
  guides: number;
  skippedReason: string | null;
  hint: string | null;
}

export interface GuidanceHit {
  pack: string;
  id: string;
  title: string;
  description: string;
}

export interface GuidanceSearchData {
  query: string;
  packs: GuidancePackStatus[];
  results: GuidanceHit[];
  skipped: { pack: string; reason: string }[];
}

export interface GuidanceRetrieveData {
  pack: string;
  id: string;
  title: string;
  content: string;
  source: "local" | "cli";
}

function parseLocalManifest(packPath: string): GuidancePackManifest | null {
  const manifestPath = join(packPath, "guidance-pack.json");
  if (!existsSync(manifestPath)) return null;
  try {
    const parsed: unknown = JSON.parse(readFileSync(manifestPath, "utf-8"));
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const raw = parsed as Record<string, unknown>;
    if (typeof raw.name !== "string" || raw.name.trim() === "") return null;
    if (typeof raw.version !== "string" || raw.version.trim() === "") return null;
    if (!Array.isArray(raw.guides)) return null;
    const guides: GuidancePackManifest["guides"] = [];
    for (const item of raw.guides) {
      if (item === null || typeof item !== "object" || Array.isArray(item)) continue;
      const guide = item as Record<string, unknown>;
      if (typeof guide.id !== "string" || typeof guide.title !== "string" || typeof guide.file !== "string") continue;
      guides.push({
        id: guide.id,
        title: guide.title,
        description: typeof guide.description === "string" ? guide.description : "",
        file: guide.file,
        ...(Array.isArray(guide.tags) ? { tags: guide.tags.filter((tag): tag is string => typeof tag === "string") } : {}),
      });
    }
    return {
      name: raw.name.trim(),
      version: raw.version.trim(),
      license: typeof raw.license === "string" ? raw.license : "unknown",
      ...(typeof raw.description === "string" ? { description: raw.description } : {}),
      guides,
    };
  } catch {
    return null;
  }
}

function packDir(root: string, settings: GuidancePackSettings): string | null {
  if (settings.path === null) return null;
  const candidate = isAbsolute(settings.path) ? resolve(settings.path) : resolve(root, settings.path);
  const prefix = root.endsWith(sep) ? root : `${root}${sep}`;
  if (!candidate.startsWith(prefix) && candidate !== root) return null;
  return existsSync(candidate) && statSync(candidate).isDirectory() ? candidate : null;
}

function cliCommandTokens(settings: GuidancePackSettings): string[] | null {
  if (settings.command === null) return null;
  try {
    return tokenizeCommand(settings.command);
  } catch {
    return null;
  }
}

function resolvePacks(
  root: string,
  config: MyGraceConfig,
  options: { allowCommands: boolean; allowUnsafeCommands: boolean }
): { statuses: GuidancePackStatus[]; manifests: Map<string, GuidancePackManifest>; commandTokens: Map<string, string[]>; authorization: ReturnType<typeof authorizeCommands> } {
  const authorization = authorizeCommands(root, config, options.allowCommands);
  const statuses: GuidancePackStatus[] = [];
  const manifests = new Map<string, GuidancePackManifest>();
  const commandTokens = new Map<string, string[]>();

  for (const settings of config.guidancePacks) {
    const enabled = settings.enabled !== false;
    const base: GuidancePackStatus = {
      name: settings.name,
      kind: settings.kind,
      enabled,
      available: false,
      version: null,
      license: null,
      guides: 0,
      skippedReason: null,
      hint: null,
    };
    if (!enabled) {
      statuses.push({ ...base, skippedReason: "disabled" });
      continue;
    }
    if (settings.kind === "local") {
      const dir = packDir(root, settings);
      if (dir === null) {
        statuses.push({ ...base, skippedReason: "missing-path", hint: `Local pack path "${settings.path ?? ""}" is not a directory inside the project.` });
        continue;
      }
      const manifest = parseLocalManifest(dir);
      if (manifest === null) {
        statuses.push({ ...base, skippedReason: "invalid-manifest", hint: "Add a valid guidance-pack.json with name/version/guides." });
        continue;
      }
      manifests.set(settings.name, manifest);
      statuses.push({ ...base, available: true, version: manifest.version, license: manifest.license, guides: manifest.guides.length });
      continue;
    }
    const tokens = cliCommandTokens(settings);
    if (tokens === null || tokens.length === 0) {
      statuses.push({ ...base, skippedReason: "invalid-command", hint: "CLI packs need a non-empty command prefix." });
      continue;
    }
    commandTokens.set(settings.name, tokens);
    if (!authorization.authorized) {
      statuses.push({
        ...base,
        skippedReason: "untrusted",
        hint: `Review commands and run \`mygrace trust\`, or pass --allow-commands. ${trustRefusalHint(root, authorization)}`,
      });
      continue;
    }
    statuses.push({ ...base, available: true, hint: "CLI pack; version is reported by the pack CLI on retrieval." });
  }
  return { statuses, manifests, commandTokens, authorization };
}

function scoreHit(manifest: GuidancePackManifest["guides"][number], terms: string[]): number {
  const haystack = `${guideText(manifest)}`.toLowerCase();
  return terms.reduce((score, term) => (haystack.includes(term) ? score + 1 : score), 0);
}
function guideText(guide: GuidancePackManifest["guides"][number]): string {
  return `${guide.id} ${guide.title} ${guide.description} ${(guide.tags ?? []).join(" ")}`;
}

function runCliPack(
  root: string,
  settings: GuidancePackSettings,
  tokens: string[],
  args: string[],
  options: { allowUnsafeCommands: boolean }
): { ok: true; stdout: string } | { ok: false; error: string; denied?: boolean } {
  const full = [...tokens, ...args];
  const unsafe = inspectUnsafeCommand(full.join(" "));
  if (unsafe !== null && !options.allowUnsafeCommands) {
    return { ok: false, error: `denied by dangerous-command policy (${unsafe.label})` };
  }
  appendAuditRecord(root, { action: "guidance-cli", pack: settings.name, argv: full });
  const result = spawnSync(full[0] as string, full.slice(1), {
    cwd: root,
    encoding: "utf8",
    timeout: settings.timeoutMs,
    shell: false,
    env: { ...integrationChildEnv({ NO_COLOR: "1", CI: "1", npm_config_yes: "true" }) },
  });
  if (result.error !== undefined) return { ok: false, error: result.error.message };
  if ((result.status ?? -1) !== 0) {
    const stderr = (result.stderr ?? "").trim();
    return { ok: false, error: stderr === "" ? `exit ${result.status ?? "unknown"}` : stderr.slice(0, 500) };
  }
  return { ok: true, stdout: result.stdout ?? "" };
}

export function searchGuidance(
  root: string,
  config: MyGraceConfig,
  query: string,
  options: { allowCommands: boolean; allowUnsafeCommands: boolean; pack?: string }
): GuidanceSearchData {
  const trimmed = query.trim();
  if (trimmed === "") throw new UsageError("context guidance needs a search query.", { hint: "Example: mygrace context guidance \"accessible dialog\"." });
  const resolved = resolvePacks(root, config, options);
  const terms = trimmed.toLowerCase().split(/\s+/).filter(Boolean);
  const results: GuidanceHit[] = [];
  const skipped: { pack: string; reason: string }[] = [];

  for (const status of resolved.statuses) {
    if (options.pack !== undefined && status.name !== options.pack) continue;
    if (!status.enabled) continue;
    if (!status.available) {
      skipped.push({ pack: status.name, reason: status.skippedReason ?? "unavailable" });
      continue;
    }
    if (status.kind === "local") {
      const manifest = resolved.manifests.get(status.name);
      if (manifest === undefined) continue;
      for (const guide of manifest.guides) {
        if (scoreHit(guide, terms) > 0) {
          results.push({ pack: status.name, id: guide.id, title: guide.title, description: guide.description });
        }
      }
      continue;
    }
    const settings = config.guidancePacks.find((pack) => pack.name === status.name)!;
    const tokens = resolved.commandTokens.get(status.name);
    if (tokens === undefined) {
      skipped.push({ pack: status.name, reason: "invalid-command" });
      continue;
    }
    const run = runCliPack(root, settings, tokens, ["search", trimmed, "--json"], options);
    if (!run.ok) {
      skipped.push({ pack: status.name, reason: `cli: ${run.error}` });
      continue;
    }
    try {
      const parsed: unknown = JSON.parse(run.stdout);
      if (!Array.isArray(parsed)) throw new Error("search output is not a JSON array");
      for (const item of parsed) {
        if (item === null || typeof item !== "object" || Array.isArray(item)) continue;
        const raw = item as Record<string, unknown>;
        if (typeof raw.id !== "string") continue;
        results.push({
          pack: status.name,
          id: raw.id,
          title: raw.id,
          description: typeof raw.description === "string" ? raw.description : "",
        });
      }
    } catch (error) {
      skipped.push({ pack: status.name, reason: `cli: ${error instanceof Error ? error.message : String(error)}` });
    }
  }
  return {
    query: trimmed,
    packs: resolved.statuses.filter((status) => options.pack === undefined || status.name === options.pack),
    results,
    skipped,
  };
}

export function retrieveGuidance(
  root: string,
  config: MyGraceConfig,
  packName: string,
  id: string,
  options: { allowCommands: boolean; allowUnsafeCommands: boolean }
): GuidanceRetrieveData {
  const resolved = resolvePacks(root, config, options);
  const status = resolved.statuses.find((entry) => entry.name === packName);
  if (status === undefined) throw new UsageError(`Unknown guidance pack "${packName}".`, { hint: `Configured packs: ${resolved.statuses.map((entry) => entry.name).join(", ") || "(none)"}.` });
  if (!status.enabled) throw new UsageError(`Guidance pack "${packName}" is disabled.`);
  if (!status.available) throw new UsageError(`Guidance pack "${packName}" is not available: ${status.skippedReason ?? "unknown"}.`);
  if (status.kind === "local") {
    const manifest = resolved.manifests.get(packName);
    if (manifest === undefined) throw new UsageError(`Guidance pack "${packName}" has no valid manifest.`);
    const guide = manifest.guides.find((entry) => entry.id === id);
    if (guide === undefined) throw new UsageError(`Unknown guide "${id}" in pack "${packName}".`);
    const dir = packDir(root, config.guidancePacks.find((pack) => pack.name === packName)!);
    if (dir === null) throw new UsageError(`Guidance pack "${packName}" path is invalid.`);
    const filePath = resolve(dir, guide.file);
    const prefix = dir.endsWith(sep) ? dir : `${dir}${sep}`;
    if (!filePath.startsWith(prefix)) throw new UsageError(`Guide "${id}" points outside its pack directory.`);
    if (!existsSync(filePath)) throw new UsageError(`Guide file is missing: ${guide.file}`);
    return { pack: packName, id, title: guide.title, content: readFileSync(filePath, "utf-8"), source: "local" };
  }
  const settings = config.guidancePacks.find((pack) => pack.name === packName)!;
  const tokens = resolved.commandTokens.get(packName);
  if (tokens === undefined) throw new UsageError(`Guidance pack "${packName}" has no valid command.`);
  if (!resolved.authorization.authorized) throw new UsageError(`Guidance pack "${packName}" needs trusted project commands.`, { hint: trustRefusalHint(root, resolved.authorization) });
  const run = runCliPack(root, settings, tokens, ["retrieve", id], options);
  if (!run.ok) throw new UsageError(`Guidance retrieval failed: ${run.error}`);
  return { pack: packName, id, title: id, content: run.stdout, source: "cli" };
}

const guidanceCommand = defineCommand({
  meta: {
    name: "guidance",
    description: "Search/retrieve domain guidance from configured packs (local markdown or trust-gated CLI)",
  },
  args: {
    query: { type: "positional", required: true, description: "Search query (use --id to retrieve a specific guide)" },
    path: { type: "string", default: ".", description: "Project root" },
    format: { type: "string", default: "text", description: "Output format: text or json" },
    id: { type: "string", description: "Retrieve this guide id from --pack (or the matching pack)" },
    pack: { type: "string", description: "Limit search to one configured pack name" },
    allowCommands: { type: "boolean", default: false, description: "Allow trust-gated CLI packs for this run" },
    allowUnsafeCommands: { type: "boolean", default: false, description: "One-off opt-in for deny-listed pack commands" },
  },
  run: async ({ args }) => {
    const format = parseOutputFormat(args.format);
    await runCommandOutcome<GuidanceSearchData | GuidanceRetrieveData>(format, { command: "context guidance" }, (): CommandOutcome<GuidanceSearchData | GuidanceRetrieveData> => {
      const input = typeof args.path === "string" ? args.path : ".";
      const root = tryFindProjectRoot(input) ?? resolve(input);
      const loaded = tryLoadConfig(root);
      if (!loaded.ok) throw loaded.error;
      const config = loaded.result.config;
      const id = typeof args.id === "string" && args.id.trim() !== "" ? args.id.trim() : null;
      const pack = typeof args.pack === "string" && args.pack.trim() !== "" ? args.pack.trim() : undefined;
      const options = { allowCommands: args.allowCommands === true, allowUnsafeCommands: args.allowUnsafeCommands === true, ...(pack === undefined ? {} : { pack }) };
      if (id !== null) {
        const data = retrieveGuidance(root, config, pack ?? config.guidancePacks[0]?.name ?? "", id, options);
        const findings: Finding[] = [];
        const envelope = createEnvelope({ data, findings, meta: { command: "context guidance", root } });
        return {
          envelope,
          print: () => {
            console.log(`Guidance: ${data.pack}/${data.id}`);
            console.log("=".repeat(24));
            console.log(data.content.trimEnd());
          },
        };
      }
      const data = searchGuidance(root, config, args.query, options);
      const findings: Finding[] = data.skipped.map((entry) =>
        finding("info", "GUIDANCE_PACK_SKIPPED", `Guidance pack "${entry.pack}" was skipped: ${entry.reason}.`)
      );
      const envelope = createEnvelope({ data, findings, meta: { command: "context guidance", root } });
      return {
        envelope,
        print: () => {
          console.log(`Guidance search: ${data.query}`);
          console.log("=".repeat(24));
          if (data.results.length === 0) console.log("No matches in configured packs.");
          for (const hit of data.results) console.log(`- [${hit.pack}] ${hit.id}: ${hit.title}${hit.description === "" ? "" : ` — ${hit.description}`}`);
          if (data.skipped.length > 0) {
            console.log("");
            for (const skipped of data.skipped) console.log(`ⓘ [${skipped.pack}] skipped: ${skipped.reason}`);
          }
          if (data.results.length > 0) console.log(`\nRetrieve: mygrace context guidance "<query>" --id <id> --pack ${data.results[0]!.pack}`);
        },
      };
    });
  },
});

export { guidanceCommand };
