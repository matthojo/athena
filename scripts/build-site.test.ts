// The landing page's generator: anchors, links, callouts and the README pieces the page is built from.
// Run: npx tsx --test scripts/build-site.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  DOCS_URL,
  Slugger,
  boldLeadItems,
  docLinks,
  renderMarkdown,
  resolveHref,
  screenshots,
  sections,
  slugify,
} from "./build-site";

test("anchors match GitHub's, so links written for GitHub still land", () => {
  assert.equal(slugify("Ask: questions and instructions"), "ask-questions-and-instructions");
  assert.equal(slugify("Collection agents as Claude routines (optional)"), "collection-agents-as-claude-routines-optional");
  assert.equal(slugify("1. Finance and health content is sealed apart"), "1-finance-and-health-content-is-sealed-apart");
  assert.equal(slugify("Athena — Architecture"), "athena--architecture");
  const s = new Slugger();
  assert.deepEqual([s.slug("Details"), s.slug("Details"), s.slug("Details")], ["details", "details-1", "details-2"]);
});

test("README links stay on the page, and other repository links go to GitHub", () => {
  assert.equal(resolveHref("#try-it-locally", "README.md"), "#try-it-locally");
  assert.equal(resolveHref("../README.md#license", "extension/README.md"), "index.html#license");
  assert.equal(resolveHref("SECURITY.md", "README.md"), "https://github.com/matthojo/athena/blob/main/SECURITY.md");
  assert.equal(resolveHref("lib/writing-style.ts", "CONTRIBUTING.md"), "https://github.com/matthojo/athena/blob/main/lib/writing-style.ts");
  assert.equal(resolveHref("netlify/database/migrations/", "CONTRIBUTING.md"), "https://github.com/matthojo/athena/tree/main/netlify/database/migrations");
  assert.equal(resolveHref("https://example.com/a", "README.md"), "https://example.com/a");
  assert.equal(resolveHref("index.html#x", "README.md"), "index.html#x");
});

test("headings get anchors, code blocks a copy button, and GitHub alerts become callouts", () => {
  const r = renderMarkdown(
    "# Title\n\n## First part\n\n> [!IMPORTANT]\n> Keep a copy.\n\n```sh\nnpm test # runs it\n```\n\n| a | b |\n|---|---|\n| 1 | 2 |\n",
    "README.md"
  );
  assert.equal(r.title, "Title");
  assert.deepEqual(r.headings, [{ depth: 2, id: "first-part", text: "First part" }]);
  assert.match(r.html, /<h2 id="first-part">/);
  assert.match(r.html, /class="callout callout--important"[\s\S]*Important[\s\S]*Keep a copy\./);
  assert.doesNotMatch(r.html, /\[!IMPORTANT\]/);
  assert.match(r.html, /class="code__copy"/);
  assert.match(r.html, /npm test <span class="c"># runs it<\/span>/);
  assert.match(r.html, /<div class="table-wrap"><table>/);
});

test("code is escaped, not run as HTML", () => {
  const r = renderMarkdown("```sh\nclaude mcp add https://<your-site>/mcp\n```\n", "README.md");
  assert.match(r.html, /&lt;your-site&gt;/);
});

test("the changelog links each version to its release", () => {
  const r = renderMarkdown("## 1.1.0\n\nFlows.\n", "CHANGELOG.md", { changelog: true });
  assert.match(r.html, /releases\/tag\/v1\.1\.0/);
});

test("README still has every piece the landing page is built from", () => {
  const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");
  const s = sections(readme);
  for (const name of ["What it does", "Your data stays on your site", "Deploy your own", "Try it locally", "Documentation", "License"]) {
    assert.ok(s.has(name), `README has "## ${name}"`);
  }
  assert.ok(/^### 1\. /m.test(s.get("Deploy your own")!), "Deploy your own has numbered ### steps");

  const features = boldLeadItems(s.get("What it does")!);
  assert.ok(features.length >= 6, "features listed as **Title:** text");
  assert.ok(features.every((f) => f.title && f.body));

  assert.ok(boldLeadItems(s.get("Your data stays on your site")!).length >= 3);

  const docs = docLinks(s.get("Documentation")!);
  assert.ok(docs.length >= 5, "Documentation lists the docs sections");
  assert.ok(docs.every((d) => d.href.startsWith(DOCS_URL)), "every docs link goes to the Community site's docs");
  assert.ok(docs.every((d) => d.text && !/\n/.test(d.text)), "a blurb spans its wrapped lines");

  const shots = screenshots(readme);
  assert.ok(shots.length >= 2);
  assert.ok(shots.every((x) => x.alt.length > 0));
});

test("the site follows the system's scheme, the switch the copied tokens.css reads", async () => {
  const { SCHEME_SCRIPT } = await import("./build-site");
  for (const dark of [false, true]) {
    const attrs: Record<string, string> = {};
    let onChange: (() => void) | null = null;
    const document = { documentElement: { setAttribute: (k: string, v: string) => (attrs[k] = v) } };
    const query = { matches: dark, addEventListener: (_: string, fn: () => void) => (onChange = fn) };
    const window = { matchMedia: (q: string) => (assert.equal(q, "(prefers-color-scheme: dark)"), query) };
    new Function("document", "window", SCHEME_SCRIPT)(document, window);
    assert.equal(attrs["data-scheme"], dark ? "dark" : "light");
    query.matches = !dark;
    onChange!();
    assert.equal(attrs["data-scheme"], dark ? "light" : "dark");
  }
});
