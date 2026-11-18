/**
 * Search across days: words (titles, artists, the journal, the day's line)
 * narrowed by kind (Watched, Listened…), source (Netflix, Spotify…), place
 * and person. Results are days, newest first, each with the things on it
 * that matched. The search lives in the address (?q=&kind=…), so Back
 * returns to the same results.
 */

import { h } from "../lib/dom";
import { icons } from "../components/icons";
import { artTile, initialsOf } from "../components/day-art";
import { dayHref } from "../components/day-card";
import { dayNumber, groupEntries, listLine, KIND_FILTER, KIND_TITLE, longDate, plural, sourceName, weekdayShort } from "../components/day-words";
import { searchDays, type DayEntry, type DaySearchFilters, type DaySearchHit, type DaySearchResult, type EntryKind } from "../db/days-app";
import { localToday } from "../lib/time";
import { failedCard, type DaysNav, type Mounted } from "./days";

const FILTERS = ["kind", "source", "place", "person"] as const;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export function renderSearch(params: URLSearchParams, nav: DaysNav, head: (extra: HTMLElement | null) => HTMLElement): Mounted {
  const today = localToday();
  const f: DaySearchFilters = {
    q: params.get("q") ?? "",
    kind: (params.get("kind") as EntryKind | null) ?? null,
    source: params.get("source"),
    place: params.get("place"),
    person: params.get("person"),
  };
  let facets: DaySearchResult["facets"] = { sources: [], places: [], people: [] };
  let dead = false;
  let seq = 0;

  const input = h("input", { class: "days-search__input", type: "search", placeholder: "Films, songs, books, places, words…", "aria-label": "Search your days", value: f.q ?? "", enterkeyhint: "search", autocomplete: "off" }) as HTMLInputElement;
  const clear = h("button", { class: "icon-btn icon-btn--ghost icon-btn--sm days-search__clear", type: "button", "aria-label": "Clear search", hidden: !f.q }, icons.close());
  const box = h("div", { class: "days-search__box" }, icons.search(), input, clear);
  const kinds = h("div", { class: "chip-row days-search__kinds", role: "radiogroup", "aria-label": "Kind" });
  const selects = h("div", { class: "days-search__selects" });
  const status = h("p", { class: "days-search__status", role: "status", "aria-live": "polite" });
  const results = h("ol", { class: "days-results", role: "list" });
  const body = h("div", { class: "days-search" }, box, kinds, selects, status, results);
  const el = h("div", { class: "view days days--search" }, head(null), body);

  function query(): string {
    const qs = new URLSearchParams();
    if (f.q) qs.set("q", f.q);
    for (const k of FILTERS) if (f[k]) qs.set(k, String(f[k]));
    return qs.toString();
  }
  /** Keep the address in step without re-rendering the page. */
  const sync = () => history.replaceState(history.state, "", `#/days/search${query() ? `?${query()}` : ""}`);

  function paintKinds() {
    const all: [EntryKind | null, string][] = [[null, "Everything"], ...(Object.entries(KIND_FILTER) as [EntryKind, string][])];
    kinds.replaceChildren(
      ...all.map(([k, label]) => {
        const b = h("button", { class: "chip", type: "button", role: "radio", "aria-checked": String((f.kind ?? null) === k) }, label);
        b.addEventListener("click", () => {
          f.kind = k;
          paintKinds();
          run();
        });
        return b;
      })
    );
  }

  function paintSelects() {
    const make = (key: "source" | "place" | "person", label: string, any: string, options: string[], name: (s: string) => string = (s) => s) => {
      if (!options.length && !f[key]) return null;
      const sel = h("select", { class: "days-select__control", "aria-label": label }, h("option", { value: "" }, any), ...options.map((o) => h("option", { value: o, selected: f[key] === o }, name(o)))) as HTMLSelectElement;
      if (f[key] && !options.includes(f[key]!)) sel.append(h("option", { value: f[key]!, selected: true }, name(f[key]!)));
      sel.addEventListener("change", () => {
        f[key] = sel.value || null;
        wrap.classList.toggle("is-set", !!sel.value);
        run();
      });
      const wrap = h("label", { class: `days-select${f[key] ? " is-set" : ""}` }, h("span", { class: "days-select__label" }, label), sel, icons.chevronDown());
      return wrap;
    };
    selects.replaceChildren(
      ...[make("source", "From", "Any app", facets?.sources ?? [], sourceName), make("place", "Place", "Anywhere", facets?.places ?? []), make("person", "With", "Anyone", facets?.people ?? [])].filter((x): x is HTMLLabelElement => !!x)
    );
  }

  let timer: ReturnType<typeof setTimeout> | undefined;
  input.addEventListener("input", () => {
    clear.hidden = !input.value;
    clearTimeout(timer);
    timer = setTimeout(() => {
      f.q = input.value.trim();
      run();
    }, 220);
  });
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      clearTimeout(timer);
      f.q = input.value.trim();
      run();
    }
  });
  clear.addEventListener("click", () => {
    input.value = "";
    clear.hidden = true;
    f.q = "";
    input.focus();
    run();
  });

  async function run() {
    sync();
    const mine = ++seq;
    const blank = !f.q && FILTERS.every((k) => !f[k]);
    results.setAttribute("aria-busy", "true");
    try {
      const r = await searchDays(blank ? { q: "" } : f);
      if (dead || mine !== seq) return;
      // The server offers what the results span; a filter that's set keeps the choices it had, so it can be changed.
      const next = r.facets ?? { sources: [], places: [], people: [] };
      facets = { sources: f.source ? facets.sources : next.sources, places: f.place ? facets.places : next.places, people: f.person ? facets.people : next.people };
      paintSelects();
      results.removeAttribute("aria-busy");
      if (blank) {
        status.textContent = "";
        results.replaceChildren(h("li", { class: "days-search__hint" }, h("p", { class: "empty__title" }, "Search your days"), h("p", { class: "empty__sub" }, "Try a film, a song, a book, a place or a word from your journal.")));
        return;
      }
      const groups = groupHits(r.results, f.source ?? null);
      status.textContent = groups.length ? plural(groups.length, "day") : "";
      results.replaceChildren(...(groups.length ? groups.map((g) => resultRow(g, f.q ?? "", today, nav)) : [h("li", { class: "days-search__hint" }, h("p", { class: "empty__title" }, "Nothing matches"), h("p", { class: "empty__sub" }, "Try fewer words, or take a filter off."))]));
    } catch {
      if (dead || mine !== seq) return;
      results.removeAttribute("aria-busy");
      status.textContent = "";
      results.replaceChildren(h("li", {}, failedCard("search", () => void run())));
    }
  }

  paintKinds();
  paintSelects();
  void run();
  requestAnimationFrame(() => input.focus());
  return { el, destroy: () => (dead = true) };
}

