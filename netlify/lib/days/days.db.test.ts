// Real path for Days: the real /api function and routes, a stand-in Life log run through the runner's own
// AthenaWriter (athena_day_entry, athena_day_line, athena_day_read, athena_health_day), the Netflix and Timeline
// imports as the app sends them, the conversion of sample Life log notes, Ask's days tool through answerQuestion
// with a scripted model, global search, and Postgres with every migration applied (0032 included).
// Run: ATHENA_TEST_DB_URL=postgres://… npx tsx --test netlify/lib/days/days.db.test.ts
// Skipped without ATHENA_TEST_DB_URL. Uses fixed test keys; empties the Days, Life log, health and places rows first.
// Outside services are stubbed: Nominatim and Open-Meteo answer from here.
import { test } from "node:test";
import assert from "node:assert/strict";

const url = process.env.ATHENA_TEST_DB_URL;
if (url) {
  process.env.NETLIFY_DB_URL = url;
  process.env.CONNECTOR_ENCRYPTION_KEY ??= "11".repeat(32);
  process.env.ATHENA_DATA_KEY = "22".repeat(32);
  process.env.ANTHROPIC_API_KEY ??= "test";
  process.env.MCP_BEARER_TOKEN = "master-token-for-tests";
  (globalThis as { Netlify?: unknown }).Netlify = { env: { get: (k: string) => process.env[k] } };
}

const TZ = "Europe/London";
const DAY = "2026-11-06";
const OLD = "2026-10-01";
const RUN = "00000000-0000-0000-0000-0000000000aa";

