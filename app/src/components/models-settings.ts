/**
 * Settings → AI models, #/settings/models:
 * which model does each job, and where that choice came from.
 *
 * - Ask: "Ask thinks with" and "Pictures" (off until chosen).
 * - Background work: "Everyday work" and "Careful work", then Advanced, each
 *   job on its own ("Same as Careful work" until set).
 * - Agreements: each company the owner agreed to send data to, what uses it,
 *   and Take back, which first says which choices go back to the default.
 *
 * Every row says what will really run and why, in words. Each opens the
 * picker (models-picker.ts). Saves are said in a polite live region, and the
 * row that changed settles in place.
 */
import "../styles/models.css";
import { h } from "../lib/dom";
import { icons, type IconName } from "./icons";
import { confirmDialog } from "./confirm";
import { openModelPicker, nameOf } from "./models-picker";
import { agreedWords, companyOf, JOB_WORDS, listWords, pickRole, notePieces, rowNote, savedWords, shownRef, takeBackEffects, TIERS, whyWords, targetLabel, type Resolved, type RowNote, type Target } from "./models-words";
import { assistantModels, ConsentNeeded, loadModels, onModelsChange, saveModels, takeBack, type ModelsResponse } from "../db/models";
import { listTeam } from "../db/team";
import { DEFAULT_MODELS, JOBS, PROVIDERS, needsConsent, type JobId, type ModelRef, type ProviderId } from "../../../lib/model-types";

const ADVANCED_KEY = "athena.models.advanced";

const remembered = (): boolean => {
  try {
    return sessionStorage.getItem(ADVANCED_KEY) === "open";
  } catch {
    return false;
  }
};

/** A full stop only a screen reader hears, so two pieces read as two sentences, not one run-on. */
const stop = () => h("span", { class: "visually-hidden" }, ". ");

