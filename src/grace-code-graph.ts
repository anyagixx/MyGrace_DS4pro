#!/usr/bin/env bun
/**
 * MyGRACE — Octocode code-graph adapter (ROADMAP ADR-9, INTEGRATION-PLAN §3).
 *
 * Octocode is an optional external code-intelligence binary. This adapter uses
 * exactly one short-lived MCP stdio session (`octocode mcp --path <root>`) and
 * only its read-only tools:
 *
 *   - `graphrag` `{operation:"get-relationships"}` → file-level import edges
 *   - `view_signatures`                          → per-file symbol signatures
 *   - `structural_search` is allowlisted for future callers, never used to write
 *
 * Non-negotiable policy (ADR-9): the binary is resolved by the integration
 * registry (kill switch, config bin, env bin, PATH; tested version range), is
 * spawned argv-only with `shell:false` and the scrubbed
 * `integrationChildEnv()`, every call is bounded by
 * `config.integrations.octocode.timeoutMs`, the session is always closed, and
 * external output is untrusted data parsed defensively. Expected failures
 * (missing tool, unsupported version, timeout, malformed JSON) degrade to
 * `notes[]` — they never throw and never gate the core commands.
 */

// START_MODULE_CONTRACT
//   PURPOSE: Read-only Octocode code-graph adapter (file import edges and symbol signatures) over one short-lived MCP stdio session.
//   SCOPE: Resolves/validates the integration, calls only read-only MCP tools, parses untrusted JSON defensively; no writes, no network, no gating.
//   DEPENDS: @modelcontextprotocol/sdk, grace-config, grace-integrations, node:path
//   LINKS: ROADMAP.md (ADR-9), INTEGRATION-PLAN.md (Wave 5)
// END_MODULE_CONTRACT

// START_MODULE_MAP
//   CodeGraphEdge            — {from,to,relation:"imports"} project-relative file edge
//   CodeGraphResult          — {available,version,edges,notes} for collectImportEdges
//   SymbolInfo               — {name,kind}
//   CodeSymbolsResult        — {available,version,files,notes} for collectFileSymbols
//   READ_ONLY_TOOLS          — Octocode MCP tool allowlist (no index/grep/rewrite tools)
//   parseGraphRelationships()— defensive graphrag payload → filtered/deduped/sorted import edges
//   parseViewSignatures()    — defensive view_signatures payload → per-file deduped/sorted symbols
//   collectImportEdges()     — one MCP session; get-relationships per module file; notes on failure
//   collectFileSymbols()     — one MCP session; one view_signatures call; notes on failure
// END_MODULE_MAP

// START_CHANGE_SUMMARY
//   v1.4.0 (Wave 5) — introduced the Octocode graph-only adapter: MCP session policy,
//   import-edge and signature parsers, notes-only degradation (ADR-9).
// END_CHANGE_SUMMARY

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";
import { isAbsolute, relative, resolve } from "node:path";
import type { MyGraceConfig } from "./grace-config";
import { INTEGRATION_FINDING_CODES, integrationChildEnv, resolveIntegration } from "./grace-integrations";
import type { IntegrationStatus } from "./grace-integrations";

// START_BLOCK_TYPES
/** One file→file import edge, project-relative POSIX paths. */
export interface CodeGraphEdge {
  from: string;
  to: string;
  relation: "imports";
}

export interface CodeGraphResult {
  available: boolean;
  version: string | null;
  edges: CodeGraphEdge[];
  notes: string[];
}

export interface SymbolInfo {
  name: string;
  kind: string;
}

export interface CodeSymbolsResult {
  available: boolean;
  version: string | null;
  /** Keyed by project-relative POSIX path; every requested file is present. */
  files: Record<string, SymbolInfo[]>;
  notes: string[];
}

export interface CodeGraphOptions {
  root: string;
  config: MyGraceConfig;
  /** Module source files (project-relative or absolute paths inside the root). */
  files: string[];
  env?: NodeJS.ProcessEnv;
}
// END_BLOCK_TYPES

