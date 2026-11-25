#!/usr/bin/env bun
/**
 * MyGRACE — Octocode adapter contract smoke test (release gate G14, ADR-9).
 *
 * Runs the real `src/grace-code-graph.ts` adapter against a real Octocode
 * binary on `examples/demo-store` and on this repository, proving that:
 *   - graph mode works with no semantic index and no LLM calls; Octocode does
 *     initialize local FastEmbed embeddings first, so the model cache must be warm;
 *   - module files resolve to real import edges and per-file symbols;
 *   - the adapter degrades honestly when the tool is absent (skip mode).
 *
 * Prerequisite: a warm Octocode FastEmbed cache (`~/.cache/octolib`). The first
 * start downloads model files (default Jina code model ~612 MB; smaller FastEmbed
 * models are supported and much faster to warm, see README). Without `--download` the script
 * uses `MYGRACE_OCTOCODE_BIN` → PATH and exits 0 with a skip message when the
 * tool is not installed (so `bun test` and local runs stay dependency-free).
 *
 * Usage:
 *   bun run scripts/integration-octocode-smoke.ts            # skip if absent
 *   bun run scripts/integration-octocode-smoke.ts --download # fetch pinned 0.29.2
 *   bun run scripts/integration-octocode-smoke.ts --json
 */

import { chmodSync, existsSync, mkdirSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { collectFileSymbols, collectImportEdges } from "../src/grace-code-graph";
import { loadConfig } from "../src/grace-config";
import type { MyGraceConfig } from "../src/grace-config";
import { findExecutableOnPath, resolveIntegration } from "../src/grace-integrations";
import { loadGraphIndexStrict } from "../src/grace-shard";

const PINNED_VERSION = "0.29.2";
const TOOLS_DIR = resolve(import.meta.dir, "..", ".integration-tools");
const ASSET_NAME = `octocode-${PINNED_VERSION}-x86_64-unknown-linux-musl.tar.gz`;
const ASSET_URL = `https://github.com/Muvon/octocode/releases/download/${PINNED_VERSION}/${ASSET_NAME}`;
const ROOT = resolve(import.meta.dir, "..");
const DEMO = join(ROOT, "examples", "demo-store");

interface ProjectProbe {
  project: string;
  files: number;
  edges: number;
  symbols: number;
  notes: string[];
  ok: boolean;
}

function fail(message: string): never {
  console.error(`✗ ${message}`);
  process.exit(1);
}

function walkForBinary(dir: string): string | null {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return null;
  }
  for (const entry of entries) {
    const absolute = join(dir, entry);
    if (entry === "octocode") {
      try {
        if (!readdirSync(absolute).length) return absolute; // file, not dir
      } catch {
        return absolute;
      }
    }
    const nested = walkForBinary(absolute);
    if (nested !== null) return nested;
  }
  return null;
}

async function downloadPinnedBinary(): Promise<string> {
  if (process.platform !== "linux" || process.arch !== "x64") {
    fail(`--download supports linux x64 only (this host: ${process.platform}/${process.arch}); install Octocode manually and set MYGRACE_OCTOCODE_BIN.`);
  }
  mkdirSync(TOOLS_DIR, { recursive: true });
  const archive = join(TOOLS_DIR, ASSET_NAME);
  const existing = walkForBinary(TOOLS_DIR);
  if (existing !== null) return existing;
  console.error(`Downloading pinned Octocode ${PINNED_VERSION} …`);
  const response = await fetch(ASSET_URL, { redirect: "follow" });
  if (!response.ok) fail(`download failed: HTTP ${response.status} for ${ASSET_URL}`);
  await Bun.write(archive, response);
  const extract = Bun.spawnSync(["tar", "-xzf", archive, "-C", TOOLS_DIR]);
  if (extract.exitCode !== 0) fail(`tar failed: ${extract.stderr.toString()}`);
  const binary = walkForBinary(TOOLS_DIR);
  if (binary === null) fail("the release archive did not contain an `octocode` binary");
  chmodSync(binary, 0o755);
  return binary;
}

function moduleFiles(root: string, config: MyGraceConfig): string[] {
  try {
    const graph = loadGraphIndexStrict(root, config);
    const files = new Set<string>();
    for (const entry of graph.entries) {
      if (!/^M-[A-Za-z0-9][A-Za-z0-9_-]*$/.test(entry.tag)) continue;
      const path = (entry.attrs.PATH ?? "").trim();
      if (path !== "" && existsSync(join(root, path))) files.add(path);
    }
    return [...files].sort();
  } catch {
    return [];
  }
}

async function probeProject(label: string, root: string, bin: string): Promise<ProjectProbe> {
  const config = loadConfig(root).config;
  config.integrations.octocode = { ...config.integrations.octocode, bin, timeoutMs: 30_000 };
  const files = moduleFiles(root, config);
  const notes: string[] = [];
  if (files.length === 0) {
    notes.push("no indexed module source files found");
    return { project: label, files: 0, edges: 0, symbols: 0, notes, ok: false };
  }
  const [edges, symbols] = await Promise.all([
    collectImportEdges({ root, config, files }),
    collectFileSymbols({ root, config, files }),
  ]);
  notes.push(...edges.notes, ...symbols.notes);
  const symbolCount = Object.values(symbols.files).reduce((total, list) => total + list.length, 0);
  const ok = edges.available && symbols.available && edges.edges.length > 0 && symbolCount > 0 && notes.every((note) => !note.includes("INTEGRATION_"));
  return { project: label, files: files.length, edges: edges.edges.length, symbols: symbolCount, notes, ok };
}

const args = process.argv.slice(2);
const wantsJson = args.includes("--json");
const wantsDownload = args.includes("--download");

let bin: string | null = process.env.MYGRACE_OCTOCODE_BIN?.trim() || null;
if (bin === null) bin = findExecutableOnPath("octocode");
if (bin === null && wantsDownload) bin = await downloadPinnedBinary();
if (bin === null) {
  const message = "SKIP: Octocode is not installed; set MYGRACE_OCTOCODE_BIN or pass --download to run the contract smoke.";
  if (wantsJson) console.log(JSON.stringify({ ok: true, skipped: true, message }, null, 2));
  else console.log(`⏭ ${message}`);
  process.exit(0);
}

const versionConfig = loadConfig(ROOT).config;
versionConfig.integrations.octocode = { ...versionConfig.integrations.octocode, bin };
const version = resolveIntegration("octocode", versionConfig, ROOT, process.env);
if (!version.available || !version.supported) fail(version.hint ?? "Detected Octocode is outside the tested range.");

const probes: ProjectProbe[] = [];
probes.push(await probeProject("examples/demo-store", DEMO, bin));
probes.push(await probeProject("repository", ROOT, bin));

const failures = probes.filter((probe) => !probe.ok);
const ok = probes.some((probe) => probe.ok) && failures.length < probes.length;
if (wantsJson) {
  console.log(JSON.stringify({ ok, tool: { bin, version: version.version }, probes }, null, 2));
} else {
  console.log(`Octocode ${version.version} (${version.source}) — ${bin}`);
  for (const probe of probes) {
    console.log(`${probe.ok ? "✓" : "✗"} ${probe.project}: ${probe.files} files, ${probe.edges} import edges, ${probe.symbols} symbols`);
    for (const note of probe.notes.slice(0, 3)) console.log(`    - ${note}`);
  }
}
if (!ok) fail("the Octocode adapter did not produce code edges + symbols on any probe project.");
