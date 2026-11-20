import assert from "node:assert/strict";
import { test } from "node:test";
import {
  batchByFlow,
  datedDays,
  dueBeforeDate,
  dueBeforeEvent,
  dueSchedule,
  pickValues,
  queueFlowRuns,
  startFlowEvent,
  timedRange,
  triggerGives,
  type ActiveFlow,
  type DatedItem,
  type FlowClaims,
  type FlowTriggerDeps,
  type TimedItem,
} from "./flow-triggers";
import { onOwnerEvent } from "./team-triggers";
import type { FlowStarter, FlowTrigger } from "./flow-types";
import type { TeamEventRow } from "./team-events";

const TZ = "Europe/London";
const OLD = "2026-10-01T09:00:00Z";

const flow = (id: string, trigger: FlowTrigger, created_at = OLD): ActiveFlow => ({ id, name: `Flow ${id}`, trigger, assistant_id: null, created_at });

// ---------- fakes ----------

function fakeClaims(events: TeamEventRow[] = []): FlowClaims & { fires: Set<string>; pending: TeamEventRow[] } {
  const fires = new Set<string>();
  const pending = [...events];
  return {
    fires,
    pending,
    async fire(flowId, key) {
      const k = `${flowId}|${key}`;
      if (fires.has(k)) return false;
      fires.add(k);
      return true;
    },
    async release(flowId, key) {
      fires.delete(`${flowId}|${key}`);
    },
    async events(limit) {
      return pending.splice(0, limit);
    },
    async event(id) {
      const i = pending.findIndex((e) => e.id === id);
      return i < 0 ? null : pending.splice(i, 1)[0];
    },
  };
}

type Started = { flowId: string } & Parameters<FlowStarter["start"]>[1];
function fakeStarter(opts: { fail?: boolean } = {}): FlowStarter & { started: Started[] } {
  const started: Started[] = [];
  return {
    started,
    async start(flowId, start) {
      if (opts.fail) throw new Error("engine down");
      started.push({ flowId, ...start });
      return `run-${started.length}`;
    },
  };
}

function deps(flows: ActiveFlow[], o: { timed?: TimedItem[]; dated?: DatedItem[]; events?: TeamEventRow[]; starter?: FlowStarter & { started: Started[] }; items?: FlowTriggerDeps["items"] } = {}) {
  const claims = fakeClaims(o.events);
  const starter = o.starter ?? fakeStarter();
  const asked = { timed: 0, dated: [] as string[][] };
  const d: FlowTriggerDeps = {
    source: { listActive: async () => flows },
    starter,
    tz: TZ,
    claims,
    calendar: {
      async timed(from, to) {
        asked.timed++;
        return (o.timed ?? []).filter((e) => Date.parse(e.starts_at) >= from.getTime() && Date.parse(e.starts_at) <= to.getTime());
      },
      async dated(dates) {
        asked.dated.push(dates);
        return (o.dated ?? []).filter((x) => dates.includes(x.date));
      },
    },
    items: o.items,
  };
  return { d, claims, starter, asked };
}

const ev = (id: number, facets: TeamEventRow["facets"], o: Partial<TeamEventRow> = {}): TeamEventRow => ({
  id: String(id),
  kind: "collected",
  ref_id: `ref-${id}`,
  ref_kind: "note",
  facets,
  created_at: "2026-11-20T09:00:00.000Z",
  ...o,
});

// ---------- schedule ----------

test("schedule: due in its slot, once across overlapping passes, with the date and time", async () => {
  // Friday 20 November 2026, 16:02 in London (GMT).
  const now = new Date("2026-11-20T16:02:00Z");
  const f = flow("a", { kind: "schedule", days: [5], time: "16:00" });
  const { d, starter } = deps([f]);
  const first = await queueFlowRuns(d, now);
  const second = await queueFlowRuns(d, new Date("2026-11-20T16:07:00Z"));
  assert.equal(first.length, 1);
  assert.equal(second.length, 0);
  assert.equal(starter.started[0].slot, "2026-11-20T16:00:00.000Z");
  assert.equal(starter.started[0].label, "Every Friday at 16:00");
  assert.deepEqual(starter.started[0].values, { date: "2026-11-20", time: "2026-11-20T16:00:00.000Z" });
});

