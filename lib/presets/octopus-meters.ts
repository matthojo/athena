/**
 * Octopus Energy's meters as the address Athena keeps for the account, and
 * the Setup and Edit form's fields for them. Pure, shared by the PWA and the
 * adapter (netlify/lib/connectors/octopus-direct.ts).
 *
 * The address is one of:
 *   …/v1/electricity-meter-points/{mpan}/meters/{serial}/                    electricity
 *   …/v1/electricity-meter-points/{mpan}/meters/{serial}/?gas=mprn:serial[:m3] both
 *   …/v1/gas-meter-points/{mprn}/meters/{serial}/[?units=m3]                 gas only
 * The first two are what Athena has always kept, so older accounts read the
 * same. `m3` marks a SMETS2 gas meter, which reports m³ rather than kWh.
 * Any of them may carry `account=A-XXXXXXXX`, the Octopus account number:
 * optional, for House's costs (lib/tariff.ts). "Find my meters" keeps the
 * number it was given; Edit can set or clear it.
 */
import { checkAddressFields, firstProblem, type AddressFields, type AddressValues } from "../address-fields";

export const OCTOPUS_API_URL = "https://api.octopus.energy/v1";

export interface Meters {
  electricity?: { mpan: string; serial: string };
  gas?: { mprn: string; serial: string; m3: boolean };
  /** The account number, A-XXXXXXXX: for the tariff, so House can show costs. */
  account?: string;
}

const MPAN = /^\d{13}$/;
const MPRN = /^\d{6,10}$/;
const SERIAL = /^[A-Z0-9]{4,20}$/i;
export const ACCOUNT_NUMBER = /^A-[A-Z0-9]{8}$/;

/** The old one-line form's words, still taken (and said) for a pasted line. */
export const NEED_LINE = "Paste your MPAN (13 digits) and meter serial, with a space between them. For gas, add its MPRN and serial after them, and m3 if it's a SMETS2 meter.";
export const NEED_METER = "Add your electricity meter, your gas meter, or both.";

export class MeterAddressError extends Error {}

export const OCTOPUS_FIELDS: AddressFields = {
  none: NEED_METER,
  groups: [
    {
      key: "electricity",
      title: "Electricity",
      inputs: [
        { key: "mpan", label: "MPAN", placeholder: "13 digits", pattern: MPAN.source, message: "An MPAN is 13 digits.", missing: "Add the electricity meter's MPAN.", numeric: true },
        { key: "serial", label: "Meter serial", placeholder: "Letters and numbers", pattern: SERIAL.source, message: "A meter serial is 4 to 20 letters and numbers.", missing: "Add the electricity meter's serial.", upper: true },
      ],
    },
    {
      key: "gas",
      title: "Gas",
      inputs: [
        { key: "mprn", label: "MPRN", placeholder: "6 to 10 digits", pattern: MPRN.source, message: "An MPRN is 6 to 10 digits.", missing: "Add the gas meter's MPRN.", numeric: true },
        { key: "serial", label: "Meter serial", placeholder: "Letters and numbers", pattern: SERIAL.source, message: "A meter serial is 4 to 20 letters and numbers.", missing: "Add the gas meter's serial.", upper: true },
      ],
      toggle: { key: "m3", label: "My gas meter reports in m³ (SMETS2)" },
    },
    {
      key: "account",
      title: "For costs (optional)",
      optional: true,
      sub: "With your account number, House prices each day at your tariff. Athena reads only the tariff and its prices.",
      inputs: [{ key: "number", label: "Account number", placeholder: "A-1234ABCD", pattern: ACCOUNT_NUMBER.source, message: "An Octopus account number looks like A-1234ABCD.", missing: "Add the account number.", upper: true }],
    },
  ],
  finder: {
    label: "Account number",
    placeholder: "A-1234ABCD",
    pattern: "^A-[A-Z0-9]{8}$",
    message: "An Octopus account number looks like A-1234ABCD.",
    sub: "It's at the top of your Octopus bills and dashboard. Athena asks Octopus which meters are on it, using the key above.",
    button: "Find my meters",
    asking: "Asking Octopus…",
    pick: "Pick the meters to read. Each one fills in its fields above.",
    empty: "Octopus has no meters on that account. Add them yourself above.",
    failed: "Couldn't ask Octopus. Add your meters yourself above.",
    keeps: "account.number",
  },
  read: (address) => {
    try {
      return meterValues(metersOf(address));
    } catch {
      return null;
    }
  },
};

