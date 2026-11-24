/**
 * MyGRACE — optional integrations registry tests (W5, ADR-9).
 *
 * Pure version/range/path helpers, detection through config → env → PATH,
 * kill switch and required/optional finding severities, plus the
 * `mygrace integrations status` command contract (JSON envelope, exit 0).
 * Exec-based cases use the fake Octocode wrapper and are POSIX-only.
 */

import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cloneDefault } from "../src/grace-config";
import type { MyGraceConfig } from "../src/grace-config";
import { EXIT } from "../src/grace-errors";
import {
  INTEGRATION_ENV,
  buildIntegrationsStatus,
  findExecutableOnPath,
  integrationFindings,
  integrationsCommand,
  parseVersionRange,
  parseVersionText,
  resolveIntegration,
  versionSatisfies,
} from "../src/grace-integrations";
import { makeFakeOctocode } from "./fixtures/octocode/fake-octocode";

const POSIX_ONLY = process.platform !== "win32";
const posixTest = test.skipIf(!POSIX_ONLY);

const INTEGRATIONS_DISABLED_BY_ENV = ["off", "0", "false", "disabled"].includes(
  (process.env.MYGRACE_INTEGRATIONS ?? "").trim().toLowerCase()
);
const runtimeTest = test.skipIf(INTEGRATIONS_DISABLED_BY_ENV);

function makeDir(): string {
  return mkdtempSync(join(tmpdir(), "mygrace-integrations-"));
}

function emptyEnv(overrides: Record<string, string> = {}): NodeJS.ProcessEnv {
  return { PATH: "", HOME: tmpdir(), TMPDIR: tmpdir(), ...overrides };
}

function configWith(octocodeBin: string | null, versionRange = ">=0.29 <0.30"): MyGraceConfig {
  const config = cloneDefault();
  config.integrations.octocode.bin = octocodeBin;
  config.integrations.octocode.versionRange = versionRange;
  return config;
}

class ExitSignal extends Error {}

async function capture(fn: () => Promise<unknown>): Promise<{ stdout: string; exit: number }> {
  const chunks: string[] = [];
  const originalWrite = process.stdout.write.bind(process.stdout);
  const originalLog = console.log;
  const originalExit = process.exit;
  let exit: number | undefined;
  process.stdout.write = ((chunk: unknown) => {
    chunks.push(String(chunk));
    return true;
  }) as typeof process.stdout.write;
  console.log = ((...values: unknown[]) => {
    chunks.push(`${values.map((value) => String(value)).join(" ")}\n`);
  }) as typeof console.log;
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
    process.exit = originalExit;
  }
  return { stdout: chunks.join(""), exit: exit ?? 0 };
}

// ─── Versions and ranges ───────────────────────────────────────────────

describe("version helpers", () => {
  test("parseVersionText reads the first semver in a banner", () => {
    expect(parseVersionText("octocode 0.29.2")).toEqual([0, 29, 2]);
    expect(parseVersionText("v3.3.0\n")).toEqual([3, 3, 0]);
    expect(parseVersionText("no version here")).toBeNull();
  });

  test("parseVersionRange supports two- and three-component bounds", () => {
    expect(parseVersionRange(">=0.29 <0.30")).toEqual([
      { op: ">=", version: [0, 29, 0] },
      { op: "<", version: [0, 30, 0] },
    ]);
    expect(parseVersionRange(">=3.3 <4")).toEqual([
      { op: ">=", version: [3, 3, 0] },
      { op: "<", version: [4, 0, 0] },
    ]);
    expect(parseVersionRange(">=4")).toEqual([{ op: ">=", version: [4, 0, 0] }]);
  });

  test("versionSatisfies respects every comparator and rejects unknown versions", () => {
    expect(versionSatisfies([0, 29, 2], ">=0.29 <0.30")).toBe(true);
    expect(versionSatisfies([0, 29, 0], ">=0.29 <0.30")).toBe(true);
    expect(versionSatisfies([0, 30, 0], ">=0.29 <0.30")).toBe(false);
    expect(versionSatisfies([0, 28, 9], ">=0.29 <0.30")).toBe(false);
    expect(versionSatisfies(null, ">=0.29 <0.30")).toBe(false);
    expect(versionSatisfies([3, 3, 0], ">=3.3 <4")).toBe(true);
  });
});

// ─── PATH / executable detection ───────────────────────────────────────

