/**
 * Settings, in sections with their own addresses: #/settings/about
 * (About you: components/profile-settings.ts, and #/settings/knows inside it:
 * components/knows-page.ts), #/settings/fields,
 * #/settings/notifications (components/notification-settings.ts),
 * #/settings/types (its name and address come from lib/custom-kind-words.ts),
 * #/settings/sources, …/voice, …/iphone and #/settings/api-keys (SECTIONS),
 * in groups. #/settings/accounts and …/collections, the old pages, open
 * Sources. On desktop the sections run down
 * the left and the chosen one fills the rest; on a phone #/settings lists
 * them and each opens on its own page, with a way back.
 *
 * Your fields: pick a kind (People, Places, Watch & read…), see its fields
 * in the order its records show them, add one, tap one to rename it, change
 * its type or options, or archive it, and reorder them. Archived fields wait
 * on the Archived page with their values. The owner's own kinds of record
 * have tabs here too, after the built-in ones, with the same list and editor.
 *
 * The owner's own kinds of record: components/kinds-settings.ts.
 * Sources, Voice and From your iPhone: components/connector-settings.ts.
 * Sources' row carries its health ("All working", "2 need you") from
 * components/status.ts, which lib/sources-health.ts keeps current. API keys: components/api-keys.ts.
 */

import { h } from "../lib/dom";
import { icons, type IconName } from "../components/icons";
import { openFieldEditor } from "../components/field-editor";
import { shareSetting } from "../components/share-setting";
import { versionSetting } from "../components/version-setting";
import { apiKeysSection } from "../components/api-keys";
import { mapsArtSection } from "../components/maps-art-settings";
import { notificationsSection } from "../components/notification-settings";
import { kindsSection } from "../components/kinds-settings";
import { todoContextsSection } from "../components/todo-contexts-settings";
import { aboutYouSection } from "../components/profile-settings";
import { knowsSection } from "../components/knows-page";
import { askMoneySetting } from "../components/ask-money-setting";
import { askActivitySection, askSettingsSection } from "../components/ask-settings";
import { kindsSnapshot, loadKinds, onKindsChange } from "../db/custom-kinds";
import { KIND_WORD } from "../../../lib/custom-kind-words";
import { healthSourcesPanel } from "../components/health-sources";
import { draftSettingsSection } from "../components/draft-settings";
import { connectorSection, SOURCES_SECTION, TALK_SECTIONS, type ConnectorSection } from "../components/connector-settings";
import { healthTime, onSourcesStatus, sourcesStatus } from "../components/status";
import { showToast } from "../components/toast";
import { liveFields, loadAllFields, onCustomFieldsChange, reorderFields, type CustomField, type FieldKind } from "../db/custom-fields";
import { FIELD_TYPE_ICON, fieldKindIcon, fieldSummary, lastFieldsKind, rememberFieldsKind } from "../lib/field-meta";
import { plural } from "../lib/format";
import { FIELD_KIND_LIST, customKindId, fieldKindInfo, isBuiltinKind, isCustomKind } from "../../../lib/custom-field-rules";
import type { ConnectionState } from "../types";
import type { ViewId } from "../components/nav";
import { pageHead } from "../components/page-head";

/** Every kind with fields: the built-in ones, then the owner's own, in their order. */
const allKinds = (): FieldKind[] => [...FIELD_KIND_LIST, ...kindsSnapshot().map((k) => k.kind)];

function lastKind(): FieldKind {
  const k = lastFieldsKind();
  if (isBuiltinKind(k)) return k;
  // One of the owner's own kinds, while it's still live.
  if (isCustomKind(k) && kindsSnapshot().some((x) => x.id === customKindId(k))) return k;
  return "person";
}

/** Tab names, short like the Library's (any other kind uses its label). */
const TAB: Partial<Record<FieldKind, string>> = { organisation: "Orgs", asset: "Admin" };

