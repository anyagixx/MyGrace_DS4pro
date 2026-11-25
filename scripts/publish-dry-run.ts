#!/usr/bin/env bun
/**
 * MyGRACE — publish dry-run: prove the *release artifact* is complete and runnable
 * BEFORE anything is published (ROADMAP G1/G10, task W4.2).
 *
 * `pack-smoke.ts` already exercises the packaged CLI by letting bun auto-install
 * dependencies from the network. This script is the stricter, offline-oriented
 * release gate:
 *
 *   1. `bun pm pack --destination <tmp>` and assert exactly one tarball whose
 *      filename matches `<normalized-name>-<version>.tgz`.
 *   2. Extract it and compare the tarball package.json with the checkout:
 *      name/version, `bin` target present, `files` entries present and non-empty,
 *      no `file:` dependencies, `publishConfig.access`, and no unexpected
 *      top-level entries in the tarball.
 *   3. Statically prove runtime completeness: every relative import of every
 *      shipped `src/**` file resolves inside the tarball, and every bare import
 *      of `src/**` is a Node/bun builtin or a declared runtime dependency.
 *   4. Install dependencies OFFLINE from the local bun cache
 *      (`bun install --production --offline --frozen-lockfile`, using a copied
 *      checkout lockfile and a writable BUN_INSTALL/BUN_TMPDIR). When this
 *      sandbox/CI cache is incomplete the script falls back to copying the
 *      checkout's production dependency closure and clearly marks the result as
 *      DEGRADED (see the summary) — it never silently pretends a registry
 *      install happened.
 *   5. Run the installed packaged CLI: `--version` must equal package.json and
 *      `--help` must list the commands parsed from the packaged `src/grace.ts`.
 *
 * What this does NOT validate (CI/registry steps): npm authentication, the
 * npm account/package ownership, 2FA/trusted-publisher configuration, provenance
 * signature generation (needs GitHub OIDC + npm registry), network install,
 * postinstall script behaviour, and platform-specific runtime behavior
 * (Linux/Windows/macOS coverage lives in the CI matrix). Those are documented in
 * the release workflow and the summary below.
 *
 * Usage: bun run scripts/publish-dry-run.ts [--keep]
 * Exit codes: 0 artifact validated, 1 validation failed, 2 usage error.
 */

import { execFileSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { builtinModules } from "node:module";
import { dirname, extname, join, normalize, relative, resolve, sep } from "node:path";
import { tmpdir } from "node:os";

// ─── CLI / process helpers ─────────────────────────────────────────────

const ROOT = resolve(import.meta.dirname, "..");
const KEEP = process.argv.includes("--keep");
const WORK_PREFIX = "mygrace-publish-dry-";

interface CommandResult {
  status: number;
  stdout: string;
  stderr: string;
}

class PublishCheckError extends Error {
  readonly hint?: string;
  constructor(message: string, hint?: string) {
    super(message);
    this.name = "PublishCheckError";
    this.hint = hint;
  }
}

function check(condition: boolean, message: string, hint?: string): asserts condition {
  if (!condition) throw new PublishCheckError(message, hint);
}

function run(command: string, args: readonly string[], options: { cwd: string; env?: NodeJS.ProcessEnv }): CommandResult {
  try {
    const stdout = execFileSync(command, [...args], {
      cwd: options.cwd,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, ...options.env },
      timeout: 5 * 60_000,
      maxBuffer: 32 * 1024 * 1024,
    });
    return { status: 0, stdout, stderr: "" };
  } catch (error) {
    const details = error as { stdout?: string; stderr?: string; message?: string; status?: number };
    return {
      status: typeof details.status === "number" ? details.status : 1,
      stdout: details.stdout ?? "",
      stderr: details.stderr ?? details.message ?? "",
    };
  }
}

function log(step: string, message: string): void {
  process.stdout.write(`[publish-dry-run] ${step} ${message}\n`);
}

// ─── filesystem helpers ────────────────────────────────────────────────

