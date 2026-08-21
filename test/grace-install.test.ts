import { describe, test, expect } from "bun:test";
import {
  addPatchEntry,
  removePatchEntry,
  patchFileHasEntry,
  mcpPatchEntry,
} from "../src/grace-install";

describe("addPatchEntry", () => {
  test("replaces an empty array literal with the entry", () => {
    const content = "# comment line\n[]\n";
    const next = addPatchEntry(content);
    expect(next).not.toBeNull();
    expect(next).toContain("- id: mcp-mygrace");
    expect(next).toContain("'@deepseek-ai/dsh-mcp-client'");
    expect(next).not.toMatch(/^\[\]$/m);
    expect(next).toContain("# comment line");
  });

  test("appends to a non-empty array", () => {
    const content = "- id: other-entry\n  name: 'x'\n";
    const next = addPatchEntry(content)!;
    expect(next.indexOf("- id: other-entry")).toBeLessThan(next.indexOf("- id: mcp-mygrace"));
    expect(next).toContain("serverName: mygrace");
  });

  test("is idempotent — a second call returns null", () => {
    const first = addPatchEntry("[]\n")!;
    expect(addPatchEntry(first)).toBeNull();
    expect(patchFileHasEntry(first)).toBe(true);
  });
});

describe("removePatchEntry", () => {
  test("removes the mygrace block and keeps other entries", () => {
    const content = [
      "- id: other-entry",
      "  name: 'x'",
      "- id: mcp-mygrace",
      "  name: '@deepseek-ai/dsh-mcp-client'",
      "  config:",
      "    transport: stdio",
      "- id: last-entry",
      "  name: 'y'",
      "",
    ].join("\n");
    const next = removePatchEntry(content)!;
    expect(next).toContain("- id: other-entry");
    expect(next).toContain("- id: last-entry");
    expect(next).not.toContain("mcp-mygrace");
    expect(next).not.toContain("transport: stdio");
  });

  test("returns null when the entry is absent", () => {
    expect(removePatchEntry("- id: other\n")).toBeNull();
  });

  test("round-trips: add then remove restores an empty array", () => {
    const original = "# keep me\n[]\n";
    const added = addPatchEntry(original)!;
    const removed = removePatchEntry(added)!;
    expect(removed.replace(/\n+$/g, "")).toBe(original.replace(/\n+$/g, ""));
  });
});

describe("mcpPatchEntry", () => {
  test("produces an insert-wrapped loader entry (required by the cordis loader)", () => {
    const entry = mcpPatchEntry();
    const lines = entry.split("\n");
    expect(lines[0]).toBe("- insert:");
    expect(lines[1]).toBe("    - id: mcp-mygrace");
    expect(entry).toContain("name: '@deepseek-ai/dsh-mcp-client'");
    expect(entry).toContain("transport: stdio");
    expect(entry).toContain("command: ");
    expect(entry).toContain("grace-mcp.ts");
    // no raw path leaks through unquoted
    for (const line of lines) {
      if (line.trim().startsWith("command:")) {
        expect(line).toContain("'");
      }
    }
  });

  test("removePatchEntry handles the canonical insert-wrapped form", () => {
    const content = [
      "- id: other-entry",
      "  name: 'x'",
      "- insert:",
      "    - id: mcp-mygrace",
      "      name: '@deepseek-ai/dsh-mcp-client'",
      "      config:",
      "        transport: stdio",
      "- id: last-entry",
      "  name: 'y'",
      "",
    ].join("\n");
    const next = removePatchEntry(content)!;
    expect(next).toContain("- id: other-entry");
    expect(next).toContain("- id: last-entry");
    expect(next).not.toContain("mcp-mygrace");
    expect(next).not.toContain("- insert:");
    expect(next).not.toContain("transport: stdio");
  });
});

// ─── buildStatusSnapshot ────────────────────────────────────────────────

import { buildStatusSnapshot } from "../src/grace-status";

describe("buildStatusSnapshot", () => {
  test("summarizes the fixture project", () => {
    const s = buildStatusSnapshot(import.meta.dir + "/fixtures/mygrace-project");
    expect(s.modules.total).toBe(2);
    expect(s.phases.total).toBeGreaterThan(0);
    expect(s.verifications.total).toBeGreaterThan(0);
    expect(s.lint.errors).toBe(0);
    expect(s.lint.warnings).toBe(0);
    expect(s.modules.byStatus["wip"]).toBe(1);
  });
});
