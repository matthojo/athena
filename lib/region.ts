/**
 * Where the owner is, for web searches (docs/team-notes/web-runs.md): their
 * profile's Region answer ("United Kingdom, GBP, English") read as a country,
 * a currency and a language, with the city from Home town.
 *
 * Only what the owner wrote is read. A country they didn't name is never
 * worked out from anything else (not the time zone, not the city), and a
 * currency or a language they didn't give comes only from the country they
 * did. Without a country Athena knows, searches go out unplaced.
 *
 * Pure (Intl only), so the app can show what Athena understood as the owner
 * types (app/src/components/profile-inputs.ts).
 */

/** The profile answer's key (lib/profile.ts PROFILE_FIELDS). */
export const REGION_KEY = "Region";

export interface Region {
  /** ISO 3166-1 alpha-2, upper case: "GB". */
  country: string | null;
  /** As people say it: "United Kingdom". */
  countryName: string | null;
  /** ISO 4217: "GBP". */
  currency: string | null;
  /** BCP 47: "en-GB". */
  language: string | null;
  /** From Home town, only alongside a country: "Leeds". */
  city: string | null;
  /** Parts of the answer Athena couldn't read, as typed. */
  unread: string[];
}

/** The web search tool's location (Anthropic's `user_location`). */
export interface SearchLocation {
  type: "approximate";
  country?: string;
  city?: string;
  /** IANA, the owner's own setting (owner, 16 Nov 2026): sent with a place, never used to find one. */
  timezone?: string;
}

// ---------- tables ----------

/**
 * Each country's everyday currency. A country missing here gets no currency
 * unless the owner names one: better none than a guess.
 */
const CURRENCY_OF: Record<string, string> = (() => {
  const groups: Record<string, string> = {
    EUR: "AD AT AX BE BL CY DE EE ES FI FR GF GP GR HR IE IT LT LU LV MC ME MF MQ MT NL PM PT RE SI SK SM VA XK YT",
    USD: "US AS BQ EC FM GU MH MP PR PW SV TC TL UM VG VI",
    GBP: "GB GG IM JE",
    AUD: "AU CC CX KI NF NR TV",
    NZD: "NZ CK NU PN TK",
    XOF: "BF BJ CI GW ML NE SN TG",
    XAF: "CF CG CM GA GQ TD",
    XCD: "AG AI DM GD KN LC MS VC",
    DKK: "DK FO GL",
    CHF: "CH LI",
    NOK: "NO SJ BV",
    INR: "IN BT",
    ZAR: "ZA",
    XPF: "NC PF WF",
    ANG: "CW SX",
  };
  const one: Record<string, string> = {
    AE: "AED", AF: "AFN", AL: "ALL", AM: "AMD", AO: "AOA", AR: "ARS", AW: "AWG", AZ: "AZN", BA: "BAM", BB: "BBD", BD: "BDT", BG: "BGN", BH: "BHD", BI: "BIF", BM: "BMD", BN: "BND", BO: "BOB",
    BR: "BRL", BS: "BSD", BW: "BWP", BY: "BYN", BZ: "BZD", CA: "CAD", CD: "CDF", CL: "CLP", CN: "CNY", CO: "COP", CR: "CRC", CU: "CUP", CV: "CVE", CZ: "CZK", DJ: "DJF", DO: "DOP", DZ: "DZD",
    EG: "EGP", ER: "ERN", ET: "ETB", FJ: "FJD", FK: "FKP", GE: "GEL", GH: "GHS", GI: "GIP", GM: "GMD", GN: "GNF", GT: "GTQ", GY: "GYD", HK: "HKD", HN: "HNL", HT: "HTG", HU: "HUF", ID: "IDR",
    IL: "ILS", IQ: "IQD", IR: "IRR", IS: "ISK", JM: "JMD", JO: "JOD", JP: "JPY", KE: "KES", KG: "KGS", KH: "KHR", KM: "KMF", KR: "KRW", KW: "KWD", KY: "KYD", KZ: "KZT", LA: "LAK", LB: "LBP",
    LK: "LKR", LR: "LRD", LS: "LSL", LY: "LYD", MA: "MAD", MD: "MDL", MG: "MGA", MK: "MKD", MM: "MMK", MN: "MNT", MO: "MOP", MR: "MRU", MU: "MUR", MV: "MVR", MW: "MWK", MX: "MXN", MY: "MYR",
    MZ: "MZN", NA: "NAD", NG: "NGN", NI: "NIO", NP: "NPR", OM: "OMR", PA: "PAB", PE: "PEN", PG: "PGK", PH: "PHP", PK: "PKR", PL: "PLN", PY: "PYG", QA: "QAR", RO: "RON", RS: "RSD", RU: "RUB",
    RW: "RWF", SA: "SAR", SB: "SBD", SC: "SCR", SD: "SDG", SE: "SEK", SG: "SGD", SH: "SHP", SL: "SLE", SO: "SOS", SR: "SRD", SS: "SSP", ST: "STN", SY: "SYP", SZ: "SZL", TH: "THB", TJ: "TJS",
    TM: "TMT", TN: "TND", TO: "TOP", TR: "TRY", TT: "TTD", TW: "TWD", TZ: "TZS", UA: "UAH", UG: "UGX", UY: "UYU", UZ: "UZS", VE: "VES", VN: "VND", VU: "VUV", WS: "WST", YE: "YER", ZM: "ZMW", ZW: "ZWG",
  };
  const out: Record<string, string> = { ...one };
  for (const [cur, list] of Object.entries(groups)) for (const cc of list.split(" ")) out[cc] = cur;
  return out;
})();

