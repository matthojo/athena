/**
 * Pictures in Ask and assistant chats, and the quiet line saying which model
 * answered.
 *
 * - While a picture is made, its step (`picture:<file id>`, lib/answer.ts) puts a calm placeholder in the reply,
 *   at the picture's own shape, and the picture fades in where it stood as soon as it's made.
 * - In the finished reply: the picture at its own shape, alt text from what was asked for, tap to open it full
 *   size, Save to a note (a sheet with search, or a new note), Download, and Undo, which archives it: it waits
 *   on the Archived page, and Restore here or there puts it back (owner, 17 Nov 2026).
 * - "Answered with Gemini 3.5 Flash" under a reply on a model other than the default, and when the chosen model
 *   didn't answer, a line naming it: "Gemini 3.5 Flash didn't answer, so Claude Sonnet 5.5 did."
 * - Sample mode paints its pictures on the device (no model): a lighthouse at dusk, and the same at night.
 */
import { h } from "../lib/dom";
import { icons } from "./icons";
import { openSheet } from "./sheet";
import { showToast } from "./toast";
import { attachExisting, cacheFile, fileUrl, isGone, openFileViewer } from "./attachments";
import { isSampleMode, createNote } from "../db/api";
import { loadModels } from "../db/models";
import { pictureModelFor } from "../db/ask-pictures";
import { notesSnapshot } from "../db/data";
import { DEFAULT_MODELS, sameRef, type ModelRef } from "../../../lib/model-types";
import { fellBackLine, modelLabel } from "../../../lib/model-label";
import type { AskFile } from "../types";
import "../styles/ask-picture.css";

/** A picture in a reply (lib/images.ts MadePicture), and where the owner has put it since. */
export interface ShownPicture {
  file: AskFile;
  alt: string;
  prompt: string;
  ref: ModelRef;
  from?: string[];
  /** Saved to this note from here. */
  note?: { id: string; title: string };
}

/** What a reply says about its model: read when it's there; older replies have none. */
export interface ModelNote {
  model?: ModelRef;
  fell_back?: boolean;
  /** The model that didn't answer, when the server says (proposed in the spec). */
  tried?: ModelRef;
  pictures?: ShownPicture[];
}

export const PICTURE_STEP = "picture:";
const reduced = () => matchMedia("(prefers-reduced-motion: reduce)").matches;
const ratioOf = (f: Pick<AskFile, "width" | "height">) => (f.width && f.height ? `${f.width} / ${f.height}` : "1 / 1");

// ---------- While it's made ----------

/**
 * The placeholders for a reply being worked on: one per picture step, in `host`. A step that's done shows its
 * picture (by the file id in the step's id) before the words arrive; a dropped one takes its placeholder away.
 */
export function syncPictureSlots(host: HTMLElement, steps: ReadonlyArray<{ id: string; text: string; done: boolean; dropped?: boolean }>): void {
  const mine = steps.filter((s) => s.id.startsWith(PICTURE_STEP));
  for (const el of [...host.children] as HTMLElement[]) if (!mine.some((s) => s.id === el.dataset.step && !s.dropped)) el.remove();
  for (const s of mine) {
    if (s.dropped) continue;
    let slot = host.querySelector<HTMLElement>(`[data-step="${CSS.escape(s.id)}"]`);
    if (!slot) {
      slot = pictureSlot(s.text);
      slot.dataset.step = s.id;
      host.append(slot);
    }
    if (s.done && slot.dataset.state !== "made") {
      slot.dataset.state = "made";
      const id = s.id.slice(PICTURE_STEP.length);
      void reveal(slot, { id, name: "", type: "image/png", size: 0, has_thumb: true });
    }
  }
  host.hidden = !host.children.length;
}

