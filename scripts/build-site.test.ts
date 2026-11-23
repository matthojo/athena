// The project website's generator: anchors, links, callouts and the README pieces the home page is built from.
// Run: npx tsx --test scripts/build-site.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  DOCS,
  Slugger,
  boldLeadItems,
  docBlurbs,
  indexSections,
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

test("repository links become pages on the site, or files on GitHub", () => {
  assert.equal(resolveHref("GUIDE.md#voice", "README.md"), "guide.html#voice");
  assert.equal(resolveHref("SECURITY.md", "GUIDE.md"), "security.html");
  assert.equal(resolveHref("../README.md", "extension/README.md"), "index.html");
  assert.equal(resolveHref("README.md", "extension/README.md"), "extension.html");
  assert.equal(resolveHref("lib/writing-style.ts", "CONTRIBUTING.md"), "https://github.com/matthojo/athena/blob/main/lib/writing-style.ts");
  assert.equal(resolveHref("netlify/database/migrations/", "CONTRIBUTING.md"), "https://github.com/matthojo/athena/tree/main/netlify/database/migrations");
  assert.equal(resolveHref("https://example.com/a", "GUIDE.md"), "https://example.com/a");
  assert.equal(resolveHref("#voice", "GUIDE.md"), "#voice");
  assert.equal(resolveHref("security.html#x", "COMMUNITY.md"), "security.html#x");
});

test("headings get anchors, code blocks a copy button, and GitHub alerts become callouts", () => {
  const r = renderMarkdown(
    "# Title\n\n## First part\n\n> [!IMPORTANT]\n> Keep a copy.\n\n```sh\nnpm test # runs it\n```\n\n| a | b |\n|---|---|\n| 1 | 2 |\n",
    "GUIDE.md"
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

test("README still has every piece the home page and Getting started are built from", () => {
  const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");
  const s = sections(readme);
  for (const name of DOCS.find((d) => d.sections)!.sections!) assert.ok(s.has(name), `README has "## ${name}"`);
  for (const name of ["What it does", "Your data stays on your site", "Documentation", "License"]) assert.ok(s.has(name), `README has "## ${name}"`);

  const features = boldLeadItems(s.get("What it does")!);
  assert.ok(features.length >= 6, "features listed as **Title:** text");
  assert.ok(features.every((f) => f.title && f.body));

  assert.ok(boldLeadItems(s.get("Your data stays on your site")!).length >= 3);

  const blurbs = docBlurbs(s.get("Documentation")!);
  for (const d of DOCS.filter((d) => d.file && d.file !== "README.md" && d.file !== "LICENSE")) {
    assert.ok(blurbs.has(d.file!), `Documentation lists ${d.file}`);
  }
  assert.match(blurbs.get("GUIDE.md")!, /in detail$/, "a blurb spans its wrapped lines");

  const shots = screenshots(readme);
  assert.ok(shots.length >= 2);
  assert.ok(shots.every((x) => x.alt.length > 0));
});

test("the search index has one entry per section", () => {
  const html = renderMarkdown("Intro words.\n\n## Voice\n\nDictation.\n\n### Talk\n\nOut loud.\n", "GUIDE.md").html;
  const entries = indexSections("guide", "Guide", html);
  assert.deepEqual(
    entries.map((e) => [e.h, e.a, e.x]),
    [
      ["Guide", "", "Intro words."],
      ["Voice", "voice", "Dictation."],
      ["Talk", "talk", "Out loud."],
    ]
  );
});
