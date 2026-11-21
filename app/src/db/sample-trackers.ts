/**
 * Tracking in sample mode: a fake of the server's routes (lib/tracker-types.ts),
 * in memory until the page reloads. It answers what GET/POST/PATCH/DELETE
 * /api/trackers would, so the app is built against the contract alone.
 *
 * The sample's story, from Moss's runs (db/sample-team.ts):
 *  - the LEGO Ferrari, saved at £42, now £34 at Smyths after 12 checks at 4
 *    shops, with a target of £30; and its stock at John Lewis, out for a
 *    fortnight and back in since Tuesday;
 *  - the Aesop balm, saved at £31 at Boots, now £27 at John Lewis: under the
 *    £28 you asked for;
 *  - the Moleskine at £18 at Waterstones, checked last, but £15 at WHSmith on
 *    Friday: under the £16 you asked for, reached at another shop; the dress
 *    checked once more by Ask;
 *  - the Kindle with only its saved price (Amazon didn't answer);
 *  - the linen dress, checked once by Ask, that nobody checks yet;
 *  - the Fellow kettle, a shop's page with nothing tracked yet;
 *  - on their own: the Octopus tariff's unit rate, read by Wren each Friday,
 *    and a passport renewal you check by hand ("Just me"), approved yesterday.
 *
 * `sampleTrackersFail(true)` makes the next loads fail, for the panel's
 * "Tracking didn't load" (review shots only).
 */
import { TRACKER_LIMITS, type Tracker, type TrackerChecker, type TrackerInput, type TrackerPoint, type TrackerPointInput, type TrackerTarget, type TrackerView } from "../../../lib/tracker-types";
import type { SavedItem } from "../../../lib/saved-rules";
import { SAMPLE_TEAM_IDS } from "./sample-team";
import { cleanNumber, currencyAffix, readTracker, sourceOf, summaryOf } from "../lib/tracker-words";

const LEGO = "https://www.lego.com/en-gb/product/ferrari-daytona-sp3-42143";
const AESOP = "https://www.boots.com/aesop-resurrection-aromatique-hand-balm-75ml";
const MOLESKINE = "https://www.waterstones.com/book/moleskine-2027-weekly-diary";
const KINDLE = "https://www.amazon.co.uk/dp/B0CFPJYX7P";
const DRESS = "https://marlowandfinch.example/products/sage-linen-wrap-dress";
const JOHN_LEWIS_LEGO = "https://www.johnlewis.com/lego-technic-42143-ferrari-daytona-sp3";
const SMYTHS = "https://www.smyths.co.uk/uk/en-gb/toys/lego/lego-technic/42143";
const ARGOS = "https://www.argos.co.uk/product/1325411";
const OCTOPUS = "https://octopus.energy/smart/tracker/";
const PASSPORT = "https://www.gov.uk/track-passport-application";

/** The gift ideas, as Saved seeds (db/sample-saved.ts Seed): appended after its own, so no other sample id moves. */
export const PRICED_SEEDS = [
  {
    id: "s-lego", days: 40, time: "20:14", kind: "link" as const, source: "share-target" as const,
    url: LEGO, title: "LEGO Technic Ferrari Daytona SP3", site: "LEGO", fetch_status: "preview" as const,
    excerpt: "A 1:8 replica with a working gearbox and butterfly doors.", note: "Rowan's birthday?",
    thing: "product" as const, facts: { name: "LEGO Technic Ferrari Daytona SP3", price: "42", currency: "GBP", shop: "LEGO" },
  },
  {
    id: "s-aesop", days: 0, time: "01:35", kind: "link" as const, source: "extension" as const,
    url: AESOP, title: "Aesop Resurrection Aromatique Hand Balm 75ml", site: "Boots", fetch_status: "preview" as const,
    thing: "product" as const, facts: { name: "Aesop hand balm", price: "31", currency: "GBP", shop: "Boots" },
  },
  {
    id: "s-moleskine", days: 9, time: "19:32", kind: "link" as const, source: "share-target" as const,
    url: MOLESKINE, title: "Moleskine 2027 Weekly Diary, Large, Black", site: "Waterstones", fetch_status: "preview" as const,
    thing: "product" as const, facts: { name: "Moleskine 2027 diary", price: "18", currency: "GBP", shop: "Waterstones" },
  },
  {
    id: "s-kettle", days: 3, time: "21:48", kind: "link" as const, source: "share-target" as const,
    url: "https://fellowproducts.com/products/stagg-ekg-electric-pour-over-kettle", title: "Stagg EKG Electric Pour-Over Kettle", site: "Fellow", fetch_status: "preview" as const,
    excerpt: "A variable-temperature kettle with a precision pour spout.",
    thing: "product" as const, facts: { name: "Fellow Stagg EKG kettle", shop: "Fellow" },
  },
  {
    id: "s-kindle", days: 1, time: "18:05", kind: "link" as const, source: "share-target" as const,
    url: KINDLE, title: "Kindle Paperwhite (16 GB)", site: "Amazon", fetch_status: "preview" as const,
    thing: "product" as const, facts: { name: "Kindle Paperwhite", price: "159.99", currency: "GBP", shop: "Amazon" },
  },
];

