// Run: npx tsx --test lib/netflix-csv.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  batchNetflixDays,
  countWatched,
  dateOrder,
  groupViewsByDay,
  keepNetflix,
  mergeWatched,
  netflixSummary,
  NetflixError,
  NETFLIX_TITLE,
  parseViewingActivity,
  readDate,
  readWatched,
  seasonShort,
  splitTitle,
} from "./netflix-csv";
import { keepImported } from "./youtube-takeout";

const csv = (rows: Array<[string, string]>) => ["Title,Date", ...rows.map(([t, d]) => `"${t.replace(/"/g, '""')}","${d}"`)].join("\r\n");

test("dates: each locale's format, settled by the file or the locale", () => {
  assert.equal(readDate("14/03/2024", "dmy"), "2024-03-14");
  assert.equal(readDate("3/14/24", "mdy"), "2024-03-14");
  assert.equal(readDate("14.03.24", "mdy"), "2024-03-14", "dots are always day first");
  assert.equal(readDate("14-03-2024", "dmy"), "2024-03-14");
  assert.equal(readDate("2024/03/14", "dmy"), "2024-03-14");
  assert.equal(readDate("2024. 3. 14.", "dmy"), "2024-03-14");
  assert.equal(readDate("2024-03-14", "mdy"), "2024-03-14");
  assert.equal(readDate("31/02/2024", "dmy"), null);
  assert.equal(readDate("yesterday", "dmy"), null);

  // A 13 or more settles it, whatever the locale says.
  assert.deepEqual(dateOrder(["3/4/24", "3/14/24"], "en-GB"), { order: "mdy", guessed: false });
  assert.deepEqual(dateOrder(["3/4/2024", "14/3/2024"], "en-US"), { order: "dmy", guessed: false });
  assert.deepEqual(dateOrder(["4.3.24"], "en-US"), { order: "dmy", guessed: false });
  assert.deepEqual(dateOrder(["2024/03/04"], "en-US"), { order: "ymd", guessed: false });
  // Nothing settles it: the locale does, and says so.
  assert.deepEqual(dateOrder(["3/4/24", "1/2/24"], "en-US"), { order: "mdy", guessed: true });
  assert.deepEqual(dateOrder(["3/4/2024"], "en-GB"), { order: "dmy", guessed: true });
  assert.deepEqual(dateOrder(["3/4/2024"], "fr-FR"), { order: "dmy", guessed: true });
  assert.throws(() => dateOrder(["13/1/24", "1/13/24"]), NetflixError);

  // The same ambiguous file reads per locale, or the way the review asks.
  const file = csv([["Heat", "3/4/24"]]);
  assert.equal(parseViewingActivity(file, { locale: "en-GB" }).views[0].day, "2024-04-03");
  assert.equal(parseViewingActivity(file, { locale: "en-US" }).views[0].day, "2024-03-04");
  const other = parseViewingActivity(file, { locale: "en-GB", order: "mdy" });
  assert.equal(other.views[0].day, "2024-03-04");
  assert.equal(other.guessed, false);
});

