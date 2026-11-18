/**
 * What a person's profile knows beyond their details: open loops with them
 * (both ways), small things worth remembering (facts), a catch-up you can log
 * in place, and other names they go by (identities) — plus merging a
 * duplicate. Built for record-profile.ts, which places these sections.
 *
 * Also "Together": the catch-ups and the calendar events you were at with
 * them, newest first (lib/record-story.ts, drawn by record-timeline.ts).
 * To do counts only what's open; decisions you made together sit under
 * their own heading, Decided.
 */

import { h } from "../lib/dom";
import { icons, type IconName } from "./icons";
import { showToast } from "./toast";
import { confirmDialog } from "./confirm";
import { openSheet } from "./sheet";
import { choiceChips } from "./fields";
import { loopRow } from "./loop-row";
import { openCommitmentSheet } from "./commitment-sheet";
import {
  addFact,
  addIdentity,
  loadBrief,
  logInteraction,
  mergePeople,
  onMemoryChange,
  removeIdentity,
  setMemoryArchived,
  updateFact,
} from "../db/memory";
import { findRecord, loadRecords, saveRecord } from "../db/records";
import { recentSeen, sampleStory, storyTimeline } from "./record-timeline";
import { personStory, type StoryEvent, type StoryInteraction, type StoryRow, type StorySeen } from "../lib/record-story";
import { describeSource } from "../lib/sources";
import { CHANNEL_META } from "../lib/memory-meta";
import { hueFor, initials } from "../lib/format";
import { zonedToInstant } from "../../../lib/dates";
import { deviceZone, localToday, whenLocal } from "../lib/time";
import type { Fact, Identity, IdentityKind, InteractionChannel, Person, PersonBrief } from "../types";

const COMMON_KEYS = ["Partner", "Kids", "Pets", "Based in", "Role", "Team", "Coffee order", "Dietary", "Hobbies", "Prefers", "Working on"];

const IDENTITY_ICON: Record<IdentityKind, IconName> = { email: "mail", phone: "phone", slack: "at", alias: "person", other: "link" };

/** Guess what someone typed into "Also known as". */
function identityKind(raw: string): IdentityKind {
  const s = raw.trim();
  if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s)) return "email";
  if (s.startsWith("@")) return "slack";
  if (/^[+\d][\d\s()-]{6,}$/.test(s)) return "phone";
  return "alias";
}

const LOG_CHANNELS: InteractionChannel[] = ["call", "message", "meeting", "in_person", "email"];

let memorySeq = 0;

export interface PersonMemory {
  loops: HTMLElement;
  /** Decisions made with them, under their own heading; hidden with none. */
  decisions: HTMLElement;
  /** "Together": catch-ups and events with them. */
  together: HTMLElement;
  facts: HTMLElement;
  composer: HTMLElement;
  aka: HTMLElement;
  openComposer: () => void;
  brief: () => PersonBrief | null;
  /** Together's rows, newest first (empty until loaded). */
  story: () => StoryRow[];
  destroy: () => void;
}

