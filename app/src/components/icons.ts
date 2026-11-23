/**
 * Line icons on a 24px grid, 1.7px stroke, round caps — drawn to sit beside
 * Geist at 14–16px. `homeSolid` / `notesSolid` are the active-tab variants;
 * their inner strokes use `.icon-cutout` so they knock out to the surface.
 */

import { svg } from "../lib/dom";

const base = (inner: string, extra = "") =>
  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" ${extra}>${inner}</svg>`;

const HOME_PATH = "M4 10.6 12 4l8 6.6V19a1.5 1.5 0 0 1-1.5 1.5H15v-5a1 1 0 0 0-1-1h-4a1 1 0 0 0-1 1v5H5.5A1.5 1.5 0 0 1 4 19z";
const NOTES_LINES = "M9 8.5h6M9 12h6M9 15.5h3.5";

export const icons = {
  home: () => svg(base(`<path d="${HOME_PATH}"/>`, 'class="icon-line"')),
  homeSolid: () => svg(base(`<path d="${HOME_PATH}" fill="currentColor"/>`, 'class="icon-solid"')),
  notes: () => svg(base(`<rect x="5" y="3.5" width="14" height="17" rx="3"/><path d="${NOTES_LINES}"/>`, 'class="icon-line"')),
  notesSolid: () =>
    svg(
      base(
        `<rect x="5" y="3.5" width="14" height="17" rx="3" fill="currentColor"/><path class="icon-cutout" d="${NOTES_LINES}"/>`,
        'class="icon-solid"'
      )
    ),
  plus: () => svg(base(`<path d="M12 5v14M5 12h14"/>`)),
  search: () => svg(base(`<circle cx="11" cy="11" r="6.5"/><path d="m20 20-4.2-4.2"/>`)),
  close: () => svg(base(`<path d="M6.5 6.5l11 11M17.5 6.5l-11 11"/>`)),
  back: () => svg(base(`<path d="M14.5 5.5 8 12l6.5 6.5"/>`)),
  chevronDown: () => svg(base(`<path d="M6 9.5l6 6 6-6"/>`)),
  more: () =>
    svg(base(`<circle cx="6" cy="12" r="1.3" fill="currentColor" stroke="none"/><circle cx="12" cy="12" r="1.3" fill="currentColor" stroke="none"/><circle cx="18" cy="12" r="1.3" fill="currentColor" stroke="none"/>`)),
  archive: () => svg(base(`<rect x="3.5" y="4.5" width="17" height="4.5" rx="1.5"/><path d="M5 9v9a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V9M10 13h4"/>`)),
  trash: () => svg(base(`<path d="M4.5 7h15M9.5 7V5a1 1 0 0 1 1-1h3a1 1 0 0 1 1 1v2M6.5 7l.8 11.6a1.5 1.5 0 0 0 1.5 1.4h6.4a1.5 1.5 0 0 0 1.5-1.4L17.5 7M10 11v5M14 11v5"/>`)),
  link: () => svg(base(`<path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1"/><path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1"/>`)),
  at: () => svg(base(`<circle cx="12" cy="12" r="3.5"/><path d="M15.5 8.5v4.8a2.2 2.2 0 0 0 4.4 0V12a7.9 7.9 0 1 0-3.1 6.3"/>`)),
  text: () => svg(base(`<path d="M5 6.5V5h14v1.5M12 5v14M9.5 19h5"/>`)),
  heading: () => svg(base(`<path d="M6 5v14M18 5v14M6 12h12"/>`)),
  listBullet: () =>
    svg(base(`<path d="M10 7h10M10 12h10M10 17h10"/><circle cx="5" cy="7" r="1" fill="currentColor" stroke="none"/><circle cx="5" cy="12" r="1" fill="currentColor" stroke="none"/><circle cx="5" cy="17" r="1" fill="currentColor" stroke="none"/>`)),
  listNumber: () => svg(base(`<path d="M10 7h10M10 12h10M10 17h10M4.5 5.5 6 5v4M4.5 14.5a1.2 1.2 0 1 1 1.9 1L4.5 18H7"/>`)),
  checklist: () => svg(base(`<rect x="3.5" y="4.5" width="5" height="5" rx="1.2"/><path d="m4.8 15.8 1.4 1.4 2.6-2.8M11.5 7h9M11.5 16h9"/>`)),
  /** Team: a cat's face, the line style of the set (ears, eyes, a small nose and mouth). */
  team: () =>
    svg(
      base(
        `<path d="M5.2 10.2 5 4.5l4.4 3a8.3 8.3 0 0 1 5.2 0l4.4-3-.2 5.7c.8 1.1 1.2 2.4 1.2 3.8 0 3.9-3.6 6.5-8 6.5s-8-2.6-8-6.5c0-1.4.4-2.7 1.2-3.8z"/><circle cx="9.3" cy="13" r="1" fill="currentColor" stroke="none"/><circle cx="14.7" cy="13" r="1" fill="currentColor" stroke="none"/><path d="M11.2 15.4h1.6L12 16.3zM12 16.3v.6c-.4.6-1 .8-1.6.6M12 16.9c.4.6 1 .8 1.6.6"/>`
      )
    ),
  person: () => svg(base(`<circle cx="12" cy="8.5" r="3.5"/><path d="M5 19.5c.8-3.4 3.4-5 7-5s6.2 1.6 7 5"/>`)),
  pin: () => svg(base(`<path d="M12 20.5s6.5-5.6 6.5-10.8a6.5 6.5 0 0 0-13 0c0 5.2 6.5 10.8 6.5 10.8z"/><circle cx="12" cy="9.7" r="2.3"/>`)),
  building: () => svg(base(`<path d="M4.5 20V6a1.5 1.5 0 0 1 1.5-1.5h7A1.5 1.5 0 0 1 14.5 6v14M14.5 10H18a1.5 1.5 0 0 1 1.5 1.5V20M3 20h18M8 8.5h3M8 12h3M8 15.5h3"/>`)),
  bell: () => svg(base(`<path d="M6 16.5V11a6 6 0 0 1 12 0v5.5l1.5 2h-15z"/><path d="M10 20.5a2.2 2.2 0 0 0 4 0"/>`)),
  gift: () => svg(base(`<rect x="4" y="9" width="16" height="11" rx="2"/><path d="M3.5 9h17M12 9v11M12 9c-1.5-3.5-5-4-5-1.8C7 9 12 9 12 9zM12 9c1.5-3.5 5-4 5-1.8C17 9 12 9 12 9z"/>`)),
  phone: () => svg(base(`<path d="M6.5 4h3l1.5 4-2 1.5a10 10 0 0 0 5.5 5.5l1.5-2 4 1.5v3a2 2 0 0 1-2 2A15.5 15.5 0 0 1 4.5 6a2 2 0 0 1 2-2z"/>`)),
  library: () => svg(base(`<path d="M5 4.5v15M9.5 4.5v15"/><path d="m13.5 5.2 4.2-1 3 14.6-4.2 1z"/>`)),
  restore: () => svg(base(`<path d="M4.5 12a7.5 7.5 0 1 0 2.2-5.3"/><path d="M4.5 4.5v4.2h4.2"/>`)),
  chevronRight: () => svg(base(`<path d="M9.5 5.5 16 12l-6.5 6.5"/>`)),
  arrowUp: () => svg(base(`<path d="M12 19V5M6 11l6-6 6 6"/>`)),
  arrowDown: () => svg(base(`<path d="M12 5v14M18 13l-6 6-6-6"/>`)),
  note: () => svg(base(`<path d="M6 3.5h8.5L19 8v11.5a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1v-15a1 1 0 0 1 1-1z"/><path d="M14 3.5V8h5M8.5 12.5h7M8.5 16h5"/>`)),
  capture: () => svg(base(`<path d="M13 3.5 5.5 13.5H11l-1 7 7.5-10H12z"/>`)),
  clock: () => svg(base(`<circle cx="12" cy="12" r="8"/><path d="M12 7.5V12l3 2"/>`)),
  project: () => svg(base(`<rect x="4" y="4" width="16" height="16" rx="3.5"/><path d="M9.5 4v16M15 4v8"/>`)),
  pen: () => svg(base(`<path d="M4.5 19.5l1-4.2L15.6 5.2a2 2 0 0 1 2.8 0l.4.4a2 2 0 0 1 0 2.8L8.7 18.5z"/><path d="M13.5 7.3l3.2 3.2"/>`)),
  calendar: () => svg(base(`<rect x="4" y="5.5" width="16" height="14.5" rx="3"/><path d="M4 10h16M8.5 3.5v4M15.5 3.5v4"/>`)),
  briefcase: () =>
    svg(base(`<rect x="3.5" y="7" width="17" height="12.5" rx="3"/><path d="M8.5 7V5.5A1.5 1.5 0 0 1 10 4h4a1.5 1.5 0 0 1 1.5 1.5V7M3.5 12.5h17"/>`)),
  // Work (#/work): a merge, two branches meeting.
  work: () => svg(base(`<circle cx="7" cy="5.5" r="2"/><circle cx="7" cy="18.5" r="2"/><circle cx="17" cy="9.5" r="2"/><path d="M7 7.5v9M17 11.5c0 3-4 3.5-8.6 5.6"/>`)),
  mail: () => svg(base(`<rect x="3.5" y="5.5" width="17" height="13" rx="3"/><path d="m4.5 7.5 7.5 5.5 7.5-5.5"/>`)),
  wallet: () =>
    svg(base(`<path d="M4 8.5A2.5 2.5 0 0 1 6.5 6H17v2.5"/><rect x="4" y="8.5" width="16" height="11" rx="3"/><circle cx="16" cy="14" r="1.1" fill="currentColor" stroke="none"/>`)),
  folder: () => svg(base(`<path d="M3.5 7.5a2 2 0 0 1 2-2h4l2 2.5h7a2 2 0 0 1 2 2v7.5a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2z"/>`)),
  people: () =>
    svg(base(`<circle cx="9" cy="8.5" r="3"/><path d="M3.5 19c.6-3 2.6-4.5 5.5-4.5s4.9 1.5 5.5 4.5"/><circle cx="17" cy="8" r="2.3"/><path d="M15.5 14.3c2.2.2 3.6 1.6 4 4"/>`)),
  inbox: () =>
    svg(base(`<path d="M3.5 12.5h5l1.6 2.6h3.8l1.6-2.6h5"/><path d="M5.2 6.3 3.5 12.5V18a2 2 0 0 0 2 2h13a2 2 0 0 0 2-2v-5.5l-1.7-6.2A2 2 0 0 0 16.9 5H7.1a2 2 0 0 0-1.9 1.3z"/>`)),
  cloud: () => svg(base(`<path d="M7.5 18.5a4 4 0 0 1-.6-7.95A5.5 5.5 0 0 1 17.4 9.1a4.2 4.2 0 0 1-.4 9.4z"/>`)),
  refresh: () => svg(base(`<path d="M19.5 12a7.5 7.5 0 1 1-2.2-5.3"/><path d="M19.5 4.5v4.2h-4.2"/>`)),
  logout: () => svg(base(`<path d="M14 4.5h3.5a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2H14"/><path d="M10.5 8 6.5 12l4 4M6.5 12H15"/>`)),
  flame: () => svg(base(`<path d="M12 3.5c.6 3-3 5-3 8.5a3 3 0 0 0 6 0c0-1-.4-1.9-1-2.6 2.6 1.1 4 3.3 4 5.6a6 6 0 0 1-12 0c0-4.6 4.2-7.2 6-11.5z"/>`)),
  plug: () => svg(base(`<path d="M9 3.5v4M15 3.5v4M6.5 7.5h11V11a5.5 5.5 0 0 1-11 0zM12 16.5v4"/>`)),
  check: () => svg(base(`<path d="M5 12.5l4.5 4.5L19 7.5"/>`)),
  maybe: () => svg(base(`<path d="M9.3 9.2a2.8 2.8 0 1 1 3.9 2.6c-.8.4-1.2 1-1.2 1.8v.5"/><path d="M12 17.6v.2"/>`)),
  // ---------- custom fields: Settings, the field types, ratings ----------
  sliders: () =>
    svg(base(`<path d="M4.5 7h9M17.5 7h2M4.5 12h3M11.5 12h8M4.5 17h11"/><circle cx="15.5" cy="7" r="2"/><circle cx="9.5" cy="12" r="2"/><circle cx="17.5" cy="17" r="2"/>`)),
  paragraph: () => svg(base(`<path d="M4.5 6.5h15M4.5 10.5h15M4.5 14.5h15M4.5 18.5h9"/>`)),
  hash: () => svg(base(`<path d="M9.8 4.5 8.2 19.5M15.8 4.5l-1.6 15M5 9h14.5M4.5 15H19"/>`)),
  toggle: () => svg(base(`<rect x="3.5" y="7" width="17" height="10" rx="5"/><circle cx="15.5" cy="12" r="2.6"/>`)),
  radio: () => svg(base(`<circle cx="12" cy="12" r="8"/><circle cx="12" cy="12" r="3.2" fill="currentColor" stroke="none"/>`)),
  tag: () =>
    svg(base(`<path d="M3.8 12.2V5.5a1.7 1.7 0 0 1 1.7-1.7h6.7l8 8a1.7 1.7 0 0 1 0 2.4l-6.3 6.3a1.7 1.7 0 0 1-2.4 0z"/><circle cx="8.3" cy="8.3" r="1.3"/>`)),
  star: () => svg(base(`<path d="M12 4.2l2.35 4.76 5.25.77-3.8 3.7.9 5.23L12 16.2l-4.7 2.46.9-5.23-3.8-3.7 5.25-.77z"/>`)),
  starSolid: () => svg(base(`<path d="M12 4.2l2.35 4.76 5.25.77-3.8 3.7.9 5.23L12 16.2l-4.7 2.46.9-5.23-3.8-3.7 5.25-.77z" fill="currentColor"/>`)),
  // A half star (Letterboxd's ½): the left half filled, the outline whole.
  starHalf: () =>
    svg(base(`<path class="star-half__fill" d="M12 4.2L9.65 8.96 4.4 9.73l3.8 3.7-.9 5.23L12 16.2z" fill="currentColor"/><path class="star-half__rest" d="M12 4.2l2.35 4.76 5.25.77-3.8 3.7.9 5.23L12 16.2"/>`)),
  sparkle: () =>
    svg(base(`<path d="M12 4.5l1.5 4.2 4.2 1.5-4.2 1.5L12 16l-1.5-4.3-4.2-1.5 4.2-1.5z"/><path d="M18 15.5l.6 1.6 1.6.6-1.6.6-.6 1.6-.6-1.6-1.6-.6 1.6-.6z"/>`)),
  wifiOff: () =>
    svg(base(`<path d="M3 3l18 18"/><path d="M8.5 16.3a5 5 0 0 1 7 0"/><path d="M5.3 13a9.2 9.2 0 0 1 2.9-2"/><path d="M12.2 7.8a9.2 9.2 0 0 1 6.5 2.7"/><circle cx="12" cy="19.5" r="1" fill="currentColor" stroke="none"/>`)),
  mic: () => svg(base(`<rect x="9" y="3.5" width="6" height="11" rx="3"/><path d="M5.8 11.5a6.2 6.2 0 0 0 12.4 0M12 17.7v2.8"/>`)),
  micOff: () =>
    svg(base(`<path d="M3.5 3.5l17 17"/><path d="M15 10V6.5a3 3 0 0 0-5.7-1.3M9 9v2.5a3 3 0 0 0 4.9 2.3"/><path d="M5.8 11.5a6.2 6.2 0 0 0 9.9 5M18.2 11.5a6.2 6.2 0 0 1-.6 2.6M12 17.7v2.8"/>`)),
  // ---------- layer 2: loops, people timelines, life admin, watch & read, goals ----------
  circle: () => svg(base(`<circle cx="12" cy="12" r="8"/>`)),
  send: () => svg(base(`<path d="M20 4 3.8 10.4l6.6 2.6 2.6 6.6z"/><path d="m20 4-9.6 9"/>`)),
  hourglass: () =>
    svg(base(`<path d="M7 3.5h10M7 20.5h10"/><path d="M8 3.5v2.2a4 4 0 0 0 1.6 3.2L12 10.7l2.4-1.8A4 4 0 0 0 16 5.7V3.5M8 20.5v-2.2a4 4 0 0 1 1.6-3.2l2.4-1.8 2.4 1.8a4 4 0 0 1 1.6 3.2v2.2"/>`)),
  flag: () => svg(base(`<path d="M5.5 20.5v-16"/><path d="M5.5 5h11.3l-2.3 3.8 2.3 3.7H5.5"/>`)),
  /** Flows: one step leading to the next. To do keeps the turning arrows (loop). */
  flow: () => svg(base(`<circle cx="6.5" cy="6.5" r="2.5"/><circle cx="17.5" cy="17.5" r="2.5"/><path d="M6.5 9v4.5a4 4 0 0 0 4 4H15"/><path d="M11 6.5h3.5a3 3 0 0 1 3 3V11"/>`)),
  loop: () =>
    svg(base(`<path d="M4.5 12a7.5 7.5 0 0 1 12.8-5.3l2.2 2.3"/><path d="M19.5 4.5V9H15"/><path d="M19.5 12a7.5 7.5 0 0 1-12.8 5.3l-2.2-2.3"/><path d="M4.5 19.5V15H9"/>`)),
  chat: () => svg(base(`<path d="M5 18.5V7.5A2.5 2.5 0 0 1 7.5 5h9A2.5 2.5 0 0 1 19 7.5v6a2.5 2.5 0 0 1-2.5 2.5H8.2z"/><path d="M9 10h6M9 12.8h3.5"/>`)),
  book: () => svg(base(`<path d="M5 18.5V6A2 2 0 0 1 7 4h12v13H7a2 2 0 0 0-2 2 1.5 1.5 0 0 0 1.5 1.5H19"/><path d="M9 8h6"/>`)),
  target: () =>
    svg(base(`<circle cx="12" cy="12" r="8"/><circle cx="12" cy="12" r="4.3"/><circle cx="12" cy="12" r="1" fill="currentColor" stroke="none"/>`)),
  shield: () => svg(base(`<path d="M12 3.5 5 6.3v5.2c0 4.3 2.9 7.6 7 9 4.1-1.4 7-4.7 7-9V6.3z"/><path d="m9.2 12 2 2 3.8-3.9"/>`)),
  key: () => svg(base(`<circle cx="8" cy="15" r="4"/><path d="m10.9 12.1 8.6-8.6M16.5 6.5l2.5 2.5M14 9l2 2"/>`)),
  idCard: () =>
    svg(base(`<rect x="3.5" y="5.5" width="17" height="13" rx="2.5"/><circle cx="9" cy="11" r="2"/><path d="M5.8 15.5c.6-1.3 1.7-2 3.2-2s2.6.7 3.2 2M14.5 10h3.5M14.5 13.3h2.5"/>`)),
  car: () =>
    svg(base(`<path d="M5 15.5v-3.2l1.7-4A2 2 0 0 1 8.5 7h7a2 2 0 0 1 1.8 1.3l1.7 4v3.2a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1z"/><path d="M5.3 12h13.4M7 16.5v1.5M17 16.5v1.5"/><circle cx="8.3" cy="14" r=".9" fill="currentColor" stroke="none"/><circle cx="15.7" cy="14" r=".9" fill="currentColor" stroke="none"/>`)),
  paw: () =>
    svg(base(`<circle cx="7.5" cy="10" r="1.6"/><circle cx="10.5" cy="6.6" r="1.6"/><circle cx="13.5" cy="6.6" r="1.6"/><circle cx="16.5" cy="10" r="1.6"/><path d="M12 11.5c-2.7 0-4.6 2.5-4.6 4.5 0 1.5 1.2 2.3 2.5 2 .9-.2 1.3-.6 2.1-.6s1.2.4 2.1.6c1.3.3 2.5-.5 2.5-2 0-2-1.9-4.5-4.6-4.5z"/>`)),
  heart: () => svg(base(`<path d="M12 19.5s-7-4.2-7-9.3A3.9 3.9 0 0 1 12 8a3.9 3.9 0 0 1 7 2.2c0 5.1-7 9.3-7 9.3z"/>`)),
  play: () => svg(base(`<path d="M8.5 5.8v12.4a.8.8 0 0 0 1.2.7l9.4-6.2a.8.8 0 0 0 0-1.4L9.7 5.1a.8.8 0 0 0-1.2.7z"/>`)),
  // Watch & read: the list itself, and the kinds the book/note/mic/play icons don't cover.
  bookmark: () => svg(base(`<path d="M6.5 5.5a2 2 0 0 1 2-2h7a2 2 0 0 1 2 2v15l-5.5-3.8-5.5 3.8z"/>`)),
  film: () => svg(base(`<path d="M4 11h16v7.5a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2z"/><path d="M4 11 3.3 8.3l15.2-4.4.8 2.8z"/><path d="M7.5 7.1 9.8 9.4M12.4 5.7 14.7 8"/>`)),
  tv: () => svg(base(`<rect x="3.5" y="7.5" width="17" height="12.5" rx="2.5"/><path d="m8.5 3.5 3.5 4 3.5-4"/>`)),
  music: () => svg(base(`<path d="M9 17.5V6l10-2v11.5"/><circle cx="6.5" cy="17.5" r="2.5"/><circle cx="16.5" cy="15.5" r="2.5"/>`)),
  headphones: () => svg(base(`<path d="M4.5 16v-3.5a7.5 7.5 0 0 1 15 0V16"/><rect x="3.5" y="14" width="4" height="6" rx="1.5"/><rect x="16.5" y="14" width="4" height="6" rx="1.5"/>`)),
  game: () =>
    svg(base(`<path d="M8 6.5h8a3.8 3.8 0 0 1 3.7 3l.9 4.6a2.4 2.4 0 0 1-4.1 2.1L15 14.5H9l-1.5 1.7a2.4 2.4 0 0 1-4.1-2.1l.9-4.6A3.8 3.8 0 0 1 8 6.5z"/><path d="M8 9.5v3M6.5 11h3"/><circle cx="15.5" cy="10" r=".9" fill="currentColor" stroke="none"/><circle cx="17" cy="12" r=".9" fill="currentColor" stroke="none"/>`)),
  week: () =>
    svg(base(`<rect x="4" y="5.5" width="16" height="14.5" rx="3"/><path d="M4 10h16M8.5 3.5v4M15.5 3.5v4"/><path d="m9 15 2 2 4-4"/>`)),
  graph: () =>
    svg(base(`<circle cx="6.5" cy="7" r="2.3"/><circle cx="17.5" cy="9" r="2.3"/><circle cx="10" cy="17.5" r="2.3"/><path d="m8.8 7.4 6.4 1.2M16 10.8l-4.5 4.9M7.2 9.2l1.9 6.1"/>`)),
  // ---------- trips and purchases ----------
  suitcase: () =>
    svg(base(`<rect x="4" y="7.5" width="16" height="12" rx="2.8"/><path d="M9 7.5V5.8A1.8 1.8 0 0 1 10.8 4h2.4A1.8 1.8 0 0 1 15 5.8v1.7M8.5 7.5v12M15.5 7.5v12"/>`)),
  plane: () =>
    svg(
      base(
        `<path d="M20.6 3.4c-.8-.8-2.3-.4-3.4.7l-3.4 3.4-7.6-2.1-1.7 1.7 6.2 3.6-3.3 3.4-2.6-.4-1.3 1.3 3.1 1.6 1.6 3.1 1.3-1.3-.4-2.6 3.4-3.3 3.6 6.2 1.7-1.7-2.1-7.6 3.4-3.4c1.1-1.1 1.5-2.6.7-3.4z"/>`
      )
    ),
  train: () =>
    svg(
      base(
        `<rect x="6" y="3.5" width="12" height="13.5" rx="3.5"/><path d="M6 10.5h12M9.5 6.5h5M9 20.5l1.5-3.5M15 20.5 13.5 17"/><circle cx="9.3" cy="13.8" r=".9" fill="currentColor" stroke="none"/><circle cx="14.7" cy="13.8" r=".9" fill="currentColor" stroke="none"/>`
      )
    ),
  bed: () => svg(base(`<path d="M3.5 6.5v12.5M3.5 15.5h17V19M20.5 15.5v-3.3a2.7 2.7 0 0 0-2.7-2.7H11v6"/><circle cx="7.3" cy="11.8" r="1.9"/>`)),
  ticket: () =>
    svg(
      base(
        `<path d="M4 8a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v1.8a2.2 2.2 0 0 0 0 4.4V16a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2v-1.8a2.2 2.2 0 0 0 0-4.4z"/><path d="M14.5 8.2v1.4M14.5 11.3v1.4M14.5 14.4v1.4"/>`
      )
    ),
  parcel: () => svg(base(`<path d="M12 3.6 19.5 7.6v8.8L12 20.4 4.5 16.4V7.6z"/><path d="M4.8 7.8 12 11.7l7.2-3.9M12 11.7v8.5M8.3 5.6l7.4 4"/>`)),
  truck: () =>
    svg(
      base(
        `<path d="M3.5 15.5V7.5a1.5 1.5 0 0 1 1.5-1.5h8.5a1.5 1.5 0 0 1 1.5 1.5v8M15 9.5h2.8a1.5 1.5 0 0 1 1.2.6l1.2 1.7a1.5 1.5 0 0 1 .3.9v2.8h-1.6M9.6 15.5h4.8"/><circle cx="7.4" cy="16.4" r="1.9"/><circle cx="16.6" cy="16.4" r="1.9"/>`
      )
    ),
  /** A pushpin (pinning an answer in Ask); `pin` is a map pin. */
  thumbtack: () => svg(base(`<path d="M9 4.5h6M10 4.5v5.2l-3 3.3h10l-3-3.3V4.5M12 13v6.5"/>`)),
  /** Stop: a rounded square, filled. */
  stop: () => svg(`<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="7" y="7" width="10" height="10" rx="2.2" fill="currentColor"/></svg>`),
  copy: () =>
    svg(base(`<rect x="8.5" y="8.5" width="11" height="11" rx="2.5"/><path d="M15.5 8.5V6A1.5 1.5 0 0 0 14 4.5H6A1.5 1.5 0 0 0 4.5 6v8A1.5 1.5 0 0 0 6 15.5h2.5"/>`)),
  external: () => svg(base(`<path d="M13.5 4.5h6v6M19.5 4.5l-8 8"/><path d="M17.5 13.5v4a2 2 0 0 1-2 2h-9a2 2 0 0 1-2-2v-9a2 2 0 0 1 2-2h4"/>`)),
  arrowRight: () => svg(base(`<path d="M5 12h14M13 6l6 6-6 6"/>`)),
  // Saved: an image, a quote, a snippet of code.
  image: () => svg(base(`<rect x="3.5" y="4.5" width="17" height="15" rx="2.5"/><circle cx="9" cy="9.5" r="1.6"/><path d="m4 17 4.6-4.4a1.5 1.5 0 0 1 2 0L15 16.5M13.5 15l1.9-1.8a1.5 1.5 0 0 1 2 0L20 15.7"/>`)),
  quote: () => svg(base(`<path d="M10 7.5H6.8A1.8 1.8 0 0 0 5 9.3v3.2h5V7.5ZM10 12.5c0 2.6-1.3 4-3.6 4.5M19 7.5h-3.2a1.8 1.8 0 0 0-1.8 1.8v3.2h5V7.5ZM19 12.5c0 2.6-1.3 4-3.6 4.5"/>`)),
  code: () => svg(base(`<path d="M8.5 7.5 4 12l4.5 4.5M15.5 7.5 20 12l-4.5 4.5M13.2 5.5l-2.4 13"/>`)),
  // For the owner's own kinds of record (lib/custom-field-rules.ts KIND_ICONS).
  wine: () => svg(base(`<path d="M7.6 3.5h8.8l.3 4.1a4.7 4.7 0 0 1-9.4 0z"/><path d="M7.5 7.5h9M12 12.3v7.7M8.5 20.5h7"/>`)),
  leaf: () => svg(base(`<path d="M5.5 18.5c-.6-7.6 4.3-13 13.6-13.2.4 9.2-4.9 14.2-12.4 13.5"/><path d="M5 19.5c2.6-3.8 5.4-6.6 9-8.8"/>`)),
  dice: () =>
    svg(
      base(
        `<rect x="4" y="4" width="16" height="16" rx="3.5"/><circle cx="8.6" cy="8.6" r="1.15" fill="currentColor" stroke="none"/><circle cx="15.4" cy="8.6" r="1.15" fill="currentColor" stroke="none"/><circle cx="12" cy="12" r="1.15" fill="currentColor" stroke="none"/><circle cx="8.6" cy="15.4" r="1.15" fill="currentColor" stroke="none"/><circle cx="15.4" cy="15.4" r="1.15" fill="currentColor" stroke="none"/>`
      )
    ),
  cup: () => svg(base(`<path d="M4.5 9h11v4.8a4.7 4.7 0 0 1-4.7 4.7H9.2a4.7 4.7 0 0 1-4.7-4.7z"/><path d="M15.5 10.5h1.6a2.4 2.4 0 0 1 0 4.8h-1.9M8 3.8v2.4M11.5 3.8v2.4"/>`)),
  laptop: () => svg(base(`<rect x="5" y="5.5" width="14" height="9.5" rx="1.5"/><path d="M3 18.5h18"/>`)),
  bag: () => svg(base(`<path d="M5.5 8.5h13l-1 10.2a1.5 1.5 0 0 1-1.5 1.3H8a1.5 1.5 0 0 1-1.5-1.3z"/><path d="M9 10.5V7a3 3 0 0 1 6 0v3.5"/>`)),
  /** Recipes: a cooking pot with a lid. */
  pot: () => svg(base(`<path d="M4.5 10.5h15v5.5a3.5 3.5 0 0 1-3.5 3.5H8a3.5 3.5 0 0 1-3.5-3.5z"/><path d="M2.5 12h2M19.5 12h2M6 10.5a6 6 0 0 1 12 0M12 4.5v-1"/>`)),
  minus: () => svg(base(`<path d="M5 12h14"/>`)),
  /** A drag handle: two columns of three dots. */
  grip: () => svg(base(`<circle cx="9" cy="6.5" r="1.1" fill="currentColor" stroke="none"/><circle cx="15" cy="6.5" r="1.1" fill="currentColor" stroke="none"/><circle cx="9" cy="12" r="1.1" fill="currentColor" stroke="none"/><circle cx="15" cy="12" r="1.1" fill="currentColor" stroke="none"/><circle cx="9" cy="17.5" r="1.1" fill="currentColor" stroke="none"/><circle cx="15" cy="17.5" r="1.1" fill="currentColor" stroke="none"/>`)),
  /** A to-do's description: lines of text. */
  lines: () => svg(base(`<path d="M5 7h14M5 12h14M5 17h9"/>`)),
  globe: () => svg(base(`<circle cx="12" cy="12" r="8"/><path d="M4 12h16M12 4c2.2 2.3 3.2 5 3.2 8s-1 5.7-3.2 8c-2.2-2.3-3.2-5-3.2-8s1-5.7 3.2-8z"/>`)),
};

export type IconName = keyof typeof icons;
