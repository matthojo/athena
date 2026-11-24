/**
 * Settings → About you: the owner's profile by section (GET /api/profile),
 * each answer with where it came from ("You told Athena", or "Learned from
 * <source>" for one accepted from the Review inbox). Tap an answer to change
 * it in place, forget it, or see the values it had before. "Run setup
 * again" restarts the wizard at the first step.
 */

import { h } from "../lib/dom";
import { icons } from "./icons";
import { showToast } from "./toast";
import { confirmDialog } from "./confirm";
import { profileControl, profileQuestion, inputHint } from "./profile-inputs";
import { openProfileWizard, QUEUED_NOTE } from "./profile-wizard";
import { changeSetup, loadHistory, loadProfile, onProfileChange, saveProfile, type ProfileSectionView } from "../db/profile";
import { displayValue } from "../lib/profile-catalogue";
import { shortDate } from "../lib/format";
import { provenanceLine } from "../lib/profile-provenance";
import type { ConnectionState, Fact } from "../types";

type FieldView = ProfileSectionView["fields"][number];

export function aboutYouSection(): { el: HTMLElement; destroy: () => void } {
  let sections: ProfileSectionView[] = [];
  let state: ConnectionState = "online";
  let editing: string | null = null;
  let loaded = false;

  const again = h("button", { class: "btn btn--soft", type: "button" }, icons.refresh(), "Run setup again");
  again.addEventListener("click", async () => {
    try {
      await changeSetup({ restart: true, step: "about" });
      void openProfileWizard({ step: "about" });
    } catch (error) {
      showToast(error instanceof Error ? error.message : "Couldn't start setup", { icon: "wifiOff" });
    }
  });
  const list = h("div", { class: "profile-set" });
  const el = h(
    "section",
    { class: "settings__section", "aria-labelledby": "settings-about" },
    h("h2", { class: "settings__heading", id: "settings-about" }, icons.person(), "About you"),
    h("p", { class: "settings__lede" }, "What Athena knows about you, so it can fit its help to you. Only you change it here. Anything Athena works out about you goes to your Inbox first."),
    h("div", { class: "settings__actions" }, again),
    list
  );

  function row(f: FieldView): HTMLElement {
    const value = f.fact?.value ?? "";
    const meta: (string | HTMLElement)[] = [];
    if (f.fact) meta.push(`${provenanceLine(f.fact)} · ${shortDate(f.fact.observed_at)}`);
    if (f.pending) meta.push(h("span", { class: "badge badge--queued" }, "Waiting to sync"));
    if (editing === f.key) return editor(f);
    const b = h(
      "button",
      { class: "row profile-row", type: "button", "data-key": f.key, "aria-label": `${f.label}: ${value ? displayValue(value, f.input) : "not set"}. Change` },
      h(
        "span",
        { class: "row__body" },
        h("span", { class: "profile-row__label" }, f.label),
        h("span", { class: `profile-row__value${value ? "" : " profile-row__value--empty"}` }, value ? displayValue(value, f.input) : "Not set"),
        meta.length ? h("span", { class: "row__meta profile-row__meta" }, ...meta) : null
      ),
      h("span", { class: "row__chevron", "aria-hidden": "true" }, icons.pen())
    );
    b.addEventListener("click", () => {
      editing = f.key;
      paint(f.key);
    });
    return b;
  }

  function editor(f: FieldView): HTMLElement {
    const control = profileControl(f, f.fact?.value ?? "");
    const save = h("button", { class: "btn btn--primary btn--sm", type: "submit" }, "Save");
    const cancel = h("button", { class: "btn btn--ghost btn--sm", type: "button" }, "Cancel");
    const forget = h("button", { class: "btn btn--ghost btn--sm profile-edit__forget", type: "button", hidden: !f.fact }, icons.trash(), "Forget");
    const history = h("div", { class: "profile-history", "aria-live": "polite" });
    const form = h(
      "form",
      { class: "profile-edit", "data-key": f.key, novalidate: true },
      profileQuestion(f.label, control, f.input === "list" ? inputHint(f.input, f.hint) : null),
      h("div", { class: "profile-edit__actions" }, forget, h("span", { class: "profile-wiz__spacer" }), cancel, save),
      history
    ) as HTMLFormElement;

    const close = () => {
      editing = null;
      paint(f.key);
    };
    const commit = async (next: string, done: string) => {
      form.querySelectorAll("button").forEach((x) => ((x as HTMLButtonElement).disabled = true));
      try {
        const how = await saveProfile([{ key: f.key, value: next }]);
        showToast(how === "queued" ? QUEUED_NOTE : done, { icon: how === "queued" ? "cloud" : "check", timeoutMs: how === "queued" ? 4000 : undefined });
        editing = null;
        await load(f.key);
      } catch (error) {
        form.querySelectorAll("button").forEach((x) => ((x as HTMLButtonElement).disabled = false));
        showToast(error instanceof Error ? error.message : "Couldn't save that", { icon: "wifiOff", timeoutMs: 4000 });
      }
    };
    form.addEventListener("submit", (e) => {
      e.preventDefault();
      const next = control.value();
      if (next === (f.fact?.value ?? "").trim()) return close();
      void commit(next, next ? "Saved" : "Forgotten");
    });
    form.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && !(e.target as HTMLElement).matches(".picker__input")) {
        e.preventDefault();
        close();
      }
    });
    cancel.addEventListener("click", close);
    forget.addEventListener("click", async () => {
      const ok = await confirmDialog({
        title: "Forget this answer?",
        body: `Athena stops using what it knows for “${f.label.replace(/\?$/, "")}”. Earlier values stay in its history.`,
        confirmLabel: "Forget",
        danger: true,
      });
      if (ok) void commit("", "Forgotten");
    });

    if (f.fact) void paintHistory(f, history);
    requestAnimationFrame(() => control.focus());
    return form;
  }

  async function paintHistory(f: FieldView, into: HTMLElement) {
    let facts: Fact[];
    try {
      ({ facts } = await loadHistory(f.key));
    } catch {
      return;
    }
    const earlier = facts.filter((x) => x.id !== f.fact?.id);
    if (!earlier.length) {
      into.replaceChildren(h("p", { class: "profile-history__none" }, "No earlier values."));
      return;
    }
    into.replaceChildren(
      h("p", { class: "profile-history__title" }, "Earlier"),
      h(
        "ol",
        { class: "profile-history__list" },
        ...earlier.map((x) =>
          h(
            "li",
            { class: "profile-history__item" },
            h("span", { class: "profile-history__value" }, displayValue(x.value, f.input)),
            h("span", { class: "profile-history__meta" }, `${provenanceLine(x)} · ${shortDate(x.observed_at)}${x.superseded_at ? `, replaced ${shortDate(x.superseded_at)}` : ""}`)
          )
        )
      )
    );
  }

  function paint(focusKey?: string) {
    if (!loaded) return;
    const shown = sections.filter((s) => s.fields.length);
    list.replaceChildren(
      ...shown.map((s) =>
        h(
          "section",
          { class: "profile-set__group", "aria-labelledby": `profile-sec-${s.id}` },
          h("h3", { class: "profile-set__title", id: `profile-sec-${s.id}` }, s.title),
          h("div", { class: "card card--flush list" }, ...s.fields.map(row))
        )
      ),
      ...(state === "offline" ? [h("p", { class: "settings__note" }, icons.wifiOff(), "You're offline. Changes save on this device and go to Athena when you're back online.")] : [])
    );
    if (focusKey && editing === null) requestAnimationFrame(() => list.querySelector<HTMLElement>(`.profile-row[data-key="${CSS.escape(focusKey)}"]`)?.focus());
  }

  async function load(focusKey?: string) {
    try {
      const r = await loadProfile();
      sections = r.sections;
      state = r.state;
      loaded = true;
      paint(focusKey);
    } catch (error) {
      list.replaceChildren(h("p", { class: "settings__note" }, icons.wifiOff(), error instanceof Error ? error.message : "Couldn't load your profile"));
    }
  }

  list.replaceChildren(
    h("div", { class: "card card--flush list" }, ...[0, 1, 2].map(() => h("div", { class: "row" }, h("span", { class: "row__body" }, h("span", { class: "skeleton", style: "height:12px;width:40%" }), h("span", { class: "skeleton", style: "height:14px;width:65%;margin-top:6px" })))))
  );
  void load();
  // Don't repaint over an answer being typed.
  const off = onProfileChange(() => editing === null && void load());
  return { el, destroy: off };
}