/** [days back, hour (-1: 42 minutes ago), value, source, link, who]. */
type Check = [daysBack: number, hour: number, value: string, source: string | null, url: string | null, by: TrackerChecker];
const M: TrackerChecker = "assistant";

interface Seed {
  key: string;
  /** The saved item's link, for one on an item. */
  item?: string;
  tracker: Partial<Tracker> & Pick<Tracker, "label" | "kind" | "direction" | "preset">;
  /** Checks after the save, oldest first. */
  checks: Check[];
  target?: { op: TrackerTarget["op"]; value: string; daysBack: number };
  /** Its standalone created day, back from today. */
  createdDaysBack?: number;
}

const SEEDS: Seed[] = [
  {
    key: "lego-price", item: LEGO, tracker: { label: "price", kind: "number", direction: "lower", preset: "price", assistant_id: SAMPLE_TEAM_IDS.moss },
    checks: [
      [36, 8, "42", "LEGO", LEGO, M],
      [31, 8, "39.99", "John Lewis", JOHN_LEWIS_LEGO, M],
      [27, 8, "42", "LEGO", LEGO, M],
      [23, 8, "37.50", "Argos", ARGOS, M],
      [19, 12, "39.99", "John Lewis", JOHN_LEWIS_LEGO, "ask"],
      [15, 8, "36", "Smyths", SMYTHS, M],
      [12, 8, "38", "Smyths", SMYTHS, M],
      [8, 21, "35.99", "Argos", ARGOS, "owner"],
      [5, 8, "36", "Smyths", SMYTHS, M],
      [2, 8, "35", "Smyths", SMYTHS, M],
      [0, -1, "34", "Smyths", SMYTHS, M],
    ],
    target: { op: "lte", value: "30", daysBack: 6 },
  },
  {
    key: "lego-stock", item: LEGO, tracker: { label: "stock", kind: "state", direction: "change", preset: "stock", states: ["in stock", "sold out"], assistant_id: SAMPLE_TEAM_IDS.moss, url: JOHN_LEWIS_LEGO },
    checks: [
      [20, 8, "sold out", "John Lewis", JOHN_LEWIS_LEGO, M],
      [16, 8, "sold out", "John Lewis", JOHN_LEWIS_LEGO, M],
      [12, 8, "sold out", "John Lewis", JOHN_LEWIS_LEGO, M],
      [9, 8, "sold out", "John Lewis", JOHN_LEWIS_LEGO, M],
      [6, 8, "in stock", "John Lewis", JOHN_LEWIS_LEGO, M],
      [3, 8, "in stock", "John Lewis", JOHN_LEWIS_LEGO, M],
      [0, -1, "in stock", "John Lewis", JOHN_LEWIS_LEGO, M],
    ],
  },
  {
    key: "aesop-price", item: AESOP, tracker: { label: "price", kind: "number", direction: "lower", preset: "price", assistant_id: SAMPLE_TEAM_IDS.moss },
    checks: [[0, -1, "27", "John Lewis", "https://www.johnlewis.com/aesop-resurrection-aromatique-hand-balm-75ml", M]],
    target: { op: "lte", value: "28", daysBack: 0 },
  },
  {
    key: "moleskine-price", item: MOLESKINE, tracker: { label: "price", kind: "number", direction: "lower", preset: "price", assistant_id: SAMPLE_TEAM_IDS.moss },
    checks: [
      [8, 8, "18", "Waterstones", MOLESKINE, M],
      [3, 10, "15", "WHSmith", "https://www.whsmith.co.uk/products/moleskine-2027-weekly-diary-large-black", M],
      [1, 19, "18", "Waterstones", MOLESKINE, M],
    ],
    // Reached at another shop: Waterstones checked last, WHSmith's £15 meets the £16.
    target: { op: "lte", value: "16", daysBack: 4 },
  },
  { key: "kindle-price", item: KINDLE, tracker: { label: "price", kind: "number", direction: "lower", preset: "price", assistant_id: SAMPLE_TEAM_IDS.moss }, checks: [] },
  { key: "dress-price", item: DRESS, tracker: { label: "price", kind: "number", direction: "lower", preset: "price" }, checks: [[0, -1, "85", "Marlow & Finch", DRESS, "ask"]] },
  {
    key: "octopus", createdDaysBack: 59,
    tracker: { name: "Octopus tariff", url: OCTOPUS, label: "unit rate", kind: "number", suffix: "p/kWh", direction: "lower", preset: null, assistant_id: SAMPLE_TEAM_IDS.wren },
    checks: [
      [59, 17, "24.50", "Octopus Energy", OCTOPUS, M],
      [52, 17, "24.50", "Octopus Energy", OCTOPUS, M],
      [45, 17, "24.86", "Octopus Energy", OCTOPUS, M],
      [38, 17, "25.10", "Octopus Energy", OCTOPUS, M],
      [31, 17, "24.12", "Octopus Energy", OCTOPUS, M],
      [24, 17, "23.70", "Octopus Energy", OCTOPUS, M],
      [17, 17, "23.94", "Octopus Energy", OCTOPUS, M],
      [10, 17, "22.86", "Octopus Energy", OCTOPUS, M],
      [3, 17, "23.18", "Octopus Energy", OCTOPUS, M],
    ],
    target: { op: "lte", value: "22", daysBack: 30 },
  },
  {
    key: "passport", createdDaysBack: 23,
    tracker: { name: "Passport renewal", url: PASSPORT, label: "status", kind: "state", states: ["approved", "being checked", "received"], direction: "change", preset: null, assistant_set_by: "owner" },
    checks: [
      [23, 9, "received", null, PASSPORT, "owner"],
      [16, 9, "being checked", null, PASSPORT, "owner"],
      [9, 20, "being checked", null, PASSPORT, "owner"],
      [1, 12, "approved", null, PASSPORT, "owner"],
    ],
    target: { op: "eq", value: "approved", daysBack: 16 },
  },
];

