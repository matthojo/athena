// Rich links on the device: the preview cache rules and the live card for each kind (app/src/db/rich-links-rules.ts).
// Run: npx tsx --test app/src/db/rich-links-rules.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  areaOf,
  eventCard,
  firstLines,
  hostOf,
  linkHostAfter,
  linkPieces,
  nextBirthday,
  noteCard,
  personCard,
  placeCard,
  plainCard,
  previewPictureKey,
  previewPlan,
  readingProgress,
  savedCard,
  serverIsNewer,
  todoCard,
  watchCard,
  type Clock,
  type StoredPreview,
} from "./rich-links-rules";
import type { LinkPreview } from "../../../lib/link-previews";
import type { SavedItem } from "../../../lib/saved-rules";
import type { AthenaEvent, Commitment, Note, Person, Place, ReadingItem } from "../types";

const NOW = Date.parse("2026-11-08T12:00:00Z");
const HOUR = 3_600_000;

test("a web link's label is followed by the site it goes to, unless the label names it", () => {
  const [p] = linkPieces("Here it is: [Open your receipt](https://evil.example/?d=abc123)");
  assert.equal(p.target, "web");
  assert.equal(linkHostAfter(p.label, (p as { url: string }).url), "evil.example");
  assert.equal(linkHostAfter("Shop", "https://www.shop.example.com/kettle"), "shop.example.com");
  // The label already says where: nothing to add.
  assert.equal(linkHostAfter("shop.example.com/kettle", "https://shop.example.com/kettle"), null);
  assert.equal(linkHostAfter("On Shop.Example.com", "https://www.shop.example.com/"), null);
  // A label naming a different site than the link's is the case that matters.
  assert.equal(linkHostAfter("bank.example", "https://bank.example.evil.example/login"), "bank.example.evil.example");
  // A lookalike host shows as its real (punycode) name.
  assert.equal(linkHostAfter("example.com", "https://exаmple.com/"), "xn--exmple-4nf.com");
  // No label: the host is the label already.
  assert.equal(linkHostAfter("", "https://shop.example.com/"), null);
});
const clock: Clock = { today: "2026-11-08", tz: "Europe/London" };
const ID = "11111111-2222-4333-8444-555555555555";
const PLACE = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";

function preview(over: Partial<LinkPreview> = {}): LinkPreview {
  return {
    id: "p1",
    url: "https://example.com/walk",
    status: "ok",
    title: "A walk",
    summary: null,
    site_name: "example.com",
    author: null,
    kind: null,
    facts: null,
    image_url: "/api/link-preview/p1/image?v=abc",
    image_w: 1200,
    image_h: 630,
    image_tone: "#334455",
    shape: "wide",
    favicon_url: "/api/link-preview/p1/favicon?v=abc",
    fetched_at: "2026-11-01T00:00:00.000Z",
    embed: null,
    ...over,
  };
}
const stored = (over: Partial<LinkPreview> = {}, checkedAgo = 0): StoredPreview => ({ preview: preview(over), checked_at: NOW - checkedAgo });

test("preview cache: this device first, the server after a day (an hour for a failure), never offline", () => {
  assert.equal(previewPlan(null, { online: true, now: NOW }), "fetch", "nothing here: ask");
  assert.equal(previewPlan(null, { online: false, now: NOW }), "none", "nothing here, offline: nothing");
  assert.equal(previewPlan(stored({}, 2 * HOUR), { online: true, now: NOW }), "cached", "checked two hours ago");
  assert.equal(previewPlan(stored({}, 25 * HOUR), { online: true, now: NOW }), "check", "a day on: ask if the server's is newer");
  assert.equal(previewPlan(stored({}, 400 * HOUR), { online: false, now: NOW }), "cached", "offline: the copy here, however old");
  assert.equal(previewPlan(stored({ status: "failed" }, 30 * 60_000), { online: true, now: NOW }), "cached", "a failure, half an hour ago");
  assert.equal(previewPlan(stored({ status: "failed" }, 61 * 60_000), { online: true, now: NOW }), "check", "a failure, over an hour ago");
  assert.equal(previewPlan(stored({}, 0), { online: true, now: NOW, refresh: true }), "check", "Try again always asks");
  assert.equal(previewPlan(stored({}, 0), { online: false, now: NOW, refresh: true }), "cached", "Try again offline keeps the copy");
});

