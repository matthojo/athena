// Regular payments from money days: cadence, steady amounts, the confidence cut, rises, missed payments, mandates.
// Run: npx tsx --test lib/recurring.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import type { MoneyCategory } from "./day-types";
import { CONFIDENCE_CUT, amountSteadiness, detectRecurring, dueSoon, merchantKey, merchantName, monthlyTotals, nextDate, regularity, regularLines, type RecurringInputDay } from "./recurring";
import { addDays } from "./dates";

type P = { merchant: string; amount: number; category?: MoneyCategory; kind?: "debit" };

/** Days from a list of [date, payment] pairs. */
function days(...pairs: Array<[string, P]>): RecurringInputDay[] {
  const by = new Map<string, RecurringInputDay>();
  for (const [date, p] of pairs) {
    const d = by.get(date) ?? { date, currency: "GBP", payments: [] };
    d.payments.push({ merchant: p.merchant, amount: p.amount, category: p.category ?? "entertainment", ...(p.kind ? { kind: p.kind } : {}) });
    by.set(date, d);
  }
  return [...by.values()];
}

/** The same payment on a day of the month, for n months ending in `lastMonth` (YYYY-MM). */
function monthly(p: P, day: number, lastMonth: string, n: number, amounts?: number[]): Array<[string, P]> {
  const [y, m] = lastMonth.split("-").map(Number);
  const out: Array<[string, P]> = [];
  for (let i = n - 1; i >= 0; i--) {
    const d = new Date(Date.UTC(y, m - 1 - i, 1));
    const last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
    const date = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(Math.min(day, last)).padStart(2, "0")}`;
    out.push([date, { ...p, amount: amounts ? amounts[n - 1 - i] : p.amount }]);
  }
  return out;
}

const TODAY = "2026-11-08";

test("merchant names normalise across a bank's references", () => {
  assert.equal(merchantKey("SPOTIFY P1A2B3C4"), "spotify");
  assert.equal(merchantKey("Spotify"), "spotify");
  assert.equal(merchantKey("NETFLIX.COM"), "netflix");
  assert.equal(merchantKey("Apple.com/bill"), "apple");
  assert.equal(merchantKey("PureGym Ltd"), "puregym");
  assert.equal(merchantKey("AMAZON PRIME*2B3XY9"), "amazon prime");
  assert.equal(merchantName("SPOTIFY P1A2B3C4"), "Spotify");
  assert.equal(merchantName("NETFLIX.COM"), "Netflix");
  assert.equal(merchantName("AMAZON PRIME*2B3XY9"), "Amazon Prime");
  assert.equal(merchantName("Disney Plus"), "Disney Plus");
  assert.equal(merchantName("BRITISH GAS"), "British Gas");
});

test("next payment: same day next month, the month's last day when shorter, a week or a year on", () => {
  assert.equal(nextDate("2026-01-31", "monthly"), "2026-02-28");
  assert.equal(nextDate("2026-02-28", "monthly", 31), "2026-03-31");
  assert.equal(nextDate("2026-12-14", "monthly"), "2027-01-14");
  assert.equal(nextDate("2026-11-08", "weekly"), "2026-11-15");
  assert.equal(nextDate("2025-11-20", "yearly"), "2026-11-20");
});

test("regularity: on-cadence gaps count, a skipped month counts half, a random one doesn't", () => {
  assert.equal(regularity([31, 30, 31], "monthly"), 1);
  assert.equal(regularity([30, 61], "monthly"), 0.75);
  assert.equal(regularity([30, 12], "monthly"), 0.5);
});

test("amounts: one price change is a step, not noise", () => {
  assert.deepEqual(amountSteadiness([1099, 1099, 1099]), { score: 1 });
  const s = amountSteadiness([1099, 1099, 1099, 1199, 1199]);
  assert.equal(s.split, 3);
  assert.ok(s.score > 0.9);
  assert.ok(amountSteadiness([300, 1450, 720, 2200, 980]).score < 0.6);
});

test("a monthly subscription is found, with its next date and monthly figure", () => {
  const list = detectRecurring(days(...monthly({ merchant: "SPOTIFY P1A2B3", amount: 1199 }, 14, "2026-10", 8)), TODAY);
  assert.equal(list.length, 1);
  const [s] = list;
  assert.equal(s.name, "Spotify");
  assert.equal(s.cadence, "monthly");
  assert.equal(s.kind, "subscription");
  assert.equal(s.last_on, "2026-10-14");
  assert.equal(s.next_on, "2026-11-14");
  assert.equal(s.last_amount, 1199);
  assert.equal(s.monthly, 1199);
  assert.ok(s.confidence >= CONFIDENCE_CUT);
  assert.equal(s.rise, undefined);
  assert.equal(s.missed, undefined);
});

test("a weekly coffee at the same café, same price every Saturday, isn't a subscription", () => {
  const pairs: Array<[string, P]> = [];
  for (let d = "2026-08-01"; d <= TODAY; d = addDays(d, 7)) pairs.push([d, { merchant: "Monmouth Coffee", amount: 340, category: "eating_out" }]);
  assert.equal(detectRecurring(days(...pairs), TODAY).length, 0);
  const [all] = detectRecurring(days(...pairs), TODAY, { all: true });
  assert.ok(all.confidence < CONFIDENCE_CUT, `café scored ${all.confidence}`);
});

test("a commute and a lunch spot with varying amounts aren't regular payments", () => {
  const pairs: Array<[string, P]> = [];
  let i = 0;
  for (let d = "2026-09-01"; d <= TODAY; d = addDays(d, 1)) {
    const dow = new Date(`${d}T12:00:00Z`).getUTCDay();
    if (dow === 0 || dow === 6) continue;
    pairs.push([d, { merchant: "TfL Travel Charge", amount: [280, 420, 560, 700][i++ % 4], category: "transport" }]);
    if (i % 3 === 0) pairs.push([d, { merchant: "Pret A Manger", amount: 650 + ((i * 137) % 800), category: "eating_out" }]);
  }
  assert.deepEqual(detectRecurring(days(...pairs), TODAY), []);
});

test("a price rise is marked, from the old price to the new one", () => {
  const list = detectRecurring(days(...monthly({ merchant: "NETFLIX.COM", amount: 0 }, 3, "2026-11", 8, [1099, 1099, 1099, 1099, 1099, 1099, 1299, 1299])), TODAY);
  assert.equal(list.length, 1);
  assert.deepEqual(list[0].rise, { from: 1099, to: 1299, on: "2026-10-03" });
  assert.equal(list[0].usual_amount, 1299);
});

test("an old rise isn't news any more", () => {
  const list = detectRecurring(days(...monthly({ merchant: "NETFLIX.COM", amount: 0 }, 3, "2026-11", 10, [999, 999, 1099, 1099, 1099, 1099, 1099, 1099, 1099, 1099])), TODAY);
  assert.equal(list[0].rise, undefined);
});

test("a payment that didn't come is marked missed; a whole cycle later it has stopped", () => {
  // Gym on the 1st, last paid 1 Oct: 1 Nov passed a week ago.
  const gym = monthly({ merchant: "PureGym Ltd", amount: 2499, category: "personal_care" }, 1, "2026-10", 6);
  const [missed] = detectRecurring(days(...gym), TODAY);
  assert.deepEqual(missed.missed, { due_on: "2026-11-01" });
  // Last paid in August: long stopped, so it's gone.
  assert.equal(detectRecurring(days(...monthly({ merchant: "PureGym Ltd", amount: 2499, category: "personal_care" }, 1, "2026-08", 6)), TODAY).length, 0);
});

test("a direct debit is a bill, and its amount may move", () => {
  const list = detectRecurring(days(...monthly({ merchant: "Octopus Energy", amount: 0, category: "bills", kind: "debit" }, 1, "2026-11", 5, [7400, 8100, 9300, 8600, 10200])), TODAY);
  assert.equal(list.length, 1);
  assert.equal(list[0].kind, "bill");
  assert.equal(list[0].next_on, "2026-12-01");
});

test("a live mandate settles a bill from two payments, and a cancelled one hides its payee", () => {
  const two = monthly({ merchant: "LB HACKNEY CTAX", amount: 16800, category: "bills" }, 5, "2026-11", 2);
  assert.equal(detectRecurring(days(...two), TODAY).length, 0);
  const live = detectRecurring(days(...two), TODAY, { mandates: [{ name: "LB Hackney CTAX", live: true }] });
  assert.equal(live.length, 1);
  assert.equal(live[0].mandate, true);
  assert.equal(live[0].confidence, 1);
  const subs = monthly({ merchant: "Old Gym", amount: 3000, category: "personal_care", kind: "debit" }, 9, "2026-10", 6);
  assert.equal(detectRecurring(days(...subs), TODAY, { mandates: [{ name: "Old Gym", live: false }] }).length, 0);
});

test("a live mandate with no payments read yet comes from its own last payment", () => {
  const [r] = detectRecurring([], TODAY, { mandates: [{ name: "Thames Water", live: true, last_on: "2026-10-20", last_amount: 3800, currency: "GBP" }] });
  assert.equal(r.name, "Thames Water");
  assert.equal(r.next_on, "2026-11-20");
  assert.equal(r.kind, "bill");
});

test("yearly renewals are found from two payments a year apart", () => {
  const list = detectRecurring(days(["2024-11-20", { merchant: "Amazon Prime*AB12", amount: 9500, category: "shopping" }], ["2025-11-20", { merchant: "AMAZON PRIME*ZZ99", amount: 9500, category: "shopping" }]), TODAY);
  assert.equal(list.length, 1);
  assert.equal(list[0].cadence, "yearly");
  assert.equal(list[0].next_on, "2026-11-20");
  assert.equal(list[0].monthly, 792);
});

test("Not a subscription: hidden keys stay out", () => {
  const d = days(...monthly({ merchant: "Spotify", amount: 1199 }, 14, "2026-10", 6));
  assert.equal(detectRecurring(d, TODAY, { hidden: ["spotify"] }).length, 0);
});

test("the briefing gets names due today or tomorrow, never an amount", () => {
  const d = days(...monthly({ merchant: "Spotify", amount: 1199 }, 9, "2026-10", 6), ...monthly({ merchant: "iCloud", amount: 299 }, 8, "2026-10", 6), ...monthly({ merchant: "Netflix", amount: 1299 }, 20, "2026-10", 6));
  const soon = dueSoon(detectRecurring(d, TODAY), TODAY);
  assert.deepEqual(soon.map((s) => [s.name, s.on]), [["iCloud", "2026-11-08"], ["Spotify", "2026-11-09"]]);
  for (const s of soon) assert.equal(Object.keys(s).some((k) => /amount/.test(k)), false);
});

test("monthly totals add weekly and yearly at their monthly rate", () => {
  const d = days(...monthly({ merchant: "Spotify", amount: 1200 }, 14, "2026-10", 6), ["2024-11-20", { merchant: "Amazon Prime", amount: 12000, category: "shopping" }], ["2025-11-20", { merchant: "Amazon Prime", amount: 12000, category: "shopping" }]);
  assert.deepEqual(monthlyTotals(detectRecurring(d, TODAY)), [{ currency: "GBP", amount: 2200, count: 2 }]);
});

test("Ask's lines say how often, the usual amount and what changed", () => {
  const list = detectRecurring(days(...monthly({ merchant: "NETFLIX.COM", amount: 0 }, 3, "2026-11", 6, [1099, 1099, 1099, 1099, 1299, 1299])), TODAY);
  const [line] = regularLines(list, (m) => `£${(m / 100).toFixed(2)}`);
  assert.equal(line.name, "Netflix");
  assert.equal(line.how_often, "every month");
  assert.equal(line.usual_amount, "£12.99");
  assert.match(line.price_rose, /from £10\.99 to £12\.99/);
});

test("nudges: a recent rise and a missed payment, by name only, each with its own once-only tag", async () => {
  const { paymentNudges, rekeyLegacyPayment } = await import("./nudges");
  // Stands in for data-box's blindIndexes: the current key's index first, then an older key's.
  const index = (merchant: string) => [`new${merchant.length}`, `old${merchant.length}`];
  // Netflix went up on 3 Nov; the gym's 1 Nov payment hasn't come.
  const list = detectRecurring(days(...monthly({ merchant: "NETFLIX.COM", amount: 0 }, 3, "2026-11", 6, [1099, 1099, 1099, 1099, 1099, 1299]), ...monthly({ merchant: "PureGym Ltd", amount: 2499, category: "personal_care" }, 1, "2026-10", 6)), TODAY);
  const n = paymentNudges(list, TODAY, index);
  assert.deepEqual(n.map((x) => x.kind).sort(), ["missed", "price_up"]);
  const up = n.find((x) => x.kind === "price_up")!;
  assert.equal(up.title, "Netflix costs more now");
  // reminder_log is readable: the tag is the merchant's index and a date, never its name.
  assert.equal(up.tag, "pay-up:new7:2026-11-03");
  assert.deepEqual(up.older, ["pay-up:old7:2026-11-03"]);
  for (const x of n) assert.doesNotMatch(`${x.tag} ${x.older.join(" ")}`, /netflix|puregym/i);
  // A key written before the change maps to the same tag, so what was sent isn't sent again.
  assert.deepEqual(rekeyLegacyPayment("regular-up:netflix:2026-11-03", index), [up.tag, ...up.older]);
  assert.deepEqual(rekeyLegacyPayment("regular-missed:the gym: east:2026-11-01", index), ["pay-missed:new13:2026-11-01", "pay-missed:old13:2026-11-01"]);
  assert.deepEqual(rekeyLegacyPayment("week:2026-11-08", index), []);
  // No data key, no index: no nudge, and nothing readable written in its place.
  assert.deepEqual(paymentNudges(list, TODAY, () => []), []);
  const missed = n.find((x) => x.kind === "missed")!;
  assert.equal(missed.title, "No payment to PureGym yet");
  assert.match(missed.body, /1 November/);
  for (const x of n) {
    assert.doesNotMatch(`${x.title} ${x.body}`, /£|\d+\.\d\d/);
    assert.equal(x.url, "/#/money");
  }
  // A rise more than a week old isn't pushed.
  assert.equal(paymentNudges(list, "2026-11-20", index).filter((x) => x.kind === "price_up").length, 0);
});

test("banks mark direct debits, and Starling's mandates read as live or cancelled", async () => {
  const { monzoTxn } = await import("../netlify/lib/connectors/monzo-direct");
  const { starlingTxn, starlingMandate } = await import("../netlify/lib/connectors/starling-direct");
  assert.equal(monzoTxn({ id: "tx_1", created: "2026-11-01T06:00:00Z", amount: -9300, currency: "GBP", category: "bills", scheme: "bacs", counterparty: { name: "Octopus Energy" } })?.kind, "debit");
  assert.equal(monzoTxn({ id: "tx_2", created: "2026-11-01T06:00:00Z", amount: -1199, currency: "GBP", category: "entertainment", scheme: "mastercard", merchant: { name: "Spotify" } })?.kind, undefined);
  assert.equal(starlingTxn({ feedItemUid: "f1", amount: { currency: "GBP", minorUnits: 16800 }, direction: "OUT", transactionTime: "2026-11-15T06:00:00Z", status: "SETTLED", source: "DIRECT_DEBIT", spendingCategory: "BILLS_AND_SERVICES", counterPartyName: "Hackney Council" })?.kind, "debit");
  assert.deepEqual(starlingMandate({ uid: "m1", status: "LIVE", originatorName: "Thames Water", lastPayment: { lastDate: "2026-10-20", lastAmount: { currency: "GBP", minorUnits: 3800 } } }), { name: "Thames Water", live: true, last_on: "2026-10-20", last_amount: 3800, currency: "GBP" });
  assert.deepEqual(starlingMandate({ uid: "m2", status: "CANCELLED", originatorName: "Old Gym" }), { name: "Old Gym", live: false });
  assert.equal(starlingMandate({ uid: "m3", status: "LIVE" }), null);
});
