// Run: npx tsx --test lib/live-travel.test.ts
// The two live clients (netlify/lib/live-travel.ts) against recorded answers, with fetch stubbed: no network.
// Then the words (lib/live-travel-text.ts): the push, the briefing line, the card's chip.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { clearLiveCache, commuteDisruptions, lineStatuses, liveTravelConfigured, readService, trainStatus, TFL_STATUS_URL } from "../netlify/lib/live-travel";
import { liveCandidate, lineLine, trainBriefingLine, trainChip, trainLiveLine, trainPush, type TrainStatus } from "./live-travel-text";
import type { BookingLike } from "./trip-text";

const RDM = JSON.parse(readFileSync(new URL("./fixtures/rdm-departures-pad-bri.json", import.meta.url), "utf8"));
const TFL = JSON.parse(readFileSync(new URL("./fixtures/tfl-line-status.json", import.meta.url), "utf8"));

const NOW = new Date("2026-11-09T06:45:00Z"); // 06:45 in London (GMT in November)
const keys = (k: Record<string, string>) => (name: string) => k[name];
const BOTH = keys({ ATHENA_RDM_KEY: "rdm-test", ATHENA_TFL_KEY: "tfl-test" });

function train(over: Partial<BookingLike> = {}): BookingLike {
  return {
    id: "b1",
    kind: "train",
    status: "confirmed",
    title: "GWR to Bristol",
    provider: "Great Western Railway",
    reference: "TL4K88QW",
    start_date: "2026-11-09",
    starts_at: "2026-11-09T07:10:00Z",
    start_tz: "Europe/London",
    start_place: "London Paddington",
    start_city: "London",
    end_date: "2026-11-09",
    ends_at: "2026-11-09T08:46:00Z",
    end_tz: "Europe/London",
    end_place: "Bristol Temple Meads",
    end_city: "Bristol",
    seat: "Coach B, seat 32",
    ...over,
  };
}

function recorder(body: unknown, status = 200) {
  const calls: Array<{ url: URL; headers: Record<string, string> }> = [];
  const fetch = (async (input: string | URL, init?: RequestInit) => {
    calls.push({ url: new URL(String(input)), headers: { ...((init?.headers as Record<string, string> | undefined) ?? {}) } });
    assert.ok(init?.signal, "every request has a timeout");
    return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
  }) as typeof globalThis.fetch;
  return { calls, fetch };
}

beforeEach(() => clearLiveCache());

test("no key, no feature: nothing is fetched and nothing goes wrong", async () => {
  const { calls, fetch } = recorder(RDM);
  const env = keys({});
  assert.deepEqual(liveTravelConfigured({ env }), { trains: false, lines: false });
  assert.equal(await trainStatus(train(), { fetch, env, now: NOW }), null);
  assert.equal(await lineStatuses({ fetch, env, now: NOW }), null);
  assert.deepEqual(await commuteDisruptions(["elizabeth"], { fetch, env, now: NOW }), []);
  assert.equal(calls.length, 0);
});

test("a late train: the board at Paddington, filtered to Bristol, sends only station codes and a window", async () => {
  const { calls, fetch } = recorder(RDM);
  const s = await trainStatus(train(), { fetch, env: BOTH, now: NOW });
  assert.deepEqual(s, {
    from: "PAD",
    to: "BRI",
    scheduled: "07:10",
    expected: "07:22",
    late: 12,
    state: "late",
    platform: "4",
    destination: "Bristol Temple Meads",
    reason: "This train has been delayed by a fault with the signalling system",
    checked_at: NOW.toISOString(),
  });
  assert.equal(calls.length, 1);
  const { url, headers } = calls[0];
  assert.equal(url.host, "api1.raildata.org.uk");
  assert.match(url.pathname, /\/GetDepartureBoard\/PAD$/);
  assert.equal(url.searchParams.get("filterCrs"), "BRI");
  assert.equal(url.searchParams.get("filterType"), "to");
  assert.equal(headers["x-apikey"], "rdm-test");
  // 25 minutes ahead: the window starts at 0 and covers the hour after.
  assert.equal(url.searchParams.get("timeOffset"), "0");
  // Nothing about the owner: no reference, seat, name or booking id anywhere in the request.
  for (const secret of ["TL4K88QW", "Coach", "b1", "GWR"]) assert.ok(!url.toString().includes(secret), secret);
});

