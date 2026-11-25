// Run: npx tsx --test lib/templates.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { blankRanges, fieldKey, fillTemplate, filledTitle, journalFromTemplate, parseTemplate, splitTitle, STARTERS, templateNeeds, type FieldValues } from "./templates";

const PERSON = "11111111-1111-4111-8111-111111111111";
const EVENT = "22222222-2222-4222-8222-222222222222";

test("fields are found once each, aliases and spacing normalised", () => {
  const fields = parseTemplate("{{Attendees}} and {{ guests }} then {{Last  time we spoke}} and {{weird one}}");
  assert.deepEqual(
    fields.map((f) => f.key),
    ["attendees", "last time we spoke", "weird one"],
  );
  assert.equal(fields[2].info, null);
  assert.equal(fieldKey("This week’s days"), "this week's days");
});

test("a template asks for the context its fields need", () => {
  assert.deepEqual(templateNeeds(STARTERS.find((s) => s.key === "meeting")!.body), ["meeting"]);
  assert.deepEqual(templateNeeds(STARTERS.find((s) => s.key === "one-on-one")!.body), ["person"]);
  assert.deepEqual(templateNeeds(STARTERS.find((s) => s.key === "trip")!.body), ["trip"]);
  assert.deepEqual(templateNeeds("Just {{today}}"), []);
});

test("filled fields are replaced and cited; blanks stay exactly as written", () => {
  const values: FieldValues = {
    meeting: { lines: ["Design review"], sources: [{ label: "Design review", kind: "event", id: EVENT, detail: "Tue 10 Nov" }] },
    attendees: { lines: ["Priya Shah", "Tom Reed"], sources: [{ label: "Design review", kind: "event", id: EVENT }] },
    "last time we spoke": { lines: ["3 Nov: talked pricing"], sources: [{ label: "Priya Shah", kind: "person", id: PERSON, detail: "catch-up on 3 Nov" }] },
    "agenda from email": null,
  };
  const out = fillTemplate("# {{meeting}}\n\nWith {{attendees}}\n\n## Agenda\n{{agenda from email}}\n\n## Last time\n{{last time we spoke}}\n\n{{mystery}}", values);
  assert.match(out.body, /^# Design review\n/);
  assert.match(out.body, /With Priya Shah, Tom Reed\n/);
  assert.match(out.body, /## Agenda\n\{\{agenda from email\}\}\n/);
  assert.match(out.body, /## Last time\n3 Nov: talked pricing\n/);
  assert.match(out.body, /\n\{\{mystery\}\}\n/);
  assert.deepEqual(out.blanks.sort(), ["agenda from email", "mystery"]);
  assert.match(out.body, /### Sources/);
  assert.match(out.body, new RegExp(`- Last time we spoke: \\[Priya Shah\\]\\(athena://person/${PERSON} "link"\\), catch-up on 3 Nov`));
  assert.match(out.body, /- Left for you: agenda from email, mystery/);
  assert.equal(filledTitle(out.body, "Meeting notes"), "Design review");
});

test("a field alone on its line becomes a list; inline it's joined", () => {
  const values: FieldValues = { "trip legs": { lines: ["Fly LHR to LIS", "Stay at Casa"], sources: [{ label: "Trip · Lisbon" }] } };
  const out = fillTemplate("## Legs\n{{trip legs}}\n- {{trip legs}}\nLegs: {{trip legs}}", values);
  assert.match(out.body, /## Legs\n- Fly LHR to LIS\n- Stay at Casa\n- Fly LHR to LIS\n- Stay at Casa\nLegs: Fly LHR to LIS, Stay at Casa/);
  assert.match(out.body, /- Trip legs: Trip · Lisbon/);
});

test("nothing found means no invented text and no empty Sources noise", () => {
  const out = fillTemplate("Plain note", {});
  assert.equal(out.body, "Plain note");
  assert.deepEqual(out.blanks, []);
  const empty = fillTemplate("Hi {{person}}", { person: { lines: [], sources: [] } });
  assert.match(empty.body, /^Hi \{\{person\}\}/);
  assert.equal(filledTitle("# {{meeting}}", "Meeting notes"), "Meeting notes");
});

test("blank ranges point at each {{…}}", () => {
  assert.deepEqual(blankRanges("a {{x}} b {{y z}}"), [
    [2, 7],
    [10, 17],
  ]);
});

test("the opening heading becomes the note's title, unless it's still a blank", () => {
  assert.deepEqual(splitTitle("# Design review\n\nWith Priya", "Meeting notes"), { title: "Design review", body: "With Priya" });
  assert.deepEqual(splitTitle("# {{meeting}}\n\nWith Priya", "Meeting notes"), { title: "Meeting notes", body: "# {{meeting}}\n\nWith Priya" });
  assert.deepEqual(splitTitle("No heading", "Letter"), { title: "Letter", body: "No heading" });
});

test("a journal starts from a template: no opening heading, the day's dates, every other field left as written", () => {
  const day = { date: "Wednesday 25 November", week: "Week of 23 November" };
  assert.equal(
    journalFromTemplate("\n# Gratitude, {{date}}\n\nThree things, {{today}}:\n1. \n\n## For {{week}}\n\n{{open loops}} and {{weird one}}\n\n", day),
    "Three things, Wednesday 25 November:\n1. \n\n## For Week of 23 November\n\n{{open loops}} and {{weird one}}",
  );
  // No heading at the top: nothing is left out. Only a level-one heading is the title.
  assert.equal(journalFromTemplate("## Went well\n\n- [ ] ", day), "## Went well\n\n- [ ] ");
  // A template that is only a heading leaves nothing to start from.
  assert.equal(journalFromTemplate("# Just a title\n\n", day), "");
});
