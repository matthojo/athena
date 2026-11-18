/**
 * One day. On a phone, one column: the date and the day's line, mood, the
 * journal, photos, where you went, your body, what you watched, heard,
 * read, played and posted, meetings and notes, and (on today's page) On
 * this day. From 1024px, two columns: the story on the left, the context
 * (places, weather, body, meetings, On this day) in a rail on the right.
 *
 * A day with only health leads with it at a larger size; a day with
 * nothing says so and keeps mood and the journal ready. "Add to this day"
 * and "Log health" (components/day-entry-sheet.ts, health-log-sheet.ts)
 * type in what no connected app saw.
 * ← and → (or J and K) move between days.
 */

import { h } from "../lib/dom";
import { icons } from "../components/icons";
import { dayIcons, weatherIcon } from "../components/day-icons";
import { showToast } from "../components/toast";
import { artTile, photoArt } from "../components/day-art";
import { earlierCard } from "../components/day-card";
import { healthSection } from "../components/day-health";
import { moneyHomeSection } from "../components/day-money";
import { foodRow, foodSection, mindStrip } from "../components/day-food";
import { journalEditor, lineEditor } from "../components/day-journal";
import { dayMapSlot } from "../components/day-map-slot";
import { dayRibbon } from "../components/day-ribbon";
import { loadPatterns } from "../db/patterns";
import { patternSlot } from "../components/patterns-block";
import { fitsDay } from "../../../lib/patterns";
import { moodPicker } from "../components/day-mood";
import { entrySections } from "../components/day-sections";
import { addDays, capital, dayHighlight, sourceName, duration, fallbackLine, type Highlight, hasHealth, hasStory, list, longDate, plural, relativeDay, weekLabel, weekStart, type HealthFigures } from "../components/day-words";
import { prepareFile } from "../components/attachments";
import { openDayEntrySheet } from "../components/day-entry-sheet";
import { openHealthLogSheet } from "../components/health-log-sheet";
import { addVisitButton, manualVisitList } from "../components/place-visits";
import { loadManualVisits } from "../db/place-visits";
import { addDayPhoto, dayMark, loadDay, removeDayEntry, nothingNew, onDaysChange, photoUrl, reloadWhenIdle, saveDay, setEntryHidden, type Day, type DayEvent, type DayNote, type DayPhoto } from "../db/days-app";
import { loadHealthDays } from "../db/health";
import { localToday } from "../lib/time";
import { failedCard, type DaysNav, type Mounted } from "./days";
import { travelToday } from "../components/travel-today";
import { checkinDaySection } from "../components/checkin-day";
import { blank, onThisDay } from "./days-feed";

const isTyping = (t: EventTarget | null) => t instanceof HTMLElement && (t.matches("input, textarea, select") || t.isContentEditable);