test("schedule: a slot more than the run window late is skipped, and so is one from before the flow", () => {
  const t: Extract<FlowTrigger, { kind: "schedule" }> = { kind: "schedule", days: [5], time: "08:00" };
  assert.equal(dueSchedule(t, { created_at: OLD }, new Date("2026-11-20T09:20:00Z"), TZ)?.toISOString(), "2026-11-20T08:00:00.000Z");
  assert.equal(dueSchedule(t, { created_at: OLD }, new Date("2026-11-20T09:31:00Z"), TZ), null);
  assert.equal(dueSchedule(t, { created_at: "2026-11-20T08:30:00Z" }, new Date("2026-11-20T08:40:00Z"), TZ), null);
  assert.equal(dueSchedule({ ...t, time: "not a time" }, { created_at: OLD }, new Date("2026-11-20T08:05:00Z"), TZ), null);
});

test("schedule: a run that can't start gives its claim back for the next pass", async () => {
  const now = new Date("2026-11-20T16:02:00Z");
  const f = flow("a", { kind: "schedule", days: [5], time: "16:00" });
  const broken = deps([f], { starter: fakeStarter({ fail: true }) });
  assert.equal((await queueFlowRuns(broken.d, now)).length, 0);
  assert.equal(broken.claims.fires.size, 0);
});

// ---------- before an event ----------

const meeting: TimedItem = { id: "ev-1", title: "Design review", starts_at: "2026-11-20T14:00:00.000Z", people: [{ id: "p-1", name: "Sam Carter" }] };
const solo: TimedItem = { id: "ev-2", title: "Focus time", starts_at: "2026-11-20T14:00:00.000Z", people: [] };

test("before/event: fires from X minutes before until the start, never after", () => {
  const t: Extract<FlowTrigger, { kind: "before"; what: "event" }> = { kind: "before", what: "event", minutes: 15 };
  assert.equal(dueBeforeEvent(t, { created_at: OLD }, [meeting], new Date("2026-11-20T13:44:00Z")).length, 0);
  assert.equal(dueBeforeEvent(t, { created_at: OLD }, [meeting], new Date("2026-11-20T13:45:00Z")).length, 1);
  assert.equal(dueBeforeEvent(t, { created_at: OLD }, [meeting], new Date("2026-11-20T13:59:00Z")).length, 1);
  assert.equal(dueBeforeEvent(t, { created_at: OLD }, [meeting], new Date("2026-11-20T14:01:00Z")).length, 0);
  // A long lead still stops at the run window.
  const day = { ...t, minutes: 24 * 60 };
  assert.equal(dueBeforeEvent(day, { created_at: OLD }, [meeting], new Date("2026-11-19T15:29:00Z")).length, 1);
  assert.equal(dueBeforeEvent(day, { created_at: OLD }, [meeting], new Date("2026-11-19T15:31:00Z")).length, 0);
});

test("before/event: withPeople leaves out events with nobody from People; match is on the title", () => {
  const now = new Date("2026-11-20T13:50:00Z");
  const t: Extract<FlowTrigger, { kind: "before"; what: "event" }> = { kind: "before", what: "event", minutes: 15, withPeople: true };
  assert.deepEqual(dueBeforeEvent(t, { created_at: OLD }, [meeting, solo], now).map((x) => x.item.id), ["ev-1"]);
  assert.deepEqual(dueBeforeEvent({ ...t, withPeople: false }, { created_at: OLD }, [meeting, solo], now).map((x) => x.item.id), ["ev-1", "ev-2"]);
  assert.deepEqual(dueBeforeEvent({ ...t, withPeople: false, match: "FOCUS" }, { created_at: OLD }, [meeting, solo], now).map((x) => x.item.id), ["ev-2"]);
});

test("before/event: nothing for a time from before the flow was made", () => {
  const t: Extract<FlowTrigger, { kind: "before"; what: "event" }> = { kind: "before", what: "event", minutes: 15 };
  assert.equal(dueBeforeEvent(t, { created_at: "2026-11-20T13:50:00Z" }, [meeting], new Date("2026-11-20T13:55:00Z")).length, 0);
});

test("before/event: a pass reads only as far ahead as the longest lead, and starts one run per event, once", async () => {
  const now = new Date("2026-11-20T13:50:00Z");
  const f = flow("b", { kind: "before", what: "event", minutes: 15, withPeople: true });
  assert.equal(timedRange([{ kind: "schedule", days: [1], time: "09:00" }], now), null);
  assert.equal(timedRange([f.trigger], now)?.to.toISOString(), "2026-11-20T14:05:00.000Z");
  const { d, starter } = deps([f], { timed: [meeting, solo] });
  await queueFlowRuns(d, now);
  await queueFlowRuns(d, new Date("2026-11-20T13:55:00Z"));
  assert.equal(starter.started.length, 1);
  assert.equal(starter.started[0].label, "Before “Design review” at 14:00");
  assert.deepEqual(starter.started[0].values, {
    event: { id: "ev-1", title: "Design review" },
    people: [{ id: "p-1", name: "Sam Carter" }],
    starts_at: "2026-11-20T14:00:00.000Z",
    title: "Design review",
  });
});

