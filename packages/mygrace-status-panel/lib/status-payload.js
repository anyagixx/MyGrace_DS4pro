/**
 * MyGRACE status-panel — data layer (host half of `mygrace-status-panel`).
 *
 * ROADMAP Wave 4.1: the sidebar card is LIVE. This module contains the pure,
 * testable logic behind the single host route `/api/mygrace.status`:
 *
 *   browser ──fetch("api/mygrace.status")──▶ host route (lib/index.js)
 *                                              │ buildStatusPayload(...)
 *                                              ▼
 *                                   spawn `mygrace status --format json`
 *
 * Design rules:
 *   - NEVER throw for expected failures: every failure becomes a
 *     `{ok:false, error}` payload the card can render ("not connected");
 *   - NEVER rely on PATH alone: the CLI comes from `MYGRACE_BIN`, else the
 *     launcher written by `mygrace install-dsh`
 *     (`$DSH_HOME/mygrace/bin/mygrace`), else a clear error;
 *   - project root resolution order: validated `?path=` → `MYGRACE_PROJECT_ROOT`
 *     (validated) → walk up from the harness cwd to `docs/graph-index.xml`;
 *   - `mygrace status --format json` is the single data source (no duplicated
 *     XML parsing in the panel);
 *   - `trust` mirrors ADR-1's precedence for a read-only observer:
 *     `mygrace.config.json` `allowCommands:true` → via "config", else a current
 *     `.mygrace/trust.json` (hashes of docs/modules/*.xml,
 *     docs/verification/*.xml and the config match) → via "trust", else
 *     `{authorized:false, via:null}`.
 *
 * Pure JS (no build step, node builtins only) so DSH can load it from a
 * profile-installed package. JSDoc carries the contract.
 */

// START_MODULE_CONTRACT
//   PURPOSE: Build the live MyGRACE status payload served at /api/mygrace.status and consumed by the sidebar card.
//   SCOPE: Read-only project discovery, hashing and one `mygrace status --format json` subprocess; no network beyond that in the child.
//   DEPENDS: node:fs, node:path, node:os, node:crypto, node:child_process (nothing from DSH; loadable as an external profile plugin)
//   LINKS: ROADMAP.md (Wave 4.1), src/grace-status.ts (the data source), src/grace-test.ts (trust-record format)
// END_MODULE_CONTRACT

// START_MODULE_MAP
//   PANEL_ROUTE_PATH            — "/api/mygrace.status" (host registration path)
//   PANEL_BROWSER_ROUTE         — "api/mygrace.status" (document-relative client fetch URL)
//   PANEL_TIMEOUT_MS            — 5 s subprocess deadline
//   resolveProjectRoot()        — ?path= → MYGRACE_PROJECT_ROOT → remembered project → latest DSH session workspace → cwd walk-up
//   resolveCliCommand()         — MYGRACE_BIN → $DSH_HOME launcher → actionable error (never PATH-only)
//   createCliRunner()           — async execFile runner with timeout/abort/ENOENT classification
//   parseStatusOutput()         — validate/normalize `mygrace status --format json`
//   readTrustState()            — ADR-1 observer trust: {authorized, via} | null
//   buildStatusPayload()        — the pure entry point used by the host route and the tests
// END_MODULE_MAP

// START_CHANGE_SUMMARY
//   v1.3 (Wave 4.1): replaced the decorative static card data path with a real
//   host route backing data layer: project discovery, PATH-free CLI resolution,
//   timeout/abort classification, trust observation, payload normalization.
//   v1.3.2: project discovery follows the session — when the harness was launched
//   outside a project, the card reads the MCP server's remembered
//   `$HOME/.mygrace/active-project` root before falling back to cwd walking.
//   v1.3.3: when no explicit/remembered root exists yet (fresh harness start),
//   the newest DSH session workspace is used instead of the launch directory.
// END_CHANGE_SUMMARY

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