export function renderDay(date: string, nav: DaysNav, opts: { write?: boolean; mood?: boolean } = {}): Mounted {
  const today = localToday();
  let dead = false;
  let flush: (() => void) | null = null;

  const prev = addDays(date, -1);
  const next = addDays(date, 1);
  const hasNext = next <= today;

  const back = h("a", { class: "icon-btn icon-btn--ghost day-top__back", href: "#/days", "aria-label": "All days" }, icons.back());
  back.addEventListener("click", (e) => {
    e.preventDefault();
    if ((history.state as { daysFrom?: string } | null)?.daysFrom) history.back();
    else nav.to(null);
  });
  const step = (to: string, dir: "next" | "prev", label: string, icon: () => SVGSVGElement, enabled: boolean) => {
    const a = enabled ? h("a", { class: "icon-btn icon-btn--ghost day-top__step", href: `#/days/${to}`, "aria-label": label }, icon()) : h("button", { class: "icon-btn icon-btn--ghost day-top__step is-disabled", type: "button", disabled: true, "aria-label": label }, icon());
    if (enabled)
      a.addEventListener("click", (e) => {
        e.preventDefault();
        go(to, dir);
      });
    return a;
  };
  const cal = h("a", { class: "icon-btn icon-btn--ghost", href: `#/days/calendar?m=${date.slice(0, 7)}`, "aria-label": "Calendar" }, dayIcons.calendarGrid());
  cal.addEventListener("click", (e) => {
    e.preventDefault();
    nav.to("calendar", `m=${date.slice(0, 7)}`);
  });
  const weekLink = h("a", { class: "day-top__week", href: `#/days/week/${weekStart(date)}` }, weekLabel(weekStart(date), today));
  weekLink.addEventListener("click", (e) => {
    e.preventDefault();
    nav.to(`week/${weekStart(date)}`);
  });
  const top = h(
    "header",
    { class: "notes__head day-top" },
    h("div", { class: "day-top__bar" }, back, weekLink, h("span", { class: "day-top__spacer" }), step(prev, "prev", "Day before", dayIcons.chevronLeft, true), step(next, "next", "Day after", dayIcons.chevronRight, hasNext), cal)
  );

  const page = h("article", { class: "day", "aria-busy": "true", "aria-labelledby": "day-title" }, loadingDay(date, today));
  // The day's travel under its date: live on the day, "Travelled" after (components/travel-today.ts). Made once, so repaints don't ask again.
  const travel = travelToday({ date, place: "day", openTrip: (id) => void import("./trips").then((m) => m.openTripSheet(id)) });
  cleanups.push(travel.destroy);
  // The day's check-in answers, read-only, under the journal (components/checkin-day.ts). Made once, so repaints don't ask again.
  const checkins = checkinDaySection(date);
  cleanups.push(checkins.destroy);
  const el = h("div", { class: "view days days--day" }, top, page);

  function go(to: string, dir: "next" | "prev") {
    flush?.();
    nav.to(to, null, { replace: true, dir });
  }

  const onKey = (e: KeyboardEvent) => {
    if (e.metaKey || e.ctrlKey || e.altKey || isTyping(e.target) || document.querySelector("dialog[open]")) return;
    if (e.key === "ArrowLeft" || e.key === "j") go(prev, "prev");
    else if ((e.key === "ArrowRight" || e.key === "k") && hasNext) go(next, "next");
  };
  window.addEventListener("keydown", onKey);

  // Swipe between days on a phone (horizontal, decisive, not inside a scroller).
  let touch: { x: number; y: number; t: number; ok: boolean } | null = null;
  page.addEventListener("touchstart", (e) => {
    const t = e.touches[0];
    const inScroller = (e.target as HTMLElement).closest(".shelf, .photos, textarea, input");
    touch = { x: t.clientX, y: t.clientY, t: Date.now(), ok: !inScroller };
  }, { passive: true });
  page.addEventListener("touchend", (e) => {
    if (!touch?.ok) return;
    const t = e.changedTouches[0];
    const dx = t.clientX - touch.x;
    const dy = t.clientY - touch.y;
    if (Date.now() - touch.t < 600 && Math.abs(dx) > 80 && Math.abs(dy) < 40) {
      if (dx > 0) go(prev, "prev");
      else if (hasNext) go(next, "next");
    }
    touch = null;
  }, { passive: true });

  async function load() {
    page.setAttribute("aria-busy", "true");
    try {
      // The day, and the two weeks before it for "than usual" and the sparklines.
      const [day, around] = await Promise.all([loadDay(date), loadHealthDays(addDays(date, -14), addDays(date, -1)).catch(() => null)]);
      if (dead) return;
      const from = addDays(date, -14);
      const before: (HealthFigures & { date: string })[] = (around?.days ?? []).filter((d) => d.date < date && d.date >= from);
      paint(day, before);
    } catch {
      if (dead) return;
      page.removeAttribute("aria-busy");
      page.classList.add("day--no-rail");
      page.replaceChildren(h("div", { class: "day__main" }, dayHero(date, today, null), failedCard("this day", () => void load())));
    }
  }

  function paint(day: Day, before: (HealthFigures & { date: string })[]) {
    page.removeAttribute("aria-busy");
    // A day's stops also come as entries (source "places"); they have their own section.
    day = { ...day, entries: day.entries.filter((e) => e.source !== "places") };
    painted = dayMark(day);
    kept = before;
    const story = hasStory(day);
    const health = hasHealth(day.health) ? day.health : null;
    const healthOnly = !story && !!health;
    const nothing = !story && !health;
    page.classList.toggle("day--health-only", healthOnly);
    page.classList.toggle("day--empty", nothing);

    const save = async (patch: Parameters<typeof saveDay>[1]) => {
      const d = await saveDay(date, patch);
      Object.assign(day, d);
    };

    // ---- the line, mood and journal ----
    const line = lineEditor({ value: day.line ?? null, fallback: fallbackLine(day), save: (l) => save({ line: l }) });
    const mood = moodPicker({
      value: day.mood ?? null,
      label: date === today ? "How's today going?" : "How was the day?",
      onChange: (m) => {
        const before = day.mood;
        mind = swapMind(mind, day.health, !!m);
        save({ mood: m }).catch(() => {
          mood.set(before ?? null);
          mind = swapMind(mind, day.health, !!before);
          showToast("Mood didn't save. Check you're online", { icon: "wifiOff" });
        });
      },
    });
    const journal = journalEditor({
      value: day.journal ?? "",
      label: "Journal",
      placeholder: date === today ? "What's on your mind today?" : "A few words about the day",
      save: (text) => save({ journal: text }),
    });
    flush = journal.flush;

    // Mindful minutes, and State of Mind on a day with no mood of the owner's (labelled "from Health").
    let mind: HTMLElement = mindStrip(day.health, !!day.mood) ?? h("span", { hidden: true });
    const hero = dayHero(date, today, day);
    hero.append(line);
    const you = h(
      "section",
      { class: "day-you", "aria-label": "Your words" },
      h("p", { class: "day-you__label", "aria-hidden": "true" }, date === today ? "How's today going?" : "How was it?"),
      mood.el,
      mind,
      journal.el
    );

    // ---- the story column ----
    const main = h("div", { class: "day__main" });
    const rail = h("div", { class: "day__rail" });
    const ribbon = dayRibbon(day);
    const top = dayHighlight(day);
    main.append(withOrder(hero, 1), withOrder(travel.el, 1), ...(top ? [withOrder(highlightCard(top), 1)] : []), withOrder(you, 2), withOrder(checkins.el, 2), ...(ribbon ? [withOrder(ribbon, 2)] : []));
    // One line when the day fits a pattern from the last 90 days.
    main.append(withOrder(patternSlot(loadPatterns(90), (ps) => fitsDay(ps, date), { label: "A pattern this day fits", className: "day-pattern" }), 2));
    main.append(withOrder(photosSection(day, date, (d) => paint(Object.assign(day, d), before)), 3));
    if (healthOnly && health) {
      main.append(withOrder(withBodyLines(healthSection(health, before, { hero: true, date }), day), 4), withOrder(quietNote(date === today), 5));
    }
    if (nothing) main.append(withOrder(emptyNote(date, today), 1));
    const hide = (ids: string[], name: string) => {
      const removed = day.entries.filter((e) => ids.includes(e.id));
      const restore = () => {
        day.entries = [...day.entries, ...removed.filter((r) => !day.entries.some((e) => e.id === r.id))];
        paint(day, before);
      };
      day.entries = day.entries.filter((e) => !ids.includes(e.id));
      paint(day, before);
      // What was added by hand is deleted, not hidden: there's nothing behind it to come back.
      if (removed.length && removed.every((e) => e.source === "manual")) {
        Promise.all(ids.map((id) => removeDayEntry(date, id))).then(
          () => showToast(`Removed ${name} from this day`, { icon: "check" }),
          () => {
            restore();
            showToast("That didn't save. Check you're online", { icon: "wifiOff" });
          }
        );
        return;
      }
      Promise.all(ids.map((id) => setEntryHidden(date, id, true))).then(
        () =>
          showToast(`Hid ${name} from this day`, {
            icon: "check",
            action: { label: "Undo", run: () => void Promise.all(ids.map((id) => setEntryHidden(date, id, false))).then(restore, () => showToast("That didn't undo. Check you're online", { icon: "wifiOff" })) },
          }),
        () => {
          restore();
          showToast("That didn't hide. Check you're online", { icon: "wifiOff" });
        }
      );
    };
    // The big, visual kinds tell the story; the small text ones (chess, posts, links) sit with the context on a wide screen.
    const sideSections: HTMLElement[] = [];
    // The highlight isn't listed again below it.
    const heroIds = new Set(top ? day.entries.filter((e) => e === top.entry || (top.entry.group && e.group === top.entry.group && e.kind === top.entry.kind)).map((e) => e.id) : []);
    for (const s of entrySections(day.entries.filter((e) => !heroIds.has(e.id)), { onHide: hide, date: day.date })) {
      if (/day-sec--(read|highlight|chess|posted|saved|other)\b/.test(s.className)) sideSections.push(withOrder(s, 7));
      else main.append(withOrder(s, 6));
    }

    // ---- the rail ----
    if (day.places.length || day.weather) rail.append(withOrder(placesSection(day, today, () => void load()), 4));
    if (health && !healthOnly) rail.append(withOrder(withBodyLines(healthSection(health, before, { date }), day), 5));
    else if (!health) {
      const food = foodSection(day.health);
      if (food) rail.append(withOrder(food, 5));
    }
    if (day.money || day.home) rail.append(withOrder(moneyHomeSection(day)!, 5));
    if (day.events.length || day.notes.length) rail.append(withOrder(linkedSection(day, nav), 7));
    if (date === today) {
      const otd = h("section", { class: "day-sec day-otd", "aria-labelledby": "day-otd-title", hidden: true }, h("div", { class: "day-sec__head" }, h("h2", { class: "day-sec__title", id: "day-otd-title" }, "On this day")));
      rail.append(withOrder(otd, 3));
      void onThisDay(today).then((ds) => {
        if (dead || !ds.length) return;
        otd.append(h("div", { class: "day-otd__list" }, ...ds.map((d) => earlierCard(d, today, (to) => nav.to(to)))));
        otd.hidden = false;
      });
    }

    rail.append(...sideSections);
    const addEntry = h("button", { class: "btn btn--soft btn--sm", type: "button" }, icons.plus(), "Add to this day");
    addEntry.addEventListener("click", () => openDayEntrySheet(date, () => void load()));
    const logHealth = h("button", { class: "btn btn--ghost btn--sm", type: "button" }, icons.heart(), "Log health");
    logHealth.addEventListener("click", () => openHealthLogSheet(() => void load(), { date }));
    // No Places section to hold it: "Add a visit" sits with the others.
    const addVisit = !day.places.length && !day.weather && date <= today ? addVisitButton(() => void load(), { date }) : null;
    main.append(withOrder(h("div", { class: "day-add" }, addEntry, logHealth, addVisit), 8));
    const foot = h("nav", { class: "day-foot", "aria-label": "Other days" }, footLink(prev, "prev", today, go), hasNext ? footLink(next, "next", today, go) : h("span"));
    page.replaceChildren(main, rail, withOrder(foot, 9));
    page.classList.toggle("day--no-rail", !rail.childElementCount);
    // On a wide screen, even out the two columns: the small text sections at the rail's foot move under the story while the rail runs longer.
    if (wide.matches) requestAnimationFrame(() => balance(main, rail));

    if (opts.write) requestAnimationFrame(() => journal.focus());
    // From the evening notification (#/days/<today>?mood): the mood picker, ready.
    else if (opts.mood) {
      opts.mood = false; // Once: not again when a photo or a hide repaints the day.
      requestAnimationFrame(() => mood.focus());
    }
  }

  // Changed somewhere else (the live channel): the day loads again, never under the caret and not for an echo of a save made here.
  let painted = "";
  let kept: (HealthFigures & { date: string })[] = [];
  const elsewhere = reloadWhenIdle(page, () => loadDay(date), (day) => {
    if (dead || !painted || nothingNew(day, painted)) return;
    // A repaint from elsewhere never takes the focus.
    const write = opts.write;
    opts.write = false;
    paint(day, kept);
    opts.write = write;
  });
  cleanups.push(onDaysChange((dates) => void ((!dates.length || dates.includes(date)) && elsewhere())));

  void load();
  return {
    el,
    destroy() {
      dead = true;
      flush?.();
      cleanups.forEach((fn) => fn());
      cleanups = [];
      window.removeEventListener("keydown", onKey);
    },
  };
}

