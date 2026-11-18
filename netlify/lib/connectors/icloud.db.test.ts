// iCloud end to end against Postgres: the real /api routes, sealing, account checks, Ask, precheck and People writes.
// Only iCloud's network replies are stubbed (fixtures/icloud-dav.ts); everything on Athena's side is real.
// Run: ATHENA_TEST_DB_URL=postgres://… npx tsx --test netlify/lib/connectors/icloud.db.test.ts
// Skipped without ATHENA_TEST_DB_URL. Uses fixed test keys; empties the connector tables first.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as F from "./fixtures/icloud-dav";

const url = process.env.ATHENA_TEST_DB_URL;
if (url) {
  process.env.NETLIFY_DB_URL = url;
  process.env.CONNECTOR_ENCRYPTION_KEY ??= "11".repeat(32);
  process.env.ATHENA_DATA_KEY ??= "22".repeat(32);
  process.env.ANTHROPIC_API_KEY ??= "test";
}

const APPLE_ID = "jordan@icloud.com";
const PASSWORD = "abcd-efgh-ijkl-mnop";
const CAL_HOME = "https://p42-caldav.icloud.com/123456789/calendars/";
const BOOK = "https://p42-contacts.icloud.com/123456789/carddavhome/card/";

/** iCloud, as far as Athena can tell: the fixtures, behind Basic auth with the right pair. */
function stubIcloud(state: { password: string; methods: Set<string> }) {
  const reply = (body: string, status = 207) => new Response(body, { status, headers: { "Content-Type": "application/xml" } });
  globalThis.fetch = (async (input: string | URL, init: RequestInit = {}) => {
    const u = String(input);
    const method = String(init.method);
    state.methods.add(method);
    const auth = (init.headers as Record<string, string>).Authorization;
    if (auth !== `Basic ${Buffer.from(`${APPLE_ID}:${state.password}`).toString("base64")}`) return new Response("", { status: 401 });
    const body = String(init.body ?? "");
    if (u === "https://caldav.icloud.com/") return reply(F.CALDAV_PRINCIPAL);
    if (u === "https://caldav.icloud.com/123456789/principal/") return reply(F.CALDAV_HOME);
    if (u === CAL_HOME) return reply(F.CALENDARS);
    if (method === "REPORT" && u === `${CAL_HOME}home/`) return reply(F.HOME_REPORT);
    if (method === "REPORT" && u === `${CAL_HOME}8F3A2C10-WORK/`) return reply(F.WORK_REPORT);
    if (method === "REPORT" && u.startsWith(CAL_HOME)) return reply(F.EMPTY_REPORT);
    if (u === "https://contacts.icloud.com/") return reply(F.CARDDAV_PRINCIPAL);
    if (u === "https://contacts.icloud.com/123456789/principal/") return reply(F.CARDDAV_HOME);
    if (u === "https://p42-contacts.icloud.com/123456789/carddavhome/") return reply(F.BOOKS);
    if (method === "PROPFIND" && u === BOOK) return reply(F.CARD_LIST);
    if (method === "REPORT" && u === BOOK) return reply(F.multigetReply([...body.matchAll(/<d:href>([^<]+)<\/d:href>/g)].map((m) => m[1])));
    throw new Error(`No fixture for ${method} ${u}`);
  }) as typeof fetch;
}

