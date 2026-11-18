/**
 * Sample mode's place visits added by hand: kept in this browser's
 * localStorage and laid over the made-up days (db/sample-days.ts
 * withManualVisits), the way the server merges them into the day. No map:
 * a typed address is named by the name given, else the address.
 */

import type { Day } from "./days-app";
import type { ManualVisit, ManualVisitInput } from "./place-visits";

const KEY = "athena.sample.placeVisits";

function all(): ManualVisit[] {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? "[]");
    return (Array.isArray(v) ? (v as ManualVisit[]) : []).sort((a, b) => b.start.localeCompare(a.start));
  } catch {
    return [];
  }
}

function save(list: ManualVisit[]): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(list));
  } catch {
    // Private mode: they last as long as the page.
  }
}

const later = <T>(v: T, ms = 120): Promise<T> => new Promise((res) => setTimeout(() => res(structuredClone(v)), ms));

export function sampleManualVisits(date?: string): Promise<ManualVisit[]> {
  return later(all().filter((v) => !date || v.date === date), 60);
}

export async function addSampleVisit(input: ManualVisitInput, placeName?: string): Promise<ManualVisit> {
  const visit: ManualVisit = {
    id: `sample-${Date.now().toString(36)}`,
    date: input.date,
    start: new Date(`${input.date}T${input.time}:00`).toISOString(),
    minutes: input.minutes,
    ...(input.place_id ? { place_id: input.place_id } : {}),
    name: placeName || input.name || input.address || "A place",
    ...(input.address ? { address: input.address } : {}),
  };
  save([...all(), visit]);
  return later(visit, 200);
}

export function removeSampleVisit(id: string): Promise<void> {
  save(all().filter((v) => v.id !== id));
  return later(undefined, 60);
}

/**
 * A made-up day with the visits added by hand on it: each a stop (the same
 * Place twice is one stop, its minutes added: made-up days have no times to
 * compare), and the places line saying new ones last. Synchronous, for
 * sample-days' withEdits.
 */
export function withManualVisits(d: Day): Day {
  const added = all()
    .filter((v) => v.date === d.date)
    .sort((a, b) => a.start.localeCompare(b.start));
  if (!added.length) return d;
  const places = d.places.map((p) => ({ ...p }));
  const names: string[] = [];
  for (const v of added) {
    const same = places.find((p) => (v.place_id ? p.id === v.place_id : !p.id && p.name === v.name));
    if (same) same.minutes = (same.minutes ?? 0) + v.minutes;
    else places.push({ ...(v.place_id ? { id: v.place_id } : {}), name: v.name, minutes: v.minutes });
    // A Place the made-up day already has is that stop: the line says it once.
    if (!names.includes(v.name) && !(same && d.places.some((p) => (p.id ?? p.name) === (same.id ?? same.name)))) names.push(v.name);
  }
  const said = d.places_line ? [d.places_line.replace(/, then /, ", ")] : [];
  const parts = [...said, ...names];
  const line = parts.length > 1 ? `${parts.slice(0, -1).join(", ")}, then ${parts[parts.length - 1]}` : parts[0];
  return { ...d, places, places_line: line.replace(/^./, (c) => c.toUpperCase()) };
}