test("cached for 2 minutes, then asked again", async () => {
  const { calls, fetch } = recorder(RDM);
  await trainStatus(train(), { fetch, env: BOTH, now: NOW });
  await trainStatus(train(), { fetch, env: BOTH, now: new Date(NOW.getTime() + 60_000) });
  assert.equal(calls.length, 1);
  await trainStatus(train(), { fetch, env: BOTH, now: new Date(NOW.getTime() + 121_000) });
  assert.equal(calls.length, 2);
});

test("on time, cancelled, delayed with no estimate, and a time that rounded", async () => {
  const { fetch } = recorder(RDM);
  const at = (t: string) => train({ starts_at: `2026-11-09T${t}:00Z` });
  const onTime = await trainStatus(at("06:57"), { fetch, env: BOTH, now: NOW });
  assert.equal(onTime?.state, "on_time");
  assert.equal(onTime?.platform, "2");
  const cancelled = await trainStatus(at("07:41"), { fetch, env: BOTH, now: NOW });
  assert.equal(cancelled?.state, "cancelled");
  assert.equal(cancelled?.platform, null);
  assert.match(cancelled?.reason ?? "", /shortage of train crew/);
  const delayed = await trainStatus(at("08:00"), { fetch, env: BOTH, now: NOW });
  assert.equal(delayed?.state, "delayed");
  // An email that said 07:11 for the 07:10.
  assert.equal((await trainStatus(at("07:11"), { fetch, env: BOTH, now: NOW }))?.scheduled, "07:10");
  // Not on the board at all.
  assert.equal(await trainStatus(at("07:20"), { fetch, env: BOTH, now: NOW }), null);
});

test("only trains in Great Britain leaving in the next 3 hours get asked about", async () => {
  const { calls, fetch } = recorder(RDM);
  const ask = (b: BookingLike) => trainStatus(b, { fetch, env: BOTH, now: NOW });
  assert.equal(await ask(train({ starts_at: "2026-11-09T10:30:00Z" })), null, "too far ahead");
  assert.equal(await ask(train({ starts_at: "2026-11-09T05:30:00Z" })), null, "long gone");
  assert.equal(await ask(train({ kind: "flight" })), null);
  assert.equal(await ask(train({ status: "cancelled" })), null);
  assert.equal(await ask(train({ start_tz: "Europe/Paris" })), null, "Eurostar from Paris");
  assert.equal(await ask(train({ start_place: "Somewhere Halt", start_city: "London" })), null, "a station we can't name");
  assert.equal(calls.length, 0);
  assert.ok(liveCandidate(train({ starts_at: "2026-11-09T09:40:00Z" }), NOW));
  assert.ok(!liveCandidate(train({ starts_at: "2026-11-09T09:50:00Z" }), NOW));
});

test("failures are null: a 500, a timeout, an answer we can't read", async () => {
  assert.equal(await trainStatus(train(), { fetch: recorder({}, 500).fetch, env: BOTH, now: NOW }), null);
  assert.equal(await trainStatus(train(), { fetch: recorder({ trainServices: null }).fetch, env: BOTH, now: NOW }), null);
  const hang = (async (_: unknown, init?: RequestInit) => {
    throw Object.assign(new Error("The operation was aborted due to timeout"), { name: "TimeoutError", signal: init?.signal });
  }) as typeof fetch;
  assert.equal(await trainStatus(train(), { fetch: hang, env: BOTH, now: NOW }), null);
  assert.equal(await lineStatuses({ fetch: hang, env: BOTH, now: NOW }), null);
});

test("the board's odd answers: a train late across midnight, no report", () => {
  const ctx = { from: "PAD", to: "BRI", destination: "Bristol Temple Meads", checkedAt: NOW };
  assert.equal(readService({ std: "23:55", etd: "00:07" }, ctx)?.late, 12);
  assert.equal(readService({ std: "07:10", etd: "07:08" }, ctx)?.state, "on_time");
  assert.equal(readService({ std: "07:10", etd: "No report" }, ctx), null);
  assert.equal(readService({ etd: "On time" }, ctx), null);
});