// ---------- before a date ----------

const birthday: DatedItem = { source: "event", id: "ev-9", title: "Alex Morgan's birthday", kind: "birthday", date: "2026-11-23", person: { id: "p-9", name: "Alex Morgan" }, years: 40 };
const renewal: DatedItem = { source: "renewal", id: "as-1", title: "Car insurance", kind: "renewal", date: "2026-11-27", company: "Northwind Insurance" };

test("before/date: N days before, at HH:MM in the owner's zone, within the run window", () => {
  const t: Extract<FlowTrigger, { kind: "before"; what: "date" }> = { kind: "before", what: "date", days: 3, at: "09:00", eventKind: "birthday" };
  assert.equal(dueBeforeDate(t, { created_at: OLD }, [birthday], new Date("2026-11-20T08:59:00Z"), TZ).length, 0);
  const [hit] = dueBeforeDate(t, { created_at: OLD }, [birthday], new Date("2026-11-20T09:00:00Z"), TZ);
  assert.equal(hit.key, "before-date:event:ev-9:2026-11-23");
  assert.equal(dueBeforeDate(t, { created_at: OLD }, [birthday], new Date("2026-11-20T10:31:00Z"), TZ).length, 0);
  // In British Summer Time 09:00 is 08:00 UTC.
  const summer = { ...birthday, date: "2026-07-13" };
  assert.equal(dueBeforeDate(t, { created_at: "2026-01-01T00:00:00Z" }, [summer], new Date("2026-07-10T08:05:00Z"), TZ).length, 1);
});

test("before/date: eventKind filters; renewals only when asked for; nothing before the flow existed", () => {
  const now = new Date("2026-11-20T09:05:00Z");
  const any: Extract<FlowTrigger, { kind: "before"; what: "date" }> = { kind: "before", what: "date", days: 7, at: "09:00" };
  assert.deepEqual(dueBeforeDate(any, { created_at: OLD }, [renewal], now, TZ), []);
  assert.equal(dueBeforeDate({ ...any, eventKind: "renewal" }, { created_at: OLD }, [renewal], now, TZ).length, 1);
  assert.equal(dueBeforeDate({ ...any, eventKind: "deadline" }, { created_at: OLD }, [renewal], now, TZ).length, 0);
  assert.equal(dueBeforeDate({ ...any, eventKind: "renewal", match: "passport" }, { created_at: OLD }, [renewal], now, TZ).length, 0);
  assert.equal(dueBeforeDate({ ...any, eventKind: "renewal" }, { created_at: "2026-11-20T09:01:00Z" }, [renewal], now, TZ).length, 0);
});

test("before/date: reads only the days it needs, and gives a renewal's company and date", async () => {
  const now = new Date("2026-11-20T09:05:00Z");
  const f = flow("c", { kind: "before", what: "date", days: 7, at: "09:00", eventKind: "renewal" });
  assert.deepEqual(datedDays([f.trigger], now, TZ), ["2026-11-26", "2026-11-27"]);
  const { d, starter, asked } = deps([f], { dated: [renewal, birthday] });
  await queueFlowRuns(d, now);
  await queueFlowRuns(d, new Date("2026-11-20T09:10:00Z"));
  assert.equal(asked.timed, 0);
  assert.equal(starter.started.length, 1);
  assert.equal(starter.started[0].label, "“Car insurance” in 7 days");
  assert.deepEqual(starter.started[0].values, { item: "Car insurance", company: { id: null, name: "Northwind Insurance" }, renewal_date: "2026-11-27", title: "Car insurance" });
});

// ---------- events ----------

test("event: one flow's matching events in a pass make one run; nothing from before the flow", async () => {
  const renewalFlow = flow("e", { kind: "event", event: { source: "collected", kind: "renewal" } });
  const emailFlow = flow("m", { kind: "event", event: { source: "collected", kind: "email" } }, "2026-11-20T09:30:00Z");
  const events = [
    ev(1, { kind: "renewal", title: "Car insurance renews 2026-12-01", email: true }, { ref_kind: "asset" }),
    ev(2, { kind: "issue", title: "Fix the login page", connector: "linear" }),
    ev(3, { kind: "renewal", title: "Broadband renews 2026-12-14", email: true }, { ref_kind: "asset" }),
  ];
  const items: FlowTriggerDeps["items"] = async (e) => (e.id === "3" ? { item: "Broadband", company: { id: null, name: "Example Broadband" }, renewal_date: "2026-12-14" } : {});
  const { d, starter, claims } = deps([renewalFlow, emailFlow], { events, items });
  const out = await queueFlowRuns(d, new Date("2026-11-20T10:00:00Z"));
  assert.equal(out.length, 1);
  assert.equal(claims.pending.length, 0);
  const run = starter.started[0];
  assert.equal(run.flowId, "e");
  assert.deepEqual(run.event_ids, ["1", "3"]);
  assert.deepEqual(run.values, { item: "Broadband", company: { id: null, name: "Example Broadband" }, renewal_date: "2026-12-14", title: "Broadband renews 2026-12-14", count: 2 });
});

