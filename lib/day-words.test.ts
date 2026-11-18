// Place names in the day sentence: "at the Barbican", "at Dishoom".
// Run: npx tsx --test lib/day-words.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { placeWithArticle } from "./day-words";

test("venues take 'the'; a one-word name plus Centre is said the short way", () => {
  assert.equal(placeWithArticle("Barbican Centre"), "the Barbican");
  assert.equal(placeWithArticle("Southbank Centre"), "the Southbank");
  assert.equal(placeWithArticle("British Museum"), "the British Museum");
  assert.equal(placeWithArticle("Natural History Museum"), "the Natural History Museum");
  assert.equal(placeWithArticle("National Theatre"), "the National Theatre");
  assert.equal(placeWithArticle("Prince Charles Cinema"), "the Prince Charles Cinema");
  assert.equal(placeWithArticle("Royal Albert Hall"), "the Royal Albert Hall");
  assert.equal(placeWithArticle("Brixton Leisure Centre"), "the Brixton Leisure Centre");
  assert.equal(placeWithArticle("Garden Centre"), "the Garden Centre");
});

test("restaurants, parks, markets and owned names stay as the owner named them", () => {
  for (const n of ["Dishoom", "Hampstead Heath", "Hyde Park", "Borough Market", "Wembley Stadium", "Tate Modern", "Wigmore Hall", "St Paul's Cathedral", "The Barbican", "The Ivy", "Museum", "Westminster Abbey"]) {
    assert.equal(placeWithArticle(n), n, n);
  }
  assert.equal(placeWithArticle("  Barbican   Centre "), "the Barbican");
  assert.equal(placeWithArticle(""), "");
});
