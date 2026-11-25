/**
 * Service marks for Settings' Accounts and Collections, so an account reads at a glance the
 * way it does in a phone's settings: Gmail's envelope, Calendar's 31, Slack's
 * pinwheel. Drawn inline (nothing fetched, so they work offline and leak
 * nothing about which services you use), in the services' own colours where
 * those are fixed, and in the theme's ink where the mark is monochrome.
 * Custom servers show the logo their server advertised (fetched and stored
 * by Athena's server, see netlify/lib/connectors/icons.ts), or a plug.
 */

import { h, svg } from "../lib/dom";
import { icons } from "./icons";
import { presetFor } from "../../../lib/connector-presets";
import { WORK_MARKS } from "./brand-marks/work";
import { BUSINESS_MARKS } from "./brand-marks/business";
import { MICROSOFT_MARKS } from "./brand-marks/microsoft";
import { API_MARKS } from "./brand-marks/api";
import { API_B_MARKS } from "./brand-marks/api-b";
import { APPLE_MARKS } from "./brand-marks/apple";
import { HEALTH_MARKS } from "./brand-marks/health";
import { LIFE_MARKS } from "./brand-marks/life";
import { MEDIA_TRAVEL_MARKS } from "./brand-marks/media-travel";
import { NETFLIX_MARKS } from "./brand-marks/netflix";
import { TRAVEL_MARKS } from "./brand-marks/travel";
import { READING_SOCIAL_MARKS } from "./brand-marks/reading-social";
import { FLIGHTS_MARKS } from "./brand-marks/flights";
import { LIVE_TRAVEL_MARKS } from "./brand-marks/live-travel";
import { DOCUMENTS_MARKS } from "./brand-marks/documents";
import { LIFE_B_MARKS } from "./brand-marks/life-b";
import { darkSource } from "../lib/appearance";