/** The calm frame a picture is made in: the sunken panel, a slow wash of light, and one line. */
function pictureSlot(text: string): HTMLElement {
  const said = h("span", { class: "pic-slot__said" }, "This can take up to a minute.");
  // A picture takes a while; say so once, rather than look stuck.
  window.setTimeout(() => {
    if (said.isConnected && !said.closest("[data-state=made]")) said.textContent = "Still working on it.";
  }, 14_000);
  const el = h(
    "div",
    { class: "pic pic--slot", role: "status", "aria-live": "polite", "aria-label": text },
    h("div", { class: "pic__frame pic-slot__frame", style: "aspect-ratio: 1 / 1" }, h("span", { class: "pic-slot__wash", "aria-hidden": "true" }), h("span", { class: "pic-slot__mark", "aria-hidden": "true" }, icons.image())),
    h("p", { class: "pic-slot__line" }, said),
  );
  return el;
}

/** The made picture, in place of its placeholder. */
async function reveal(slot: HTMLElement, f: AskFile): Promise<void> {
  const url = (await fileUrl(f, { thumb: true })) ?? (await fileUrl({ ...f, has_thumb: false }));
  if (!url || !slot.isConnected) return;
  const img = h("img", { class: "pic__img", src: url, alt: "", decoding: "async" }) as HTMLImageElement;
  await img.decode().catch(() => undefined);
  const frame = slot.querySelector<HTMLElement>(".pic__frame")!;
  if (img.naturalWidth && img.naturalHeight) frame.style.aspectRatio = `${img.naturalWidth} / ${img.naturalHeight}`;
  frame.classList.add("is-made");
  frame.append(img);
  slot.querySelector(".pic-slot__said")!.textContent = "Done. Writing the reply…";
}

// ---------- In the reply ----------

export interface PictureCardOptions {
  /** Undo's state, as the reply's receipts keep it. "undone" is archived; "restoring" is on its way back. */
  state: "ready" | "undoing" | "undone" | "restoring" | "gone";
  onUndo?: () => void;
  /** Archived: put it back here. */
  onRestore?: () => void;
  /** Saved to a note: the conversation keeps where. */
  onSaved: (note: { id: string; title: string }) => void;
  /** Every picture in the conversation, for the viewer's arrows. */
  all?: () => AskFile[];
}

/** One picture: its own shape, open full size, Save to a note, Download, Undo. */
export function pictureCard(p: ShownPicture, opts: PictureCardOptions): HTMLElement {
  const f = p.file;
  const changed = !!p.from?.length;
  const made = `${changed ? "Changed" : "Made"} with ${modelLabel(p.ref)}`;
  if (isGone(f)) {
    return h("figure", { class: "pic pic--removed" }, h("div", { class: "pic__gone" }, icons.trash(), h("span", {}, "This picture was deleted")));
  }
  if (opts.state === "undone" || opts.state === "restoring") return archivedCard(p, opts);
  const img = h("img", { class: "pic__img", alt: p.alt, decoding: "async" }) as HTMLImageElement;
  const open = h("button", { class: "pic__frame", type: "button", style: `aspect-ratio: ${ratioOf(f)}`, "aria-label": `Open full size: ${p.alt}` }, img, h("span", { class: "pic__zoom", "aria-hidden": "true" }, icons.external()));
  open.addEventListener("click", () => {
    const set = opts.all?.().filter((x) => !isGone(x)) ?? [f];
    openFileViewer(f, set.some((x) => x.id === f.id) ? set : [f]);
  });
  // The preview first, then the whole picture, without a flash: whichever is ready shows.
  void (async () => {
    const small = await fileUrl(f, { thumb: true });
    if (small && !img.src) img.src = small;
    const big = await fileUrl(f);
    if (!big) {
      if (!small) open.replaceWith(h("div", { class: "pic__frame pic__frame--missing", style: `aspect-ratio: ${ratioOf(f)}` }, icons.wifiOff(), h("span", {}, "This picture opens once you're back online.")));
      return;
    }
    const full = new Image();
    full.src = big;
    await full.decode().catch(() => undefined);
    img.src = big;
  })();
  img.addEventListener("load", () => open.classList.add("is-made"), { once: true });

  const save = p.note
    ? h("a", { class: "pic__btn pic__btn--saved", href: `#/notes/${encodeURIComponent(p.note.id)}` }, icons.check(), h("span", { class: "pic__btn-text" }, `On ${p.note.title}`))
    : h("button", { class: "pic__btn", type: "button" }, icons.note(), h("span", { class: "pic__btn-text" }, "Save to a note"));
  if (!p.note) save.addEventListener("click", () => openSaveSheet(p, opts.onSaved, save));
  const download = h("button", { class: "pic__btn pic__btn--icon", type: "button", "aria-label": `Download ${f.name}`, title: "Download" }, icons.arrowDown());
  download.addEventListener("click", () => void downloadPicture(f));
  const undoing = opts.state === "undoing";
  const undo =
    opts.onUndo && opts.state !== "gone"
      ? (h("button", { class: "pic__btn pic__btn--quiet", type: "button", disabled: undoing, "aria-label": `Undo: remove ${p.alt}` }, undoing ? "Removing…" : "Undo") as HTMLButtonElement)
      : null;
  if (undo) undo.addEventListener("click", () => opts.onUndo!());
  return h(
    "figure",
    { class: "pic" },
    open,
    h("figcaption", { class: "pic__bar" }, h("span", { class: "pic__made" }, icons.sparkle(), h("span", {}, made)), h("span", { class: "pic__actions" }, save, download, undo)),
  );
}

