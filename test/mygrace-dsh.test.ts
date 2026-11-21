import { describe, test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { apply, inject, resolveBun, resolveMcpConfig, resolveMcpEntry, name } from "../packages/mygrace-dsh/lib/index.js";

const ROOT = import.meta.dir + "/..";

describe("@osovv/mygrace-dsh host plugin", () => {
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
    expect(config?.args.slice(0, 2)).toEqual(["run", expect.stringContaining("src/grace-mcp.ts")]);
  });

  test("resolveBun returns a non-empty string", () => {
    expect(typeof resolveBun()).toBe("string");
    expect(resolveBun().length).toBeGreaterThan(0);
  });

  test("apply does not throw without a DSH MCP context (repo test env)", async () => {
    const calls: any[] = [];
    const ctx = {
      logger: { warn: () => {} },
      plugin: async (plugin: any, config: any) => { calls.push({ plugin, config }); },
    };
    await apply(ctx as any, {});
    // In the profile tree, ctx.plugin would be called; in this repo,
    // @deepseek-ai/dsh-mcp-client is not resolvable, so no call is expected.
    if (calls.length > 0) {
      expect(calls[0].config.serverName).toBe("mygrace");
      expect(calls[0].config.args[1]).toBe(join(ROOT, "src", "grace-mcp.ts"));
    }
  });
});

describe("mygrace-dsh bundle patch", () => {
  test("cordis.patch.yml contains the three rows", () => {
    const content = readFileSync(join(ROOT, "packages", "mygrace-dsh", "cordis.patch.yml"), "utf-8");
    expect(content).toContain("id: mygrace-host");
    expect(content).toContain("name: '@osovv/mygrace-dsh'");
    expect(content).toContain("id: mygrace-skills");
    expect(content).toContain("name: '@osovv/dsh-skill-mygrace'");
    expect(content).toContain("id: mygrace-panel");
    expect(content).toContain("name: 'mygrace-status-panel'");
  });
});