// START_BLOCK_CONSTANTS
/** Only these Octocode MCP tools may ever be called (ADR-9 allowlist, read-only). */
export const READ_ONLY_TOOLS = ["graphrag", "view_signatures", "structural_search"] as const;
/** Tools the adapter needs for its two capabilities (sanity check after initialize). */
const REQUIRED_TOOLS = ["graphrag", "view_signatures"] as const;
/** Hard cap on notes so one broken session cannot flood the agent context. */
const MAX_NOTES = 12;
/** Output cap for a single tool payload (untrusted data, ADR-9). */
const MAX_TOOL_TEXT = 4 * 1024 * 1024;
const DEFAULT_CALL_TIMEOUT_MS = 10_000;
const SESSION_OPEN_TIMEOUT_MS = 5_000;
const CLOSE_TIMEOUT_MS = 2_000;
// END_BLOCK_CONSTANTS

// START_BLOCK_HELPERS
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function firstLine(text: string): string {
  const line = text.split("\n").map((part) => part.trim()).find((part) => part !== "");
  return line === undefined ? text : line.slice(0, 300);
}

/** Append notes up to MAX_NOTES; overflow becomes one summary line. */
function capNotes(notes: readonly string[]): string[] {
  const unique: string[] = [];
  for (const note of notes) {
    if (note.trim() === "" || unique.includes(note)) continue;
    unique.push(note);
  }
  if (unique.length <= MAX_NOTES) return unique;
  return [...unique.slice(0, MAX_NOTES - 1), `… (+${unique.length - (MAX_NOTES - 1)} more notes suppressed)`];
}

function toPosix(value: string): string {
  return value.replaceAll("\\", "/");
}

/**
 * Normalize one path to project-relative POSIX form.
 *
 * Accepts relative paths and absolute paths inside the project root; returns
 * null for empty paths, traversal, or paths outside the root (external output
 * is untrusted — ADR-9).
 */
function normalizeProjectFile(root: string, candidate: string): string | null {
  const raw = candidate.trim();
  if (raw === "") return null;
  let path = raw;
  if (isAbsolute(raw)) {
    const rel = relative(resolve(root), resolve(raw));
    if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) return null;
    path = rel;
  }
  const posix = toPosix(path).replace(/^\.\/+/, "");
  if (posix === "" || posix === ".") return null;
  const segments = posix.split("/");
  if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) return null;
  return posix;
}

function normalizeInputFiles(root: string, files: readonly string[], notes: string[]): string[] {
  const normalized = new Set<string>();
  for (const file of files) {
    const safe = normalizeProjectFile(root, file);
    if (safe === null) {
      notes.push(`Skipped unsafe file path "${file}".`);
      continue;
    }
    normalized.add(safe);
  }
  return [...normalized].sort();
}

type Payload = { ok: true; value: unknown } | { ok: false; note: string };

/** First array found in a payload or one of its well-known wrapper keys. */
function arrayFromPayload(payload: unknown, depth = 0): unknown[] | null {
  if (Array.isArray(payload)) return payload;
  if (payload === null || typeof payload !== "object" || depth > 2) return null;
  const record = payload as Record<string, unknown>;
  for (const key of ["relationships", "edges", "data", "results", "files", "signatures", "items"]) {
    const candidate = record[key];
    if (Array.isArray(candidate)) return candidate;
    if (candidate !== null && typeof candidate === "object") {
      const nested = arrayFromPayload(candidate, depth + 1);
      if (nested !== null) return nested;
    }
  }
  return null;
}

function relationTypeOf(record: Record<string, unknown>): string {
  const value = record.relation_type ?? record.relationType ?? record.relation;
  return typeof value === "string" ? value : "";
}

function fileOf(record: Record<string, unknown>, keys: readonly string[]): string | null {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim() !== "") return value;
  }
  return null;
}
// END_BLOCK_HELPERS

// START_BLOCK_PARSERS
export interface ParsedRelationships {
  edges: CodeGraphEdge[];
  notes: string[];
}

