/**
 * Tests for the LIVE DSH status panel (ROADMAP Wave 4.1).
 *
 * Covers the pure host data layer (`lib/status-payload.js`), the host route
 * registration/disposal (`lib/index.js`), the browser bundle contract
 * (`lib/client.js`, static checks only — no browser here), the documented
 * payload/failure matrix, the trust observation, and the installer composition
 * against a temp DSH home (`install-dsh --panel --dry-run` and a real
 * `install-dsh --panel` followed by `dsh --profile web --dump-config`).
 *
 * Nothing here touches the real ~/.dsh: every HOME/DSH_HOME is a unique temp
 * directory under `analysis/_w4-panel/` (concurrency-safe per process) and is
 * removed afterwards.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import YAML from "yaml";
import {
  PANEL_BROWSER_ROUTE,
  PANEL_ROUTE_PATH,
  PANEL_TIMEOUT_MS,
  buildStatusPayload,
  createCliRunner,
  parseStatusOutput,
  readTrustState,
  resolveCliCommand,
  resolveProjectRoot,
} from "../packages/mygrace-status-panel/lib/status-payload.js";
import {
  apply,
  inject,
  name,
  registerPanelRoute,
} from "../packages/mygrace-status-panel/lib/index.js";

const ROOT = join(import.meta.dirname, "..");
const PANEL_DIR = join(ROOT, "packages", "mygrace-status-panel");
const CLI = join(ROOT, "src", "grace.ts");
const WORK_ROOT = join(ROOT, "analysis", "_w4-panel");
const FIXED_NOW = () => new Date("2026-11-22T12:00:00.000Z");

let baseDir: string;

beforeAll(() => {
  mkdirSync(WORK_ROOT, { recursive: true });
  baseDir = mkdtempSync(join(WORK_ROOT, `panel-${process.pid}-`));
});

afterAll(() => {
  rmSync(baseDir, { recursive: true, force: true });
});

function tempDir(prefix: string): string {
  return mkdtempSync(join(baseDir, prefix));
}

function sha256(content: string | Uint8Array): string {
  return createHash("sha256").update(content).digest("hex");
}

/** A minimal (but lazily shaped) MyGRACE project: only the marker is needed for discovery. */
function makeProject(options: { moduleXml?: string; verificationXml?: string; config?: unknown } = {}): string {
  const root = tempDir("project-");
  mkdirSync(join(root, "docs", "modules"), { recursive: true });
  mkdirSync(join(root, "docs", "verification"), { recursive: true });
  writeFileSync(join(root, "docs", "graph-index.xml"), '<GraphIndex project="Test"><M-A NAME="A" TYPE="CORE_LOGIC" STATUS="done" PATH="src/a.ts" DEPENDS="" VERIFICATION_REF="V-M-A"/></GraphIndex>\n');
  writeFileSync(
    join(root, "docs", "modules", "M-A.xml"),
    options.moduleXml ?? '<Module id="M-A" NAME="A" TYPE="CORE_LOGIC" STATUS="done" PATH="src/a.ts" DEPENDS="" VERIFICATION_REF="V-M-A"><Purpose>test</Purpose></Module>\n'
  );
  writeFileSync(
    join(root, "docs", "verification", "V-M-A.xml"),
    options.verificationXml ?? '<Verification id="V-M-A" MODULE="M-A" PRIORITY="high" STATUS="done"><module-checks><check-1>bun test</check-1></module-checks></Verification>\n'
  );
  if (options.config !== undefined) writeFileSync(join(root, "mygrace.config.json"), JSON.stringify(options.config, null, 2));
  return root;
}

