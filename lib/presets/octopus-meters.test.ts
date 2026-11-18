// Run: npx tsx --test lib/presets/octopus-meters.test.ts
// Octopus's meters as the address Athena keeps: the form's fields, the old one-line form and the addresses already saved.
import { test } from "node:test";
import assert from "node:assert/strict";
import { checkAddressFields, firstProblem } from "../address-fields";
import { MeterAddressError, NEED_LINE, NEED_METER, OCTOPUS_FIELDS, buildAddress, meterValues, metersOf, octopusAddress, withoutAccount } from "./octopus-meters";
import { presetFor } from "../connector-presets";

const API = "https://api.octopus.energy/v1";
const form = (v: unknown) => octopusAddress(JSON.stringify(v));

test("electricity only: fields → the same address Athena has always kept → the meter back", () => {
  const url = form({ electricity: { mpan: "1200012345678", serial: "21l1234567" } });
  assert.equal(url, `${API}/electricity-meter-points/1200012345678/meters/21L1234567/`);
  assert.deepEqual(metersOf(url), { electricity: { mpan: "1200012345678", serial: "21L1234567" } });
});

test("gas only, in kWh and in m³: a gas-meter-points address", () => {
  const kwh = form({ gas: { mprn: "1234567890", serial: "g4a12345678", m3: false } });
  assert.equal(kwh, `${API}/gas-meter-points/1234567890/meters/G4A12345678/`);
  assert.deepEqual(metersOf(kwh), { gas: { mprn: "1234567890", serial: "G4A12345678", m3: false } });
  const m3 = form({ gas: { mprn: "123456", serial: "E6S12345", m3: true } });
  assert.equal(m3, `${API}/gas-meter-points/123456/meters/E6S12345/?units=m3`);
  assert.deepEqual(metersOf(m3), { gas: { mprn: "123456", serial: "E6S12345", m3: true } });
  assert.equal(metersOf(m3).electricity, undefined);
});

test("both meters: electricity's address with gas beside it, as before", () => {
  const url = form({ electricity: { mpan: "1200012345678", serial: "21L1234567" }, gas: { mprn: "1234567890", serial: "G4A12345678", m3: true } });
  assert.equal(url, `${API}/electricity-meter-points/1200012345678/meters/21L1234567/?gas=1234567890%3AG4A12345678%3Am3`);
  assert.deepEqual(metersOf(url), { electricity: { mpan: "1200012345678", serial: "21L1234567" }, gas: { mprn: "1234567890", serial: "G4A12345678", m3: true } });
});

test("the old one-line form still parses to exactly the address it always made", () => {
  assert.equal(octopusAddress("1200012345678 21l1234567"), `${API}/electricity-meter-points/1200012345678/meters/21L1234567/`);
  assert.equal(octopusAddress("1200012345678 21L1234567 1234567890 g4a12345678"), `${API}/electricity-meter-points/1200012345678/meters/21L1234567/?gas=1234567890%3AG4A12345678`);
  assert.equal(octopusAddress("1200012345678 21L1234567 1234567890 G4A12345678 m3"), `${API}/electricity-meter-points/1200012345678/meters/21L1234567/?gas=1234567890%3AG4A12345678%3Am3`);
  for (const bad of ["12345 21L1", "1200012345678", "1200012345678 21L1234567 1234567890"]) assert.throws(() => octopusAddress(bad), (e: Error) => e instanceof MeterAddressError && e.message === NEED_LINE);
});

test("an address saved before this change migrates without a migration: read, shown in the form, saved again unchanged", () => {
  // As the old octopusAddress() wrote them for an account with both meters, and with electricity alone.
  for (const old of [`${API}/electricity-meter-points/1200012345678/meters/21L1234567/?gas=1234567890%3AG4A12345678%3Am3`, `${API}/electricity-meter-points/1200012345678/meters/21L1234567/`]) {
    const values = OCTOPUS_FIELDS.read!(old)!;
    assert.equal(values.electricity.mpan, "1200012345678");
    if (old.includes("gas")) assert.deepEqual(values.gas, { mprn: "1234567890", serial: "G4A12345678", m3: true });
    else assert.equal(values.gas, undefined);
    assert.equal(form(values), old, "the Edit form's values save back to the same address");
    assert.equal(octopusAddress(old), old, "an address sent back unchanged is kept");
    assert.equal(buildAddress(metersOf(old)), old);
  }
  assert.equal(OCTOPUS_FIELDS.read!("https://example.com/"), null);
  assert.deepEqual(meterValues({ gas: { mprn: "123456", serial: "E6S12345", m3: false } }), { gas: { mprn: "123456", serial: "E6S12345", m3: false } });
});

