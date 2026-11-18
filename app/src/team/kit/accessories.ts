/**
 * The ten accessories, each in one slot (head, face or neck) and drawn from
 * the species anchors so it sits right on every head. Colours follow the
 * accessories sheet and stay fixed: they are the props, not the character.
 */
import type { AccessoryId } from "./types";
import type { Anchors } from "./species";
import { INK } from "./palette";

export type Slot = "head" | "face" | "neck";

// The sheet's colours, muted with the palette (16 Nov): still recognisable props, no longer stickers.
const BLUE = "#436ed1";
const BLUE_DEEP = "#3059ba";
const YELLOW = "#f0d17d";
const PINK = "#e5bac3";
const ORANGE = "#d3805a";
const GOLD = "#d7ac68";
const CREAM = "#f6f1e7";
const RED = "#c86459";

export interface AccessoryArt {
  slot: Slot;
  label: string;
  draw(a: Anchors): string;
}

const n = (v: number) => +v.toFixed(2);

/** A thick band with an ink edge: drawn as an ink stroke under a coloured one. */
const band = (d: string, colour: string, w: number) =>
  `<path d="${d}" fill="none" stroke="${INK}" stroke-width="${w}" stroke-linecap="round"/>` +
  `<path d="${d}" fill="none" stroke="${colour}" stroke-width="${w - 2.6}" stroke-linecap="round"/>`;

const flower = (x: number, y: number, petal: string, r = 2.5) => {
  let s = "";
  for (let i = 0; i < 5; i++) {
    const t = (i / 5) * Math.PI * 2 - Math.PI / 2;
    s += `<circle cx="${n(x + Math.cos(t) * r * 1.15)}" cy="${n(y + Math.sin(t) * r * 1.15)}" r="${r}" fill="${petal}"/>`;
  }
  return s + `<circle cx="${n(x)}" cy="${n(y)}" r="${n(r * 0.7)}" fill="${YELLOW}"/>`;
};

