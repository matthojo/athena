// Run: npx tsx --test netlify/lib/connectors/media-servers-direct.test.ts
// Plex and Jellyfin, with fetch stubbed and replies in their APIs' shapes (fixtures/media-servers.ts).
import { afterEach, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import type { Connector, ConnectorSecrets } from "../../../lib/connectors";
import { CONNECTOR_PRESETS, classifyTool, directApi } from "../../../lib/connector-presets";
import { directFailure, directFor } from "./direct";
import { lifeRetryWaits } from "./lifelog-b-http";
import { mediaServerNet, openPlex, plexAdapter, plexToken, PLEX_UNREACHABLE } from "./plex-direct";
import { jellyfinAddress, jellyfinAdapter, openJellyfin, ownerUser } from "./jellyfin-direct";
import * as M from "./fixtures/media-servers";

type Reply = { status?: number; body?: unknown };
const realFetch = globalThis.fetch;
const realCheck = mediaServerNet.assertPublic;
let routes: Array<(url: URL, init: RequestInit) => Reply | undefined> = [];
let calls: Array<{ url: URL; init: RequestInit }> = [];
/** Hosts the stand-in network answers on; others time out. */
let reachable = new Set<string>();

beforeEach(() => {
  calls = [];
  routes = [];
  lifeRetryWaits.ms = [1, 1];
  reachable = new Set([new URL(M.PLEX_PUBLIC_URI).host, new URL(M.PLEX_RELAY_URI).host]);
  mediaServerNet.assertPublic = async (u: URL) => {
    if (/^192-168-|^10-|^127\./.test(u.hostname) || u.hostname === "localhost") throw new Error("internal address");
  };
  globalThis.fetch = (async (input: string | URL, init: RequestInit = {}) => {
    const url = new URL(String(input));
    calls.push({ url, init });
    assert.equal(init.method, "GET");
    for (const r of routes) {
      const reply = r(url, init);
      if (reply) return new Response(JSON.stringify(reply.body), { status: reply.status ?? 200 });
    }
    throw new TypeError(`fetch failed: ${url.host}`);
  }) as typeof fetch;
});
afterEach(() => {
  globalThis.fetch = realFetch;
  mediaServerNet.assertPublic = realCheck;
});

const header = (init: RequestInit, name: string) => (init.headers as Record<string, string>)[name];
const PLEX_DIR = (url: URL, init: RequestInit) =>
  url.host === "clients.plex.tv" && url.pathname === "/api/v2/resources" ? (header(init, "X-Plex-Token") === "abcDEF123ghiJKL456mn" ? { body: M.PLEX_RESOURCES } : { status: 401, body: { errors: [{ code: 1001, message: "User could not be authenticated" }] } }) : undefined;
const PLEX_SERVER = (url: URL, init: RequestInit) => {
  if (!url.host.endsWith(".plex.direct:32400") && !url.host.endsWith(".plex.direct:8443")) return undefined;
  if (!reachable.has(url.host)) return undefined;
  if (header(init, "X-Plex-Token") !== "server-access-token") return { status: 401, body: {} };
  if (url.pathname === "/identity") return { body: { MediaContainer: { machineIdentifier: M.PLEX_MACHINE } } };
  if (url.pathname === "/status/sessions/history/all") return { body: M.plexHistoryReply(url) };
  return undefined;
};
const plex = { id: "p1", name: "Plex", provider: "plex", auth_type: "token", url: "https://clients.plex.tv", scope: "" } as Connector;
const plexSecrets: ConnectorSecrets = { token: "abcDEF123ghiJKL456mn" };

const jellyfin = (url = M.JELLYFIN_BASE) => ({ id: "j1", name: "Jellyfin", provider: "jellyfin", auth_type: "token", url, scope: "" }) as Connector;
const jfSecrets: ConnectorSecrets = { token: "0123456789abcdef0123456789abcdef" };
const JF = (url: URL, init: RequestInit) => {
  if (url.origin !== M.JELLYFIN_BASE) return undefined;
  if (header(init, "X-Emby-Token") !== jfSecrets.token) return { status: 401, body: null };
  if (url.pathname === "/System/Info") return { body: M.JELLYFIN_INFO };
  if (url.pathname === "/Users") return { body: M.JELLYFIN_USERS };
  if (url.pathname === "/Items" && url.searchParams.get("userId") === "u-jordan") return { body: M.jellyfinItemsReply(url) };
  return undefined;
};

test("presets: both are Entertainment, take a key, read only, and say the server must be reachable from the internet", () => {
  for (const id of ["plex", "jellyfin"]) {
    const p = CONNECTOR_PRESETS.find((x) => x.id === id)!;
    assert.equal(p.category, "entertainment");
    assert.equal(p.auth, "token");
    assert.match(`${p.help} ${p.setup?.heads_up}`, /can only reach a server you can open from outside your home/);
    assert.ok(p.setup!.steps.length >= 2);
    assert.equal(directApi({ provider: id, auth_type: "token" }), true);
  }
  assert.equal(CONNECTOR_PRESETS.find((x) => x.id === "plex")!.url, "https://clients.plex.tv");
  for (const t of plexAdapter.tools(plex)) assert.equal(classifyTool("plex", t.name, t.annotations), "read");
  for (const t of jellyfinAdapter.tools(jellyfin())) assert.equal(classifyTool("jellyfin", t.name, t.annotations), "read");
  assert.equal(directFor(plex), plexAdapter);
  assert.equal(directFor(jellyfin()), jellyfinAdapter);
});

test("Plex token: the token itself, or the whole View XML address", () => {
  assert.equal(plexToken(" abcDEF123ghiJKL456mn "), "abcDEF123ghiJKL456mn");
  assert.equal(plexToken(`${M.PLEX_LOCAL_URI}/library/metadata/7001?X-Plex-Token=abcDEF123ghiJKL456mn`), "abcDEF123ghiJKL456mn");
  assert.equal(plexToken("not a token at all"), undefined);
  assert.equal(plexToken(""), undefined);
});

test("Plex: finds the owned server's public https address (not the home one, not a friend's), then reads history in a window", async () => {
  routes = [PLEX_DIR, PLEX_SERVER];
  const acct = await openPlex(plex, { token: `https://app.plex.tv/x?X-Plex-Token=${plexSecrets.token}` }, "Europe/London");
  const r = JSON.parse((await acct.call("watch_history", { date: "2026-11-06" })).text);
  assert.deepEqual(r.items[0], {
    kind: "film",
    title: "Paddington in Peru",
    year: 2024,
    date: "2026-11-06",
    time: "22:10",
    at: "2026-11-06T22:10:00Z",
    id: "7001",
    link: `https://app.plex.tv/desktop/#!/server/${M.PLEX_MACHINE}/details?key=%2Flibrary%2Fmetadata%2F7001`,
  });
  assert.deepEqual(r.items[1], {
    kind: "episode",
    show: "Slow Horses",
    season: 4,
    episode: 2,
    title: "Hello Goodbye",
    date: "2026-11-06",
    time: "20:20",
    at: "2026-11-06T20:20:00Z",
    show_id: "499",
    link: `https://app.plex.tv/desktop/#!/server/${M.PLEX_MACHINE}/details?key=%2Flibrary%2Fmetadata%2F1089`,
    show_link: `https://app.plex.tv/desktop/#!/server/${M.PLEX_MACHINE}/details?key=%2Flibrary%2Fmetadata%2F499`,
  });
  // The guest's episode stays out: only the owner's account is asked for.
  assert.deepEqual([r.count, r.films, r.episodes, r.server], [3, 1, 2, "Living room"]);
  const hist = calls.find((c) => c.url.pathname === "/status/sessions/history/all")!;
  assert.equal(hist.url.host, new URL(M.PLEX_PUBLIC_URI).host);
  assert.equal(hist.url.searchParams.get("accountID"), "1");
  assert.equal(hist.url.searchParams.get("viewedAt>"), String(Date.parse("2026-11-06T00:00:00Z") / 1000));
  assert.equal(hist.init.redirect, "manual");
  // The home address was never tried, nor the friend's server.
  assert.ok(!calls.some((c) => c.url.host.startsWith("192-168-") || c.url.host.includes("friend")));
});

test("Plex paging: next_cursor walks the window with no repeats; music is left out", async () => {
  routes = [PLEX_DIR, PLEX_SERVER];
  const acct = await openPlex(plex, plexSecrets, "UTC");
  const seen: string[] = [];
  let cursor: string | undefined;
  for (let i = 0; i < 5; i++) {
    const r = JSON.parse((await acct.call("watch_history", { after: "2026-11-05", before: "2026-11-07", limit: 2, cursor })).text);
    seen.push(...r.items.map((x: { title: string }) => x.title));
    cursor = r.next_cursor;
    if (!cursor) break;
  }
  assert.deepEqual(seen, ["Paddington in Peru", "Hello Goodbye", "Identity Theft", "Conclave"]);
});

test("Plex: the relay when the direct address doesn't answer; a server that can't be reached at all says how to fix it", async () => {
  routes = [PLEX_DIR, PLEX_SERVER];
  reachable = new Set([new URL(M.PLEX_RELAY_URI).host]);
  const acct = await openPlex(plex, plexSecrets, "UTC");
  await acct.call("watch_history", { date: "2026-11-06" });
  assert.equal(calls.at(-1)!.url.host, new URL(M.PLEX_RELAY_URI).host);

  reachable = new Set();
  const err = await openPlex(plex, plexSecrets, "UTC").catch((e) => e);
  assert.deepEqual(directFailure(err), { status: "needs_auth", detail: PLEX_UNREACHABLE });
});

test("Plex: a refused token is needs_auth, before any server is tried", async () => {
  routes = [PLEX_DIR, PLEX_SERVER];
  const err = await openPlex(plex, { token: "wrongtoken1234567890" }, "UTC").catch((e) => e);
  assert.equal(plexAdapter.accountProblem(err), true);
  assert.deepEqual(directFailure(err), { status: "needs_auth", detail: "Plex didn't accept that key. Copy the View XML address again and paste it." });
  assert.ok(!calls.some((c) => c.url.host.endsWith(".plex.direct:32400")));
  const none = await openPlex(plex, {}, "UTC").catch((e) => e);
  assert.equal(directFailure(none)!.detail, "Paste your Plex key under Edit.");
});

test("Jellyfin address: https only, a bare name gets https, /web is dropped; home addresses are refused when opened", async () => {
  assert.equal(jellyfinAddress("jellyfin.example.com"), "https://jellyfin.example.com");
  assert.equal(jellyfinAddress("https://media.example.com/jellyfin/web/index.html#!/home"), "https://media.example.com/jellyfin");
  assert.throws(() => jellyfinAddress("http://jellyfin.example.com"), /https address/);
  assert.throws(() => jellyfinAddress("https://me:pw@jellyfin.example.com"), /Leave your username and password out/);
  const err = await openJellyfin(jellyfin("https://192-168-1-5.local.example"), jfSecrets, "UTC").catch((e) => e);
  assert.match(directFailure(err)!.detail, /on your home network/);
  assert.equal(calls.length, 0);
});

test("Jellyfin: the administrator's plays, last played first, in a window, with Watch & read ids", async () => {
  routes = [JF];
  const acct = await openJellyfin(jellyfin(), jfSecrets, "Europe/London");
  const r = JSON.parse((await acct.call("watch_history", { date: "2026-11-06" })).text);
  assert.equal(r.user, "jordan");
  assert.deepEqual(
    r.items.map((i: Record<string, unknown>) => [i.kind, i.show ?? i.title, i.season, i.episode, i.time, i.plays]),
    [
      ["episode", "Shōgun", 1, 3, "21:45", undefined],
      ["episode", "Shōgun", 1, 2, "20:50", undefined],
      ["film", "Past Lives", undefined, undefined, "18:00", 2],
    ],
  );
  assert.equal(r.items[0].show_id, "s-shogun");
  assert.equal(r.items[0].show_link, `${M.JELLYFIN_BASE}/web/#/details?id=s-shogun&serverId=${M.JELLYFIN_SERVER_ID}`);
  assert.deepEqual([r.films, r.episodes, r.next_cursor], [1, 2, undefined]);
  const items = calls.find((c) => c.url.pathname === "/Items")!;
  assert.equal(items.url.searchParams.get("SortBy"), "DatePlayed");
  assert.equal(items.url.searchParams.get("Filters"), "IsPlayed");
  assert.equal(items.init.redirect, "manual");
  assert.match(header(items.init, "Authorization"), /^MediaBrowser .*Token="0123456789abcdef0123456789abcdef"/);
});

test("Jellyfin paging: limit and next_cursor across the window, stopping at the first older play", async () => {
  routes = [JF];
  const acct = await openJellyfin(jellyfin(), jfSecrets, "UTC");
  const first = JSON.parse((await acct.call("watch_history", { after: "2026-11-01", limit: 2 })).text);
  assert.equal(first.items.length, 2);
  const second = JSON.parse((await acct.call("watch_history", { after: "2026-11-01", limit: 2, cursor: first.next_cursor })).text);
  assert.deepEqual(second.items.map((i: { title: string }) => i.title), ["Past Lives", "Heat"]);
  // Arrival (30 Oct) is before the window: no third page.
  assert.equal(second.next_cursor, undefined);
});

test("Jellyfin: a refused key is needs_auth; a 10.8 server is read through /Users/{id}/Items", async () => {
  routes = [JF];
  const err = await openJellyfin(jellyfin(), { token: "ffffffffffffffffffffffffffffffff" }, "UTC").catch((e) => e);
  assert.equal(jellyfinAdapter.accountProblem(err), true);
  assert.deepEqual(directFailure(err), { status: "needs_auth", detail: "Jellyfin didn't accept that key. Make a new one in Dashboard, then API Keys." });

  routes = [
    (url, init) => (url.pathname === "/Items" ? { status: 404, body: null } : url.pathname === "/Users/u-jordan/Items" ? { body: M.jellyfinItemsReply(url) } : JF(url, init)),
  ];
  const acct = await openJellyfin(jellyfin(), jfSecrets, "UTC");
  assert.equal(JSON.parse((await acct.call("watch_history", { date: "2026-11-04" })).text).items[0].title, "Heat");
});

test("Jellyfin: whose viewing is read", () => {
  assert.deepEqual(ownerUser(M.JELLYFIN_USERS), { id: "u-jordan", name: "jordan" });
  assert.deepEqual(ownerUser([{ Id: "solo", Name: "me" }]), { id: "solo", name: "me" });
  assert.equal(ownerUser([{ Id: "a" }, { Id: "b" }]), null);
});
