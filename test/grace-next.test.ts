/**
 * MyGRACE — `mygrace next` tests.
 *
 * The advisor is a fixed priority ladder, so every state in the ladder is built
 * from a disposable copy of the shipped demo project (lint-clean baseline) and
 * mutated in exactly one way. This proves:
 *   - the action codes are deterministic and the ladder order is enforced,
 *   - advice exits 0 even when it reports problems to fix,
 *   - config errors are the only non-zero exit (exit 2, ADR-3),
 *   - the JSON envelope shape is `{ok, exitCode, findings, meta, data:{action}}`.
 */

import { describe, expect, test } from "bun:test";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { ConfigError, UsageError } from "../src/grace-errors";
import { writeTrustRecord } from "../src/grace-test";
import { nextCommand, recommendNext, type NextActionCode } from "../src/grace-next";

const ROOT = resolve(import.meta.dirname, "..");
const DEMO = join(ROOT, "examples", "demo-store");

// ─── Disposable demo copies ────────────────────────────────────────────

interface DemoCopy {
  root: string;
  cleanup: () => void;
}

/** Copy examples/demo-store to a temp dir (the demo is a lint-clean baseline). */
function copyDemo(): DemoCopy {
  const base = mkdtempSync(join(tmpdir(), "mygrace-next-"));
  const root = join(base, "demo-store");
  cpSync(DEMO, root, { recursive: true });
  return { root, cleanup: () => rmSync(base, { recursive: true, force: true }) };
}

function edit(path: string, transform: (content: string) => string): void {
  writeFileSync(path, transform(readFileSync(path, "utf-8")));
}

/** Make one demo module pending/wip in the index only (or in both index and entity file). */
function setModuleStatus(copy: DemoCopy, moduleId: string, status: "pending" | "wip" | "done", options: { entity?: boolean } = {}): void {
  edit(join(copy.root, "docs", "graph-index.xml"), (content) =>
    content.replace(new RegExp(`<${moduleId} ([^>]*?)STATUS="[^"]*"`, "u"), `<${moduleId} $1STATUS="${status}"`)
  );
  if (options.entity === true) {
    edit(join(copy.root, "docs", "modules", `${moduleId}.xml`), (content) =>
      content.replace(/STATUS="[^"]*"/u, `STATUS="${status}"`)
    );
  }
}

async function expectConfigError(fn: () => unknown): Promise<ConfigError> {
  try {
    await fn();
  } catch (error) {
    expect(error).toBeInstanceOf(ConfigError);
    return error as ConfigError;
  }
  throw new Error("expected a ConfigError but the call succeeded");
}

// ─── stdout/exit capture for the citty command ─────────────────────────

class ExitSignal extends Error {}

interface Captured {
  stdout: string;
  exit: number;
  thrown: unknown;
}

async function capture(fn: () => Promise<unknown>): Promise<Captured> {
  const chunks: string[] = [];
  const originalWrite = process.stdout.write.bind(process.stdout);
  const originalLog = console.log;
  const originalExit = process.exit;
  let exit: number | undefined;
  let thrown: unknown;
  process.stdout.write = ((chunk: unknown) => {
    chunks.push(String(chunk));
    return true;
  }) as typeof process.stdout.write;
  console.log = ((...values: unknown[]) => {
    chunks.push(`${values.map((value) => String(value)).join(" ")}\n`);
  }) as typeof console.log;
  process.exit = ((code?: number) => {
    exit = code ?? 0;
    throw new ExitSignal(`exit:${code ?? 0}`);
  }) as never;
  try {
    await fn();
  } catch (error) {
    if (!(error instanceof ExitSignal)) thrown = error;
  } finally {
    process.stdout.write = originalWrite;
    console.log = originalLog;
    process.exit = originalExit;
  }
  return { stdout: chunks.join(""), exit: exit ?? 0, thrown };
}

/** Assert the action shape shared by every ladder state. */
function expectActionShape(code: NextActionCode): void {
  const result = recommendNext(DEMO);
  expect(result.action.code).toBe(code);
  expect(result.action.summary.length).toBeGreaterThan(0);
  expect(result.action.why.length).toBeGreaterThan(0);
  expect(result.findings).toEqual([]);
}

// ─── Ladder states ─────────────────────────────────────────────────────

