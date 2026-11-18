// Run: npx tsx --test lib/car-sync.test.ts
// The car sync's renewals: made once, moved when the date moves, archived when the car goes; and what happens with no keys.
import { test } from "node:test";
import assert from "node:assert/strict";
import { addVehicle, CarInputError, MAX_VEHICLES, refreshCars, removeVehicle, sampleVehicle, type Lookup } from "./car-sync";
import { memoryCar } from "./car-sync.fixtures";
import { carCard } from "./car";
import { MOT_SAMPLE, VES_SAMPLE } from "./car.fixtures";

const TODAY = "2026-11-10";
const ves = (over: Record<string, unknown> = {}) => async (): Promise<Lookup<unknown>> => ({ ok: { ...VES_SAMPLE, make: "FORD", colour: "BLUE", taxStatus: "Taxed", taxDueDate: "2027-04-01", motStatus: "Valid", motExpiryDate: "2026-12-01", ...over } });

test("adding a car makes its MOT and tax renewals once, named by the car, never the registration", async () => {
  const car = memoryCar({ ves: ves() });
  const { id } = await addVehicle("ab12 cde", TODAY, car.ports);
  const v = car.state().vehicles[0];
  assert.equal(v.id, id);
  assert.equal(v.registration, "AB12CDE");
  assert.deepEqual(car.calls.ves, ["AB12CDE"]);
  const items = [...car.assets.values()];
  assert.deepEqual(items.map((a) => [a.name, a.renews_on, a.provider]), [["Blue Ford MOT", "2026-12-01", "DVLA"], ["Blue Ford tax", "2027-04-01", "DVLA"]]);
  assert.deepEqual(items[0].remind_days_before, [0]);
  for (const a of items) assert.ok(!a.name.includes("AB12"));
  // Again the same day, and adding the same plate again: no second read, no duplicates.
  await refreshCars(TODAY, car.ports);
  const again = await addVehicle("AB12CDE", TODAY, car.ports);
  assert.equal(again.id, id);
  assert.equal(car.assets.size, 2);
  assert.equal(car.calls.ves.length, 1, "read once a day");
});

test("a date that moves updates the same renewal and closes that date's nudges", async () => {
  let expiry = "2026-12-01";
  const car = memoryCar({ ves: async () => ({ ok: { ...VES_SAMPLE, make: "FORD", colour: "BLUE", taxStatus: "Taxed", taxDueDate: "2027-04-01", motStatus: "Valid", motExpiryDate: expiry } }) });
  await addVehicle("AB12CDE", TODAY, car.ports);
  const motId = car.state().vehicles[0].assets.mot!;
  expiry = "2027-12-01";
  await refreshCars("2026-11-11", car.ports);
  assert.equal(car.assets.size, 2);
  assert.equal(car.assets.get(motId)!.renews_on, "2027-12-01");
  assert.deepEqual(car.closed, [`car:${car.state().vehicles[0].id}:mot:`]);
});

test("SORN archives the tax renewal; a car taken off archives both and closes its nudges", async () => {
  let status = "Taxed";
  const car = memoryCar({ ves: async () => ({ ok: { ...VES_SAMPLE, taxStatus: status, taxDueDate: "2027-04-01", motStatus: "Valid", motExpiryDate: "2026-12-01" } }) });
  const { id } = await addVehicle("AB12CDE", TODAY, car.ports);
  const { mot, tax } = car.state().vehicles[0].assets;
  status = "SORN";
  await refreshCars(TODAY, car.ports, { force: true });
  assert.ok(car.assets.get(tax!)!.archived_at);
  assert.equal(car.state().vehicles[0].assets.tax, undefined);
  await removeVehicle(id, car.ports);
  assert.ok(car.assets.get(mot!)!.archived_at);
  assert.deepEqual(car.state().vehicles, []);
  assert.ok(car.closed.includes(`car:${id}:`));
  await assert.rejects(removeVehicle(id, car.ports), (e: unknown) => e instanceof CarInputError && e.status === 404);
});

test("an item the owner archived stays archived", async () => {
  let expiry = "2026-12-01";
  const car = memoryCar({ ves: async () => ({ ok: { ...VES_SAMPLE, motStatus: "Valid", motExpiryDate: expiry } }) });
  await addVehicle("AB12CDE", TODAY, car.ports);
  const motId = car.state().vehicles[0].assets.mot!;
  await car.ports.archiveAsset(motId);
  expiry = "2027-12-01";
  await refreshCars("2026-11-11", car.ports);
  assert.equal(car.assets.get(motId)!.renews_on, "2026-12-01");
  assert.equal(car.assets.size, 2, "tax stays; no new MOT item");
});

test("MOT History alone: the MOT date and its history; no tax renewal", async () => {
  const car = memoryCar({ mot: async () => ({ ok: MOT_SAMPLE }) });
  await addVehicle("AA51AAA", TODAY, car.ports);
  assert.deepEqual([...car.assets.values()].map((a) => [a.name, a.renews_on, a.provider]), [["Ford Focus MOT", "2026-03-01", "DVSA"]]);
  const card = carCard(car.state().vehicles[0], TODAY);
  assert.equal(card.advisories.length, 3);
  assert.equal(card.problem, null);
});

test("no keys: nothing is sent, the car says how to fix it, nothing errors", async () => {
  const car = memoryCar();
  await addVehicle("AB12CDE", TODAY, car.ports);
  const v = car.state().vehicles[0];
  assert.match(v.problem!, /Add a DVLA or DVSA key in Sources/);
  assert.equal(car.assets.size, 0);
  const card = carCard(v, TODAY);
  assert.deepEqual(card.sources, { dvla: false, mot: false });
  assert.equal(card.mot.on, null);
});

test("not found, a failing source and bad input", async () => {
  const car = memoryCar({ ves: async () => ({ notFound: true }), mot: async () => ({ notFound: true }) });
  await addVehicle("AB12CDE", TODAY, car.ports);
  assert.match(car.state().vehicles[0].problem!, /Neither DVLA nor DVSA has a vehicle/);
  const flaky = memoryCar({ ves: ves(), mot: async () => ({ error: "DVSA is busy right now." }) });
  await addVehicle("AB12CDE", TODAY, flaky.ports);
  assert.equal(flaky.state().vehicles[0].problem, "DVSA is busy right now.");
  assert.equal(flaky.assets.size, 2, "DVLA's dates still land");
  await assert.rejects(addVehicle("hello", TODAY, car.ports), /doesn't look like a registration/);
  const full = memoryCar({ ves: ves() });
  for (let i = 0; i < MAX_VEHICLES; i++) await addVehicle(`AB${10 + i}CDE`, TODAY, full.ports);
  await assert.rejects(addVehicle("ZZ99ZZZ", TODAY, full.ports), /up to 6 vehicles/);
});

test("the sample car: MOT in three weeks, two advisories, tax paid", () => {
  const card = carCard(sampleVehicle(TODAY), TODAY);
  assert.equal(card.mot.days, 21);
  assert.equal(card.advisories.length, 2);
  assert.equal(card.tax.status, "Taxed");
  assert.ok(card.tax.days! > 30);
});