/** Undone: archived. A small, quiet row with the picture's own thumbnail, so it's plain which one, and Restore. */
function archivedCard(p: ShownPicture, opts: PictureCardOptions): HTMLElement {
  const f = p.file;
  const thumb = h("img", { class: "pic__ghost-img", alt: "", decoding: "async" }) as HTMLImageElement;
  void fileUrl(f, { thumb: true }).then((u) => u && (thumb.src = u));
  const restoring = opts.state === "restoring";
  const restore = opts.onRestore
    ? (h("button", { class: "pic__btn", type: "button", disabled: restoring, "aria-label": `Restore ${p.alt}` }, icons.restore(), h("span", { class: "pic__btn-text" }, restoring ? "Restoring…" : "Restore")) as HTMLButtonElement)
    : null;
  restore?.addEventListener("click", () => opts.onRestore!());
  return h(
    "figure",
    { class: "pic pic--archived", "aria-label": `Archived: ${p.alt}` },
    h(
      "div",
      { class: "pic__archived" },
      h("span", { class: "pic__ghost", style: `aspect-ratio: ${ratioOf(f)}`, "aria-hidden": "true" }, thumb),
      h("span", { class: "pic__archived-what" }, h("span", { class: "pic__archived-title" }, "Archived")),
      restore,
    ),
  );
}

/** Several pictures in one reply sit side by side on a wide screen, one under another on a phone. */
export function picturesEl(cards: HTMLElement[]): HTMLElement | null {
  if (!cards.length) return null;
  return h("div", { class: "pics", "data-count": String(Math.min(cards.length, 2)) }, ...cards);
}

async function downloadPicture(f: AskFile): Promise<void> {
  const url = await fileUrl(f);
  if (!url) return void showToast("This picture can't be downloaded right now.", { icon: "wifiOff" });
  const a = h("a", { href: url, download: f.name }) as HTMLAnchorElement;
  document.body.append(a);
  a.click();
  a.remove();
}

// ---------- Save to a note ----------

