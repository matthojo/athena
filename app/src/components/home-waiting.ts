/**
 * Home's "Waiting for you": the one place Home says what's owed. It used to
 * be four ("4 things wait for you", "1 change waits", "7 things to review",
 * "One overdue, one due today"); now it's one card with a phrase for each
 * place something waits, each opening where it's dealt with: Team chat at
 * the oldest post that waits, the Inbox, To do. Hidden when nothing waits.
 * The words are lib/waiting-words.ts; the team's count is the same one the
 * sidebar and the Team page use (team/waiting.ts).
 */
import "../styles/home-waiting.css";
import { h } from "../lib/dom";
import { icons, type IconName } from "./icons";
import { getChat, onChatChange } from "../db/team-chat";
import { watchWaiting } from "../team/waiting";
import { waitingPosts } from "../team/assign-words";
import { waitingParts, waitingSentence, type WaitingCounts, type WaitingPart } from "../lib/waiting-words";

const ICON: Record<WaitingPart["key"], IconName> = { team: "team", inbox: "inbox", todo: "loop" };

export function homeWaiting(): { el: HTMLElement; set: (c: Pick<WaitingCounts, "inbox" | "overdue" | "dueToday">) => void; destroy: () => void } {
  const list = h("ul", { class: "home-waiting__list" });
  const el = h("section", { class: "card home-waiting", "aria-labelledby": "home-waiting-title", hidden: true }, h("h2", { class: "home-waiting__title", id: "home-waiting-title" }, "Waiting for you"), list);
  const counts: WaitingCounts = { team: 0, inbox: 0, overdue: 0, dueToday: 0 };
  let teamHref = "#/team/chat";
  let alive = true;

  function paint() {
    const parts = waitingParts(counts, teamHref);
    el.hidden = !parts.length;
    el.setAttribute("aria-label", waitingSentence(parts));
    list.replaceChildren(
      ...parts.map((p) =>
        h("li", {}, h("a", { class: "home-waiting__link", href: p.href, "data-key": p.key, "data-tone": p.tone }, h("span", { class: "home-waiting__icon", "aria-hidden": "true" }, icons[p.tone === "late" ? "clock" : ICON[p.key]]()), p.text, h("span", { class: "home-waiting__chevron", "aria-hidden": "true" }, icons.chevronRight())))
      )
    );
  }

  /** The oldest post that waits, so the link opens Team chat right at it. */
  async function findPost() {
    const chat = counts.team ? await getChat().catch(() => null) : null;
    if (!alive) return;
    const first = chat ? waitingPosts(chat)[0] : undefined;
    const href = first ? `#/team/chat/${first.id}` : "#/team/chat";
    if (href === teamHref) return;
    teamHref = href;
    paint();
  }

  const offCount = watchWaiting((p) => {
    counts.team = p.waiting;
    paint();
    void findPost();
  });
  const offChat = onChatChange(() => void findPost());
  return {
    el,
    set(c) {
      Object.assign(counts, c);
      paint();
    },
    destroy() {
      alive = false;
      offCount();
      offChat();
    },
  };
}
