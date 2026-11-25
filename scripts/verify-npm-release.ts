#!/usr/bin/env bun
/**
 * Verify a published npm release against the registry (read-only).
 *
 * Used after `npm publish` in release.yml and runnable locally:
 *   bun run verify:npm                          # report current version (0 if not published)
 *   bun run verify:npm --require-published      # fail when the version is missing
 *   bun run verify:npm --require-provenance     # also require a provenance attestation
 *   bun run verify:npm --json                   # machine-readable result
 *
 * Checks: exact name/version, dist.tarball URL, dist.integrity, optional
 * provenance attestation, and a HEAD request for the tarball. No writes.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

interface RegistryDist {
  tarball?: string;
  integrity?: string;
  shasum?: string;
  attestations?: { url?: string; provenance?: { predicateType?: string } };
}

interface RegistryVersion {
  name?: string;
  version?: string;
  dist?: RegistryDist;
}

const REGISTRY = (process.env.NPM_REGISTRY_URL ?? "https://registry.npmjs.org").replace(/\/$/, "");
const project = JSON.parse(readFileSync(join(import.meta.dir, "..", "package.json"), "utf8")) as {
  name?: string;
  version?: string;
};

const args = process.argv.slice(2);
const flagged = (name: string): boolean => args.includes(`--${name}`);
const option = (name: string): string | undefined => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 ? args[index + 1] : undefined;
};

const packageName = option("package") ?? project.name ?? "";
const version = option("version") ?? project.version ?? "";
const requirePublished = flagged("require-published");
const requireProvenance = flagged("require-provenance");
const asJson = flagged("json");

if (packageName === "" || version === "") {
  console.error("verify-npm-release: package name/version missing (pass --package and --version).");
  process.exit(2);
}

interface Report {
  package: string;
  version: string;
  status: "published" | "not-published" | "mismatch" | "error";
  tarball: string | null;
  integrity: string | null;
  provenance: boolean;
  problems: string[];
}

const report: Report = {
  package: packageName,
  version,
  status: "error",
  tarball: null,
  integrity: null,
  provenance: false,
  problems: [],
};

function finish(): never {
  if (asJson) console.log(JSON.stringify(report, null, 2));
  else {
    console.log(`npm release check: ${report.package}@${report.version}`);
    console.log(`  status:    ${report.status}`);
    if (report.tarball !== null) console.log(`  tarball:   ${report.tarball}`);
    if (report.integrity !== null) console.log(`  integrity: ${report.integrity}`);
    console.log(`  provenance: ${report.provenance ? "present" : "absent"}`);
    for (const problem of report.problems) console.log(`  ✗ ${problem}`);
    if (report.status === "published" && report.problems.length === 0) console.log("  ✓ registry release verified");
  }
  const ok = report.problems.length === 0
    && (report.status === "published" || (report.status === "not-published" && !requirePublished));
  process.exit(ok ? 0 : 1);
}

try {
  const response = await fetch(`${REGISTRY}/${encodeURIComponent(packageName)}/${version}`, {
    headers: { accept: "application/json" },
  });
  if (response.status === 404) {
    report.status = "not-published";
    if (requirePublished) {
      report.problems.push(`version ${version} is not on the registry (bootstrap the package first: NPM_TOKEN + NPM_PUBLISH_ENABLED=true).`);
      finish();
    }
    finish();
  }
  if (!response.ok) {
    report.status = "error";
    report.problems.push(`registry responded HTTP ${response.status}.`);
    finish();
  }
  const data = (await response.json()) as RegistryVersion;
  if (data.name !== packageName) report.problems.push(`registry name ${String(data.name)} ≠ ${packageName}.`);
  if (data.version !== version) report.problems.push(`registry version ${String(data.version)} ≠ ${version}.`);
  report.tarball = data.dist?.tarball ?? null;
  report.integrity = data.dist?.integrity ?? null;
  report.provenance = data.dist?.attestations?.url !== undefined;
  if (report.tarball === null) report.problems.push("dist.tarball is missing.");
  if (report.integrity === null) report.problems.push("dist.integrity is missing.");
  if (requireProvenance && !report.provenance) report.problems.push("provenance attestation is missing (publish through OIDC trusted publishing).");
  if (report.tarball !== null) {
    const head = await fetch(report.tarball, { method: "HEAD" });
    if (!head.ok) report.problems.push(`tarball HEAD responded HTTP ${head.status}.`);
    else if (Number(head.headers.get("content-length") ?? "0") <= 0) report.problems.push("tarball is empty.");
  }
  report.status = report.problems.length === 0 ? "published" : "mismatch";
} catch (error) {
  report.status = "error";
  report.problems.push(`registry check failed: ${(error as Error).message}`);
}
finish();
