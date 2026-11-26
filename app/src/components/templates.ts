/**
 * Note templates in the app: "New from template" (the picker, then what it's
 * about: a meeting, a person, a trip or a project), and the template editor
 * (also "Save as template" on a note). The filling happens on the server
 * (lib/template-fill.ts); this only asks for it and opens the new note.
 *
 * Fields are shown with where they come from, and a field nothing can fill
 * is said to stay a blank, so nothing about a template is a surprise.
 *
 * A template added from someone else (lib/template-share.ts) carries no
 * badge in the picker ("Shared" could read as shared out), only a dot when
 * Community has a newer version; its editor says where it came from and who
 * made it, and Community's word on it (an update, or taken down). A template the owner wrote has Share in its editor
 * (components/template-share-sheet.ts).
 */
import "../styles/documents.css";
import { h } from "../lib/dom";
import { icons, type IconName } from "./icons";
import { openSheet, type SheetHandle } from "./sheet";
import { showToast } from "./toast";
import { FIELDS, fieldInfo, parseTemplate } from "../../../lib/templates";
import { archiveTemplate, createTemplate, fillFromTemplate, loadProjects, loadTemplates, markPrepared, updateTemplate, type FillInput, type NoteTemplate } from "../db/documents";
import { loadUpcoming, loadRecords } from "../db/records";
import { loadTrips } from "../db/trips";
import { hueFor, initials } from "../lib/format";
import type { EntityKind } from "../types";
import { clockTime } from "../lib/clock";
import { catalogueStatus, updateDot } from "../community/status";
import { sharedByWords, sharedChangeWords, templateIcon } from "./template-share-words";

const iconFor = (t: NoteTemplate): IconName => templateIcon(t);

/** Where a field's value comes from, grouped for the editor's palette. */
const GROUPS: Array<{ label: string; keys: string[] }> = [
  { label: "Calendar", keys: ["meeting", "attendees", "agenda from email"] },
  { label: "People", keys: ["person", "last time we spoke", "about them", "open loops"] },
  { label: "Trips", keys: ["trip", "trip dates", "trip legs"] },
  { label: "Days and to-dos", keys: ["week", "this week's days", "this week's done to-dos", "open to-dos"] },
  { label: "Projects", keys: ["project", "project people", "open to-dos for project"] },
  { label: "Any time", keys: ["date", "today", "my name"] },
];

export interface TemplateOpenContext {
  /** Open the filled note (main.ts: openNoteSheet with a seed that saves). */
  openFilled: (note: { title: string; body: string }) => void;
  openLink: (kind: EntityKind, id: string) => void;
}

/** "Today 16:00", "Tomorrow 09:30", "Wed 09:30". */
const when = (iso: string) => {
  const at = new Date(iso);
  const days = Math.round((new Date(at.toDateString()).getTime() - new Date(new Date().toDateString()).getTime()) / 86_400_000);
  const day = days === 0 ? "Today" : days === 1 ? "Tomorrow" : new Intl.DateTimeFormat(undefined, { weekday: "short" }).format(at);
  return `${day} ${clockTime(at)}`;
};

// ---------- the picker ----------