/** What each kind's empty list suggests. */
const EXAMPLES: Partial<Record<FieldKind, string>> = {
  person: "a shoe size, a clothing size or their interests",
  place: "what it's good for, or a rating",
  organisation: "an account manager, or how you know them",
  event: "a dress code, or who's going",
  note: "a mood, or a project stage",
  reading: "a rating, or whether you'd recommend it",
  goal: "why it matters, or a reward",
  asset: "a policy type, or who to call",
  project: "a client, or a budget owner",
};

function fieldsSection(ctx: { go: (view: ViewId) => void }): { el: HTMLElement; destroy: () => void } {
  let kind = lastKind();
  let all: CustomField[] = [];
  let state: ConnectionState = "online";
  let loaded = false;
  let reordering = false;

  const tabs = h("nav", { class: "segmented settings__kinds", "aria-label": "Fields for" });
  const list = h("div", { class: "settings__fields" });
  const el = h(
    "section",
    { class: "settings__section", "aria-labelledby": "settings-fields" },
    h("h2", { class: "settings__heading", id: "settings-fields" }, icons.sliders(), "Your fields"),
    h("p", { class: "settings__lede" }, "Add your own details to anything in Athena, like a shoe size for people or a rating for films and books. They show up in each one's Details."),
    tabs,
    list
  );

  function paintTabs() {
    tabs.replaceChildren(
      ...allKinds().map((k) => {
        const n = liveFields(all, k).length;
        const b = h(
          "button",
          { class: "segmented__item", type: "button", "aria-current": k === kind ? "page" : undefined, "aria-label": `${fieldKindInfo(k).label}${n ? `, ${n} ${plural(n, "field", "fields")}` : ""}` },
          TAB[k] ?? fieldKindInfo(k).label,
          n ? h("span", { class: "segmented__count" }, String(n)) : null
        );
        b.addEventListener("click", () => {
          if (k === kind) return;
          kind = k;
          reordering = false;
          rememberFieldsKind(k);
          paint();
        });
        return b;
      })
    );
    requestAnimationFrame(() => {
      const current = tabs.querySelector<HTMLElement>('[aria-current="page"]');
      if (current && tabs.scrollWidth > tabs.clientWidth) {
        // Centre the current tab, measured against the row itself (offsetLeft
        // counts from the nearest positioned ancestor, which overshot).
        const at = current.getBoundingClientRect().left - tabs.getBoundingClientRect().left + tabs.scrollLeft;
        tabs.scrollLeft = at - (tabs.clientWidth - current.offsetWidth) / 2;
      }
    });
  }

  async function move(fields: CustomField[], from: number, to: number) {
    if (to < 0 || to >= fields.length) return;
    const order = [...fields];
    const [moved] = order.splice(from, 1);
    order.splice(to, 0, moved);
    // Show the new order at once; the server's answer follows.
    all = all.map((f) => {
      const i = order.findIndex((o) => o.id === f.id);
      return i >= 0 ? { ...f, position: i } : f;
    });
    paint();
    try {
      await reorderFields(kind, order.map((f) => f.id));
    } catch (error) {
      showToast(error instanceof Error ? error.message : "Couldn't move it", { icon: "wifiOff" });
      void load();
    }
  }

  function row(f: CustomField, i: number, fields: CustomField[]): HTMLElement {
    const lead = h("span", { class: "tile tile--sm", "aria-hidden": "true" }, icons[FIELD_TYPE_ICON[f.type]]());
    const body = h("span", { class: "row__body" }, h("span", { class: "row__title" }, f.label), h("span", { class: "row__meta" }, fieldSummary(f)));
    if (reordering) {
      const arrow = (dir: "up" | "down") => {
        const target = dir === "up" ? i - 1 : i + 1;
        const b = h(
          "button",
          { class: "icon-btn icon-btn--sm icon-btn--ghost", type: "button", "data-dir": dir, "aria-label": `Move ${f.label} ${dir}`, disabled: target < 0 || target >= fields.length },
          dir === "up" ? icons.arrowUp() : icons.arrowDown()
        );
        b.addEventListener("click", () => void move(fields, i, target));
        return b;
      };
      return h("div", { class: "row settings__row", "data-id": f.id }, lead, body, h("span", { class: "settings__move" }, arrow("up"), arrow("down")));
    }
    const b = h("button", { class: "row settings__row", type: "button", "data-id": f.id, "aria-label": `${f.label}, ${fieldSummary(f)}. Edit` }, lead, body, h("span", { class: "row__chevron", "aria-hidden": "true" }, icons.chevronRight()));
    b.addEventListener("click", () => openFieldEditor(kind, f));
    return b;
  }

  function paint() {
    paintTabs();
    if (!loaded) return;
    // A repaint (a move, a reload) keeps the keyboard where it was.
    const active = document.activeElement as HTMLElement | null;
    const focusId = list.contains(active) ? active?.closest<HTMLElement>("[data-id]")?.dataset.id : undefined;
    const focusDir = active?.dataset.dir;
    requestAnimationFrame(() => {
      if (!focusId) return;
      const row = list.querySelector<HTMLElement>(`[data-id="${focusId}"]`);
      (focusDir ? row?.querySelector<HTMLElement>(`[data-dir="${focusDir}"]:not(:disabled)`) : row)?.focus();
    });
    const info = fieldKindInfo(kind);
    const fields = liveFields(all, kind);
    const archived = all.filter((f) => f.kind === kind && f.archived_at).length;

    const add = h("button", { class: `btn ${fields.length ? "btn--soft" : "btn--primary"}`, type: "button" }, icons.plus(), "Add a field");
    add.addEventListener("click", () => openFieldEditor(kind, null));
    const reorder = h("button", { class: "btn btn--ghost", type: "button", "aria-pressed": String(reordering) }, reordering ? "Done" : "Reorder");
    reorder.addEventListener("click", () => {
      reordering = !reordering;
      paint();
    });

    const notes: HTMLElement[] = [];
    if (kind === "project") notes.push(h("p", { class: "settings__note" }, icons.project(), "Projects don't have a page in the app yet, so fill these in by asking Athena in Ask."));
    if (archived) {
      const link = h("button", { class: "settings__link", type: "button" }, "Restore from Archived");
      link.addEventListener("click", () => ctx.go("archived"));
      notes.push(h("p", { class: "settings__note" }, icons.archive(), `${archived} archived ${plural(archived, "field", "fields")}, values kept. `, link));
    }
    if (state === "offline") notes.push(h("p", { class: "settings__note" }, icons.wifiOff(), "You're offline. These are the fields saved on this device; changing them needs a connection."));

    list.replaceChildren(
      fields.length
        ? h("div", { class: `card card--flush list${reordering ? " is-reordering" : ""}` }, ...fields.map((f, i) => row(f, i, fields)))
        : h(
            "div",
            { class: "empty settings__empty" },
            h("span", { class: "tile" }, icons[fieldKindIcon(kind)]()),
            h("p", { class: "empty__title" }, `No fields for ${info.many} yet`),
            h("p", { class: "empty__sub" }, `Add one for anything you'd like to keep on every ${info.one}: ${EXAMPLES[kind] ?? "a rating, a price or where it's from"}.`)
          ),
      h("div", { class: "settings__actions" }, add, fields.length > 1 ? reorder : null),
      ...notes
    );
  }

  async function load() {
    // The owner's own kinds are tabs too: know them (and which one was asked for) before painting.
    const [result] = await Promise.all([loadAllFields(), loadKinds()]);
    all = result.fields;
    state = result.state;
    if (!allKinds().includes(kind)) kind = lastKind();
    loaded = true;
    paint();
  }

  list.replaceChildren(
    h("div", { class: "card card--flush list" }, ...[0, 1].map(() => h("div", { class: "row" }, h("span", { class: "tile tile--sm skeleton" }), h("span", { class: "row__body" }, h("span", { class: "skeleton", style: "height:12px;width:40%" })), h("span", {}))))
  );
  paintTabs();
  void load();
  const unsub = onCustomFieldsChange(() => void load());
  // A kind made, renamed or archived: its tab follows.
  const unsubKinds = onKindsChange((k) => {
    if (k !== null || !loaded) return;
    if (!allKinds().includes(kind)) kind = "person";
    paint();
  });
  return {
    el,
    destroy: () => {
      unsub();
      unsubKinds();
    },
  };
}

