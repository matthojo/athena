/**
 * Service marks for the presets in lib/presets/api-b.ts, keyed by preset id.
 * Inline SVG strings, merged into brand-logo.ts's MARKS. Same rules as
 * there: drawn inline, nothing fetched; the service's own colours where they
 * are fixed, currentColor where the mark is monochrome.
 *
 * Simplified at tile size: Reddit's orange disc with the alien's head,
 * Spotify's green disc with three sound waves, Last.fm's red disc with its
 * "as" wordmark drawn as paths, Steam's navy-to-blue disc with the valve mark.
 */
export const API_B_MARKS: Record<string, string> = {
  // redditinc.com/brand (checked 9 Nov 2026)
  reddit: `<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="10" fill="#ff4500"/><circle cx="16.9" cy="6.2" r="1.35" fill="#fff"/><path d="M12.2 8.3l.95-3.55 3.75.95" fill="none" stroke="#fff" stroke-width="1" stroke-linecap="round" stroke-linejoin="round"/><circle cx="6.9" cy="11.4" r="1.55" fill="#fff"/><circle cx="17.1" cy="11.4" r="1.55" fill="#fff"/><ellipse cx="12" cy="13.6" rx="6.1" ry="4.3" fill="#fff"/><circle cx="9.6" cy="13" r="1.05" fill="#ff4500"/><circle cx="14.4" cy="13" r="1.05" fill="#ff4500"/><path d="M9.7 15.6c1.35.95 3.25.95 4.6 0" fill="none" stroke="#ff4500" stroke-width=".9" stroke-linecap="round"/></svg>`,
  // developer.spotify.com/documentation/design (checked 9 Nov 2026)
  spotify: `<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="10" fill="#1ed760"/><path d="M6.6 9.3c3.7-1.1 8-.8 11.1 1M7.2 12.4c3-.85 6.5-.55 9.1.95M7.8 15.3c2.4-.6 5-.4 7 .75" fill="none" stroke="#000" stroke-linecap="round" stroke-width="1.55"/></svg>`,
  // commons.wikimedia.org/wiki/File:Lastfm_logo.svg (via simpleicons.org) (checked 9 Nov 2026)
  lastfm: `<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="10" fill="#d51007"/><path d="M11.1 14.7l-.5-1.35s-.8.9-2 .9c-1.06 0-1.81-.92-1.81-2.4 0-1.89.95-2.57 1.9-2.57 1.36 0 1.8.88 2.17 2.01l.5 1.54c.5 1.5 1.42 2.7 4.07 2.7 1.9 0 3.18-.58 3.18-2.12 0-1.25-.71-1.9-2.04-2.21l-.98-.21c-.68-.16-.88-.43-.88-.9 0-.52.42-.84 1.1-.84.75 0 1.15.28 1.21.95l1.53-.18c-.12-1.38-1.07-1.95-2.64-1.95-1.38 0-2.73.52-2.73 2.2 0 1.04.5 1.7 1.77 2l1.04.25c.78.18 1.04.5 1.04.94 0 .57-.55.8-1.6.8-1.55 0-2.2-.82-2.57-1.94l-.51-1.54c-.65-2-1.69-2.74-3.75-2.74-2.28 0-3.49 1.44-3.49 3.89 0 2.35 1.21 3.62 3.37 3.62 1.75 0 2.59-.82 2.59-.82z" fill="#fff"/></svg>`,
  // partner.steamgames.com/doc/marketing/branding, via simpleicons.org (checked 9 Nov 2026)
  steam: `<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M11.979 0C5.678 0 .511 4.86.022 11.037l6.432 2.658c.545-.371 1.203-.59 1.912-.59.063 0 .125.004.188.006l2.861-4.142V8.91c0-2.495 2.028-4.524 4.524-4.524 2.494 0 4.524 2.031 4.524 4.527s-2.03 4.525-4.524 4.525h-.105l-4.076 2.911c0 .052.004.105.004.159 0 1.875-1.515 3.396-3.39 3.396-1.635 0-3.016-1.173-3.331-2.727L.436 15.27C1.862 20.307 6.486 24 11.979 24c6.627 0 11.999-5.373 11.999-12S18.605 0 11.979 0zM7.54 18.21l-1.473-.61c.262.543.714.999 1.314 1.25 1.297.539 2.793-.076 3.332-1.375.263-.63.264-1.319.005-1.949s-.75-1.121-1.377-1.383c-.624-.26-1.29-.249-1.878-.03l1.523.63c.956.4 1.409 1.5 1.009 2.455-.397.957-1.497 1.41-2.454 1.012H7.54zm11.415-9.303c0-1.662-1.353-3.015-3.015-3.015-1.665 0-3.015 1.353-3.015 3.015 0 1.665 1.35 3.015 3.015 3.015 1.663 0 3.015-1.35 3.015-3.015zm-5.273-.005c0-1.252 1.013-2.266 2.265-2.266 1.249 0 2.266 1.014 2.266 2.266 0 1.251-1.017 2.265-2.266 2.265-1.253 0-2.265-1.014-2.265-2.265z"/></svg>`,
};
