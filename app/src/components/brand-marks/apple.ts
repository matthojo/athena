/**
 * Service marks for the presets in lib/presets/apple.ts, keyed by preset id. Same rules as brand-logo.ts's MARKS.
 *
 * Drawn after the iPhone apps they read: Calendar's white page with a red
 * day name over the date, Contacts' grey card with a silhouette and its
 * coloured index tabs. Fixed colours in both themes, as the app icons are.
 */
export const APPLE_MARKS: Record<string, string> = {
  // apple.com/calendar (app icon) (checked 9 Nov 2026)
  "icloud-calendar": `<svg viewBox="0 0 48 48" aria-hidden="true"><rect x="5" y="5" width="38" height="38" rx="9" fill="#fff" stroke="#d9d9de" stroke-width="1"/><path fill="#f43f3b" d="M14.6 12.4h2.1l1.5 4.3 1.5-4.3h2.1v6.4h-1.5v-4.2l-1.4 4.2h-1.4l-1.4-4.2v4.2h-1.5zM26.6 12.3c1.9 0 3.2 1.4 3.2 3.3s-1.3 3.3-3.2 3.3-3.2-1.4-3.2-3.3 1.3-3.3 3.2-3.3zm0 1.4c-1 0-1.6.8-1.6 1.9s.6 1.9 1.6 1.9 1.6-.8 1.6-1.9-.6-1.9-1.6-1.9zM31 12.4h1.5l2.6 3.9v-3.9h1.5v6.4h-1.4l-2.7-4v4H31z"/><path fill="#1d1d1f" d="M19.8 23.3h9.6v2.2l-5.5 12.3h-2.9l5.4-11.9h-6.6z"/></svg>`,
  // apple.com (Contacts app icon) (checked 9 Nov 2026)
  "icloud-contacts": `<svg viewBox="0 0 48 48" aria-hidden="true"><rect x="5" y="5" width="38" height="38" rx="9" fill="#c9c4bd"/><rect x="9" y="9" width="27" height="30" rx="3" fill="#f2efea"/><path fill="#ff9f0a" d="M36 12h3.2a1 1 0 0 1 1 1v4.6H36z"/><path fill="#34c759" d="M36 18.6h4.2v5.4H36z"/><path fill="#0a84ff" d="M36 25h4.2v5.4H36z"/><path fill="#bf5af2" d="M36 31.4h4.2V35a1 1 0 0 1-1 1H36z"/><circle cx="22.5" cy="20" r="5" fill="#9b958d"/><path fill="#9b958d" d="M13.5 35.2c.9-5.3 4.4-8.1 9-8.1s8.1 2.8 9 8.1z"/></svg>`,
};
