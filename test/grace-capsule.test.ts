/**
 * MyGRACE — capsules tests (v1.6, ADR-10).
 *
 * Hermetic: capsule programs are executed through a fake `MYGRACE_BIN`
 * (POSIX shell script) that records argv and returns configured exit codes, so
 * no real project run is needed. Covers schema/allowlist validation, list/show,
 * qualification replay (+hash), unqualified refusal, run/continue with judgment
 * state, deopt to the source skill, drift detection, bindings and disabled config.
 */

import { describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CAPSULE_FINDING_CODES,
  CAPSULE_PROGRAMS,
  capsuleCommand,
  validateCapsuleDefinition,
} from "../src/grace-capsule";

const POSIX_ONLY = process.platform !== "win32";
const posixTest = test.skipIf(!POSIX_ONLY);

const GENERATED_GRAPH = `<GraphIndex project="CapsuleFixture" version="2.0.0">\n</GraphIndex>\n`;

function capsule(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schema_version: 1,
    name: "daily",
    title: "Daily check",
    source_skill: "mygrace-status",
    steps: [
      { id: "status", program: "status" },
      { id: "ci", program: "ci" },
    ],
    ...overrides,
  };
}

interface Fixture {
  root: string;
  capsulesDir: string;
  log: string;
  cleanup(): void;
}

function makeFixture(options: { enabled?: boolean; capsule?: Record<string, unknown>; name?: string } = {}): Fixture {
  const root = mkdtempSync(join(tmpdir(), "mygrace-capsule-"));
  mkdirSync(join(root, "docs"), { recursive: true });
  mkdirSync(join(root, "capsules"), { recursive: true });
  writeFileSync(join(root, "docs", "graph-index.xml"), GENERATED_GRAPH);
  writeFileSync(
    join(root, "mygrace.config.json"),
    JSON.stringify({ integrations: { capsules: { enabled: options.enabled ?? true, dir: "capsules" } } })
  );
  const name = options.name ?? "daily";
  writeFileSync(join(root, "capsules", `${name}.json`), JSON.stringify(options.capsule ?? capsule({ name }), null, 2));
  const log = join(root, "calls.log");
  return {
    root,
    capsulesDir: join(root, "capsules"),
    log,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

/** Fake `mygrace` executable: records argv, prints JSON (or text for packet), honours failure env. */
function makeFakeCli(dir: string): { bin: string; log: string; cleanup(): void } {
  const bin = join(dir, "fake-mygrace");
  const log = join(dir, "calls.log");
  const script = [
    "#!/bin/sh",
    `echo "$@" >> '${log}'`,
    'case "$1" in',
    '  packet) printf "PACKET FIXTURE\\n" ;;',
    '  *) printf \'{"ok":true,"exitCode":0,"findings":[],"data":{}}\\n\' ;;',
    "esac",
    'if [ -n "$FAKE_FAIL_PROGRAM" ] && [ "$1" = "$FAKE_FAIL_PROGRAM" ]; then',
    '  echo "simulated failure" >&2',
    '  exit "${FAKE_FAIL_EXIT:-1}"',
    "fi",
    "exit 0",
    "",
  ].join("\n");
  writeFileSync(bin, script, { encoding: "utf-8", mode: 0o755 });
  chmodSync(bin, 0o755);
  return { bin, log, cleanup: () => rmSync(bin, { force: true }) };
}

class ExitSignal extends Error {}

async function capture(fn: () => Promise<unknown>): Promise<{ stdout: string; exit: number }> {
  const chunks: string[] = [];
  const originalWrite = process.stdout.write.bind(process.stdout);
  const originalLog = console.log;
  const originalError = console.error;
  const originalExit = process.exit;
  let exit: number | undefined;
  process.stdout.write = ((chunk: unknown) => {
    chunks.push(String(chunk));
    return true;
  }) as typeof process.stdout.write;
  console.log = ((...values: unknown[]) => {
    chunks.push(`${values.map((value) => String(value)).join(" ")}\n`);
  }) as typeof console.log;
  console.error = ((...values: unknown[]) => {
    chunks.push(`${values.map((value) => String(value)).join(" ")}\n`);
  }) as typeof console.error;
  process.exit = ((code?: number) => {
    exit = code ?? 0;
    throw new ExitSignal(`exit:${code ?? 0}`);
  }) as never;
  try {
    await fn();
  } catch (error) {
    if (!(error instanceof ExitSignal)) throw error;
  } finally {
    process.stdout.write = originalWrite;
    console.log = originalLog;
    console.error = originalError;
    process.exit = originalExit;
  }
  return { stdout: chunks.join(""), exit: exit ?? 0 };
}

async function withFakeCli(
  fn: (fake: { bin: string; log: string; env: () => void }) => Promise<void>,
  env: Record<string, string> = {}
): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "mygrace-fake-cli-"));
  const fake = makeFakeCli(dir);
  const previous: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries({ MYGRACE_BIN: fake.bin, ...env })) {
    previous[key] = process.env[key];
    process.env[key] = value;
  }
  try {
    await fn({
      bin: fake.bin,
      log: fake.log,
      env: () => {
        for (const [key, value] of Object.entries(env)) process.env[key] = value;
      },
    });
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    fake.cleanup();
    rmSync(dir, { recursive: true, force: true });
  }
}