/** What people call a country that isn't its English display name. */
const COUNTRY_ALIASES: Record<string, string> = {
  uk: "GB", "great britain": "GB", britain: "GB", england: "GB", scotland: "GB", wales: "GB", "northern ireland": "GB", "united kingdom of great britain and northern ireland": "GB",
  usa: "US", "u.s.": "US", "u.s.a.": "US", us: "US", america: "US", "united states of america": "US",
  holland: "NL", "the netherlands": "NL", "republic of ireland": "IE", eire: "IE", "south korea": "KR", korea: "KR", "czech republic": "CZ", uae: "AE", "the uk": "GB", "the us": "US", "the usa": "US",
};

/** Symbols that name one currency only. "$" and "¥" don't. */
const CURRENCY_SYMBOLS: Record<string, string> = { "£": "GBP", "€": "EUR", "₹": "INR", "₩": "KRW", "₺": "TRY", "₽": "RUB", "₪": "ILS", "zł": "PLN" };

const LANGUAGE_CODES = ["ar", "ca", "cs", "cy", "da", "de", "el", "en", "es", "et", "eu", "fi", "fr", "ga", "gl", "he", "hi", "hr", "hu", "id", "is", "it", "ja", "ko", "lt", "lv", "ms", "mt", "nb", "nl", "nn", "no", "pl", "pt", "ro", "ru", "sk", "sl", "sr", "sv", "th", "tr", "uk", "vi", "zh"];

const fold = (s: string) => s.normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/\s+/g, " ").trim();

/** Codes Intl names that aren't countries today: old ones and groupings. */
const NOT_COUNTRIES = new Set(["AN", "BU", "CS", "DD", "EU", "EZ", "FX", "QO", "SU", "TP", "UK", "UN", "XA", "XB", "YU", "ZR"]);

let countries: Map<string, string> | null = null;
/** Every country Intl can name, by its folded English name, plus the aliases. */
function countryNames(): Map<string, string> {
  if (countries) return countries;
  const names = new Map<string, string>();
  const dn = new Intl.DisplayNames(["en"], { type: "region" });
  for (let a = 65; a <= 90; a++)
    for (let b = 65; b <= 90; b++) {
      const cc = String.fromCharCode(a, b);
      const name = dn.of(cc);
      // First wins: "UK" also names the United Kingdom, as an old alias of GB.
      if (name && name !== cc && !NOT_COUNTRIES.has(cc) && name !== "Unknown Region" && !names.has(fold(name))) names.set(fold(name), cc);
    }
  for (const [alias, cc] of Object.entries(COUNTRY_ALIASES)) names.set(alias, cc);
  return (countries = names);
}

