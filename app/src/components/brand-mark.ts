/**
 * The Athena mark: three connected nodes, a minimal knowledge-graph glyph.
 * Drawn in currentColor so it sits on light or dark; the top node carries
 * the cobalt accent. scripts/generate-icons.mjs draws the same geometry for
 * the PWA icon set — keep them in sync.
 */

import { svg } from "../lib/dom";

export function brandMark(): SVGSVGElement {
  return svg(`
    <svg class="brand-mark" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M12 6.2 6.2 16.8M12 6.2l5.8 10.6M6.2 16.8h11.6" stroke="currentColor" stroke-opacity="0.45" stroke-width="1.6" stroke-linecap="round"/>
      <circle class="brand-mark__accent" cx="12" cy="6.2" r="2.7"/>
      <circle cx="6.2" cy="16.8" r="2.7" fill="currentColor"/>
      <circle cx="17.8" cy="16.8" r="2.7" fill="currentColor"/>
    </svg>
  `);
}