export function personMemory(
  person: Person,
  opts: {
    /** The brief (re)loaded: repaint the timeline. */
    onBrief: () => void;
    /** A catch-up moved last_contacted_at: repaint the profile from this record. */
    onPerson: (p: Person) => void;
    /** Together's rows changed: the hero's "Last saw" line follows. */
    onStory?: (rows: StoryRow[]) => void;
    /** Open a calendar event from a Together row. */
    openEvent?: (id: string) => void;
  }
): PersonMemory {
  const uid = `pm-${++memorySeq}`;
  const first = person.name.replace(/^(dr|mr|mrs|ms)\.?\s+/i, "").split(/\s+/)[0];
  let brief: PersonBrief | null = null;
  let dead = false;

  // ---------- open loops ----------
  const loopsCount = h("span", { class: "group__count" });
  const addLoop = h("button", { class: "link-btn section-add", type: "button", "aria-label": `Add a to-do for ${first}` }, icons.plus(), "Add");
  addLoop.addEventListener("click", () => openCommitmentSheet(null, { kind: "i_owe", person: { id: person.id, name: person.name } }));
  const loopsBody = h("div", {});
  const loops = h(
    "section",
    { class: "profile__section" },
    h("div", { class: "section-head-row" }, h("h2", { class: "group__label" }, "To do", loopsCount), addLoop),
    loopsBody
  );

  // ---------- decided together ----------
  const decidedCount = h("span", { class: "group__count" });
  const decidedBody = h("div", {});
  const decisions = h("section", { class: "profile__section", hidden: true }, h("h2", { class: "group__label" }, "Decided", decidedCount), decidedBody);

  // The count sits over exactly the rows under it: open to-dos here, decisions under Decided.
  function paintLoops() {
    const open = brief?.open_loops ?? [];
    const decided = brief?.decisions ?? [];
    const row = (c: (typeof open)[number]) => loopRow(c, { onOpen: (x) => openCommitmentSheet(x), showPerson: false });
    loopsCount.textContent = open.length ? String(open.length) : "";
    loopsBody.replaceChildren(
      open.length
        ? h("div", { class: "card card--flush list" }, ...open.map(row))
        : h("p", { class: "note__links-empty" }, `Nothing open with ${first}. Add something you'll do for them, or something you're waiting on from them.`)
    );
    decisions.hidden = !decided.length;
    decidedCount.textContent = decided.length > 1 ? String(decided.length) : "";
    decidedBody.replaceChildren(...(decided.length ? [h("div", { class: "card card--flush list" }, ...decided.map(row))] : []));
  }

  // ---------- together ----------
  const timeline = storyTimeline({
    title: "Together",
    shape: "person",
    empty: `Catch-ups you log with ${first}, and calendar events with them, show up here.`,
    openEvent: opts.openEvent,
  });
  let story: StoryRow[] = [];
  /** What doesn't change while the page is open: the calendar's seen events, sample mode's extras, events with them. */
  let context: Promise<{ seen: StorySeen[]; extra: StoryInteraction[]; events: StoryEvent[] }> | null = null;
  const loadContext = (today: string) =>
    (context ??= Promise.all([
      recentSeen(today),
      sampleStory(today),
      loadRecords("event")
        .then((r) => r.items)
        .catch(() => []),
    ]).then(([seen, sample, events]) => ({
      seen: [...seen, ...sample.seen],
      extra: sample.interactions,
      events: events.filter((e) => e.person_id === person.id && e.recurrence === "none").map((e) => ({ id: e.id, title: e.title, date: whenLocal(e).date, kind: e.kind })),
    })));

  async function paintStory() {
    const today = localToday();
    const ctx = await loadContext(today).catch(() => ({ seen: [], extra: [], events: [] }));
    if (dead) return;
    story = personStory({
      personId: person.id,
      interactions: [...(brief?.interactions ?? []), ...ctx.extra],
      seen: ctx.seen,
      events: ctx.events,
      today,
      localDay: (iso) => localToday(new Date(iso)),
    });
    timeline.set(story, today);
    opts.onStory?.(story);
  }

  // ---------- facts ----------
  const keyList = h("datalist", { id: `${uid}-keys` }, ...COMMON_KEYS.map((k) => h("option", { value: k })));
  const factsCard = h("div", { class: "card card--flush fields facts" });
  const facts = h("section", { class: "profile__section" }, h("h2", { class: "group__label" }, "Things to remember"), factsCard, keyList);

  function factRow(f: Fact): HTMLElement {
    const value = h("input", { class: "prop__input", type: "text", "aria-label": f.key, name: `fact-${f.id}` }) as HTMLInputElement;
    value.value = f.value;
    value.addEventListener("change", async () => {
      const v = value.value.trim();
      try {
        if (!v) {
          await setMemoryArchived("fact", f.id, true);
          showToast(`Forgot “${f.key}”`, { icon: "archive", action: { label: "Undo", run: () => void setMemoryArchived("fact", f.id, false) } });
        } else if (v !== f.value) await updateFact(f.id, { value: v });
      } catch (error) {
        value.value = f.value;
        showToast(error instanceof Error ? error.message : "Couldn't save", { icon: "wifiOff" });
      }
    });
    const src = f.source && f.source !== "manual" ? describeSource(f.source) : null;
    return h(
      "div",
      { class: "prop" },
      h("label", { class: "prop__label", for: value.id || (value.id = `${uid}-f-${f.id}`) }, f.key),
      h(
        "span",
        { class: "prop__control" },
        value,
        src ? h("span", { class: "fact-source", title: `From ${src.name}${f.source_quote ? `: “${f.source_quote}”` : ""}`, "aria-label": `From ${src.name}` }, icons.sparkle()) : null
      )
    );
  }

  function addRow(): HTMLElement {
    const key = h("input", { class: "prop__input prop__key", type: "text", placeholder: "Add detail", list: `${uid}-keys`, "aria-label": "Detail", name: "fact-key", autocomplete: "off" }) as HTMLInputElement;
    const value = h("input", { class: "prop__input", type: "text", placeholder: "and what it is", "aria-label": "Value", name: "fact-value", autocomplete: "off" }) as HTMLInputElement;
    const submit = async () => {
      const k = key.value.trim();
      const v = value.value.trim();
      if (!k || !v) {
        (k ? value : key).focus();
        return;
      }
      try {
        await addFact({ subject_kind: "person", subject_id: person.id, key: k, value: v });
        key.value = "";
        value.value = "";
        key.focus();
      } catch (error) {
        showToast(error instanceof Error ? error.message : "Couldn't save", { icon: "wifiOff" });
      }
    };
    for (const el of [key, value]) {
      el.addEventListener("keydown", (e) => {
        if (e.key !== "Enter") return;
        e.preventDefault();
        if (el === key && !value.value.trim()) value.focus();
        else void submit();
      });
    }
    value.addEventListener("change", () => key.value.trim() && value.value.trim() && void submit());
    return h("div", { class: "prop prop--add" }, key, h("span", { class: "prop__control" }, value));
  }

  function paintFacts() {
    factsCard.replaceChildren(...(brief?.facts ?? []).map(factRow), addRow());
  }

  // ---------- log a catch-up ----------
  let channel: InteractionChannel = "call";
  const channels = choiceChips<InteractionChannel>(
    "How",
    LOG_CHANNELS.map((c) => ({ value: c, label: CHANNEL_META[c].label, icon: icons[CHANNEL_META[c].icon]() })),
    channel,
    (c) => (channel = c)
  );
  channels.el.classList.remove("chip-row--wrap");
  const summary = h("textarea", { class: "log-composer__text", rows: 2, placeholder: `What did you talk about? (optional)`, "aria-label": "What you talked about", name: "summary" }) as HTMLTextAreaElement;
  const when = h("input", { class: "prop__input log-composer__date", type: "date", "aria-label": "When", name: "when", max: localToday() }) as HTMLInputElement;
  const cancel = h("button", { class: "btn btn--ghost btn--sm", type: "button" }, "Cancel");
  const log = h("button", { class: "btn btn--primary btn--sm", type: "button" }, icons.check(), "Log it") as HTMLButtonElement;
  const composer = h(
    "div",
    { class: "log-composer card", hidden: true, role: "group", "aria-label": `Log a catch-up with ${first}` },
    h("p", { class: "log-composer__title" }, `Caught up with ${first}`),
    channels.el,
    summary,
    h("div", { class: "log-composer__foot" }, when, h("span", { class: "note__bar-spacer" }), cancel, log)
  );
  cancel.addEventListener("click", () => (composer.hidden = true));
  log.addEventListener("click", async () => {
    log.disabled = true;
    const today = localToday();
    const day = when.value || today;
    // Today means now; an earlier day means midday that day, here.
    const at = day === today ? new Date().toISOString() : zonedToInstant(day, "12:00", deviceZone()).toISOString();
    const before = person.last_contacted_at;
    try {
      const saved = await logInteraction({ person_ids: [person.id], channel, summary: summary.value.trim(), at });
      composer.hidden = true;
      summary.value = "";
      const fresh = await findRecord("person", person.id);
      if (fresh && !dead) opts.onPerson(fresh);
      showToast(`Logged a ${CHANNEL_META[channel].label.toLowerCase()} with ${first}`, {
        icon: "check",
        action: {
          label: "Undo",
          run: async () => {
            try {
              await setMemoryArchived("interaction", saved.id, true);
              await saveRecord("person", { last_contacted_at: before }, person.id);
              const back = await findRecord("person", person.id);
              if (back && !dead) opts.onPerson(back);
            } catch {
              showToast("Couldn't undo", { icon: "wifiOff" });
            }
          },
        },
      });
    } catch (error) {
      showToast(error instanceof Error ? error.message : "Couldn't log that", { icon: "wifiOff", timeoutMs: 4000 });
    }
    log.disabled = false;
  });

  function openComposer() {
    composer.hidden = false;
    when.value = localToday();
    requestAnimationFrame(() => {
      composer.scrollIntoView({ block: "nearest", behavior: "smooth" });
      summary.focus({ preventScroll: true });
    });
  }

  // ---------- also known as ----------
  const akaChips = h("span", { class: "aka__chips" });
  const akaInput = h("input", { class: "prop__input aka__input", type: "text", placeholder: "Add an email, @handle or nickname", "aria-label": "Also known as", name: "aka", autocomplete: "off" }) as HTMLInputElement;
  const aka = h("span", { class: "aka" }, akaChips, akaInput);
  akaInput.addEventListener("keydown", async (e) => {
    if (e.key !== "Enter") return;
    e.preventDefault();
    const v = akaInput.value.trim();
    if (!v) return;
    try {
      await addIdentity({ person_id: person.id, kind: identityKind(v), value: v });
      akaInput.value = "";
    } catch (error) {
      showToast(error instanceof Error ? error.message : "Couldn't add that", { icon: "wifiOff", timeoutMs: 4000 });
    }
  });

  function paintAka() {
    akaChips.replaceChildren(
      ...(brief?.identities ?? []).map((i: Identity) => {
        const remove = h("button", { class: "picker__clear", type: "button", "aria-label": `Forget ${i.value}` }, icons.close());
        remove.addEventListener("click", () => void removeIdentity(i.id).catch((error) => showToast(error instanceof Error ? error.message : "Couldn't remove it", { icon: "wifiOff" })));
        return h("span", { class: "picker__chip aka__chip" }, h("span", { class: "aka__icon", "aria-hidden": "true" }, icons[IDENTITY_ICON[i.kind]]()), h("span", { class: "picker__name" }, i.kind === "slack" ? `@${i.value}` : i.value), remove);
      })
    );
  }

  // ---------- load ----------
  async function load() {
    const { brief: b } = await loadBrief(person.id);
    if (dead) return;
    brief = b;
    paintLoops();
    paintFacts();
    paintAka();
    opts.onBrief();
    await paintStory();
  }
  paintLoops();
  paintFacts();
  void load();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const unsub = onMemoryChange(() => {
    clearTimeout(timer);
    timer = setTimeout(() => void load(), 120);
  });

  return {
    loops,
    decisions,
    together: timeline.el,
    facts,
    composer,
    aka,
    openComposer,
    brief: () => brief,
    story: () => story,
    destroy() {
      dead = true;
      clearTimeout(timer);
      unsub();
    },
  };
}

