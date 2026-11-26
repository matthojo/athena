/**
 * Files in Ask and on notes: photos (the phone camera too), screenshots,
 * PDFs and Markdown/text (lib/files.ts on the server).
 *
 * - On the device, a photo is shrunk before it uploads: at most 1568px on
 *   its long edge and about 1.15 megapixels (what Claude reads without
 *   scaling it again), JPEG (PNG stays PNG, for crisp screenshots), with a
 *   480px preview. Any file is at most 4 MB; five go with one message.
 * - Bytes are cached on the device (Cache Storage, "athena-files-v1"), so
 *   a file opens offline once it's been seen here, and sample mode keeps
 *   everything here and nothing on a server.
 * - The composer tray (composerFiles) uploads as soon as a file is picked.
 *   Offline, files wait in the tray and upload when the connection is back;
 *   the typed question is never cleared until it's sent.
 * - A note's Files section (noteFilesSection): add, open, remove (with Undo).
 */

import { h, svg } from "../lib/dom";
import { icons } from "./icons";
import { showToast } from "./toast";
import {
  ApiError,
  attachNoteFile,
  detachNoteFile,
  fetchFileBlob,
  fetchNoteFiles,
  isSampleMode,
  removeFileFromThread,
  uploadFile,
} from "../db/api";
import { markFilesRemoved } from "../db/ask-threads";
import type { AskFile } from "../types";
import { DOCX_TYPE } from "../../../lib/assignment-types";
import "../styles/attachments.css";

// ---------- Limits ----------

export const MAX_FILE_BYTES = 4 * 1024 * 1024;
export const MAX_FILES = 5;
// About 2.5 megapixels: sharper photos, about 3,300 tokens each.
const MAX_EDGE = 2576;
const MAX_PIXELS = 2_500_000;
const THUMB_EDGE = 480;

/** What the picker offers. iOS adds Take Photo and Photo Library for image/*. */
export const FILE_ACCEPT = "image/*,application/pdf,.pdf,.md,.markdown,.txt,text/plain,text/markdown";

// ---------- Icons (24px grid, 1.7px stroke, like components/icons.ts) ----------

const line = (inner: string) =>
  svg(`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${inner}</svg>`);
export const fileIcons = {
  clip: () => line(`<path d="M15.5 7.5 9 14a2.1 2.1 0 0 0 3 3l6.8-6.8a4.2 4.2 0 0 0-6-6L5.9 11.1a6.3 6.3 0 0 0 8.9 8.9L20 14.8"/>`),
  doc: () => line(`<path d="M14 3.5H8A2.5 2.5 0 0 0 5.5 6v12A2.5 2.5 0 0 0 8 20.5h8a2.5 2.5 0 0 0 2.5-2.5V8z"/><path d="M14 3.5V8h4.5"/><path d="M9 12.5h6M9 15.5h4"/>`),
  image: () => line(`<rect x="3.5" y="5" width="17" height="14" rx="2.5"/><circle cx="9" cy="10" r="1.6"/><path d="m20.5 15.5-4.2-4.2a1 1 0 0 0-1.4 0L7 19"/>`),
  download: () => line(`<path d="M12 4v11M7.5 10.5 12 15l4.5-4.5M5 19.5h14"/>`),
};

// ---------- Describing a file ----------

export const isImage = (f: Pick<AskFile, "type">) => f.type.startsWith("image/");
export const isPdf = (f: Pick<AskFile, "type">) => f.type === "application/pdf";
/** A Word document made from a note (lib/document-make-db.ts). */
const isWord = (f: Pick<AskFile, "type">) => f.type === DOCX_TYPE;

function bytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / 1024 / 1024).toFixed(n < 10 * 1024 * 1024 ? 1 : 0)} MB`;
}

/** "PDF · 2 pages", "Markdown · 3 KB", "Photo · 1.2 MB". */
export function fileDetail(f: AskFile): string {
  if (isPdf(f)) return f.pages ? `PDF · ${f.pages === 1 ? "1 page" : `${f.pages} pages`}` : `PDF · ${bytes(f.size)}`;
  if (f.type === "text/markdown") return `Markdown · ${bytes(f.size)}`;
  if (f.type.startsWith("text/")) return `Text · ${bytes(f.size)}`;
  if (isWord(f)) return `Word · ${bytes(f.size)}`;
  return `Photo · ${bytes(f.size)}`;
}

/** For screen readers: "receipt.pdf, PDF, 2 pages". */
const spoken = (f: AskFile) => `${f.name}, ${fileDetail(f).replace(" · ", ", ")}`;

// ---------- Getting a file ready (on the device) ----------

export interface Prepared {
  meta: AskFile;
  blob: Blob;
  thumb: Blob | null;
}

const TEXT_EXT = /\.(md|markdown|txt|text)$/i;

function typeOf(file: File): string | null {
  const t = file.type.toLowerCase();
  if (t.startsWith("image/")) return t;
  if (t === "application/pdf" || /\.pdf$/i.test(file.name)) return "application/pdf";
  if (t === "text/markdown" || /\.(md|markdown)$/i.test(file.name)) return "text/markdown";
  if (t === "text/plain" || TEXT_EXT.test(file.name)) return "text/plain";
  return null;
}

const canvasBlob = (canvas: HTMLCanvasElement, type: string, quality?: number) =>
  new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, type, quality));

async function draw(bitmap: ImageBitmap, scale: number, type: string, quality: number): Promise<Blob | null> {
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(bitmap.width * scale));
  canvas.height = Math.max(1, Math.round(bitmap.height * scale));
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  if (type === "image/jpeg") {
    // Transparent PNGs and GIFs on white, not black.
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
  }
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  return canvasBlob(canvas, type, quality);
}

const renamed = (name: string, type: string) => name.replace(/\.[a-z0-9]{2,5}$/i, "") + (type === "image/png" ? ".png" : ".jpg");

/** Count a PDF's pages from its page objects (what the server does too). */
async function pdfPages(blob: Blob): Promise<number | null> {
  try {
    const text = new TextDecoder("latin1").decode(await blob.arrayBuffer());
    const n = (text.match(/\/Type\s*\/Page(?![s\w])/g) ?? []).length;
    return n || null;
  } catch {
    return null;
  }
}

/** Check a picked file and shrink a photo. Resolves to the file ready to send, or what's wrong in a sentence. */
export async function prepareFile(file: File): Promise<Prepared | { error: string }> {
  const type = typeOf(file);
  const name = file.name || "Photo";
  if (!type) return { error: `${name} isn't a photo, PDF or text file.` };
  const id = crypto.randomUUID();
  if (type.startsWith("image/")) {
    let bitmap: ImageBitmap;
    try {
      bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
    } catch {
      return { error: `Athena can't open ${name}. Try a JPEG or PNG.` };
    }
    const { width, height } = bitmap;
    const scale = Math.min(1, MAX_EDGE / Math.max(width, height), Math.sqrt(MAX_PIXELS / (width * height)));
    const outType = type === "image/png" ? "image/png" : "image/jpeg";
    let blob = await draw(bitmap, scale, outType, 0.85);
    if (blob && blob.size > MAX_FILE_BYTES) blob = await draw(bitmap, scale, "image/jpeg", 0.82);
    const thumb = await draw(bitmap, Math.min(1, THUMB_EDGE / Math.max(width, height)), "image/jpeg", 0.78);
    bitmap.close();
    if (!blob) return { error: `Athena can't open ${name}. Try a JPEG or PNG.` };
    const finalType = blob.type || outType;
    return {
      meta: { id, name: renamed(name, finalType), type: finalType, size: blob.size, width: Math.round(width * scale), height: Math.round(height * scale), has_thumb: !!thumb },
      blob,
      thumb,
    };
  }
  if (file.size > MAX_FILE_BYTES) return { error: `${name} is over 4 MB. Try a smaller copy.` };
  if (!file.size) return { error: `${name} is empty.` };
  const blob = new Blob([await file.arrayBuffer()], { type });
  return { meta: { id, name, type, size: file.size, pages: type === "application/pdf" ? await pdfPages(blob) : null }, blob, thumb: null };
}

// ---------- On this device ----------

const CACHE = "athena-files-v1";
const keyFor = (id: string, thumb: boolean) => `/__files/${id}${thumb ? "/thumb" : ""}`;
const urls = new Map<string, string>();
const loading = new Map<string, Promise<string | null>>();
/** Files the server says are gone (deleted for good with a note, maybe on another device). */
const gone = new Set<string>();
export const isGone = (f: Pick<AskFile, "id" | "removed">) => !!f.removed || gone.has(f.id);

/** Forget a deleted file's copy on this device. */
export async function forgetFile(id: string): Promise<void> {
  gone.add(id);
  for (const thumb of [false, true]) {
    const key = keyFor(id, thumb);
    const url = urls.get(key);
    if (url) URL.revokeObjectURL(url);
    urls.delete(key);
    try {
      await (await caches.open(CACHE)).delete(key);
    } catch {
      // nothing kept
    }
  }
}

/** Keep a file's bytes here (it opens offline, and in sample mode this is the only copy). */
export async function cacheFile(id: string, blob: Blob, thumb?: Blob | null): Promise<void> {
  // Usable at once, before the copy in Cache Storage lands (a tile may paint straight away).
  if (!urls.has(keyFor(id, false))) urls.set(keyFor(id, false), URL.createObjectURL(blob));
  if (thumb && !urls.has(keyFor(id, true))) urls.set(keyFor(id, true), URL.createObjectURL(thumb));
  try {
    const cache = await caches.open(CACHE);
    await cache.put(keyFor(id, false), new Response(blob, { headers: { "Content-Type": blob.type } }));
    if (thumb) await cache.put(keyFor(id, true), new Response(thumb, { headers: { "Content-Type": thumb.type } }));
  } catch {
    // No Cache Storage (a private window): it's fetched again when needed.
  }
}

async function cached(key: string): Promise<Blob | null> {
  try {
    const res = await (await caches.open(CACHE)).match(key);
    return res ? await res.blob() : null;
  } catch {
    return null;
  }
}