const WHO: Record<string, string> = { [SAMPLE_TEAM_IDS.moss]: "Moss", [SAMPLE_TEAM_IDS.dot]: "Dot", [SAMPLE_TEAM_IDS.wren]: "Wren" };

/** A day back at an hour, local; hour -1 is "42 minutes ago" (today's live check). */
function at(daysBack: number, hour: number): string {
  if (hour < 0) return new Date(Date.now() - 42 * 60_000).toISOString();
  const d = new Date();
  d.setDate(d.getDate() - daysBack);
  d.setHours(hour, 10, 0, 0);
  return d.toISOString();
}

const trackers = new Map<string, Tracker>();
const points = new Map<string, TrackerPoint[]>();
const removed = new Set<string>();
let seeded = false;
let seq = 0;

function emptyTracker(over: Partial<Tracker>): Tracker {
  return {
    id: `trk-${++seq}`,
    saved_id: null,
    name: "",
    url: null,
    label: "",
    kind: "number",
    prefix: "",
    suffix: "",
    currency: null,
    states: [],
    direction: "change",
    preset: null,
    target: null,
    assistant_id: null,
    assistant_set_by: null,
    created_at: new Date().toISOString(),
    ...over,
  };
}

/** A tracker's first point when it's a saved item's price: what it cost when it was saved. */
function savePoint(t: Tracker, item: SavedItem): TrackerPoint | null {
  const f = item.facts;
  if (t.preset !== "price" || !f?.price || !f.currency) return null;
  return { id: `${t.id}:save`, tracker_id: t.id, value: f.price, source: f.shop ?? item.site ?? null, url: item.url ?? null, checked_at: item.saved_at, checked_by: "save", assistant_id: null };
}

