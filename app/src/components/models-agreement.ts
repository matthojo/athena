/**
 * The agreement (owner, 17 Nov 2026: ask
 * once per company, then anything goes). Shown in the picker's own sheet the
 * first time the owner picks or tries a model from a company other than
 * Anthropic: what goes to that company, money and health included, and that
 * Anthropic's handling no longer covers it. "Use Google models" or "Not now".
 */
import { h } from "../lib/dom";
import { icons } from "./icons";
import { companyOf } from "./models-words";
import type { ProviderId } from "../../../lib/model-types";

export function agreementBody(provider: ProviderId, model: string, on: { agree: () => Promise<void>; cancel: () => void }): HTMLElement {
  const co = companyOf(provider);
  // Tabbing to the button reads what it agrees to (focus mode skips the text between).
  const yes = h("button", { class: "btn btn--primary", type: "button", "aria-describedby": "ma-sum ma-who" }, `Use ${co} models`);
  const no = h("button", { class: "btn btn--soft", type: "button" }, "Not now");
  const error = h("p", { class: "mp-error", role: "alert" });
  yes.addEventListener("click", async () => {
    yes.disabled = true;
    yes.setAttribute("aria-busy", "true");
    error.textContent = "";
    try {
      await on.agree();
    } catch (e) {
      error.textContent = e instanceof Error && e.message ? `That didn't save. ${e.message}` : "That didn't save. Try again.";
      yes.disabled = false;
    } finally {
      yes.removeAttribute("aria-busy");
    }
  });
  no.addEventListener("click", on.cancel);

  const item = (icon: keyof typeof icons, text: string | HTMLElement) => h("li", { class: "ma-item" }, h("span", { class: "ma-item__icon", "aria-hidden": "true" }, icons[icon]()), typeof text === "string" ? h("span", {}, text) : text);
  const via = provider === "openrouter" ? h("p", { class: "ma-p" }, "OpenRouter passes each request on to the company that runs the model, so that company gets it too.") : null;

  return h(
    "div",
    { class: "ma" },
    // A heading, so a screen reader reads it once when focus lands here.
    h("h3", { class: "ma-lead", id: "ma-lead", tabindex: -1, "data-focus": "" }, `${model} is made by ${co}. To use it, Athena sends ${co} what each job reads.`),
    h("p", { class: "visually-hidden", id: "ma-sum" }, `${co} gets what you ask and the replies, the notes, people, records and files a job reads, money and health when a job reads them, and photos and files you add.`),
    h("h3", { class: "ma-h" }, `What goes to ${co}`),
    h(
      "ul",
      { class: "ma-list" },
      item("chat", "What you ask, and the replies"),
      item("notes", "The notes, people, records and files a job reads to answer"),
      item("wallet", h("span", {}, h("strong", {}, "Money and health"), ", when a job reads them")),
      item("image", "Photos and files you add to a conversation")
    ),
    via,
    h("h3", { class: "ma-h" }, "Who looks after it"),
    h("p", { class: "ma-p", id: "ma-who" }, `Anthropic's handling of your data doesn't cover ${co}. ${co}'s own terms do.`),
    h("p", { class: "ma-p ma-p--quiet" }, `You're asked once for ${co}. Take it back any time in Settings, under AI models, and every choice on ${co} goes back to the default.`),
    error,
    h("div", { class: "ma-actions" }, no, yes)
  );
}
