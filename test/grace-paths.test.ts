import { describe, expect, test } from "bun:test";
import { join, resolve } from "node:path";
import {
  assertEntityId,
  assertSafeRelativePath,
  docsRelative,
  entityDir,
  entityPath,
  isWithin,
  resolveWithin,
} from "../src/grace-paths";
import { UsageError } from "../src/grace-errors";

// ─── id grammar ─────────────────────────────────────────────────────────

describe("assertEntityId() valid grammars", () => {
  const valid: Array<[Parameters<typeof assertEntityId>[0], string[]]> = [
    ["module", ["M-A", "M-AUTH", "M-1", "M-a1", "M-A_B", "M-A-1"]],
    ["verification", ["V-M-A", "V-M-AUTH", "V-M-A_B-1"]],
    ["phase", ["Phase-1", "Phase-01", "Phase-123", "Phase-1a", "Phase-1A"]],
  ];

  for (const [kind, ids] of valid) {
    test(`${kind} accepts the documented ids`, () => {
      for (const id of ids) expect(assertEntityId(kind, id)).toBe(id);
    });
  }

  test("trims surrounding whitespace", () => {
    expect(assertEntityId("module", "  M-AUTH  ")).toBe("M-AUTH");
    expect(assertEntityId("phase", "\tPhase-2\n")).toBe("Phase-2");
  });
});

describe("assertEntityId() rejects unsafe input (ADR-4)", () => {
  const invalid: Array<[Parameters<typeof assertEntityId>[0], string[]]> = [
    [
      "module",
      ["", "M-", "M", "m-auth", "M AUTH", "M-A/B", "M-A.B", "M-_A", "../M-A", "/M-A", "C:\\M-A", "-M-A", "M-A\0"],
    ],
    ["verification", ["", "V-M-", "V-AUTH", "M-AUTH", "V-M-A/../B"]],
    ["phase", ["", "Phase-", "Phase-a", "Phase-1-2", "Phase-1ab", "phase-1", "../Phase-1"]],
  ];

  for (const [kind, ids] of invalid) {
    test(`${kind} rejects malformed / traversal ids`, () => {
      for (const id of ids) {
        expect(() => assertEntityId(kind, id)).toThrow(UsageError);
        try {
          assertEntityId(kind, id);
        } catch (error) {
          expect(error).toBeInstanceOf(UsageError);
          expect((error as UsageError).code).toBe("USAGE");
          expect((error as UsageError).exitCode).toBe(2);
        }
      }
    });
  }

  test("missing ids produce a kind-specific 'Missing' error with the right command hint", () => {
    const cases: Array<[Parameters<typeof assertEntityId>[0], string, string]> = [
      ["module", "Missing module id", "module show"],
      ["verification", "Missing verification id", "verification index"],
      ["phase", "Missing phase id", "phase show"],
    ];
    for (const [kind, message, command] of cases) {
      for (const missing of [undefined, null, "", "   "]) {
        try {
          assertEntityId(kind, missing);
          throw new Error("expected assertEntityId to throw");
        } catch (error) {
          expect(error).toBeInstanceOf(UsageError);
          const usage = error as UsageError;
          expect(usage.message).toContain(message);
          expect(usage.hint).toContain(`mygrace ${command}`);
        }
      }
    }
  });
});

// ─── entity paths ───────────────────────────────────────────────────────

describe("entityDir() and entityPath()", () => {
  test("entityDir() maps each kind to its docs directory", () => {
    expect(entityDir("/proj", "module")).toBe(join("/proj", "docs", "modules"));
    expect(entityDir("/proj", "verification")).toBe(join("/proj", "docs", "verification"));
    expect(entityDir("/proj", "phase")).toBe(join("/proj", "docs", "plans"));
  });

  test("entityPath() joins a validated id", () => {
    expect(entityPath("/proj", "module", "M-AUTH")).toBe(join("/proj", "docs", "modules", "M-AUTH.xml"));
    expect(entityPath("/proj", "verification", "V-M-AUTH")).toBe(
      join("/proj", "docs", "verification", "V-M-AUTH.xml")
    );
    expect(entityPath("/proj", "phase", "Phase-2")).toBe(join("/proj", "docs", "plans", "Phase-2.xml"));
  });

  test("entityPath() refuses traversal ids", () => {
    expect(() => entityPath("/proj", "module", "../../etc/passwd")).toThrow(UsageError);
    expect(() => entityPath("/proj", "phase", "/tmp/Phase-1")).toThrow(UsageError);
  });
});

