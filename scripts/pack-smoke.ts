/**
 * MyGRACE — release gate: prove the *packaged* CLI works (ROADMAP G1).
 *
 * v1 shipped a tarball that could not start because `files` omitted five
 * statically imported modules; `prepublishOnly` validated the repository, not
 * the artifact. This script packs the package, extracts it into a throwaway
 * directory and then:
 *
 *   1. verifies every relative import of `src/grace.ts` exists in the tarball,
 *   2. runs the packaged CLI (`--version`, `--help`),
 *   3. runs `init-dsh` on an empty project and lints the generated scaffold,
 *   4. runs `install-dsh --dry-run` against a throwaway DSH_HOME.
 *
 * Exits 1 with an actionable message on the first failed assertion.
 *
 * Usage: bun run scripts/pack-smoke.ts [--keep]
 */

import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { findElements, parseXml } from "../src/grace-xml";

const ROOT = resolve(import.meta.dirname, "..");
const KEEP = process.argv.includes("--keep");

interface SmokeContext {
  workDir: string;
  packageDir: string;
  tarball: string;
  packagedCli: string;
}

function log(message: string): void {
  process.stdout.write(`[pack-smoke] ${message}\n`);
}

function fail(message: string, hint?: string): never {
  process.stderr.write(`[pack-smoke] FAIL: ${message}\n`);
  if (hint !== undefined) process.stderr.write(`[pack-smoke] hint: ${hint}\n`);
  process.exit(1);
}

function run(command: string, args: string[], cwd: string, env: Record<string, string> = {}): string {
  try {
    return execFileSync(command, args, {
      cwd,
      encoding: "utf-8",
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    const details = error as { stdout?: string; stderr?: string; message?: string };
    fail(
      `command failed: ${command} ${args.join(" ")}`,
      `${(details.stderr ?? "").trim() || (details.stdout ?? "").trim() || details.message || "unknown error"}`
    );
  }
}

function prepare(): SmokeContext {
  const workDir = mkdtempSync(join(tmpdir(), "mygrace-pack-smoke-"));
  mkdirSync(join(workDir, "package"), { recursive: true });

  log(`packing into ${workDir}`);
  run("bun", ["pm", "pack", "--destination", workDir], ROOT);

  const tarballs = readdirSync(workDir).filter((file) => file.endsWith(".tgz"));
  if (tarballs.length !== 1) fail(`expected exactly one tarball, found ${tarballs.length}`);
  const tarball = join(workDir, tarballs[0] as string);

  mkdirSync(join(workDir, "extracted"), { recursive: true });
  run("tar", ["-xzf", tarball, "-C", join(workDir, "extracted")], workDir);

  const packageDir = join(workDir, "extracted", "package");
  if (!existsSync(join(packageDir, "package.json"))) fail("tarball has no package.json");

  return { workDir, packageDir, tarball, packagedCli: join(packageDir, "src", "grace.ts") };
}

/** 1. Static check: every `./x` import from the packaged entry point must ship. */
function checkEntryImportsShipped(ctx: SmokeContext): void {
  const entry = join(ctx.packageDir, "src", "grace.ts");
  if (!existsSync(entry)) fail("src/grace.ts is missing from the tarball", "add it to package.json files");
  const source = readFileSync(entry, "utf-8");
  const imports = [...source.matchAll(/from\s+"(\.\/[^"]+)"/gu)].map((match) => match[1] as string);
  if (imports.length === 0) fail("could not find local imports in src/grace.ts");

  for (const request of imports) {
    const target = join(ctx.packageDir, "src", `${request.slice(2)}.ts`);
    if (!existsSync(target)) {
      fail(
        `packaged CLI imports "./${request.slice(2)}" but it is not in the tarball`,
        "add the missing src/*.ts files (or the whole src directory) to package.json files"
      );
    }
  }
  log(`entry-point imports shipped: ${imports.length}/${imports.length}`);
}

/** 2. The packaged CLI must start and report the packaged version. */
function checkCliStarts(ctx: SmokeContext): void {
  const version = JSON.parse(readFileSync(join(ctx.packageDir, "package.json"), "utf-8")).version as string;
  const output = run("bun", ["run", ctx.packagedCli, "--version"], ctx.packageDir).trim();
  if (!output.includes(version)) fail(`packaged CLI --version printed "${output}", expected "${version}"`);
  log(`packaged CLI starts: version ${version}`);

  const help = run("bun", ["run", ctx.packagedCli, "--help"], ctx.packageDir);
  if (!help.includes("COMMANDS")) fail("packaged CLI --help did not print the command list");
  log("packaged CLI --help works");
}

/** 3. End-to-end: init-dsh must produce a lint-clean scaffold from packaged templates. */
function checkInitDsh(ctx: SmokeContext): void {
  const projectDir = join(ctx.workDir, "scaffold");
  mkdirSync(projectDir, { recursive: true });
  run("bun", ["run", ctx.packagedCli, "init-dsh", "--path", projectDir, "--name", "PackSmoke"], ctx.packageDir);

  const indexPath = join(projectDir, "docs", "graph-index.xml");
  if (!existsSync(indexPath)) fail("init-dsh did not create docs/graph-index.xml");
  try {
    const document = parseXml(readFileSync(indexPath, "utf-8"), indexPath);
    if (!findElements(document, (element) => element.tag === "GraphIndex").length) {
      fail("generated graph-index.xml has no GraphIndex root");
    }
  } catch (error) {
    fail(`generated docs XML is invalid: ${String(error)}`);
  }

  const lintOutput = run("bun", ["run", ctx.packagedCli, "lint", "--path", projectDir], ctx.packageDir);
  if (!lintOutput.includes("0") || lintOutput.includes("Errors: 1")) {
    fail(`fresh scaffold does not lint clean:\n${lintOutput}`);
  }
  log("init-dsh scaffold lints clean");
}

/** 4. Installer dry-run against a throwaway home (never touches the real ~/.dsh). */
function checkInstallDryRun(ctx: SmokeContext): void {
  const fakeHome = join(ctx.workDir, "home");
  mkdirSync(join(fakeHome, ".dsh", "profiles", "web"), { recursive: true });
  writeFileSync(join(fakeHome, ".dsh", "profiles", "web", "cordis.patch.yml"), "[]\n");

  const output = run("bun", ["run", ctx.packagedCli, "install-dsh", "--dry-run"], ctx.packageDir, {
    HOME: fakeHome,
    DSH_HOME: join(fakeHome, ".dsh"),
  });
  if (!output.includes("would")) fail(`install-dsh --dry-run printed no planned actions:\n${output}`);
  if (existsSync(join(fakeHome, ".dsh", "skills"))) fail("install-dsh --dry-run wrote files despite --dry-run");
  log("install-dsh --dry-run plans actions without writing");
}

function main(): void {
  const started = Date.now();
  const ctx = prepare();
  try {
    checkEntryImportsShipped(ctx);
    checkCliStarts(ctx);
    checkInitDsh(ctx);
    checkInstallDryRun(ctx);
    log(`OK (${Date.now() - started} ms) — tarball ${relative(ROOT, ctx.tarball) || ctx.tarball}`);
  } finally {
    if (KEEP) {
      log(`artifacts kept in ${ctx.workDir}`);
    } else {
      rmSync(ctx.workDir, { recursive: true, force: true });
    }
  }
}

main();
