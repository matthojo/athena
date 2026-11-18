/**
 * Ride and takeaway receipts from email: Uber and Bolt (rides), Uber Eats,
 * Deliveroo and Just Eat (food orders). docs/notes/night-c3.md.
 *
 * Pure: reads one email's text and says what it was. lib/receipts-save.ts
 * writes it (a Day entry, a purchase for a food order, and sealed rows for
 * the fare or total and a ride's addresses).
 *
 * What goes where:
 *  - A ride is an "other" Day entry, like a TfL journey: title from and to
 *    (a known Place's name, or a named spot like "Covent Garden"; never a
 *    street address), subtitle the time and minutes, group "Rides".
 *  - A food order is an "other" Day entry: "Takeaway from Dishoom", subtitle
 *    the time and the dishes in short, group "Takeaway"; and a purchase with
 *    the restaurant as retailer, the dishes as items and no prices.
 *  - The fare or total, and a ride's full pick-up and drop-off addresses,
 *    only ever go to sealed rows (sealedAmount, sealedRide).
 *
 * Dedupe: every receipt has a ref (Uber's trip or order uuid, Bolt's ride id,
 * Deliveroo's and Just Eat's order number). The entry's external_id, the
 * purchase's order number and the sealed rows' keys are all that ref, so the
 * same receipt read twice, or a takeaway's later emails, change one thing.
 */

import { addDays, zonedParts, zonedToInstant } from "./dates";
import type { EntryInput } from "./days";

export type RideService = "uber" | "bolt";
export type FoodService = "ubereats" | "deliveroo" | "justeat";
export type ReceiptService = RideService | FoodService;

/** One email as a collection run reads it. */
export interface ReceiptEmail {
  /** The thread or message id. */
  id: string;
  /** The From header: "Uber Receipts <noreply@uber.com>". */
  from: string;
  subject: string;
  /** When it was sent, ISO 8601. */
  date: string;
  /** The body, plain text or HTML. */
  text: string;
}

export interface Money {
  /** Minor units (pence). */
  minor: number;
  currency: "GBP" | "EUR" | "USD";
}

export interface Ride {
  type: "ride";
  service: RideService;
  ref: string;
  /** The day, in the owner's zone. */
  day: string;
  /** Pick-up and drop-off, ISO instants, when the receipt gives the times. */
  start?: string;
  end?: string;
  minutes?: number;
  /** The receipt's own words for pick-up and drop-off: sealed, never shown. */
  from?: string;
  to?: string;
  amount?: Money;
}

export type FoodStatus = "ordered" | "out_for_delivery" | "delivered" | "cancelled" | "refunded";

export interface FoodOrder {
  type: "food";
  service: FoodService;
  ref: string;
  day: string;
  /** When it was ordered, ISO. */
  at?: string;
  restaurant?: string;
  /** Dish names, without prices or quantities. */
  items: string[];
  status: FoodStatus;
  amount?: Money;
}

export type Receipt = Ride | FoodOrder;

/** A Place in the Library, for naming a ride's ends. */
export interface PlaceRef {
  id: string;
  name: string;
  address?: string;
}

export const SERVICE_NAME: Record<ReceiptService, string> = { uber: "Uber", bolt: "Bolt", ubereats: "Uber Eats", deliveroo: "Deliveroo", justeat: "Just Eat" };
export const RIDES_GROUP = "Rides";
export const TAKEAWAY_GROUP = "Takeaway";

// ---------- Text ----------

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", pound: "£", euro: "€", middot: "·", bull: "•", times: "×", rsquo: "'", lsquo: "'", ndash: "–", mdash: "—" };

/** An HTML body as lines of text; plain text passes through with its lines. */
export function bodyText(raw: string): string {
  let s = raw.replace(/\r\n?/g, "\n");
  if (/<(?:html|body|table|div|p|br|td)\b/i.test(s)) {
    s = s
      .replace(/<(script|style|head)\b[\s\S]*?<\/\1>/gi, " ")
      // A link keeps its address: Uber's trip and order ids are only in the href.
      .replace(/<a\b[^>]*?href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi, " $2 $1 ")
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/(?:p|div|tr|li|h[1-6]|table)>/gi, "\n")
      .replace(/<\/t[dh]>/gi, "  ")
      .replace(/<[^>]+>/g, " ");
  }
  s = s.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === "#") {
      const n = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(n) ? String.fromCodePoint(n) : m;
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
  return s
    .replace(/ /g, " ")
    .split("\n")
    .map((l) => l.replace(/[ \t]{3,}/g, "  ").trim())
    .filter(Boolean)
    .join("\n");
}

