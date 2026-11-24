/**
 * How an assistant works for you, on its page (team-detail.ts), read as
 * sentences rather than a form:
 *
 * - Its brief: when it runs, what it can do alone, and its instructions. Each
 *   is one line you tap to change, in a sheet with Save and Cancel, so a
 *   stray tap never changes what it may do.
 * - What it knows about you: its memory, with Forget on each thing and on all.
 * - Its personality and looks: the greeting it says, its character in one line,
 *   and how it looks, each a tap away.
 *
 * Each section paints once the assistant has loaded (`paint`), and again
 * after a change.
 */
import { h } from "../lib/dom";
import { icons } from "../components/icons";
import { openSheet, type SheetHandle } from "../components/sheet";
import { confirmDialog } from "../components/confirm";
import { showToast } from "../components/toast";
import { forgetMemory, type TeamAssistant, type TeamAssistantInput } from "../db/team";
import { MAX_INSTRUCTIONS, PRONOUNS, TONES, type Personality, type TeamTrigger, type TeamTriggerInput } from "../../../lib/team-types";
import { renderAvatarTile } from "./avatar";
import { ALLOW_OPTIONS, allowFor, allowOption, allowSummary } from "./setup-allow";
import { triggerList } from "./trigger-editor";
import { triggerSentence } from "./trigger-editor-words";
import { cap, characterWords, looksWords, pronouns } from "./detail-words";
import { webRow } from "./detail-web";
import { askWebOn } from "./web-access";

export interface BriefContext {
  get: () => TeamAssistant;
  save: (patch: TeamAssistantInput) => Promise<boolean>;
}

/** A trigger as PATCH takes it: its id keeps it (and its last slot). */
export function triggerInput(t: TeamTrigger | TeamTriggerInput): TeamTriggerInput {
  const out: TeamTriggerInput = { kind: t.kind };
  if (t.id) out.id = t.id;
  if (t.kind === "schedule") {
    out.days = t.days ?? [];
    out.time = t.time ?? "09:00";
  } else if (t.event) out.event = t.event;
  if (t.paused) out.paused = true;
  return out;
}

/** One line of the brief: what it's about, the sentence, and a quiet note; tapping it opens its editor. */
function row(o: { key: string; label: string; value: Node | string; note?: string | null; edit: string; open: () => void; clamp?: boolean }): HTMLElement {
  const b = h(
    "button",
    { class: "tdb-row", type: "button", "data-edit": o.key, "aria-label": `${o.edit}: ${typeof o.value === "string" ? o.value : (o.value.textContent ?? "")}` },
    h("span", { class: "tdb-row__label" }, o.label),
    h("span", { class: `tdb-row__value${o.clamp ? " is-clamped" : ""}` }, o.value),
    o.note ? h("span", { class: "tdb-row__note" }, o.note) : null,
    h("span", { class: "tdb-row__go", "aria-hidden": "true" }, icons.chevronRight())
  );
  b.addEventListener("click", o.open);
  return b;
}

/** A sheet with an editor and Save and Cancel at its foot. Save closes it when the change is kept. */
function editSheet(o: { label: string; title: string; lede?: string; body: HTMLElement; save: () => Promise<boolean>; saveLabel?: string }): SheetHandle {
  const save = h("button", { class: "btn btn--primary", type: "button" }, o.saveLabel ?? "Save");
  const cancel = h("button", { class: "btn btn--soft", type: "button" }, "Cancel");
  const handle = openSheet({ label: o.label, title: o.title, body: h("div", { class: "tdb-sheet" }, o.lede ? h("p", { class: "tdb-sheet__lede" }, o.lede) : null, o.body, h("div", { class: "tdb-sheet__foot" }, cancel, save)) });
  cancel.addEventListener("click", () => handle.close());
  save.addEventListener("click", async () => {
    if (save.getAttribute("aria-disabled") === "true") return;
    save.setAttribute("aria-disabled", "true");
    const ok = await o.save().catch(() => false);
    save.removeAttribute("aria-disabled");
    if (ok) handle.close();
  });
  return handle;
}

