/**
 * Trace-link policy (v3.5.0): every indexed module must be mentioned by at
 * least one requirement and one phase/step. This catches the audit's
 * NO_REQUIREMENT_LINK / NO_PHASE_LINK gaps without shelling out to `trace`.
 */

import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");

function moduleIds(): string[] {
  const graph = readFileSync(join(ROOT, "docs", "graph-index.xml"), "utf-8");
  return [...new Set(graph.match(/M-[A-Za-z0-9][A-Za-z0-9_-]*/g) ?? [])].sort();
}

describe("trace-link policy", () => {
  test("every module is mentioned by requirements and a phase", () => {
    const modules = moduleIds();
    expect(modules.length).toBeGreaterThan(0);
    const requirements = readFileSync(join(ROOT, "docs", "requirements.xml"), "utf-8");
    const planDir = join(ROOT, "docs", "plans");
    const phases = readdirSync(planDir)
      .filter((file) => file.endsWith(".xml"))
      .map((file) => readFileSync(join(planDir, file), "utf-8"))
      .join("\n");
    for (const id of modules) {
      expect({ id, requirements: requirements.includes(id) }).toMatchObject({ requirements: true });
      expect({ id, phase: phases.includes(id) }).toMatchObject({ phase: true });
    }
  });
});
