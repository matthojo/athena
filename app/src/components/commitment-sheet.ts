/**
 * Add or edit an open loop in a sheet: what it is, which way it runs (to do,
 * I promised, waiting on, a decision), who with, when it's due. Existing loops save
 * as you change them; a new one is created by its Add button (or ⌘↵). When an
 * agent filed it, the sheet shows where it came from and the words it was
 * taken from, so you can judge it.
 */

import { placeMenuAcross } from "../lib/menu-place";
import { h } from "../lib/dom";
import { icons, type IconName } from "./icons";
import { openSheet } from "./sheet";
import { showToast } from "./toast";
import { confirmDialog } from "./confirm";
import { autoTextarea, choiceChips, dueDatePicker, field } from "./fields";
import { personPicker } from "./person-picker";
import { dismissSuggested, personSuggestion } from "./person-suggestion";
import { loadTodoPeople } from "../db/todo-people";
import { contextPicker } from "./todo-context-ui";
import { openDraftSheet } from "./draft-sheet";
import { openCreateSheet } from "./create-sheet";
import { blockTime } from "../db/scheduling";
import { blockAsk } from "../lib/create-event";
import { deleteMemoryForever, saveCommitment, setMemoryArchived } from "../db/memory";
import { COMMITMENT_META } from "../lib/memory-meta";
import { describeSource } from "../lib/sources";
import { relativeTime } from "../lib/format";
import type { Commitment, CommitmentKind, PersonRef } from "../types";

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
  let saving: Promise<void> = Promise.resolve();
  const uid = `loop-${++sheetSeq}`;

  const title = h("textarea", { class: "note__title-input loop-sheet__title", name: "title", rows: 1, maxlength: 300, "aria-label": "Title" }) as HTMLTextAreaElement;
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

  const kinds = choiceChips<Choice>(
    "Kind",
    (["todo", "waiting_on", "decision"] as Choice[]).map((k) => ({ value: k, label: k === "decision" ? "Decision" : COMMITMENT_META[k].label, icon: icons[COMMITMENT_META[k].icon as IconName]() })),
    choice,
    (c) => {
      choice = c;
      kind = effectiveKind();
      title.placeholder = PLACEHOLDER[kind];
      dueRow.hidden = c === "decision";
      areaRow.hidden = whereRow.hidden = c === "decision";
      notesRow.querySelector(".prop__label")!.textContent = c === "decision" ? "Why" : "Notes";
      if (rec) save({ kind });
    }
  );

  const picker = personPicker({
    value: person,
    label: "With",
    placeholder: "Someone (optional)",
    onChange: (p) => {
      person = p;
      kind = effectiveKind();
      suggested.replaceChildren();
      if (rec) save({ person_id: p?.id ?? null, kind });
    },
  });
  // Nobody linked, but its words name someone: offer them under the picker. A tap picks them as the picker would.
  const suggested = h("span", { class: "suggest-person__slot" });
  if (initial && !initial.person_id && initial.status === "open") {
    void loadTodoPeople().then((named) => {
      const who = named[initial.id];
      if (who?.length && !person) suggested.replaceChildren(personSuggestion(who, { link: (p) => picker.set(p), dismiss: () => dismissSuggested(initial.id) }));
    });
  }
  const duePicker = dueDatePicker(due, (d) => {
    due = d;
    if (rec) save({ due_on: d });
  });
  const notes = autoTextarea(initial?.notes ?? "", { name: "notes", placeholder: "Add context", "aria-label": "Notes" }, 44);
  notes.addEventListener("change", () => rec && save({ notes: notes.value }));

  const dueRow = field("Due", duePicker.el);
  dueRow.hidden = kind === "decision";

  // Area and where/how. When Athena chose them, a quiet note says so; picking one makes it yours.
  let areaId: string | null = initial?.area_id ?? opts.area_id ?? null;
  let whereId: string | null = initial?.where_id ?? opts.where_id ?? null;
  const both = !!(initial?.area_id && initial?.where_id);
  const byAthena = h("span", { class: "ctx-by-athena", hidden: !initial?.context_by_athena }, icons.sparkle(), both ? "Athena chose these. Tap to change." : "Athena chose this. Tap to change.");
  const areaPicker = contextPicker("area", areaId, (id) => {
    areaId = id;
    byAthena.hidden = true;
    if (rec) save({ area_id: id });
  });
  const wherePicker = contextPicker("where", whereId, (id) => {
    whereId = id;
    byAthena.hidden = true;
    if (rec) save({ where_id: id });
  });
  // The note sits under the last picker Athena filled.
  const areaRow = field("Area", areaPicker.el, initial?.where_id ? null : byAthena);
  const whereRow = field("Where", wherePicker.el, initial?.where_id ? byAthena : null);
  areaRow.hidden = whereRow.hidden = kind === "decision";
  areaRow.classList.add("prop--ctx");
  whereRow.classList.add("prop--ctx");

  const notesRow = field(kind === "decision" ? "Why" : "Notes", notes);
  const fields = h("div", { class: "card card--flush fields" }, field("With", picker.el, suggested), dueRow, areaRow, whereRow, notesRow);

  // ---------- actions ----------
  const addBtn = h("button", { class: "btn btn--primary", type: "button", disabled: !title.value.trim() }, icons.plus(), "Add") as HTMLButtonElement;
  addBtn.addEventListener("click", () => void create());
  const doneBtn = h("button", { class: "btn btn--soft", type: "button" }) as HTMLButtonElement;
  doneBtn.addEventListener("click", () => {
    if (!rec) return;
    const next = rec.status === "open" ? "done" : "open";
    save({ status: next });
    if (next === "done") void saving.then(() => sheet.close());
  });

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
  const blockBtn = h("button", { class: "btn btn--soft btn--sm loop-sheet__block", type: "button" }, icons.clock(), "Block time for this") as HTMLButtonElement;
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

  const foot = h("div", { class: "loop-sheet__foot" });
  const provenance = h("div", {});

  function paintFoot() {
    moreBtn.hidden = !rec;
    blockBtn.hidden = true;
    if (!rec) {
      foot.replaceChildren(h("span", { class: "loop-sheet__hint" }, "Return to add"), addBtn);
      return;
    }
    doneBtn.replaceChildren(...(rec.status === "open" ? [icons.check(), "Mark done"] : [icons.restore(), "Reopen"]));
    doneBtn.hidden = rec.kind === "decision";
    const status = rec.status === "done" && rec.done_at ? `Done ${relativeTime(rec.done_at)}` : rec.status === "dropped" ? "Dropped" : `Added ${relativeTime(rec.created_at)}`;
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
        paintFoot();
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
      const created = await saveCommitment({
        title: v,
        kind,
        person_id: person?.id ?? null,
        due_on: kind === "decision" ? null : due,
        notes: notes.value,
        ...(kind === "decision" ? {} : { area_id: areaId, where_id: whereId }),
      });
      opts.onSaved?.(created);
      sheet.close();
      showToast(kind === "decision" ? "Decision recorded" : kind === "waiting_on" ? "Added to Waiting on" : "Added to To do", { icon: kind === "decision" ? "flag" : "check" });
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

  const body = h(
    "div",
    { class: "loop-sheet" },
    h("div", { class: "loop-sheet__top" }, kinds.el, h("span", { class: "note__bar-spacer" }), moreBtn, menu),
    title,
    fields,
    blockBtn,
    provenance,
    foot
  );

  const sheet = openSheet({ label: initial ? initial.title : "New to-do", title: initial ? undefined : "New to-do", body, onClose: () => afterClose?.() });
  paintFoot();
  requestAnimationFrame(() => {
    grow();
    if (!initial) title.focus();
  });
  sheet.dialog.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && !rec) {
      e.preventDefault();
      void create();
    }
  });
}
