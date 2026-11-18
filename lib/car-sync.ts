/**
 * The car sync: reads each vehicle from DVLA and DVSA once a day and keeps
 * its Life admin renewals in step ("Ford Focus MOT", "Ford Focus tax").
 *
 * Every side effect goes through a port (CarPorts), so the same code runs
 * against the database (lib/car-store.ts carPorts) and in tests. Renewals
 * are ordinary `assets` rows (kind 'vehicle'); the sync remembers which
 * asset tracks what on the vehicle (CarVehicle.assets), so it never makes a
 * second one. A date that moves updates the asset and closes that date's
 * nudges; a vehicle taken off, or a date that no longer applies (SORN),
 * archives its asset. Archived, never deleted, like the rest of Athena.
 */
import { addDays } from "./dates";
import {
  RENEWAL_NOTE,
  RENEWAL_REMIND_DAYS,
  carNudgePrefix,
  normaliseRegistration,
  readMot,
  readVes,
  vehicleLabels,
  wantedRenewals,
  type CarState,
  type CarVehicle,
  type CarWhat,
  type MotHistory,
  type VesVehicle,
} from "./car";

/** What a lookup answered. `none`: that source isn't set up (no key), so its last answer is kept as it is. */
export type Lookup<T> = { ok: T } | { notFound: true } | { error: string } | { none: true };

export interface CarAsset {
  id: string;
  name: string;
  renews_on: string | null;
  archived_at: string | null;
}

export interface CarPorts {
  load(): Promise<CarState>;
  save(state: CarState): Promise<void>;
  ves(registration: string): Promise<Lookup<unknown>>;
  mot(registration: string): Promise<Lookup<unknown>>;
  getAsset(id: string): Promise<CarAsset | null>;
  createAsset(input: { name: string; renews_on: string; provider: string; notes: string; remind_days_before: number[] }): Promise<{ id: string }>;
  updateAsset(id: string, patch: { name?: string; renews_on?: string }): Promise<void>;
  archiveAsset(id: string): Promise<void>;
  /** Close the live nudges whose key starts with this (lib/proactive/store.ts). */
  closeNudges(prefix: string): Promise<void>;
  newId(): string;
}

export const MAX_VEHICLES = 6;

export class CarInputError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message);
    this.name = "CarInputError";
  }
}

const NOT_FOUND = "Neither DVLA nor DVSA has a vehicle with that registration. Check it and add it again.";

/** One vehicle, read from both sources. A source with no key keeps what it had; one that fails keeps it too, and says so. */
async function readVehicle(v: CarVehicle, ports: CarPorts, today: string): Promise<CarVehicle> {
  const [ves, mot] = await Promise.all([ports.ves(v.registration).catch(() => ({ error: "DVLA didn't answer." })), ports.mot(v.registration).catch(() => ({ error: "DVSA didn't answer." }))]);
  const next: CarVehicle = { ...v, assets: { ...v.assets } };
  const problems: string[] = [];
  if ("ok" in ves) {
    const parsed: VesVehicle | null = readVes(ves.ok);
    if (parsed) next.ves = parsed;
    else problems.push("DVLA answered with something Athena couldn't read.");
  } else if ("error" in ves) problems.push(ves.error);
  if ("ok" in mot) {
    const parsed: MotHistory | null = readMot(mot.ok);
    if (parsed) next.mot = parsed;
    else problems.push("DVSA answered with something Athena couldn't read.");
  } else if ("error" in mot) problems.push(mot.error);
  const vesMissing = "notFound" in ves || "none" in ves;
  const motMissing = "notFound" in mot || "none" in mot;
  if ("notFound" in ves) next.ves = null;
  if ("notFound" in mot) next.mot = null;
  if (("notFound" in ves && motMissing) || ("notFound" in mot && vesMissing)) problems.push(NOT_FOUND);
  if ("none" in ves && "none" in mot) problems.push("Add a DVLA or DVSA key in Sources, under Places and travel, and Athena reads this car.");
  next.problem = problems.length ? problems.join(" ") : null;
  // Tried today, whatever came back: the next read is tomorrow's, or Check again. Daily, so a busy API isn't asked every 5 minutes.
  next.fetched_on = today;
  return next;
}

/** Keep one vehicle's renewals in step with its dates. Returns the vehicle with its asset ids. */
export async function syncRenewals(v: CarVehicle, label: string, ports: CarPorts): Promise<CarVehicle> {
  const wanted = new Map(wantedRenewals(v, label).map((r) => [r.what, r]));
  const assets = { ...v.assets };
  for (const what of ["mot", "tax"] as CarWhat[]) {
    const want = wanted.get(what);
    const id = assets[what];
    const have = id ? await ports.getAsset(id) : null;
    if (!want) {
      // SORN, or no date any more: the renewal goes, and so do its nudges.
      if (have && !have.archived_at) await ports.archiveAsset(have.id);
      if (id) await ports.closeNudges(carNudgePrefix(v.id, what));
      delete assets[what];
      continue;
    }
    if (!have) {
      // New, or the row is gone: make it once and remember it.
      assets[what] = (await ports.createAsset({ name: want.name, renews_on: want.renews_on, provider: want.provider, notes: RENEWAL_NOTE, remind_days_before: RENEWAL_REMIND_DAYS })).id;
      continue;
    }
    // An item the owner archived stays archived: Athena doesn't bring it back.
    if (have.archived_at) continue;
    const patch: { name?: string; renews_on?: string } = {};
    if (have.renews_on !== want.renews_on) patch.renews_on = want.renews_on;
    if (have.name !== want.name) patch.name = want.name;
    if (Object.keys(patch).length) await ports.updateAsset(have.id, patch);
    // Renewed (the date moved): what was said about the old date goes quiet.
    if (patch.renews_on) await ports.closeNudges(carNudgePrefix(v.id, what));
  }
  return { ...v, assets };
}

