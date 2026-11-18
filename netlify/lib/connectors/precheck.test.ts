// The email pre-check's sort, the pure parts: where each thread goes, what's rescued from noise, and what Claude is told.
// Run: npx tsx --test netlify/lib/connectors/precheck.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { KINDS, rescueKind, sortThread, triageNote, type EmailThread, type Kind } from "./precheck";

const mail = (subject: string, snippet = ""): Pick<EmailThread, "subject" | "snippet"> => ({ subject, snippet });
const said = (choice: Kind, p: number, rest: Partial<Record<Kind, number>> = {}) => ({ choice, probabilities: { [choice]: p, ...rest } });

test("clear noise is dropped; noise Jev isn't sure of goes where it most likely belongs", () => {
  assert.equal(sortThread(mail("This week's best reads"), said("noise", 0.9)), "noise");
  assert.equal(sortThread(mail("Weekend plans?"), said("noise", 0.45, { action: 0.35, reference: 0.15 })), "action");
  assert.equal(sortThread(mail("Some notes"), said("noise", 0.5, { reference: 0.3, action: 0.1 })), "reference");
});

test("nice-to-know mail isn't a kind any more: no fyi bucket to become a note", () => {
  assert.equal("fyi" in KINDS, false);
  assert.deepEqual(Object.keys(KINDS).sort(), ["action", "alert", "date", "noise", "receipt", "reference", "renewal"]);
});

test("orders, alerts, renewals and dates are read whatever Jev called them", () => {
  assert.equal(sortThread(mail("Your parcel is out for delivery"), said("noise", 0.95)), "receipt");
  assert.equal(sortThread(mail("Security alert", "New sign-in to your Google Account on a Windows device"), said("noise", 0.9)), "alert");
  assert.equal(sortThread(mail("Your payment failed", "We couldn't take your payment for Spotify Premium"), said("noise", 0.8)), "alert");
  assert.equal(sortThread(mail("Your car insurance renews on 3 January"), said("noise", 0.9)), "renewal");
  assert.equal(sortThread(mail("Reminder: your appointment on Tuesday"), said("reference", 0.7)), "date");
  // A real person's reply stays what Jev said.
  assert.equal(sortThread(mail("Re: the kitchen quote", "Here's the breakdown you asked for"), said("reference", 0.8)), "reference");
  // Jev's own kind wins over the wording when it isn't noise or reference.
  assert.equal(sortThread(mail("Your order has been dispatched"), said("action", 0.7)), "action");
});

test("the wording alone", () => {
  assert.equal(rescueKind(mail("Big savings this weekend")), null);
  assert.equal(rescueKind(mail("Unusual sign-in activity")), "alert");
  assert.equal(rescueKind(mail("Your MOT is due")), "renewal");
  assert.equal(rescueKind(mail("Your passport expires soon")), "renewal");
  assert.equal(rescueKind(mail("Booking confirmation", "Booking reference ABC123")), "receipt");
  assert.equal(rescueKind(mail("Engineer visit", "Our engineer will arrive between 8am and 12pm")), "date");
});

test("Claude is told which threads to read and which tool each goes to", () => {
  const t = (id: string, subject: string, kind: Kind) => ({ id, subject, from: "x@y.com", snippet: "", date: "", labels: [], kind });
  const note = triageNote([t("a", "Out for delivery", "receipt"), t("b", "New sign-in", "alert"), t("c", "Sale!", "noise"), t("d", "Sale 2", "noise")]);
  assert.match(note, /Read only these 2/);
  assert.match(note, /- a · Out for delivery · from x@y\.com \(receipt\)/);
  assert.match(note, /\(alert\): athena_alert/);
  assert.match(note, /\(receipt\): .*athena_purchase/);
  assert.doesNotMatch(note, /athena_renewal/, "only the kinds in this batch");
  assert.match(note, /The other 2 looked like newsletters/);
  assert.match(triageNote([t("c", "Sale!", "noise")]), /None of them look worth recording/);
});
