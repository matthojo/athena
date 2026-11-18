// Run: npx tsx --test netlify/lib/connectors/octopus-history.test.ts
// Octopus's meter history: months stepped back within a deadline, to 24 months or the first empty month, resumable; and House's 25-month windows.
import { test } from "node:test";
import assert from "node:assert/strict";
import { addDays } from "../../../lib/dates";
import type { HomeDayFigures } from "../../../lib/money";
import { historyFloor, monthStep, monthsBefore, OCTOPUS_HISTORY_MONTHS, stepBack, STEP_DAYS, type ReadDays, type StepState } from "./octopus-history";
import { HOUSE_DAYS } from "../../../lib/house-data";
import { TARIFF_HISTORY_DAYS } from "./octopus-direct";
import { houseEnergy, homeMonths } from "../../../lib/house";

const TODAY = "2026-11-10";

/** Readings on every day from `since`; asks recorded. */
function meter(since = "2000-01-01") {
  const asked: Array<[string, string]> = [];
  const read: ReadDays = async (after, before) => {
    asked.push([after, before]);
    const m = new Map<string, HomeDayFigures>();
    for (let d = after; d < before; d = addDays(d, 1)) if (d >= since) m.set(d, { kwh: 9, gas_kwh: 20 });
    return m;
  };
  return { asked, read };
}

test("the floor is 24 months back to the day; a step is 30 days and stops there", async () => {
  assert.equal(OCTOPUS_HISTORY_MONTHS, 24);
  assert.equal(historyFloor(TODAY), "2024-11-10");
  assert.equal(monthsBefore("2026-03-31", 1), "2026-02-28");
  const { read } = meter();
  const s = await monthStep("2026-11-07", TODAY, read);
  assert.equal(s.days.size, STEP_DAYS);
  assert.equal(s.oldest, "2026-10-08");
  assert.equal(s.next, "2026-10-08");
  const last = await monthStep("2024-11-25", TODAY, read);
  assert.equal(last.oldest, "2024-11-10", "clipped at the floor");
  assert.equal(last.next, undefined);
  assert.equal((await monthStep("2024-11-10", TODAY, read)).days.size, 0);
});

test("a run takes as many months as fit before its deadline, saving after each", async () => {
  const { asked, read } = meter();
  let t = 0;
  const saved: StepState[] = [];
  // Each month takes 10 s of a 35 s budget: four months (the check is before each).
  const r = await stepBack({}, {
    today: TODAY,
    first: "2026-11-04",
    deadline: 35,
    clock: () => t,
    read: async (a, b) => ((t += 10), read(a, b)),
    save: async (days, s) => (saved.push(s), days.size),
  });
  assert.equal(r.months, 4);
  assert.equal(asked.length, 4);
  assert.deepEqual(asked[0], ["2026-10-05", "2026-11-04"]);
  assert.equal(r.state.before, "2026-07-07");
  assert.equal(r.changed, 120);
  assert.deepEqual(saved.map((s) => s.before), ["2026-10-05", "2026-09-05", "2026-08-06", "2026-07-07"]);
  assert.equal(r.state.done, undefined);
});

test("stops at 24 months with readings all the way, and at the first empty month", async () => {
  const all = meter();
  const r = await stepBack({}, { today: TODAY, first: "2026-11-04", deadline: Infinity, read: all.read, save: async () => 0 });
  assert.equal(r.state.done, true);
  assert.equal(all.asked.at(-1)![0], "2024-11-10", "the last step ends at the floor");
  assert.ok(all.asked.every(([a]) => a >= "2024-11-10"), "nothing older asked");
  assert.equal(r.months, 25);
  // The meter was fitted in March 2026: the step before that comes back empty and the load stops there.
  const newer = meter("2026-03-15");
  const n = await stepBack({}, { today: TODAY, first: "2026-11-04", deadline: Infinity, read: newer.read, save: async () => 0 });
  assert.equal(n.state.done, true);
  assert.ok(newer.asked.at(-1)![1] <= "2026-03-15");
  assert.ok(newer.asked.length <= 10);
});

test("resumes from where the last run stopped, and a finished one reads nothing", async () => {
  const { asked, read } = meter();
  const r = await stepBack({ before: "2025-06-01" }, { today: TODAY, first: "2026-11-04", deadline: Infinity, read, save: async () => 0 });
  assert.deepEqual(asked[0], ["2025-05-02", "2025-06-01"]);
  assert.equal(r.state.done, true);
  asked.length = 0;
  const again = await stepBack({ done: true }, { today: TODAY, first: "2026-11-04", deadline: Infinity, read, save: async () => 0 });
  assert.equal(again.months, 0);
  assert.equal(asked.length, 0);
  // Out of time before the first step: nothing read, nothing lost.
  const late = await stepBack({ before: "2025-06-01" }, { today: TODAY, first: "2026-11-04", deadline: 0, clock: () => 1, read, save: async () => 0 });
  assert.deepEqual(late.state, { before: "2025-06-01" });
});

test("House and the tariff both read 25 months: rolling 12 against the 12 before and the year so far are priced", () => {
  const since = monthsBefore(TODAY, 25);
  assert.ok(addDays(TODAY, -HOUSE_DAYS) <= since, `HOUSE_DAYS ${HOUSE_DAYS} reaches ${since}`);
  assert.equal(TARIFF_HISTORY_DAYS, HOUSE_DAYS);
  // 25 months of readings, priced from the tariff's floor: the 12 before is priced too.
  const days = new Map<string, HomeDayFigures>();
  for (let d = addDays(TODAY, -HOUSE_DAYS); d < TODAY; d = addDays(d, 1)) days.set(d, { kwh: 9, half_hours: Array(48).fill(9 / 48), gas_kwh: 20 });
  const at = (d: string) => Math.floor(Date.parse(`${d}T00:00:00Z`) / 1000);
  const from = addDays(TODAY, -TARIFF_HISTORY_DAYS);
  const tariff = {
    fetched_on: TODAY,
    account: "A-TEST0001",
    agreements: [
      { fuel: "electricity" as const, tariff: "E-1R-FLAT-24-04-01-C", product: "FLAT-24-04-01", from: `${from}T00:00:00Z`, to: null, unit: [[at(from), 0, 25]] as Array<[number, number, number]>, standing: [[at(from), 0, 50]] as Array<[number, number, number]> },
      { fuel: "gas" as const, tariff: "G-1R-FLAT-24-04-01-C", product: "FLAT-24-04-01", from: `${from}T00:00:00Z`, to: null, unit: [[at(from), 0, 6]] as Array<[number, number, number]>, standing: [[at(from), 0, 30]] as Array<[number, number, number]> },
    ],
  };
  const started = performance.now();
  const e = houseEnergy({ days, months: homeMonths(days), tariff, today: TODAY, now: new Date(`${TODAY}T09:00:00Z`), tz: "Europe/London", weather: { missing: "no_home" } })!;
  const ms = performance.now() - started;
  // Measured here: about 0.1 s for 762 days with half hours and a flat tariff, about 0.4 s for the 26-month sample on a time-of-use one, making it included. Quick enough without folding old days into months.
  assert.ok(ms < 3000, `${Math.round(ms)} ms`);
  for (const fuel of ["electricity", "gas"] as const) {
    for (const kind of ["rolling", "ytd", "year"] as const) {
      const r = e.trends!.rows.find((x) => x.fuel === fuel && x.kind === kind)!;
      assert.ok(r, `${fuel} ${kind}`);
      assert.ok(r.against[0].cost_change !== undefined, `${fuel} ${kind} priced on both sides`);
    }
  }
  assert.equal(e.trends!.needs.length, 0);
});