/** A URL for a file (or its preview), from here or fetched once through the token. Null when it can't be had right now. */
export function fileUrl(f: AskFile, opts: { thumb?: boolean } = {}): Promise<string | null> {
  if (isGone(f)) return Promise.resolve(null);
  const thumb = !!opts.thumb && !!f.has_thumb;
  const key = keyFor(f.id, thumb);
  const ready = urls.get(key);
  if (ready) return Promise.resolve(ready);
  // No preview of its own: the full file will do.
  if (opts.thumb && !thumb && urls.has(keyFor(f.id, false))) return Promise.resolve(urls.get(keyFor(f.id, false))!);
  let pending = loading.get(key);
  if (!pending) {
    pending = (async () => {
      let blob = await cached(key);
      if (!blob && !isSampleMode() && navigator.onLine) {
        try {
          blob = await fetchFileBlob(f.id, thumb);
          try {
            await (await caches.open(CACHE)).put(key, new Response(blob, { headers: { "Content-Type": blob.type } }));
          } catch {
            // not kept; fine
          }
        } catch (error) {
          if (error instanceof ApiError && error.status === 404) gone.add(f.id);
          blob = null;
        }
      }
      if (!blob) return null;
      const url = URL.createObjectURL(blob);
      urls.set(key, url);
      return url;
    })().finally(() => loading.delete(key));
    loading.set(key, pending);
  }
  return pending;
}

// ---------- Tiles ----------

export type TileState = "ready" | "preparing" | "uploading" | "waiting" | "failed" | "removed";

export interface TileOptions {
  state?: TileState;
  progress?: number;
  /** Shown on a failed tile. */
  error?: string;
  onOpen?: () => void;
  onRemove?: () => void;
  onRetry?: () => void;
  /** "tray": the composer's small tiles; "message": in a bubble; "note": a note's Files. */
  place: "tray" | "message" | "note";
  /** A local copy to show straight away (just picked). */
  preview?: string | null;
}

const ring = (progress: number) => {
  const c = 2 * Math.PI * 9;
  return svg(
    `<svg class="file-tile__ring" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" stroke-opacity=".25" stroke-width="2.4"/><circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-dasharray="${c.toFixed(2)}" stroke-dashoffset="${(c * (1 - Math.max(0.04, Math.min(1, progress)))).toFixed(2)}" transform="rotate(-90 12 12)"/></svg>`
  );
};

const STATE_WORDS: Record<TileState, string> = {
  ready: "",
  preparing: "Getting it ready",
  uploading: "Uploading",
  waiting: "Waiting to upload",
  failed: "Didn't upload",
  removed: "Deleted",
};

/** One file: a picture for a photo, a card with its name for anything else. */
export function fileTile(f: AskFile, opts: TileOptions): HTMLElement {
  const state: TileState = isGone(f) ? "removed" : (opts.state ?? "ready");
  // A deleted photo has nothing left to show: it becomes a card with its name.
  const image = isImage(f) && state !== "removed";
  const body = h("button", {
    class: "file-tile__body",
    type: "button",
    "aria-label": state === "failed" ? `${f.name}: didn't upload. Try again` : state === "removed" ? `${f.name}: deleted` : `${state === "ready" ? "Open" : STATE_WORDS[state]}: ${spoken(f)}`,
    ...(state === "removed" ? { "aria-disabled": "true" } : {}),
  });
  if (image) {
    const img = h("img", { class: "file-tile__img", alt: "", decoding: "async", draggable: "false" }) as HTMLImageElement;
    if (f.width && f.height) img.style.aspectRatio = `${f.width} / ${f.height}`;
    const show = (url: string | null) => {
      // The server says it's gone: show it as deleted, in place.
      if (!url && gone.has(f.id)) return void tile.replaceWith(fileTile(f, opts));
      if (!url) return body.classList.add("is-missing");
      img.src = url;
      img.addEventListener("load", () => body.classList.add("is-loaded"), { once: true });
    };
    if (opts.preview) show(opts.preview);
    else void fileUrl(f, { thumb: true }).then(show);
    body.append(img, h("span", { class: "file-tile__fallback", "aria-hidden": "true" }, fileIcons.image()));
  } else {
    body.append(
      h(
        "span",
        { class: `file-tile__icon${isPdf(f) && state !== "removed" ? " file-tile__icon--pdf" : ""}`, "aria-hidden": "true" },
        state === "removed" && isImage(f) ? fileIcons.image() : fileIcons.doc(),
        state === "removed" && isImage(f) ? null : h("span", { class: "file-tile__ext" }, isPdf(f) ? "PDF" : isWord(f) ? "DOCX" : f.type === "text/markdown" ? "MD" : "TXT")
      ),
      h("span", { class: "file-tile__text" }, h("span", { class: "file-tile__name" }, f.name), h("span", { class: "file-tile__meta" }, state === "ready" ? fileDetail(f) : STATE_WORDS[state]))
    );
  }
  if (state === "uploading" || state === "preparing") body.append(h("span", { class: "file-tile__busy", "aria-hidden": "true" }, ring(opts.progress ?? 0.04)));
  if (state === "waiting") body.append(h("span", { class: "file-tile__badge", "aria-hidden": "true" }, icons.wifiOff()));
  if (state === "failed") body.append(h("span", { class: "file-tile__badge file-tile__badge--bad", "aria-hidden": "true" }, icons.refresh()));
  body.addEventListener("click", () => (state === "failed" ? opts.onRetry?.() : state === "ready" ? opts.onOpen?.() : undefined));

  const tile = h("div", { class: `file-tile file-tile--${opts.place} file-tile--${image ? "image" : "doc"}`, "data-state": state, "data-id": f.id, title: state === "removed" ? `${f.name} was deleted` : (opts.error ?? f.name) }, body);
  if (opts.onRemove) {
    const x = h("button", { class: "file-tile__remove", type: "button", "aria-label": `Remove ${f.name}` }, icons.close());
    x.addEventListener("click", (e) => {
      e.stopPropagation();
      opts.onRemove?.();
    });
    tile.append(x);
  }
  return tile;
}

