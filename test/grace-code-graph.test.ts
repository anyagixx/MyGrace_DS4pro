/**
 * MyGRACE — Octocode code-graph adapter tests (W5.1, ADR-9).
 *
 * Two layers:
 *   - pure parsers (`parseGraphRelationships`, `parseViewSignatures`) against
 *     recorded fixture payloads — cross-platform, no subprocess;
 *   - the real adapter against a fake `octocode` MCP executable
 *     (`test/fixtures/octocode/fake-octocode.ts`) — POSIX only, because the
 *     wrapper is a `#!/bin/sh` script. No network, no real Octocode.
 */

import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cloneDefault } from "../src/grace-config";
import { collectFileSymbols, collectImportEdges, parseGraphRelationships, parseViewSignatures } from "../src/grace-code-graph";
import { makeFakeOctocode } from "./fixtures/octocode/fake-octocode";

const FIXTURES = join(import.meta.dir, "fixtures", "octocode");
const RELATIONSHIPS = JSON.parse(readFileSync(join(FIXTURES, "graphrag-get-relationships.json"), "utf8")) as unknown;
const SIGNATURES = JSON.parse(readFileSync(join(FIXTURES, "view-signatures.json"), "utf8")) as unknown;
const POSIX_ONLY = process.platform !== "win32";

function makeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "mygrace-code-graph-"));
  for (const file of ["src/a/index.ts", "src/b/index.ts", "src/c/index.ts"]) {
    const absolute = join(root, file);
    mkdirSync(join(absolute, ".."), { recursive: true });
    writeFileSync(absolute, "// fixture\n");
  }
  return root;
}

function neutralEnv(root: string): NodeJS.ProcessEnv {
  return { PATH: "", HOME: root, TMPDIR: tmpdir() };
}

function fakeConfig(bin: string, timeoutMs = 5_000) {
  const config = cloneDefault();
  config.integrations.octocode.bin = bin;
  config.integrations.octocode.timeoutMs = timeoutMs;
  return config;
}

// ─── Pure parsers (cross-platform) ─────────────────────────────────────

describe("parseGraphRelationships", () => {
  test("keeps only plain file-level imports, dedupes and sorts", () => {
    const parsed = parseGraphRelationships(RELATIONSHIPS, {
      root: "/project",
      files: ["src/a/index.ts", "src/b/index.ts", "src/c/index.ts"],
    });
    expect(parsed.notes).toEqual([]);
    expect(parsed.edges).toEqual([
      { from: "src/a/index.ts", to: "src/b/index.ts", relation: "imports" },
      { from: "src/b/index.ts", to: "src/a/index.ts", relation: "imports" },
      { from: "src/c/index.ts", to: "src/a/index.ts", relation: "imports" },
    ]);
  });

  test("symbol endpoints, non-import relations and out-of-scope files are ignored", () => {
    const payload = [
      { source: "src/a/index.ts", target: "src/b/index.ts::helper", relation_type: "imports" },
      { source: "src/a/index.ts", target: "src/c/index.ts", relation_type: "calls" },
      { source: "src/outside/unknown.ts", target: "src/a/index.ts", relation_type: "imports" },
    ];
    const parsed = parseGraphRelationships(payload, { root: "/project", files: ["src/a/index.ts", "src/b/index.ts"] });
    expect(parsed.edges).toEqual([]);
  });

  test("invalid JSON and unexpected shapes become INTEGRATION_INVALID_OUTPUT notes", () => {
    const invalid = parseGraphRelationships("not-json{{", { root: "/project" });
    expect(invalid.edges).toEqual([]);
    expect(invalid.notes[0]).toContain("INTEGRATION_INVALID_OUTPUT");
    const shape = parseGraphRelationships({ nodes: [] }, { root: "/project" });
    expect(shape.notes[0]).toContain("INTEGRATION_INVALID_OUTPUT");
  });
});

describe("parseViewSignatures", () => {
  test("dedupes symbols per file and keeps every requested file present", () => {
    const parsed = parseViewSignatures(SIGNATURES, { root: "/project", files: ["src/a/index.ts", "src/b/index.ts"] });
    expect(parsed.files["src/a/index.ts"]).toEqual([
      { name: "alpha", kind: "function" },
      { name: "alphaHelper", kind: "function" },
      { name: "alphaThing", kind: "class" },
    ]);
    expect(parsed.files["src/b/index.ts"]).toEqual([{ name: "beta", kind: "function" }]);
    expect(parsed.files["src/c/index.ts"]).toBeUndefined();
  });

  test("invalid payload degrades to notes and empty symbol lists", () => {
    const parsed = parseViewSignatures("not-json{{", { root: "/project", files: ["src/a/index.ts"] });
    expect(parsed.files["src/a/index.ts"]).toEqual([]);
    expect(parsed.notes[0]).toContain("INTEGRATION_INVALID_OUTPUT");
  });
});

