import assert from "node:assert/strict";
import { test } from "node:test";

test("a contraction of a stop word is a stop word: \"What's\" isn't what a question is about", async () => {
  const { keywords } = await import("./ask");
  assert.deepEqual(keywords("What's the weather like tomorrow?"), ["weather", "tomorrow", "like"]);
  assert.deepEqual(keywords("What’s something we can watch tonight?"), ["watch", "tonight"]);
  assert.deepEqual(keywords("Where's Priya's memo? I don't know"), ["priya", "memo"]);
});

test("up to eight words, the most telling first: names and figures, then longer words, weak ones last", async () => {
  const { keywords, MAX_KEYWORDS } = await import("./ask");
  assert.deepEqual(keywords("What did Elena and Priya agree about the Q3 pricing memo last week?"), ["q3", "elena", "priya", "pricing", "agree", "memo", "last", "week"]);
  // The old rule kept the four longest, so "Lisbon" lost to "restaurant" and "recommended".
  const long = keywords("Which restaurant near the Lisbon apartment had Marta recommended for the anniversary dinner in October with vegetarian options?");
  assert.equal(long.length, MAX_KEYWORDS);
  assert.deepEqual(long.slice(0, 3), ["october", "lisbon", "marta"]);
  // The first word's capital says nothing.
  assert.deepEqual(keywords("Pricing for Elena"), ["elena", "pricing"]);
});
