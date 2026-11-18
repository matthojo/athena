// Link modes in Markdown link titles (rich links, stage 1): athena:// and web links, round trips, escaping,
// old links unchanged, and content-link sync finding every mode.
// Run: npx tsx --test lib/links.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ATHENA_LINK_START,
  athenaLinkRegex,
  contentEdgeKeys,
  contentLinkKeys,
  defaultMode,
  edgeKindOf,
  LINK_KINDS,
  linkKindOf,
  escapeLinkUrl,
  formatAthenaLink,
  formatWebLink,
  LINK_MODES,
  linkMode,
  modesFor,
  parseAthenaLinks,
  parseLinkMode,
  parseWebLinks,
  replaceAthenaLinks,
  WEB_LINK_START,
} from "./links";

const PRIYA = "1c2d3e4f-5a6b-4c7d-8e9f-0a1b2c3d4e5f";
const DISHOOM = "0b9a7c1e-4d2f-4a51-9c3e-7f1d2a6b8e01";

test("old links read and write exactly as before", () => {
  const md = formatAthenaLink("person", PRIYA, "@Priya Shah");
  assert.equal(md, `[@Priya Shah](athena://person/${PRIYA})`);
  assert.deepEqual(parseAthenaLinks(`Lunch with ${md}.`), [{ kind: "person", id: PRIYA, label: "@Priya Shah" }]);
  assert.equal(formatAthenaLink("person", PRIYA, "@Priya Shah", null), md, "no mode, no title");
  assert.equal(formatAthenaLink("person", PRIYA, "@Priya Shah", "mention"), md, "the default isn't written");
  assert.equal(formatWebLink("https://a.example/x", "A page"), "[A page](https://a.example/x)");
  assert.equal(formatWebLink("https://a.example/x", "A page", "link"), "[A page](https://a.example/x)");
  assert.equal(linkMode(parseAthenaLinks(md)[0]), "mention");
  assert.equal(linkMode(parseWebLinks("[A page](https://a.example/x)")[0]), "link");
});

test("every mode round-trips on athena:// links; embed reads and writes as card", () => {
  for (const mode of LINK_MODES) {
    const md = formatAthenaLink("place", DISHOOM, "@Dishoom [King's Cross]", mode);
    const want = mode === "mention" ? "" : ` "${mode === "embed" ? "card" : mode}"`;
    assert.equal(md, `[@Dishoom \\[King's Cross\\]](athena://place/${DISHOOM}${want})`);
    const [link] = parseAthenaLinks(`x ${md} y`);
    assert.equal(link.label, "@Dishoom [King's Cross]");
    assert.equal(link.id, DISHOOM);
    assert.equal(linkMode(link), mode === "embed" ? "card" : mode);
    assert.equal(formatAthenaLink(link.kind, link.id, link.label, link.mode), md, "parse then format is stable");
  }
  assert.deepEqual(parseAthenaLinks(`[Priya](athena://person/${PRIYA} "embed")`), [{ kind: "person", id: PRIYA, label: "Priya", mode: "card" }]);
});

test("every mode round-trips on web links", () => {
  for (const mode of LINK_MODES) {
    const md = formatWebLink("https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=10", "A [good] song", mode);
    const [link] = parseWebLinks(`See ${md}, then`);
    assert.equal(link.url, "https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=10");
    assert.equal(link.label, "A [good] song");
    assert.equal(linkMode(link), mode);
    assert.equal(formatWebLink(link.url, link.label, link.mode), md);
  }
});

test("titles: double or single quotes, any case, and titles that aren't modes", () => {
  assert.equal(parseLinkMode(" Card "), "card");
  assert.equal(parseLinkMode("A tooltip"), undefined);
  assert.equal(parseLinkMode(null), undefined);
  assert.deepEqual(parseAthenaLinks(`[P](athena://person/${PRIYA} 'card')`)[0].mode, "card");
  assert.deepEqual(parseAthenaLinks(`[P](athena://person/${PRIYA}  "CARD" )`)[0].mode, "card");
  // A title that isn't a mode is still a link (so the graph finds it); it reads as the default.
  assert.deepEqual(parseAthenaLinks(`[P](athena://person/${PRIYA} "my friend")`), [{ kind: "person", id: PRIYA, label: "P" }]);
  assert.deepEqual(parseWebLinks(`[W](https://a.example "Example \\"site\\"")`), [{ url: "https://a.example", label: "W" }]);
  // Not links: an unclosed title, a title on the next line.
  assert.deepEqual(parseAthenaLinks(`[P](athena://person/${PRIYA} "card)`), []);
  assert.deepEqual(parseAthenaLinks(`[P](athena://person/${PRIYA}\n"card")`), []);
});