const CORE_MARKS: Record<string, string> = {
  // google.com (Gmail 2020 product logo) (checked 9 Nov 2026)
  gmail: `<svg viewBox="0 0 48 48" aria-hidden="true"><path fill="#4caf50" d="M45 16.2l-5 2.75-5 4.75V40h7a3 3 0 0 0 3-3z"/><path fill="#1e88e5" d="M3 16.2l3.614 1.71L13 23.7V40H6a3 3 0 0 1-3-3z"/><path fill="#e53935" d="M35 11.2l-11 8.25-11-8.25-1 5.8 1 6.7 11 8.25 11-8.25 1-6.7z"/><path fill="#c62828" d="M3 12.298V16.2l10 7.5V11.2L9.876 8.859A4.298 4.298 0 0 0 3 12.298z"/><path fill="#fbc02d" d="M45 12.298V16.2l-10 7.5V11.2l3.124-2.341A4.298 4.298 0 0 1 45 12.298z"/></svg>`,
  // google.com (Calendar 2020 product logo) (checked 9 Nov 2026)
  "google-calendar": `<svg viewBox="0 0 48 48" aria-hidden="true"><path fill="#fff" d="M13 13h22v22H13z"/><path fill="#1e88e5" d="M25.68 20.92l1.008 1.44 1.584-1.152v8.352H30V18.616h-1.44zM22.943 23.745c.625-.574 1.013-1.37 1.013-2.249 0-1.747-1.533-3.168-3.417-3.168-1.602 0-2.972 1.009-3.33 2.453l1.657.421c.165-.664.868-1.146 1.673-1.146.942 0 1.709.646 1.709 1.44s-.767 1.44-1.709 1.44h-.997v1.728h.997c1.081 0 1.993.751 1.993 1.64 0 .904-.866 1.64-1.931 1.64-.962 0-1.784-.61-1.914-1.418L17 26.802c.262 1.636 1.81 2.87 3.6 2.87 2.007 0 3.64-1.511 3.64-3.368 0-1.023-.504-1.941-1.297-2.559z"/><path fill="#fbc02d" d="M34 42H14l-1-4 1-4h20l1 4z"/><path fill="#4caf50" d="M38 35l4-1V14l-4-1-4 1v20z"/><path fill="#1e88e5" d="M34 14l1-4-1-4H9a3 3 0 0 0-3 3v25l4 1 4-1V14z"/><path fill="#e53935" d="M34 34v8l8-8z"/><path fill="#1565c0" d="M39 6h-5v8h8V9a3 3 0 0 0-3-3zM9 42h5v-8H6v5a3 3 0 0 0 3 3z"/></svg>`,
  // slack.com/media-kit (checked 9 Nov 2026)
  slack: `<svg viewBox="0 0 54 54" aria-hidden="true"><path fill="#36c5f0" d="M19.712.133a5.381 5.381 0 0 0-5.376 5.387 5.381 5.381 0 0 0 5.376 5.386h5.376V5.52A5.381 5.381 0 0 0 19.712.133m0 14.365H5.376A5.381 5.381 0 0 0 0 19.884a5.381 5.381 0 0 0 5.376 5.387h14.336a5.381 5.381 0 0 0 5.376-5.387 5.381 5.381 0 0 0-5.376-5.386"/><path fill="#2eb67d" d="M53.76 19.884a5.381 5.381 0 0 0-5.376-5.386 5.381 5.381 0 0 0-5.376 5.386v5.387h5.376a5.381 5.381 0 0 0 5.376-5.387m-14.336 0V5.52A5.381 5.381 0 0 0 34.048.133a5.381 5.381 0 0 0-5.376 5.387v14.364a5.381 5.381 0 0 0 5.376 5.387 5.381 5.381 0 0 0 5.376-5.387"/><path fill="#ecb22e" d="M34.048 54a5.381 5.381 0 0 0 5.376-5.387 5.381 5.381 0 0 0-5.376-5.386h-5.376v5.386A5.381 5.381 0 0 0 34.048 54m0-14.365h14.336a5.381 5.381 0 0 0 5.376-5.386 5.381 5.381 0 0 0-5.376-5.387H34.048a5.381 5.381 0 0 0-5.376 5.387 5.381 5.381 0 0 0 5.376 5.386"/><path fill="#e01e5a" d="M0 34.249a5.381 5.381 0 0 0 5.376 5.386 5.381 5.381 0 0 0 5.376-5.386v-5.387H5.376A5.381 5.381 0 0 0 0 34.25m14.336-.001v14.364A5.381 5.381 0 0 0 19.712 54a5.381 5.381 0 0 0 5.376-5.387V34.25a5.381 5.381 0 0 0-5.376-5.387 5.381 5.381 0 0 0-5.376 5.387"/></svg>`,
  // github.com/logos (checked 9 Nov 2026)
  github: `<svg viewBox="0 0 16 16" aria-hidden="true"><path fill="currentColor" d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0 0 16 8c0-4.42-3.58-8-8-8z"/></svg>`,
  // linear.app/brand (checked 9 Nov 2026)
  linear: `<svg viewBox="0 0 100 100" aria-hidden="true"><path fill="currentColor" d="M1.22541 61.5228c-.2225-.9485.90748-1.5459 1.59638-.857L39.3342 97.1782c.6889.6889.0915 1.8189-.857 1.5964C20.0515 94.4522 5.54779 79.9485 1.22541 61.5228ZM.00189135 46.8891c-.01764375.2833.08887215.5599.28957165.7606L52.3503 99.7085c.2007.2007.4773.3075.7606.2896 2.3692-.1476 4.6938-.46 6.9624-.9259.7645-.157 1.0301-1.0963.4782-1.6481L2.57595 39.4485c-.55186-.5519-1.49117-.2863-1.648174.4782-.465915 2.2686-.77832 4.5932-.92588465 6.9624ZM4.21093 29.7054c-.16649.3738-.08169.8106.20765 1.1l64.77602 64.776c.2894.2894.7262.3742 1.1.2077 1.7861-.7956 3.5171-1.6927 5.1855-2.684.5521-.328.6373-1.0867.1832-1.5407L8.43566 24.3367c-.45409-.4541-1.21271-.3689-1.54074.1832-.99132 1.6684-1.88843 3.3994-2.68399 5.1855ZM12.6587 18.074c-.3701-.3701-.393-.9637-.0443-1.3541C21.7795 6.45931 35.1114 0 49.9519 0 77.5927 0 100 22.4073 100 50.0481c0 14.8405-6.4593 28.1724-16.7199 37.3375-.3903.3487-.984.3258-1.3542-.0443L12.6587 18.074Z"/></svg>`,
  // notion.so, via simpleicons.org (checked 9 Nov 2026)
  notion: `<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M4.459 4.208c.746.606 1.026.56 2.428.466l13.215-.793c.28 0 .047-.28-.046-.326L17.86 1.968c-.42-.326-.981-.7-2.055-.607L3.01 2.295c-.466.046-.56.28-.374.466zm.793 3.08v13.904c0 .747.373 1.027 1.214.98l14.523-.84c.841-.046.935-.56.935-1.167V6.354c0-.606-.233-.933-.748-.887l-15.177.887c-.56.047-.747.327-.747.933zm14.337.745c.093.42 0 .84-.42.888l-.7.14v10.264c-.608.327-1.168.514-1.635.514-.748 0-.935-.234-1.495-.933l-4.577-7.186v6.952L12.21 19s0 .84-1.168.84l-3.222.186c-.093-.186 0-.653.327-.746l.84-.233V9.854L7.822 9.76c-.094-.42.14-1.026.793-1.073l3.456-.233 4.764 7.279v-6.44l-1.215-.139c-.093-.514.28-.887.747-.933zM1.936 1.035l13.31-.98c1.634-.14 2.055-.047 3.082.7l4.249 2.986c.7.513.934.653.934 1.213v16.378c0 1.026-.373 1.634-1.68 1.726l-15.458.934c-.98.047-1.448-.093-1.962-.747l-3.129-4.06c-.56-.747-.793-1.306-.793-1.96V2.667c0-.839.374-1.54 1.447-1.632z"/></svg>`,
  // granola.ai (header logo SVG, favicon) (checked 9 Nov 2026)
  granola: `<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="#1e1e1e" d="M21.1 20.3C20.5 20.9 20.1 21.2 19.9 21.4C19.7 21.5 19.7 21.6 19.6 21.7C19.0 22.1 18.5 22.2 18.1 22.6C17.5 23.0 15.5 23.5 14.9 23.7C13.9 23.9 12.8 24.0 11.6 23.9C11.3 23.9 11.1 23.9 10.9 23.9C10.8 23.9 10.7 23.9 10.6 23.9C10.6 23.9 10.6 23.9 10.6 23.9C10.6 23.9 10.6 23.9 10.5 23.9C10.5 23.9 10.5 23.9 10.4 23.9C10.4 23.9 10.4 23.9 10.4 23.9C10.3 23.9 10.2 23.9 10.2 23.9C10.2 24.0 10.1 23.9 10.1 23.9C10.0 23.9 9.7 23.7 9.7 23.7C9.6 23.7 9.6 23.7 9.5 23.7C9.5 23.7 9.5 23.7 9.4 23.7C9.4 23.7 9.4 23.6 9.3 23.6C9.2 23.5 9.2 23.7 9.0 23.5C9.0 23.5 9.0 23.5 8.9 23.5C8.9 23.5 8.9 23.5 8.9 23.5C8.8 23.4 8.5 23.4 8.3 23.3C8.0 23.2 8.1 23.2 8.0 23.1C6.7 22.6 4.7 21.6 4.0 20.9C3.8 20.7 3.5 20.1 3.3 19.9C3.1 19.8 2.8 19.6 2.8 19.4C2.7 19.3 2.8 19.1 2.7 19.0C2.5 18.8 2.3 18.7 2.0 18.4C1.8 17.9 1.6 17.4 1.3 16.8C1.1 16.3 0.5 14.6 0.5 11.6C0.5 9.6 1.4 6.8 1.8 6.4C2.1 6.2 2.0 5.6 2.2 5.4C4.3 2.4 8.1 0.2 12.5 0.0C12.7 0.0 12.9 0 13.1 0.0C14.2 -0.0 15.3 0.1 16.3 0.3C17.4 0.6 18.4 1.0 19.4 1.5C19.4 1.5 19.5 1.5 19.6 1.5C19.6 1.5 19.6 1.5 19.7 1.6C19.7 1.6 19.8 1.6 19.9 1.6C20.1 1.6 20.1 1.7 20.1 1.8C20.2 1.8 20.2 1.9 20.3 1.9C20.6 2 20.6 2.0 20.6 2.1C20.7 2.1 20.7 2.1 20.7 2.2C20.7 2.2 20.7 2.2 20.8 2.3C20.8 2.3 21.0 2.4 21.0 2.5C21.0 2.6 21.1 2.6 21.1 2.8C21.1 2.9 21.1 2.9 20.8 3.2C20.5 3.5 19.9 3.7 19.5 3.6C18.1 3.1 17.9 3.0 17.4 2.8C16.4 2.6 15.6 2.4 14.6 2.4C12.9 2.4 11.7 2.6 10.1 3.1C9.4 3.3 8.2 4.0 7.5 4.5C6.9 5.0 6.0 5.7 5.6 6.4C5.4 6.6 5.3 6.8 5.0 7.2C4.5 7.7 4.0 9.1 3.8 9.8C3.8 10.0 3.9 10.1 3.8 10.3C3.8 10.5 3.5 10.5 3.5 10.7C3.4 11.2 3.4 11.8 3.4 12.3C3.4 12.6 3.5 13.0 3.6 13.3C3.6 13.4 3.9 13.5 3.9 13.7C3.9 13.8 3.8 13.9 3.8 14.0C3.8 14.1 3.9 15.1 4.0 15.3C4.1 15.4 4.4 15.7 4.5 15.9C4.5 16.0 4.4 16.2 4.5 16.3C4.6 16.4 4.8 16.4 4.9 16.6C5.0 16.7 5.2 17.2 5.4 17.3C5.4 17.4 5.6 17.5 5.7 17.5C5.9 17.7 5.7 17.8 5.9 18.0C6.5 18.7 7.5 19.6 8.4 20.0C8.6 20.1 10.1 20.7 10.2 20.7C12.2 21 14.6 20.9 16.6 19.8C17.1 19.5 19.8 17.7 20.2 15.4C20.3 15.0 20.5 13.9 20.4 13.5C20.2 11.9 19.2 9.6 17.4 8.8C16.4 8.3 15.7 8.3 15.5 8.4C15.0 8.5 14.8 8.1 14.3 8.2C12.8 8.3 11.2 8.7 10.1 10.0C9.0 11.1 8.8 12.6 9.3 13.5C9.4 13.7 9.3 13.8 9.2 13.9C9.2 13.9 9.1 14 9.1 14.0C9.1 14.1 9.2 14.1 9.3 14.1C9.9 14.4 10.1 15.4 10.9 15.3L11.1 15.3C11.1 15.3 11.4 15.3 11.5 15.2C11.6 15.0 11.6 14.9 11.5 14.8C11.5 14.8 11.5 14.8 11.5 14.7C11.4 14.7 11.4 14.6 11.4 14.6C11.4 14.6 11.5 14.6 11.5 14.5C11.5 14.4 11.4 14.4 11.4 14.3C11.4 14.2 11.5 14.2 11.5 14.1C11.6 14.1 11.6 14.0 11.5 14.0C11.5 14.0 11.5 14.0 11.5 14.0C11.5 13.9 11.5 13.9 11.5 13.8C11.5 13.8 11.5 13.7 11.5 13.7C11.6 13.6 11.5 13.5 11.5 13.4C11.5 13.4 11.7 13.3 11.8 13.2C11.8 13.2 11.8 13.2 11.8 13.2C11.8 13.1 11.7 13.1 11.7 13.0C11.7 13 11.8 12.9 11.8 12.9C11.8 12.8 11.9 12.8 11.9 12.7L11.9 12.5C12.0 12.5 12.0 12.4 12.1 12.4C12.2 12.4 12.1 12.2 12.2 12.2C12.2 12.2 12.3 12.2 12.4 12.2C12.7 12.1 12.5 12.0 12.5 11.9C12.6 11.8 12.6 11.8 12.7 11.8C12.7 11.9 12.8 11.8 12.8 11.8C12.8 11.8 12.9 11.7 12.9 11.7C13.0 11.7 13.1 11.7 13.2 11.7C13.3 11.7 13.3 11.7 13.4 11.7C13.5 11.7 13.7 11.7 13.8 11.6C13.9 11.6 13.9 11.5 14.0 11.5C14.1 11.5 14.2 11.7 14.3 11.7C14.3 11.7 14.4 11.6 14.5 11.6C14.5 11.6 14.5 11.7 14.6 11.7L14.6 11.7C14.6 11.7 15.3 11.7 16.0 12.1C16.5 12.4 16.8 13.1 16.8 13.1C17.1 13.7 16.8 14.3 16.8 14.8C16.8 15.0 16.8 15.2 16.8 15.4C16.8 15.5 16.6 15.7 16.6 15.8C16.6 15.9 16.6 16.0 16.4 16.2C16.3 16.4 16.2 16.4 16.2 16.4C16.2 16.5 15.8 17.0 15.6 17.3C14.9 17.8 14.3 18.0 13.4 18.0C13.0 18.0 13.0 18.1 12.9 18.1C12.7 18.1 11.8 18.1 11.5 18.0C11.5 18.0 10.2 17.8 9.7 17.5C9.5 17.4 7.7 16.1 7.3 15.3C6.0 13.0 6.3 10.5 7.6 8.8C8.5 7.6 10.1 6.0 13.7 5.7C15.6 5.5 17.2 5.8 18.5 6.4C20.4 7.2 21.7 8.7 22.5 10.5C24.0 13.6 23.9 17.1 21.1 20.3Z"/></svg>`,
  // elevenlabs.io/brand (checked 9 Nov 2026)
  elevenlabs: `<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="8.6" y="4.5" width="2" height="15" rx="0.4" fill="currentColor"/><rect x="13.4" y="4.5" width="2" height="15" rx="0.4" fill="currentColor"/></svg>`,
};