const wide = window.matchMedia("(min-width: 1024px)");

/**
 * One-line rows at the foot of the Body block, each null when the day has
 * none. Food and drink is here; Habits, Money and Home add theirs to this list.
 */
function bodyLines(day: Day): HTMLElement[] {
  return [foodRow(day.health)].filter((x): x is HTMLElement => !!x);
}

function withBodyLines(section: HTMLElement, day: Day): HTMLElement {
  section.querySelector(".day-health__list")?.append(...bodyLines(day));
  return section;
}

/** The Mind strip again after the owner sets or clears the mood. */
function swapMind(old: HTMLElement, health: Day["health"], ownMood: boolean): HTMLElement {
  const next = mindStrip(health, ownMood) ?? h("span", { hidden: true });
  old.replaceWith(next);
  return next;
}

function balance(main: HTMLElement, rail: HTMLElement) {
  const gap = 32;
  let diff = rail.offsetHeight - main.offsetHeight;
  const movable = [...rail.children].filter((c): c is HTMLElement => c instanceof HTMLElement && /day-sec--(read|highlight|chess|posted|saved|other)\b/.test(c.className));
  const move: HTMLElement[] = [];
  for (const sec of movable.reverse()) {
    const h = sec.offsetHeight + gap;
    if (diff <= h) break;
    move.unshift(sec);
    diff -= 2 * h;
  }
  main.append(...move);
}