/** A sheet: a new note named after the picture, or one of yours, with search. Opening the note is one tap from the toast. */
function openSaveSheet(p: ShownPicture, onSaved: PictureCardOptions["onSaved"], from: HTMLElement): void {
  const title = p.file.name.replace(/\.\w+$/, "");
  const field = h("input", { class: "field pic-save__search", type: "search", placeholder: "Search your notes", "aria-label": "Search your notes", autocomplete: "off" }) as HTMLInputElement;
  const list = h("div", { class: "pic-save__list", role: "list", "aria-label": "Your notes" });
  const preview = h("div", { class: "pic-save__preview" }, h("img", { alt: "", class: "pic-save__thumb" }), h("div", { class: "pic-save__what" }, h("p", { class: "pic-save__name" }, title), h("p", { class: "pic-save__meta" }, `Made with ${modelLabel(p.ref)}`)));
  void fileUrl(p.file, { thumb: true }).then((u) => u && ((preview.querySelector("img") as HTMLImageElement).src = u));
  const body = h("div", { class: "pic-save" }, preview, field, list);
  const sheet = openSheet({ label: "Save the picture to a note", title: "Save to a note", body, onClose: () => from.isConnected && (from as HTMLElement).focus() });
  let busy = false;
  const pick = async (note: { id: string; title: string } | null) => {
    if (busy) return;
    busy = true;
    list.setAttribute("aria-busy", "true");
    try {
      const target = note ?? (await newNote(title));
      await attachExisting(target.id, p.file);
      sheet.close();
      onSaved(target);
      showToast(`Saved to ${target.title}`, { icon: "check", action: { label: "Open", run: () => (location.hash = `#/notes/${encodeURIComponent(target.id)}`) } });
    } catch {
      showToast(navigator.onLine ? "Couldn't save the picture to that note. Try again." : "You're offline. Save it once you're back online.", { icon: "note" });
    } finally {
      busy = false;
      list.removeAttribute("aria-busy");
    }
  };
  const row = (label: string, detail: string, icon: HTMLElement | SVGElement, run: () => void, cls = "") => {
    const b = h("button", { class: `pic-save__row${cls}`, type: "button", role: "listitem" }, h("span", { class: "tile tile--sm", "aria-hidden": "true" }, icon), h("span", { class: "pic-save__row-body" }, h("span", { class: "pic-save__row-title" }, label), detail ? h("span", { class: "pic-save__row-detail" }, detail) : null));
    b.addEventListener("click", run);
    return b;
  };
  const paint = () => {
    const q = field.value.trim().toLowerCase();
    const notes = notesSnapshot()
      .notes.filter((n) => !n.archived_at && (n.title || "").trim())
      .filter((n) => !q || n.title.toLowerCase().includes(q))
      .sort((a, b) => b.updated_at.localeCompare(a.updated_at))
      .slice(0, q ? 20 : 6);
    const fresh = q ? field.value.trim() : title;
    list.replaceChildren(
      row(`New note: ${fresh}`, "A note with just this picture", icons.plus(), () => void pick(null), " pic-save__row--new"),
      ...(notes.length ? [h("p", { class: "pic-save__label" }, q ? "Matching notes" : "Recent notes")] : []),
      ...notes.map((n) => row(n.title, relative(n.updated_at), icons.note(), () => void pick({ id: n.id, title: n.title }))),
      ...(q && !notes.length ? [h("p", { class: "pic-save__none" }, "No notes with that in the title.")] : []),
    );
    // "New note" takes what's typed as its name.
    newTitle = fresh;
  };
  let newTitle = title;
  const newNote = async (fallback: string) => {
    const name = (newTitle || fallback).slice(0, 120);
    if (isSampleMode()) return { id: `sample-pic-${crypto.randomUUID()}`, title: name };
    const n = await createNote({ title: name, body: "", type: "note", tags: [], source: "app" } as Parameters<typeof createNote>[0]);
    return { id: n.id, title: n.title || name };
  };
  field.addEventListener("input", paint);
  paint();
  // A phone keeps the keyboard down until asked: the list is the quick path.
  if (matchMedia("(pointer: fine)").matches) field.focus();
}

function relative(iso: string): string {
  const days = Math.round((Date.now() - Date.parse(iso)) / 86_400_000);
  if (days <= 0) return "Today";
  if (days === 1) return "Yesterday";
  if (days < 7) return `${days} days ago`;
  return new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short" }).format(new Date(iso));
}

// ---------- Which model answered ----------

