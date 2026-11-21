import { describe, test, expect } from "bun:test";
import { apply, inject, name, rewriteForRtk } from "../packages/dsh-mygrace-rtk/lib/index.js";

describe("rewriteForRtk", () => {
  test("prefixes known command tokens", () => {
    expect(rewriteForRtk("git status")).toBe("rtk git status");
    expect(rewriteForRtk("npm test")).toBe("rtk npm test");
    expect(rewriteForRtk("bun test src/a.test.ts")).toBe("rtk bun test src/a.test.ts");
    expect(rewriteForRtk("/usr/bin/git status")).toBe("rtk /usr/bin/git status");
  });

  test("no rewrite for non-matching commands, non-strings, already rtk", () => {
    expect(rewriteForRtk("echo hello")).toBeUndefined();
    expect(rewriteForRtk("tmux attach")).toBeUndefined();
    expect(rewriteForRtk("")).toBeUndefined();
    expect(rewriteForRtk("rtk git status")).toBeUndefined();
    expect(rewriteForRtk("git")).toBeUndefined();
    expect(rewriteForRtk(42)).toBeUndefined();
    expect(rewriteForRtk(null)).toBeUndefined();
  });

  test("honors rtkName override", () => {
    expect(rewriteForRtk("git status", "rtk2")).toBe("rtk2 git status");
    expect(rewriteForRtk("rtk2 git status", "rtk2")).toBeUndefined();
  });
});

describe("dsh-mygrace-rtk plugin", () => {
  test("name is dsh-mygrace-rtk, injects tools", () => {
    expect(name).toBe("dsh-mygrace-rtk");
    expect(inject).toEqual(["tools"]);
  });

  test("apply registers a tools/execute listener when rtk is available", async () => {
    const listeners: any[] = [];
    const ctx = { on: (event: string, fn: any) => { listeners.push(fn); } };
    apply(ctx as any, { rtkBinary: "/bin/rtk" });
    expect(listeners.length).toBeGreaterThan(0);
  });

  test("listener rewrites bash commands", async () => {
    const listeners: any[] = [];
    const ctx = { on: (event: string, fn: any) => { listeners.push(fn); } };
    apply(ctx as any, { rtkBinary: "/bin/rtk" });
    const listener = listeners[0];
    const next = async () => "result";
    const exec: any = { name: "bash", arguments: { command: "git status", description: "Show git status" } };
    const result = await listener(exec, next);
    expect(result).toBe("result");
    expect(exec.arguments.command).toBe("rtk git status");
    expect(exec.arguments.description).toBe("Show git status");
  });

  test("listener passes through non-bash tools", async () => {
    const listeners: any[] = [];
    const ctx = { on: (event: string, fn: any) => { listeners.push(fn); } };
    apply(ctx as any, { rtkBinary: "/bin/rtk" });
    const exec: any = { name: "read_file", arguments: { path: "/tmp/x" } };
    await listeners[0](exec, async () => "ok");
    expect(exec.arguments).toEqual({ path: "/tmp/x" });
  });

  test("no listener when rtk is missing and no override given", () => {
    const listeners: any[] = [];
    const ctx = { logger: { warn: () => {} }, on: (event: string, fn: any) => { listeners.push(fn); } };
    apply(ctx as any, {});
    expect(listeners.length).toBe(0);
  });

  test("enabled: false registers nothing", () => {
    const listeners: any[] = [];
    const ctx = { on: (event: string, fn: any) => { listeners.push(fn); } };
    apply(ctx as any, { rtkBinary: "/bin/rtk", enabled: false });
    expect(listeners.length).toBe(0);
  });
});
