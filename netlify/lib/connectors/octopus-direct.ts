/**
 * Octopus Energy without MCP: a narrow, read-only adapter over Octopus's
 * public REST API (api.octopus.energy/v1), registered in direct.ts. The
 * owner pastes the API key from their account's developer page, and adds
 * the electricity meter (MPAN and serial), the gas meter (MPRN and serial),
 * or both, as the account's address (lib/presets/octopus-meters.ts). Octopus
 * takes the key as the username in Basic auth.
 *
 * consumption(date | after, before): half-hourly kWh from each smart meter
 * the account has, from /electricity-meter-points/{mpan}/meters/{serial}/
 * consumption/ and /gas-meter-points/{mprn}/meters/{serial}/consumption/,
 * following `next`. Grouped by the owner's local day by lib/money.ts, each
 * fuel kept apart; a fuel without a meter gets no figures at all.
 *
 * Half-hourly use shows when someone's home, so the figures are sealed as
 * 'home' days and the tool is never offered to Claude. Gas: SMETS1 meters
 * report kWh and SMETS2 meters m³ (Octopus's REST guide, checked 7 Nov
 * 2026). No documented endpoint says which a meter is, so the owner says so
 * with a switch, and Athena turns m³ into kWh with the usual factor
 * (× 1.02264 × 39.5 ÷ 3.6).
 *
 * findAddress(account number): GET /accounts/{number}/ with the key, for the
 * meter points and serials on the account's current home, to pick from in
 * the form. Export meters are left out. Nothing else on the reply is kept.
 *
 * History (backfill.ts): on connect, Edit or "Load history again", the
 * consumption read a month a page back to OCTOPUS_HISTORY_MONTHS or the first
 * empty month (octopus-history.ts), saved as sealed 'home' days. Same
 * endpoints and key as the tool, earlier dates.
 *
 * readOctopusTariffs(address, key): for House's costs, once a day from the
 * meter sync, when the address carries the account number. GET
 * /accounts/{number}/ with the key for the agreements (tariff code, from,
 * to) on the meter points Athena reads; then, without the key, each
 * tariff's public unit rates and standing charges under /products/. Those
 * calls carry only the product and tariff codes and the dates. Not a tool:
 * a year of half-hourly prices is too big for one, and no model needs it.
 */
import type { Connector, ConnectorSecrets } from "../../../lib/connectors";
import { AthenaInputError } from "../../../lib/db";
import { homeDays, type Reading } from "../../../lib/money";
import { isTwoRate, productOf, ratesOf, type Fuel as TariffFuel, type TariffAgreement, type TariffStore } from "../../../lib/tariff";
import { MeterAddressError, OCTOPUS_API_URL, metersOf as parseMeters, octopusAddress as buildFromForm, type Meters } from "../../../lib/presets/octopus-meters";
import { ToolInputError } from "./google-api";
import type { AddressChoice, DirectAccount, DirectAdapter } from "./direct";
import type { HistoryBackfill } from "./backfill";
import { saveHomeDays, type HomeDayFigures } from "../../../lib/money";
import { addDays, zonedToday, zonedToInstant } from "../../../lib/dates";
import { monthStep } from "./octopus-history";
import { LifeApiError, WINDOW_PROPS, account, getJson, lifeAccountProblem, lifeFailure, ownerZone, readOnly, windowOf, withItems, type LifeTool } from "./lifelog-b-http";

export type { Meters };

const HOSTS = ["api.octopus.energy"];
const MAX_DAYS = 31;
export const M3_TO_KWH = (1.02264 * 39.5) / 3.6;

/** The form's fields, an address Athena made, or the old one-line form → the address Athena keeps. */
export function octopusAddress(raw: string): string {
  try {
    return buildFromForm(raw);
  } catch (e) {
    if (e instanceof MeterAddressError) throw new AthenaInputError(e.message);
    throw e;
  }
}

export function metersOf(address: string): Meters {
  try {
    return parseMeters(address);
  } catch (e) {
    if (e instanceof MeterAddressError) throw new LifeApiError("octopus", 400, e.message, true);
    throw e;
  }
}

type Fuel = "electricity" | "gas" | null;
const fuelOf = (url: string): Fuel => (url.includes("/gas-meter-points/") ? "gas" : url.includes("/electricity-meter-points/") ? "electricity" : null);