/** One file of marks per lib/presets/*.ts file, so parallel work never edits the same map. */
const MARKS: Record<string, string> = { ...CORE_MARKS, ...WORK_MARKS, ...BUSINESS_MARKS, ...MICROSOFT_MARKS, ...API_MARKS, ...API_B_MARKS, ...APPLE_MARKS, ...HEALTH_MARKS, ...READING_SOCIAL_MARKS, ...MEDIA_TRAVEL_MARKS, ...NETFLIX_MARKS, ...TRAVEL_MARKS, ...FLIGHTS_MARKS, ...LIVE_TRAVEL_MARKS, ...LIFE_MARKS, ...DOCUMENTS_MARKS, ...LIFE_B_MARKS };

export type LogoSize = "sm" | "md" | "lg";

/**
 * Services with no mark Athena can draw faithfully: no official vector is
 * published, or the brand is a wordmark only (docs/notes/connectors-audit.md).
 * Rather than invent one, they show their preset's category icon. "custom"
 * is any MCP server, which shows the logo it advertises or a plug.
 */
export const ICON_FALLBACK: readonly string[] = ["custom", "circleback", "withings", "polar", "habitify", "octopus", "opensky", "dvla", "dvsa-mot", "home-connect", "fastmail"];

/** Does this preset have a drawn mark? (brand-logo.test.ts: every preset has one or is in ICON_FALLBACK.) */
export const hasMark = (provider: string): boolean => provider in MARKS;