// ─── Adapter against the fake Octocode MCP server (POSIX only) ─────────

const posixTest = test.skipIf(!POSIX_ONLY);

describe("adapter degradation (no tool installed)", () => {
  test("collectImportEdges returns available:false + install hint", async () => {
    const root = makeRoot();
    try {
      const result = await collectImportEdges({
        root,
        config: cloneDefault(),
        files: ["src/a/index.ts"],
        env: { PATH: "", HOME: root, TMPDIR: tmpdir() },
      });
      expect(result.available).toBe(false);
      expect(result.edges).toEqual([]);
      expect(result.notes.join(" ")).toContain("Octocode");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  posixTest("collectImportEdges with an unsupported version does not spawn a session", async () => {
    const fake = makeFakeOctocode({ version: "0.28.0" });
    const root = makeRoot();
    try {
      const result = await collectImportEdges({
        root,
        config: fakeConfig(fake.bin),
        files: ["src/a/index.ts"],
        env: { PATH: "", HOME: root, TMPDIR: tmpdir() },
      });
      expect(result.available).toBe(false);
      expect(result.version).toBe("0.28.0");
    } finally {
      rmSync(root, { recursive: true, force: true });
      fake.cleanup();
    }
  });
});

describe("adapter against a fake MCP server", () => {
  posixTest("collectImportEdges returns deduped file-level import edges", async () => {
    const fake = makeFakeOctocode({ mode: "ok" });
    const root = makeRoot();
    try {
      const result = await collectImportEdges({
        root,
        config: fakeConfig(fake.bin),
        files: ["src/a/index.ts", "src/b/index.ts", "src/c/index.ts"],
        env: neutralEnv(root),
      });
      expect(result.available).toBe(true);
      expect(result.version).toBe("0.29.2");
      expect(result.edges).toEqual([
        { from: "src/a/index.ts", to: "src/b/index.ts", relation: "imports" },
        { from: "src/b/index.ts", to: "src/a/index.ts", relation: "imports" },
        { from: "src/c/index.ts", to: "src/a/index.ts", relation: "imports" },
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
      fake.cleanup();
    }
  });

  posixTest("collectFileSymbols resolves per-file signatures", async () => {
    const fake = makeFakeOctocode({ mode: "ok" });
    const root = makeRoot();
    try {
      const result = await collectFileSymbols({
        root,
        config: fakeConfig(fake.bin),
        files: ["src/a/index.ts", "src/b/index.ts"],
        env: neutralEnv(root),
      });
      expect(result.available).toBe(true);
      expect(result.files["src/a/index.ts"]?.map((symbol) => symbol.name)).toEqual(["alpha", "alphaHelper", "alphaThing"]);
      expect(result.files["src/b/index.ts"]?.map((symbol) => symbol.name)).toEqual(["beta"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
      fake.cleanup();
    }
  });

  posixTest("malformed tool JSON is a note, not a crash", async () => {
    const fake = makeFakeOctocode({ mode: "invalid" });
    const root = makeRoot();
    try {
      const result = await collectImportEdges({
        root,
        config: fakeConfig(fake.bin),
        files: ["src/a/index.ts"],
        env: neutralEnv(root),
      });
      expect(result.available).toBe(true);
      expect(result.edges).toEqual([]);
      expect(result.notes.join(" ")).toContain("INTEGRATION_INVALID_OUTPUT");
    } finally {
      rmSync(root, { recursive: true, force: true });
      fake.cleanup();
    }
  });

  posixTest("a server missing required read-only tools degrades to available:false", async () => {
    const fake = makeFakeOctocode({ mode: "tools-missing" });
    const root = makeRoot();
    try {
      const result = await collectImportEdges({
        root,
        config: fakeConfig(fake.bin),
        files: ["src/a/index.ts"],
        env: neutralEnv(root),
      });
      expect(result.available).toBe(false);
      expect(result.notes.join(" ")).toContain("read-only tool");
    } finally {
      rmSync(root, { recursive: true, force: true });
      fake.cleanup();
    }
  });

  posixTest("per-call timeout becomes a note instead of hanging the command", async () => {
    const fake = makeFakeOctocode({ mode: "timeout" });
    const root = makeRoot();
    try {
      const result = await collectImportEdges({
        root,
        config: fakeConfig(fake.bin, 300),
        files: ["src/a/index.ts"],
        env: neutralEnv(root),
      });
      expect(result.available).toBe(true);
      expect(result.edges).toEqual([]);
      expect(result.notes.join(" ")).toContain("INTEGRATION_TIMEOUT");
    } finally {
      rmSync(root, { recursive: true, force: true });
      fake.cleanup();
    }
  });
});
