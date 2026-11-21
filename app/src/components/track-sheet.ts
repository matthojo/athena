/**
 * "Track this" (lib/tracker-types.ts): one small sheet.
 *
 *  - On a saved item it offers the presets that fit (its price when it has
 *    one, its stock) and "Something else". A preset starts in one tap.
 *  - "Something else" asks what it is ("followers"), whether it's a number
 *    or a state, how a number is written (what goes before and after it,
 *    shown live as "£1,234"), or the states it can be in (the one you hope
 *    for first), and what counts as news for a number.
 *  - On its own (from Saved), it asks for a name and an optional link first.
 *
 * The words "prefix" and "suffix" never show: the owner sees the number
 * written out as it will appear.
 */
import { h } from "../lib/dom";
import { icons } from "./icons";
import { openSheet } from "./sheet";
import { showToast } from "./toast";
import { cleanLink, createTracker, stopTracking, updateTracker, type TrackerView } from "../db/trackers";
import { cap, cleanAffix, cleanLabel, cleanStates, currencyAffix, presetsFor, valueWords } from "../lib/tracker-words";
import type { SavedItem } from "../../../lib/saved-rules";
import type { TrackerDirection, TrackerKind } from "../../../lib/tracker-types";
import { TRACKER_LIMITS } from "../../../lib/tracker-types";
import { listTeam, type TeamAssistant } from "../db/team";
import { assistantsFor } from "../../../lib/trackers";
import { renderAvatarTile } from "../team/avatar";
import { webOn } from "../team/web-access";
import "../styles/tracking.css";

/**
 * "Who checks it?" (owner, 16 Nov 2026: "Ask in the sheet, with a sensible pick"). The choices are the
 * assistants who can look things up online, and "Just me". It starts on the one whose job fits (the server's
 * `assistantsFor`, lib/trackers.ts): for a price or stock, an assistant whose job is prices. With nobody who can
 * look things up, it's you, with one quiet line, and no choice is sent.
 */
export function pickChecker(team: Array<Pick<TeamAssistant, "id" | "name" | "job" | "web" | "paused"> & { instructions?: string | null }>, what: { preset: "price" | "stock" | null; label?: string }): string | null {
  return assistantsFor({ preset: what.preset, label: what.label ?? "", name: "" }, team.map((a) => ({ ...a, web: webOn(a as TeamAssistant) })))[0]?.id ?? null;
}

function whoRow(start: { preset: "price" | "stock" | null; label?: string }): { el: HTMLElement; value: () => string | null | undefined; refit: (label: string) => void } {
  let what = start;
  let current: string | null = null;
  let touched = false;
  let team: TeamAssistant[] = [];
  const row = h("div", { class: "chip-row chip-row--wrap choice", role: "radiogroup", "aria-labelledby": "tks-who" });
  const quiet = h("p", { class: "tks-field__hint", hidden: true }, "Just you for now. An assistant can check this for you once one can look things up online.");
  const el = h("div", { class: "tks-field tks-who" }, h("p", { class: "tks-field__label", id: "tks-who" }, "Who checks it?"), row, quiet);
  const paint = () => {
    const web = team.filter((a) => a.web && !a.paused);
    quiet.hidden = web.length > 0;
    row.hidden = !web.length;
    const fit = pickChecker(team, what);
    // The fitting one first, then "Just me", then the rest.
    const order = [...web.filter((a) => a.id === fit), ...web.filter((a) => a.id !== fit)];
    const chip = (id: string | null, label: string) => {
      const b = h("button", { class: "chip", type: "button", role: "radio", "aria-checked": String(id === current) }, label);
      b.addEventListener("click", () => {
        current = id;
        touched = true;
        paint();
      });
      return b;
    };
    row.replaceChildren(...order.slice(0, 1).map((a) => chip(a.id, a.name)), chip(null, "Just me"), ...order.slice(1).map((a) => chip(a.id, a.name)));
  };
  void listTeam().then(
    (t) => {
      team = t;
      if (!touched) current = pickChecker(team, what);
      paint();
    },
    () => paint()
  );
  paint();
  return {
    el,
    // No choice shown (nobody can look things up): none sent, so the first assistant to check it takes it on.
    value: () => (row.hidden ? undefined : current),
    // "Something else": the label typed picks the assistant whose job fits it, until the owner picks.
    refit: (label: string) => {
      what = { preset: null, label };
      if (!touched) current = pickChecker(team, what);
      paint();
    },
  };
}