const withOrder = (el: HTMLElement, n: number) => {
  el.style.setProperty("--order", String(n));
  return el;
};

function dayHero(date: string, today: string, day: Day | null): HTMLElement {
  const rel = relativeDay(date, today);
  const weather = day?.weather ? h("p", { class: "day-hero__weather" }, h("span", { class: "day-hero__wicon", "aria-hidden": "true" }, weatherIcon(day.weather)), day.weather) : null;
  return h(
    "header",
    { class: "day-hero" },
    h("p", { class: "day-hero__kicker" }, rel && rel !== longDate(date, today).split(" ")[0] ? rel : date.slice(0, 4) !== today.slice(0, 4) ? date.slice(0, 4) : relativeAgo(date, today)),
    h("h1", { class: "day-hero__date", id: "day-title", tabindex: "-1" }, longDate(date, today).replace(/ \d{4}$/, "")),
    weather
  );
}

function relativeAgo(date: string, today: string): string {
  const n = Math.round((Date.parse(`${today}T12:00:00Z`) - Date.parse(`${date}T12:00:00Z`)) / 86_400_000);
  if (n < 14) return `${n} days ago`;
  if (n < 60) return `${Math.round(n / 7)} weeks ago`;
  return `${Math.round(n / 30)} months ago`;
}