test("TfL: every line in one request with the app key, only the ones not running normally kept", async () => {
  const { calls, fetch } = recorder(TFL);
  const lines = await lineStatuses({ fetch, env: BOTH, now: NOW });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url.origin + calls[0].url.pathname, TFL_STATUS_URL);
  assert.equal(calls[0].url.searchParams.get("app_key"), "tfl-test");
  assert.deepEqual(
    lines?.map((l) => [l.id, l.name, l.description]),
    [
      ["central", "Central line", "minor delays"],
      ["waterloo-city", "Waterloo & City line", "service closed"],
      ["elizabeth", "Elizabeth line", "part suspended"],
    ],
  );
  // Mildmay's "No Issues" is fine; the Elizabeth line's worst status wins.
  assert.equal(lines?.find((l) => l.id === "elizabeth")?.severity, 3);
});

test("the commute: only the owner's lines, busiest first, only when not Good Service", async () => {
  const { fetch } = recorder(TFL);
  const got = await commuteDisruptions(["victoria", "elizabeth", "central"], { fetch, env: BOTH, now: NOW });
  assert.deepEqual(got.map(lineLine), ["Elizabeth line: part suspended", "Central line: minor delays"]);
  assert.deepEqual(await commuteDisruptions(["victoria", "jubilee"], { fetch, env: BOTH, now: NOW }), []);
  assert.deepEqual(await commuteDisruptions([], { fetch, env: BOTH, now: NOW }), []);
});

// ---------- the words ----------

const status = (over: Partial<TrainStatus> = {}): TrainStatus => ({
  from: "PAD",
  to: "BRI",
  scheduled: "07:10",
  expected: null,
  late: 0,
  state: "on_time",
  platform: "4",
  destination: "Bristol Temple Meads",
  reason: null,
  checked_at: NOW.toISOString(),
  ...over,
});

test("the push: status first, then the seat and the reference", () => {
  assert.equal(trainLiveLine(status()), "07:10 to Bristol Temple Meads: on time, platform 4");
  assert.equal(trainLiveLine(status({ state: "late", late: 12, expected: "07:22", platform: null })), "07:10 to Bristol Temple Meads: 12 min late");
  assert.deepEqual(trainPush(train(), status({ state: "late", late: 12, expected: "07:22" }), "Europe/London"), {
    title: "GWR to Bristol",
    body: "07:10 to Bristol Temple Meads: 12 min late, platform 4 · seat Coach B, seat 32 · ref TL4K88QW",
  });
  assert.equal(trainPush(train(), status({ state: "cancelled", platform: null }), "Europe/London").body, "07:10 to Bristol Temple Meads: cancelled · seat Coach B, seat 32 · ref TL4K88QW");
  // No live times: the push as it always was.
  assert.deepEqual(trainPush(train(), null, "Europe/London"), { title: "GWR to Bristol", body: "Departs 07:10 · London Paddington · seat Coach B, seat 32 · ref TL4K88QW" });
});

test("the briefing line and the card's chip", () => {
  assert.equal(trainBriefingLine(train(), status({ state: "late", late: 12 })), "07:10 London Paddington to Bristol Temple Meads: 12 min late, platform 4, ref TL4K88QW");
  assert.deepEqual(trainChip(status()), { label: "On time", platform: "4", tone: "good" });
  assert.deepEqual(trainChip(status({ state: "late", late: 12 })), { label: "12 min late", platform: "4", tone: "warn" });
  assert.deepEqual(trainChip(status({ state: "cancelled" })), { label: "Cancelled", platform: null, tone: "bad" });
  assert.deepEqual(trainChip(status({ state: "delayed", platform: null })), { label: "Delayed", platform: null, tone: "warn" });
});

// ---------- the briefing ----------

import { buildBriefing, type BriefingInput } from "./briefing";

function briefingWith(extra: Partial<BriefingInput>): ReturnType<typeof buildBriefing> {
  const trip = { id: "t1", title: "Bristol", starts_on: "2026-11-09", ends_on: "2026-11-09", bookings: [train()] };
  return buildBriefing({ now: NOW, tz: "Europe/London", events: [], people: [], catchUps: [], recentNotes: [], trips: [trip], ...extra });
}