describe("findExecutableOnPath", () => {
  posixTest("finds an executable file in an explicit PATH", () => {
    const dir = makeDir();
    try {
      const bin = join(dir, "octocode");
      writeFileSync(bin, "#!/bin/sh\necho octocode 0.29.2\n", { mode: 0o755 });
      expect(findExecutableOnPath("octocode", { PATH: dir })).toBe(bin);
      expect(findExecutableOnPath("octocode", { PATH: join(dir, "missing") })).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ─── Detection: config → env → PATH ────────────────────────────────────

describe("resolveIntegration", () => {
  test("missing octocode is unavailable with an install hint (no finding when optional)", () => {
    const root = makeDir();
    try {
      const status = resolveIntegration("octocode", cloneDefault(), root, emptyEnv());
      expect(status.available).toBe(false);
      expect(status.source).toBeNull();
      expect(status.hint).toContain("Octocode");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  posixTest("a supported binary is detected from the config bin", () => {
    const fake = makeFakeOctocode({ version: "0.29.2" });
    const root = makeDir();
    try {
      const status = resolveIntegration("octocode", configWith(fake.bin), root, emptyEnv());
      expect(status.available).toBe(true);
      expect(status.supported).toBe(true);
      expect(status.version).toBe("0.29.2");
      expect(status.source).toBe("config");
      const findings = integrationFindings({
        killSwitch: false,
        root,
        octocode: status,
        archify: resolveIntegration("archify", cloneDefault(), root, emptyEnv()),
      });
      expect(findings.some((item) => item.message.includes("octocode"))).toBe(false);
      expect(findings.some((item) => item.message.includes("archify"))).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
      fake.cleanup();
    }
  });

  posixTest("an unsupported version degrades with a warning finding", () => {
    const fake = makeFakeOctocode({ version: "0.28.0" });
    const root = makeDir();
    try {
      const status = resolveIntegration("octocode", configWith(fake.bin), root, emptyEnv());
      expect(status.available).toBe(true);
      expect(status.supported).toBe(false);
      const findings = integrationFindings({
        killSwitch: false,
        root,
        octocode: status,
        archify: resolveIntegration("archify", cloneDefault(), root, emptyEnv()),
      });
      expect(findings.map((item) => item.code)).toContain("INTEGRATION_UNSUPPORTED_VERSION");
      expect(findings.find((item) => item.code === "INTEGRATION_UNSUPPORTED_VERSION")?.severity).toBe("warning");
    } finally {
      rmSync(root, { recursive: true, force: true });
      fake.cleanup();
    }
  });

  posixTest("the env override beats the configured bin", () => {
    const fake = makeFakeOctocode({ version: "0.29.2" });
    const root = makeDir();
    try {
      const status = resolveIntegration("octocode", cloneDefault(), root, emptyEnv({ [INTEGRATION_ENV.octocodeBin]: fake.bin }));
      expect(status.available).toBe(true);
      expect(status.source).toBe("env");
    } finally {
      rmSync(root, { recursive: true, force: true });
      fake.cleanup();
    }
  });

  posixTest("enabled:true makes a missing tool a warning, not info", () => {
    const root = makeDir();
    try {
      const config = cloneDefault();
      config.integrations.octocode.enabled = true;
      const status = resolveIntegration("octocode", config, root, emptyEnv());
      expect(status.required).toBe(true);
      const findings = integrationFindings({
        killSwitch: false,
        root,
        octocode: status,
        archify: resolveIntegration("archify", cloneDefault(), root, emptyEnv()),
      });
      expect(findings.find((item) => item.code === "INTEGRATION_UNAVAILABLE")?.severity).toBe("warning");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("the kill switch disables every integration without findings", () => {
    const root = makeDir();
    try {
      const status = resolveIntegration("octocode", cloneDefault(), root, emptyEnv({ [INTEGRATION_ENV.killSwitch]: "off" }));
      expect(status.enabled).toBe(false);
      expect(status.hint).toContain("MYGRACE_INTEGRATIONS");
      const findings = integrationFindings({
        killSwitch: true,
        root,
        octocode: status,
        archify: resolveIntegration("archify", cloneDefault(), root, emptyEnv({ [INTEGRATION_ENV.killSwitch]: "off" })),
      });
      expect(findings).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("integrations.<id>.enabled=false is explicit and produces no hint noise", () => {
    const root = makeDir();
    try {
      const config = cloneDefault();
      config.integrations.archify.enabled = false;
      const status = resolveIntegration("archify", config, root, emptyEnv());
      expect(status.enabled).toBe(false);
      expect(status.hint).toContain("enabled=false");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

// ─── Status payload + command ──────────────────────────────────────────

describe("integrations status", () => {
  test("buildIntegrationsStatus reports both tools and the kill switch", () => {
    const root = makeDir();
    try {
      const data = buildIntegrationsStatus(root, cloneDefault(), emptyEnv());
      expect(data.killSwitch).toBe(false);
      expect(data.octocode.id).toBe("octocode");
      expect(data.archify.id).toBe("archify");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  runtimeTest("JSON mode prints the ADR-8 envelope and exits 0 even with info findings", async () => {
    const root = makeDir();
    try {
      const result = await capture(() =>
        integrationsCommand.run!({ args: { path: root, format: "json" } } as never)
      );
      expect(result.exit).toBe(EXIT.OK);
      const envelope = JSON.parse(result.stdout) as {
        ok: boolean;
        exitCode: number;
        findings: Array<{ code: string }>;
        data: { octocode: { available: boolean } };
      };
      expect(envelope.ok).toBe(true);
      expect(envelope.exitCode).toBe(0);
      expect(envelope.data.octocode.available).toBe(false);
      expect(envelope.findings.map((item) => item.code)).toContain("INTEGRATION_UNAVAILABLE");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("text mode prints the integrations table", async () => {
    const root = makeDir();
    try {
      const result = await capture(() => integrationsCommand.run!({ args: { path: root, format: "text" } } as never));
      expect(result.exit).toBe(EXIT.OK);
      expect(result.stdout).toContain("MyGRACE integrations");
      expect(result.stdout).toContain("octocode");
      expect(result.stdout).toContain("archify");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
