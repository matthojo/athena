/**
 * Marks for lib/presets/live-travel.ts, merged into brand-logo.ts.
 *  - Google Maps: Google's 2020 pin, its own paths and colours.
 *  - TfL: the corporate roundel (TfL colour standard, blue #000F9F) on a
 *    white plate, so it reads on a dark tile too.
 *  - National Rail: the double arrow, drawn at tile size in the theme's ink.
 */
export const LIVE_TRAVEL_MARKS: Record<string, string> = {
  // Google Maps 2020 pin, Google's own paths and colours (checked 10 Nov 2026)
  "google-routes": `<svg viewBox="-28.85 -8.85 150 150" aria-hidden="true"><path fill="#1a73e8" d="M60.2 2.2C55.8.8 51 0 46.1 0 32 0 19.3 6.4 10.8 16.5l21.8 18.3L60.2 2.2z"/><path fill="#ea4335" d="M10.8 16.5C4.1 24.5 0 34.9 0 46.1c0 8.7 1.7 15.7 4.6 22l28-33.3-21.8-18.3z"/><path fill="#4285f4" d="M46.2 28.5c9.8 0 17.7 7.9 17.7 17.7 0 4.3-1.6 8.3-4.2 11.4 0 0 13.9-16.6 27.5-32.7-5.6-10.8-15.3-19-27-22.7L32.6 34.8c3.3-3.8 8.1-6.3 13.6-6.3"/><path fill="#fbbc04" d="M46.2 63.8c-9.8 0-17.7-7.9-17.7-17.7 0-4.3 1.5-8.3 4.1-11.3l-28 33.3c4.8 10.6 12.8 19.2 21 29.9l34.1-40.5c-3.3 3.9-8.1 6.3-13.5 6.3"/><path fill="#34a853" d="M59.1 109.2c15.4-24.1 33.3-35 33.3-63 0-7.7-1.9-14.9-5.2-21.3L25.6 98c2.6 3.4 5.3 7.3 7.9 11.3 9.4 14.5 6.8 23.1 12.8 23.1s3.4-8.7 12.8-23.2"/></svg>`,
  // TfL corporate roundel, TfL colour standard blue #000F9F, on a white plate (checked 10 Nov 2026)
  tfl: `<svg viewBox="0 0 24 24" aria-hidden="true"><rect width="24" height="24" rx="5" fill="#fff"/><g transform="translate(2.4 4.2) scale(.0312)"><path fill="#000f9f" d="M469.453 249.986c0 89.078-72.26 161.308-161.337 161.308-89.1 0-161.294-72.23-161.294-161.308 0-89.063 72.194-161.286 161.294-161.286 89.078-.001 161.337 72.222 161.337 161.286M308.116 0C170.027 0 58.094 111.925 58.094 249.986 58.094 388.06 170.027 500 308.116 500c138.06 0 249.985-111.94 249.985-250.014C558.101 111.925 446.176 0 308.116 0"/><rect y="199.516" fill="#000f9f" width="615.322" height="101.129"/></g></svg>`,
  // National Rail double arrow, drawn at tile size in theme ink; official file not reachable, to check (checked 10 Nov 2026)
  "national-rail": `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M2.5 9.5h17l-5.5-5.5M21.5 14.5h-17l5.5 5.5M9.5 9.5l5 5" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linejoin="miter" stroke-miterlimit="4"/></svg>`,
};
