// Leave by's live directions: TfL in London, Google Routes elsewhere, the estimate otherwise; cached 10 minutes.
// Run: npx tsx --test netlify/lib/proactive/directions.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { liveRoute, readGoogle, readTfl, type Route, type RouteDeps } from "./directions";

const islington = { lat: 51.5362, lng: -0.1033 };
const kingsCross = { lat: 51.5354, lng: -0.1246 };
const bristol = { lat: 51.4545, lng: -2.5879 };
const clifton = { lat: 51.4645, lng: -2.6177 };
const now = new Date("2026-11-09T12:00:00Z");
const arrive = new Date("2026-11-09T13:00:00Z");

function memCache(): NonNullable<RouteDeps["cache"]> {
  const m = new Map<string, { at: number; route: Route | null }>();
  return { get: async (k) => m.get(k) ?? null, set: async (k, v) => void m.set(k, v) };
}

function stub(answers: Array<{ match: RegExp; body: unknown; status?: number }>) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const f = (async (url: string | URL, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    const a = answers.find((x) => x.match.test(String(url) + (init?.body ? String(init.body) : "")));
    return new Response(JSON.stringify(a?.body ?? {}), { status: a?.status ?? 200 });
  }) as typeof fetch;
  return { f, calls };
}

test("London: TfL's Journey Planner, arriving by the start, with only the two coordinates and the time", async () => {
  const { f, calls } = stub([{ match: /api\.tfl\.gov\.uk/, body: { journeys: [{ duration: 31, legs: [{ mode: { id: "walking" } }, { mode: { id: "tube" } }] }, { duration: 24, legs: [{ mode: { id: "bus" } }] }] } }]);
  const env = (k: string) => ({ ATHENA_TFL_KEY: "tfl-key", ATHENA_GOOGLE_ROUTES_KEY: "g-key" })[k];
  const r = await liveRoute(islington, kingsCross, arrive, "e1", { fetch: f, now, env, cache: memCache() });
  assert.deepEqual(r, { minutes: 24, mode: "transit", source: "tfl" });
  assert.equal(calls.length, 1);
  const u = new URL(calls[0].url);
  assert.equal(u.pathname, "/Journey/JourneyResults/51.53620,-0.10330/to/51.53540,-0.12460");
  assert.equal(u.searchParams.get("timeIs"), "Arriving");
  assert.equal(u.searchParams.get("time"), "1300");
  assert.equal(u.searchParams.get("date"), "20261109");
  assert.equal(u.searchParams.get("app_key"), "tfl-key");
  assert.deepEqual([...u.searchParams.keys()].sort(), ["app_key", "date", "mode", "time", "timeIs"]);
});

test("elsewhere: Google Routes, transit then walking, key in a header", async () => {
  const { f, calls } = stub([
    { match: /"travelMode":"TRANSIT"/, body: {} },
    { match: /"travelMode":"WALK"/, body: { routes: [{ duration: "1534s" }] } },
  ]);
  const env = (k: string) => ({ ATHENA_TFL_KEY: "tfl-key", ATHENA_GOOGLE_ROUTES_KEY: "g-key" })[k];
  const r = await liveRoute(bristol, clifton, arrive, "e2", { fetch: f, now, env, cache: memCache() });
  assert.deepEqual(r, { minutes: 26, mode: "walk", source: "google" });
  assert.equal(calls.length, 2);
  const h = calls[0].init!.headers as Record<string, string>;
  assert.equal(h["X-Goog-Api-Key"], "g-key");
  const body = JSON.parse(String(calls[0].init!.body));
  assert.deepEqual(Object.keys(body).sort(), ["arrivalTime", "destination", "origin", "travelMode"]);
  assert.equal(body.arrivalTime, "2026-11-09T13:00:00.000Z");
});

test("no planner, too far ahead, or no answer: null, and the caller keeps its estimate", async () => {
  const { f, calls } = stub([{ match: /./, body: {}, status: 500 }]);
  // No keys at all.
  assert.equal(await liveRoute(islington, kingsCross, arrive, "e3", { fetch: f, now, env: () => undefined, cache: memCache() }), null);
  // Outside London with only a TfL key.
  assert.equal(await liveRoute(bristol, clifton, arrive, "e3", { fetch: f, now, env: (k) => (k === "ATHENA_TFL_KEY" ? "k" : undefined), cache: memCache() }), null);
  assert.equal(calls.length, 0);
  // More than 90 minutes ahead: not asked.
  assert.equal(await liveRoute(islington, kingsCross, new Date("2026-11-09T14:00:00Z"), "e3", { fetch: f, now, env: () => "k", cache: memCache() }), null);
  assert.equal(calls.length, 0);
  // The planner fails: null.
  assert.equal(await liveRoute(islington, kingsCross, arrive, "e3", { fetch: f, now, env: () => "k", cache: memCache() }), null);
});

