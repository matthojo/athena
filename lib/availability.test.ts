// Free slots (lib/availability.ts): working hours, buffers, travel, days off, guests, zones.
// Run: npx tsx --test lib/availability.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { busyFromEvents, busyFromTravel, DEFAULT_HOURS, findSlots, LEAD_MINUTES, readWorkingHours, TRAVEL_BUFFER, type FindInput } from "./availability";
import { zonedParts } from "./dates";

const at = (iso: string) => Date.parse(iso);
const LON = "Europe/London";
/** Monday 9 Nov 2026, 08:00 in London (GMT). */
const MON = at("2026-11-09T08:00:00Z");

function base(over: Partial<FindInput> = {}): FindInput {
  return { from: MON, to: at("2026-11-14T00:00:00Z"), minutes: 30, tz: LON, hours: DEFAULT_HOURS, busy: [], now: MON, ...over };
}
const local = (ms: number, tz = LON) => {
  const p = zonedParts(new Date(ms), tz);
  return `${p.date} ${p.time}`;
};

test("readWorkingHours: defaults, and each field checked on its own", () => {
  assert.deepEqual(readWorkingHours(null), DEFAULT_HOURS);
  assert.deepEqual(readWorkingHours({ days: [1, 2, 9, 2, "x"], start: "08:30", end: "16:00", buffer: 5 }), { days: [1, 2], start: "08:30", end: "16:00", buffer: 5 });
  // An end before the start, a bad time, a buffer out of range: the defaults for those.
  assert.deepEqual(readWorkingHours({ start: "17:00", end: "09:00", buffer: 600 }), DEFAULT_HOURS);
  assert.deepEqual(readWorkingHours({ start: "25:00", days: [] }), DEFAULT_HOURS);
});

test("findSlots: three slots, inside working hours, on quarter hours, one per day", () => {
  const slots = findSlots(base());
  assert.equal(slots.length, 3);
  const days = new Set(slots.map((s) => local(s.start).slice(0, 10)));
  assert.equal(days.size, 3);
  for (const s of slots) {
    const p = zonedParts(new Date(s.start), LON);
    assert.ok(p.hour >= 9 && local(s.end).slice(11) <= "18:00", local(s.start));
    assert.equal(p.minute % 15, 0);
    assert.equal(s.end - s.start, 30 * 60_000);
  }
  // Best first.
  assert.ok(slots[0].score >= slots[1].score && slots[1].score >= slots[2].score);
});

test("findSlots: nothing before now plus the lead time, nothing at the weekend", () => {
  const now = at("2026-11-13T16:50:00Z"); // Friday 16:50
  const slots = findSlots(base({ now, from: now, to: at("2026-11-16T23:00:00Z") }));
  assert.ok(slots.length > 0);
  for (const s of slots) {
    assert.ok(s.start >= now + LEAD_MINUTES * 60_000);
    assert.ok(![0, 6].includes(new Date(s.start).getUTCDay()), local(s.start));
  }
  // Friday has 17:30 left (16:50 + 30 min lead → 17:30, ends 18:00); Monday the rest.
  assert.ok(slots.some((s) => local(s.start) === "2026-11-13 17:30"));
});

test("findSlots: keeps the buffer around meetings", () => {
  // One day only, busy 09:00–17:00 apart from 12:00–12:40.
  const busy = [
    { start: at("2026-11-10T09:00:00Z"), end: at("2026-11-10T12:00:00Z"), kind: "event" as const },
    { start: at("2026-11-10T12:40:00Z"), end: at("2026-11-10T17:00:00Z"), kind: "event" as const },
  ];
  const day = { from: at("2026-11-10T00:00:00Z"), to: at("2026-11-11T00:00:00Z") };
  // 40 minutes free, 10 either side kept clear: no 30-minute slot fits there, only 17:15 onwards.
  const slots = findSlots(base({ ...day, busy, count: 5 }));
  assert.ok(slots.every((s) => s.start >= at("2026-11-10T17:10:00Z")), slots.map((s) => local(s.start)).join());
  // With no buffer, 12:00 fits.
  const tight = findSlots(base({ ...day, busy, hours: { ...DEFAULT_HOURS, buffer: 0 }, count: 5 }));
  assert.ok(tight.some((s) => local(s.start) === "2026-11-10 12:00"));
});

