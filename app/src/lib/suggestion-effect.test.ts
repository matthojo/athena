// Run: npx tsx --test app/src/lib/suggestion-effect.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { setUses12Hour } from "./clock";
import { acceptLabel, acceptedToast, consequence } from "./suggestion-effect";
import type { Suggestion } from "../types";

setUses12Hour(false);
// Dates in another year than this one say which.
const Y = String(new Date().getFullYear() + 1);
const names = new Map([["p1", "Marcus"], ["p2", "Elena"]]);
const card = (op: Suggestion["op"], payload: Record<string, unknown>, existing: Suggestion["existing"] = null) => ({ op, payload, existing });

test("an order not yet in Purchases is added, at its status", () => {
  const s = card("purchase", { retailer: "Amazon", status: "delivered" });
  assert.equal(consequence(s, names), "Adds the order to Purchases, marked delivered");
  assert.equal(acceptLabel(s), "Add to Purchases");
  assert.equal(acceptedToast(s), "Added to Purchases");
});

test("an order already in Purchases is moved on: Update status", () => {
  const s = card("purchase", { retailer: "Amazon", status: "delivered" }, { id: "o1", status: "dispatched" });
  assert.equal(consequence(s, names), "Moves your order in Purchases from dispatched to delivered");
  assert.equal(acceptLabel(s), "Update status");
  assert.equal(acceptedToast(s), "Order updated");
});

test("an order already at that status only gains the email", () => {
  const s = card("purchase", { status: "delivered" }, { id: "o1", status: "delivered" });
  assert.equal(consequence(s, names), "Adds this email to your order in Purchases, already marked delivered");
  assert.equal(acceptLabel(s), "Update order");
});

test("a booking: added to Trips, or the saved one updated", () => {
  const fresh = card("booking", { kind: "train", start_local: `${Y}-12-12T07:05`, start_city: "York" });
  assert.equal(consequence(fresh, names), `Adds it to Trips · 12 December ${Y} at 07:05 from York`);
  assert.equal(acceptLabel(fresh), "Add to Trips");
  const moved = card("booking", { kind: "train", start_local: `${Y}-12-12T08:05` }, { id: "b1", name: "York to Leeds", status: "confirmed" });
  assert.equal(consequence(moved, names), `Updates your train booking in Trips · 12 December ${Y} at 08:05`);
  assert.equal(acceptLabel(moved), "Update booking");
  const cancelled = card("booking", { kind: "hotel", status: "cancelled", start_local: `${Y}-12-12` }, { id: "b2", status: "confirmed" });
  assert.equal(consequence(cancelled, names), "Marks your hotel booking cancelled in Trips");
});

test("a detail: remembered, or replacing what's saved", () => {
  const fresh = card("fact", { subject_kind: "person", subject_id: "p2", key: "Moving", value: "To Lisbon" });
  assert.equal(consequence(fresh, names), "Adds to Elena’s details · Moving: To Lisbon");
  assert.equal(acceptLabel(fresh), "Remember");
  const replacing = card("fact", { subject_kind: "person", subject_id: "p2", key: "Moving", value: "To Porto" }, { id: "f1", value: "To Lisbon" });
  assert.equal(consequence(replacing, names), "Replaces Elena’s moving, “To Lisbon”");
  assert.equal(acceptLabel(replacing), "Replace");
  const me = card("fact", { subject_kind: "me", key: "Sleep", value: "Bed by 11" }, { id: "f2", value: "Bed by 12" });
  assert.equal(consequence(me, names), "Replaces “Bed by 12” in Settings, under About you");
});

test("a to-do says who it's for, or who you're waiting on", () => {
  assert.equal(consequence(card("commitment", { kind: "i_owe", person_id: "p1", due_on: "2026-12-04" }), names), "Adds a to-do for Marcus, due 4 December");
  assert.equal(consequence(card("commitment", { kind: "waiting_on", person_id: "p1" }), names), "Adds it to To do, waiting on Marcus");
  assert.equal(acceptLabel(card("commitment", {})), "Add to To do");
  assert.equal(acceptLabel(card("commitment", { id: "c1" }, { id: "c1", name: "Send the rubric" })), "Update to-do");
});

test("an event says when, from a date or an instant", () => {
  assert.equal(consequence(card("event", { date: `${Y}-12-12`, time: "19:30" }), names), `Adds it to Events · 12 December ${Y} at 19:30`);
  // Appointments from email carry an instant, not a date and time; this year's needs no year.
  const at = new Date(Number(Y) - 1, 11, 31, 9, 15);
  assert.equal(consequence(card("event", { starts_at: at.toISOString() }), names), "Adds it to Events · 31 December at 09:15");
  assert.equal(acceptLabel(card("event", {})), "Add to Events");
});

test("people, catch-ups and links name what they do", () => {
  assert.equal(consequence(card("person", { name: "Ada" }), names), "Adds Ada to People");
  assert.equal(acceptLabel(card("interaction", {})), "Log catch-up");
  assert.equal(consequence(card("link", { sourceType: "note", sourceId: "n1", targetType: "person", targetId: "p1" }), names), "Links a note with Marcus");
});
