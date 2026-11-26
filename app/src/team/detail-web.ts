/**
 * "Can look things up online", in an assistant's brief (detail-brief.ts),
 * beside What it can do alone. A plain switch, live like the app-wide one it
 * follows: off by default.
 *
 * - On or off: the switch, what it means, and that it follows "Let Ask
 *   search the web".
 * - Off while its job needs it (the hint from hiring, web-access.ts): one
 *   quiet line saying what it'll miss, with the switch right there.
 * - "Let Ask search the web" off: no switch, since it couldn't do anything.
 *   It says so and links to the setting.
 */
import { h } from "../lib/dom";
import { showToast } from "../components/toast";
import type { TeamAssistant, TeamAssistantInput } from "../db/team";
import { pronouns } from "./detail-words";
import { needsWeb, webOn, webPatch } from "./web-access";
import { ASK_WEB_SETTING, WEB_FOLLOWS, WEB_BLOCKED, webBlockedDetail, webChat, webDetail, webLabel, webNeededLine } from "./web-words";

export interface WebRowContext {
  get: () => TeamAssistant;
  save: (patch: TeamAssistantInput) => Promise<boolean>;
  /** The app-wide setting: null until it's read. */
  setting: () => boolean | null;
  /** Repaint the row after a change. */
  repaint: () => void;
}

export function webRow(ctx: WebRowContext): HTMLElement {
  const a = ctx.get();
  const setting = ctx.setting();
  const on = webOn(a);
  const id = "tdb-web";

  if (setting === false) {
    const open = h("a", { class: "btn btn--soft btn--sm tdb-web__open", href: ASK_WEB_SETTING.href }, "Open Settings");
    return h(
      "div",
      { class: "tdb-web is-blocked", "data-web": "blocked" },
      h("span", { class: "tdb-web__label" }, "Online"),
      h("span", { class: "tdb-web__name" }, WEB_BLOCKED),
      h("span", { class: "tdb-web__detail" }, webBlockedDetail(a.name, on)),
      h("span", { class: "tdb-web__foot" }, open)
    );
  }

  const needed = !on && needsWeb(a);
  const sw = h("input", { type: "checkbox", role: "switch", class: "switch", id, "aria-describedby": `${needed ? `${id}-need ` : ""}${id}-d ${id}-f`, checked: on, disabled: setting === null }) as HTMLInputElement;
  sw.addEventListener("change", async () => {
    const next = sw.checked;
    sw.disabled = true;
    const ok = await ctx.save(webPatch(next)).catch(() => false);
    sw.disabled = false;
    if (!ok) {
      sw.checked = !next;
      return;
    }
    const x = ctx.get();
    const own = pronouns(x.personality).their;
    showToast(next ? `${x.name} can look things up on ${own} own` : `${x.name} won't look things up on ${own} own`, { icon: "check" });
    ctx.repaint();
    requestAnimationFrame(() => document.getElementById(id)?.focus({ preventScroll: true }));
  });

  const need = needed ? h("span", { class: "tdb-web__need", id: `${id}-need` }, webNeededLine(a.name, a.job, a.personality)) : null;
  return h(
    "label",
    { class: `tdb-web${on ? " is-on" : ""}${need ? " is-needed" : ""}`, for: id, "data-web": on ? "on" : "off" },
    h("span", { class: "tdb-web__label", "aria-hidden": "true" }, "Online"),
    h("span", { class: "tdb-web__name" }, webLabel(a.personality)),
    need,
    h("span", { class: "tdb-web__detail", id: `${id}-d` }, webDetail(a.personality)),
    h("span", { class: "tdb-web__follows", id: `${id}-f` }, `${webChat(a.personality)} ${WEB_FOLLOWS}`),
    h("span", { class: "tdb-web__switch" }, sw)
  );
}
