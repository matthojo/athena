// TripIt into Trips, the real path: the routes add a TripIt account with the owner's app, sign in through TripIt's
// OAuth 1.0 handshake and the real callback, and a real Life log run copies its trips into Trips before Claude.
// TripIt's replies are in fixtures/tripit.ts; a stand-in Claude just finishes. Postgres with db/schema.sql.
// Run: ATHENA_TEST_DB_URL=postgres://… npx tsx --test netlify/lib/connectors/tripit-trips.db.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import * as F from "./fixtures/feeds-recorded";
import * as T from "./fixtures/tripit";

const url = process.env.ATHENA_TEST_DB_URL;
if (url) {
  process.env.NETLIFY_DB_URL = url;
  process.env.CONNECTOR_ENCRYPTION_KEY ??= "11".repeat(32);
  process.env.ATHENA_DATA_KEY ??= "22".repeat(32);
  process.env.ANTHROPIC_API_KEY = "test";
  process.env.ANTHROPIC_BASE_URL = "https://claude.test";
}

const header = (init: RequestInit) => String((init.headers as Record<string, string> | undefined)?.Authorization ?? "");
const oauthToken = (init: RequestInit) => decodeURIComponent(/oauth_token="([^"]*)"/.exec(header(init))?.[1] ?? "");

