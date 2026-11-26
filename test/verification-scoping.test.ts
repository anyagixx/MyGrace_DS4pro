/**
 * Verification scoping policy (v3.5.0).
 *
 * Every verification entry must declare at least one test file and a scoped
 * command that names those files; a bare `bun test` would run the whole suite
 * and make `mygrace verify --module` meaningless. This test turns the audit
 * finding into an enforced invariant.
 */

import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseCheckCommands, parseTestFiles } from "../src/grace-test";

const ROOT = join(import.meta.dir, "..");
const VERIFICATION_DIR = join(ROOT, "docs", "verification");

describe("verification scoping policy", () => {
  const files = readdirSync(VERIFICATION_DIR).filter((file) => /^V-M-.*\.xml$/.test(file));

  test("every verification declares test files and a scoped command", () => {
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      const content = readFileSync(join(VERIFICATION_DIR, file), "utf-8");
      const testFiles = parseTestFiles(content);
      const commands = parseCheckCommands(content);
      expect({ file, testFiles: testFiles.length }).toMatchObject({ testFiles: expect.any(Number) });
      expect(testFiles.length).toBeGreaterThan(0);
      expect(commands.length).toBeGreaterThan(0);
      expect(commands[0]).not.toBe("bun test");
      for (const testFile of testFiles) {
        expect(existsSync(join(ROOT, testFile))).toBe(true);
        expect(commands[0]).toContain(testFile);
      }
    }
  });
});