/** Read vehicles not read today (or every one, with `force`), then keep every renewal in step. */
export async function refreshCars(today: string, ports: CarPorts, opts: { force?: boolean; only?: string } = {}): Promise<CarState> {
  const state = await ports.load();
  const read: CarVehicle[] = [];
  for (const v of state.vehicles) {
    const due = opts.only ? v.id === opts.only : opts.force || v.fetched_on !== today;
    read.push(due ? await readVehicle(v, ports, today) : v);
  }
  const labels = vehicleLabels(read);
  const synced: CarVehicle[] = [];
  for (const v of read) synced.push(await syncRenewals(v, labels.get(v.id)!, ports));
  const next = { vehicles: synced };
  await ports.save(next);
  return next;
}

/** Add a registration and read it at once. The same registration twice is the same car. */
export async function addVehicle(raw: unknown, today: string, ports: CarPorts): Promise<{ state: CarState; id: string }> {
  const registration = normaliseRegistration(raw);
  if (!registration) throw new CarInputError("That doesn't look like a registration number. Type it as it is on the plate, like AB12 CDE.");
  const state = await ports.load();
  const same = state.vehicles.find((v) => v.registration === registration);
  if (same) return { state, id: same.id };
  if (state.vehicles.length >= MAX_VEHICLES) throw new CarInputError(`Athena keeps up to ${MAX_VEHICLES} vehicles. Take one off first.`);
  const v: CarVehicle = { id: ports.newId(), registration, added_on: today, fetched_on: null, ves: null, mot: null, assets: {} };
  await ports.save({ vehicles: [...state.vehicles, v] });
  return { state: await refreshCars(today, ports, { only: v.id }), id: v.id };
}

/** Take a vehicle off: its renewals are archived and its nudges closed. Its registration is gone from Athena. */
export async function removeVehicle(id: string, ports: CarPorts): Promise<CarState> {
  const state = await ports.load();
  const v = state.vehicles.find((x) => x.id === id);
  if (!v) throw new CarInputError("That vehicle isn't in Athena.", 404);
  for (const assetId of Object.values(v.assets)) {
    const a = assetId ? await ports.getAsset(assetId) : null;
    if (a && !a.archived_at) await ports.archiveAsset(a.id);
  }
  await ports.closeNudges(carNudgePrefix(v.id));
  const next = { vehicles: state.vehicles.filter((x) => x.id !== id) };
  await ports.save(next);
  return next;
}

/** Read once a day: is any vehicle not yet read today? */
export const carsDue = (state: CarState, today: string) => state.vehicles.some((v) => v.fetched_on !== today);

/** A sample car for sample mode: MOT in three weeks, two advisories, tax paid (app/src/db/sample-car.ts uses it). */
export function sampleVehicle(today: string): CarVehicle {
  const mot = addDays(today, 21);
  const lastTest = addDays(mot, -365);
  return {
    id: "sample-car",
    registration: "LK19OPT",
    added_on: addDays(today, -40),
    fetched_on: today,
    ves: { make: "FORD", colour: "BLUE", year: 2019, fuel: "PETROL", tax_status: "Taxed", tax_due: addDays(today, 143), mot_status: "Valid", mot_expiry: mot },
    mot: {
      make: "FORD",
      model: "FOCUS",
      colour: "Blue",
      fuel: "Petrol",
      first_due: null,
      recall: "No",
      tests: [
        {
          date: lastTest,
          result: "PASSED",
          expiry: mot,
          miles: 41_830,
          defects: [
            { type: "ADVISORY", text: "Nearside Front Tyre worn close to legal limit/worn on edge (5.2.3 (e))", dangerous: false },
            { type: "ADVISORY", text: "Front brake disc worn, pitted or scored, but not seriously weakened (1.1.14 (a) (ii))", dangerous: false },
          ],
        },
        { date: addDays(lastTest, -364), result: "PASSED", expiry: addDays(lastTest, 1), miles: 34_120, defects: [] },
        { date: addDays(lastTest, -729), result: "FAILED", expiry: null, miles: 26_540, defects: [{ type: "MAJOR", text: "Offside Headlamp not working (4.1.1 (a) (ii))", dangerous: false }] },
        { date: addDays(lastTest, -728), result: "PASSED", expiry: addDays(lastTest, -364), miles: 26_545, defects: [] },
      ],
    },
    assets: {},
  };
}
