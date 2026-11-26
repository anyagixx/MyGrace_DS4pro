/**
 * MyGRACE — guidance packs (ADR-12) tests.
 *
 * Local packs are filesystem-only; CLI packs use a fake executable so the
 * suite never needs network access. Trust-gating and path traversal are the
 * security-critical cases.
 */

import { describe, expect, test } from "bun:test";

const POSIX_ONLY = process.platform !== "win32";
const posixTest = test.skipIf(!POSIX_ONLY);
import { chmodSync, cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cloneDefault } from "../src/grace-config";
import type { MyGraceConfig } from "../src/grace-config";
import { GuidancePackSettings } from "../src/grace-config";
import {
  GUIDANCE_LOCK_FILENAME,
  guidanceCommandPinned,
  loadGuidanceLock,
  retrieveGuidance,
  searchGuidance,
  writeGuidanceLock,
} from "../src/grace-guidance";

const EXAMPLES = join(import.meta.dir, "..", "examples", "guidance-packs");

function makeRoot(): string {
  return mkdtempSync(join(tmpdir(), "mygrace-guidance-"));
}

function localPackConfig(...paths: string[]): MyGraceConfig {
  const config = cloneDefault();
  config.guidancePacks = paths.map((path, index) => ({
    name: `pack-${index + 1}`,
    enabled: "auto",
    kind: "local",
    path,
    command: null,
    timeoutMs: 10_000,
  }));
  return config;
}

