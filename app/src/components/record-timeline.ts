/**
 * The story section on a record page: "Together" on a person, "Visits" on a
 * place (lib/record-story.ts builds the rows). Drawn with Week in review's
 * Seen rows (the wr- styles: a person's card, a place's row) so the two
 * pages feel like one thing. The newest five show, then "Show all".
 *
 * The rows fade in once, in order, 40ms apart; repaints after that (a new
 * catch-up, a note saved) just swap them. With reduced motion they appear.
 *
 * Also the two reads both pages share: calendar events with someone at a
 * place (GET /api/week-review's seen, the last six weeks, kept for offline)
 * and, in sample mode, the catch-ups and events sample-week.ts adds.
 *
 * Built only with h() and text nodes: titles and summaries can come from agents.
 */

import { h } from "../lib/dom";
import { icons, type IconName } from "./icons";
import { isSampleMode, request } from "../db/api";
import { getMeta, setMeta } from "../db/idb";
import { addDays } from "../../../lib/dates";
import { CHANNEL_META } from "../lib/memory-meta";
import { storyWhen, type StoryInteraction, type StoryRow, type StorySeen } from "../lib/record-story";
import "../styles/week-review.css";
import "../styles/record.css";

export const STORY_SHOWN = 5;

const ico = (icon: IconName) => {
  const el = icons[icon]();
  el.classList.add("wr-ico");
  return el;
};

function rowIcon(r: StoryRow): IconName {
  if (r.kind === "visit") return "pin";
  if (r.kind === "event") return "calendar";
  return CHANNEL_META[r.kind].icon;
}

export interface StoryTimeline {
  el: HTMLElement;
  /** Paint these rows (newest first). The first paint with rows fades them in. */
  set: (rows: StoryRow[], today: string) => void;
}

/**
 * A titled section ("Together", "Visits") with the rows, or a quiet line when
 * there are none. `openEvent` makes a row with a calendar event behind it a
 * button that opens it.
 */
export function storyTimeline(opts: { title: string; shape: "person" | "place"; empty: string; openEvent?: (id: string) => void }): StoryTimeline {
  const count = h("span", { class: "record-h__meta" });
  const body = h("div", { class: "story__body" });
  const el = h("section", { class: `profile__section story story--${opts.shape}`, hidden: true }, h("h2", { class: "group__label record-h" }, opts.title, count), body);
  let entered = false;
  let all = false;

  function row(r: StoryRow, today: string, i: number): HTMLElement {
    const when = storyWhen(r.date, today);
    const open = r.event && opts.openEvent ? r.event : null;
    let inner: HTMLElement;
    if (opts.shape === "person") {
      inner = h(
        open ? "button" : "div",
        { class: `wr-person story__card${r.inPerson ? " is-in-person" : ""}`, ...(open ? { type: "button" } : {}) },
        h("span", { class: "wr-person__avatar", "aria-hidden": "true" }, ico(rowIcon(r))),
        h(
          "span",
          { class: "wr-person__body" },
          h("span", { class: "wr-person__head" }, h("span", { class: "wr-person__name" }, r.title), h("span", { class: "wr-person__when" }, when)),
          r.summary ? h("span", { class: "wr-person__summary" }, r.summary) : null,
          r.where ? h("span", { class: "wr-person__where" }, ico("pin"), r.where) : null
        )
      );
    } else {
      inner = h(
        open ? "button" : "div",
        { class: "wr-place story__line", ...(open ? { type: "button" } : {}) },
        h("span", { class: "wr-place__icon" }, ico(rowIcon(r))),
        h("span", { class: "wr-place__body" }, h("span", { class: "wr-place__name" }, r.title), h("span", { class: "wr-place__meta" }, [when, r.length].filter(Boolean).join(" · ")))
      );
    }
    if (open) inner.addEventListener("click", () => opts.openEvent!(open));
    const li = h("li", { class: "story__row" }, inner);
    li.style.setProperty("--i", String(i));
    return li;
  }

  function set(rows: StoryRow[], today: string) {
    el.hidden = false;
    count.textContent = rows.length > 1 ? String(rows.length) : "";
    if (!rows.length) {
      body.replaceChildren(h("p", { class: "note__links-empty" }, opts.empty));
      return;
    }
    const shown = all ? rows : rows.slice(0, STORY_SHOWN);
    const list = h("ul", { class: `${opts.shape === "person" ? "wr-people" : "wr-places"} story__list`, role: "list" }, ...shown.map((r, i) => row(r, today, i)));
    if (!entered) {
      // Once: the rows arrive in order. Later repaints don't replay it.
      entered = true;
      list.classList.add("story__list--enter");
    }
    const parts: HTMLElement[] = [list];
    if (rows.length > shown.length) {
      const more = h("button", { class: "wr-more wr-more--link story__more", type: "button" }, `Show all ${rows.length}`, ico("chevronDown"));
      more.addEventListener("click", () => {
        all = true;
        set(rows, today);
        const added = body.querySelectorAll<HTMLElement>(".story__row");
        // The ones just shown fade in after the five already there.
        added.forEach((li, i) => {
          if (i < STORY_SHOWN) return;
          li.style.setProperty("--i", String(i - STORY_SHOWN));
          li.classList.add("story__row--enter");
        });
      });
      parts.push(more);
    }
    body.replaceChildren(...parts);
  }

  return { el, set };
}

// ---------- shared reads ----------

const tz = () => Intl.DateTimeFormat().resolvedOptions().timeZone;

/**
 * Calendar events with someone at a place over the last six weeks (the most
 * GET /api/week-review covers in one go), kept on this device for offline.
 * Empty in sample mode, which has its own (sampleStory).
 */
export async function recentSeen(today: string): Promise<StorySeen[]> {
  if (isSampleMode()) return [];
  const from = addDays(today, -42);
  try {
    const { seen } = await request<{ seen: StorySeen[] }>(`/week-review?${new URLSearchParams({ from, to: today, tz: tz() })}`);
    void setMeta("record:seen", JSON.stringify(seen)).catch(() => undefined);
    return seen;
  } catch {
    try {
      const kept = await getMeta("record:seen");
      return kept ? (JSON.parse(kept) as StorySeen[]) : [];
    } catch {
      return [];
    }
  }
}

/**
 * Sample mode's extra catch-ups and calendar events (sample-week.ts): a week
 * and the four before it, as Week in review shows them. The week is the
 * seven days to today rather than the calendar week, so early in a week the
 * lunch and the gallery still land on days that have been.
 */
export async function sampleStory(today: string): Promise<{ interactions: StoryInteraction[]; seen: StorySeen[] }> {
  if (!isSampleMode()) return { interactions: [], seen: [] };
  const [{ sampleWeekExtras }, { loadDay }] = await Promise.all([import("../db/sample-week"), import("../db/days-app")]);
  const start = addDays(today, -6);
  const week = await Promise.all(Array.from({ length: 7 }, (_, i) => loadDay(addDays(start, i)).catch(() => null)));
  const w = sampleWeekExtras("week", start, today, today, week.filter((d): d is NonNullable<typeof d> => !!d));
  const m = sampleWeekExtras("month", addDays(today, -34), addDays(today, -7), today, []);
  return { interactions: [...w.interactions, ...m.interactions], seen: [...w.seenEvents, ...m.seenEvents] };
}
