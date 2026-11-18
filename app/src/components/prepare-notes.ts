/**
 * Today's "Prepare notes": a meeting in the next day and a half with someone
 * Athena knows, and no notes yet (lib/template-fill.ts prepareSuggestions).
 * One tap fills Meeting notes from the calendar, People, catch-ups, to-dos
 * and email, and opens the note. Hidden when there's nothing to prepare.
 */
import "../styles/documents.css";
import { h } from "../lib/dom";
import { hueFor, initials } from "../lib/format";
import { loadPrepare, type PrepareSuggestion } from "../db/documents";
import { onLive } from "../live";
import { prepKey } from "../lib/prep-key";
import { openTemplatePicker } from "./templates";
import type { EntityKind } from "../types";

function whenWords(iso: string): string {
  const at = new Date(iso);
  const now = new Date();
  const day = at.toDateString() === now.toDateString() ? "Today" : at.toDateString() === new Date(now.getTime() + 86_400_000).toDateString() ? "Tomorrow" : new Intl.DateTimeFormat(undefined, { weekday: "long" }).format(at);
  return `${day} at ${new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(at)}`;
}

const names = (people: PrepareSuggestion["people"]) =>
  people.length <= 2 ? people.map((p) => p.name).join(" and ") : `${people[0].name}, ${people[1].name} and ${people.length - 2} more`;

export function prepareNotes(opts: { openLink: (kind: EntityKind, id: string) => void }): { el: HTMLElement; destroy: () => void } {
  const el = h("section", { class: "home-prep", "aria-label": "Prepare notes", hidden: true });
  const open = (eventId: string) =>
    openTemplatePicker(
      {
        openLink: opts.openLink,
        openFilled: (n) => void import("./note-detail").then((m) => m.openNoteSheet(null, { openLink: opts.openLink, seed: n.body, seedTitle: n.title, keepSeed: true })),
      },
      { forMeeting: eventId }
    );

  let shown = "";
  const paint = (list: PrepareSuggestion[]) => {
    shown = prepKey(list);
    el.hidden = !list.length;
    el.replaceChildren(
      ...list.map((s) => {
        const go = h("button", { class: "btn btn--soft btn--sm prep__go", type: "button", "aria-label": `Prepare notes for ${s.title}` }, "Prepare notes");
        go.addEventListener("click", () => {
          open(s.event_id);
          // Offered once: the note now exists.
          paint(list.filter((x) => x.event_id !== s.event_id));
        });
        return h(
          "div",
          { class: "prep" },
          h("span", { class: "prep__faces", "aria-hidden": "true" }, ...s.people.slice(0, 3).map((p) => h("span", { class: "avatar", style: `--h:${hueFor(p.name)}` }, initials(p.name)))),
          h("span", { class: "prep__text" }, h("span", { class: "prep__title" }, s.title), h("span", { class: "prep__sub" }, `${whenWords(s.starts_at)} with ${names(s.people)}`)),
          go
        );
      })
    );
  };
  // Kept in step with other devices and with collections (live/index.ts): a meeting synced, moved or
  // declined, or its notes prepared somewhere else, changes the cards without a reload. Also on coming back to the app.
  let gone = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const load = () =>
    void loadPrepare().then(
      (list) => {
        if (!gone && prepKey(list) !== shown) paint(list);
      },
      () => undefined
    );
  const soon = () => {
    clearTimeout(timer);
    timer = setTimeout(load, 600);
  };
  const offs = [onLive("record", soon), onLive("note", soon)];
  const onVisible = () => document.visibilityState === "visible" && soon();
  document.addEventListener("visibilitychange", onVisible);
  load();
  return {
    el,
    destroy() {
      gone = true;
      clearTimeout(timer);
      offs.forEach((off) => off());
      document.removeEventListener("visibilitychange", onVisible);
    },
  };
}