function readJsonFile(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path, "utf-8")) as Record<string, unknown>;
}

function listFilesRecursive(dir: string, base = dir): string[] {
  if (!existsSync(dir)) return [];
  const output: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === ".git") continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) output.push(...listFilesRecursive(full, base));
    else if (entry.isFile()) output.push(relative(base, full).split(sep).join("/"));
  }
  return output.sort();
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

// ─── static import analysis ────────────────────────────────────────────

interface PackageJsonShape {
  name: string;
  version: string;
  bin?: Record<string, string> | string;
  files?: string[];
  dependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  engines?: Record<string, string>;
  publishConfig?: { access?: string };
}

interface ImportRef {
  specifier: string;
  kind: "relative" | "bare";
}

const LOADERS: Record<string, "js" | "jsx" | "ts" | "tsx"> = {
  ".js": "js",
  ".mjs": "js",
  ".cjs": "js",
  ".jsx": "jsx",
  ".ts": "ts",
  ".tsx": "tsx",
};

/**
 * Extract imports with Bun's own transpiler instead of regexes: a regex over
 * source text happily reports `import`-looking text inside strings/templates
 * (that produced a false positive during development) and misses multi-line
 * `import { … } from "…"` statements.
 *
 * Dynamic imports with computed specifiers are not statically checkable and are
 * therefore (explicitly) out of scope; only string-literal imports are listed.
 */
