// Tracking, in words. Run: npx tsx --test app/src/lib/tracker-words.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import type { TrackerPoint, TrackerView } from "../../../lib/tracker-types";
import { reachedBy, cleanNumber, cleanStates, diffWords, meets, presetsFor, readTracker, stateRuns, summaryOf, toUnits, trackerDetail, trackerGlance, trackerSentence, valueWords, whoState, whoWords, whenWords, cantWords } from "./tracker-words";

// Monday 16 Nov 2026, noon local.
const NOW = new Date(2026, 10, 16, 12, 0, 0);
const ago = (days: number, hour = 9) => {
  const d = new Date(NOW);
  d.setDate(d.getDate() - days);
  d.setHours(hour, 0, 0, 0);
  return d.toISOString();
};
let n = 0;
const pt = (days: number, value: string, extra: Partial<TrackerPoint> = {}): TrackerPoint => ({ id: `p${++n}`, tracker_id: "t", value, source: null, url: null, checked_at: ago(days), checked_by: "assistant", assistant_id: "a", who: "Penny", ...extra });
const price = (points: TrackerPoint[], target: TrackerView["target"] = null): TrackerView => ({
  id: "t", saved_id: "s", name: "Fellstone", url: null, label: "price", kind: "number", prefix: "£", suffix: "", currency: "GBP", states: [], direction: "lower", preset: "price", target, assistant_id: "a", created_at: ago(40), points, summary: null,
});
const number = (points: TrackerPoint[], over: Partial<TrackerView> = {}): TrackerView => ({ ...price(points), saved_id: null, name: "Electricity tariff", label: "unit rate", prefix: "", suffix: "p/kWh", currency: null, preset: null, ...over });
const state = (points: TrackerPoint[], over: Partial<TrackerView> = {}): TrackerView => ({ ...price(points), label: "stock", kind: "state", prefix: "", currency: null, states: ["in stock", "sold out"], direction: "change", preset: "stock", ...over });
const say = (v: TrackerView) => trackerSentence(readTracker(v)!, NOW).text;
const goal = (op: "lte" | "gte" | "eq" | "change", value: string): TrackerView["target"] => ({ op, value, set_by: "owner", assistant_id: null, set_at: ago(3) });

test("values are the page's own digits, written as the owner chose", () => {
  assert.equal(valueWords(price([]), "34"), "£34");
  assert.equal(valueWords(price([]), "34.5"), "£34.50");
  assert.equal(valueWords(price([]), "1299.99"), "£1,299.99");
  assert.equal(valueWords(number([]), "24.86"), "24.86p/kWh");
  assert.equal(valueWords(number([], { suffix: " followers" }), "12040"), "12,040 followers");
  assert.equal(valueWords(number([], { suffix: "°C" }), "-2.5"), "−2.5°C");
  assert.equal(valueWords(state([]), "in stock"), "in stock");
});

test("a number is cleaned, never guessed", () => {
  assert.equal(cleanNumber(" 1,299.00 "), "1299.00");
  assert.equal(cleanNumber("007"), "7");
  assert.equal(cleanNumber("−3"), "-3");
  for (const bad of ["£34", "about 30", "30-40", "", "1.2.3"]) assert.throws(() => cleanNumber(bad));
  assert.equal(toUnits("34.5", 2), 3450);
  assert.equal(toUnits("-0.25", 2), -25);
  assert.equal(diffWords(price([]), -800, 2), "£8");
  assert.equal(diffWords(price([]), 450, 2), "£4.50");
  assert.equal(diffWords(number([]), 32, 2), "0.32p/kWh");
});

