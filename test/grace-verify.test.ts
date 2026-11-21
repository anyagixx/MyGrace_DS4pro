import { describe, test, expect } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { verifyCommand } from "../src/grace-verify";

function makeProject(checkCmd: string) {
  const root = mkdtempSync(join(tmpdir(), "mygrace-verify-"));
  mkdirSync(join(root, "docs", "modules"), { recursive: true });
  mkdirSync(join(root, "docs", "verification"), { recursive: true });
  writeFileSync(
    join(root, "docs", "graph-index.xml"),
    `<GraphIndex project="T" version="1.0.0">\n  <M-A NAME="A" TYPE="T" STATUS="done" />\n</GraphIndex>\n`
  );
  writeFileSync(join(root, "docs", "modules", "M-A.xml"), `<M-A><module-checks><check-1>${checkCmd}</check-1></module-checks></M-A>`);
  writeFileSync(join(root, "docs", "verification", "V-M-A.xml"), `<V-M-A><test-files><file>x.test.ts</file></test-files></V-M-A>`);
  return root;
}

async function runVerify(root: string): Promise<{ logs: string[]; exit: number }> {
  const logs: string[] = [];
  const orig = console.log;
  console.log = ((m?: unknown) => logs.push(String(m))) as typeof console.log;
  let exit = 0;
  const origExit = process.exit;
  process.exit = ((code?: number) => { exit = code ?? 0; throw new Error(`exit:${code}`); }) as never;
  try {
    await verifyCommand.run!({ args: { path: root } } as any);
  } catch {
    // exit stub throws; exit already recorded
  } finally {
    process.exit = origExit;
    console.log = orig;
  }
  return { logs, exit };
}

describe("verifyCommand", () => {
  test("ok module: prints Verify ok, no last-failures.md, exit 0", async () => {
    const root = makeProject("true");
    try {
      const { logs, exit } = await runVerify(root);
      expect(logs.join("")).toContain("Verify: 1 ok");
      expect(exit).toBe(0);
      expect(existsSync(join(root, ".mygrace", "last-failures.md"))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("failing module: prints digest, writes last-failures.md, exit 1", async () => {
    const root = makeProject("false");
    try {
      const { logs, exit } = await runVerify(root);
      expect(logs.join("")).toContain("FAILED");
      expect(exit).toBe(1);
      expect(existsSync(join(root, ".mygrace", "last-failures.md"))).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
