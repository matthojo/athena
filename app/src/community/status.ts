/**
 * An added item's word from the Community catalogue, on its own page: one line mounts it on the assistant page,
 * the skill page and the flow page.
 *
 *   catalogueStatus("flow", flow.id)
 *
 * It stays empty unless the daily check (GET /api/community/updates) has something to say about that item:
 *
 * - **Update available.** A change of reach tier leads, then the version and the listing's summary. Nothing updates
 *   by itself: "Look at the new version" opens the preview (#/add?catalogue=<id>), where Update replaces this one's
 *   content and keeps its name and history.
 * - **On the lists.** `updateDot(kind, id)` beside an item's name on the Team, Flows and Skills lists: a small dot
 *   when there's an update, named "Update available" for a screen reader.
 * - **Taken down.** The catalogue's reason, in its words. The server paused the item once when it was withdrawn;
 *   the owner can switch it back on or remove it. It stays theirs either way.
 */
import "../styles/community.css";
import { h } from "../lib/dom";
import { icons } from "../components/icons";
import { showToast } from "../components/toast";
import { confirmDialog } from "../components/confirm";
import { addHash, forgetUpdates, updateFor, type UpdateCheck } from "../db/community";
import type { ShareKind } from "../../../lib/share-kinds";
import type { Reach } from "../../../lib/reach";
import { tierPhrase, versionWords } from "./words";

const NOUN: Record<ShareKind, string> = { assistant: "assistant", skill: "skill", flow: "flow", checkin: "set of questions", template: "template" };
const LIST: Record<ShareKind, string> = { assistant: "#/team", skill: "#/settings/skills", flow: "#/flows", checkin: "#/settings/checkins", template: "#/notes" };

/** What a tier reaches, when only the tier is known (the item here). */
const TIER_HERE: Record<Reach["tier"], string> = { 1: "stays in Athena", 2: "uses AI or a lookup outside Athena", 3: "searches the web" };

/** "The new version reaches further: it searches the web. This one uses AI or a lookup outside Athena." Null when the tier is the same. Pure. */
export function tierChangeWords(here: Reach["tier"] | null | undefined, next: Reach): string | null {
  if (!here || here === next.tier) return null;
  const way = next.tier > here ? "reaches further" : "reaches less";
  return `The new version ${way}: it ${tierPhrase(next)}. This one ${TIER_HERE[here]}.`;
}

interface Running {
  on: boolean;
  setOn(): Promise<void>;
  remove(): Promise<void>;
}

/** The item as it is now, and how to switch it on or remove it. Loaded only for a withdrawn item. */
async function running(kind: ShareKind, id: string): Promise<Running | null> {
  if (kind === "template") {
    // A template never runs, so there's nothing to switch back on: only Remove (archived, like any template).
    const m = await import("../db/documents");
    const t = (await m.loadTemplates()).find((x) => x.id === id);
    return t ? { on: true, setOn: async () => undefined, remove: () => m.archiveTemplate(id) } : null;
  }
  if (kind === "checkin") {
    const m = await import("../db/checkins");
    const set = (await m.loadCheckinSettings()).sets.find((x) => x.id === id);
    return set ? { on: !set.paused, setOn: async () => void (await m.setCheckinSetPaused(id, false)), remove: async () => void (await m.removeCheckinSet(id)) } : null;
  }
  if (kind === "flow") {
    const m = await import("../db/flows");
    const got = await m.getFlow(id);
    return got ? { on: !got.flow.paused, setOn: async () => void (await m.updateFlow(id, { paused: false })), remove: () => m.deleteFlow(id) } : null;
  }
  if (kind === "assistant") {
    const m = await import("../db/team");
    const a = await m.getAssistant(id);
    return a ? { on: !a.paused, setOn: async () => void (await m.updateAssistant(id, { paused: false })), remove: () => m.deleteAssistant(id) } : null;
  }
  const m = await import("../db/skills");
  const s = await m.fetchSkill(id);
  return s ? { on: s.enabled, setOn: async () => void (await m.setSkillEnabled(id, true)), remove: () => m.deleteSkill(id) } : null;
}

function updateBanner(c: UpdateCheck): HTMLElement | null {
  const n = c.newer;
  if (!n) return null;
  const tier = tierChangeWords(c.tier_here, n.reach);
  const see = h("a", { class: "btn btn--primary btn--sm", href: addHash({ catalogue: c.catalogue_id }) }, "Look at the new version");
  return h(
    "section",
    { class: "cm-banner cm-banner--update", "aria-label": UPDATE_WORDS },
    h("span", { class: "cm-banner__icon", "aria-hidden": "true" }, icons.refresh()),
    h(
      "div",
      { class: "cm-banner__body" },
      h("p", { class: "cm-banner__title" }, UPDATE_WORDS),
      tier ? h("p", { class: "cm-banner__reach" }, tier) : null,
      h("p", { class: "cm-banner__text" }, `${versionWords(c.version, n.version)}. ${n.summary}`),
      h("p", { class: "cm-banner__text" }, `It won't update by itself. Updating keeps this ${NOUN[c.kind]}'s name and history, and replaces the rest with the new version.`),
      h("div", { class: "cm-banner__acts" }, see)
    )
  );
}