export function buildAddress(m: Meters): string {
  let url: URL;
  if (m.electricity) {
    url = new URL(`${OCTOPUS_API_URL}/electricity-meter-points/${m.electricity.mpan}/meters/${m.electricity.serial.toUpperCase()}/`);
    if (m.gas) url.searchParams.set("gas", `${m.gas.mprn}:${m.gas.serial.toUpperCase()}${m.gas.m3 ? ":m3" : ""}`);
  } else {
    if (!m.gas) throw new MeterAddressError(NEED_METER);
    url = new URL(`${OCTOPUS_API_URL}/gas-meter-points/${m.gas.mprn}/meters/${m.gas.serial.toUpperCase()}/`);
    if (m.gas.m3) url.searchParams.set("units", "m3");
  }
  const account = m.account?.replace(/\s+/g, "").toUpperCase();
  if (account && ACCOUNT_NUMBER.test(account)) url.searchParams.set("account", account);
  return url.toString();
}

/** The address with its account number taken off: the meters alone, to tell whether they moved. */
export function withoutAccount(address: string): string {
  try {
    const url = new URL(address);
    url.searchParams.delete("account");
    return url.toString();
  } catch {
    return address;
  }
}

/** The account number kept on an address, if any. */
function accountOf(url: URL): { account?: string } {
  const a = url.searchParams.get("account")?.toUpperCase();
  return a && ACCOUNT_NUMBER.test(a) ? { account: a } : {};
}

/** The address Athena keeps → its meters. Throws MeterAddressError for anything else. */
export function metersOf(address: string): Meters {
  let url: URL;
  try {
    url = new URL(address);
  } catch {
    throw new MeterAddressError(NEED_METER);
  }
  if (url.hostname !== "api.octopus.energy") throw new MeterAddressError(NEED_METER);
  const e = url.pathname.match(/^\/v1\/electricity-meter-points\/(\d{13})\/meters\/([A-Za-z0-9]{4,20})\/?$/);
  if (e) {
    const gas = url.searchParams.get("gas")?.split(":");
    const ok = gas && gas.length >= 2 && MPRN.test(gas[0]) && SERIAL.test(gas[1]);
    return { electricity: { mpan: e[1], serial: e[2] }, ...(ok ? { gas: { mprn: gas[0], serial: gas[1], m3: gas[2] === "m3" } } : {}), ...accountOf(url) };
  }
  const g = url.pathname.match(/^\/v1\/gas-meter-points\/(\d{6,10})\/meters\/([A-Za-z0-9]{4,20})\/?$/);
  if (g) return { gas: { mprn: g[1], serial: g[2], m3: url.searchParams.get("units") === "m3" }, ...accountOf(url) };
  throw new MeterAddressError(NEED_METER);
}

export function meterValues(m: Meters): AddressValues {
  return {
    ...(m.electricity ? { electricity: { mpan: m.electricity.mpan, serial: m.electricity.serial } } : {}),
    ...(m.gas ? { gas: { mprn: m.gas.mprn, serial: m.gas.serial, m3: m.gas.m3 } } : {}),
    ...(m.account ? { account: { number: m.account } } : {}),
  };
}

/** "1200012345678 21L1234567 [1234567890 G4A12345678 [m3]]": the one-line form Athena first asked for. */
function fromLine(raw: string): Meters {
  const parts = raw.trim().split(/[\s,/]+/).filter(Boolean);
  const m3 = parts.length === 5 && /^m(3|³)$/i.test(parts[4]);
  if (m3) parts.pop();
  const [mpan, serial, mprn, gasSerial] = parts;
  if (!mpan || !serial || !MPAN.test(mpan) || !SERIAL.test(serial) || parts.length === 3 || parts.length > 4) throw new MeterAddressError(NEED_LINE);
  if (mprn && (!MPRN.test(mprn) || !SERIAL.test(gasSerial ?? ""))) throw new MeterAddressError(NEED_LINE);
  return { electricity: { mpan, serial: serial.toUpperCase() }, ...(mprn ? { gas: { mprn, serial: gasSerial!.toUpperCase(), m3 } } : {}) };
}

/**
 * What the form sent → the address Athena keeps. Takes the form's fields as
 * JSON, an address Athena made (sent back unchanged from Edit), or the old
 * one-line form.
 */
export function octopusAddress(raw: string): string {
  const s = raw.trim();
  if (s.startsWith("{")) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(s);
    } catch {
      throw new MeterAddressError(NEED_METER);
    }
    const c = checkAddressFields(OCTOPUS_FIELDS, (parsed && typeof parsed === "object" ? parsed : {}) as AddressValues);
    const problem = firstProblem(c);
    if (problem) throw new MeterAddressError(problem);
    const e = c.values.electricity;
    const g = c.values.gas;
    const a = c.values.account;
    return buildAddress({
      ...(e ? { electricity: { mpan: String(e.mpan), serial: String(e.serial) } } : {}),
      ...(g ? { gas: { mprn: String(g.mprn), serial: String(g.serial), m3: g.m3 === true } } : {}),
      ...(a ? { account: String(a.number) } : {}),
    });
  }
  if (/^https:\/\//i.test(s)) return buildAddress(metersOf(s));
  return buildAddress(fromLine(s));
}
