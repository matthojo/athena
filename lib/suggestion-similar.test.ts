// Run: npx tsx --test lib/suggestion-similar.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { caughtBy, emailIdOf, groupSimilar, ignoreChoices, mailFrom, senderDomain, similarKey, subjectPhrase } from "./suggestion-similar";

test("repeats differ only by a date, a time, a number or a reference", () => {
  const a = similarKey({ op: "event", summary: "Appointment: Spin class at Northfield Leisure · 2026-11-25" });
  const b = similarKey({ op: "event", summary: "Appointment: Spin class at Northfield Leisure · 2026-12-02" });
  assert.ok(a);
  assert.equal(a, b);
  assert.equal(
    similarKey({ op: "commitment", summary: "To do: Pay invoice INV-2041 by Friday" }),
    similarKey({ op: "commitment", summary: "To do: Pay invoice INV-2077 by Monday" }),
  );
  assert.equal(
    similarKey({ op: "purchase", summary: "Out for delivery: Larkspur Home order #4417" }),
    similarKey({ op: "purchase", summary: "Out for delivery: Larkspur Home order #4502" }),
  );
});

test("different things, or the same words for a different op, stay apart", () => {
  assert.notEqual(similarKey({ op: "event", summary: "Appointment: Dentist check-up · 2026-11-25" }), similarKey({ op: "event", summary: "Appointment: Spin class · 2026-11-25" }));
  assert.notEqual(similarKey({ op: "event", summary: "Renew the parking permit for the van" }), similarKey({ op: "commitment", summary: "Renew the parking permit for the van" }));
});

test("too little left to compare is never grouped", () => {
  assert.equal(similarKey({ op: "commitment", summary: "To do: Call 07700 900123" }), null);
  assert.equal(similarKey({ op: "event", summary: "Friday 6 December at 19:30" }), null);
});

test("groups keep the order they were given, each led by its first", () => {
  const items = [
    { id: "1", op: "event", summary: "Appointment: Spin class at Northfield Leisure · 2026-12-02" },
    { id: "2", op: "commitment", summary: "You told Marcus you'd send him the hiring rubric" },
    { id: "3", op: "event", summary: "Appointment: Spin class at Northfield Leisure · 2026-11-25" },
    { id: "4", op: "event", summary: "Appointment: Spin class at Northfield Leisure · 2026-11-18" },
  ];
  assert.deepEqual(groupSimilar(items).map((g) => g.map((s) => s.id)), [["1", "3", "4"], ["2"]]);
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
