/**
 * The "what you did" sections of a day page, each designed for its kind:
 * posters in a row for Watched, albums with their plays for Listened, books
 * with their highlights for Read, wide art for Played, results for Chess,
 * the words themselves for Posted, and links for Saved. A section's title
 * is its kind; under it, what it adds up to in words.
 */

import { h } from "../lib/dom";
import { icons } from "./icons";
import { dayIcons } from "./day-icons";
import { artTile, initialsOf } from "./day-art";
import { alsoSort, capital, groupEntries, hoursMinutes, isEpisode, kindSummary, KIND_TITLE, list, plural, sourceName, type AlsoSort, type EntryGroup } from "./day-words";
import type { DayEntry, EntryKind } from "../db/days-app";
import { habitSection } from "./day-habits";
import { savedDaySection } from "./day-saved";

const timeOf = (iso: string | undefined) => (iso && iso.length >= 16 ? iso.slice(11, 16) : null);

function stars(rating: number | undefined): HTMLElement | null {
  if (rating === undefined) return null;
  const out = h("span", { class: "stars", role: "img", "aria-label": `Rated ${rating} out of 5` });
  for (let i = 1; i <= 5; i++) out.append(rating >= i ? icons.starSolid() : rating >= i - 0.5 ? icons.starHalf() : icons.star());
  return out;
}

function section(kind: EntryKind, entries: DayEntry[], body: HTMLElement, subline?: string): HTMLElement {
  const id = `day-sec-${kind}`;
  return h(
    "section",
    { class: `day-sec day-sec--${kind}`, "aria-labelledby": id },
    h("div", { class: "day-sec__head" }, h("h2", { class: "day-sec__title", id }, KIND_TITLE[kind]), subline === "" ? null : h("span", { class: "day-sec__sub" }, subline ?? kindSummary(kind, entries))),
    body
  );
}

/** A link when the entry has one, otherwise a plain block. */
function item(e: DayEntry, cls: string, ...children: (Node | null)[]): HTMLElement {
  const safe = e.url && /^https:\/\//.test(e.url) ? e.url : null;
  const el = safe ? h("a", { class: `${cls} day-link`, href: safe, target: "_blank", rel: "noopener noreferrer" }, ...children) : h("div", { class: cls }, ...children);
  el.dataset.ids = e.id;
  el.dataset.name = e.group && e.kind !== "highlight" ? e.group : e.title;
  return el;
}

/** The entries an item stands for (a show's episodes, an album's tracks), for Hide. */
const standsFor = (el: HTMLElement, g: EntryGroup) => {
  el.dataset.ids = g.entries.map((x) => x.id).join(" ");
  return el;
};

// ---------- Watched ----------

function watched(entries: DayEntry[]): HTMLElement {
  const groups = groupEntries(entries);
  const shelf = h(
    "ul",
    { class: `shelf${groups.length === 1 ? " shelf--single" : ""}`, role: "list" },
    ...groups.map((g) => {
      const e = g.lead;
      const show = isEpisode(e);
      const title = show ? e.group! : e.title;
      const sub = show
        ? [g.entries.length > 1 ? capital(plural(g.total, "episode")) : e.subtitle ?? e.title, groups.length === 1 ? sourceName(e.source) : null].filter(Boolean).join(" · ")
        : [e.subtitle, e.note, sourceName(e.source)].filter(Boolean).join(" · ");
      return h(
        "li",
        { class: "shelf__item" },
        standsFor(item(e, "poster", artTile(e.art, { frame: [3, 4], initials: initialsOf(title), className: "poster__art" }), h("span", { class: "poster__title" }, title), h("span", { class: "poster__sub" }, sub), stars(e.rating)), g)
      );
    })
  );
  return section("watched", entries, shelf, groups.length === 1 ? "" : undefined);
}

// ---------- Listened ----------

function listened(entries: DayEntry[]): HTMLElement {
  const groups = groupEntries(entries);
  const top = groups.slice(0, 4);
  const rest = groups.slice(4);
  const row = (g: EntryGroup) => {
    const e = g.lead;
    const title = e.group ?? e.title;
    const tracks = [...new Set(g.entries.map((x) => x.title))];
    const trackWords = e.group ? (tracks.length > 3 ? `${tracks.slice(0, 3).join(", ")} and ${tracks.length - 3} more` : list(tracks)) : null;
    return h(
      "li",
      { class: "album" },
      standsFor(item(
        e,
        "album__link",
        artTile(e.art, { frame: [3, 4], initials: initialsOf(title), className: "album__art" }),
        h(
          "span",
          { class: "album__body" },
          h("span", { class: "album__title" }, title),
          h("span", { class: "album__by" }, [e.subtitle, plural(g.total, "play")].filter(Boolean).join(" · ")),
          trackWords ? h("span", { class: "album__tracks" }, trackWords) : null
        )
      ), g)
    );
  };
  const listEl = h("ul", { class: "albums", role: "list" }, ...top.map(row));
  const body = h("div", { class: "day-sec__body" }, listEl);
  if (rest.length) {
    const more = h("button", { class: "btn btn--ghost btn--sm day-more", type: "button", "aria-expanded": "false" }, `${plural(rest.length, "more album")}`);
    more.addEventListener("click", () => {
      listEl.append(...rest.map(row));
      more.remove();
    });
    body.append(more);
  }
  return section("listened", entries, body, groups.length === 1 ? "" : undefined);
}