function runSub(command: string, args: Record<string, unknown>) {
  const sub = (capsuleCommand as unknown as { subCommands: Record<string, { run?: (context: unknown) => Promise<unknown> }> }).subCommands[command];
  if (sub?.run === undefined) throw new Error(`missing subcommand ${command}`);
  return capture(() => sub.run!({ args } as never));
}

const qualifiedCalls = (log: string): string[] => (existsSync(log) ? readFileSync(log, "utf-8").trim().split("\n").filter(Boolean) : []);

// ─── Schema, allowlist and binding dataflow ────────────────────────────

describe("validateCapsuleDefinition", () => {
  test("accepts a minimal program-only capsule", () => {
    expect(validateCapsuleDefinition(capsule())).toEqual({ valid: true, issues: [] });
  });

  test("accepts a judgment step and declared module binding", () => {
    const value = capsule({
      bindings: [{ name: "module", from: "arg:module", required: true, pattern: "^M-[A-Za-z0-9_-]+$" }],
      steps: [{ program: "trace" }, { judge: "Review the trace", skill: "mygrace-fix" }],
    });
    expect(validateCapsuleDefinition(value).valid).toBe(true);
  });

  test("rejects unknown programs, unknown keys and non-program steps", () => {
    expect(validateCapsuleDefinition(capsule({ steps: [{ program: "shell" }] })).valid).toBe(false);
    expect(validateCapsuleDefinition(capsule({ extra: true })).valid).toBe(false);
    expect(validateCapsuleDefinition(capsule({ steps: [{ something: "else" }] })).valid).toBe(false);
    expect(validateCapsuleDefinition(capsule({ steps: [] })).valid).toBe(false);
  });

  test("rejects a program whose placeholder has no declared binding", () => {
    const validation = validateCapsuleDefinition(capsule({ steps: [{ program: "trace" }] }));
    expect(validation.valid).toBe(false);
    expect(validation.issues.some((issue) => issue.message.includes('needs binding "module"'))).toBe(true);
  });

  test("rejects bad names, duplicate step ids and unbounded binding sources", () => {
    expect(validateCapsuleDefinition(capsule({ name: "Bad Name" })).valid).toBe(false);
    expect(validateCapsuleDefinition(capsule({ steps: [{ id: "a", program: "status" }, { id: "a", program: "ci" }] })).valid).toBe(false);
    const badBinding = validateCapsuleDefinition(
      capsule({ bindings: [{ name: "module", from: "env:MODULE", required: true }], steps: [{ program: "trace" }] })
    );
    expect(badBinding.valid).toBe(false);
    expect(badBinding.issues.some((issue) => issue.message.includes('"arg:module"'))).toBe(true);
  });

  test("rejects a capsule with too many steps", () => {
    expect(validateCapsuleDefinition(capsule({ steps: Array.from({ length: 13 }, () => ({ program: "status" })) })).valid).toBe(false);
  });

  test("the program allowlist is read-only (no verify/test/trust/install/diagram write)", () => {
    expect(Object.keys(CAPSULE_PROGRAMS).sort()).toEqual([
      "ci",
      "focus",
      "impact",
      "lint",
      "lint-changed",
      "next",
      "packet",
      "status",
      "trace",
    ]);
  });
});

// ─── list / show / validate ────────────────────────────────────────────

