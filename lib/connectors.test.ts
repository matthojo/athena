// Run: npx tsx --test lib/connectors.test.ts
// What the Sources screens read: plain-words run errors, saved counts, reusable own clients, manual schedules.
import { test } from "node:test";
import assert from "node:assert/strict";
import { blockedRunError, computeNextRun, ownClientFamily, ownClientsSummary, savedCount, type Connector } from "./connectors";

test("a blocked run says which account, in plain words", () => {
  assert.equal(blockedRunError([{ name: "Personal Gmail", auth_type: "oauth", signedOut: true }]), "Personal Gmail is signed out");
  assert.equal(
    blockedRunError([
      { name: "Personal Gmail", auth_type: "oauth", signedOut: true },
      { name: "Work Calendar", auth_type: "oauth", signedOut: true },
    ]),
    "Personal Gmail and Work Calendar are signed out",
  );
  assert.equal(blockedRunError([{ name: "GitHub", auth_type: "token", signedOut: true }]), "GitHub's key stopped working");
  assert.equal(
    blockedRunError([
      { name: "Personal Gmail", auth_type: "oauth", signedOut: true },
      { name: "Company wiki", auth_type: "none", signedOut: false },
    ]),
    "Personal Gmail is signed out. Athena couldn't reach Company wiki",
  );
  assert.equal(blockedRunError([]), "It has no accounts to read");
  for (const text of [blockedRunError([{ name: "X", signedOut: true }]), blockedRunError([{ name: "Y", signedOut: false }])]) {
    assert.doesNotMatch(text, /invalid_grant|401|needs signing in|unreachable/);
  }
});

test("saved counts new things, not updates or bookkeeping", () => {
  assert.equal(savedCount({ notes_created: 2, notes_updated: 9, events_created: 1, events_updated: 140, bookings_created: 1, purchases_created: 1, todos: 3, turns: 7, input_tokens: 9000 }), 8);
  assert.equal(savedCount({ claude_skipped: 1, blocked_by: ["x"] }), 0);
  assert.equal(savedCount(undefined), 0);
});

const account = (over: Partial<Connector>): Connector =>
  ({
    id: "id",
    name: "Account",
    provider: "gmail",
    account_label: "",
    url: "https://gmail.googleapis.com",
    auth_type: "oauth",
    scope: "",
    status: "connected",
    status_detail: "",
    tools: [],
    allowed_tools: [],
    tools_checked_at: null,
    last_used_at: null,
    server_info: {},
    oauth: {},
    has_token: false,
    has_own_client: true,
    has_client_secret: true,
    created_at: "2026-11-01T09:00:00Z",
    updated_at: "2026-11-01T09:00:00Z",
    ...over,
  }) as Connector;

test("own clients are offered by family, names only", () => {
  assert.equal(ownClientFamily("gmail"), "Google");
  assert.equal(ownClientFamily("google-calendar"), "Google");
  assert.equal(ownClientFamily("youtube"), "Google");
  assert.equal(ownClientFamily("outlook-mail"), "Microsoft");
  assert.equal(ownClientFamily("outlook-calendar"), "Microsoft");
  assert.equal(ownClientFamily("linear"), undefined);
  assert.equal(ownClientFamily("custom"), undefined);

  const summary = ownClientsSummary([
    account({ id: "g-old", name: "Work Gmail", created_at: "2026-10-01T09:00:00Z" }),
    account({ id: "g-new", name: "Personal Gmail", created_at: "2026-11-01T09:00:00Z" }),
    account({ id: "g-broken", name: "Old Calendar", provider: "google-calendar", status: "needs_auth", created_at: "2026-11-05T09:00:00Z" }),
    account({ id: "ms", name: "Client Outlook", provider: "outlook-mail" }),
    account({ id: "lin", name: "Linear", provider: "linear" }),
    account({ id: "custom", name: "Wiki", provider: "custom" }),
    account({ id: "no-client", name: "Gmail via Google", has_own_client: false, created_at: "2026-11-06T09:00:00Z" }),
  ]);
  assert.deepEqual(summary, {
    Google: { from: "g-old", name: "Work Gmail" },
    Microsoft: { from: "ms", name: "Client Outlook" },
  });
  // Nothing but an id and a name per family.
  for (const v of Object.values(summary)) assert.deepEqual(Object.keys(v).sort(), ["from", "name"]);
  assert.deepEqual(ownClientsSummary([account({ auth_type: "token", provider: "gmail" })]), {});
});

test("manual collections never get a next run, whatever enabled says", () => {
  const after = new Date("2026-11-07T08:00:00Z");
  for (const enabled of [true, false]) {
    assert.equal(computeNextRun({ schedule: "manual", run_at: "07:00", every_hours: null, enabled }, after, "Europe/London"), null);
  }
  assert.ok(computeNextRun({ schedule: "daily", run_at: "07:00", every_hours: null, enabled: true }, after, "Europe/London"));
});
