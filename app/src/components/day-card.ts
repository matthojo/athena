/**
 * A day in the feed: the date as a big numeral, the day's line, its mood,
 * the key figures in a sentence and a strip of its artwork. The whole card
 * is one link to the day. Also the compact cards for On this day and for a
 * week's recap between the weeks of the feed.
 */

import "../styles/memories.css";
import { dayHref } from "../lib/day-link";
import { h } from "../lib/dom";
import { prefersReducedMotion } from "../lib/motion";
import type { FirstKind, RememberedDay } from "../lib/memories";
import { hideMemory, showMemory } from "../db/memories-app";
import { icons } from "./icons";
import { showToast } from "./toast";
import { artStrip, artTile, photoArt } from "./day-art";
import { moodGlyph } from "./day-mood";
import { dayNumber, list, listLine, longDate, moodWord, relativeDay, summaryFigures, weekdayShort, yearsAgo, type WeekGlance } from "./day-words";
import { loadDays, type DayArt, type DaySummary, type Mood } from "../db/days-app";
import { keptMomentsNow, loadWeekMoments } from "../db/week-moments";
import { sameMoment, type WeekMoment } from "../lib/week-moment";
import "../styles/week-moment.css";

export { dayHref };

/** A summary's artwork: its first photo, then its entries' art. */
function artOf(day: DaySummary): { art?: DayArt; title: string; photo?: boolean }[] {
  const out: { art?: DayArt; title: string; photo?: boolean }[] = day.art.map((a) => ({ art: a, title: "" }));
  if (day.photo) out.unshift({ art: photoArt({ id: day.photo, thumb: true, added_at: "" }), title: "Photo", photo: true });
  return out;
}

/** A summary has no entries to build a line from; its figures stand in. */
const bareLine = (day: DaySummary) => (day.journal ? "You wrote about this day" : null);

export function dayCard(day: DaySummary, today: string, opts: { onOpen?: (date: string) => void } = {}): HTMLElement {
  const figures = summaryFigures(day.counts);
  const line = day.line ? listLine(day.line) : bareLine(day);
  const rel = relativeDay(day.date, today);
  const mood = moodWord(day.mood);
  const label = [longDate(day.date, today), line, mood ? `Mood: ${mood}` : null, figures.length ? list(figures) : null].filter(Boolean).join(". ");
  const a = h(
    "a",
    { class: `day-card${line ? "" : " day-card--bare"}${artOf(day).length ? "" : " day-card--text"}`, href: dayHref(day.date), "aria-label": label, "data-date": day.date },
    h(
      "span",
      { class: "day-card__date", "aria-hidden": "true" },
      h("span", { class: "day-card__dow" }, weekdayShort(day.date)),
      h("span", { class: "day-card__num" }, dayNumber(day.date)),
      day.mood ? h("span", { class: "day-card__mood", "data-mood": String(day.mood) }, moodGlyph(day.mood, { label: false }), moodWord(day.mood)) : null
    ),
    h(
      "span",
      { class: "day-card__body", "aria-hidden": "true" },
      rel === "Today" || rel === "Yesterday" ? h("span", { class: "day-card__top" }, h("span", { class: "day-card__rel" }, rel)) : null,
      // Artwork leads; then one sentence: the day's line, or its figures when it has none.
      artStrip(artOf(day), { height: 72, max: 5 }),
      h("span", { class: "day-card__line" }, line ?? (figures.length ? list(figures.slice(0, 3)) : "Nothing much recorded"))
    )
  );
  if (opts.onOpen) a.addEventListener("click", (e) => {
    if (e.metaKey || e.ctrlKey || e.shiftKey) return;
    e.preventDefault();
    opts.onOpen!(day.date);
  });
  return a;
}

/**
 * On this day. With a memory (components/day-today.ts onThisDay): one
 * sentence, at most one cover, and "Not this one" under it, which hides the
 * day from memories for good. It fades up the first time it's shown (no
 * motion with reduced motion). Without one: the same date in an earlier
 * year, small.
 */
export function earlierCard(day: RememberedDay, today: string, onOpen: (date: string) => void): HTMLElement {
  if (day.memory) return memoryCard(day, day.memory, onOpen);
  const line = (day.line ? listLine(day.line) : list(summaryFigures(day.counts, 3))) || "Nothing much recorded";
  const a = h(
    "a",
    { class: "earlier", href: dayHref(day.date), "aria-label": `${yearsAgo(day.date, today)}, ${longDate(day.date, today)}: ${line}` },
    h("span", { class: "earlier__when", "aria-hidden": "true" }, yearsAgo(day.date, today), h("span", { class: "earlier__year" }, day.date.slice(0, 4))),
    h("span", { class: "earlier__line", "aria-hidden": "true" }, line),
    artStrip(artOf(day), { height: 40, max: 5 })
  );
  a.addEventListener("click", (e) => {
    if (e.metaKey || e.ctrlKey) return;
    e.preventDefault();
    onOpen(day.date);
  });
  return a;
}

/** Memories already shown in this visit: they fade up once, not on every repaint. */
const shownMemories = new Set<string>();

const FIRST_ICON: Record<FirstKind, keyof typeof icons> = { place: "pin", person: "person", run: "heart", book: "book" };