test("one call per event per 10 minutes", async () => {
  const { f, calls } = stub([{ match: /tfl/, body: { journeys: [{ duration: 20, legs: [{ mode: { id: "walking" } }] }] } }]);
  const deps = { fetch: f, env: () => "k", cache: memCache() };
  assert.deepEqual(await liveRoute(islington, kingsCross, arrive, "e4", { ...deps, now }), { minutes: 20, mode: "walk", source: "tfl" });
  await liveRoute(islington, kingsCross, arrive, "e4", { ...deps, now: new Date("2026-11-09T12:05:00Z") });
  assert.equal(calls.length, 1, "cached");
  await liveRoute(islington, kingsCross, arrive, "e4", { ...deps, now: new Date("2026-11-09T12:11:00Z") });
  assert.equal(calls.length, 2, "asked again after 10 minutes");
});

test("reading the answers", () => {
  assert.equal(readTfl({}), null);
  assert.equal(readGoogle({ routes: [] }, "transit"), null);
  assert.deepEqual(readGoogle({ routes: [{ duration: "59s" }] }, "transit"), { minutes: 1, mode: "transit", source: "google" });
});

// ---------- keys from Sources (travel-key.ts) ----------

/** Every console line written while `run` runs. */
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

const STORED_TFL = "stored-tfl-key-9f3a";
const STORED_GOOGLE = "stored-google-key-7b21";
const stored = async () => ({ tfl: STORED_TFL, "google-routes": STORED_GOOGLE });

test("a key pasted into Sources is used before the environment's, for TfL and for Google", async () => {
  const env = (k: string) => ({ ATHENA_TFL_KEY: "env-tfl", ATHENA_GOOGLE_ROUTES_KEY: "env-google" })[k];
  const t = stub([{ match: /api\.tfl\.gov\.uk/, body: { journeys: [{ duration: 18, legs: [{ mode: { id: "tube" } }] }] } }]);
  assert.deepEqual(await liveRoute(islington, kingsCross, arrive, "s1", { fetch: t.f, now, env, stored, cache: memCache() }), { minutes: 18, mode: "transit", source: "tfl" });
  assert.equal(new URL(t.calls[0].url).searchParams.get("app_key"), STORED_TFL);
  const g = stub([{ match: /"travelMode":"TRANSIT"/, body: { routes: [{ duration: "900s" }] } }]);
  assert.deepEqual(await liveRoute(bristol, clifton, arrive, "s2", { fetch: g.f, now, env, stored, cache: memCache() }), { minutes: 15, mode: "transit", source: "google" });
  assert.equal((g.calls[0].init?.headers as Record<string, string>)["X-Goog-Api-Key"], STORED_GOOGLE);
});

test("a stored key alone switches Leave by's planner on, with nothing in the environment", async () => {
  const t = stub([{ match: /api\.tfl\.gov\.uk/, body: { journeys: [{ duration: 12, legs: [{ mode: { id: "walking" } }] }] } }]);
  const r = await liveRoute(islington, kingsCross, arrive, "s3", { fetch: t.f, now, env: () => undefined, stored, cache: memCache() });
  assert.deepEqual(r, { minutes: 12, mode: "walk", source: "tfl" });
});

test("the key never appears in the answer, the cache or a log line, even when the planner fails", async () => {
  const kept: unknown[] = [];
  const cache: NonNullable<RouteDeps["cache"]> = { get: async () => null, set: async (_k, v) => void kept.push(v) };
  const answers: Array<{ f: typeof fetch; from: typeof islington; to: typeof islington }> = [
    { f: stub([{ match: /tfl/, body: { journeys: [{ duration: 20, legs: [] }] } }]).f, from: islington, to: kingsCross },
    { f: stub([{ match: /tfl/, body: { message: "bad key" }, status: 401 }]).f, from: islington, to: kingsCross },
    { f: stub([{ match: /routes/, body: { error: { message: "API key not valid" } }, status: 400 }]).f, from: bristol, to: clifton },
    { f: (async () => { throw new TypeError("fetch failed"); }) as unknown as typeof fetch, from: bristol, to: clifton },
  ];
  let i = 0;
  for (const a of answers) {
    let r: unknown;
    const logs = await logsOf(async () => void (r = await liveRoute(a.from, a.to, arrive, `leak${i++}`, { fetch: a.f, now, env: () => undefined, stored, cache })));
    for (const key of [STORED_TFL, STORED_GOOGLE]) {
      assert.ok(!logs.includes(key), `log line holds the key: ${logs}`);
      assert.ok(!JSON.stringify(r ?? null).includes(key));
    }
  }
  assert.ok(!JSON.stringify(kept).includes(STORED_TFL) && !JSON.stringify(kept).includes(STORED_GOOGLE));
});

test("Google is asked once per event: its answer is kept until the event starts, where TfL's is refreshed after 10 minutes", async () => {
  const g = stub([{ match: /"travelMode":"TRANSIT"/, body: { routes: [{ duration: "900s" }] } }]);
  const deps = { fetch: g.f, env: () => undefined, stored, cache: memCache() };
  await liveRoute(bristol, clifton, arrive, "g1", { ...deps, now });
  await liveRoute(bristol, clifton, arrive, "g1", { ...deps, now: new Date("2026-11-09T12:30:00Z") });
  await liveRoute(bristol, clifton, arrive, "g1", { ...deps, now: new Date("2026-11-09T12:55:00Z") });
  assert.equal(g.calls.length, 1);
});

