/**
 * An added item's word from the Community catalogue, on its own page: one line mounts it on the assistant page,
 * the skill page and the flow page.
 *
 *   catalogueStatus("flow", flow.id)
 *
 * It stays empty unless the daily check (GET /api/community/updates) has something to say about that item:
 *
 * - **Update available.** A change of reach tier leads, then the version and the listing's summary. Nothing updates
 *   by itself: "See what changed" opens the preview (#/add?catalogue=<id>), where the owner's own edits stay unless
 *   they choose to replace them.
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

const NOUN: Record<ShareKind, string> = { assistant: "assistant", skill: "skill", flow: "flow" };
const LIST: Record<ShareKind, string> = { assistant: "#/team", skill: "#/settings/skills", flow: "#/flows" };

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
  const see = h("a", { class: "btn btn--primary btn--sm", href: addHash({ catalogue: c.catalogue_id }) }, "See what changed");
  return h(
    "section",
    { class: "cm-banner cm-banner--update", "aria-label": "Update available" },
    h("span", { class: "cm-banner__icon", "aria-hidden": "true" }, icons.refresh()),
    h(
      "div",
      { class: "cm-banner__body" },
      h("p", { class: "cm-banner__title" }, "Update available"),
      tier ? h("p", { class: "cm-banner__reach" }, tier) : null,
      h("p", { class: "cm-banner__text" }, `${versionWords(c.version, n.version)}. ${n.summary}`),
      h("p", { class: "cm-banner__text" }, `It won't update by itself. Any edits you made to this ${NOUN[c.kind]} stay unless you choose to replace them.`),
      h("div", { class: "cm-banner__acts" }, see)
    )
  );
}

function withdrawnBanner(c: UpdateCheck, r: Running | null, repaint: () => void): HTMLElement | null {
  const w = c.withdrawn;
  if (!w) return null;
  const noun = NOUN[c.kind];
  const state = !r ? "" : r.on ? `You switched it back on. It stays yours, but there won't be updates.` : `Athena paused it. It stays yours: switch it back on, or remove it.`;
  const acts: HTMLElement[] = [];
  if (r && !r.on) {
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
  if (r) {
    const remove = h("button", { class: "btn btn--ghost btn--sm cm-remove", type: "button" }, icons.trash(), h("span", {}, "Remove")) as HTMLButtonElement;
    remove.addEventListener("click", async () => {
      const ok = await confirmDialog({ title: `Remove this ${noun}?`, body: `It's removed from your Athena. You can't undo this.`, confirmLabel: "Remove", danger: true });
      if (!ok) return;
      remove.disabled = true;
      try {
        await r.remove();
        forgetUpdates();
        showToast(`Removed the ${noun}`, { icon: "check" });
        location.hash = LIST[c.kind];
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

/** Mount on an item's page. Empty unless the catalogue has news about this item. */
export function catalogueStatus(kind: ShareKind, id: string): HTMLElement {
  const el = h("div", { class: "cm-status" });
  void (async () => {
    const check = await updateFor(kind, id);
    if (!check) return;
    if (check.withdrawn) {
      const r = await running(kind, id).catch(() => null);
      const repaint = () => el.replaceChildren(...[withdrawnBanner(check, r, repaint)].filter((n): n is HTMLElement => !!n));
      repaint();
      return;
    }
    const b = updateBanner(check);
    if (b) el.replaceChildren(b);
  })();
  return el;
}
