import { describe, test, expect } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, existsSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  TRUST_RECORD_VERSION,
  authorizeCommands,
  checkTrust,
  computeTrustHashes,
  loadTrustRecord,
  trustFilePath,
  trustCommand,
  writeTrustRecord,
} from "../src/grace-test";
import { ConfigError } from "../src/grace-errors";
import { cloneDefault } from "../src/grace-config";

const GRAPH_INDEX = `<GraphIndex project="T" version="1.0.0">\n  <M-A NAME="A" TYPE="T" STATUS="done" />\n</GraphIndex>\n`;
const MODULE = `<M-A NAME="A" TYPE="T" STATUS="done"><contract><purpose>Do A</purpose></contract></M-A>`;
const VERIFICATION = `<V-M-A MODULE="M-A" STATUS="pending"><test-files><file>x.test.ts</file></test-files><module-checks><check-1>true</check-1></module-checks></V-M-A>`;

function makeProject(options: { config?: Record<string, unknown>; command?: string; gitignore?: string } = {}): string {
  const root = mkdtempSync(join(tmpdir(), "mygrace-trust-"));
  mkdirSync(join(root, "docs", "modules"), { recursive: true });
  mkdirSync(join(root, "docs", "verification"), { recursive: true });
  writeFileSync(join(root, "docs", "graph-index.xml"), GRAPH_INDEX);
  writeFileSync(join(root, "docs", "modules", "M-A.xml"), MODULE);
  const command = options.command ?? "true";
  writeFileSync(
    join(root, "docs", "verification", "V-M-A.xml"),
    `<V-M-A><test-files><file>x.test.ts</file></test-files><module-checks><check-1>${command}</check-1></module-checks></V-M-A>`
  );
  if (options.config !== undefined) writeFileSync(join(root, "mygrace.config.json"), JSON.stringify(options.config));
  if (options.gitignore !== undefined) writeFileSync(join(root, ".gitignore"), options.gitignore);
  return root;
}

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

