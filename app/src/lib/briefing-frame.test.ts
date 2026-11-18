// Run: npx tsx --test app/src/lib/briefing-frame.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { briefingFrame, quoteLine } from "./briefing-frame";
import { phaseAt } from "../components/day-words";

const at = (hh: number, mm = 0) => new Date(2026, 10, 9, hh, mm);
const VOICE = "Morning, Alex. The 09:15 to Bristol is on time, and Priya turns 35 on Thursday.";

test("before 18:00 the card is today's briefing, the line as written", () => {
  for (const d of [at(7, 30), at(12), at(17, 59)]) {
    const f = briefingFrame(d, VOICE, "Monday 9 November");
    assert.equal(f.lookingBack, false);
    assert.equal(f.label, "Today's briefing");
    assert.equal(f.line, VOICE);
    assert.equal(f.ariaLabel, `Open today's briefing: ${VOICE}`);
  }
});

test("from 18:00 it is this morning's briefing, the line quoted", () => {
  for (const d of [at(18), at(21), at(23, 59)]) {
    const f = briefingFrame(d, VOICE, "Monday 9 November");
    assert.equal(f.lookingBack, true);
    assert.equal(f.label, "This morning's briefing");
    assert.equal(f.line, `“${VOICE}”`);
    assert.equal(f.ariaLabel, `Open this morning's briefing: ${VOICE}`);
  }
});

test("turns at the same minute as the headline's phaseAt", () => {
  for (let m = 0; m < 24 * 60; m += 15) {
    const d = at(Math.floor(m / 60), m % 60);
    assert.equal(briefingFrame(d, VOICE, "t").lookingBack, phaseAt(d) === "evening");
  }
});

test("an older note without a line keeps its title in the label", () => {
  const f = briefingFrame(at(21), null, "Monday 9 November");
  assert.equal(f.line, null);
  assert.equal(f.label, "This morning's briefing");
  assert.equal(f.ariaLabel, "Open this morning's briefing: Monday 9 November");
});

test("quoteLine doesn't double the writer's own quotes", () => {
  assert.equal(quoteLine("“Morning.”"), "“Morning.”");
  assert.equal(quoteLine('"Morning."'), "“Morning.”");
  assert.equal(quoteLine("  Morning. "), "“Morning.”");
});
