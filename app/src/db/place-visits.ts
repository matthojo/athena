/**
 * Place visits added by hand, for the app (GET/POST/DELETE
 * /api/places/visits/manual, lib/places-visits.ts on the server): for
 * someone without Swarm or a Google Maps Timeline file. Nothing is cached on
 * the device; sample mode keeps them in this browser (db/sample-place-visits.ts)
 * and lays them over the made-up days.
 */

import { isSampleMode, request } from "./api";
import type { ManualVisitInput, ManualVisitRow } from "../../../lib/places-visits";

export type ManualVisit = ManualVisitRow;
export type { ManualVisitInput };

const samples = () => import("./sample-place-visits");

/** Visits added by hand, newest first: one day, or the last year. */
export async function loadManualVisits(date?: string): Promise<ManualVisit[]> {
  if (isSampleMode()) return (await samples()).sampleManualVisits(date);
  return (await request<{ visits: ManualVisit[] }>(`/places/visits/manual${date ? `?${new URLSearchParams({ date })}` : ""}`)).visits;
}

/** Add one. The server finds where it is (the Place's spot or address, or the typed address) and rebuilds the day. */
export async function addManualVisit(input: ManualVisitInput, placeName?: string): Promise<ManualVisit> {
  if (isSampleMode()) return (await samples()).addSampleVisit(input, placeName);
  return (await request<{ visit: ManualVisit }>("/places/visits/manual", { method: "POST", body: JSON.stringify(input) })).visit;
}

/** Take one out; its day is rebuilt. */
export async function removeManualVisit(date: string, id: string): Promise<void> {
  if (isSampleMode()) return (await samples()).removeSampleVisit(id);
  await request(`/places/visits/manual?${new URLSearchParams({ date, id })}`, { method: "DELETE" });
}