/** Exact host route the panel registers (absolute path below `/api`). */
export const PANEL_ROUTE_PATH = "/api/mygrace.status";
/**
 * Document-relative URL the browser bundle fetches.
 *
 * DSH serves the app with document-relative API routes (see
 * `.agents/notes/implemented/architecture/2026-09-14-web-document-relative-app-routes.md`
 * in the DSH checkout and `dsh-client-ui-deliverables/lib/client.js`, which
 * strips the leading slash the same way), so `api/mygrace.status` resolves
 * against the current page URL.
 */
export const PANEL_BROWSER_ROUTE = PANEL_ROUTE_PATH.slice(1);
/** Subprocess deadline for one `mygrace status` call. */
export const PANEL_TIMEOUT_MS = 5_000;
/** Env var naming the MyGRACE CLI executable (launcher or compatible wrapper). */
export const PANEL_BIN_ENV = "MYGRACE_BIN";
/** Env var naming the project root when no `?path=` query is supplied. */
export const PANEL_PROJECT_ROOT_ENV = "MYGRACE_PROJECT_ROOT";

const STATE_DIR = ".mygrace";
const TRUST_FILENAME = "trust.json";
const CONFIG_FILENAME = "mygrace.config.json";
const TRUST_RECORD_VERSION = 1;

/** @returns {value is Record<string, unknown>} */
function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** @returns {number} a finite non-negative number, or the fallback */
function count(value, fallback = 0) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : fallback;
}

/** @returns {string} */
function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

/** @param {string} dir */
function projectMarker(dir) {
  return join(dir, "docs", "graph-index.xml");
}

// ─── Project discovery ──────────────────────────────────────────────────

/**
 * @typedef {{ok:true, root:string, source:"query"|"env"|"cwd"}|{ok:false, error:string}} ProjectResolution
 */

/**
 * Resolve the MyGRACE project root the card should report on.
 *
 * Order (first valid wins): validated `?path=` query → validated
 * `MYGRACE_PROJECT_ROOT` env var → walk up from `cwd` to a
 * `docs/graph-index.xml`. A supplied-but-invalid path is reported instead of
 * silently ignored, so a stale bookmark is visible to the user.
 *
 * @param {{queryPath?: string|null, env?: Record<string,string|undefined>, cwd?: string}} options
 * @returns {ProjectResolution}
 */

/** State file the MCP server writes when it resolves an explicit project root. */
export const ACTIVE_PROJECT_FILE_ENV = "MYGRACE_ACTIVE_PROJECT_FILE";

/**
 * Path of the remembered-project state file.
 * `MYGRACE_ACTIVE_PROJECT_FILE` overrides; otherwise `$HOME/.mygrace/active-project`.
 * Returns undefined when no HOME is available (tests pass an explicit env).
 * @param {NodeJS.ProcessEnv} env
 * @returns {string|undefined}
 */
function rememberedProjectFile(env) {
  const override = typeof env?.[ACTIVE_PROJECT_FILE_ENV] === "string" ? env[ACTIVE_PROJECT_FILE_ENV].trim() : "";
  if (override !== "") return resolve(override);
  const home = typeof env?.HOME === "string" && env.HOME.trim() !== "" ? env.HOME.trim() : "";
  return home === "" ? undefined : join(home, ".mygrace", "active-project");
}

/**
 * The remembered project root, or undefined when absent/stale/not a MyGRACE project.
 * @param {NodeJS.ProcessEnv} env
 * @returns {string|undefined}
 */
function readRememberedProject(env) {
  const file = rememberedProjectFile(env);
  if (file === undefined) return undefined;
  try {
    const value = readFileSync(file, "utf-8").trim();
    if (value === "") return undefined;
    const root = resolve(value);
    return existsSync(projectMarker(root)) ? root : undefined;
  } catch {
    return undefined;
  }
}


/**
 * DSH home for session discovery (`DSH_HOME`, else `$HOME/.dsh`); undefined
 * when neither is available (tests pass an explicit env).
 * @param {NodeJS.ProcessEnv} env
 * @returns {string|undefined}
 */
function dshHome(env) {
  const override = typeof env?.DSH_HOME === "string" ? env.DSH_HOME.trim() : "";
  if (override !== "") return resolve(override);
  const home = typeof env?.HOME === "string" && env.HOME.trim() !== "" ? env.HOME.trim() : "";
  return home === "" ? undefined : join(home, ".dsh");
}