test("event: batches follow Team's filter, tags and saved actions included", () => {
  const tagged = flow("t", { kind: "event", event: { source: "note", tag: "#Recipe" } });
  const gift = flow("g", { kind: "event", event: { source: "saved", savedAction: "gift idea" } });
  const batches = batchByFlow(
    [
      ev(5, { title: "Lentil soup", tags: ["recipe"] }, { kind: "note" }),
      ev(4, { savedAction: "gift-idea", title: "Board game" }, { kind: "saved" }),
      ev(6, { title: "Standup", tags: ["work"] }, { kind: "note" }),
    ],
    [tagged, gift],
  );
  assert.deepEqual(batches.map((b) => [b.flow.id, b.events.map((e) => e.id)]), [["g", ["4"]], ["t", ["5"]]]);
});

test("owner actions start at once, and a pass doesn't start them again", async () => {
  const tagged = flow("t", { kind: "event", event: { source: "note", tag: "recipe" } });
  const { d, starter } = deps([tagged], { events: [ev(7, { title: "Lentil soup", tags: ["recipe"], kind: "note" }, { kind: "note" })] });
  const remove = onOwnerEvent((id) => startFlowEvent(d, id));
  try {
    const now = await startFlowEvent(d, "7");
    assert.equal(now.length, 1);
    assert.equal(starter.started[0].label, "New note: “Lentil soup”");
    assert.deepEqual(starter.started[0].values, { item: { id: "ref-7", kind: "note", title: "Lentil soup" }, tags: "recipe", title: "Lentil soup", count: 1 });
    assert.equal((await startFlowEvent(d, "7")).length, 0);
    assert.equal((await queueFlowRuns(d, new Date("2026-11-20T10:00:00Z"))).length, 0);
  } finally {
    remove();
  }
});

test("owner actions are left for the pass when no flow waits for events", async () => {
  const { d, claims } = deps([flow("a", { kind: "schedule", days: [1], time: "09:00" })], { events: [ev(8, { title: "x" }, { kind: "note" })] });
  assert.equal((await startFlowEvent(d, "8")).length, 0);
  assert.equal(claims.pending.length, 1);
});

// ---------- what each trigger gives ----------

test("triggerGives: what each kind gives later steps", () => {
  const keys = (t: FlowTrigger) => triggerGives(t).map((v) => `${v.key}:${v.kind}`);
  assert.deepEqual(keys({ kind: "schedule", days: [1], time: "09:00" }), ["date:date", "time:datetime"]);
  assert.deepEqual(keys({ kind: "before", what: "event", minutes: 15 }), ["event:event", "people:person", "starts_at:datetime", "title:text"]);
  assert.deepEqual(keys({ kind: "before", what: "date", days: 3, at: "09:00", eventKind: "birthday" }), ["event:event", "person:person", "date:date", "years:number", "title:text"]);
  assert.deepEqual(keys({ kind: "event", event: { source: "collected", kind: "renewal" } }), ["item:text", "company:organisation", "renewal_date:date", "title:text", "count:number"]);
  assert.deepEqual(keys({ kind: "event", event: { source: "collected", kind: "email" } }), ["item:email", "title:text", "count:number"]);
  assert.deepEqual(keys({ kind: "manual" }), ["date:date"]);
  // Labels read as chips: lower case, "the …".
  for (const t of [{ kind: "before", what: "event", minutes: 5 }, { kind: "event", event: { source: "saved" } }] as FlowTrigger[]) {
    for (const v of triggerGives(t)) assert.match(v.label, /^(the|what|who|when|how) [a-z' -]+$/);
  }
});

test("pickValues keeps only what the trigger gives, and only what's known", () => {
  const t: FlowTrigger = { kind: "event", event: { source: "collected", kind: "renewal" } };
  assert.deepEqual(pickValues(t, { item: "Passport", company: null, renewal_date: "2027-03-01", website: "example.com", count: 1 }), { item: "Passport", renewal_date: "2027-03-01", count: 1 });
});