const lines = (text: string) => text.split("\n");

// ---------- Which service ----------

const SENDER: Array<[RegExp, "uber" | "bolt" | "deliveroo" | "justeat"]> = [
  [/@(?:[\w-]+\.)*uber\.com(?=>|\s*$)/i, "uber"],
  [/@(?:[\w-]+\.)*bolt\.eu(?=>|\s*$)/i, "bolt"],
  [/@(?:[\w-]+\.)*deliveroo\.(?:co\.uk|com|ie|fr|be|it|nl)(?=>|\s*$)/i, "deliveroo"],
  [/@(?:[\w-]+\.)*just-?eat\.(?:co\.uk|com|ie)(?=>|\s*$)/i, "justeat"],
];

/** The service a receipt is from, by its sender (and, for Uber, whether it's an Eats order). Null for anything else. */
export function serviceOf(email: Pick<ReceiptEmail, "from" | "subject" | "text">): ReceiptService | null {
  const by = SENDER.find(([re]) => re.test(email.from))?.[1];
  if (!by) return null;
  if (by === "uber") return /uber\s?eats/i.test(email.from) || /uber\s?eats|your .*order/i.test(email.subject) || /ubereats\.com|you ordered from/i.test(email.text) ? "ubereats" : "uber";
  if (by === "bolt" && (/bolt food/i.test(email.subject) || /bolt food/i.test(email.from))) return null;
  return by;
}

// ---------- Figures, dates and times ----------

const CURRENCY: Record<string, Money["currency"]> = { "£": "GBP", "€": "EUR", $: "USD" };
const AMOUNT = /(-)?([£€$])\s?(\d{1,5}(?:[.,]\d{3})*(?:[.,]\d{2})?)(?!\d)/;

function money(s: string): Money | undefined {
  const m = AMOUNT.exec(s);
  if (!m || m[1]) return undefined;
  // "1,234.50" and "1.234,50": the separator before the last two digits is the decimal point.
  const decimal = /[.,](\d{2})$/.exec(m[3]);
  const whole = (decimal ? m[3].slice(0, -3) : m[3]).replace(/[.,]/g, "");
  const value = Number(`${whole}.${decimal ? decimal[1] : "00"}`);
  return Number.isFinite(value) ? { minor: Math.round(value * 100), currency: CURRENCY[m[2]] } : undefined;
}

/** The total paid: the last "Total" line with an amount ("Total £14.82", "Total charged £12.40"). Never "Subtotal". */
export function totalOf(text: string): Money | undefined {
  let found: Money | undefined;
  for (const l of lines(text)) {
    if (/^(?:order\s+)?total\b(?!\s*(?:distance|time|duration))/i.test(l) || /^amount (?:paid|charged)\b/i.test(l)) found = money(l) ?? found;
  }
  return found;
}

const MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];
const MONTH_RE = "(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*";
const pad = (n: number) => String(n).padStart(2, "0");