/** Fill in the sample's trackers from Saved's sample items (db/sample-saved.ts calls this once its items exist). */
export function seedSampleTrackers(items: SavedItem[]): void {
  if (seeded) return;
  seeded = true;
  for (const s of SEEDS) {
    const item = s.item ? items.find((i) => i.url === s.item) : null;
    if (s.item && !item) continue;
    const created = item ? item.saved_at : at(s.createdDaysBack ?? 0, 9);
    const money = s.tracker.preset === "price" && item?.facts?.currency ? { currency: item.facts.currency, ...currencyAffix(item.facts.currency) } : {};
    const t = emptyTracker({
      ...s.tracker,
      ...money,
      id: `trk-${s.key}`,
      saved_id: item?.id ?? null,
      name: item ? (item.title ?? "") : (s.tracker.name ?? ""),
      url: s.tracker.url ?? item?.url ?? null,
      // Given to an assistant by someone; the passport is the owner's own "Just me".
      assistant_set_by: s.tracker.assistant_set_by ?? (s.tracker.assistant_id ? "owner" : null),
      created_at: created,
    });
    if (s.target) t.target = { op: s.target.op, value: s.target.value, set_by: "owner", assistant_id: null, set_at: at(s.target.daysBack, 9) };
    const list: TrackerPoint[] = [];
    const first = item ? savePoint(t, item) : null;
    if (first) list.push(first);
    s.checks.forEach(([days, hour, value, source, url, by], i) => {
      const checked_at = at(days, hour);
      if (Date.parse(checked_at) < Date.parse(created)) return;
      const assistant_id = by === "assistant" ? t.assistant_id : null;
      list.push({ id: `${t.id}:${i}`, tracker_id: t.id, value, source, url, checked_at, checked_by: by, assistant_id, ...(assistant_id ? { who: WHO[assistant_id] } : {}) });
    });
    trackers.set(t.id, t);
    points.set(t.id, list);
  }
}

async function ensure(): Promise<void> {
  if (seeded) return;
  const { sampleSavedPage } = await import("./sample-saved");
  sampleSavedPage({});
}

function view(t: Tracker): TrackerView {
  const pts = (points.get(t.id) ?? []).filter((p) => !removed.has(p.id)).sort((a, b) => Date.parse(a.checked_at) - Date.parse(b.checked_at));
  const v: TrackerView = { ...t, target: t.target ? { ...t.target } : null, states: [...t.states], points: pts, summary: null };
  v.summary = summaryOf(v);
  return v;
}

const order = (a: Tracker, b: Tracker) => a.created_at.localeCompare(b.created_at);

let failing = false;
/** Review shots only: make loads fail ("Tracking didn't load"), or work again. */
export function sampleTrackersFail(on: boolean): void {
  failing = on;
}

/** GET /api/trackers. */
export async function sampleListTrackers(q: { saved_id?: string; standalone?: boolean }): Promise<TrackerView[]> {
  await ensure();
  if (failing) throw new Error("Couldn't reach Athena");
  return [...trackers.values()]
    .filter((t) => (q.saved_id ? t.saved_id === q.saved_id : q.standalone ? t.saved_id === null : true))
    .sort(order)
    .map(view);
}

