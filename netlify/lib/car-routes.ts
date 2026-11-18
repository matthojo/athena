/**
 * The car over REST, mounted by netlify/functions/api.ts behind the same
 * bearer token:
 *
 *   GET    /api/car                  → { vehicles: CarCard[], keys: { dvla, mot } }
 *   POST   /api/car/vehicles         { registration } → read at once; same answer plus { id }
 *   DELETE /api/car/vehicles/:id     → renewals archived, nudges closed
 *   POST   /api/car/refresh          → every vehicle read again now
 *
 * `keys` says only whether each key is set up, never a key. The owner's own
 * registrations come back to the owner's own app, and nowhere else.
 * runCarSync is the once-a-day read, from the reminders function.
 */
import { getOwnerTimeZone } from "../../lib/db";
import { zonedToday } from "../../lib/dates";
import { carCard, vehicleLabels, type CarCard, type CarState } from "../../lib/car";
import { addVehicle, carsDue, CarInputError, refreshCars, removeVehicle, type CarPorts } from "../../lib/car-sync";
import { carPorts, loadCarState } from "../../lib/car-store";
import { carLookups, type CarKeys } from "./car-api";

type Reply = (data: unknown, status?: number) => Response;

const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface CarRouteDeps {
  ports?: CarPorts;
  keys?: CarKeys;
  today?: string;
}

export function carView(state: CarState, today: string, keys: CarKeys): { vehicles: CarCard[]; keys: { dvla: boolean; mot: boolean } } {
  const labels = vehicleLabels(state.vehicles);
  return { vehicles: state.vehicles.map((v) => carCard(v, today, labels.get(v.id))), keys: { dvla: !!keys.dvla, mot: !!keys.mot } };
}

async function setup(deps: CarRouteDeps) {
  const today = deps.today ?? zonedToday(new Date(), await getOwnerTimeZone());
  if (deps.ports && deps.keys) return { today, ports: deps.ports, keys: deps.keys };
  const lookups = await carLookups();
  return { today, ports: deps.ports ?? carPorts(lookups), keys: deps.keys ?? lookups.keys };
}

export async function handleCarRoutes(req: Request, _url: URL, segments: string[], reply: Reply, deps: CarRouteDeps = {}): Promise<Response | null> {
  const [, first, second, third] = segments;
  if (first !== "car") return null;
  try {
    if (segments.length === 2 && req.method === "GET") {
      const { today, ports, keys } = await setup(deps);
      return reply(carView(await ports.load(), today, keys));
    }
    if (second === "vehicles" && segments.length === 3 && req.method === "POST") {
      const body = (await req.json().catch(() => ({}))) as { registration?: unknown };
      const { today, ports, keys } = await setup(deps);
      if (!keys.dvla && !keys.mot) throw new CarInputError("Add a DVLA or DVSA key first, so Athena can look the car up.");
      const { state, id } = await addVehicle(body.registration, today, ports);
      return reply({ ...carView(state, today, keys), id }, 201);
    }
    if (second === "vehicles" && segments.length === 4 && req.method === "DELETE") {
      if (!ID.test(third)) return reply({ error: "Not found" }, 404);
      const { today, ports, keys } = await setup(deps);
      return reply(carView(await removeVehicle(third, ports), today, keys));
    }
    if (second === "refresh" && segments.length === 3 && req.method === "POST") {
      const { today, ports, keys } = await setup(deps);
      return reply(carView(await refreshCars(today, ports, { force: true }), today, keys));
    }
    return reply({ error: "Not found" }, 404);
  } catch (error) {
    if (error instanceof CarInputError) return reply({ error: error.message }, error.status);
    throw error;
  }
}

/** Once a day, from the reminders function: read each vehicle not read today. Quiet when there are none. Never throws. */
export async function runCarSync(today: string, deps: { ports?: CarPorts } = {}): Promise<number> {
  try {
    const state = deps.ports ? await deps.ports.load() : await loadCarState();
    if (!state.vehicles.length || !carsDue(state, today)) return 0;
    const ports = deps.ports ?? carPorts(await carLookups());
    const next = await refreshCars(today, ports);
    return next.vehicles.length;
  } catch (error) {
    console.error("Athena car: the daily read failed", error instanceof Error ? error.name : "");
    return 0;
  }
}