/**
 * Parse a `graphrag get-relationships` payload defensively.
 *
 * Keeps only `relation_type === "imports"` edges whose `source`/`target` are
 * plain file paths (symbol endpoints such as `file.ts::name` are ignored),
 * normalizes paths to project-relative POSIX form, restricts edges to the
 * supplied files, dedupes and sorts deterministically.
 */
export function parseGraphRelationships(
  payload: unknown,
  options: { root: string; files?: readonly string[] } = { root: "." }
): ParsedRelationships {
  const notes: string[] = [];
  let value = payload;
  if (typeof value === "string") {
    try {
      value = JSON.parse(value);
    } catch {
      return {
        edges: [],
        notes: [`${INTEGRATION_FINDING_CODES.invalidOutput}: graphrag returned invalid JSON.`],
      };
    }
  }
  const items = arrayFromPayload(value);
  if (items === null) {
    return {
      edges: [],
      notes: [`${INTEGRATION_FINDING_CODES.invalidOutput}: graphrag returned an unexpected payload shape.`],
    };
  }

  const allowed = options.files === undefined ? null : new Set(options.files);
  const seen = new Set<string>();
  const edges: CodeGraphEdge[] = [];
  for (const item of items) {
    if (item === null || typeof item !== "object" || Array.isArray(item)) continue;
    const record = item as Record<string, unknown>;
    if (relationTypeOf(record) !== "imports") continue;
    const rawFrom = fileOf(record, ["source", "from"]);
    const rawTo = fileOf(record, ["target", "to"]);
    if (rawFrom === null || rawTo === null) continue;
    if (rawFrom.includes("::") || rawTo.includes("::")) continue; // symbol endpoint, not a file edge
    const from = normalizeProjectFile(options.root, rawFrom);
    const to = normalizeProjectFile(options.root, rawTo);
    if (from === null || to === null) continue;
    if (allowed !== null && (!allowed.has(from) || !allowed.has(to))) continue;
    const key = `${from}\u0000${to}`;
    if (seen.has(key)) continue;
    seen.add(key);
    edges.push({ from, to, relation: "imports" });
  }
  edges.sort((left, right) => left.from.localeCompare(right.from) || left.to.localeCompare(right.to));
  return { edges, notes };
}

export interface ParsedSymbols {
  files: Record<string, SymbolInfo[]>;
  notes: string[];
}

/** Deduplicate/sort symbols per file; requested files are always present (possibly empty). */
export function parseViewSignatures(
  payload: unknown,
  options: { root: string; files?: readonly string[] } = { root: "." }
): ParsedSymbols {
  const notes: string[] = [];
  const result: Record<string, SymbolInfo[]> = {};
  for (const file of options.files ?? []) {
    result[normalizeProjectFile(options.root, file) ?? file] = [];
  }

  let value = payload;
  if (typeof value === "string") {
    try {
      value = JSON.parse(value);
    } catch {
      return {
        files: result,
        notes: [`${INTEGRATION_FINDING_CODES.invalidOutput}: view_signatures returned invalid JSON.`],
      };
    }
  }
  const items = arrayFromPayload(value);
  if (items === null) {
    return {
      files: result,
      notes: [`${INTEGRATION_FINDING_CODES.invalidOutput}: view_signatures returned an unexpected payload shape.`],
    };
  }

  const allowed = options.files === undefined ? null : new Set(Object.keys(result));
  let parsedEntries = 0;
  for (const item of items) {
    if (item === null || typeof item !== "object" || Array.isArray(item)) continue;
    const record = item as Record<string, unknown>;
    const rawPath = fileOf(record, ["path", "file"]);
    if (rawPath === null) continue;
    const path = normalizeProjectFile(options.root, rawPath);
    if (path === null || (allowed !== null && !allowed.has(path))) continue;
    const signatures = Array.isArray(record.signatures) ? record.signatures : Array.isArray(record.symbols) ? record.symbols : [];
    const bucket = result[path] ?? (result[path] = []);
    const seen = new Set(bucket.map((symbol) => `${symbol.name}\u0000${symbol.kind}`));
    for (const signature of signatures) {
      if (signature === null || typeof signature !== "object" || Array.isArray(signature)) continue;
      const signatureRecord = signature as Record<string, unknown>;
      const name = typeof signatureRecord.name === "string" ? signatureRecord.name.trim() : "";
      if (name === "") continue;
      const kind = typeof signatureRecord.kind === "string" && signatureRecord.kind.trim() !== "" ? signatureRecord.kind.trim() : "unknown";
      const key = `${name}\u0000${kind}`;
      if (seen.has(key)) continue;
      seen.add(key);
      bucket.push({ name, kind });
    }
    parsedEntries += 1;
  }

  for (const bucket of Object.values(result)) {
    bucket.sort((left, right) => left.name.localeCompare(right.name) || left.kind.localeCompare(right.kind));
  }
  if (parsedEntries === 0 && items.length > 0) {
    notes.push(`${INTEGRATION_FINDING_CODES.invalidOutput}: view_signatures returned no recognizable entries.`);
  }
  return { files: result, notes };
}
// END_BLOCK_PARSERS

