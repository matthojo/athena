/**
 * A small modal confirmation on a native <dialog>, for the one irreversible
 * action in the app: permanent delete. Escape / the backdrop cancel. Focus
 * lands on Cancel, never on the destructive button.
 */

import { h } from "../lib/dom";

export function confirmDialog(opts: { title: string; body: string; confirmLabel: string; danger?: boolean }): Promise<boolean> {
  return confirmChoice(opts).then((r) => !!r);
}

/**
 * The same confirm with one extra choice, a checkbox that starts unticked
 * ("Also delete receipt.pdf from your conversations"). Null when cancelled.
 */
export function confirmChoice(opts: { title: string; body: string; confirmLabel: string; danger?: boolean; choice?: { label: string; detail?: string; confirmLabel?: string } }): Promise<{ choice: boolean } | null> {
  return new Promise((resolve) => {
    const box = h("input", { class: "confirm__check-box", type: "checkbox", id: "confirm-choice" }) as HTMLInputElement;
    const choice = opts.choice
      ? h(
          "label",
          { class: "confirm__check", for: "confirm-choice" },
          box,
          h("span", { class: "confirm__check-text" }, h("span", { class: "confirm__check-label" }, opts.choice.label), opts.choice.detail ? h("span", { class: "confirm__check-detail" }, opts.choice.detail) : null)
        )
      : null;
    const cancel = h("button", { class: "btn btn--soft", type: "button", autofocus: true }, "Cancel");
    const ok = h("button", { class: `btn ${opts.danger ? "btn--danger" : "btn--primary"}`, type: "button" }, opts.confirmLabel);
    const dialog = h(
      "dialog",
      { class: "confirm", "aria-labelledby": "confirm-title", "aria-describedby": "confirm-body" },
      h("h2", { class: "confirm__title", id: "confirm-title" }, opts.title),
      h("p", { class: "confirm__body", id: "confirm-body" }, opts.body),
      choice,
      h("div", { class: "confirm__actions" }, cancel, ok)
    ) as HTMLDialogElement;

    let settled = false;
    const done = (value: boolean) => {
      if (settled) return;
      settled = true;
      dialog.close();
      dialog.remove();
      resolve(value ? { choice: !!choice && box.checked } : null);
    };
    // Ticked, the button says what it'll delete.
    box.addEventListener("change", () => (ok.textContent = box.checked && opts.choice?.confirmLabel ? opts.choice.confirmLabel : opts.confirmLabel));
    cancel.addEventListener("click", () => done(false));
    ok.addEventListener("click", () => done(true));
    dialog.addEventListener("cancel", (e) => {
      e.preventDefault();
      done(false);
    });
    dialog.addEventListener("click", (e) => {
      if (e.target === dialog) done(false);
    });
    document.body.append(dialog);
    dialog.showModal();
    cancel.focus();
  });
}