function refused(status: number, fuel: Fuel): LifeApiError {
  if (status === 401 || status === 403) return new LifeApiError("octopus", 401, "Octopus didn't accept that API key. Copy it again from your account's developer page and paste it under Edit.", true);
  if (status === 404 && fuel === "gas") return new LifeApiError("octopus", 404, "Octopus can't find that gas meter. Check the MPRN and serial under Edit.", true);
  if (status === 404 && fuel === "electricity") return new LifeApiError("octopus", 404, "Octopus can't find that electricity meter. Check the MPAN and serial under Edit.", true);
  if (status === 404) return new LifeApiError("octopus", 404, "Octopus can't find that account number. Check it on your bill or dashboard.");
  if (status === 429) return new LifeApiError("octopus", 429, "Octopus is limiting how often Athena can ask right now. Try again in a few minutes.");
  if (status >= 500) return new LifeApiError("octopus", status, "Octopus is having trouble right now. Try again in a few minutes.");
  if (status === 400) return new LifeApiError("octopus", 400, "Octopus didn't understand those dates");
  return new LifeApiError("octopus", status, `Octopus refused that (${status})`);
}

export interface OctopusContext {
  /** A path under the API, or a `next` URL Octopus gave. */
  get<T>(pathOrUrl: string, params?: Record<string, string>): Promise<T>;
  meters: Meters;
  tz: string;
}

interface Page {
  next?: string | null;
  results?: Array<{ consumption?: number; interval_start?: string }>;
}

/** Every half hour in [after, before), following `next` (at most 20 pages). */
async function readings(ctx: OctopusContext, path: string, after: number, before: number): Promise<Reading[]> {
  const out: Reading[] = [];
  let page = await ctx.get<Page>(path, { period_from: new Date(after).toISOString(), period_to: new Date(before).toISOString(), page_size: "1500", order_by: "period" });
  for (let n = 0; n < 20; n++) {
    for (const r of page.results ?? []) if (typeof r.consumption === "number" && r.interval_start) out.push({ start: r.interval_start, kwh: r.consumption });
    if (!page.next) break;
    page = await ctx.get<Page>(page.next);
  }
  return out;
}

/** The consumption endpoint for the one meter given. */
function consumptionPath(m: Meters): string {
  if (m.electricity) return `/electricity-meter-points/${m.electricity.mpan}/meters/${m.electricity.serial}/consumption/`;
  return `/gas-meter-points/${m.gas!.mprn}/meters/${m.gas!.serial}/consumption/`;
}

export const OCTOPUS_TOOLS: LifeTool<OctopusContext>[] = [
  {
    name: "consumption",
    summary: "See your electricity and gas use",
    description: `Electricity and gas per local day, from whichever meters the account has: date, kwh and half_hours (48 kWh values from midnight) for electricity, gas_kwh for gas. A fuel without a meter is left out. At most ${MAX_DAYS} days a call. Default: yesterday.`,
    inputSchema: { type: "object", properties: { ...WINDOW_PROPS } },
    annotations: readOnly,
    async run(ctx, args) {
      const w = windowOf(args, ctx.tz);
      const before = w.before ?? Date.now();
      const after = w.after ?? before - 86_400_000;
      if (before - after > MAX_DAYS * 86_400_000) throw new ToolInputError(`Ask for ${MAX_DAYS} days or fewer at a time`);
      const days = await consumptionDays(ctx, after, before);
      return withItems([...days.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([date, d]) => ({ date, ...d })), {});
    },
  },
];

/** Each meter's half hours in [after, before), grouped by local day. */
async function consumptionDays(ctx: OctopusContext, after: number, before: number): Promise<Map<string, HomeDayFigures>> {
  const { electricity, gas } = ctx.meters;
  const electric = electricity ? await readings(ctx, consumptionPath({ electricity }), after, before) : null;
  const gasReadings = gas ? (await readings(ctx, consumptionPath({ gas }), after, before)).map((r) => (gas.m3 ? { ...r, kwh: r.kwh * M3_TO_KWH } : r)) : null;
  return homeDays(electric, gasReadings, ctx.tz);
}

/**
 * The meters' history as one stream, a month a page from a few days ago
 * (the Life log run keeps the last few days fresh) back to the floor or the
 * first empty month. The page saves its days itself (sealed home days, not
 * Day entries), so the engine writes nothing for it.
 */
export const octopusBackfill: HistoryBackfill = {
  tools: ["consumption"],
  unit: "day",
  async open(connector, secrets, { tz }) {
    const key = secrets.token?.trim();
    if (!key) throw new LifeApiError("octopus", 401, "Paste your Octopus API key.", true);
    const ctx: OctopusContext = { get: keyed(key), meters: metersOf(connector.url), tz };
    const today = zonedToday(new Date(), tz);
    const at = (d: string) => zonedToInstant(d, "00:00", tz).getTime();
    return [
      {
        id: "consumption",
        tools: ["consumption"],
        async page(cursor) {
          const step = await monthStep(cursor ?? addDays(today, -3), today, (after, before) => consumptionDays(ctx, at(after), at(before)));
          const saved = await saveHomeDays("octopus", step.days, { tz });
          return { entries: [], read: step.days.size, added: saved.changed, ...(step.oldest ? { oldest: step.oldest } : {}), ...(step.next ? { next: step.next } : {}) };
        },
      },
    ];
  },
};

