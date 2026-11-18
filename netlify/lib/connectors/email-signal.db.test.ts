// Real path: the email digest's write tools against Postgres with every migration applied. Notes only for reference mail;
// appointments, renewals and alerts as records; and the Team events each sets off.
// Run: ATHENA_TEST_DB_URL=postgres://… ATHENA_DATA_KEY=<64 hex> npx tsx --test netlify/lib/connectors/email-signal.db.test.ts
// Skipped without ATHENA_TEST_DB_URL. Empties team_events and assets first.
import { test } from "node:test";
import assert from "node:assert/strict";

const url = process.env.ATHENA_TEST_DB_URL;
if (url) process.env.NETLIFY_DB_URL = url;

const NOW = new Date("2026-11-15T09:00:00Z");
const TZ = "Europe/London";

async function setup(recipe = "email-digest", label = `signal${Math.random().toString(36).slice(2, 8)}`) {
  const { AthenaWriter } = await import("./runner");
  const collection = { id: "c1", name: "Email", recipe, connector_ids: [], label, source: `email-digest-${label}`, instructions: "", schedule: "daily", run_at: null, every_hours: null, lookback_hours: 24, lookahead_days: 0, event_push: false, enabled: true, next_run_at: null, last_run_at: null, last_status: null, created_at: "", updated_at: "" } as never;
  const stats = { turns: 0, tool_calls: 0, source_calls: 0, notes_created: 0, notes_updated: 0, skipped_dismissed: 0, archived: 0, restored: 0, events_created: 0, events_updated: 0, metrics: 0, people: 0, catch_ups: 0, todos: 0, details: 0, suggestions: 0 } as Record<string, number>;
  const writer = new AthenaWriter(collection, "00000000-0000-4000-8000-000000000001", stats as never, NOW, TZ);
  writer.providers = ["gmail"];
  const run = async (tool: string, input: Record<string, unknown>) => {
    let out: string;
    try {
      out = await writer.run(tool, input);
    } catch (error) {
      // A refusal comes back to the model as the tool's error.
      return { text: (error as Error).message };
    }
    try {
      return JSON.parse(out) as Record<string, unknown>;
    } catch {
      return { text: out };
    }
  };
  return { writer, run, stats, source: `email-digest-${label}` };
}

async function events(): Promise<Array<{ ref_kind: string; facets: Record<string, unknown> }>> {
  const { qRaw } = await import("../../../lib/db");
  return qRaw(`SELECT ref_kind, facets FROM team_events ORDER BY id`);
}