test("titles: shows split into show, season and episode; films stay films", () => {
  assert.deepEqual(splitTitle("Slow Horses: Season 4: Identity Theft"), { title: "Slow Horses", season: "S4", episode: "Identity Theft" });
  assert.deepEqual(splitTitle("The Crown: Series 5: Queen Victoria Syndrome"), { title: "The Crown", season: "S5", episode: "Queen Victoria Syndrome" });
  assert.deepEqual(splitTitle("Stranger Things: Stranger Things 4: Chapter One: The Hellfire Club"), { title: "Stranger Things", season: "S4", episode: "Chapter One: The Hellfire Club" });
  assert.deepEqual(splitTitle("Baby Reindeer: Limited Series: Episode 1"), { title: "Baby Reindeer", season: "", episode: "Episode 1" });
  assert.deepEqual(splitTitle("Money Heist: Part 5: Your Life Was Here"), { title: "Money Heist", season: "Part 5", episode: "Your Life Was Here" });
  assert.deepEqual(splitTitle("Love, Death & Robots: Volume 3: Three Robots: Exit Strategies"), { title: "Love, Death & Robots", season: "Volume 3", episode: "Three Robots: Exit Strategies" });
  // A show with a colon in its name.
  assert.deepEqual(splitTitle("Formula 1: Drive to Survive: Season 6: Under Pressure"), { title: "Formula 1: Drive to Survive", season: "S6", episode: "Under Pressure" });
  // Other languages' profiles.
  assert.deepEqual(splitTitle("Dark: Staffel 2: Anfänge und Enden"), { title: "Dark", season: "S2", episode: "Anfänge und Enden" });
  assert.deepEqual(splitTitle("La casa de papel: Temporada 3: Hemos vuelto"), { title: "La casa de papel", season: "S3", episode: "Hemos vuelto" });
  assert.deepEqual(splitTitle("Lupin: Partie 2: Chapitre 6"), { title: "Lupin", season: "Partie 2", episode: "Chapitre 6" });
  assert.equal(seasonShort("シーズン2", "x"), "S2");
  assert.equal(seasonShort("Mini-série", "x"), "");
  assert.equal(seasonShort("Episode 3", "x"), null);
  // Films, colons and all.
  assert.deepEqual(splitTitle("Glass Onion: A Knives Out Mystery"), { title: "Glass Onion: A Knives Out Mystery" });
  assert.deepEqual(splitTitle("Rebel Moon – Part One: A Child of Fire"), { title: "Rebel Moon – Part One: A Child of Fire" });
  assert.deepEqual(splitTitle("Roma"), { title: "Roma" });
  // Odd ones: "·" kept out (it's the note's separator), a show with no season part, a show named elsewhere in the file.
  assert.deepEqual(splitTitle("Love · Death"), { title: "Love - Death" });
  assert.deepEqual(splitTitle("Our Planet: Our Planet: One Planet"), { title: "Our Planet", season: "", episode: "One Planet" });
  assert.deepEqual(splitTitle("Our Planet: Frozen Worlds", new Set(["Our Planet"])), { title: "Our Planet", season: "", episode: "Frozen Worlds" });
});

test("the file: oldest first, grouped by day, odd rows and other files handled", () => {
  const file = csv([
    ["Slow Horses: Season 4: Hello Goodbye", "14/03/2024"],
    ["Slow Horses: Season 4: Identity Theft", "14/03/2024"],
    ["Glass Onion: A Knives Out Mystery", "14/03/2024"],
    ["Slow Horses: Season 4: Identity Theft", "14/03/2024"],
    ["Our Planet: Frozen Worlds", "02/01/2024"],
    ["Our Planet: Season 2: Out of the Deep", "01/01/2024"],
    ["Bad date", "not a date"],
    ["Tomorrow's show", "15/03/2024"],
    ["", "01/01/2024"],
  ]);
  const p = parseViewingActivity(file, { locale: "en-GB", today: "2024-03-14" });
  assert.equal(p.order, "dmy");
  assert.deepEqual(p.skipped, { undated: 1, future: 1 });
  assert.deepEqual(p.views.map((v) => v.day), ["2024-01-01", "2024-01-02", "2024-03-14", "2024-03-14", "2024-03-14", "2024-03-14"]);
  // "Our Planet: Frozen Worlds" is the show, because the file names Our Planet with a season.
  assert.deepEqual(p.views[1], { title: "Our Planet", season: "", episode: "Frozen Worlds", day: "2024-01-02" });
  const days = groupViewsByDay(p.views);
  assert.deepEqual(days[2], {
    day: "2024-03-14",
    watched: [{ title: "Slow Horses", season: "S4", episodes: ["Identity Theft", "Hello Goodbye"] }, { title: "Glass Onion: A Knives Out Mystery" }],
  });
  assert.deepEqual(countWatched(days), { episodes: 4, films: 1 });

  assert.throws(() => parseViewingActivity("Name,When\nx,y"), (e: NetflixError) => e.reason === "unreadable");
  assert.throws(() => parseViewingActivity("Title,Date\n"), (e: NetflixError) => e.reason === "empty");
  assert.throws(() => parseViewingActivity("Profile Name,Start Time,Duration,Title\nMatt,2024-03-14 21:00:00,00:40:00,Heat"), (e: NetflixError) => e.reason === "full-export");
  // A BOM and quoted commas.
  assert.equal(parseViewingActivity('﻿Title,Date\n"Love, Death & Robots: Volume 1: Sonnie\'s Edge","1/2/2024"', { locale: "en-GB" }).views[0].title, "Love, Death & Robots");

  const many = Array.from({ length: 130 }, (_, i) => ({ day: `2024-01-${String((i % 28) + 1).padStart(2, "0")}-${i}`, watched: [{ title: "X" }] }));
  assert.deepEqual(batchNetflixDays(many, 60).map((b) => b.length), [60, 60, 10]);
});