/**
 * Workspace of the most recently active DSH session, or undefined.
 *
 * A fresh harness start has no remembered project yet; the session cache
 * (`$DSH_HOME/storages/session_projcache/sessions/*.json`) records each
 * session's `identity.cwd`, so the card can follow the project the user is
 * actually looking at instead of the harness launch directory.
 * @param {NodeJS.ProcessEnv} env
 * @returns {string|undefined}
 */
function readLatestSessionProject(env) {
  const home = dshHome(env);
  if (home === undefined) return undefined;
  const dir = join(home, "storages", "session_projcache", "sessions");
  /** @type {{file:string, mtimeMs:number}[]} */
  const candidates = [];
  try {
    for (const name of readdirSync(dir)) {
      if (!name.endsWith(".json")) continue;
      const file = join(dir, name);
      candidates.push({ file, mtimeMs: statSync(file).mtimeMs });
    }
  } catch {
    return undefined;
  }
  candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);
  for (const candidate of candidates.slice(0, 25)) {
    try {
      const record = JSON.parse(readFileSync(candidate.file, "utf-8"));
      const cwd = record?.record?.identity?.cwd;
      if (typeof cwd !== "string" || !isAbsolute(cwd)) continue;
      const root = resolve(cwd);
      if (existsSync(projectMarker(root))) return root;
    } catch {
      // Malformed/locked session record: try the next newest one.
    }
  }
  return undefined;
}

export function resolveProjectRoot(options) {
  const queryPath = typeof options.queryPath === "string" ? options.queryPath.trim() : "";
  if (queryPath !== "") {
    if (!isAbsolute(queryPath)) {
      return { ok: false, error: `The ?path= parameter must be an absolute path (received "${queryPath}").` };
    }
    const root = resolve(queryPath);
    if (!existsSync(projectMarker(root))) {
      return { ok: false, error: `No MyGRACE project at "${root}" (docs/graph-index.xml not found).` };
    }
    return { ok: true, root, source: "query" };
  }

  const envRoot = typeof options.env?.[PANEL_PROJECT_ROOT_ENV] === "string" ? String(options.env[PANEL_PROJECT_ROOT_ENV]).trim() : "";
  if (envRoot !== "") {
    if (!isAbsolute(envRoot)) {
      return { ok: false, error: `${PANEL_PROJECT_ROOT_ENV} must be an absolute path (received "${envRoot}").` };
    }
    const root = resolve(envRoot);
    if (!existsSync(projectMarker(root))) {
      return { ok: false, error: `No MyGRACE project at ${PANEL_PROJECT_ROOT_ENV}="${root}" (docs/graph-index.xml not found).` };
    }
    return { ok: true, root, source: "env" };
  }

  // The harness may be launched from any directory: follow the last project the
  // MCP server resolved (the session workspace) before walking up from cwd.
  const remembered = readRememberedProject(options.env ?? process.env);
  if (remembered !== undefined) return { ok: true, root: remembered, source: "remembered" };

  // Fresh harness start: follow the workspace of the newest DSH session.
  const sessionRoot = readLatestSessionProject(options.env ?? process.env);
  if (sessionRoot !== undefined) return { ok: true, root: sessionRoot, source: "session" };

  let dir = resolve(options.cwd ?? process.cwd());
  for (;;) {
    if (existsSync(projectMarker(dir))) return { ok: true, root: dir, source: "cwd" };
    const parent = resolve(dir, "..");
    if (parent === dir) break;
    dir = parent;
  }
  return {
    ok: false,
    error:
      "No MyGRACE project found: pass ?path=<absolute project root>, set MYGRACE_PROJECT_ROOT, open a session that used a MyGRACE MCP tool, or start the harness inside a project with docs/graph-index.xml.",
  };
}

// ─── CLI resolution ─────────────────────────────────────────────────────

/**
 * @typedef {{ok:true, command:string, source:"env"|"launcher"}|{ok:false, error:string}} CliResolution
 */

