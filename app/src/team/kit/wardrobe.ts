/**
 * The wardrobe: a live editor for an AvatarSpec. Species, coat, eyes, mouth,
 * outfit and colour are radio groups (arrow keys move and pick); accessories
 * are toggles in a tray, one per slot, and wearing a second in a slot swaps
 * it in. Shuffle re-rolls everything that isn't locked.
 */
import "./wardrobe.css";
import type { AccessoryId, AvatarSpec, EyesId, MouthId, OutfitId, Species } from "./types";
import { ACCENT, FUR, OUTFIT, darkFill } from "./palette";
import { SPECIES } from "./species";
import { EYES, MOUTHS, OUTFITS } from "./parts";
import { ACCESSORIES, toggleAccessory, type Slot } from "./accessories";
import { ACCESSORY_IDS, EYES_IDS, MOUTH_IDS, OUTFIT_IDS, SPECIES_IDS, avatarMarkup, normalizeSpec } from "./svg";
import { shuffleSpec, type LockPart } from "./procedural";
import { renderAvatarTile, updateAvatar } from "./render";

const DICE =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="4" y="4" width="16" height="16" rx="4"/><circle cx="9" cy="9" r="1.1" fill="currentColor" stroke="none"/><circle cx="15" cy="15" r="1.1" fill="currentColor" stroke="none"/><circle cx="15" cy="9" r="1.1" fill="currentColor" stroke="none"/><circle cx="9" cy="15" r="1.1" fill="currentColor" stroke="none"/></svg>';
const LOCK =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="5.5" y="10.5" width="13" height="9.5" rx="2.5"/><path class="kit-lock-shackle" d="M8.5 10.5V8a3.5 3.5 0 0 1 7 0v2.5"/></svg>';

const SLOT_WORD: Record<Slot, string> = { head: "head", face: "face", neck: "neck" };

function el<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Record<string, string> = {}, html?: string): HTMLElementTagNameMap[K] {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
  if (html !== undefined) n.innerHTML = html;
  return n;
}

function newSeed(): string {
  const b = new Uint8Array(6);
  crypto.getRandomValues(b);
  return Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
}

/** A cropped preview of the spec, drawn at an outline weight that suits the crop. */
function mini(spec: AvatarSpec, box: [number, number, number, number], px: number): string {
  return avatarMarkup(spec, { size: (px * 120) / box[2], viewBox: box.map((v) => +v.toFixed(2)).join(" ") });
}

interface Option<T extends string> {
  value: T;
  label: string;
  html: string;
}

