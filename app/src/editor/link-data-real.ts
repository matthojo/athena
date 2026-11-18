/**
 * The editor's LinkData from the real data layer (app/src/db/rich-links.ts,
 * stage 2S). main.ts plugs it in once with `setLinkData(realLinkData)`. In
 * sample mode 2S answers live cards from the sample data, and previews come
 * from the editor's sample pages.
 *
 * 2S's LiveCard is mapped to the editor's union here (`toEditorCard`), so the
 * renderer stays as it is. 2S tells listeners "something changed" with no
 * kind or id, so this asks the editor to redraw every card it has asked for.
 */

import type { LinkKind } from "../../../lib/links";
import * as rich from "../db/rich-links";
import { findRecord, saveRecord } from "../db/records";
import { isSampleMode } from "../db/api";
import { samplePreviewFor, type LinkData, type LiveCard } from "./link-data";

/** One 2S card as the editor draws it. Dates stay ISO ("YYYY-MM-DD" for a day with no time). */
export function toEditorCard(c: rich.LiveCard): LiveCard {
  const base = { title: c.title, archived: c.archived, stale: c.stale };
  switch (c.kind) {
    case "person":
      return { ...base, kind: c.kind, photo: c.photo?.src ?? null, relation: c.relationship, lastCatchUp: c.lastCatchUp, birthday: c.nextBirthday?.date ?? null };
    case "place":
      return { ...base, kind: c.kind, area: c.area, lastVisit: c.lastVisit, map: c.mapUrl, openMap: c.openMapUrl };
    case "todo":
      return { ...base, kind: c.kind, due: c.due, done: c.done };
    case "watch":
      return { ...base, kind: c.kind, type: c.kindLabel, status: c.statusLabel, progress: c.progress, progressText: c.progressText, cover: c.cover?.src ?? null };
    case "saved":
      return { ...base, kind: c.kind, price: c.price, shop: c.shop, image: c.image?.src ?? null };
    case "event":
      return { ...base, kind: c.kind, startsAt: c.time ? `${c.date}T${c.time}` : c.date, where: c.place?.name ?? null };
    case "note":
      return { ...base, kind: c.kind, lines: c.firstLines.split("\n").map((l) => l.trim()).filter(Boolean), editedAt: c.updated };
    default:
      return { ...base, kind: c.kind, subtitle: c.subtitle || null };
  }
}

/** Cards the editor has asked for, so a change can redraw them. */
const asked = new Set<string>();
/** Saved's actions per item, fetched with its card so the menu can open at once. */
const moves = new Map<string, rich.SavedActions>();

function fetchMoves(id: string): void {
  void rich.savedMoves(id).then(
    (m) => void moves.set(id, m),
    () => undefined
  );
}

export const realLinkData: LinkData = {
  // Sample mode keeps the editor's own sample pages, which cover every player.
  loadPreview: (url, opts) => (isSampleMode() ? samplePreviewFor(url) : rich.loadPreview(url, opts)),
  async liveCard(kind, id) {
    asked.add(`${kind}:${id}`);
    const card = await rich.liveCard(kind, id);
    if (kind === "saved" && card) fetchMoves(id);
    return card ? toEditorCard(card) : null;
  },
  onLiveChange(fn) {
    return rich.onLiveChange(() => {
      for (const key of asked) {
        const at = key.indexOf(":");
        const kind = key.slice(0, at) as LinkKind;
        const id = key.slice(at + 1);
        if (kind === "saved") fetchMoves(id);
        fn(kind, id);
      }
    });
  },
  toggleTodo: async (id) => (await rich.toggleTodo(id)).done,
  logCatchUp: async (id) => ({ undo: (await rich.logCatchUp(id)).undo }),
  markWatched: async (id) => ({ undo: (await rich.markWatched(id)).undo }),
  // Saved's own actions that need no picker; where it's filed now is "It's here now".
  savedCollections(id) {
    const m = moves.get(id);
    if (!m) return null;
    return m.actions.filter((a) => !a.params.length).map((a) => ({ id: a.id, name: a.label, current: m.filed?.action === a.id }));
  },
  async moveSaved(id, actionId) {
    const { result } = await rich.moveSaved(id, actionId);
    return result.done;
  },
  // A reminder the day before, on the event itself.
  async remindEvent(id) {
    const e = await findRecord("event", id);
    if (!e) throw new Error("Not found");
    if (!e.remind_days_before.includes(1)) await saveRecord("event", { remind_days_before: [...e.remind_days_before, 1].sort((a, b) => b - a) }, id);
  },
};
