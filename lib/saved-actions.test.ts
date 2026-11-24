// Saved actions: what a page is (fixture pages and addresses), which actions fit which item and in what
// order, how an item reads on a list and as a to-do, and the card's line. No database (the runs are in
// netlify/lib/saved/saved-actions.db.test.ts).
// Run: npx tsx --test lib/saved-actions.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { cleanIsbn, detectFromHtml, detectFromUrl, isoMinutes, thingLine } from "./saved-kinds";
import { extractPage } from "./saved-extract";
import { actionsFor, listLine, registerSavedAction, savedActionIds, thingOf, todoTitle } from "./saved-actions";
import type { SavedItem } from "./saved-rules";

const page = (name: string) => readFileSync(new URL(`./fixtures/saved/kinds/${name}`, import.meta.url), "utf8");

test("detection: books, films and shows from schema.org, Open Graph and the address", () => {
  const book = detectFromHtml(page("goodreads-book.html"), "https://www.goodreads.com/book/show/59808223-lapvona");
  assert.deepEqual(book, { type: "book", facts: { name: "Lapvona", by: "Ottessa Moshfegh", isbn: "9780593300268" } });
  // IMDb's /title/ says film; its own schema says it's a series.
  const show = detectFromHtml(page("imdb-show.html"), "https://www.imdb.com/title/tt14452776/");
  assert.equal(show?.type, "show");
  assert.equal(show?.facts.name, "The Bear");
  assert.equal(show?.facts.by, "Christopher Storer");
  assert.equal(show?.facts.year, "2022");
  assert.equal(show?.facts.imdb, "tt14452776");
  // A CDATA comment around the JSON (Letterboxd) still parses.
  const film = detectFromHtml(page("letterboxd-film.html"), "https://letterboxd.com/film/past-lives/");
  assert.deepEqual(film, { type: "film", facts: { name: "Past Lives", by: "Celine Song", year: "2023" } });
});

test("detection: products, recipes, places and events", () => {
  assert.deepEqual(detectFromHtml(page("shop-product.html"), "https://www.cos.com/en-gb/women/dresses/product.green-wrap-dress.123.html"), {
    type: "product",
    facts: { name: "Green wrap dress", price: "45", currency: "GBP", shop: "COS" },
  });
  assert.deepEqual(detectFromHtml(page("recipe.html"), "https://kitchen.example/miso-chicken"), { type: "recipe", facts: { name: "Miso butter roast chicken", by: "Ruby Tandoh", minutes: 75 } });
  assert.deepEqual(detectFromHtml(page("restaurant.html"), "https://dishoom.example/shoreditch"), { type: "place", facts: { name: "Dishoom Shoreditch", address: "7 Boundary St, London, E2 7JE" } });
  const event = detectFromHtml(page("event.html"), "https://barbican.example/event/floating-points");
  assert.equal(event?.type, "event");
  assert.equal(event?.facts.starts, "2026-11-14T19:30:00+00:00");
  assert.equal(event?.facts.address, "Barbican Hall, Silk St, London");
});

test("detection: a plain page is nothing in particular, an article page is an article", () => {
  assert.equal(detectFromHtml(page("plain.html"), "https://example.com/hello"), null);
  const article = readFileSync(new URL("./fixtures/saved/article.html", import.meta.url), "utf8");
  const x = extractPage(article, "https://longform.example/science/sleep");
  const d = detectFromHtml(article, "https://longform.example/science/sleep", { title: x.title, author: x.author, hasText: !!x.text });
  assert.equal(d?.type, "article");
  assert.equal(d?.facts.by, x.author);
  const video = readFileSync(new URL("./fixtures/saved/video.html", import.meta.url), "utf8");
  assert.equal(detectFromHtml(video, "https://www.youtube.com/watch?v=abc")?.type, "video");
});

