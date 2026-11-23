/**
 * "Accounts <Name> can open", on an imported assistant's page (lib/shared-limits.ts): someone else shared it, so it
 * opens only the connected accounts ticked here, in its runs and chats. One tick per account, saved as it's
 * ticked. Shown only for an imported assistant.
 */
import { h } from "../lib/dom";
import { showToast } from "../components/toast";
import { accountTicks } from "../components/account-ticks";
import { itemAccounts, type AccountRow } from "../db/item-accounts";
import type { TeamAssistant, TeamAssistantInput } from "../db/team";
import { pronouns } from "./detail-words";

export function accountsSection(ctx: { get: () => TeamAssistant; save: (patch: TeamAssistantInput) => Promise<boolean>; alive: () => boolean }): { el: HTMLElement; paint: () => void } {
  const title = h("h2", { class: "td-sec__title", id: "tda-title" });
  const lede = h("p", { class: "tdmo-lede", id: "tda-lede" });
  const rows = h("div", {});
  const el = h("section", { class: "td-sec tda", "aria-labelledby": "tda-title", "aria-describedby": "tda-lede", hidden: true }, h("header", { class: "td-sec__head" }, title), lede, rows);
  let accounts: AccountRow[] | null = null;
  let loading = false;

  function paint() {
    const a = ctx.get();
    el.hidden = !a.imported;
    if (!a.imported) return;
    const p = pronouns(a.personality);
    title.textContent = `Accounts ${a.name} can open`;
    lede.textContent = `Someone else shared ${a.name}, so ${p.they} ${p.plural ? "open" : "opens"} only the accounts you tick, in ${p.their} runs and in chat.`;
    if (!accounts) {
      if (!loading) {
        loading = true;
        void itemAccounts().then(
          (list) => {
            accounts = list;
            if (ctx.alive()) paint();
          },
          () => {
            loading = false;
            if (ctx.alive()) rows.replaceChildren(h("p", { class: "form__hint" }, "Your accounts didn't load. Check you're online and try again."));
          }
        );
      }
      return;
    }
    const ticks = accountTicks({
      accounts,
      ticked: a.accounts ?? [],
      idPrefix: "tda",
      label: title.textContent,
      onChange: async (ids) => {
        const ok = await ctx.save({ accounts: ids });
        if (ok) showToast(ids.length ? `${a.name} can open ${ids.length === 1 ? "1 account" : `${ids.length} accounts`}` : `${a.name} opens no accounts`, { icon: "check" });
        return ok;
      },
    });
    rows.replaceChildren(ticks.el);
  }
  return { el, paint };
}
