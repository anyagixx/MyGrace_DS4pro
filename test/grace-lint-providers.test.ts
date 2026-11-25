/**
 * MyGRACE — external lint providers (ADR-11) tests.
 *
 * Covers the trust gate, dangerous-command denial, both JSON adapters,
 * severity mapping and the audit-log side effect without any network access.
 */

import { describe, expect, test } from "bun:test";

const POSIX_ONLY = process.platform !== "win32";
const posixTest = test.skipIf(!POSIX_ONLY);
import { chmodSync, cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cloneDefault } from "../src/grace-config";
import type { MyGraceConfig } from "../src/grace-config";
import { adaptJsonFindings, adaptLegacyScan, runLintProviders } from "../src/grace-lint-providers";
import { runCiGate } from "../src/grace-ci";

function makeRoot(): string {
  return mkdtempSync(join(tmpdir(), "mygrace-lint-provider-"));
}

function providerConfig(command: string, overrides: Partial<MyGraceConfig["lintProviders"][number]> = {}): MyGraceConfig {
  const config = cloneDefault();
  config.lintProviders = [
    {
      name: "fake-scanner",
      enabled: "auto",
      adapter: "legacy-scan",
      command,
      timeoutMs: 10_000,
      failOn: "warning",
      ...overrides,
    },
  ];
  return config;
}

const LEGACY_PAYLOAD = {
  targetDir: ".",
  totalFindings: 2,
  activeRuleCount: 1,
  activeGuideCount: 1,
  guides: [
    {
      guideId: "dialog",
      retrieveCommand: "npx modern-web-guidance retrieve dialog",
      count: 2,
      rules: [
        {
          ruleId: "native-dialog",
          summary: "Use <dialog> instead of a hand-rolled modal.",
          count: 2,
          findings: [
            { file: "src/ui.ts", line: 10, message: "Hand-rolled modal.", lineContent: "div.modal" },
            { file: "src/ui.ts", line: 42, message: "Missing dialog semantics.", lineContent: "role=dialog" },
          ],
        },
      ],
    },
  ],
};

describe("adaptLegacyScan", () => {
  test("flattens guides/rules/findings into coded warnings", () => {
    const settings = providerConfig("fake") .lintProviders[0]!;
    const findings = adaptLegacyScan(settings, LEGACY_PAYLOAD, "/tmp/project");
    expect(findings).toHaveLength(2);
    expect(findings[0]?.code).toBe("LINT_PROVIDER_FINDING");
    expect(findings[0]?.severity).toBe("warning");
    expect(findings[0]?.file).toBe("src/ui.ts");
    expect(findings[0]?.line).toBe(10);
    expect(findings[0]?.hint).toContain("retrieve dialog");
  });

  test("failOn=error maps to error severity and failOn=none to info", () => {
    const errorSettings = providerConfig("fake", { failOn: "error" }).lintProviders[0]!;
    const infoSettings = providerConfig("fake", { failOn: "none" }).lintProviders[0]!;
    expect(adaptLegacyScan(errorSettings, LEGACY_PAYLOAD, "/tmp")[0]?.severity).toBe("error");
    expect(adaptLegacyScan(infoSettings, LEGACY_PAYLOAD, "/tmp")[0]?.severity).toBe("info");
  });

  test("rejects a non-legacy-scan payload", () => {
    const settings = providerConfig("fake").lintProviders[0]!;
    expect(() => adaptLegacyScan(settings, { nope: true }, "/tmp")).toThrow(/guides/);
  });
});

describe("adaptJsonFindings", () => {
  test("accepts an array or {findings} object and keeps file/line/code hints", () => {
    const settings = providerConfig("fake", { adapter: "json-findings" }).lintProviders[0]!;
    const findings = adaptJsonFindings(
      settings,
      { findings: [{ file: "a.ts", line: 3, code: "X1", message: "bad" }, { message: "global" }] },
      "/tmp"
    );
    expect(findings).toHaveLength(2);
    expect(findings[0]?.file).toBe("a.ts");
    expect(findings[0]?.line).toBe(3);
    expect(findings[0]?.hint).toContain("X1");
  });
});