describe("trust record shape", () => {
  test("absent record: loadTrustRecord → null, checkTrust → untrusted", () => {
    const root = makeProject();
    try {
      expect(loadTrustRecord(root)).toBeNull();
      const check = checkTrust(root);
      expect(check.trusted).toBe(false);
      expect(check.recordFound).toBe(false);
      expect(check.reason).toContain("no trust record");
      expect(check.recordPath).toBe(join(root, ".mygrace", "trust.json"));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("writeTrustRecord covers docs/modules + docs/verification with sorted sha256 entries", () => {
    const root = makeProject();
    try {
      const record = writeTrustRecord(root);
      expect(record.version).toBe(TRUST_RECORD_VERSION);
      expect(Number.isNaN(Date.parse(record.generatedAt))).toBe(false);
      expect(Object.keys(record.files)).toEqual(["docs/modules/M-A.xml", "docs/verification/V-M-A.xml"]);
      for (const hash of Object.values(record.files)) expect(hash).toMatch(/^[0-9a-f]{64}$/);

      const expected = createHash("sha256").update(readFileSync(join(root, "docs", "verification", "V-M-A.xml"))).digest("hex");
      expect(record.files["docs/verification/V-M-A.xml"]).toBe(expected);

      const onDisk = JSON.parse(readFileSync(trustFilePath(root), "utf-8"));
      expect(onDisk).toEqual(record);
      // Stable JSON: fields in fixed order, files sorted (reviewable diffs).
      const text = readFileSync(trustFilePath(root), "utf-8");
      expect(text.startsWith(`{\n  "version": 1,\n  "generatedAt":`)).toBe(true);
      expect(text.indexOf("docs/modules/M-A.xml")).toBeLessThan(text.indexOf("docs/verification/V-M-A.xml"));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("mygrace.config.json is covered when present (testRunner is a command source)", () => {
    const root = makeProject({ config: { testRunner: "pytest -q" } });
    try {
      const record = writeTrustRecord(root);
      expect(Object.keys(record.files)).toEqual([
        "docs/modules/M-A.xml",
        "docs/verification/V-M-A.xml",
        "mygrace.config.json",
      ]);
      expect(computeTrustHashes(root)).toEqual(record.files);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("checkTrust invalidation", () => {
  test("trusted after writeTrustRecord", () => {
    const root = makeProject();
    try {
      writeTrustRecord(root);
      const check = checkTrust(root);
      expect(check.trusted).toBe(true);
      expect(check.reason).toContain("current");
      expect(check.fileCount).toBe(2);
      expect(check.stale).toEqual([]);
      expect(check.missing).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("editing a command file makes the record stale (refusal source of truth)", () => {
    const root = makeProject();
    try {
      writeTrustRecord(root);
      writeFileSync(
        join(root, "docs", "verification", "V-M-A.xml"),
        `<V-M-A><test-files><file>x.test.ts</file></test-files><module-checks><check-1>./evil.sh</check-1></module-checks></V-M-A>`
      );
      const check = checkTrust(root);
      expect(check.trusted).toBe(false);
      expect(check.stale).toEqual(["docs/verification/V-M-A.xml"]);
      expect(check.reason).toContain("stale");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("editing mygrace.config.json testRunner invalidates trust", () => {
    const root = makeProject({ config: { testRunner: "bun test" } });
    try {
      writeTrustRecord(root);
      writeFileSync(join(root, "mygrace.config.json"), JSON.stringify({ testRunner: "./evil.sh" }));
      const check = checkTrust(root);
      expect(check.trusted).toBe(false);
      expect(check.stale).toEqual(["mygrace.config.json"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("a new unhashed command file is missing from the record", () => {
    const root = makeProject();
    try {
      writeTrustRecord(root);
      mkdirSync(join(root, "docs", "verification", "shards"), { recursive: true });
      writeFileSync(join(root, "docs", "verification", "shards", "V-M-B.xml"), `<V-M-B><module-checks><check-1>./evil.sh</check-1></module-checks></V-M-B>`);
      const check = checkTrust(root);
      expect(check.trusted).toBe(false);
      expect(check.missing).toEqual(["docs/verification/shards/V-M-B.xml"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("deleting a command file is reported as removed but stays trusted", () => {
    const root = makeProject();
    try {
      writeTrustRecord(root);
      unlinkSync(join(root, "docs", "verification", "V-M-A.xml"));
      const check = checkTrust(root);
      expect(check.trusted).toBe(true);
      expect(check.removed).toEqual(["docs/verification/V-M-A.xml"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("tampering the recorded hash invalidates trust", () => {
    const root = makeProject();
    try {
      writeTrustRecord(root);
      const path = trustFilePath(root);
      const record = JSON.parse(readFileSync(path, "utf-8"));
      record.files["docs/verification/V-M-A.xml"] = "0".repeat(64);
      writeFileSync(path, JSON.stringify(record, null, 2));
      const check = checkTrust(root);
      expect(check.trusted).toBe(false);
      expect(check.stale).toEqual(["docs/verification/V-M-A.xml"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("loadTrustRecord validation", () => {
  function writeRawRecord(root: string, content: string): void {
    mkdirSync(join(root, ".mygrace"), { recursive: true });
    writeFileSync(trustFilePath(root), content);
  }

  test("malformed JSON is a typed ConfigError", () => {
    const root = makeProject();
    try {
      writeRawRecord(root, "{ not json");
      expect(() => loadTrustRecord(root)).toThrow(ConfigError);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("wrong version is a typed ConfigError", () => {
    const root = makeProject();
    try {
      writeRawRecord(root, JSON.stringify({ version: 99, generatedAt: new Date().toISOString(), files: {} }));
      expect(() => loadTrustRecord(root)).toThrow(ConfigError);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("unsafe/traversal paths in the record are rejected", () => {
    const root = makeProject();
    try {
      writeRawRecord(
        root,
        JSON.stringify({ version: 1, generatedAt: new Date().toISOString(), files: { "../../etc/passwd": "a".repeat(64) } })
      );
      expect(() => loadTrustRecord(root)).toThrow(ConfigError);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("checkTrust never throws on a corrupt record — it reports the reason", () => {
    const root = makeProject();
    try {
      writeRawRecord(root, "garbage");
      const check = checkTrust(root);
      expect(check.trusted).toBe(false);
      expect(check.error?.code).toBe("TRUST_RECORD_INVALID");
      expect(check.reason).toContain("invalid");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("authorizeCommands", () => {
  test("no record, no config, no flag → not authorized", () => {
    const root = makeProject();
    try {
      const authorization = authorizeCommands(root, defaultConfig(), false);
      expect(authorization.authorized).toBe(false);
      expect(authorization.via).toBeNull();
      expect(authorization.shellOptIn).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("explicit --allow-commands wins and enables shell-style opt-in", () => {
    const root = makeProject();
    try {
      const authorization = authorizeCommands(root, defaultConfig(), true);
      expect(authorization.authorized).toBe(true);
      expect(authorization.via).toBe("flag");
      expect(authorization.shellOptIn).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("config.allowCommands authorizes without shell opt-in", () => {
    const root = makeProject();
    try {
      const config = { ...defaultConfig(), allowCommands: true };
      const authorization = authorizeCommands(root, config, false);
      expect(authorization.authorized).toBe(true);
      expect(authorization.via).toBe("config");
      expect(authorization.shellOptIn).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("a current trust record authorizes; persisted allowCommands enables shell opt-in", () => {
    const root = makeProject();
    try {
      writeTrustRecord(root);
      const plain = authorizeCommands(root, defaultConfig(), false);
      expect(plain.authorized).toBe(true);
      expect(plain.via).toBe("trust");
      expect(plain.shellOptIn).toBe(false);

      writeTrustRecord(root, { allowCommands: true });
      const optedIn = authorizeCommands(root, defaultConfig(), false);
      expect(optedIn.authorized).toBe(true);
      expect(optedIn.via).toBe("trust");
      expect(optedIn.shellOptIn).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("trustCommand", () => {
  test("writes the record and lists every declared command (text mode, exit 0)", async () => {
    const root = makeProject();
    try {
      const { stdout, exit, thrown } = await capture(() => trustCommand.run!({ args: { path: root } } as never));
      expect(thrown).toBeUndefined();
      expect(exit).toBe(0);
      expect(existsSync(trustFilePath(root))).toBe(true);
      expect(stdout).toContain("MyGRACE trust");
      expect(stdout).toContain("docs/verification/V-M-A.xml — M-A: true");
      expect(stdout).toContain("Wrote");
      expect(stdout).toContain("mygrace test");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("--format json emits the ADR-8 trust envelope after the review step", async () => {
    const root = makeProject();
    try {
      const { stdout, exit } = await capture(() => trustCommand.run!({ args: { path: root, format: "json" } } as never));
      expect(exit).toBe(0);
      const envelope = JSON.parse(stdout);
      expect(envelope.ok).toBe(true);
      expect(envelope.exitCode).toBe(0);
      expect(envelope.meta.command).toBe("trust");
      expect(envelope.data.trusted).toBe(true);
      expect(envelope.data.recordPath).toBe(trustFilePath(root));
      expect(envelope.data.files).toEqual(["docs/modules/M-A.xml", "docs/verification/V-M-A.xml"]);
      expect(envelope.data.commands[0]).toMatchObject({ file: "docs/verification/V-M-A.xml", command: "true", source: "verification" });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("warns (finding) when .mygrace/ is not gitignored; silent when it is", async () => {
    const missing = makeProject({ gitignore: "node_modules/\n" });
    const covered = makeProject({ gitignore: "node_modules/\n.mygrace/\n" });
    try {
      const warned = await capture(() => trustCommand.run!({ args: { path: missing, format: "json" } } as never));
      const warnedEnvelope = JSON.parse(warned.stdout);
      expect(warnedEnvelope.findings.some((item: { code: string }) => item.code === "TRUST_RECORD_NOT_GITIGNORED")).toBe(true);
      expect(warned.exit).toBe(0); // warning does not fail the command

      const ok = await capture(() => trustCommand.run!({ args: { path: covered, format: "json" } } as never));
      const okEnvelope = JSON.parse(ok.stdout);
      expect(okEnvelope.findings.some((item: { code: string }) => item.code === "TRUST_RECORD_NOT_GITIGNORED")).toBe(false);
    } finally {
      rmSync(missing, { recursive: true, force: true });
      rmSync(covered, { recursive: true, force: true });
    }
  });

  test("a malformed command-source XML is an error finding (exit 1) but the record is still written", async () => {
    const root = makeProject();
    try {
      writeFileSync(join(root, "docs", "verification", "V-M-A.xml"), "<V-M-A><module-checks><check-1>true</check-1></V-M-A>");
      const { exit, stdout } = await capture(() => trustCommand.run!({ args: { path: root, format: "json" } } as never));
      expect(exit).toBe(1);
      const envelope = JSON.parse(stdout);
      expect(envelope.findings.some((item: { code: string }) => item.code === "XML_INVALID")).toBe(true);
      expect(existsSync(trustFilePath(root))).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("--allow-commands persists the shell opt-in", async () => {
    const root = makeProject();
    try {
      await capture(() => trustCommand.run!({ args: { path: root, allowCommands: true } } as never));
      const record = loadTrustRecord(root);
      expect(record?.allowCommands).toBe(true);
      expect(checkTrust(root).allowCommands).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

/** Helper: config object for authorizeCommands unit tests (defaults + explicit layout). */
function defaultConfig(): Parameters<typeof authorizeCommands>[1] {
  return { ...cloneDefault(), sourceDirs: ["src"], markupExts: [".ts"], ignoreDirs: ["node_modules"] };
}
