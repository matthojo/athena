/**
 * A note's way out: "Send to Google Docs", "Send to Notion" and "Save as
 * template" in its menu, and a strip under the title for each doc or page
 * made from it, with Open and Undo (lib/documents.ts on the server).
 *
 * Sending again updates the same doc or page. Undo trashes the doc in Drive,
 * or moves the Notion page Athena made under "Removed by Athena"; nothing else in either account is
 * ever touched.
 */
import "../styles/documents.css";
import { h } from "../lib/dom";
import { icons } from "./icons";
import { brandLogo } from "./brand-logo";
import { showToast } from "./toast";
import { relativeTime } from "../lib/format";
import { loadDocumentAccounts, loadExports, OPEN_IN, PROVIDER_NAME, sendToDocuments, undoDocument, type DocumentExport, type DocumentProvider } from "../db/documents";

export interface NoteDocuments {
  /** The strip that lists where this note went. */
  el: HTMLElement;
  /** Show the strip for this note (null: a new note, not saved yet). */
  show(noteId: string | null): void;
  send(provider: DocumentProvider): Promise<void>;
}

const UNDONE: Record<DocumentProvider, string> = { "google-docs": "Undone · in Drive's trash", notion: "Moved to Removed by Athena in Notion" };

export function noteDocuments(opts: { title: () => string; save: () => Promise<void>; noteId: () => string | null }): NoteDocuments {
  const el = h("section", { class: "note-docs", "aria-label": "Sent from this note", hidden: true });
  let current: string | null = null;
  let rows: DocumentExport[] = [];
  const busy = new Set<string>();

  const paint = () => {
    const live = rows.filter((r) => r.provider);
    el.hidden = !live.length;
    el.replaceChildren(
      ...live.map((r) => {
        const undone = !!r.undone_at;
        const open = h("a", { class: "btn btn--soft btn--sm note-docs__open", href: r.url, target: "_blank", rel: "noopener noreferrer" }, OPEN_IN[r.provider], icons.external());
        const undo = h("button", { class: "btn btn--ghost btn--sm", type: "button", disabled: busy.has(r.id) }, busy.has(r.id) ? "Undoing…" : "Undo") as HTMLButtonElement;
        undo.addEventListener("click", () => void runUndo(r));
        return h(
          "div",
          { class: `note-docs__row${undone ? " is-undone" : ""}` },
          brandLogo(r.provider, "sm"),
          h(
            "span",
            { class: "note-docs__text" },
            h("span", { class: "note-docs__title" }, `In ${PROVIDER_NAME[r.provider]}`),
            h("span", { class: "note-docs__sub" }, undone ? UNDONE[r.provider] : r.updated_at === r.created_at ? `Sent ${relativeTime(r.created_at)}` : `Updated ${relativeTime(r.updated_at)}`)
          ),
          undone ? null : open,
          undone ? null : undo
        );
      })
    );
  };

  async function refresh() {
    const id = current;
    if (!id || id.startsWith("local-")) {
      rows = [];
      paint();
      return;
    }
    try {
      const got = await loadExports(id);
      if (current !== id) return;
      // The newest per account, undone ones only until they're replaced.
      const seen = new Set<string>();
      rows = got.filter((r) => (seen.has(r.connector_id) ? false : (seen.add(r.connector_id), true)));
      paint();
    } catch {
      // Offline: the strip stays as it was.
    }
  }

  async function runUndo(r: DocumentExport) {
    busy.add(r.id);
    paint();
    try {
      const done = await undoDocument(r.id);
      rows = rows.map((x) => (x.id === r.id ? done : x));
      showToast(r.provider === "notion" ? "Moved to Removed by Athena in Notion" : "Doc moved to Drive's trash", { icon: "restore" });
    } catch (error) {
      showToast(error instanceof Error ? error.message : "Couldn't undo that. Try again.", { icon: "close" });
    } finally {
      busy.delete(r.id);
      paint();
    }
  }

  async function send(provider: DocumentProvider) {
    await opts.save();
    const id = opts.noteId();
    if (!id || id.startsWith("local-")) {
      showToast("Waiting for this note to sync. Try again in a moment.", { icon: "wifiOff" });
      return;
    }
    const accounts = await loadDocumentAccounts().catch(() => null);
    if (!accounts) {
      showToast("Sending needs a connection", { icon: "wifiOff" });
      return;
    }
    const account = accounts.find((a) => a.provider === provider);
    if (!account) {
      showToast(provider === "notion" ? "Turn on “Let Athena create pages” for Notion in Sources" : "Add Google Docs in Sources first", { icon: "plug", action: { label: "Sources", run: () => (location.hash = "#/settings/accounts") } });
      return;
    }
    showToast(`Sending to ${PROVIDER_NAME[provider]}…`, { icon: "send" });
    try {
      const r = await sendToDocuments(id, opts.title(), provider, account.id);
      current = id;
      await refresh();
      const where = provider === "notion" ? `under ${account.parent_title}` : "in your Athena folder";
      showToast(r.updated ? `Updated in ${PROVIDER_NAME[provider]}` : `New ${provider === "notion" ? "page" : "doc"} ${where}`, {
        icon: "check",
        action: { label: "Open", run: () => window.open(r.export.url, "_blank", "noopener") },
      });
    } catch (error) {
      showToast(error instanceof Error ? error.message : `Couldn't send to ${PROVIDER_NAME[provider]}`, { icon: "close" });
    }
  }

  return {
    el,
    show(noteId) {
      current = noteId;
      void refresh();
    },
    send,
  };
}