export type SettingsSection = "about" | "fields" | typeof KIND_WORD.slug | ConnectorSection | "health" | "maps" | "days" | "checkins" | "todo" | "drafts" | "recipes" | "notifications" | "reminders" | "knows" | "api-keys" | "ask" | "ask-activity" | "skills" | "models" | "spend";

interface SectionInfo {
  id: SettingsSection;
  label: string;
  detail: string;
  icon: IconName;
}

/** Settings' sections, in groups, in the order the navigation lists them. */
const GROUPS: Array<{ label: string | null; sections: SectionInfo[] }> = [
  {
    label: null,
    sections: [
      { id: "about", label: "About you", detail: "What Athena knows about you, and setup", icon: "person" },
      { id: "fields", label: "Your fields", detail: "Your own details on people, places, films and more", icon: "sliders" },
      { id: KIND_WORD.slug, label: KIND_WORD.yours, detail: KIND_WORD.detail, icon: "folder" },
      { id: "days", label: "Days", detail: "How your mood looks", icon: "calendar" },
      { id: "checkins", label: "Check-ins", detail: "Morning and evening questions", icon: "chat" },
      { id: "todo", label: "To do", detail: "Areas, and where you do things", icon: "loop" },
      { id: "drafts", label: "Drafts", detail: "Messaging apps you use", icon: "pen" },
      { id: "recipes", label: "Recipes", detail: "Pantry staples and units", icon: "pot" },
      { id: "ask", label: "Ask", detail: "Skills, routines, and what Ask did", icon: "sparkle" },
      { id: "models", label: "AI models", detail: "Which model does each job", icon: "sliders" },
      { id: "spend", label: "AI spend", detail: "What Athena's AI cost, and a daily budget", icon: "wallet" },
      { id: "notifications", label: "Notifications", detail: "What reaches your phone, and when", icon: "bell" },
    ],
  },
  {
    label: "Your sources",
    sections: [
      SOURCES_SECTION,
      { id: "health", label: "Health", detail: "Where sleep, steps, workouts and weight come from", icon: "heart" },
      { id: "maps", label: "Maps and artwork", detail: "Day maps, posters and covers", icon: "pin" },
    ],
  },
  { label: "Talk and capture", sections: TALK_SECTIONS },
  { label: "Access", sections: [{ id: "api-keys", label: "API keys", detail: "For your iPhone's Shortcut, agents or scripts", icon: "key" }] },
];
const SECTIONS: SectionInfo[] = GROUPS.flatMap((g) => g.sections);