describe("capsule list/show/validate", () => {
  test("list reports validity and qualification state", async () => {
    const fixture = makeFixture();
    try {
      const result = await runSub("list", { path: fixture.root, format: "json" });
      expect(result.exit).toBe(0);
      const envelope = JSON.parse(result.stdout) as { data: { capsules: Array<{ name: string; qualified: boolean; valid: boolean }> } };
      expect(envelope.data.capsules).toHaveLength(1);
      expect(envelope.data.capsules[0]).toMatchObject({ name: "daily", valid: true, qualified: false });
    } finally {
      fixture.cleanup();
    }
  });

  test("show expands program previews and reports qualification state", async () => {
    const fixture = makeFixture();
    try {
      const result = await runSub("show", { name: "daily", path: fixture.root, format: "json" });
      expect(result.exit).toBe(0);
      const envelope = JSON.parse(result.stdout) as { data: { hash: string; programs: string[][] } };
      expect(envelope.data.hash).toHaveLength(64);
      expect(envelope.data.programs[0]?.slice(0, 2)).toEqual(["status", "--path"]);
    } finally {
      fixture.cleanup();
    }
  });

  test("validate exits 1 for an invalid capsule", async () => {
    const fixture = makeFixture({ capsule: capsule({ steps: [{ program: "shell" }] }) });
    try {
      const result = await runSub("validate", { path: fixture.root, format: "json" });
      expect(result.exit).toBe(1);
      const envelope = JSON.parse(result.stdout) as { findings: Array<{ code: string; severity: string }> };
      expect(envelope.findings[0]?.code).toBe(CAPSULE_FINDING_CODES.invalid);
      expect(envelope.findings[0]?.severity).toBe("error");
    } finally {
      fixture.cleanup();
    }
  });
});

// ─── qualify / run / continue / deopt ──────────────────────────────────