test("findSlots: a slot never overlaps a meeting, and sits next to one when it can", () => {
  const busy = [{ start: at("2026-11-10T10:00:00Z"), end: at("2026-11-10T11:00:00Z"), kind: "event" as const }];
  const slots = findSlots(base({ from: at("2026-11-10T00:00:00Z"), to: at("2026-11-11T00:00:00Z"), busy, count: 1 }));
  assert.equal(slots.length, 1);
  assert.ok(slots[0].start >= at("2026-11-10T11:10:00Z") || slots[0].end <= at("2026-11-10T09:50:00Z"));
});

test("findSlots: travel days are skipped and flights get a wide berth", () => {
  const travel = busyFromTravel(
    [
      { kind: "flight", starts_at: "2026-11-10T07:10:00Z", ends_at: "2026-11-10T09:45:00Z", start_date: "2026-11-10" },
      { kind: "hotel", starts_at: "2026-11-10T15:00:00Z", ends_at: "2026-11-12T11:00:00Z", start_date: "2026-11-10" },
      { kind: "train", status: "cancelled", starts_at: "2026-11-11T09:00:00Z", ends_at: "2026-11-11T11:00:00Z", start_date: "2026-11-11" },
    ],
    [{ starts_on: "2026-11-10", ends_on: "2026-11-12" }],
    LON,
  );
  assert.deepEqual(travel.blockedDays, ["2026-11-10"]);
  assert.deepEqual(travel.awayDays, ["2026-11-11", "2026-11-12"]);
  assert.equal(travel.busy.length, 1);
  const slots = findSlots(base({ ...travel, count: 5 }));
  assert.ok(slots.every((s) => local(s.start).slice(0, 10) !== "2026-11-10"));
  // Away days score lower, so Monday, Friday and Thursday… come before them.
  assert.ok(!["2026-11-11", "2026-11-12"].includes(local(slots[0].start).slice(0, 10)));
  // A leg's buffer: an hour clear after landing.
  const one = findSlots(base({ busy: travel.busy, from: at("2026-11-10T00:00:00Z"), to: at("2026-11-11T00:00:00Z"), count: 30 }));
  assert.ok(one.every((s) => s.start >= at("2026-11-10T09:45:00Z") + TRAVEL_BUFFER * 60_000));
});

test("busyFromEvents: declined, cancelled, free and ordinary all-day events don't count; out of office blocks the day", () => {
  const r = busyFromEvents(
    [
      { start: "2026-11-10T10:00:00Z", end: "2026-11-10T11:00:00Z", summary: "Design review" },
      { start: "2026-11-10T12:00:00Z", end: "2026-11-10T13:00:00Z", myResponse: "declined" },
      { start: "2026-11-10T14:00:00Z", end: "2026-11-10T15:00:00Z", status: "cancelled" },
      { start: "2026-11-10T15:00:00Z", end: "2026-11-10T16:00:00Z", free: true },
      { start: "2026-11-11", end: "2026-11-12", allDay: true, summary: "Sam's birthday" },
      { start: "2026-11-12", end: "2026-11-14", allDay: true, eventType: "outOfOffice", summary: "Away" },
      { start: "2026-11-16", end: "2026-11-17", allDay: true, summary: "Annual leave" },
      { start: "2026-11-17T08:00:00Z", end: "2026-11-17T18:00:00Z", eventType: "outOfOffice" },
    ],
    LON,
  );
  assert.deepEqual(r.busy, [{ start: at("2026-11-10T10:00:00Z"), end: at("2026-11-10T11:00:00Z"), kind: "event" }]);
  assert.deepEqual(r.blockedDays, ["2026-11-12", "2026-11-13", "2026-11-16", "2026-11-17"]);
  const slots = findSlots(base({ ...r, to: at("2026-11-18T00:00:00Z"), count: 10 }));
  assert.ok(slots.every((s) => !r.blockedDays.includes(local(s.start).slice(0, 10))));
});