export function modelsSettingsSection(opts: { page?: boolean } = {}): { el: HTMLElement; destroy: () => void } {
  const live = h("p", { class: "visually-hidden", role: "status", "aria-live": "polite" });
  const body = h("div", { class: "settings__body ms-body", "aria-busy": "true" }, h("div", { class: "ms-loading" }, h("span", { class: "ms-loading__bar" }), h("span", { class: "ms-loading__bar" }), h("span", { class: "ms-loading__bar" })));
  const el = h(
    "section",
    { class: "settings__section settings__section--models", "aria-labelledby": "settings-models" },
    h("div", { class: "src-head" }, h(opts.page ? "h1" : "h2", { class: "settings__heading", id: "settings-models" }, icons.sparkle(), "AI models")),
    h("p", { class: "settings__lede" }, "Which model does each job. Athena uses Claude unless you pick another."),
    body,
    live
  );
  let alive = true;
  let advancedOpen = remembered();
  let lastSaved: string | null = null;

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

  // ---------- a row ----------
  /** A row, and under it a note when its model has a newer version or is gone, with the one thing to do about it. */
  function row(key: string, t: Target, icon: IconName, detail: string, r: Resolved | null, m: ModelsResponse, open: (from: HTMLElement) => void, change: (ref: ModelRef) => Promise<void>): HTMLElement[] {
    const name = r ? nameOf(shownRef(r), m) : "Off";
    const why = whyWords(t, r);
    const note = rowNote(pickRole(t), r, m.catalogue, { follows: t.kind === "job" && !m.settings.jobs?.[t.job] });
    // A choice whose company isn't set up on this site runs on the default instead.
    const chosenOff = r && !note && !m.configured[r.ref.provider];
    const fallback = t.kind === "owner" && t.role !== "image" ? DEFAULT_MODELS[t.role] : t.kind === "job" ? DEFAULT_MODELS[JOBS[t.job].tier] : null;
    const warn = chosenOff ? `${companyOf(r!.ref.provider)} isn't set up on this site, so ${fallback ? nameOf(fallback, m) : "nothing"} runs for now.` : null;
    const id = `ms-${key}`;
    const described = [`${id}-w`, `${id}-d`, warn ? `${id}-x` : null, note ? `${id}-n` : null].filter(Boolean).join(" ");
    const b = h(
      "button",
      { class: `row ms-row${t.kind === "job" ? ` ms-row--job${r?.from === "job" || note?.kind === "gone" ? " is-own" : ""}` : ""}${r ? "" : " is-off"}${note ? ` has-note is-${note.kind}` : ""}${lastSaved === key ? " is-saved" : ""}`, type: "button", "data-model-row": key, "aria-labelledby": `${id}-t ${id}-v`, "aria-describedby": described, "aria-haspopup": "dialog" },
      t.kind === "job" ? null : h("span", { class: "tile tile--sm", "aria-hidden": "true" }, icons[icon]()),
      h(
        "span",
        { class: "row__body ms-row__body" },
        h("span", { class: "row__title ms-row__title", id: `${id}-t` }, targetLabel(t)),
        h("span", { class: "ms-row__now" }, h("span", { class: "ms-row__model", id: `${id}-v` }, name ?? ""), h("span", { class: "ms-row__why", id: `${id}-w` }, why, stop())),
        h("span", { class: "ms-row__detail", id: `${id}-d` }, detail),
        warn ? h("span", { class: "ms-row__warn", id: `${id}-x` }, icons.maybe(), h("span", {}, warn)) : null
      ),
      h("span", { class: "row__trail" }, h("span", { class: "ms-row__change", "aria-hidden": "true" }, "Change"), h("span", { class: "row__chevron", "aria-hidden": "true" }, icons.chevronRight()))
    );
    b.addEventListener("click", () => open(b));
    return note ? [b, noteStrip(`${id}-n`, key, t, note, b, open, change, m, t.kind === "job")] : [b];
  }

  /** The note under a row. Switch saves the newer version in one tap; Pick another opens the picker. */
  function noteStrip(id: string, key: string, t: Target, note: RowNote, rowEl: HTMLElement, open: (from: HTMLElement) => void, change: (ref: ModelRef) => Promise<void>, m: ModelsResponse, job: boolean): HTMLElement {
    const label = note.kind === "newer" ? note.label : `Pick another for ${targetLabel(t)}`;
    const act = h("button", { class: `btn btn--sm ${note.kind === "newer" ? "btn--primary" : "btn--soft"} ms-note__act`, type: "button", "aria-label": label }, note.action);
    act.addEventListener("click", async () => {
      if (note.kind === "gone") return open(rowEl);
      act.setAttribute("aria-disabled", "true");
      act.classList.add("is-busy");
      try {
        await change(note.ref);
        announce(savedWords(t, nameOf(note.ref, m)));
        body.querySelector<HTMLElement>(`[data-model-row="${key}"]`)?.focus({ preventScroll: true });
      } catch (e) {
        act.removeAttribute("aria-disabled");
        act.classList.remove("is-busy");
        // A company not agreed yet: the picker asks first.
        if (e instanceof ConsentNeeded) return open(rowEl);
        announce(e instanceof Error && e.message ? `That didn't save. ${e.message}` : "That didn't save. Try again.");
      }
    });
    return h(
      "div",
      { class: `ms-note ms-note--${note.kind}${job ? " ms-note--job" : ""}` },
      h("span", { class: "ms-note__icon", "aria-hidden": "true" }, note.kind === "gone" ? icons.flag() : icons.sparkle()),
      h("span", { class: "ms-note__text", id }, notePieces(note)[0], h("span", { class: "ms-note__name" }, notePieces(note)[1])),
      act
    );
  }

  /** Save one choice; the picker handles consent and errors. */
  const saver = (key: string, patch: (ref: ModelRef | null) => Parameters<typeof saveModels>[0]) => async (ref: ModelRef | null | "none") => {
    const r = ref === "none" ? null : ref;
    await saveModels(patch(r), r?.provider);
    lastSaved = key;
  };

  function ownerRow(m: ModelsResponse, role: "think" | "image" | "everyday" | "careful", icon: IconName, detail: string): HTMLElement[] {
    const t: Target = { kind: "owner", role };
    const r = m.effective[role];
    const save = saver(role, (ref) => ({ [role]: ref }));
    return row(role, t, icon, detail, r, m, (from) => openModelPicker({ target: t, current: m.settings[role] ?? null, resolved: r, save, announce, from }), (ref) => save(ref));
  }

  function jobRow(m: ModelsResponse, job: JobId): HTMLElement[] {
    const t: Target = { kind: "job", job };
    const tier = JOBS[job].tier;
    const save = saver(`job-${job}`, (ref) => ({ jobs: { [job]: ref } }));
    return row(`job-${job}`, t, "loop", JOB_WORDS[job].detail, m.effective.jobs[job], m, (from) => openModelPicker({ target: t, current: m.settings.jobs?.[job] ?? null, resolved: m.effective.jobs[job], inherited: nameOf(m.effective[tier].ref, m), save, announce, from }), (ref) => save(ref));
  }

  // ---------- agreements ----------
  async function confirmTakeBack(p: Exclude<ProviderId, "anthropic">, m: ModelsResponse, from: HTMLElement) {
    const co = companyOf(p);
    from.setAttribute("aria-busy", "true");
    const team = await listTeam().catch(() => []);
    from.removeAttribute("aria-busy");
    const effects = takeBackEffects(p, m.settings, team.map((a) => ({ name: a.name, models: assistantModels(a) })), m.catalogue);
    const ok = await confirmDialog({
      title: `Take back ${co}?`,
      body: `${co} stops getting your data. ${effects.length ? `${listWords(effects)}.` : `Nothing uses ${co} right now.`}`,
      confirmLabel: "Take back",
    });
    if (!ok) return from.focus();
    try {
      await takeBack(p);
      // The confirm hands focus back as it closes: move it on first, then speak, so the news isn't cut off.
      window.setTimeout(() => body.querySelector<HTMLElement>("[data-model-row=think]")?.focus(), 60);
      announce(effects.length ? `Took back ${co}. ${listWords(effects)}.` : `Took back ${co}.`, 700);
    } catch (e) {
      announce(e instanceof Error && e.message ? `That didn't save. ${e.message}` : "That didn't save. Try again.");
      from.focus();
    }
  }

  /** Which of the owner's choices use a company: "Everyday work and The briefing". */
  function usedBy(p: ProviderId, m: ModelsResponse): string[] {
    const s = m.settings;
    const out: string[] = [];
    if (s.think?.provider === p) out.push("Ask");
    if (s.image?.provider === p) out.push("Pictures");
    for (const tier of ["everyday", "careful"] as const) if (s[tier]?.provider === p) out.push(TIERS[tier].label);
    for (const job of Object.keys(JOBS) as JobId[]) if (s.jobs?.[job]?.provider === p) out.push(JOB_WORDS[job].label);
    return out;
  }

  function agreements(m: ModelsResponse): HTMLElement {
    const agreed = PROVIDERS.filter((p): p is Exclude<ProviderId, "anthropic"> => needsConsent(p) && !!m.settings.consent?.[p]);
    if (!agreed.length)
      return h("div", { class: "card ms-agree ms-agree--none" }, h("span", { class: "tile tile--sm", "aria-hidden": "true" }, icons.shield()), h("p", { class: "ms-agree__none" }, "Only Anthropic gets your data. The first time you pick another company's model, Athena asks you first."));
    return h(
      "ul",
      { class: "card card--flush list ms-agree", "aria-label": "Agreements" },
      ...agreed.map((p) => {
        const uses = usedBy(p, m);
        const btn = h("button", { class: "btn btn--soft btn--sm ms-agree__back", type: "button", "aria-label": `Take back ${companyOf(p)}`, "data-take-back": p }, "Take back");
        btn.addEventListener("click", () => void confirmTakeBack(p, m, btn));
        return h(
          "li",
          { class: "ms-agree__row" },
          h("span", { class: "tile tile--sm ms-agree__mark", "aria-hidden": "true" }, companyOf(p).charAt(0)),
          h(
            "span",
            { class: "ms-agree__body" },
            h("span", { class: "ms-agree__name" }, companyOf(p)),
            h("span", { class: "ms-agree__meta" }, `${agreedWords(m.settings.consent![p]!)}. ${uses.length ? `Used by ${listWords(uses)}.` : "Not used right now."}`)
          ),
          btn
        );
      })
    );
  }

  // ---------- the page ----------
  function group(label: string, id: string, ...children: Array<HTMLElement | null>): HTMLElement {
    // Named in plain case: the label is shown in capitals, which a screen reader may read as shouting or spell out.
    return h("section", { class: "group ms-group", "aria-label": label }, h("div", { class: "group__head" }, h(opts.page ? "h2" : "h3", { class: "group__label", id }, label)), ...children);
  }

  function advanced(m: ModelsResponse): HTMLElement {
    const own = (Object.keys(JOBS) as JobId[]).filter((j) => m.settings.jobs?.[j]);
    const list = h("div", { class: "ms-jobs", id: "ms-jobs", hidden: !advancedOpen });
    const tiers = (["everyday", "careful"] as const).map((tier) =>
      h("div", { class: "ms-jobs__tier" }, h(opts.page ? "h3" : "h4", { class: "ms-jobs__label" }, TIERS[tier].label), h("div", { class: "card card--flush list" }, ...(Object.keys(JOBS) as JobId[]).filter((j) => JOBS[j].tier === tier).flatMap((j) => jobRow(m, j))))
    );
    list.append(...tiers);
    const toggle = h(
      "button",
      { class: "ms-adv", type: "button", "aria-expanded": advancedOpen ? "true" : "false", "aria-controls": "ms-jobs" },
      h("span", { class: "ms-adv__text" }, h("span", { class: "ms-adv__title" }, "Each job on its own", stop()), h("span", { class: "ms-adv__meta" }, own.length ? `${own.length === 1 ? "1 job has its" : `${own.length} jobs have their`} own model: ${listWords(own.map((j) => JOB_WORDS[j].label))}` : "Every job follows Everyday or Careful work")),
      h("span", { class: "ms-adv__chev", "aria-hidden": "true" }, icons.chevronDown())
    );
    toggle.addEventListener("click", () => {
      advancedOpen = !advancedOpen;
      try {
        sessionStorage.setItem(ADVANCED_KEY, advancedOpen ? "open" : "closed");
      } catch {
        // Private mode: it just won't be remembered.
      }
      toggle.setAttribute("aria-expanded", advancedOpen ? "true" : "false");
      list.hidden = !advancedOpen;
    });
    return h("div", { class: "ms-advanced" }, toggle, list);
  }

  function ago(iso: string): string {
    const h_ = Math.round((Date.now() - Date.parse(iso)) / 3_600_000);
    return h_ < 1 ? "within the hour" : h_ < 24 ? `${h_} ${h_ === 1 ? "hour" : "hours"} ago` : `${Math.round(h_ / 24)} days ago`;
  }

  function paint(m: ModelsResponse) {
    if (!alive) return;
    const focused = (document.activeElement as HTMLElement | null)?.dataset?.modelRow ?? null;
    body.removeAttribute("aria-busy");
    body.replaceChildren(
      group(
        "Ask",
        "ms-g-ask",
        h("div", { class: "card card--flush list" }, ...ownerRow(m, "think", "sparkle", "Ask, and every assistant unless it has its own"), ...ownerRow(m, "image", "image", "Making or changing a picture in a conversation"))
      ),
      group(
        "Background work",
        "ms-g-bg",
        h("div", { class: "card card--flush list" }, ...ownerRow(m, "everyday", "clock", TIERS.everyday.detail), ...ownerRow(m, "careful", "pen", TIERS.careful.detail)),
        advanced(m)
      ),
      group("Agreements", "ms-g-agree", agreements(m)),
      h("p", { class: "ms-foot" }, `${m.catalogue.length} models on the gateway's list, read ${ago(m.updated_at)}. Voice keeps its own setting.`)
    );
    if (focused) body.querySelector<HTMLElement>(`[data-model-row="${focused}"]`)?.focus({ preventScroll: true });
    // The row that just changed settles in place, once.
    lastSaved = null;
  }

  async function load() {
    try {
      paint(await loadModels({ fresh: true }));
    } catch {
      if (!alive) return;
      const again = h("button", { class: "btn btn--soft", type: "button" }, "Try again");
      again.addEventListener("click", () => {
        body.setAttribute("aria-busy", "true");
        void load();
      });
      body.removeAttribute("aria-busy");
      body.replaceChildren(h("div", { class: "empty ms-error" }, h("p", { class: "empty__title" }, "AI models didn't load"), h("p", { class: "empty__sub" }, "They need a connection. Check you're online and try again."), again));
    }
  }

  const off = onModelsChange(paint);
  void load();
  return {
    el,
    destroy: () => {
      alive = false;
      off();
    },
  };
}
