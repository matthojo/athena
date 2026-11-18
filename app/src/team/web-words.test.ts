// Looking things up online, in words. Run: npx tsx --test app/src/team/web-words.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import type { Personality } from "../../../lib/team-types";
import { WEB_FOLLOWS, isPriceJob, webBlockedDetail, webChat, webDetail, webLabel, webNeededLine, webTerm, webTermSettingOff } from "./web-words";

const she: Personality = { tone: "warm", traits: [], pronoun: "she", greeting: "" };
const they: Personality = { tone: "crisp", traits: [], pronoun: "they", greeting: "" };
const he: Personality = { tone: "calm", traits: [], pronoun: "he", greeting: "" };

test("a job about prices reads as one", () => {
  assert.equal(isPriceJob("Finds good prices for gift ideas"), true);
  assert.equal(isPriceJob("When I save a gift idea, find a good price"), true);
  assert.equal(isPriceJob("Tells me when something I want is on sale"), true);
  assert.equal(isPriceJob("Sums up your week every Friday"), false);
  assert.equal(isPriceJob("Turns Linear issues assigned to you into to-dos"), false);
  // Not a word inside another one.
  assert.equal(isPriceJob("Keeps my priceless photos tidy"), false);
});

test("the switch is about working on its own, and chats aren't (owner, 16 Nov 2026)", () => {
  assert.equal(webLabel(she), "Can look things up online on her own");
  assert.equal(webLabel(they), "Can look things up online on their own");
  assert.equal(webChat(she), "In a chat, she searches the way Ask does, with this on or off.");
  assert.equal(webChat(they), "In a chat, they search the way Ask does, with this on or off.");
});

test("what a search may carry, in the assistant's own pronoun", () => {
  assert.equal(webDetail(she), "Searches the web and reads pages when she works on her own. A search can include where you live, what she's looking for and the shops she knows you use. Nothing else about you.");
  assert.equal(webDetail(they), "Searches the web and reads pages when they work on their own. A search can include where you live, what they're looking for and the shops they know you use. Nothing else about you.");
  assert.match(webDetail(he), /when he works on his own\./);
  assert.match(WEB_FOLLOWS, /“Let Ask search the web”/);
});

test("needing it while it's off says what it'll miss, plainly", () => {
  assert.equal(webNeededLine("Muse", "Finds good prices for gift ideas", she), "Muse needs this to check prices. Without it, her runs only see what you've saved.");
  assert.equal(webNeededLine("Kit", "Checks opening hours before I go out", they), "Kit needs this for the job. Without it, their runs only see what's in Athena.");
});

test("with the app-wide setting off, it says why and what happens next", () => {
  assert.equal(webBlockedDetail("Muse", true), "“Let Ask search the web” is off in Settings. Muse will look things up once it's on.");
  assert.equal(webBlockedDetail("Dot", false), "“Let Ask search the web” is off in Settings. Turn it on there, then choose here whether Dot can.");
});

test("at hiring it speaks for itself, and changes its mind when you switch it off", () => {
  assert.equal(webTerm("Finds a good price", true), "I'll check prices online as I work.");
  assert.equal(webTerm("Checks opening hours", true), "I'll look things up online as I work.");
  assert.equal(webTerm("Finds a good price", false), "On my own, I'll stick to what's in Athena.");
  assert.match(webTermSettingOff("Finds a good price"), /^I'd check prices online, but web search is off in Settings\.$/);
});

test("no line says “it” for the assistant, and none uses a dash", () => {
  const lines = [webLabel(she), webChat(she), webDetail(she), webNeededLine("Muse", "Finds good prices", she), webBlockedDetail("Muse", true), webTerm("x", true)];
  for (const l of lines) {
    assert.doesNotMatch(l, /\bit (works|sees|knows)\b/);
    assert.doesNotMatch(l, /[—–]/);
  }
});
