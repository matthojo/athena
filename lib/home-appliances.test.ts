import assert from "node:assert/strict";
import { test } from "node:test";
import { applianceName, cycleEntry, durationWords, enumTail, hasCycles, programName, RUN_LOST_MS, stateLine, step, typeWord, type ApplianceSnapshot } from "./home-appliances";

const dish = (over: Partial<ApplianceSnapshot> = {}): ApplianceSnapshot => ({ id: "BOSCH-SMV-123", name: "", type: "Dishwasher", brand: "Bosch", connected: true, state: "Ready", ...over });
const at = (hm: string) => new Date(`2026-11-11T${hm}:00.000Z`);

test("words: what an appliance is, what it's called, what a programme is called", () => {
  assert.equal(typeWord("Washer"), "Washing machine");
  assert.equal(typeWord("SteamOven"), "Steam Oven");
  assert.equal(applianceName({ name: "  Kitchen  dishwasher ", type: "Dishwasher" }), "Kitchen dishwasher");
  assert.equal(applianceName({ name: "", type: "Dryer" }), "Tumble dryer");
  assert.equal(enumTail("BSH.Common.EnumType.OperationState.Run"), "Run");
  assert.equal(enumTail(3), undefined);
  assert.equal(enumTail("x.<script>"), undefined);
  assert.equal(programName({ key: "Dishcare.Dishwasher.Program.Eco50", name: "Eco 50°C" }), "Eco 50°C");
  assert.equal(programName({ key: "Dishcare.Dishwasher.Program.Eco50" }), "Eco 50");
  assert.equal(programName({ key: "LaundryCare.Washer.Program.Cotton.CottonEco" }), "Cotton Cotton Eco");
  assert.equal(programName({ key: "nonsense" }), undefined);
  assert.equal(programName(undefined), undefined);
  assert.equal(hasCycles("Dishwasher"), true);
  assert.equal(hasCycles("FridgeFreezer"), false);
  assert.equal(hasCycles("CoffeeMaker"), false);
  assert.equal(durationWords(195), "3h 15m");
  assert.equal(durationWords(120), "2h");
  assert.equal(durationWords(48), "48m");
});

test("what it's doing now, in a few words", () => {
  assert.equal(stateLine(dish({ connected: false, state: undefined })), "Offline");
  assert.equal(stateLine(dish({ state: "Run", program: { key: "Dishcare.Dishwasher.Program.Eco50" }, remaining_s: 4800 })), "Running Eco 50, 1h 20m left");
  assert.equal(stateLine(dish({ state: "Pause", program: { key: "x.Program.Auto2" } })), "Paused Auto 2");
  assert.equal(stateLine(dish({ state: "Finished" })), "Finished");
  assert.equal(stateLine(dish({ state: "Ready", door: "Open" })), "Door open");
  assert.equal(stateLine(dish({ state: "Inactive" })), "Off");
  assert.equal(stateLine(dish({ state: "SomethingNew" })), "On");
});

test("a cycle is found between two looks: running, then not", () => {
  // First seen running, 40 minutes in by its own count: the start is exact.
  const one = step(undefined, dish({ state: "Run", program: { key: "Dishcare.Dishwasher.Program.Eco50" }, elapsed_s: 2400 }), at("10:00"));
  assert.deepEqual(one.next.run, { started: "2026-11-11T09:20:00.000Z", program: "Eco 50" });
  assert.equal(one.finished, undefined);
  // Still running: the start stands.
  const two = step(one.next, dish({ state: "Run", program: { key: "Dishcare.Dishwasher.Program.Eco50" }, elapsed_s: 3300 }), at("10:15"));
  assert.equal(two.next.run?.started, "2026-11-11T09:20:00.000Z");
  // Finished: one cycle, and nothing left running.
  const three = step(two.next, dish({ state: "Finished" }), at("12:30"));
  assert.deepEqual(three.finished, { started: "2026-11-11T09:20:00.000Z", ended: "2026-11-11T12:30:00.000Z", program: "Eco 50" });
  assert.equal(three.next.run, undefined);
  assert.deepEqual(three.next.last, three.finished);
  // The next look says the same thing: no second cycle.
  const four = step(three.next, dish({ state: "Finished" }), at("12:45"));
  assert.equal(four.finished, undefined);
  assert.deepEqual(four.next.last, three.finished);
  assert.deepEqual(cycleEntry(dish(), three.finished!), { title: "Dishwasher", subtitle: "Eco 50", at: "2026-11-11T12:30:00.000Z", minutes: 190, external_id: "BOSCH-SMV-123:2026-11-11T09:20:00.000Z" });
});

test("the door opened before the look still ends the cycle; a fault or a stop doesn't count as one", () => {
  const running = step(undefined, dish({ state: "Run" }), at("10:00")).next;
  assert.ok(step(running, dish({ state: "Ready", door: "Open" }), at("11:00")).finished);
  assert.equal(step(running, dish({ state: "Error" }), at("11:00")).finished, undefined);
  assert.equal(step(running, dish({ state: "Aborting" }), at("11:00")).finished, undefined);
  // A delayed start hasn't begun.
  assert.equal(step(undefined, dish({ state: "DelayedStart" }), at("10:00")).next.run, undefined);
});

test("offline mid-cycle: the run is kept for a while, then let go; a fridge never has a cycle", () => {
  const running = step(undefined, dish({ state: "Run" }), at("10:00")).next;
  const offline = step(running, dish({ connected: false, state: undefined }), at("10:15"));
  assert.equal(offline.next.run?.started, "2026-11-11T10:00:00.000Z");
  assert.equal(offline.finished, undefined);
  // Back and finished: the cycle is found.
  assert.ok(step(offline.next, dish({ state: "Finished" }), at("12:00")).finished);
  // Gone for good: forgotten.
  const lost = step(running, dish({ connected: false, state: undefined }), new Date(at("10:00").getTime() + RUN_LOST_MS + 1));
  assert.equal(lost.next.run, undefined);
  const fridge = { ...dish({ type: "FridgeFreezer", state: "Run" }) };
  const cold = step(undefined, fridge, at("10:00")).next;
  assert.equal(step(cold, { ...fridge, state: "Ready" }, at("11:00")).finished, undefined);
});
