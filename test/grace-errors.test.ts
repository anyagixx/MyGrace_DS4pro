import { describe, expect, test } from "bun:test";
import {
  EXIT,
  MyGraceError,
  UsageError,
  ConfigError,
  ProjectNotFoundError,
  XmlError,
  TrustError,
  finding,
  exitCodeForFindings,
  createEnvelope,
  printJson,
  handleCliError,
  withErrorBoundary,
  isMyGraceError,
} from "../src/grace-errors";

// ─── capture helpers ────────────────────────────────────────────────────

function captureOut() {
  const stream = process.stdout;
  const original = stream.write;
  let text = "";
  stream.write = ((chunk: unknown) => {
    text += String(chunk);
    return true;
  }) as typeof stream.write;
  return {
    text: () => text,
    restore: () => {
      stream.write = original;
    },
  };
}

function captureErr() {
  const stream = process.stderr;
  const original = stream.write;
  let text = "";
  stream.write = ((chunk: unknown) => {
    text += String(chunk);
    return true;
  }) as typeof stream.write;
  return {
    text: () => text,
    restore: () => {
      stream.write = original;
    },
  };
}

function stubExit() {
  const original = process.exit;
  const codes: number[] = [];
  process.exit = ((code?: number) => {
    codes.push(code ?? 0);
    throw new Error(`exit:${code}`);
  }) as never;
  return {
    codes,
    restore: () => {
      process.exit = original;
    },
  };
}

// ─── exit-code constants ────────────────────────────────────────────────

describe("EXIT constants", () => {
  test("document the stable exit-code contract (ADR-3)", () => {
    expect(EXIT.OK).toBe(0);
    expect(EXIT.FINDINGS).toBe(1);
    expect(EXIT.USAGE).toBe(2);
    expect(EXIT.INTERNAL).toBe(3);
  });
});

// ─── typed errors ───────────────────────────────────────────────────────

describe("MyGraceError", () => {
  test("defaults to FINDINGS and renders code, message and location", () => {
    const error = new MyGraceError("SOME_CODE", "something broke", { file: "docs/x.xml", line: 4 });
    expect(error.code).toBe("SOME_CODE");
    expect(error.message).toBe("something broke");
    expect(error.exitCode).toBe(EXIT.FINDINGS);
    expect(error.file).toBe("docs/x.xml");
    expect(error.line).toBe(4);
    expect(error.toLine()).toBe("SOME_CODE: something broke (docs/x.xml:4)");
  });

  test("renders an actionable hint on a second line", () => {
    const error = new UsageError("bad flag", { hint: "run `mygrace --help`" });
    expect(error.toLine()).toBe("USAGE: bad flag\n  → run `mygrace --help`");
  });

  test("renders a bare location when no file is present", () => {
    const error = new MyGraceError("CODE", "plain");
    expect(error.toLine()).toBe("CODE: plain");
  });

  test("is a real Error with no stack in toLine()", () => {
    const error = new MyGraceError("CODE", "plain");
    expect(error).toBeInstanceOf(Error);
    expect(error.toLine()).not.toContain(" at ");
  });
});

describe("error subclasses", () => {
  test("UsageError is a usage error (exit 2)", () => {
    const error = new UsageError("bad argument");
    expect(error).toBeInstanceOf(MyGraceError);
    expect(error.code).toBe("USAGE");
    expect(error.exitCode).toBe(EXIT.USAGE);
    expect(isMyGraceError(error)).toBe(true);
  });

  test("ConfigError is a usage error with a stable code", () => {
    const error = new ConfigError("bad config", { file: "mygrace.config.json" });
    expect(error.code).toBe("CONFIG_INVALID");
    expect(error.exitCode).toBe(EXIT.USAGE);
    expect(error.file).toBe("mygrace.config.json");
  });

  test("ProjectNotFoundError explains the search and the fix", () => {
    const error = new ProjectNotFoundError("/tmp/nothing");
    expect(error.code).toBe("PROJECT_NOT_FOUND");
    expect(error.exitCode).toBe(EXIT.USAGE);
    expect(error.message).toContain("docs/graph-index.xml");
    expect(error.hint).toContain("/tmp/nothing");
    expect(error.hint).toContain("init-dsh");
  });

  test("XmlError is a finding (exit 1) and carries the line", () => {
    const error = new XmlError("docs/modules/M-A.xml", "Unclosed tag", { line: 3, column: 7 });
    expect(error.code).toBe("XML_INVALID");
    expect(error.exitCode).toBe(EXIT.FINDINGS);
    expect(error.message).toBe("Invalid XML: Unclosed tag");
    expect(error.file).toBe("docs/modules/M-A.xml");
    expect(error.line).toBe(3);
    expect(error.column).toBe(7);
    expect(error.toLine()).toContain("docs/modules/M-A.xml:3");
  });

  test("TrustError is a usage error naming the command and the trust recipe", () => {
    const error = new TrustError("/proj", "bun test src/a.test.ts");
    expect(error.code).toBe("UNTRUSTED_PROJECT");
    expect(error.exitCode).toBe(EXIT.USAGE);
    expect(error.message).toContain("bun test src/a.test.ts");
    expect(error.hint).toContain("mygrace trust --path /proj");
    expect(error.hint).toContain("--allow-commands");
  });

  test("isMyGraceError rejects plain errors", () => {
    expect(isMyGraceError(new Error("plain"))).toBe(false);
    expect(isMyGraceError("nope")).toBe(false);
    expect(isMyGraceError(undefined)).toBe(false);
  });
});

