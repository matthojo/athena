/**
 * The budget notice in an Ask reply (owner, 17 Nov 2026): when today's AI budget is used, or the assistant being
 * chatted with has used its own cap, the reply says so (its words come from the server) and this small block under
 * it offers one tap, "Allow £1 more today", in the owner's currency. Once allowed, the same message can be sent
 * again from here. Mounted with one line where Ask builds a message (views/ask.ts).
 *
 * When the budget couldn't be checked (the database was away), the block offers Run anyway: the same message again,
 * once, without the check (db/run-anyway.ts), and Try again, which sends it as usual.
 */
import "../styles/spend.css";
import { h } from "../lib/dom";
import { icons } from "./icons";
import { showToast } from "./toast";
import { allowMore } from "../db/spend";
import { armRunAnyway, runAnywayUntil } from "../db/run-anyway";
import { money, type BudgetNotice, type UncheckedNotice } from "../../../lib/spend-types";

const isNotice = (n: unknown): n is BudgetNotice => !!n && typeof n === "object" && ((n as BudgetNotice).scope === "all" || (n as BudgetNotice).scope === "assistant") && typeof (n as BudgetNotice).limit === "number";

const isUnchecked = (n: unknown): n is UncheckedNotice => !!n && typeof n === "object" && (n as UncheckedNotice).scope === "unchecked" && typeof (n as UncheckedNotice).run_anyway === "string";

/** The parts every notice shares: the icon, title, words, actions and a polite live region. */
function frame(icon: SVGElement, title: string, sub: string): { el: HTMLElement; words: HTMLElement; actions: HTMLElement; live: HTMLElement } {
  const titleId = `spend-notice-${Math.random().toString(36).slice(2, 8)}`;
  const live = h("p", { class: "visually-hidden", role: "status", "aria-live": "polite" });
  const actions = h("div", { class: "spend-notice__actions" });
  const words = h("p", { class: "spend-notice__sub" }, sub);
  const el = h(
    "div",
    { class: "spend-notice", role: "group", "aria-labelledby": titleId },
    h("span", { class: "spend-notice__icon", "aria-hidden": "true" }, icon),
    h("div", { class: "spend-notice__body" }, h("p", { class: "spend-notice__title", id: titleId }, title), words, actions, live)
  );
  return { el, words, actions, live };
}

/**
 * Today's budget couldn't be checked: Run anyway sends this message again, once, without the check; Try again sends it
 * as usual. A token past its time (a reply reopened later) offers Try again only. Without a message to send, the words
 * say to send it again.
 */
function uncheckedNotice(n: UncheckedNotice, question: string | null, ask?: (text: string) => void, now = Date.now()): HTMLElement {
  const fresh = runAnywayUntil(n.run_anyway) > now;
  const canSend = !!question && !!ask;
  const sub = !canSend
    ? "Send your message again in a minute."
    : fresh
      ? "Run anyway answers this one message without the check. Athena adds its cost once it can read the budget again."
      : "Try again in a minute.";
  const { el, words, actions, live } = frame(icons.hourglass(), "Today's AI budget", sub);
  el.dataset.unchecked = "true";
  if (!canSend) return el;
  const sent = (said: string) => {
    el.dataset.sent = "true";
    words.textContent = said;
    actions.replaceChildren();
    live.textContent = said;
  };
  const anyway = fresh ? h("button", { class: "btn btn--primary btn--sm spend-notice__btn", type: "button" }, icons.play(), "Run anyway") : null;
  const again = h("button", { class: `btn ${fresh ? "btn--soft" : "btn--primary"} btn--sm spend-notice__btn`, type: "button" }, icons.refresh(), "Try again");
  anyway?.addEventListener("click", () => {
    armRunAnyway(n.run_anyway, question!);
    sent("Sent again without the check.");
    ask!(question!);
  });
  again.addEventListener("click", () => {
    sent("Sent again.");
    ask!(question!);
  });
  actions.append(...(anyway ? [anyway] : []), again);
  return el;
}

/** The block for a reply that carries a budget notice, or null for any other reply. */
export function spendNotice(reply: unknown, askAgain?: () => void, unchecked?: { question: string | null; ask?: (text: string) => void }): HTMLElement | null {
  const n = (reply as { budget?: unknown } | null)?.budget;
  if (isUnchecked(n)) return uncheckedNotice(n, unchecked?.question ?? null, unchecked?.ask);
  if (!isNotice(n)) return null;
  const step = money(n.step, n.currency, n.locale);
  const who = n.scope === "assistant" ? n.name ?? "This assistant" : null;
  const title = who ? `${who}'s daily cap` : "Today's AI budget";
  const sub = who ? `${who} starts again at midnight, or you can allow a little more now.` : "Athena starts again at midnight, or you can allow a little more now.";
  const titleId = `spend-notice-${Math.random().toString(36).slice(2, 8)}`;
  const live = h("p", { class: "visually-hidden", role: "status", "aria-live": "polite" });
  const actions = h("div", { class: "spend-notice__actions" });
  const more = h("button", { class: "btn btn--primary btn--sm spend-notice__btn", type: "button" }, icons.plus(), who ? `Allow ${step} more today for ${who}` : `Allow ${step} more today`);
  const see = h("a", { class: "spend-notice__link", href: "#/settings/spend" }, "See AI spend");
  actions.append(more, see);
  const words = h("p", { class: "spend-notice__sub" }, sub);
  const el = h(
    "div",
    { class: "spend-notice", role: "group", "aria-labelledby": titleId },
    h("span", { class: "spend-notice__icon", "aria-hidden": "true" }, icons.wallet()),
    h("div", { class: "spend-notice__body" }, h("p", { class: "spend-notice__title", id: titleId }, title), words, actions, live)
  );
  more.addEventListener("click", async () => {
    more.disabled = true;
    try {
      await allowMore(n.scope === "assistant" && n.assistant_id ? { assistant_id: n.assistant_id } : {});
      el.dataset.allowed = "true";
      words.textContent = `${step} more allowed for today.${askAgain ? " Send your message again when you're ready." : ""}`;
      const again = askAgain ? h("button", { class: "btn btn--primary btn--sm spend-notice__btn", type: "button" }, icons.refresh(), "Ask again") : null;
      again?.addEventListener("click", () => {
        again.disabled = true;
        askAgain!();
      });
      actions.replaceChildren(...(again ? [again] : []), see);
      live.textContent = `${step} more allowed for today.`;
      (again ?? see).focus();
    } catch (error) {
      more.disabled = false;
      showToast(error instanceof Error ? error.message : "That didn't work. Check you're online", { icon: "wifiOff" });
    }
  });
  return el;
}

/** Put the notice under a reply's bubble when its reply carries one. Nothing happens for any other message. */
export function attachSpendNotice(node: HTMLElement, m: { reply?: unknown; question?: unknown }, ask?: (text: string) => void): void {
  const question = typeof m.question === "string" && m.question.trim() ? m.question : null;
  const block = spendNotice(m.reply, question && ask ? () => ask(question) : undefined, { question, ask });
  if (!block || node.querySelector(".spend-notice")) return;
  (node.querySelector(".assist") ?? node.querySelector(".bubble")?.parentElement ?? node).append(block);
}
