import { describe, test, expect } from "bun:test";
import { existsSync, readFileSync, mkdirSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  addPatchEntry,
  removePatchEntry,
  patchFileHasEntry,
  mcpPatchEntry,
  panelPatchEntry,
  installDshCommand,
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

describe("panel patch entry", () => {
  test("panelPatchEntry uses the insert form with the panel id", () => {
    const entry = panelPatchEntry();
    expect(entry.split("\n")[0]).toBe("- insert:");
    expect(entry).toContain("- id: mygrace-status-panel");
  });

  test("MCP and panel rows coexist and remove independently", () => {
    let content = "- insert:\n    - id: mcp-mygrace\n      name: '@deepseek-ai/dsh-mcp-client'\n";
    const withPanel = addPatchEntry(content, panelPatchEntry(), "mygrace-status-panel")!;
    expect(withPanel).toContain("mcp-mygrace");
    expect(withPanel).toContain("mygrace-status-panel");
    const withoutPanel = removePatchEntry(withPanel, "mygrace-status-panel")!;
    expect(withoutPanel).toContain("mcp-mygrace");
    expect(withoutPanel).not.toContain("mygrace-status-panel");
  });
});

// ─── install-dsh --dsh-home (R5) ────────────────────────────────────────

describe("install-dsh --dsh-home", () => {
  test("patches the fake home; idempotent; --uninstall removes rows and skills", async () => {
    const home = mkdtempSync(join(tmpdir(), "mygrace-fakehome-"));
    try {
      mkdirSync(join(home, "profiles", "web"), { recursive: true });
      const patchPath = join(home, "profiles", "web", "cordis.patch.yml");
      writeFileSync(patchPath, "[]\n");

      const install = () => installDshCommand.run!({ args: { dshHome: home, profile: "web" } } as any);
      await install();
      expect(readFileSync(patchPath, "utf-8")).toContain("id: mcp-mygrace");
      expect(existsSync(join(home, "skills", "mygrace-ask"))).toBe(true);

      await install(); // idempotent — second run must not duplicate the MCP row
      expect(readFileSync(patchPath, "utf-8").match(/id: mcp-mygrace/g)).toHaveLength(1);

      await installDshCommand.run!({ args: { dshHome: home, profile: "web", uninstall: true } } as any);
      expect(readFileSync(patchPath, "utf-8")).toContain("[]");
      expect(existsSync(join(home, "skills", "mygrace-ask"))).toBe(false);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