// START_BLOCK_SESSION
interface SessionState {
  client: Client;
  version: string | null;
  timeoutMs: number;
}

type SessionOpen =
  | { ok: true; session: SessionState }
  | { ok: false; version: string | null; notes: string[] };

/** Reject after `ms` unless the wrapped promise settles first (bound on hung tools). */
function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolvePromise, rejectPromise) => {
    const timer = setTimeout(() => rejectPromise(new Error(`${label} timed out after ${ms} ms`)), ms);
    timer.unref?.();
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolvePromise(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        rejectPromise(error);
      }
    );
  });
}

/** `integrationChildEnv()` narrowed to the string record the SDK transport expects. */
function scrubbedTransportEnv(): Record<string, string> {
  const record: Record<string, string> = {};
  for (const [key, value] of Object.entries(integrationChildEnv())) {
    if (typeof value === "string") record[key] = value;
  }
  return record;
}

function toolTimeoutOf(status: IntegrationStatus): number {
  return status.timeoutMs > 0 ? status.timeoutMs : DEFAULT_CALL_TIMEOUT_MS;
}

/** Close a client without letting a broken transport turn cleanup into a hang/throw. */
async function closeQuietly(client: Client): Promise<void> {
  try {
    await withTimeout(client.close(), CLOSE_TIMEOUT_MS, "client.close");
  } catch {
    // Best effort: the child process is gone or the pipe is already closed.
  }
}

function classifyToolError(label: string, error: unknown, timeoutMs: number): string {
  const message = errorMessage(error);
  if (/timed? ?out|timeout|RequestTimeout/iu.test(message)) {
    return `${INTEGRATION_FINDING_CODES.timeout}: ${label} exceeded ${timeoutMs} ms.`;
  }
  return `${INTEGRATION_FINDING_CODES.invalidOutput}: ${label} failed — ${firstLine(message)}`;
}

/** Extract the JSON value from a `tools/call` result (structured content or text JSON). */
function extractToolValue(result: unknown): Payload {
  if (result === null || typeof result !== "object") {
    return { ok: false, note: `${INTEGRATION_FINDING_CODES.invalidOutput}: tool returned an unexpected result type.` };
  }
  const record = result as Record<string, unknown>;
  const text = Array.isArray(record.content)
    ? record.content
        .map((block) => {
          if (block === null || typeof block !== "object") return "";
          const entry = block as Record<string, unknown>;
          return entry.type === "text" && typeof entry.text === "string" ? entry.text : "";
        })
        .join("")
    : "";
  if (record.isError === true) {
    return {
      ok: false,
      note: `${INTEGRATION_FINDING_CODES.invalidOutput}: tool reported an error${text === "" ? "" : ` — ${firstLine(text)}`}.`,
    };
  }
  if (record.structuredContent !== undefined && record.structuredContent !== null) {
    return { ok: true, value: record.structuredContent };
  }
  if (text === "") {
    return { ok: false, note: `${INTEGRATION_FINDING_CODES.invalidOutput}: tool returned no text content.` };
  }
  if (text.length > MAX_TOOL_TEXT) {
    return {
      ok: false,
      note: `${INTEGRATION_FINDING_CODES.invalidOutput}: tool output exceeded ${MAX_TOOL_TEXT} bytes.`,
    };
  }
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch {
    return { ok: false, note: `${INTEGRATION_FINDING_CODES.invalidOutput}: tool returned invalid JSON.` };
  }
}