test("a price: the saved price, then the lowest since", () => {
  const saved = pt(30, "42", { checked_by: "save", source: "Fellstone" });
  assert.equal(say(price([saved])), "£42 at Fellstone, the price when you saved it.");
  assert.equal(say(price([saved, pt(2, "34", { source: "Copperkettle" })])), "£34 at Copperkettle, the lowest since you saved it.");
  assert.equal(say(price([saved, pt(10, "32", { source: "Brightside" }), pt(1, "36", { source: "Brightside" })])), "£36 at Brightside, £6 under the saved price. It was £32 on 6 Nov.");
  assert.equal(say(price([saved, pt(1, "45", { source: "Fellstone" })])), "£45 at Fellstone, £3 more than when you saved it.");
});

test("a price's best now is across shops checked in the last 14 days", () => {
  const saved = pt(30, "42", { checked_by: "save", source: "Fellstone" });
  const v = price([saved, pt(3, "34", { source: "Copperkettle" }), pt(1, "35.99", { source: "Brightside" })]);
  assert.equal(trackerSentence(readTracker(v)!, NOW).lead, "£34 at Copperkettle");
  assert.equal(trackerDetail(readTracker(v)!, NOW), "Saved at £42 on 17 Oct · 3 checks at 3 shops");
});

test("the target is said first: set, reached, and exactly", () => {
  const saved = pt(30, "42", { checked_by: "save", source: "Fellstone" });
  assert.equal(say(price([saved, pt(1, "34", { source: "Copperkettle" })], goal("lte", "30"))), "£34 at Copperkettle. You asked to hear at £30 or less.");
  assert.equal(say(price([saved, pt(1, "27", { source: "Fenn & Hale" })], goal("lte", "28"))), "£27 at Fenn & Hale, under the £28 you asked for.");
  assert.equal(say(price([saved, pt(1, "30", { source: "Copperkettle" })], goal("lte", "30"))), "£30 at Copperkettle, the £30 you asked for.");
  assert.equal(say(number([pt(5, "900"), pt(1, "1600")], { suffix: " followers", direction: "higher", target: goal("gte", "1500") })), "1,600 followers, over the 1,500 followers you asked for.");
  // Brightside's £32 is too old to count as now; it's the lowest, said in the quieter line.
  const r = readTracker(price([saved, pt(20, "32", { source: "Brightside" }), pt(1, "34", { source: "Copperkettle" })], goal("lte", "30")))!;
  assert.equal(trackerSentence(r, NOW).lead, "£34 at Copperkettle");
  assert.equal(trackerDetail(r, NOW), "Lowest £32 on 27 Oct · Saved at £42 on 17 Oct · 3 checks at 3 shops");
});

test("reached when any shop's current price meets it, named in the sentence", () => {
  const saved = pt(30, "20", { checked_by: "save", source: "Page & Stone" });
  const pts = [saved, pt(3, "15", { source: "Inkwell" }), pt(1, "18", { source: "Page & Stone" })];
  const v = price(pts, goal("lte", "16"));
  assert.equal(say(v), "£15 at Inkwell, under the £16 you asked for.");
  assert.equal(reachedBy(v, pts, 2)?.source, "Inkwell");
  // A shop's price older than 14 days before the newest check doesn't count.
  const stale = [saved, pt(20, "15", { source: "Inkwell" }), pt(1, "18", { source: "Page & Stone" })];
  assert.equal(reachedBy(price(stale, goal("lte", "16")), stale, 2), null);
  assert.equal(say(price(stale, goal("lte", "16"))), "£18 at Page & Stone. You asked to hear at £16 or less.");
  // The server's word wins, and its reached_by is the check the sentence names.
  const told = { ...v, summary: { ...summaryOf(v, NOW)!, target_reached: false, reached_by: null } };
  assert.match(say(told), /You asked to hear at £16 or less/);
  const byServer = { ...v, summary: { ...summaryOf(v, NOW)!, reached_by: pts[1] } };
  assert.equal(trackerSentence(readTracker(byServer)!, NOW).lead, "£15 at Inkwell");
});