export interface TrackSheetOptions {
  /** The saved item to track; none for one that stands on its own. */
  item?: SavedItem | null;
  /** What it already tracks, so a preset isn't offered twice. */
  existing?: TrackerView[];
  /** After it starts: open it, say so. */
  onCreated?: (t: TrackerView) => void;
}

let uid = 0;

/** A field with its label above it. */
function field(label: string, control: HTMLElement, opts: { hint?: string; id: string }): HTMLElement {
  control.id = opts.id;
  return h("div", { class: "tks-field" }, h("label", { class: "tks-field__label", for: opts.id }, label), control, opts.hint ? h("p", { class: "tks-field__hint" }, opts.hint) : null);
}

function seg<T extends string>(label: string, options: Array<{ value: T; label: string }>, value: T, onChange: (v: T) => void): { el: HTMLElement; value: () => T } {
  let current = value;
  const id = `tks-seg-${++uid}`;
  const row = h("div", { class: "seg tks-seg", role: "radiogroup", "aria-labelledby": id });
  const paint = () => [...row.children].forEach((b) => b.setAttribute("aria-checked", String((b as HTMLElement).dataset.v === current)));
  for (const o of options) {
    const b = h("button", { class: "seg__item", type: "button", role: "radio", "data-v": o.value }, o.label);
    b.addEventListener("click", () => {
      current = o.value;
      paint();
      onChange(o.value);
    });
    row.append(b);
  }
  paint();
  return { el: h("div", { class: "tks-field" }, h("p", { class: "tks-field__label", id }, label), row), value: () => current };
}