test("TripIt: sign in with the owner's app, and a run puts its trips in Trips, once", { skip: !url && "set ATHENA_TEST_DB_URL" }, async () => {
  F.installFetch();
  try {
    let claudeCalls = 0;
    F.stub(
      (u, init) => (u.href === "https://api.tripit.com/oauth/request_token" && init.method === "POST" ? { body: "oauth_token=req-token&oauth_token_secret=req-secret" } : undefined),
      (u, init) => (u.href === "https://api.tripit.com/oauth/access_token" && init.method === "POST" && oauthToken(init) === "req-token" ? { body: "oauth_token=access-token&oauth_token_secret=access-secret" } : undefined),
      (u, init) => {
        if (u.host !== "api.tripit.com" || !u.pathname.startsWith("/v1/")) return undefined;
        if ((init.method ?? "GET") !== "GET") return { status: 405, body: {} };
        if (oauthToken(init) !== "access-token") return { status: 401, body: "" };
        if (u.pathname === "/v1/get/profile/format/json") return { body: T.TRIPIT_PROFILE };
        if (u.pathname.startsWith("/v1/list/trip/past/false/")) return { body: T.TRIPIT_UPCOMING };
        if (u.pathname.startsWith("/v1/list/trip/past/true/")) return { body: T.TRIPIT_PAST };
        return undefined;
      },
      (u) => {
        if (u.host !== "claude.test") return undefined;
        claudeCalls++;
        return { body: { id: `msg_${claudeCalls}`, type: "message", role: "assistant", model: "stand-in", content: [{ type: "text", text: "Nothing else today." }], stop_reason: "end_turn", stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } } };
      },
    );

    const { handleConnectorRoutes, handleOAuthCallback } = await import("./routes");
    const { executeRun } = await import("./runner");
    const C = await import("../../../lib/connectors");
    const { q, qRaw } = await import("../../../lib/db");
    const { listTrips, saveBooking } = await import("../../../lib/trips");
    for (const t of ["trip_bookings", "trips", "collected_items", "collections", "connectors"]) await qRaw(`DELETE FROM ${t}`);
    await qRaw(`INSERT INTO settings (key, value) VALUES ('timezone', '"Europe/London"') ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`);
    const api = async (method: string, path: string, body?: unknown) => {
      const u = new URL(`https://athena.test/api${path}`);
      const req = new Request(u, { method, body: body === undefined ? undefined : JSON.stringify(body), headers: { "Content-Type": "application/json" } });
      const res = (await handleConnectorRoutes(req, u, u.pathname.split("/").filter(Boolean), (d, s = 200) => Response.json(d, { status: s }), u.origin))!;
      return { status: res.status, json: JSON.parse(await res.text()) };
    };

    // The owner's TripIt app, then sign-in: TripIt's consent page, and back through the callback with oauth_token.
    const made = await api("POST", "/connectors", { provider: "tripit", name: "TripIt", account_label: "personal", client_id: "consumer-key", client_secret: "consumer-secret" });
    assert.equal(made.status, 201, JSON.stringify(made.json));
    const id = made.json.id as string;
    const signIn = await api("POST", `/connectors/${id}/sign-in`);
    assert.equal(signIn.status, 200, JSON.stringify(signIn.json));
    const consent = new URL(signIn.json.authorization_url);
    assert.equal(consent.host, "www.tripit.com");
    const callback = new URL(consent.searchParams.get("oauth_callback")!);
    assert.equal(callback.pathname, "/api/connectors/oauth/callback");
    callback.searchParams.set("oauth_token", consent.searchParams.get("oauth_token")!);
    const back = await handleOAuthCallback(new Request(callback), callback);
    assert.match(await back.text(), new RegExp(`connected=${id}`));
    const account = (await C.getConnector(id))!;
    assert.equal(account.status, "connected");
    assert.deepEqual(account.allowed_tools, ["list_trips"]);
    // The tokens are sealed, never in the row.
    const [row] = await q<{ credentials: unknown }>(`SELECT credentials FROM connectors WHERE id = $1`, [id]);
    assert.ok(!JSON.stringify(row).includes("access-secret"));
    // The same callback again is refused: the state was used.
    assert.match(await (await handleOAuthCallback(new Request(callback), callback)).text(), /expired or was already used/);

    // An email already saved the outbound flight: TripIt fills that one in rather than adding a second.
    const fromEmail = await saveBooking({ kind: "flight", title: "TAP flight TP1351", reference: "xk7p2q", start_local: "2026-11-20T07:10", start_tz: "Europe/London", start_city: "London", end_city: "Lisbon", source: "email-digest-personal", source_ref: "email-digest-personal:msg-1", confidence: 0.95 });

    const life = await api("POST", "/collections", { recipe: "life-log", name: "Life log", label: "personal", connector_ids: [id], schedule: "daily", run_at: "23:30" });
    assert.equal(life.status, 201, JSON.stringify(life.json));
    const runOnce = async () => {
      const run = await C.queueRun(life.json.id, "manual");
      await executeRun(run.id, new Date("2026-11-07T08:00:00Z"));
      return (await C.listRuns(life.json.id)).find((r) => r.id === run.id)!;
    };
    const first = await runOnce();
    assert.equal(first.status, "succeeded", `${first.error ?? ""} ${JSON.stringify(first.stats)}`);
    // Upcoming, the recent past, and (once) every older past trip: Rome in May too.
    assert.equal(first.stats.bookings_created, 5, JSON.stringify(first.stats));
    assert.match(first.summary ?? "", /TripIt: all 2 past trips are in Trips\./);
    assert.equal(first.stats.bookings_updated, 1);

    const trips = await listTrips({ today: "2026-10-01" });
    const byTitle = new Map(trips.map((t) => [t.title, t]));
    assert.deepEqual([...byTitle.keys()].sort(), ["Lisbon", "Paris", "Rome"]);
    const lisbon = byTitle.get("Lisbon")!;
    assert.deepEqual([lisbon.starts_on, lisbon.ends_on], ["2026-11-20", "2026-11-23"]);
    assert.deepEqual(
      lisbon.bookings.map((b) => [b.kind, b.title, b.start_date, b.start_place, b.end_city, b.seat]),
      [
        ["flight", "TP 1351", "2026-11-20", "LHR T2", "Lisbon", "22C"],
        ["hotel", "Memmo Alfama", "2026-11-20", "Travessa das Merceeiras 27, Lisbon", "Lisbon", ""],
        ["car", "Hertz", "2026-11-21", "Lisbon Airport", "Lisbon", ""],
        ["flight", "TP 1358", "2026-11-23", "LIS", "London", ""],
      ],
    );
    // The email's booking is the one TripIt filled in: same id, TripIt's details now, still one outbound flight.
    assert.equal(lisbon.bookings[0].id, fromEmail.booking!.id);
    assert.equal(lisbon.bookings[0].starts_at, "2026-11-20T07:10:00.000Z");
    assert.equal(byTitle.get("Paris")!.bookings[0].title, "Eurostar 9014");
    assert.ok(!JSON.stringify(trips).match(/£|€|212\.40|540\.00/), "no prices in Trips");

    // Again: everything updates in place, nothing new.
    const second = await runOnce();
    assert.equal(second.status, "succeeded");
    assert.equal(second.stats.bookings_created ?? 0, 0, JSON.stringify(second.stats));
    assert.equal((await q(`SELECT id FROM trip_bookings`)).length, 6);
    // The import ran once: no line about it after that.
    assert.doesNotMatch(second.summary ?? "", /past trips/);
    // The owner archives the car hire: TripIt leaves it alone after that.
    await qRaw(`UPDATE trip_bookings SET archived_at = now() WHERE source_ref = 'tripit:car:440003'`);
    const third = await runOnce();
    assert.equal(third.status, "succeeded");
    assert.equal((await q(`SELECT id FROM trip_bookings WHERE archived_at IS NULL`)).length, 5);
    // Nothing but GETs reached TripIt's API, and the only POSTs were the two sign-in steps.
    const toTripIt = F.calls.filter((c) => c.url.host === "api.tripit.com");
    assert.ok(toTripIt.filter((c) => c.url.pathname.startsWith("/v1/")).every((c) => (c.init.method ?? "GET") === "GET"));
    assert.deepEqual(toTripIt.filter((c) => c.init.method === "POST").map((c) => c.url.pathname), ["/oauth/request_token", "/oauth/access_token"]);
  } finally {
    F.restoreFetch();
  }
});

