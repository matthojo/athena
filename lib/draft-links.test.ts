// The links a draft opens: sms:, wa.me, Slack DMs and mailto:. Run: npx tsx --test lib/draft-links.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { dialable, diallingCode, internationalDigits, mailtoLink, parseSlackIdentity, slackDmLink, smsLink, SLACK_OPEN, telegramLink, whatsappLink } from "./draft-links";

test("dialling codes come from the locale's region", () => {
  assert.equal(diallingCode("en-GB"), "44");
  assert.equal(diallingCode("en_US"), "1");
  assert.equal(diallingCode("fr-FR"), "33");
  assert.equal(diallingCode("en"), null);
  assert.equal(diallingCode(undefined), null);
  assert.equal(diallingCode("xx-ZZ"), null);
});

test("numbers become international digits for wa.me, however they were saved", () => {
  assert.equal(internationalDigits("+44 7700 900123"), "447700900123");
  assert.equal(internationalDigits("+44 (0)7700 900123"), "447700900123");
  assert.equal(internationalDigits("0044 7700 900123"), "447700900123");
  assert.equal(internationalDigits("07700 900123", "44"), "447700900123");
  assert.equal(internationalDigits("(415) 555-0134", "1"), "14155550134");
  assert.equal(internationalDigits("1-415-555-0134", "1"), "14155550134");
  assert.equal(internationalDigits("447700900123"), "447700900123");
  // A national number with no country to go on can't be made international.
  assert.equal(internationalDigits("07700 900123"), null);
  assert.equal(internationalDigits("12345"), null);
  assert.equal(internationalDigits("+1234567890123456"), null);
});

test("sms: links carry the number and the words, encoded", () => {
  assert.equal(smsLink("+44 7700 900123", "Running late, 10 mins?"), "sms:+447700900123?&body=Running%20late%2C%2010%20mins%3F");
  assert.equal(smsLink("07700 900123", "Hi", "44"), "sms:+447700900123?&body=Hi");
  // Ampersands, hashes, line breaks and emoji can't break out of the body.
  assert.equal(smsLink("+447700900123", "Tom & Jo #2\nsee you 🙂"), "sms:+447700900123?&body=Tom%20%26%20Jo%20%232%0Asee%20you%20%F0%9F%99%82");
  // No number: Messages asks who it's to.
  assert.equal(smsLink(null, "Hi"), "sms:?&body=Hi");
  assert.equal(smsLink("", "Hi"), "sms:?&body=Hi");
  // A short code or an extension stays as typed, digits only.
  assert.equal(dialable("6 1 2 3 4"), "61234");
});

test("wa.me links: digits only, no + or 00, and the text encoded", () => {
  assert.equal(whatsappLink("+44 7700 900123", "Lovely to see you!"), "https://wa.me/447700900123?text=Lovely%20to%20see%20you!");
  assert.equal(whatsappLink("07700 900123", "Hi", "44"), "https://wa.me/447700900123?text=Hi");
  assert.equal(whatsappLink("0033 6 12 34 56 78", "Salut"), "https://wa.me/33612345678?text=Salut");
  assert.equal(whatsappLink("+447700900123", "a+b=c?&d"), "https://wa.me/447700900123?text=a%2Bb%3Dc%3F%26d");
  // Unknown or unusable number: WhatsApp lets them pick the chat.
  assert.equal(whatsappLink(null, "Hi"), "https://wa.me/?text=Hi");
  assert.equal(whatsappLink("07700 900123", "Hi"), "https://wa.me/?text=Hi");
});

test("Slack identities: member IDs, with or without the workspace, links and handles", () => {
  assert.deepEqual(parseSlackIdentity("U04ABCDEF"), { user: "U04ABCDEF", team: null, handle: null });
  assert.deepEqual(parseSlackIdentity("@W012ABCDE"), { user: "W012ABCDE", team: null, handle: null });
  assert.deepEqual(parseSlackIdentity("T01TEAM12/U04ABCDEF"), { user: "U04ABCDEF", team: "T01TEAM12", handle: null });
  assert.deepEqual(parseSlackIdentity("T01TEAM12:U04ABCDEF"), { user: "U04ABCDEF", team: "T01TEAM12", handle: null });
  assert.deepEqual(parseSlackIdentity("https://app.slack.com/client/T01TEAM12/D05DMCHAT1"), { user: "D05DMCHAT1", team: "T01TEAM12", handle: null });
  // Saved identities are lowercased: still a member ID. A handle isn't one, even one that starts with u.
  assert.deepEqual(parseSlackIdentity("u04abcdef"), { user: "U04ABCDEF", team: null, handle: null });
  assert.deepEqual(parseSlackIdentity("t01team12/u04abcdef"), { user: "U04ABCDEF", team: "T01TEAM12", handle: null });
  assert.deepEqual(parseSlackIdentity("@ursula"), { user: null, team: null, handle: "ursula" });
  assert.deepEqual(parseSlackIdentity("wilhelmina"), { user: null, team: null, handle: "wilhelmina" });
  assert.deepEqual(parseSlackIdentity("priya.shah"), { user: null, team: null, handle: "priya.shah" });
});

test("Slack DM deep links", () => {
  assert.equal(slackDmLink("T01TEAM12/U04ABCDEF"), "slack://user?team=T01TEAM12&id=U04ABCDEF");
  assert.equal(slackDmLink("U04ABCDEF", "T01TEAM12"), "slack://user?team=T01TEAM12&id=U04ABCDEF");
  assert.equal(slackDmLink("https://app.slack.com/client/T01TEAM12/D05DMCHAT1"), "slack://channel?team=T01TEAM12&id=D05DMCHAT1");
  // No workspace: Slack's redirect finds it.
  assert.equal(slackDmLink("U04ABCDEF"), "https://slack.com/app_redirect?channel=U04ABCDEF");
  // A handle alone can't open a DM; the sheet opens Slack instead.
  assert.equal(slackDmLink("priya"), null);
  assert.equal(slackDmLink(""), null);
  assert.equal(slackDmLink(null), null);
  assert.equal(SLACK_OPEN, "slack://open");
});

test("mailto: links keep subject and body, spaces as %20", () => {
  assert.equal(mailtoLink(["priya@example.com"], "Q4 budget", "Hi Priya,\n\nThanks & speak soon"), "mailto:priya%40example.com?subject=Q4%20budget&body=Hi%20Priya%2C%0A%0AThanks%20%26%20speak%20soon");
  assert.equal(mailtoLink([], "", "Hi"), "mailto:?body=Hi");
  assert.equal(mailtoLink(["a@x.io", "b@y.io"], "", ""), "mailto:a%40x.io,b%40y.io");
});

test("Telegram opens its share picker with the text filled in", () => {
  assert.equal(telegramLink("See you at 7 & bring snacks"), "https://t.me/share/url?url=See%20you%20at%207%20%26%20bring%20snacks");
});
