/**
 * "Ignore emails like this", from an Inbox card that came from an email: pick
 * what to skip (the sender, everyone at their organisation, or a phrase in the
 * subject, which can be edited), and Athena adds it to that account's email
 * rules (lib/suggestion-ignore.ts) so the next sync never reads mail like it.
 * What the rule catches leaves the Inbox too. Resolves with the outcome, or
 * null when the owner cancels.
 */
import { h } from "../lib/dom";
import { icons } from "./icons";
import { openSheet } from "./sheet";
import { input } from "./fields";
import { ignoreLikeSuggestion, type IgnoreOutcome, type IgnoreRule } from "../db/memory";
import { ignoreChoices } from "../../../lib/suggestion-similar";
import { readSender, readSubject, senderAddress } from "../../../lib/mail-rules";
import type { Suggestion } from "../types";

/** "Larkspur Home <orders@larkspur.example>" → "Larkspur Home"; a bare address stays as it is. */
export function senderName(from: string): string {
  const name = from.replace(/<[^>]*>/, "").replace(/^["'\s]+|["'\s]+$/g, "").trim();
  return name || senderAddress(from);
}

export function openIgnoreSheet(s: Suggestion, similar: number): Promise<IgnoreOutcome | null> {
  return new Promise((resolve) => {
    let outcome: IgnoreOutcome | null = null;
    const choices = ignoreChoices(s.email);
    const body = h("div", { class: "move-sheet ignore-sheet" });
    const sheet = openSheet({ label: "Ignore emails like this", title: "Ignore emails like this", body, onClose: () => resolve(outcome) });

    type Option = { id: string; label: string; detail?: string; rule: () => IgnoreRule | null; field?: HTMLInputElement };
    const options: Option[] = [];
    if (choices.sender) options.push({ id: "sender", label: `From ${choices.sender}`, detail: s.email ? senderName(s.email.from) : undefined, rule: () => ({ kind: "sender", value: choices.sender! }) });
    if (choices.domain) options.push({ id: "domain", label: `From anyone at ${choices.domain}`, detail: "Every address there, and its subdomains", rule: () => ({ kind: "sender", value: choices.domain! }) });
    // No email recorded (a find from before Athena kept it): the owner types who it was from.
    if (!choices.sender) {
      const from = input("text", "", { placeholder: "name@shop.example or shop.example", "aria-label": "Sender to skip", autocomplete: "off", inputmode: "email" });
      options.push({ id: "typed-sender", label: "From", field: from, rule: () => (readSender(from.value) ? { kind: "sender", value: readSender(from.value)! } : null) });
    }
    const phrase = input("text", choices.subject ?? "", { maxlength: 100, placeholder: "A phrase in the subject", "aria-label": "Subject phrase to skip", autocomplete: "off" });
    options.push({ id: "subject", label: "With this in the subject", field: phrase, rule: () => (readSubject(phrase.value) ? { kind: "subject", value: readSubject(phrase.value)! } : null) });

    let picked = options[0].id;
    const rows = options.map((o) => {
      const radio = h("input", { class: "ignore-choice__input", type: "radio", name: "ignore-choice", value: o.id }) as HTMLInputElement;
      radio.checked = o.id === picked;
      radio.addEventListener("change", () => {
        if (!radio.checked) return;
        picked = o.id;
        o.field?.focus();
      });
      o.field?.addEventListener("focus", () => {
        radio.checked = true;
        picked = o.id;
      });
      return h(
        "label",
        { class: "ignore-choice" },
        radio,
        h("span", { class: "ignore-choice__text" }, h("span", { class: "ignore-choice__label" }, o.label), o.detail ? h("span", { class: "ignore-choice__detail" }, o.detail) : null),
        o.field ? h("span", { class: "ignore-choice__field" }, o.field) : null
      );
    });

    const email = s.email ? h("p", { class: "ignore-sheet__email" }, icons.mail(), h("span", {}, s.email.subject || "(no subject)", h("span", { class: "ignore-sheet__from" }, ` · ${senderName(s.email.from)}`))) : null;
    const error = h("p", { class: "move-sheet__error", role: "alert", hidden: true });
    const cancel = h("button", { class: "btn btn--soft", type: "button" }, "Cancel");
    const go = h("button", { class: "btn btn--primary", type: "button" }, "Ignore") as HTMLButtonElement;
    body.replaceChildren(
      ...([
        h("p", { class: "move-sheet__ask", id: "ignore-ask" }, "Skip emails like this from now on?"),
        h(
          "p",
          { class: "move-sheet__sub" },
          `Athena stops reading them on this email account, and ${similar ? `this and ${similar} like it leave` : "this leaves"} your Inbox. Change it any time in Settings, under the account's email rules.`
        ),
        email,
        h("div", { class: "ignore-sheet__choices", role: "radiogroup", "aria-labelledby": "ignore-ask" }, ...rows),
        error,
        h("div", { class: "move-sheet__actions" }, cancel, go),
      ] as Array<HTMLElement | null>).filter((x): x is HTMLElement => !!x)
    );
    body.setAttribute("aria-labelledby", "ignore-ask");
    cancel.addEventListener("click", () => sheet.close());
    go.addEventListener("click", async () => {
      const o = options.find((x) => x.id === picked)!;
      const rule = o.rule();
      if (!rule) {
        error.textContent = o.id === "subject" ? "Give it a phrase of at least two characters." : "That isn't an email address or a domain.";
        error.hidden = false;
        o.field?.focus();
        return;
      }
      go.disabled = true;
      cancel.setAttribute("disabled", "");
      go.textContent = "Saving…";
      error.hidden = true;
      try {
        outcome = await ignoreLikeSuggestion(s, rule);
        sheet.close();
      } catch (e) {
        error.textContent = e instanceof Error && e.message ? e.message : "Couldn't save that. Try again in a minute.";
        error.hidden = false;
        go.disabled = false;
        cancel.removeAttribute("disabled");
        go.textContent = "Try again";
      }
    });
  });
}