test("a drive goes to Google with traffic, even in London with TfL; with no Google key it's no_key, never transit", async () => {
  const { f, calls } = stub([{ match: /"travelMode":"DRIVE"/, body: { routes: [{ duration: "1320s" }] } }]);
  const env = (k: string) => ({ ATHENA_TFL_KEY: "tfl-key", ATHENA_GOOGLE_ROUTES_KEY: "g-key" })[k];
  const r = await liveRoute(islington, kingsCross, arrive, "d1", { fetch: f, now, env, cache: memCache() }, "drive");
  assert.deepEqual(r, { minutes: 22, mode: "drive", source: "google" });
  assert.equal(calls.length, 1);
  const body = JSON.parse(String(calls[0].init!.body));
  assert.equal(body.routingPreference, "TRAFFIC_AWARE");
  assert.equal(body.arrivalTime, undefined);
  const none = stub([]);
  assert.equal(await liveRoute(islington, kingsCross, arrive, "d2", { fetch: none.f, now, env: (k) => (k === "ATHENA_TFL_KEY" ? "tfl-key" : undefined), cache: memCache() }, "drive"), "no_key");
  assert.equal(none.calls.length, 0);
});

test("by bike outside London: Google BICYCLE; on foot in London: TfL walking only", async () => {
  const env = (k: string) => ({ ATHENA_TFL_KEY: "tfl-key", ATHENA_GOOGLE_ROUTES_KEY: "g-key" })[k];
  const g = stub([{ match: /"travelMode":"BICYCLE"/, body: { routes: [{ duration: "600s" }] } }]);
  assert.deepEqual(await liveRoute(bristol, clifton, arrive, "c1", { fetch: g.f, now, env, cache: memCache() }, "cycle"), { minutes: 10, mode: "cycle", source: "google" });
  const t = stub([{ match: /api\.tfl\.gov\.uk/, body: { journeys: [{ duration: 28, legs: [{ mode: { id: "walking" } }] }] } }]);
  assert.deepEqual(await liveRoute(islington, kingsCross, arrive, "w1", { fetch: t.f, now, env, cache: memCache() }, "walk"), { minutes: 28, mode: "walk", source: "tfl" });
  assert.equal(new URL(t.calls[0].url).searchParams.get("mode"), "walking");
});

test("a drive is asked once more near the leave time, and never a third time", async () => {
  let secs = 1500; // 25 minutes, then traffic makes it 35.
  const calls: string[] = [];
  const f = (async (url: string | URL, init?: RequestInit) => {
    calls.push(String(init?.body ?? url));
    return new Response(JSON.stringify({ routes: [{ duration: `${secs}s` }] }), { status: 200 });
  }) as typeof fetch;
  const env = (k: string) => ({ ATHENA_GOOGLE_ROUTES_KEY: "g-key" })[k];
  const cache = memCache();
  const arrive13 = new Date("2026-11-09T13:00:00Z");
  const t = (hhmm: string) => new Date(`2026-11-09T${hhmm}:00Z`);
  const ask = (now: Date) => liveRoute(bristol, clifton, arrive13, "r1", { fetch: f, now, env, cache }, "drive");
  assert.deepEqual(await ask(t("11:35")), { minutes: 25, mode: "drive", source: "google" });
  assert.deepEqual(await ask(t("11:50")), { minutes: 25, mode: "drive", source: "google" }, "kept: not near the leave time yet");
  assert.equal(calls.length, 1);
  secs = 2100;
  // Leave at 12:30 by the first answer: at 12:00 it's 30 minutes away, so ask once more.
  assert.deepEqual(await ask(t("12:00")), { minutes: 35, mode: "drive", source: "google", rechecked: true });
  assert.equal(calls.length, 2);
  for (const now of ["12:05", "12:10", "12:15", "12:20"]) await ask(t(now));
  assert.equal(calls.length, 2, "one extra call per event and way of travelling, no more");
  assert.ok(calls.every((b) => b.includes('"travelMode":"DRIVE"') && b.includes("TRAFFIC_AWARE")));
});

test("a recheck that gets no answer keeps the first time and isn't tried again", async () => {
  let fail = false;
  let n = 0;
  const f = (async () => (n++, fail ? new Response("", { status: 503 }) : new Response(JSON.stringify({ routes: [{ duration: "1500s" }] }), { status: 200 }))) as typeof fetch;
  const env = (k: string) => ({ ATHENA_GOOGLE_ROUTES_KEY: "g-key" })[k];
  const cache = memCache();
  const arrive13 = new Date("2026-11-09T13:00:00Z");
  const ask = (hhmm: string) => liveRoute(bristol, clifton, arrive13, "r2", { fetch: f, now: new Date(`2026-11-09T${hhmm}:00Z`), env, cache }, "drive");
  await ask("11:35");
  fail = true;
  assert.deepEqual(await ask("12:00"), { minutes: 25, mode: "drive", source: "google" });
  await ask("12:10");
  assert.equal(n, 2);
});