/**
 * Under a reply: "Answered with Gemini 3.5 Flash" when it isn't the default, and when the chosen model didn't
 * answer, "Gemini 3.5 Flash didn't answer, so Claude Sonnet 5.5 did" (without `tried`: "Your chosen model didn't
 * answer…"). Nothing for the default, or a reply that doesn't say.
 */
export function modelLine(reply: ModelNote | null | undefined): HTMLElement | null {
  const ref = reply?.model;
  if (!ref) return null;
  if (reply!.fell_back) {
    // The model that didn't answer, by name, when the reply says (`tried`).
    return h("p", { class: "answer__model answer__model--fell" }, icons.refresh(), h("span", {}, fellBackLine(ref, reply!.tried)));
  }
  if (sameRef(ref, DEFAULT_MODELS.think)) return null;
  return h("p", { class: "answer__model" }, h("span", {}, `Answered with ${modelLabel(ref)}`));
}

// ---------- Sample mode ----------

/**
 * Sample mode has no picture model. It paints two pictures on the device so the feature can be seen: a lighthouse
 * at dusk, and the same at night when asked to change it. Which model it says made them, or that pictures are off,
 * follows the sample's AI models settings (db/sample-models.ts; owner, 17 Nov 2026): Settings, AI models, Pictures.
 * Staging for screenshots, like ask-sample-faults.ts:
 *
 *   sessionStorage.setItem("athena.ask.sampleFellBack", "gemini")    // the next reply fell back from Gemini to Claude
 */
const PICTURE_WORDS = /\b(draw|paint|sketch|illustrat\w*|picture|image|drawing|painting)\b/i;
const CHANGE_WORDS = /\b(make it|change it|turn it|now make|same (?:one|picture)|instead|at night|night ?time|darker|brighter|add (?:a|some|the))\b/i;

/** The sample's picture model for this chat: an assistant's own (null is "No pictures"), else the owner's, else off. */
export async function samplePictureModel(assistantId: string | null): Promise<ModelRef | null> {
  return pictureModelFor((await loadModels().catch(() => null))?.effective, assistantId);
}

/** A staged fall-back for the next sample reply: the model it fell back from. */
export function takeSampleFellBack(): ModelNote | null {
  try {
    const from = sessionStorage.getItem("athena.ask.sampleFellBack");
    if (!from) return null;
    sessionStorage.removeItem("athena.ask.sampleFellBack");
    return { model: DEFAULT_MODELS.think, fell_back: true, tried: { provider: "gemini", model: "gemini-3.5-flash" } };
  } catch {
    return null;
  }
}

/** Is this message asking sample mode for a picture, or to change the last one? */
export function samplePictureAsk(q: string, last: ShownPicture | null): "make" | "change" | null {
  if (last && CHANGE_WORDS.test(q)) return "change";
  return PICTURE_WORDS.test(q) && /\b(draw|paint|sketch|make|create|illustrat|picture of|image of|can you)\b/i.test(q) ? "make" : null;
}

/** Paint a sample picture and keep it on the device, as a made picture would be kept in the conversation. */
export async function paintSamplePicture(kind: "dusk" | "night"): Promise<AskFile> {
  const W = 1024;
  const c = document.createElement("canvas");
  c.width = c.height = W;
  const g = c.getContext("2d")!;
  paintLighthouse(g, W, kind === "night");
  const blob = await new Promise<Blob>((r) => c.toBlob((b) => r(b!), "image/jpeg", 0.9));
  const t = document.createElement("canvas");
  t.width = t.height = 480;
  t.getContext("2d")!.drawImage(c, 0, 0, 480, 480);
  const thumb = await new Promise<Blob>((r) => t.toBlob((b) => r(b!), "image/jpeg", 0.82));
  const id = crypto.randomUUID();
  await cacheFile(id, blob, thumb);
  const name = kind === "night" ? "The lighthouse at night.jpg" : "A red lighthouse at dusk.jpg";
  return { id, name, type: "image/jpeg", size: blob.size, width: W, height: W, has_thumb: true };
}