/** Text with each case-insensitive match of q wrapped in <mark>. */
function marked(text: string, q: string): (Node | string)[] {
  if (!q) return [text];
  const out: (Node | string)[] = [];
  const lower = text.toLowerCase();
  const needle = q.toLowerCase();
  let i = 0;
  for (let at = lower.indexOf(needle); at !== -1 && needle; at = lower.indexOf(needle, i)) {
    out.push(text.slice(i, at), h("mark", {}, text.slice(at, at + needle.length)));
    i = at + needle.length;
  }
  out.push(text.slice(i));
  return out;
}

interface DayHits {
  date: string;
  line?: string;
  entries: DayEntry[];
  /** Words from the journal around the match. */
  journal?: string;
}

/** Hits grouped by day, newest first, narrowed to one app when asked. */
function groupHits(hits: DaySearchHit[], source: string | null): DayHits[] {
  const byDate = new Map<string, DayHits>();
  for (const x of [...hits].sort((a, b) => b.rank - a.rank)) {
    if (source && x.entry?.source !== source) continue;
    const g = byDate.get(x.date) ?? { date: x.date, line: x.line, entries: [] };
    if (x.entry) g.entries.push(x.entry);
    if (x.match === "journal" && !g.journal) g.journal = x.snippet;
    g.line ??= x.line;
    byDate.set(x.date, g);
  }
  return [...byDate.values()].sort((a, b) => b.date.localeCompare(a.date));
}

function resultRow(hit: DayHits, q: string, today: string, nav: DaysNav, why?: string): HTMLElement {
  // A day without a sentence shows just what matched; the date is already beside it.
  const line = hit.line ? listLine(hit.line) : null;
  // The server marks the match in « »; older answers come plain.
  const snippet = hit.journal ? (hit.journal.includes("«") ? hit.journal.split(/«|»/).map((part, i) => (i % 2 ? h("mark", {}, part) : part)) : marked(hit.journal, q)) : null;
  const a = h(
    "a",
    { class: "result", href: dayHref(hit.date) },
    h("span", { class: "day-card__date", "aria-hidden": "true" }, h("span", { class: "day-card__dow" }, weekdayShort(hit.date)), h("span", { class: "day-card__num" }, dayNumber(hit.date)), h("span", { class: "result__ym" }, hit.date.slice(0, 7) === today.slice(0, 7) ? "" : `${MONTHS[Number(hit.date.slice(5, 7)) - 1]} ${hit.date.slice(0, 4)}`)),
    h(
      "span",
      { class: "result__body" },
      h("span", { class: "visually-hidden" }, `${longDate(hit.date, today)}. `),
      line ? h("span", { class: "result__line" }, h("span", {}, ...marked(line, q))) : null,
      why ? h("span", { class: "result__why" }, why) : null,
      snippet ? h("span", { class: "result__snippet" }, "“", ...snippet, "”") : null,
      hit.entries.length
        ? h(
            "span",
            { class: "result__entries" },
            ...groupEntries(hit.entries).slice(0, 4).map((g) => {
              const e = g.lead;
              const many = g.entries.length > 1;
              const title = e.group && e.kind !== "highlight" ? (many ? e.group : `${e.group}: ${e.title}`) : e.title;
              const detail = many ? plural(g.entries.length, e.kind === "watched" ? "episode" : e.kind === "listened" ? "track" : "item") : e.kind !== "highlight" ? e.subtitle : null;
              return h(
                "span",
                { class: "result__entry" },
                artTile(e.art, { height: 56, frame: [3, 4], initials: initialsOf(e.group ?? e.title) }),
                h("span", { class: "result__entry-body" }, h("span", { class: "result__entry-title" }, ...marked(title, q)), h("span", { class: "result__entry-sub" }, [KIND_TITLE[e.kind], detail, sourceName(e.source)].filter(Boolean).join(" · ")))
              );
            })
          )
        : null
    )
  );
  a.addEventListener("click", (e) => {
    if (e.metaKey || e.ctrlKey) return;
    e.preventDefault();
    nav.to(hit.date);
  });
  return h("li", {}, a);
}
