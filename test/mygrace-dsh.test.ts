/**
 * Honesty tests for the optional DSH packages (ROADMAP ADR-7, W1.4).
 *
 * v1 advertised `install-dsh --bundle` as a supported path although the bundle
 * cannot work from a registry install (unpublished file: dependencies, private
 * panel, unresolved @deepseek-ai peer). v1.1 removed `--bundle` from the CLI and
 * demoted the bundle to an explicit unpublished preview. Wave 4.1 turned the
 * sidebar panel into a LIVE card (host route /api/mygrace.status + polling
 * browser card); it keeps its opt-in/private status.
 */

import { describe, test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import YAML from "yaml";
import { apply, inject, name, resolveBun, resolveMcpConfig, resolveMcpEntry } from "../packages/mygrace-dsh/lib/index.js";

const ROOT = join(import.meta.dirname, "..");
const DSH_PKG = join(ROOT, "packages", "mygrace-dsh");
const PANEL_PKG = join(ROOT, "packages", "mygrace-status-panel");

function readJson(path: string): Record<string, any> {
  return JSON.parse(readFileSync(path, "utf-8")) as Record<string, any>;
}

describe("mygrace-dsh host plugin (unpublished preview)", () => {
  test("name is mygrace-dsh, injects tools", () => {
    expect(name).toBe("mygrace-dsh");
    expect(inject).toEqual(["tools"]);
  });

  test("resolveMcpEntry finds src/grace-mcp.ts in the checkout", () => {
    expect(resolveMcpEntry()).toBe(join(ROOT, "src", "grace-mcp.ts"));
  });

  test("resolveMcpConfig returns the stdio MCP config", () => {
    const config = resolveMcpConfig();
    expect(config).toBeDefined();
    expect(config?.transport).toBe("stdio");
    expect(config?.serverName).toBe("mygrace");
    expect(config?.command).toBe(resolveBun());
    const normalizedArgs = (config?.args ?? []).map((arg) => arg.replaceAll("\\", "/"));
    expect(normalizedArgs.slice(0, 2)).toEqual(["run", expect.stringContaining("src/grace-mcp.ts")]);
  });

  test("resolveBun returns a non-empty string", () => {
    expect(typeof resolveBun()).toBe("string");
    expect(resolveBun().length).toBeGreaterThan(0);
  });

  test("apply warns instead of throwing when the MCP client is not resolvable here", async () => {
    const warnings: string[] = [];
    const calls: any[] = [];
    const ctx = {
      logger: { warn: (message: string) => warnings.push(message) },
      plugin: async (plugin: any, config: any) => { calls.push({ plugin, config }); },
    };
    await apply(ctx as any, {});
    // In the repo, @deepseek-ai/dsh-mcp-client is not resolvable, so no mount
    // happens and the warning explains it (never a raw stack trace).
    if (calls.length > 0) {
      expect(calls[0].config.serverName).toBe("mygrace");
      expect(calls[0].config.args[1]).toBe(join(ROOT, "src", "grace-mcp.ts"));
    } else {
      expect(warnings.join("\n")).toContain("preview");
    }
  });

  test("package is private and explicitly labelled an unpublished preview", () => {
    const pkg = readJson(join(DSH_PKG, "package.json"));
    expect(pkg.name).toBe("mygrace-dsh");
    expect(pkg.private).toBe(true); // cannot be published accidentally
    expect(pkg.description).toContain("UNPUBLISHED PREVIEW");
    expect(pkg.description).toContain("NOT installed by `mygrace setup install`");
    const readme = readFileSync(join(DSH_PKG, "README.md"), "utf-8");
    expect(readme).toContain("UNPUBLISHED OPTIONAL PREVIEW");
    expect(readme).toContain("not installed by the CLI");
    expect(readme).not.toContain("bun run src/grace.ts setup install --bundle");
  });

  test("bundle patch is valid YAML with the four preview rows", () => {
    const doc = YAML.parse(readFileSync(join(DSH_PKG, "cordis.patch.yml"), "utf-8")) as Array<Record<string, any>>;
    expect(Array.isArray(doc)).toBe(true);
    const ids = doc.flatMap((row) => row.insert ?? [row]).map((entry) => entry.id);
    expect(ids).toEqual(["mygrace-host", "mygrace-skills", "mygrace-rtk", "mygrace-panel"]);
  });
});

describe("mygrace-status-panel (LIVE card, opt-in/private)", () => {
  test("is private (never published) and documented as LIVE, not decorative", () => {
    const pkg = readJson(join(PANEL_PKG, "package.json"));
    expect(pkg.private).toBe(true);
    expect(pkg.description).toContain("LIVE");
    expect(pkg.description).toContain("/api/mygrace.status");
    expect(pkg.description.toLowerCase()).not.toContain("decorative");
    const readme = readFileSync(join(PANEL_PKG, "README.md"), "utf-8");
    expect(readme).toContain("LIVE");
    expect(readme.toLowerCase()).not.toContain("decorative placeholder");
    expect(readme).not.toContain("does **not** read project data");
  });

  test("dsh.client.inject has no stale @deepseek-ai/dsh-client-runtime entry", () => {
    const pkg = readJson(join(PANEL_PKG, "package.json"));
    expect(pkg.dsh.client.platform).toBe("web");
    expect(pkg.dsh.client.inject).toEqual(["@deepseek-ai/dsh-client-ui-sidebar"]);
    expect(pkg.dsh.client.inject).not.toContain("@deepseek-ai/dsh-client-runtime");
  });

  test("client bundle keeps the DSH factory contract and fetches the live route", () => {
    const client = readFileSync(join(PANEL_PKG, "lib", "client.js"), "utf-8");
    expect(client).toContain("window.__ModuleLoader__.load({");
    expect(client).toContain('id: "mygrace-status-panel"');
    expect(client).toContain("ctx.slots.inject(\"sidebar.footer.action\"");
    expect(client).toContain("/api/mygrace.status");
    expect(client).toContain("fetch(STATUS_ROUTE");
    expect(client).toContain("not connected");
    expect(client).not.toContain("Decorative placeholder");
    expect(client).not.toContain("Graph-first workflow is active in this workspace.");
  });

  test("host half registers the live route and the package exports a ./client bundle", () => {
    const host = readFileSync(join(PANEL_PKG, "lib", "index.js"), "utf-8");
    expect(host).not.toContain("export function apply() {}");
    expect(host).toContain("connection.fetch.register");
    expect(host).toContain("PANEL_ROUTE_PATH");
    const pkg = readJson(join(PANEL_PKG, "package.json"));
    expect(pkg.exports["./client"]).toBe("./lib/client.js");
    expect(pkg.files).toContain("lib/client.js");
    expect(pkg.files).toContain("lib/status-payload.js");
  });
});
