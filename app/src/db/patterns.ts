/**
 * Patterns for the app (GET /api/patterns, lib/patterns.ts): one load per
 * window, kept for a few minutes so Days, the day page and Health share it.
 * Sample mode reads db/sample-patterns.ts. Nothing is kept on the device.
 */

import { isSampleMode, request } from "./api";
import type { Pattern, PatternWindow } from "../../../lib/patterns";

export type { Pattern, PatternWindow } from "../../../lib/patterns";

const TTL_MS = 5 * 60_000;
const loaded = new Map<number, { at: number; p: Promise<Pattern[]> }>();

/** The owner's patterns over the last 30, 90 or 365 days, strongest first. Empty when there aren't any yet, or they can't be had. */
export function loadPatterns(window: PatternWindow = 90): Promise<Pattern[]> {
  const hit = loaded.get(window);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.p;
  const p = (isSampleMode()
    ? import("./sample-patterns").then((m) => m.samplePatterns(window))
    : request<{ patterns: Pattern[] }>(`/patterns?window=${window}`).then((r) => r.patterns ?? [])
  ).catch(() => {
    loaded.delete(window);
    return [] as Pattern[];
  });
  loaded.set(window, { at: Date.now(), p });
  return p;
}