/** "New from template". `forMeeting` skips straight to filling Meeting notes for that event (Today's "Prepare notes"). */
export function openTemplatePicker(ctx: TemplateOpenContext, opts: { forMeeting?: string } = {}): void {
  const body = h("div", { class: "tpl" });
  const sheet = openSheet({ label: "New from template", title: "New from template", body });
  const scroll = sheet.dialog.querySelector(".sheet__scroll") as HTMLElement;
  scroll.replaceChildren(body);

  if (opts.forMeeting) {
    void loadTemplates().then((all) => {
      const t = all.find((x) => x.starter === "meeting") ?? all[0];
      void fill(sheet, body, t, { event_id: opts.forMeeting }, ctx);
    });
    body.append(working("Filling in your notes…"));
    return;
  }
  void paintList();

  async function paintList() {
    sheet.setTitle("New from template");
    sheet.setBack(null);
    body.replaceChildren(h("div", { class: "tpl__loading" }, h("span", { class: "doc-spin", "aria-hidden": "true" })));
    let all: NoteTemplate[];
    try {
      all = await loadTemplates();
    } catch {
      body.replaceChildren(h("p", { class: "tpl__empty" }, "Templates need a connection. Try again when you're online."));
      return;
    }
    const cards = all.map((t, i) => {
      const pick = h(
        "button",
        { class: "tpl-card__main", type: "button" },
        h("span", { class: "tile tile--sm", "aria-hidden": "true" }, icons[iconFor(t)]()),
        h(
          "span",
          { class: "tpl-card__text" },
          h("span", { class: "tpl-card__name" }, h("span", { class: "tpl-card__label" }, t.name), t.edited && t.starter ? h("span", { class: "tpl-card__tag" }, "Edited") : null, t.shared?.catalogue_id ? updateDot("template", t.id) : null),
          h("span", { class: "tpl-card__blurb" }, t.blurb)
        )
      );
      pick.addEventListener("click", () => void choose(t));
      const edit = h("button", { class: "icon-btn icon-btn--sm icon-btn--ghost tpl-card__edit", type: "button", "aria-label": `Edit ${t.name}` }, icons.pen());
      edit.addEventListener("click", () => {
        sheet.close();
        setTimeout(() => openTemplateEditor(t, { onSaved: () => openTemplatePicker(ctx) }), 260);
      });
      return h("li", { class: "tpl-card", style: `--i:${i}` }, pick, edit);
    });
    const add = h("button", { class: "btn btn--soft btn--block tpl__new", type: "button" }, icons.plus(), "New template");
    add.addEventListener("click", () => {
      sheet.close();
      setTimeout(() => openTemplateEditor(null, { onSaved: () => openTemplatePicker(ctx) }), 260);
    });
    body.replaceChildren(
      h("p", { class: "tpl__lede" }, "Athena fills in what it knows and notes where each part came from. The rest is left for you."),
      h("ul", { class: "tpl__list", role: "list" }, ...cards),
      add
    );
  }

  async function choose(t: NoteTemplate) {
    const input: FillInput = {};
    for (const need of t.needs) {
      const picked = await pickContext(sheet, body, need, () => void paintList());
      if (picked === undefined) return; // went back
      Object.assign(input, picked);
    }
    await fill(sheet, body, t, input, ctx);
  }
}

function working(text: string): HTMLElement {
  return h("div", { class: "tpl__working", role: "status" }, h("span", { class: "doc-spin", "aria-hidden": "true" }), h("span", {}, text));
}

async function fill(sheet: SheetHandle, body: HTMLElement, t: NoteTemplate, input: FillInput, ctx: TemplateOpenContext) {
  body.replaceChildren(working("Filling in what Athena knows…"));
  try {
    const filled = await fillFromTemplate(t, input);
    if (input.event_id) void markPrepared(input.event_id);
    sheet.close();
    setTimeout(() => {
      ctx.openFilled({ title: filled.title, body: filled.body });
      const left = filled.blanks.length;
      showToast(left ? `${filled.filled.length} filled · ${left} left for you` : `${filled.filled.length} filled from Athena`, { icon: "sparkle" });
    }, 260);
  } catch (error) {
    body.replaceChildren(h("p", { class: "tpl__empty" }, error instanceof Error ? error.message : "Couldn't fill that in. Try again."));
  }
}

type Picked = Partial<FillInput> | null;

