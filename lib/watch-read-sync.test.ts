// Watch & read from sources: the pure parts (stars, titles, links) and half stars on the Rating field.
// Run: npx tsx --test lib/watch-read-sync.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { checkInput, linkKey, titleKey, toStars } from "./watch-read-sync";
import { formatValue, normaliseValue, FieldError, starWords } from "./custom-field-rules";

test("ratings become stars: Letterboxd halves stay, Trakt is halved, none is undefined (never 0)", () => {
  assert.equal(toStars("letterboxd", "★★★★½ (4.5/5)"), 4.5);
  assert.equal(toStars("letterboxd", "★★★½"), 3.5);
  assert.equal(toStars("letterboxd", "½"), 0.5);
  assert.equal(toStars("letterboxd", 4.5), 4.5);
  assert.equal(toStars("trakt", "8/10"), 4);
  assert.equal(toStars("trakt", "7/10"), 3.5);
  assert.equal(toStars("trakt", 10), 5);
  assert.equal(toStars("trakt", 1), 0.5);
  assert.equal(toStars("goodreads", "4/5"), 4);
  assert.equal(toStars("goodreads", 3), 3);
  for (const none of [undefined, null, "", 0, "0", "0/5", "unrated", 11, "12/10", -1]) assert.equal(toStars("trakt", none as never), undefined, String(none));
  assert.equal(toStars("goodreads", 6), undefined);
});

test("titles match across sources: case, accents, punctuation, a leading The, a book's series", () => {
  assert.equal(titleKey("film", "Dune: Part Two"), titleKey("film", "dune part two"));
  assert.equal(titleKey("film", "Amélie"), titleKey("film", "Amelie"));
  assert.equal(titleKey("film", "The Holdovers"), titleKey("film", "Holdovers"));
  assert.equal(titleKey("tv", "Law & Order"), titleKey("tv", "Law and Order"));
  assert.equal(titleKey("book", "Dune (Dune, #1)"), titleKey("book", "Dune (Dune #1)"));
  assert.equal(titleKey("book", "Dune (Dune, #1)"), titleKey("book", "Dune"));
  assert.notEqual(titleKey("film", "Dune"), titleKey("film", "Dune: Part Two"));
});

test("a source's link names the title, not the diary entry or episode", () => {
  assert.equal(linkKey("https://letterboxd.com/jordan/film/dune-part-two/"), "letterboxd:film:dune-part-two");
  assert.equal(linkKey("https://letterboxd.com/jordan/film/dune-part-two/1/"), "letterboxd:film:dune-part-two");
  assert.equal(linkKey("https://letterboxd.com/film/dune-part-two/"), "letterboxd:film:dune-part-two");
  assert.equal(linkKey("https://trakt.tv/movies/dune-part-two-2024"), "trakt:movies:dune-part-two-2024");
  assert.equal(linkKey("https://trakt.tv/shows/severance/seasons/2/episodes/3"), "trakt:shows:severance");
  assert.equal(linkKey("https://www.goodreads.com/book/show/44767458-dune"), "goodreads:book:44767458");
  assert.equal(linkKey("https://www.goodreads.com/review/show/123"), "goodreads:review:123");
  assert.equal(linkKey("https://example.com/film/x"), undefined);
  assert.equal(linkKey("not a link"), undefined);
});

test("input is checked: kind, source, status and a title", () => {
  const ok = { kind: "film", title: "  Dune  ", status: "done", source: "trakt", year: 2021 } as const;
  assert.equal(checkInput(ok).title, "Dune");
  assert.equal(checkInput({ ...ok, year: 3 }).year, undefined);
  assert.throws(() => checkInput({ ...ok, kind: "game" as never }));
  assert.throws(() => checkInput({ ...ok, source: "imdb" as never }));
  assert.throws(() => checkInput({ ...ok, status: "watched" as never }));
  assert.throws(() => checkInput({ ...ok, title: " ... " }));
});

test("the Rating field holds half stars, and reads them as words", () => {
  const f = { type: "rating" as const, label: "Rating", options: [] as string[], unit: "" };
  assert.equal(normaliseValue(f, 4.5).value, 4.5);
  assert.equal(normaliseValue(f, "★★★★½").value, 4.5);
  assert.equal(normaliseValue(f, "3.5 stars").value, 3.5);
  assert.equal(normaliseValue(f, 0.5).value, 0.5);
  assert.equal(normaliseValue(f, 4).value, 4);
  assert.equal(normaliseValue(f, 0).value, null);
  for (const bad of [4.3, 6, -1, 0.25, "lots"]) assert.throws(() => normaliseValue(f, bad), FieldError, String(bad));
  assert.equal(formatValue(f, 4.5), "4½ stars");
  assert.equal(formatValue(f, 1), "1 star");
  assert.equal(starWords(0.5), "Half a star");
  assert.equal(starWords(5), "5 stars");
});
