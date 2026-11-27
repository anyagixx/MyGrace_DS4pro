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
//   DEPENDS: grace-config, grace-common, grace-errors, grace-test (authorization/audit/tokenizer), node:crypto
//   LINKS: docs/guidance-packs.md, docs/adr/ADR-12-guidance-packs.md
// END_MODULE_CONTRACT

// START_MODULE_MAP
//   GuidancePackStatus   — resolved pack (kind, availability, version, skipped reason)
//   GuidanceHit          — one search result (pack, id, title, description)
//   GuidancePackManifest — local `guidance-pack.json` shape
//   loadGuidancePacks()  — resolve local manifests and CLI availability/trust
//   searchGuidance()     — search across enabled packs
//   retrieveGuidance()   — retrieve one guide (local file read or CLI stdout)
//   guidanceLock helpers — `mygrace context guidance --lock/--check-lock/--sign/--keygen` (ADR-12)
//   guidanceCommand      — `mygrace context guidance <query> [--id] [--lock] [--check-lock]`
// END_MODULE_MAP

// START_CHANGE_SUMMARY
//   v3.1.0 — introduced ADR-12 guidance-pack SPI and the `context guidance` command.
//   v3.3.0 — guidance lockfile: local SHA-256 + CLI command hash/version, auto-verified.
//   v3.4.0 — lock attestation: CLI package digest (npx cache) + optional Ed25519 signature.
// END_CHANGE_SUMMARY

import { spawnSync } from "node:child_process";
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign as signBytes, verify as verifyBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { isAbsolute, join, resolve, sep } from "node:path";
import { defineCommand } from "citty";
import { tryFindProjectRoot } from "./grace-common";
import { findNpxCachedPackage } from "./grace-integrations";
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
  pinned: boolean;
  locked: GuidanceLockState;
  skippedReason: string | null;
  hint: string | null;
}

export type GuidanceLockState = "verified" | "mismatch" | "missing" | "unlocked";

export interface GuidanceRegistryEntry {
  package: string;
  version: string;
  integrity: string | null;
  signatures: number;
  checkedAt: string;
}

export interface GuidanceLockEntry {
  kind: GuidancePackSettings["kind"];
  version: string | null;
  sha256: string | null;
  commandHash: string | null;
  registry: GuidanceRegistryEntry | null;
  lockedAt: string;
}

export interface GuidanceLock {
  version: 1;
  generatedAt: string;
  packs: Record<string, GuidanceLockEntry>;
}

export const GUIDANCE_LOCK_FILENAME = "mygrace.guidance-lock.json";
export const GUIDANCE_SIGNATURE_FILENAME = "mygrace.guidance-lock.sig";
export const GUIDANCE_PUBLIC_KEY_FILENAME = "mygrace.guidance.pub";
export const GUIDANCE_PRIVATE_KEY_PATH = join(".mygrace", "guidance-signing.key");
/** Override for tests/private mirrors; default is the public npm registry. */
export const GUIDANCE_REGISTRY_ENV = "MYGRACE_NPM_REGISTRY";

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

export interface GuidanceLockData {
  lock: GuidanceLock;
  file: string;
}

export interface GuidanceKeygenData {
  privateKey: string;
  publicKey: string;
}

export type GuidanceData = GuidanceSearchData | GuidanceRetrieveData | GuidanceLockData | GuidanceKeygenData;

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

/** CLI pack commands must pin their package spec; `@latest`/bare npx is flagged. */
export function guidanceCommandPinned(command: string): boolean {
  if (/@latest\b/i.test(command)) return false;
  const match = /(?:^|\s)(?:npx|pnpx|bunx)\s+(?:-y\s+|--yes\s+)?([^\s-][^\s]*)/.exec(command);
  if (match === null) return true;
  const spec = match[1] ?? "";
  if (spec.startsWith(".") || spec.startsWith("/") || spec.startsWith("~")) return true;
  return /@\d/.test(spec);
}

