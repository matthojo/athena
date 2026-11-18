/**
 * Each week's kept moment (lib/week-moment.ts), kept on the server
 * (GET /api/week-moments, PUT/DELETE /api/week-moments/:monday) so every
 * device shows the same covers. This device keeps a copy in localStorage, so
 * the Days feed and month view draw a week's cover on first paint and offline;
 * the server's answer replaces it when it comes. Sample mode keeps them here
 * only.
 *
 * Nothing runs on import: the first read happens when a view asks.
 */

import { isSampleMode, request } from "./api";
import type { WeekMoment } from "../lib/week-moment";

export type WeekMoments = Record<string, WeekMoment>;

const COPY = "athena.weekMoments";
const SAMPLE = "athena.sample.weekMoments";
let fresh: Promise<WeekMoments> | null = null;

function readCopy(key: string): WeekMoments {
  try {
    const raw = localStorage.getItem(key);
    const v = raw ? (JSON.parse(raw) as unknown) : null;
    return v && typeof v === "object" && !Array.isArray(v) ? (v as WeekMoments) : {};
  } catch {
    return {};
  }
}

function writeCopy(key: string, v: WeekMoments): void {
  try {
    localStorage.setItem(key, JSON.stringify(v));
  } catch {
    // A full or blocked store only costs the first paint's covers.
  }
}

const key = () => (isSampleMode() ? SAMPLE : COPY);

/** What this device has now, without waiting: for a first paint. */
export function keptMomentsNow(): WeekMoments {
  return readCopy(key());
}

/** The server's moments (once per page load), falling back to this device's copy. */
export function loadWeekMoments(): Promise<WeekMoments> {
  if (isSampleMode()) return Promise.resolve(readCopy(SAMPLE));
  fresh ??= request<{ moments: WeekMoments }>("/week-moments")
    .then((r) => {
      writeCopy(COPY, r.moments);
      return r.moments;
    })
    .catch(() => {
      fresh = null;
      return readCopy(COPY);
    });
  return fresh;
}

/** Keep (or, with null, let go of) a week's moment. Resolves once the server has it. */
export async function keepWeekMoment(monday: string, moment: WeekMoment | null): Promise<void> {
  const k = key();
  const before = readCopy(k);
  const next = { ...before };
  if (moment) next[monday] = moment;
  else delete next[monday];
  writeCopy(k, next);
  if (isSampleMode()) return;
  try {
    await request(`/week-moments/${monday}`, moment ? { method: "PUT", body: JSON.stringify(moment) } : { method: "DELETE" });
    fresh = Promise.resolve(next);
  } catch (error) {
    writeCopy(k, before);
    throw error;
  }
}
