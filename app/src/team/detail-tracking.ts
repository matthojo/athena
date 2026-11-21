/**
 * What an assistant tracks, on its page (team-detail.ts): each tracker it
 * checks, on a saved item or on its own, as a row that opens where it
 * lives, with a glance at where it stands ("£34 · Copperkettle", "In stock ·
 * since Tuesday"). Hidden when it tracks nothing.
 */
import { h } from "../lib/dom";
import { listTrackers, onTrackersChange, type TrackerView } from "../db/trackers";
import { trackerHref, trackerRow } from "../components/tracking";
import type { TeamAssistant } from "../db/team";

const SHOWN = 5;

export function trackingSection(get: () => TeamAssistant | null, alive: () => boolean): { el: HTMLElement; paint: () => void; destroy: () => void } {
  const title = h("h2", { class: "td-sec__title", id: "tdt-title" });
  const box = h("div", { class: "tdt" });
  const el = h("section", { class: "td-sec", "aria-labelledby": "tdt-title", hidden: true }, h("header", { class: "td-sec__head" }, title), box);
  let all = false;

  async function paint() {
    const a = get();
    if (!a) return;
    const mine = (await listTrackers().catch(() => [] as TrackerView[])).filter((t) => t.assistant_id === a.id);
    if (!alive()) return;
    el.hidden = !mine.length;
    if (!mine.length) return;
    title.textContent = `What ${a.name} tracks`;
    // The newest check first: what it looked at last is what you'd ask about.
    const last = (t: TrackerView) => t.points[t.points.length - 1]?.checked_at ?? t.created_at;
    const sorted = [...mine].sort((x, y) => last(y).localeCompare(last(x)));
    const rows = (all ? sorted : sorted.slice(0, SHOWN)).map((t) => trackerRow(t, () => (location.hash = trackerHref(t))));
    const more = sorted.length > SHOWN && !all ? h("button", { class: "tk-toggle tdt-more", type: "button" }, `All ${sorted.length}`) : null;
    more?.addEventListener("click", () => {
      all = true;
      void paint();
    });
    box.replaceChildren(h("div", { class: "tdt-list" }, ...rows), ...(more ? [more] : []));
  }

  const off = onTrackersChange(() => void paint());
  return { el, paint: () => void paint(), destroy: off };
}
