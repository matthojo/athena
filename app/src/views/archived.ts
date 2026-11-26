/**
 * Archived: the one place archived things of every kind are visible. Newest
 * first; each can be restored, or deleted permanently after a confirmation.
 * (Agents can archive but never delete or list this page's contents — see
 * docs: security/sign-in-and-keys.) The owner's archived fields wait here too, and can only be
 * restored: a field is never deleted, and its values come back with it.
 * Archived Ask conversations are here too (db/ask-threads.ts, kept on the
 * device and synced): restore one, or delete it for good. So are the owner's
 * own kinds of record (with how many records go with one) and single
 * records: deleting a kind says how many records it takes with it. So are
 * pictures Ask made and the owner undid (db/ask-pictures.ts): restoring one
 * puts it back in its conversation.
 */

import { h } from "../lib/dom";
import { icons } from "../components/icons";
import { confirmChoice, confirmDialog } from "../components/confirm";
import { deleteFilesChoice, filesDeletedWithNote, heldNoteFiles } from "../components/attachments";
import { showToast } from "../components/toast";
import { deleteForever, loadArchived, onRecordsChange, setArchived } from "../db/records";
import { deleteMemoryForever, onMemoryChange, sampleArchivedMemory, setMemoryArchived } from "../db/memory";
import { deleteNoteLocal, setNoteArchivedLocal } from "../db/sync";
import { deleteEntity, isSampleMode } from "../db/api";
import { get } from "../db/idb";
import { refreshNotes } from "../db/data";
import { relativeTime } from "../lib/format";
import { isLogisticsKind, isMemoryKind, KIND_META as KIND } from "../lib/memory-meta";
import { deleteLogisticsForever, onLogisticsChange, sampleArchivedLogistics, setLogisticsArchived } from "../db/trips";
import { loadAllFields, onCustomFieldsChange, setFieldArchived, type CustomField } from "../db/custom-fields";
import { FIELD_TYPE_ICON } from "../lib/field-meta";
import { fieldKindInfo } from "../../../lib/custom-field-rules";
import { deleteThread, getThread, listArchivedThreads, onThreadsChange, requestOpen, setThreadArchived, threadTitle } from "../db/ask-threads";
import { deletePictureForGood, listArchivedPictures, onPicturesChange, restorePicture, type ArchivedPicture } from "../db/ask-pictures";
import { fileUrl, openFileViewer } from "../components/attachments";
import "../styles/ask-picture.css";
import { deleteKindForever, deleteRecordForever, onKindsChange, sampleArchivedKinds, setKindArchived, setRecordArchived } from "../db/custom-kinds";
import { KIND_WORD } from "../../../lib/custom-kind-words";
import { kindIcon } from "../lib/entity-icon";
import type { ArchivedItem, AskThread, Note } from "../types";
import { pageHead } from "../components/page-head";

/** The row's line: "Wine", "Type · 4 wines", "Person". */
function archivedMeta(item: ArchivedItem): string {
  if (item.kind === "record") return item.detail ?? KIND.record.label;
  if (item.kind === "kind") return `${KIND_WORD.One}${item.count ? ` · ${item.count} ${item.count === 1 ? (item.detail ?? "record") : item.detail ? item.title.toLowerCase() : "records"}` : ""}`;
  return KIND[item.kind].label;
}

/** What deleting a kind takes with it, in words. */
function kindLoss(item: ArchivedItem): string {
  const n = item.count ?? 0;
  if (!n) return "Its fields are removed from Athena everywhere.";
  const things = n === 1 ? `one ${item.detail ?? "record"}` : `${n} ${item.detail ? item.title.toLowerCase() : "records"}`;
  return `Its ${things}, with their notes, values and links, and its fields are removed from Athena everywhere.`;
}