function importsOf(content: string, extension: string): ImportRef[] {
  const loader = LOADERS[extension] ?? "js";
  const stripped = content.replace(/^#![^\n]*\n/, ""); // shebang is not valid module syntax
  const records = new Bun.Transpiler({ loader }).scanImports(stripped);
  const seen = new Set<string>();
  const refs: ImportRef[] = [];
  for (const record of records) {
    if (seen.has(record.path)) continue;
    seen.add(record.path);
    refs.push({ specifier: record.path, kind: record.path.startsWith(".") ? "relative" : "bare" });
  }
  return refs;
}

const RESOLVE_EXTENSIONS = [".ts", ".tsx", ".js", ".mjs", ".cjs", ".json"];

/** Resolve a relative import inside the package dir; null when missing/escaping. */
function resolveRelativeImport(specifier: string, fromFile: string, packageDir: string): string | null {
  const base = resolve(dirname(fromFile), specifier);
  const normalizedBase = normalize(base);
  const normalizedPackage = normalize(resolve(packageDir));
  if (normalizedBase !== normalizedPackage && !normalizedBase.startsWith(`${normalizedPackage}${sep}`)) {
    return null; // escapes the tarball
  }
  const candidates: string[] = [normalizedBase];
  for (const extension of RESOLVE_EXTENSIONS) candidates.push(`${normalizedBase}${extension}`);
  for (const extension of RESOLVE_EXTENSIONS) candidates.push(join(normalizedBase, `index${extension}`));
  for (const candidate of candidates) {
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
  }
  return null;
}

function packageNameOfBareSpecifier(specifier: string): string | null {
  if (specifier.startsWith("node:") || specifier.startsWith("bun:") || specifier.startsWith("data:")) return null;
  if (builtinModules.includes(specifier)) return null;
  const parts = specifier.split("/");
  if (specifier.startsWith("@")) return parts.length >= 2 ? `${parts[0]}/${parts[1]}` : specifier;
  return parts[0] ?? specifier;
}

interface StaticAnalysis {
  filesChecked: number;
  relativeImports: number;
  bareImports: number;
}

function verifyStaticCompleteness(packageDir: string, pkg: PackageJsonShape): StaticAnalysis {
  const shippedFiles = listFilesRecursive(join(packageDir, "src")).filter((file) =>
    [".ts", ".tsx", ".js", ".mjs", ".cjs"].includes(extname(file))
  );
  const declaredDependencies = new Set(Object.keys(pkg.dependencies ?? {}));
  const missing: string[] = [];
  const undeclared: string[] = [];
  let relativeImports = 0;
  let bareImports = 0;

  for (const relativeFile of shippedFiles) {
    const absoluteFile = join(packageDir, "src", relativeFile);
    const extension = extname(relativeFile);
    for (const ref of importsOf(readFileSync(absoluteFile, "utf-8"), extension)) {
      if (ref.kind === "relative") {
        relativeImports += 1;
        if (resolveRelativeImport(ref.specifier, absoluteFile, packageDir) === null) {
          missing.push(`src/${relativeFile} → "${ref.specifier}" (not shipped)`);
        }
        continue;
      }
      const dependency = packageNameOfBareSpecifier(ref.specifier);
      if (dependency === null) continue;
      bareImports += 1;
      if (!declaredDependencies.has(dependency)) {
        undeclared.push(`src/${relativeFile} → "${ref.specifier}" (dependency "${dependency}" is not in package.json dependencies)`);
      }
    }
  }

  // The optional DSH panel ships as plain JS and may reference host-provided
  // globals/modules (`react/jsx-runtime`): verify only that its relative imports
  // stay inside its own directory.
  const panelDir = join(packageDir, "packages", "mygrace-status-panel");
  if (isDirectory(panelDir)) {
    for (const relativeFile of listFilesRecursive(panelDir).filter((file) => file.endsWith(".js"))) {
      const absoluteFile = join(panelDir, relativeFile);
      for (const ref of importsOf(readFileSync(absoluteFile, "utf-8"), ".js")) {
        if (ref.kind !== "relative") continue;
        if (resolveRelativeImport(ref.specifier, absoluteFile, panelDir) === null) {
          missing.push(`packages/mygrace-status-panel/${relativeFile} → "${ref.specifier}"`);
        }
      }
    }
  }

  check(
    missing.length === 0,
    `shipped sources import files that are not in the tarball:\n  - ${missing.join("\n  - ")}`,
    "Add the missing paths to package.json `files` (or stop importing them). `files` omissions are exactly how v1 shipped a broken CLI."
  );
  check(
    undeclared.length === 0,
    `shipped sources import packages that are not declared runtime dependencies:\n  - ${undeclared.join("\n  - ")}`,
    "Add the package to `dependencies` (not `devDependencies`) in package.json."
  );

  return { filesChecked: shippedFiles.length, relativeImports, bareImports };
}

// ─── tarball checks ────────────────────────────────────────────────────

interface TarballReport {
  tarballPath: string;
  packageDir: string;
  tarballPackage: PackageJsonShape;
}

function packAndExtract(workDir: string, rootPkg: PackageJsonShape): TarballReport {
  const packDir = join(workDir, "pack");
  mkdirSync(packDir, { recursive: true });
  log("1/6", `packing ${rootPkg.name}@${rootPkg.version} …`);
  const pack = run("bun", ["pm", "pack", "--destination", packDir], { cwd: ROOT });
  check(pack.status === 0, `bun pm pack failed: ${(pack.stderr || pack.stdout).trim()}`);

  const tarballs = readdirSync(packDir).filter((file) => file.endsWith(".tgz"));
  check(tarballs.length === 1, `expected exactly one tarball, found ${tarballs.length}: ${tarballs.join(", ")}`);
  const tarballName = tarballs[0] as string;
  const tarballPath = join(packDir, tarballName);
  const normalizedName = rootPkg.name.replace(/^@/, "").replace("/", "-");
  check(
    tarballName === `${normalizedName}-${rootPkg.version}.tgz`,
    `tarball name "${tarballName}" does not match <name>-<version>.tgz (${normalizedName}-${rootPkg.version}.tgz)`,
    "Check package.json name/version; bun pm pack derives the tarball name from them."
  );

  const extractedDir = join(workDir, "extracted");
  mkdirSync(extractedDir, { recursive: true });
  const untar = run("tar", ["-xzf", tarballPath, "-C", extractedDir], { cwd: workDir });
  check(untar.status === 0, `tar extraction failed: ${(untar.stderr || untar.stdout).trim()}`);

  const packageDir = join(extractedDir, "package");
  check(existsSync(join(packageDir, "package.json")), "extracted tarball has no package.json");
  const tarballPackage = readJsonFile(join(packageDir, "package.json")) as unknown as PackageJsonShape;
  return { tarballPath, packageDir, tarballPackage };
}

function verifyTarballManifest(packageDir: string, tarballPackage: PackageJsonShape, rootPkg: PackageJsonShape): string[] {
  const notes: string[] = [];
  check(
    tarballPackage.name === rootPkg.name && tarballPackage.version === rootPkg.version,
    `tarball package.json is ${tarballPackage.name}@${tarballPackage.version}, checkout is ${rootPkg.name}@${rootPkg.version}`
  );
  check(tarballPackage.publishConfig?.access === "public", 'tarball package.json is missing publishConfig.access = "public" (scoped package publish would fail)');

  const binEntries: Array<[string, string]> =
    typeof tarballPackage.bin === "string"
      ? [["mygrace", tarballPackage.bin]]
      : Object.entries(tarballPackage.bin ?? {});
  check(binEntries.length > 0, "tarball package.json has no `bin` entry — `npx mygrace-cli` would not work");
  for (const [binName, binPath] of binEntries) {
    check(existsSync(join(packageDir, binPath)), `bin "${binName}" points to "${binPath}" which is missing from the tarball`);
  }

  const fileEntries = rootPkg.files ?? [];
  check(fileEntries.length > 0, "checkout package.json has no `files` allowlist");
  for (const entry of fileEntries) {
    const absolute = join(packageDir, entry);
    const present = isDirectory(absolute)
      ? listFilesRecursive(absolute).length > 0
      : existsSync(absolute);
    check(present, `package.json "files" entry "${entry}" is missing (or empty) in the published tarball`);
  }

  const allowedTopLevel = new Set(["package.json"]);
  for (const entry of fileEntries) allowedTopLevel.add(entry.split("/")[0] as string);
  const actualTopLevel = new Set(
    listFilesRecursive(packageDir)
      .map((file) => file.split("/")[0] as string)
      .filter((name) => name !== "")
  );
  const unexpected = [...actualTopLevel].filter((name) => !allowedTopLevel.has(name));
  check(
    unexpected.length === 0,
    `tarball contains unexpected top-level entries not covered by "files": ${unexpected.join(", ")}`,
    "Add them to package.json `files` if intended, or delete them from the publish tree."
  );

  for (const [dependency, specifier] of Object.entries(tarballPackage.dependencies ?? {})) {
    check(
      !String(specifier).startsWith("file:"),
      `runtime dependency "${dependency}" uses "${specifier}" — npm cannot publish/install file: dependencies`,
      "Use a real semver range for published dependencies (see scripts/publish-prepare.ts for the optional bundle packages)."
    );
  }

  // npm 11/12 auto-normalises `./`-prefixed bin paths at publish time (the
  // published manifest stores `src/grace.ts`, which still installs correctly,
  // but npm prints an "auto-corrected package.json" warning). Prefer the clean
  // form in package.json so the publish log stays warning-free.
  const rawBinEntries: Array<[string, string]> =
    typeof rootPkg.bin === "string" ? [["mygrace", rootPkg.bin]] : Object.entries(rootPkg.bin ?? {});
  for (const [name, target] of rawBinEntries) {
    if (String(target).startsWith("./")) {
      notes.push(`bin["${name}"] = "${target}": npm publish auto-normalises the leading "./" (warning only; installed CLI still works). Prefer "${String(target).slice(2)}" in package.json.`);
    }
  }
  return notes;
}

// ─── offline install ───────────────────────────────────────────────────

type InstallMode = "offline-cache" | "checkout-closure";

interface InstallReport {
  mode: InstallMode;
  detail: string;
  cacheWarning?: string;
}

function copyProductionDependencyClosure(repoRoot: string, targetNodeModules: string): string[] {
  const sourceRoot = join(repoRoot, "node_modules");
  check(
    isDirectory(sourceRoot),
    "offline install failed and the checkout has no node_modules for the fallback",
    "Run `bun install` once in the repository (online) so the bun cache is primed, then re-run this script."
  );
  const copied: string[] = [];
  const visited = new Set<string>();

  const copyPackage = (dependency: string): void => {
    if (visited.has(dependency)) return;
    visited.add(dependency);
    const source = join(sourceRoot, ...dependency.split("/"));
    if (!isDirectory(source)) return; // optional/peer dependency not installed
    cpSync(source, join(targetNodeModules, ...dependency.split("/")), { recursive: true, dereference: false });
    copied.push(dependency);
    let manifest: Record<string, unknown> = {};
    try {
      manifest = readJsonFile(join(source, "package.json"));
    } catch {
      return;
    }
    for (const nested of Object.keys((manifest.dependencies as Record<string, string> | undefined) ?? {})) {
      copyPackage(nested);
    }
    for (const nested of Object.keys((manifest.optionalDependencies as Record<string, string> | undefined) ?? {})) {
      copyPackage(nested);
    }
  };

  for (const dependency of ["@modelcontextprotocol/sdk", "citty", "fast-xml-parser", "yaml"]) copyPackage(dependency);
  return copied;
}

function detectBunCacheDir(): string {
  return process.env.BUN_INSTALL_CACHE_DIR ?? join(homedir(), ".bun", "install", "cache");
}

function installDependenciesOffline(packageDir: string, workDir: string, repoRoot: string): InstallReport {
  log("4/6", "installing runtime dependencies OFFLINE from the local bun cache …");
  const lockSource = join(repoRoot, "bun.lock");
  if (existsSync(lockSource)) {
    cpSync(lockSource, join(packageDir, "bun.lock"));
  }

  const installEnv: NodeJS.ProcessEnv = {
    BUN_INSTALL: join(workDir, "bun-install"),
    BUN_INSTALL_CACHE_DIR: detectBunCacheDir(),
    BUN_TMPDIR: join(workDir, "bun-tmp"),
  };
  mkdirSync(installEnv.BUN_INSTALL as string, { recursive: true });
  mkdirSync(installEnv.BUN_TMPDIR as string, { recursive: true });

  const offline = run("bun", ["install", "--production", "--offline", "--frozen-lockfile"], {
    cwd: packageDir,
    env: installEnv,
  });
  if (offline.status === 0) {
    return { mode: "offline-cache", detail: `bun install --production --offline (cache: ${installEnv.BUN_INSTALL_CACHE_DIR})` };
  }

  const combined = `${offline.stdout}\n${offline.stderr}`;
  const cacheGaps = [...combined.matchAll(/"([^"]+)" is not in the cache/g)].map((match) => match[1] as string);
  const cacheWarning =
    cacheGaps.length > 0
      ? `bun cache is incomplete for: ${[...new Set(cacheGaps)].join(", ")} — run \`bun install\` once online to prime it for a true offline validation`
      : `offline install failed: ${combined.trim().split("\n").slice(-3).join(" | ")}`;

  log("4/6", `DEGRADED offline install: ${cacheWarning}`);
  log("4/6", "falling back to the checkout's production dependency closure (still offline) …");
  rmSync(join(packageDir, "node_modules"), { recursive: true, force: true });
  mkdirSync(join(packageDir, "node_modules"), { recursive: true });
  const copied = copyProductionDependencyClosure(repoRoot, join(packageDir, "node_modules"));
  check(copied.length > 0, "could not copy any runtime dependencies from the checkout", "Run `bun install` in the repository.");

  for (const required of ["@modelcontextprotocol/sdk", "citty", "fast-xml-parser", "yaml"]) {
    check(
      existsSync(join(packageDir, "node_modules", ...required.split("/"))),
      `fallback dependency copy is missing "${required}"`,
      "Run `bun install` in the repository and retry."
    );
  }

  return {
    mode: "checkout-closure",
    detail: `checkout dependency closure copied from node_modules (${copied.length} packages) — NOT a registry install`,
    cacheWarning,
  };
}

// ─── packaged CLI smoke ────────────────────────────────────────────────

interface CliReport {
  version: string;
  commandCount: number;
}

function verifyPackagedCli(packageDir: string, expectedVersion: string): CliReport {
  log("5/6", "running the packaged CLI (--version, --help) …");
  const version = run("bun", ["run", "./src/grace.ts", "--version"], { cwd: packageDir });
  check(
    version.status === 0,
    `packaged CLI --version failed:\n${(version.stderr || version.stdout).trim()}`,
    "The tarball cannot start from its own dependencies — a packaging regression."
  );
  const versionText = version.stdout.trim().split("\n").filter(Boolean).pop() ?? "";
  check(
    versionText.includes(expectedVersion),
    `packaged CLI --version printed "${versionText}", expected version ${expectedVersion}`,
    "The `version` source (package.json / src/grace.ts) is inconsistent."
  );

  const help = run("bun", ["run", "./src/grace.ts", "--help"], { cwd: packageDir });
  check(
    help.status === 0,
    `packaged CLI --help failed:\n${(help.stderr || help.stdout).trim()}`,
    "The citty command tree cannot load from the tarball."
  );
  const helpText = `${help.stdout}\n${help.stderr}`;
  check(helpText.trim().length > 0, "packaged CLI --help produced no output");

  // Derive the documented command list from the packaged CLI wiring, not a
  // hardcoded count: every top-level `name: guard(...)` must appear in --help.
  const graceSource = readFileSync(join(packageDir, "src", "grace.ts"), "utf-8");
  const commandNames = [...graceSource.matchAll(/\n\s{4}"?([a-z][a-z0-9-]*)"?:\s*guard\(/g)]
    .map((match) => match[1] as string)
    .filter((name, index, all) => all.indexOf(name) === index);
  check(commandNames.length > 0, "could not parse the subcommand table from the packaged src/grace.ts");
  const missingCommands = commandNames.filter((name) => !helpText.includes(name));
  check(
    missingCommands.length === 0,
    `packaged CLI --help does not list ${missingCommands.length} command(s): ${missingCommands.join(", ")}`,
    "Check the citty subCommands wiring; `--help` must expose the documented command surface."
  );

  return { version: versionText, commandCount: commandNames.length };
}

// ─── main ──────────────────────────────────────────────────────────────

interface RunSummary {
  notes: string[];
  rootPackage: PackageJsonShape;
  tarballPath: string;
  tarballFiles: number;
  tarballSizeKb: number;
  staticAnalysis: StaticAnalysis;
  install: InstallReport;
  cli: CliReport;
}

function execute(workDir: string): RunSummary {
  const rootPkg = readJsonFile(join(ROOT, "package.json")) as unknown as PackageJsonShape;
  check(rootPkg.name === "mygrace-cli", `unexpected package name "${rootPkg.name}"`);
  check(typeof rootPkg.version === "string" && /^\d+\.\d+\.\d+/.test(rootPkg.version), "package.json version is not semver");

  const tarball = packAndExtract(workDir, rootPkg);
  log("2/6", "verifying tarball manifest (files/bin/deps/top-level entries) …");
  const manifestNotes = verifyTarballManifest(tarball.packageDir, tarball.tarballPackage, rootPkg);

  log("3/6", "static runtime-completeness analysis (imports) …");
  const staticAnalysis = verifyStaticCompleteness(tarball.packageDir, tarball.tarballPackage);

  const install = installDependenciesOffline(tarball.packageDir, workDir, ROOT);
  const cli = verifyPackagedCli(tarball.packageDir, rootPkg.version);

  const tarballSizeKb = Math.round(statSync(tarball.tarballPath).size / 1024);
  return {
    notes: manifestNotes,
    rootPackage: rootPkg,
    tarballPath: tarball.tarballPath,
    tarballFiles: listFilesRecursive(tarball.packageDir).length,
    tarballSizeKb,
    staticAnalysis,
    install,
    cli,
  };
}

function printSummary(summary: RunSummary, workDir: string): void {
  const degraded = summary.install.mode !== "offline-cache";
  const lines = [
    "",
    "MyGRACE publish dry-run — artifact summary",
    "==========================================",
    `Package:        ${summary.rootPackage.name}@${summary.rootPackage.version}`,
    `Tarball:        ${summary.tarballPath.split(sep).pop()} (${summary.tarballFiles} files, ${summary.tarballSizeKb} KB)`,
    `Static imports: ${summary.staticAnalysis.filesChecked} shipped src files, ` +
      `${summary.staticAnalysis.relativeImports} relative + ${summary.staticAnalysis.bareImports} bare imports verified`,
    `Dependencies:   ${summary.install.mode === "offline-cache" ? "OFFLINE cache install" : "DEGRADED " + summary.install.detail}`,
    ...(summary.install.cacheWarning === undefined ? [] : [`Cache note:     ${summary.install.cacheWarning}`]),
    `Packaged CLI:   --version ${summary.cli.version}; --help lists ${summary.cli.commandCount} commands`,
    ...(summary.notes.length === 0 ? [] : ["", "Notes:", ...summary.notes.map((note) => `  - ${note}`)]),
    "",
    "Validated: tarball contents vs package.json files/bin, version/name, no file: deps, static import",
    "  completeness, offline dependency install (or clearly-marked degraded closure), packaged CLI",
    "  --version/--help with the documented command table.",
    "NOT validated here: npm auth/2FA/trusted publisher, npm account/package ownership, provenance",
    "  signature generation (GitHub OIDC), network install, postinstall scripts, Windows/macOS",
    "  runtime behavior (see the CI OS matrix), and actual `npm publish`.",
    "",
    degraded
      ? "✓ Artifact is publishable in substance (dependency install was DEGRADED — CI with a primed cache validates the true offline path)."
      : "✓ Artifact is publishable in substance (offline install succeeded).",
  ];
  process.stdout.write(`${lines.join("\n")}\n`);
  if (KEEP) process.stdout.write(`[publish-dry-run] kept artifacts at ${workDir}\n`);
}

function main(): void {
  if (process.argv.includes("--help") || process.argv.includes("-h")) {
    console.log(
      "Usage: bun run scripts/publish-dry-run.ts [--keep]\n\n" +
        "Packs the package, verifies the tarball offline and runs the packaged CLI.\n" +
        "  --keep   keep the temporary pack/extract/install workspace for inspection"
    );
    return;
  }
  const unknown = process.argv.slice(2).filter((argument) => argument !== "--keep");
  if (unknown.length > 0) {
    console.error(`publish-dry-run: unknown argument(s): ${unknown.join(", ")}`);
    process.exit(2);
  }

  const workDir = mkdtempSync(join(tmpdir(), WORK_PREFIX));
  let summary: RunSummary | null = null;
  let failure: PublishCheckError | null = null;
  try {
    summary = execute(workDir);
  } catch (error) {
    failure = error instanceof PublishCheckError ? error : new PublishCheckError(error instanceof Error ? error.message : String(error));
  } finally {
    if (!KEEP && existsSync(workDir)) rmSync(workDir, { recursive: true, force: true });
  }

  if (failure !== null) {
    process.stderr.write(`[publish-dry-run] FAIL: ${failure.message}\n`);
    if (failure.hint !== undefined) process.stderr.write(`[publish-dry-run] hint: ${failure.hint}\n`);
    if (KEEP) process.stderr.write(`[publish-dry-run] kept artifacts at ${workDir}\n`);
    process.exit(1);
  }

  if (summary !== null) printSummary(summary, workDir);
  process.exit(0);
}

main();
