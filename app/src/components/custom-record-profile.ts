/**
 * One record in one of the owner's own kinds (a wine, a plant): the profile
 * shown in the mobile sheet and the desktop Library pane, built like a
 * place's. A hero like a label (the kind's icon on a card tinted by its
 * name), the title, a line from its first fields and one action (Write a
 * note); then its notes (the note editor, so @ links people, places and
 * other records), what it links to, what mentions it, a small graph, and
 * its fields at the end in a folded Details: only the set ones, as words,
 * with the empty ones behind "Add a detail" (a new record shows them all,
 * open). The overflow menu has Duplicate and Archive; deleting for good is
 * the Archived page's.
 *
 * Edits save as they're made and need a connection (db/custom-kinds.ts). A new
 * record is created by its title, with whatever was typed into its notes and
 * fields by then.
 *
 * Built only with h() and text nodes: titles, notes and values can come from agents.
 */

import { placeMenuAcross } from "../lib/menu-place";
import { openAsk } from "../lib/open-ask";
import { openLinked } from "../lib/open-linked";
import { h } from "../lib/dom";
import { icons, type IconName } from "./icons";
import { openSheet } from "./sheet";
import { showToast } from "./toast";
import { openNoteSheet } from "./note-detail";
import { customFieldsSection } from "./custom-fields";
import { localGraphSection, type LocalGraphSection } from "./local-graph";
import { loadConnections, notesSnapshot, onNotes, searchEntities } from "../db/data";
import { isSampleMode, saveRecord } from "../db/api";
import { OfflineError } from "../db/records";
import { duplicateCustomRecord, findCustomRecord, kindById, recordBacklinks, saveCustomRecord, setRecordArchived } from "../db/custom-kinds";
import { loadKindValues, onCustomFieldsChange } from "../db/custom-fields";
import { rememberFieldsKind } from "../lib/field-meta";
import { markdownToText } from "../lib/markdown-text";
import { hueFor, relativeTime, shortDate } from "../lib/format";
import { formatAthenaLink } from "../../../lib/links";
import { entityIcon, kindIcon } from "../lib/entity-icon";
import { formatValue } from "../../../lib/custom-field-rules";
import { isEncryptedPlaceholder } from "../../../lib/encrypted";
import type { NoteEditorHandle } from "../editor/editor";
import type { Connection, CustomRecord, EntityKind, EntityRef } from "../types";
import "../styles/record.css";

export { kindIcon };

const capitalise = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** "a wine", "an olive oil". */
export const withArticle = (one: string) => `${/^[aeiou]/i.test(one) ? "an" : "a"} ${one}`;

/** A record's line under its title: its first one or two filled fields ("Cinsault · Bekaa Valley, Lebanon"). */
export function recordSubtitle(fields: { id: string; type: string; unit: string }[], values: Record<string, unknown> | undefined, max = 2): string {
  if (!values) return "";
  const parts: string[] = [];
  for (const f of fields) {
    const v = values[f.id];
    if (v === undefined || v === null || (Array.isArray(v) && !v.length)) continue;
    parts.push(formatValue(f as never, v as never));
    if (parts.length >= max) break;
  }
  return parts.join(" · ");
}

export interface CustomProfileContext {
  close: () => void;
  openLink: (kind: EntityKind, id: string) => void;
  /** Start a new note whose body begins with this Markdown (a link to the record). */
  compose?: (seed: string) => void;
  /** A brand-new record was created. */
  onCreated?: (record: CustomRecord) => void;
  /** Duplicate made a copy: show it. */
  onDuplicated?: (record: CustomRecord) => void;
  autofocus?: boolean;
}

export interface CustomProfileView {
  el: HTMLElement;
  recordId: () => string | null;
  destroy: () => void;
}

let editorModule: Promise<typeof import("../editor/editor")> | null = null;
const loadEditor = () => (editorModule ??= import("../editor/editor"));

/** Create a person/place/organisation from the @ popover (online only), as notes do. */
async function createEntity(kind: "person" | "place" | "organisation", name: string): Promise<EntityRef | null> {
  try {
    const rec = await saveRecord<{ id: string; name: string; updated_at: string }>(kind, { name });
    showToast(`Added ${name}`, { icon: "check" });
    return { kind, id: rec.id, title: rec.name, subtitle: "", updated_at: rec.updated_at };
  } catch {
    showToast("Couldn't create that. Are you online?", { icon: "wifiOff" });
    return null;
  }
}

