/**
 * Icons Days needs that the shared set doesn't have, drawn the same way as
 * components/icons.ts (24px grid, 1.7px stroke, round caps).
 */

import { svg } from "../lib/dom";

const base = (inner: string) =>
  svg(`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${inner}</svg>`);

export const dayIcons = {
  /** Days in the nav: a page with the sun rising on it. */
  days: () => base(`<rect x="4" y="4.5" width="16" height="15" rx="3"/><path d="M8 15.5a4 4 0 0 1 8 0M12 9.5v1M7.6 11.3l.7.7M16.4 11.3l-.7.7M4 15.5h16"/>`),
  steps: () => base(`<path d="M8.5 13.5c-1.9 0-2.8-1.7-2.8-4S6.6 4.5 8.4 4.5s2.4 2.3 2.2 4.6c-.2 2.6-.4 4.4-2.1 4.4zM7 16.5l3 .4-.4 2.2a1.5 1.5 0 0 1-3-.4zM15.5 17.5c1.9 0 2.8-1.7 2.8-4s-.9-4.9-2.7-4.9-2.4 2.3-2.2 4.6c.2 2.6.4 4.3 2.1 4.3zM17 20.5l-3 .4"/>`),
  sun: () => base(`<circle cx="12" cy="12" r="3.8"/><path d="M12 3.5v1.6M12 18.9v1.6M3.5 12h1.6M18.9 12h1.6M6 6l1.1 1.1M16.9 16.9 18 18M6 18l1.1-1.1M16.9 7.1 18 6"/>`),
  cloud: () => base(`<path d="M7.5 18.5h9.2a3.8 3.8 0 0 0 .4-7.6 5.2 5.2 0 0 0-10-.9A4.3 4.3 0 0 0 7.5 18.5z"/>`),
  rain: () => base(`<path d="M7.5 15h9.2a3.8 3.8 0 0 0 .4-7.6 5.2 5.2 0 0 0-10-.9A4.3 4.3 0 0 0 7.5 15zM9 18l-.8 2M13 18l-.8 2M17 18l-.8 2"/>`),
  snow: () => base(`<path d="M7.5 15h9.2a3.8 3.8 0 0 0 .4-7.6 5.2 5.2 0 0 0-10-.9A4.3 4.3 0 0 0 7.5 15z"/><circle cx="9" cy="19" r=".6" fill="currentColor"/><circle cx="13" cy="20" r=".6" fill="currentColor"/><circle cx="16" cy="18.5" r=".6" fill="currentColor"/>`),
  partSun: () => base(`<path d="M9.5 4v1.2M4.4 9.5H3.2M5.6 5.6l.8.8M13.6 5.6l-.8.8"/><path d="M6.6 11.3a3.3 3.3 0 0 1 6-2.7"/><path d="M9 19.5h8a3.3 3.3 0 0 0 .3-6.6 4.5 4.5 0 0 0-8.6-.8A3.7 3.7 0 0 0 9 19.5z"/>`),
  camera: () => base(`<path d="M4 8.5A1.5 1.5 0 0 1 5.5 7h2l1.4-2h6.2l1.4 2h2A1.5 1.5 0 0 1 20 8.5v9a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 4 17.5z"/><circle cx="12" cy="12.8" r="3.3"/>`),
  quote: () => base(`<path d="M9.5 8.5H6.8A1.8 1.8 0 0 0 5 10.3v2.4h4.5v4.8H5M19 8.5h-2.7a1.8 1.8 0 0 0-1.8 1.8v2.4H19v4.8h-4.5"/>`),
  chess: () => base(`<path d="M9 20.5h6M8 18h8M10 18l-.5-5h5L14 18M9.5 13 8 9.5h8L14.5 13M10 9.5V7h4v2.5M12 7V4.5M10.8 5.5h2.4"/>`),
  calendarGrid: () => base(`<rect x="4" y="5" width="16" height="15" rx="3"/><path d="M4 9.5h16M8 3.5v3M16 3.5v3M8 13h.01M12 13h.01M16 13h.01M8 16.5h.01M12 16.5h.01"/>`),
  feed: () => base(`<rect x="4.5" y="4" width="15" height="6.5" rx="2"/><rect x="4.5" y="13.5" width="15" height="6.5" rx="2"/>`),
  chevronLeft: () => base(`<path d="M14.5 5.5 8 12l6.5 6.5"/>`),
  chevronRight: () => base(`<path d="M9.5 5.5 16 12l-6.5 6.5"/>`),
  mosaic: () => base(`<rect x="4" y="4" width="7" height="9" rx="1.5"/><rect x="13" y="4" width="7" height="5" rx="1.5"/><rect x="13" y="11" width="7" height="9" rx="1.5"/><rect x="4" y="15" width="7" height="5" rx="1.5"/>`),
};

/** A weather icon from the day's weather in words ("14° and rain in London"). */
export function weatherIcon(text: string): SVGSVGElement {
  const t = text.toLowerCase();
  if (/snow|sleet/.test(t)) return dayIcons.snow();
  if (/rain|drizzle|shower|storm|thunder/.test(t)) return dayIcons.rain();
  if (/spells|partly|some sun|sun and cloud/.test(t)) return dayIcons.partSun();
  if (/sun|clear/.test(t)) return dayIcons.sun();
  if (/cloud|overcast|fog|mist|grey/.test(t)) return dayIcons.cloud();
  return dayIcons.partSun();
}