function memoryCard(day: DaySummary, m: NonNullable<RememberedDay["memory"]>, onOpen: (date: string) => void): HTMLElement {
  // The sentence, with the owner's own words set apart.
  const at = m.sentence.indexOf(' You wrote "');
  const own = at < 0 && m.sentence.includes(', you wrote "') ? m.sentence.indexOf('"') : -1;
  const split = at >= 0 ? at + ' You wrote '.length : own;
  const text =
    split >= 0
      ? h("span", { class: "memory__text" }, m.sentence.slice(0, split), h("q", { class: "memory__quote" }, m.sentence.slice(split + 1, -1)))
      : h("span", { class: "memory__text" }, m.sentence);
  // At most one cover, and no "+3": a memory is one picture, not a shelf.
  const cover = artStrip(artOf(day).slice(0, 1), { height: 56, max: 1 });
  const mark = !cover && m.first ? h("span", { class: "memory__mark", "aria-hidden": "true" }, icons[FIRST_ICON[m.first]]()) : null;
  const link = h("a", { class: "memory__link", href: dayHref(day.date), "aria-label": m.sentence }, ...[cover, mark].filter((x): x is HTMLElement => !!x), text);
  link.addEventListener("click", (e) => {
    if (e.metaKey || e.ctrlKey) return;
    e.preventDefault();
    onOpen(day.date);
  });

  const hide = h("button", { class: "memory__hide", type: "button" }, "Not this one");
  const card = h("div", { class: `memory${m.first ? " memory--first" : ""}`, "data-date": day.date }, link, hide);
  if (!shownMemories.has(day.date)) {
    shownMemories.add(day.date);
    if (!prefersReducedMotion()) card.classList.add("memory--enter");
  }

  hide.addEventListener("click", () => {
    const parent = card.parentElement;
    const next = card.nextSibling;
    const gone = () => card.remove();
    if (prefersReducedMotion()) gone();
    else {
      card.classList.add("is-leaving");
      card.addEventListener("transitionend", gone, { once: true });
      setTimeout(gone, 600);
    }
    hideMemory(day.date).catch(() => undefined);
    showToast("That day won't come back as a memory.", {
      icon: "check",
      action: {
        label: "Undo",
        run: () => {
          card.classList.remove("is-leaving", "memory--enter");
          if (parent && !card.isConnected) parent.insertBefore(card, next && next.parentNode === parent ? next : null);
          showMemory(day.date).catch(() => undefined);
        },
      },
    });
  });
  return card;
}

/** Seven (or 28–31) small glyphs, one per day, Monday first. */
export function moodRow(moods: (Mood | null)[], dates: string[], opts: { labels?: boolean } = {}): HTMLElement {
  const row = h("span", { class: `mood-row${opts.labels ? " mood-row--labelled" : ""}` });
  moods.forEach((m, i) => {
    const cell = h("span", { class: "mood-row__day" }, moodGlyph(m, { label: false }));
    if (opts.labels) cell.append(h("span", { class: "mood-row__dow" }, weekdayShort(dates[i]).slice(0, 1)));
    row.append(cell);
  });
  const set = moods.filter(Boolean) as Mood[];
  row.setAttribute("role", "img");
  row.setAttribute("aria-label", set.length ? `Mood on ${set.length} of ${moods.length} days, mostly ${moodWord(Math.round(set.reduce((a, b) => a + b, 0) / set.length) as Mood)}` : "No moods set");
  return row;
}

/**
 * Between the weeks of the feed: the week that just ended, in a line. A week
 * with a kept moment (the Week in review's "Pick this week's moment") wears it
 * as its cover: a small print of the photo or cover, or the day's own line.
 * Without one it's the line alone, and complete as it is.
 */
export function weekCard(r: WeekGlance, from: string, href: string, label: string, onOpen: () => void): HTMLElement {
  const dates = Array.from({ length: r.moods.length }, (_, i) => {
    const d = new Date(`${from}T12:00:00Z`);
    d.setUTCDate(d.getUTCDate() + i);
    return d.toISOString().slice(0, 10);
  });
  const head = h("span", { class: "week-card__head" }, h("span", { class: "week-card__label" }, label), moodRow(r.moods, dates));
  const line = h("span", { class: "week-card__line" }, r.headline, h("span", { class: "week-card__go" }, " See the week"));
  const a = h("a", { class: "week-card", href }, head, line);
  a.addEventListener("click", (e) => {
    if (e.metaKey || e.ctrlKey) return;
    e.preventDefault();
    onOpen();
  });

  // The kept moment: this device's copy first, then the server's (or another device's) answer.
  const wear = (m: WeekMoment | null, text?: string) => {
    if (!m || (m.kind === "line" && !text) || (m.kind !== "line" && !m.art)) {
      a.classList.remove("week-card--kept");
      a.replaceChildren(head, line);
      return;
    }
    const cover =
      m.kind === "line"
        ? h("span", { class: "week-card__cover week-card__cover--line", "aria-hidden": "true" }, "\u201C")
        : h("span", { class: "week-card__cover", "aria-hidden": "true" }, artTile(m.art, { frame: m.kind === "photo" ? [3, 4] : undefined, photo: m.kind === "photo" ? "thumb" : undefined }));
    const quote = m.kind === "line" ? h("span", { class: "week-card__quote" }, text!) : null;
    a.classList.add("week-card--kept");
    a.replaceChildren(cover, h("span", { class: "week-card__main" }, head, ...(quote ? [quote] : []), line));
  };
  let wanted: WeekMoment | null = null;
  const show = (m: WeekMoment | null) => {
    wanted = m;
    if (m?.kind === "line") void lineOf(m.date).then((text) => wanted === m && wear(m, text ?? undefined));
    else wear(m);
  };
  show(keptMomentsNow()[from] ?? null);
  void loadWeekMoments().then((all) => {
    const m = all[from] ?? null;
    if (!sameMoment(m, wanted) && (m || wanted)) show(m);
  });
  return a;
}

/** A kept line's words, from the day itself (they're never copied into the moment). */
async function lineOf(date: string): Promise<string | null> {
  try {
    const r = await loadDays(date, date);
    return r.days.find((d) => d.date === date)?.line?.trim() || null;
  } catch {
    return null;
  }
}