test("detection from the address alone: Maps, book shops, film sites", () => {
  assert.deepEqual(detectFromUrl("https://www.google.com/maps/place/Dishoom+Shoreditch/@51.52,-0.07,17z"), { type: "place", facts: { name: "Dishoom Shoreditch" } });
  assert.equal(detectFromUrl("https://maps.app.goo.gl/AbCdEf123")?.type, "place");
  assert.deepEqual(detectFromUrl("https://maps.apple.com/?q=Barbican&ll=51.52,-0.09"), { type: "place", facts: { name: "Barbican" } });
  // A book's ASIN is its ISBN-10; anything else on Amazon is a product.
  assert.deepEqual(detectFromUrl("https://www.amazon.co.uk/Sample-Book-Title/dp/123456789X/ref=sr_1_1"), { type: "book", facts: { isbn: "123456789X" } });
  assert.deepEqual(detectFromUrl("https://www.amazon.co.uk/dp/B0EXAMPLE1"), { type: "product", facts: { shop: "Amazon" } });
  assert.deepEqual(detectFromUrl("https://uk.bookshop.org/p/books/lapvona-ottessa-moshfegh/7140373?ean=9781787333260"), { type: "book", facts: {} });
  assert.equal(detectFromUrl("https://openlibrary.org/works/OL27448W")?.type, "book");
  assert.equal(detectFromUrl("https://www.themoviedb.org/tv/136315-the-bear")?.type, "show");
  assert.equal(detectFromUrl("https://www.netflix.com/gb/title/80057281")?.type, "show");
  assert.equal(detectFromUrl("https://youtu.be/abc")?.type, "video");
  assert.equal(detectFromUrl("https://example.com/"), null);
  assert.equal(cleanIsbn("978-0-593-30026-8"), "9780593300268");
  assert.equal(cleanIsbn("9780593300269"), undefined);
  assert.equal(isoMinutes("PT45M"), 45);
  assert.equal(isoMinutes("nonsense"), undefined);
});

test("the card's line", () => {
  assert.equal(thingLine("book", { by: "Ottessa Moshfegh" }), "Book · Ottessa Moshfegh");
  assert.equal(thingLine("product", { price: "45", currency: "GBP", shop: "COS" }), "Product · £45 · COS");
  assert.equal(thingLine("show", { year: "2022" }), "TV show · 2022");
  assert.equal(thingLine("recipe", { minutes: 75 }), "Recipe · 75 min");
  assert.equal(thingLine("event", { starts: "2026-11-14T19:30:00Z" }), "Event · Sat 14 Nov");
  assert.equal(thingLine("place", {}), "Place");
  assert.equal(thingLine("article", { by: "Someone" }), null);
  assert.equal(thingLine(null, null), null);
});

const item = (over: Partial<SavedItem>): SavedItem => ({
  id: "00000000-0000-4000-8000-000000000001",
  kind: "link",
  url: "https://example.com/x",
  title: "Something",
  site: "example.com",
  author: null,
  published_at: null,
  excerpt: null,
  quote: null,
  note: null,
  tags: [],
  source: "app",
  source_url: null,
  image_url: null,
  image_w: null,
  image_h: null,
  image_tone: null,
  saved_at: "2026-11-08T08:00:00Z",
  saved_on: "2026-11-08",
  archived: false,
  has_readable: false,
  fetch_status: "ok",
  thing: null,
  facts: null,
  filed: null,
  ...over,
});

const ids = (i: SavedItem) => actionsFor(i).map((a) => a.id);