export const ACCESSORIES: Record<AccessoryId, AccessoryArt> = {
  beanie: {
    slot: "head",
    label: "Beanie",
    draw: ({ top, brim }) => {
      const y = top + 13;
      const l = 60 - brim - 1, r = 60 + brim + 1;
      return (
        `<path d="M${n(l + 2)},${y} C${n(l + 2)},${top - 14} ${n(r - 2)},${top - 14} ${n(r - 2)},${y} Z" fill="${BLUE}"/>` +
        `<path d="M${n(l + 14)},${top - 4} Q${60},${top - 8} ${n(r - 14)},${top - 4}" fill="none" stroke-width="{t}"/>` +
        `<rect x="${n(l)}" y="${y - 4}" width="${n(r - l)}" height="9" rx="4.5" fill="${BLUE_DEEP}"/>` +
        `<circle cx="60" cy="${top - 10}" r="5" fill="${YELLOW}"/>`
      );
    },
  },
  "party-hat": {
    slot: "head",
    label: "Party hat",
    draw: ({ top }) => {
      const b = top + 5;
      return (
        `<g transform="rotate(10 60 ${b})">` +
        `<path d="M48,${b} L62,${b - 28} L74,${b} Q61,${b + 4} 48,${b} Z" fill="${CREAM}" stroke-linejoin="round"/>` +
        `<path d="M52.6,${b - 9.4} L70.4,${b - 9.8} L72,${b - 4.6} L51,${b - 4.4} Z M57.4,${b - 19.2} L66.6,${b - 19.4} L68.2,${b - 14.6} L55.4,${b - 14.4} Z" fill="${RED}" stroke="none"/>` +
        `<path d="M48,${b} L62,${b - 28} L74,${b} Q61,${b + 4} 48,${b} Z" fill="none" stroke-linejoin="round"/>` +
        `<circle cx="62" cy="${b - 29}" r="3.6" fill="${YELLOW}"/>` +
        `</g>`
      );
    },
  },
  crown: {
    slot: "head",
    label: "Crown",
    draw: ({ top }) => {
      const b = top + 5;
      return (
        `<path d="M46,${b} L43,${b - 15} L52,${b - 8} L60,${b - 19} L68,${b - 8} L77,${b - 15} L74,${b} Q60,${b + 3} 46,${b} Z" fill="${GOLD}" stroke-linejoin="round"/>` +
        `<path d="M45.4,${b - 4} Q60,${b - 1.6} 74.6,${b - 4}" fill="none" stroke-width="{t}"/>` +
        `<circle cx="43" cy="${b - 16}" r="2" fill="${YELLOW}"/><circle cx="60" cy="${b - 20}" r="2.2" fill="${YELLOW}"/><circle cx="77" cy="${b - 16}" r="2" fill="${YELLOW}"/>`
      );
    },
  },
  bow: {
    slot: "head",
    label: "Bow",
    draw: ({ side: [x, y] }) =>
      `<g transform="translate(${x} ${y}) rotate(20)">` +
      `<path d="M0,0 C-3,-7 -12,-8 -12,0 C-12,8 -3,7 0,0 Z M0,0 C3,-7 12,-8 12,0 C12,8 3,7 0,0 Z" fill="${PINK}" stroke-linejoin="round"/>` +
      `<path d="M-8,-1.5 Q-5,0 -8,1.5 M8,-1.5 Q5,0 8,1.5" fill="none" stroke-width="{t}"/>` +
      `<rect x="-2.8" y="-3.4" width="5.6" height="6.8" rx="2.2" fill="${YELLOW}"/></g>`,
  },
  flowers: {
    slot: "head",
    label: "Flowers",
    draw: ({ side: [x, y] }) =>
      `<g stroke-width="{t}">` + flower(x - 9, y + 2, BLUE, 2.4) + flower(x + 7, y + 4, BLUE, 2.4) + flower(x - 1, y - 2, PINK, 2.8) + `</g>`,
  },
  headphones: {
    slot: "head",
    label: "Headphones",
    draw: ({ top, faceL, eyeY }) => {
      const l = faceL + 2, r = 120 - faceL - 2;
      const cy = eyeY + 1;
      return (
        band(`M${l},${cy - 4} C${l},${top - 16} ${r},${top - 16} ${r},${cy - 4}`, PINK, 7) +
        `<rect x="${l - 7}" y="${cy - 9}" width="10" height="18" rx="5" fill="${YELLOW}"/>` +
        `<rect x="${r - 3}" y="${cy - 9}" width="10" height="18" rx="5" fill="${YELLOW}"/>` +
        `<path d="M${l - 3},${cy - 5} L${l - 3},${cy + 5} M${r + 3},${cy - 5} L${r + 3},${cy + 5}" fill="none" stroke="${ORANGE}" stroke-width="2" stroke-linecap="round"/>`
      );
    },
  },
  glasses: {
    slot: "face",
    label: "Glasses",
    draw: ({ eyeY, eyeDx, faceL }) => {
      const r = Math.min(8, eyeDx - 2.5);
      const lx = 60 - eyeDx, rx = 60 + eyeDx;
      const frame = (cx: number) =>
        `<circle cx="${cx}" cy="${eyeY}" r="${n(r)}" fill="#ffffff" fill-opacity="0.18" stroke="${INK}" stroke-width="4"/>` +
        `<circle cx="${cx}" cy="${eyeY}" r="${n(r)}" fill="none" stroke="${ORANGE}" stroke-width="1.8"/>`;
      return (
        band(`M${n(lx + r)},${eyeY} Q60,${eyeY - 4} ${n(rx - r)},${eyeY}`, ORANGE, 4) +
        band(`M${n(lx - r)},${eyeY - 1} L${faceL + 1},${eyeY - 3} M${n(rx + r)},${eyeY - 1} L${119 - faceL},${eyeY - 3}`, ORANGE, 4) +
        frame(lx) + frame(rx)
      );
    },
  },
  "eye-patch": {
    slot: "face",
    label: "Eye patch",
    draw: ({ eyeY, eyeDx, strapL: [sx, sy], faceL }) => {
      const x = 60 + eyeDx;
      return (
        `<path d="M${sx},${sy} L${n(x - 4)},${eyeY - 4} M${n(x + 5)},${eyeY + 1} L${120 - faceL - 0.5},${eyeY + 6}" fill="none" stroke-width="2.2" stroke-linecap="round"/>` +
        `<path d="M${x - 7},${eyeY - 3} Q${x},${eyeY - 7} ${x + 7},${eyeY - 2} Q${x + 6},${eyeY + 6} ${x},${eyeY + 6} Q${x - 7},${eyeY + 5} ${x - 7},${eyeY - 3} Z" fill="${INK}"/>`
      );
    },
  },
  scarf: {
    slot: "neck",
    label: "Scarf",
    draw: () => {
      return (
        `<g>` +
        `<path d="M64,98 L66,118 L76,116.5 L72,97 Z" fill="${ORANGE}" stroke-linejoin="round"/>` +
        `<path d="M64.6,104 L73.2,103 M65.2,110 L74.6,109" fill="none" stroke="${BLUE}" stroke-width="3"/>` +
        `<path d="M64,98 L66,118 L76,116.5 L72,97 Z" fill="none" stroke-linejoin="round"/>` +
        `<path d="M66,118 L65.6,121 M71,117.4 L71,120.4 M76,116.5 L76.6,119.4" fill="none" stroke-width="{t}"/>` +
        `<path d="M37,88 C46,96 74,96 83,88 L85,96 C76,105 44,105 35,96 Z" fill="${ORANGE}" stroke-linejoin="round"/>` +
        `<path d="M44,95 L47,102.6 M56,97 L57,104 M66,97 L65,104 M76,95 L74,102.6" fill="none" stroke="${BLUE}" stroke-width="3"/>` +
        `<path d="M37,88 C46,96 74,96 83,88 L85,96 C76,105 44,105 35,96 Z" fill="none" stroke-linejoin="round"/>` +
        `</g>`
      );
    },
  },
  "heart-necklace": {
    slot: "neck",
    label: "Heart necklace",
    draw: () => {
      return (
        `<g>` +
        band("M45,92 Q60,108 75,92", GOLD, 3.6) +
        `<path d="M60,111 C57.6,109 53,106 53,102.6 C53,99.6 56.6,98.4 60,101.6 C63.4,98.4 67,99.6 67,102.6 C67,106 62.4,109 60,111 Z" fill="${YELLOW}" stroke-linejoin="round"/>` +
        `<path d="M57,102.8 L63,106.2 M63,102.8 L57,106.2" fill="none" stroke="${GOLD}" stroke-width="1.4" stroke-linecap="round"/>` +
        `</g>`
      );
    },
  },
};

export const SLOT_OF = (id: AccessoryId): Slot => ACCESSORIES[id].slot;

/** Keep at most one accessory per slot; a later one replaces an earlier one in the same slot. Unknown ids drop. */
export function fitSlots(list: readonly string[]): AccessoryId[] {
  const bySlot = new Map<Slot, AccessoryId>();
  for (const id of list) {
    if (!(id in ACCESSORIES)) continue;
    const acc = id as AccessoryId;
    bySlot.delete(SLOT_OF(acc));
    bySlot.set(SLOT_OF(acc), acc);
  }
  const order: Slot[] = ["head", "face", "neck"];
  return order.flatMap((s) => (bySlot.has(s) ? [bySlot.get(s)!] : []));
}

/** Tap behaviour for the tray: wear it (swapping out the slot's current one) or take it off. */
export function toggleAccessory(list: readonly AccessoryId[], id: AccessoryId): AccessoryId[] {
  if (list.includes(id)) return list.filter((a) => a !== id);
  return fitSlots([...list, id]);
}