export function renderArchived(): { el: HTMLElement; destroy: () => void } {
  const list = h("div", { class: "notes__list" });
  const count = h("span", { class: "page-count" });
  const el = h(
    "div",
    { class: "view archived" },
    pageHead({ title: "Archived", count, lede: "Hidden everywhere else in Athena. Restore anything, or delete it for good." }),
    list
  );

  async function restore(item: ArchivedItem) {
    try {
      if (item.kind === "note" && isSampleMode()) {
        const note = await get<Note>("notes", item.id);
        if (note) await setNoteArchivedLocal(note, false);
        await refreshNotes();
      } else if (isMemoryKind(item.kind)) await setMemoryArchived(item.kind, item.id, false);
      else if (isLogisticsKind(item.kind)) await setLogisticsArchived(item.kind, item.id, false);
      else if (item.kind === "kind") await setKindArchived(item.id, false);
      else if (item.kind === "record") await setRecordArchived({ id: item.id, kind_id: item.kind_id ?? "" }, false);
      else await setArchived(item.kind, item.id, false);
      showToast(item.kind === "kind" ? `Restored ${item.title}, with everything in it` : `Restored ${item.title}`, { icon: "restore" });
      void load();
    } catch (error) {
      showToast(error instanceof Error ? error.message : "Couldn't restore", { icon: "wifiOff" });
    }
  }

  async function remove(item: ArchivedItem) {
    const noun = item.kind === "record" ? (item.detail ?? "record").toLowerCase() : (KIND[item.kind].noun ?? KIND[item.kind].label.toLowerCase());
    // A note whose file a conversation still has offers to delete the file too, as on the note.
    const held = item.kind === "note" ? await heldNoteFiles(item.id) : [];
    const picked = await confirmChoice({
      title: `Delete ${item.title} permanently?`,
      body:
        item.kind === "kind"
          ? `${kindLoss(item)} This can't be undone.`
          : `This ${noun}${item.kind === "record" ? ", its values" : ""} and its links are removed from Athena everywhere.${item.kind === "person" ? " Their birthday goes too." : ""} This can't be undone.`,
      confirmLabel: "Delete permanently",
      danger: true,
      choice: deleteFilesChoice(held),
    });
    if (!picked) return;
    try {
      if (item.kind === "note" && picked.choice) {
        await deleteEntity("note", item.id, { files: true });
        await refreshNotes();
      } else if (item.kind === "note" && isSampleMode()) {
        const note = await get<Note>("notes", item.id);
        if (note) await deleteNoteLocal(note);
      } else if (isMemoryKind(item.kind)) await deleteMemoryForever(item.kind, item.id);
      else if (isLogisticsKind(item.kind)) await deleteLogisticsForever(item.kind, item.id);
      else if (item.kind === "kind") await deleteKindForever(item.id);
      else if (item.kind === "record") await deleteRecordForever({ id: item.id, kind_id: item.kind_id ?? "" });
      else await deleteForever(item.kind, item.id);
      showToast(await filesDeletedWithNote(held, picked.choice), { icon: "trash" });
      void load();
    } catch (error) {
      showToast(error instanceof Error ? error.message : "Couldn't delete", { icon: "wifiOff" });
    }
  }

  async function restoreField(f: CustomField) {
    try {
      await setFieldArchived(f, false);
      showToast(`Restored ${f.label}, with its values`, { icon: "restore" });
      void load();
    } catch (error) {
      showToast(error instanceof Error ? error.message : "Couldn't restore", { icon: "wifiOff" });
    }
  }

  /** An archived Ask conversation: restore it to Ask's list, or delete it for good. */
  function conversationRow(t: AskThread): HTMLElement {
    const title = threadTitle(t);
    const restoreBtn = h("button", { class: "btn btn--soft btn--sm", type: "button", "aria-label": `Restore ${title}` }, icons.restore(), "Restore");
    restoreBtn.addEventListener("click", async () => {
      await setThreadArchived(t.id, false);
      showToast("Restored to Ask", { icon: "restore" });
    });
    const deleteBtn = h("button", { class: "icon-btn icon-btn--sm icon-btn--ghost archived__delete", type: "button", "aria-label": `Delete ${title} permanently` }, icons.trash());
    deleteBtn.addEventListener("click", async () => {
      const ok = await confirmDialog({
        title: "Delete this conversation permanently?",
        body: `“${title}” is removed from all your devices. Any notes or to-dos from it stay as they are. This can't be undone.`,
        confirmLabel: "Delete permanently",
        danger: true,
      });
      if (!ok) return;
      await deleteThread(t.id);
      showToast("Deleted permanently", { icon: "trash" });
    });
    return h(
      "div",
      { class: "row archived__row" },
      h("span", { class: "tile tile--sm" }, icons.chat()),
      h(
        "span",
        { class: "row__body" },
        h("span", { class: "row__title" }, title),
        h("span", { class: "row__meta" }, `Conversation · archived ${relativeTime(t.archived_at!)}`)
      ),
      h("span", { class: "archived__actions" }, restoreBtn, deleteBtn)
    );
  }

  /** A picture Ask made, undone: its thumbnail (tap to look), the conversation it was in, Restore and Delete. */
  function pictureRow(p: ArchivedPicture, where: string | null): HTMLElement {
    const name = p.file.name.replace(/\.\w+$/, "") || "Picture";
    const img = h("img", { class: "archived__pic-img", alt: "", decoding: "async" }) as HTMLImageElement;
    void fileUrl(p.file, { thumb: true }).then((u) => u && (img.src = u));
    const look = h("button", { class: "tile tile--sm archived__pic", type: "button", "aria-label": `Look at ${name}` }, img);
    look.addEventListener("click", () => openFileViewer(p.file, [p.file]));
    const restoreBtn = h("button", { class: "btn btn--soft btn--sm", type: "button", "aria-label": `Restore ${name}` }, icons.restore(), "Restore");
    restoreBtn.addEventListener("click", async () => {
      try {
        await restorePicture(p);
        showToast("Back in its conversation", { icon: "restore", action: { label: "Open", run: () => {
          requestOpen(p.thread_id);
          location.hash = "#/ask";
        } } });
      } catch {
        showToast(navigator.onLine ? "Couldn't restore the picture. Try again." : "You're offline. Restore it once you're back online.", { icon: "wifiOff" });
      }
    });
    const deleteBtn = h("button", { class: "icon-btn icon-btn--sm icon-btn--ghost archived__delete", type: "button", "aria-label": `Delete ${name} permanently` }, icons.trash());
    deleteBtn.addEventListener("click", async () => {
      const onNotes = p.on_notes === 1 ? " The note that has it keeps it." : p.on_notes > 1 ? ` The ${p.on_notes} notes that have it keep it.` : "";
      const ok = await confirmDialog({
        title: "Delete this picture permanently?",
        body: `It's removed from ${where ? `“${where}”` : "its conversation"}${p.on_notes ? "" : " and from Athena"}.${onNotes} This can't be undone.`,
        confirmLabel: "Delete permanently",
        danger: true,
      });
      if (!ok) return;
      try {
        await deletePictureForGood(p);
        showToast("Deleted permanently", { icon: "trash" });
      } catch {
        showToast("Couldn't delete the picture. Try again.", { icon: "wifiOff" });
      }
    });
    return h(
      "div",
      { class: "row archived__row" },
      look,
      h("span", { class: "row__body" }, h("span", { class: "row__title" }, name), h("span", { class: "row__meta" }, `Picture · archived ${relativeTime(p.archived_at)}`)),
      h("span", { class: "archived__actions" }, restoreBtn, deleteBtn),
    );
  }

  /** An archived field: restore only. A field is never deleted, and its values come back with it. */
  function fieldRow(f: CustomField): HTMLElement {
    const restoreBtn = h("button", { class: "btn btn--soft btn--sm", type: "button", "aria-label": `Restore the ${f.label} field` }, icons.restore(), "Restore");
    restoreBtn.addEventListener("click", () => void restoreField(f));
    return h(
      "div",
      { class: "row archived__row" },
      h("span", { class: "tile tile--sm" }, icons[FIELD_TYPE_ICON[f.type]]()),
      h(
        "span",
        { class: "row__body" },
        h("span", { class: "row__title" }, f.label),
        h("span", { class: "row__meta" }, `Field for ${fieldKindInfo(f.kind).many} · archived ${relativeTime(f.archived_at!)}`)
      ),
      h("span", { class: "archived__actions" }, restoreBtn)
    );
  }

  async function load() {
    const [{ items: records, state }, { fields }, conversations, pictures] = await Promise.all([loadArchived(), loadAllFields(), listArchivedThreads(), listArchivedPictures()]);
    // Each picture says which conversation it was in, by that conversation's title on this device.
    const places = await Promise.all(pictures.map((p) => getThread(p.thread_id).then((t) => (t ? threadTitle(t) : null), () => null)));
    // The server lists every kind; sample mode keeps layer-2 items, trips and purchases in their own stores.
    const items =
      state === "sample"
        ? [...records, ...(await sampleArchivedMemory()), ...(await sampleArchivedLogistics()), ...(await sampleArchivedKinds())].sort((a, b) => b.archived_at.localeCompare(a.archived_at))
        : records;
    const archivedFields = fields.filter((f) => f.archived_at);
    const total = items.length + archivedFields.length + conversations.length + pictures.length;
    count.textContent = total ? String(total) : "";
    if (state === "offline") {
      list.replaceChildren(h("div", { class: "empty" }, h("span", { class: "tile" }, icons.wifiOff()), h("p", { class: "empty__title" }, "Archived needs a connection"), h("p", { class: "empty__sub" }, "Archived items aren't kept on this device. Try again when you're online.")));
      return;
    }
    if (!total) {
      list.replaceChildren(h("div", { class: "empty" }, h("span", { class: "tile" }, icons.archive()), h("p", { class: "empty__title" }, "Nothing archived"), h("p", { class: "empty__sub" }, "When you or a collection archives something, it waits here until you restore it or delete it for good.")));
      return;
    }
    const itemRows = (items as ArchivedItem[]).map((item) => {
          const restoreBtn = h("button", { class: "btn btn--soft btn--sm", type: "button" }, icons.restore(), "Restore");
          restoreBtn.addEventListener("click", () => void restore(item));
          const deleteBtn = h("button", { class: "icon-btn icon-btn--sm icon-btn--ghost archived__delete", type: "button", "aria-label": `Delete ${item.title} permanently` }, icons.trash());
          deleteBtn.addEventListener("click", () => void remove(item));
          return h(
            "div",
            { class: "row archived__row" },
            h("span", { class: "tile tile--sm" }, icons[item.icon ? kindIcon({ icon: item.icon }) : KIND[item.kind].icon]()),
            h(
              "span",
              { class: "row__body" },
              h("span", { class: "row__title" }, item.title || "Untitled"),
              h("span", { class: "row__meta" }, `${archivedMeta(item)} · archived ${relativeTime(item.archived_at)}`)
            ),
            h("span", { class: "archived__actions" }, restoreBtn, deleteBtn)
          );
        });
    // Archived fields sit among the rest, newest first.
    const rows = [
      ...archivedFields.map((f) => ({ at: f.archived_at!, el: fieldRow(f) })),
      ...conversations.map((t) => ({ at: t.archived_at!, el: conversationRow(t) })),
      ...pictures.map((p, i) => ({ at: p.archived_at, el: pictureRow(p, places[i]) })),
      ...items.map((item, i) => ({ at: item.archived_at, el: itemRows[i] })),
    ].sort((a, b) => b.at.localeCompare(a.at));
    list.replaceChildren(h("div", { class: "card card--flush list" }, ...rows.map((r) => r.el)));
  }

  list.replaceChildren(h("div", { class: "card card--flush list" }, ...[0, 1].map(() => h("div", { class: "row" }, h("span", { class: "tile tile--sm skeleton" }), h("span", { class: "row__body" }, h("span", { class: "skeleton", style: "height:12px;width:50%" })), h("span", {})))));
  void load();
  const unsub = onRecordsChange(() => void load());
  const unsubMemory = onMemoryChange(() => void load());
  const unsubFields = onCustomFieldsChange(() => void load());
  const unsubLogistics = onLogisticsChange(() => void load());
  const unsubThreads = onThreadsChange(() => void load());
  const unsubKinds = onKindsChange(() => void load());
  const unsubPictures = onPicturesChange(() => void load());
  return {
    el,
    destroy: () => {
      unsub();
      unsubMemory();
      unsubFields();
      unsubLogistics();
      unsubThreads();
      unsubKinds();
      unsubPictures();
    },
  };
}