/** Opens the sheet. */
export function openTrackSheet(opts: TrackSheetOptions = {}): void {
  const item = opts.item ?? null;
  const body = h("div", { class: "tks" });
  const sheet = openSheet({ label: item ? "Track this" : "Track something", title: item ? "Track this" : "Track something", body });

  const start = async (b: HTMLButtonElement, input: Parameters<typeof createTracker>[0], said: string) => {
    b.setAttribute("aria-busy", "true");
    try {
      const t = await createTracker(input);
      sheet.close();
      // Undo stops it at once: nothing has been read for it yet that the owner would lose.
      showToast(said, { icon: "check", action: { label: "Undo", run: () => void stopTracking(t) } });
      opts.onCreated?.(t);
    } catch (error) {
      showToast(error instanceof Error && !/^[a-z]+:/.test(error.message) ? error.message : "Couldn't start tracking that", { icon: "wifiOff" });
    } finally {
      b.removeAttribute("aria-busy");
    }
  };
  // Who checks a preset: the price assistant when there is one.
  const presetWho = whoRow({ preset: "price" });

  // ---------- step 1, on a saved item: what fits ----------
  function choose() {
    sheet.setTitle("Track this");
    sheet.setBack(null);
    const presets = presetsFor(item!, opts.existing ?? []);
    const full = (opts.existing?.length ?? 0) >= TRACKER_LIMITS.perItem;
    const f = item!.facts;
    const rows: HTMLElement[] = [];
    const option = (icon: SVGElement, name: string, sub: string, run: (b: HTMLButtonElement) => void) => {
      const b = h("button", { class: "tks-opt", type: "button" }, h("span", { class: "tks-opt__icon", "aria-hidden": "true" }, icon), h("span", { class: "tks-opt__text" }, h("span", { class: "tks-opt__name" }, name), h("span", { class: "tks-opt__sub" }, sub)), icons.chevronRight()) as HTMLButtonElement;
      b.addEventListener("click", () => run(b));
      rows.push(b);
    };
    if (presets.includes("price") && f?.price && f.currency) {
      const was = valueWords({ kind: "number", currency: f.currency, ...currencyAffix(f.currency) }, f.price);
      option(icons.tag(), "Price", `${was}${f.shop ? ` at ${f.shop}` : ""} when you saved it. Athena keeps every check after that.`, (b) => void start(b, { saved_id: item!.id, preset: "price", assistant_id: presetWho.value() }, "Tracking its price"));
    }
    if (presets.includes("stock")) option(icons.parcel(), "Stock", "In stock or sold out, and since when.", (b) => void start(b, { saved_id: item!.id, preset: "stock", assistant_id: presetWho.value() }, "Tracking its stock"));
    option(icons.sliders(), "Something else", "A number or a state you name.", () => describe());
    body.replaceChildren(
      h("p", { class: "tks-lede" }, `${item!.title ?? "This item"}`),
      ...(full ? [h("p", { class: "tks-note" }, `This has ${TRACKER_LIMITS.perItem} already, the most one thing can have. Stop one to start another.`)] : [...rows, ...(presets.length ? [presetWho.el] : [])])
    );
  }

  // ---------- step 2: something the owner describes ----------
  function describe() {
    if (item) {
      sheet.setTitle("Something else");
      sheet.setBack(choose);
    }
    const id = `tks-${++uid}`;
    const err = h("p", { class: "tks-error", role: "alert", hidden: true });
    const name = h("input", { class: "tk-input", autocomplete: "off", placeholder: "Electricity tariff", maxlength: 80, enterkeyhint: "next" }) as HTMLInputElement;
    const link = h("input", { class: "tk-input", type: "url", inputmode: "url", autocomplete: "off", placeholder: "https://", enterkeyhint: "next" }) as HTMLInputElement;
    const label = h("input", { class: "tk-input", autocomplete: "off", placeholder: item ? "rating" : "unit rate", maxlength: TRACKER_LIMITS.label, enterkeyhint: "next", autocapitalize: "none" }) as HTMLInputElement;

    // A number: what's written before and after it, shown live.
    const before = h("input", { class: "tk-input tks-affix", autocomplete: "off", placeholder: "Before", maxlength: TRACKER_LIMITS.affix, "aria-label": "Written before the number", autocapitalize: "none" }) as HTMLInputElement;
    const after = h("input", { class: "tk-input tks-affix", autocomplete: "off", placeholder: "After", maxlength: TRACKER_LIMITS.affix, "aria-label": "Written after the number", autocapitalize: "none" }) as HTMLInputElement;
    const shows = h("p", { class: "tks-preview", "aria-live": "polite" });
    const paintShows = () => {
      const pre = cleanAffix(before.value);
      let suf = cleanAffix(after.value);
      // A word after a number reads with a space ("12 kg"); a symbol doesn't ("12%", "24p").
      if (suf && /^[A-Za-z]{2,}/.test(suf)) suf = ` ${suf}`;
      shows.replaceChildren(pre || suf ? "Shows as " : "Like £ before it, or kg after. Shows as ", h("strong", {}, valueWords({ kind: "number", prefix: pre, suffix: suf, currency: null }, "1234")));
      return { prefix: pre, suffix: suf };
    };
    before.addEventListener("input", paintShows);
    after.addEventListener("input", paintShows);
    paintShows();
    const written = h("div", { class: "tks-field" }, h("p", { class: "tks-field__label" }, "How it's written"), h("div", { class: "tks-written" }, before, h("span", { class: "tks-written__n", "aria-hidden": "true" }, "1,234"), after), shows);
    const news = seg<TrackerDirection>("What counts as news", [{ value: "lower", label: "Goes down" }, { value: "higher", label: "Goes up" }, { value: "change", label: "Any change" }], "change", () => undefined);

    // A state: the one hoped for, then the others.
    const hope = h("input", { class: "tk-input", autocomplete: "off", placeholder: item ? "available" : "approved", maxlength: TRACKER_LIMITS.state, autocapitalize: "none", "aria-label": "The state you hope for" }) as HTMLInputElement;
    const others = h("div", { class: "tks-states" });
    const addOther = (placeholder = "another state") => {
      const input = h("input", { class: "tk-input", autocomplete: "off", placeholder, maxlength: TRACKER_LIMITS.state, autocapitalize: "none", "aria-label": "Another state" }) as HTMLInputElement;
      others.append(input);
      moreStates.hidden = others.children.length >= TRACKER_LIMITS.states - 1;
      return input;
    };
    const moreStates = h("button", { class: "tk-toggle", type: "button" }, icons.plus(), "Another state");
    moreStates.addEventListener("click", () => addOther().focus());
    addOther(item ? "waiting list" : "being checked");
    const states = h(
      "div",
      { class: "tks-group", hidden: true },
      field("The one you hope for", hope, { id: `${id}-hope` }),
      h("div", { class: "tks-field" }, h("p", { class: "tks-field__label" }, "Otherwise it can be"), others, moreStates)
    );
    const number = h("div", { class: "tks-group" }, written, news.el);

    let kind: TrackerKind = "number";
    const kindSeg = seg<TrackerKind>("It's", [{ value: "number", label: "A number" }, { value: "state", label: "A state" }], "number", (k) => {
      kind = k;
      number.hidden = k !== "number";
      states.hidden = k !== "state";
    });

    const who = whoRow({ preset: null });
    label.addEventListener("input", () => who.refit(label.value));
    const go = h("button", { class: "btn btn--primary btn--block", type: "submit" }, "Start tracking") as HTMLButtonElement;
    const form = h(
      "form",
      { class: "tks-form" },
      ...(item
        ? []
        : [field("Name", name, { id: `${id}-name` }), field("Its page", link, { id: `${id}-link`, hint: "Optional. Where you or an assistant read it." })]),
      field("What to track", label, { id: `${id}-label`, hint: item ? "One or two words, like rating or queue position." : "One or two words, like unit rate or followers." }),
      kindSeg.el,
      number,
      states,
      who.el,
      err,
      go
    );
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      err.hidden = true;
      const fail = (m: string, el?: HTMLInputElement) => {
        err.textContent = m;
        err.hidden = false;
        el?.setAttribute("aria-invalid", "true");
        el?.focus();
      };
      if (!item && !name.value.trim()) return fail("Give it a name, like Electricity tariff.", name);
      let url: string | null = null;
      try {
        url = item ? null : cleanLink(link.value);
      } catch {
        return fail("That link doesn't look right. Paste the page's address, or leave it empty.", link);
      }
      let lab: string;
      try {
        lab = cleanLabel(label.value);
      } catch {
        return fail(item ? "Say what to track, like rating." : "Say what you're reading, like unit rate.", label);
      }
      let input: Parameters<typeof createTracker>[0];
      if (kind === "number") input = { label: lab, kind, ...paintShows(), direction: news.value() };
      else {
        let list: string[];
        try {
          list = cleanStates([hope.value, ...[...others.querySelectorAll("input")].map((i) => (i as HTMLInputElement).value)]);
        } catch {
          return fail("Add at least two states: the one you hope for and one other.", hope.value.trim() ? (others.querySelector("input") as HTMLInputElement) : hope);
        }
        input = { label: lab, kind, states: list, direction: "change" };
      }
      input.assistant_id = who.value();
      if (item) input.saved_id = item.id;
      else {
        input.name = name.value.replace(/\s+/g, " ").trim();
        input.url = url;
        input.saved_id = null;
      }
      await start(go, input, `Tracking ${item ? lab : input.name}`);
    });
    body.replaceChildren(form);
    queueMicrotask(() => (item ? label : name).focus());
  }

  if (item) choose();
  else describe();
}

