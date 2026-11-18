/**
 * Service marks for the presets in lib/presets/api.ts, keyed by preset id.
 * Inline SVG strings, merged into brand-logo.ts's MARKS. Same rules as
 * there: drawn inline, nothing fetched; the service's own colours where they
 * are fixed, currentColor where the mark is monochrome.
 *
 * Trakt: the red disc with its ring and tick. YouTube: the red play button.
 * Letterboxd: the three dots. Goodreads: the brown "g".
 */
export const API_MARKS: Record<string, string> = {
  // app.trakt.tv/branding (checked 9 Nov 2026)
  trakt: `<svg viewBox="0 0 48 48" aria-hidden="true"><rect width="48" height="48" rx="10.8" fill="#6438D0"/><g transform="translate(9.6 9.6) scale(.47213)" fill="none" stroke="#fff" stroke-width="6" stroke-linecap="round" stroke-linejoin="round"><path d="M56 38.95A27.5 27.5 0 1 1 36.19 3.2"/><path d="M16.93 27.11l18.89 15.85M29.92 34.75 53.89 6.17M56.69 18.31 42.49 35.24M26.88 22.41l-3.52-2.96"/></g></svg>`,
  // youtube.com/howyoutubeworks/resources/brand-resources (checked 9 Nov 2026)
  youtube: `<svg viewBox="0 0 48 48" aria-hidden="true"><rect x="4" y="11" width="40" height="27" rx="8.5" fill="#ff0000"/><path d="M20 18.2v12.6l11-6.3z" fill="#fff"/></svg>`,
  // letterboxd.com/about/brand (checked 9 Nov 2026)
  letterboxd: `<svg viewBox="0 0 48 48" aria-hidden="true"><circle cx="9.6" cy="24" r="8.6" fill="#ff8000"/><circle cx="38.4" cy="24" r="8.6" fill="#40bcf4"/><circle cx="24" cy="24" r="8.6" fill="#00e054"/><path d="M16.8 19.3a8.6 8.6 0 0 1 0 9.4 8.6 8.6 0 0 1 0-9.4zM31.2 19.3a8.6 8.6 0 0 1 0 9.4 8.6 8.6 0 0 1 0-9.4z" fill="#fff" opacity=".4"/></svg>`,
  // goodreads.com/about/press (checked 9 Nov 2026)
  goodreads: `<svg viewBox="0 0 48 48" aria-hidden="true"><rect x="5" y="5" width="38" height="38" rx="9" fill="#f4f1ea"/><circle cx="23" cy="21" r="7" fill="none" stroke="#382110" stroke-width="3.4"/><path d="M30 13.5v15.2c0 5.4-3.2 8.3-7.6 8.3-3.4 0-6-1.7-6.9-4.6" fill="none" stroke="#382110" stroke-width="3.4" stroke-linecap="round"/></svg>`,
};