/**
 * Resolve the MyGRACE executable WITHOUT relying on PATH:
 *   1. explicit `MYGRACE_BIN` (absolute path must exist; a bare command name is
 *      honoured as an explicit user choice);
 *   2. the launcher written by `mygrace install-dsh`
 *      (`$DSH_HOME/mygrace/bin/mygrace[-cmd]`);
 *   3. an actionable error (never a silent PATH fallback).
 *
 * @param {{env?: Record<string,string|undefined>, dshHome?: string, exists?: (path:string)=>boolean}} options
 * @returns {CliResolution}
 */
export function resolveCliCommand(options = {}) {
  const env = options.env ?? process.env;
  const exists = options.exists ?? existsSync;
  const override = typeof env[PANEL_BIN_ENV] === "string" ? String(env[PANEL_BIN_ENV]).trim() : "";
  if (override !== "") {
    if (isAbsolute(override) && !exists(override)) {
      return { ok: false, error: `${PANEL_BIN_ENV} points to a missing executable: "${override}".` };
    }
    return { ok: true, command: override, source: "env" };
  }
  const home = resolve(
    (typeof options.dshHome === "string" && options.dshHome.trim() !== "" ? options.dshHome : env.DSH_HOME)?.trim?.() ||
      join(homedir(), ".dsh")
  );
  const launcher = join(home, "mygrace", "bin", process.platform === "win32" ? "mygrace.cmd" : "mygrace");
  if (exists(launcher)) return { ok: true, command: launcher, source: "launcher" };
  return {
    ok: false,
    error:
      `MyGRACE CLI not found: set ${PANEL_BIN_ENV} to the CLI launcher, or run \`mygrace install-dsh\` ` +
      `(expected launcher at "${launcher}").`,
  };
}

// ─── CLI runner ─────────────────────────────────────────────────────────

/**
 * @typedef {(
 *   | {ok:true, stdout:string, stderr:string, exitCode:number}
 *   | {ok:false, kind:"timeout"|"aborted"|"not-found"|"spawn", error:string}
 * )} CliRunResult
 */

/**
 * Async runner for the status subprocess.
 *
 * `execFile` is used (argv-only, no shell) with a hard timeout, an optional
 * AbortSignal and an output cap. A non-zero EXIT is not a transport failure:
 * `mygrace status --format json` exits 1 when the project has findings but
 * still prints a valid envelope, so the runner returns it for normalization.
 *
 * @param {{timeoutMs?: number}} [options]
 * @returns {(command:string, args:string[], runOptions?: {signal?: AbortSignal, cwd?: string}) => Promise<CliRunResult>}
 */
export function createCliRunner(options = {}) {
  const timeoutMs = typeof options.timeoutMs === "number" && options.timeoutMs > 0 ? options.timeoutMs : PANEL_TIMEOUT_MS;
  return function runCli(command, args, runOptions = {}) {
    return new Promise((resolvePromise) => {
      let settled = false;
      /** @param {CliRunResult} result */
      const finish = (result) => {
        if (settled) return;
        settled = true;
        resolvePromise(result);
      };
      try {
        execFile(
          command,
          args,
          {
            encoding: "utf-8",
            timeout: timeoutMs,
            killSignal: "SIGTERM",
            maxBuffer: 16 * 1024 * 1024,
            cwd: runOptions.cwd,
            signal: runOptions.signal,
            shell: process.platform === "win32" && /\.cmd$/i.test(command),
          },
          (error, stdout, stderr) => {
            const out = typeof stdout === "string" ? stdout : "";
            const err = typeof stderr === "string" ? stderr : "";
            if (error !== null) {
              const details = /** @type {NodeJS.ErrnoException & {killed?:boolean, signal?:string}} */ (error);
              if (details.name === "AbortError" || details.code === "ABORT_ERR" || runOptions.signal?.aborted === true) {
                finish({ ok: false, kind: "aborted", error: "The status request was aborted." });
                return;
              }
              if (details.killed === true || details.code === "ETIMEDOUT") {
                finish({ ok: false, kind: "timeout", error: `mygrace status timed out after ${timeoutMs} ms.` });
                return;
              }
              if (details.code === "ENOENT" || details.code === "EACCES" || details.code === "ENOTDIR" || details.code === "EISDIR") {
                finish({ ok: false, kind: "not-found", error: `MyGRACE CLI "${command}" was not found or is not executable.` });
                return;
              }
              if (typeof details.code === "number") {
                // The process ran and exited non-zero; stdout may still hold the JSON envelope.
                finish({ ok: true, stdout: out, stderr: err, exitCode: details.code });
                return;
              }
              finish({ ok: false, kind: "spawn", error: `Cannot run "${command}": ${details.message}` });
              return;
            }
            finish({ ok: true, stdout: out, stderr: err, exitCode: 0 });
          }
        );
      } catch (error) {
        finish({ ok: false, kind: "spawn", error: `Cannot run "${command}": ${errorMessage(error)}` });
      }
    });
  };
}