/** SHA-256 over every file in a local pack (sorted, path + bytes). */
export function localPackDigest(dir: string): string {
  const hash = createHash("sha256");
  const walk = (current: string, prefix: string): void => {
    const entries = readdirSync(current, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const relative = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
      const absolute = join(current, entry.name);
      if (entry.isDirectory()) {
        walk(absolute, relative);
      } else if (entry.isFile()) {
        hash.update(relative);
        hash.update("\0");
        hash.update(readFileSync(absolute));
        hash.update("\0");
      }
    }
  };
  walk(dir, "");
  return hash.digest("hex");
}

/** Parse the package spec after npx/pnpx/bunx (`npx -y pkg@1.0.2` → `pkg`). */
export function packageSpecFromCommand(tokens: readonly string[]): string | null {
  const runnerIndex = tokens.findIndex((token) => /^(npx|pnpx|bunx)$/.test(token));
  if (runnerIndex === -1) return null;
  for (const token of tokens.slice(runnerIndex + 1)) {
    if (token.startsWith("-")) continue;
    const withoutVersion = token.startsWith("@") ? token.replace(/@([^/]+)$/, (match) => (match.includes("/") ? match : "")) : token.split("@")[0];
    return withoutVersion === "" ? null : withoutVersion;
  }
  return null;
}

/** Version part of the package spec after npx/pnpx/bunx, if present. */
export function packageVersionFromCommand(tokens: readonly string[]): string | null {
  const runnerIndex = tokens.findIndex((token) => /^(npx|pnpx|bunx)$/.test(token));
  if (runnerIndex === -1) return null;
  for (const token of tokens.slice(runnerIndex + 1)) {
    if (token.startsWith("-")) continue;
    const at = token.lastIndexOf("@");
    return at > 0 ? token.slice(at + 1) : null;
  }
  return null;
}

/** Fetch npm registry provenance metadata for a package/version. */
export async function fetchRegistryProvenance(
  packageName: string,
  version: string | null,
  timeoutMs = 15_000,
  env: NodeJS.ProcessEnv = process.env
): Promise<GuidanceRegistryEntry> {
  const base = (env[GUIDANCE_REGISTRY_ENV] ?? "https://registry.npmjs.org").replace(/\/$/, "");
  const encoded = packageName.startsWith("@") ? packageName.replace("/", "%2F") : encodeURIComponent(packageName);
  const url = version === null ? `${base}/${encoded}` : `${base}/${encoded}/${encodeURIComponent(version)}`;
  const response = await fetch(url, {
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(Math.min(timeoutMs, 20_000)),
  });
  if (!response.ok) throw new Error(`registry responded ${response.status} for ${packageName}${version ? `@${version}` : ""}`);
  const raw = (await response.json()) as Record<string, unknown>;
  let metadata: Record<string, unknown> = raw;
  if (version === null) {
    const tags = raw["dist-tags"];
    const latest = tags !== null && typeof tags === "object" ? (tags as Record<string, unknown>).latest : undefined;
    const versions = raw.versions;
    if (typeof latest !== "string" || versions === null || typeof versions !== "object") {
      throw new Error(`registry metadata for ${packageName} has no latest version`);
    }
    metadata = (versions as Record<string, Record<string, unknown>>)[latest] ?? {};
    version = latest;
  }
  const dist = metadata.dist;
  const distObject = dist !== null && typeof dist === "object" ? (dist as Record<string, unknown>) : {};
  const integrity = typeof distObject.integrity === "string" ? distObject.integrity : null;
  const signatures = Array.isArray(distObject.signatures) ? distObject.signatures.length : 0;
  return {
    package: packageName,
    version,
    integrity,
    signatures,
    checkedAt: new Date().toISOString(),
  };
}

/** Stable hash of a CLI pack command (whitespace-normalised). */
export function cliCommandHash(command: string): string {
  return createHash("sha256").update(command.trim().replace(/\s+/g, " ")).digest("hex");
}