/** Pages inside a section, reached from it rather than listed: Reminders, from Notifications. */
const SUBPAGES: Partial<Record<SettingsSection, SettingsSection>> = { reminders: "notifications", knows: "about", "ask-activity": "ask" };

/** The old Accounts and Collections pages are Sources now; sign-ins still come back to #/settings/accounts. */
const ALIASES: Record<string, SettingsSection> = { accounts: "sources", collections: "sources" };

/** Sources' row: its health in words, and an amber count when something needs you. */
function sourcesBadge(): { detail: string | null; count: number; stale: boolean } {
  const s = sourcesStatus();
  if (!s) return { detail: null, count: 0, stale: false };
  if (!s.live) return { detail: s.count ? `${s.short} at ${healthTime(s.at)}` : null, count: 0, stale: true };
  return { detail: s.short, count: s.count, stale: false };
}

function countPill(n: number): HTMLElement {
  return h("span", { class: "src-pill", "aria-label": `${n} ${plural(n, "needs", "need")} you` }, String(n));
}

function section(id: SettingsSection, ctx: { go: (view: ViewId) => void; open: (id: SettingsSection) => void; connected: string | null; /** A phone page of its own: its heading is the page's h1. */ page?: boolean }): { el: HTMLElement; destroy: () => void } {
  if (id === "fields") return fieldsSection({ go: ctx.go });
  if (id === "about") {
    // What Athena knows, from Ask and everywhere else, is one step in from here.
    const a = aboutYouSection();
    const entry = h(
      "button",
      { class: "row", type: "button" },
      h("span", { class: "tile tile--sm" }, icons.sparkle()),
      h("span", { class: "row__body" }, h("span", { class: "row__title" }, "What Athena knows"), h("span", { class: "row__meta" }, "Things you told Ask, and what Athena learned")),
      h("span", { class: "row__trail" }, h("span", { class: "row__chevron", "aria-hidden": "true" }, icons.chevronRight()))
    );
    entry.addEventListener("click", () => ctx.open("knows"));
    a.el.querySelector(".settings__actions")?.before(h("div", { class: "card card--flush list settings__sub" }, entry), h("div", { class: "card settings__sub ask-money-card" }, askMoneySetting()), h("div", { class: "card settings__sub ask-money-card" }, shareSetting()), h("div", { class: "card settings__sub ask-money-card" }, versionSetting()));
    return a;
  }
  if (id === "knows") return knowsSection();
  if (id === "ask") return askSettingsSection({ open: ctx.open });
  if (id === "ask-activity") return askActivitySection();
  if (id === "spend") return lazySection(() => import("../components/spend-settings").then((m) => m.spendSettingsSection()));
  if (id === KIND_WORD.slug) return kindsSection({ go: ctx.go });
  if (id === "health") return healthSection({ open: ctx.open, go: ctx.go });
  if (id === "todo") return todoContextsSection();
  if (id === "maps") return mapsArtSection();
  if (id === "drafts") return draftSettingsSection();
  if (id === "recipes") {
    // Loaded with the Recipes code, so Settings stays light.
    const slot = h("div", { style: "display:contents" });
    void import("../components/recipe-settings").then((m) => slot.append(m.recipeSettingsSection().el));
    return { el: slot, destroy: () => undefined };
  }
  if (id === "days") {
    // Loaded with the Days chunk, so Settings stays light.
    const slot = h("div", { style: "display:contents" });
    void import("../components/day-settings").then((m) => slot.append(m.daysSettingsSection().el));
    return { el: slot, destroy: () => undefined };
  }
  if (id === "models") {
    // Loaded with the picker, so Settings stays light (components/models-settings.ts).
    const slot = h("div", { style: "display:contents" });
    let done = () => undefined as void;
    void import("../components/models-settings").then((m) => {
      const c = m.modelsSettingsSection({ page: ctx.page });
      slot.append(c.el);
      done = c.destroy;
    });
    return { el: slot, destroy: () => done() };
  }
  if (id === "checkins") {
    // Loaded with the check-in code, so Settings stays light.
    const slot = h("div", { style: "display:contents" });
    let done = () => undefined as void;
    void import("../components/checkin-settings").then((m) => {
      const c = m.checkinSettingsSection({ openNotifications: () => ctx.open("notifications") });
      slot.append(c.el);
      done = c.destroy;
    });
    return { el: slot, destroy: () => done() };
  }
  if (id === "notifications") {
    // Your own reminders live one step in from here.
    const n = notificationsSection();
    const entry = h(
      "button",
      { class: "row", type: "button" },
      h("span", { class: "tile tile--sm" }, icons.clock()),
      h("span", { class: "row__body" }, h("span", { class: "row__title" }, "Reminders"), h("span", { class: "row__meta" }, "Your own reminders, once or on repeat")),
      h("span", { class: "row__trail" }, h("span", { class: "row__chevron", "aria-hidden": "true" }, icons.chevronRight()))
    );
    entry.addEventListener("click", () => ctx.open("reminders"));
    n.el.append(h("div", { class: "card card--flush list settings__sub" }, entry));
    return n;
  }
  if (id === "reminders") {
    const slot = h("div", { class: "settings__reminders" });
    let done = () => undefined as void;
    void import("./reminders").then((m) => {
      const r = m.renderReminders();
      slot.append(r.el);
      done = r.destroy;
    });
    return { el: slot, destroy: () => done() };
  }
  if (id === "api-keys") {
    const keys = apiKeysSection();
    void keys.reload();
    return { el: keys.el, destroy: () => undefined };
  }
  return connectorSection(id as ConnectorSection, { connected: ctx.connected, go: ctx.open });
}

