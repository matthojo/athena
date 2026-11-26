/**
 * The model picker: a sheet on a phone, a dialog on a wide screen. Every model
 * the gateway lists, by company, newest first, with search and a company
 * filter; no recommended group. A newer version of the chosen model is offered
 * at the top, and a chosen model the gateway no longer lists is still named
 * there. Choosing a model shows what it can do beside the list (below it on a
 * phone), with Try it and Use. A company the owner hasn't agreed to asks first
 * (models-agreement.ts), in the same sheet.
 *
 * Keyboard: the list is one listbox. Up, Down, Home, End, Page Up and Page
 * Down move; typing jumps by name (models-keys.ts); Enter or Space chooses.
 * Down from the search box goes into the list. Escape clears the search, then
 * closes. Focus goes back to the row that opened it.
 */
import "../styles/models.css";
import { h } from "../lib/dom";
import { icons } from "./icons";
import { openSheet, type SheetHandle } from "./sheet";
import { agreementBody } from "./models-agreement";
import { listKey, type ListKeyState } from "./models-keys";
import { agreeTo, ConsentNeeded, modelsNow, tryModel, type ModelsResponse } from "../db/models";
import { aOrAn, byCompany, changesPictures, factsPhrase, companyOf, defaultFor, facts, followWords, modelName, offeredFor, pickRole, savedWords, searchModels, seconds, targetLabel, testRole, untested, withdrawnWords, type Resolved, type Target } from "./models-words";
import { needsConsent, PROVIDERS, refKey, sameRef, type CatalogueModel, type ModelRef, type ProviderId } from "../../../lib/model-types";

export interface PickerOptions {
  target: Target;
  /** The target's own choice; null when it follows (the default, the tier, Ask) or is off. */
  current: ModelRef | null;
  /** The target as it resolves now, for a newer version to offer or a withdrawn choice to name. */
  resolved?: Resolved | null;
  /** What following means right now, for the "Same as" option: "Claude Sonnet 5.5". */
  inherited?: string | null;
  /** An assistant's pictures can also be "none of its own": null there means no pictures, and `follow` means the same as Ask. */
  none?: { label: string; detail: string; selected: boolean };
  save: (ref: ModelRef | null | "none") => Promise<void>;
  /** Said in the page's polite live region once a choice is saved. */
  announce: (text: string) => void;
  /** Focus goes back here when the picker closes. */
  from: HTMLElement;
}

/** One option in the list: a model, "the same as …" (null) or "no pictures" ("none"). */
type Choice = { key: string; ref: ModelRef | null | "none"; model: CatalogueModel | null; label: string; detail: string };

const FOLLOW = "follow";
const NONE = "none";
let seq = 0;

/** The model's maker, for its mark: the company, or OpenRouter's maker before the slash. */
function maker(m: CatalogueModel): string {
  if (m.ref.provider !== "openrouter") return companyOf(m.ref.provider);
  return m.ref.model.split("/")[0] ?? "OpenRouter";
}

/** Gateway ids read better split: "deepseek-v3.2" with "deepseek" under it. */
function title(m: CatalogueModel): string {
  if (!untested(m) || m.ref.provider !== "openrouter") return m.name;
  return m.ref.model.split("/").slice(1).join("/") || m.name;
}

