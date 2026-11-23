/**
 * Home's one-time notice after the update that limits imported skills (lib/shared-limits.ts): skills someone else
 * shared now open only the connected accounts ticked for them, and none is ticked to start. It names each imported
 * skill that had none ticked, each a link to its page. "Got it" ends it for good; a skill whose accounts are ticked
 * drops off the list, and the notice goes when none is left.
 */
import "../styles/accounts-notice.css";
import { h } from "../lib/dom";
import { icons } from "./icons";
import { showToast } from "./toast";
import { accountsNotice, dismissAccountsNotice, type NoticeSkill } from "../db/item-accounts";
import { onSkillsChange, sampleSkillList } from "../db/skills";

/** Sample mode's: its imported skill, while nothing is ticked for it. */
const sampleNotice = (): NoticeSkill[] => sampleSkillList().filter((s) => s.imported && !s.assistant_id && !(s.accounts ?? []).length).map((s) => ({ id: s.id, name: s.name, title: s.title }));

export function accountsNoticeCard(): { el: HTMLElement; destroy: () => void } {
  const el = h("article", { class: "card briefing profile-card acct-notice", hidden: true, "aria-labelledby": "acct-notice-title" });
  let dead = false;

  async function paint() {
    let skills: NoticeSkill[];
    try {
      skills = await accountsNotice(sampleNotice);
    } catch {
      return;
    }
    if (dead) return;
    el.hidden = !skills.length;
    if (!skills.length) return;
    const done = h("button", { class: "btn btn--soft btn--sm", type: "button" }, "Got it");
    done.addEventListener("click", async () => {
      el.hidden = true;
      try {
        await dismissAccountsNotice();
      } catch (error) {
        el.hidden = false;
        showToast(error instanceof Error ? error.message : "Couldn't save that", { icon: "wifiOff" });
      }
    });
    const one = skills.length === 1;
    el.replaceChildren(
      h("span", { class: "tile" }, icons.shield()),
      h(
        "span",
        { class: "briefing__text" },
        h("span", { class: "briefing__title", id: "acct-notice-title" }, one ? `${skills[0].title} can't open your accounts` : `${skills.length} imported skills can't open your accounts`),
        h("span", { class: "briefing__snippet profile-card__snippet" }, `Skills someone else shared now open only the accounts you tick for them. ${one ? "This one has" : "These have"} none ticked yet.`),
        h("ul", { class: "acct-notice__list" }, ...skills.map((s) => h("li", {}, h("a", { href: `#/settings/skills/${s.id}`, class: "acct-notice__link" }, icons.book(), h("span", {}, `Choose accounts for ${s.title}`), icons.chevronRight())))),
        h("span", { class: "profile-card__actions" }, done)
      )
    );
  }

  void paint();
  const off = onSkillsChange(() => void paint());
  return {
    el,
    destroy: () => {
      dead = true;
      off();
    },
  };
}
