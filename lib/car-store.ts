/**
 * Where the car lives: one `settings` row, key 'car', whose value is
 * { sealed: <the whole CarState, sealed with the data key> }. Registrations
 * and both sources' answers sit inside the seal; nothing about the car is
 * readable in the database. No migration: `settings` already takes any key.
 *
 * carPorts() joins it to Life admin (assets, kind 'vehicle'), the nudge
 * store and the two lookups (netlify/lib/car-api.ts passes them in).
 */
import { randomUUID } from "node:crypto";
import { dataKeyConfigured, DataKeyMissing, openStrict, sealText } from "./data-box";
import { qRaw, archiveEntity } from "./db";
import { getAsset, upsertAsset } from "./memory";
import { closeNudgesLike } from "./proactive/store";
import { EMPTY_CAR, type CarState } from "./car";
import type { CarPorts, Lookup } from "./car-sync";

export const CAR_KEY = "car";

export async function loadCarState(): Promise<CarState> {
  const [row] = await qRaw<{ value: { sealed?: string } }>(`SELECT value FROM settings WHERE key = $1`, [CAR_KEY]);
  if (!row?.value?.sealed) return { vehicles: [] };
  const o = JSON.parse(openStrict(row.value.sealed)) as Partial<CarState>;
  return { vehicles: Array.isArray(o.vehicles) ? o.vehicles : EMPTY_CAR.vehicles };
}

export async function saveCarState(state: CarState): Promise<void> {
  if (!dataKeyConfigured()) throw new DataKeyMissing();
  await qRaw(
    `INSERT INTO settings (key, value) VALUES ($1, $2::jsonb) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
    [CAR_KEY, JSON.stringify({ sealed: sealText(JSON.stringify(state)) })],
  );
}

export function carPorts(lookups: { ves: (reg: string) => Promise<Lookup<unknown>>; mot: (reg: string) => Promise<Lookup<unknown>> }): CarPorts {
  return {
    load: loadCarState,
    save: saveCarState,
    ves: lookups.ves,
    mot: lookups.mot,
    async getAsset(id) {
      const a = await getAsset(id, { includeArchived: true });
      return a ? { id: a.id, name: a.name, renews_on: a.renews_on, archived_at: a.archived_at } : null;
    },
    async createAsset(input) {
      const a = await upsertAsset({ name: input.name, kind: "vehicle", provider: input.provider, renews_on: input.renews_on, notes: input.notes, remind_days_before: input.remind_days_before });
      return { id: a.id };
    },
    async updateAsset(id, patch) {
      await upsertAsset({ id, ...patch });
    },
    async archiveAsset(id) {
      await archiveEntity("asset", id);
    },
    closeNudges: (prefix) => closeNudgesLike(prefix),
    newId: () => randomUUID(),
  };
}