describe("capsule lifecycle", () => {
  posixTest("qualify replays programs and records the hash; run then completes", async () => {
    const fixture = makeFixture();
    try {
      await withFakeCli(async (fake) => {
        const qualify = await runSub("qualify", { name: "daily", fixture: fixture.root, path: fixture.root, format: "json" });
        expect(qualify.exit).toBe(0);
        expect(qualifiedCalls(fake.log)).toEqual(["status --path " + fixture.root + " --format json", "ci --path " + fixture.root + " --format json"]);

        const record = JSON.parse(readFileSync(join(fixture.root, ".mygrace", "capsules", "qualifications.json"), "utf-8")) as Record<
          string,
          { hash: string }
        >;
        expect(record.daily?.hash).toHaveLength(64);

        const run = await runSub("run", { name: "daily", path: fixture.root, format: "json" });
        expect(run.exit).toBe(0);
        const envelope = JSON.parse(run.stdout) as { data: { status: string; steps: Array<{ id: string; ok: boolean }> }; findings: unknown[] };
        expect(envelope.data.status).toBe("completed");
        expect(envelope.data.steps.map((step) => step.id)).toEqual(["status", "ci"]);
        expect(envelope.data.steps.every((step) => step.ok)).toBe(true);
        expect(envelope.findings).toEqual([]);
      });
    } finally {
      fixture.cleanup();
    }
  });

  posixTest("run refuses an unqualified capsule unless --allow-unqualified", async () => {
    const fixture = makeFixture();
    try {
      await withFakeCli(async () => {
        const refused = await runSub("run", { name: "daily", path: fixture.root, format: "json" });
        expect(refused.exit).toBe(1);
        expect(JSON.parse(refused.stdout).findings[0].code).toBe(CAPSULE_FINDING_CODES.unqualified);

        const allowed = await runSub("run", { name: "daily", path: fixture.root, format: "json", allowUnqualified: true });
        expect(allowed.exit).toBe(0);
        const envelope = JSON.parse(allowed.stdout) as { findings: Array<{ code: string; severity: string }>; data: { status: string } };
        expect(envelope.data.status).toBe("completed");
        expect(envelope.findings[0]).toMatchObject({ code: CAPSULE_FINDING_CODES.unqualified, severity: "warning" });
      });
    } finally {
      fixture.cleanup();
    }
  });

  posixTest("a judgment step persists state and continue completes the run", async () => {
    const fixture = makeFixture({
      capsule: capsule({
        name: "judged",
        steps: [{ program: "status" }, { judge: "Review status", skill: "mygrace-fix" }, { program: "ci" }],
      }),
      name: "judged",
    });
    try {
      await withFakeCli(async () => {
        const qualify = await runSub("qualify", { name: "judged", fixture: fixture.root, path: fixture.root, format: "json" });
        expect(qualify.exit).toBe(0);
        const run = await runSub("run", { name: "judged", path: fixture.root, format: "json" });
        expect(run.exit).toBe(0);
        const envelope = JSON.parse(run.stdout) as {
          data: { status: string; runId: string; judgment?: { message: string; skill: string } };
          findings: Array<{ code: string }>;
        };
        expect(envelope.data.status).toBe("waiting");
        expect(envelope.data.judgment).toMatchObject({ message: "Review status", skill: "mygrace-fix", stepId: "step-2", nextIndex: 2 });
        expect(envelope.findings[0]?.code).toBe(CAPSULE_FINDING_CODES.judgmentRequired);
        expect(existsSync(join(fixture.root, ".mygrace", "capsules", "state", `${envelope.data.runId}.json`))).toBe(true);

        const continued = await runSub("continue", { runId: envelope.data.runId, path: fixture.root, format: "json" });
        expect(continued.exit).toBe(0);
        const completed = JSON.parse(continued.stdout) as { data: { status: string; steps: Array<{ id: string }> } };
        expect(completed.data.status).toBe("completed");
        expect(completed.data.steps.map((step) => step.id)).toEqual(["step-1", "step-3"]);
        expect(existsSync(join(fixture.root, ".mygrace", "capsules", "state", `${envelope.data.runId}.json`))).toBe(false);
      });
    } finally {
      fixture.cleanup();
    }
  });

  posixTest("a failing program deopts to the source skill and exits 1", async () => {
    const fixture = makeFixture();
    try {
      await withFakeCli(async () => {
        const qualify = await runSub("qualify", { name: "daily", fixture: fixture.root, path: fixture.root, format: "json" });
        expect(qualify.exit).toBe(0);
      });
      await withFakeCli(
        async () => {
          const run = await runSub("run", { name: "daily", path: fixture.root, format: "json" });
          expect(run.exit).toBe(1);
          const envelope = JSON.parse(run.stdout) as { findings: Array<{ code: string; hint?: string }>; data: { status: string } };
          expect(envelope.data.status).toBe("deopted");
          expect(envelope.findings[0]?.code).toBe(CAPSULE_FINDING_CODES.deopt);
          expect(envelope.findings[0]?.hint ?? "").toContain("mygrace-status");
        },
        { FAKE_FAIL_PROGRAM: "ci", FAKE_FAIL_EXIT: "1" }
      );
    } finally {
      fixture.cleanup();
    }
  });

  posixTest("a capsule edited after the judgment is reported as drift on continue", async () => {
    const fixture = makeFixture({
      capsule: capsule({
        name: "judged",
        steps: [{ program: "status" }, { judge: "Review status", skill: "mygrace-fix" }],
      }),
      name: "judged",
    });
    try {
      await withFakeCli(async () => {
        const qualify = await runSub("qualify", { name: "judged", fixture: fixture.root, path: fixture.root, format: "json" });
        expect(qualify.exit).toBe(0);
        const run = await runSub("run", { name: "judged", path: fixture.root, format: "json" });
        const runId = (JSON.parse(run.stdout) as { data: { runId: string } }).data.runId;
        const capsulePath = join(fixture.capsulesDir, "judged.json");
        writeFileSync(capsulePath, JSON.stringify(capsule({ name: "judged", title: "Edited", steps: [{ program: "status" }, { judge: "Review status", skill: "mygrace-fix" }] })));
        const continued = await runSub("continue", { runId, path: fixture.root, format: "json" });
        expect(continued.exit).toBe(1);
        expect(JSON.parse(continued.stdout).findings[0].code).toBe(CAPSULE_FINDING_CODES.drift);
      });
    } finally {
      fixture.cleanup();
    }
  });

  posixTest("module binding is required and validated", async () => {
    const fixture = makeFixture({
      capsule: capsule({
        name: "roster",
        bindings: [{ name: "module", from: "arg:module", required: true, pattern: "^M-[A-Za-z0-9][A-Za-z0-9_-]*$" }],
        steps: [{ program: "trace" }, { program: "focus" }],
      }),
      name: "roster",
    });
    try {
      await withFakeCli(async (fake) => {
        const qualify = await runSub("qualify", {
          name: "roster",
          fixture: fixture.root,
          path: fixture.root,
          module: "M-CLI",
          format: "json",
        });
        expect(qualify.exit).toBe(0);

        const missing = await runSub("run", { name: "roster", path: fixture.root, format: "json" });
        expect(missing.exit).toBe(2);
        const envelope = JSON.parse(missing.stdout) as { error?: { code: string } };
        expect(envelope.error?.code).toBe("USAGE");

        void fake;
      });
    } finally {
      fixture.cleanup();
    }
  });

  posixTest("execution is disabled unless integrations.capsules.enabled=true", async () => {
    const fixture = makeFixture({ enabled: false });
    try {
      await withFakeCli(async () => {
        const run = await runSub("run", { name: "daily", path: fixture.root, format: "json" });
        expect(run.exit).toBe(2);
        const qualify = await runSub("qualify", { name: "daily", fixture: fixture.root, path: fixture.root, format: "json" });
        expect(qualify.exit).toBe(2);
      });
    } finally {
      fixture.cleanup();
    }
  });
});