test("a number of your own: neutral words, never price or shop", () => {
  const v = number([pt(40, "24.50", { source: "Tidewell" }), pt(10, "22.86", { source: "Tidewell" }), pt(3, "23.18", { source: "Tidewell" })]);
  const text = say(v);
  assert.equal(text, "23.18p/kWh, 1.32p/kWh lower than on 7 Oct. It was 22.86p/kWh on 6 Nov.");
  assert.doesNotMatch(text + trackerDetail(readTracker(v)!, NOW), /price|shop/i);
  assert.equal(trackerDetail(readTracker(v)!, NOW), "Started at 24.50p/kWh on 7 Oct · 3 checks");
  assert.equal(say(number([pt(5, "20"), pt(1, "19")])), "19p/kWh, the lowest so far.");
  assert.equal(say(number([pt(5, "20"), pt(1, "21")], { direction: "change" })), "21p/kWh, up 1p/kWh since yesterday.");
  assert.equal(say(number([pt(5, "20"), pt(1, "20")], { direction: "change", target: goal("change", "") })), "20p/kWh, the same at every check since 11 Nov. You'll hear when it changes.");
  assert.equal(say(number([pt(0, "20")])), "20p/kWh, checked today.");
});

test("a state: since when, and what you asked to hear", () => {
  const jl = { source: "Fenn & Hale" };
  const pts = [pt(20, "sold out", jl), pt(9, "sold out", jl), pt(6, "in stock", jl), pt(0, "in stock", jl)];
  assert.equal(say(state(pts)), "In stock at Fenn & Hale since Tuesday.");
  assert.equal(trackerDetail(readTracker(state(pts))!, NOW), "Sold out from 27 Oct to 10 Nov · 4 checks");
  assert.equal(say(state(pts, { target: goal("eq", "in stock") })), "In stock at Fenn & Hale since Tuesday. You asked to hear when it was.");
  assert.equal(say(state([pt(9, "sold out", jl), pt(2, "sold out", jl)], { target: goal("eq", "in stock") })), "Sold out at Fenn & Hale, every check since 7 Nov. You asked to hear when it's in stock.");
  assert.equal(say(state([pt(1, "approved")], { preset: null, label: "status", states: ["approved", "received"] })), "Approved, checked yesterday.");
  // The same day: a time, and no "from 16 Nov to 16 Nov".
  const today = [pt(0, "sold out", { ...jl, checked_at: new Date(2026, 10, 16, 8, 5).toISOString() }), pt(0, "in stock", { ...jl, checked_at: new Date(2026, 10, 16, 10, 30).toISOString() })];
  assert.equal(say(state(today)), "In stock at Fenn & Hale since 10:30.");
  assert.equal(trackerDetail(readTracker(state(today))!, NOW), "Sold out earlier on 16 Nov · 2 checks");
  assert.deepEqual(stateRuns(readTracker(state(pts))!, NOW.getTime()).map((r) => [r.value, r.points.length]), [["sold out", 2], ["in stock", 2]]);
});

test("meets: at or under, at or over, a state, never for any change", () => {
  const v = price([]);
  assert.equal(meets(v, { op: "lte", value: "30" }, "29.99", 2), true);
  assert.equal(meets(v, { op: "lte", value: "30" }, "30.01", 2), false);
  assert.equal(meets(v, { op: "gte", value: "30" }, "30", 2), true);
  assert.equal(meets(state([]), { op: "eq", value: "In stock" }, "in stock", 0), true);
  assert.equal(meets(v, { op: "change", value: "" }, "30", 2), false);
});

test("the summary the fake sends agrees with the words", () => {
  const v = price([pt(30, "42", { checked_by: "save" }), pt(1, "27")], goal("lte", "28"));
  const s = summaryOf(v, NOW)!;
  assert.equal(s.target_reached, true);
  assert.equal(s.best?.value, "27");
  assert.equal(s.checks, 2);
  assert.equal(s.fresh, true);
});