test("briefing: today's train with its status, and the owner's lines only when they're not on Good Service", () => {
  const late = briefingWith({
    trainStatus: { b1: status({ state: "late", late: 12, expected: "07:22" }) },
    commute: [{ id: "elizabeth", name: "Elizabeth line", severity: 3, description: "part suspended", reason: null }],
  });
  assert.match(late.body, /## Travel\n- 07:10 London Paddington to Bristol Temple Meads: 12 min late, platform 4, ref TL4K88QW/);
  assert.match(late.body, /## Commute\n- Elizabeth line: part suspended/);
  assert.match(late.digest, /^07:10 London Paddington to Bristol Temple Meads: 12 min late, platform 4, ref TL4K88QW · Elizabeth line: part suspended/);
  assert.ok(late.hasReminders);

  // No live times and every line fine: the briefing as it was.
  const plain = briefingWith({});
  assert.match(plain.body, /## Travel\n- GWR to Bristol today 07:10 from London Paddington, ref TL4K88QW/);
  assert.doesNotMatch(plain.body, /Commute/);
});

// ---------- Ask's train_status ----------

import { TOOLS } from "./assistant";
import { trainStatusReport } from "./live-travel-text";
import { assistantStepDone, assistantStepStart, stepActs } from "./steps";

test("train_status is offered to Ask, read-only, with nothing required", () => {
  const tool = TOOLS.find((t) => t.name === "train_status");
  assert.ok(tool, "the tool is in TOOLS");
  assert.equal((tool!.input_schema as { required?: string[] }).required, undefined);
  assert.match(tool!.description ?? "", /Read-only/);
  assert.equal(stepActs("train_status"), false, "a look, not a change");
  assert.equal(assistantStepStart("train_status", {}), "Checking live train times");
  assert.equal(assistantStepDone("train_status", {}, "{}", []), "Checked live train times");
});

test("train_status: 'is my train on time?' gets the live line; otherwise it says why not", async () => {
  const later = train({ id: "b2", starts_at: "2026-11-09T17:30:00Z", title: "GWR to London", start_place: "Bristol Temple Meads", end_place: "London Paddington" });
  const deps = {
    now: NOW,
    today: "2026-11-09",
    tz: "Europe/London",
    on: { trains: true, lines: true },
    lookup: async (b: BookingLike) => (b.id === "b1" ? status({ state: "late", late: 12, expected: "07:22", reason: "Signalling fault" }) : null),
    commute: async () => [{ id: "elizabeth", name: "Elizabeth line", severity: 3, description: "part suspended", reason: null }],
  };
  assert.deepEqual(await trainStatusReport([train(), later], deps), {
    trains: [
      { booking_id: "b1", train: "GWR to Bristol today 07:10 from London Paddington, ref TL4K88QW", live: "07:10 to Bristol Temple Meads: 12 min late, platform 4", reason: "Signalling fault" },
      { booking_id: "b2", train: "GWR to London today 17:30 from Bristol Temple Meads, ref TL4K88QW", live: null, why: "Live times show from 3 hours before it leaves." },
    ],
    lines_not_good: ["Elizabeth line: part suspended"],
  });

  // No keys: it says so, and never asks.
  let asked = 0;
  const off = await trainStatusReport([train()], { ...deps, on: { trains: false, lines: false }, lookup: async () => (asked++, null) });
  assert.equal(asked, 0);
  assert.deepEqual(off, {
    trains: [{ booking_id: "b1", train: "GWR to Bristol today 07:10 from London Paddington, ref TL4K88QW", live: null, why: "Live train times aren't switched on (no Rail Data Marketplace key)." }],
    lines_note: "Tube line status isn't switched on (no TfL key).",
  });

  // A lookup that throws is no answer, not an error; no trains at all says so.
  const failed = await trainStatusReport([train()], { ...deps, lookup: async () => Promise.reject(new Error("boom")), commute: async () => Promise.reject(new Error("boom")) });
  assert.equal((failed.trains as Array<{ why: string }>)[0].why, "National Rail has nothing on it right now.");
  assert.deepEqual(failed.lines_not_good, []);
  assert.equal((await trainStatusReport([], deps)).trains_note, "No train bookings in the next 24 hours.");
});

// ---------- recorded answers (scripts/record-live-travel-fixtures.ts) ----------

import { existsSync } from "node:fs";
import { readLines } from "../netlify/lib/live-travel";

const recorded = (name: string) => new URL(`./fixtures/recorded/${name}`, import.meta.url);

test("recorded departure board: every service either reads as a status or is honestly unknown", { skip: !existsSync(recorded("rdm-departures.json")) && "not recorded yet" }, () => {
  const board = JSON.parse(readFileSync(recorded("rdm-departures.json"), "utf8")) as { trainServices?: Array<{ std?: string; etd?: string }> | null };
  for (const s of board.trainServices ?? []) {
    const got = readService(s, { from: "PAD", to: "BRI", destination: "Bristol Temple Meads", checkedAt: NOW });
    assert.ok(got === null || /^\d{2}:\d{2}$/.test(got.scheduled), JSON.stringify(s));
    if (got?.state === "late") assert.ok(got.late > 0);
  }
});

test("recorded TfL status: every line kept is a known line, not on Good Service", { skip: !existsSync(recorded("tfl-line-status.json")) && "not recorded yet" }, () => {
  const raw = JSON.parse(readFileSync(recorded("tfl-line-status.json"), "utf8"));
  assert.ok(Array.isArray(raw) && raw.length > 10);
  for (const l of readLines(raw)) {
    assert.notEqual(l.severity, 10);
    assert.ok(l.name && l.description, JSON.stringify(l));
  }
});

// ---------- keys from Sources (netlify/lib/travel-key.ts) ----------

import { liveTravelReady } from "../netlify/lib/live-travel";

const STORED_RDM = "stored-rdm-key-41c8";
const STORED_TFL = "stored-tfl-key-0d92";
const STORED = async () => ({ "national-rail": STORED_RDM, tfl: STORED_TFL });
const NONE = keys({});

async function logsOf(run: () => Promise<unknown>): Promise<string> {
  const lines: string[] = [];
  const saved = { error: console.error, warn: console.warn, log: console.log, info: console.info };
  for (const k of ["error", "warn", "log", "info"] as const) console[k] = (...a: unknown[]) => void lines.push(a.map((x) => (x instanceof Error ? `${x.name} ${x.message} ${x.stack}` : String(x))).join(" "));
  try {
    await run();
  } finally {
    Object.assign(console, saved);
  }
  return lines.join("\n");
}

test("keys pasted into Sources switch both halves on, with nothing in the environment, and are the ones sent", async () => {
  assert.deepEqual(await liveTravelReady({ env: NONE, stored: STORED }), { trains: true, lines: true });
  assert.deepEqual(await liveTravelReady({ env: NONE, stored: async () => ({}) }), { trains: false, lines: false });
  const rdm = recorder(RDM);
  assert.ok(await trainStatus(train(), { fetch: rdm.fetch, env: BOTH, stored: STORED, now: NOW }));
  assert.equal(rdm.calls[0].headers["x-apikey"], STORED_RDM, "the stored key wins over the environment's");
  const tfl = recorder(TFL);
  assert.ok(await lineStatuses({ fetch: tfl.fetch, env: NONE, stored: STORED, now: NOW }));
  assert.equal(tfl.calls[0].url.searchParams.get("app_key"), STORED_TFL);
});

test("a stored key never appears in an answer or a log line, when it works or when it's refused", async () => {
  const cases: Array<() => Promise<unknown>> = [
    () => trainStatus(train(), { fetch: recorder(RDM).fetch, env: NONE, stored: STORED, now: NOW }),
    () => lineStatuses({ fetch: recorder(TFL).fetch, env: NONE, stored: STORED, now: NOW }),
    () => trainStatus(train(), { fetch: recorder({ error: "bad key" }, 401).fetch, env: NONE, stored: STORED, now: NOW }),
    () => lineStatuses({ fetch: recorder({ message: "Invalid app_key" }, 403).fetch, env: NONE, stored: STORED, now: NOW }),
    () => commuteDisruptions(["central"], { fetch: (async () => { throw new TypeError("fetch failed"); }) as unknown as typeof fetch, env: NONE, stored: STORED, now: NOW }),
  ];
  for (const run of cases) {
    clearLiveCache();
    let out: unknown;
    const logs = await logsOf(async () => void (out = await run()));
    for (const key of [STORED_RDM, STORED_TFL]) {
      assert.ok(!logs.includes(key), `log line holds the key: ${logs}`);
      assert.ok(!JSON.stringify(out ?? null).includes(key));
    }
  }
});