function loadingDay(date: string, today: string): HTMLElement {
  return h(
    "div",
    { class: "day__main day__loading" },
    dayHero(date, today, null),
    h("span", { class: "visually-hidden" }, "Loading the day"),
    h("span", { class: "skeleton day-sk day-sk--line" }),
    h("span", { class: "skeleton day-sk day-sk--line2" }),
    h("span", { class: "skeleton day-sk day-sk--mood" }),
    h("span", { class: "skeleton day-sk day-sk--card" }),
    h("span", { class: "skeleton day-sk day-sk--shelf" })
  );
}

// ---------- The day's highlight ----------

function stars(rating: number): HTMLElement {
  const out = h("span", { class: "stars highlight__stars", role: "img", "aria-label": `Rated ${rating} out of 5` });
  for (let i = 1; i <= 5; i++) out.append(rating >= i ? icons.starSolid() : rating >= i - 0.5 ? icons.starHalf() : icons.star());
  return out;
}

function highlightCard(top: Highlight): HTMLElement {
  const e = top.entry;
  const safe = e.url && /^https:\/\//.test(e.url) ? e.url : null;
  const body = [
    artTile(e.art, { className: "highlight__art", large: true }),
    h(
      "span",
      { class: "highlight__body" },
      h("span", { class: "highlight__label" }, "Of the day"),
      h("span", { class: "highlight__title" }, top.title),
      h("span", { class: "highlight__why" }, top.why),
      e.note ? h("span", { class: "highlight__note" }, `“${e.note}”`) : null,
      e.rating ? stars(e.rating) : null,
      h("span", { class: "highlight__from" }, [e.kind === "watched" && !e.group ? e.subtitle : null, sourceName(e.source)].filter(Boolean).join(" · "))
    ),
  ];
  return safe ? h("a", { class: "highlight day-link", href: safe, target: "_blank", rel: "noopener noreferrer" }, ...body) : h("div", { class: "highlight" }, ...body);
}