// ---------- the brief ----------

export function briefSection(ctx: BriefContext): { el: HTMLElement; paint: () => void } {
  const title = h("h2", { class: "td-sec__title", id: "tdb-title" });
  const rows = h("div", { class: "tdb-rows" });
  // "Let Ask search the web", read afresh each time the page opens (coming back from Settings included).
  let webSetting: boolean | null = null;
  void askWebOn(true).then((on) => {
    webSetting = on;
    if (rows.childElementCount) paint();
  });
  const el = h("section", { class: "td-sec tdb", "aria-labelledby": "tdb-title" }, h("header", { class: "td-sec__head" }, title), rows);

  function editWhen() {
    const a = ctx.get();
    let draft = a.triggers.map(triggerInput);
    const list = triggerList(draft, (ts) => (draft = ts), a.name);
    editSheet({
      label: "When it runs",
      title: `When ${a.name} runs`,
      body: h("div", { class: "tdb-when" }, list.el),
      save: () => ctx.save({ triggers: draft.map(triggerInput) }).then((ok) => (ok && paint(), ok)),
    });
  }

  function editAlone() {
    const a = ctx.get();
    let allow = [...a.allow];
    const tools = allowFor(a.job, a.allow);
    const swRow = (tool: string) => {
      const o = allowOption(tool);
      const id = `tdb-allow-${tool}`;
      const sw = h("input", { type: "checkbox", role: "switch", class: "switch", id, "aria-describedby": `${id}-d` }) as HTMLInputElement;
      sw.checked = allow.includes(tool);
      sw.addEventListener("change", () => {
        allow = sw.checked ? [...new Set([...allow, tool])] : allow.filter((t) => t !== tool);
      });
      return h("label", { class: "td-allow", for: id }, h("span", { class: "td-allow__text" }, h("span", { class: "td-allow__label" }, o.label), o.detail ? h("span", { class: "td-allow__detail", id: `${id}-d` }, o.detail) : null), sw);
    };
    const list = h("div", { class: "td-allows" }, ...tools.map(swRow));
    const rest = ALLOW_OPTIONS.filter((o) => !tools.includes(o.tool));
    const more = rest.length ? h("button", { class: "btn btn--ghost btn--sm td-more", type: "button" }, `More ${a.name} could do (${rest.length})`) : null;
    more?.addEventListener("click", () => {
      more.remove();
      list.append(...rest.map((o) => swRow(o.tool)));
    });
    editSheet({
      label: "What it can do alone",
      title: `What ${a.name} can do alone`,
      lede: `${a.name} does the things switched on here without asking. Anything off becomes a plan that waits for your approval. You can undo any change in What Ask did.`,
      body: h("div", {}, list, more),
      save: () => ctx.save({ allow }).then((ok) => (ok && paint(), ok)),
    });
  }

  function editInstructions() {
    const a = ctx.get();
    const area = h("textarea", { class: "td-area", rows: 8, maxlength: MAX_INSTRUCTIONS, "aria-label": "Instructions", placeholder: `What should ${a.name} know about doing the job?` }, a.instructions) as HTMLTextAreaElement;
    const handle = editSheet({
      label: "Instructions",
      title: `${a.name}'s instructions`,
      lede: `Write them as you'd brief a person. ${a.name} reads them on every chat and run.`,
      body: area,
      save: () => ctx.save({ instructions: area.value.trim() }).then((ok) => (ok && paint(), ok)),
    });
    area.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        handle.dialog.querySelector<HTMLButtonElement>(".tdb-sheet__foot .btn--primary")?.click();
      }
    });
    requestAnimationFrame(() => {
      area.focus({ preventScroll: true });
      area.setSelectionRange(area.value.length, area.value.length);
    });
  }

  function paint() {
    const a = ctx.get();
    const p = pronouns(a.personality);
    title.textContent = `${a.name}'s brief`;
    const when = a.triggers.length
      ? h("span", { class: "tdb-lines" }, ...a.triggers.map((t) => h("span", { class: `tdb-line${t.paused ? " is-off" : ""}` }, t.kind === "schedule" ? icons.clock() : icons.bell(), h("span", {}, triggerSentence(t) + (t.paused ? " (off)" : "")))))
      : `Only when you chat with ${p.them}`;
    // Each trigger is a flow it runs (lib/team-flows.ts), listed under "<Name>'s flows", where steps can go around the job.
    const flows = a.triggers.some((t) => t.flow_id);
    const alone = `${allowSummary(a.allow)}.`;
    const instructions = a.instructions.trim() ? a.instructions.trim() : `None yet. ${cap(p.they)} ${p.plural ? "work" : "works"} from ${p.their} job.`;
    rows.replaceChildren(
      row({ key: "when", label: "When it runs", value: when, ...(flows ? { note: `Each is one of ${a.name}'s flows, below: open one to add steps around the job.` } : {}), edit: "Change when it runs", open: editWhen }),
      row({ key: "alone", label: "What it can do alone", value: alone, note: a.allow.length ? "Anything else waits for your approval." : "Every change waits for your approval.", edit: "Change what it can do alone", open: editAlone }),
      webRow({ get: ctx.get, save: ctx.save, setting: () => webSetting, repaint: paint }),
      row({ key: "instructions", label: "Instructions", value: instructions, edit: "Change the instructions", open: editInstructions, clamp: !!a.instructions.trim() })
    );
  }

  return { el, paint };
}