/** A section loaded with its own code, so Settings stays light. */
function lazySection(load: () => Promise<{ el: HTMLElement; destroy: () => void }>): { el: HTMLElement; destroy: () => void } {
  const slot = h("div", { style: "display:contents" });
  let done = () => undefined as void;
  void load().then((s) => {
    slot.append(s.el);
    done = s.destroy;
  });
  return { el: slot, destroy: () => done() };
}

/** #/settings/skills and #/settings/skills/<id>: loaded with its own code, so Settings stays light. */
function skillsPage(section: string, go: (noteId: string | null) => void): { el: HTMLElement; destroy: () => void } {
  const id = section.startsWith("skills/") ? section.slice("skills/".length) : null;
  const back = h("button", { class: "settings__back", type: "button" }, icons.back(), id ? "Skills" : "Settings");
  back.addEventListener("click", () => go(id ? "skills" : "ask"));
  const slot = h("div", { style: "display:contents" });
  let done = () => undefined as void;
  void import("../components/skills-page").then((m) => {
    const nav = { open: (to: string | null) => go(to ? `skills/${to}` : "skills"), back: () => go(id ? "skills" : "ask") };
    const s = id ? m.skillEditorSection(id, nav) : m.skillsListSection(nav);
    slot.append(s.el);
    done = s.destroy;
  });
  return { el: h("div", { class: "view settings settings--page settings--skills" }, h("div", { class: "settings__page-head" }, back), slot), destroy: () => done() };
}