export function wardrobe(initial: AvatarSpec, onChange: (spec: AvatarSpec) => void): HTMLElement {
  let spec = normalizeSpec(initial);
  const locks = new Set<LockPart>();

  const root = el("section", { class: "kit-wardrobe", "aria-label": "Customise character" });
  const stage = el("div", { class: "kit-wr-stage" });
  // The same tile as everywhere else the character stands; updateAvatar keeps its tint with the coat.
  const preview = renderAvatarTile(spec, { size: 144, animate: true });
  const shuffle = el("button", { type: "button", class: "kit-wr-shuffle" }, `${DICE}<span>Shuffle</span>`);
  stage.append(preview, shuffle);
  const groups = el("div", { class: "kit-wr-groups" });
  root.append(stage, groups);

  const set = (next: AvatarSpec) => {
    spec = next;
    updateAvatar(preview, spec);
    draw();
    onChange(spec);
  };

  shuffle.addEventListener("click", () => set(shuffleSpec(spec, locks, newSeed())));

  function lockButton(part: LockPart, label: string): HTMLButtonElement {
    const b = el("button", {
      type: "button",
      class: "kit-wr-lock",
      "aria-pressed": String(locks.has(part)),
      "aria-label": `Keep ${label.toLowerCase()} when shuffling`,
      title: `Keep ${label.toLowerCase()} when shuffling`,
      "data-key": `lock:${part}`,
    }, LOCK);
    b.addEventListener("click", () => {
      locks.has(part) ? locks.delete(part) : locks.add(part);
      draw();
    });
    return b;
  }

  function section(title: string, lock: LockPart | null, body: HTMLElement, hint?: string, lockLabel = title): HTMLElement {
    const id = `kit-wr-${title.toLowerCase().replace(/[^a-z]+/g, "-")}`;
    const s = el("div", { class: "kit-wr-section" });
    const head = el("div", { class: "kit-wr-head" });
    head.append(el("h3", { id }, title));
    if (lock) head.append(lockButton(lock, lockLabel));
    body.setAttribute("aria-labelledby", id);
    s.append(head);
    if (hint) s.append(el("p", { class: "kit-wr-hint" }, hint));
    s.append(body);
    return s;
  }

  function radios<T extends string>(kind: string, cls: string, options: Option<T>[], current: T, pick: (v: T) => void): HTMLElement {
    const g = el("div", { role: "radiogroup", class: `kit-wr-radios ${cls}` });
    const buttons = options.map((o) => {
      const on = o.value === current;
      const b = el("button", {
        type: "button",
        role: "radio",
        "aria-checked": String(on),
        "aria-label": o.label,
        tabindex: on ? "0" : "-1",
        "data-key": `${kind}:${o.value}`,
      }, o.html);
      b.addEventListener("click", () => pick(o.value));
      return b;
    });
    if (!options.some((o) => o.value === current) && buttons[0]) buttons[0].tabIndex = 0;
    g.addEventListener("keydown", (e) => {
      const i = buttons.indexOf(document.activeElement as HTMLButtonElement);
      if (i < 0) return;
      const step = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[e.key];
      let j = step !== undefined ? (i + step + buttons.length) % buttons.length : e.key === "Home" ? 0 : e.key === "End" ? buttons.length - 1 : -1;
      if (j < 0) return;
      e.preventDefault();
      pick(options[j].value);
      (groups.querySelector(`[data-key="${CSS.escape(`${kind}:${options[j].value}`)}"]`) as HTMLElement | null)?.focus();
    });
    g.append(...buttons);
    return g;
  }

  const swatch = (fill: string) => `<span class="kit-wr-swatch" style="--sw:${fill};--sw-dark:${darkFill(fill)}"></span>`;

  function draw(): void {
    const focused = (document.activeElement as HTMLElement | null)?.dataset?.key;
    const a = SPECIES[spec.species].anchors;
    const eyeW = 2 * a.eyeDx + 28;
    const eyeBox: [number, number, number, number] = [60 - eyeW / 2, a.eyeY - eyeW * 0.3, eyeW, eyeW * 0.6];
    const mouthC = (a.noseY + a.mouthY) / 2 + 1;
    const mouthBox: [number, number, number, number] = [44, mouthC - 10, 32, 20];
    const outfitBox: [number, number, number, number] = [14, a.chinY - 8, 92, 40];
    const noAcc = { ...spec, accessories: [] as AccessoryId[] };

    groups.replaceChildren(
      section("Species", "species",
        radios<Species>("species", "kit-wr-seg", SPECIES_IDS.map((s) => ({
          value: s,
          label: SPECIES[s].label,
          html: `${mini({ ...noAcc, species: s }, [16, 2, 88, 88], 28)}<span>${SPECIES[s].label}</span>`,
        })), spec.species, (species) => set({ ...spec, species }))),
      section("Fur", "fur",
        radios("fur", "kit-wr-swatches", Object.entries(FUR).map(([k, t]) => ({ value: k, label: t.label, html: swatch(t.fill) })),
          spec.fur, (fur) => set({ ...spec, fur })), undefined, "Fur and cheeks"),
      section("Cheeks and ears", null,
        radios("accent", "kit-wr-swatches", Object.entries(ACCENT).map(([k, t]) => ({ value: k, label: t.label, html: swatch(t.fill) })),
          spec.accent, (accent) => set({ ...spec, accent }))),
      section("Eyes", "eyes",
        radios<EyesId>("eyes", "kit-wr-grid", EYES_IDS.map((e) => ({ value: e, label: EYES[e].label, html: mini({ ...noAcc, eyes: e }, eyeBox, 64) })),
          spec.eyes, (eyes) => set({ ...spec, eyes }))),
      section("Mouth and nose", "mouth",
        radios<MouthId>("mouth", "kit-wr-grid kit-wr-mouths", MOUTH_IDS.map((m) => ({ value: m, label: MOUTHS[m].label, html: mini({ ...noAcc, mouth: m }, mouthBox, 64) })),
          spec.mouth, (mouth) => set({ ...spec, mouth }))),
      section("Outfit", "outfit",
        radios<OutfitId>("outfit", "kit-wr-grid kit-wr-outfits", OUTFIT_IDS.map((o) => ({ value: o, label: OUTFITS[o].label, html: mini({ ...noAcc, outfit: o }, outfitBox, 64) })),
          spec.outfit, (outfit) => set({ ...spec, outfit }))),
      section("Outfit colour", "outfitColor",
        radios("outfitColor", "kit-wr-swatches", Object.entries(OUTFIT).map(([k, t]) => ({ value: k, label: t.label, html: swatch(t.fill) })),
          spec.outfitColor, (outfitColor) => set({ ...spec, outfitColor }))),
      section("Accessories", "accessories", tray(), "One each for head, face and neck. Tap to wear, tap again to take off."),
    );
    if (focused) (groups.querySelector(`[data-key="${CSS.escape(focused)}"]`) as HTMLElement | null)?.focus();
  }

  function tray(): HTMLElement {
    const g = el("div", { role: "group", class: "kit-wr-grid kit-wr-tray" });
    for (const id of ACCESSORY_IDS) {
      const on = spec.accessories.includes(id);
      const art = ACCESSORIES[id];
      const b = el("button", {
        type: "button",
        "aria-pressed": String(on),
        "aria-label": `${art.label} (${SLOT_WORD[art.slot]})`,
        "data-key": `acc:${id}`,
      }, mini({ ...spec, accessories: [id] }, [4, 0, 112, 112], 64));
      b.addEventListener("click", () => set({ ...spec, accessories: toggleAccessory(spec.accessories, id) }));
      g.append(b);
    }
    return g;
  }

  draw();
  return root;
}