// ---------- Read and highlights ----------

function read(books: DayEntry[], highlights: DayEntry[]): HTMLElement {
  const body = h("div", { class: "day-sec__body books" });
  for (const b of books) {
    const progress = /page (\d+) of (\d+)/.exec(b.subtitle ?? "");
    const quotes = highlights.filter((x) => x.group === b.title || x.subtitle === b.title);
    body.append(
      h(
        "article",
        { class: "book", "data-ids": [b.id, ...quotes.map((q) => q.id)].join(" "), "data-name": b.title },
        artTile(b.art, { frame: [3, 4], initials: initialsOf(b.title), className: "book__art" }),
        h(
          "div",
          { class: "book__body" },
          h("h3", { class: "book__title" }, b.title),
          h("p", { class: "book__by" }, (b.subtitle ?? "").replace(/ · page \d+ of \d+/, "")),
          progress
            ? h(
                "p",
                { class: "book__progress" },
                h("span", { class: "book__bar", "aria-hidden": "true" }, h("span", { style: `width:${Math.min(100, (Number(progress[1]) / Number(progress[2])) * 100).toFixed(0)}%` })),
                h("span", {}, `Page ${progress[1]} of ${progress[2]}`)
              )
            : null
        )
      ),
      ...quotes.map((q) => h("blockquote", { class: "quote" }, h("span", { class: "quote__mark", "aria-hidden": "true" }, dayIcons.quote()), h("p", {}, q.title)))
    );
  }
  const loose = highlights.filter((x) => !books.some((b) => x.group === b.title || x.subtitle === b.title));
  for (const q of loose)
    body.append(h("blockquote", { class: "quote quote--loose" }, h("span", { class: "quote__mark", "aria-hidden": "true" }, dayIcons.quote()), h("p", {}, q.title), q.subtitle ? h("footer", { class: "quote__from" }, q.subtitle) : null));
  if (books.length) return section("read", books, body);
  return section("highlight", highlights, body);
}

// ---------- Played ----------

function played(entries: DayEntry[]): HTMLElement {
  const shelf = h(
    "ul",
    { class: `shelf shelf--wide${entries.length === 1 ? " shelf--single" : ""}`, role: "list" },
    ...entries.map((e) =>
      h(
        "li",
        { class: "shelf__item" },
        item(e, "poster poster--wide", artTile(e.art, { frame: [3, 4], initials: initialsOf(e.title), className: "poster__art" }), h("span", { class: "poster__title" }, e.title), h("span", { class: "poster__sub" }, [e.minutes ? hoursMinutes(e.minutes) : null, e.subtitle, e.note, sourceName(e.source)].filter(Boolean).join(" · ")))
      )
    )
  );
  return section("played", entries, shelf, entries.length === 1 ? "" : undefined);
}

// ---------- Chess ----------

function chess(entries: DayEntry[]): HTMLElement {
  const wins = entries.filter((e) => /^won/i.test(e.title)).length;
  const losses = entries.filter((e) => /^lost/i.test(e.title)).length;
  const tally = entries.length > 1 ? capital(`${plural(wins, "win")}, ${plural(losses, "loss", "losses")}${entries.length - wins - losses ? `, ${plural(entries.length - wins - losses, "draw")}` : ""}`) : undefined;
  return section(
    "chess",
    entries,
    h(
      "div",
      { class: "day-sec__body" },
      h(
        "ul",
        { class: "rows", role: "list" },
        ...entries.map((e) =>
          h("li", {}, item(e, "row-line", h("span", { class: "row-line__icon", "aria-hidden": "true" }, dayIcons.chess()), h("span", { class: "row-line__body" }, h("span", { class: "row-line__title" }, e.title), h("span", { class: "row-line__sub" }, [e.subtitle, sourceName(e.source)].filter(Boolean).join(" · ")))))
        )
      )
    ),
    tally
  );
}

// ---------- Posted ----------