let languages: Map<string, string> | null = null;
function languageNames(): Map<string, string> {
  if (languages) return languages;
  const dn = new Intl.DisplayNames(["en"], { type: "language" });
  const out = new Map<string, string>();
  for (const code of LANGUAGE_CODES) {
    const name = dn.of(code);
    if (name) out.set(fold(name), code);
  }
  return (languages = out);
}

let currencies: Set<string> | null = null;
function knownCurrency(code: string): boolean {
  currencies ??= new Set(Intl.supportedValuesOf("currency"));
  return currencies.has(code);
}

export function countryName(cc: string): string {
  return new Intl.DisplayNames(["en"], { type: "region" }).of(cc) ?? cc;
}

/** The country's main language as a tag: "en-GB", "de-CH". From the country only. */
function languageOf(cc: string): string | null {
  try {
    const lang = new Intl.Locale(`und-${cc}`).maximize().language;
    return lang && lang !== "und" ? `${lang}-${cc}` : null;
  } catch {
    return null;
  }
}

// ---------- reading the answer ----------

/** One part of the answer: a country, a currency or a language, or null. */
function readPart(raw: string): { country?: string; currency?: string; language?: string } | null {
  const part = raw.trim();
  const folded = fold(part);
  if (!folded) return null;
  for (const [sym, cur] of Object.entries(CURRENCY_SYMBOLS)) if (part === sym || folded === sym) return { currency: cur };
  // "GBP", "gbp", "£ GBP", "pounds (GBP)".
  const code = /\b([a-z]{3})\b/i.exec(part.replace(/[£€₹₩₺₽₪]/g, " "));
  if (/^[a-z]{3}$/i.test(folded) && knownCurrency(folded.toUpperCase()) && !countryNames().has(folded)) return { currency: folded.toUpperCase() };
  const country = countryNames().get(folded.replace(/^the /, "")) ?? countryNames().get(folded);
  if (country) return { country };
  // "GB", "DE": two letters Intl can name.
  if (/^[a-z]{2}$/i.test(folded)) {
    const cc = countryNames().get(fold(countryName(folded.toUpperCase())));
    if (cc) return { country: cc };
  }
  // "en-GB", "pt-BR".
  if (/^[a-z]{2,3}-[a-z]{2}$/i.test(part)) {
    const [l, r] = part.split("-");
    return { language: `${l.toLowerCase()}-${r.toUpperCase()}` };
  }
  const lang = languageNames().get(folded.replace(/^british |^american /, ""));
  if (lang) return { language: /^british /.test(folded) ? `${lang}-GB` : /^american /.test(folded) ? `${lang}-US` : lang };
  if (code && knownCurrency(code[1].toUpperCase()) && /pound|euro|dollar|franc|krona|krone|yen|rupee|zloty|real|peso/i.test(part)) return { currency: code[1].toUpperCase() };
  return null;
}

/**
 * The owner's Region answer and Home town, read. Pure. Parts are split on commas, "·", ";" or "/".
 * Currency and language the owner didn't give come from the country they named, and from nothing else.
 */