test("Days: a Life log run, imports, health, places, conversion, Ask and search, and one whole busy day", { skip: !url && "set ATHENA_TEST_DB_URL" }, async () => {
  const api = (await import("../../functions/api")).default;
  const { handleConnectorRoutes } = await import("../connectors/routes");
  const { AthenaWriter } = await import("../connectors/runner");
  const { qRaw, q, createNote } = await import("../../../lib/db");
  const { answerQuestion } = await import("../../../lib/answer");
  const { answerSourcesWith } = await import("../connectors/answer-sources");
  const { recall } = await import("../../../lib/memory");
  const D = await import("../../../lib/days");
  const { episodeHash } = await import("../../../lib/netflix-csv");

  for (const t of ["day_files", "day_entries", "days", "custom_values", "reading_items", "collected_items", "collections", "connectors", "location_todo", "location_cache", "place_geo"]) await qRaw(`DELETE FROM ${t}`);
  await qRaw(`DELETE FROM notes`);
  await qRaw(`DELETE FROM events`);
  await qRaw(`DELETE FROM sensitive_blobs WHERE domain IN ('health', 'location')`);
  await qRaw(`DELETE FROM places`);
  await qRaw(`INSERT INTO settings (key, value) VALUES ('timezone', '"Europe/London"') ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`);

  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL, init: RequestInit = {}) => {
    const u = new URL(String(input));
    const reply = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
    if (u.host === "nominatim.openstreetmap.org") return reply({ name: "Kentish Town", category: "place", type: "suburb", address: { suburb: "Kentish Town", city: "London" } });
    if (u.host.endsWith("open-meteo.com")) {
      const d = u.searchParams.get("start_date")!;
      return reply({ daily: { time: [d], temperature_2m_max: [13.6], weather_code: [63], precipitation_sum: [5.1] } });
    }
    return realFetch(input as never, init);
  }) as typeof fetch;

  const call = async (method: string, path: string, body?: unknown, token = "master-token-for-tests") => {
    const res = await api(
      new Request(`https://athena.test/api${path}`, { method, headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) }),
      {} as never,
    );
    const text = await res.text();
    return { status: res.status, json: text ? JSON.parse(text) : null, text };
  };
  const routes = async (method: string, path: string, body?: unknown) => {
    const u = new URL(`https://athena.test/api${path}`);
    const req = new Request(u, { method, body: body === undefined ? undefined : JSON.stringify(body), headers: { "Content-Type": "application/json" } });
    const res = (await handleConnectorRoutes(req, u, u.pathname.split("/").filter(Boolean), (d, s = 200) => Response.json(d, { status: s }), u.origin))!;
    return { status: res.status, json: JSON.parse(await res.text()) };
  };

  try {
    // ---- accounts and a Life log ----
    const nf = (await routes("POST", "/connectors", { provider: "netflix", name: "Netflix", account_label: "personal" })).json;
    const gr = (await routes("POST", "/connectors", { provider: "goodreads", name: "Goodreads", account_label: "personal", url: "https://www.goodreads.com/user/show/12345-jordan" })).json;
    const life = (await routes("POST", "/collections", { recipe: "life-log", name: "Life log", label: "personal", connector_ids: [gr.id], schedule: "daily", run_at: "23:30" })).json;
    assert.ok(life.id, JSON.stringify(life));

    // ---- Netflix: the import writes entries, one per episode and film ----
    const netflixDays = [{ day: DAY, watched: [{ title: "Severance", season: "Season 2", episodes: ["Who Is Alive?", "Chikhai Bardo"] }, { title: "Roma" }] }];
    let r = await routes("POST", `/connectors/${nf.id}/viewing`, { days: netflixDays, file: { items: 3, days: 1 } });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.deepEqual({ ...r.json, watch_read: undefined }, { days_created: 1, days_updated: 0, days_unchanged: 0, days_skipped: 0, added: 3, added_films: 1, watch_read: undefined });
    // The same file again: nothing.
    r = await routes("POST", `/connectors/${nf.id}/viewing`, { days: netflixDays, file: { items: 3, days: 1 } });
    assert.deepEqual([r.json.days_unchanged, r.json.added], [1, 0]);
    assert.equal((await q<{ n: number }>(`SELECT count(*)::int AS n FROM notes`))[0].n, 0, "no day note");

    // Sealed at rest: titles and the source's ids aren't readable; the dedupe key is a blind index.
    const raw = await qRaw<{ title: string; external_id: string; ext_key: string }>(`SELECT title, external_id, ext_key FROM day_entries`);
    for (const x of raw) {
      assert.match(x.title, /^enc:v1:/);
      assert.match(x.external_id, /^enc:v1:/);
      assert.ok(!x.ext_key.includes(DAY), "the key says nothing");
    }

    // ---- a stand-in Life log run, through the runner's own writer ----
    const stats = { notes_created: 0, notes_updated: 0, restored: 0, metrics: 0, skipped_dismissed: 0 } as never;
    const writer = new AthenaWriter(life, RUN, stats, new Date("2026-11-07T08:00:00Z"), TZ);
    const names = writer.tools.map((t) => t.name);
    for (const n of ["athena_day_entry", "athena_day_line", "athena_day_read"]) assert.ok(names.includes(n), n);
    await assert.rejects(
      writer.run("athena_save_note", { external_id: `life-log-${DAY}`, title: "Friday", body: "## Watched" }),
      /athena_day_entry/,
      "a Life log day isn't a note any more",
    );
    const entries = [
      // Trakt's copy of a Netflix episode: folds into it, adding the episode number and the rating.
      { kind: "watched", source: "trakt", external_id: "h-9001", title: "Severance", subtitle: "S2E3 · Who Is Alive?", rating: "9/10", url: "https://trakt.tv/shows/severance", at: "2026-11-06T21:00:00Z" },
      { kind: "listened", source: "lastfm", external_id: "blackstar-2026-11-06", title: "Blackstar", subtitle: "David Bowie", count: 7, minutes: 41, note: "the whole album", group: "David Bowie" },
      { kind: "read", source: "goodreads", external_id: "book:123", title: "The Wager", subtitle: "David Grann", note: "finished", url: "https://www.goodreads.com/book/show/123" },
      { kind: "highlight", source: "readwise", external_id: "rw-55-2026-11-06", title: "The Wager", subtitle: "David Grann", count: 3, note: "Kindle" },
      { kind: "played", source: "steam", external_id: "steam-2379780-2026-11-06", title: "Balatro", minutes: 75, note: "42.5 hours in total" },
      { kind: "chess", source: "lichess", external_id: "lichess-2026-11-06", title: "Chess on Lichess", count: 4, note: "3 wins, 1 loss" },
      { kind: "posted", source: "bluesky", external_id: "at://me/post/1", title: "Finally finished Severance", url: "https://bsky.app/profile/me/post/1" },
      { kind: "saved", source: "youtube", external_id: "like-dQw4w9WgXcQ", title: "How to build a boat", subtitle: "Some Channel", url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ" },
      { kind: "binge", source: "trakt", external_id: "bad", title: "Refused" },
    ];
    const saved = JSON.parse(await writer.run("athena_day_entry", { date: DAY, entries }));
    assert.equal(saved.created, 8, JSON.stringify(saved));
    assert.equal(saved.folded, 1);
    assert.equal(saved.refused.length, 1, "one bad entry is named, the rest are saved");
    // A rerun changes nothing.
    const again = JSON.parse(await writer.run("athena_day_entry", { date: DAY, entries: entries.slice(0, 8) }));
    assert.deepEqual([again.created, again.updated, again.unchanged], [0, 0, 8]);
    // The line: written by the run, one sentence, style-checked.
    assert.equal(JSON.parse(await writer.run("athena_day_line", { date: DAY, line: "Finished Severance and The Wager, and a Bowie afternoon" })).result, "saved");
    await assert.rejects(writer.run("athena_day_line", { date: "2026-11-09", line: "Tomorrow" }), /hasn't happened/);
    // athena_day_read: what's there, no health or places.
    const read = JSON.parse(await writer.run("athena_day_read", { date: DAY }));
    assert.equal(read.line, "Finished Severance and The Wager, and a Bowie afternoon");
    assert.ok(read.entries.some((e: { title: string; note?: string }) => e.title === "Balatro" && e.note === "42.5 hours in total"));
    assert.ok(!JSON.stringify(read).includes("steps"));

    // ---- health: sealed, joined into the day, never note text ----
    (writer as unknown as { healthSources: string[] }).healthSources = ["strava"];
    await writer.run("athena_health_day", { date: DAY, source: "strava", workouts: [{ type: "run", minutes: 31, distance_m: 5200 }] });
    let res = await call("POST", "/health/day", { date: DAY, steps: 12400, sleep_minutes: 460, resting_hr: 52 }, (await (await import("../../../lib/api-keys")).createApiKey("iPhone", "capture")).token);
    assert.equal(res.status, 200, res.text);
    assert.equal((await q<{ n: number }>(`SELECT count(*)::int AS n FROM notes`))[0].n, 0, "health writes no note");

    // ---- the Timeline import: places sealed, joined into the day ----
    const at = (hm: string) => new Date(`${DAY}T${hm}:00Z`).toISOString();
    res = await call("POST", "/places/timeline", {
      days: [{ date: DAY, visits: [
        { start: at("00:00"), end: at("08:30"), lat: 51.556, lng: -0.142, kind: "home" },
        { start: at("09:10"), end: at("12:40"), lat: 51.5136, lng: -0.1365, kind: "work" },
        { start: at("12:50"), end: at("13:50"), lat: 51.51245, lng: -0.12705, name: "Dishoom" },
      ] }],
    });
    assert.equal(res.status, 200, res.text);
    await call("POST", "/places/names");
    assert.equal((await q<{ n: number }>(`SELECT count(*)::int AS n FROM notes`))[0].n, 0, "places write no note");

    // ---- the owner's own: mood, journal, a photo, an edited line ----
    const { saveFile } = await import("../../../lib/files");
    const { useFileStore } = await import("../../../lib/files");
    const blobs = new Map<string, Uint8Array>();
    useFileStore(() => ({ set: async (k: string, v: Uint8Array) => void blobs.set(k, v), get: async (k: string) => blobs.get(k) ?? null, delete: async (k: string) => void blobs.delete(k) }) as never);
    const png = Uint8Array.from(Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=", "base64"));
    const photo = await saveFile({ id: "5f0c1a5e-0000-4000-8000-000000000001", name: "heath.png", type: "image/png", bytes: png, width: 1, height: 1, link: { day: DAY } });
    // Added straight to the day as it uploads; PATCH can add one Athena already has, too.
    res = await call("PATCH", `/days/${DAY}`, { mood: 4, journal: "A slow, good day.\n\nRain at lunch.", photos: { add: [photo.id] } });
    assert.equal(res.status, 200, res.text);
    assert.equal(res.json.mood, 4);
    for (const bad of [{ mood: 6 }, { mood: "great" }, { line: "x".repeat(300) }, { colour: "blue" }]) assert.equal((await call("PATCH", `/days/${DAY}`, bad)).status, 400, JSON.stringify(bad));
    const [privateRaw] = await qRaw<{ private: string; line: string }>(`SELECT private, line FROM days WHERE date = $1::date`, [DAY]);
    assert.match(privateRaw.private, /^enc:v1:/, "mood and journal sealed");
    assert.match(privateRaw.line, /^enc:v1:/, "the line sealed");
    // The owner rewrites the line: a later run's line doesn't replace it.
    await call("PATCH", `/days/${DAY}`, { line: "Severance done. Bowie all afternoon." });
    assert.equal(JSON.parse(await writer.run("athena_day_line", { date: DAY, line: "Another line from the run" })).result, "owner_wrote_it");

    // ---- notes, meetings and events that day link by date ----
    const meeting = await createNote({ title: "Pricing sync with Gayle", body: "Decided on the new tier.", type: "note", source: "calendar-meetings", tags: [] });
    await qRaw(`UPDATE notes SET created_at = $2::timestamptz WHERE id = $1`, [meeting.id, `${DAY}T10:00:00Z`]);
    await qRaw(`INSERT INTO events (title, kind, date, starts_at) VALUES ('Dentist', 'appointment', $1::date, $2::timestamptz)`, [DAY, `${DAY}T15:30:00Z`]);

    // ---- the whole day, as the app reads it ----
    res = await call("GET", `/days/${DAY}`);
    assert.equal(res.status, 200, res.text);
    const day = res.json as import("../../../lib/day-types").Day;
    assert.equal(day.date, DAY);
    assert.equal(day.line, "Severance done. Bowie all afternoon.");
    assert.equal(day.line_by, "owner");
    assert.equal(day.mood, 4);
    assert.equal(day.journal, "A slow, good day.\n\nRain at lunch.");
    assert.deepEqual(day.photos.map((p) => p.id), [photo.id]);
    assert.equal(day.weather, "14° and rain in London");
    assert.deepEqual(day.places.map((p) => p.name), ["Home", "Work", "Dishoom"]);
    assert.equal(day.health?.steps, 12400);
    assert.match(day.health?.line ?? "", /7h 40m sleep/);
    const sev = day.entries.filter((e) => e.title === "Severance");
    assert.equal(sev.length, 2, "two Netflix episodes; Trakt's copy folded into one");
    const folded = sev.find((e) => e.subtitle === "S2E3 · Who Is Alive?");
    assert.ok(folded, JSON.stringify(sev));
    assert.equal(folded!.source, "netflix");
    assert.equal(folded!.rating, 4.5);
    assert.ok(day.entries.some((e) => e.kind === "workout" && e.minutes === 31), "Strava's run, opened from the sealed day");
    assert.deepEqual(day.notes.map((n) => n.title), ["Pricing sync with Gayle"]);
    assert.deepEqual(day.events.map((e) => e.title), ["Dentist"]);
    // The Timeline import wrote the day's stops as entries, sealed like every entry.
    const placeRows = await qRaw<{ title: string; kind: string }>(`SELECT title, kind FROM day_entries WHERE source = 'places' AND date = $1::date`, [DAY]);
    assert.equal(placeRows.length, 3);
    for (const r of placeRows) assert.match(r.title, /^enc:v1:/);
    assert.ok(!(await D.getDay(DAY, { tz: TZ, places: false }))!.entries.some((e) => e.source === "places"), "hidden where places are");
    assert.deepEqual(day.entries.filter((e) => e.source === "places").map((e) => [e.kind, e.title]), [["other", "Home"], ["other", "Work"], ["other", "Dishoom"]]);
    assert.deepEqual(day.counts.by_kind, { watched: 3, listened: 7, read: 1, highlight: 3, played: 1, chess: 4, posted: 1, saved: 1, workout: 1, other: 3 });
    assert.deepEqual(day.counts.minutes, { listened: 41, played: 75, workout: 31 });
    assert.equal(day.counts.steps, 12400);
    assert.equal(day.counts.heat, 4);

    // ---- cover art: days-art's finder writes it through setEntryArt; the day and its summary carry it ----
    const art = { id: "a".repeat(32), w: 200, h: 300, tone: "#aa7744" };
    const blackstar = day.entries.find((e) => e.title === "Blackstar")!;
    assert.ok((await D.entriesWithoutArt(100)).some((e) => e.id === blackstar.id));
    assert.ok(!(await D.entriesWithoutArt(100)).some((e) => ["posted", "saved", "chess", "workout", "other"].includes(e.kind) || e.source === "places"), "only kinds that get art");
    await D.setEntryArt(blackstar.id, art);
    assert.ok(!(await D.entriesWithoutArt(100)).some((e) => e.id === blackstar.id));
    assert.deepEqual((await call("GET", `/days/${DAY}`)).json.entries.find((e: { title: string }) => e.title === "Blackstar").art, art);
    assert.deepEqual((await call("GET", `/days?from=${DAY}&to=${DAY}`)).json.days[0].art, [art], "the calendar cell gets it too");

    // A capture key can't read a day.
    const capture = (await (await import("../../../lib/api-keys")).createApiKey("Shortcut", "capture")).token;
    assert.equal((await call("GET", `/days/${DAY}`, undefined, capture)).status, 401);

    // Hide an entry: gone from the day, and a source saving it again leaves it hidden.
    const steam = day.entries.find((e) => e.source === "steam")!;
    assert.equal((await call("PATCH", `/days/${DAY}/entries/${steam.id}`, { hidden: true })).json.changed, true);
    assert.equal(JSON.parse(await writer.run("athena_day_entry", { date: DAY, entries: [entries[4]] })).skipped, 1);
    assert.ok(!(await call("GET", `/days/${DAY}`)).json.entries.some((e: { source: string }) => e.source === "steam"));

    // ---- conversion: old Life log notes become entries, then are archived ----
    const sample = `## Health\n7h sleep · 8,000 steps\n\n## Watched\n- [Slow Horses S4](https://www.netflix.com/search?q=Slow%20Horses#e=${episodeHash("Slow Horses", "S4", "Hello Goodbye")}) · Hello Goodbye\n- [Dune (2021)](https://letterboxd.com/me/film/dune-2021/) · ★★★★½\n\n## Listened\n- [Blackstar](https://www.last.fm/music/David+Bowie/Blackstar) · David Bowie · 7 tracks\n\n## Places\nLunch at Dishoom`;
    const old = await createNote({ title: "Wednesday 1 October · Slow Horses, Dune and Bowie", body: sample, type: "note", source: life.source, tags: ["life-log"] });
    await qRaw(`INSERT INTO collected_items (source, kind, external_id, record_id, title, item_date) VALUES ($1, 'note', $2, $3, '', $4::date)`, [life.source, `life-log-${OLD}`, old.id, OLD]);
    const plan = (await call("GET", "/days/convert")).json;
    assert.deepEqual({ notes: plan.notes, days: plan.days, entries: plan.entries, lines: plan.lines }, { notes: 1, days: 1, entries: 9, lines: 1 });
    assert.deepEqual(plan.by_kind, { watched: 2, listened: 7 });
    assert.equal((await q<{ n: number }>(`SELECT count(*)::int AS n FROM day_entries WHERE date = $1::date`, [OLD]))[0].n, 0, "the dry run writes nothing");
    const done = (await call("POST", "/days/convert")).json;
    assert.deepEqual(done, { converted: 1, entries: 3, lines: 1, remaining: 0, unreadable: 0 });
    const [archived] = await qRaw<{ archived_at: string | null }>(`SELECT archived_at FROM notes WHERE id = $1`, [old.id]);
    assert.ok(archived.archived_at, "archived, never deleted");
    const oldDay = (await call("GET", `/days/${OLD}`)).json;
    assert.equal(oldDay.line, "Slow Horses, Dune and Bowie");
    assert.deepEqual(oldDay.entries.map((e: { title: string; source: string }) => `${e.source}:${e.title}`).sort(), ["lastfm:Blackstar", "letterboxd:Dune (2021)", "netflix:Slow Horses"]);
    // Idempotent: nothing more to do, and the Netflix import of that day finds its episode already there.
    assert.equal((await call("GET", "/days/convert")).json.notes, 0);
    assert.deepEqual((await call("POST", "/days/convert")).json.converted, 0);
    r = await routes("POST", `/connectors/${nf.id}/viewing`, { days: [{ day: OLD, watched: [{ title: "Slow Horses", season: "S4", episodes: ["Hello Goodbye"] }] }] });
    assert.equal(r.json.added, 0, "the converted episode is the import's episode");
    // A run's own entry for a converted line takes over from it.
    const takeover = JSON.parse(await writer.run("athena_day_entry", { date: OLD, entries: [{ kind: "listened", source: "lastfm", external_id: "blackstar-2026-10-01", title: "Blackstar", subtitle: "David Bowie", count: 7, minutes: 41 }] }));
    assert.equal(takeover.folded, 1);
    const afterTakeover = (await call("GET", `/days/${OLD}`)).json;
    assert.equal(afterTakeover.entries.filter((e: { title: string }) => e.title === "Blackstar").length, 1);
    assert.equal(afterTakeover.entries.find((e: { title: string }) => e.title === "Blackstar").minutes, 41);

    // ---- a range: the calendar's summaries ----
    const range = (await call("GET", `/days?from=2026-09-28&to=2026-11-07`)).json;
    assert.deepEqual(range.days.map((d: { date: string }) => d.date), [OLD, DAY]);
    const busy = range.days.find((d: { date: string }) => d.date === DAY);
    assert.equal(busy.mood, 4);
    assert.equal(busy.journal, true);
    assert.equal(busy.photo, photo.id);
    assert.equal(busy.counts.heat, 4);
    assert.equal(busy.counts.by_kind.other, 3, "places count toward the day");
    assert.equal(busy.counts.steps, 12400);
    assert.equal((await call("GET", "/days?from=2026-01-01&to=2027-06-01")).status, 400, "at most 400 days");

    // ---- search: Days' own, and global search ----
    const found = (await call("GET", `/days/search?q=${encodeURIComponent("wager")}`)).json;
    assert.ok(found.results.some((h: { match: string; entry?: { title: string } }) => h.match === "entry" && h.entry?.title === "The Wager"));
    const byLine = (await call("GET", `/days/search?q=${encodeURIComponent("bowie afternoon")}`)).json;
    assert.ok(byLine.results.some((h: { match: string }) => h.match === "line"));
    const journal = (await call("GET", `/days/search?q=${encodeURIComponent("rain lunch")}`)).json;
    assert.ok(journal.results.some((h: { match: string }) => h.match === "journal"), "the owner's own search reaches the journal");
    // Markers, filters and facets.
    assert.ok(found.results.some((h: { snippet: string }) => h.snippet === "Read: The «Wager» · David Grann"), JSON.stringify(found.results.map((h: { snippet: string }) => h.snippet)));
    assert.ok(byLine.results.some((h: { snippet: string }) => h.snippet.includes("«Bowie afternoon»")) || byLine.results.some((h: { snippet: string }) => /«Bowie»/.test(h.snippet)));
    assert.deepEqual(found.facets.places, ["Dishoom", "Home", "Work"]);
    assert.ok(found.facets.sources.includes("goodreads") && found.facets.sources.includes("readwise"));
    const { upsertPerson, linkEntities } = await import("../../../lib/db");
    const gayle = await upsertPerson({ name: "Gayle Lee" });
    await linkEntities({ sourceType: "note", sourceId: meeting.id, targetType: "person", targetId: gayle.id, relation: "mentions" });
    const withGayle = (await call("GET", `/days/search?q=wager&person=${encodeURIComponent("gayle")}`)).json;
    assert.ok(withGayle.results.length > 0 && withGayle.results.every((h: { date: string }) => h.date === DAY));
    assert.deepEqual(withGayle.facets.people, ["Gayle Lee"]);
    assert.equal((await call("GET", `/days/search?q=wager&person=nobody`)).json.results.length, 0);
    assert.ok((await call("GET", `/days/search?q=wager&place=dishoom`)).json.results.length > 0);
    assert.equal((await call("GET", `/days/search?q=wager&place=Lisbon`)).json.results.length, 0);
    const onlyReadwise = (await call("GET", `/days/search?q=wager&source=readwise`)).json.results;
    assert.ok(onlyReadwise.length > 0 && onlyReadwise.every((h: { entry?: { source: string } }) => h.entry?.source === "readwise"));
    assert.ok((await call("GET", `/days/search?q=dishoom`)).json.results.some((h: { entry?: { source: string } }) => h.entry?.source === "places"), "the owner's own search finds places");
    assert.ok(!(await recall("dishoom")).some((h) => h.kind === "day"), "global search doesn't");

    const global = await recall("wager");
    const dayHit = global.find((h) => h.kind === "day");
    assert.equal(dayHit?.id, DAY);
    // Journals are searched like any note body: ⌘K finds the day by what was written.
    const byJournal = (await recall("rain lunch")).find((h) => h.kind === "day");
    assert.equal(byJournal?.id, DAY, "global search reaches the journal");
    assert.match(byJournal!.snippet, /«/, "with the match marked");
    const { sealed: stillSealed } = (await qRaw<{ sealed: boolean }>(`SELECT private LIKE 'enc:v1:%' AS sealed FROM days WHERE date = $1::date`, [DAY]))[0] as unknown as { sealed: boolean };
    assert.ok(stillSealed, "searching opens the journal in memory only: it stays sealed at rest");

    // ---- Ask: the days tool, with a scripted model ----
    const ask = async (question: string, plan: Record<string, unknown>) => {
      const seen: string[] = [];
      let round = 0;
      const client = {
        messages: {
          async create(params: { messages: unknown; tools?: Array<{ name: string }> }) {
            const base = { id: `m${round}`, type: "message", role: "assistant", model: "test", stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } };
            seen.push(JSON.stringify(params.messages));
            if (round++ === 0) {
              assert.ok(params.tools?.some((t) => t.name === "days"), "Ask offers days");
              return { ...base, stop_reason: "tool_use", content: [{ type: "tool_use", id: "t0", name: "days", input: plan }] };
            }
            return { ...base, stop_reason: "tool_use", content: [{ type: "tool_use", id: "done", name: "answer", input: { found: true, text: "You watched Severance [1].", sources: [{ ref: `day:${DAY}`, title: "Friday", date: DAY }] } }] };
          },
        },
      };
      const reply = await answerQuestion(question, { sources: answerSourcesWith({ list: async () => [], open: async () => null as never }), client: client as never }, { now: new Date("2026-11-07T09:00:00Z"), tz: TZ });
      return { reply, seen: seen.join("\n") };
    };
    const watching = await ask("What was I watching last week?", { from: "2026-11-01", to: "2026-11-07", kind: "watched" });
    assert.equal(watching.reply.sources?.[0]?.kind, "day");
    assert.equal(watching.reply.sources?.[0]?.id, DAY);
    assert.match(watching.seen, /Severance/);
    const oneDay = await ask("What did I do on Friday?", { date: DAY });
    assert.match(oneDay.seen, /Balatro|Blackstar/);
    // A day in full now opens everything the day has (no keyword gate: the model asked for the day). A range of entries still carries none of it.
    for (const sealed of ["12,400", "Dishoom", "\\\"mood\\\""]) assert.ok(oneDay.seen.includes(sealed), sealed);
    for (const secret of ["12400", "12,400", "Dishoom", "\\\"mood\\\""]) assert.ok(!watching.seen.includes(secret), secret);
    assert.match(oneDay.seen, /A slow, good day/, "the journal is part of the day for Ask");
    const searched = await ask("When did I write about rain at lunch?", { query: "rain lunch" });
    assert.match(searched.seen, /journal/, "Ask's days search reaches journals too");
    const feeling = await ask("How was I feeling on Friday?", { date: DAY });
    assert.match(feeling.seen, /A slow, good day/);
    const where = await ask("Where did I have lunch on Friday?", { date: DAY });
    assert.match(where.seen, /Dishoom/);

    // ---- photos stay while the day uses them ----
    const { sweepFiles } = await import("../../../lib/files");
    await qRaw(`UPDATE files SET created_at = now() - interval '1 hour'`);
    await sweepFiles();
    assert.equal((await q<{ n: number }>(`SELECT count(*)::int AS n FROM files WHERE id = $1`, [photo.id]))[0].n, 1, "a day's photo isn't swept");
    await call("PATCH", `/days/${DAY}`, { photos: { remove: [photo.id] } });
    await sweepFiles();
    assert.equal((await q<{ n: number }>(`SELECT count(*)::int AS n FROM files WHERE id = $1`, [photo.id]))[0].n, 0, "taken off, then tidied up");
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("Days: the one-off link repair moves links out of stored words into url, sealed, once", { skip: !url && "set ATHENA_TEST_DB_URL" }, async () => {
  const { qRaw, sealer } = await import("../../../lib/db");
  const D = await import("../../../lib/days");
  const track = "https://open.spotify.com/track/2KlukXYZ";
  await qRaw(`DELETE FROM day_entries`);
  await qRaw(`DELETE FROM settings WHERE key = $1`, [D.LINK_REPAIR_KEY]);
  const s = await sealer();
  // Rows as an older run wrote them: the link in the words, no url.
  const add = (id: string, title: string, subtitle: string | null, note: string | null, link: string | null) =>
    qRaw(
      `INSERT INTO day_entries (date, kind, source, external_id, ext_key, title, subtitle, url, note, position) VALUES ($1::date, 'listened', 'spotify', $2, $3, $4, $5, $6, $7, 0)`,
      [DAY, s.text(id), D.extKeys("spotify", id)[0], s.text(title), s.maybe(subtitle), s.maybe(link), s.maybe(note)],
    );
  await add("a", "Showing Teeth", "A Fate Worse Than Loneliness", `2 plays [link](${track})`, null);
  await add("b", "Blackstar", `David Bowie ${track}`, null, "https://www.last.fm/music/David+Bowie/Blackstar");
  await add("c", "[Untitled]", "Someone", null, null);

  // Read before the repair: already clean.
  const before = await D.getDay(DAY, { tz: TZ });
  const teeth = before!.entries.find((e) => e.title === "Showing Teeth")!;
  assert.deepEqual([teeth.note, teeth.url], ["2 plays", track]);
  assert.ok((await D.entriesWithoutArt()).some((e) => e.title === "Showing Teeth" && e.url === track));

  assert.deepEqual(await D.repairEntryLinks(), { fixed: 2, done: true });
  const rows = await qRaw<{ title: string; note: string | null; url: string | null }>(`SELECT title, note, url FROM day_entries ORDER BY title`);
  // Sealed as writeEntries seals them: nothing readable in the table.
  assert.ok(rows.every((r) => !r.url || !r.url.includes("spotify.com")));
  const after = await D.getDay(DAY, { tz: TZ });
  const by = Object.fromEntries(after!.entries.map((e) => [e.title, e]));
  assert.deepEqual([by["Showing Teeth"].note, by["Showing Teeth"].url], ["2 plays", track]);
  assert.deepEqual([by["Blackstar"].subtitle, by["Blackstar"].url], ["David Bowie", "https://www.last.fm/music/David+Bowie/Blackstar"]);
  assert.equal(by["[Untitled]"].url, undefined);
  // Idempotent: done once, a no-op after.
  assert.deepEqual(await D.repairEntryLinks(), { fixed: 0, done: true });
  await qRaw(`DELETE FROM settings WHERE key = $1`, [D.LINK_REPAIR_KEY]);
  assert.deepEqual(await D.repairEntryLinks(), { fixed: 0, done: true });
});