// ─── relative path safety ──────────────────────────────────────────────

describe("assertSafeRelativePath()", () => {
  test("accepts safe relative paths and returns them unchanged", () => {
    for (const value of ["src/a.ts", "a/b/c", "a//b", "./x", "a..b/c", "..hidden/file"]) {
      expect(assertSafeRelativePath(value)).toBe(value);
    }
  });

  test("rejects empty / blank paths", () => {
    for (const value of ["", "   "]) {
      expect(() => assertSafeRelativePath(value)).toThrow(UsageError);
      try {
        assertSafeRelativePath(value, "source path");
      } catch (error) {
        expect((error as UsageError).message).toContain("Empty source path");
      }
    }
  });

  test("rejects absolute paths (POSIX, drive-letter and UNC)", () => {
    for (const value of ["/etc/passwd", "C:\\Windows\\x", "C:/Windows/x", "\\\\server\\share\\x"]) {
      expect(() => assertSafeRelativePath(value)).toThrow(UsageError);
      try {
        assertSafeRelativePath(value);
      } catch (error) {
        expect((error as UsageError).message).toContain("absolute paths are not allowed");
      }
    }
  });

  test("rejects parent-directory segments", () => {
    for (const value of ["../x", "a/../b", "a/../../b", "..\\x"]) {
      expect(() => assertSafeRelativePath(value)).toThrow(UsageError);
      try {
        assertSafeRelativePath(value);
      } catch (error) {
        expect((error as UsageError).message).toContain('parent directory segments ("..")');
      }
    }
  });

  test("rejects NUL bytes", () => {
    expect(() => assertSafeRelativePath("a\0b")).toThrow(UsageError);
    try {
      assertSafeRelativePath("a\0b");
    } catch (error) {
      expect((error as UsageError).message).toContain("NUL byte");
    }
  });
});

describe("isWithin()", () => {
  test("true for the base itself and nested paths", () => {
    expect(isWithin("/tmp/base", "/tmp/base")).toBe(true);
    expect(isWithin("/tmp/base", "/tmp/base/sub/file")).toBe(true);
    expect(isWithin("/tmp/base", "/tmp/base/sub/../other")).toBe(true);
  });

  test("false for siblings and prefix lookalikes", () => {
    expect(isWithin("/tmp/base", "/tmp/base-other/file")).toBe(false);
    expect(isWithin("/tmp/base", "/tmp/other")).toBe(false);
  });
});

describe("resolveWithin()", () => {
  const base = resolve("/tmp/mygrace-resolve-base");

  test("resolves a relative candidate inside the base", () => {
    expect(resolveWithin(base, "sub/file.xml")).toBe(join(base, "sub", "file.xml"));
    expect(resolveWithin(base, "docs/./modules/M-A.xml")).toBe(join(base, "docs", "modules", "M-A.xml"));
  });

  test("allows an absolute candidate only when it is inside the base", () => {
    expect(resolveWithin(base, join(base, "docs", "x.xml"))).toBe(join(base, "docs", "x.xml"));
    expect(() => resolveWithin(base, "/etc/passwd")).toThrow(UsageError);
  });

  test("rejects traversal outside the base with a readable error", () => {
    for (const candidate of ["../escape", "docs/../../escape", "/tmp"]) {
      expect(() => resolveWithin(base, candidate)).toThrow(UsageError);
      try {
        resolveWithin(base, candidate);
      } catch (error) {
        const usage = error as UsageError;
        expect(usage.code).toBe("USAGE");
        expect(usage.message).toContain("outside");
      }
    }
  });

  test("uses the supplied label in the error message", () => {
    try {
      resolveWithin(base, "../x", "module path");
    } catch (error) {
      expect((error as UsageError).message).toContain("module path");
    }
  });

  test("the base directory itself resolves to the base", () => {
    expect(resolveWithin(base, "")).toBe(base);
    expect(resolveWithin(base, ".")).toBe(base);
  });
});

describe("docsRelative()", () => {
  test("joins segments under docs/", () => {
    expect(docsRelative("modules", "M-A.xml")).toBe(join("docs", "modules", "M-A.xml"));
    expect(docsRelative()).toBe("docs");
  });
});