// ─── findings ───────────────────────────────────────────────────────────

describe("finding()", () => {
  test("builds a finding with stable severity/code/message", () => {
    expect(finding("error", "PATH_MISSING", "src/x.ts does not exist")).toEqual({
      severity: "error",
      code: "PATH_MISSING",
      message: "src/x.ts does not exist",
    });
  });

  test("copies location and hint extras", () => {
    expect(
      finding("warning", "STATUS_DRIFT", "drift", { file: "docs/x.xml", line: 2, column: 4, hint: "sync indexes" })
    ).toEqual({
      severity: "warning",
      code: "STATUS_DRIFT",
      message: "drift",
      file: "docs/x.xml",
      line: 2,
      column: 4,
      hint: "sync indexes",
    });
  });

  test("supports info severity", () => {
    expect(finding("info", "NOTE", "fyi").severity).toBe("info");
  });
});

describe("exitCodeForFindings()", () => {
  test("no findings is OK", () => {
    expect(exitCodeForFindings([])).toBe(EXIT.OK);
  });

  test("errors always fail", () => {
    expect(exitCodeForFindings([finding("error", "E", "boom")])).toBe(EXIT.FINDINGS);
    expect(exitCodeForFindings([finding("error", "E", "boom")], true)).toBe(EXIT.FINDINGS);
  });

  test("warnings fail only in strict mode", () => {
    const warnings = [finding("warning", "W", "hmm")];
    expect(exitCodeForFindings(warnings, false)).toBe(EXIT.OK);
    expect(exitCodeForFindings(warnings, true)).toBe(EXIT.FINDINGS);
  });

  test("info findings never fail, even in strict mode", () => {
    expect(exitCodeForFindings([finding("info", "I", "note")], true)).toBe(EXIT.OK);
  });
});

// ─── JSON envelope ─────────────────────────────────────────────────────

describe("createEnvelope()", () => {
  test("clean result is ok with exit 0 and no error key", () => {
    const envelope = createEnvelope({ data: { modules: 2 } });
    expect(envelope).toEqual({
      ok: true,
      exitCode: EXIT.OK,
      data: { modules: 2 },
      findings: [],
      meta: {},
    });
    expect("error" in envelope).toBe(false);
  });

  test("findings drive ok/exitCode; strict promotes warnings", () => {
    const errorFinding = finding("error", "E", "boom");
    expect(createEnvelope({ findings: [errorFinding] })).toMatchObject({ ok: false, exitCode: EXIT.FINDINGS });
    const warning = finding("warning", "W", "hmm");
    expect(createEnvelope({ findings: [warning] })).toMatchObject({ ok: true, exitCode: EXIT.OK });
    expect(createEnvelope({ findings: [warning], strict: true })).toMatchObject({
      ok: false,
      exitCode: EXIT.FINDINGS,
    });
  });

  test("typed error drives exit code and is serialized without extras", () => {
    const envelope = createEnvelope({ error: new ConfigError("bad config", { hint: "fix it" }) });
    expect(envelope.ok).toBe(false);
    expect(envelope.exitCode).toBe(EXIT.USAGE);
    expect(envelope.error).toEqual({ code: "CONFIG_INVALID", message: "bad config", hint: "fix it" });
  });

  test("untyped error maps to INTERNAL and omits undefined hint", () => {
    const envelope = createEnvelope({ error: { code: "X", message: "unexpected" } });
    expect(envelope.exitCode).toBe(EXIT.INTERNAL);
    expect(envelope.error).toEqual({ code: "X", message: "unexpected" });
    expect(envelope.error === undefined ? null : "hint" in envelope.error).toBe(false);
  });

  test("meta is copied when supplied", () => {
    const envelope = createEnvelope({ meta: { command: "lint", root: "/p", durationMs: 12 } });
    expect(envelope.meta).toEqual({ command: "lint", root: "/p", durationMs: 12 });
  });

  test("data is only present when supplied", () => {
    const envelope = createEnvelope({ findings: [] });
    expect("data" in envelope).toBe(false);
  });
});

