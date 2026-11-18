/**
 * Work for the app (GET /api/life/work, lib/work-data.ts on the server): one
 * period's page, or one project. Nothing is stored on the device; the last
 * answers are held in memory for a minute, so the Library's line and the
 * page share one request. Sample mode answers from db/sample-work.ts with the
 * same rules (lib/work-stats.ts).
 */

import { isSampleMode, request } from "./api";
import type { WorkData, WorkProjectDetail } from "../../../lib/work-stats";

export type { WorkData, WorkNote, WorkProject, WorkProjectDetail, WorkSpread } from "../../../lib/work-stats";

const HOLD_MS = 60_000;
const held = new Map<string, { at: number; value: Promise<unknown> }>();

function once<T>(key: string, load: () => Promise<T>): Promise<T> {
  const h = held.get(key);
  if (h && Date.now() - h.at < HOLD_MS) return h.value as Promise<T>;
  const value = load();
  held.set(key, { at: Date.now(), value });
  value.catch(() => held.delete(key));
  return value;
}

export function loadWork(period: string): Promise<WorkData> {
  return once(`p:${period}`, async () => (isSampleMode() ? (await import("./sample-work")).sampleWork(period) : request<WorkData>(`/life/work?period=${encodeURIComponent(period)}`)));
}

/** One project over the last year; null when none of the owner's issues are in it. */
export function loadWorkProject(name: string): Promise<WorkProjectDetail | null> {
  return once(`project:${name.toLowerCase()}`, async () => {
    if (isSampleMode()) return (await import("./sample-work")).sampleWorkProject(name);
    try {
      return await request<WorkProjectDetail>(`/life/work?project=${encodeURIComponent(name)}`);
    } catch (e) {
      if ((e as { status?: number }).status === 404) return null;
      throw e;
    }
  });
}