test("findSlots: a guest's busy times are avoided, without a buffer", () => {
  const day = { from: at("2026-11-10T00:00:00Z"), to: at("2026-11-11T00:00:00Z") };
  const guests = [{ who: "priya@example.com", busy: [{ start: at("2026-11-10T09:00:00Z"), end: at("2026-11-10T15:00:00Z") }] }];
  const slots = findSlots(base({ ...day, guests, count: 30 }));
  assert.ok(slots.length > 0);
  assert.ok(slots.every((s) => s.start >= at("2026-11-10T15:00:00Z")));
  assert.ok(slots.some((s) => s.start === at("2026-11-10T15:00:00Z")));
});

test("findSlots: a guest's own working hours, in their zone", () => {
  // Priya works 09:00–17:00 in New York (EST, UTC-5): 14:00–22:00 UTC. London is 09:00–18:00 UTC in November.
  const guests = [{ who: "priya@example.com", busy: [], hours: { days: [1, 2, 3, 4, 5], start: "09:00", end: "17:00", tz: "America/New_York" } }];
  const slots = findSlots(base({ guests, count: 10 }));
  assert.ok(slots.length > 0);
  for (const s of slots) assert.ok(s.start >= at(`${local(s.start).slice(0, 10)}T14:00:00Z`), local(s.start));
});

test("findSlots: working hours are the owner's wall clock across a clock change", () => {
  // New York changes on Sunday 1 Nov 2026; Tokyo never does. 09:00 local either way.
  for (const tz of ["America/New_York", "Asia/Tokyo"]) {
    const now = at("2026-10-29T00:00:00Z");
    const slots = findSlots(base({ tz, now, from: now, to: at("2026-11-04T00:00:00Z"), count: 10 }));
    assert.ok(slots.length >= 3);
    for (const s of slots) {
      const p = zonedParts(new Date(s.start), tz);
      assert.ok(p.hour >= 9 && p.hour * 60 + p.minute + 30 <= 18 * 60, `${tz} ${p.date} ${p.time}`);
    }
  }
});

test("findSlots: nothing fits, nothing comes back", () => {
  assert.deepEqual(findSlots(base({ minutes: 10 * 60 })), []);
  assert.deepEqual(findSlots(base({ minutes: 0 })), []);
  assert.deepEqual(findSlots(base({ to: MON - 1 })), []);
  assert.deepEqual(findSlots(base({ hours: { ...DEFAULT_HOURS, days: [6] }, to: at("2026-11-13T23:00:00Z") })), []);
});

test("findSlots: prefers late morning on the hour to the first thing", () => {
  const [best] = findSlots(base({ from: at("2026-11-10T00:00:00Z"), to: at("2026-11-11T00:00:00Z"), count: 1 }));
  const p = zonedParts(new Date(best.start), LON);
  assert.equal(p.minute, 0);
  assert.ok(p.hour >= 10 && p.hour < 12, p.time);
});

test("findSlots: an hour-long meeting spreads over three days and none overlap", () => {
  const slots = findSlots(base({ minutes: 60, count: 3 }));
  assert.equal(slots.length, 3);
  for (let i = 0; i < slots.length; i++) for (let j = i + 1; j < slots.length; j++) assert.ok(slots[i].end <= slots[j].start || slots[j].end <= slots[i].start);
});

test("findSlots: when only one day is open, the next best on that day, never overlapping", () => {
  const slots = findSlots(base({ from: at("2026-11-10T00:00:00Z"), to: at("2026-11-11T00:00:00Z"), count: 3 }));
  assert.equal(slots.length, 3);
  const sorted = [...slots].sort((a, b) => a.start - b.start);
  for (let i = 1; i < sorted.length; i++) assert.ok(sorted[i - 1].end <= sorted[i].start);
});
