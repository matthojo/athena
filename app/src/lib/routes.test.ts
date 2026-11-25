// Run: npx tsx --test app/src/lib/routes.test.ts
// Every address Athena has handed out (pushes, emails, bookmarks, old builds) must still open somewhere.
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseRoute, routeHash, type Route } from "./routes";

const r = (view: string, noteId: string | null = null, source: string | null = null): Route => ({ view: view as Route["view"], noteId, source });

test("plain views round-trip", () => {
  for (const v of ["library", "ask", "archived", "loops", "admin", "reading", "goals", "health", "review"]) {
    assert.deepEqual(parseRoute(`#/${v}`), r(v));
    assert.equal(routeHash(r(v)), `#/${v}`);
  }
});

test("Health's Wellness tab keeps its path; anything else under Health opens Body", () => {
  assert.deepEqual(parseRoute("#/health/wellness"), r("health", "wellness"));
  assert.equal(routeHash(r("health", "wellness")), "#/health/wellness");
  assert.deepEqual(parseRoute("#/health/elsewhere"), r("health"));
});

test("home: empty, bare and unknown hashes", () => {
  for (const h of ["", "#", "#/", "#/nowhere", "#/kind"]) assert.deepEqual(parseRoute(h), r("home"));
  assert.equal(routeHash(r("home")), "#/");
});

test("notes with an id and a source", () => {
  assert.deepEqual(parseRoute("#/notes"), r("notes"));
  assert.deepEqual(parseRoute("#/notes/n%201"), r("notes", "n 1"));
  assert.deepEqual(parseRoute("#/notes?source=work-activity"), r("notes", null, "work-activity"));
  assert.equal(routeHash(r("notes", "n 1", "work")), "#/notes/n%201?source=work");
});

test("records, trips, purchases and the graph keep their id", () => {
  for (const v of ["people", "places", "organisations", "events", "trips", "purchases", "graph"]) {
    assert.deepEqual(parseRoute(`#/${v}/abc`), r(v, "abc"));
    assert.equal(routeHash(r(v, "abc")), `#/${v}/abc`);
    assert.deepEqual(parseRoute(`#/${v}`), r(v));
  }
});

test("the owner's own kinds", () => {
  assert.deepEqual(parseRoute("#/kind/wines"), r("kind:wines"));
  assert.deepEqual(parseRoute("#/kind/wines/w1"), r("kind:wines", "w1"));
  assert.equal(routeHash(r("kind:wines", "w1")), "#/kind/wines/w1");
});

test("days keep their sub-path and query", () => {
  assert.deepEqual(parseRoute("#/days"), r("days"));
  assert.deepEqual(parseRoute("#/days/2026-11-07"), r("days", "2026-11-07"));
  assert.deepEqual(parseRoute("#/days/week/2026-11-02"), r("days", "week/2026-11-02"));
  assert.deepEqual(parseRoute("#/days/calendar?m=2026-11"), r("days", "calendar", "m=2026-11"));
  assert.equal(routeHash(r("days", "search", "q=run")), "#/days/search?q=run");
});

test("old: #/day/<date> opens the day", () => {
  assert.deepEqual(parseRoute("#/day/2026-11-07"), r("days", "2026-11-07"));
});

test("settings sections and sign-in returns", () => {
  assert.deepEqual(parseRoute("#/settings"), r("settings"));
  assert.deepEqual(parseRoute("#/settings/voice"), r("settings", "voice"));
  assert.deepEqual(parseRoute("#/settings/accounts?connected=strava"), r("settings", "accounts", "strava"));
  assert.equal(routeHash(r("settings", "api-keys", "x")), "#/settings/api-keys");
});

test("old: #/connectors lands in Settings", () => {
  assert.deepEqual(parseRoute("#/connectors"), r("settings", "accounts"));
  assert.deepEqual(parseRoute("#/connectors?connected=trakt"), r("settings", "accounts", "trakt"));
  assert.deepEqual(parseRoute("#/connectors?open=elevenlabs"), r("settings", "voice"));
});

test("old: #/reminders (and pushes that link there) opens Reminders in Settings", () => {
  assert.deepEqual(parseRoute("#/reminders"), r("settings", "reminders"));
  assert.equal(routeHash(r("reminders")), "#/settings/reminders");
  assert.deepEqual(parseRoute(routeHash(r("reminders"))), r("settings", "reminders"));
});

test("new: the Library index and Inbox keep their addresses", () => {
  assert.deepEqual(parseRoute("#/library"), r("library"));
  assert.equal(routeHash(r("library")), "#/library");
  assert.deepEqual(parseRoute("#/review"), r("review"));
  assert.deepEqual(parseRoute("#/settings/notifications"), r("settings", "notifications"));
});

test("every address Athena has used still opens somewhere other than Home", () => {
  const old = ["#/notes", "#/ask", "#/people", "#/places", "#/organisations", "#/events", "#/trips", "#/purchases", "#/health", "#/admin", "#/reading", "#/goals", "#/graph", "#/days", "#/day/2026-01-01", "#/loops", "#/review", "#/week", "#/archived", "#/reminders", "#/settings", "#/settings/accounts", "#/settings/collections", "#/connectors", "#/kind/wines"];
  for (const h of old) assert.notEqual(parseRoute(h).view, "home", h);
});

test("old: #/week opens Week in review for this week", () => {
  assert.deepEqual(parseRoute("#/week", "2026-11-08"), r("days", "week/2026-11-02"));
  assert.deepEqual(parseRoute("#/week", "2026-11-09"), r("days", "week/2026-11-09"));
  assert.deepEqual(parseRoute("#/week?x=1", "2026-11-04"), r("days", "week/2026-11-02"));
  assert.match(routeHash(r("week")), /^#\/days\/week\/\d{4}-\d{2}-\d{2}$/);
});

test("Recipes keeps its own path: the grid, a recipe, cook mode, the week and the list", () => {
  const id = "5a3e0000-0000-4000-8000-000000000701";
  for (const path of [null, id, `${id}/cook`, "plan", "list"]) {
    const route: Route = { view: "recipes", source: null, noteId: path };
    const hash = routeHash(route);
    assert.equal(hash, `#/recipes${path ? `/${path}` : ""}`);
    assert.deepEqual(parseRoute(hash), route);
  }
  assert.deepEqual(parseRoute(`#/recipes/${id}/cook?step=2`), { view: "recipes", source: null, noteId: `${id}/cook` });
});

test("a nudge's push opens Ask on it: #/ask/nudge/<id>", () => {
  assert.deepEqual(parseRoute("#/ask/nudge/5a3e0000-0000-4000-8000-00000000d001"), { view: "ask", source: null, noteId: "5a3e0000-0000-4000-8000-00000000d001" });
  assert.deepEqual(parseRoute("#/ask"), { view: "ask", source: null, noteId: null });
});

test("team: the list, one assistant and setup are one view", () => {
  assert.deepEqual(parseRoute("#/team"), r("team"));
  assert.deepEqual(parseRoute("#/team/new"), r("team", "new"));
  assert.deepEqual(parseRoute("#/team/5a3e0000-0000-4000-8000-0000000e0001"), r("team", "5a3e0000-0000-4000-8000-0000000e0001"));
  assert.equal(routeHash(r("team")), "#/team");
  assert.equal(routeHash(r("team", "new")), "#/team/new");
  assert.equal(routeHash(r("team", "abc")), "#/team/abc");
});
