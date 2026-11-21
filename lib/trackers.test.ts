// Tracking's pure rules (lib/trackers.ts): honest values, presets, the summary, news, targets and the words.
// Run: npx tsx --test lib/trackers.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  checkDetail,
  cleanNumber,
  cleanTarget,
  cleanValue,
  compareNumbers,
  isNews,
  newsFor,
  planTracker,
  priceNowOf,
  subtractNumbers,
  summarise,
  targetWords,
  trackerDetail,
  trackerFacts,
  trackerPromptLine,
  trackerSentence,
  trackerView,
  TrackerInputError,
  valueWords,
  assistantsFor,
  newsLine,
  type Tracker,
  type TrackerPoint,
} from "./trackers";

const NOW = new Date("2026-11-16T12:00:00Z");
const ITEM = { id: "5a3e0000-0000-4000-8000-000000000001", name: "LEGO Technic Ferrari", url: "https://www.lego.com/ferrari", currency: "GBP" };

const tracker = (t: Partial<Tracker> & Pick<Tracker, "kind" | "direction" | "label">): Tracker => ({
  id: "t1",
  saved_id: null,
  name: "Thing",
  url: null,
  prefix: "",
  suffix: "",
  currency: null,
  states: [],
  preset: null,
  target: null,
  assistant_id: null,
  created_at: "2026-10-01T00:00:00Z",
  ...t,
});
const PRICE = tracker({ ...planTracker({ saved_id: ITEM.id, preset: "price" }, ITEM), name: ITEM.name });
const STOCK = tracker({ ...planTracker({ saved_id: ITEM.id, preset: "stock" }, ITEM), name: ITEM.name });
const FOLLOWERS = tracker(planTracker({ name: "My channel", url: "https://www.youtube.com/@me", label: "Followers", kind: "number", direction: "higher" }, null));

let n = 0;
const point = (value: string, day: string, extra: Partial<TrackerPoint> = {}): TrackerPoint => ({
  id: `p${++n}`,
  tracker_id: "t1",
  value,
  source: null,
  url: "https://example.com/page",
  checked_at: `2026-${day}T09:00:00Z`,
  checked_by: "ask",
  assistant_id: null,
  ...extra,
});

test("honest numbers: digits as the page wrote them, never a guess", () => {
  assert.equal(cleanNumber("34.99", { money: true }), "34.99");
  assert.equal(cleanNumber("1,299.00", { money: true }), "1299.00");
  assert.equal(cleanNumber("12,400"), "12400");
  assert.equal(cleanNumber("-3.5"), "-3.5");
  assert.equal(cleanNumber("007"), "7");
  assert.equal(cleanNumber(34.5, { money: true }), "34.5");
  for (const bad of ["about 35", "30-40", "£34", "1.2k", "", "34.999"]) assert.throws(() => cleanNumber(bad, { money: true }), TrackerInputError, bad);
  assert.throws(() => cleanNumber("-3", { money: true }), TrackerInputError, "a price is never negative");
  assert.equal(compareNumbers("34.5", "34.50"), 0);
  assert.equal(compareNumbers("9", "10"), -1);
  assert.equal(subtractNumbers("34", "42"), "-8");
  assert.equal(subtractNumbers("36.5", "32"), "4.5");
});