describe("recommendNext — priority ladder", () => {
  test("1. INIT_PROJECT: a directory without docs/graph-index.xml says how to bootstrap", () => {
    const empty = mkdtempSync(join(tmpdir(), "mygrace-next-empty-"));
    try {
      const result = recommendNext(empty);
      expect(result.root).toBeNull();
      expect(result.action.code).toBe("INIT_PROJECT");
      expect(result.action.command).toContain("mygrace init-dsh");
      expect(result.action.why).toContain("No docs/graph-index.xml");
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });

  test("2. FIX_INDEX: a malformed index outranks every other problem", () => {
    const copy = copyDemo();
    try {
      edit(join(copy.root, "docs", "plan-index.xml"), (content) => `${content.replace("</PlanIndex>", "")}`);
      // Also make commands untrusted and a module pending: FIX_INDEX must still win.
      setModuleStatus(copy, "M-CART", "wip");
      const result = recommendNext(copy.root);
      expect(result.action.code).toBe("FIX_INDEX");
      expect(result.action.ids).toContain("docs/plan-index.xml");
      expect(result.action.command).toContain("lint --format json");
      expect(result.action.why).toContain("index problem");
    } finally {
      copy.cleanup();
    }
  });

  test("3. FIX_LINT_ERRORS: a missing module PATH outranks coverage/trust/pending work", () => {
    const copy = copyDemo();
    try {
      setModuleStatus(copy, "M-CART", "wip");
      edit(join(copy.root, "docs", "graph-index.xml"), (content) =>
        content.replace('M-CART NAME="Cart" TYPE="CORE_LOGIC" STATUS="wip" PATH="src/cart/index.ts"', 'M-CART NAME="Cart" TYPE="CORE_LOGIC" STATUS="wip" PATH="src/cart/missing.ts"')
      );
      const result = recommendNext(copy.root);
      expect(result.action.code).toBe("FIX_LINT_ERRORS");
      expect(result.action.ids).toContain("MODULE_PATH_NOT_FOUND");
      expect(result.action.command).toContain("lint");
      expect(result.action.why).toContain("mygrace-fix skill");
    } finally {
      copy.cleanup();
    }
  });

  test("4. ADD_VERIFICATION_COVERAGE: a verification without <test-files> is the next blocker", () => {
    const copy = copyDemo();
    try {
      edit(join(copy.root, "docs", "verification", "V-M-CART.xml"), (content) =>
        content.replace(/<test-files>[\s\S]*?<\/test-files>/u, "")
      );
      const result = recommendNext(copy.root);
      expect(result.action.code).toBe("ADD_VERIFICATION_COVERAGE");
      expect(result.action.ids).toContain("M-CART");
      expect(result.action.command).toContain("ci --format json");
      expect(result.action.why).toContain("mygrace-verification skill");
    } finally {
      copy.cleanup();
    }
  });

  test("5. TRUST_COMMANDS: pending work with untrusted project commands asks for trust", () => {
    const copy = copyDemo();
    try {
      setModuleStatus(copy, "M-CART", "wip"); // index-only: STATUS_DRIFT warning, no lint errors
      const result = recommendNext(copy.root);
      expect(result.action.code).toBe("TRUST_COMMANDS");
      expect(result.action.command).toContain("mygrace trust");
      expect(result.action.command).toContain("--path");
      expect(result.action.why).toContain("trust");
    } finally {
      copy.cleanup();
    }
  });

  test("6. VERIFY_MODULE: pending module with ready verification and a current trust record", () => {
    const copy = copyDemo();
    try {
      setModuleStatus(copy, "M-CART", "wip", { entity: true });
      writeTrustRecord(copy.root); // written after the edits, so it is current
      const result = recommendNext(copy.root);
      expect(result.action.code).toBe("VERIFY_MODULE");
      expect(result.action.ids).toEqual(["M-CART"]);
      expect(result.action.command).toContain("mygrace verify --module M-CART");
      expect(result.action.why).toContain("verification plan is ready");
    } finally {
      copy.cleanup();
    }
  });

  test("7. REFRESH_WARNINGS: warnings-only project points at the refresh skill", () => {
    const copy = copyDemo();
    try {
      // Push one entity above the module line budget → ENTITY_TOO_LARGE warning only.
      edit(join(copy.root, "docs", "modules", "M-CART.xml"), (content) => {
        const closing = content.lastIndexOf("</M-CART>");
        const padding = "  <!-- padding to exceed the module size budget -->\n".repeat(60);
        return `${content.slice(0, closing)}${padding}${content.slice(closing)}`;
      });
      const result = recommendNext(copy.root);
      expect(result.action.code).toBe("REFRESH_WARNINGS");
      expect(result.action.ids).toContain("ENTITY_TOO_LARGE");
      expect(result.action.command).toContain("--strict");
      expect(result.action.why).toContain("mygrace-refresh skill");
    } finally {
      copy.cleanup();
    }
  });

  test("8a. NEXT_PHASE: a clean project with a pending phase points at it", () => {
    const copy = copyDemo();
    try {
      edit(join(copy.root, "docs", "plan-index.xml"), (content) =>
        content.replace('<Phase-2 name="Cart" status="done"', '<Phase-2 name="Cart" status="pending"')
      );
      edit(join(copy.root, "docs", "plans", "Phase-2.xml"), (content) =>
        content.replace("<Phase-2 name=\"Cart\" status=\"done\">", "<Phase-2 name=\"Cart\" status=\"pending\">")
      );
      const result = recommendNext(copy.root);
      expect(result.action.code).toBe("NEXT_PHASE");
      expect(result.action.ids).toEqual(["Phase-2"]);
      expect(result.action.command).toContain("phase show Phase-2");
    } finally {
      copy.cleanup();
    }
  });

  test("8b. NOTHING_TO_DO: the shipped demo is clean", () => {
    expectActionShape("NOTHING_TO_DO");
  });

  test("the ladder is deterministic: two runs return the same action JSON", () => {
    const copy = copyDemo();
    try {
      setModuleStatus(copy, "M-CART", "wip");
      const first = JSON.stringify(recommendNext(copy.root));
      const second = JSON.stringify(recommendNext(copy.root));
      expect(first).toBe(second);
    } finally {
      copy.cleanup();
    }
  });

  test("config errors are exit-2 advice errors, not a recommendation", async () => {
    const copy = copyDemo();
    try {
      writeFileSync(join(copy.root, "mygrace.config.json"), JSON.stringify({ indexCaps: "nope" }));
      const error = await expectConfigError(() => recommendNext(copy.root));
      expect(error.exitCode).toBe(2);
      expect(error.code).toBe("CONFIG_INVALID");
    } finally {
      copy.cleanup();
    }
  });
});

// ─── citty command (text + JSON envelope) ──────────────────────────────

describe("nextCommand", () => {
  test("is registered with the documented metadata", () => {
    const meta = typeof nextCommand.meta === "object" ? (nextCommand.meta as { name?: string }) : undefined;
    expect(meta?.name).toBe("next");
    expect(typeof nextCommand.run).toBe("function");
  });

  test("JSON mode prints the ADR-8 envelope with data.action and exits 0", async () => {
    const { stdout, exit, thrown } = await capture(() =>
      nextCommand.run!({ args: { path: DEMO, format: "json" } } as never)
    );
    expect(thrown).toBeUndefined();
    expect(exit).toBe(0);
    const envelope = JSON.parse(stdout) as {
      ok: boolean;
      exitCode: number;
      findings: unknown[];
      meta: { command: string; root: string };
      data: { action: { code: string; summary: string; why: string } };
    };
    expect(envelope.ok).toBe(true);
    expect(envelope.exitCode).toBe(0);
    expect(envelope.meta.command).toBe("next");
    expect(envelope.meta.root).toBe(DEMO);
    expect(envelope.findings).toEqual([]);
    expect(envelope.data.action.code).toBe("NOTHING_TO_DO");
  });

  test("JSON mode for a non-project returns INIT_PROJECT advice with exit 0", async () => {
    const empty = mkdtempSync(join(tmpdir(), "mygrace-next-empty-"));
    try {
      const { stdout, exit } = await capture(() => nextCommand.run!({ args: { path: empty, format: "json" } } as never));
      expect(exit).toBe(0);
      const envelope = JSON.parse(stdout) as {
        ok: boolean;
        exitCode: number;
        data: { action: { code: string; command: string } };
        meta: { command: string };
      };
      expect(envelope.ok).toBe(true);
      expect(envelope.exitCode).toBe(0);
      expect(envelope.data.action.code).toBe("INIT_PROJECT");
      expect(envelope.data.action.command).toContain("init-dsh");
      expect(envelope.meta.command).toBe("next");
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });

  test("text mode prints NEXT / WHY / CODE and exits 0 even when it recommends work", async () => {
    const copy = copyDemo();
    try {
      setModuleStatus(copy, "M-CART", "wip");
      const { stdout, exit } = await capture(() => nextCommand.run!({ args: { path: copy.root } } as never));
      expect(exit).toBe(0); // advice never fails the build
      expect(stdout).toContain("NEXT: Review and trust the project-declared commands");
      expect(stdout).toContain("WHY:");
      expect(stdout).toContain("RUN: mygrace trust");
      expect(stdout).toContain("CODE: TRUST_COMMANDS");
    } finally {
      copy.cleanup();
    }
  });

  test("JSON mode on a malformed config exits 2 with a CONFIG_INVALID error envelope", async () => {
    const copy = copyDemo();
    try {
      writeFileSync(join(copy.root, "mygrace.config.json"), "{ not json");
      const { stdout, exit, thrown } = await capture(() =>
        nextCommand.run!({ args: { path: copy.root, format: "json" } } as never)
      );
      expect(thrown).toBeUndefined();
      expect(exit).toBe(2);
      const envelope = JSON.parse(stdout) as { ok: boolean; exitCode: number; error: { code: string } };
      expect(envelope.ok).toBe(false);
      expect(envelope.exitCode).toBe(2);
      expect(envelope.error.code).toBe("CONFIG_INVALID");
    } finally {
      copy.cleanup();
    }
  });

  test("an invalid --format value is a typed usage error", async () => {
    const { thrown } = await capture(() => nextCommand.run!({ args: { path: DEMO, format: "yaml" } } as never));
    expect(thrown).toBeInstanceOf(UsageError);
  });
});
