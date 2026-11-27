import { describe, test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { apply, inject, name, provider } from "../packages/dsh-skill-mygrace/lib/index.js";

const ROOT = import.meta.dirname + "/..";

describe("dsh-skill-mygrace provider", () => {
  test("name is the cordis plugin name, injects skills service", () => {
    expect(name).toBe("skill-mygrace");
    expect(inject).toEqual(["skills"]);
  });

  test("registers a provider on ctx.skills", () => {
    const calls: any[] = [];
    const ctx = { skills: { registerProvider: (fn: any) => { calls.push(fn); return {}; } } };
    apply(ctx as any);
    expect(calls).toHaveLength(1);
    expect(calls[0]()).toBe(provider);
  });

  test("provider.name is mygrace", () => {
    expect(provider.name).toBe("mygrace");
  });

  test("list() returns the 15 MyGRACE skills", async () => {
    const skills = await provider.list();
    expect(skills.length).toBe(15);
    for (const s of skills) {
      expect(s.name).toMatch(/^mygrace-[a-z0-9-]+$/);
      expect(s.provider).toBe("mygrace");
      expect(typeof s.description).toBe("string");
      expect(s.description.length).toBeGreaterThan(10);
      expect(typeof s.invocation.modelInvocable).toBe("boolean");
      expect(typeof s.invocation.userInvocable).toBe("boolean");
      expect(typeof s.rank).toBe("number");
    }
    expect(skills.map((s: any) => s.name)).toContain("mygrace-reviewer");
    expect(skills.map((s: any) => s.name)).toContain("mygrace-grilling");
    expect(skills.map((s: any) => s.name)).toContain("mygrace-domain-modeling");
    expect(skills.map((s: any) => s.name)).toContain("mygrace-show-me");
    const showMe = skills.find((s: any) => s.name === "mygrace-show-me")!;
    expect(showMe.invocation).toEqual({ modelInvocable: false, userInvocable: true });
  });

  test("grilling and domain-modeling skills carry the adapted MyGRACE workflow", async () => {
    for (const [name, marker] of [
      ["mygrace-grilling", "frontier"],
      ["mygrace-domain-modeling", "GLOSSARY.md"],
      ["mygrace-show-me", "Focused HTML artifacts"],
    ] as const) {
      const candidate = (await provider.list()).find((s) => s.name === name)!;
      const loaded = await provider.get(candidate as any);
      expect(loaded.content).toContain(marker);
      expect(loaded.content).toContain("MIT License");
      expect(loaded.content.length).toBeGreaterThan(1500);
      if (name === "mygrace-show-me") expect(loaded.invocation.modelInvocable).toBe(false);
    }
  });

  test("get() returns the skill file content", async () => {
    const candidate = (await provider.list()).find((s) => s.name === "mygrace-status")!;
    const loaded = await provider.get(candidate as any);
    expect(loaded.name).toBe("mygrace-status");
    // Content must be a real, loadable skill body — not a placeholder or a stale copy.
    expect(loaded.content).toContain("name: mygrace-status");
    expect(loaded.content).toContain("mygrace status");
    expect(loaded.content.length).toBeGreaterThan(400);
    expect(loaded.source).toBe("bundled");
  });

  test("package.json is the DSH skill-provider shape and says 15 skills", () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, "packages", "dsh-skill-mygrace", "package.json"), "utf-8"));
    expect(pkg.name).toBe("dsh-skill-mygrace");
    expect(pkg.files).toContain("assets");
    expect(pkg.description).toContain("15 MyGRACE skills");
    expect(pkg.private).not.toBe(true); // this one is meant to be publishable
  });
});