/** A message's files: photos as a small gallery, documents as cards beneath. */
export function messageFiles(files: AskFile[]): HTMLElement {
  const photos = files.filter((f) => isImage(f) && !isGone(f));
  const docs = files.filter((f) => !isImage(f) || isGone(f));
  const open = (f: AskFile) => () => openFileViewer(f, files.filter((x) => !isGone(x)));
  return h(
    "div",
    { class: "msg-files", "data-photos": String(Math.min(photos.length, 4)) },
    photos.length ? h("div", { class: "msg-files__photos" }, ...photos.map((f) => fileTile(f, { place: "message", onOpen: open(f) }))) : null,
    ...docs.map((f) => fileTile(f, { place: "message", onOpen: open(f) }))
  );
}

// ---------- Opening one ----------

let viewer: HTMLDialogElement | null = null;

/** A file full size: a photo, a PDF, or text to read; Download, and Open for a PDF. Arrows step through `set`. */
export function openFileViewer(f: AskFile, set: AskFile[] = [f]): void {
  viewer?.close();
  const list = set.length ? set : [f];
  let index = Math.max(0, list.findIndex((x) => x.id === f.id));
  const title = h("p", { class: "viewer__name" });
  const meta = h("p", { class: "viewer__meta" });
  const stage = h("div", { class: "viewer__stage" });
  const download = h("a", { class: "btn btn--soft btn--sm viewer__action", download: "" }, fileIcons.download(), "Download") as HTMLAnchorElement;
  const openPdf = h("a", { class: "btn btn--soft btn--sm viewer__action", target: "_blank", rel: "noopener" }, icons.external(), "Open") as HTMLAnchorElement;
  const close = h("button", { class: "icon-btn icon-btn--sm viewer__close", type: "button", "aria-label": "Close" }, icons.close());
  const prev = h("button", { class: "icon-btn viewer__step viewer__step--prev", type: "button", "aria-label": "Previous file" }, icons.back());
  const next = h("button", { class: "icon-btn viewer__step viewer__step--next", type: "button", "aria-label": "Next file" }, icons.chevronRight());
  const dialog = h(
    "dialog",
    { class: "viewer", "aria-label": f.name },
    h("header", { class: "viewer__head" }, h("div", { class: "viewer__title" }, title, meta), h("div", { class: "viewer__actions" }, openPdf, download, close)),
    stage,
    list.length > 1 ? prev : null,
    list.length > 1 ? next : null
  ) as HTMLDialogElement;

  let seq = 0;
  async function show() {
    const file = list[index];
    const mine = ++seq;
    dialog.setAttribute("aria-label", file.name);
    title.textContent = file.name;
    meta.textContent = list.length > 1 ? `${fileDetail(file)} · ${index + 1} of ${list.length}` : fileDetail(file);
    stage.replaceChildren(h("div", { class: "viewer__loading", role: "status" }, ring(0.3), h("span", {}, "Opening…")));
    download.hidden = openPdf.hidden = true;
    prev.toggleAttribute("disabled", index === 0);
    next.toggleAttribute("disabled", index === list.length - 1);
    const url = await fileUrl(file);
    if (mine !== seq) return;
    if (!url) {
      const deleted = isGone(file);
      stage.replaceChildren(
        h("div", { class: "viewer__empty" }, deleted ? icons.trash() : icons.wifiOff(), h("p", {}, deleted ? `${file.name} was deleted.` : navigator.onLine ? "This file won't open." : "You're offline. This file opens once you're back online."))
      );
      return;
    }
    download.href = url;
    download.download = file.name;
    download.hidden = false;
    if (isImage(file)) {
      const img = h("img", { class: "viewer__img", src: url, alt: file.name }) as HTMLImageElement;
      stage.replaceChildren(img);
    } else if (isPdf(file)) {
      openPdf.href = url;
      openPdf.hidden = false;
      // A browser that can't show PDFs inline gets a card with the two ways to open it, not a blank page.
      stage.replaceChildren(
        navigator.pdfViewerEnabled === false
          ? h(
              "div",
              { class: "viewer__card" },
              h("span", { class: "file-tile__icon file-tile__icon--pdf viewer__card-icon", "aria-hidden": "true" }, fileIcons.doc(), h("span", { class: "file-tile__ext" }, "PDF")),
              h("p", { class: "viewer__card-name" }, file.name),
              h("p", { class: "viewer__meta" }, fileDetail(file)),
              h("div", { class: "viewer__card-actions" }, openPdf.cloneNode(true), download.cloneNode(true))
            )
          : h("iframe", { class: "viewer__pdf", src: url, title: file.name })
      );
      if (navigator.pdfViewerEnabled === false) openPdf.hidden = download.hidden = true;
    } else if (isWord(file)) {
      // Nothing here draws a Word document: its name, and Download in the header.
      stage.replaceChildren(
        h("div", { class: "viewer__card" }, h("span", { class: "file-tile__icon viewer__card-icon", "aria-hidden": "true" }, fileIcons.doc(), h("span", { class: "file-tile__ext" }, "DOCX")), h("p", { class: "viewer__card-name" }, file.name), h("p", { class: "viewer__meta" }, fileDetail(file)))
      );
    } else {
      const text = await (await fetch(url)).text();
      if (mine !== seq) return;
      stage.replaceChildren(h("pre", { class: "viewer__text" }, text));
    }
  }

  const step = (by: number) => {
    const to = index + by;
    if (to < 0 || to >= list.length) return;
    index = to;
    void show();
  };
  prev.addEventListener("click", () => step(-1));
  next.addEventListener("click", () => step(1));
  close.addEventListener("click", () => dialog.close());
  dialog.addEventListener("click", (e) => {
    if (e.target === dialog || e.target === stage) dialog.close();
  });
  dialog.addEventListener("keydown", (e) => {
    if (e.key === "ArrowLeft") step(-1);
    else if (e.key === "ArrowRight") step(1);
  });
  // Swipe sideways between files, down to close.
  let start: { x: number; y: number } | null = null;
  stage.addEventListener("pointerdown", (e) => (start = { x: e.clientX, y: e.clientY }));
  stage.addEventListener("pointerup", (e) => {
    if (!start) return;
    const dx = e.clientX - start.x;
    const dy = e.clientY - start.y;
    start = null;
    if (Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(dy)) step(dx < 0 ? 1 : -1);
    else if (dy > 90 && Math.abs(dy) > Math.abs(dx)) dialog.close();
  });
  dialog.addEventListener("close", () => {
    dialog.remove();
    if (viewer === dialog) viewer = null;
  });
  document.body.append(dialog);
  viewer = dialog;
  dialog.showModal();
  close.focus();
  void show();
}