/** The first full date the text gives ("6 November 2026", "November 6, 2026"), as YYYY-MM-DD. */
export function dateIn(text: string): string | undefined {
  const dmy = new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+${MONTH_RE}\\.?,?\\s+(\\d{4})\\b`, "i").exec(text);
  const mdy = new RegExp(`\\b${MONTH_RE}\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?,?\\s+(\\d{4})\\b`, "i").exec(text);
  const pick = dmy && (!mdy || dmy.index <= mdy.index) ? { d: dmy[1], m: dmy[2], y: dmy[3] } : mdy ? { d: mdy[2], m: mdy[1], y: mdy[3] } : null;
  if (!pick) return undefined;
  const month = MONTHS.findIndex((x) => x.startsWith(pick.m.toLowerCase().slice(0, 3))) + 1;
  const day = Number(pick.d);
  if (!month || day < 1 || day > 31) return undefined;
  return `${pick.y}-${pad(month)}-${pad(day)}`;
}

const TIME_RE = /\b(\d{1,2})[:.](\d{2})\s*([ap]\.?m\.?)?(?![\d:])/i;

/** A clock time in the text as HH:MM, 24-hour ("9:40 pm" → "21:40"). */
export function timeIn(text: string): string | undefined {
  const m = TIME_RE.exec(text);
  if (!m) return undefined;
  let h = Number(m[1]);
  const min = Number(m[2]);
  const ap = m[3]?.[0].toLowerCase();
  if (ap === "p" && h < 12) h += 12;
  if (ap === "a" && h === 12) h = 0;
  if (h > 23 || min > 59) return undefined;
  return `${pad(h)}:${pad(min)}`;
}

const localParts = (at: Date, tz: string) => zonedParts(at, tz);
const localInstant = (date: string, time: string, tz: string) => zonedToInstant(date, time, tz);
const addDay = addDays;

/**
 * The day a receipt is about, and a clock time on it as an instant. The day
 * is the date the receipt prints, else the email's own day; a time later
 * than the email was sent (a 23:50 ride receipted at 00:10) is the day before.
 */
function dayAndTime(text: string, sent: Date, tz: string, time?: string): { day: string; at?: string } {
  const sentLocal = localParts(sent, tz);
  const printed = dateIn(text);
  let day = printed ?? sentLocal.date;
  if (!printed && time && time > sentLocal.time) day = addDay(day, -1);
  return { day, ...(time ? { at: localInstant(day, time, tz).toISOString() } : {}) };
}

// ---------- Refs ----------

const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";

/** The receipt's own id: a trip or order uuid in a link, else an "Order number" or "Ride ID" line. */
export function refOf(service: ReceiptService, text: string): string | undefined {
  if (service === "uber" || service === "ubereats") {
    const link = new RegExp(`(?:trips?|orders?)/(${UUID})`, "i").exec(text) ?? new RegExp(`\\b(?:trip|order)\\s*(?:id)?[:#]?\\s*(${UUID})`, "i").exec(text);
    if (link) return link[1].toLowerCase();
  }
  const labelled = /\b(?:order\s*(?:number|no\.?|id|#)|ride\s*(?:id|number)|trip\s*(?:id|number)|booking\s*(?:id|number))\s*[:#]?\s*#?\s*([A-Z0-9][A-Z0-9-]{2,40})\b/i.exec(text);
  if (labelled) return labelled[1].toUpperCase();
  const hash = /\border\s+#\s?([A-Z0-9-]{3,40})\b/i.exec(text);
  return hash ? hash[1].toUpperCase() : undefined;
}

/** Short order numbers repeat (Deliveroo's are a few digits): those carry the day, so two orders never share an entry. */
export const entryRef = (r: Pick<Receipt, "ref" | "day">) => (r.ref.length < 8 ? `${r.day}:${r.ref}` : r.ref);

// ---------- Rides ----------

/** "21:40", "21:40 · 12 Example Road", "9:40 PM | Covent Garden": a time and, maybe, the place on the same line. */
const STOP_LINE = /^(?:(?:pick-?\s?up|drop-?\s?off|from|to|start|end)\s*[:·|-]?\s*)?(\d{1,2}[:.]\d{2}\s*(?:[ap]\.?m\.?)?)\s*(?:[·|•,-]\s*(.+))?$/i;

/** Pick-up and drop-off as the receipt lists them: each a time with the address on the same or the next line. */
export function stopsOf(text: string): Array<{ time: string; place?: string }> {
  const ls = lines(text);
  const out: Array<{ time: string; place?: string }> = [];
  for (let i = 0; i < ls.length; i++) {
    const m = STOP_LINE.exec(ls[i]);
    if (!m) continue;
    const time = timeIn(m[1]);
    if (!time) continue;
    let place = m[2]?.trim();
    const next = ls[i + 1];
    if (!place && next && !STOP_LINE.test(next) && /[a-z]{3}/i.test(next) && !AMOUNT.test(next)) place = next;
    // A time with no place is a payment or a footer line, not a stop.
    if (!place || AMOUNT.test(place)) continue;
    out.push({ time, place });
  }
  return out;
}

function minutesBetween(a: string, b: string): number {
  const [ah, am] = a.split(":").map(Number);
  const [bh, bm] = b.split(":").map(Number);
  const d = bh * 60 + bm - (ah * 60 + am);
  return d < 0 ? d + 1440 : d;
}

function parseRide(service: RideService, email: ReceiptEmail, text: string, tz: string): Ride | null {
  const ref = refOf(service, text);
  if (!ref) return null;
  const stops = stopsOf(text);
  const pick = stops[0];
  const drop = stops.length > 1 ? stops[stops.length - 1] : undefined;
  const { day, at } = dayAndTime(text, new Date(email.date), tz, pick?.time);
  const said = /(?:duration|trip time|ride time)?\s*(\d{1,3})\s*(?:min|mins|minutes)\b/i.exec(lines(text).find((l) => /\b\d{1,3}\s*min/i.test(l) && /(mile|km|duration|trip|ride|\|)/i.test(l)) ?? "");
  const minutes = said ? Number(said[1]) : pick && drop ? minutesBetween(pick.time, drop.time) : undefined;
  const ride: Ride = { type: "ride", service, ref, day };
  if (at) ride.start = at;
  if (at && drop) ride.end = new Date(Date.parse(at) + minutesBetween(pick!.time, drop.time) * 60_000).toISOString();
  if (minutes && minutes > 0 && minutes < 600) ride.minutes = minutes;
  if (pick?.place) ride.from = pick.place;
  if (drop?.place) ride.to = drop.place;
  const amount = totalOf(text);
  if (amount) ride.amount = amount;
  return ride;
}

// ---------- Food orders ----------

const NOT_ITEM = /^(?:sub-?total|total|delivery|service|small order|bag|tip|rider tip|promotion|discount|offer|credit|vat|fees?)\b/i;

/** Dish lines: "1x Pad Thai £11.95", "2 × Garlic Naan  £9.00", "1  Chicken Ruby  £13.90". Names only. */
export function itemsOf(text: string): string[] {
  const out: string[] = [];
  for (const l of lines(text)) {
    const m = /^(\d{1,2})\s*(?:[x×]\s*|\s{2,}|\s)(.+?)\s{1,}-?[£€$]\s?\d/i.exec(l);
    if (!m) continue;
    const name = m[2]
      .replace(/\s*\([^)]*\)\s*/g, " ")
      .replace(/\s{2,}/g, " ")
      .trim();
    if (!name || NOT_ITEM.test(name) || out.includes(name)) continue;
    out.push(name);
  }
  return out.slice(0, 20);
}

const RESTAURANT: RegExp[] = [
  /\byou ordered from\s+(.+?)[.!]?$/im,
  /\breceipt for\s+(.+?)[.!]?$/im,
  /^(?:restaurant|from)\s*:\s*(.+)$/im,
  /\border from\s+(.+?)(?:\s+(?:was|is|has|will)\b|[.!]|$)/im,
  /(?:^|[.!]\s+)(.+?)\s+has (?:received|accepted|got) your order\b/im,
  /(?:^|[.!]\s+)(.+?)\s+(?:has your order|is (?:preparing|making) your (?:order|food))\b/im,
];

/** The restaurant's name, from the body or the subject ("Order confirmation from Mamma Mia Pizzeria"). */
export function restaurantOf(text: string, subject: string): string | undefined {
  for (const re of RESTAURANT) {
    const m = re.exec(text);
    const name = m?.[1]?.replace(/^(?:thanks for your order,?\s+\w+[.!]\s*)/i, "").trim();
    if (name && name.length <= 80 && !/\b(?:uber|deliveroo|just eat|we|you)\b/i.test(name)) return name;
  }
  const s = /\b(?:order|food) (?:confirmation )?from\s+(.+?)(?:\s+is\b|[.!]|$)/i.exec(subject);
  return s?.[1]?.trim() || undefined;
}

/** A food order email's status, from its subject: placed, on its way, delivered. */
export function foodStatusOf(subject: string, text: string): FoodStatus {
  const s = `${subject}\n${text.slice(0, 400)}`;
  if (/\brefund/i.test(s)) return "refunded";
  if (/\bcancel+ed\b/i.test(s)) return "cancelled";
  if (/\bdelivered\b|\benjoy your (?:meal|food|order)\b|\bhas arrived\b/i.test(subject)) return "delivered";
  if (/\bon (?:its|the) way\b|\bout for delivery\b|\bheading (?:your way|to you)\b/i.test(s)) return "out_for_delivery";
  if (/\bdelivered (?:at|to)\b/i.test(text) && /\breceipt\b/i.test(s)) return "delivered";
  return "ordered";
}

const PLACED = /\b(?:order\s+placed|placed\s+at|ordered\s+at|order\s+time)\s*:?\s*([^\n]+)/i;

function parseFood(service: FoodService, email: ReceiptEmail, text: string, tz: string): FoodOrder | null {
  const ref = refOf(service, text);
  if (!ref) return null;
  const placed = PLACED.exec(text)?.[1] ?? "";
  const sent = new Date(email.date);
  const time = timeIn(placed) ?? localParts(sent, tz).time;
  const { day, at } = dayAndTime(dateIn(placed) ? placed : text, sent, tz, time);
  const order: FoodOrder = { type: "food", service, ref, day, items: itemsOf(text), status: foodStatusOf(email.subject, text) };
  if (at) order.at = at;
  const restaurant = restaurantOf(text, email.subject);
  if (restaurant) order.restaurant = restaurant;
  const amount = totalOf(text);
  if (amount) order.amount = amount;
  // A status email with nothing to go on (no dishes, no restaurant, no total) isn't worth a write.
  if (!order.items.length && !order.restaurant && !order.amount && order.status === "ordered") return null;
  return order;
}

// ---------- One email ----------

/**
 * What a receipt email was, or null: not from one of the five services, a
 * newsletter or a promotion, or a receipt without an id to dedupe by.
 */
export function parseReceipt(email: ReceiptEmail, opts: { tz: string }): Receipt | null {
  const text = bodyText(email.text);
  const service = serviceOf({ ...email, text });
  if (!service) return null;
  if (Number.isNaN(Date.parse(email.date))) return null;
  if (service === "uber" || service === "bolt") return parseRide(service, email, text, opts.tz);
  return parseFood(service, email, text, opts.tz);
}

// ---------- What the day shows ----------

const POSTCODE = /\b([A-Z]{1,2}\d[A-Z\d]?)\s*(\d[A-Z]{2})\b/i;
const STREET = /\b(?:road|rd|street|st|lane|ln|avenue|ave|close|crescent|drive|dr|grove|gardens|terrace|place|way|mews|court|square|row|walk|hill|park|rise|vale|view)\.?$/i;
const fold = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
const ABBREVIATION: Record<string, string> = { rd: "road", st: "street", ave: "avenue", av: "avenue", ln: "lane", cl: "close", cres: "crescent", dr: "drive", gdns: "gardens", gr: "grove", pl: "place", sq: "square", ter: "terrace", terr: "terrace" };
const street = (s: string) => fold(s).split(" ").map((w) => ABBREVIATION[w] ?? w).join(" ");

/** The first line of an address, without its house number: "12 Example Road, London N1 2AB" → "example road". */
function firstLine(address: string): string {
  return street(address.split(",")[0].replace(/^\s*(?:flat|apt|apartment|unit)\s+\S+\s*/i, "").replace(/^\s*\d+[a-z]?\b\s*/i, ""));
}

/** The known Place a receipt's address is: same postcode and street, or a Place named what the receipt names. */
export function placeFor(address: string | undefined, places: PlaceRef[]): PlaceRef | null {
  if (!address) return null;
  const pc = POSTCODE.exec(address);
  const head = fold(address.split(",")[0]);
  for (const p of places) {
    if (fold(p.name) === head) return p;
    if (!p.address) continue;
    const ppc = POSTCODE.exec(p.address);
    if (pc && ppc && `${pc[1]}${pc[2]}`.toUpperCase() === `${ppc[1]}${ppc[2]}`.toUpperCase() && firstLine(p.address) === firstLine(address)) return p;
  }
  return null;
}

/**
 * What a ride's end is called on the day: a known Place's name, or a named
 * spot the receipt gives ("Covent Garden", "King's Cross St. Pancras").
 * Never a street address: one with a house number or a street word is left
 * out, so a home address never shows on a day.
 */
export function endName(address: string | undefined, places: PlaceRef[]): string | null {
  if (!address) return null;
  const known = placeFor(address, places);
  if (known) return known.name;
  const head = address.split(",")[0].trim();
  if (!head || head.length > 48 || /\d/.test(head) || STREET.test(head) || POSTCODE.test(head)) return null;
  return head;
}

const clock = (iso: string | undefined, tz: string) => (iso ? localParts(new Date(iso), tz).time : null);

/** A ride as a Day entry: "Home → Covent Garden", "21:40 · 22 min". The fare and the addresses stay out. */
export function rideEntry(r: Ride, places: PlaceRef[], tz: string): EntryInput {
  const from = endName(r.from, places);
  const to = endName(r.to, places);
  const title = from && to && from !== to ? `${from} → ${to}` : to ? `Ride to ${to}` : from ? `Ride from ${from}` : "Ride";
  const sub = [clock(r.start, tz), r.minutes ? `${r.minutes} min` : null].filter(Boolean).join(" · ");
  return {
    kind: "other",
    source: r.service,
    external_id: entryRef(r),
    title,
    ...(sub ? { subtitle: sub } : {}),
    ...(r.start ? { at: r.start } : {}),
    ...(r.minutes ? { minutes: r.minutes } : {}),
    group: RIDES_GROUP,
  };
}

/** Short enough for one line at phone width: "Pad Thai and Chicken Satay", "Chicken Ruby and 2 more". */
export function dishes(items: string[], max = 2): string {
  if (!items.length) return "";
  if (items.length <= max) return items.length === 1 ? items[0] : `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
  return `${items.slice(0, max - 1).join(", ")} and ${items.length - (max - 1)} more`;
}

/** A food order as a Day entry: "Takeaway from Dishoom", "19:21 · Chicken Ruby and 2 more". No total. */
export function foodEntry(o: FoodOrder, tz: string): EntryInput | null {
  if (!o.restaurant) return null;
  const sub = [clock(o.at, tz), dishes(o.items)].filter(Boolean).join(" · ");
  return {
    kind: "other",
    source: o.service,
    external_id: entryRef(o),
    title: `Takeaway from ${o.restaurant}`,
    ...(sub ? { subtitle: sub } : {}),
    ...(o.at ? { at: o.at } : {}),
    group: TAKEAWAY_GROUP,
  };
}

/** A food order as a purchase (lib/trips.ts PurchaseInput): the restaurant, the dishes, the app; never the total. */
export function foodPurchase(o: FoodOrder, email: Pick<ReceiptEmail, "date">): {
  retailer: string;
  order_number: string;
  items: string[];
  ordered_on: string;
  status: FoodStatus;
  status_at: string;
  detail: string;
} {
  return {
    retailer: o.restaurant ?? SERVICE_NAME[o.service],
    order_number: entryRef(o),
    items: o.items,
    ordered_on: o.day,
    status: o.status,
    status_at: new Date(email.date).toISOString(),
    detail: `Through ${SERVICE_NAME[o.service]}`,
  };
}

/** What's sealed for a receipt's money: the amount, keyed by its ref. Never anywhere else. */
export function sealedAmount(r: Receipt): { day: string; key: string; value: { service: ReceiptService; type: Receipt["type"]; minor: number; currency: Money["currency"] } } | null {
  if (!r.amount) return null;
  return { day: r.day, key: `${r.service}:${entryRef(r)}`, value: { service: r.service, type: r.type, minor: r.amount.minor, currency: r.amount.currency } };
}

/** What's sealed for a ride's ends: the receipt's addresses and the Places they are, keyed by its ref. */
export function sealedRide(r: Ride, places: PlaceRef[]): { day: string; key: string; value: { service: RideService; from?: string; to?: string; from_place?: string; to_place?: string; start?: string; end?: string } } | null {
  if (!r.from && !r.to) return null;
  const fromPlace = placeFor(r.from, places);
  const toPlace = placeFor(r.to, places);
  return {
    day: r.day,
    key: `${r.service}:${entryRef(r)}`,
    value: {
      service: r.service,
      ...(r.from ? { from: r.from } : {}),
      ...(r.to ? { to: r.to } : {}),
      ...(fromPlace ? { from_place: fromPlace.id } : {}),
      ...(toPlace ? { to_place: toPlace.id } : {}),
      ...(r.start ? { start: r.start } : {}),
      ...(r.end ? { end: r.end } : {}),
    },
  };
}
