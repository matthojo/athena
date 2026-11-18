/**
 * Home's way into Team chat (docs/team.md "Team chat" → Waiting, at the
 * top): shown while something waits for you, with the one count, and
 * opening the chat at the oldest post that waits.
 */
import "../styles/team-assign.css";
import { h } from "../lib/dom";
import { icons } from "../components/icons";
import { getChat, onChatChange } from "../db/team-chat";
import { watchWaiting } from "./waiting";
import { thingsWait, waitingPosts, waitTitle } from "./assign-words";
import { whoTile } from "./chat-posts";

export function teamChatCard(): { el: HTMLElement; destroy: () => void } {
  const faces = h("span", { class: "home-chat__faces", "aria-hidden": "true" });
  const title = h("span", { class: "home-chat__title" });
  const sub = h("span", { class: "home-chat__sub" });
  const el = h("a", { class: "card home-chat", href: "#/team/chat", hidden: true }, faces, h("span", { class: "home-chat__text" }, title, sub), icons.chevronRight());
  let count = 0;
  let alive = true;

  async function paint() {
    el.hidden = !count;
    if (!count) return;
    title.textContent = thingsWait(count);
    const chat = await getChat().catch(() => null);
    if (!alive || !chat) return;
    const waits = waitingPosts(chat);
    el.setAttribute("href", waits[0] ? `#/team/chat/${waits[0].id}` : "#/team/chat");
    sub.textContent = waits.length ? `${waitTitle(waits[0])}${waits.length > 1 ? `, and ${waits.length - 1} more` : ""}. Open Team chat.` : "Open Team chat.";
    faces.replaceChildren(...waits.slice(0, 3).map((p) => whoTile(p.who, 32)));
  }

  const offCount = watchWaiting((p) => {
    count = p.waiting;
    void paint();
  });
  const offChat = onChatChange(() => void paint());
  return {
    el,
    destroy() {
      alive = false;
      offCount();
      offChat();
    },
  };
}