describe("runLintProviders", () => {
  test("refuses to run when project commands are untrusted", () => {
    const root = makeRoot();
    try {
      const report = runLintProviders(root, providerConfig("echo should-not-run"), { allowCommands: false, allowUnsafeCommands: false });
      expect(report.providers[0]?.ran).toBe(false);
      expect(report.providers[0]?.skippedReason).toBe("untrusted");
      expect(report.findings.some((item) => item.code === "LINT_PROVIDER_REFUSED")).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  posixTest("runs an authorized legacy-scan provider and appends an audit record", () => {
    const root = makeRoot();
    try {
      const scanner = join(root, "scanner.sh");
      writeFileSync(scanner, `#!/bin/sh\ncat <<'JSON'\n${JSON.stringify(LEGACY_PAYLOAD)}\nJSON\n`);
      chmodSync(scanner, 0o755);
      const report = runLintProviders(root, providerConfig("./scanner.sh {path}"), {
        allowCommands: true,
        allowUnsafeCommands: false,
      });
      expect(report.providers[0]?.ran).toBe(true);
      expect(report.providers[0]?.exitCode).toBe(0);
      expect(report.findings).toHaveLength(2);
      expect(report.findings[0]?.code).toBe("LINT_PROVIDER_FINDING");
      const audit = readFileSync(join(root, ".mygrace", "audit.log"), "utf-8");
      expect(audit).toContain("\"action\":\"lint-provider\"");
      expect(audit).toContain("\"provider\":\"fake-scanner\"");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("denies dangerous provider commands without --allow-unsafe-commands", () => {
    const root = makeRoot();
    try {
      const report = runLintProviders(root, providerConfig("rm -rf {path}"), {
        allowCommands: true,
        allowUnsafeCommands: false,
      });
      expect(report.providers[0]?.ran).toBe(false);
      expect(report.providers[0]?.skippedReason).toBe("denied");
      expect(report.findings.some((item) => item.code === "LINT_PROVIDER_DENIED")).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  posixTest("invalid JSON becomes a warning, never a crash", () => {
    const root = makeRoot();
    try {
      const scanner = join(root, "bad.sh");
      writeFileSync(scanner, "#!/bin/sh\necho not-json\n");
      chmodSync(scanner, 0o755);
      const report = runLintProviders(root, providerConfig("./bad.sh"), { allowCommands: true, allowUnsafeCommands: false });
      expect(report.providers[0]?.ran).toBe(true);
      expect(report.findings.some((item) => item.code === "LINT_PROVIDER_INVALID_OUTPUT")).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("ci integration", () => {
  posixTest("ci merges authorized provider findings into the gate", () => {
    const fixture = join(import.meta.dir, "fixtures", "mygrace-project");
    const root = mkdtempSync(join(tmpdir(), "mygrace-ci-provider-"));
    try {
      cpSync(fixture, root, { recursive: true });
      const scanner = join(root, "scanner.sh");
      writeFileSync(scanner, `#!/bin/sh
cat <<'JSON'
${JSON.stringify(LEGACY_PAYLOAD)}
JSON
`);
      chmodSync(scanner, 0o755);
      writeFileSync(
        join(root, "mygrace.config.json"),
        JSON.stringify({
          allowCommands: true,
          lintProviders: [
            { name: "legacy-web", adapter: "legacy-scan", command: "./scanner.sh {path}", failOn: "warning" },
          ],
        })
      );
      const result = runCiGate(root, { allowCommands: true });
      const providerFindings = result.findings.filter((item) => item.code === "LINT_PROVIDER_FINDING");
      expect(providerFindings).toHaveLength(2);
      expect(providerFindings[0]?.severity).toBe("warning");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