// ─── output helpers ────────────────────────────────────────────────────

describe("printJson()", () => {
  test("prints deterministic 2-space JSON with a trailing newline", () => {
    const capture = captureOut();
    try {
      printJson({ b: 2, a: [1, "x"] });
      expect(capture.text()).toBe('{\n  "b": 2,\n  "a": [\n    1,\n    "x"\n  ]\n}\n');
    } finally {
      capture.restore();
    }
  });
});

describe("handleCliError()", () => {
  test("prints one readable line (no stack) for typed errors", () => {
    const capture = captureErr();
    try {
      const code = handleCliError(new UsageError("bad flag", { hint: "see --help" }));
      expect(code).toBe(EXIT.USAGE);
      expect(capture.text()).toBe("mygrace: USAGE: bad flag\n  → see --help\n");
      expect(capture.text()).not.toContain(" at ");
    } finally {
      capture.restore();
    }
  });

  test("unexpected errors map to INTERNAL with a debug hint", () => {
    const capture = captureErr();
    try {
      const code = handleCliError(new Error("kaboom"));
      expect(code).toBe(EXIT.INTERNAL);
      expect(capture.text()).toContain("mygrace: INTERNAL: kaboom");
      expect(capture.text()).toContain("MYGRACE_DEBUG=1");
      expect(capture.text()).not.toContain(" at ");
    } finally {
      capture.restore();
    }
  });

  test("non-Error values still produce a readable message", () => {
    const capture = captureErr();
    try {
      expect(handleCliError("plain string")).toBe(EXIT.INTERNAL);
      expect(capture.text()).toContain("INTERNAL: plain string");
    } finally {
      capture.restore();
    }
  });

  test("prints the stack only when MYGRACE_DEBUG=1", () => {
    const previous = process.env.MYGRACE_DEBUG;
    const capture = captureErr();
    try {
      process.env.MYGRACE_DEBUG = "1";
      handleCliError(new Error("debug me"));
      expect(capture.text()).toContain("Error: debug me");
      expect(capture.text()).toContain("at ");
    } finally {
      capture.restore();
      if (previous === undefined) delete process.env.MYGRACE_DEBUG;
      else process.env.MYGRACE_DEBUG = previous;
    }
  });
});

describe("withErrorBoundary()", () => {
  test("passes through successful handlers", async () => {
    let ran = false;
    const wrapped = withErrorBoundary(() => {
      ran = true;
    });
    await wrapped();
    expect(ran).toBe(true);
  });

  test("exits with the typed error's code on failure", async () => {
    const exit = stubExit();
    const capture = captureErr();
    try {
      const wrapped = withErrorBoundary(() => {
        throw new ConfigError("bad config");
      });
      await expect(wrapped()).rejects.toThrow("exit:2");
      expect(exit.codes).toEqual([EXIT.USAGE]);
      expect(capture.text()).toContain("CONFIG_INVALID: bad config");
    } finally {
      capture.restore();
      exit.restore();
    }
  });

  test("exits 3 for unexpected errors", async () => {
    const exit = stubExit();
    const capture = captureErr();
    try {
      const wrapped = withErrorBoundary(async () => {
        throw new Error("unexpected");
      });
      await expect(wrapped()).rejects.toThrow("exit:3");
      expect(exit.codes).toEqual([EXIT.INTERNAL]);
    } finally {
      capture.restore();
      exit.restore();
    }
  });
});