/** Pick the duplicate to fold into `keep`; the duplicate is archived, never deleted. */
export function openMergeSheet(keep: Person, onMerged: (p: Person) => void): void {
  const search = h("input", { type: "search", name: "q", placeholder: "Search people", autocomplete: "off", "aria-label": "Search people" }) as HTMLInputElement;
  const list = h("div", { class: "card card--flush list" });
  let people: Person[] = [];
  const body = h(
    "div",
    { class: "merge" },
    h("p", { class: "page-lede" }, `Pick the duplicate of ${keep.name}. Its notes, to-dos, catch-ups and details move here, and the duplicate is archived.`),
    h("label", { class: "search" }, icons.search(), search),
    list
  );
  const sheet = openSheet({ label: `Merge into ${keep.name}`, title: `Merge into ${keep.name}`, body });

  function paint() {
    const q = search.value.trim().toLowerCase();
    const shown = people.filter((p) => p.id !== keep.id && (!q || p.name.toLowerCase().includes(q))).slice(0, 30);
    list.replaceChildren(
      ...shown.map((p) => {
        const row = h(
          "button",
          { class: "row", type: "button" },
          h("span", { class: "avatar avatar--row", style: `--h:${hueFor(p.name)}`, "aria-hidden": "true" }, initials(p.name)),
          h("span", { class: "row__body" }, h("span", { class: "row__title" }, p.name), p.relationship ? h("span", { class: "row__meta" }, p.relationship) : null),
          h("span", {})
        );
        row.addEventListener("click", async () => {
          const ok = await confirmDialog({
            title: `Merge ${p.name} into ${keep.name}?`,
            body: `${p.name}'s notes, to-dos, catch-ups, facts and contact details move to ${keep.name}. ${p.name} is then archived, so you can restore them from Archived if this was a mistake.`,
            confirmLabel: "Merge",
          });
          if (!ok) return;
          try {
            const merged = await mergePeople(keep.id, p.id);
            sheet.close();
            onMerged(merged);
            showToast(`Merged ${p.name} into ${keep.name}`, { icon: "people" });
          } catch (error) {
            showToast(error instanceof Error ? error.message : "Couldn't merge them", { icon: "wifiOff", timeoutMs: 4000 });
          }
        });
        return row;
      })
    );
  }
  search.addEventListener("input", paint);
  void loadRecords("person").then(({ items }) => {
    people = items;
    paint();
  });
}
