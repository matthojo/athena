/**
 * Tracking links for a parcel: the carrier's own page, built from the
 * carrier and the tracking number when the email (or the owner) gave no
 * link. Pure, shared by the server and the PWA. Athena only builds the link;
 * it never fetches anything from a carrier.
 *
 * Checked 6 Nov 2026 by opening each with a sample number: Evri, DPD, UPS,
 * Amazon, InPost (Yodel's links now land there) and FedEx. Royal Mail,
 * Parcelforce and DHL refuse automated visits, so theirs follow their
 * published link formats.
 */

export interface Carrier {
  id: string;
  /** How the owner sees it: "Royal Mail". */
  name: string;
  /** Names it goes by in emails and forms, matched loosely. */
  aliases: RegExp;
  /** A tracking number only this carrier uses, for guessing the carrier when none is given. */
  shape?: RegExp;
  link: (number: string) => string;
}

const enc = encodeURIComponent;

export const CARRIERS: readonly Carrier[] = [
  {
    id: "royal-mail",
    name: "Royal Mail",
    aliases: /^royal ?mail|^rm ?(tracked|signed)/,
    shape: /^[A-Z]{2}\d{9}GB$/,
    link: (n) => `https://www.royalmail.com/track-your-item#/tracking-results/${enc(n)}`,
  },
  {
    id: "parcelforce",
    name: "Parcelforce",
    aliases: /^parcel ?force/,
    link: (n) => `https://www.parcelforce.com/track-trace?trackNumber=${enc(n)}`,
  },
  {
    id: "evri",
    name: "Evri",
    aliases: /^evri|^hermes/,
    shape: /^H[0-9A-Z]{15}$/,
    link: (n) => `https://www.evri.com/track/parcel/${enc(n)}`,
  },
  {
    id: "dpd",
    name: "DPD",
    aliases: /^dpd/,
    shape: /^\d{14}$/,
    link: (n) => `https://track.dpd.co.uk/parcels/${enc(n)}`,
  },
  {
    id: "dhl",
    name: "DHL",
    aliases: /^dhl/,
    shape: /^JJD\d{10,20}$/,
    link: (n) => `https://www.dhl.com/gb-en/home/tracking.html?tracking-id=${enc(n)}&submit=1`,
  },
  {
    id: "ups",
    name: "UPS",
    aliases: /^ups\b|^united parcel/,
    shape: /^1Z[0-9A-Z]{16}$/,
    link: (n) => `https://www.ups.com/track?tracknum=${enc(n)}`,
  },
  {
    id: "amazon",
    name: "Amazon",
    aliases: /^amazon/,
    shape: /^TB[ACM]\d{9,15}$/,
    link: (n) => `https://track.amazon.co.uk/tracking/${enc(n)}`,
  },
  {
    id: "inpost",
    name: "InPost",
    aliases: /^inpost|^yodel/,
    link: (n) => `https://inpost.co.uk/tracking/result?parcel_code=${enc(n)}`,
  },
  {
    id: "fedex",
    name: "FedEx",
    aliases: /^fed ?ex/,
    link: (n) => `https://www.fedex.com/fedextrack/?trknbr=${enc(n)}`,
  },
];

/** "AB 1234 5678 9GB" and "ab123456789gb" are the same number. */
export const cleanTrackingNumber = (raw: string): string => raw.toUpperCase().replace(/[^A-Z0-9]/g, "");

/** The carrier a name means: "Royal Mail Tracked 24", "DPD Local", "Hermes", "Amazon Logistics". */
export function carrierNamed(name: string): Carrier | null {
  const key = name.trim().toLowerCase().replace(/[^a-z0-9 ]/g, "").replace(/\s+/g, " ");
  if (!key) return null;
  return CARRIERS.find((c) => c.aliases.test(key)) ?? null;
}

/** The carrier a tracking number can only belong to, or null when it could be several. */
export function carrierFromNumber(number: string): Carrier | null {
  const n = cleanTrackingNumber(number);
  if (!n) return null;
  return CARRIERS.find((c) => c.shape?.test(n)) ?? null;
}

/** An http(s) web address, or null. */
function webLink(raw: string): string | null {
  const s = raw.trim();
  if (!s) return null;
  try {
    const u = new URL(/^https?:\/\//i.test(s) ? s : `https://${s}`);
    return (u.protocol === "https:" || u.protocol === "http:") && u.hostname.includes(".") ? u.toString() : null;
  } catch {
    return null;
  }
}

export interface TrackingLink {
  url: string;
  /** The carrier's name for the button ("Track with Royal Mail"), or "" when the link is the email's own and the carrier isn't known. */
  carrier: string;
  /** Built here from the carrier and number, rather than given. */
  built: boolean;
}

/**
 * Where Track goes: the link the email (or the owner) gave, else one built
 * from the carrier and tracking number, else one built from a number only one
 * carrier uses. null when there's nothing to open.
 */
export function trackingLink(p: { carrier?: string; tracking_number?: string; tracking_url?: string }): TrackingLink | null {
  const named = carrierNamed(p.carrier ?? "");
  const given = webLink(p.tracking_url ?? "");
  if (given) return { url: given, carrier: named?.name ?? (p.carrier ?? "").trim(), built: false };
  const number = cleanTrackingNumber(p.tracking_number ?? "");
  if (!number) return null;
  const carrier = named ?? ((p.carrier ?? "").trim() ? null : carrierFromNumber(number));
  return carrier ? { url: carrier.link(number), carrier: carrier.name, built: true } : null;
}