// ---------- what it knows about you ----------

export function memorySection(ctx: BriefContext): { el: HTMLElement; paint: () => void } {
  const title = h("h2", { class: "td-sec__title", id: "tdm-title" });
  const box = h("div", { class: "tdm" });
  const el = h("section", { class: "td-sec", "aria-labelledby": "tdm-title" }, h("header", { class: "td-sec__head" }, title), box);

  async function forget(fact?: number) {
    const a = ctx.get();
    try {
      a.memory = await forgetMemory(a.id, fact);
      paint();
    } catch {
      showToast("Couldn't forget that. Try again.");
    }
  }

  function paint() {
    const a = ctx.get();
    const p = pronouns(a.personality);
    title.textContent = `What ${a.name} knows about you`;
    const m = a.memory;
    if (!m.summary.trim() && !m.facts.length) {
      box.replaceChildren(h("p", { class: "td-empty" }, `Nothing yet. What ${a.name} learns about you from your chats and runs shows here.`));
      return;
    }
    const facts = m.facts.map((f, i) => {
      const b = h("button", { class: "icon-btn icon-btn--sm icon-btn--ghost tdm-forget", type: "button", "aria-label": `Forget “${f}”`, title: "Forget this" }, icons.close());
      b.addEventListener("click", () => void forget(i));
      return h("li", { class: "tdm-fact" }, h("span", { class: "tdm-fact__text" }, f), b);
    });
    const all = h("button", { class: "btn btn--ghost btn--sm tdm-all", type: "button" }, "Forget all");
    all.addEventListener("click", async () => {
      const ok = await confirmDialog({ title: `Forget everything ${a.name} knows?`, body: `What ${p.they} ${p.plural ? "have" : "has"} learned about you goes. ${cap(p.their)} chats and runs stay.`, confirmLabel: "Forget all", danger: true });
      if (ok) await forget();
    });
    const parts: HTMLElement[] = [];
    if (m.summary.trim()) parts.push(h("p", { class: "tdm-summary" }, m.summary.trim()));
    if (facts.length) parts.push(h("ul", { class: "tdm-facts" }, ...facts));
    parts.push(h("p", { class: "tdm-foot" }, h("span", {}, "Learned from your chats and runs."), all));
    box.replaceChildren(...parts);
  }

  return { el, paint };
}