/** Stable JSON (sorted keys) used for signing/verifying the lockfile. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record).sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

/** Generate an Ed25519 signing keypair: private in .mygrace/, public in the repo root. */
export function generateGuidanceKeys(root: string): { privateKey: string; publicKey: string } {
  const privatePath = join(root, GUIDANCE_PRIVATE_KEY_PATH);
  const publicPath = join(root, GUIDANCE_PUBLIC_KEY_FILENAME);
  if (existsSync(privatePath) || existsSync(publicPath)) {
    throw new UsageError(`Guidance signing keys already exist (${GUIDANCE_PRIVATE_KEY_PATH} / ${GUIDANCE_PUBLIC_KEY_FILENAME}).`, {
      hint: "Delete the old key files before rotating; keep the public key committed.",
    });
  }
  const pair = generateKeyPairSync("ed25519");
  mkdirSync(join(root, ".mygrace"), { recursive: true });
  writeFileSync(privatePath, pair.privateKey.export({ type: "pkcs8", format: "pem" }));
  chmodSync(privatePath, 0o600);
  writeFileSync(publicPath, pair.publicKey.export({ type: "spki", format: "pem" }));
  return { privateKey: privatePath, publicKey: publicPath };
}

/** Sign the canonical lockfile; requires `.mygrace/guidance-signing.key` and the matching public key. */
export function signGuidanceLock(root: string, lock: GuidanceLock): string {
  const privatePath = join(root, GUIDANCE_PRIVATE_KEY_PATH);
  const publicPath = join(root, GUIDANCE_PUBLIC_KEY_FILENAME);
  if (!existsSync(privatePath)) {
    throw new UsageError(`No guidance signing key at ${GUIDANCE_PRIVATE_KEY_PATH}.`, {
      hint: "Run `mygrace context guidance --keygen` once, commit the public key, and keep the private key local.",
    });
  }
  const privateKey = createPrivateKey(readFileSync(privatePath, "utf-8"));
  const derivedPublic = createPublicKey(privateKey).export({ type: "spki", format: "pem" });
  if (existsSync(publicPath) && readFileSync(publicPath, "utf-8") !== derivedPublic) {
    throw new UsageError(`${GUIDANCE_PUBLIC_KEY_FILENAME} does not match the private signing key.`, {
      hint: "Re-run --keygen after deleting both key files, or restore the matching public key.",
    });
  }
  if (!existsSync(publicPath)) writeFileSync(publicPath, derivedPublic);
  const signature = signBytes(null, Buffer.from(canonicalJson(lock)), privateKey).toString("base64");
  writeFileSync(join(root, GUIDANCE_SIGNATURE_FILENAME), `${signature}\n`);
  return signature;
}

/** Verify the lock signature; `missing` when no signature/public key is present. */
export function verifyGuidanceLockSignature(root: string, lock: GuidanceLock): "valid" | "invalid" | "missing" {
  const signaturePath = join(root, GUIDANCE_SIGNATURE_FILENAME);
  const publicPath = join(root, GUIDANCE_PUBLIC_KEY_FILENAME);
  if (!existsSync(signaturePath) || !existsSync(publicPath)) return "missing";
  try {
    const signature = Buffer.from(readFileSync(signaturePath, "utf-8").trim(), "base64");
    const publicKey = createPublicKey(readFileSync(publicPath, "utf-8"));
    return verifyBytes(null, Buffer.from(canonicalJson(lock)), publicKey, signature) ? "valid" : "invalid";
  } catch {
    return "invalid";
  }
}

/** Read and validate `mygrace.guidance-lock.json`; null when absent. */
export function loadGuidanceLock(root: string): GuidanceLock | null {
  const file = join(root, GUIDANCE_LOCK_FILENAME);
  if (!existsSync(file)) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, "utf-8"));
  } catch {
    throw new UsageError(`Invalid ${GUIDANCE_LOCK_FILENAME}: not valid JSON.`, { file: GUIDANCE_LOCK_FILENAME });
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new UsageError(`Invalid ${GUIDANCE_LOCK_FILENAME}: expected an object.`, { file: GUIDANCE_LOCK_FILENAME });
  }
  const raw = parsed as Record<string, unknown>;
  if (raw.version !== 1 || raw.packs === null || typeof raw.packs !== "object" || Array.isArray(raw.packs)) {
    throw new UsageError(`Invalid ${GUIDANCE_LOCK_FILENAME}: unsupported shape/version.`, { file: GUIDANCE_LOCK_FILENAME });
  }
  const packs: Record<string, GuidanceLockEntry> = {};
  for (const [name, entry] of Object.entries(raw.packs as Record<string, unknown>)) {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) continue;
    const item = entry as Record<string, unknown>;
    if (item.kind !== "local" && item.kind !== "cli") continue;
    packs[name] = {
      kind: item.kind,
      version: typeof item.version === "string" ? item.version : null,
      sha256: typeof item.sha256 === "string" ? item.sha256 : null,
      commandHash: typeof item.commandHash === "string" ? item.commandHash : null,
      registry:
        item.registry !== null && typeof item.registry === "object" && !Array.isArray(item.registry)
          ? (() => {
              const reg = item.registry as Record<string, unknown>;
              return typeof reg.package === "string" && typeof reg.version === "string"
                ? {
                    package: reg.package,
                    version: reg.version,
                    integrity: typeof reg.integrity === "string" ? reg.integrity : null,
                    signatures: typeof reg.signatures === "number" ? reg.signatures : 0,
                    checkedAt: typeof reg.checkedAt === "string" ? reg.checkedAt : new Date(0).toISOString(),
                  }
                : null;
            })()
          : null,
      lockedAt: typeof item.lockedAt === "string" ? item.lockedAt : new Date(0).toISOString(),
    };
  }
  return { version: 1, generatedAt: typeof raw.generatedAt === "string" ? raw.generatedAt : new Date(0).toISOString(), packs };
}