test("preview cache: the server's copy replaces this one only when it's newer", () => {
  const here = preview();
  assert.equal(serverIsNewer(null, here), true);
  assert.equal(serverIsNewer(here, preview()), false, "the same read");
  assert.equal(serverIsNewer(here, preview({ fetched_at: "2026-12-01T00:00:00.000Z", image_url: "/api/link-preview/p1/image?v=def" })), true, "a later read");
  assert.equal(serverIsNewer(here, preview({ fetched_at: "2026-10-01T00:00:00.000Z" })), false, "an older read never wins");
  assert.equal(serverIsNewer(here, preview({ status: "failed" })), false, "a failure never replaces a good copy");
  assert.equal(serverIsNewer(preview({ status: "failed", fetched_at: null }), here), true, "a good read replaces a failure");
  assert.equal(serverIsNewer(here, preview({ favicon_url: null })), true, "the favicon went");
  assert.equal(serverIsNewer(here, preview({ id: "p2" })), true, "a new row (a new key)");
});

test("preview pictures are kept under a key that changes with their ?v=", () => {
  assert.equal(previewPictureKey(preview(), "image"), "/link-preview-cache/p1/image/abc");
  assert.equal(previewPictureKey(preview(), "favicon"), "/link-preview-cache/p1/favicon/abc");
  assert.equal(previewPictureKey(preview({ image_url: "/api/link-preview/p1/image?v=def" }), "image"), "/link-preview-cache/p1/image/def");
  assert.equal(previewPictureKey(preview({ image_url: null }), "image"), null);
  assert.equal(previewPictureKey(preview({ image_url: "/sample/saved/night.webp" }), "image"), null, "a sample's own file isn't kept");
});

test("person: relationship, last catch-up and next birthday (with the age turned when the year is known)", () => {
  const p: Person = { id: ID, name: "Priya Shah", notes: "", last_contacted_at: "2026-10-30T18:00:00.000Z", relationship: " Friend ", birthday: "1990-11-20", created_at: "", updated_at: "" };
  const card = personCard(p, clock);
  assert.deepEqual(card, {
    kind: "person",
    id: ID,
    title: "Priya Shah",
    archived: false,
    stale: false,
    photo: null,
    relationship: "Friend",
    lastCatchUp: "2026-10-30T18:00:00.000Z",
    nextBirthday: { date: "2026-11-20", inDays: 12, turns: 36 },
  });
  assert.deepEqual(nextBirthday("--03-02", clock), { date: "2027-03-02", inDays: 114, turns: null }, "no year: next one, no age");
  assert.deepEqual(nextBirthday("1990-11-08", clock), { date: "2026-11-08", inDays: 0, turns: 36 }, "today");
  assert.equal(nextBirthday(null, clock), null);
  assert.equal(personCard({ ...p, birthday: null, relationship: "", last_contacted_at: null, archived_at: "2026-11-01" }, clock).archived, true);
});

test("place: name, area from the address, map still, Open map and last visit", () => {
  const p: Place = { id: PLACE, name: "Dishoom King's Cross", address: "5 Stable Street, London N1C 4AB", url: "", notes: "", created_at: "", updated_at: "" };
  assert.deepEqual(placeCard(p, { mapUrl: "blob:x", openMapUrl: "maps://?q=x", lastVisit: "2026-11-03" }), {
    kind: "place",
    id: PLACE,
    title: "Dishoom King's Cross",
    name: "Dishoom King's Cross",
    archived: false,
    stale: false,
    area: "London",
    address: "5 Stable Street, London N1C 4AB",
    mapUrl: "blob:x",
    openMapUrl: "maps://?q=x",
    lastVisit: "2026-11-03",
  });
  assert.equal(areaOf("Silk Street, London EC2Y 8DS, United Kingdom"), "London");
  assert.equal(areaOf("12 Rue de Rivoli, 75001 Paris, France"), "Paris");
  assert.equal(areaOf("1 Infinite Loop, Cupertino, CA 95014"), "Cupertino", "a US state is skipped");
  assert.equal(areaOf("Hampstead Heath"), null, "one part: no area to tell");
  assert.equal(areaOf(""), null);
  assert.deepEqual(placeCard({ ...p, address: "" }).address, null);
});

test("to-do: title, due, done and overdue", () => {
  const c = { id: ID, title: "Book the dentist", kind: "todo", status: "open", due_on: "2026-11-07", notes: "", person_id: null, person: null, done_at: null, created_at: "", updated_at: "" } as unknown as Commitment;
  assert.deepEqual(todoCard(c, clock), { kind: "todo", id: ID, title: "Book the dentist", archived: false, stale: false, due: "2026-11-07", done: false, overdue: true });
  assert.equal(todoCard({ ...c, status: "done" }, clock).done, true);
  assert.equal(todoCard({ ...c, status: "done" }, clock).overdue, false, "done isn't overdue");
  assert.equal(todoCard({ ...c, due_on: "2026-11-08" }, clock).overdue, false, "due today isn't overdue");
  assert.equal(todoCard({ ...c, status: "dropped" }, clock).archived, true, "a dropped to-do reads as gone");
});

