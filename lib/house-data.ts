/**
 * The House page from the database (GET /api/life/house): the sealed home
 * days, the sealed tariff and the regular payments, opened here and drawn by
 * lib/house.ts. Same access as Money: the app's token or a full key.
 *
 * Gas allowing for the weather needs the home's daily mean temperatures:
 * from Open-Meteo for the Place called Home (lib/weather.ts dailyMeans, only
 * the coordinates rounded to two decimals and the dates are sent), cached a
 * month at a time. Where Home is: its spot from visits, else its typed
 * address looked up once through Places' geocoder (lib/static-map.ts
 * placeStop: Nominatim, only the address sent, the answer cached sealed).
 * Without a Home, or when either service doesn't answer in time, the card
 * shows raw figures and says why.
 */
import { loadAppliances } from "./appliance-store";
import { houseAppliances } from "./home-appliances";
import { addDays } from "./dates";
import { listConnectors } from "./connectors";
import { homeMonths, readHomeDays, regularPayments, type HomeDayFigures } from "./money";
import { loadReadings } from "./meter-readings";
import { householdBills, houseEnergy, type HouseData, type HouseEnergy } from "./house";

export type { HouseData };
import { loadTariffStore } from "./tariff-store";
import { metersOf } from "./presets/octopus-meters";
import { placeStop } from "./static-map";
import { q } from "./db";
import { dailyMeans, type MeanCache } from "./weather";

/**
 * 25 months: the last 12 months against the 12 before, this year so far
 * against last year's and the same month last year, all with room to be
 * priced (netlify/lib/connectors/octopus-direct.ts TARIFF_HISTORY_DAYS reads
 * prices as far back).
 */
export const HOUSE_DAYS = 762;
/** How long the page waits for the temperatures before showing gas unadjusted. */
export const WEATHER_WAIT_MS = 6_000;

type Weather = { temps: Map<string, number> } | { missing: "no_home" | "unavailable" };

/** The Place called Home: its spot from visits, else its address looked up (once, cached). null without one. */
export async function homeSpot(): Promise<{ lat: number; lng: number } | null> {
  const rows = await q<{ id: string; name: string }>(`SELECT id, name FROM places WHERE archived_at IS NULL`);
  const home = rows.find((r) => r.name.trim().toLowerCase() === "home");
  return home ? placeStop(home.id) : null;
}

/** The home's daily mean temperatures over the days with gas, or why there are none. */
export async function homeWeather(days: Map<string, HomeDayFigures>, today: string, opts: { fetch?: typeof fetch; spot?: () => Promise<{ lat: number; lng: number } | null>; waitMs?: number; cache?: MeanCache } = {}): Promise<Weather | undefined> {
  const gas = [...days.keys()].filter((d) => days.get(d)?.gas_kwh !== undefined).sort();
  if (!gas.length) return undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<"late">((res) => (timer = setTimeout(() => res("late"), opts.waitMs ?? WEATHER_WAIT_MS)));
  // The address lookup and the temperatures share the wait.
  const work = (async (): Promise<Weather> => {
    const spot = await (opts.spot ?? homeSpot)().catch(() => null);
    if (!spot) return { missing: "no_home" };
    const temps = await dailyMeans(spot, gas[0], gas[gas.length - 1], { today, fetch: opts.fetch, ...(opts.cache ? { cache: opts.cache } : {}) }).catch(() => null);
    return temps?.size ? { temps } : { missing: "unavailable" };
  })();
  try {
    const r = await Promise.race([work, late]);
    return r === "late" ? { missing: "unavailable" } : r;
  } finally {
    clearTimeout(timer);
  }
}

async function meterState(): Promise<{ meters: boolean; account: boolean; bank: boolean }> {
  const connectors = await listConnectors().catch(() => []);
  const meters = connectors.filter((c) => c.provider === "octopus");
  const account = meters.some((c) => {
    try {
      return !!metersOf(c.url).account;
    } catch {
      return false;
    }
  });
  return { meters: meters.length > 0, account, bank: connectors.some((c) => c.provider === "monzo" || c.provider === "starling") };
}

/** The energy half of the page alone (Ask's energy tool reads this): no bank payments are opened. */
export async function houseEnergyData(today: string, now: Date, tz: string): Promise<{ energy: HouseEnergy | null; meter: boolean; meter_account: boolean; costs: HouseData["costs"]; bank: boolean }> {
  const [home, tariff, state] = await Promise.all([readHomeDays(addDays(today, -HOUSE_DAYS), today), loadTariffStore().catch(() => null), meterState()]);
  const priced = !!tariff?.agreements.length && state.account;
  const weather = await homeWeather(home.days, today);
  const energy = houseEnergy({ days: home.days, months: homeMonths(home.days), tariff: priced ? tariff : null, today, now, tz, weather });
  return { energy, meter: state.meters || home.days.size > 0, meter_account: state.meters, costs: priced ? "priced" : state.account ? "waiting" : "no_account", bank: state.bank };
}

export async function houseData(today: string, now: Date, tz: string): Promise<HouseData> {
  const [e, regular, readings] = await Promise.all([houseEnergyData(today, now, tz), regularPayments(today).catch(() => null), loadReadings().catch(() => [])]);
  const bills = householdBills(regular?.items ?? []);
  // What the 15-minute look last saw (netlify/lib/home/appliance-sync.ts). Read from the sealed store: nothing is asked of Home Connect here.
  const appliances = await loadAppliances().then(houseAppliances, () => []);
  return { today, energy: e.energy, meter: e.meter, meter_account: e.meter_account, readings, costs: e.costs, bills: { bank: e.bank, ...bills }, ...(appliances.length ? { appliances } : {}) };
}