// ---------- The composer's files (Ask) ----------

interface Pending {
  meta: AskFile;
  blob: Blob;
  thumb: Blob | null;
  preview: string | null;
  state: TileState;
  progress: number;
  error?: string;
  /** The conversation it was uploaded for. */
  thread: string | null;
  abort?: AbortController;
}

/** Kept across tab switches, like the conversation on screen: what's in the tray waits for you. */
let tray: Pending[] = [];
let activePaint: (() => void) | null = null;

export interface ComposerFiles {
  /** The paperclip, for the composer bar. */
  button: HTMLButtonElement;
  /** The tray of picked files (empty when there are none). */
  el: HTMLElement;
  /** The offline / problem line under the tray. */
  status: HTMLElement;
  count(): number;
  /** Every file is uploaded (or in sample mode, ready here). */
  ready(): boolean;
  /** Take the files for the message being sent; the tray empties. */
  take(): AskFile[];
  /** The files waiting to go, without taking them (the box checks the model can see them). */
  peek(): AskFile[];
  /** Add files (picked, pasted or dropped). */
  add(files: Iterable<File>): Promise<void>;
  destroy(): void;
}

export function composerFiles(opts: { thread: () => string; onChange: () => void }): ComposerFiles {
  const picker = h("input", { type: "file", accept: FILE_ACCEPT, multiple: true, hidden: true, tabindex: -1 }) as HTMLInputElement;
  const button = h(
    "button",
    { class: "attach-btn", type: "button", "aria-label": "Add a photo or file", title: "Add a photo or file" },
    fileIcons.clip(),
    picker
  ) as HTMLButtonElement;
  const el = h("div", { class: "composer-files", role: "list", "aria-label": "Files to send" });
  const status = h("p", { class: "composer-files__status", role: "status", hidden: true });
  let destroyed = false;
  // An upload can finish after a tab switch: it repaints whichever tray is on screen then.
  const repaint = () => activePaint?.();

  button.addEventListener("click", (e) => {
    if (e.target === picker) return;
    picker.click();
  });
  picker.addEventListener("change", () => {
    const files = [...(picker.files ?? [])];
    picker.value = "";
    void add(files);
  });

  function paint(notify = true) {
    if (destroyed) return;
    el.replaceChildren(
      ...tray.map((p) =>
        h(
          "div",
          { role: "listitem" },
          fileTile(p.meta, {
            place: "tray",
            state: p.state,
            progress: p.progress,
            error: p.error,
            preview: p.preview,
            onOpen: () => openFileViewer(p.meta, tray.map((x) => x.meta)),
            onRemove: () => remove(p),
            onRetry: () => void upload(p),
          })
        )
      )
    );
    el.hidden = !tray.length;
    const waiting = tray.some((p) => p.state === "waiting");
    const failed = tray.find((p) => p.state === "failed");
    status.hidden = !waiting && !failed;
    status.classList.toggle("is-bad", !waiting && !!failed);
    status.replaceChildren(
      ...(waiting
        ? [icons.wifiOff(), h("span", {}, "You're offline. Your files will upload when you're back, and your question is saved.")]
        : failed
          ? [icons.close(), h("span", {}, failed.error ?? "A file didn't upload. Tap it to try again.")]
          : [])
    );
    button.disabled = tray.length >= MAX_FILES;
    if (notify) opts.onChange();
  }

  async function add(files: Iterable<File>) {
    const list = [...files];
    if (!list.length) return;
    const room = MAX_FILES - tray.length;
    if (room <= 0 || list.length > room) showToast(`Up to ${MAX_FILES} files per message`, { icon: "close" });
    for (const file of list.slice(0, Math.max(0, room))) {
      // A placeholder tile while a photo shrinks.
      const placeholder: Pending = {
        meta: { id: crypto.randomUUID(), name: file.name || "Photo", type: file.type || "application/octet-stream", size: file.size },
        blob: file,
        thumb: null,
        preview: null,
        state: "preparing",
        progress: 0.15,
        thread: null,
      };
      tray.push(placeholder);
      repaint();
      const ready = await prepareFile(file);
      const at = tray.indexOf(placeholder);
      if (at < 0) continue;
      if ("error" in ready) {
        tray.splice(at, 1);
        repaint();
        showToast(ready.error, { icon: "close" });
        continue;
      }
      const p: Pending = { ...placeholder, meta: ready.meta, blob: ready.blob, thumb: ready.thumb, preview: URL.createObjectURL(ready.thumb ?? ready.blob), state: "uploading", progress: 0.04 };
      tray[at] = p;
      void cacheFile(p.meta.id, p.blob, p.thumb);
      void upload(p);
    }
  }

  async function upload(p: Pending) {
    if (isSampleMode()) {
      p.state = "ready";
      p.progress = 1;
      return repaint();
    }
    if (!navigator.onLine) {
      p.state = "waiting";
      return repaint();
    }
    p.state = "uploading";
    p.progress = 0.04;
    p.error = undefined;
    p.thread = opts.thread();
    p.abort = new AbortController();
    repaint();
    try {
      const meta = await uploadFile(
        { id: p.meta.id, file: p.blob, name: p.meta.name, thumb: p.thumb, width: p.meta.width ?? undefined, height: p.meta.height ?? undefined, link: { thread: p.thread } },
        (fraction) => {
          p.progress = Math.max(p.progress, fraction * 0.96);
          const ringEl = document.querySelector(`.composer-files [data-id="${p.meta.id}"] .file-tile__ring`);
          if (!ringEl) repaint();
          else ringEl.replaceWith(ring(p.progress));
        },
        p.abort.signal
      );
      if (!tray.includes(p)) return;
      p.meta = { ...p.meta, ...meta };
      p.state = "ready";
      p.progress = 1;
    } catch (error) {
      if (!tray.includes(p) || (error instanceof DOMException && error.name === "AbortError")) return;
      if (!navigator.onLine || (error instanceof ApiError && error.status === 0)) p.state = "waiting";
      else {
        p.state = "failed";
        p.error = error instanceof ApiError && error.status && error.status < 500 ? error.message : "A file didn't upload. Tap it to try again.";
      }
    }
    repaint();
  }

  function remove(p: Pending) {
    tray = tray.filter((x) => x !== p);
    p.abort?.abort();
    if (p.preview) URL.revokeObjectURL(p.preview);
    if (p.state === "ready" && p.thread && !isSampleMode()) void removeFileFromThread(p.meta.id, p.thread).catch(() => undefined);
    repaint();
  }

  // Back online: send what was waiting.
  const onOnline = () => tray.filter((p) => p.state === "waiting").forEach((p) => void upload(p));
  const onOffline = () => {
    for (const p of tray) if (p.state === "uploading") p.state = "waiting";
    repaint();
  };
  window.addEventListener("online", onOnline);
  window.addEventListener("offline", onOffline);

  // Reopened with files still in the tray (a tab switch): show them as they are.
  for (const p of tray) if (p.state === "uploading" && !p.abort) void upload(p);
  activePaint = paint;
  // The host isn't built yet: it paints itself once it is.
  paint(false);

  return {
    button,
    el,
    status,
    count: () => tray.length,
    ready: () => tray.every((p) => p.state === "ready"),
    take() {
      const files = tray.map((p) => p.meta);
      tray = [];
      repaint();
      return files;
    },
    peek: () => tray.map((p) => p.meta),
    add,
    destroy() {
      destroyed = true;
      if (activePaint === paint) activePaint = null;
      window.removeEventListener("online", onOnline);
      window.removeEventListener("offline", onOffline);
    },
  };
}