test("validation: each field in plain words, spaces taken out and serials in capitals", () => {
  const check = (v: Parameters<typeof checkAddressFields>[1]) => checkAddressFields(OCTOPUS_FIELDS, v);
  assert.equal(check({}).none, NEED_METER);
  assert.equal(check({ electricity: { mpan: " ", serial: "" }, gas: { mprn: "", serial: "", m3: true } }).none, NEED_METER, "a switch on its own isn't a meter");
  assert.deepEqual(check({ electricity: { mpan: "12345", serial: "21L1234567" } }).errors, { "electricity.mpan": "An MPAN is 13 digits." });
  assert.deepEqual(check({ electricity: { mpan: "1200012345678", serial: "" } }).errors, { "electricity.serial": "Add the electricity meter's serial." });
  assert.deepEqual(check({ gas: { mprn: "12345", serial: "G4" } }).errors, { "gas.mprn": "An MPRN is 6 to 10 digits.", "gas.serial": "A meter serial is 4 to 20 letters and numbers." });
  assert.deepEqual(check({ gas: { mprn: "", serial: "G4A12345678" } }).errors, { "gas.mprn": "Add the gas meter's MPRN." });
  const ok = check({ electricity: { mpan: "12 0001 2345 678", serial: " 21l 1234567 " }, gas: { mprn: "", serial: "" } });
  assert.deepEqual(ok, { values: { electricity: { mpan: "1200012345678", serial: "21L1234567" } }, errors: {} });
  // A gas meter half typed stops the save even when electricity is complete.
  const half = check({ electricity: { mpan: "1200012345678", serial: "21L1234567" }, gas: { mprn: "1234567890", serial: "" } });
  assert.equal(firstProblem(half), "Add the gas meter's serial.");
  assert.throws(() => form({ electricity: { mpan: "1200012345678", serial: "21L1234567" }, gas: { mprn: "1234567890" } }), /Add the gas meter's serial/);
  assert.throws(() => form({}), (e: Error) => e.message === NEED_METER);
  assert.throws(() => octopusAddress("{not json"), (e: Error) => e.message === NEED_METER);
});

test("the preset asks for the meters as fields, and its steps match the form", () => {
  const p = presetFor("octopus");
  assert.equal(p.address?.fields, OCTOPUS_FIELDS);
  assert.deepEqual(OCTOPUS_FIELDS.groups.map((g) => g.title), ["Electricity", "Gas", "For costs (optional)"]);
  assert.equal(OCTOPUS_FIELDS.groups[2].optional, true, "the account number is extra, never a meter");
  assert.equal(OCTOPUS_FIELDS.groups[1].toggle?.label, "My gas meter reports in m³ (SMETS2)");
  assert.match(p.setup!.steps.map((s) => s.sub).join(" "), /Electricity, gas or both/);
});

test("the account number rides on the address, optional: Edit shows it, saves it back, and it's never a meter on its own", () => {
  const url = form({ electricity: { mpan: "1200012345678", serial: "21L1234567" }, account: { number: " a-1234abcd " } });
  assert.equal(url, `${API}/electricity-meter-points/1200012345678/meters/21L1234567/?account=A-1234ABCD`);
  assert.deepEqual(metersOf(url), { electricity: { mpan: "1200012345678", serial: "21L1234567" }, account: "A-1234ABCD" });
  const values = OCTOPUS_FIELDS.read!(url)!;
  assert.deepEqual(values.account, { number: "A-1234ABCD" });
  assert.equal(form(values), url, "Edit's values save back to the same address");
  const gas = form({ gas: { mprn: "1234567890", serial: "G4A12345678", m3: true }, account: { number: "A-1234ABCD" } });
  assert.deepEqual(metersOf(gas).account, "A-1234ABCD");
  assert.equal(withoutAccount(gas), `${API}/gas-meter-points/1234567890/meters/G4A12345678/?units=m3`, "the meters alone, to tell whether they moved");
  // Cleared under Edit: the address goes back to exactly what it was.
  assert.equal(form({ ...values, account: { number: "" } }), `${API}/electricity-meter-points/1200012345678/meters/21L1234567/`);
  assert.throws(() => form({ account: { number: "A-1234ABCD" } }), (e: Error) => e.message === NEED_METER);
  assert.throws(() => form({ electricity: { mpan: "1200012345678", serial: "21L1234567" }, account: { number: "12345" } }), (e: Error) => /A-1234ABCD/.test(e.message));
  assert.equal(OCTOPUS_FIELDS.finder?.keeps, "account.number", "Find my meters keeps the number it found them with");
});