// ---------- Photos ----------

function photosSection(day: Day, date: string, onAdded: (d: Day) => void): HTMLElement {
  const input = h("input", { type: "file", accept: "image/*", multiple: true, class: "visually-hidden", tabindex: "-1", "aria-hidden": "true" }) as HTMLInputElement;
  const add = h("button", { class: `photo-add${day.photos.length ? "" : " photo-add--alone"}`, type: "button" }, dayIcons.camera(), h("span", {}, day.photos.length ? "Add" : "Add a photo"));
  add.addEventListener("click", () => input.click());
  input.addEventListener("change", async () => {
    const files = [...(input.files ?? [])].slice(0, 6);
    input.value = "";
    if (!files.length) return;
    add.setAttribute("aria-busy", "true");
    add.querySelector("span")!.textContent = "Adding…";
    let latest: Day | null = null;
    for (const f of files) {
      const ready = await prepareFile(f);
      if ("error" in ready) {
        showToast(ready.error, { icon: "wifiOff" });
        continue;
      }
      try {
        latest = await addDayPhoto(date, { id: ready.meta.id, blob: ready.blob, name: ready.meta.name, thumb: ready.thumb, width: ready.meta.width ?? undefined, height: ready.meta.height ?? undefined });
      } catch {
        showToast("That photo didn't upload. Check you're online", { icon: "wifiOff" });
      }
    }
    if (latest) onAdded(latest);
    else {
      add.removeAttribute("aria-busy");
      add.querySelector("span")!.textContent = day.photos.length ? "Add" : "Add a photo";
    }
  });
  const n = day.photos.length;
  const grid = h("div", { class: `photos photos--${Math.min(n, 4)}` }, ...day.photos.map((p, i) => photoTile(p, i, day.photos)), add);
  return h("section", { class: `day-sec day-photos${n ? "" : " day-photos--none"}`, "aria-label": n ? `Photos, ${n}` : "Photos" }, grid, input);
}

function photoTile(p: DayPhoto, i: number, all: DayPhoto[]): HTMLElement {
  const b = h("button", { class: "photo", type: "button", "aria-label": `Photo ${i + 1} of ${all.length}` }, artTile(photoArt(p), { className: "photo__art", photo: p.thumb ? "thumb" : "full" }));
  b.addEventListener("click", () => openViewer(all, i));
  return b;
}