test("appliesTo and fit: the best action first, and only the ones that make sense", () => {
  const book = item({ thing: "book", title: "Lapvona", facts: { name: "Lapvona", by: "Ottessa Moshfegh" } });
  assert.deepEqual(ids(book), ["watch_read", "gift_idea", "add_to_list", "make_todo", "link"]);
  assert.equal(actionsFor(book)[0].suggested, true);
  assert.equal(actionsFor(book)[0].label, "Move to Watch & read");
  const dress = item({ thing: "product", title: "Green wrap dress", facts: { price: "45", currency: "GBP", shop: "COS" } });
  assert.deepEqual(ids(dress), ["gift_idea", "add_to_list", "make_todo", "link"]);
  assert.deepEqual(actionsFor(dress)[0].params.map((p) => [p.name, p.kind, p.required]), [["person_id", "person", true]]);
  const place = item({ thing: "place", title: "Dishoom Shoreditch" });
  assert.deepEqual(ids(place), ["save_place", "add_to_list", "make_todo", "link"]);
  // Films, shows and videos can go to Watch & read too.
  assert.equal(ids(item({ thing: "film", title: "Past Lives" }))[0], "watch_read");
  assert.equal(ids(item({ url: "https://www.youtube.com/watch?v=abc123" }))[0], "watch_read");
  // A quote is only for a list, a to-do or a link.
  assert.deepEqual(ids(item({ kind: "quote", url: null, quote: "Make it work" })), ["add_to_list", "make_todo", "link"]);
  // Items saved before 0039 have no stored type: the address says what it is.
  assert.equal(thingOf(item({ url: "https://www.goodreads.com/book/show/1-x" })), "book");
  assert.equal(ids(item({ url: "https://www.goodreads.com/book/show/1-x" }))[0], "watch_read");
  // Archived: nothing. Filed: still listed, but nothing is suggested.
  assert.deepEqual(actionsFor(item({ archived: true })), []);
  assert.equal(actionsFor(item({ thing: "book", filed: { at: "x", action: "watch_read", label: "Watch & read", href: null } }))[0].suggested, false);
  // The to-do's title is offered, ready to change.
  assert.equal(actionsFor(book).find((a) => a.id === "make_todo")?.params[0].suggested, "Read: Lapvona");
});

test("how an item reads on a list and as a to-do", () => {
  assert.equal(listLine(item({ thing: "product", title: "Green wrap dress", url: "https://cos.example/d", facts: { price: "45", currency: "GBP", shop: "COS" } })), "[Green wrap dress](https://cos.example/d) · £45 · COS");
  assert.equal(listLine(item({ thing: "book", title: "Lapvona by Ottessa Moshfegh | Goodreads", facts: { name: "Lapvona", by: "Ottessa Moshfegh" } })), "[Lapvona](https://example.com/x) · Ottessa Moshfegh");
  assert.equal(listLine(item({ title: "A page [with] brackets" })), "[A page with brackets](https://example.com/x) · example.com");
  assert.equal(listLine(item({ kind: "note", url: null, site: null, title: null, quote: "Gift idea for Ana: the Ottolenghi cookbook" })), "Gift idea for Ana: the Ottolenghi cookbook");
  assert.equal(todoTitle(item({ thing: "product", title: "Green wrap dress" })), "Buy: Green wrap dress");
  assert.equal(todoTitle(item({ thing: "book", facts: { name: "Lapvona" } })), "Read: Lapvona");
  assert.equal(todoTitle(item({ thing: "place", title: "Dishoom Shoreditch" })), "Visit: Dishoom Shoreditch");
  assert.equal(todoTitle(item({ title: "A plain page" })), "Read: A plain page");
  assert.equal(todoTitle(item({ kind: "note", url: null, title: null, quote: "Call the framer about the print" })), "Call the framer about the print");
});

test("any feature can register an action", async () => {
  registerSavedAction({
    id: "test_print",
    label: "Print it",
    icon: "image",
    appliesTo: (i) => i.kind === "image",
    fit: () => 50,
    run: async () => ({ label: "Printer", href: null, filed: false, undo: null, done: "Printed", target: null }),
  });
  assert.ok(savedActionIds().includes("test_print"));
  assert.equal(ids(item({ kind: "image", thing: "image" }))[0], "test_print");
  assert.ok(!ids(item({ kind: "link" })).includes("test_print"));
  assert.throws(() => registerSavedAction({ id: "undo", label: "x", icon: "x", appliesTo: () => true, run: async () => ({ label: "", href: null, filed: false, undo: null, done: "", target: null }) }));
});
