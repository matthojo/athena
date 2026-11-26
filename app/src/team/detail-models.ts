/**
 * "How <name> thinks", on an assistant's page: its thinking and its pictures, each "Same as Ask" or a
 * model of its own, through the same picker as Settings → AI models.
 * Pictures can also be none at all. Uses the assistant's own pronoun.
 */
import "../styles/models.css";
import { h } from "../lib/dom";
import { icons } from "../components/icons";
import { openModelPicker, nameOf } from "../components/models-picker";
import { notePieces, rowNote, savedWords, shownRef, type Resolved, type RowNote, type Target } from "../components/models-words";
import { assistantModels, ConsentNeeded, freshAssistantModels, loadModels, modelsNow, onModelsChange, saveAssistantModels } from "../db/models";
import type { TeamAssistant } from "../db/team";
import { sameRef, type AssistantModels, type ModelRef } from "../../../lib/model-types";
import { cap, pronouns } from "./detail-words";

export function modelsSection(get: () => TeamAssistant): { el: HTMLElement; paint: () => void; destroy: () => void } {
  const title = h("h2", { class: "td-sec__title", id: "tdmo-title" });
  const lede = h("p", { class: "tdmo-lede", id: "tdmo-lede" });
  const rows = h("div", { class: "tdmo-rows" });
  const live = h("p", { class: "visually-hidden", role: "status", "aria-live": "polite" });
  const el = h("section", { class: "td-sec tdmo", "aria-labelledby": "tdmo-title", "aria-describedby": "tdmo-lede" }, h("header", { class: "td-sec__head" }, title), lede, rows, live);
  let mine: AssistantModels = assistantModels(get());
  let saved: "think" | "image" | null = null;
  let failed = false;

  let liveTimer = 0;
  /** Say it once in the live region, after focus has settled (a focus change cuts speech off), then clear it so it isn't read again later. */
  function announce(text: string, delay = 450) {
    window.clearTimeout(liveTimer);
    live.textContent = "";
    liveTimer = window.setTimeout(() => {
      live.textContent = text;
      liveTimer = window.setTimeout(() => (live.textContent = ""), 6000);
    }, delay);
  }

  /** A row, and under it a note when its model has a newer version (Switch) or is gone (Pick another). */
  function row(key: "think" | "image", label: string, model: string, why: string, open: (from: HTMLElement) => void, note: RowNote | null, t: Target, change: (ref: ModelRef) => Promise<void>): HTMLElement[] {
    const id = `tdmo-${key}`;
    const b = h(
      "button",
      { class: `tdmo-row${note ? ` has-note is-${note.kind}` : ""}${saved === key ? " is-saved" : ""}`, type: "button", "data-model-row": `assistant-${key}`, "aria-haspopup": "dialog", "aria-labelledby": `${id}-l ${id}-m`, "aria-describedby": `${id}-w${note ? ` ${id}-n` : ""}` },
      h(
        "span",
        { class: "tdmo-row__body" },
        h("span", { class: "tdmo-row__label", id: `${id}-l` }, label),
        h("span", { class: "tdmo-row__model", id: `${id}-m` }, model),
        h("span", { class: "tdmo-row__why", id: `${id}-w` }, why)
      ),
      h("span", { class: "tdmo-row__chev", "aria-hidden": "true" }, icons.chevronRight())
    );
    b.addEventListener("click", () => open(b));
    if (!note) return [b];
    const act = h("button", { class: "btn btn--sm ms-note__act", type: "button", "aria-label": note.kind === "newer" ? note.label : `Pick another for ${label}` }, note.action);
    act.addEventListener("click", async () => {
      if (note.kind === "gone") return open(b);
      act.setAttribute("aria-disabled", "true");
      act.classList.add("is-busy");
      try {
        await change(note.ref);
        const m = modelsNow();
        announce(savedWords(t, m ? nameOf(note.ref, m) : note.ref.model));
        rows.querySelector<HTMLElement>(`[data-model-row="assistant-${key}"]`)?.focus({ preventScroll: true });
      } catch (e) {
        act.removeAttribute("aria-disabled");
        act.classList.remove("is-busy");
        if (e instanceof ConsentNeeded) return open(b);
        announce(e instanceof Error && e.message ? `That didn't save. ${e.message}` : "That didn't save. Try again.");
      }
    });
    const strip = h(
      "div",
      { class: `ms-note ms-note--${note.kind} ms-note--tdmo` },
      h("span", { class: "ms-note__icon", "aria-hidden": "true" }, note.kind === "gone" ? icons.flag() : icons.sparkle()),
      h("span", { class: "ms-note__text", id: `${id}-n` }, notePieces(note)[0], h("span", { class: "ms-note__name" }, notePieces(note)[1])),
      act
    );
    return [b, strip];
  }

  async function save(next: AssistantModels, key: "think" | "image", ref: ModelRef | null) {
    mine = await saveAssistantModels(get(), next, ref?.provider);
    // What the server resolves for the new choice (a newer version, or one gone), painted once, before focus returns to the row.
    await loadModels({ fresh: true }).catch(() => undefined);
    saved = key;
    paint();
  }

  function paint() {
    const a = get();
    const p = pronouns(a.personality);
    title.textContent = `How ${a.name} thinks`;
    const m = modelsNow();
    if (!m) {
      lede.textContent = failed ? "Models didn't load. Check you're online, then open this page again." : `${a.name} uses Ask's models unless you give ${p.them} ${p.their} own.`;
      rows.replaceChildren();
      return;
    }
    lede.textContent = `${a.name} uses Ask's models unless you give ${p.them} ${p.their} own.`;
    const base = { kind: "assistant" as const, id: a.id, name: a.name, their: p.their };
    const askThink = nameOf(m.effective.think.ref, m) ?? "";
    const askImage = m.effective.image ? nameOf(m.effective.image.ref, m) : null;

    // Its own models as they resolve on the server: what runs, a newer version, or one no longer offered.
    const own = m.effective.assistants?.[a.id] ?? null;
    // Only the server's word on the model saved now: until it's read again, an earlier choice's note would be stale.
    const fits = (r: Resolved | null | undefined, ref: ModelRef | null | undefined): Resolved | null => (r && ref && sameRef(shownRef(r), ref) ? r : null);
    const thinkR = fits(own?.think, mine.think);

    const think: Target = { ...base, role: "think" };
    const thinkRow = row("think", "Thinking", mine.think ? nameOf(mine.think, m) ?? "" : askThink, mine.think ? `${cap(p.their)} own` : "Same as Ask", (from) =>
      openModelPicker({
        target: think,
        current: mine.think ?? null,
        resolved: thinkR,
        inherited: askThink,
        from,
        announce,
        save: async (ref) => {
          const r = ref === "none" ? null : ref;
          const next = { ...mine };
          if (r) next.think = r;
          else delete next.think;
          await save(next, "think", r);
        },
      }),
      rowNote("think", thinkR, m.catalogue),
      think,
      (ref) => save({ ...mine, think: ref }, "think", ref)
    );

    const image: Target = { ...base, role: "image" };
    const none = mine.image === null;
    const ownImage = mine.image ? nameOf(mine.image, m) : null;
    const imageR = fits(own?.image, mine.image);
    const imageModel = none ? "No pictures" : ownImage ?? (askImage ?? "Off");
    const imageWhy = none ? `${a.name} won't make pictures` : ownImage ? `${cap(p.their)} own` : "Same as Ask";
    const imageRow = row("image", "Pictures", imageModel, imageWhy, (from) =>
      openModelPicker({
        target: image,
        current: mine.image ?? null,
        inherited: askImage ?? "Off",
        resolved: imageR,
        none: { label: "No pictures", detail: `${a.name} won't make pictures, even when Ask does`, selected: none },
        from,
        announce,
        save: async (ref) => {
          const next = { ...mine };
          if (ref === "none") next.image = null;
          else if (ref) next.image = ref;
          else delete next.image;
          await save(next, "image", ref === "none" ? null : ref);
        },
      }),
      rowNote("image", imageR, m.catalogue),
      image,
      (ref) => save({ ...mine, image: ref }, "image", ref)
    );
    rows.replaceChildren(...thinkRow, ...imageRow);
    saved = null;
  }

  const off = onModelsChange(() => {
    // Taking an agreement back can reset this assistant's own choices too.
    paint();
    void freshAssistantModels(get())
      .then((m) => {
        mine = m;
        paint();
      })
      .catch(() => undefined);
  });
  paint();
  void loadModels()
    .then(() => paint())
    .catch(() => {
      failed = true;
      paint();
    });
  return {
    el,
    // A new name or pronoun: the words change, the choices don't.
    paint,
    destroy: off,
  };
}