function posted(entries: DayEntry[]): HTMLElement {
  return section(
    "posted",
    entries,
    h(
      "ul",
      { class: "posts", role: "list" },
      ...entries.map((e) => h("li", {}, item(e, "post", h("p", { class: "post__text" }, e.title), h("span", { class: "post__meta" }, [sourceName(e.source), timeOf(e.at)].filter(Boolean).join(" · ")))))
    )
  );
}

// ---------- Saved and other ----------

/** An Also row's icon: a train for a TfL journey, a car for a ride, a bag for a takeaway. */
const ALSO_ICON: Record<AlsoSort, () => SVGSVGElement> = { journey: icons.train, ride: icons.car, takeaway: icons.bag, other: icons.link };

function rowIcon(kind: EntryKind, e: DayEntry): SVGSVGElement {
  if (kind === "saved") return icons.bookmark();
  return kind === "other" ? ALSO_ICON[alsoSort(e)]() : icons.link();
}

function links(kind: EntryKind, entries: DayEntry[]): HTMLElement {
  return section(
    kind,
    entries,
    h(
      "ul",
      { class: "rows", role: "list" },
      ...entries.map((e) =>
        h(
          "li",
          {},
          item(
            e,
            "row-line",
            h("span", { class: "row-line__icon", "aria-hidden": "true" }, rowIcon(kind, e)),
            h("span", { class: "row-line__body" }, h("span", { class: "row-line__title" }, e.title), h("span", { class: "row-line__sub" }, [e.subtitle, sourceName(e.source)].filter(Boolean).join(" · "))),
            e.url ? h("span", { class: "row-line__go", "aria-hidden": "true" }, icons.external()) : null
          )
        )
      )
    )
  );
}

/**
 * With onHide, each section gets an Edit toggle; while editing, everything
 * in it has a Hide button (a show's episodes or an album's tracks hide
 * together).
 */
function withHide(sec: HTMLElement, onHide: (ids: string[], name: string) => void): HTMLElement {
  const targets = [...sec.querySelectorAll<HTMLElement>("[data-ids]")];
  if (!targets.length) return sec;
  const head = sec.querySelector(".day-sec__head")!;
  const title = sec.querySelector(".day-sec__title")?.textContent ?? "";
  const edit = h("button", { class: "btn btn--ghost btn--sm day-sec__edit", type: "button", "aria-pressed": "false", "aria-label": `Edit ${title}` }, "Edit");
  edit.addEventListener("click", () => {
    const on = !sec.classList.contains("is-editing");
    sec.classList.toggle("is-editing", on);
    edit.setAttribute("aria-pressed", String(on));
    edit.textContent = on ? "Done" : "Edit";
  });
  head.classList.add("day-sec__head--edit");
  head.append(edit);
  for (const t of targets) {
    const holder = t.tagName === "A" ? t.parentElement! : t;
    holder.classList.add("hideable");
    const name = t.dataset.name ?? "this";
    const b = h("button", { class: "hide-btn", type: "button", "aria-label": `Hide ${name} from this day` }, icons.close(), h("span", {}, "Hide"));
    b.addEventListener("click", (e) => {
      e.preventDefault();
      onHide((t.dataset.ids ?? "").split(" ").filter(Boolean), name);
    });
    holder.append(b);
  }
  return sec;
}

/** Every section the day has, in the day's order. Workouts are in Body, not here. */
export function entrySections(entries: DayEntry[], opts: { onHide?: (ids: string[], name: string) => void; date?: string } = {}): HTMLElement[] {
  const done = (secs: HTMLElement[]) => (opts.onHide ? secs.map((s) => withHide(s, opts.onHide!)) : secs);
  const of = (k: EntryKind) => entries.filter((e) => e.kind === k);
  const out: HTMLElement[] = [];
  if (of("watched").length) out.push(watched(of("watched")));
  if (of("listened").length) out.push(listened(of("listened")));
  if (of("read").length || of("highlight").length) out.push(read(of("read"), of("highlight")));
  if (of("played").length) out.push(played(of("played")));
  if (of("chess").length) out.push(chess(of("chess")));
  if (of("posted").length) out.push(posted(of("posted")));
  // With the day's date, what you saved in Athena joins the apps' saved links under one "Saved".
  if (opts.date) out.push(savedDaySection(of("saved").length ? links("saved", of("saved")).querySelector("ul") : null, opts.date));
  else if (of("saved").length) out.push(links("saved", of("saved")));
  if (of("other").length) out.push(links("other", of("other")));
  // With the day's date, Athena's own habits due that day show (and tick) even before any entry exists.
  if (of("habit").length || opts.date) out.push(habitSection(of("habit"), opts.date));
  return done(out);
}