const day = [
  { title: "Slow Horses", season: "S4", episodes: ["Identity Theft", "Hello Goodbye", "Cleaners"] },
  { title: "Glass Onion: A Knives Out Mystery" },
];

test("the day note: one line per show and film, idempotent, a second profile adds only what's new", () => {
  const m = mergeWatched("", day);
  assert.equal(m.added, 4);
  assert.match(m.body, /^## Watched\n- \[Slow Horses S4\]\(https:\/\/www\.netflix\.com\/search\?q=Slow%20Horses#e=[0-9a-z.]+\) · 3 episodes\n- \[Glass Onion: A Knives Out Mystery\]\(https:\/\/www\.netflix\.com\/search\?q=Glass%20Onion%3A%20A%20Knives%20Out%20Mystery\) · Film$/);
  // Same file again: nothing.
  const again = mergeWatched(m.body, day);
  assert.equal(again.changed, false);
  assert.equal(again.added, 0);
  // Another profile: one episode in common, one new.
  const second = mergeWatched(m.body, [{ title: "Slow Horses", season: "S4", episodes: ["Cleaners", "Uncivil Partnership"] }]);
  assert.equal(second.added, 1);
  assert.match(second.body, /Slow Horses S4\]\([^)]+\) · 4 episodes/);
  // One episode is named.
  assert.match(mergeWatched("", [{ title: "Severance", season: "S2", episodes: ["Who Is Alive?"] }]).body, /\[Severance S2\]\([^)]+\) · Who Is Alive\?$/);
  // The app's editor saves a blank line after each heading: still the same lines, nothing to change.
  const edited = m.body.replace("## Watched\n", "## Watched\n\n");
  assert.equal(mergeWatched(edited, day).changed, false);
  assert.equal(readWatched(edited).length, 2);
  // Read back.
  assert.deepEqual(readWatched(second.body).map((w) => [w.title, w.season, w.eps.length]), [["Slow Horses", "S4", 4], ["Glass Onion: A Knives Out Mystery", undefined, 0]]);
  // Odd titles round-trip: brackets, stars, parentheses.
  const odd = mergeWatched("", [{ title: "[REC] (2007)" }, { title: "Love, Death & Robots", season: "Volume 3", episodes: ["Bad *Travelling*"] }]);
  assert.deepEqual(readWatched(odd.body).map((w) => [w.title, w.season, w.name]), [["[REC] (2007)", undefined, undefined], ["Love, Death & Robots", "Volume 3", "Bad *Travelling*"]]);
  assert.equal(mergeWatched(odd.body, [{ title: "[REC] (2007)" }]).changed, false);
});

