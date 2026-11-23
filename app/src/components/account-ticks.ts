/**
 * One tick per connected account, for something someone else shared (lib/shared-limits.ts): the import sheet, an
 * imported assistant's page and an imported skill's page. All unticked to start; the accounts the file says it
 * needs come first. An unticked account stays closed to it: in its runs and chats, or while Ask uses the skill.
 */
import "../styles/account-ticks.css";
import { h } from "../lib/dom";
import { brandLogo } from "./brand-logo";
import type { AccountRow } from "../db/item-accounts";

export interface AccountTicksOptions {
  accounts: readonly AccountRow[];
  ticked: readonly string[];
  /** Providers the file says it needs: those rows say so. */
  needs?: readonly string[];
  /** Ids stay unique on a page with two lists. */
  idPrefix: string;
  /** What the group is called, for screen readers: "Accounts Dot can open". */
  label: string;
  /** Told after each tick, with every ticked id. Resolve false to put the tick back. */
  onChange?: (ids: string[]) => Promise<boolean> | void;
}

export function accountTicks(opts: AccountTicksOptions): { el: HTMLElement; value: () => string[] } {
  const needs = new Set(opts.needs ?? []);
  const boxes = opts.accounts.map((a, i) => {
    const id = `${opts.idPrefix}-${i}`;
    const box = h("input", { type: "checkbox", class: "acct-tick__box", id, value: a.id, checked: opts.ticked.includes(a.id) }) as HTMLInputElement;
    const meta = [a.label, needs.has(a.provider) ? "It says it needs this" : ""].filter(Boolean).join(" · ");
    const row = h(
      "label",
      { class: "acct-tick", for: id },
      box,
      brandLogo(a.provider, "sm"),
      h("span", { class: "acct-tick__text" }, h("span", { class: "acct-tick__name" }, a.name), meta ? h("span", { class: "acct-tick__meta" }, meta) : null),
    );
    return { box, row };
  });
  const value = () => boxes.filter((b) => b.box.checked).map((b) => b.box.value);
  for (const b of boxes)
    b.box.addEventListener("change", async () => {
      if (!opts.onChange) return;
      b.box.disabled = true;
      const ok = await Promise.resolve(opts.onChange(value())).catch(() => false);
      b.box.disabled = false;
      if (ok === false) b.box.checked = !b.box.checked;
    });
  const el = boxes.length
    ? h("div", { class: "acct-ticks", role: "group", "aria-label": opts.label }, ...boxes.map((b) => b.row))
    : h("p", { class: "form__hint acct-ticks__none" }, "You haven't connected any accounts. Any you connect later stay closed to it until you tick them here.");
  return { el, value };
}
