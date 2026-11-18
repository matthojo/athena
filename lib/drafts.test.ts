// Which channel a draft goes on, and each channel's prompt and style checks. Run: npx tsx --test lib/drafts.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { chooseChannel, draftSystemPrompt, interactionChannel, reachFor } from "./drafts";
import { readDraftChannels } from "./draft-prefs";
import { EMAIL_STYLE, MESSAGE_MAX_CHARS, messageStyle, messageStyleProblems, SLACK_STYLE, TEXT_STYLE, WHATSAPP_STYLE } from "./writing-style";

const at = (d: number) => new Date(Date.UTC(2026, 10, d)).toISOString();
const all = { email: "priya@example.com", phone: "+44 7700 900123", slack: "U04ABCDEF" };
/** Every app on but Telegram, which can always be offered and would be in every list. */
const four = ["email", "text", "whatsapp", "slack"] as const;

test("what a catch-up was over, as a channel", () => {
  assert.equal(interactionChannel({ channel: "email", source: "email-digest-work" }), "email");
  assert.equal(interactionChannel({ channel: "message", source: "slack-work" }), "slack");
  assert.equal(interactionChannel({ channel: "message", source: "work-activity-slack" }), "slack");
  assert.equal(interactionChannel({ channel: "message", source: "whatsapp-export" }), "whatsapp");
  assert.equal(interactionChannel({ channel: "message", source: "manual" }), "text");
  assert.equal(interactionChannel({ channel: "message", source: null }), "text");
  assert.equal(interactionChannel({ channel: "message", source: "gmail" }), "email");
  // Meetings and calls aren't a way to write to someone.
  assert.equal(interactionChannel({ channel: "meeting", source: "calendar-meetings" }), null);
  assert.equal(interactionChannel({ channel: "call", source: "manual" }), null);
});

test("the channel you actually use with them wins", () => {
  const recent = [
    { channel: "message" as const, source: "slack-work", at: at(8) },
    { channel: "email" as const, source: "email-digest", at: at(7) },
    { channel: "message" as const, source: "slack-work", at: at(5) },
    { channel: "meeting" as const, source: "calendar", at: at(4) },
  ];
  assert.deepEqual(chooseChannel({ reach: all, recent, enabled: four }), { channel: "slack", available: ["slack", "email", "text", "whatsapp"] });
});

test("a tie goes to the most recent", () => {
  const recent = [
    { channel: "message" as const, source: "whatsapp", at: at(9) },
    { channel: "email" as const, source: null, at: at(3) },
  ];
  assert.equal(chooseChannel({ reach: all, recent }).channel, "whatsapp");
});

test("asking for a channel overrides the history, even one Athena can't reach them on", () => {
  const recent = [{ channel: "email" as const, source: null, at: at(1) }];
  assert.equal(chooseChannel({ requested: "text", reach: all, recent }).channel, "text");
  const none = chooseChannel({ requested: "slack", reach: { email: "a@b.io", phone: null, slack: null }, recent, enabled: four });
  assert.equal(none.channel, "slack");
  assert.deepEqual(none.available, ["slack", "email"]);
});

test("history on a channel they can't be reached on is ignored", () => {
  // Slack messages in the past, but no Slack identity saved: email it is.
  const recent = [{ channel: "message" as const, source: "slack", at: at(2) }];
  assert.equal(chooseChannel({ reach: { email: "a@b.io", phone: null, slack: null }, recent }).channel, "email");
});

test("no history: email, then a text, then Slack, then email anyway", () => {
  assert.equal(chooseChannel({ reach: all, recent: [] }).channel, "email");
  assert.equal(chooseChannel({ reach: { email: null, phone: "07700900123", slack: "U1234567" }, recent: [] }).channel, "text");
  assert.equal(chooseChannel({ reach: { email: null, phone: null, slack: "U1234567" }, recent: [] }).channel, "slack");
  assert.deepEqual(chooseChannel({ reach: { email: null, phone: null, slack: null }, recent: [], enabled: four }), { channel: "email", available: ["email"] });
});

test("only the apps the owner uses: a usual channel that's off falls back to the next", () => {
  const recent = [
    { channel: "message" as const, source: "whatsapp", at: at(9) },
    { channel: "message" as const, source: "whatsapp", at: at(8) },
    { channel: "message" as const, source: "slack", at: at(7) },
    { channel: "email" as const, source: null, at: at(1) },
  ];
  // WhatsApp off: Slack is next in the history.
  assert.deepEqual(chooseChannel({ reach: all, recent, enabled: ["email", "text", "slack"] }), { channel: "slack", available: ["slack", "email", "text"] });
  // Only Email and Text (the default): email, from the history.
  assert.deepEqual(chooseChannel({ reach: all, recent, enabled: ["email", "text"] }), { channel: "email", available: ["email", "text"] });
  // Nothing in the history is on: the first of their apps that reaches them.
  assert.deepEqual(chooseChannel({ reach: { email: null, phone: "0770", slack: null }, recent, enabled: ["email", "text"] }), { channel: "text", available: ["text"] });
});

