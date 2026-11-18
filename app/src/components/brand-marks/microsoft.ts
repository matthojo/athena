/**
 * Service marks for the presets in lib/presets/microsoft.ts, keyed by preset id.
 * Inline SVG strings, merged into brand-logo.ts's MARKS. Same rules as
 * there: drawn inline, nothing fetched; the service's own colours where they
 * are fixed, currentColor where the mark is monochrome.
 *
 * Outlook's mark: the blue "O" tile in front of a mail panel; the calendar
 * keeps the same tile in front of a month grid, so the pair reads as one
 * service in the directory.
 */

/** The front tile with its "O", shared by both marks. */
const O_TILE = `<rect x="4" y="13" width="22" height="22" rx="2.6" fill="#0a5ec7"/><ellipse cx="15" cy="24" rx="5.4" ry="6.4" fill="none" stroke="#fff" stroke-width="2.6"/>`;

export const MICROSOFT_MARKS: Record<string, string> = {
  // Microsoft Outlook app icon (2019 palette; no official SVG found) (checked 9 Nov 2026)
  "outlook-mail": `<svg viewBox="0 0 48 48" aria-hidden="true"><defs><clipPath id="olk-m"><rect x="15" y="7" width="29" height="34" rx="3"/></clipPath></defs><g clip-path="url(#olk-m)"><path fill="#0364b8" d="M15 7h15v9H15z"/><path fill="#0078d4" d="M30 7h14v9H30zM15 16h15v8H15z"/><path fill="#28a8ea" d="M30 16h14v8H30z"/><path fill="#1490df" d="M15 22h29v19H15z"/><path fill="#50d9ff" opacity=".55" d="M15 22l14.5 10L44 22v3L29.5 35 15 25z"/></g>${O_TILE}</svg>`,
  // Microsoft Outlook app icon (2019 palette; no official SVG found) (checked 9 Nov 2026)
  "outlook-calendar": `<svg viewBox="0 0 48 48" aria-hidden="true"><defs><clipPath id="olk-c"><rect x="15" y="7" width="29" height="34" rx="3"/></clipPath></defs><g clip-path="url(#olk-c)"><path fill="#0364b8" d="M15 7h29v8H15z"/><path fill="#1490df" d="M15 15h29v26H15z"/><path fill="#fff" opacity=".85" d="M29 19h4v4h-4zM36 19h4v4h-4zM29 26h4v4h-4zM36 26h4v4h-4zM29 33h4v4h-4zM36 33h4v4h-4z"/></g>${O_TILE}</svg>`,
};
