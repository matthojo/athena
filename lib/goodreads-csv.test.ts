// Run: npx tsx --test lib/goodreads-csv.test.ts
// The Goodreads library parser, the Read-section merge and keepImported, on a small synthetic export (lib/fixtures/goodreads-library.csv).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { batchBookDays, bookKey, BOOKS_TITLE, booksSummary, groupBooksByDay, keepBooks, LibraryError, mergeBooks, parseCsv, parseLibrary, readDate, readImportedBooks } from "./goodreads-csv";
import { keepImported, mergeDay } from "./youtube-takeout";

const csv = readFileSync(new URL("./fixtures/goodreads-library.csv", import.meta.url), "utf8");

test("CSV: quotes, doubled quotes, line breaks in a field, CRLF, BOM", () => {
  const rows = parseCsv(`﻿a,b,c\r\n"x, y","say ""hi""","two\nlines"\r\n\r\n1,,3`);
  assert.deepEqual(rows, [
    ["a", "b", "c"],
    ["x, y", 'say "hi"', "two\nlines"],
    ["1", "", "3"],
  ]);
});

test("dates: Goodreads' slashes, dashes, single digits; nonsense refused", () => {
  assert.equal(readDate("2026/07/03"), "2026-07-03");
  assert.equal(readDate("2026/7/4"), "2026-07-04");
  assert.equal(readDate("2026-07-03"), "2026-07-03");
  assert.equal(readDate("2026/02/30"), null);
  assert.equal(readDate("2026/07"), null);
  assert.equal(readDate(""), null);
});

test("library: finished books on Date Read (else Date Added), to-read on Date Added, currently reading left out", () => {
  const r = parseLibrary(csv);
  assert.deepEqual(r.skipped, { reading: 1, undated: 0 });
  assert.deepEqual(
    r.books.map((b) => [b.day, b.title, b.rating, !!b.want, !!b.added]),
    [
      ["2015-03-02", "Harry Potter and the Deathly Hallows", 3, false, true],
      ["2023-01-15", "The Way of Kings (The Stormlight Archive #1)", 0, false, false],
      ["2026-07-03", "Atomic Habits", 4, false, false],
      ["2026-07-03", "Dune (Dune #1)", 5, false, false],
      ["2026-07-04", "The Hitchhiker's Guide to the Galaxy [Illustrated] *Special*", 4, false, false],
      ["2026-10-01", "1984", 0, true, false],
    ]
  );
  const dune = r.books.find((b) => b.id === "44767458")!;
  assert.equal(dune.author, "Frank Herbert");
  const days = groupBooksByDay(r.books);
  assert.deepEqual(days.map((d) => [d.day, d.books.length]), [["2015-03-02", 1], ["2023-01-15", 1], ["2026-07-03", 2], ["2026-07-04", 1], ["2026-10-01", 1]]);
  assert.equal(days[4].books[0].want, true);
  assert.deepEqual(batchBookDays(days, 2).map((b) => b.length), [2, 2, 1]);
});

test("to-read: under Liked and saved, beside the run's lines, kept by a rewrite, not counted as finished", () => {
  const want = { id: "61439040", title: "1984", author: "George Orwell", rating: 0, want: true };
  const r = mergeBooks("## Read\n- [Dune](https://www.goodreads.com/book/show/1)\n\n## Liked and saved\n- Liked: [A video](https://youtu.be/x)\n- Want to read: [1984](https://www.goodreads.com/review/show/5)\n\n## Posted\n- A photo", [want]);
  assert.equal(r.added, 1);
  assert.equal(r.finished, 1, "the Read line is the only finished book");
  assert.equal(
    r.body,
    "## Read\n- [Dune](https://www.goodreads.com/book/show/1)\n\n## Liked and saved\n- [1984](https://www.goodreads.com/book/show/61439040) · George Orwell\n- Liked: [A video](https://youtu.be/x)\n\n## Posted\n- A photo"
  );
  assert.equal(mergeBooks(r.body, [want]).changed, false);
  assert.equal(keepBooks(r.body, "## Posted\n- A photo"), "## Read\n- [Dune](https://www.goodreads.com/book/show/1)\n\n## Liked and saved\n- [1984](https://www.goodreads.com/book/show/61439040) · George Orwell\n\n## Posted\n- A photo");
  assert.equal(booksSummary([want]), "1984 to read");
  assert.ok(BOOKS_TITLE.test("Thursday 1 October · 1984 to read"));
});

test("not a library export, or an empty one, is refused in words the sheet can map", () => {
  assert.throws(() => parseLibrary("name,email\nMatt,m@x"), (e) => e instanceof LibraryError && e.reason === "unreadable");
  assert.throws(() => parseLibrary(csv.split("\r\n")[0]), (e) => e instanceof LibraryError && e.reason === "empty");
  assert.throws(() => parseLibrary("[{\"title\":\"Watched x\"}]"), (e) => e instanceof LibraryError && e.reason === "unreadable");
});