function openViewer(all: DayPhoto[], start: number) {
  let i = start;
  const img = h("img", { class: "photo-viewer__img", alt: "" }) as HTMLImageElement;
  const count = h("p", { class: "photo-viewer__count", "aria-live": "polite" });
  const close = h("button", { class: "icon-btn photo-viewer__close", type: "button", "aria-label": "Close" }, icons.close());
  const prevB = h("button", { class: "icon-btn photo-viewer__step", type: "button", "aria-label": "Previous photo" }, dayIcons.chevronLeft());
  const nextB = h("button", { class: "icon-btn photo-viewer__step", type: "button", "aria-label": "Next photo" }, dayIcons.chevronRight());
  const dialog = h("dialog", { class: "photo-viewer", "aria-label": "Photos" }, img, h("div", { class: "photo-viewer__bar" }, prevB, count, nextB), close) as HTMLDialogElement;
  const show = () => {
    const p = all[i];
    img.style.aspectRatio = p.w && p.h ? `${p.w} / ${p.h}` : "";
    img.removeAttribute("src");
    void photoUrl(p.id, false).then((u) => u && all[i] === p && (img.src = u));
    img.alt = `Photo ${i + 1} of ${all.length}`;
    count.textContent = all.length > 1 ? `${i + 1} of ${all.length}` : "";
    prevB.hidden = nextB.hidden = all.length < 2;
  };
  prevB.addEventListener("click", () => ((i = (i - 1 + all.length) % all.length), show()));
  nextB.addEventListener("click", () => ((i = (i + 1) % all.length), show()));
  close.addEventListener("click", () => dialog.close());
  dialog.addEventListener("click", (e) => e.target === dialog && dialog.close());
  dialog.addEventListener("keydown", (e) => {
    if (e.key === "ArrowLeft") prevB.click();
    if (e.key === "ArrowRight") nextB.click();
  });
  dialog.addEventListener("close", () => dialog.remove());
  document.body.append(dialog);
  show();
  dialog.showModal();
}

// ---------- Places ----------

const isHome = (name: string) => /^home$/i.test(name.trim());

/** Things to undo when the day page goes (the map's object URLs). */
let cleanups: (() => void)[] = [];
const onGone = (fn: () => void) => cleanups.push(fn);

/** Where the day went: the line, the map, the stops; the visits added by hand with a remove, and "Add a visit" (up to today). */
function placesSection(day: Day, today: string, reload: () => void): HTMLElement {
  const stops = day.places;
  const added = h("div", { class: "day-places__added" });
  if (day.date <= today)
    void loadManualVisits(day.date).then(
      (visits) => visits.length && added.replaceChildren(manualVisitList(visits, reload)),
      () => undefined
    );
  const named = stops.filter((p) => !isHome(p.name) || stops.length === 1);
  const sentence = day.places_line || (named.length ? list(named.slice(0, 4).map((p) => p.name)) + (named.length > 4 ? ` and ${named.length - 4} more` : "") : null);
  const map = dayMapSlot(day.date, stops.map((p) => p.name));
  if (map) onGone(map.destroy);
  return h(
    "section",
    { class: "day-sec day-places", "aria-labelledby": "day-places-title" },
    h("div", { class: "day-sec__head" }, h("h2", { class: "day-sec__title", id: "day-places-title" }, "Where"), sentence ? h("span", { class: "day-sec__sub" }, sentence) : null),
    map ? h("div", { class: "day-places__map" }, map.el) : null,
    stops.length
      ? h(
          "ol",
          { class: "stops", role: "list" },
          ...stops.map((p) =>
            h(
              "li",
              { class: `stop${isHome(p.name) ? " stop--home" : ""}` },
              h("span", { class: "stop__dot", "aria-hidden": "true" }),
              h("span", { class: "stop__name" }, p.name),
              p.minutes ? h("span", { class: "stop__time" }, duration(p.minutes)) : null
            )
          )
        )
      : null,
    day.weather && !stops.length ? h("p", { class: "day-places__weather" }, day.weather) : null,
    added,
    day.date <= today ? h("div", { class: "day-places__foot" }, addVisitButton(reload, { date: day.date })) : null
  );
}