async function callToolJson(session: SessionState, tool: string, args: Record<string, unknown>): Promise<Payload> {
  try {
    const raw = await withTimeout(
      session.client.callTool({ name: tool, arguments: args }, CallToolResultSchema, { timeout: session.timeoutMs }),
      session.timeoutMs + 750,
      tool
    );
    return extractToolValue(raw);
  } catch (error) {
    return { ok: false, note: classifyToolError(tool, error, session.timeoutMs) };
  }
}

/**
 * Spawn `octocode mcp --path <root>` and initialize one MCP session.
 *
 * argv-only with `shell:false` (StdioClientTransport), scrubbed ADR-9 env,
 * cwd = project root. Capability sanity check: the read-only tools this adapter
 * needs must be listed, otherwise the integration is treated as non-conforming.
 */
async function openOctocodeSession(root: string, status: IntegrationStatus): Promise<SessionOpen> {
  if (status.bin === null) {
    return { ok: false, version: status.version, notes: [status.hint ?? "Octocode executable could not be resolved."] };
  }
  const timeoutMs = toolTimeoutOf(status);
  const transport = new StdioClientTransport({
    command: status.bin,
    args: ["mcp", "--path", root],
    env: scrubbedTransportEnv(),
    cwd: root,
    stderr: "ignore",
  });
  const client = new Client({ name: "mygrace-code-graph", version: "1.4.0" }, { capabilities: {} });
  try {
    await withTimeout(client.connect(transport), SESSION_OPEN_TIMEOUT_MS, "octocode initialize");
    const listed = await withTimeout(
      client.listTools(undefined, { timeout: Math.max(timeoutMs, 1_000) }),
      Math.max(timeoutMs, 1_000),
      "octocode tools/list"
    );
    const names = new Set(listed.tools.map((tool) => tool.name));
    const missing = REQUIRED_TOOLS.filter((tool) => !names.has(tool));
    if (missing.length > 0) {
      await closeQuietly(client);
      return {
        ok: false,
        version: status.version,
        notes: [
          `${INTEGRATION_FINDING_CODES.invalidOutput}: Octocode MCP is missing read-only tool(s) ${missing.join(", ")}.`,
        ],
      };
    }
    const serverVersion = client.getServerVersion()?.version ?? null;
    return { ok: true, session: { client, version: status.version ?? serverVersion, timeoutMs } };
  } catch (error) {
    await closeQuietly(client);
    return { ok: false, version: status.version, notes: [classifyToolError("octocode session", error, timeoutMs)] };
  }
}

/** Availability gate shared by both capabilities: never spawn a disabled/missing/unsupported tool. */
function unavailableReason(status: IntegrationStatus): string {
  if (!status.enabled) return status.hint ?? "Octocode integration is disabled.";
  if (!status.available) return status.hint ?? "Octocode is not installed; install it or set MYGRACE_OCTOOCODE_BIN.";
  if (!status.supported) {
    return status.hint ?? `Octocode ${status.version ?? "(unknown)"} is outside the tested range ${status.expectedRange}.`;
  }
  return "";
}
// END_BLOCK_SESSION

// START_BLOCK_IMPORTS
/**
 * Collect file-level `imports` edges from Octocode for the supplied module files.
 *
 * One MCP session, one `graphrag get-relationships` call per file, read-only.
 * Never throws for expected failures: missing/disabled/unsupported integration,
 * per-call timeout, MCP errors and malformed JSON all become `notes[]`.
 */