function keyed(key: string) {
  const basic = Buffer.from(`${key}:`).toString("base64");
  return <T>(pathOrUrl: string, params: Record<string, string> = {}): Promise<T> => {
    const url = new URL(pathOrUrl.startsWith("https://") ? pathOrUrl : `${OCTOPUS_API_URL}${pathOrUrl}`);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    const fuel = fuelOf(url.pathname);
    return getJson<T>(url.toString(), { service: "octopus", hosts: HOSTS, headers: { Authorization: `Basic ${basic}` }, refused: (status) => refused(status, fuel), unreachable: "Couldn't reach Octopus Energy" });
  };
}

/** Open with the key: one half hour from each meter proves the key and that meter. */
export async function openOctopus(connector: Connector, secrets: ConnectorSecrets, tz?: string): Promise<DirectAccount> {
  const key = secrets.token?.trim();
  if (!key) throw new LifeApiError("octopus", 401, "Paste your Octopus API key.", true);
  const meters = metersOf(connector.url);
  const get = keyed(key);
  if (meters.electricity) await get(consumptionPath({ electricity: meters.electricity }), { page_size: "1" });
  if (meters.gas) await get(consumptionPath({ gas: meters.gas }), { page_size: "1" });
  return account("octopus", OCTOPUS_TOOLS, { get, meters, tz: tz ?? (await ownerZone()) });
}

interface OctopusAccount {
  properties?: Array<{
    moved_out_at?: string | null;
    electricity_meter_points?: Array<{ mpan?: string; is_export?: boolean; meters?: Array<{ serial_number?: string }> }>;
    gas_meter_points?: Array<{ mprn?: string; meters?: Array<{ serial_number?: string }> }>;
  }>;
}

const ACCOUNT = /^A-[A-Z0-9]{8}$/;

/** The meters on the owner's current home, from their account number. Read-only; only meter points and serials are kept. */
export async function findOctopusMeters(number: string, secrets: ConnectorSecrets): Promise<AddressChoice[]> {
  const n = number.replace(/\s+/g, "").toUpperCase();
  if (!ACCOUNT.test(n)) throw new AthenaInputError("An Octopus account number looks like A-1234ABCD.");
  const key = secrets.token?.trim();
  if (!key) throw new AthenaInputError("Paste your Octopus API key first.");
  const acct = await keyed(key)<OctopusAccount>(`/accounts/${n}/`);
  const homes = (acct.properties ?? []).filter((p) => !p.moved_out_at);
  const out: AddressChoice[] = [];
  const seen = new Set<string>();
  const add = (c: AddressChoice) => {
    const k = `${c.group}:${Object.values(c.values).join(":")}`;
    if (!seen.has(k)) seen.add(k), out.push(c);
  };
  for (const p of homes) {
    for (const e of p.electricity_meter_points ?? []) {
      if (e.is_export || !e.mpan || !/^\d{13}$/.test(e.mpan)) continue;
      for (const m of e.meters ?? []) if (m.serial_number?.trim()) add({ group: "electricity", values: { mpan: e.mpan, serial: m.serial_number.trim().toUpperCase() }, label: `Electricity · ${e.mpan} · ${m.serial_number.trim().toUpperCase()}` });
    }
    for (const g of p.gas_meter_points ?? []) {
      if (!g.mprn || !/^\d{6,10}$/.test(g.mprn)) continue;
      for (const m of g.meters ?? []) if (m.serial_number?.trim()) add({ group: "gas", values: { mprn: g.mprn, serial: m.serial_number.trim().toUpperCase() }, label: `Gas · ${g.mprn} · ${m.serial_number.trim().toUpperCase()}` });
    }
  }
  return out;
}

// ---------- Tariffs (House's costs) ----------

/** How far back prices are read: 25 months, so House can price both sides of 12 months against the 12 before (lib/house-data.ts HOUSE_DAYS). */
export const TARIFF_HISTORY_DAYS = 762;

interface AgreementRow {
  tariff_code?: string;
  valid_from?: string | null;
  valid_to?: string | null;
}

interface OctopusAgreements {
  properties?: Array<{
    moved_out_at?: string | null;
    electricity_meter_points?: Array<{ mpan?: string; is_export?: boolean; agreements?: AgreementRow[] }>;
    gas_meter_points?: Array<{ mprn?: string; agreements?: AgreementRow[] }>;
  }>;
}

interface RatePage {
  next?: string | null;
  results?: Array<{ value_inc_vat?: number; valid_from?: string; valid_to?: string | null; payment_method?: string | null }>;
}