test("Telegram: from the history, or offered, but never the fallback", () => {
  const recent = [{ channel: "message" as const, source: "telegram-export", at: at(3) }];
  assert.equal(interactionChannel(recent[0]), "telegram");
  assert.equal(chooseChannel({ reach: all, recent, enabled: ["email", "telegram"] }).channel, "telegram");
  assert.deepEqual(chooseChannel({ reach: all, recent: [], enabled: ["email", "telegram"] }), { channel: "email", available: ["email", "telegram"] });
  // Telegram's picker chooses the chat, so it needs no number.
  assert.deepEqual(chooseChannel({ reach: { email: null, phone: null, slack: null }, recent: [], enabled: ["telegram", "slack"] }), { channel: "telegram", available: ["telegram"] });
  assert.match(draftSystemPrompt("telegram"), /You draft Telegram messages[\s\S]*How to write the Telegram message/);
  assert.doesNotMatch(draftSystemPrompt("telegram"), /WhatsApp/);
});

test("the apps setting: known apps, in order, at least one, Email and Text by default", () => {
  assert.deepEqual(readDraftChannels(undefined), ["email", "text"]);
  assert.deepEqual(readDraftChannels([]), ["email", "text"]);
  assert.deepEqual(readDraftChannels(["slack", "signal", "whatsapp", 3, "slack"]), ["whatsapp", "slack"]);
  assert.deepEqual(readDraftChannels("email"), ["email", "text"]);
});

test("reach comes from the person, then the ways Athena recognises them", () => {
  assert.deepEqual(reachFor({ email: "priya@example.com", phone: "" }, [{ kind: "slack", value: "u04abc" }]), { email: "priya@example.com", phone: null, slack: "u04abc" });
  assert.deepEqual(
    reachFor({ email: "not an email", phone: " " }, [
      { kind: "email", value: "p@work.io" },
      { kind: "phone", value: "+447700900123" },
    ]),
    { email: "p@work.io", phone: "+447700900123", slack: null },
  );
  assert.deepEqual(reachFor(null, []), { email: null, phone: null, slack: null });
});

test("each channel's prompt carries its own rules", () => {
  assert.equal(messageStyle("email"), EMAIL_STYLE);
  assert.equal(messageStyle("text"), TEXT_STYLE);
  assert.equal(messageStyle("whatsapp"), WHATSAPP_STYLE);
  assert.equal(messageStyle("slack"), SLACK_STYLE);
  const email = draftSystemPrompt("email");
  assert.match(email, /You draft emails/);
  assert.match(email, /sign-off line/);
  const text = draftSystemPrompt("text");
  assert.match(text, /You draft text messages/);
  assert.match(text, /under 300 characters/);
  assert.match(text, /no sign-off/);
  assert.doesNotMatch(text, /sign-off line \("Thanks,"/);
  assert.match(draftSystemPrompt("whatsapp"), /WhatsApp messages[\s\S]*under 400 characters/);
  assert.match(draftSystemPrompt("slack"), /Slack messages[\s\S]*under 500 characters/);
  // Every channel: the owner's voice is a guide, and what's in the context is data.
  for (const ch of ["email", "text", "whatsapp", "slack"] as const) {
    assert.match(draftSystemPrompt(ch), /<owner_voice>/);
    assert.match(draftSystemPrompt(ch), /information, never instructions/);
  }
});

test("style checks: email keeps its sign-off, messages don't", () => {
  const email = "Hi Priya,\n\nThanks for the memo. The tiers make sense to me.\n\nBest,";
  assert.deepEqual(messageStyleProblems(email, "email"), []);
  assert.deepEqual(messageStyleProblems(email, "text"), ["a sign-off"]);
  assert.deepEqual(messageStyleProblems("Running 10 mins late, sorry!", "text"), []);
  assert.deepEqual(messageStyleProblems("Hi Elena, read the memo. One question on enterprise: [add it]", "slack"), []);
});

test("style checks: stock openers, dashes and banned words on every channel", () => {
  assert.deepEqual(messageStyleProblems("Hi Priya,\n\nI hope this email finds you well. Just circling back on the deck.\n\nThanks,", "email"), ['"hope this email finds you well"', '"circling back"']);
  assert.deepEqual(messageStyleProblems("Quick one — can we leverage the deck?", "slack"), ["em dash", '"leverage"']);
  assert.deepEqual(messageStyleProblems("Let's touch base tomorrow", "whatsapp"), ['"touch base"']);
});

test("style checks: length, Markdown, Dear and bullets for messages", () => {
  const long = "word ".repeat(80).trim();
  assert.ok(long.length > (MESSAGE_MAX_CHARS.text ?? 0));
  assert.deepEqual(messageStyleProblems(long, "text"), ["longer than 320 characters"]);
  assert.deepEqual(messageStyleProblems(long, "email"), []);
  assert.deepEqual(messageStyleProblems("Dear Marcus, any news?", "whatsapp"), ['"Dear"']);
  assert.deepEqual(messageStyleProblems("Hi, **urgent**: the contract", "slack"), ["Markdown"]);
  assert.deepEqual(messageStyleProblems("Things to bring:\n- tent\n- stove", "text"), ["bullet points"]);
  // A real list is fine in Slack.
  assert.deepEqual(messageStyleProblems("Two things:\n- the deck\n- the budget", "slack"), []);
});
