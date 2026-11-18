/**
 * House for the app (GET /api/life/house, lib/house-data.ts on the server):
 * the home's energy as chart data, its cost, the household bills. Nothing is
 * cached on the device. Sample mode answers from db/sample-life.ts with the
 * same rules (lib/house.ts).
 */

import { isSampleMode, request } from "./api";
import type { HouseData } from "../../../lib/house";
import type { MeterReading } from "../../../lib/manual-entry";

export type { MeterReading };

/** What the House page's "Add a reading" sends (POST /api/life/readings). */
export interface ReadingInput {
  fuel: MeterReading["fuel"];
  date: string;
  value: number;
  unit: MeterReading["unit"];
}

export type House = HouseData;
export type { HouseBill, HouseEnergy, DailyPoint, MonthPoint } from "../../../lib/house";

export async function loadHouse(): Promise<House> {
  return isSampleMode() ? (await import("./sample-life")).sampleHouse() : request<House>("/life/house");
}

/** Add a meter reading by hand. Answers with every reading, newest first. */
export async function addReading(input: ReadingInput): Promise<MeterReading[]> {
  if (isSampleMode()) return (await import("./sample-life")).addSampleReading(input);
  return (await request<{ readings: MeterReading[] }>("/life/readings", { method: "POST", body: JSON.stringify(input) })).readings;
}

/** Take a reading out. Answers with the rest. */
export async function removeReading(id: string): Promise<MeterReading[]> {
  if (isSampleMode()) return (await import("./sample-life")).removeSampleReading(id);
  return (await request<{ readings: MeterReading[] }>(`/life/readings?${new URLSearchParams({ id })}`, { method: "DELETE" })).readings;
}