export function readRegion(value: string | null | undefined, homeTown?: string | null): Region {
  const out: Region = { country: null, countryName: null, currency: null, language: null, city: null, unread: [] };
  for (const raw of (value ?? "").split(/[,·;/|\n]+/)) {
    if (!raw.trim()) continue;
    const got = readPart(raw);
    if (!got) {
      out.unread.push(raw.trim().slice(0, 40));
      continue;
    }
    if (got.country && !out.country) out.country = got.country;
    if (got.currency && !out.currency) out.currency = got.currency;
    if (got.language && !out.language) out.language = got.language;
  }
  if (out.country) {
    out.countryName = countryName(out.country);
    out.currency ??= CURRENCY_OF[out.country] ?? null;
    if (!out.language) out.language = languageOf(out.country);
    else if (!out.language.includes("-")) out.language = `${out.language}-${out.country}`;
    // The city goes with a country only: "Paris" alone could be anywhere.
    const city = (homeTown ?? "").split(/[,(\n]/)[0].replace(/\s+/g, " ").trim();
    if (city && city.length <= 60 && !/[@\d]{3,}/.test(city)) out.city = city;
  }
  return out;
}

/**
 * The search tool's location, or null to search unplaced (no country the owner named). The owner's time zone goes
 * with a place (it helps "open now"), never instead of one. Pure.
 */
export function searchLocation(r: Region | null, timezone?: string | null): SearchLocation | null {
  if (!r?.country) return null;
  const tz = timezone && /^[A-Za-z]+(?:\/[A-Za-z0-9_+-]+){1,2}$/.test(timezone) ? timezone : null;
  return { type: "approximate", country: r.country, ...(r.city ? { city: r.city } : {}), ...(tz ? { timezone: tz } : {}) };
}

/** "Leeds, United Kingdom · GBP · English": what Athena understood, in a line. Empty without a country. Pure. */
export function regionLine(r: Region | null): string {
  if (!r?.country) return "";
  const lang = r.language ? new Intl.DisplayNames(["en"], { type: "language" }).of(r.language.split("-")[0]) : null;
  return [[r.city, r.countryName].filter(Boolean).join(", "), r.currency, lang].filter(Boolean).join(" · ");
}

// ---------- choosing one (the profile's three dropdowns; owner, 16 Nov 2026) ----------

export interface RegionOption {
  /** "GB", "GBP", "en". */
  code: string;
  /** "United Kingdom", "British Pound", "English". */
  name: string;
}

let choices: { countries: RegionOption[]; currencies: RegionOption[]; languages: RegionOption[] } | null = null;

/** Every country, currency and language the profile offers, each sorted by name. Pure, built once. */
export function regionChoices(): { countries: RegionOption[]; currencies: RegionOption[]; languages: RegionOption[] } {
  if (choices) return choices;
  const byName = (a: RegionOption, b: RegionOption) => a.name.localeCompare(b.name, "en");
  const seen = new Set<string>();
  const countries: RegionOption[] = [];
  for (const cc of countryNames().values()) {
    if (seen.has(cc)) continue;
    seen.add(cc);
    countries.push({ code: cc, name: countryName(cc) });
  }
  const money = new Intl.DisplayNames(["en"], { type: "currency" });
  const currencies = [...new Set(Object.values(CURRENCY_OF))].map((code) => ({ code, name: money.of(code) ?? code }));
  const speak = new Intl.DisplayNames(["en"], { type: "language" });
  const languages = LANGUAGE_CODES.map((code) => ({ code, name: speak.of(code) ?? code }));
  return (choices = { countries: countries.sort(byName), currencies: currencies.sort(byName), languages: languages.sort(byName) });
}

/** The currency and language a country usually goes with, for filling the other two dropdowns. Null where Athena won't guess. Pure. */
export function regionDefaults(country: string): { currency: string | null; language: string | null } {
  const cc = country.toUpperCase();
  const language = languageOf(cc)?.split("-")[0] ?? null;
  return { currency: CURRENCY_OF[cc] ?? null, language: language && LANGUAGE_CODES.includes(language) ? language : null };
}

/** What the three dropdowns hold, read back from a Region answer (one typed by hand too). Pure. */
export function regionParts(value: string | null | undefined): { country: string; currency: string; language: string } {
  const r = readRegion(value);
  return { country: r.country ?? "", currency: r.currency ?? "", language: r.language?.split("-")[0] ?? "" };
}

/** The Region answer as it's stored and shown: "United Kingdom, GBP, English". Reads back with readRegion. Pure. */
export function composeRegion(p: { country?: string | null; currency?: string | null; language?: string | null }): string {
  const { languages } = regionChoices();
  return [p.country ? countryName(p.country.toUpperCase()) : "", p.currency ? p.currency.toUpperCase() : "", p.language ? (languages.find((l) => l.code === p.language)?.name ?? "") : ""]
    .filter(Boolean)
    .join(", ");
}