export function customRecordProfile(kindId: string, initial: CustomRecord | null, ctx: CustomProfileContext): CustomProfileView {
  let rec: CustomRecord | null = initial;
  let dead = false;
  let saving: Promise<void> = Promise.resolve();
  let body = initial?.body ?? "";
  let editor: NoteEditorHandle | null = null;
  const uid = Math.random().toString(36).slice(2);
  const kind = () => kindById(kindId);
  const one = () => kind()?.one ?? "item";
  const fieldKind = `custom:${kindId}` as const;
  // A title or notes this copy of Athena can't decrypt (a deploy preview) are shown, never saved over.
  const locked = !!initial && (isEncryptedPlaceholder(initial.title) || isEncryptedPlaceholder(initial.body));

  // ---------- identity ----------
  // Like a label on the bottle or the jar: the kind's icon on a card tinted by the record's name.
  const mark = h("span", { class: "record-label", "aria-hidden": "true" });
  const titleInput = h("textarea", {
    class: "note__title-input profile__name",
    name: "title",
    rows: 1,
    placeholder: `Name this ${one()}`,
    "aria-label": "Name",
    maxlength: 300,
  }) as HTMLTextAreaElement;
  titleInput.value = rec?.title ?? "";
  titleInput.readOnly = locked;
  const grow = () => {
    titleInput.style.height = "auto";
    titleInput.style.height = `${titleInput.scrollHeight}px`;
  };
  titleInput.addEventListener("input", grow);
  titleInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      titleInput.blur();
    }
  });
  titleInput.addEventListener("change", () => {
    const v = titleInput.value.trim();
    if (!v) {
      if (rec) titleInput.value = rec.title;
      return;
    }
    if (rec && v === rec.title) return;
    save(rec ? { title: v } : {});
  });
  const sub = h("p", { class: "profile__sub" });

  /** Save a patch; a new record is created by its first save, which needs a title. */
  function save(patch: { title?: string; body?: string }) {
    saving = saving.then(async () => {
      if (dead || locked) return;
      if (!rec && !titleInput.value.trim()) {
        titleInput.focus();
        showToast(`Name the ${one()} first`, { icon: "pen" });
        return;
      }
      try {
        const created = !rec;
        const saved = await saveCustomRecord(kindId, rec ? patch : { title: titleInput.value.trim(), body }, rec?.id);
        rec = saved;
        if (created) {
          custom.show(saved.id);
          ctx.onCreated?.(saved);
        }
        paint();
      } catch (error) {
        showToast(error instanceof OfflineError ? error.message : error instanceof Error ? error.message : "Couldn't save", { icon: "wifiOff", timeoutMs: 4000 });
      }
    });
  }

  // ---------- menu: Duplicate, Archive ----------
  const menuId = `crec-menu-${uid}`;
  const moreBtn = h("button", { class: "icon-btn icon-btn--sm icon-btn--ghost note__more", type: "button", "aria-label": "More actions", popovertarget: menuId }, icons.more()) as HTMLButtonElement;
  const menu = h("div", { class: "menu note-menu", id: menuId, popover: "auto" }) as HTMLElement & { hidePopover?: () => void };
  const menuItem = (icon: IconName, label: string, run: () => void) => {
    const b = h("button", { class: "menu__item", type: "button" }, icons[icon](), label);
    b.addEventListener("click", () => {
      menu.hidePopover?.();
      run();
    });
    return b;
  };
  menu.replaceChildren(
    // Ask with this one attached (lib/open-ask.ts).
    menuItem("chat", "Ask about this", () => rec && openAsk({ context: { kind: "record", id: rec.id, label: rec.title || "Untitled" } })),
    h("div", { class: "menu__sep" }),
    menuItem("copy", "Duplicate", () => void duplicate()),
    menuItem("archive", "Archive", () => void archive())
  );
  menu.addEventListener("toggle", (e) => {
    if ((e as ToggleEvent).newState !== "open") return;
    const r = moreBtn.getBoundingClientRect();
    menu.style.top = `${Math.min(r.bottom + 6, window.innerHeight - 120)}px`;
    placeMenuAcross(menu, moreBtn);
  });

  async function duplicate() {
    if (!rec) return;
    try {
      await saving;
      const copy = await duplicateCustomRecord(rec);
      showToast(`Made “${copy.title}”`, { icon: "copy" });
      ctx.onDuplicated?.(copy);
    } catch (error) {
      showToast(error instanceof Error ? error.message : "Couldn't duplicate it", { icon: "wifiOff" });
    }
  }

  async function archive() {
    if (!rec) return;
    const r = rec;
    try {
      await setRecordArchived(r, true);
      dead = true;
      ctx.close();
      showToast(`${capitalise(one())} archived`, {
        icon: "archive",
        action: { label: "Undo", run: () => void setRecordArchived(r, false).catch(() => showToast("Couldn't undo. Restore it from Archived")) },
      });
    } catch (error) {
      showToast(error instanceof Error ? error.message : "Couldn't archive", { icon: "wifiOff" });
    }
  }

  // ---------- the one action: a note that links here ----------
  const actions = h("div", { class: "profile__primary" });
  function paintActions() {
    actions.replaceChildren();
    if (!rec || !ctx.compose) return;
    const b = h("button", { class: "btn btn--soft btn--sm profile__go", type: "button" }, icons.pen(), "Write a note");
    b.addEventListener("click", () => rec && ctx.compose!(`${formatAthenaLink("record", rec.id, `@${rec.title}`)} `));
    actions.append(b);
  }

  // ---------- details: the kind's own fields ----------
  const custom = customFieldsSection(fieldKind);
  const fieldsCard = h("div", { class: "card card--flush fields" });
  const noFields = h("div", { class: "record-nofields" });
  const preview = h("span", { class: "record-details__preview" });
  const addDetail = h("button", { class: "link-btn section-add record-details__add", type: "button", hidden: true }, icons.plus(), "Add a detail") as HTMLButtonElement;
  // "Add a detail" stands in for the fields' own "Add …" row (hidden in a folded Details), and opens the empty ones.
  addDetail.addEventListener("click", () => fieldsCard.querySelector<HTMLButtonElement>(".prop--reveal")?.click());
  const syncAdd = () => {
    addDetail.hidden = !rec || !fieldsCard.querySelector(".prop--reveal");
  };
  const watchFields = new MutationObserver(syncAdd);
  watchFields.observe(fieldsCard, { childList: true });
  const details = h(
    "details",
    { class: "profile__section record-details", open: !initial || undefined },
    h("summary", { class: "record-details__summary" }, h("h2", { class: "group__label" }, "Details"), preview, h("span", { class: "record-details__chev", "aria-hidden": "true" }, icons.chevronDown())),
    h("div", { class: "record-details__body" }, fieldsCard, addDetail, noFields)
  ) as HTMLDetailsElement;
  function paintNoFields(count: number) {
    noFields.hidden = count > 0;
    if (count > 0) return;
    const k = kind();
    const btn = h("button", { class: "link-btn", type: "button" }, "Add fields");
    btn.addEventListener("click", () => {
      rememberFieldsKind(fieldKind);
      location.hash = "#/settings/fields";
    });
    noFields.replaceChildren(h("p", {}, `${k ? k.name : "These"} have no fields yet. Give them a few, like a rating or where it's from. `), btn);
  }
  let fieldCount = -1;
  const refreshFieldCount = () =>
    void loadKindValues(fieldKind).then(({ fields }) => {
      if (dead) return;
      fieldCount = fields.length;
      paintNoFields(fieldCount);
      paintSub();
    });

  // ---------- notes (the record's body) ----------
  const bodySlot = h("div", { class: "editor-slot" }, plainBody(body));
  const toolbarSlot = h("div", { class: "record-notes__toolbar" });
  const notesCard = h("div", { class: "record-notes", "data-empty": body.trim() ? undefined : "true" }, toolbarSlot, bodySlot);
  let bodyTimer: ReturnType<typeof setTimeout> | undefined;
  let linksTimer: ReturnType<typeof setTimeout> | undefined;
  const flushBody = () => {
    clearTimeout(bodyTimer);
    if (rec && body !== rec.body) save({ body });
  };

  function plainBody(md: string): HTMLElement {
    const paragraphs = markdownToText(md).split(/\n{2,}/).filter((p) => p.trim());
    return h("div", { class: "note__body note__body--preview" }, ...paragraphs.map((p) => h("p", {}, p)));
  }

  // ---------- linked + mentioned in ----------
  const linked = h("div", { class: "link-chips" });
  const linkedWrap = h("section", { class: "note__links" }, h("h2", { class: "group__label" }, "Linked"), linked);
  const mentions = h("div", { class: "backlinks" });
  const mentionsCount = h("span", { class: "group__count" });
  const mentionsWrap = h("section", { class: "note__links" }, h("h2", { class: "group__label" }, "Mentioned in", mentionsCount), mentions);

  const chip = (c: Pick<Connection, "kind" | "id" | "title">) => {
    const b = h("button", { class: "link-chip", type: "button", "data-kind": c.kind }, icons[entityIcon(c.kind, (c as Connection).kind_id, c.id, (c as Connection).subtitle)](), c.title || "Untitled");
    b.addEventListener("click", () => openLinked(ctx.openLink, c.kind, c.id));
    return b;
  };

  async function paintLinks() {
    if (!rec) {
      linkedWrap.hidden = true;
      mentionsCount.textContent = "";
      mentions.replaceChildren(h("p", { class: "note__links-empty" }, `Once it's saved, type @ in a note to link this ${one()}.`));
      return;
    }
    const current = rec;
    const [{ outgoing, backlinks }, fromRecords] = await Promise.all([loadConnections("record", current.id, body), recordBacklinks("record", current.id)]);
    if (dead || rec !== current) return;
    const seen = new Set<string>();
    const out = outgoing.filter((c) => !seen.has(`${c.kind}:${c.id}`) && seen.add(`${c.kind}:${c.id}`));
    linkedWrap.hidden = !out.length;
    linked.replaceChildren(...out.map(chip));

    const cached = new Map(notesSnapshot().notes.map((n) => [n.id, n]));
    const back = [...backlinks, ...fromRecords.filter((r) => !backlinks.some((b) => b.kind === r.kind && b.id === r.id))];
    mentionsCount.textContent = back.length ? String(back.length) : "";
    mentions.replaceChildren(
      back.length
        ? h(
            "div",
            { class: "card card--flush list" },
            ...back.map((c) => {
              const n = c.kind === "note" ? cached.get(c.id) : undefined;
              const snippet = n ? markdownToText(n.body).replace(/\s+/g, " ").trim() : c.subtitle;
              const icon: IconName = entityIcon(c.kind, c.kind_id, c.id, c.subtitle);
              const row = h(
                "button",
                { class: "row", type: "button" },
                h("span", { class: "tile tile--sm" }, icons[icon]()),
                h("span", { class: "row__body" }, h("span", { class: "row__title-line" }, h("span", { class: "row__title" }, c.title || "Untitled")), snippet ? h("span", { class: "row__snippet" }, snippet) : null),
                c.updated_at ? h("span", { class: "row__time" }, shortDate(c.updated_at)) : h("span", {})
              );
              row.addEventListener("click", () => openLinked(ctx.openLink, c.kind, c.id));
              return row;
            })
          )
        : h("p", { class: "note__links-empty" }, `Nothing mentions it yet. Type @ in a note to link this ${one()}.`)
    );
  }

  // ---------- assemble ----------
  const foot = h("footer", { class: "note__foot" });
  let localGraph: LocalGraphSection | null = null;
  function ensureGraph() {
    if (!rec || localGraph) return;
    localGraph = localGraphSection({ kind: "record", id: rec.id, title: () => (rec ? rec.title : ""), openLink: ctx.openLink });
    details.before(localGraph.el);
  }

  /** The line under the title: the first two filled fields, once they're loaded. */
  function paintSub() {
    if (!rec) {
      sub.replaceChildren(`New ${one()}`);
      sub.hidden = false;
      return;
    }
    void loadKindValues(fieldKind).then(({ fields, values }) => {
      if (dead || !rec) return;
      const line = recordSubtitle(fields, values[rec.id]);
      sub.replaceChildren(line || capitalise(one()));
      sub.hidden = false;
      preview.textContent = recordSubtitle(fields, values[rec.id], 3);
    });
  }

  function paint() {
    moreBtn.hidden = !rec || locked;
    mark.replaceChildren(icons[kindIcon(kind())]());
    mark.style.setProperty("--h", String(hueFor(rec?.title || titleInput.value || one())));
    syncAdd();
    paintActions();
    actions.hidden = !actions.childElementCount;
    paintSub();
    foot.textContent = rec ? `Added ${shortDate(rec.created_at)} · Updated ${relativeTime(rec.updated_at)}` : "Saves as you go. Needs a connection.";
    void paintLinks();
    ensureGraph();
  }

  const el = h(
    "article",
    { class: `note note--edit profile profile--record${locked ? " note--encrypted" : ""}` },
    h("header", { class: "profile__hero" }, h("div", { class: "profile__top" }, mark, h("span", { class: "note__bar-spacer" }), moreBtn, menu), titleInput, sub, actions),
    h("section", { class: "profile__section" }, h("h2", { class: "group__label" }, "Notes"), notesCard),
    linkedWrap,
    mentionsWrap,
    details,
    foot
  );
  custom.attach(fieldsCard);
  custom.show(rec?.id ?? null);
  refreshFieldCount();
  paint();
  requestAnimationFrame(() => {
    grow();
    if (ctx.autofocus) titleInput.focus();
  });

  void loadEditor().then(({ createNoteEditor }) => {
    if (dead) return;
    if (locked) {
      // Read-only: links draw as they do in the editor.
      if (!isEncryptedPlaceholder(body)) {
        editor = createNoteEditor({ markdown: body, readOnly: true, onChange: () => undefined, onOpenLink: ctx.openLink, search: async () => [] });
        bodySlot.replaceChildren(editor.content);
      }
      return;
    }
    editor = createNoteEditor({
      markdown: body,
      placeholder: `Notes about this ${one()}. Type @ to link a person, place or anything else`,
      onChange(md) {
        body = md;
        notesCard.toggleAttribute("data-empty", !md.trim());
        clearTimeout(bodyTimer);
        bodyTimer = setTimeout(flushBody, 800);
        clearTimeout(linksTimer);
        linksTimer = setTimeout(() => void paintLinks(), 500);
      },
      onOpenLink: ctx.openLink,
      search: async (q, kinds) => (await searchEntities(q, kinds)).results.filter((r) => !(r.kind === "record" && r.id === rec?.id)),
      create: isSampleMode() ? null : createEntity,
    });
    toolbarSlot.replaceChildren(editor.toolbar);
    bodySlot.replaceChildren(editor.content);
    editor.content.addEventListener("focusout", flushBody);
  });

  // Mentions come from the notes store offline and in sample mode, which may still be loading.
  const unsubNotes = onNotes(() => {
    clearTimeout(linksTimer);
    linksTimer = setTimeout(() => void paintLinks(), 150);
  });
  const unsubFields = onCustomFieldsChange((k) => {
    if (k === fieldKind || k === null) refreshFieldCount();
  });
  const onHide = () => flushBody();
  window.addEventListener("pagehide", onHide);

  return {
    el,
    recordId: () => rec?.id ?? null,
    destroy() {
      flushBody();
      void saving.finally(() => {
        dead = true;
      });
      clearTimeout(linksTimer);
      watchFields.disconnect();
      unsubNotes();
      unsubFields();
      window.removeEventListener("pagehide", onHide);
      localGraph?.destroy();
      custom.destroy();
      editor?.destroy();
      editor = null;
    },
  };
}

