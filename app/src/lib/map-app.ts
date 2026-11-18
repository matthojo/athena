/**
 * Which maps app "Open map" opens on this device (Settings → Maps and
 * artwork). It's kept on the device, in localStorage, not on the server: a
 * phone and a computer often want different apps. Before the owner picks,
 * Apple devices open Apple Maps and everything else OpenStreetMap
 * (lib/embeds.ts defaultMapApp). Whatever is picked, nothing loads from it
 * inside a note: the map in a note is always Athena's still.
 */
import { defaultMapApp, isMapApp, mapAppUrl, mapPlatform, type MapApp, type MapPlatform } from "../../../lib/embeds";

export type { MapApp };

export const MAP_APP_KEY = "athena.mapApp";

/** Names for the choice, in the order Settings offers them. */
export const MAP_APP_LABELS: Readonly<Record<MapApp, string>> = { apple: "Apple Maps", google: "Google Maps", osm: "OpenStreetMap" };

const userAgent = () => (typeof navigator === "undefined" ? "" : navigator.userAgent);

/** This device's platform, from its user agent. */
export const devicePlatform = (ua: string = userAgent()): MapPlatform => mapPlatform(ua);

/** The picked app, or this device's default. */
export function getMapApp(ua: string = userAgent()): MapApp {
  try {
    const kept = globalThis.localStorage?.getItem(MAP_APP_KEY);
    if (isMapApp(kept)) return kept;
  } catch {
    // storage blocked: fall through to the default
  }
  return defaultMapApp(devicePlatform(ua));
}

/** Keep a choice on this device. */
export function setMapApp(app: MapApp): void {
  try {
    globalThis.localStorage?.setItem(MAP_APP_KEY, app);
  } catch {
    // private mode: the default comes back after a reload
  }
}

/** "Open map" for a spot or an address, in the app this device uses. Null with nothing to show. */
export function openMapUrl(spot: { at?: { lat: number; lng: number } | null; query?: string | null }, ua: string = userAgent()): string | null {
  return mapAppUrl(spot, getMapApp(ua), devicePlatform(ua));
}