// ─── Status output normalization ────────────────────────────────────────

/**
 * @typedef {{total:number, byStatus:Record<string,number>}} StatusCounts
 * @typedef {{total:number, byPriority:Record<string,number>, byStatus:Record<string,number>}} VerificationCounts
 * @typedef {{errors:number, warnings:number}} LintCounts
 */

/** @returns {Record<string, number>} */
function normalizedCountMap(value) {
  if (!isRecord(value)) return {};
  /** @type {Record<string, number>} */
  const result = {};
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry === "number" && Number.isFinite(entry)) result[key] = entry;
  }
  return result;
}

/** @returns {StatusCounts|null} */
function normalizeStatusCounts(value) {
  if (!isRecord(value) || typeof value.total !== "number" || !Number.isFinite(value.total)) return null;
  return { total: count(value.total), byStatus: normalizedCountMap(value.byStatus) };
}

/**
 * Parse and validate `mygrace status --format json` (ADR-8 envelope).
 *
 * @param {string} stdout
 * @returns {{ok:true, data:{project:string|null, modules:StatusCounts, phases:StatusCounts, verifications:VerificationCounts, lint:LintCounts}}|{ok:false, error:string}}
 */
export function parseStatusOutput(stdout) {
  let envelope;
  try {
    envelope = JSON.parse(stdout);
  } catch (error) {
    const preview = typeof stdout === "string" ? stdout.slice(0, 120).replace(/\s+/gu, " ") : "";
    return { ok: false, error: `mygrace status returned invalid JSON (${errorMessage(error)}). Output began: ${JSON.stringify(preview)}` };
  }
  if (!isRecord(envelope)) return { ok: false, error: "mygrace status returned JSON that is not an object." };
  const data = envelope.data;
  if (!isRecord(data)) return { ok: false, error: "mygrace status JSON has no data object (unexpected envelope shape)." };

  const modules = normalizeStatusCounts(data.modules);
  if (modules === null) return { ok: false, error: "mygrace status JSON has an unexpected shape: modules.total is missing or not a number." };
  const phases = normalizeStatusCounts(data.phases);
  if (phases === null) return { ok: false, error: "mygrace status JSON has an unexpected shape: phases.total is missing or not a number." };
  const verificationsRaw = data.verifications;
  if (!isRecord(verificationsRaw) || typeof verificationsRaw.total !== "number" || !Number.isFinite(verificationsRaw.total)) {
    return { ok: false, error: "mygrace status JSON has an unexpected shape: verifications.total is missing or not a number." };
  }
  const lintRaw = isRecord(data.lint) ? data.lint : {};
  const project = typeof data.project === "string" && data.project.trim() !== "" ? data.project : null;

  return {
    ok: true,
    data: {
      project,
      modules,
      phases,
      verifications: {
        total: count(verificationsRaw.total),
        byPriority: normalizedCountMap(verificationsRaw.byPriority),
        byStatus: normalizedCountMap(verificationsRaw.byStatus),
      },
      lint: { errors: count(lintRaw.errors), warnings: count(lintRaw.warnings) },
    },
  };
}

// ─── Trust observation (ADR-1, read-only) ───────────────────────────────

