/**
 * Settings → About you → What Athena knows (#/settings/knows): every lasting
 * thing Athena keeps about the owner and uses in Ask, grouped by where it
 * came from (app/src/lib/knows.ts), each with where and when. Tap one to
 * change it in place or forget it. A waiting one (from the Review inbox)
 * is kept with Save, or turned down with Forget.
 */
import { h } from "../lib/dom";
import { icons } from "./icons";
import { showToast } from "./toast";
import { confirmDialog } from "./confirm";
import { profileControl, profileQuestion, inputHint } from "./profile-inputs";
import { QUEUED_NOTE } from "./profile-wizard";
import { editKnown, forgetKnown, loadKnows } from "../db/knows";
import { onProfileChange } from "../db/profile";
import { groupKnows, type KnowsGroup, type KnownItem } from "../lib/knows";
import { displayValue } from "../lib/profile-catalogue";
import { shortDate } from "../lib/format";
import type { ConnectionState } from "../types";
import "../styles/knows.css";

export function knowsSection(): { el: HTMLElement; destroy: () => void } {
  let groups: KnowsGroup[] = [];
  let state: ConnectionState = "online";
  let editing: string | null = null;
  let loaded = false;

  const list = h("div", { class: "profile-set knows" });
  const el = h(
    "section",
    { class: "settings__section", "aria-labelledby": "settings-knows" },
    h("h2", { class: "settings__heading", id: "settings-knows" }, icons.sparkle(), "What Athena knows"),
    h("p", { class: "settings__lede" }, "What Athena keeps about you and uses when you ask it something. Change anything here, or tell it to forget."),
    list
  );

  const who = (i: KnownItem) => (i.about.kind === "person" ? i.about.name : null);
  const shown = (i: KnownItem) => displayValue(i.value, i.input);

  function row(i: KnownItem): HTMLElement {
    if (editing === i.key) return editor(i);
    const person = who(i);
    const b = h(
      "button",
      { class: "row profile-row knows-row", type: "button", "data-key": i.key, "aria-label": `${person ? `${person}, ` : ""}${i.label}: ${shown(i)}. ${i.from}, ${shortDate(i.at)}. Change or forget` },
      h(
        "span",
        { class: "row__body" },
        h("span", { class: "profile-row__label" }, person ? h("span", { class: "knows-row__who" }, person) : null, i.label),
        h("span", { class: "profile-row__value" }, shown(i)),
        h("span", { class: "row__meta profile-row__meta" }, `${i.from} · ${shortDate(i.at)}`),
        i.why ? h("span", { class: "knows-row__why" }, `“${i.why}”`) : null
      ),
      h("span", { class: "row__chevron", "aria-hidden": "true" }, icons.pen())
    );
    b.addEventListener("click", () => {
      editing = i.key;
      paint(i.key);
    });
    return b;
  }

  function editor(i: KnownItem): HTMLElement {
    const person = who(i);
    const control = profileControl({ key: i.label, label: person ? `${person} · ${i.label}` : i.label, input: i.input }, i.value);
    const save = h("button", { class: "btn btn--primary btn--sm", type: "submit" }, i.suggestion ? "Keep" : "Save");
    const cancel = h("button", { class: "btn btn--ghost btn--sm", type: "button" }, "Cancel");
    const forget = h("button", { class: "btn btn--ghost btn--sm profile-edit__forget", type: "button" }, icons.trash(), i.suggestion ? "Not right" : "Forget");
    const form = h(
      "form",
      { class: "profile-edit", "data-key": i.key, novalidate: true },
      profileQuestion(person ? `${person} · ${i.label}` : i.label, control, i.input === "list" ? inputHint(i.input) : null),
      h("p", { class: "knows-edit__from" }, `${i.from} · ${shortDate(i.at)}`),
      h("div", { class: "profile-edit__actions" }, forget, h("span", { class: "profile-wiz__spacer" }), cancel, save)
    ) as HTMLFormElement;

    const busy = (on: boolean) => form.querySelectorAll("button").forEach((x) => ((x as HTMLButtonElement).disabled = on));
    const close = () => {
      editing = null;
      paint(i.key);
    };
    const run = async (work: () => Promise<"saved" | "queued">, done: string) => {
      busy(true);
      try {
        const how = await work();
        showToast(how === "queued" ? QUEUED_NOTE : done, { icon: how === "queued" ? "cloud" : "check", timeoutMs: how === "queued" ? 4000 : undefined });
        editing = null;
        await load();
      } catch (error) {
        busy(false);
        showToast(error instanceof Error ? error.message : "Couldn't save that", { icon: "wifiOff", timeoutMs: 4000 });
      }
    };
    form.addEventListener("submit", (e) => {
      e.preventDefault();
      const next = control.value().trim();
      if (!next) return void forgetIt();
      if (next === i.value.trim() && !i.suggestion) return close();
      void run(() => editKnown(i, next), i.suggestion ? "Kept" : "Saved");
    });
    form.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && !(e.target as HTMLElement).matches(".picker__input")) {
        e.preventDefault();
        close();
      }
    });
    cancel.addEventListener("click", close);
    async function forgetIt() {
      if (!i.suggestion) {
        const ok = await confirmDialog({
          title: "Forget this?",
          body: `Athena stops using “${person ? `${person} · ` : ""}${i.label}: ${shown(i)}”.${i.about.kind === "person" ? " You can bring it back from Archived." : " Earlier values stay in its history."}`,
          confirmLabel: "Forget",
          danger: true,
        });
        if (!ok) return;
      }
      void run(() => forgetKnown(i), i.suggestion ? "Turned down" : "Forgotten");
    }
    forget.addEventListener("click", () => void forgetIt());
    requestAnimationFrame(() => control.focus());
    return form;
  }

  function paint(focusKey?: string) {
    if (!loaded) return;
    if (!groups.length) {
      list.replaceChildren(
        h("div", { class: "card knows-empty" }, h("p", { class: "knows-empty__title" }, "Nothing yet"), h("p", { class: "knows-empty__body" }, "Tell Ask something to remember, like “remember that I'm vegetarian”, or fill in About you. It shows up here."))
      );
      return;
    }
    list.replaceChildren(
      ...groups.map((g) =>
        h(
          "section",
          { class: "profile-set__group", "aria-labelledby": `knows-${g.id}` },
          h("h3", { class: "profile-set__title", id: `knows-${g.id}` }, g.title, h("span", { class: "knows__count" }, String(g.items.length))),
          h("p", { class: "knows__lede" }, g.lede),
          h("div", { class: "card card--flush list" }, ...g.items.map(row))
        )
      ),
      ...(state === "offline" ? [h("p", { class: "settings__note" }, icons.wifiOff(), "You're offline. This is what Athena knew when you were last online.")] : [])
    );
    if (focusKey && editing === null) requestAnimationFrame(() => list.querySelector<HTMLElement>(`.knows-row[data-key="${CSS.escape(focusKey)}"]`)?.focus());
  }

  async function load() {
    try {
      const r = await loadKnows();
      groups = groupKnows(r.lists);
      state = r.state;
      loaded = true;
      paint();
    } catch (error) {
      list.replaceChildren(h("p", { class: "settings__note" }, icons.wifiOff(), error instanceof Error ? error.message : "Couldn't load what Athena knows"));
    }
  }

  list.replaceChildren(
    h("div", { class: "card card--flush list" }, ...[0, 1, 2].map(() => h("div", { class: "row" }, h("span", { class: "row__body" }, h("span", { class: "skeleton", style: "height:12px;width:40%" }), h("span", { class: "skeleton", style: "height:14px;width:65%;margin-top:6px" })))))
  );
  void load();
  // Ask remembering something, or a change in About you, shows here too. Not while an edit is open.
  const off = onProfileChange(() => editing === null && void load());
  return { el, destroy: off };
}
