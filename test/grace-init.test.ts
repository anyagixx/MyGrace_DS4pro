import { describe, test, expect } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { CONFIG_FILENAME, DEFAULT_CONFIG } from "../src/grace-config";

const REPO_ROOT = join(import.meta.dirname, "..");
const CLI = join(REPO_ROOT, "src", "grace.ts");

interface RunResult {
  status: number;
  stdout: string;
}

/** Run `mygrace setup init` in a throwaway directory. */
function runInit(path: string, extraArgs: string[] = []): RunResult {
  try {
    const stdout = execFileSync(process.execPath, ["run", CLI, "setup", "init", "--path", path, ...extraArgs], {
      encoding: "utf-8",
      env: { ...process.env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { status: 0, stdout };
  } catch (error) {
    const details = error as { status?: number; stdout?: string; stderr?: string };
    return { status: details.status ?? 1, stdout: `${details.stdout ?? ""}${details.stderr ?? ""}` };
  }
}

function withTempDir<T>(body: (dir: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), "mygrace-init-"));
  try {
    return body(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("setup init", () => {
  test("bootstraps docs indexes, AGENTS.md, config and a .gitignore", () => {
    withTempDir((project) => {
      const result = runInit(project, ["--name", "InitTest"]);
      expect(result.status).toBe(0);

      for (const relativePath of [
        "docs/graph-index.xml",
        "docs/plan-index.xml",
        "docs/verification-index.xml",
        "docs/requirements.xml",
        "docs/technology.xml",
        "AGENTS.md",
        CONFIG_FILENAME,
        ".gitignore",
      ]) {
        expect(existsSync(join(project, relativePath))).toBe(true);
      }

      const graphIndex = readFileSync(join(project, "docs", "graph-index.xml"), "utf-8");
      expect(graphIndex).toContain('project="InitTest"');

      // ADR-1: local trust state must never be committed.
      expect(readFileSync(join(project, ".gitignore"), "utf-8")).toContain(".mygrace/");
    });
  }, 30_000);

  test("writes a config that matches the documented defaults", () => {
    withTempDir((project) => {
      expect(runInit(project, ["--name", "ConfigTest", "--language", "python", "--test-runner", "pytest"]).status).toBe(0);
      const config = JSON.parse(readFileSync(join(project, CONFIG_FILENAME), "utf-8")) as typeof DEFAULT_CONFIG;
      expect(config.sourceDirs).toEqual(DEFAULT_CONFIG.sourceDirs);
      expect(config.indexCaps).toEqual(DEFAULT_CONFIG.indexCaps);
      expect(config.sizeBudgets.module).toEqual(DEFAULT_CONFIG.sizeBudgets.module);
      expect(config.allowCommands).toBe(false);
      expect(config.language).toBe("python");
      expect(config.testRunner).toBe("pytest");
    });
  }, 30_000);

  test("is idempotent without --force: existing files are skipped, not overwritten", () => {
    withTempDir((project) => {
      expect(runInit(project, ["--name", "Once"]).status).toBe(0);
      const agentsPath = join(project, "AGENTS.md");
      const custom = "# Custom AGENTS.md — user edits must survive\n";
      writeFileSync(agentsPath, custom);

      const second = runInit(project, ["--name", "Twice"]);
      expect(second.status).toBe(0);
      expect(second.stdout).toContain("skipped");
      expect(readFileSync(agentsPath, "utf-8")).toBe(custom);
    });
  }, 45_000);

  test("--force overwrites an existing AGENTS.md", () => {
    withTempDir((project) => {
      expect(runInit(project, ["--name", "Force"]).status).toBe(0);
      const agentsPath = join(project, "AGENTS.md");
      writeFileSync(agentsPath, "stale content\n");

      expect(runInit(project, ["--name", "Force", "--force"]).status).toBe(0);
      const content = readFileSync(agentsPath, "utf-8");
      expect(content).not.toBe("stale content\n");
      expect(content).toContain("MyGRACE");
    });
  }, 45_000);

  test("appends a note instead of rewriting an existing .gitignore", () => {
    withTempDir((project) => {
      const gitignorePath = join(project, ".gitignore");
      writeFileSync(gitignorePath, "node_modules/\n");
      const result = runInit(project, ["--name", "ExistingIgnore"]);
      expect(result.status).toBe(0);
      expect(readFileSync(gitignorePath, "utf-8")).toBe("node_modules/\n");
      expect(result.stdout).toContain(".mygrace/");
    });
  }, 30_000);

  test("does not touch an existing .gitignore that already ignores .mygrace/", () => {
    withTempDir((project) => {
      const gitignorePath = join(project, ".gitignore");
      writeFileSync(gitignorePath, ".mygrace/\nnode_modules/\n");
      const result = runInit(project, ["--name", "AlreadyIgnored"]);
      expect(result.status).toBe(0);
      expect(readFileSync(gitignorePath, "utf-8")).toBe(".mygrace/\nnode_modules/\n");
      expect(result.stdout).not.toContain("add `.mygrace/`");
    });
  }, 30_000);
});
