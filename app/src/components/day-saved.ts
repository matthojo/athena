/**
 * A day's "Saved" section: what you saved in Athena that day (links, images,
 * quotes, snippets, notes), compact, then links your apps saved (Pocket,
 * Raindrop…) as before. Athena's come from GET /api/saved?day= after the day
 * paints; the section hides when the day has neither.
 */

import { h } from "../lib/dom";
import { icons, type IconName } from "./icons";
import { loadSaved, onSavedChange, type SavedItem } from "../db/saved";
import { savedPicture } from "../views/saved";
import { plural } from "../lib/format";
import "../styles/saved.css";
import { clockTime } from "../lib/clock";

const ICON: Record<SavedItem["kind"], IconName> = { link: "link", image: "image", quote: "quote", snippet: "code", note: "note" };
const SHOWN = 4;

function row(item: SavedItem): HTMLElement {
  const title =
    item.kind === "quote" ? `“${(item.quote ?? "").replace(/^[“"]|[”"]$/g, "")}”` : item.kind === "image" ? item.note ?? item.title ?? "Image" : item.kind === "link" ? item.title ?? item.url ?? "Link" : item.quote ?? item.note ?? "";
  const sub = [item.kind === "quote" ? item.author : null, item.site, item.kind === "image" || item.kind === "snippet" ? item.kind === "image" ? "Image" : "Snippet" : null, clockTime(item.saved_at)].filter(Boolean).join(" · ");
  const pic = item.image_url ? savedPicture(item, "sm", { minRatio: 1, maxRatio: 1 }) : null;
  const b = h(
    "a",
    { class: `day-saved__item day-saved__item--${item.kind}`, href: `#/saved/${encodeURIComponent(item.id)}` },
    h("span", { class: "day-saved__thumb", "aria-hidden": "true" }, pic ?? icons[ICON[item.kind]]()),
    h("span", { class: "day-saved__body" }, h("span", { class: "day-saved__title" }, title), h("span", { class: "day-saved__sub" }, sub))
  );
  return b;
}

/** Athena's saved items for `date`, above `others` (the apps' saved links, already drawn). */
export function savedDaySection(others: HTMLElement | null, date?: string): HTMLElement {
  const sub = h("span", { class: "day-sec__sub" });
  const mine = h("div", { class: "day-saved" });
  const sec = h(
    "section",
    { class: "day-sec day-sec--saved", "aria-labelledby": "day-sec-saved-athena" },
    h("div", { class: "day-sec__head" }, h("h2", { class: "day-sec__title", id: "day-sec-saved-athena" }, "Saved"), sub),
    mine,
    others
  );
  const otherCount = others ? others.querySelectorAll("li").length : 0;
  const paint = (items: SavedItem[]) => {
    const all = items.length + otherCount;
    sec.hidden = all === 0;
    sub.textContent = all ? `${all} ${plural(all, "thing", "things")} kept` : "";
    const rows = items.slice(0, SHOWN).map(row);
    if (items.length > SHOWN) rows.push(h("a", { class: "btn btn--ghost btn--sm day-saved__more", href: "#/saved" }, `${items.length - SHOWN} more in Saved`));
    mine.replaceChildren(...rows);
    mine.hidden = !items.length;
  };
  paint([]);
  if (date) {
    const load = () =>
      loadSaved({ day: date, limit: 40 }).then(
        (p) => paint([...p.items].reverse()),
        () => undefined
      );
    void load();
    const off = onSavedChange(() => (sec.isConnected ? void load() : off()));
  }
  return sec;
}
