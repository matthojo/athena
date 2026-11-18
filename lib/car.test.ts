// Run: npx tsx --test lib/car.test.ts
// The car's pure parts: reading DVLA and DVSA answers (shapes from their published specs), the card, and the nudges' timing.
import { test } from "node:test";
import assert from "node:assert/strict";
import { carCard, carDues, carNudgeKey, carNudgeStage, motDue, normaliseRegistration, plainAdvisory, readMot, readVes, showRegistration, taxDue, vehicleLabel, vehicleLabels, wantedRenewals, type CarVehicle } from "./car";
import { carDue } from "./proactive/rules";
import type { ProactiveInput } from "./proactive/types";
import { MOT_SAMPLE, NEW_REG_SAMPLE, VES_SAMPLE } from "./car.fixtures";

const vehicle = (over: Partial<CarVehicle> = {}): CarVehicle => ({ id: "v1", registration: "AA51AAA", added_on: "2026-11-01", fetched_on: "2026-11-10", ves: null, mot: null, assets: {}, ...over });

test("VES: the published example reads as make, colour, year, tax and MOT", () => {
  const v = readVes(VES_SAMPLE)!;
  assert.deepEqual(v, { make: "ROVER", colour: "Blue", year: 2004, fuel: "PETROL", tax_status: "Untaxed", tax_due: "2017-12-25", mot_status: "No details held by DVLA", mot_expiry: "2008-12-25" });
  assert.equal(readVes({ errors: [{ status: "404", title: "Vehicle Not Found" }] }), null);
  assert.equal(readVes(null), null);
  // Only the required field: everything else is null, not undefined.
  assert.deepEqual(readVes({ registrationNumber: "X1" }), { make: null, colour: null, year: null, fuel: null, tax_status: null, tax_due: null, mot_status: null, mot_expiry: null });
});

test("MOT History: tests newest first, mileage in miles, defects kept", () => {
  const m = readMot(MOT_SAMPLE)!;
  assert.equal(m.make, "Ford");
  assert.equal(m.model, "Focus");
  assert.equal(m.recall, "No");
  assert.deepEqual(m.tests.map((t) => t.date), ["2025-02-17", "2024-02-21", "2024-02-20", "2023-02-19"]);
  assert.equal(m.tests[0].miles, 41830);
  assert.equal(m.tests[1].miles, null, "UNREADABLE has no reading");
  assert.equal(m.tests[2].miles, Math.round(55000 * 0.621371), "KM converted");
  assert.equal(m.tests[0].defects.length, 3);
  assert.deepEqual(m.tests[3].defects, []);
  assert.equal(readMot({ errorCode: "MOTH-NF-01", errorMessage: "The vehicle requested has not been found" }), null);
});

test("MOT History: a new vehicle's first MOT date is its due date", () => {
  const m = readMot(NEW_REG_SAMPLE)!;
  assert.deepEqual(m.tests, []);
  assert.equal(m.first_due, "2027-03-13");
  assert.equal(motDue(vehicle({ mot: m })), "2027-03-13");
});

test("registrations: normalised for the APIs, spaced for the owner, nonsense refused", () => {
  assert.equal(normaliseRegistration(" ab12 cde "), "AB12CDE");
  assert.equal(normaliseRegistration("K-123-ABC"), "K123ABC");
  assert.equal(normaliseRegistration("ABCDEFG"), null);
  assert.equal(normaliseRegistration("123"), null);
  assert.equal(normaliseRegistration("AB12CDEFGH"), null);
  assert.equal(normaliseRegistration(42), null);
  assert.equal(showRegistration("AB12CDE"), "AB12 CDE");
  assert.equal(showRegistration("K123ABC"), "K123ABC");
});

test("dates: MOT from either source (the later), tax from DVLA unless SORN", () => {
  const ves = { make: "FORD", colour: "BLUE", year: 2019, fuel: "PETROL", tax_status: "Taxed", tax_due: "2027-04-01", mot_status: "Valid", mot_expiry: "2026-03-01" };
  const mot = readMot(MOT_SAMPLE)!;
  assert.equal(motDue(vehicle({ ves })), "2026-03-01");
  assert.equal(motDue(vehicle({ mot })), "2026-03-01");
  assert.equal(motDue(vehicle({ ves: { ...ves, mot_expiry: "2026-03-02" }, mot })), "2026-03-02");
  assert.equal(motDue(vehicle({ ves: { ...ves, mot_status: "No details held by DVLA" } })), null);
  assert.equal(taxDue(vehicle({ ves })), "2027-04-01");
  assert.equal(taxDue(vehicle({ ves: { ...ves, tax_status: "SORN" } })), null);
  assert.equal(taxDue(vehicle({ mot })), null, "no DVLA, no tax date");
});

test("labels: make and model, else colour and make; two alike get their plate's start; never the whole registration", () => {
  assert.equal(vehicleLabel(vehicle({ mot: readMot(MOT_SAMPLE) })), "Ford Focus");
  assert.equal(vehicleLabel(vehicle({ ves: readVes(VES_SAMPLE) })), "Blue Rover");
  assert.equal(vehicleLabel(vehicle({ ves: { ...readVes(VES_SAMPLE)!, make: "BMW", colour: null } })), "BMW");
  assert.equal(vehicleLabel(vehicle()), "Your car");
  const a = vehicle({ id: "a", registration: "AB12CDE", ves: readVes(VES_SAMPLE) });
  const b = vehicle({ id: "b", registration: "XY34ZZZ", ves: readVes(VES_SAMPLE) });
  const labels = vehicleLabels([a, b]);
  assert.equal(labels.get("a"), "Blue Rover (AB12)");
  assert.equal(labels.get("b"), "Blue Rover (XY34)");
  for (const r of wantedRenewals(a, labels.get("a"))) assert.ok(!r.name.includes("AB12CDE"));
});

