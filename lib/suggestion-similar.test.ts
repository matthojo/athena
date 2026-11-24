// Run: npx tsx --test lib/suggestion-similar.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { caughtBy, emailIdOf, groupSame, ignoreChoices, mailFrom, sameKey, senderDomain, subjectPhrase } from "./suggestion-similar";

test("the same thing, worded the same, is one thing", () => {
  assert.equal(
    sameKey({ op: "event", summary: "Appointment: Spin class at Northfield Leisure · 2026-11-25" }),
    sameKey({ op: "event", summary: "appointment — spin class at Northfield Leisure, 2026-11-25." }),
  );
  assert.equal(sameKey({ op: "commitment", summary: "To do: Pay the invoice" }), sameKey({ op: "commitment", summary: "To do: pay invoice" }));
  assert.equal(sameKey({ op: "fact", summary: "Elena’s moving to Lisbon" }), sameKey({ op: "fact", summary: "Elenas moving to Lisbon" }));
});

test("another date, another number or another op is another thing", () => {
  assert.notEqual(sameKey({ op: "event", summary: "Appointment: Spin class · 2026-11-25" }), sameKey({ op: "event", summary: "Appointment: Spin class · 2026-12-02" }));
  assert.notEqual(sameKey({ op: "purchase", summary: "Out for delivery: order #4417" }), sameKey({ op: "purchase", summary: "Out for delivery: order #4502" }));
  assert.notEqual(sameKey({ op: "event", summary: "Renew the parking permit" }), sameKey({ op: "commitment", summary: "Renew the parking permit" }));
});

test("groups keep the order they were given, each led by its first", () => {
  const items = [
    { id: "1", op: "event", summary: "Appointment: Spin class · 2026-12-02" },
    { id: "2", op: "commitment", summary: "You told Marcus you'd send him the hiring rubric" },
    { id: "3", op: "event", summary: "Appointment: spin class · 2026-12-02" },
    { id: "4", op: "event", summary: "Appointment: Spin class · 2026-12-09" },
  ];
  assert.deepEqual(groupSame(items).map((g) => g.map((s) => s.id)), [["1", "3"], ["2"], ["4"]]);
});

test("mailFrom reads search, thread and message replies", () => {
  const search = JSON.stringify({
    threads: [
      { id: "t1", messages: [{ id: "m1", sender: "Northfield Leisure <bookings@northfield.example>", subject: "Your class this Thursday" }, { id: "m2", sender: "Sam Lee <sam@example.com>", subject: "Re: Your class this Thursday" }] },
      { id: "t2", messages: [{ id: "m3" }] },
    ],
  });
  const s = mailFrom(search);
  assert.deepEqual(s.get("t1"), { from: "Northfield Leisure <bookings@northfield.example>", subject: "Your class this Thursday" });
  assert.equal(s.get("m2")?.from, "Sam Lee <sam@example.com>");
  assert.equal(s.has("t2"), false);
  const message = mailFrom(JSON.stringify({ id: "m9", threadId: "t9", sender: "orders@larkspur.example", subject: "Order #4417 shipped" }));
  assert.equal(message.get("t9")?.subject, "Order #4417 shipped");
  assert.equal(message.get("m9")?.from, "orders@larkspur.example");
  assert.equal(mailFrom("Not JSON").size, 0);
  assert.equal(mailFrom(JSON.stringify({ events: [] })).size, 0);
});

test("a metadata-only search doesn't replace a subject already known", () => {
  const m = mailFrom(JSON.stringify({ threads: [{ id: "t1", messages: [{ id: "m1", sender: "a@shop.example" }, { id: "m2", sender: "a@shop.example", subject: "Weekly offers" }] }] }));
  assert.equal(m.get("t1")?.subject, "Weekly offers");
});

test("emailIdOf takes the source and any part off", () => {
  assert.equal(emailIdOf("email-digest:18c2ab#spin-class", "email-digest"), "18c2ab");
  assert.equal(emailIdOf("email-digest-personal:abc", "email-digest-personal"), "abc");
  assert.equal(emailIdOf(null, "email-digest"), null);
});

test("ignore choices: the address, its organisation, and a lasting subject phrase", () => {
  assert.deepEqual(ignoreChoices({ from: "Northfield Leisure <Bookings@Mail.Northfield.example>", subject: "Your class this Thursday at 7pm" }), {
    sender: "bookings@mail.northfield.example",
    domain: "northfield.example",
    subject: "Your class this",
  });
  assert.equal(ignoreChoices({ from: "sam.lee@gmail.com", subject: "Hello" }).domain, null);
  assert.equal(senderDomain("news@offers.shop.co.uk"), "shop.co.uk");
  assert.deepEqual(ignoreChoices(null), { sender: null, domain: null, subject: null });
});

test("subject phrases skip what changes and Re:", () => {
  assert.equal(subjectPhrase("Your order #4417 has shipped"), "has shipped");
  assert.equal(subjectPhrase("Re: Fwd: Weekly report for 18 Nov"), "Weekly report");
  assert.equal(subjectPhrase("12/11"), null);
});

test("caughtBy matches the way the mail rules do", () => {
  const email = { from: "Larkspur <orders@mail.larkspur.example>", subject: "Your order has shipped" };
  assert.equal(caughtBy(email, { kind: "sender", value: "orders@mail.larkspur.example" }), true);
  assert.equal(caughtBy(email, { kind: "sender", value: "larkspur.example" }), true);
  assert.equal(caughtBy(email, { kind: "sender", value: "other.example" }), false);
  assert.equal(caughtBy(email, { kind: "subject", value: "has SHIPPED" }), true);
  assert.equal(caughtBy(null, { kind: "subject", value: "x" }), false);
});