/** POST /api/trackers. */
export async function sampleCreateTracker(input: TrackerInput, item: SavedItem | null): Promise<TrackerView> {
  await ensure();
  const mine = [...trackers.values()].filter((t) => (item ? t.saved_id === item.id : t.saved_id === null));
  if (mine.length >= (item ? TRACKER_LIMITS.perItem : TRACKER_LIMITS.standalone)) throw new Error("limit: that's as many as one thing can have");
  let base: Partial<Tracker>;
  if (input.preset === "price") {
    const currency = input.currency ?? item?.facts?.currency ?? "GBP";
    base = { label: "price", kind: "number", direction: "lower", preset: "price", currency, ...currencyAffix(currency) };
  } else if (input.preset === "stock") base = { label: "stock", kind: "state", direction: "change", preset: "stock", states: ["in stock", "sold out"] };
  else {
    if (!input.label || !input.kind) throw new Error("label: what it is, like followers");
    base = { label: input.label, kind: input.kind, prefix: input.prefix ?? "", suffix: input.suffix ?? "", currency: input.currency ?? null, states: input.kind === "state" ? (input.states ?? []) : [], direction: input.kind === "state" ? "change" : (input.direction ?? "change"), preset: null };
  }
  const t = emptyTracker({ ...base, saved_id: item?.id ?? null, name: item ? (item.title ?? "") : (input.name ?? "").trim(), url: input.url ?? item?.url ?? null, assistant_id: input.assistant_id ?? null, assistant_set_by: input.assistant_id !== undefined ? "owner" : null });
  if (input.target) t.target = { ...input.target, set_by: "owner", assistant_id: null, set_at: new Date().toISOString() };
  trackers.set(t.id, t);
  const first = item ? savePoint(t, item) : null;
  points.set(t.id, first ? [first] : []);
  return view(t);
}

/** PATCH /api/trackers/<id>. */
export async function samplePatchTracker(id: string, patch: TrackerInput): Promise<TrackerView> {
  await ensure();
  const t = trackers.get(id);
  if (!t) throw new Error("That isn't tracked any more");
  if (patch.target !== undefined) t.target = patch.target ? { op: patch.target.op, value: patch.target.value, set_by: "owner", assistant_id: null, set_at: new Date().toISOString() } : null;
  if (patch.name !== undefined) t.name = patch.name.trim() || t.name;
  if (patch.url !== undefined) t.url = patch.url;
  if (patch.label !== undefined) t.label = patch.label;
  if (patch.assistant_id !== undefined) {
    t.assistant_id = patch.assistant_id;
    t.assistant_set_by = "owner";
  }
  return view(t);
}

const stopped = new Map<string, { t: Tracker; p: TrackerPoint[] }>();

/** DELETE /api/trackers/<id>: kept aside, so Undo can restore it. */
export async function sampleDeleteTracker(id: string): Promise<void> {
  const t = trackers.get(id);
  if (t) stopped.set(id, { t, p: points.get(id) ?? [] });
  trackers.delete(id);
  points.delete(id);
}

/** POST /api/trackers/<id>/restore. */
export async function sampleRestoreTracker(id: string): Promise<void> {
  const was = stopped.get(id);
  if (!was) return;
  trackers.set(id, was.t);
  points.set(id, was.p);
  stopped.delete(id);
}

/** POST /api/trackers/<id>/points: the owner's own check. */
export async function sampleAddPoint(id: string, input: TrackerPointInput): Promise<TrackerPoint> {
  await ensure();
  const t = trackers.get(id);
  if (!t) throw new Error("That isn't tracked any more");
  const value = t.kind === "number" ? cleanNumber(input.value) : input.value.trim().toLowerCase();
  if (t.kind === "state" && !t.states.includes(value)) throw new Error("value: one of its states");
  const p: TrackerPoint = { id: `${id}:own:${Date.now()}`, tracker_id: id, value, source: input.source?.trim() || null, url: input.url ?? null, checked_at: input.checked_at ?? new Date().toISOString(), checked_by: "owner", assistant_id: null };
  points.set(id, [...(points.get(id) ?? []), p]);
  return p;
}

