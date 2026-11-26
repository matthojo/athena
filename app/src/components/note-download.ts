/**
 * A note as a file: "Download as Markdown", "Download as Word" and "Print
 * or save as PDF" in its menu.
 *
 * Signed in, the server makes the file and keeps it on the note
 * (lib/document-make-db.ts), so it's under Files afterwards. In sample
 * mode, offline, or for a note that hasn't synced yet, the same code
 * (lib/document-make.ts) makes it on the device and nothing is kept.
 *
 * Print puts a copy of the note (its title and its body as the editor drew
 * it) at the top of the page and prints only that (styles/note-print.css).
 * The browser's print sheet is where "Save as PDF" lives.
 */
import "../styles/note-print.css";
import { h, svg } from "../lib/dom";
import { showToast } from "./toast";
import { ApiError, getToken, isSampleMode, request } from "../db/api";
import { DOCX_TYPE, type DocumentFile, type DocumentFormat } from "../../../lib/assignment-types";

const line = (inner: string) =>
  svg(`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${inner}</svg>`);
export const downloadIcons = {
  download: () => line(`<path d="M12 4v11M7.5 10.5 12 15l4.5-4.5M5 19.5h14"/>`),
  print: () => line(`<path d="M7.5 8.5v-4h9v4"/><rect x="4" y="8.5" width="16" height="8" rx="2"/><path d="M7.5 13.5h9v6h-9z"/>`),
};

const FORMAT_NAME: Record<DocumentFormat, string> = { md: "Markdown", docx: "Word" };
const API_BASE = "/api";

export interface NoteDownload {
  download(format: DocumentFormat): Promise<void>;
  print(): void;
}

/** Hand a file to the browser's own download. */
function saveBlob(blob: Blob, name: string): void {
  const url = URL.createObjectURL(blob);
  const a = h("a", { href: url, download: name, hidden: true }) as HTMLAnchorElement;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

async function madeOnServer(noteId: string, format: DocumentFormat): Promise<{ blob: Blob; name: string }> {
  const { document: made } = await request<{ document: DocumentFile }>(`/notes/${encodeURIComponent(noteId)}/document`, { method: "POST", body: JSON.stringify({ format }) });
  const token = getToken();
  const res = await fetch(`${API_BASE}/files/${encodeURIComponent(made.file_id)}/download`, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
  if (!res.ok) throw new ApiError(`${res.status} ${res.statusText}`, res.status);
  return { blob: await res.blob(), name: made.name };
}

async function madeHere(note: { title: string; body: string }, format: DocumentFormat): Promise<{ blob: Blob; name: string } | null> {
  const { noteDocument, noteMarkdown } = await import("../../../lib/document-make");
  if (!noteMarkdown(note)) return null;
  const { name, bytes } = noteDocument(note, format);
  return { blob: new Blob([bytes as BlobPart], { type: format === "docx" ? DOCX_TYPE : "text/markdown" }), name };
}

export function noteDownload(opts: {
  /** The title as typed ("" when it's only a hint). */
  title: () => string;
  body: () => string;
  save: () => Promise<void>;
  noteId: () => string | null;
  /** Where the editor drew the body. */
  content: () => HTMLElement;
  /** A file was made and kept on the note. */
  onKept?: () => void;
}): NoteDownload {
  async function download(format: DocumentFormat) {
    await opts.save();
    const id = opts.noteId();
    const note = { title: opts.title(), body: opts.body() };
    const local = isSampleMode() || !id || id.startsWith("local-");
    try {
      let made: { blob: Blob; name: string } | null = null;
      let kept = false;
      if (!local) {
        try {
          made = await madeOnServer(id, format);
          kept = true;
        } catch (error) {
          // Offline (fetch itself failed): make it here. Anything the server said is shown as it is.
          if (error instanceof ApiError) throw error;
        }
      }
      made ??= await madeHere(note, format);
      if (!made) {
        showToast("There's nothing in this note yet", { icon: "note" });
        return;
      }
      saveBlob(made.blob, made.name);
      showToast(`Downloaded ${made.name}`, { icon: "check" });
      if (kept) opts.onKept?.();
    } catch (error) {
      showToast(error instanceof ApiError ? error.message : `Couldn't make the ${FORMAT_NAME[format]} file. Try again.`, { icon: "close" });
    }
  }

  function print() {
    document.querySelector(".print-note")?.remove();
    const body = opts.content().querySelector(".editor__content, .note__body")?.cloneNode(true) as HTMLElement | undefined;
    // The copy is for paper: nothing in it is typed into, focused or loaded.
    body?.removeAttribute("contenteditable");
    body?.removeAttribute("role");
    body?.querySelectorAll("iframe, video, audio, button, .ProseMirror-widget, .ProseMirror-gapcursor").forEach((el) => el.remove());
    body?.querySelectorAll("input").forEach((el) => (el.disabled = true));
    const title = opts.title().trim();
    const root = h("div", { class: "print-note" }, title ? h("h1", { class: "print-note__title" }, title) : null, body ?? null);
    document.body.append(root);
    document.documentElement.classList.add("is-printing-note");
    const done = () => {
      document.documentElement.classList.remove("is-printing-note");
      root.remove();
    };
    window.addEventListener("afterprint", done, { once: true });
    // The tab's title is what a saved PDF is called.
    const was = document.title;
    if (title) document.title = title;
    try {
      window.print();
    } finally {
      document.title = was;
    }
  }

  return { download, print };
}