/** An executable file usable as MYGRACE_BIN (content is irrelevant for fake runners). */
function fakeExecutable(dir: string, name = "mygrace"): string {
  const path = join(dir, name);
  writeFileSync(path, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  chmodSync(path, 0o755);
  return path;
}

/** A realistic `mygrace status --format json` envelope (ADR-8). */
function statusEnvelope(overrides: Record<string, unknown> = {}, project = "/project"): Record<string, unknown> {
  return {
    ok: true,
    exitCode: 0,
    findings: [],
    meta: { command: "status", root: project, durationMs: 12 },
    data: {
      project,
      modules: { total: 3, byStatus: { done: 3 } },
      phases: { total: 2, byStatus: { done: 2 } },
      verifications: { total: 3, byPriority: { high: 3 }, byStatus: { done: 3 } },
      lint: { errors: 0, warnings: 0 },
      indexErrors: [],
    },
    ...overrides,
  };
}

interface RecordedCall {
  command: string;
  args: string[];
  cwd?: string;
}

/** Fake runner recording its calls; `handler` decides the result. */
function recordingRunner(handler: () => any): { runCli: any; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  const runCli = async (command: string, args: string[], options: { cwd?: string } = {}) => {
    calls.push({ command, args, ...(options.cwd === undefined ? {} : { cwd: options.cwd }) });
    return handler();
  };
  return { runCli, calls };
}

const sampleStdout = (project = "/project") => JSON.stringify(statusEnvelope({}, project));

// ─── Project discovery ──────────────────────────────────────────────────

describe("resolveProjectRoot", () => {
  test("a validated absolute ?path= wins", () => {
    const project = makeProject();
    const other = makeProject();
    const result = resolveProjectRoot({ queryPath: project, env: { MYGRACE_PROJECT_ROOT: other }, cwd: "/" });
    expect(result).toEqual({ ok: true, root: project, source: "query" });
  });

  test("a relative ?path= is rejected with an actionable error", () => {
    const result = resolveProjectRoot({ queryPath: "relative/project", cwd: "/" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("must be an absolute path");
  });

  test("a ?path= without docs/graph-index.xml is rejected", () => {
    const empty = tempDir("empty-");
    const result = resolveProjectRoot({ queryPath: empty, cwd: "/" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("No MyGRACE project at");
  });

  test("MYGRACE_PROJECT_ROOT is used when no query is present", () => {
    const project = makeProject();
    const result = resolveProjectRoot({ env: { MYGRACE_PROJECT_ROOT: project }, cwd: "/" });
    expect(result).toEqual({ ok: true, root: project, source: "env" });
  });

  test("a relative MYGRACE_PROJECT_ROOT is rejected", () => {
    const result = resolveProjectRoot({ env: { MYGRACE_PROJECT_ROOT: "relative" }, cwd: "/" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("MYGRACE_PROJECT_ROOT must be an absolute path");
  });

  test("walks up from the cwd to the project marker", () => {
    const project = makeProject();
    const nested = join(project, "src", "deep", "dir");
    mkdirSync(nested, { recursive: true });
    const result = resolveProjectRoot({ env: {}, cwd: nested });
    expect(result).toEqual({ ok: true, root: project, source: "cwd" });
  });

  test("follows the project remembered by the MCP server when the harness starts elsewhere", () => {
    const project = makeProject();
    const state = join(tempDir("remembered-"), "active-project");
    writeFileSync(state, `${project}\n`);
    const result = resolveProjectRoot({ env: { MYGRACE_ACTIVE_PROJECT_FILE: state }, cwd: "/" });
    expect(result).toEqual({ ok: true, root: project, source: "remembered" });
  });

  test("a stale remembered project is ignored", () => {
    const state = join(tempDir("remembered-stale-"), "active-project");
    writeFileSync(state, `${join(tempDir("gone-"), "missing")}\n`);
    const result = resolveProjectRoot({ env: { MYGRACE_ACTIVE_PROJECT_FILE: state }, cwd: "/" });
    expect(result.ok).toBe(false);
  });

  test("reports a clear error when there is no project anywhere", () => {
    const result = resolveProjectRoot({ env: {}, cwd: "/" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("No MyGRACE project found");
      expect(result.error).toContain("MYGRACE_PROJECT_ROOT");
    }
  });
});

// ─── CLI resolution (never PATH-only) ───────────────────────────────────

describe("resolveCliCommand", () => {
  test("MYGRACE_BIN wins and is reported as source env", () => {
    const bin = fakeExecutable(tempDir("bin-"));
    const result = resolveCliCommand({ env: { MYGRACE_BIN: bin }, dshHome: tempDir("dsh-") });
    expect(result).toEqual({ ok: true, command: bin, source: "env" });
  });

  test("a missing absolute MYGRACE_BIN is reported, not silently skipped", () => {
    const missing = join(tempDir("bin-"), "does-not-exist");
    const result = resolveCliCommand({ env: { MYGRACE_BIN: missing }, dshHome: tempDir("dsh-") });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("MYGRACE_BIN points to a missing executable");
  });

  test("falls back to the install-dsh launcher under $DSH_HOME", () => {
    const dshHome = tempDir("dsh-");
    mkdirSync(join(dshHome, "mygrace", "bin"), { recursive: true });
    const launcherName = process.platform === "win32" ? "mygrace.cmd" : "mygrace";
    const launcher = join(dshHome, "mygrace", "bin", launcherName);
    writeFileSync(launcher, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    const result = resolveCliCommand({ env: {}, dshHome });
    expect(result).toEqual({ ok: true, command: launcher, source: "launcher" });
  });

  test("reports an actionable error when neither source exists (no bare PATH fallback)", () => {
    const result = resolveCliCommand({ env: {}, dshHome: tempDir("dsh-") });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("MyGRACE CLI not found");
      expect(result.error).toContain("mygrace install-dsh");
      expect(result.error).toContain("MYGRACE_BIN");
    }
  });
});

// ─── Status output parsing ──────────────────────────────────────────────

describe("parseStatusOutput", () => {
  test("normalizes the status envelope", () => {
    const parsed = parseStatusOutput(sampleStdout());
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.data.modules).toEqual({ total: 3, byStatus: { done: 3 } });
    expect(parsed.data.phases.total).toBe(2);
    expect(parsed.data.verifications.byPriority).toEqual({ high: 3 });
    expect(parsed.data.lint).toEqual({ errors: 0, warnings: 0 });
  });

  test("keeps findings from a non-zero status envelope (project errors are data)", () => {
    const envelope = statusEnvelope({
      ok: false,
      exitCode: 1,
      data: {
        ...(statusEnvelope().data as Record<string, unknown>),
        lint: { errors: 2, warnings: 1 },
      },
    });
    const parsed = parseStatusOutput(JSON.stringify(envelope));
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.data.lint).toEqual({ errors: 2, warnings: 1 });
  });

  test("rejects non-JSON output", () => {
    const parsed = parseStatusOutput("this is not json");
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.error).toContain("invalid JSON");
  });

  test("rejects an envelope without a data object", () => {
    const parsed = parseStatusOutput(JSON.stringify({ ok: true }));
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.error).toContain("no data object");
  });

  test("rejects an unexpected shape (missing modules.total)", () => {
    const parsed = parseStatusOutput(JSON.stringify({ ok: true, data: { project: "/x" } }));
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.error).toContain("unexpected shape");
  });
});

// ─── Payload builder: success path ──────────────────────────────────────

describe("buildStatusPayload (success)", () => {
  test("maps status data and the trust verdict into the documented payload", async () => {
    const bin = fakeExecutable(tempDir("bin-"));
    const project = makeProject({ config: { allowCommands: true } });
    const { runCli, calls } = recordingRunner(() => ({ ok: true, stdout: sampleStdout(project), stderr: "", exitCode: 0 }));

    const payload: any = await buildStatusPayload({
      root: project,
      env: { MYGRACE_BIN: bin },
      runCli,
      now: FIXED_NOW,
    });

    expect(payload.ok).toBe(true);
    expect(payload.project).toBe(project);
    expect(payload.modules).toEqual({ total: 3, byStatus: { done: 3 } });
    expect(payload.phases).toEqual({ total: 2, byStatus: { done: 2 } });
    expect(payload.verifications).toEqual({ total: 3, byPriority: { high: 3 }, byStatus: { done: 3 } });
    expect(payload.lint).toEqual({ errors: 0, warnings: 0 });
    expect(payload.trust).toEqual({ authorized: true, via: "config" });
    expect(payload.generatedAt).toBe("2026-11-22T12:00:00.000Z");
    expect(typeof payload.durationMs).toBe("number");
    expect(payload.error).toBeUndefined();

    expect(calls).toHaveLength(1);
    expect(calls[0]?.command).toBe(bin);
    expect(calls[0]?.args).toEqual(["status", "--path", project, "--format", "json"]);
    expect(calls[0]?.cwd).toBe(project);
  });

  test("a non-zero exit with a valid envelope still yields ok:true (findings are data)", async () => {
    const bin = fakeExecutable(tempDir("bin-"));
    const project = makeProject();
    const { runCli } = recordingRunner(() => ({ ok: true, stdout: sampleStdout(), stderr: "", exitCode: 1 }));
    const payload: any = await buildStatusPayload({ root: project, env: { MYGRACE_BIN: bin }, runCli });
    expect(payload.ok).toBe(true);
  });

  test("resolves the project via MYGRACE_PROJECT_ROOT when no root is passed", async () => {
    const bin = fakeExecutable(tempDir("bin-"));
    const project = makeProject();
    const { runCli } = recordingRunner(() => ({ ok: true, stdout: sampleStdout(project), stderr: "", exitCode: 0 }));
    const payload: any = await buildStatusPayload({ env: { MYGRACE_BIN: bin, MYGRACE_PROJECT_ROOT: project }, cwd: "/", runCli });
    expect(payload.ok).toBe(true);
    expect(payload.project).toBe(project);
  });
});

// ─── Payload builder: failure matrix ────────────────────────────────────

describe("buildStatusPayload (failure matrix: never throws, {ok:false,error})", () => {
  test("no project found", async () => {
    const { runCli, calls } = recordingRunner(() => ({ ok: true, stdout: sampleStdout(), stderr: "", exitCode: 0 }));
    const payload: any = await buildStatusPayload({ env: {}, cwd: "/", runCli, now: FIXED_NOW });
    expect(payload.ok).toBe(false);
    expect(payload.error).toContain("No MyGRACE project found");
    expect(payload.generatedAt).toBe("2026-11-22T12:00:00.000Z");
    expect(calls).toHaveLength(0); // no subprocess without a project
  });

  test("invalid ?path= is reported", async () => {
    const bin = fakeExecutable(tempDir("bin-"));
    const { runCli } = recordingRunner(() => ({ ok: true, stdout: sampleStdout(), stderr: "", exitCode: 0 }));
    const payload: any = await buildStatusPayload({ queryPath: "relative", env: { MYGRACE_BIN: bin }, cwd: "/", runCli });
    expect(payload.ok).toBe(false);
    expect(payload.error).toContain("must be an absolute path");
  });

  test("CLI missing (no MYGRACE_BIN, no launcher)", async () => {
    const project = makeProject();
    const { runCli, calls } = recordingRunner(() => ({ ok: true, stdout: sampleStdout(), stderr: "", exitCode: 0 }));
    const payload: any = await buildStatusPayload({ root: project, env: {}, dshHome: tempDir("dsh-"), runCli });
    expect(payload.ok).toBe(false);
    expect(payload.project).toBe(project);
    expect(payload.error).toContain("MyGRACE CLI not found: set MYGRACE_BIN");
    expect(calls).toHaveLength(0);
  });

  test("MYGRACE_BIN points to a missing file", async () => {
    const project = makeProject();
    const { runCli, calls } = recordingRunner(() => ({ ok: true, stdout: sampleStdout(), stderr: "", exitCode: 0 }));
    const payload: any = await buildStatusPayload({ root: project, env: { MYGRACE_BIN: join(tempDir("bin-"), "nope") }, runCli });
    expect(payload.ok).toBe(false);
    expect(payload.error).toContain("MYGRACE_BIN points to a missing executable");
    expect(calls).toHaveLength(0);
  });

  test("CLI spawn ENOENT/not-executable", async () => {
    const project = makeProject();
    const bin = fakeExecutable(tempDir("bin-"));
    const { runCli } = recordingRunner(() => ({ ok: false, kind: "not-found", error: 'MyGRACE CLI "/x" was not found or is not executable.' }));
    const payload: any = await buildStatusPayload({ root: project, env: { MYGRACE_BIN: bin }, runCli });
    expect(payload.ok).toBe(false);
    expect(payload.error).toContain("was not found or is not executable");
    expect(payload.project).toBe(project);
  });

  test("timeout is classified with the configured deadline", async () => {
    const project = makeProject();
    const bin = fakeExecutable(tempDir("bin-"));
    const { runCli } = recordingRunner(() => ({ ok: false, kind: "timeout", error: "mygrace status timed out after 5000 ms." }));
    const payload: any = await buildStatusPayload({ root: project, env: { MYGRACE_BIN: bin }, runCli });
    expect(payload.ok).toBe(false);
    expect(payload.error).toContain("timed out after 5000 ms");
  });

  test("aborted request", async () => {
    const project = makeProject();
    const bin = fakeExecutable(tempDir("bin-"));
    const controller = new AbortController();
    const { runCli } = recordingRunner(() => {
      controller.abort();
      return { ok: true, stdout: sampleStdout(), stderr: "", exitCode: 0 };
    });
    const payload: any = await buildStatusPayload({ root: project, env: { MYGRACE_BIN: bin }, runCli, signal: controller.signal });
    expect(payload.ok).toBe(false);
    expect(payload.error).toContain("aborted");
  });

  test("malformed JSON from the CLI", async () => {
    const project = makeProject();
    const bin = fakeExecutable(tempDir("bin-"));
    const { runCli } = recordingRunner(() => ({ ok: true, stdout: "<html>oops</html>", stderr: "", exitCode: 0 }));
    const payload: any = await buildStatusPayload({ root: project, env: { MYGRACE_BIN: bin }, runCli });
    expect(payload.ok).toBe(false);
    expect(payload.error).toContain("invalid JSON");
  });

  test("unexpected JSON shape from the CLI", async () => {
    const project = makeProject();
    const bin = fakeExecutable(tempDir("bin-"));
    const { runCli } = recordingRunner(() => ({ ok: true, stdout: JSON.stringify({ ok: true }), stderr: "", exitCode: 0 }));
    const payload: any = await buildStatusPayload({ root: project, env: { MYGRACE_BIN: bin }, runCli });
    expect(payload.ok).toBe(false);
    expect(payload.error).toContain("no data object");
  });

  test("a throwing runner is contained", async () => {
    const project = makeProject();
    const bin = fakeExecutable(tempDir("bin-"));
    const { runCli } = recordingRunner(() => {
      throw new Error("boom");
    });
    const payload: any = await buildStatusPayload({ root: project, env: { MYGRACE_BIN: bin }, runCli });
    expect(payload.ok).toBe(false);
    expect(payload.error).toContain("Cannot run the MyGRACE CLI: boom");
  });

  test("the real runner enforces its timeout (fast subprocess deadline)", async () => {
    if (process.platform === "win32") return; // smoke uses /bin/sh
    const project = makeProject();
    const slowBin = join(tempDir("bin-"), "mygrace");
    writeFileSync(slowBin, "#!/bin/sh\nsleep 2\n", { mode: 0o755 });
    chmodSync(slowBin, 0o755);
    const started = Date.now();
    const payload: any = await buildStatusPayload({
      root: project,
      env: { MYGRACE_BIN: slowBin },
      runCli: createCliRunner({ timeoutMs: 150 }),
    });
    expect(payload.ok).toBe(false);
    expect(payload.error).toContain("timed out after 150 ms");
    expect(Date.now() - started).toBeLessThan(1_500);
  }, 10_000);

  test("the exported deadline is 5 s", () => {
    expect(PANEL_TIMEOUT_MS).toBe(5_000);
  });
});

// ─── Trust observation (ADR-1) ──────────────────────────────────────────

describe("readTrustState", () => {
  test("config.allowCommands === true → {authorized:true, via:'config'}", () => {
    const project = makeProject({ config: { allowCommands: true } });
    expect(readTrustState(project)).toEqual({ authorized: true, via: "config" });
  });

  test("a current trust record → {authorized:true, via:'trust'}", () => {
    const project = makeProject();
    const files: Record<string, string> = {};
    for (const rel of ["docs/modules/M-A.xml", "docs/verification/V-M-A.xml"]) {
      files[rel] = sha256(readFileSync(join(project, rel)));
    }
    mkdirSync(join(project, ".mygrace"), { recursive: true });
    writeFileSync(
      join(project, ".mygrace", "trust.json"),
      `${JSON.stringify({ version: 1, generatedAt: new Date().toISOString(), files }, null, 2)}\n`
    );
    expect(readTrustState(project)).toEqual({ authorized: true, via: "trust" });
  });

  test("a stale trust record → unauthorized", () => {
    const project = makeProject();
    const files = {
      "docs/modules/M-A.xml": sha256(readFileSync(join(project, "docs", "modules", "M-A.xml"))),
    };
    mkdirSync(join(project, ".mygrace"), { recursive: true });
    writeFileSync(join(project, ".mygrace", "trust.json"), JSON.stringify({ version: 1, generatedAt: new Date().toISOString(), files }));
    // Edit the command source after trust: the record is now stale.
    writeFileSync(join(project, "docs", "modules", "M-A.xml"), "<Module>changed</Module>\n");
    expect(readTrustState(project)).toEqual({ authorized: false, via: null });
  });

  test("malformed trust JSON never throws and stays unauthorized", () => {
    const project = makeProject();
    mkdirSync(join(project, ".mygrace"), { recursive: true });
    writeFileSync(join(project, ".mygrace", "trust.json"), "{not json");
    expect(readTrustState(project)).toEqual({ authorized: false, via: null });
  });

  test("unsafe path entries make the record invalid (unauthorized)", () => {
    const project = makeProject();
    mkdirSync(join(project, ".mygrace"), { recursive: true });
    writeFileSync(
      join(project, ".mygrace", "trust.json"),
      JSON.stringify({ version: 1, generatedAt: new Date().toISOString(), files: { "../evil.xml": "a".repeat(64) } })
    );
    expect(readTrustState(project)).toEqual({ authorized: false, via: null });
  });
});

// ─── Host route registration / disposal / handler ──────────────────────

interface FakeCtx {
  warnings: string[];
  routes: any[];
  effects: Array<() => () => Promise<void>>;
  ctx: any;
}

function fakeCtx(register?: (route: any) => () => Promise<void>): FakeCtx {
  const warnings: string[] = [];
  const routes: any[] = [];
  const effects: Array<() => () => Promise<void>> = [];
  const disposers: Array<() => Promise<void>> = [];
  const ctx = {
    logger: { warn: (message: string) => warnings.push(message) },
    connection: {
      fetch: {
        register:
          register ??
          ((route: any) => {
            routes.push(route);
            const dispose = async () => {
              disposers.push(dispose);
            };
            return dispose;
          }),
      },
    },
    effect: (factory: () => () => Promise<void>) => effects.push(factory),
  };
  return { warnings, routes, effects, ctx };
}

describe("host plugin (lib/index.js)", () => {
  test("declares the plugin identity and requires the connection service", () => {
    expect(name).toBe("mygrace-status-panel");
    expect(inject).toEqual(["connection"]);
  });

  test("registers exactly the documented GET route with the DSH fetch-route shape", () => {
    const fake = fakeCtx();
    const registered = registerPanelRoute(fake.ctx, { runCli: async () => ({ ok: false, kind: "spawn", error: "x" }) });
    expect(registered).not.toBeNull();
    expect(fake.routes).toHaveLength(1);
    const route = fake.routes[0];
    expect(route.path).toBe(PANEL_ROUTE_PATH);
    expect(PANEL_ROUTE_PATH).toBe("/api/mygrace.status");
    expect(route.methods).toEqual(["GET"]);
    expect(route.requestBody).toBe("buffered");
    expect(typeof route.fetch).toBe("function");
    // Disposal is wired through ctx.effect (the DSH idiom).
    expect(fake.effects).toHaveLength(1);
  });

  test("the route returns the live payload with cache-control: no-store", async () => {
    const project = makeProject({ config: { allowCommands: true } });
    const bin = fakeExecutable(tempDir("bin-"));
    const fake = fakeCtx();
    const { runCli, calls } = recordingRunner(() => ({ ok: true, stdout: sampleStdout(project), stderr: "", exitCode: 0 }));
    registerPanelRoute(fake.ctx, { runCli, env: { MYGRACE_BIN: bin }, cwd: "/", now: FIXED_NOW });
    const route = fake.routes[0];
    const response: Response = await route.fetch(new Request(`http://127.0.0.1:3080${PANEL_ROUTE_PATH}?path=${encodeURIComponent(project)}`));
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const payload: any = await response.json();
    expect(payload.ok).toBe(true);
    expect(payload.project).toBe(project);
    expect(payload.generatedAt).toBe("2026-11-22T12:00:00.000Z");
    expect(calls).toHaveLength(1);
  });

  test("failures are 200 {ok:false,...} and never throw", async () => {
    const project = makeProject();
    const fake = fakeCtx();
    registerPanelRoute(fake.ctx, {
      runCli: async () => ({ ok: false, kind: "timeout", error: "mygrace status timed out after 5000 ms." }),
      env: { MYGRACE_BIN: fakeExecutable(tempDir("bin-")) },
      cwd: "/",
    });
    const route = fake.routes[0];
    const response: Response = await route.fetch(
      new Request(`http://127.0.0.1:3080${PANEL_ROUTE_PATH}?path=${encodeURIComponent(project)}`)
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const payload: any = await response.json();
    expect(payload.ok).toBe(false);
    expect(payload.error).toContain("timed out");
  });

  test("a failing payload builder is contained in the handler", async () => {
    const fake = fakeCtx();
    expect(() => {
      registerPanelRoute(fake.ctx, {
        runCli: () => {
          throw new Error("kaboom");
        },
        env: { MYGRACE_BIN: fakeExecutable(tempDir("bin-")) },
        cwd: "/",
      });
    }).not.toThrow();
    const route = fake.routes[0];
    // A runner that throws synchronously is awaited inside buildStatusPayload;
    // exercise the handler with a root that exists so the CLI is invoked.
    const project = makeProject();
    const response: Response = await route.fetch(new Request(`http://127.0.0.1:3080${PANEL_ROUTE_PATH}?path=${encodeURIComponent(project)}`));
    const payload: any = await response.json();
    expect(payload.ok).toBe(false);
  });

  test("missing connection service → warning, no throw, no route", () => {
    const warnings: string[] = [];
    const scriptedCtx = { logger: { warn: (message: string) => warnings.push(message) }, effect: () => {} };
    expect(() => apply(scriptedCtx)).not.toThrow();
    expect(warnings.join("\n")).toContain("connection service unavailable");
  });

  test("register throwing is contained (host boot must not break)", () => {
    const warnings: string[] = [];
    const scriptedCtx = {
      logger: { warn: (message: string) => warnings.push(message) },
      connection: { fetch: { register: () => { throw new Error("nope"); } } },
      effect: () => {},
    };
    expect(() => apply(scriptedCtx)).not.toThrow();
    expect(warnings.join("\n")).toContain("route registration failed");
  });

  test("ctx.effect disposer unregisters the route", async () => {
    let disposed = false;
    const fake = fakeCtx(() => async () => {
      disposed = true;
    });
    registerPanelRoute(fake.ctx, { runCli: async () => ({ ok: false, kind: "spawn", error: "x" }) });
    expect(fake.effects).toHaveLength(1);
    const disposer = fake.effects[0]!();
    await disposer();
    expect(disposed).toBe(true);
  });

  test("an already-aborted request returns {ok:false,error:'aborted'} without running the CLI", async () => {
    const project = makeProject();
    const fake = fakeCtx();
    const { runCli, calls } = recordingRunner(() => ({ ok: true, stdout: sampleStdout(), stderr: "", exitCode: 0 }));
    registerPanelRoute(fake.ctx, { runCli, env: { MYGRACE_BIN: fakeExecutable(tempDir("bin-")) }, cwd: "/" });
    const controller = new AbortController();
    controller.abort();
    const request = new Request(`http://127.0.0.1:3080${PANEL_ROUTE_PATH}?path=${encodeURIComponent(project)}`, { signal: controller.signal });
    const payload: any = await (fake.routes[0].fetch(request) as Promise<Response>).then((response) => response.json());
    expect(payload.ok).toBe(false);
    expect(payload.error).toContain("aborted");
    expect(calls).toHaveLength(0);
  });
});

// ─── Client bundle contract (static checks; no browser available) ───────

describe("browser bundle (lib/client.js)", () => {
  const clientPath = join(PANEL_DIR, "lib", "client.js");
  const client = () => readFileSync(clientPath, "utf-8");

  test("syntax is valid (node --check, with a parse fallback)", () => {
    const check = spawnSync("node", ["--check", clientPath], { encoding: "utf-8" });
    if (check.error !== null) {
      expect(() => new Function(client())).not.toThrow();
      return;
    }
    expect(check.status).toBe(0);
  });

  test("keeps the DSH module-loader + slots contract", () => {
    const source = client();
    expect(source).toContain("window.__ModuleLoader__.load({");
    expect(source).toContain('id: "mygrace-status-panel"');
    expect(source).toContain('require("react/jsx-runtime")');
    expect(source).toContain('require("react")');
    expect(source).toContain('var inject = ["slots"];');
    expect(source).toContain('ctx.slots.inject("sidebar.footer.action"');
    expect(source).toContain("ctx.slots.register(");
    expect(source).toContain("exports.apply = apply;");
    expect(source).toContain("exports.inject = inject;");
  });

  test("fetches the live host route document-relatively (DSH convention)", () => {
    expect(PANEL_BROWSER_ROUTE).toBe("api/mygrace.status");
    const source = client();
    expect(source).toContain('"/api/mygrace.status".slice(1)');
    expect(source).toContain("fetch(STATUS_ROUTE");
    expect(source).toContain('cache: "no-store"');
  });

  test("polls on mount, every 30 s and on visibilitychange, with cleanup", () => {
    const source = client();
    expect(source).toContain("setInterval(function ()");
    expect(source).toContain("REFRESH_MS = 30000");
    expect(source).toContain('addEventListener("visibilitychange"');
    expect(source).toContain("clearInterval(timer)");
    expect(source).toContain('removeEventListener("visibilitychange"');
  });

  test("renders data, badges, trust and a safe error state", () => {
    const source = client();
    expect(source).toContain("modules");
    expect(source).toContain("lint errors");
    expect(source).toContain("trusted");
    expect(source).toContain("untrusted");
    expect(source).toContain("not connected");
    expect(source).toContain("payload.ok !== true");
    // The decorative placeholder text must be gone for good.
    expect(source).not.toContain("Decorative placeholder");
  });
});

// ─── Package manifest / README truth ────────────────────────────────────

describe("package metadata", () => {
  const pkg = () => JSON.parse(readFileSync(join(PANEL_DIR, "package.json"), "utf-8"));
  const readme = () => readFileSync(join(PANEL_DIR, "README.md"), "utf-8");

  test("still private/unpublished, but described as LIVE", () => {
    const manifest = pkg();
    expect(manifest.private).toBe(true);
    expect(manifest.description).toContain("LIVE");
    expect(manifest.description).toContain("/api/mygrace.status");
  });

  test("ships the data layer and keeps the client export", () => {
    const manifest = pkg();
    expect(manifest.files).toContain("lib/status-payload.js");
    expect(manifest.exports["./client"]).toBe("./lib/client.js");
    expect(manifest.dsh.client.platform).toBe("web");
    expect(manifest.dsh.client.inject).toEqual(["@deepseek-ai/dsh-client-ui-sidebar"]);
  });

  test("README documents live data, the route, prerequisites and the payload", () => {
    const text = readme();
    expect(text).toContain("LIVE");
    expect(text).toContain("/api/mygrace.status");
    expect(text).toContain("MYGRACE_BIN");
    expect(text).toContain("cache-control: no-store");
    expect(text).toContain("5 s");
    expect(text).toContain("trust");
    expect(text).toContain("Not verified without a live");
  });
});

// ─── Installer composition against a temp DSH home ──────────────────────

const FAKE_PNPM = `#!/usr/bin/env bun
import { readFileSync, writeFileSync } from "node:fs";
const [command, spec] = process.argv.slice(2);
const manifestPath = process.cwd() + "/package.json";
const pkg = JSON.parse(readFileSync(manifestPath, "utf8"));
pkg.dependencies ??= {};
if (command === "add") {
  pkg.dependencies["mygrace-status-panel"] = spec;
  writeFileSync(manifestPath, JSON.stringify(pkg, null, 2) + "\\n");
  process.exit(0);
}
if (command === "remove") {
  delete pkg.dependencies["mygrace-status-panel"];
  writeFileSync(manifestPath, JSON.stringify(pkg, null, 2) + "\\n");
  process.exit(0);
}
process.exit(1);
`;

function makeFakeBin(): string {
  const binDir = tempDir("bin-");
  const file = join(binDir, "pnpm");
  writeFileSync(file, FAKE_PNPM, { mode: 0o755 });
  chmodSync(file, 0o755);
  // Only the fake bin dir and the bun runtime dir: no real `dsh`/`pnpm` leak in.
  return `${binDir}:${dirname(process.execPath)}`;
}

/** Env without MYGRACE_BIN/MYGRACE_PROJECT_ROOT so host config cannot leak into the CLI test. */
function scrubbedEnv(extra: Record<string, string>): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) continue;
    if (key === "MYGRACE_BIN" || key === "MYGRACE_PROJECT_ROOT") continue;
    env[key] = value;
  }
  return { ...env, ...extra };
}

function makeDshHome(patch = "[]\n"): { home: string; dshHome: string } {
  const home = tempDir("home-");
  const dshHome = join(home, ".dsh");
  mkdirSync(join(dshHome, "profiles", "web"), { recursive: true });
  writeFileSync(join(dshHome, "profiles", "web", "cordis.patch.yml"), patch);
  writeFileSync(
    join(dshHome, "profiles", "web", "package.json"),
    `${JSON.stringify({ name: "dsh-profile-web", private: true, dependencies: {} }, null, 2)}\n`
  );
  return { home, dshHome };
}

function runInstallCli(home: string, dshHome: string, args: string[], path: string): { status: number; stdout: string; stderr: string } {
  const result = spawnSync(
    process.execPath,
    ["run", CLI, "install-dsh", "--dsh-home", dshHome, ...args],
    { cwd: ROOT, encoding: "utf-8", timeout: 120_000, env: scrubbedEnv({ HOME: home, DSH_HOME: dshHome, PATH: path }) }
  );
  return { status: result.status ?? -1, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

// The fake dsh/pnpm executables are POSIX shell scripts; Windows runners cannot
// spawn them, and the DSH itself targets POSIX. Covered on ubuntu/macos.
describe.skipIf(process.platform === "win32")("installer composition (temp DSH home, never the real ~/.dsh)", () => {
  test("--panel --dry-run plans the LIVE card without writing anything", () => {
    const original = "# patch\n[]\n";
    const { home, dshHome } = makeDshHome(original);
    const result = runInstallCli(home, dshHome, ["--panel", "--dry-run"], makeFakeBin());
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("LIVE");
    expect(result.stdout).toContain("would");
    expect(readFileSync(join(dshHome, "profiles", "web", "cordis.patch.yml"), "utf-8")).toBe(original);
    expect(existsSync(join(dshHome, "skills"))).toBe(false);
  }, 120_000);

  test("--panel install writes the row and the profile dependency; the row composes in dsh --dump-config", () => {
    const original = "# patch\n[]\n";
    const { home, dshHome } = makeDshHome(original);
    const result = runInstallCli(home, dshHome, ["--panel"], makeFakeBin());
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("LIVE status card");

    const patch = readFileSync(join(dshHome, "profiles", "web", "cordis.patch.yml"), "utf-8");
    expect(patch).toContain("id: mygrace-status-panel");
    const rows = YAML.parse(patch) as Array<Record<string, any>>;
    const ids = rows.flatMap((row) => row.insert ?? [row]).map((entry) => entry.id);
    expect(ids).toContain("mygrace-status-panel");

    const manifest = JSON.parse(readFileSync(join(dshHome, "profiles", "web", "package.json"), "utf-8"));
    expect(manifest.dependencies["mygrace-status-panel"]).toContain("file:");

    // Compose the profile with the REAL DSH loader (no boot, no route execution).
    const which = spawnSync("dsh", ["--version"], { encoding: "utf-8" });
    if (which.error !== null) return; // DSH not installed in this environment: compose check unavailable.
    const dump = spawnSync("dsh", ["--profile", "web", "--dump-config"], {
      cwd: ROOT,
      encoding: "utf-8",
      timeout: 60_000,
      env: scrubbedEnv({ HOME: home, DSH_HOME: dshHome, PATH: process.env.PATH ?? "" }),
    });
    expect(dump.status).toBe(0);
    expect(dump.stdout).toContain("mygrace-status-panel");
  }, 180_000);

  test("uninstall removes the row and the profile dependency again", () => {
    const { home, dshHome } = makeDshHome();
    const path = makeFakeBin();
    expect(runInstallCli(home, dshHome, ["--panel"], path).status).toBe(0);
    const uninstall = runInstallCli(home, dshHome, ["--uninstall"], path);
    expect(uninstall.status).toBe(0);
    expect(uninstall.stdout).toContain("Uninstall complete");
    expect(readFileSync(join(dshHome, "profiles", "web", "cordis.patch.yml"), "utf-8")).toBe("[]\n");
    const manifest = JSON.parse(readFileSync(join(dshHome, "profiles", "web", "package.json"), "utf-8"));
    expect(manifest.dependencies["mygrace-status-panel"]).toBeUndefined();
  }, 180_000);
});
