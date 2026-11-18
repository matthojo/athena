// Run: npx tsx --test app/src/lib/create-event.test.ts
// The four ways to add an event, as the app prefills them: the slot card's "Book it", Ask's
// "lunch with Priya Thursday at 1", Check in's "Add to calendar" for a booking, and a to-do's
// "Block time for this". Plus the confirm sheet's invite line.
import { test } from "node:test";
import assert from "node:assert/strict";
import { blockAsk, bookingAsk, bookingMinutes, dayIn, inviteLine, slotBooking, timeIn } from "./create-event";
import type { SlotCard } from "../db/scheduling";

const TODAY = "2026-11-09"; // a Monday
const at = (date: string, time: string) => `${date}T${time}:00Z`;

test("the invite line says who gets an invite, and that no one does for a booking or a block", () => {
  const priya = { name: "Priya Shah", email: "priya@example.com" };
  const marcus = { name: "Marcus Webb", email: "marcus@example.com" };
  const elena = { name: "Dr Elena Costa", email: "elena@example.com" };
  assert.equal(inviteLine([priya, marcus], "meeting"), "Priya and Marcus get an invite.");
  assert.equal(inviteLine([priya], "meeting"), "Priya gets an invite.");
  assert.equal(inviteLine([priya, marcus, elena], "meeting"), "Priya, Marcus and Elena get an invite.");
  assert.equal(inviteLine([], "meeting"), "No one is invited.");
  assert.equal(inviteLine([], "booking"), "Just for you. No one is invited.");
  assert.equal(inviteLine([priya], "focus"), "On your calendar only. No one is invited.", "a block never invites, whatever's passed");
});

test("1. Book it: the slot's time, the card's title and its people, with the addresses Athena has", () => {
  const card: SlotCard = {
    minutes: 30,
    tz: "Europe/London",
    title: "A 30 min call with Priya and Marcus",
    slots: [{ start: "2026-11-10T11:00:00.000Z", end: "2026-11-10T11:30:00.000Z" }, { start: "2026-11-11T14:30:00.000Z", end: "2026-11-11T15:00:00.000Z" }],
    people: [{ name: "Priya Shah", email: "priya@example.com", seen: true }, { name: "Marcus Webb", email: "", seen: false }],
    unread: [],
  };
  assert.deepEqual(slotBooking(card, 1), {
    kind: "meeting",
    title: "Call with Priya and Marcus",
    start: "2026-11-11T14:30:00.000Z",
    end: "2026-11-11T15:00:00.000Z",
    who: [{ name: "Priya Shah", email: "priya@example.com" }, { name: "Marcus Webb" }],
  });
  assert.equal(slotBooking({ ...card, minutes: 60, title: "A 1 hour call with Priya and Marcus" }, 0).title, "Meeting with Priya and Marcus", "longer than 30 minutes is a meeting");
  assert.equal(slotBooking({ ...card, people: [card.people[0]] }, 0).title, "Call with Priya");
  assert.equal(slotBooking({ ...card, title: "Pricing tiers with Priya" }, 0).title, "Pricing tiers with Priya", "the owner's own words stay");
});

test("3. Check in: a booking or appointment becomes an event with no guests, on the day and at the time it says", () => {
  const dishoom = bookingAsk(
    { summary: "Dishoom confirmed your table for 4 on Friday 13 November at 19:30", source_quote: "Your table for 4 at Dishoom King's Cross is booked.", payload: { title: "Dinner at Dishoom, table for 4", date: "2026-11-13", time: "19:30", location: "Dishoom King's Cross" } },
    TODAY,
    at
  );
  assert.deepEqual(dishoom, { kind: "booking", title: "Dinner at Dishoom, table for 4", start: "2026-11-13T19:30:00.000Z", minutes: 90, location: "Dishoom King's Cross", known: { day: true, time: true } });
  assert.equal("who" in dishoom!, false, "a booking never carries guests");

  const dentist = bookingAsk({ summary: "Dentist appointment confirmed", source_quote: "Your check-up with Dr Okafor is confirmed for Tuesday 17 November at 3:15pm.", payload: {} }, TODAY, at)!;
  assert.equal(dentist.start, "2026-11-17T15:15:00.000Z");
  assert.equal(dentist.minutes, 30);
  assert.equal(dentist.title, "Dentist appointment confirmed");

  const yoga = bookingAsk({ summary: "You're booked on Thursday's yoga class at 7am", source_quote: null, payload: null }, TODAY, at)!;
  assert.equal(yoga.start, "2026-11-12T07:00:00.000Z");
  assert.equal(yoga.minutes, 60);

  // A day but no time: 09:00 that day, flagged for the owner to set in the sheet.
  const noTime = bookingAsk({ summary: "Haircut booked for Saturday", source_quote: "", payload: {} }, TODAY, at)!;
  assert.equal(noTime.start, "2026-11-14T09:00:00.000Z");
  assert.deepEqual(noTime.known, { day: true, time: false });

  // Asking to meet is "Suggest times", and a plain fact is neither.
  assert.equal(bookingAsk({ summary: "Priya asked for 30 minutes next week", source_quote: "Could we grab 30 minutes next week?", payload: {} }, TODAY, at), null);
  assert.equal(bookingAsk({ summary: "Elena is moving to Lisbon in the spring", source_quote: "Lisbon in the spring!", payload: {} }, TODAY, at), null);
});

test("dates and times in an email, and how long things last", () => {
  assert.equal(dayIn("on 12 November", TODAY), "2026-11-12");
  assert.equal(dayIn("Nov 3rd", TODAY), "2027-11-03", "a date already gone is next year's");
  assert.equal(dayIn("tomorrow", TODAY), "2026-11-10");
  assert.equal(dayIn("this Friday", TODAY), "2026-11-13");
  assert.equal(dayIn("14/11", TODAY), "2026-11-14");
  assert.equal(dayIn("soon", TODAY), null);
  assert.equal(timeIn("at 7:30pm"), "19:30");
  assert.equal(timeIn("12am"), "00:00");
  assert.equal(timeIn("doors 18.45"), "18:45");
  assert.equal(timeIn("at noon"), "12:00");
  assert.equal(timeIn("table for 4"), null);
  assert.equal(bookingMinutes("a 45 minute massage"), 45);
  assert.equal(bookingMinutes("Tickets for Hamlet"), 150);
  assert.equal(bookingMinutes("Your table is booked. We'll hold it for 15 minutes."), 90, "a grace period isn't the length");
});

test("4. Block time: the to-do's title, an hour unless it says, before it's due", () => {
  assert.deepEqual(blockAsk({ title: "Draft the Q3 planning doc", notes: "Now / next / later", due_on: "2026-11-13" }), { title: "Draft the Q3 planning doc", minutes: 60, due: "2026-11-13" });
  assert.equal(blockAsk({ title: "Review the deck (2 hours)" }).minutes, 120);
  assert.equal(blockAsk({ title: "Expenses", notes: "about 30 mins" }).minutes, 30);
  assert.equal(blockAsk({ title: "Write it all", notes: "10 hours" }).minutes, 240, "at most four hours");
});