/** A service's mark in a rounded tile. `provider` is a preset id from lib/connector-presets.ts. */
export function brandLogo(provider: string, size: LogoSize = "md"): HTMLElement {
  const known = provider in MARKS;
  const preset = known ? undefined : presetFor(provider);
  // A known service without a mark shows its category icon; anything else (a custom server) the plug.
  const icon = preset && preset.id !== "custom" ? icons[preset.icon as keyof typeof icons] : undefined;
  const el = document.createElement("span");
  el.className = `logo logo--${size} logo--${known ? provider : icon ? "icon" : "custom"}`;
  el.setAttribute("aria-hidden", "true");
  el.append(known ? svg(MARKS[provider]) : (icon ?? icons.plug)());
  return el;
}

/** Only data: images, which is all the server ever stores; anything else is ignored. */
const isDataImage = (src: string | undefined): src is string => !!src && /^data:image\/(png|jpeg|gif|webp|svg\+xml|x-icon|vnd\.microsoft\.icon);base64,/.test(src);

/**
 * An account's logo: the drawn mark for a known service, otherwise the logo
 * its server advertised — with a dark-mode variant when it has one — or a plug.
 */
export function connectorLogo(c: { provider: string; server_info?: { icon?: { light?: string; dark?: string } } }, size: LogoSize = "md"): HTMLElement {
  const icon = c.server_info?.icon;
  const light = isDataImage(icon?.light) ? icon!.light : undefined;
  const dark = isDataImage(icon?.dark) ? icon!.dark : undefined;
  if (c.provider in MARKS || (!light && !dark)) return brandLogo(c.provider, size);
  const img = h("img", { src: light ?? dark!, alt: "", decoding: "async", draggable: "false" });
  const el = document.createElement("span");
  el.className = `logo logo--${size} logo--image`;
  el.setAttribute("aria-hidden", "true");
  el.append(dark && light ? h("picture", {}, darkSource(dark), img) : img);
  return el;
}