test("Watch & read: cover, kind, status in the kind's words, and progress", () => {
  const r: ReadingItem = { id: ID, title: "Severance", url: "", kind: "tv", author: "", status: "reading", notes: "Up to S2, episode 4.", recommended_by: null, recommender: null, finished_at: null, source: null, created_at: "", updated_at: "" };
  const cover = { src: "blob:c", w: 2, h: 3, tone: "#111111" };
  assert.deepEqual(watchCard(r, { cover }), { kind: "watch", id: ID, title: "Severance", archived: false, stale: false, cover, readingKind: "tv", kindLabel: "TV show", status: "reading", statusLabel: "Watching", progress: null, progressText: null });
  assert.equal(watchCard({ ...r, kind: "book", status: "queued" }).statusLabel, "To read");
  assert.equal(watchCard({ ...r, kind: "film", status: "done" }).progress, 1);
  assert.equal(readingProgress("queued", ""), 0);
  assert.equal(readingProgress("reading", "About 40% in"), 0.4);
  assert.equal(readingProgress("reading", "Page 120 of 300"), 0.4);
  assert.equal(readingProgress("reading", "Up to 7/10"), 0.7);
  assert.equal(readingProgress("reading", "Up to S2"), null, "not a fraction");
  assert.equal(readingProgress("reading", "300 of 120"), null, "can't be past the end");
});

test("Watch & read progress reads the field first, then the notes", () => {
  const r: ReadingItem = { id: ID, title: "The Mom Test", url: "", kind: "book", author: "", status: "reading", notes: "About 10% in", recommended_by: null, recommender: null, finished_at: null, source: null, created_at: "", updated_at: "" };
  const pages = watchCard({ ...r, progress: { unit: "page", done: 84, total: 136 } });
  assert.equal(pages.progress, 84 / 136, "the field wins over the notes");
  assert.equal(pages.progressText, "Page 84 of 136");
  const pct = watchCard({ ...r, progress: { unit: "percent", done: 45, total: null } });
  assert.equal(pct.progress, 0.45);
  assert.equal(pct.progressText, "45%");
  // A count with no total gives no share: the notes fill in, and the words still say where you are.
  const count = watchCard({ ...r, progress: { unit: "episode", done: 4, total: null } });
  assert.equal(count.progress, 0.1);
  assert.equal(count.progressText, "Episode 4");
  assert.equal(watchCard({ ...r, progress: null }).progress, 0.1, "no field: the notes");
  assert.equal(watchCard(r).progress, 0.1, "an older copy without the field: the notes");
  assert.equal(watchCard({ ...r, status: "done", progress: { unit: "page", done: 84, total: 136 } }).progress, 1, "finished is full");
  assert.equal(watchCard({ ...r, status: "queued", notes: "", progress: null }).progress, 0);
});

test("Saved: picture, price and shop", () => {
  const s = { id: ID, kind: "link", url: "https://www.cos.com/dress", title: "Pleated midi dress", site: "cos.com", image_url: "/api/saved/x/image", image_w: 800, image_h: 1000, image_tone: "#6b4a3a", archived: false, facts: { price: "89", currency: "GBP", shop: "COS" } } as unknown as SavedItem;
  const image = { src: "blob:s", w: 800, h: 1000, tone: "#6b4a3a" };
  assert.deepEqual(savedCard(s, { image }), { kind: "saved", id: ID, title: "Pleated midi dress", archived: false, stale: false, image, price: "£89", shop: "COS", url: "https://www.cos.com/dress" });
  const bare = savedCard({ ...s, facts: null });
  assert.deepEqual([bare.price, bare.shop, bare.image], [null, "cos.com", null], "no facts: the site stands in for the shop");
});