test("TripIt: a long history imports over several runs, from where the last one stopped, never twice", { skip: !url && "set ATHENA_TEST_DB_URL" }, async () => {
  const { tripitImport } = await import("./tripit-trips");
  const pagesPerRun = tripitImport.pagesPerRun;
  tripitImport.pagesPerRun = 2;
  F.installFetch();
  try {
    // Five pages of past trips, one each: Berlin, Oslo, Porto, Vienna, Kyoto (newest first).
    const cities = ["Berlin", "Oslo", "Porto", "Vienna", "Kyoto"];
    const pastPage = (n: number) => {
      const city = cities[n - 1];
      const day = `2025-0${9 - n}-1${n}`;
      return {
        page_num: String(n),
        page_size: "25",
        max_page: String(cities.length),
        Trip: { id: `90${n}`, display_name: city, start_date: day, end_date: day, PrimaryLocationAddress: { city } },
        LodgingObject: { id: `91${n}`, trip_id: `90${n}`, supplier_name: `Hotel ${city}`, StartDateTime: { date: day, time: "15:00:00", timezone: "Europe/London" }, Address: { city } },
      };
    };
    F.stub(
      (u, init) => {
        if (u.host !== "api.tripit.com") return undefined;
        if ((init.method ?? "GET") !== "GET") return { status: 405, body: {} };
        if (u.pathname === "/v1/get/profile/format/json") return { body: T.TRIPIT_PROFILE };
        if (u.pathname.startsWith("/v1/list/trip/past/false/")) return { body: { page_num: "1", max_page: "1" } };
        const page = /\/past\/true\/.*page_num\/(\d+)\//.exec(u.pathname);
        if (page) return { body: pastPage(Number(page[1])) };
        return undefined;
      },
      (u) => (u.host === "claude.test" ? { body: { id: "m", type: "message", role: "assistant", model: "stand-in", content: [{ type: "text", text: "Done." }], stop_reason: "end_turn", stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } } } : undefined),
    );
    const { handleConnectorRoutes } = await import("./routes");
    const { executeRun } = await import("./runner");
    const C = await import("../../../lib/connectors");
    const { q, qRaw } = await import("../../../lib/db");
    for (const t of ["trip_bookings", "trips", "collected_items", "collections", "connectors"]) await qRaw(`DELETE FROM ${t}`);
    const api = async (method: string, path: string, body?: unknown) => {
      const u = new URL(`https://athena.test/api${path}`);
      const req = new Request(u, { method, body: body === undefined ? undefined : JSON.stringify(body), headers: { "Content-Type": "application/json" } });
      const res = (await handleConnectorRoutes(req, u, u.pathname.split("/").filter(Boolean), (d, s = 200) => Response.json(d, { status: s }), u.origin))!;
      return { status: res.status, json: JSON.parse(await res.text()) };
    };
    // Signed in already (the sign-in itself is the test above).
    const made = await api("POST", "/connectors", { provider: "tripit", name: "TripIt", account_label: "personal", client_id: "consumer-key", client_secret: "consumer-secret" });
    await C.updateConnectorSecrets(made.json.id, (s) => void (s.tokens = { access_token: "access-token", token_secret: "access-secret", token_type: "oauth1" } as never));
    assert.equal((await api("POST", `/connectors/${made.json.id}/check`)).status, 200);
    const life = await api("POST", "/collections", { recipe: "life-log", name: "Life log", label: "personal", connector_ids: [made.json.id], schedule: "daily", run_at: "23:30" });
    const runOnce = async () => {
      const run = await C.queueRun(life.json.id, "manual");
      await executeRun(run.id, new Date("2026-11-07T08:00:00Z"));
      return (await C.listRuns(life.json.id)).find((r) => r.id === run.id)!;
    };
    const count = async () => (await q(`SELECT id FROM trip_bookings`)).length;

    const r1 = await runOnce();
    assert.equal(r1.status, "succeeded", r1.error ?? "");
    assert.match(r1.summary ?? "", /TripIt: 2 past trips in Trips so far\. The rest come on the next run\./);
    assert.equal(await count(), 2);
    const r2 = await runOnce();
    assert.match(r2.summary ?? "", /TripIt: 4 past trips in Trips so far\./);
    assert.equal(await count(), 4);
    const r3 = await runOnce();
    assert.match(r3.summary ?? "", /TripIt: all 5 past trips are in Trips\./);
    assert.equal(await count(), 5);
    const r4 = await runOnce();
    assert.doesNotMatch(r4.summary ?? "", /past trips/);
    assert.equal(await count(), 5, "never twice");
    // Pages were read in order, each once for the import (page 1 is also the recent-past check every run).
    const importPages = F.calls.map((c) => /\/past\/true\/.*page_num\/(\d+)\//.exec(c.url.pathname)?.[1]).filter((p): p is string => !!p && p !== "1");
    assert.deepEqual(importPages, ["2", "3", "4", "5"]);
  } finally {
    tripitImport.pagesPerRun = pagesPerRun;
    F.restoreFetch();
  }
});