// ---------- personality and looks ----------

const TONE_WORD: Record<string, string> = { warm: "Warm", crisp: "Crisp", playful: "Playful", calm: "Calm", wry: "Wry" };
const PRONOUN_WORD: Record<string, string> = { she: "She", he: "He", they: "They" };

function chips<T extends string>(label: string, values: readonly T[], words: Record<string, string>, value: T, pick: (v: T) => Promise<boolean>): HTMLElement {
  const row = h("div", { class: "td-chips", role: "radiogroup", "aria-label": label });
  let current = value;
  const paint = () =>
    [...row.children].forEach((b) => {
      const on = (b as HTMLElement).dataset.v === current;
      b.setAttribute("aria-checked", on ? "true" : "false");
      b.setAttribute("tabindex", on ? "0" : "-1");
    });
  for (const v of values) {
    const b = h("button", { class: "chip td-chip", type: "button", role: "radio", "data-v": v }, words[v] ?? v);
    b.addEventListener("click", async () => {
      if (v === current) return;
      const was = current;
      current = v;
      paint();
      if (!(await pick(v))) {
        current = was;
        paint();
      }
    });
    row.append(b);
  }
  row.addEventListener("keydown", (e) => {
    const list = [...row.children] as HTMLElement[];
    const i = list.indexOf(document.activeElement as HTMLElement);
    const step = e.key === "ArrowRight" || e.key === "ArrowDown" ? 1 : e.key === "ArrowLeft" || e.key === "ArrowUp" ? -1 : 0;
    if (i < 0 || !step) return;
    e.preventDefault();
    const next = list[(i + step + list.length) % list.length];
    next.focus();
    next.click();
  });
  paint();
  return row;
}

export function personalitySection(ctx: BriefContext & { customise: () => void }): { el: HTMLElement; paint: () => void } {
  const title = h("h2", { class: "td-sec__title", id: "tdp-title" });
  const box = h("div", { class: "tdp" });
  const el = h("section", { class: "td-sec", "aria-labelledby": "tdp-title" }, h("header", { class: "td-sec__head" }, title), box);

  function editCharacter() {
    const a = ctx.get();
    const set = (patch: Partial<Personality>) => ctx.save({ personality: { ...ctx.get().personality, ...patch } }).then((ok) => (ok && paint(), ok));
    openSheet({
      label: "Personality",
      title: `${a.name}'s personality`,
      body: h(
        "div",
        { class: "tdb-sheet" },
        h("p", { class: "tdb-sheet__lede" }, `How ${a.name} sounds in chats and on Home. Changes save as you pick.`),
        h("p", { class: "td-label" }, "Tone"),
        chips("Tone", TONES, TONE_WORD, a.personality.tone, (tone) => set({ tone })),
        h("p", { class: "td-label" }, "Goes by"),
        chips("Pronoun", PRONOUNS, PRONOUN_WORD, a.personality.pronoun, (pronoun) => set({ pronoun }))
      ),
    });
  }

  function paint() {
    const a = ctx.get();
    const p = a.personality;
    title.textContent = "Personality";
    const pro = pronouns(p);
    box.replaceChildren(
      h("div", { class: "td-greet" }, renderAvatarTile(a.avatar, { size: 32 }), h("p", { class: "td-bubble" }, p.greeting || "Hi.")),
      h(
        "div",
        { class: "tdb-rows" },
        row({ key: "character", label: "Character", value: `${characterWords(p)}. Goes by ${pro.they}/${pro.them}.`, edit: "Change the personality", open: editCharacter }),
        row({ key: "looks", label: "Looks", value: `${looksWords(a.avatar)}.`, edit: "Customise the character", open: ctx.customise })
      )
    );
  }

  return { el, paint };
}