/** Health: which app each figure comes from. */
function healthSection(ctx: { open: (id: SettingsSection) => void; go: (view: ViewId) => void }): { el: HTMLElement; destroy: () => void } {
  const panel = healthSourcesPanel({ openSources: () => ctx.open("sources"), openIphone: () => ctx.open("iphone") });
  const see = h("button", { class: "acct-link", type: "button" }, "See your health");
  see.addEventListener("click", () => ctx.go("health"));
  return {
    el: h(
      "section",
      { class: "settings__section settings__section--health", "aria-labelledby": "settings-health" },
      h("div", { class: "src-head" }, h("h2", { class: "settings__heading", id: "settings-health" }, icons.heart(), "Health"), see),
      h("p", { class: "settings__lede" }, "Pick one app for each. Athena never adds two together. If your app has nothing for a day, the next one fills in."),
      h("div", { class: "settings__body" }, panel.el)
    ),
    destroy: () => undefined,
  };
}

/** #/settings and #/settings/<section>: the sections, side by side on desktop, a list then a page on a phone. */
export function renderSettings(ctx: {
  go: (view: ViewId, opts?: { noteId?: string | null }) => void;
  section: string | null;
  /** Back from an account sign-in: the account that's in (#/settings/accounts?connected=<id>). */
  connected: string | null;
  isDesktop: () => boolean;
}): { el: HTMLElement; destroy: () => void } {
  // Skills: a full page of its own, on a phone and a wide screen alike, with a way back.
  if (ctx.section === "skills" || ctx.section?.startsWith("skills/")) return skillsPage(ctx.section, (id) => ctx.go("settings", { noteId: id }));
  const asked = ctx.section ? ALIASES[ctx.section] ?? ctx.section : null;
  const chosen = SECTIONS.find((s) => s.id === asked)?.id ?? (asked && asked in SUBPAGES ? (asked as SettingsSection) : null);
  const open = (id: SettingsSection | null) => ctx.go("settings", { noteId: id });
  const go = (view: ViewId) => ctx.go(view);
  const sectionCtx = { go, open, connected: ctx.connected };
  const head = () => pageHead({ title: "Settings", lede: "Make Athena fit how you keep track of things." });

  if (ctx.isDesktop()) {
    const active = chosen ?? SECTIONS[0].id;
    const body = section(active, sectionCtx);
    const nav = h(
      "nav",
      { class: "settings__nav", "aria-label": "Settings sections" },
      ...GROUPS.flatMap((g) => [
        g.label ? h("p", { class: "settings__nav-label" }, g.label) : null,
        ...g.sections.map((s) => {
          const pill = s.id === "sources" ? h("span", { class: "settings__nav-pill" }) : null;
          const lit = s.id === (SUBPAGES[active] ?? active);
          const b = h("button", { class: "settings__nav-item", type: "button", "aria-current": lit ? "page" : undefined }, icons[s.icon](), s.label, pill);
          b.addEventListener("click", () => s.id !== active && open(s.id));
          return b;
        }),
      ])
    );
    const pillSlot = nav.querySelector<HTMLElement>(".settings__nav-pill");
    const paintPill = () => {
      if (!pillSlot) return;
      const { count } = sourcesBadge();
      pillSlot.replaceChildren(...(count ? [countPill(count)] : []));
    };
    paintPill();
    const unsub = onSourcesStatus(paintPill);
    return {
      el: h("div", { class: "view settings settings--split" }, head(), h("div", { class: "settings__layout" }, nav, h("div", { class: "settings__pane" }, body.el))),
      destroy: () => {
        unsub();
        body.destroy();
      },
    };
  }

  if (!chosen) {
    const unsubs: Array<() => void> = [];
    const row = (s: SectionInfo) => {
      const meta = h("span", { class: "row__meta" }, s.detail);
      const trail = h("span", { class: "row__trail" }, h("span", { class: "row__chevron", "aria-hidden": "true" }, icons.chevronRight()));
      const b = h("button", { class: "row", type: "button", "data-section": s.id }, h("span", { class: "tile tile--sm" }, icons[s.icon]()), h("span", { class: "row__body" }, h("span", { class: "row__title" }, s.label), meta), trail);
      b.addEventListener("click", () => open(s.id));
      if (s.id === "sources") {
        const paint = () => {
          const badge = sourcesBadge();
          meta.textContent = badge.detail ?? s.detail;
          meta.classList.toggle("src-row-meta--warn", badge.count > 0);
          trail.replaceChildren(...(badge.count ? [countPill(badge.count)] : []), h("span", { class: "row__chevron", "aria-hidden": "true" }, icons.chevronRight()));
        };
        paint();
        unsubs.push(onSourcesStatus(paint));
      }
      return b;
    };
    const groups = GROUPS.map((g) =>
      h(
        "section",
        { class: "group" },
        g.label ? h("div", { class: "group__head" }, h("h2", { class: "group__label" }, g.label)) : null,
        h("div", { class: "card card--flush list settings__index" }, ...g.sections.map(row))
      )
    );
    return { el: h("div", { class: "view settings" }, head(), ...groups), destroy: () => unsubs.forEach((u) => u()) };
  }

  const body = section(chosen, { ...sectionCtx, page: true });
  const parent = SUBPAGES[chosen] ?? null;
  const back = h("button", { class: "settings__back", type: "button" }, icons.back(), parent ? SECTIONS.find((s) => s.id === parent)!.label : "Settings");
  back.addEventListener("click", () => open(parent));
  return { el: h("div", { class: "view settings settings--page" }, h("div", { class: "settings__page-head" }, back), body.el), destroy: body.destroy };
}
