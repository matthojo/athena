// Fails when a dependency Athena ships has a licence that would tie the
// project's hands: anything copyleft beyond the file or library level (GPL,
// AGPL, SSPL and the like), or a licence it doesn't recognise. Athena's
// maintainer can relicense Athena itself (CONTRIBUTING.md), but not
// someone else's package, so what it depends on has to stay permissive.
// Reads package-lock.json, so it needs no install. Dev dependencies aren't
// shipped, so they aren't checked.
// Run: npm run check:licences (npm test runs it too, through check-licences.test.ts)
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// Licences fine to depend on, whatever Athena is licensed under later.
// LGPL and MPL are copyleft only for the library's own files, which Athena
// uses unchanged (sharp's libvips binaries, web-push).
export const ALLOWED = new Set([
  "0BSD",
  "Apache-2.0",
  "BlueOak-1.0.0",
  "BSD-2-Clause",
  "BSD-3-Clause",
  "CC0-1.0",
  "CC-BY-4.0",
  "ISC",
  "LGPL-3.0-or-later",
  "MIT",
  "MPL-2.0",
  "Python-2.0",
  "Unlicense",
]);

// Packages whose lockfile entry has no licence field, with the licence their
// own files state. Check the package before adding one.
export const KNOWN: Record<string, string> = {
  callsite: "MIT", // Readme.md, "License: MIT"
};

/** True when an SPDX expression only needs licences in ALLOWED: every part of an AND, at least one side of an OR. */
export function allowed(expression: string): boolean {
  const text = expression.trim().replace(/^\((.*)\)$/, "$1");
  if (/\bOR\b/.test(text) && !/\bAND\b/.test(text)) {
    return text.split(/\s+OR\s+/).some((part) => allowed(part));
  }
  if (/\bAND\b/.test(text) && !/\bOR\b/.test(text)) {
    return text.split(/\s+AND\s+/).every((part) => allowed(part));
  }
  if (/\b(AND|OR)\b/.test(text)) return false; // mixed; read it by hand and add the package to KNOWN
  return ALLOWED.has(text);
}

type Lockfile = { packages: Record<string, { license?: string; dev?: boolean }> };

/** Each shipped package whose licence isn't allowed, with that licence. */
export function problems(lock: Lockfile): { name: string; license: string }[] {
  const found: { name: string; license: string }[] = [];
  for (const [path, entry] of Object.entries(lock.packages)) {
    if (path === "" || entry.dev) continue;
    const name = path.replace(/^.*node_modules\//, "");
    const license = entry.license ?? KNOWN[name] ?? "(none)";
    if (!allowed(license)) found.push({ name, license });
  }
  return found;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const lock = JSON.parse(readFileSync(new URL("../package-lock.json", import.meta.url), "utf8")) as Lockfile;
  const found = problems(lock);
  if (found.length === 0) {
    console.log("Every shipped dependency has an allowed licence.");
  } else {
    console.error("These dependencies have a licence Athena doesn't accept (scripts/check-licences.ts says why):");
    for (const { name, license } of found) console.error(`  ${name}: ${license}`);
    process.exit(1);
  }
}
