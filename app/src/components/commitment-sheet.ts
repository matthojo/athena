/**
 * A to-do, open: everything about one thing you mean to do, laid out like a
 * page rather than a form.
 *
 *   ◯  Title                                   (tick it here too)
 *      [Fri] [Priya] [▮▮▯ Medium] [● Work] [Computer]
 *      Description   rich text; @ links people, notes, anything
 *      Steps 2 of 5  a checklist you can type, tick, reorder and paste into
 *      Links         web pages and things in Athena
 *
 * The kind (to do, waiting on, a decision) is a quiet switch at the top.
 * Existing to-dos save as you change them; a new one is created by its Add
 * button (or ⌘↵), with everything filled in so far. When an agent filed it,
 * the sheet shows where it came from and the words it was taken from, so
 * you can judge it.
 */

import { placeMenuAcross } from "../lib/menu-place";
import { h } from "../lib/dom";
import { icons, type IconName } from "./icons";
import { openSheet } from "./sheet";
import { showToast } from "./toast";
import { confirmDialog } from "./confirm";
import { choiceChips } from "./fields";
import { dismissSuggested, personSuggestion } from "./person-suggestion";
import { loadTodoPeople } from "../db/todo-people";
import { contextPill, duePill, personPill, priorityPill } from "./todo-props";
import { stepsEditor } from "./todo-steps";
import { linksEditor } from "./todo-links";
import { openDraftSheet } from "./draft-sheet";
import { openCreateSheet } from "./create-sheet";
import { blockTime } from "../db/scheduling";
import { blockAsk } from "../lib/create-event";
import { deleteMemoryForever, saveCommitment, setMemoryArchived } from "../db/memory";
import { searchEntities } from "../db/data";
import { COMMITMENT_META } from "../lib/memory-meta";
import { describeSource } from "../lib/sources";
import { relativeTime } from "../lib/format";
import { openAppLink } from "../lib/app-links";
import { prefersReducedMotion } from "../lib/motion";
import { linkTarget, stepProgress, type TodoLink, type TodoPriority, type TodoStep } from "../../../lib/todo-details";
import type { NoteEditorHandle } from "../editor/editor";
import type { Commitment, CommitmentKind, PersonRef } from "../types";
import "../styles/todo-detail.css";

let editorModule: Promise<typeof import("../editor/editor")> | null = null;
const loadEditor = () => (editorModule ??= import("../editor/editor"));

const PLACEHOLDER: Record<CommitmentKind, string> = {
  todo: "What needs doing?",
  i_owe: "What needs doing?",
  waiting_on: "What are you waiting for?",
  decision: "What did you decide?",
};

let sheetSeq = 0;

/** "Fairly sure (72%)" — how sure the agent was, in words first. */
export function confidenceLabel(confidence: number): string {
  const pct = Math.round(confidence * 100);
  const words = confidence >= 0.9 ? "Very sure" : confidence >= 0.75 ? "Fairly sure" : confidence >= 0.6 ? "Not certain" : "A guess";
  return `${words} (${pct}%)`;
}

/** Where an agent found something: the source and, when there is one, the exact words. */
export function provenanceBlock(p: { source?: string | null; source_quote?: string | null; confidence?: number | null }, at?: string): HTMLElement | null {
  if (!p.source || p.source === "manual") return null;
  const src = describeSource(p.source);
  return h(
    "figure",
    { class: "provenance" },
    h(
      "figcaption",
      { class: "provenance__head" },
      icons.sparkle(),
      h("span", {}, `From ${src.name}${src.label ? ` · ${src.label}` : ""}${at ? ` · ${relativeTime(at)}` : ""}`),
      typeof p.confidence === "number" ? h("span", { class: "provenance__confidence" }, confidenceLabel(p.confidence)) : null
    ),
    p.source_quote ? h("blockquote", { class: "provenance__quote" }, `“${p.source_quote.replace(/^[“"]|[”"]$/g, "")}”`) : null
  );
}

/** "With", "For", "Waiting on", "Decided with": what the person is to this to-do. */
const personWord = (kind: CommitmentKind): string => (kind === "waiting_on" ? "Waiting on" : kind === "decision" ? "Decided with" : kind === "i_owe" ? "For" : "With");