/** DELETE /api/trackers/<id>/points/<pointId>, and its restore (Undo). */
export function sampleRemovePoint(pointId: string): void {
  removed.add(pointId);
}
export function sampleRestorePoint(pointId: string): void {
  removed.delete(pointId);
}

/** A list's items with the best price now, as the server's listSaved gives it: only with a check since the save. */
export function withSamplePricesNow<T extends SavedItem>(items: T[]): T[] {
  return items.map((i) => {
    const t = [...trackers.values()].find((x) => x.saved_id === i.id && x.preset === "price");
    if (!t) return i;
    const r = readTracker(view(t));
    if (!r || !r.points.some((p) => p.checked_by !== "save")) return i;
    const now: NonNullable<SavedItem["price_now"]> = { amount: r.now.value, currency: t.currency ?? "GBP", shop: sourceOf(r.now) };
    return { ...i, price_now: now };
  });
}

// ---------- Ask, in sample mode ----------

/** "Has the Lego ever been cheaper?", "which gift ideas have dropped in price?": sample mode answers these from the checks above. */
export const isPriceHistoryQuestion = (question: string): boolean => /\b(cheaper|price history|prices? (?:moved|changed|dropped)|dropped in price|ever been (?:cheap|less))\b/i.test(question);

export const SAMPLE_PRICE_QUESTION = "Which gift ideas have dropped in price?";

/** The answer sample mode gives: the figures from the checks above, cited, so the reply's cards match its words. */
export async function samplePriceAnswer(): Promise<import("../../../lib/answer-text").AnswerReply> {
  await ensure();
  const { sampleSavedPage } = await import("./sample-saved");
  const { readTracker: read, trackerSentence, valueWords, toUnits } = await import("../lib/tracker-words");
  const items = sampleSavedPage({}).items.filter((i) => i.thing === "product" && i.url !== DRESS);
  const rows = items
    .map((item) => {
      const t = [...trackers.values()].find((x) => x.saved_id === item.id && x.preset === "price");
      const r = t ? read(view(t)) : null;
      return r && r.saved ? { item, r, d: toUnits(r.now.value, r.scale) - toUnits(r.saved.value, r.scale) } : null;
    })
    .filter((x): x is NonNullable<typeof x> => !!x && x.r.points.length > 1);
  const dropped = rows.filter((x) => x.d < 0).sort((a, b) => a.d - b.d);
  const same = rows.filter((x) => x.d === 0);
  const name = (x: (typeof rows)[number]) => x.item.facts?.name ?? x.item.title ?? "It";
  const lines = dropped.map((x, i) => {
    const t = x.r.tracker;
    const low = x.r.target === "reached" && t.target ? `, under the ${valueWords(t, t.target.value)} you asked for` : x.r.best && toUnits(x.r.best.value, x.r.scale) === toUnits(x.r.now.value, x.r.scale) ? ", its lowest yet" : "";
    return `The **${name(x)}** is ${trackerSentence(x.r).lead}${low}, down from ${valueWords(t, x.r.saved!.value)} at ${sourceOf(x.r.saved!) ?? "the shop"} when you saved it [${i + 1}].`;
  });
  const still = same.length ? ` The ${same.map(name).join(" and ")} ${same.length === 1 ? "is" : "are"} still ${same.map((x) => valueWords(x.r.tracker, x.r.now.value)).join(" and ")}.` : "";
  return {
    text: `${dropped.length === 1 ? "One has" : `${dropped.length === 2 ? "Two" : dropped.length} have`}. ${lines.join(" ")}${still}`,
    sources: dropped.map((x, i) => ({ n: i + 1, kind: "saved" as const, id: x.item.id, url: null, title: name(x), date: x.item.saved_on, account: null })),
    related: [],
    searched: "Searched what you track",
    skipped: [],
    found: true,
    flagged: false,
    next: ["Has the Ferrari ever been cheaper?", "Tell me when one drops again"],
  };
}