/** Recursively collect `.xml` files under `dir` (missing dirs yield []). */
function collectXmlFiles(dir) {
  /** @type {string[]} */
  const files = [];
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return files;
  }
  for (const entry of entries) {
    const fullPath = join(dir, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === ".git") continue;
      files.push(...collectXmlFiles(fullPath));
      continue;
    }
    if (entry.isFile() && entry.name.endsWith(".xml")) files.push(fullPath);
  }
  return files;
}

/** Project-relative POSIX path (stable across platforms). */
function projectRelative(root, absolutePath) {
  return relative(root, absolutePath).split(sep).join("/");
}

/**
 * Every file whose content can declare/parameterise an executed command, like
 * `commandSourceFiles()` in `src/grace-test.ts`: docs/modules/**\/*.xml,
 * docs/verification/**\/*.xml and `mygrace.config.json`.
 */
function commandSourceFiles(root) {
  const files = [
    ...collectXmlFiles(join(root, "docs", "modules")),
    ...collectXmlFiles(join(root, "docs", "verification")),
  ].map((file) => projectRelative(root, file));
  if (existsSync(join(root, CONFIG_FILENAME))) files.push(CONFIG_FILENAME);
  return [...new Set(files)].sort();
}

function safeRelativePath(value) {
  if (typeof value !== "string" || value.trim() === "") return null;
  if (isAbsolute(value)) return null;
  const segments = value.split(/[\\/]+/u);
  if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) return null;
  return segments.join("/");
}

/**
 * Observe ADR-1 authorization without executing anything.
 *
 * @param {string} root
 * @returns {{authorized:boolean, via:"config"|"trust"|null}}
 */
export function readTrustState(root) {
  const untrusted = { authorized: false, via: /** @type {null} */ (null) };
  try {
    if (existsSync(join(root, CONFIG_FILENAME))) {
      try {
        const config = JSON.parse(readFileSync(join(root, CONFIG_FILENAME), "utf-8"));
        if (isRecord(config) && config.allowCommands === true) return { authorized: true, via: "config" };
      } catch {
        // A malformed config cannot grant authorization; fall through to the trust record.
      }
    }

    const trustPath = join(root, STATE_DIR, TRUST_FILENAME);
    if (!existsSync(trustPath)) return untrusted;
    /** @type {unknown} */
    let record;
    try {
      record = JSON.parse(readFileSync(trustPath, "utf-8"));
    } catch {
      return untrusted;
    }
    if (!isRecord(record) || record.version !== TRUST_RECORD_VERSION) return untrusted;
    if (typeof record.generatedAt !== "string" || Number.isNaN(Date.parse(record.generatedAt))) return untrusted;
    if (!isRecord(record.files)) return untrusted;

    /** @type {Record<string, string>} */
    const recorded = {};
    for (const [rawPath, hash] of Object.entries(record.files)) {
      const relativePath = safeRelativePath(rawPath);
      if (relativePath === null || typeof hash !== "string" || !/^[0-9a-f]{64}$/iu.test(hash)) return untrusted;
      recorded[relativePath] = hash.toLowerCase();
    }

    /** @type {Record<string, string>} */
    const current = {};
    for (const relativePath of commandSourceFiles(root)) {
      const absolutePath = join(root, relativePath);
      if (statSync(absolutePath).isFile()) current[relativePath] = sha256(readFileSync(absolutePath));
    }
    const missing = Object.keys(current).filter((file) => recorded[file] === undefined);
    const stale = Object.keys(current).filter((file) => recorded[file] !== undefined && recorded[file] !== current[file]);
    if (missing.length > 0 || stale.length > 0) return untrusted;
    return { authorized: true, via: "trust" };
  } catch {
    return untrusted;
  }
}

// ─── Payload builder (the pure entry point) ─────────────────────────────

/**
 * @typedef {Object} PanelStatusPayload
 * @property {boolean} ok
 * @property {string|null} project
 * @property {{total:number, byStatus:Record<string,number>}} [modules]
 * @property {{total:number, byStatus:Record<string,number>}} [phases]
 * @property {{total:number, byPriority:Record<string,number>, byStatus:Record<string,number>}} [verifications]
 * @property {{errors:number, warnings:number}} [lint]
 * @property {{authorized:boolean, via:"config"|"trust"|null}|null} trust
 * @property {string} generatedAt ISO-8601 timestamp of this payload
 * @property {number} [durationMs]
 * @property {string} [error] human-readable failure; present only when ok=false
 */