// ---------- A note's files ----------

const NOTE_KEY = (id: string) => `athena.noteFiles.${id}`;

function rememberNoteFiles(noteId: string, files: AskFile[]) {
  try {
    localStorage.setItem(NOTE_KEY(noteId), JSON.stringify(files));
  } catch {
    // full; it's only the offline copy
  }
}

function rememberedNoteFiles(noteId: string): AskFile[] {
  try {
    return JSON.parse(localStorage.getItem(NOTE_KEY(noteId)) ?? "[]") as AskFile[];
  } catch {
    return [];
  }
}

export interface NoteFilesSection {
  el: HTMLElement;
  /** The note exists (or got its server id): load its files. null = a note not made yet. */
  show(noteId: string | null): void;
  /** What's on the note right now. */
  files(): AskFile[];
  destroy(): void;
}

/** "Files" on a note: what's attached (by you or by Athena), with Add, Open and Remove. */
export function noteFilesSection(opts: { readOnly?: boolean } = {}): NoteFilesSection {
  const picker = h("input", { type: "file", accept: FILE_ACCEPT, multiple: true, hidden: true, tabindex: -1 }) as HTMLInputElement;
  const addBtn = h("button", { class: "btn btn--soft btn--sm note-files__add", type: "button" }, fileIcons.clip(), "Add file") as HTMLButtonElement;
  const grid = h("div", { class: "note-files__grid", role: "list" });
  const hint = h("p", { class: "note__links-empty note-files__hint" });
  const el = h(
    "section",
    { class: "note-files", "aria-label": "Files", hidden: true },
    h("div", { class: "note-files__head" }, h("h2", { class: "group__label" }, "Files"), opts.readOnly ? null : addBtn, picker),
    grid,
    hint
  );
  let noteId: string | null = null;
  let files: AskFile[] = [];
  const busy: Array<{ meta: AskFile; preview: string | null; state: TileState; progress: number }> = [];
  let destroyed = false;
  let seq = 0;

  addBtn.addEventListener("click", () => picker.click());
  picker.addEventListener("change", () => {
    const picked = [...(picker.files ?? [])];
    picker.value = "";
    void add(picked);
  });

  const local = () => !noteId || noteId.startsWith("local-");

  function paint() {
    if (destroyed) return;
    el.hidden = !noteId;
    const offline = !navigator.onLine && !isSampleMode();
    addBtn.disabled = local() || offline;
    for (const id of [...open]) if (!files.some((f) => f.id === id && f.summary)) open.delete(id);
    grid.replaceChildren(
      ...files.flatMap((f) => {
        const cell = h(
          "div",
          { role: "listitem", class: "note-files__cell", "data-id": f.id },
          fileTile(f, { place: "note", onOpen: () => openFileViewer(f, files), onRemove: opts.readOnly ? undefined : () => remove(f) }),
          f.summary ? summaryToggle(f) : null
        );
        return open.has(f.id) && f.summary ? [cell, summaryPanel(f)] : [cell];
      }),
      ...busy.map((b) => h("div", { role: "listitem" }, fileTile(b.meta, { place: "note", state: b.state, progress: b.progress, preview: b.preview })))
    );
    grid.hidden = !files.length && !busy.length;
    placeCarets();
    hint.textContent = local()
      ? "Files can be added once this note has synced."
      : offline
        ? files.length
          ? "You're offline. Files you've viewed on this device still open."
          : "You're offline. Connect to add files."
        : files.length || busy.length
          ? ""
          : "Add a photo, PDF or text file, or ask Athena to attach one from a conversation.";
    hint.hidden = !hint.textContent;
  }

  // ---------- Athena's summary under each file ----------
  // One line under the file; tap for the whole summary, which opens across the
  // full width below that row (the grid packs densely, so the file stays put
  // and the words get room to read). Nothing while it's being written, or if
  // there isn't one.
  const open = new Set<string>();
  const panelId = (f: AskFile) => `file-summary-${f.id}`;
  const still = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  function summaryToggle(f: AskFile): HTMLElement {
    const btn = h(
      "button",
      { class: "file-summary__toggle", type: "button", "aria-expanded": String(open.has(f.id)), "aria-controls": panelId(f), "aria-label": `Athena's summary of ${f.name}` },
      h("span", { class: "file-summary__mark", "aria-hidden": "true" }),
      h("span", { class: "file-summary__line", "aria-hidden": "true" }, f.summary ?? ""),
      h("span", { class: "file-summary__chevron", "aria-hidden": "true" }, icons.chevronDown())
    );
    btn.addEventListener("click", () => toggle(f, btn));
    return btn;
  }

  function summaryPanel(f: AskFile, entering = false): HTMLElement {
    return h(
      "div",
      { role: "listitem", class: `file-summary${entering && !still() ? " is-entering" : ""}`, id: panelId(f), "aria-label": `Athena's summary of ${f.name}` },
      h(
        "div",
        { class: "file-summary__clip" },
        h(
          "div",
          { class: "file-summary__box" },
          h("p", { class: "file-summary__text" }, f.summary ?? ""),
          h("p", { class: "file-summary__note" }, "Ask about anything not in this summary and Athena reads the whole file.")
        )
      )
    );
  }

  function toggle(f: AskFile, btn: HTMLElement) {
    const cell = btn.closest(".note-files__cell");
    const shown = grid.querySelector<HTMLElement>(`#${CSS.escape(panelId(f))}`);
    if (open.has(f.id)) {
      open.delete(f.id);
      btn.setAttribute("aria-expanded", "false");
      if (shown && !still()) {
        shown.classList.add("is-leaving");
        shown.addEventListener("animationend", () => shown.remove(), { once: true });
      } else shown?.remove();
      return;
    }
    open.add(f.id);
    btn.setAttribute("aria-expanded", "true");
    shown?.remove();
    cell?.after(summaryPanel(f, true));
    placeCarets();
  }

  /** Each open summary points up at its file's column. */
  function placeCarets() {
    const left = grid.getBoundingClientRect().left;
    for (const panel of grid.querySelectorAll<HTMLElement>(".file-summary")) {
      const cell = panel.previousElementSibling as HTMLElement | null;
      if (!cell) continue;
      const r = cell.getBoundingClientRect();
      panel.style.setProperty("--caret-x", `${Math.round(r.left - left + r.width / 2)}px`);
    }
  }
  const sized = new ResizeObserver(() => placeCarets());
  sized.observe(grid);

  async function load() {
    if (!noteId || local()) return paint();
    const mine = ++seq;
    files = rememberedNoteFiles(noteId);
    paint();
    if (isSampleMode() || !navigator.onLine) return;
    try {
      const fresh = await fetchNoteFiles(noteId);
      if (mine !== seq || destroyed) return;
      files = fresh;
      rememberNoteFiles(noteId, files);
      paint();
    } catch {
      // Offline or not reachable: the copy here stands.
    }
  }

  async function add(picked: File[]) {
    if (!noteId || local()) return;
    const id = noteId;
    for (const file of picked) {
      const ready = await prepareFile(file);
      if ("error" in ready) {
        showToast(ready.error, { icon: "close" });
        continue;
      }
      void cacheFile(ready.meta.id, ready.blob, ready.thumb);
      if (isSampleMode()) {
        files = [...files, ready.meta];
        rememberNoteFiles(id, files);
        paint();
        continue;
      }
      const b = { meta: ready.meta, preview: URL.createObjectURL(ready.thumb ?? ready.blob), state: "uploading" as TileState, progress: 0.04 };
      busy.push(b);
      paint();
      try {
        const meta = await uploadFile(
          { id: ready.meta.id, file: ready.blob, name: ready.meta.name, thumb: ready.thumb, width: ready.meta.width ?? undefined, height: ready.meta.height ?? undefined, link: { note: id } },
          (fraction) => {
            b.progress = Math.max(b.progress, fraction * 0.96);
            paint();
          }
        );
        if (noteId === id) files = [...files, meta];
        rememberNoteFiles(id, noteId === id ? files : [...rememberedNoteFiles(id), meta]);
      } catch (error) {
        showToast(error instanceof ApiError && error.status && error.status < 500 ? error.message : `${ready.meta.name} didn't upload. Try again.`, { icon: "close" });
      }
      busy.splice(busy.indexOf(b), 1);
      paint();
    }
  }

  /** Off the note now; gone from the server once the Undo has had its moment. */
  function remove(f: AskFile) {
    if (!noteId) return;
    const id = noteId;
    const at = files.findIndex((x) => x.id === f.id);
    files = files.filter((x) => x.id !== f.id);
    rememberNoteFiles(id, files);
    paint();
    let undone = false;
    const commit = setTimeout(() => {
      if (undone || isSampleMode()) return;
      void detachNoteFile(id, f.id).catch(() => {
        showToast(`Couldn't remove ${f.name}. Try again.`, { icon: "close" });
        if (noteId === id && !files.some((x) => x.id === f.id)) files.splice(Math.min(at, files.length), 0, f);
        rememberNoteFiles(id, files);
        paint();
      });
    }, 6000);
    showToast(`Removed ${f.name}`, {
      icon: "trash",
      action: {
        label: "Undo",
        run: () => {
          undone = true;
          clearTimeout(commit);
          if (noteId === id && !files.some((x) => x.id === f.id)) files.splice(Math.min(at, files.length), 0, f);
          rememberNoteFiles(id, noteId === id ? files : [...rememberedNoteFiles(id), f]);
          paint();
        },
      },
    });
  }

  const onNet = () => void load();
  window.addEventListener("online", onNet);
  window.addEventListener("offline", paint);

  return {
    el,
    show(id) {
      if (id === noteId) return;
      noteId = id;
      files = [];
      void load();
    },
    files: () => files,
    destroy() {
      destroyed = true;
      sized.disconnect();
      window.removeEventListener("online", onNet);
      window.removeEventListener("offline", paint);
    },
  };
}