export async function collectImportEdges(options: CodeGraphOptions): Promise<CodeGraphResult> {
  const { root, config } = options;
  const env = options.env ?? process.env;
  const notes: string[] = [];
  try {
    const status = resolveIntegration("octocode", config, root, env);
    const reason = unavailableReason(status);
    if (reason !== "") {
      return { available: false, version: status.version, edges: [], notes: capNotes([...notes, reason, ...(status.hint === null ? [] : [status.hint])]) };
    }
    const files = normalizeInputFiles(root, options.files, notes);
    if (files.length === 0) {
      return { available: true, version: status.version, edges: [], notes: capNotes([...notes, "No module source files to analyze."]) };
    }

    const opened = await openOctocodeSession(root, status);
    if (!opened.ok) {
      return { available: false, version: opened.version, edges: [], notes: capNotes([...notes, ...opened.notes]) };
    }
    const session = opened.session;
    try {
      const seen = new Set<string>();
      const edges: CodeGraphEdge[] = [];
      for (const file of files) {
        const payload = await callToolJson(session, "graphrag", {
          operation: "get-relationships",
          node_id: file,
          format: "json",
        });
        if (!payload.ok) {
          notes.push(payload.note);
          continue;
        }
        const parsed = parseGraphRelationships(payload.value, { root, files });
        notes.push(...parsed.notes);
        for (const edge of parsed.edges) {
          const key = `${edge.from}\u0000${edge.to}`;
          if (seen.has(key)) continue;
          seen.add(key);
          edges.push(edge);
        }
      }
      edges.sort((left, right) => left.from.localeCompare(right.from) || left.to.localeCompare(right.to));
      return { available: true, version: session.version, edges, notes: capNotes(notes) };
    } finally {
      await closeQuietly(session.client);
    }
  } catch (error) {
    return {
      available: false,
      version: null,
      edges: [],
      notes: capNotes([...notes, `Octocode code graph failed: ${firstLine(errorMessage(error))}`]),
    };
  }
}
// END_BLOCK_IMPORTS

// START_BLOCK_SYMBOLS
/**
 * Collect per-file symbol signatures with one `view_signatures` call.
 *
 * Same session policy and degradation model as {@link collectImportEdges}.
 */
export async function collectFileSymbols(options: CodeGraphOptions): Promise<CodeSymbolsResult> {
  const { root, config } = options;
  const env = options.env ?? process.env;
  const notes: string[] = [];
  const emptyFiles: Record<string, SymbolInfo[]> = {};
  try {
    const status = resolveIntegration("octocode", config, root, env);
    const reason = unavailableReason(status);
    if (reason !== "") {
      return { available: false, version: status.version, files: emptyFiles, notes: capNotes([...notes, reason]) };
    }
    const files = normalizeInputFiles(root, options.files, notes);
    for (const file of files) emptyFiles[file] = [];
    if (files.length === 0) {
      return { available: true, version: status.version, files: emptyFiles, notes: capNotes([...notes, "No module source files to analyze."]) };
    }

    const opened = await openOctocodeSession(root, status);
    if (!opened.ok) {
      return { available: false, version: opened.version, files: emptyFiles, notes: capNotes([...notes, ...opened.notes]) };
    }
    const session = opened.session;
    try {
      const payload = await callToolJson(session, "view_signatures", { files });
      if (!payload.ok) {
        notes.push(payload.note);
        return { available: true, version: session.version, files: emptyFiles, notes: capNotes(notes) };
      }
      const parsed = parseViewSignatures(payload.value, { root, files });
      notes.push(...parsed.notes);
      const filesWithSymbols: Record<string, SymbolInfo[]> = { ...emptyFiles };
      for (const [file, symbols] of Object.entries(parsed.files)) {
        filesWithSymbols[file] = symbols;
      }
      return { available: true, version: session.version, files: filesWithSymbols, notes: capNotes(notes) };
    } finally {
      await closeQuietly(session.client);
    }
  } catch (error) {
    return {
      available: false,
      version: null,
      files: emptyFiles,
      notes: capNotes([...notes, `Octocode signatures failed: ${firstLine(errorMessage(error))}`]),
    };
  }
}
// END_BLOCK_SYMBOLS