test("event: next date, time and place (from its notes' first place link)", () => {
  const base = { id: ID, kind: "other" as const, time: null, starts_at: null, recurrence: "none" as const, year_known: true, remind_days_before: [] as number[], person_id: null, created_at: "", updated_at: "" };
  const dinner: AthenaEvent = { ...base, title: "Dinner with Priya", date: "2026-11-14", starts_at: "2026-11-14T19:30:00.000Z", notes: `At [@Dishoom](athena://place/${PLACE}).` };
  assert.deepEqual(eventCard(dinner, clock, { placeName: () => "Dishoom King's Cross" }), {
    kind: "event",
    id: ID,
    title: "Dinner with Priya",
    archived: false,
    stale: false,
    date: "2026-11-14",
    time: "19:30",
    place: { id: PLACE, name: "Dishoom King's Cross" },
  });
  assert.deepEqual(eventCard(dinner, clock).place, { id: PLACE, name: "Dishoom" }, "the link's own label when the place isn't on this device");
  const birthday: AthenaEvent = { ...base, kind: "birthday", title: "Mum's birthday", date: "1960-03-02", recurrence: "yearly", notes: "" };
  assert.deepEqual([eventCard(birthday, clock).date, eventCard(birthday, clock).time, eventCard(birthday, clock).place], ["2027-03-02", null, null]);
});

test("note: title, first lines as plain text, when it was edited", () => {
  const n: Note = {
    id: ID,
    title: "Saturday with Priya",
    body: `# Saturday with Priya\n\nWe walked from [@Dishoom](athena://place/${PLACE} "card") to the canal.\n\n- **Coffee** at [Granary](https://example.com/g "card")\n- Bought bread`,
    type: "note",
    source: null,
    tags: [],
    created_at: "",
    updated_at: "2026-11-07T10:00:00.000Z",
  };
  assert.deepEqual(noteCard(n), { kind: "note", id: ID, title: "Saturday with Priya", archived: false, stale: false, firstLines: "We walked from Dishoom to the canal.\nCoffee at Granary\nBought bread", updated: "2026-11-07T10:00:00.000Z" });
  assert.ok(!/athena:|https:|\(|\*|"card"/.test(noteCard(n).firstLines), "no Markdown, addresses or modes");
  const long = firstLines({ title: "", body: "word ".repeat(100) }, 40);
  assert.ok(long.endsWith("…") && long.length <= 41, long);
  assert.equal(noteCard({ ...n, title: "" }).title, "Saturday with Priya", "no title: the first line");
});

test("records, organisations and projects: a plain card with a subtitle", () => {
  assert.deepEqual(plainCard("record", ID, "Château Musar 2017", "Wine"), { kind: "record", id: ID, title: "Château Musar 2017", subtitle: "Wine", archived: false, stale: false });
  assert.deepEqual(plainCard("project", ID, "Athena", "Active", { archived: true }).archived, true);
  assert.equal(hostOf("https://www.netlify.com/about"), "netlify.com");
  assert.equal(hostOf("netlify.com"), "netlify.com");
  assert.equal(hostOf(""), "");
  assert.equal(hostOf("not a host"), "");
});

test("links in text: every link and mode is found, so Ask never shows one as Markdown", async () => {
  const { linkPieces } = await import("./rich-links-rules");
  const text = [
    `Lunch with [@Priya](athena://person/${ID}) at [@Dishoom](athena://place/${PLACE} "card").`,
    `[A slow walk](https://example.com/walk "card")`,
    `[The video](https://youtu.be/dQw4w9WgXcQ 'embed') and [docs](https://example.com/docs) and [@Site](https://example.org "mention").`,
    `[Plan](athena://note/${ID} "link") then [@Thing](athena://todo/${ID} "embed")`,
    `![a picture](https://example.com/p.png "card")`,
  ].join("\n");
  const pieces = linkPieces(text);
  assert.deepEqual(
    pieces.map((p) => [p.target, p.target === "athena" ? p.kind : p.url, p.label, p.mode]),
    [
      ["athena", "person", "@Priya", "mention"],
      ["athena", "place", "@Dishoom", "card"],
      ["web", "https://example.com/walk", "A slow walk", "card"],
      ["web", "https://youtu.be/dQw4w9WgXcQ", "The video", "embed"],
      ["web", "https://example.com/docs", "docs", "link"],
      ["web", "https://example.org", "@Site", "mention"],
      ["athena", "note", "Plan", "link"],
      ["athena", "todo", "@Thing", "card"],
    ],
  );
  let left = text;
  for (const p of [...pieces].reverse()) left = left.slice(0, p.at) + left.slice(p.end);
  assert.ok(!/\]\((athena|https?):/.test(left.replace(/!\[[^\]]*\]\([^)]*\)/g, "")), `nothing left as a link: ${left}`);
  assert.ok(!/"card"|'embed'|"mention"|"link"/.test(left.replace(/!\[[^\]]*\]\([^)]*\)/g, "")), "no mode words left");
});