/** Public prices: no key goes with them. */
function publicGet<T>(pathOrUrl: string, params: Record<string, string> = {}): Promise<T> {
  const url = new URL(pathOrUrl.startsWith("https://") ? pathOrUrl : `${OCTOPUS_API_URL}${pathOrUrl}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  return getJson<T>(url.toString(), { service: "octopus", hosts: HOSTS, refused: (status) => refused(status, null), unreachable: "Couldn't reach Octopus Energy" });
}

async function priceRows(path: string, from: string, to: string): Promise<RatePage["results"]> {
  const out: NonNullable<RatePage["results"]> = [];
  let page = await publicGet<RatePage>(path, { period_from: from, period_to: to, page_size: "1500" });
  for (let n = 0; n < 30; n++) {
    out.push(...(page.results ?? []));
    if (!page.next) break;
    page = await publicGet<RatePage>(page.next);
  }
  return out;
}

const TARIFF_CODE = /^[EG]-\dR-[A-Z0-9-]+-[A-P]$/;

/**
 * The account's agreements on the meters this address reads, each with its
 * prices since TARIFF_HISTORY_DAYS ago. Null when the address has no
 * account number.
 */
export async function readOctopusTariffs(address: string, secrets: ConnectorSecrets, today: string): Promise<TariffStore | null> {
  const meters = metersOf(address);
  if (!meters.account) return null;
  const key = secrets.token?.trim();
  if (!key) throw new LifeApiError("octopus", 401, "Paste your Octopus API key.", true);
  const acct = await keyed(key)<OctopusAgreements>(`/accounts/${meters.account}/`);
  const found: Array<{ fuel: TariffFuel; row: AgreementRow }> = [];
  for (const p of acct.properties ?? []) {
    for (const e of p.electricity_meter_points ?? []) if (!e.is_export && meters.electricity && e.mpan === meters.electricity.mpan) for (const row of e.agreements ?? []) found.push({ fuel: "electricity", row });
    for (const g of p.gas_meter_points ?? []) if (meters.gas && g.mprn === meters.gas.mprn) for (const row of g.agreements ?? []) found.push({ fuel: "gas", row });
  }
  const floor = `${addDays(today, -TARIFF_HISTORY_DAYS)}T00:00:00Z`;
  const ceiling = `${addDays(today, 2)}T00:00:00Z`;
  const agreements: TariffAgreement[] = [];
  for (const { fuel, row } of found) {
    const tariff = row.tariff_code?.trim().toUpperCase() ?? "";
    if (!TARIFF_CODE.test(tariff) || !row.valid_from) continue;
    // Over before the window starts: nothing on the page uses it.
    const ms = (iso: string) => Date.parse(iso);
    if (!Number.isFinite(ms(row.valid_from)) || (row.valid_to && ms(row.valid_to) < ms(floor))) continue;
    const from = ms(row.valid_from) > ms(floor) ? new Date(row.valid_from).toISOString() : floor;
    const to = row.valid_to && ms(row.valid_to) < ms(ceiling) ? new Date(row.valid_to).toISOString() : ceiling;
    const product = productOf(tariff);
    const base = `/products/${encodeURIComponent(product)}/${fuel}-tariffs/${encodeURIComponent(tariff)}`;
    const twoRate = fuel === "electricity" && isTwoRate(tariff);
    const [unit, night, standing] = await Promise.all([
      priceRows(`${base}/${twoRate ? "day" : "standard"}-unit-rates/`, from, to),
      twoRate ? priceRows(`${base}/night-unit-rates/`, from, to) : Promise.resolve(undefined),
      priceRows(`${base}/standing-charges/`, from, to),
    ]);
    agreements.push({ fuel, tariff, product, from: new Date(row.valid_from).toISOString(), to: row.valid_to ? new Date(row.valid_to).toISOString() : null, unit: ratesOf(unit ?? []), ...(night ? { night: ratesOf(night) } : {}), standing: ratesOf(standing ?? []) });
  }
  agreements.sort((a, b) => a.fuel.localeCompare(b.fuel) || a.from.localeCompare(b.from));
  return { fetched_on: today, account: meters.account, agreements };
}

export const octopusAdapter: DirectAdapter = {
  id: "octopus",
  handles: (c) => c.provider === "octopus" && c.auth_type === "token",
  tools: () => OCTOPUS_TOOLS,
  serverInfo: () => ({ website_url: "https://octopus.energy/" }),
  open: (connector, secrets) => openOctopus(connector, secrets),
  checkAddress: octopusAddress,
  findAddress: findOctopusMeters,
  accountProblem: (e) => lifeAccountProblem("octopus", e),
  failure: (e) => lifeFailure("octopus", e),
  backfill: octopusBackfill,
};