/** Mobile (and "+ New" from a sheet): a record in a sheet. */
export function openCustomRecordSheet(kindId: string, rec: CustomRecord | null, opts: { openLink: (kind: EntityKind, id: string) => void }): void {
  let view: CustomProfileView | null = null;
  const k = kindById(kindId);
  const newLabel = `New ${k?.one ?? "item"}`;
  const sheet = openSheet({
    label: rec ? rec.title : newLabel,
    title: rec ? undefined : newLabel,
    body: h("div", {}),
    variant: "tall",
    onClose: () => view?.destroy(),
  });
  const thenClose = (run: () => void) => {
    sheet.close();
    setTimeout(run, 260);
  };
  view = customRecordProfile(kindId, rec, {
    close: () => sheet.close(),
    openLink: (kind, id) => thenClose(() => opts.openLink(kind, id)),
    compose: (seed) => thenClose(() => openNoteSheet(null, { openLink: opts.openLink, seed })),
    onDuplicated: (copy) => thenClose(() => openCustomRecordSheet(kindId, copy, opts)),
    autofocus: !rec,
  });
  sheet.dialog.querySelector(".sheet__scroll")!.replaceChildren(view.el);
}

/** A record's sheet from just its id (a link, a search result), when it's still there. */
export async function openCustomRecordById(id: string, opts: { openLink: (kind: EntityKind, id: string) => void }): Promise<boolean> {
  const rec = await findCustomRecord(id);
  if (!rec) return false;
  openCustomRecordSheet(rec.kind_id, rec, opts);
  return true;
}