test("presets fill themselves in; a described tracker needs its label, kind and direction", () => {
  assert.deepEqual(
    { label: PRICE.label, kind: PRICE.kind, prefix: PRICE.prefix, currency: PRICE.currency, direction: PRICE.direction, url: PRICE.url, saved_id: PRICE.saved_id, name: planTracker({ saved_id: ITEM.id, preset: "price" }, ITEM).name },
    { label: "price", kind: "number", prefix: "£", currency: "GBP", direction: "lower", url: ITEM.url, saved_id: ITEM.id, name: "" },
  );
  assert.equal(planTracker({ saved_id: ITEM.id, preset: "price", currency: "sek" }, ITEM).suffix, " SEK");
  assert.deepEqual([STOCK.kind, STOCK.states, STOCK.direction], ["state", ["in stock", "sold out"], "change"]);
  assert.deepEqual([FOLLOWERS.label, FOLLOWERS.direction, FOLLOWERS.name, FOLLOWERS.saved_id], ["followers", "higher", "My channel", null]);
  assert.throws(() => planTracker({ saved_id: ITEM.id, preset: "price" }, { ...ITEM, currency: null }), /currency/);
  assert.throws(() => planTracker({ label: "followers", kind: "number", direction: "higher" }, null), /name/, "on its own it needs a name");
  assert.throws(() => planTracker({ name: "X", label: "followers", kind: "number" }, null), /direction/);
  assert.throws(() => planTracker({ name: "X", label: "queue", kind: "state", states: ["open"] }, null), /states/);
  assert.throws(() => planTracker({ name: "X", label: "rate", kind: "number", direction: "lower", suffix: "p2" }, null), /suffix/);
  assert.throws(() => planTracker({ saved_id: ITEM.id, preset: "price" }, null), /isn't there/);
});

test("values and targets: a state is one of its states; the target's op comes from the tracker", () => {
  assert.equal(cleanValue(STOCK, "In Stock"), "in stock");
  assert.throws(() => cleanValue(STOCK, "available"), /"in stock", "sold out"/);
  assert.deepEqual(cleanTarget(PRICE, { value: "30" }), { op: "lte", value: "30" });
  assert.deepEqual(cleanTarget(STOCK, {}), { op: "eq", value: "in stock" });
  assert.deepEqual(cleanTarget(FOLLOWERS, { value: "10,000" }), { op: "gte", value: "10000" });
  assert.deepEqual(cleanTarget(FOLLOWERS, { op: "change" }), { op: "change", value: "" });
  assert.throws(() => cleanTarget(STOCK, { op: "lte", value: "in stock" }), /state's target/);
  assert.equal(targetWords(PRICE, { op: "lte", value: "30" }), "£30 or less");
  assert.equal(targetWords(FOLLOWERS, { op: "gte", value: "10000" }), "10,000 followers or more");
  assert.equal(targetWords(STOCK, { op: "eq", value: "in stock" }), "when it's in stock");
});

test("words: the page's digits with the prefix or suffix, never rounded", () => {
  assert.equal(valueWords(PRICE, "34.5"), "£34.50");
  assert.equal(valueWords(PRICE, "1299"), "£1,299");
  assert.equal(valueWords(FOLLOWERS, "12400"), "12,400 followers");
  assert.equal(valueWords(tracker({ kind: "number", direction: "change", label: "rate", suffix: "p a kWh" }), "24.5"), "24.5p a kWh");
  assert.equal(valueWords(STOCK, "in stock"), "in stock");
});

test("a price: saved at £42, cheaper at Smyths, a stale shop doesn't count as now", () => {
  const points = [
    point("42", "10-07", { checked_by: "save", source: "LEGO" }),
    point("29", "10-10", { source: "Argos" }),
    point("36", "11-10", { source: "Smyths" }),
    point("34", "11-14", { source: "Smyths" }),
  ];
  const s = summarise(PRICE, points, { now: NOW })!;
  assert.equal(s.now.value, "34", "Argos was checked more than 14 days before the newest");
  assert.equal(s.best!.value, "29");
  assert.equal(s.first.checked_by, "save");
  assert.equal(s.fresh, true);
  assert.equal(s.checks, 4);
  assert.equal(s.sources, 3);
  const view = trackerView(PRICE, points, { now: NOW });
  assert.equal(trackerSentence(view, { tz: "Europe/London", now: NOW })!.text, "£34 at Smyths, £8 under the saved price. The lowest was £29 on 10 Oct.");
  assert.equal(trackerDetail(view, { tz: "Europe/London", now: NOW }), "Saved at £42 on 7 Oct · 4 checks at 3 shops");
  assert.deepEqual(priceNowOf(PRICE, points), { amount: "34", currency: "GBP", shop: "Smyths" });
  assert.equal(priceNowOf(PRICE, [points[0]]), null, "only the saved price: the list keeps it");
  // The lowest since it was saved.
  const low = trackerView(PRICE, [points[0], point("34", "11-14", { source: "Smyths" })], { now: NOW });
  assert.equal(trackerSentence(low, { now: NOW })!.text, "£34 at Smyths, the lowest since you saved it.");
  assert.equal(trackerSentence(trackerView(PRICE, [points[0]]), { now: NOW })!.text, "£42 at LEGO, the price when you saved it.");
  const dearer = trackerView(PRICE, [points[0], point("45", "11-14", { source: "LEGO" })], { now: NOW });
  assert.equal(trackerSentence(dearer, { now: NOW })!.text, "£45 at LEGO, £3 more than when you saved it.");
});

test("a price target: set, and reached by the best price now; the lowest moves to the quieter line", () => {
  const t = { ...PRICE, target: { op: "lte" as const, value: "30", set_by: "owner" as const, assistant_id: null, set_at: "2026-11-01T00:00:00Z" } };
  const set = trackerView(t, [point("42", "10-07", { checked_by: "save", source: "LEGO" }), point("29", "10-25", { source: "Argos" }), point("34", "11-14", { source: "Smyths" })], { now: NOW });
  assert.equal(set.summary!.target_reached, false);
  assert.equal(trackerSentence(set, { now: NOW })!.text, "£34 at Smyths. You asked to hear at £30 or less.");
  assert.equal(trackerDetail(set, { now: NOW }), "Lowest £29 on 25 Oct · Saved at £42 on 7 Oct · 3 checks at 3 shops");
  const reached = trackerView(t, [...set.points, point("27", "11-15", { source: "John Lewis" })], { now: NOW });
  assert.equal(reached.summary!.target_reached, true);
  assert.equal(trackerSentence(reached, { now: NOW })!.text, "£27 at John Lewis, under the £30 you asked for.");
});

test("stock: a state; any change is news, and its target is being in stock", () => {
  const before = [point("sold out", "11-01", { source: "Smyths" })];
  const back = point("in stock", "11-12", { source: "Smyths" });
  const news = newsFor(STOCK, before, back);
  assert.deepEqual(news, { best: false, changed: true, target_reached: false });
  assert.equal(isNews(STOCK, news), true);
  assert.equal(isNews(STOCK, newsFor(STOCK, [back], point("in stock", "11-13"))), false, "the same state again is only kept");
  assert.equal(checkDetail(STOCK, back, news, "sold out"), "Stock checked · In stock at Smyths · Was sold out");
  const view = trackerView(STOCK, [...before, back], { now: NOW });
  assert.equal(view.summary!.best, null);
  assert.equal(view.summary!.changed_at, back.checked_at);
  assert.equal(trackerSentence(view, { now: NOW })!.text, "In stock at Smyths, since 12 Nov. It was sold out before.");
  const waiting = { ...STOCK, target: { op: "eq" as const, value: "in stock", set_by: "owner" as const, assistant_id: null, set_at: "2026-11-01T00:00:00Z" } };
  assert.equal(newsFor(waiting, before, back).target_reached, true);
  assert.equal(trackerSentence(trackerView(waiting, before, { now: NOW }), { now: NOW })!.text, "Sold out at Smyths. You asked to hear when it's in stock.");
  assert.equal(trackerSentence(trackerView(waiting, [...before, back], { now: NOW }), { now: NOW })!.text, "In stock at Smyths. You asked to hear when it was.");
});

test("followers, higher is better: a new high is news, a dip is only kept; a target at or over", () => {
  const pts = [point("11900", "11-01", { source: "YouTube" }), point("12400", "11-08", { source: "YouTube" })];
  const high = newsFor(FOLLOWERS, pts, { value: "12500" });
  assert.deepEqual(high, { best: true, changed: true, target_reached: false });
  assert.equal(isNews(FOLLOWERS, high), true);
  const dip = newsFor(FOLLOWERS, pts, { value: "12300" });
  assert.equal(isNews(FOLLOWERS, dip), false);
  assert.equal(checkDetail(FOLLOWERS, { value: "12500", source: "YouTube", url: null }, high, "12400"), "Checked · 12,500 followers at YouTube · Highest yet");
  const view = trackerView(FOLLOWERS, pts, { now: NOW });
  assert.equal(trackerSentence(view, { now: NOW })!.text, "12,400 followers at YouTube, the highest so far.");
  const after = trackerView(FOLLOWERS, [...pts, point("12300", "11-14", { source: "YouTube" })], { now: NOW });
  assert.equal(trackerSentence(after, { now: NOW })!.text, "12,300 followers at YouTube. The highest was 12,400 followers on 8 Nov.");
  const goal = { ...FOLLOWERS, target: { op: "gte" as const, value: "12500", set_by: "ask" as const, assistant_id: null, set_at: "2026-11-01T00:00:00Z" } };
  assert.equal(newsFor(goal, pts, { value: "12500" }).target_reached, true);
  assert.equal(trackerSentence(trackerView(goal, pts), { now: NOW })!.text, "12,400 followers at YouTube. You asked to hear at 12,500 followers or more.");
});

test("a number followed for any change: up or down is news", () => {
  const rate = tracker({ kind: "number", direction: "change", label: "rate", suffix: "p a kWh", name: "Octopus tariff" });
  const pts = [point("23", "11-01", { source: null, url: null }), point("24.5", "11-03", { source: null, url: null })];
  assert.equal(isNews(rate, newsFor(rate, pts, { value: "24" })), true);
  assert.equal(isNews(rate, newsFor(rate, pts, { value: "24.5" })), false);
  assert.equal(trackerSentence(trackerView(rate, pts), { now: NOW })!.text, "24.5p a kWh, up from 23p a kWh on 1 Nov.");
  assert.equal(trackerSentence(trackerView(rate, [pts[0], point("23", "11-05")]), { now: NOW })!.text, "23p a kWh at example.com, the same since 1 Nov.");
});

test("what the model reads, and the run's prompt line", () => {
  const pts = [point("42", "10-07", { checked_by: "save", source: "LEGO" }), point("34", "11-14", { source: "Smyths", checked_by: "assistant", who: "Moss", assistant_id: "a1" })];
  const t = { ...PRICE, id: "t9", target: { op: "lte" as const, value: "30", set_by: "owner" as const, assistant_id: null, set_at: "2026-11-01T00:00:00Z" } };
  const facts = trackerFacts(trackerView(t, pts, { now: NOW }), { now: NOW, tz: "Europe/London" }) as unknown as { tracker_id: string; better: string; target: unknown; now: { value: string }; points: Array<{ by: string }> };
  assert.equal(facts.tracker_id, "t9");
  assert.equal(facts.better, "lower is better");
  assert.deepEqual(facts.target, { wants: "£30 or less", op: "lte", value: "30", reached: false });
  assert.equal(facts.now.value, "£34");
  assert.equal(facts.points.at(-1)!.by, "Moss");
  assert.equal(trackerPromptLine(trackerView(t, pts), { now: NOW, tz: "Europe/London" }), "Price: last £34 at Smyths on 14 Nov; lowest £34 (14 Nov); saved at £42; you want to hear at £30 or less.");
  assert.equal(trackerPromptLine(trackerView({ ...STOCK, id: "s" }, [])), "Stock: no checks yet.");
});

test("several sources: a target is reached while any source's current value meets it, and says which", () => {
  const t = { ...PRICE, target: { op: "lte" as const, value: "30", set_by: "owner" as const, assistant_id: null, set_at: "2026-11-01T00:00:00Z" } };
  const argos = point("29", "11-05", { source: "Argos" });
  const smyths = point("34", "11-14", { source: "Smyths" });
  const view = trackerView(t, [point("42", "10-07", { checked_by: "save", source: "LEGO" }), argos, smyths], { now: NOW });
  assert.equal(view.summary!.target_reached, true, "a dearer check at another shop doesn't clear it");
  assert.equal(view.summary!.reached_by!.id, argos.id);
  assert.equal(trackerSentence(view, { now: NOW })!.text, "£29 at Argos, under the £30 you asked for.");
  // Once Argos's check is more than 14 days older than the newest, it isn't current: not reached.
  const later = trackerView(t, [...view.points, point("34", "11-25", { source: "Smyths" })], { now: NOW });
  assert.equal(later.summary!.target_reached, false);
  assert.equal(later.summary!.reached_by, null);
  // Stock: in stock at one shop while sold out at another is reached.
  const waiting = { ...STOCK, target: { op: "eq" as const, value: "in stock", set_by: "owner" as const, assistant_id: null, set_at: "2026-11-01T00:00:00Z" } };
  const jl = point("in stock", "11-10", { source: "John Lewis" });
  const stock = trackerView(waiting, [jl, point("sold out", "11-12", { source: "Smyths" })], { now: NOW });
  assert.equal(stock.summary!.reached_by!.id, jl.id);
  // A check kept that meets it is told with its own source.
  const n = newsFor(t, [argos], smyths);
  assert.equal(n.target_reached, false, "the dearer check itself doesn't meet it");
  const under = point("28", "11-15", { source: "Boots" });
  const told = trackerView(t, [argos, smyths, under], { now: NOW });
  assert.equal(newsLine(told, under, newsFor(t, [argos, smyths], under)), "£28 at Boots, under the £30 you asked for.");
});

test("who checks: assistants that fit a tracker, best first", () => {
  const a = (name: string, job: string, more: Partial<{ web: boolean; paused: boolean; instructions: string }> = {}) => ({ id: name, name, job, web: true, paused: false, ...more });
  const team = [a("Moss", "Finds good prices for gift ideas"), a("Wren", "Keeps an eye on my channel's followers"), a("Pip", "Checks prices", { web: false }), a("Dot", "Watches deals", { paused: true }), a("Kit", "Plans meals", { instructions: "Look for cheaper prices on ingredients" })];
  assert.deepEqual(assistantsFor(PRICE, team).map((x) => x.name), ["Moss", "Kit"], "web on and not paused; a job match ranks above instructions");
  assert.deepEqual(assistantsFor(FOLLOWERS, team).map((x) => x.name), ["Wren"]);
  assert.deepEqual(assistantsFor(STOCK, team).map((x) => x.name), []);
  assert.deepEqual(assistantsFor(STOCK, [a("Rae", "Tells me when things are back in stock")]).map((x) => x.name), ["Rae"]);
});