// ---------- Meetings and notes ----------

/** "10:00" in this device's zone, or "All day". */
const eventTime = (e: DayEvent) => (e.starts_at ? new Date(e.starts_at).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" }) : "All day");

function linkedSection(day: Day, nav: DaysNav): HTMLElement {
  const items: HTMLElement[] = [];
  for (const e of [...day.events].sort((a, b) => (a.starts_at ?? "").localeCompare(b.starts_at ?? ""))) {
    const b = h(
      "button",
      { class: "row-line row-line--button", type: "button", "aria-label": `${e.title}, ${eventTime(e)}. Open the event` },
      h("span", { class: "row-line__time" }, eventTime(e)),
      h("span", { class: "row-line__body" }, h("span", { class: "row-line__title" }, e.title)),
      h("span", { class: "row-line__go", "aria-hidden": "true" }, icons.chevronRight())
    );
    b.addEventListener("click", () => nav.openLink("event", e.id));
    items.push(h("li", {}, b));
  }
  for (const n of day.notes) {
    const b = h(
      "button",
      { class: "row-line row-line--button", type: "button" },
      h("span", { class: "row-line__icon", "aria-hidden": "true" }, icons.note()),
      h("span", { class: "row-line__body" }, h("span", { class: "row-line__title" }, n.title), h("span", { class: "row-line__sub" }, noteKind(n))),
      h("span", { class: "row-line__go", "aria-hidden": "true" }, icons.chevronRight())
    );
    b.addEventListener("click", () => nav.openLink("note", n.id));
    items.push(h("li", {}, b));
  }
  const words = list([day.events.length ? plural(day.events.length, "event") : "", day.notes.length ? plural(day.notes.length, "note") : ""]);
  return h(
    "section",
    { class: "day-sec day-linked", "aria-labelledby": "day-linked-title" },
    h("div", { class: "day-sec__head" }, h("h2", { class: "day-sec__title", id: "day-linked-title" }, day.events.length && day.notes.length ? "Meetings and notes" : day.events.length ? "Meetings" : "Notes"), h("span", { class: "day-sec__sub" }, capital(words))),
    h("ul", { class: "rows", role: "list" }, ...items)
  );
}

const NOTE_KIND: Record<string, string> = { meeting: "Meeting note", email: "From email", capture: "Note", note: "Note" };
const noteKind = (n: DayNote) => NOTE_KIND[n.type] ?? "Note";

// ---------- Quiet and empty days ----------

function quietNote(isToday: boolean): HTMLElement {
  return h("p", { class: "day-quiet" }, isToday ? "Nothing else yet today. It fills in as your apps send things." : "A quiet day: nothing else came in from your apps.");
}

function emptyNote(date: string, today: string): HTMLElement {
  const future = date > today;
  return h(
    "div",
    { class: "day-empty day-empty--plain" },
    h("p", { class: "empty__title" }, future ? "This day hasn't happened yet" : "Nothing came in on this day"),
    h("p", { class: "empty__sub" }, future ? "Come back on the day." : "No apps sent anything for it. You can still add a mood, a few words or a photo.")
  );
}

function footLink(date: string, dir: "next" | "prev", today: string, go: (d: string, dir: "next" | "prev") => void): HTMLElement {
  const short = new Date(`${date}T12:00:00Z`).toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" });
  const a = h(
    "a",
    { class: `day-foot__link day-foot__link--${dir}`, href: `#/days/${date}`, "aria-label": `${dir === "prev" ? "Day before" : "Day after"}: ${longDate(date, today)}` },
    h("span", { class: "day-foot__dir", "aria-hidden": "true" }, dir === "prev" ? dayIcons.chevronLeft() : null, dir === "prev" ? "Day before" : "Day after", dir === "next" ? dayIcons.chevronRight() : null),
    h("span", { class: "day-foot__date", "aria-hidden": "true" }, short)
  );
  a.addEventListener("click", (e) => {
    e.preventDefault();
    go(date, dir);
  });
  return a;
}

