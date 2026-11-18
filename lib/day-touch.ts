/**
 * Mark days changed (lib/days.ts): every device's next look at a day picks
 * up its new health, places or entries. Its own module so lib/health.ts and
 * lib/places-visits.ts can call it without importing lib/days.ts, which
 * reads them.
 */
import { isValidDate } from "./dates";
import { qRaw } from "./db";

export async function touchDays(dates: string[]): Promise<void> {
  const valid = [...new Set(dates.filter(isValidDate))];
  if (!valid.length) return;
  await qRaw(`INSERT INTO days (date) SELECT unnest($1::date[]) ON CONFLICT (date) DO UPDATE SET updated_at = now()`, [valid]);
}
