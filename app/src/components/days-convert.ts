/**
 * Moving the Life log's old day notes into Days (lib/days-convert.ts).
 *
 * Shown on the Life log's page while there are notes to move. It says what
 * will happen first (the server's dry run: how many notes, days and things,
 * and that the notes go to Archived), then moves them in batches with one
 * tap, showing how far it's got. Nothing is deleted. Safe to leave halfway:
 * the next visit picks up where it stopped.
 */
import { h } from "../lib/dom";
import { plural } from "../lib/format";
import { icons } from "./icons";
import { convertBatch, fetchConversionPlan, type ConversionPlan } from "../db/days";
import { dayHref } from "../lib/day-link";
import "../styles/days-convert.css";

const KIND_WORD: Record<string, [string, string]> = {
  watched: ["show or film", "shows and films"],
  listened: ["track", "tracks"],
  read: ["book or article", "books and articles"],
  highlight: ["highlight", "highlights"],
  played: ["game", "games"],
  chess: ["chess game", "chess games"],
  posted: ["post", "posts"],
  saved: ["saved", "saved"],
  other: ["other", "others"],
};

const n = (x: number) => x.toLocaleString("en-GB");
const month = (d: string) => new Date(`${d}T12:00:00Z`).toLocaleDateString("en-GB", { month: "long", year: "numeric", timeZone: "UTC" });

/** "March to November", "March 2025 to November 2026", or "November". */
function span(p: ConversionPlan): string {
  if (!p.first || !p.last) return "";
  const sameYear = p.first.slice(0, 4) === p.last.slice(0, 4);
  const a = sameYear ? new Date(`${p.first}T12:00:00Z`).toLocaleDateString("en-GB", { month: "long", timeZone: "UTC" }) : month(p.first);
  const b = sameYear ? new Date(`${p.last}T12:00:00Z`).toLocaleDateString("en-GB", { month: "long", timeZone: "UTC" }) : month(p.last);
  return a === b ? a : `${a} to ${b}`;
}

/** The card, or null when there's nothing to move (or it can't be asked). */
export async function daysConvertCard(opts: { sample?: boolean } = {}): Promise<HTMLElement | null> {
  if (opts.sample) return null;
  let plan: ConversionPlan;
  try {
    plan = await fetchConversionPlan();
  } catch {
    return null;
  }
  if (!plan.notes) return null;

  const total = plan.notes;
  const tile = h("span", { class: "dc-tile", "aria-hidden": "true" }, icons.calendar());
  const title = h("p", { class: "dc-title" }, "Move your Life log into Days");
  const when = span(plan);
  const sub = h(
    "p",
    { class: "dc-sub" },
    `${n(plan.days)} ${plural(plan.days, "day", "days")} of notes${when ? `, ${when},` : ""} become ${n(plan.entries)} entries you can browse by day. ` +
      "The old notes go to Archived, so nothing is lost.",
  );
  const kinds = Object.entries(plan.by_kind)
    .filter(([, c]) => (c ?? 0) > 0)
    .sort((a, b) => (b[1] ?? 0) - (a[1] ?? 0));
  const chips = h(
    "ul",
    { class: "dc-chips", "aria-label": "What's in them" },
    ...kinds.slice(0, 4).map(([k, c]) => h("li", { class: "dc-chip" }, `${n(c!)} ${plural(c!, ...(KIND_WORD[k] ?? KIND_WORD.other))}`)),
    kinds.length > 4 ? h("li", { class: "dc-chip dc-chip--more" }, `${kinds.length - 4} more`) : null,
  );
  const bar = h("span", { class: "dc-bar__fill" });
  const progress = h("div", { class: "dc-bar", role: "progressbar", "aria-label": "Moving notes", "aria-valuemin": "0", "aria-valuemax": String(total), "aria-valuenow": "0", hidden: true }, bar);
  const button = h("button", { class: "btn btn--primary btn--sm dc-btn", type: "button" }, `Move ${n(plan.days)} ${plural(plan.days, "day", "days")}`);
  const note = plan.unreadable
    ? h("p", { class: "dc-note" }, `${n(plan.unreadable)} ${plural(plan.unreadable, "note", "notes")} can't be opened here. They'll move when you do this on your live site, where the data key is.`)
    : null;
  const card = h(
    "section",
    { class: "dc", "aria-labelledby": "dc-title" },
    tile,
    h("div", { class: "dc-body" }, Object.assign(title, { id: "dc-title" }), sub, chips, progress, note, h("div", { class: "dc-actions" }, button)),
  );

  const setProgress = (done: number) => {
    progress.hidden = false;
    progress.setAttribute("aria-valuenow", String(done));
    bar.style.transform = `scaleX(${Math.min(1, done / total)})`;
  };

  async function run() {
    button.disabled = true;
    chips.hidden = true;
    let moved = 0;
    setProgress(0);
    button.textContent = `Moving 0 of ${n(total)}…`;
    try {
      // Batches of about eight seconds; stop when a batch moves nothing (only notes that won't open are left).
      for (;;) {
        const r = await convertBatch();
        moved += r.converted;
        setProgress(moved);
        button.textContent = `Moving ${n(Math.min(moved, total))} of ${n(total)}…`;
        if (!r.remaining || !r.converted) break;
      }
      card.classList.add("dc--done");
      tile.replaceChildren(icons.check());
      title.textContent = `Done: ${n(moved)} ${plural(moved, "day", "days")} moved`;
      sub.textContent = "The old notes are in Archived if you ever need them.";
      progress.hidden = true;
      const open = h("a", { class: "btn btn--sm dc-btn", href: dayHref(plan.last ?? "") }, "Open the latest day");
      button.replaceWith(open);
    } catch {
      card.classList.add("dc--stuck");
      button.disabled = false;
      button.textContent = "Try again";
      sub.textContent = `${n(moved)} of ${n(total)} moved before it stopped. Try again to move the rest.`;
    }
  }
  button.addEventListener("click", () => void run());
  return card;
}