test("web links: brackets in addresses, escaping, images and other schemes", () => {
  const wiki = "https://en.wikipedia.org/wiki/Mercury_(planet)";
  assert.equal(formatWebLink(wiki, "Mercury", "card"), `[Mercury](${wiki} "card")`);
  assert.deepEqual(parseWebLinks(`[Mercury](${wiki} "card")`), [{ url: wiki, label: "Mercury", mode: "card" }]);
  assert.equal(escapeLinkUrl("https://a.example/a b\"c<d>"), "https://a.example/a%20b%22c%3Cd%3E");
  assert.equal(escapeLinkUrl("https://a.example/x)y(z"), "https://a.example/x%29y%28z");
  assert.equal(escapeLinkUrl("https://a.example/((x))"), "https://a.example/%28(x)%29");
  const odd = formatWebLink("https://a.example/x)y", "Odd");
  assert.deepEqual(parseWebLinks(odd), [{ url: "https://a.example/x%29y", label: "Odd" }]);
  assert.deepEqual(parseWebLinks("![a picture](https://a.example/p.png)"), [], "an image isn't a link");
  assert.deepEqual(parseWebLinks(`[P](athena://person/${PRIYA})`), [], "athena:// isn't a web link");
  assert.deepEqual(parseWebLinks("[x](javascript:alert(1))"), []);
  assert.throws(() => formatWebLink("javascript:alert(1)", "x"));
  assert.throws(() => formatWebLink("ftp://a.example", "x"));
  assert.ok(WEB_LINK_START.test(`[x](https://a.example "embed") after`));
  assert.ok(!WEB_LINK_START.test(`before [x](https://a.example)`));
});

test("labels escape brackets and backslashes, and fold newlines", () => {
  const md = formatAthenaLink("note", PRIYA, "a \\ b [c]\nd", "card");
  assert.equal(md, `[a \\\\ b \\[c\\] d](athena://note/${PRIYA} "card")`);
  assert.equal(parseAthenaLinks(md)[0].label, "a \\ b [c] d");
});

test("content-link sync finds a link whatever its mode", () => {
  const body = [
    formatAthenaLink("person", PRIYA, "@Priya"),
    ...LINK_MODES.map((m) => formatAthenaLink("place", DISHOOM, "@Dishoom", m)),
    `[@Priya](athena://person/${PRIYA} "a title")`,
    formatWebLink("https://a.example", "Web", "card"),
  ].join(" and ");
  assert.deepEqual(contentLinkKeys(body), [`person:${PRIYA}`, `place:${DISHOOM}`]);
  for (const mode of LINK_MODES) {
    const one = formatAthenaLink("organisation", DISHOOM, "@Org", mode);
    assert.deepEqual(contentLinkKeys(`text ${one} text`), [`organisation:${DISHOOM}`], `edge found for ${mode}`);
    assert.deepEqual(contentLinkKeys(one, { kind: "organisation", id: DISHOOM }), [], "a note never links to itself");
  }
});

test("consumers of the shared regex see titled links too: same groups, label first", () => {
  const md = `Gift for ${formatAthenaLink("person", PRIYA, "@Priya", "card")}.`;
  assert.equal(replaceAthenaLinks(md, (l) => `${l.label}/${l.mode}`), "Gift for @Priya/card.");
  // profile.ts and briefing-writer.ts replace with positional groups (label, kind, id).
  assert.equal(md.replace(athenaLinkRegex(), (_m, label: string, kind: string, id: string) => `${label}|${kind}|${id}`), `Gift for @Priya|person|${PRIYA}.`);
  const m = ATHENA_LINK_START.exec(`[@Priya](athena://person/${PRIYA} "card") rest`);
  assert.ok(m);
  assert.equal(m[0], `[@Priya](athena://person/${PRIYA} "card")`, "the editor's tokenizer consumes the whole link");
});

test("defaults and the modes each target can take", () => {
  assert.equal(defaultMode("athena"), "mention");
  assert.equal(defaultMode("web"), "link");
  assert.deepEqual(modesFor("athena"), ["mention", "link", "card"]);
  assert.deepEqual(modesFor("web"), ["mention", "link", "card", "embed"]);
});

test("mentions of saved items, to-dos and Watch & read titles are edges under their tables' names", () => {
  const DRESS = "5a3e5a7e-0000-4000-8000-000000000001";
  const DENTIST = "c0ffee00-1111-4222-8333-444455556666";
  const BEAR = "be4be4be-aaaa-4bbb-8ccc-dddddddddddd";
  assert.equal(edgeKindOf("saved"), "saved");
  assert.equal(edgeKindOf("todo"), "commitment");
  assert.equal(edgeKindOf("watch"), "reading");
  assert.equal(edgeKindOf("person"), "person");
  for (const kind of LINK_KINDS) assert.equal(linkKindOf(edgeKindOf(kind)), kind, `${kind} round-trips`);

  const body = [
    `Ideas for ${formatAthenaLink("person", PRIYA, "@Priya")}: ${formatAthenaLink("saved", DRESS, "@Green dress", "card")},`,
    `then ${formatAthenaLink("todo", DENTIST, "@Book the dentist")} and ${formatAthenaLink("watch", BEAR, "@The Bear")}.`,
    `Again: [@the bear](athena://watch/${BEAR.toUpperCase()}).`,
  ].join("\n");
  assert.deepEqual(contentEdgeKeys(body), [`person:${PRIYA}`, `saved:${DRESS}`, `commitment:${DENTIST}`, `reading:${BEAR}`], "in order, once each, ids lower-cased");
  assert.deepEqual(contentLinkKeys(body), [`person:${PRIYA}`, `saved:${DRESS}`, `todo:${DENTIST}`, `watch:${BEAR}`], "link keys keep the link kinds");
  // A to-do's own body (if it ever had one) never links to itself, under either name.
  assert.deepEqual(contentEdgeKeys(formatAthenaLink("todo", DENTIST, "@x"), { kind: "commitment", id: DENTIST }), []);
  // Unknown kinds and malformed ids stay text.
  assert.deepEqual(contentEdgeKeys(`[@x](athena://gift/${DRESS}) [@y](athena://todo/not-a-uuid)`), []);
});