function withdrawnBanner(c: UpdateCheck, r: Running | null, repaint: () => void, ownActions = true): HTMLElement | null {
  const w = c.withdrawn;
  if (!w) return null;
  const noun = NOUN[c.kind];
  const paused = c.kind === "checkin" ? "Athena switched it off, so its questions aren't asked for now. They stay yours: switch the set back on, or remove it." : "Athena paused it. It stays yours: switch it back on, or remove it.";
  // A template does nothing by itself, so nothing was switched off.
  const state = !r ? "" : c.kind === "template" ? "A template does nothing by itself, so Athena left it as it is. It's still yours to use, or to remove. There won't be updates." : r.on ? `You switched it back on. It stays yours, but there won't be updates.` : paused;
  const acts: HTMLElement[] = [];
  if (r && !r.on && ownActions) {
    const on = h("button", { class: "btn btn--soft btn--sm", type: "button" }, "Switch it back on") as HTMLButtonElement;
    on.addEventListener("click", async () => {
      on.disabled = true;
      try {
        await r.setOn();
        r.on = true;
        forgetUpdates();
        showToast(`The ${noun} is on again`, { icon: "check" });
        repaint();
      } catch {
        on.disabled = false;
        showToast("That didn't save. Check you're online", { icon: "wifiOff" });
      }
    });
    acts.push(on);
  }
  if (r && ownActions) {
    const remove = h("button", { class: "btn btn--ghost btn--sm cm-remove", type: "button" }, icons.trash(), h("span", {}, "Remove")) as HTMLButtonElement;
    remove.addEventListener("click", async () => {
      const ok = await confirmDialog({
        title: `Remove this ${noun}?`,
        body: c.kind === "checkin" ? "Its questions come out of your check-ins. Answers you've already given stay on their days." : c.kind === "template" ? "It comes out of your templates. Notes and journal pages you started from it stay as they are." : `It's removed from your Athena. You can't undo this.`,
        confirmLabel: "Remove",
        danger: true,
      });
      if (!ok) return;
      remove.disabled = true;
      try {
        await r.remove();
        forgetUpdates();
        showToast(`Removed the ${noun}`, { icon: "check" });
        if (location.hash !== LIST[c.kind]) location.hash = LIST[c.kind];
      } catch {
        remove.disabled = false;
        showToast("That didn't work. Check you're online", { icon: "wifiOff" });
      }
    });
    acts.push(remove);
  }
  return h(
    "section",
    { class: "cm-banner cm-banner--withdrawn", "aria-label": "Taken down from Community", role: "status" },
    h("span", { class: "cm-banner__icon", "aria-hidden": "true" }, icons.flag()),
    h(
      "div",
      { class: "cm-banner__body" },
      h("p", { class: "cm-banner__title" }, "Taken down from Community"),
      h("p", { class: "cm-banner__text" }, "The catalogue says:"),
      h("blockquote", { class: "cm-banner__quote" }, w.reason),
      state ? h("p", { class: "cm-banner__text" }, state) : null,
      acts.length ? h("div", { class: "cm-banner__acts" }, ...acts) : null
    )
  );
}

/**
 * A small dot beside an item's name on its list, shown when the catalogue has a newer version. One check serves the
 * whole list (updateFor shares it). `onFound` lets a row that names itself for a screen reader add the words.
 */
export function updateDot(kind: ShareKind, id: string, onFound?: () => void): HTMLElement {
  const dot = h("span", { class: "cm-dot", role: "img", "aria-label": UPDATE_WORDS, title: UPDATE_WORDS, hidden: true });
  void updateFor(kind, id).then((c) => {
    if (!c?.newer) return;
    dot.hidden = false;
    onFound?.();
  });
  return dot;
}

/** The dot's name, and the banner's title. */
export const UPDATE_WORDS = "Update available";

/**
 * Mount on an item's page. Empty unless the catalogue has news about this item. `actions: false` leaves out the
 * withdrawn banner's switch and Remove, where the page beside it has its own (a set in Settings → Check-ins).
 */
export function catalogueStatus(kind: ShareKind, id: string, opts: { actions?: boolean } = {}): HTMLElement {
  const el = h("div", { class: "cm-status" });
  void (async () => {
    const check = await updateFor(kind, id);
    if (!check) return;
    if (check.withdrawn) {
      const r = await running(kind, id).catch(() => null);
      const repaint = () => el.replaceChildren(...[withdrawnBanner(check, r, repaint, opts.actions !== false)].filter((n): n is HTMLElement => !!n));
      repaint();
      return;
    }
    const b = updateBanner(check);
    if (b) el.replaceChildren(b);
  })();
  return el;
}