describe("local guidance packs", () => {
  test("searches across two configured packs", () => {
    const root = makeRoot();
    try {
      cpSync(join(EXAMPLES, "web-basics"), join(root, "packs", "web-basics"), { recursive: true });
      cpSync(join(EXAMPLES, "security-basics"), join(root, "packs", "security-basics"), { recursive: true });
      const config = localPackConfig("packs/web-basics", "packs/security-basics");
      const data = searchGuidance(root, config, "session", { allowCommands: false, allowUnsafeCommands: false });
      expect(data.packs.filter((pack) => pack.available)).toHaveLength(2);
      expect(data.results.some((hit) => hit.pack === "pack-2" && hit.id === "secure-cookies")).toBe(true);
      expect(data.results.some((hit) => hit.pack === "pack-1" && hit.id === "accessible-dialog")).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("retrieves a guide by id and rejects traversal", () => {
    const root = makeRoot();
    try {
      cpSync(join(EXAMPLES, "web-basics"), join(root, "packs", "web-basics"), { recursive: true });
      const config = localPackConfig("packs/web-basics");
      const hit = searchGuidance(root, config, "dialog", { allowCommands: false, allowUnsafeCommands: false });
      expect(hit.results.some((result) => result.id === "accessible-dialog")).toBe(true);
      const retrieved = retrieveGuidance(root, config, "pack-1", "accessible-dialog", { allowCommands: false, allowUnsafeCommands: false });
      expect(retrieved.content).toContain("showModal()");
      expect(() =>
        retrieveGuidance(root, config, "pack-1", "../../etc/passwd", { allowCommands: false, allowUnsafeCommands: false })
      ).toThrow(/Unknown guide/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("reports an unavailable local pack instead of crashing", () => {
    const root = makeRoot();
    try {
      const config = localPackConfig(join(root, "missing"));
      const data = searchGuidance(root, config, "anything", { allowCommands: false, allowUnsafeCommands: false });
      expect(data.results).toEqual([]);
      expect(data.packs[0]?.skippedReason).toBe("missing-path");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("CLI guidance packs", () => {
  function cliConfig(command: string): MyGraceConfig {
    const config = cloneDefault();
    config.allowCommands = true;
    config.guidancePacks = [
      { name: "fake-cli", enabled: "auto", kind: "cli", path: null, command, timeoutMs: 10_000 } satisfies GuidancePackSettings,
    ];
    return config;
  }

  posixTest("searches and retrieves through a trust-gated CLI pack", () => {
    const root = makeRoot();
    try {
      const cli = join(root, "guide.sh");
      writeFileSync(
        cli,
        `#!/bin/sh
case "$1" in
  search) echo '[{"id":"dialog","description":"Native dialog guidance"}]' ;;
  retrieve) echo "# Dialog\\n\\nUse showModal()." ;;
  *) exit 2 ;;
esac
`
      );
      chmodSync(cli, 0o755);
      const config = cliConfig("./guide.sh");
      const search = searchGuidance(root, config, "dialog", { allowCommands: false, allowUnsafeCommands: false });
      expect(search.results).toEqual([
        { pack: "fake-cli", id: "dialog", title: "dialog", description: "Native dialog guidance" },
      ]);
      const retrieved = retrieveGuidance(root, config, "fake-cli", "dialog", { allowCommands: false, allowUnsafeCommands: false });
      expect(retrieved.content).toContain("showModal()");
      expect(retrieved.source).toBe("cli");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("skips a CLI pack when commands are untrusted", () => {
    const root = makeRoot();
    try {
      const config = cliConfig("echo never-run");
      config.allowCommands = false;
      const data = searchGuidance(root, config, "dialog", { allowCommands: false, allowUnsafeCommands: false });
      expect(data.results).toEqual([]);
      expect(data.packs[0]?.skippedReason).toBe("untrusted");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("guidance CLI pinning", () => {
  test("flags @latest and bare npx specs", () => {
    expect(guidanceCommandPinned("npx -y modern-web-guidance@latest")).toBe(false);
    expect(guidanceCommandPinned("npx -y modern-web-guidance")).toBe(false);
    expect(guidanceCommandPinned("npx -y modern-web-guidance@1.0.2")).toBe(true);
    expect(guidanceCommandPinned("./guide.sh")).toBe(true);
  });
});

describe("guidance lockfile", () => {
  test("locks and verifies a local pack; tampering is detected", () => {
    const root = makeRoot();
    try {
      cpSync(join(EXAMPLES, "web-basics"), join(root, "packs", "web-basics"), { recursive: true });
      const config = localPackConfig("packs/web-basics");
      const options = { allowCommands: false, allowUnsafeCommands: false };
      const lock = writeGuidanceLock(root, config, options);
      expect(lock.packs["pack-1"]?.kind).toBe("local");
      expect(lock.packs["pack-1"]?.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(loadGuidanceLock(root)?.["packs"]?.["pack-1"]?.version).toBe("1.0.0");

      const verified = searchGuidance(root, config, "dialog", options);
      expect(verified.packs[0]?.locked).toBe("verified");
      expect(verified.results.length).toBeGreaterThan(0);

      const guide = join(root, "packs", "web-basics", "guides", "accessible-dialog.md");
      writeFileSync(guide, `${readFileSync(guide, "utf-8")}\n- tampered\n`);
      const tampered = searchGuidance(root, config, "dialog", options);
      expect(tampered.packs[0]?.locked).toBe("mismatch");
      expect(tampered.packs[0]?.available).toBe(false);
      expect(tampered.results).toEqual([]);
      expect(() => retrieveGuidance(root, config, "pack-1", "accessible-dialog", options)).toThrow(/not available/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("locks a CLI pack by command hash and version", () => {
    const root = makeRoot();
    try {
      const cli = join(root, "guide.sh");
      writeFileSync(
        cli,
        `#!/bin/sh
case "$1" in
  --version) echo 1.0.2 ;;
  search) echo '[{"id":"dialog","description":"Native dialog guidance"}]' ;;
  retrieve) echo "# Dialog" ;;
  *) exit 2 ;;
esac
`
      );
      chmodSync(cli, 0o755);
      const config = cloneDefault();
      config.allowCommands = true;
      config.guidancePacks = [{ name: "fake-cli", enabled: "auto", kind: "cli", path: null, command: "./guide.sh", timeoutMs: 10_000 }];
      const lock = writeGuidanceLock(root, config, { allowCommands: false, allowUnsafeCommands: false });
      expect(lock.packs["fake-cli"]?.commandHash).toMatch(/^[0-9a-f]{64}$/);
      expect(lock.packs["fake-cli"]?.version).toBe("1.0.2");
      expect(readFileSync(join(root, GUIDANCE_LOCK_FILENAME), "utf-8")).toContain("fake-cli");

      const search = searchGuidance(root, config, "dialog", { allowCommands: false, allowUnsafeCommands: false });
      expect(search.packs[0]?.locked).toBe("verified");
      expect(search.results).toHaveLength(1);

      config.guidancePacks[0]!.command = "./guide.sh --changed";
      const changed = searchGuidance(root, config, "dialog", { allowCommands: false, allowUnsafeCommands: false });
      expect(changed.packs[0]?.locked).toBe("mismatch");
      expect(changed.results).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