/** @param {CliRunResult} result @param {string} command */
function describeRunFailure(result, command) {
  if (result.ok) return "";
  if (result.kind === "timeout") return result.error;
  if (result.kind === "aborted") return result.error;
  if (result.kind === "not-found") return result.error;
  return result.error || `Cannot run "${command}".`;
}

function firstLine(text) {
  return (typeof text === "string" ? text : "").split("\n").map((line) => line.trim()).find((line) => line !== "") ?? "";
}

/**
 * Build the panel payload the host route returns.
 *
 * Never rejects and never throws: every failure is `{ok:false, error}`. The
 * only side effect is one `mygrace status --format json` subprocess (unless a
 * test injects `runCli`).
 *
 * @param {{
 *   root?: string|null,
 *   queryPath?: string|null,
 *   env?: Record<string,string|undefined>,
 *   cwd?: string,
 *   dshHome?: string,
 *   runCli?: ReturnType<typeof createCliRunner>,
 *   signal?: AbortSignal,
 *   now?: () => Date,
 *   timeoutMs?: number,
 * }} options
 * @returns {Promise<PanelStatusPayload>}
 */
export async function buildStatusPayload(options = {}) {
  const now = typeof options.now === "function" ? options.now : () => new Date();
  const generatedAt = now().toISOString();
  const startedAt = Date.now();
  const env = options.env ?? process.env;
  const timeoutMs = typeof options.timeoutMs === "number" && options.timeoutMs > 0 ? options.timeoutMs : PANEL_TIMEOUT_MS;

  /** @type {(error:string, project?: string|null) => PanelStatusPayload} */
  const failure = (error, project = null) => ({ ok: false, project, trust: null, generatedAt, durationMs: Date.now() - startedAt, error });

  try {
    /** @type {string|null} */
    let root = typeof options.root === "string" && options.root.trim() !== "" ? resolve(options.root.trim()) : null;
    if (root !== null) {
      if (!existsSync(projectMarker(root))) {
        return failure(`No MyGRACE project at "${root}" (docs/graph-index.xml not found).`);
      }
    } else {
      const resolution = resolveProjectRoot({ queryPath: options.queryPath, env, cwd: options.cwd });
      if (!resolution.ok) return failure(resolution.error);
      root = resolution.root;
    }

    const cli = resolveCliCommand({ env, dshHome: options.dshHome });
    if (!cli.ok) return failure(cli.error, root);

    const runCli = typeof options.runCli === "function" ? options.runCli : createCliRunner({ timeoutMs });
    const args = ["status", "--path", root, "--format", "json"];
    /** @type {CliRunResult} */
    let result;
    try {
      result = await runCli(cli.command, args, { signal: options.signal, cwd: root });
    } catch (error) {
      return failure(`Cannot run the MyGRACE CLI: ${errorMessage(error)}`, root);
    }
    if (options.signal?.aborted === true) return failure("The status request was aborted.", root);
    if (!isRecord(result) || typeof result.ok !== "boolean") {
      return failure("The MyGRACE CLI runner returned no usable result.", root);
    }
    if (!result.ok) return failure(describeRunFailure(result, cli.command), root);

    const parsed = parseStatusOutput(typeof result.stdout === "string" ? result.stdout : "");
    if (!parsed.ok) {
      const stderr = firstLine(result.stderr);
      return failure(stderr === "" ? parsed.error : `${parsed.error} (stderr: ${stderr})`, root);
    }

    return {
      ok: true,
      project: parsed.data.project ?? root,
      modules: parsed.data.modules,
      phases: parsed.data.phases,
      verifications: parsed.data.verifications,
      lint: parsed.data.lint,
      trust: readTrustState(root),
      generatedAt,
      durationMs: Date.now() - startedAt,
    };
  } catch (error) {
    // Last-resort containment: the sidebar must never take the GUI down.
    return failure(`Unexpected panel error: ${errorMessage(error)}`);
  }
}
