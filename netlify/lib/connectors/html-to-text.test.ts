// Security review M19: htmlToText on hostile email and calendar HTML, with a time bound, and what it still writes for ordinary HTML.
// Run: npx tsx --test netlify/lib/connectors/html-to-text.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { htmlToText, MAX_HTML_TO_TEXT } from "./google-api";
import { messageText } from "./google-gmail";
import { eventOut } from "./google-calendar";

const fill = (unit: string, chars: number) => unit.repeat(Math.ceil(chars / unit.length));
const ms = (run: () => unknown) => {
  const t = performance.now();
  run();
  return performance.now() - t;
};

test("M19: hostile HTML is converted in a fraction of a second, at any size", () => {
  // Before: 100 KB of "<a " took 0.83 s and 200 KB 3.4 s (about 85 s at 1 MB), every time the message was opened.
  const units = ["<a ", "<!--", "<style>", "<script ", "<title", "<", "<<", "<a href=x>", "<a>", '<a href="https://x.example/">t', "<li ", "<div ", "</p ", "<a href=x", "<!-- <a href=x>y", "&amp", "<noscript><a href=x>"];
  for (const unit of units) {
    for (const size of [200_000, 1_000_000, 4_000_000]) {
      const took = ms(() => htmlToText(fill(unit, size)));
      assert.ok(took < 400, `${JSON.stringify(unit)} × ${size} took ${Math.round(took)} ms`);
    }
    // One closer at the very end must not make every opener scan to it.
    const closed = ms(() => htmlToText(`${fill(unit, MAX_HTML_TO_TEXT - 20)}--></a></style></script>`));
    assert.ok(closed < 400, `${JSON.stringify(unit)} closed at the end took ${Math.round(closed)} ms`);
  }
});

test("M19: an HTML-only email of hostile markup opens quickly through Gmail's reader", () => {
  const data = Buffer.from(fill("<a ", 1_000_000)).toString("base64url");
  const took = ms(() => messageText({ mimeType: "text/html", body: { data } } as never));
  assert.ok(took < 500, `took ${Math.round(took)} ms`);
});

test("M19: a calendar description is cut before it is converted", () => {
  const description = `<p>Agenda</p>${fill("<a ", 2_000_000)}`;
  let out: { description?: string } = {};
  const took = ms(() => {
    out = eventOut({ id: "e1", summary: "Sync", description, start: { dateTime: "2026-11-10T10:00:00Z" }, end: { dateTime: "2026-11-10T10:30:00Z" } } as never, true) as { description?: string };
  });
  assert.ok(took < 300, `took ${Math.round(took)} ms`);
  assert.ok(out.description?.startsWith("Agenda"));
  assert.ok((out.description ?? "").length <= 3_001);
});

test("htmlToText still reads ordinary HTML the same way", () => {
  assert.equal(
    htmlToText(`<html><head><title>Order</title><style>p { color: red }</style></head><body><!-- hidden --><p>Your order <b>#123</b> has shipped.</p>
      <p>Track it: <a class="btn" href="https://track.example/abc?x=1&amp;y=2">Track parcel</a></p><script>alert("x")</script>
      <ul><li>One</li><li>Two</li></ul><table><tr><td>A</td><td>B</td></tr></table>Line<br>break &amp; done</body></html>`),
    "Your order #123 has shipped.\n\nTrack it: Track parcel (https://track.example/abc?x=1&y=2)\n\n- One\n- Two\n\nA B\n\nLine\nbreak & done",
  );
  // A link whose text is its address, a non-http link and an over-long one are written as text only.
  assert.equal(htmlToText('<a href="https://a.example/">https://a.example/</a>'), "https://a.example/");
  assert.equal(htmlToText('<a href="mailto:x@a.example">Write</a> <a href=\'javascript:alert(1)\'>Tap</a>'), "Write Tap");
  assert.equal(htmlToText(`<a href="https://a.example/${"x".repeat(300)}">Long</a>`), "Long");
  assert.equal(htmlToText("<a href=https://a.example/u>Bare</a>"), "Bare (https://a.example/u)");
  assert.equal(htmlToText('<A HREF="https://a.example/">Up</A  >'), "Up (https://a.example/)");
  assert.equal(htmlToText('<a name="top">Anchor</a> and <a href="https://a.example/">link <i>here</i></a>'), "Anchor and link here (https://a.example/)");
  // Unclosed blocks are left for the tag stripper, as before.
  assert.equal(htmlToText("before <!-- never closed"), "before <!-- never closed");
  assert.equal(htmlToText("<style>p{}</style>kept<script>gone()</script> too<noscript>x</noscript>"), "kept too");
  assert.equal(htmlToText("<p>a</p><style>unclosed"), "a\nunclosed");
  // Past the cap, the rest is dropped.
  assert.equal(htmlToText(`${"a".repeat(MAX_HTML_TO_TEXT)}<p>tail</p>`), "a".repeat(MAX_HTML_TO_TEXT));
});