test("an email digest keeps notes for reference mail only", { skip: !url && "set ATHENA_TEST_DB_URL" }, async () => {
  const { run, writer } = await setup();
  const fyi = await run("athena_save_note", { external_id: "t-fyi", title: "Club newsletter", body: "The club has a new website.", tags: ["Club", "fyi"] });
  assert.match(String(fyi.text), /Nice-to-know email isn't kept/);
  const receipt = await run("athena_save_note", { external_id: "t-rcpt", title: "Order confirmed", body: "An order from IKEA.", tags: ["IKEA", "receipt"] });
  assert.match(String(receipt.text), /athena_purchase/);
  const todo = await run("athena_save_note", { external_id: "t-act", title: "Sign the form", body: "The school needs the form signed.", tags: ["School", "action-item"] });
  assert.match(String(todo.text), /athena_todo/);
  const capture = await run("athena_save_note", { external_id: "t-cap", title: "Ticket", body: "A ticket for Friday.", type: "capture", tags: ["Venue"] });
  assert.match(String(capture.text), /isn't a note/);

  for (let i = 1; i <= 5; i++) {
    const kept = await run("athena_save_note", { external_id: `t-ref-${i}`, title: `Kitchen quote ${i}`, body: "The fitter quoted for the worktops and said the job takes three days.", tags: ["Fitter", "reference"] });
    assert.equal(kept.action, "created", `reference note ${i}`);
  }
  const sixth = await run("athena_save_note", { external_id: "t-ref-6", title: "Kitchen quote 6", body: "Another quote for the worktops.", tags: ["Fitter", "reference"] });
  assert.match(String(sixth.text), /at most 5 new notes/);
  // Updating one it already kept is fine.
  assert.equal((await run("athena_save_note", { external_id: "t-ref-1", title: "Kitchen quote 1", body: "The fitter quoted for the worktops; three days' work.", tags: ["Fitter", "reference"] })).action, "updated");

  // Saving one item the owner asked about from Ask: kept whatever it is.
  writer.notesForReferenceOnly = false;
  const asked = await run("athena_save_note", { external_id: "t-fyi-asked", title: "Club newsletter", body: "The club has a new website.", tags: ["Club", "fyi"] });
  assert.equal(asked.action, "created");
});

test("appointments and deadlines from email become events, moved and cancelled by later emails", { skip: !url && "set ATHENA_TEST_DB_URL" }, async () => {
  const { qRaw } = await import("../../../lib/db");
  await qRaw(`DELETE FROM team_events`);
  await qRaw(`DELETE FROM events WHERE source LIKE 'email-digest-signal%'`);
  const { run, source } = await setup();
  const { getCollected } = await import("../../../lib/connectors");
  const appt = { external_id: "t-dentist", kind: "appointment", title: "Dentist, Dr Patel", start: "2026-11-20T09:30:00+00:00", notes: "Smile Dental, High Street.", quote: "Your appointment is confirmed for Friday 20 November at 9:30.", confidence: 0.95 };
  const made = await run("athena_email_date", appt);
  assert.equal(made.action, "created");
  const [ev] = await qRaw<{ kind: string; starts_at: string; remind_days_before: number[]; source: string; timed_push: boolean }>(`SELECT kind, starts_at, remind_days_before, source, timed_push FROM events WHERE id = $1`, [made.id]);
  assert.equal(ev.kind, "appointment");
  assert.equal(new Date(ev.starts_at).toISOString(), "2026-11-20T09:30:00.000Z");
  assert.deepEqual(ev.remind_days_before, [0, 1], "the day before and on the day");
  assert.equal(ev.source, source);
  assert.equal(ev.timed_push, true);

  const moved = await run("athena_email_date", { ...appt, start: "2026-11-21T10:00:00+00:00", quote: "Your appointment has moved to Saturday at 10:00." });
  assert.equal(moved.action, "updated");
  assert.equal(moved.id, made.id, "the same event");
  const [after] = await qRaw<{ starts_at: string }>(`SELECT starts_at FROM events WHERE id = $1`, [made.id]);
  assert.equal(new Date(after.starts_at).toISOString(), "2026-11-21T10:00:00.000Z");

  const cancelled = await run("athena_email_date", { ...appt, cancelled: true, quote: "Your appointment has been cancelled." });
  assert.equal(cancelled.action, "archived");
  assert.equal((await getCollected(source, "event", "t-dentist"))?.state, "archived");

  const deadline = await run("athena_email_date", { external_id: "t-form", kind: "deadline", title: "School trip form due", date: "2026-11-27", quote: "Please return the form by 27 November.", confidence: 0.9 });
  assert.equal(deadline.action, "created");
  const [dl] = await qRaw<{ kind: string; date: string; starts_at: string | null; remind_days_before: number[] }>(`SELECT kind, to_char(date, 'YYYY-MM-DD') AS date, starts_at, remind_days_before FROM events WHERE id = $1`, [deadline.id]);
  assert.deepEqual(dl, { kind: "deadline", date: "2026-11-27", starts_at: null, remind_days_before: [0, 3] });

  // The same appointment from another thread (a reminder email) joins the one Athena has.
  const again = await run("athena_email_date", { ...appt, external_id: "t-deadline-twin", kind: "deadline", title: "School trip form due", start: undefined, date: "2026-11-27" });
  assert.equal(again.action, "joined");
  assert.equal(again.id, deadline.id);

  const past = await run("athena_email_date", { external_id: "t-old", kind: "appointment", title: "Haircut", start: "2026-11-01T10:00:00+00:00", quote: "See you on 1 November.", confidence: 0.95 });
  assert.equal(past.action, "not_saved");
  const unsure = await run("athena_email_date", { external_id: "t-maybe", kind: "appointment", title: "Eye test", date: "2026-12-02", quote: "Book your eye test.", confidence: 0.4 });
  assert.equal(unsure.action, "sent_to_review_inbox");

  const kinds = (await events()).map((e) => [e.facets.kind, e.facets.title, e.facets.email]);
  assert.deepEqual(kinds, [
    ["appointment", "Appointment: Dentist, Dr Patel · 2026-11-20", true],
    ["appointment", "Appointment: Dentist, Dr Patel · 2026-11-21", true],
    ["appointment", "Cancelled: Dentist, Dr Patel", true],
    ["deadline", "Deadline: School trip form due · 2026-11-27", true],
  ]);
});

test("renewals go to Life admin and move on, never backwards, never with a number", { skip: !url && "set ATHENA_TEST_DB_URL" }, async () => {
  const { qRaw } = await import("../../../lib/db");
  await qRaw(`DELETE FROM team_events`);
  await qRaw(`DELETE FROM assets`);
  const { run } = await setup();
  const { getAsset, upsertAsset, listAssets } = await import("../../../lib/memory");
  const notice = { external_id: "t-ins", name: "Car insurance", kind: "insurance", provider: "Direct Line", renews_on: "2027-01-03", quote: "Your policy renews on 3 January 2027 for £312.", confidence: 0.95 };
  const made = await run("athena_renewal", notice);
  assert.equal(made.action, "created");
  const asset = (await getAsset(String(made.id)))!;
  assert.equal(asset.name, "Car insurance");
  assert.equal(asset.renews_on, "2027-01-03");
  assert.deepEqual(asset.remind_days_before, [30, 7, 0]);

  assert.equal((await run("athena_renewal", { ...notice, external_id: "t-ins-2", name: "car insurance", renews_on: "2026-12-01" })).action, "unchanged", "an older date doesn't move it back");
  const next = await run("athena_renewal", { ...notice, external_id: "t-ins-3", name: "Insurance for the car", renews_on: "2028-01-03" });
  assert.equal(next.action, "updated", "the only insurance with Direct Line");
  assert.equal(next.id, made.id);
  assert.equal((await getAsset(String(made.id)))!.renews_on, "2028-01-03");

  const numbered = await run("athena_renewal", { ...notice, external_id: "t-ins-4", name: "Policy 1234 5678 90" });
  assert.match(String(numbered.text), /policy, licence, passport or account number/);
  assert.equal((await run("athena_renewal", { ...notice, external_id: "t-unsure", name: "Gym", kind: "subscription", provider: "PureGym", confidence: 0.3 })).action, "not_saved");

  // One the owner archived stays archived.
  const mot = await upsertAsset({ name: "MOT", kind: "vehicle", renews_on: "2026-12-10" });
  await qRaw(`UPDATE assets SET archived_at = now() WHERE id = $1`, [mot.id]);
  assert.equal((await run("athena_renewal", { external_id: "t-mot", name: "MOT", kind: "vehicle", provider: "DVSA", renews_on: "2027-12-10", quote: "Your MOT is due by 10 December 2027.", confidence: 0.95 })).action, "skipped");
  assert.deepEqual((await listAssets()).map((a) => a.name), ["Car insurance"]);

  assert.deepEqual((await events()).map((e) => [e.ref_kind, e.facets.kind, e.facets.title]), [
    ["asset", "renewal", "Car insurance renews 2027-01-03"],
    ["asset", "renewal", "Car insurance renews 2028-01-03"],
  ]);
});

test("an account alert is a to-do for today, once a thread, and tells Team", { skip: !url && "set ATHENA_TEST_DB_URL" }, async () => {
  const { qRaw } = await import("../../../lib/db");
  await qRaw(`DELETE FROM team_events`);
  const { run, stats } = await setup();
  const alert = { external_id: "t-signin", service: "Google", title: "Check the new sign-in to your Google account", quote: "We noticed a new sign-in to your Google Account on a Windows device.", confidence: 0.95 };
  const made = await run("athena_alert", alert);
  assert.equal(made.action, "created");
  const [c] = await qRaw<{ kind: string; due_on: string; status: string }>(`SELECT kind, to_char(due_on, 'YYYY-MM-DD') AS due_on, status FROM commitments WHERE id = $1`, [made.id]);
  assert.deepEqual(c, { kind: "todo", due_on: "2026-11-15", status: "open" });
  assert.equal(stats.alerts, 1);
  assert.equal((await run("athena_alert", alert)).action, "already_recorded");
  const [ev] = await events();
  assert.deepEqual([ev.ref_kind, ev.facets.kind, ev.facets.title, ev.facets.connector], ["todo", "alert", "Google: Check the new sign-in to your Google account", "gmail"]);
});

test("delivery updates and to-dos set off Team events, once per status", { skip: !url && "set ATHENA_TEST_DB_URL" }, async () => {
  const { qRaw } = await import("../../../lib/db");
  await qRaw(`DELETE FROM team_events`);
  const { run } = await setup();
  const order = { external_id: "t-order", retailer: "Bookshop", order_number: `BK-${Date.now()}`, items: ["The Wager"], status: "ordered", status_at: "2026-11-14T10:00:00Z", quote: "Thanks for your order.", confidence: 0.95 };
  await run("athena_purchase", order);
  await run("athena_purchase", { ...order, external_id: "t-order-2", status: "out_for_delivery", status_at: "2026-11-15T07:00:00Z", quote: "Your parcel is out for delivery." });
  // The same email read again, and an older one arriving late, set nothing off.
  await run("athena_purchase", { ...order, external_id: "t-order-2", status: "out_for_delivery", status_at: "2026-11-15T07:00:00Z", quote: "Your parcel is out for delivery." });
  await run("athena_purchase", { ...order, external_id: "t-order-3", status: "dispatched", status_at: "2026-11-14T18:00:00Z", quote: "Your order has been dispatched." });
  await run("athena_todo", { external_id: "t-school", title: "Reply to the school about the trip", kind: "todo", quote: "Please let us know by Friday.", confidence: 0.95 });

  const got = (await events()).map((e) => [e.ref_kind, e.facets.kind, e.facets.title]);
  assert.deepEqual(got, [
    ["purchase", "delivery", "Ordered: The Wager from Bookshop"],
    ["purchase", "delivery", "Out for delivery: The Wager from Bookshop"],
    ["todo", "todo", "Reply to the school about the trip"],
  ]);
});
