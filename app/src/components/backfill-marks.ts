/**
 * Marks for the file imports (backfill-import.ts) in Sources: drawn inline,
 * nothing fetched, in each service's own colour, the way brand-logo.ts draws
 * the accounts'. Simple shapes that suggest the app, not copies of its icon,
 * except TfL's roundel, which is how TfL is named everywhere.
 */
import { svg } from "../lib/dom";
import type { LogoSize } from "./brand-logo";
import type { BackfillFormat } from "./backfill-import";

/** Every file import with a mark: the backfill ones, Amazon's export (amazon-import.ts), and the Apple Music and iPlayer data downloads. */
export type FileImportFormat = BackfillFormat | "amazon" | "apple_music" | "iplayer" | "spotify_history";

const MARKS: Record<FileImportFormat, string> = {
  // A ring that closes on a tick, on Loop's deep teal.
  loop: `<svg viewBox="0 0 48 48" aria-hidden="true"><rect x="5" y="5" width="38" height="38" rx="9" fill="#24646b"/><path d="M33.2 18.6A11 11 0 1 0 35 24" fill="none" stroke="#fff" stroke-width="3.4" stroke-linecap="round"/><path d="M18.5 24.2l3.8 3.8 7.2-7.6" fill="none" stroke="#9fe3c8" stroke-width="3.4" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
  // A smile on Daylio's green.
  daylio: `<svg viewBox="0 0 48 48" aria-hidden="true"><rect x="5" y="5" width="38" height="38" rx="9" fill="#3bb08f"/><circle cx="24" cy="24" r="11.5" fill="#fff"/><circle cx="20" cy="21.5" r="1.7" fill="#2c7f68"/><circle cx="28" cy="21.5" r="1.7" fill="#2c7f68"/><path d="M19 26.6c1.4 2.3 3 3.3 5 3.3s3.6-1 5-3.3" fill="none" stroke="#2c7f68" stroke-width="2.2" stroke-linecap="round"/></svg>`,
  // A pulse through a soft heart, on Bearable's violet.
  bearable: `<svg viewBox="0 0 48 48" aria-hidden="true"><rect x="5" y="5" width="38" height="38" rx="9" fill="#6c4fd8"/><path d="M24 34.5s-10.5-6.3-10.5-13.4c0-3.4 2.6-6.1 5.8-6.1 2.1 0 3.8 1.1 4.7 2.8.9-1.7 2.6-2.8 4.7-2.8 3.2 0 5.8 2.7 5.8 6.1 0 7.1-10.5 13.4-10.5 13.4z" fill="#f2ecff"/><path d="M15.5 23.5h5l2-3.5 3 7 2-3.5h5" fill="none" stroke="#6c4fd8" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
  // Broadcast arcs on Overcast's orange.
  overcast: `<svg viewBox="0 0 48 48" aria-hidden="true"><rect x="5" y="5" width="38" height="38" rx="19" fill="#f5821f"/><circle cx="24" cy="23" r="3" fill="#fff"/><path d="M18.3 28.7a8 8 0 0 1 0-11.4M29.7 17.3a8 8 0 0 1 0 11.4M14.4 32.6a13.5 13.5 0 0 1 0-19.2M33.6 13.4a13.5 13.5 0 0 1 0 19.2" fill="none" stroke="#fff" stroke-width="2.4" stroke-linecap="round"/><path d="M24 26v9" stroke="#fff" stroke-width="2.4" stroke-linecap="round"/></svg>`,
  // The roundel.
  tfl: `<svg viewBox="0 0 48 48" aria-hidden="true"><circle cx="24" cy="24" r="14" fill="none" stroke="#dc241f" stroke-width="6.5"/><rect x="3" y="20" width="42" height="8" fill="#0019a8"/></svg>`,
  // A parcel with a warm curve under it, on a deep ink square: a box on its way, not Amazon's logo.
  amazon: `<svg viewBox="0 0 48 48" aria-hidden="true"><rect x="5" y="5" width="38" height="38" rx="9" fill="#232f3e"/><path d="M14 19.5 24 14.5l10 5v10.5l-10 5-10-5z" fill="#f3e6d0"/><path d="M14 19.5 24 24.5l10-5M24 24.5V35" fill="none" stroke="#232f3e" stroke-width="1.6" stroke-linejoin="round"/><path d="m19 17 10 5" stroke="#d9c4a1" stroke-width="2.2" stroke-linecap="round"/><path d="M15.5 38.2c5.2 2.3 11.8 2.3 17 0" fill="none" stroke="#ff9f1c" stroke-width="2.4" stroke-linecap="round"/></svg>`,
  // Sound bars rising out of a warm rose-to-coral square: listening, not Apple's note.
  apple_music: `<svg viewBox="0 0 48 48" aria-hidden="true"><defs><linearGradient id="lg-applemusic" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#ff6b8a"/><stop offset="1" stop-color="#e4304b"/></linearGradient></defs><rect x="5" y="5" width="38" height="38" rx="9" fill="url(#lg-applemusic)"/><g stroke="#fff" stroke-width="3.2" stroke-linecap="round"><path d="M15 26v4"/><path d="M20.3 20v16"/><path d="M25.6 15v18"/><path d="M30.9 21v9"/><path d="M36.2 25v4"/></g></svg>`,
  // A play button in a soft ring, pink into violet on near-black: something on iPlayer, not its logo.
  iplayer: `<svg viewBox="0 0 48 48" aria-hidden="true"><defs><linearGradient id="lg-iplayer" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#ff4c98"/><stop offset="1" stop-color="#8a4cf0"/></linearGradient></defs><rect x="5" y="5" width="38" height="38" rx="9" fill="#17131c"/><circle cx="24" cy="24" r="11.5" fill="none" stroke="url(#lg-iplayer)" stroke-width="3"/><path d="M21.3 18.8v10.4l8.6-5.2z" fill="url(#lg-iplayer)"/></svg>`,
  // A played-list with a clock hand, green on near-black: years of listening, not Spotify's logo.
  spotify_history: `<svg viewBox="0 0 48 48" aria-hidden="true"><rect x="5" y="5" width="38" height="38" rx="9" fill="#121212"/><g stroke="#1ed760" stroke-width="3" stroke-linecap="round"><path d="M13 16h14"/><path d="M13 23h10"/><path d="M13 30h8"/></g><circle cx="31.5" cy="29.5" r="7" fill="none" stroke="#1ed760" stroke-width="2.6"/><path d="M31.5 25.8v3.9l2.6 1.6" fill="none" stroke="#1ed760" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
};

export function backfillMark(format: FileImportFormat, size: LogoSize = "md"): HTMLElement {
  const el = document.createElement("span");
  el.className = `logo logo--${size} logo--file-${format}`;
  el.setAttribute("aria-hidden", "true");
  el.append(svg(MARKS[format]));
  return el;
}