test("advisories in plain words: codes gone, nearside and offside as left and right", () => {
  assert.equal(plainAdvisory("Nearside Front Tyre worn close to legal limit/worn on edge (5.2.3 (e))"), "Left front tyre worn close to the legal limit or worn on edge");
  assert.equal(plainAdvisory("Offside Rear Registration plate lamp inoperative (4.7.1 (b) (ii))"), "Right rear registration plate lamp inoperative");
  assert.equal(plainAdvisory("Oil leak, but not excessive"), "Oil leak, but not excessive");
  // Alternatives joined by a slash, with or without spaces, read as "or".
  assert.equal(plainAdvisory("Brake pipe corroded / covered in grease (1.1.11 (c))"), "Brake pipe corroded or covered in grease");
  assert.equal(plainAdvisory("Tyre slightly damaged/cracking or perishing"), "Tyre slightly damaged or cracking or perishing");
});

test("the card: status, last test, mileage trend and the latest test's advisories", () => {
  const card = carCard(vehicle({ ves: { make: "FORD", colour: "BLUE", year: 2019, fuel: "PETROL", tax_status: "Taxed", tax_due: "2027-04-01", mot_status: "Valid", mot_expiry: "2026-12-01" }, mot: readMot(MOT_SAMPLE) }), "2026-11-10");
  assert.equal(card.label, "Ford Focus");
  assert.equal(card.year, 2019);
  assert.deepEqual(card.mot, { on: "2026-12-01", days: 21, status: "Valid" });
  assert.deepEqual(card.tax, { on: "2027-04-01", days: 142, status: "Taxed" });
  assert.deepEqual(card.last_test, { date: "2025-02-17", result: "PASSED", miles: 41830 });
  assert.deepEqual(card.mileage.map((m) => m.date), ["2023-02-19", "2024-02-20", "2025-02-17"]);
  assert.equal(card.miles_a_year, 7700);
  assert.deepEqual(card.advisories, ["Left front tyre worn close to the legal limit or worn on edge", "Front brake disc worn, pitted or scored, but not seriously weakened", "Right rear registration plate lamp inoperative"]);
  assert.equal(card.recall, false);
  assert.deepEqual(card.sources, { dvla: true, mot: true });
});

const input = (today: string, cars: ProactiveInput["cars"]): ProactiveInput => ({
  now: new Date(`${today}T09:00:00Z`),
  tz: "Europe/London",
  today,
  working: { days: [1, 2, 3, 4, 5], start: "09:00", end: "17:30" },
  events: [],
  sent: [],
  todos: [],
  goals: [],
  sleep: null,
  habits: [],
  travel: {},
  closed: new Set(),
  cars,
});

test("nudge timing: nothing beyond 30 days, one about 30 days out, one in the last week, nothing once it's passed", () => {
  assert.equal(carNudgeStage("2026-11-10", "2026-12-11"), null);
  assert.equal(carNudgeStage("2026-11-10", "2026-12-10"), 30);
  assert.equal(carNudgeStage("2026-11-10", "2026-11-18"), 30);
  assert.equal(carNudgeStage("2026-11-10", "2026-11-17"), 7);
  assert.equal(carNudgeStage("2026-11-10", "2026-11-10"), 7);
  assert.equal(carNudgeStage("2026-11-10", "2026-11-09"), null);
  const due = { vehicle_id: "v1", label: "Ford Focus", what: "mot" as const, due: "2026-12-01" };
  const [n] = carDue(input("2026-11-10", [due]));
  assert.equal(n.rule, "car");
  assert.equal(n.key, carNudgeKey(due, 30));
  assert.equal(n.title, "MOT runs out in 21 days");
  assert.equal(n.body, "Ford Focus: the MOT ends on 1 December. Book a test before then.");
  assert.equal(n.expires_at, "2026-11-24T00:00:00.000Z", "the 30-day card goes when the last week starts");
  const [week] = carDue(input("2026-11-25", [due]));
  assert.equal(week.key, carNudgeKey(due, 7));
  assert.notEqual(week.key, n.key);
  assert.equal(carDue(input("2026-10-31", [due])).length, 0);
  const [tax] = carDue(input("2026-11-30", [{ ...due, what: "tax" }]));
  assert.equal(tax.title, "Car tax due tomorrow");
  for (const x of [n, week, tax]) assert.ok(!/AA51/.test(`${x.title} ${x.body} ${x.why.join(" ")} ${x.prompt}`), "no registration in a nudge");
});

test("nudges go quiet once renewed: the new date is far off, and a new date is a new key", () => {
  const before = { vehicle_id: "v1", label: "Ford Focus", what: "tax" as const, due: "2026-11-20" };
  const after = { ...before, due: "2027-11-20" };
  assert.equal(carDue(input("2026-11-15", [after])).length, 0);
  assert.notEqual(carNudgeKey(before, 7), carNudgeKey(after, 7));
  const dues = carDues({ vehicles: [vehicle({ ves: { make: "FORD", colour: "BLUE", year: 2019, fuel: null, tax_status: "SORN", tax_due: "2026-11-20", mot_status: "Valid", mot_expiry: "2026-11-25" } })] });
  assert.deepEqual(dues.map((d) => d.what), ["mot"], "SORN: no tax nudge");
});