/** Ask what the template is about. undefined: they went back; null: skip (the fields stay blank). */
function pickContext(sheet: SheetHandle, body: HTMLElement, need: string, back: () => void): Promise<Picked | undefined> {
  return new Promise((resolve) => {
    sheet.setBack(() => {
      resolve(undefined);
      back();
    });
    const skip = h("button", { class: "btn btn--ghost btn--block", type: "button" }, "Skip: leave those parts blank");
    skip.addEventListener("click", () => resolve(null));
    const list = h("ul", { class: "tpl__choices", role: "list" });
    const row = (lead: HTMLElement, title: string, sub: string, value: Picked) => {
      const b = h("button", { class: "tpl-choice", type: "button" }, lead, h("span", { class: "tpl-choice__text" }, h("span", { class: "tpl-choice__title" }, title), sub ? h("span", { class: "tpl-choice__sub" }, sub) : null));
      b.addEventListener("click", () => resolve(value));
      return h("li", {}, b);
    };
    const tile = (icon: IconName) => h("span", { class: "tile tile--sm", "aria-hidden": "true" }, icons[icon]());
    const empty = (text: string) => h("li", { class: "tpl__empty" }, text);
    const titles: Record<string, string> = { meeting: "Which meeting?", person: "Who's it with?", trip: "Which trip?", project: "Which project?", week: "Which week?" };
    sheet.setTitle(titles[need] ?? "What's it about?");
    let search: HTMLInputElement | null = null;

    if (need === "week") {
      // This week or last.
      const today = new Date();
      const last = new Date(today.getTime() - 7 * 86_400_000).toISOString().slice(0, 10);
      list.append(row(tile("week"), "This week", "", { week_of: null }), row(tile("week"), "Last week", "", { week_of: last }));
    } else if (need === "meeting") {
      list.append(h("li", { class: "tpl__loading" }, h("span", { class: "doc-spin", "aria-hidden": "true" })));
      void loadUpcoming(7).then(({ upcoming }) => {
        const meetings = upcoming.events.filter((e) => e.time && e.event.kind !== "birthday" && e.event.kind !== "anniversary").slice(0, 12);
        list.replaceChildren(...(meetings.length ? meetings.map((m) => row(tile("calendar"), m.event.title, m.starts_at ? when(m.starts_at) : m.occurs_on, { event_id: m.event.id })) : [empty("No meetings in the next week.")]));
      });
    } else if (need === "trip") {
      void loadTrips().then(({ items }) => {
        const trips = items.filter((t) => !t.archived_at).slice(0, 12);
        list.replaceChildren(...(trips.length ? trips.map((t) => row(tile("suitcase"), t.title, t.starts_on ?? "", { trip_id: t.id })) : [empty("No trips yet.")]));
      });
    } else if (need === "person" || need === "project") {
      search = h("input", { class: "tpl-input tpl__search", type: "search", placeholder: need === "person" ? "Search people" : "Search projects", "aria-label": need === "person" ? "Search people" : "Search projects", autocomplete: "off" }) as HTMLInputElement;
      void (need === "person" ? loadRecords("person").then((r) => r.items) : loadProjects()).then((items) => {
        const all = items as Array<{ id: string; name: string; relationship?: string }>;
        const paint = () => {
          const q = search!.value.trim().toLowerCase();
          const shown = all.filter((x) => !q || x.name.toLowerCase().includes(q)).slice(0, 20);
          list.replaceChildren(
            ...(shown.length
              ? shown.map((x) =>
                  row(
                    need === "person" ? h("span", { class: "avatar avatar--row", style: `--h:${hueFor(x.name)}`, "aria-hidden": "true" }, initials(x.name)) : tile("project"),
                    x.name,
                    x.relationship ?? "",
                    need === "person" ? { person_ids: [x.id] } : { project_id: x.id }
                  )
                )
              : [empty("Nobody by that name.")])
          );
        };
        search!.addEventListener("input", paint);
        paint();
      });
    }
    body.replaceChildren(...(search ? [search] : []), list, skip);
    search?.focus();
  });
}

// ---------- the editor ----------