// ---------- Deleting a note for good: its files too? (the note view and Archived) ----------

/** A note's files a conversation still has, asked fresh. None offline, in sample mode, or if the server is slow: the files stay. */
export async function heldNoteFiles(noteId: string): Promise<AskFile[]> {
  if (isSampleMode() || !navigator.onLine) return [];
  const asked = fetchNoteFiles(noteId)
    .then((files) => files.filter((f) => f.in_conversation && !f.removed))
    .catch(() => [] as AskFile[]);
  return Promise.race([asked, new Promise<AskFile[]>((resolve) => setTimeout(() => resolve([]), 2500))]);
}

/** The delete confirm's one extra choice, unticked; ticked, the button says what goes. */
export function deleteFilesChoice(held: AskFile[]): { label: string; detail: string; confirmLabel: string } | undefined {
  if (!held.length) return undefined;
  const one = held.length === 1;
  return {
    label: one ? `Also delete ${held[0].name}` : `Also delete its ${held.length} files`,
    detail: one ? "It's still in a conversation. Leave it unticked to keep it there." : "They're still in your conversations. Leave it unticked to keep them there.",
    confirmLabel: one ? "Delete both" : "Delete all",
  };
}

/** The files went with the note: forget them here, and conversations show them as deleted. Returns the toast's words. */
export async function filesDeletedWithNote(held: AskFile[], deleted: boolean): Promise<string> {
  if (!deleted || !held.length) return "Deleted permanently";
  await Promise.all(held.map((f) => forgetFile(f.id)));
  await markFilesRemoved(held.map((f) => f.id));
  return held.length === 1 ? `Deleted the note and ${held[0].name}` : "Deleted the note and its files";
}

/** Athena attached something to a note from Ask: forget the offline copy of its list, so the note loads it fresh. */
export function noteFilesChanged(noteId: string): void {
  try {
    localStorage.removeItem(NOTE_KEY(noteId));
  } catch {
    // fine
  }
}

/** Put a conversation's file on a note (the note view's own Add uses uploads instead). */
export async function attachExisting(noteId: string, f: AskFile): Promise<void> {
  // Sample mode keeps a note's files on this device.
  if (isSampleMode()) return rememberNoteFiles(noteId, [...rememberedNoteFiles(noteId).filter((x) => x.id !== f.id), f]);
  rememberNoteFiles(noteId, await attachNoteFile(noteId, f.id));
}
