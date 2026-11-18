// Run: npx tsx --test lib/stations.test.ts
// Station names from booking emails to CRS codes, odd ones included, and the owner's busiest TfL lines from a journey history.
import { test } from "node:test";
import assert from "node:assert/strict";
import { busiestLines, crsFor, linesAt, stationKey, stationName } from "./stations";

test("the usual ways a station is written", () => {
  for (const name of ["London Paddington", "LONDON PADDINGTON", "Paddington", "london paddington station", "PAD", "pad", "Paddington (PAD)"]) assert.equal(crsFor(name), "PAD", name);
  assert.equal(crsFor("Bristol Temple Meads"), "BRI");
  assert.equal(crsFor("Temple Meads"), "BRI");
  assert.equal(stationName("bri"), "Bristol Temple Meads");
  assert.equal(stationName("XYZ"), null);
});

test("odd names from booking emails", () => {
  const cases: Array<[string, string | null]> = [
    ["London Kings X", "KGX"],
    ["King's Cross", "KGX"],
    ["London King’s Cross", "KGX"],
    ["St Pancras Intl", "STP"],
    ["London St. Pancras Int'l", "STP"],
    ["Bristol Temple Meads [BRI]", "BRI"],
    ["Manchester Piccadilly (MAN)", "MAN"],
    ["B'ham New St", "BHM"],
    ["Birmingham", "BHM"],
    ["Edinburgh (Waverley)", "EDB"],
    ["Edinburgh Waverley", "EDB"],
    ["Newport (South Wales)", "NWP"],
    ["Newport", "NWP"],
    ["Stratford", "SRA"],
    ["Stratford-upon-Avon", "SAV"],
    ["Heathrow Terminal 5", "HWV"],
    ["Milton Keynes", "MKC"],
    ["Bristol Pkwy", "BPW"],
    ["Paddingon", "PAD"],
    ["Peterbrough", "PBO"],
  ];
  for (const [name, crs] of cases) assert.equal(crsFor(name), crs, name);
});

test("anything that isn't one station we know is nothing, never a guess", () => {
  for (const name of ["London Terminals", "London", "Paris Gare du Nord", "Amsterdam Centraal", "", "   ", "Any", "Hogwarts", "x".repeat(200)]) assert.equal(crsFor(name), null, name);
  assert.equal(crsFor(null), null);
  // Several stations have "Street" in them: one word that matches many is nothing.
  assert.equal(crsFor("Street"), null);
});

test("the key ignores case, accents, punctuation and filler words", () => {
  assert.equal(stationKey("King's Cross Rail Station"), "kings cross");
  assert.equal(stationKey("Saint Pancras Intl."), "st pancras international");
  assert.equal(stationKey("Highbury & Islington"), "highbury and islington");
});

test("TfL lines at a station, as a journey history names it", () => {
  assert.deepEqual(linesAt("Bank"), ["central", "northern", "waterloo-city", "dlr"]);
  assert.ok(linesAt("Kings Cross St. Pancras").includes("victoria"));
  assert.ok(linesAt("Hammersmith (District & Piccadilly)").includes("piccadilly"));
  assert.ok(linesAt("Bank / Monument").includes("central"));
  assert.deepEqual(linesAt("Nowhere Parkway"), []);
});

test("busiest lines: the line a journey's two ends share, buses left out, used at least twice", () => {
  const titles = [
    "Highbury & Islington → Oxford Circus",
    "Oxford Circus → Highbury & Islington",
    "Highbury & Islington → Oxford Circus",
    "Stratford → Bond Street",
    "Bond Street → Stratford",
    "Bus 73",
    "Bus 73",
    "Bus 73",
    "Angel → Brixton",
  ];
  // Victoria three times; Central and Elizabeth twice each (Stratford and Bond Street share both); Angel to Brixton is a change, half each.
  assert.deepEqual(busiestLines(titles), ["victoria", "central", "elizabeth"]);
  assert.deepEqual(busiestLines(titles, 1), ["victoria"]);
  assert.deepEqual(busiestLines(["Bus 38", "Bus 38"]), []);
  assert.deepEqual(busiestLines(["Angel → Old Street"]), [], "once isn't a habit");
});
