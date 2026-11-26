/**
 * Tests, fixtures and sample data use made-up addresses (example.com, *.example), never one at a real webmail
 * provider: an address there could be someone's. Code that recognises those providers (lib/mail-rules.ts WEBMAIL,
 * lib/suggestion-similar.ts SHARED_DOMAINS) isn't a fixture and isn't read here; released migrations
 * (netlify/database/migrations) are never edited, so they're left out too.
 * Run: npx tsx --test scripts/fixture-addresses.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
/** This file: it names the providers to look for, so it isn't read for them. */
const self = relative(root, fileURLToPath(import.meta.url));

/** An address at a webmail provider anyone can sign up to. */
const REAL_ADDRESS = /[A-Za-z0-9._%+-]+@(?:gmail|googlemail|icloud|me|mac|hey|outlook|hotmail|live|msn|yahoo|aol|proton|protonmail|fastmail|gmx)\.(?:com|me|co\.uk|fm)\b/gi;

/**
 * The only addresses at those providers a fixture may hold, each with why. Keep it short: a test that needs a
 * provider's domain should use an address no one can have.
 */
const ALLOWED: Record<string, { addresses: string[]; why: string }> = {
  "lib/suggestion-similar.test.ts": { addresses: ["x@gmail.com"], why: "checks a shared webmail domain isn't offered as an organisation; Gmail names are at least six characters" },
};

const SKIP_DIRS = new Set(["node_modules", "dist", ".git", ".netlify", ".claude"]);
const TEXT = /\.(?:ts|js|mjs|cjs|json|sql|md|html|ics|vcf|eml|txt|csv)$/;

/** Tests, fixtures and sample data: what this check reads. */
function isFixture(path: string): boolean {
  if (path.startsWith(`netlify${sep}database${sep}migrations${sep}`)) return false;
  const name = path.split(sep).at(-1)!;
  return (
    /\.test\.ts$/.test(name) ||
    /(?:^|[.-])fixtures?(?:[.-]|$)/.test(name) ||
    path.split(sep).some((part) => part === "fixtures" || part === "sample") ||
    /^sample-/.test(name) ||
    path === join("db", "schema.sql")
  );
}

function* files(dir: string): Generator<string> {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) yield* files(join(dir, entry.name));
    } else if (TEXT.test(entry.name)) {
      yield relative(root, join(dir, entry.name));
    }
  }
}

test("fixtures, tests and sample data hold no address at a real webmail provider", () => {
  const found: string[] = [];
  let read = 0;
  for (const path of files(root)) {
    if (!isFixture(path) || path === self) continue;
    read++;
    const allowed = new Set(ALLOWED[path.split(sep).join("/")]?.addresses.map((a) => a.toLowerCase()) ?? []);
    const text = readFileSync(join(root, path), "utf8");
    for (const m of text.matchAll(REAL_ADDRESS)) {
      if (!allowed.has(m[0].toLowerCase())) found.push(`${path}: ${m[0]}`);
    }
  }
  assert.ok(read > 100, `read ${read} files: the walk found the tests and fixtures`);
  assert.deepEqual(found, [], "use example.com or a .example domain instead");
});

test("the check itself catches a real address and passes a made-up one", () => {
  const hits = (s: string) => [...s.matchAll(REAL_ADDRESS)].map((m) => m[0]);
  // Put together here, so this file holds no whole address.
  const real = [["x", "gmail.com"], ["x", "iCloud.com"], ["x", "hotmail.co.uk"]].map(([local, domain]) => `${local}@${domain}`);
  assert.deepEqual(hits(`from: "Sam <${real[0]}>", "${real[1]}", "${real[2]}"`), real);
  assert.deepEqual(hits('"sam@example.com" "jordan@icloud.example" "priya@mail.example" "https://caldav.icloud.com/"'), []);
  assert.equal(isFixture(join("netlify", "database", "migrations", "0005_pa-memory", "migration.sql")), false);
  assert.equal(isFixture(join("lib", "mail-rules.ts")), false, "provider detection isn't a fixture");
  for (const path of [join("lib", "receipts.fixtures.ts"), join("app", "src", "db", "sample-mail.ts"), join("netlify", "lib", "connectors", "fixtures", "icloud-dav.ts"), join("lib", "x.test.ts")]) {
    assert.equal(isFixture(path), true, path);
  }
});
