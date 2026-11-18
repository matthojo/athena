/**
 * In-memory CarPorts for the car's tests (lib/car-sync.test.ts,
 * netlify/lib/car-routes.test.ts): the state, Life admin items and closed
 * nudge prefixes, held in plain objects.
 */
import type { CarState } from "./car";
import type { CarAsset, CarPorts, Lookup } from "./car-sync";

export interface MemoryCar {
  ports: CarPorts;
  state: () => CarState;
  assets: Map<string, CarAsset & { provider: string; notes: string; remind_days_before: number[] }>;
  closed: string[];
  calls: { ves: string[]; mot: string[] };
}

export function memoryCar(lookups: { ves?: (reg: string) => Promise<Lookup<unknown>>; mot?: (reg: string) => Promise<Lookup<unknown>> } = {}): MemoryCar {
  let state: CarState = { vehicles: [] };
  let n = 0;
  const assets: MemoryCar["assets"] = new Map();
  const closed: string[] = [];
  const calls = { ves: [] as string[], mot: [] as string[] };
  const ports: CarPorts = {
    load: async () => structuredClone(state),
    save: async (s) => void (state = structuredClone(s)),
    ves: async (reg) => (calls.ves.push(reg), lookups.ves ? lookups.ves(reg) : { none: true }),
    mot: async (reg) => (calls.mot.push(reg), lookups.mot ? lookups.mot(reg) : { none: true }),
    getAsset: async (id) => {
      const a = assets.get(id);
      return a ? { id: a.id, name: a.name, renews_on: a.renews_on, archived_at: a.archived_at } : null;
    },
    createAsset: async (input) => {
      const id = `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`;
      assets.set(id, { id, archived_at: null, ...input });
      return { id };
    },
    updateAsset: async (id, patch) => {
      const a = assets.get(id)!;
      assets.set(id, { ...a, ...patch });
    },
    archiveAsset: async (id) => {
      const a = assets.get(id)!;
      assets.set(id, { ...a, archived_at: "2026-11-10T09:00:00Z" });
    },
    closeNudges: async (prefix) => void closed.push(prefix),
    newId: () => `11111111-1111-4111-8111-${String(++n).padStart(12, "0")}`,
  };
  return { ports, state: () => state, assets, closed, calls };
}