export function openCommitmentSheet(
  initial: Commitment | null,
  opts: { kind?: CommitmentKind; title?: string; person?: PersonRef | null; due?: string | null; area_id?: string | null; where_id?: string | null; onSaved?: (c: Commitment) => void } = {}
): void {
  let rec = initial;
  // The app shows three kinds; a to-do with someone attached is stored as i_owe.
  type Choice = "todo" | "waiting_on" | "decision";
  const startKind = initial?.kind ?? opts.kind ?? "todo";
  let choice: Choice = startKind === "i_owe" ? "todo" : startKind;
  let person: PersonRef | null = initial?.person ?? opts.person ?? null;
  const effectiveKind = (): CommitmentKind => (choice === "todo" ? (person ? "i_owe" : "todo") : choice);
  let kind: CommitmentKind = effectiveKind();
  let due: string | null = initial?.due_on ?? opts.due ?? null;
  let priority: TodoPriority = initial?.priority ?? 0;
  let areaId: string | null = initial?.area_id ?? opts.area_id ?? null;
  let whereId: string | null = initial?.where_id ?? opts.where_id ?? null;
  let notes = initial?.notes ?? "";
  let saving: Promise<void> = Promise.resolve();
  let dead = false;
  const uid = `loop-${++sheetSeq}`;

  // ---------- title, with its own check ----------

  const title = h("textarea", { class: "todo-sheet__title", name: "title", rows: 1, maxlength: 300, "aria-label": "Title" }) as HTMLTextAreaElement;
  title.value = initial?.title ?? opts.title ?? "";
  title.placeholder = PLACEHOLDER[kind];
  const grow = () => {
    title.style.height = "auto";
    title.style.height = `${title.scrollHeight}px`;
  };
  title.addEventListener("input", () => {
    grow();
    addBtn.disabled = !title.value.trim();
  });
  title.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      if (rec) title.blur();
      else void create();
    }
  });
  title.addEventListener("change", () => {
    const v = title.value.trim();
    if (!rec) return;
    if (!v) title.value = rec.title;
    else if (v !== rec.title) save({ title: v });
  });

  const check = h("button", { class: "todo-sheet__check", type: "button", role: "checkbox", "aria-checked": "false" }, h("span", { class: "todo-sheet__ring", "aria-hidden": "true" }, icons.check())) as HTMLButtonElement;
  const flag = h("span", { class: "todo-sheet__flag", "aria-hidden": "true" }, icons.flag());
  check.addEventListener("click", () => {
    if (!rec) return;
    const next = rec.status === "open" ? "done" : "open";
    paintCheck(next === "done");
    if (next === "done" && !prefersReducedMotion()) {
      check.classList.remove("is-ticked");
      void check.offsetWidth;
      check.classList.add("is-ticked");
    }
    save({ status: next });
    if (next === "done") {
      const c = rec;
      void saving.then(() => {
        window.setTimeout(() => sheet.close(), prefersReducedMotion() ? 0 : 420);
        showToast(`Done: ${c.title}`, { icon: "check", action: { label: "Undo", run: () => void saveCommitment({ status: "open" }, c.id) } });
      });
    }
  });
  function paintCheck(done: boolean) {
    check.setAttribute("aria-checked", String(done));
    check.setAttribute("aria-label", done ? "Reopen this to-do" : "Mark this to-do done");
    head.dataset.state = done ? "done" : "open";
  }

  // ---------- kind ----------

  const kinds = choiceChips<Choice>(
    "Kind",
    (["todo", "waiting_on", "decision"] as Choice[]).map((k) => ({ value: k, label: k === "decision" ? "Decision" : COMMITMENT_META[k].label, icon: icons[COMMITMENT_META[k].icon as IconName]() })),
    choice,
    (c) => {
      choice = c;
      kind = effectiveKind();
      title.placeholder = PLACEHOLDER[kind];
      paintKind();
      if (rec) save({ kind });
    }
  );

  // ---------- properties ----------

  const dueP = duePill({
    value: () => due,
    onChange: (d) => {
      due = d;
      dueP.paint();
      if (rec) save({ due_on: d });
    },
  });
  const personP = personPill({
    value: () => person,
    label: () => personWord(effectiveKind()),
    onChange: (p) => {
      person = p;
      kind = effectiveKind();
      suggested.replaceChildren();
      personP.paint();
      if (rec) save({ person_id: p?.id ?? null, kind });
    },
  });
  const priorityP = priorityPill({
    value: () => priority,
    onChange: (p) => {
      priority = p;
      priorityP.paint();
      if (rec) save({ priority: p });
    },
  });
  // Area and where/how. When Athena chose them, a quiet note says so; picking one makes it yours.
  const byAthena = h("span", { class: "ctx-by-athena todo-sheet__by", hidden: !initial?.context_by_athena }, icons.sparkle(), "Athena chose the area. Change it if it's wrong.");
  if (initial?.area_id && initial?.where_id) byAthena.lastChild!.textContent = "Athena chose the area and where. Change them if they're wrong.";
  else if (initial?.where_id && !initial?.area_id) byAthena.lastChild!.textContent = "Athena chose where. Change it if it's wrong.";
  const areaP = contextPill("area", {
    value: () => areaId,
    onChange: (id) => {
      areaId = id;
      byAthena.hidden = true;
      areaP.paint();
      if (rec) save({ area_id: id });
    },
  });
  const whereP = contextPill("where", {
    value: () => whereId,
    onChange: (id) => {
      whereId = id;
      byAthena.hidden = true;
      whereP.paint();
      if (rec) save({ where_id: id });
    },
  });
  const props = h("div", { class: "tprops", role: "group", "aria-label": "Details" }, dueP.el, personP.el, priorityP.el, areaP.el, whereP.el);

  // Nobody linked, but its words name someone: offer them under the properties. A tap picks them.
  const suggested = h("span", { class: "suggest-person__slot todo-sheet__suggest" });
  if (initial && !initial.person_id && initial.status === "open") {
    void loadTodoPeople().then((named) => {
      const who = named[initial.id];
      if (who?.length && !person)
        suggested.replaceChildren(
          personSuggestion(who, {
            link: (p) => {
              person = p;
              kind = effectiveKind();
              personP.paint();
              suggested.replaceChildren();
              if (rec) save({ person_id: p.id, kind });
            },
            dismiss: () => dismissSuggested(initial.id),
          })
        );
    });
  }

  // ---------- description ----------

  const descLabel = h("span", { class: "tsec__label" }, "Description");
  const descSlot = h("div", { class: "tdesc__body" });
  const descFallback = h("p", { class: "tdesc__placeholder" }, notes ? notes : "Add details");
  descSlot.append(descFallback);
  const desc = h("section", { class: "tsec tsec--desc", "aria-label": "Description" }, h("h3", { class: "tsec__head" }, icons.lines(), descLabel), descSlot);
  let editor: NoteEditorHandle | null = null;
  let notesTimer: number | undefined;
  const flushNotes = () => {
    clearTimeout(notesTimer);
    notesTimer = undefined;
    if (!rec || notes === rec.notes) return;
    save({ notes });
  };
  // A web link in the description opens itself; a link to a person, note or anything in Athena opens there, after the sheet closes.
  const openLinked = (kind: string, id: string) => {
    afterClose = () => openAppLink(kind, id);
    sheet.close();
  };
  void loadEditor().then(({ createNoteEditor }) => {
    if (dead) return;
    editor = createNoteEditor({
      markdown: notes,
      placeholder: "Add details. Type @ to link a person, a note or anything else",
      onChange(md) {
        notes = md;
        desc.toggleAttribute("data-empty", !md.trim());
        clearTimeout(notesTimer);
        notesTimer = window.setTimeout(flushNotes, 800);
      },
      onOpenLink: openLinked,
      search: async (q, k) => (await searchEntities(q, k)).results,
      mentions: async (q) => (await import("../db/mentions")).findMentions(q),
      thumb: (row) => (row.thumb ? import("../db/mentions").then((m) => m.mentionThumb(row)) : null),
      create: null,
    });
    descSlot.replaceChildren(editor.content);
    editor.content.addEventListener("focusout", flushNotes);
    desc.toggleAttribute("data-empty", !notes.trim());
  });

  // ---------- steps and links ----------

  const steps = stepsEditor({
    steps: initial?.steps ?? [],
    onChange: (next: TodoStep[]) => {
      paintNudge(next);
      if (rec) save({ steps: next });
    },
  });
  const links = linksEditor({
    links: initial?.links ?? [],
    selfId: () => rec?.id ?? null,
    onChange: (next: TodoLink[]) => {
      if (rec) save({ links: next });
    },
    onOpen: (link) => {
      const t = linkTarget(link);
      if (t) openLinked(t.kind, t.id);
    },
  });

  // Every step ticked, the to-do still open: offer to close it, never do it unasked.
  const nudgeBtn = h("button", { class: "btn btn--primary btn--sm", type: "button" }, icons.check(), "Mark the to-do done");
  const nudge = h("div", { class: "todo-sheet__nudge", role: "status", hidden: true }, h("span", { class: "todo-sheet__nudge-mark", "aria-hidden": "true" }, icons.check()), h("span", { class: "todo-sheet__nudge-text" }, "Every step's done"), nudgeBtn);
  nudgeBtn.addEventListener("click", () => check.click());
  function paintNudge(list: TodoStep[] = steps.steps()) {
    const p = stepProgress(list);
    nudge.hidden = !(rec && rec.status === "open" && rec.kind !== "decision" && p.total > 0 && p.done === p.total);
  }

  // ---------- actions ----------

  const addBtn = h("button", { class: "btn btn--primary", type: "button", disabled: !title.value.trim() }, icons.plus(), "Add") as HTMLButtonElement;
  addBtn.addEventListener("click", () => void create());
  const doneBtn = h("button", { class: "btn btn--soft", type: "button" }) as HTMLButtonElement;
  doneBtn.addEventListener("click", () => check.click());

  const draftBtn = h("button", { class: "btn btn--soft loop-sheet__draft", type: "button" }) as HTMLButtonElement;
  // Closing steps history back; the draft opens once that's landed, or the step would close it too.
  let afterClose: (() => void) | null = null;
  draftBtn.addEventListener("click", () => {
    if (!rec) return;
    const c = rec;
    // A reply to the email it came from is an email; anything else goes the way you usually talk.
    afterClose = () => openDraftSheet({ commitment: c, channel: /^email-digest/.test(c.source ?? "") ? "email" : undefined });
    sheet.close();
  });

  // "Block time for this": a free slot before it's due, as a focus block on your own calendar, after you confirm.
  const blockBtn = h("button", { class: "btn btn--soft btn--sm loop-sheet__block todo-sheet__block", type: "button" }, icons.clock(), "Block time for this") as HTMLButtonElement;
  blockBtn.addEventListener("click", () => {
    if (!rec) return;
    const ask = blockAsk(rec);
    afterClose = () => void openCreateSheet(blockTime(ask), { receiptInSheet: true, label: `Block time: ${ask.title}` });
    sheet.close();
  });

  const menuId = `${uid}-menu`;
  const moreBtn = h("button", { class: "icon-btn icon-btn--sm icon-btn--ghost", type: "button", "aria-label": "More actions", popovertarget: menuId }, icons.more()) as HTMLButtonElement;
  const menu = h("div", { class: "menu note-menu", id: menuId, popover: "auto" }) as HTMLElement & { hidePopover?: () => void };
  const menuItem = (icon: IconName, label: string, run: () => void, cls = "") => {
    const b = h("button", { class: `menu__item ${cls}`, type: "button" }, icons[icon](), label);
    b.addEventListener("click", () => {
      menu.hidePopover?.();
      run();
    });
    return b;
  };
  menu.replaceChildren(
    menuItem("close", "Drop it", () => {
      if (!rec) return;
      save({ status: "dropped" });
      void saving.then(() => {
        sheet.close();
        showToast("Dropped", { icon: "close", action: { label: "Undo", run: () => rec && void saveCommitment({ status: "open" }, rec.id) } });
      });
    }),
    menuItem("archive", "Archive", () => void archive()),
    h("div", { class: "menu__sep" }),
    menuItem("trash", "Delete permanently", () => void remove(), "menu__item--danger")
  );
  menu.addEventListener("toggle", (e) => {
    if ((e as ToggleEvent).newState !== "open") return;
    const r = moreBtn.getBoundingClientRect();
    menu.style.top = `${Math.min(r.bottom + 6, window.innerHeight - 160)}px`;
    placeMenuAcross(menu, moreBtn);
  });

  const foot = h("div", { class: "loop-sheet__foot todo-sheet__foot" });
  const provenance = h("div", { class: "todo-sheet__provenance" });

  function paintKind() {
    const decision = choice === "decision";
    head.dataset.kind = decision ? "decision" : "loop";
    descLabel.textContent = decision ? "Why" : "Description";
    steps.el.hidden = decision;
    dueP.el.hidden = priorityP.el.hidden = areaP.el.hidden = whereP.el.hidden = decision;
    byAthena.hidden = decision || !rec?.context_by_athena;
    personP.paint();
    paintNudge();
    paintFoot();
  }

  function paintFoot() {
    moreBtn.hidden = !rec;
    blockBtn.hidden = true;
    check.disabled = !rec;
    if (!rec) {
      foot.replaceChildren(h("span", { class: "loop-sheet__hint" }, h("kbd", {}, "⌘↵"), " to add"), addBtn);
      return;
    }
    paintCheck(rec.status !== "open");
    doneBtn.replaceChildren(...(rec.status === "open" ? [icons.check(), "Mark done"] : [icons.restore(), "Reopen"]));
    doneBtn.hidden = rec.kind === "decision";
    const status =
      rec.kind === "decision"
        ? `Recorded ${relativeTime(rec.created_at)}`
        : rec.status === "done" && rec.done_at
          ? `Done ${relativeTime(rec.done_at)}`
          : rec.status === "dropped"
            ? "Dropped"
            : `Added ${relativeTime(rec.created_at)}`;
    // Something owed to or by a person can turn into a message for you to send; one from an email gets a reply.
    draftBtn.hidden = !(rec.person && rec.status === "open" && (rec.kind === "i_owe" || rec.kind === "waiting_on"));
    blockBtn.hidden = !(rec.status === "open" && (rec.kind === "todo" || rec.kind === "i_owe"));
    const fromEmail = /^email-digest/.test(rec.source ?? "");
    draftBtn.replaceChildren(fromEmail ? icons.mail() : icons.pen(), fromEmail ? "Draft a reply" : "Draft a message");
    foot.replaceChildren(h("span", { class: "loop-sheet__hint" }, status), h("span", { class: "loop-sheet__actions" }, draftBtn, doneBtn));
    provenance.replaceChildren(...[provenanceBlock(rec, rec.created_at)].filter((x): x is HTMLElement => !!x));
  }

  function save(patch: Partial<Commitment>) {
    saving = saving.then(async () => {
      if (!rec) return;
      try {
        rec = await saveCommitment(patch, rec.id);
        opts.onSaved?.(rec);
        if (!dead) {
          paintFoot();
          paintNudge();
        }
      } catch (error) {
        showToast(error instanceof Error ? error.message : "Couldn't save", { icon: "wifiOff", timeoutMs: 4000 });
      }
    });
  }

  async function create() {
    const v = title.value.trim();
    if (!v || rec) return;
    addBtn.disabled = true;
    try {
      kind = effectiveKind();
      const decision = kind === "decision";
      const created = await saveCommitment({
        title: v,
        kind,
        person_id: person?.id ?? null,
        due_on: decision ? null : due,
        notes: editor ? editor.getMarkdown() : notes,
        links: links.links(),
        ...(decision ? {} : { area_id: areaId, where_id: whereId, priority, steps: steps.steps() }),
      });
      opts.onSaved?.(created);
      sheet.close();
      showToast(decision ? "Decision recorded" : kind === "waiting_on" ? "Added to Waiting on" : "Added to To do", { icon: decision ? "flag" : "check" });
    } catch (error) {
      addBtn.disabled = false;
      showToast(error instanceof Error ? error.message : "Couldn't add it", { icon: "wifiOff", timeoutMs: 4000 });
    }
  }

  async function archive() {
    if (!rec) return;
    const { id } = rec;
    try {
      await setMemoryArchived("commitment", id, true);
      sheet.close();
      showToast("Archived", { icon: "archive", action: { label: "Undo", run: () => void setMemoryArchived("commitment", id, false) } });
    } catch (error) {
      showToast(error instanceof Error ? error.message : "Couldn't archive", { icon: "wifiOff" });
    }
  }

  async function remove() {
    if (!rec) return;
    const ok = await confirmDialog({
      title: "Delete this permanently?",
      body: `“${rec.title}” is removed from Athena everywhere. This can't be undone.`,
      confirmLabel: "Delete permanently",
      danger: true,
    });
    if (!ok) return;
    try {
      await deleteMemoryForever("commitment", rec.id);
      sheet.close();
      showToast("Deleted permanently", { icon: "trash" });
    } catch (error) {
      showToast(error instanceof Error ? error.message : "Couldn't delete", { icon: "wifiOff" });
    }
  }

  const head = h("div", { class: "todo-sheet__head", "data-state": "open" }, check, flag, title);
  const body = h(
    "div",
    { class: "loop-sheet todo-sheet" },
    h("div", { class: "loop-sheet__top todo-sheet__top" }, kinds.el, h("span", { class: "note__bar-spacer" }), moreBtn, menu),
    head,
    h("div", { class: "todo-sheet__props" }, props, byAthena, suggested),
    desc,
    steps.el,
    nudge,
    links.el,
    h("div", { class: "todo-sheet__extras" }, blockBtn),
    provenance,
    foot
  );

  const sheet = openSheet({
    label: initial ? initial.title : "New to-do",
    title: initial ? undefined : "New to-do",
    body,
    onClose: () => {
      flushNotes();
      dead = true;
      editor?.destroy();
      afterClose?.();
    },
  });
  sheet.dialog.classList.add("sheet--todo");
  paintKind();
  requestAnimationFrame(() => {
    grow();
    if (!initial) title.focus();
  });
  sheet.dialog.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      if (!rec) void create();
      else if (rec.kind !== "decision") check.click();
    }
  });
}
