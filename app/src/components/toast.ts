import { h } from "../lib/dom";
import { icons, type IconName } from "./icons";

let stack: HTMLElement | null = null;

export function mountToastStack(): HTMLElement {
  stack = h("div", { class: "toast-stack", role: "status", "aria-live": "polite" });
  return stack;
}

export function showToast(
  message: string,
  opts: {
    icon?: IconName;
    timeoutMs?: number;
    action?: { label: string; run: () => void };
    /** The owner's own words, quoted after the message ("Kept. Tuesday has Priya and “Felt like myself again”"). Trimmed to 60 characters. */
    quote?: string;
  } = {}
): void {
  if (!stack) return;
  let gone = false;
  const leave = () => {
    if (gone) return;
    gone = true;
    toast.classList.add("is-leaving");
    toast.addEventListener("animationend", () => toast.remove(), { once: true });
    setTimeout(() => toast.remove(), 400);
  };
  const action = opts.action
    ? h("button", { class: "toast__action", type: "button" }, opts.action.label)
    : null;
  action?.addEventListener("click", () => {
    opts.action!.run();
    leave();
  });
  const quote = opts.quote?.trim() ? h("q", { class: "toast__quote" }, quoteText(opts.quote)) : null;
  const text = quote ? h("span", { class: "toast__text" }, message, " ", quote) : message;
  const toast = h("div", { class: `toast${action ? " toast--action" : ""}${quote ? " toast--quote" : ""}` }, opts.icon ? icons[opts.icon]() : null, text, action);
  stack.append(toast);
  // Undo toasts linger long enough to reach for; a quote long enough to read.
  setTimeout(leave, opts.timeoutMs ?? (action ? 6000 : quote ? 4200 : 2400));
}

/** The first 60 characters, cut at a word (lib/nudges.ts quoteOf). */
function quoteText(text: string, max = 60): string {
  const t = text.trim().replace(/\s+/g, " ");
  if (t.length <= max) return t;
  const cut = t.slice(0, max - 1);
  const at = cut.lastIndexOf(" ");
  return `${(at > max / 2 ? cut.slice(0, at) : cut).replace(/[\s,.;:!?-]+$/, "")}…`;
}
