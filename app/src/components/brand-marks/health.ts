/**
 * Service marks for the presets in lib/presets/health.ts, keyed by preset id. Same rules as brand-logo.ts's MARKS.
 *
 * Simplified at tile size: Strava's orange disc with its two peaks, Oura's
 * black disc with the ring and the bar above it, Withings' black disc with a
 * W drawn as one stroke. Whoop's black disc with a wide, heavy, flat-topped W
 * (Whoop's mark is a wordmark; this is its first letter, unlike Withings' thin one). Polar's red disc
 * with a white lowercase p.
 */
export const HEALTH_MARKS: Record<string, string> = {
  // strava.com app icon, via simpleicons.org (checked 9 Nov 2026)
  strava: `<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="#FC4C02" d="M15.387 17.944l-2.089-4.116h-3.065L15.387 24l5.15-10.172h-3.066m-7.008-5.599l2.836 5.598h4.172L10.463 0l-7 13.828h4.169"/></svg>`,
  // ouraring.com (app icon glyph; no vector found) (checked 9 Nov 2026)
  oura: `<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="10" fill="#101114"/><path d="M9.7 6.9h4.6" stroke="#fff" stroke-width="1.5" stroke-linecap="round"/><circle cx="12" cy="13.3" r="4.3" fill="none" stroke="#fff" stroke-width="1.5"/></svg>`,
  // developer.whoop.com (WHOOP Puck Black.svg) (checked 9 Nov 2026)
  whoop: `<svg viewBox="0 0 30 30" aria-hidden="true"><rect width="30" height="30" rx="15" fill="black"/><path d="M6 9.5L8.55057 17.3372H10.1478L7.59855 9.5H6Z" fill="white"/><path d="M22.4015 9.50004L19.1006 19.6442L17.3481 14.2602H15.7509L18.3015 22.1H19.9L24 9.50004H22.4015Z" fill="white"/><path d="M10.1 22.1L14.2014 9.50004H15.7986L11.6986 22.1H10.1Z" fill="white"/></svg>`,
};