/** Edit a template, make a new one, or ("Save as template") start one from a note. */
export function openTemplateEditor(t: NoteTemplate | null, opts: { from?: { name: string; body: string }; onSaved?: (t: NoteTemplate) => void } = {}): void {
  const isNew = !t;
  const name = h("input", { class: "tpl-input tpl-ed__name", type: "text", name: "name", maxlength: 80, placeholder: "Template name", "aria-label": "Template name", value: t?.name ?? opts.from?.name ?? "" }) as HTMLInputElement;
  const text = h("textarea", { class: "tpl-ed__body", name: "body", rows: 14, spellcheck: "true", "aria-label": "Template", placeholder: "# {{meeting}}\n\n{{date}} · {{attendees}}" }) as HTMLTextAreaElement;
  text.value = t?.body ?? opts.from?.body ?? "";
  const found = h("ul", { class: "tpl-ed__found", role: "list", "aria-live": "polite" });

  const paintFound = () => {
    const fields = parseTemplate(text.value);
    found.replaceChildren(
      ...(fields.length
        ? fields.map((f) =>
            h(
              "li",
              { class: `tpl-ed__field${f.info ? "" : " is-unknown"}` },
              h("code", {}, `{{${f.name}}}`),
              h("span", {}, f.info ? f.info.source : "Athena doesn't know this one, so it stays blank for you")
            )
          )
        : [h("li", { class: "tpl-ed__none" }, "No fields yet. Add one below, or type {{ and a name.")])
    );
  };
  text.addEventListener("input", paintFound);

  const insert = (key: string) => {
    const token = `{{${key}}}`;
    const { selectionStart: a, selectionEnd: b, value } = text;
    text.value = value.slice(0, a) + token + value.slice(b);
    text.focus();
    text.setSelectionRange(a + token.length, a + token.length);
    paintFound();
  };
  const palette = h(
    "div",
    { class: "tpl-ed__palette" },
    ...GROUPS.map((g) =>
      h(
        "div",
        { class: "tpl-ed__group" },
        h("p", { class: "tpl-ed__group-label" }, g.label),
        h(
          "div",
          { class: "chip-row tpl-ed__chips" },
          ...g.keys.map((k) => {
            const info = fieldInfo(k) ?? FIELDS[0];
            const c = h("button", { class: "chip", type: "button", title: info.source, "aria-label": `Add ${k}: ${info.source}` }, k);
            c.addEventListener("click", () => insert(k));
            return c;
          })
        )
      )
    )
  );

  const error = h("p", { class: "tpl-ed__error", role: "alert", hidden: true });
  const save = h("button", { class: "btn btn--primary", type: "submit" }, isNew ? "Save template" : "Save") as HTMLButtonElement;
  const extra: HTMLElement[] = [];
  // One the owner wrote can be shared; Athena's starters and ones added from someone else can't.
  if (t && !t.starter && !t.shared) {
    const share = h("button", { class: "btn btn--ghost", type: "button" }, icons.send(), "Share");
    share.addEventListener("click", () => {
      sheet.close();
      setTimeout(() => void import("./template-share-sheet").then((m) => m.openShareTemplate(t)), 260);
    });
    extra.push(share);
  }
  if (t && t.starter && t.edited) {
    const reset = h("button", { class: "btn btn--ghost", type: "button" }, icons.restore(), "Put back the original");
    reset.addEventListener("click", async () => {
      await archiveTemplate(t.id);
      sheet.close();
      showToast(`${t.name} is back as it was`, { icon: "restore", action: { label: "Undo", run: () => void archiveTemplate(t.id, false) } });
      opts.onSaved?.(t);
    });
    extra.push(reset);
  } else if (t && !t.starter) {
    const remove = h("button", { class: "btn btn--ghost", type: "button" }, icons.archive(), "Remove");
    remove.addEventListener("click", async () => {
      await archiveTemplate(t.id);
      sheet.close();
      showToast(`Removed ${t.name}`, { icon: "archive", action: { label: "Undo", run: () => void archiveTemplate(t.id, false) } });
    });
    extra.push(remove);
  }

  // Someone else's: who made it, what they said it's for, and Community's word on it.
  const origin = t?.shared
    ? h(
        "section",
        { class: "tpl-ed__origin", "aria-label": "Where this template came from" },
        h("span", { class: "tpl-ed__origin-icon", "aria-hidden": "true" }, icons.copy()),
        h(
          "div",
          { class: "tpl-ed__origin-text" },
          h("p", { class: "tpl-ed__origin-title" }, sharedByWords(t.shared)),
          t.shared.summary ? h("p", { class: "tpl-ed__origin-sub" }, t.shared.summary) : null,
          h("p", { class: "tpl-ed__origin-sub" }, sharedChangeWords(t.shared.changed))
        )
      )
    : null;
  // The editor has its own Remove, so the taken-down banner only says why.
  const status = t?.shared?.catalogue_id ? catalogueStatus("template", t.id, { actions: false }) : null;

  const form = h(
    "form",
    { class: "tpl-ed", novalidate: true },
    origin,
    status,
    h("label", { class: "tpl-ed__label" }, h("span", {}, "Name"), name),
    h("label", { class: "tpl-ed__label" }, h("span", {}, "Template"), text),
    h("section", { class: "tpl-ed__section", "aria-label": "Fields in this template" }, h("p", { class: "tpl-ed__heading" }, "Fields in this template"), found),
    h("section", { class: "tpl-ed__section", "aria-label": "Add a field" }, h("p", { class: "tpl-ed__heading" }, "Add a field"), palette),
    error,
    h("div", { class: "tpl-ed__actions" }, ...extra, h("span", { class: "tpl-ed__spacer" }), save)
  ) as HTMLFormElement;

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    error.hidden = true;
    if (!name.value.trim()) {
      error.textContent = "Give it a name";
      error.hidden = false;
      name.focus();
      return;
    }
    save.disabled = true;
    try {
      const saved = t ? await updateTemplate(t.id, { name: name.value, body: text.value }) : await createTemplate({ name: name.value, body: text.value });
      sheet.close();
      showToast(isNew ? `Saved “${saved.name}” as a template` : "Template saved", { icon: "check" });
      opts.onSaved?.(saved);
    } catch (err) {
      error.textContent = err instanceof Error ? err.message : "Couldn't save that";
      error.hidden = false;
    } finally {
      save.disabled = false;
    }
  });

  const sheet = openSheet({ label: isNew ? "New template" : `Edit ${t!.name}`, title: isNew ? (opts.from ? "Save as template" : "New template") : "Edit template", body: form, variant: "tall" });
  (sheet.dialog.querySelector(".sheet__scroll") as HTMLElement).replaceChildren(form);
  paintFound();
}