test("iCloud: connect with one password, check, Ask, precheck, People, and a revoked password", { skip: !url && "set ATHENA_TEST_DB_URL" }, async () => {
  const realFetch = globalThis.fetch;
  const { handleConnectorRoutes } = await import("./routes");
  const C = await import("../../../lib/connectors");
  const { qRaw, getPerson } = await import("../../../lib/db");
  const { answerSources } = await import("./answer-sources");
  const { openConnector, listAllowedTools } = await import("./mcp-client");
  const { glance, precheck } = await import("./precheck");
  const { AthenaWriter } = await import("./runner");
  const { contactsDirectory } = await import("./icloud-people");

  await qRaw(`DELETE FROM collected_items`);
  await qRaw(`DELETE FROM collections`);
  await qRaw(`DELETE FROM connectors`);
  await qRaw(`DELETE FROM people WHERE true`);

  const icloud = { password: PASSWORD, methods: new Set<string>() };
  stubIcloud(icloud);
  try {
    const api = async (method: string, path: string, body?: unknown) => {
      const u = new URL(`https://athena.test/api${path}`);
      const req = new Request(u, { method, body: body === undefined ? undefined : JSON.stringify(body), headers: { "Content-Type": "application/json" } });
      try {
        const res = (await handleConnectorRoutes(req, u, u.pathname.split("/").filter(Boolean), (d, s = 200) => Response.json(d, { status: s }), u.origin))!;
        return { status: res.status, text: await res.text() };
      } catch (error) {
        return { status: (error as { status?: number }).status ?? 400, text: (error as Error).message };
      }
    };

    // ---- connect Calendar: the Apple ID is required, and sealed with the password ----
    const noId = await api("POST", "/connectors", { provider: "icloud-calendar", name: "Personal iCloud Calendar", account_label: "personal", auth_type: "token", token: PASSWORD });
    assert.equal(noId.status, 400);
    assert.match(noId.text, /Add your Apple ID/);
    const made = await api("POST", "/connectors", { provider: "icloud-calendar", name: "Personal iCloud Calendar", account_label: "personal", auth_type: "token", token: PASSWORD, username: APPLE_ID });
    assert.equal(made.status, 201, made.text);
    assert.ok(!made.text.includes(APPLE_ID) && !made.text.includes(PASSWORD), "neither is sent back to the app");
    const cal = JSON.parse(made.text);
    const sealed = await C.getConnectorWithSecrets(cal.id);
    assert.deepEqual([sealed!.secrets.username, sealed!.secrets.token], [APPLE_ID, PASSWORD]);
    const [raw] = await qRaw<{ credentials: string }>(`SELECT credentials FROM connectors WHERE id = $1`, [cal.id]);
    assert.ok(!raw.credentials.includes(APPLE_ID) && !raw.credentials.includes(PASSWORD), "sealed at rest");

    // ---- the check the form runs after a paste ----
    const checked = await api("POST", `/connectors/${cal.id}/check`);
    assert.equal(checked.status, 200, checked.text);
    const calNow = JSON.parse(checked.text);
    assert.equal(calNow.status, "connected");
    assert.deepEqual([...calNow.allowed_tools].sort(), ["get_event", "list_calendars", "list_events", "search_events"]);

    // ---- choosing calendars: the list, then only Work ----
    const choices = await api("GET", `/connectors/${cal.id}/calendars`);
    assert.equal(choices.status, 200, choices.text);
    assert.deepEqual(JSON.parse(choices.text).calendars.map((c: { id: string; chosen: boolean }) => `${c.id}:${c.chosen}`), ["home:true", "8F3A2C10-WORK:true", "C77-FAMILY:true"]);
    assert.equal((await api("PATCH", `/connectors/${cal.id}`, { scope: "../x" })).status, 400);
    assert.equal((await api("PATCH", `/connectors/${cal.id}`, { scope: "home C77-FAMILY" })).status, 200, "switch off Home and Family");
    assert.deepEqual(JSON.parse((await api("GET", `/connectors/${cal.id}/calendars`)).text).calendars.filter((c: { chosen: boolean }) => c.chosen).map((c: { id: string }) => c.id), ["8F3A2C10-WORK"]);
    assert.equal((await C.getConnector(cal.id))!.status, "connected", "choosing calendars keeps the sign-in");
    await api("PATCH", `/connectors/${cal.id}`, { scope: "" });

    // ---- Contacts: one tap, the same pair copied on the server ----
    const contactsMade = await api("POST", "/connectors", { provider: "icloud-contacts", name: "Personal iCloud Contacts", account_label: "personal", auth_type: "token", key_from: cal.id });
    assert.equal(contactsMade.status, 201, contactsMade.text);
    const contacts = JSON.parse(contactsMade.text);
    assert.deepEqual((await C.getConnectorWithSecrets(contacts.id))!.secrets.username, APPLE_ID);
    assert.equal(JSON.parse((await api("POST", `/connectors/${contacts.id}/check`)).text).status, "connected");

    // ---- Meetings: a collection reading both ----
    const col = await api("POST", "/collections", { recipe: "calendar-meetings", name: "Meetings · personal", label: "personal", connector_ids: [cal.id, contacts.id], schedule: "daily", run_at: "07:00" });
    assert.equal(col.status, 201, col.text);
    const collection = JSON.parse(col.text);

    // ---- precheck's glance: meetings since the last good run ----
    const openCal = await openConnector(cal.id);
    const calTools = new Set((await listAllowedTools(openCal)).map((t) => t.name));
    const quiet = await glance(openCal, calTools, new Date(Date.now() - 60_000), "Europe/London");
    assert.equal(quiet.count, 0, "nothing in the last minute");
    const busy = await glance(openCal, calTools, new Date("2026-10-18T00:00:00Z"), "Europe/London");
    assert.ok((busy.count ?? 0) >= 3, `the stand-ups and the rest since 18 Oct (${busy.count})`);
    await openCal.close();

    // ---- "Skip days with nothing new": on by default, off always runs, Run now always runs ----
    assert.equal(collection.skip_quiet, true, "on by default");
    const good = await C.queueRun(collection.id, "schedule");
    await qRaw(`UPDATE collection_runs SET status = 'succeeded', started_at = now() - interval '1 minute' WHERE id = $1`, [good.id]);
    const quietCal = await openConnector(cal.id);
    const quietAllowed = new Map([[quietCal, new Set((await listAllowedTools(quietCal)).map((t) => t.name))]]);
    const check = async (col: typeof collection, trigger: "schedule" | "manual") =>
      precheck({ collection: col, run: { id: "00000000-0000-4000-8000-0000000000aa", trigger }, opened: [quietCal], allowed: quietAllowed, unreachable: 0, tz: "Europe/London" });
    assert.equal((await check(collection, "schedule")).skip, true, "nothing since a minute ago: skipped");
    assert.equal((await check(collection, "manual")).skip, false, "Run now always runs");
    const off = JSON.parse((await api("PATCH", `/collections/${collection.id}`, { skip_quiet: false })).text);
    assert.equal(off.skip_quiet, false);
    assert.equal((await check(off, "schedule")).skip, false, "setting off: runs anyway");
    const syncing = JSON.parse((await api("PATCH", `/collections/${collection.id}`, { skip_quiet: true, lookahead_days: 14 })).text);
    assert.equal((await check(syncing, "schedule")).skip, false, "upcoming events not saved yet: runs");
    await api("PATCH", `/collections/${collection.id}`, { lookahead_days: 0 });
    await quietCal.close();

    // ---- Ask: both accounts, with their kinds, and a search that answers ----
    const sources = await answerSources.open({ timeoutMs: 10_000 });
    const askCal = sources.accounts.find((a) => a.name === "Personal iCloud Calendar")!;
    const askContacts = sources.accounts.find((a) => a.name === "Personal iCloud Contacts")!;
    assert.equal(askCal.kind, "event");
    assert.equal(askContacts.kind, "page");
    assert.deepEqual(askCal.tools.map((t) => t.name), ["search_events", "list_events", "get_event", "list_calendars"]);
    assert.deepEqual(askContacts.tools.map((t) => t.name), ["search_contacts", "get_contact", "list_contacts"]);
    const found = await askContacts.call("search_contacts", { query: "priya" }, 10_000);
    assert.match(JSON.stringify(found), /Head of Finance/);
    const qbr = await askCal.call("search_events", { query: "QBR" }, 10_000);
    assert.match(JSON.stringify(qbr), /QBR with Acme/);
    await sources.close();

    // ---- People: the run links Priya, and her People record fills in from Contacts ----
    const openContacts = await openConnector(contacts.id);
    const allowed = new Map([[openContacts, new Set((await listAllowedTools(openContacts)).map((t) => t.name))]]);
    const run = await C.queueRun(collection.id, "manual");
    const stats = { people: 0 } as unknown as ConstructorParameters<typeof AthenaWriter>[2];
    const writer = new AthenaWriter(collection, run.id, stats, new Date(), "Europe/London");
    writer.contacts = contactsDirectory([openContacts], allowed);
    const linked = JSON.parse(await writer.run("athena_person", { name: "Priya Shah", email: "priya@acme.example" }));
    assert.equal(linked.created, true);
    const priya = await getPerson(linked.id);
    assert.equal(priya!.phone, "+44 7700 900123");
    assert.equal(priya!.birthday, "--04-12");
    assert.equal(priya!.organisation?.name, "Acme Ltd");
    // Someone the contacts don't know is added with nothing made up.
    const stranger = JSON.parse(await writer.run("athena_person", { name: "Alex Moreno", email: "alex@elsewhere.example" }));
    const alex = await getPerson(stranger.id);
    assert.deepEqual([alex!.phone, alex!.birthday, alex!.organisation], ["", null, null]);
    await openContacts.close();

    // ---- read-only on the wire ----
    assert.deepEqual([...icloud.methods].filter((m) => !["GET", "PROPFIND", "REPORT"].includes(m)), [], "never PUT, POST or DELETE");

    // ---- Apple revokes the password: needs_auth, worded for the owner ----
    icloud.password = "revoked-elsewhere";
    const refused = await api("POST", `/connectors/${cal.id}/check`);
    assert.notEqual(refused.status, 200);
    const after = await C.getConnector(cal.id);
    assert.equal(after!.status, "needs_auth");
    assert.equal(after!.status_detail, "Make a new app-specific password");

    await api("POST", `/connectors/${contacts.id}/check`);
    assert.equal((await C.getConnector(contacts.id))!.status, "needs_auth", "Contacts shares the revoked password");

    // ---- one new password, pasted on Calendar, brings both back ----
    icloud.password = "wxyz-wxyz-wxyz-wxyz";
    const patched = await api("PATCH", `/connectors/${cal.id}`, { token: "wxyz-wxyz-wxyz-wxyz" });
    assert.equal(patched.status, 200, patched.text);
    assert.equal((await C.getConnectorWithSecrets(contacts.id))!.secrets.token, "wxyz-wxyz-wxyz-wxyz", "Contacts gets it too");
    assert.equal(JSON.parse((await api("POST", `/connectors/${cal.id}/check`)).text).status, "connected");
    assert.equal((await C.getConnector(contacts.id))!.status, "connected", "and its sign-in problem clears");

    // ---- an account with a different password isn't touched ----
    const other = await api("POST", "/connectors", { provider: "icloud-contacts", name: "Work iCloud Contacts", account_label: "work", auth_type: "token", token: "aaaa-bbbb-cccc-dddd", username: "work@icloud.com" });
    await api("PATCH", `/connectors/${cal.id}`, { token: "wxyz-wxyz-wxyz-wxyz" });
    assert.equal((await C.getConnectorWithSecrets(JSON.parse(other.text).id))!.secrets.token, "aaaa-bbbb-cccc-dddd");
  } finally {
    globalThis.fetch = realFetch;
  }
});