test("merge: into a run's note beside its own Read lines, idempotent, ratings refreshed", () => {
  const day = groupBooksByDay(parseLibrary(csv).books).find((d) => d.day === "2026-07-03")!;
  const run = "## Watched\n- Severance S2E3 · Who Is Alive?\n\n## Read\n- Started: [Piranesi](https://www.goodreads.com/review/show/9) · Susanna Clarke\n- [Dune (Dune #1)](https://www.goodreads.com/review/show/1) · Frank Herbert\n\n## Played\n- Balatro · 2 hours";
  const first = mergeBooks(run, day.books);
  assert.equal(first.added, 2);
  assert.equal(first.finished, 2);
  assert.equal(
    first.body,
    "## Watched\n- Severance S2E3 · Who Is Alive?\n\n## Read\n- [Atomic Habits](https://www.goodreads.com/book/show/40121378) · James Clear · ★★★★\n- [Dune (Dune #1)](https://www.goodreads.com/book/show/44767458) · Frank Herbert · ★★★★★\n- Started: [Piranesi](https://www.goodreads.com/review/show/9) · Susanna Clarke\n\n## Played\n- Balatro · 2 hours"
  );
  // Same file again: nothing.
  const again = mergeBooks(first.body, day.books);
  assert.equal(again.changed, false);
  assert.equal(again.added, 0);
  assert.equal(again.body, first.body);
  // A newer export with a changed rating: updated, not added.
  const rerated = mergeBooks(first.body, [{ ...day.books[0], rating: 2 }]);
  assert.equal(rerated.added, 0);
  assert.equal(rerated.changed, true);
  assert.match(rerated.body, /Atomic Habits\]\(https:\/\/www\.goodreads\.com\/book\/show\/40121378\) · James Clear · ★★$/m);
  // Markdown in titles round-trips.
  const odd = groupBooksByDay(parseLibrary(csv).books).find((d) => d.day === "2026-07-04")!;
  const made = mergeBooks("", odd.books);
  assert.equal(made.body, "## Read\n- [The Hitchhiker's Guide to the Galaxy \\[Illustrated\\] \\*Special\\*](https://www.goodreads.com/book/show/11) · Douglas Adams · ★★★★");
  assert.deepEqual(readImportedBooks(made.body), odd.books);
});

test("merge: a note without Read gets it in the Life log's order, before YouTube's sections", () => {
  const body = "## Watched\n- A film\n\n## Played\n- A game\n\n## Watched on YouTube\n- [V](https://www.youtube.com/watch?v=aaaaaaaaaa1)";
  const r = mergeBooks(body, [{ id: "1", title: "B", author: "", rating: 0 }]);
  assert.equal(r.body, "## Watched\n- A film\n\n## Read\n- [B](https://www.goodreads.com/book/show/1)\n\n## Played\n- A game\n\n## Watched on YouTube\n- [V](https://www.youtube.com/watch?v=aaaaaaaaaa1)");
});

test("keepImported: a Life log rewrite keeps the import's books and YouTube's sections", () => {
  let note = mergeBooks("## Watched\n- A film", [{ id: "44767458", title: "Dune", author: "Frank Herbert", rating: 5 }]).body;
  note = mergeDay(note, [{ id: "aaaaaaaaaa1", title: "Trailer", channel: "Studio", count: 2, music: false }]).body;
  // The run writes the day again, with its own Read line for the same book and one for another.
  const run = "## Watched\n- A film\n- Another film\n\n## Read\n- [Dune](https://www.goodreads.com/review/show/1) · Frank Herbert\n- [Piranesi](https://www.goodreads.com/review/show/2) · Susanna Clarke";
  const saved = keepImported(note, run);
  assert.equal(
    saved,
    "## Watched\n- A film\n- Another film\n\n## Read\n- [Dune](https://www.goodreads.com/book/show/44767458) · Frank Herbert · ★★★★★\n- [Piranesi](https://www.goodreads.com/review/show/2) · Susanna Clarke\n\n## Watched on YouTube\n- [Trailer](https://www.youtube.com/watch?v=aaaaaaaaaa1) · Studio · 2 times"
  );
  // A run with no Read section at all: the import's books come back under Read.
  assert.equal(keepBooks(note, "## Watched\n- A film"), "## Watched\n- A film\n\n## Read\n- [Dune](https://www.goodreads.com/book/show/44767458) · Frank Herbert · ★★★★★");
  // Saving again keeps it stable.
  assert.equal(keepImported(saved, run), saved);
  // A note no import touched is saved as the run wrote it.
  assert.equal(keepImported("## Read\n- [X](https://www.goodreads.com/review/show/3)", run), run);
});

test("titles: what the import writes, and how it knows its own", () => {
  assert.equal(booksSummary([{ id: "1", title: "Dune", author: "", rating: 0 }]), "Finished Dune");
  assert.equal(booksSummary([{ id: "1", title: "A", author: "", rating: 0 }, { id: "2", title: "B", author: "", rating: 0 }]), "Finished 2 books");
  assert.ok(BOOKS_TITLE.test("Friday 3 July · Finished Dune"));
  assert.ok(!BOOKS_TITLE.test("Friday 3 July · Severance"));
});

test("bookKey: one book across Goodreads' pages and the export", () => {
  assert.equal(bookKey("Tell Me Everything (Amgash, #5)"), "tell me everything");
  assert.equal(bookKey("Dune (Dune #1)"), bookKey("Dune (Dune, #1)"));
  assert.equal(bookKey("The Hitchhiker's Guide"), "the hitchhiker s guide");
  assert.notEqual(bookKey("Dune"), bookKey("Dune Messiah"));
});