function applyLock(
  root: string,
  statuses: GuidancePackStatus[],
  manifests: Map<string, GuidancePackManifest>,
  commandTokens: Map<string, string[]>,
  config: MyGraceConfig
): GuidanceLock | null {
  const lock = loadGuidanceLock(root);
  if (lock === null) return null;
  const signature = verifyGuidanceLockSignature(root, lock);
  if (signature === "invalid") {
    for (const status of statuses) {
      if (!status.enabled) continue;
      status.available = false;
      status.locked = "mismatch";
      status.skippedReason = "lock-signature-invalid";
      status.hint = "The guidance lock signature is invalid; do not trust this lockfile.";
    }
    return lock;
  }
  for (const status of statuses) {
    if (!status.enabled || !status.available) continue;
    const entry = lock.packs[status.name];
    if (entry === undefined) {
      status.available = false;
      status.locked = "missing";
      status.skippedReason = "lock-missing";
      status.hint = `Pack "${status.name}" is absent from ${GUIDANCE_LOCK_FILENAME}; run \`mygrace context guidance --lock\`.`;
      continue;
    }
    if (status.kind === "local") {
      const settings = config.guidancePacks.find((pack) => pack.name === status.name);
      const dir = settings === undefined ? null : packDir(root, settings);
      const digest = dir === null ? "" : localPackDigest(dir);
      if (entry.kind !== "local" || entry.sha256 === null || entry.sha256 !== digest) {
        status.available = false;
        status.locked = "mismatch";
        status.skippedReason = "lock-mismatch";
        status.hint = `Local pack "${status.name}" changed after locking; re-run \`mygrace context guidance --lock\` after review.`;
      } else {
        status.locked = "verified";
      }
      continue;
    }
    const tokens = commandTokens.get(status.name);
    const hash = tokens === undefined ? null : cliCommandHash(tokens.join(" "));
    if (entry.kind !== "cli" || entry.commandHash === null || hash === null || entry.commandHash !== hash) {
      status.available = false;
      status.locked = "mismatch";
      status.skippedReason = "lock-mismatch";
      status.hint = `CLI pack "${status.name}" command changed after locking; re-run \`mygrace context guidance --lock\` after review.`;
    } else if (entry.sha256 !== null && tokens !== undefined) {
      const packageName = packageSpecFromCommand(tokens);
      const cached = packageName === null ? null : findNpxCachedPackage(packageName);
      if (cached !== null && localPackDigest(cached.dir) !== entry.sha256) {
        status.available = false;
        status.locked = "mismatch";
        status.skippedReason = "lock-integrity";
        status.hint = `CLI pack "${status.name}" package content changed after locking; re-run --lock after reviewing the new version.`;
      } else {
        status.locked = "verified";
      }
    } else {
      status.locked = "verified";
    }
  }
  return lock;
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
  options: { allowCommands: boolean; allowUnsafeCommands: boolean; ignoreLock?: boolean }
): { statuses: GuidancePackStatus[]; manifests: Map<string, GuidancePackManifest>; commandTokens: Map<string, string[]>; authorization: ReturnType<typeof authorizeCommands>; lock: GuidanceLock | null } {
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
      pinned: settings.kind === "local" ? true : guidanceCommandPinned(settings.command ?? ""),
      locked: "unlocked",
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
  const lock = options.ignoreLock === true ? null : applyLock(root, statuses, manifests, commandTokens, config);
  return { statuses, manifests, commandTokens, authorization, lock };
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

/** Build and write `mygrace.guidance-lock.json` for configured packs. */
export async function writeGuidanceLock(
  root: string,
  config: MyGraceConfig,
  options: { allowCommands: boolean; allowUnsafeCommands: boolean; registry?: boolean }
): Promise<GuidanceLock> {
  const resolved = resolvePacks(root, config, { ...options, ignoreLock: true });
  if (resolved.statuses.filter((status) => status.enabled).length === 0) {
    throw new UsageError("No guidance packs are configured.", {
      hint: "Add guidancePacks to mygrace.config.json, then re-run `mygrace context guidance --lock`.",
    });
  }
  if (resolved.statuses.some((status) => status.enabled && status.kind === "cli" && !resolved.authorization.authorized)) {
    throw new UsageError("Locking CLI guidance packs requires trusted project commands.", {
      hint: trustRefusalHint(root, resolved.authorization),
    });
  }
  const now = new Date().toISOString();
  const packs: Record<string, GuidanceLockEntry> = {};
  for (const settings of config.guidancePacks) {
    if (settings.enabled === false) continue;
    const status = resolved.statuses.find((entry) => entry.name === settings.name);
    if (status === undefined || !status.available) continue;
    if (settings.kind === "local") {
      const dir = packDir(root, settings);
      const manifest = resolved.manifests.get(settings.name);
      if (dir === null || manifest === undefined) continue;
      packs[settings.name] = {
        kind: "local",
        version: manifest.version,
        sha256: localPackDigest(dir),
        commandHash: null,
        registry: null,
        lockedAt: now,
      };
      continue;
    }
    const tokens = resolved.commandTokens.get(settings.name);
    if (tokens === undefined) continue;
    let version: string | null = null;
    let packageDigest: string | null = null;
    const packageName = packageSpecFromCommand(tokens);
    if (packageName !== null) {
      const cached = findNpxCachedPackage(packageName);
      if (cached !== null) packageDigest = localPackDigest(cached.dir);
    }
    const probe = spawnSync(tokens[0] as string, [...tokens.slice(1), "--version"], {
      cwd: root,
      encoding: "utf8",
      timeout: Math.min(settings.timeoutMs, 10_000),
      shell: false,
      env: integrationChildEnv({ NO_COLOR: "1", CI: "1" }),
    });
    if ((probe.status ?? -1) === 0) {
      const match = /(\d+)\.(\d+)\.(\d+)/.exec(`${probe.stdout ?? ""}\n${probe.stderr ?? ""}`);
      if (match !== null) version = `${match[1]}.${match[2]}.${match[3]}`;
    }
    packs[settings.name] = {
      kind: "cli",
      version,
      sha256: packageDigest,
      commandHash: cliCommandHash(tokens.join(" ")),
      registry: null,
      lockedAt: now,
    };
  }
  if (options.registry === true) {
    for (const [name, entry] of Object.entries(packs)) {
      if (entry.kind !== "cli") continue;
      const settings = config.guidancePacks.find((pack) => pack.name === name);
      const tokens = settings === undefined ? [] : tokenizeCommand(settings.command ?? "");
      const packageName = packageSpecFromCommand(tokens);
      if (packageName === null) continue;
      const version = packageVersionFromCommand(tokens) ?? entry.version;
      try {
        entry.registry = await fetchRegistryProvenance(packageName, version, settings?.timeoutMs ?? 15_000);
      } catch (error) {
        throw new UsageError(`Cannot fetch registry provenance for ${packageName}: ${error instanceof Error ? error.message : String(error)}`, {
          hint: "Check network/registry access, or omit --registry for a local-only lockfile.",
        });
      }
    }
  }
  const lock: GuidanceLock = { version: 1, generatedAt: now, packs };
  writeFileSync(join(root, GUIDANCE_LOCK_FILENAME), `${JSON.stringify(lock, null, 2)}\n`);
  return lock;
}

/** Compare recorded registry provenance with the current registry metadata. */
export async function checkRegistryProvenance(
  root: string,
  timeoutMs = 15_000
): Promise<Finding[]> {
  const lock = loadGuidanceLock(root);
  if (lock === null) return [finding("warning", "GUIDANCE_REGISTRY_LOCK_MISSING", `No ${GUIDANCE_LOCK_FILENAME}; run --lock --registry first.`)];
  const findings: Finding[] = [];
  for (const [name, entry] of Object.entries(lock.packs)) {
    if (entry.kind !== "cli") continue;
    if (entry.registry === null) {
      findings.push(
        finding("info", "GUIDANCE_REGISTRY_MISSING", `CLI pack "${name}" has no recorded registry provenance.`, {
          hint: "Re-run `mygrace context guidance --lock --registry` with network access.",
        })
      );
      continue;
    }
    try {
      const current = await fetchRegistryProvenance(entry.registry.package, entry.registry.version, timeoutMs);
      if (current.integrity !== entry.registry.integrity || current.version !== entry.registry.version) {
        findings.push(
          finding("error", "GUIDANCE_REGISTRY_DRIFT", `Registry provenance for "${name}" changed (${entry.registry.version} → ${current.version}, integrity ${entry.registry.integrity ?? "none"} → ${current.integrity ?? "none"}).`)
        );
      }
    } catch (error) {
      findings.push(
        finding("error", "GUIDANCE_REGISTRY_UNAVAILABLE", `Cannot verify registry provenance for "${name}": ${error instanceof Error ? error.message : String(error)}`)
      );
    }
  }
  return findings;
}

const guidanceCommand = defineCommand({
  meta: {
    name: "guidance",
    description: "Search/retrieve domain guidance from configured packs (local markdown or trust-gated CLI)",
  },
  args: {
    query: { type: "positional", required: false, description: "Search query (use --id to retrieve a specific guide; not needed with --lock)" },
    path: { type: "string", default: ".", description: "Project root" },
    format: { type: "string", default: "text", description: "Output format: text or json" },
    id: { type: "string", description: "Retrieve this guide id from --pack (or the matching pack)" },
    pack: { type: "string", description: "Limit search to one configured pack name" },
    allowCommands: { type: "boolean", default: false, description: "Allow trust-gated CLI packs for this run" },
    allowUnsafeCommands: { type: "boolean", default: false, description: "One-off opt-in for deny-listed pack commands" },
    lock: { type: "boolean", default: false, description: "Write mygrace.guidance-lock.json for configured packs" },
    checkLock: { type: "boolean", default: false, description: "Fail (exit 1) when a configured pack is missing/differs from the lockfile" },
    sign: { type: "boolean", default: false, description: "With --lock: sign the lockfile with the Ed25519 private key" },
    keygen: { type: "boolean", default: false, description: "Generate the Ed25519 signing keypair (private local, public committed)" },
    requireSignature: { type: "boolean", default: false, description: "With --check-lock: require a valid lock signature" },
    registry: { type: "boolean", default: false, description: "With --lock: fetch npm registry provenance metadata (network)" },
    checkRegistry: { type: "boolean", default: false, description: "With --check-lock: re-fetch and compare npm registry provenance" },
  },
  run: async ({ args }) => {
    const format = parseOutputFormat(args.format);
    await runCommandOutcome<GuidanceData>(format, { command: "context guidance" }, async (): Promise<CommandOutcome<GuidanceData>> => {
      const input = typeof args.path === "string" ? args.path : ".";
      const root = tryFindProjectRoot(input) ?? resolve(input);
      const loaded = tryLoadConfig(root);
      if (!loaded.ok) throw loaded.error;
      const config = loaded.result.config;
      const id = typeof args.id === "string" && args.id.trim() !== "" ? args.id.trim() : null;
      const pack = typeof args.pack === "string" && args.pack.trim() !== "" ? args.pack.trim() : undefined;
      const options = { allowCommands: args.allowCommands === true, allowUnsafeCommands: args.allowUnsafeCommands === true, ...(pack === undefined ? {} : { pack }) };
      if (args.keygen === true) {
        const keys = generateGuidanceKeys(root);
        const envelope = createEnvelope({
          data: { privateKey: GUIDANCE_PRIVATE_KEY_PATH, publicKey: GUIDANCE_PUBLIC_KEY_FILENAME },
          findings: [],
          meta: { command: "context guidance", root },
        });
        return {
          envelope,
          print: () => {
            console.log(`Guidance signing keys generated.`);
            console.log(`Private (local, gitignored): ${keys.privateKey}`);
            console.log(`Public (commit this):        ${keys.publicKey}`);
            console.log("Next: mygrace context guidance --lock --sign");
          },
        };
      }
      if (args.lock === true) {
        const lock = await writeGuidanceLock(root, config, { ...options, registry: args.registry === true });
        const signaturePath = join(root, GUIDANCE_SIGNATURE_FILENAME);
        let signed = false;
        if (args.sign === true) {
          signGuidanceLock(root, lock);
          signed = true;
        } else if (existsSync(signaturePath)) {
          // A rewritten lock makes an old signature misleading; drop it.
          rmSync(signaturePath, { force: true });
        }
        const envelope = createEnvelope({
          data: { lock, file: GUIDANCE_LOCK_FILENAME, signature: signed ? GUIDANCE_SIGNATURE_FILENAME : null },
          findings: [],
          meta: { command: "context guidance", root },
        });
        return {
          envelope,
          print: () => {
            console.log(`Guidance lock written: ${GUIDANCE_LOCK_FILENAME}`);
            console.log("=".repeat(32));
            for (const [name, entry] of Object.entries(lock.packs)) {
              console.log(`- ${name} (${entry.kind}) version=${entry.version ?? "unknown"} sha256=${entry.sha256?.slice(0, 12) ?? "-"} command=${entry.commandHash?.slice(0, 12) ?? "-"}`);
            }
            console.log(signed ? `Signed: ${GUIDANCE_SIGNATURE_FILENAME}` : "Unsigned; run --lock --sign after reviewing the lockfile.");
          },
        };
      }
      if (typeof args.query !== "string" || args.query.trim() === "") {
        throw new UsageError("context guidance needs a search query (or --lock).", {
          hint: 'Example: mygrace context guidance "accessible dialog" --path .',
        });
      }
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
      for (const pack of data.packs) {
        if (pack.kind === "cli" && !pack.pinned) {
          findings.push(
            finding("warning", "GUIDANCE_PACK_UNPINNED", `Guidance CLI pack "${pack.name}" is not pinned; pin the package version for reproducible retrieval.`, {
              hint: "Replace @latest/bare npx specs with an exact version and re-run `mygrace trust`.",
            })
          );
        }
        if (args.checkLock === true && pack.locked !== "verified") {
          findings.push(
            finding("error", "GUIDANCE_LOCK_MISMATCH", `Guidance pack "${pack.name}" is ${pack.locked}; the lockfile does not verify it.`, {
              hint: "Review changes and re-run `mygrace context guidance --lock`, or remove the lockfile if it is not used.",
            })
          );
        }
      }
      if (args.checkLock === true && !existsSync(join(root, GUIDANCE_LOCK_FILENAME))) {
        findings.push(
          finding("error", "GUIDANCE_LOCK_MISSING", `No ${GUIDANCE_LOCK_FILENAME} exists; run \`mygrace context guidance --lock\` after reviewing packs.`)
        );
      }
      if (args.checkLock === true && args.checkRegistry === true) {
        findings.push(...(await checkRegistryProvenance(root)));
      }
      if (args.checkLock === true) {
        const lock = loadGuidanceLock(root);
        if (lock !== null) {
          const signature = verifyGuidanceLockSignature(root, lock);
          if (signature === "invalid") {
            findings.push(finding("error", "GUIDANCE_LOCK_SIGNATURE_INVALID", "The guidance lock signature is invalid; the lockfile must not be trusted."));
          } else if (signature === "missing" && args.requireSignature === true) {
            findings.push(
              finding("error", "GUIDANCE_LOCK_UNSIGNED", `A valid signature is required but ${GUIDANCE_SIGNATURE_FILENAME} is missing.`, {
                hint: "Run `mygrace context guidance --lock --sign` with the local signing key, then commit the signature and public key.",
              })
            );
          }
        }
      }
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