test("Trakt and Letterboxd: the same title that day is one line, the Netflix line, with their numbers, rating and link", () => {
  const run = [
    "## Watched",
    "- [Slow Horses S4E1 to E3, 3 episodes](https://trakt.tv/shows/slow-horses) · 8/10",
    "- Slow Horses S3E6 · Footprints",
    "- [Dark Matter S1E2](https://trakt.tv/shows/dark-matter)",
    "- [Glass Onion: A Knives Out Mystery (2022)](https://letterboxd.com/me/film/glass-onion/) · ★★★★½",
    "",
    "## Read",
    "- [Dune](https://www.goodreads.com/review/show/1) · Frank Herbert",
  ].join("\n");
  const m = mergeWatched(run, [...day, { title: "Dark", season: "S1", episodes: ["Secrets"] }]);
  const lines = m.body.split("\n");
  assert.equal(lines.filter((l) => /Slow Horses S4/.test(l)).length, 1, m.body);
  assert.match(m.body, /\n- \[Slow Horses S4E1–E3\]\(https:\/\/www\.netflix\.com\/search\?q=Slow%20Horses#e=[0-9a-z.]+\) · 3 episodes · 8\/10 · \[Trakt\]\(https:\/\/trakt\.tv\/shows\/slow-horses\)\n/);
  assert.match(m.body, /\[Glass Onion: A Knives Out Mystery\]\([^)]+\) · Film · ★★★★½ · \[Letterboxd\]\(https:\/\/letterboxd\.com\/me\/film\/glass-onion\/\)/);
  assert.match(m.body, /- Slow Horses S3E6 · Footprints/, "another season stays");
  assert.match(m.body, /Dark Matter S1E2/, "Dark Matter isn't Dark");
  assert.match(m.body, /## Read\n- \[Dune\]/);
  // Read back: the season stays S4, so the same file again still matches its line.
  assert.deepEqual(readWatched(m.body).find((w) => w.title === "Slow Horses"), { title: "Slow Horses", season: "S4", eps: readWatched(m.body)[0].eps, range: "E1–E3", rating: "8/10", link: "[Trakt](https://trakt.tv/shows/slow-horses)" });
  assert.equal(mergeWatched(m.body, day).changed, false);

  // A Life log run rewrites the day: the Netflix lines come back, its Trakt line folds in again.
  assert.equal(keepNetflix(m.body, run), m.body);
  // A run with no Watched section at all still gets them, Trakt's details kept, before Read.
  const bare = keepNetflix(m.body, "## Read\n- [Dune](https://www.goodreads.com/review/show/1)");
  assert.match(bare, /^## Watched\n- \[Slow Horses S4E1–E3\][^\n]+ · 8\/10 · \[Trakt\][^\n]+\n- \[Glass Onion/);
  assert.match(bare, /\n\n## Read\n/);
  // A note no import touched is saved as the run wrote it.
  assert.equal(keepNetflix("## Watched\n- Heat (1995)", run), run);
  // Through the shared keepers, beside YouTube's lines: a newer Trakt line updates the numbers and rating, the link stays.
  const yt = `${m.body}\n\n## Watched on YouTube\n- [A video](https://www.youtube.com/watch?v=abcdefghijk) · A channel`;
  const kept = keepImported(yt, "## Watched\n- Slow Horses S4E2 · 9/10");
  assert.match(kept, /\[Slow Horses S4E2\][^\n]+ · 3 episodes · 9\/10 · \[Trakt\]\(https:\/\/trakt\.tv\/shows\/slow-horses\)/);
  assert.match(kept, /## Watched on YouTube\n- \[A video\]/);
  assert.equal(kept.match(/^## Watched$/gm)?.length, 1);
  // A limited series has no season number, so no episode numbers are added.
  const lim = mergeWatched("## Watched\n- Baby Reindeer S1E1 · 9/10", [{ title: "Baby Reindeer", season: "", episodes: ["Episode 1"] }]);
  assert.match(lim.body, /^## Watched\n- \[Baby Reindeer\]\([^)]+\) · Episode 1 · 9\/10$/);
});

test("titles say what was watched", () => {
  assert.equal(netflixSummary([{ title: "Slow Horses" }]), "Slow Horses on Netflix");
  assert.equal(netflixSummary([{ title: "Slow Horses" }, { title: "Heat" }]), "Slow Horses and Heat on Netflix");
  assert.equal(netflixSummary([{ title: "A" }, { title: "B" }, { title: "C" }, { title: "D" }]), "A, B and 2 more on Netflix");
  assert.ok(NETFLIX_TITLE.test("Friday 6 November · Slow Horses on Netflix"));
  assert.ok(!NETFLIX_TITLE.test("Friday 6 November · Severance, a film and a book"));
});