test("a glance for cards and rows", () => {
  const saved = pt(30, "42", { checked_by: "save", source: "Fellstone" });
  assert.equal(trackerGlance(readTracker(price([saved, pt(1, "34", { source: "Copperkettle" })]))!, NOW), "£34 · lowest so far");
  assert.equal(trackerGlance(readTracker(number([pt(10, "22.86"), pt(3, "23.18")]))!, NOW), "23.18p/kWh · up 0.32p/kWh since Friday");
  assert.equal(trackerGlance(readTracker(state([pt(9, "sold out"), pt(6, "in stock")]))!, NOW), "In stock · since Tuesday");
});

test("making one: presets that fit, states cleaned", () => {
  assert.deepEqual(presetsFor({ facts: { price: "42", currency: "GBP" }, thing: "product" }, []), ["price", "stock"]);
  assert.deepEqual(presetsFor({ facts: { price: "42", currency: "GBP" }, thing: "product" }, [{ preset: "price" }]), ["stock"]);
  assert.deepEqual(presetsFor({ facts: null, thing: "article" }, []), []);
  assert.deepEqual(cleanStates([" Approved ", "being  checked", "approved", ""]), ["approved", "being checked"]);
  assert.throws(() => cleanStates(["only one"]));
});

test("who checks it: her name and when, the owner's own, or nobody; and why she can't", () => {
  const PENNY = "5a3e0000-0000-4000-8000-0000000e0001";
  const penny = { id: PENNY, name: "Penny", web: true, paused: false, next: null as string | null };
  const hers = pt(0, "34", { checked_by: "assistant", assistant_id: PENNY, who: "Penny", checked_at: new Date(NOW.getTime() - 42 * 60_000).toISOString() });
  const ask = pt(0, "85", { checked_by: "ask", checked_at: new Date(NOW.getTime() - 42 * 60_000).toISOString() });

  const on = whoState({ assistant_id: PENNY, assistant_set_by: "owner" }, penny, true);
  assert.equal(whoWords(on), "Penny checks this");
  assert.equal(whenWords(on, hers, NOW), "Checked 42 minutes ago", "her own check: no name twice");
  assert.equal(whenWords(on, ask, NOW), "Ask checked 42 minutes ago");
  assert.equal(whenWords(whoState({ assistant_id: PENNY }, { ...penny, next: "Friday at 17:00" }, true), hers, NOW), "Next check Friday at 17:00", "her schedule says when");
  assert.equal(cantWords(on), null);

  const off = whoState({ assistant_id: PENNY }, { ...penny, web: false, next: "Friday at 17:00" }, true);
  assert.deepEqual(cantWords(off), { line: "Penny can't look things up online, so nothing is checking this.", fix: "Turn on" });
  assert.equal(whenWords(off, hers, NOW), null, "no next check while she can't");
  assert.equal(cantWords(whoState({ assistant_id: PENNY }, { ...penny, paused: true }, true))!.fix, "Resume");
  assert.equal(cantWords(whoState({ assistant_id: PENNY }, penny, false))!.fix, "Open Settings");
  assert.equal(cantWords(whoState({ assistant_id: PENNY }, penny, null)), null, "the setting not read yet isn't a block");

  const me = whoState({ assistant_id: null, assistant_set_by: "owner" }, null, true);
  assert.equal(whoWords(me), "You check this");
  assert.equal(whenWords(me, pt(1, "approved", { checked_by: "owner" }), NOW), "Checked yesterday");

  const nobody = whoState({ assistant_id: null, assistant_set_by: null }, null, true);
  assert.equal(whoWords(nobody), "Nobody is checking this yet");
  assert.equal(whenWords(nobody, ask, NOW), "Ask checked 42 minutes ago");
  assert.equal(whenWords(nobody, pt(30, "42", { checked_by: "save" }), NOW), null, "the save isn't a check");
  // Her assistant has gone: nobody checks it.
  assert.equal(whoState({ assistant_id: PENNY }, null, true).kind, "nobody");
});