export function openModelPicker(opts: PickerOptions): void {
  const state = modelsNow();
  if (!state) return;
  const id = `mp${++seq}`;
  const role = pickRole(opts.target);
  const offered = state.catalogue.filter((m) => offeredFor(role, m));
  // A newer version of the choice, if the catalogue offers it for this role.
  const newer = opts.resolved?.newer ? offered.find((m) => sameRef(m.ref, opts.resolved!.newer)) ?? null : null;
  const dflt = defaultFor(role);
  const follow = followWords(opts.target, opts.inherited ?? null);

  // The choice so far: starts on what's in use.
  const startKey = opts.none?.selected ? NONE : opts.current ? refKey(opts.current) : follow ? FOLLOW : dflt ? refKey(dflt) : FOLLOW;
  let chosen = startKey;
  let query = "";
  let company: ProviderId | "all" = "all";
  let keys: ListKeyState = { index: -1, typed: "", at: 0 };
  /** The options as shown, in order: what the keyboard walks. */
  let shown: Choice[] = [];
  let sheet: SheetHandle;

  const choiceFor = (m: CatalogueModel): Choice => ({ key: refKey(m.ref), ref: m.ref, model: m, label: m.name, detail: m.blurb ?? (untested(m) ? "Not tested with Athena" : "") });
  // A chosen model the gateway no longer lists: still named, so the owner can see what they had.
  const gone = opts.current && !offered.some((m) => sameRef(m.ref, opts.current)) ? opts.current : null;
  const special: Choice[] = [
    ...(gone ? [{ key: refKey(gone), ref: gone, model: null, label: modelName(gone, state.catalogue), detail: withdrawnWords(role, opts.resolved, state.catalogue) ?? "No longer offered" }] : []),
    ...(follow ? [{ key: FOLLOW, ref: null, model: null, label: follow.label, detail: follow.detail }] : []),
    ...(opts.none ? [{ key: NONE, ref: "none" as const, model: null, label: opts.none.label, detail: opts.none.detail }] : []),
  ];
  const consented = (p: ProviderId) => !needsConsent(p) || !!modelsNow()?.settings.consent?.[p];
  const find = (key: string): Choice | null => special.find((c) => c.key === key) ?? (offered.find((m) => refKey(m.ref) === key) ? choiceFor(offered.find((m) => refKey(m.ref) === key)!) : null);

  // ---------- the top: search and company ----------
  const search = h("input", { class: "mp-search__input", type: "search", id: `${id}-q`, placeholder: "Search models", autocomplete: "off", autocapitalize: "off", spellcheck: "false", enterkeyhint: "search", "aria-controls": `${id}-list`, "aria-describedby": `${id}-count` }) as HTMLInputElement;
  const searchBox = h("div", { class: "mp-search" }, h("label", { class: "visually-hidden", for: `${id}-q` }, "Search models"), h("span", { class: "mp-search__icon", "aria-hidden": "true" }, icons.search()), search);
  const companies = PROVIDERS.filter((p) => offered.some((m) => m.ref.provider === p));
  const chips = h(
    "fieldset",
    { class: "mp-companies" },
    h("legend", { class: "visually-hidden" }, "Company"),
    ...(["all", ...companies] as const).map((p) => {
      const input = h("input", { type: "radio", name: `${id}-co`, value: p, class: "mp-chip__input", checked: p === "all" }) as HTMLInputElement;
      input.addEventListener("change", () => {
        if (!input.checked) return;
        company = p;
        paint();
      });
      return h("label", { class: "mp-chip" }, input, h("span", { class: "mp-chip__text" }, p === "all" ? "All" : companyOf(p)));
    })
  );
  const count = h("p", { class: "mp-count", id: `${id}-count`, role: "status", "aria-live": "polite" });

  // ---------- the list ----------
  const list = h("div", { class: "mp-list", id: `${id}-list`, role: "listbox", tabindex: 0, "aria-label": `Models for ${targetLabel(opts.target)}` });

  function option(c: Choice, inGroup: string): HTMLElement {
    const m = c.model;
    const index = shown.length;
    const optId = `${id}-o-${index}`;
    const isDefault = !!m && sameRef(m.ref, dflt) && opts.target.kind === "owner";
    // What really runs is "In use": for a choice that's gone, that's the model running instead.
    const inUse = gone ? !!m && !!opts.resolved && sameRef(m.ref, opts.resolved.ref) : c.key === startKey;
    const tags = [inUse ? "In use" : null, newer && m && sameRef(m.ref, newer.ref) ? "Newer" : null, isDefault ? "Athena's default" : null, m?.preview ? "Preview" : null].filter((t): t is string => !!t);
    const off = m ? !state!.configured[m.ref.provider] : false;
    const line = m ? facts(m) : [];
    const sub = m && untested(m) && m.ref.provider === "openrouter" ? `${maker(m)} on OpenRouter` : null;
    const el = h(
      "div",
      {
        class: `mp-opt${m && untested(m) ? " is-untested" : ""}${c.model ? "" : " mp-opt--follow"}`,
        role: "option",
        id: optId,
        "aria-selected": c.key === chosen ? "true" : "false",
        "aria-disabled": off ? "true" : undefined,
        "data-key": c.key,
        "data-group": inGroup,
        "aria-label": [m ? title(m) : c.label, sub, ...tags, off ? `${companyOf(m!.ref.provider)} isn't set up on this site` : null, c.detail, ...line].filter((x): x is string => !!x).map((x) => x.replace(/\.$/, "")).join(". "),
      },
      h("span", { class: `mp-mark${m ? "" : " mp-mark--follow"}`, "aria-hidden": "true" }, m ? maker(m).charAt(0).toUpperCase() : c.key === NONE ? icons.close() : gone && c.key === refKey(gone) ? icons.flag() : icons.loop()),
      h(
        "span",
        { class: "mp-opt__body", "aria-hidden": "true" },
        h("span", { class: "mp-opt__name" }, h("span", { class: "mp-opt__title" }, m ? title(m) : c.label), ...tags.map((t) => h("span", { class: `mp-tag${t === "In use" ? " mp-tag--use" : ""}` }, t))),
        sub ? h("span", { class: "mp-opt__sub" }, sub) : null,
        h("span", { class: `mp-opt__blurb${m && untested(m) ? " mp-opt__blurb--untested" : ""}` }, off ? `${companyOf(m!.ref.provider)} isn't set up on this site` : c.detail),
        line.length ? h("span", { class: "mp-opt__facts" }, factsPhrase(line)) : null
      ),
      h("span", { class: "mp-opt__check", "aria-hidden": "true" }, icons.check())
    );
    el.addEventListener("click", () => {
      setActive(index, false);
      choose(c.key);
    });
    // Each shown copy (a model can be in Recommended and its company) walks separately.
    shown.push(c);
    return el;
  }

  function group(label: string, choices: Choice[], key: string): HTMLElement | null {
    if (!choices.length) return null;
    const gid = `${id}-g-${key}`;
    // A plain-case name: the label is shown in capitals, which some screen readers spell out.
    return h("div", { class: "mp-group", role: "group", "aria-label": label }, h("div", { class: "mp-group__label", id: gid, "aria-hidden": "true" }, label), ...choices.map((c) => option(c, key)));
  }

  function paint() {
    shown = [];
    const browsing = !query.trim() && company === "all";
    const pool = offered.filter((m) => company === "all" || m.ref.provider === company);
    const found = searchModels(pool, query);
    const nodes: Array<HTMLElement | null> = [];
    if (browsing) {
      if (special.length) nodes.push(...special.map((c) => option(c, "top")));
      // The one in use beside its newer version, so the picker opens on both.
      const inUseModel = opts.current ? offered.find((m) => sameRef(m.ref, opts.current)) : null;
      if (newer) nodes.push(group("A newer version", [...(inUseModel ? [choiceFor(inUseModel)] : []), choiceFor(newer)], "newer"));
      for (const g of byCompany(found)) nodes.push(group(companyOf(g.provider), g.models.map(choiceFor), g.provider));
    } else if (query.trim()) {
      // Searching: best matches first, each still saying whose it is.
      nodes.push(group("Best match first", found.map(choiceFor), "found"));
    } else {
      for (const g of byCompany(found)) nodes.push(group(companyOf(g.provider), g.models.map(choiceFor), g.provider));
    }
    const any = nodes.some(Boolean);
    list.replaceChildren(
      ...(any
        ? nodes.filter((n): n is HTMLElement => !!n)
        : [h("div", { class: "mp-empty", role: "presentation" }, h("p", { class: "mp-empty__title" }, `No models match “${query.trim()}”`), h("p", { class: "mp-empty__sub" }, "Try a company, a model's name, or a word like “quick” or “photos”."))])
    );
    const n = found.length;
    count.textContent = browsing ? `${offered.length} models` : query.trim() ? (n ? `${n} ${n === 1 ? "model matches" : "models match"}` : "No models match") : `${n} ${companyOf(company as ProviderId)} models`;
    // Keep the active option where it was if it's still shown; otherwise the chosen one, or none.
    const activeKey = keys.index >= 0 ? list.getAttribute("data-active-key") : null;
    const keep = activeKey ? shown.findIndex((c) => c.key === activeKey) : -1;
    setActive(keep >= 0 ? keep : browsing ? shown.findIndex((c) => c.key === chosen) : -1, false);
  }

  function optionEl(i: number): HTMLElement | null {
    return i >= 0 ? list.querySelector<HTMLElement>(`#${id}-o-${i}`) : null;
  }

  function setActive(i: number, scroll = true) {
    optionEl(keys.index)?.classList.remove("is-active");
    keys = { ...keys, index: i };
    const el = optionEl(i);
    if (!el) {
      list.removeAttribute("aria-activedescendant");
      list.removeAttribute("data-active-key");
      return;
    }
    el.classList.add("is-active");
    list.setAttribute("aria-activedescendant", el.id);
    list.setAttribute("data-active-key", shown[i].key);
    if (scroll) el.scrollIntoView({ block: "nearest" });
  }

  list.addEventListener("keydown", (e) => {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.key === "Enter" || (e.key === " " && !keys.typed)) {
      e.preventDefault();
      if (keys.index >= 0) choose(shown[keys.index].key);
      return;
    }
    if (e.key === "ArrowUp" && keys.index <= 0) {
      // Up from the top goes back to the search box.
      e.preventDefault();
      setActive(-1);
      search.focus();
      return;
    }
    const next = listKey(e.key, keys, shown.map((c) => (c.model ? title(c.model) : c.label)), performance.now());
    if (!next) return;
    e.preventDefault();
    keys = { ...next, index: keys.index };
    setActive(next.index);
  });
  list.addEventListener("focus", () => {
    if (keys.index < 0 && shown.length) setActive(Math.max(0, shown.findIndex((c) => c.key === chosen)));
  });

  let searchTimer = 0;
  search.addEventListener("input", () => {
    window.clearTimeout(searchTimer);
    searchTimer = window.setTimeout(() => {
      query = search.value;
      keys = { index: -1, typed: "", at: 0 };
      paint();
    }, 90);
  });
  search.addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown" || (e.key === "Enter" && shown.length)) {
      e.preventDefault();
      window.clearTimeout(searchTimer);
      if (query !== search.value) {
        query = search.value;
        paint();
      }
      list.focus();
      setActive(0);
    } else if (e.key === "Escape" && search.value) {
      // The first Escape clears the search; the next one closes.
      e.preventDefault();
      e.stopPropagation();
      search.value = "";
      query = "";
      paint();
    }
  });

  // ---------- the chosen model: what it can do, Try it and Use ----------
  const detail = h("div", { class: "mp-detail", id: `${id}-detail`, "aria-labelledby": `${id}-dname` });
  const tryOut = h("p", { class: "mp-try", role: "status", "aria-live": "polite" });
  const saveOut = h("p", { class: "mp-error", role: "alert" });
  const tryBtn = h("button", { class: "btn btn--soft mp-try__btn", type: "button" }, icons.play(), h("span", {}, "Try it"));
  const useBtn = h("button", { class: "btn btn--primary mp-use", type: "button" });
  tryBtn.addEventListener("click", () => void runTry());
  useBtn.addEventListener("click", () => void use());

  function paintDetail() {
    const c = find(chosen);
    const m = c?.model ?? null;
    const inUse = chosen === startKey;
    const isGone = !!gone && chosen === refKey(gone);
    tryOut.textContent = "";
    saveOut.textContent = "";
    detail.classList.toggle("is-untested", !!m && untested(m));
    const notes: HTMLElement[] = [];
    const toolsUnknown = !!m && role === "think" && m.abilities.tools === "unknown";
    if (m && untested(m)) notes.push(h("p", { class: "mp-note mp-note--untested" }, icons.flag(), h("span", {}, h("strong", {}, "Not tested with Athena. "), "It's on the gateway's list, but Athena has no notes on it.", toolsUnknown ? " If it can't use Athena's tools, Ask can't look things up or make changes with it." : "", " Try it before you use it.")));
    else if (toolsUnknown) notes.push(h("p", { class: "mp-note" }, icons.maybe(), h("span", {}, "If it can't use Athena's tools, Ask can't look things up or make changes with it.")));
    if (m && role === "image" && !changesPictures(m)) notes.push(h("p", { class: "mp-note" }, icons.maybe(), h("span", {}, "It can make a picture, but changing one you add needs a Google model.")));
    if (m && !consented(m.ref.provider)) notes.push(h("p", { class: "mp-note" }, icons.shield(), h("span", {}, `The first time you pick ${aOrAn(companyOf(m.ref.provider))} model, Athena asks before sending anything to ${companyOf(m.ref.provider)}.`)));
    if (m && !state!.configured[m.ref.provider]) notes.push(h("p", { class: "mp-note mp-note--warn" }, icons.maybe(), h("span", {}, `${companyOf(m.ref.provider)} isn't set up on this site, so this model can't run yet. Pick another one.`)));
    const sub = m ? (m.ref.provider === "openrouter" ? `${maker(m)} on OpenRouter` : companyOf(m.ref.provider)) : null;
    const parts: Array<HTMLElement | null> = [
      h("p", { class: "mp-detail__eyebrow" }, isGone ? "Your choice" : inUse ? "In use" : "Chosen"),
      h("h3", { class: "mp-detail__name", id: `${id}-dname` }, m ? title(m) : c?.label ?? ""),
      sub ? h("p", { class: "mp-detail__company" }, sub) : null,
      m?.blurb ? h("p", { class: "mp-detail__blurb" }, m.blurb) : !m && c?.detail ? h("p", { class: "mp-detail__blurb" }, c.detail) : null,
      m ? h("ul", { class: "mp-detail__facts", "aria-label": "What it can do" }, ...facts(m).map((f) => h("li", {}, f))) : null,
      m && untested(m) ? h("p", { class: "mp-detail__id" }, h("span", { class: "visually-hidden" }, "Gateway id: "), refKey(m.ref)) : null,
      ...notes,
      tryOut,
      saveOut,
      h("div", { class: "mp-detail__actions" }, m ? tryBtn : null, useBtn),
    ];
    detail.replaceChildren(...parts.filter((p): p is HTMLElement => !!p));
    const off = !!m && !state!.configured[m.ref.provider];
    tryBtn.disabled = off;
    useBtn.disabled = inUse || off;
    useBtn.classList.toggle("is-gone", isGone);
    useBtn.textContent = isGone ? "Pick another" : inUse ? "In use" : c?.model ? `Use ${title(c.model)}` : `Use “${c?.label ?? ""}”`;
  }

  function choose(key: string) {
    const c = find(key);
    if (!c || (c.model && !state!.configured[c.model.ref.provider])) return;
    chosen = key;
    for (const el of list.querySelectorAll<HTMLElement>("[role=option]")) el.setAttribute("aria-selected", el.dataset.key === key ? "true" : "false");
    paintDetail();
    detail.classList.remove("is-fresh");
    void detail.offsetWidth;
    detail.classList.add("is-fresh");
  }

  // ---------- agreeing, trying, using ----------
  /** Ask once for a company, in this sheet. Resolves true once agreed. */
  function agree(provider: ProviderId, model: string): Promise<boolean> {
    return new Promise((resolve) => {
      const back = () => {
        sheet.setTitle(targetLabel(opts.target));
        sheet.setBack(null);
        frame.replaceChildren(picker);
        resolve(false);
        requestAnimationFrame(() => list.focus());
      };
      const body = agreementBody(provider, model, {
        agree: async () => {
          await agreeTo(provider);
          sheet.setTitle(targetLabel(opts.target));
          sheet.setBack(null);
          frame.replaceChildren(picker);
          paintDetail();
          resolve(true);
        },
        cancel: back,
      });
      sheet.setTitle(`Send to ${companyOf(provider)}?`);
      sheet.setBack(back);
      frame.replaceChildren(body);
      requestAnimationFrame(() => body.querySelector<HTMLElement>("[data-focus]")?.focus());
    });
  }

  async function runTry() {
    const m = find(chosen)?.model;
    if (!m) return;
    if (!consented(m.ref.provider) && !(await agree(m.ref.provider, m.name))) return;
    tryBtn.disabled = true;
    tryBtn.setAttribute("aria-busy", "true");
    tryOut.className = "mp-try is-busy";
    tryOut.textContent = `Trying ${title(m)}…`;
    const t0 = performance.now();
    try {
      const r = await tryModel(m.ref, testRole(opts.target));
      if (r.ok) {
        tryOut.className = "mp-try is-ok";
        tryOut.textContent = testRole(opts.target) === "image" ? `Made a picture in ${seconds(r.ms)}.` : `Answered in ${seconds(r.ms)}: “${r.reply}”`;
      } else {
        tryOut.className = "mp-try is-bad";
        tryOut.textContent = `It didn't answer after ${seconds(performance.now() - t0)}. ${r.error}`;
      }
    } catch (e) {
      tryOut.className = "mp-try is-bad";
      tryOut.textContent = e instanceof ConsentNeeded ? "Agree to send data to this company first." : "Couldn't try it. Check you're online and try again.";
    } finally {
      tryBtn.disabled = false;
      tryBtn.removeAttribute("aria-busy");
    }
  }

  async function use() {
    const c = find(chosen);
    if (!c) return;
    const m = c.model;
    // Picking the default model is going back to the default.
    const ref = c.key === FOLLOW ? null : c.key === NONE ? "none" : opts.target.kind === "owner" && m && sameRef(m.ref, dflt) && !opts.none ? null : c.ref;
    if (m && !consented(m.ref.provider) && !(await agree(m.ref.provider, m.name))) return;
    useBtn.disabled = true;
    useBtn.setAttribute("aria-busy", "true");
    try {
      await opts.save(ref);
      opts.announce(savedWords(opts.target, m ? m.name : null, c.key === NONE));
      sheet.close();
    } catch (e) {
      if (e instanceof ConsentNeeded && m && (await agree(e.provider, m.name))) return void use();
      saveOut.textContent = e instanceof Error && e.message && !(e instanceof ConsentNeeded) ? `That didn't save. ${e.message}` : "That didn't save. Try again.";
      useBtn.disabled = false;
    } finally {
      useBtn.removeAttribute("aria-busy");
    }
  }

  // ---------- the sheet ----------
  const top = h("div", { class: "mp-top" }, searchBox, chips, count);
  const picker = h("div", { class: "mp" }, h("div", { class: "mp-main" }, top, list), detail);
  const frame = h("div", { class: "mp-frame" }, picker);
  paint();
  paintDetail();
  sheet = openSheet({
    label: targetLabel(opts.target),
    title: targetLabel(opts.target),
    body: frame,
    variant: "compose",
    onClose: () => {
      window.clearTimeout(searchTimer);
      if (opts.from.isConnected) opts.from.focus();
      else document.querySelector<HTMLElement>(`[data-model-row="${opts.from.dataset.modelRow}"]`)?.focus();
    },
  });
  sheet.dialog.classList.add("models-sheet");
  // Focus into the list, on what's in use, so arrows and type-ahead work at once.
  requestAnimationFrame(() => {
    list.focus({ preventScroll: true });
    setActive(Math.max(0, shown.findIndex((c) => c.key === chosen)));
  });
}

/** The name a ref goes by, from the loaded catalogue. */
export function nameOf(ref: ModelRef | null | undefined, state: ModelsResponse | null = modelsNow()): string | null {
  return ref ? modelName(ref, state?.catalogue ?? []) : null;
}