export const SAMPLE_PROMPTS = {
  dusk: { prompt: "A red-and-white lighthouse on a cliff above a calm sea at dusk, soft watercolour, warm peach sky", alt: "A red-and-white lighthouse on a cliff above a calm sea at dusk, in soft watercolour." },
  night: { prompt: "The same lighthouse at night, its beam across the sea, under a starry sky and a crescent moon", alt: "The same lighthouse at night, its beam crossing the sea under stars and a crescent moon." },
};

/** A small watercolour on a canvas: sky, sun or moon, sea, cliff and a lighthouse. Seeded, so it's the same each time. */
function paintLighthouse(g: CanvasRenderingContext2D, W: number, night: boolean): void {
  let seed = night ? 7 : 3;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  const horizon = W * 0.62;
  const sky = g.createLinearGradient(0, 0, 0, horizon);
  if (night) {
    sky.addColorStop(0, "#0b1230");
    sky.addColorStop(0.6, "#1d2b5c");
    sky.addColorStop(1, "#3a4a7d");
  } else {
    sky.addColorStop(0, "#5d6fb3");
    sky.addColorStop(0.45, "#c98fa3");
    sky.addColorStop(0.8, "#f4b98a");
    sky.addColorStop(1, "#fbd9a8");
  }
  g.fillStyle = sky;
  g.fillRect(0, 0, W, horizon + 2);
  if (night) {
    for (let i = 0; i < 160; i++) {
      const r = rnd() * 1.6 + 0.4;
      g.fillStyle = `rgba(255,255,240,${0.35 + rnd() * 0.6})`;
      g.beginPath();
      g.arc(rnd() * W, rnd() * horizon * 0.9, r, 0, Math.PI * 2);
      g.fill();
    }
    // A crescent moon.
    g.fillStyle = "#f6efd2";
    g.beginPath();
    g.arc(W * 0.74, W * 0.18, 46, 0, Math.PI * 2);
    g.fill();
    g.fillStyle = "#121b40";
    g.beginPath();
    g.arc(W * 0.755 + 20, W * 0.17, 42, 0, Math.PI * 2);
    g.fill();
  } else {
    const sun = g.createRadialGradient(W * 0.3, horizon - 30, 10, W * 0.3, horizon - 30, 240);
    sun.addColorStop(0, "rgba(255,240,200,0.95)");
    sun.addColorStop(0.25, "rgba(255,206,150,0.6)");
    sun.addColorStop(1, "rgba(255,190,140,0)");
    g.fillStyle = sun;
    g.fillRect(0, 0, W, horizon);
  }
  // Watercolour clouds: soft blobs.
  for (let i = 0; i < 18; i++) {
    const x = rnd() * W;
    const y = rnd() * horizon * 0.7;
    const r = 60 + rnd() * 120;
    const cl = g.createRadialGradient(x, y, 0, x, y, r);
    cl.addColorStop(0, night ? "rgba(120,140,200,0.12)" : "rgba(255,235,225,0.28)");
    cl.addColorStop(1, "rgba(255,255,255,0)");
    g.fillStyle = cl;
    g.beginPath();
    g.ellipse(x, y, r * 1.8, r * 0.5, 0, 0, Math.PI * 2);
    g.fill();
  }
  // The sea.
  const sea = g.createLinearGradient(0, horizon, 0, W);
  sea.addColorStop(0, night ? "#25335f" : "#7c8fc0");
  sea.addColorStop(1, night ? "#0c1430" : "#3e4f86");
  g.fillStyle = sea;
  g.fillRect(0, horizon, W, W - horizon);
  for (let i = 0; i < 90; i++) {
    const y = horizon + 6 + rnd() * (W - horizon);
    const x = rnd() * W;
    g.strokeStyle = night ? `rgba(180,200,255,${0.06 + rnd() * 0.12})` : `rgba(255,225,190,${0.12 + rnd() * 0.25})`;
    g.lineWidth = 2 + rnd() * 2;
    g.beginPath();
    g.moveTo(x, y);
    g.lineTo(x + 30 + rnd() * 80, y);
    g.stroke();
  }
  // The cliff.
  g.fillStyle = night ? "#0d1424" : "#3b3346";
  g.beginPath();
  g.moveTo(W * 0.48, W);
  g.bezierCurveTo(W * 0.55, W * 0.7, W * 0.62, W * 0.58, W * 0.72, W * 0.56);
  g.lineTo(W, W * 0.53);
  g.lineTo(W, W);
  g.closePath();
  g.fill();
  g.fillStyle = night ? "#17233a" : "#5a5a52";
  g.beginPath();
  g.moveTo(W * 0.62, W * 0.6);
  g.bezierCurveTo(W * 0.68, W * 0.56, W * 0.8, W * 0.55, W, W * 0.545);
  g.lineTo(W, W * 0.58);
  g.bezierCurveTo(W * 0.85, W * 0.6, W * 0.72, W * 0.62, W * 0.62, W * 0.6);
  g.fill();
  // The lighthouse.
  const lx = W * 0.8;
  const base = W * 0.555;
  const top = W * 0.3;
  const bw = 56;
  const tw = 38;
  g.save();
  g.beginPath();
  g.moveTo(lx - bw / 2, base);
  g.lineTo(lx - tw / 2, top);
  g.lineTo(lx + tw / 2, top);
  g.lineTo(lx + bw / 2, base);
  g.closePath();
  g.clip();
  const stripes = 5;
  for (let i = 0; i < stripes; i++) {
    g.fillStyle = i % 2 ? (night ? "#c9cbd6" : "#f5efe6") : night ? "#8a2f3a" : "#c8453f";
    g.fillRect(lx - bw, top + ((base - top) / stripes) * i, bw * 2, (base - top) / stripes + 1);
  }
  g.restore();
  g.fillStyle = night ? "#1a1f2e" : "#2f2a35";
  g.fillRect(lx - tw / 2 - 8, top - 6, tw + 16, 8);
  g.fillStyle = night ? "#ffe7a0" : "#ffe1a8";
  g.fillRect(lx - tw / 2 + 4, top - 40, tw - 8, 34);
  g.fillStyle = night ? "#1a1f2e" : "#2f2a35";
  g.beginPath();
  g.moveTo(lx - tw / 2 - 4, top - 40);
  g.lineTo(lx, top - 70);
  g.lineTo(lx + tw / 2 + 4, top - 40);
  g.fill();
  // Its light: a glow, and at night a beam across the water.
  const glow = g.createRadialGradient(lx, top - 22, 4, lx, top - 22, night ? 200 : 90);
  glow.addColorStop(0, "rgba(255,240,190,0.9)");
  glow.addColorStop(1, "rgba(255,240,190,0)");
  g.fillStyle = glow;
  g.beginPath();
  g.arc(lx, top - 22, night ? 200 : 90, 0, Math.PI * 2);
  g.fill();
  if (night) {
    const beam = g.createLinearGradient(lx, top - 22, W * 0.05, top + 60);
    beam.addColorStop(0, "rgba(255,240,190,0.55)");
    beam.addColorStop(1, "rgba(255,240,190,0)");
    g.fillStyle = beam;
    g.beginPath();
    g.moveTo(lx, top - 30);
    g.lineTo(0, top - 120);
    g.lineTo(0, top + 110);
    g.lineTo(lx, top - 14);
    g.fill();
  }
  // Paper: a fine grain over everything, as watercolour on rough paper.
  const grain = g.getImageData(0, 0, W, W);
  for (let i = 0; i < grain.data.length; i += 4) {
    const n = (rnd() - 0.5) * 14;
    grain.data[i] += n;
    grain.data[i + 1] += n;
    grain.data[i + 2] += n;
  }
  g.putImageData(grain, 0, 0);
}
