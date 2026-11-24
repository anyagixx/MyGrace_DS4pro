import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CONFIG_FILENAME,
  DEFAULT_CONFIG,
  cloneDefault,
  configPath,
  loadConfig,
  serializeConfig,
  tryLoadConfig,
} from "../src/grace-config";
import { ConfigError } from "../src/grace-errors";

// ─── helpers ────────────────────────────────────────────────────────────

function withProject(config: string | undefined, run: (root: string) => void): void {
  const root = mkdtempSync(join(tmpdir(), "mygrace-config-"));
  try {
    if (config !== undefined) writeFileSync(join(root, CONFIG_FILENAME), config);
    run(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function expectConfigError(config: string, fragments: string[]): ConfigError {
  let caught: unknown;
  withProject(config, (root) => {
    try {
      loadConfig(root);
    } catch (error) {
      caught = error;
    }
  });
  expect(caught).toBeInstanceOf(ConfigError);
  const error = caught as ConfigError;
  expect(error.code).toBe("CONFIG_INVALID");
  expect(error.exitCode).toBe(2);
  expect(error.file).toBe(CONFIG_FILENAME);
  for (const fragment of fragments) expect(error.hint ?? "").toContain(fragment);
  return error;
}

// ─── defaults ──────────────────────────────────────────────────────────

describe("loadConfig() defaults", () => {
  test("a missing config file is not an error — v1-compatible defaults apply", () => {
    withProject(undefined, (root) => {
      const result = loadConfig(root);
      expect(result.config).toEqual(DEFAULT_CONFIG);
      expect(result.path).toBeUndefined();
      expect(result.raw).toBeUndefined();
    });
  });

  test("defaults match the documented budgets and caps (ADR-5)", () => {
    expect(DEFAULT_CONFIG.indexCaps).toEqual({ graph: 100, plan: 50, verification: 80 });
    expect(DEFAULT_CONFIG.sizeBudgets).toEqual({
      module: [30, 80],
      phase: [50, 200],
      verification: [20, 60],
    });
    expect(DEFAULT_CONFIG.sourceDirs).toContain("src");
    expect(DEFAULT_CONFIG.markupExts).toContain(".ts");
    expect(DEFAULT_CONFIG.markupExts).toContain(".py");
    expect(DEFAULT_CONFIG.ignoreDirs).toContain("node_modules");
    expect(DEFAULT_CONFIG.allowCommands).toBe(false);
  });

  test("cloneDefault() is a deep copy", () => {
    const clone = cloneDefault();
    clone.sourceDirs.push("extra");
    clone.indexCaps.graph = 999;
    (clone.sizeBudgets.module as unknown as number[])[0] = 1;
    expect(DEFAULT_CONFIG.sourceDirs).not.toContain("extra");
    expect(DEFAULT_CONFIG.indexCaps.graph).toBe(100);
    expect(DEFAULT_CONFIG.sizeBudgets.module[0]).toBe(30);
  });

  test("configPath() points at the project-root config file", () => {
    expect(configPath("/proj")).toBe(join("/proj", "mygrace.config.json"));
  });
});

// ─── valid overrides ───────────────────────────────────────────────────

describe("loadConfig() valid overrides", () => {
  test("applies every supported field and keeps defaults for omitted ones", () => {
    const config = {
      sourceDirs: ["app", "pkg"],
      markupExts: [".ts", ".py"],
      ignoreDirs: ["node_modules", "generated"],
      indexCaps: { graph: 120, plan: 60, verification: 90 },
      sizeBudgets: { module: [25, 70], phase: [40, 180], verification: [15, 50] },
      testRunner: "pytest -q",
      allowCommands: true,
      language: "python",
    };
    withProject(JSON.stringify(config), (root) => {
      const result = loadConfig(root);
      expect(result.config.sourceDirs).toEqual(["app", "pkg"]);
      expect(result.config.markupExts).toEqual([".ts", ".py"]);
      expect(result.config.ignoreDirs).toEqual(["node_modules", "generated"]);
      expect(result.config.indexCaps).toEqual({ graph: 120, plan: 60, verification: 90 });
      expect(result.config.sizeBudgets).toEqual({
        module: [25, 70],
        phase: [40, 180],
        verification: [15, 50],
      });
      expect(result.config.testRunner).toBe("pytest -q");
      expect(result.config.allowCommands).toBe(true);
      expect(result.config.language).toBe("python");
      expect(result.path).toBe(join(root, CONFIG_FILENAME));
      expect(result.raw).toEqual(config);
    });
  });

  test("a partial config keeps the default for every unspecified field", () => {
    withProject(JSON.stringify({ sourceDirs: ["app"] }), (root) => {
      const result = loadConfig(root);
      expect(result.config.sourceDirs).toEqual(["app"]);
      expect(result.config.indexCaps).toEqual(DEFAULT_CONFIG.indexCaps);
      expect(result.config.sizeBudgets).toEqual(DEFAULT_CONFIG.sizeBudgets);
      expect(result.config.testRunner).toBe(DEFAULT_CONFIG.testRunner);
    });
  });
});

// ─── invalid files ─────────────────────────────────────────────────────

describe("loadConfig() malformed files", () => {
  test("invalid JSON raises a ConfigError naming the file", () => {
    let caught: unknown;
    withProject("{ not json", (root) => {
      try {
        loadConfig(root);
      } catch (error) {
        caught = error;
      }
    });
    expect(caught).toBeInstanceOf(ConfigError);
    expect((caught as ConfigError).message).toContain(`Cannot parse ${CONFIG_FILENAME}`);
  });

  test("non-object JSON is rejected", () => {
    for (const content of ["null", "[]", '"text"', "42", "true"]) {
      let caught: unknown;
      withProject(content, (root) => {
        try {
          loadConfig(root);
        } catch (error) {
          caught = error;
        }
      });
      expect(caught).toBeInstanceOf(ConfigError);
      const error = caught as ConfigError;
      expect(error.code).toBe("CONFIG_INVALID");
      expect(error.message).toContain("must contain a JSON object");
    }
  });

  test("unknown top-level keys are listed with the allowed set", () => {
    const error = expectConfigError(JSON.stringify({ nope: true }), ['unknown key "nope"', "allowed:"]);
    expect(error.message).toContain("1 problem(s)");
  });
});

describe("loadConfig() invalid field values (ConfigError lists every issue)", () => {
  const cases: Array<{ name: string; config: unknown; fragment: string }> = [
    { name: "sourceDirs not an array", config: { sourceDirs: "src" }, fragment: '"sourceDirs" must be an array' },
    { name: "sourceDirs with empty string", config: { sourceDirs: ["src", ""] }, fragment: '"sourceDirs" must be an array' },
    { name: "sourceDirs with non-string", config: { sourceDirs: [1] }, fragment: '"sourceDirs" must be an array' },
    { name: "markupExts not an array", config: { markupExts: {} }, fragment: '"markupExts" must be an array' },
    { name: "ignoreDirs with blank entry", config: { ignoreDirs: ["dist", "  "] }, fragment: '"ignoreDirs" must be an array' },
    { name: "testRunner not a string", config: { testRunner: 42 }, fragment: '"testRunner" must be a non-empty string' },
    { name: "testRunner blank", config: { testRunner: "   " }, fragment: '"testRunner" must be a non-empty string' },
    { name: "allowCommands not boolean", config: { allowCommands: "yes" }, fragment: '"allowCommands" must be a boolean' },
    { name: "language not a string", config: { language: [] }, fragment: '"language" must be a non-empty string' },
    { name: "language blank", config: { language: " " }, fragment: '"language" must be a non-empty string' },
  ];

  for (const item of cases) {
    test(item.name, () => {
      expectConfigError(JSON.stringify(item.config), [item.fragment]);
    });
  }

  const indexCapCases: Array<{ name: string; value: unknown; fragment: string }> = [
    { name: "indexCaps not an object", value: [], fragment: '"indexCaps" must be an object' },
    { name: "graph not positive", value: { graph: 0 }, fragment: '"indexCaps.graph" must be a positive integer' },
    { name: "graph negative", value: { graph: -5 }, fragment: '"indexCaps.graph" must be a positive integer' },
    { name: "graph fractional", value: { graph: 1.5 }, fragment: '"indexCaps.graph" must be a positive integer' },
    { name: "graph string", value: { graph: "100" }, fragment: '"indexCaps.graph" must be a positive integer' },
    { name: "unknown cap key", value: { bogus: 1 }, fragment: 'unknown indexCaps key "bogus"' },
  ];

  for (const item of indexCapCases) {
    test(item.name, () => {
      expectConfigError(JSON.stringify({ indexCaps: item.value }), [item.fragment]);
    });
  }

  const sizeBudgetCases: Array<{ name: string; value: unknown; fragment: string }> = [
    { name: "sizeBudgets not an object", value: [], fragment: '"sizeBudgets" must be an object' },
    { name: "pair too short", value: { module: [10] }, fragment: '"sizeBudgets.module" must be [min, max]' },
    { name: "pair too long", value: { module: [10, 20, 30] }, fragment: '"sizeBudgets.module" must be [min, max]' },
    { name: "min greater than max", value: { module: [80, 30] }, fragment: '"sizeBudgets.module" must be [min, max]' },
    { name: "zero minimum", value: { module: [0, 30] }, fragment: '"sizeBudgets.module" must be [min, max]' },
    { name: "fractional values", value: { module: [1.5, 30] }, fragment: '"sizeBudgets.module" must be [min, max]' },
    { name: "string values", value: { module: ["1", 30] }, fragment: '"sizeBudgets.module" must be [min, max]' },
    { name: "unknown budget key", value: { bogus: [1, 2] }, fragment: 'unknown sizeBudgets key "bogus"' },
  ];

  for (const item of sizeBudgetCases) {
    test(item.name, () => {
      expectConfigError(JSON.stringify({ sizeBudgets: item.value }), [item.fragment]);
    });
  }

  test("aggregates multiple independent issues in one error", () => {
    const error = expectConfigError(
      JSON.stringify({ nope: true, testRunner: "", sizeBudgets: { module: [90, 10] } }),
      ['unknown key "nope"', '"testRunner"', '"sizeBudgets.module"']
    );
    expect(error.message).toContain("3 problem(s)");
    expect((error.hint ?? "").split("; ").length).toBe(3);
  });
});

// ─── non-throwing variant & serialization ──────────────────────────────

describe("tryLoadConfig()", () => {
  test("returns ok:true with defaults when the file is absent", () => {
    withProject(undefined, (root) => {
      const result = tryLoadConfig(root);
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error("expected ok");
      expect(result.result.config).toEqual(DEFAULT_CONFIG);
    });
  });

  test("returns ok:false with the ConfigError for an invalid file", () => {
    withProject(JSON.stringify({ testRunner: 1 }), (root) => {
      const result = tryLoadConfig(root);
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("expected failure");
      expect(result.error).toBeInstanceOf(ConfigError);
      expect(result.error.hint).toContain('"testRunner"');
    });
  });
});

describe("serializeConfig()", () => {
  test("emits stable 2-space JSON with a trailing newline", () => {
    const text = serializeConfig(DEFAULT_CONFIG);
    expect(text.endsWith("\n")).toBe(true);
    expect(text).toBe(`${JSON.stringify(DEFAULT_CONFIG, null, 2)}\n`);
    expect(JSON.parse(text)).toEqual(DEFAULT_CONFIG);
  });
});

// ─── Optional integrations config (ADR-9, v1.4) ────────────────────────

describe("loadConfig() integrations", () => {
  test("defaults match the documented tested ranges", () => {
    expect(DEFAULT_CONFIG.integrations.octocode).toEqual({
      enabled: "auto",
      bin: null,
      versionRange: ">=0.29 <0.30",
      timeoutMs: 10_000,
    });
    expect(DEFAULT_CONFIG.integrations.archify.versionRange).toBe(">=3.3 <4");
    expect(DEFAULT_CONFIG.integrations.archify.outputDir).toBe(join("docs", "diagrams"));
    expect(DEFAULT_CONFIG.integrations.capsules).toEqual({
      enabled: false,
      dir: "capsules",
      allowMutatingPrograms: false,
    });
  });

  test("a partial override keeps every other default", () => {
    withProject(JSON.stringify({ integrations: { octocode: { timeoutMs: 5_000 } } }), (root) => {
      const result = loadConfig(root);
      expect(result.config.integrations.octocode.timeoutMs).toBe(5_000);
      expect(result.config.integrations.octocode.versionRange).toBe(DEFAULT_CONFIG.integrations.octocode.versionRange);
      expect(result.config.integrations.octocode.enabled).toBe("auto");
      expect(result.config.integrations.archify).toEqual(DEFAULT_CONFIG.integrations.archify);
      expect(result.config.integrations.capsules).toEqual(DEFAULT_CONFIG.integrations.capsules);
    });
  });

  test("every documented field can be overridden", () => {
    const config = {
      integrations: {
        octocode: { enabled: false, bin: "/opt/octocode", versionRange: ">=0.30 <0.31", timeoutMs: 12_000 },
        archify: { enabled: true, bin: "tools/archify.mjs", versionRange: ">=3.4 <4", timeoutMs: 40_000, outputDir: "artifacts/diagrams" },
        capsules: { enabled: "auto", dir: "runbooks", allowMutatingPrograms: true },
      },
    };
    withProject(JSON.stringify(config), (root) => {
      const result = loadConfig(root);
      expect(result.config.integrations.octocode).toEqual({
        enabled: false,
        bin: "/opt/octocode",
        versionRange: ">=0.30 <0.31",
        timeoutMs: 12_000,
      });
      expect(result.config.integrations.archify).toEqual({
        enabled: true,
        bin: "tools/archify.mjs",
        versionRange: ">=3.4 <4",
        timeoutMs: 40_000,
        outputDir: "artifacts/diagrams",
      });
      expect(result.config.integrations.capsules).toEqual({ enabled: "auto", dir: "runbooks", allowMutatingPrograms: true });
    });
  });

  test("serializeConfig() round-trips the integrations block", () => {
    const serialized = JSON.parse(serializeConfig(cloneDefault())) as { integrations?: unknown };
    expect(serialized.integrations).toEqual(DEFAULT_CONFIG.integrations);
  });

  test("invalid integrations shapes are reported together", () => {
    expectConfigError(JSON.stringify({ integrations: [] }), [
      '"integrations" must be an object with octocode/archify/capsules entries',
    ]);
    expectConfigError(JSON.stringify({ integrations: { bogus: {} } }), ['unknown integrations key "bogus"']);
    expectConfigError(JSON.stringify({ integrations: { octocode: "yes" } }), ['"integrations.octocode" must be an object']);
    expectConfigError(JSON.stringify({ integrations: { octocode: { nope: 1 } } }), [
      'unknown integrations.octocode key "nope"',
    ]);
    expectConfigError(JSON.stringify({ integrations: { octocode: { enabled: "sometimes" } } }), [
      '"integrations.octocode.enabled" must be "auto", true or false',
    ]);
    expectConfigError(JSON.stringify({ integrations: { octocode: { bin: "" } } }), [
      '"integrations.octocode.bin" must be a non-empty string or null',
    ]);
    expectConfigError(JSON.stringify({ integrations: { octocode: { versionRange: "latest" } } }), [
      '"integrations.octocode.versionRange" must be a range like ">=0.29 <0.30"',
    ]);
    expectConfigError(JSON.stringify({ integrations: { octocode: { timeoutMs: 5 } } }), [
      '"integrations.octocode.timeoutMs" must be an integer between 100 and 600000',
    ]);
    expectConfigError(JSON.stringify({ integrations: { archify: { outputDir: " " } } }), [
      '"integrations.archify.outputDir" must be a non-empty string',
    ]);
    expectConfigError(JSON.stringify({ integrations: { capsules: { dir: "" } } }), [
      '"integrations.capsules.dir" must be a non-empty string',
    ]);
    expectConfigError(JSON.stringify({ integrations: { capsules: { allowMutatingPrograms: "yes" } } }), [
      '"integrations.capsules.allowMutatingPrograms" must be a boolean',
    ]);
  });
});