// ---------- who checks it, later ----------

/**
 * "Who checks it?" from a block's menu, or Choose on "Nobody is checking this yet": the same choices as the sheet
 * (the assistants who can look things up online, the fitting one first, and "Just me"), with the one there now
 * marked even when it can't check. One tap keeps it, with Undo.
 */
export function openCheckerSheet(view: TrackerView): void {
  const list = h("div", { class: "tks-who-list", role: "radiogroup", "aria-label": "Who checks it?" });
  const hint = h("p", { class: "tks-field__hint", hidden: true }, "No assistant can look things up online yet. You can turn it on from an assistant's page.");
  const body = h("div", { class: "tks" }, h("p", { class: "tks-lede" }, view.saved_id ? `${cap(view.label)} · ${view.name}` : view.name), list, hint);
  const sheet = openSheet({ label: "Who checks it?", title: "Who checks it?", body });
  const nameOf = (team: TeamAssistant[], id: string | null) => (id ? (team.find((a) => a.id === id)?.name ?? "An assistant") : null);

  const choose = async (b: HTMLButtonElement, id: string | null, team: TeamAssistant[]) => {
    if (id === view.assistant_id && (id || view.assistant_set_by === "owner")) return sheet.close();
    b.setAttribute("aria-busy", "true");
    const was = view.assistant_id;
    try {
      await updateTracker(view.id, { assistant_id: id });
      sheet.close();
      const who = nameOf(team, id);
      showToast(who ? `${who} checks it now` : "You check it now", { icon: "check", action: { label: "Undo", run: () => void updateTracker(view.id, { assistant_id: was }) } });
    } catch (error) {
      showToast(error instanceof Error && !/^[a-z_]+:/.test(error.message) ? error.message : "Couldn't change who checks it", { icon: "wifiOff" });
    } finally {
      b.removeAttribute("aria-busy");
    }
  };

  const option = (team: TeamAssistant[], a: TeamAssistant | null, sub: string) => {
    const id = a?.id ?? null;
    const on = id === view.assistant_id && (id !== null || view.assistant_set_by === "owner");
    const b = h(
      "button",
      { class: "tks-opt tks-who-opt", type: "button", role: "radio", "aria-checked": String(on) },
      h("span", { class: "tks-opt__icon tks-who-opt__face", "aria-hidden": "true" }, a ? renderAvatarTile(a.avatar, { size: 32, animate: false }) : icons.person()),
      h("span", { class: "tks-opt__text" }, h("span", { class: "tks-opt__name" }, a ? a.name : "Just me"), h("span", { class: "tks-opt__sub" }, sub)),
      on ? icons.check() : h("span", { class: "tks-who-opt__gap", "aria-hidden": "true" })
    ) as HTMLButtonElement;
    b.addEventListener("click", () => void choose(b, id, team));
    return b;
  };

  void listTeam()
    .catch(() => [] as TeamAssistant[])
    .then((team) => {
      const able = team.filter((a) => webOn(a) && !a.paused);
      const fit = pickChecker(team, { preset: view.preset, label: view.label });
      const order = [...able.filter((a) => a.id === fit), ...able.filter((a) => a.id !== fit)];
      const now = view.assistant_id ? team.find((a) => a.id === view.assistant_id && !order.includes(a)) : undefined;
      const rows = [
        ...order.slice(0, 1).map((a) => option(team, a, a.job)),
        option(team, null, "You add each check yourself."),
        ...order.slice(1).map((a) => option(team, a, a.job)),
        // The one there now, when it can't check: marked, with why.
        ...(now ? [option(team, now, now.paused ? "Paused" : "Can't look things up online")] : []),
      ];
      list.replaceChildren(...rows);
      hint.hidden = able.length > 0;
      ((list.querySelector('[aria-checked="true"]') ?? list.firstElementChild) as HTMLElement | null)?.focus();
    });
}
