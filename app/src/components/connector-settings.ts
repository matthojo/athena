/**
 * Settings pages for where Athena reads from (views/settings.ts):
 *
 * - Sources (#/settings/sources; #/settings/accounts and …/collections open
 *   it too): one health line, a card per problem whose button is the fix,
 *   then what Athena collects, then the accounts it reads. On desktop the
 *   two lists sit side by side. A sign-in comes back to
 *   #/settings/accounts?connected=<id>, which opens the connected sheet
 *   (components/account-connected.ts) with its collection offer.
 * - Voice (#/settings/voice): ElevenLabs, Athena's voice in Ask's Talk
 *   (components/voice-connection.ts), shown in full on its page.
 * - From your iPhone (#/settings/iphone): the Siri and share-sheet Shortcut
 *   (components/shortcut-panel.ts), shown in full on its page.
 *
 * An account or a collection opens in a sheet (connector-detail.ts,
 * collection-detail.ts); a collection can open one of its accounts on top.
 * The words for health and problems come from lib/sources-health.ts, so the
 * cards, the Settings row and the status card always agree. Everything
 * here needs a connection: sign-ins live on the server. Offline shows the
 * last known line, greyed and dated.
 */

import { savedShortcutPanel } from "./saved-shortcut";
import "../styles/sources.css";
import { h } from "../lib/dom";
import { icons, type IconName } from "./icons";
import { openSheet } from "./sheet";
import { mailRulesGroup } from "./mail-rules";
import { sampleMailPort } from "../db/sample-mail";
import { showToast } from "./toast";
import { brandLogo, connectorLogo } from "./brand-logo";
import { accountDetail, accountProblem, type DetailContext, type DetailView } from "./connector-detail";
import { collectionDetail, type CollectionDetailContext } from "./collection-detail";
import { openCollectionForm } from "./collection-form";
import { openAddAccount, startSignIn } from "./connector-forms";
import { openConnected } from "./account-connected";
import { shortcutPanel } from "./shortcut-panel";
import { habitShortcutPanel } from "./habit-shortcut";
import { fileImportsGroup, sampleImportsGroup } from "../views/connect";
import { healthShortcutPanel, iphoneSection } from "./health-shortcut";
import { voiceDetail } from "./voice-connection";
import { healthTime, markSourcesStale, sourcesStatus } from "./status";
import { plural } from "../lib/format";
import { fetchConnectors, fetchRunItems, fetchRuns, isSampleMode } from "../db/api";
import { errorText, RECIPE_ICON } from "../lib/connectors-ui";
import { collectionTitle, quietDays, whenPhrase, type RunLike } from "../lib/collection-words";
import { agoShort, publishSources, type Problem, type SourcesHealth } from "../lib/sources-health";
import { CONNECTOR_CATEGORIES, CONNECTOR_PRESETS, isCustomServer, presetFor, RECIPES } from "../../../lib/connector-presets";
import { takeSourcesAsk } from "../lib/sources-ask";
import type { Collection, Connector, ConnectorsState, RecipeId } from "../types";

export type ConnectorSection = "sources" | "voice" | "iphone";

export const SOURCES_SECTION: { id: "sources"; label: string; detail: string; icon: IconName } = {
  id: "sources",
  label: "Sources",
  detail: "Where Athena reads from, and what it saves",
  icon: "plug",
};

export const TALK_SECTIONS: Array<{ id: "voice" | "iphone"; label: string; detail: string; icon: IconName }> = [
  { id: "voice", label: "Voice", detail: "ElevenLabs, for talking with Athena in Ask", icon: "mic" },
  { id: "iphone", label: "From your iPhone", detail: "Siri, the share sheet, Health and habits", icon: "phone" },
];

const SECTIONS = [SOURCES_SECTION, ...TALK_SECTIONS];

/** Under each heading. Voice has none: its ElevenLabs card says it all. */
const LEDE: Record<ConnectorSection, string | null> = {
  sources: "Where Athena reads from, and what it saves. Anything it writes, like a draft, a moved meeting or a new doc, is something you switched on for that account, and you can undo it.",
  voice: null,
  iphone: "Tell Siri, or share a link from any app, and Athena files it the way Ask does: a to-do, a reminder, a gift idea, a film to watch. It replies with what it did. If it isn't sure, it saves it to your notes to sort later.",
};

const FIRST_RUN_LEDE = "Connect an account and Athena starts saving what matters from it: meetings, emails to act on, what shipped at work, what you watched and played.";

/** How many accounts show before "Show all". */
const FOLD = 6;
/** How many problem cards show before "N more need you". */
const PROBLEM_FOLD = 3;

function sectionShell(id: ConnectorSection, body: HTMLElement, extra: { lede?: HTMLElement; action?: HTMLElement } = {}): HTMLElement {
  const s = SECTIONS.find((x) => x.id === id)!;
  return h(
    "section",
    { class: `settings__section settings__section--${id}`, "aria-labelledby": `settings-${id}` },
    h("div", { class: "src-head" }, h("h2", { class: "settings__heading", id: `settings-${id}` }, icons[s.icon](), s.label), extra.action ?? null),
    extra.lede ?? (LEDE[id] ? h("p", { class: "settings__lede" }, LEDE[id]) : null),
    body
  );
}

/** Why a section can't be set up in sample mode, in that section's own terms. */
const SAMPLE_WHY: Record<ConnectorSection, string> = {
  sources: "Sources run on your own Athena server, so they need a connection rather than sample data.",
  voice: "Athena's voice talks through your own Athena server, so it needs a connection rather than sample data.",
  iphone: "Siri and the share sheet send to your own Athena server, so they need a connection rather than sample data.",
};

function sampleNotice(id: ConnectorSection = "sources"): HTMLElement {
  return h(
    "div",
    { class: "card empty src-empty" },
    h("span", { class: "tile" }, icons.plug()),
    h("p", { class: "empty__title" }, "Connect Athena to set this up"),
    h("p", { class: "empty__sub" }, SAMPLE_WHY[id])
  );
}

/** Sample mode: a Gmail account's "Emails Athena reads", with a day of sample mail behind it. */
function sampleMailGroup(): HTMLElement {
  const sample = { provider: "gmail" };
  const open = () => {
    const body = h(
      "div",
      { class: "note profile conn-detail acct-detail" },
      h("header", { class: "profile__hero conn-hero" }, connectorLogo(sample, "lg"), h("h2", { class: "page-title profile__name" }, "Gmail"), h("p", { class: "profile__sub" }, "Gmail · personal")),
      mailRulesGroup("gmail", sampleMailPort())
    );
    openSheet({ label: "Account", body, variant: "tall" });
  };
  const b = h("button", { class: "btn btn--soft btn--sm acct-history__btn", type: "button", "aria-label": "Try email rules on a sample Gmail account" }, "Try it");
  b.addEventListener("click", open);
  return h(
    "section",
    { class: "group src-group" },
    h("div", { class: "group__head" }, h("h3", { class: "group__label" }, "Email rules to try")),
    h(
      "div",
      { class: "card card--flush list src-list" },
      h("div", { class: "row acct-used" }, connectorLogo(sample, "md"), h("span", { class: "row__body" }, h("span", { class: "row__title" }, "Gmail"), h("span", { class: "row__meta" }, "Choose which emails Athena reads, on a day of sample mail")), b)
    )
  );
}

/** A short word for an account that needs something, matching its card. */
const ACCOUNT_WORD: Record<string, string> = {
  finish: "Finish connecting",
  signin: "Signed out",
  permission: "Needs access",
  admin: "Needs IT admin",
  secret: "Key expired",
  client: "Can't get access",
  key: "Key stopped working",
  settings: "Can't get access",
  down: "Isn't answering",
};

type Tone = "good" | "warn" | "muted" | "running";

/** A status word with a dot. Never colour alone: the word is always there. */
function statusWord(tone: Tone, text: string): HTMLElement {
  return h("span", { class: `src-word src-word--${tone}` }, h("span", { class: "src-word__dot", "aria-hidden": "true" }), text);
}

const chevron = () => h("span", { class: "row__chevron", "aria-hidden": "true" }, icons.chevronRight());

/** Starters by what you get, not by service (first run, and the guided setup's Sources step, app/src/guide/view.ts). */
export const SOURCE_STARTERS: Array<{ recipe: RecipeId; title: string; line: string; category?: string }> = [
  { recipe: "email-digest", title: "Your email", line: "Things to act on, trips and orders" },
  { recipe: "calendar-meetings", title: "Your calendar", line: "What's coming up, and a note per meeting" },
  { recipe: "work-activity", title: "Your work", line: "What shipped, what was decided" },
  { recipe: "life-log", title: "Your downtime", line: "What you watched, listened to, read and played" },
  { recipe: "life-log", category: "health", title: "Your health", line: "Sleep, steps, workouts and weight" },
  { recipe: "life-log", category: "travel", title: "Where you've been", line: "Places, trips and the weather" },
  { recipe: "life-log", category: "habits", title: "Your habits", line: "What you ticked off each day" },
  { recipe: "life-log", category: "money", title: "Your money", line: "What you spent and where, kept private" },
];

/** Wait for a closing sheet's history step before opening the next sheet. */
function afterBack(open: () => void): void {
  let ran = false;
  const go = () => {
    if (ran) return;
    ran = true;
    window.removeEventListener("popstate", go);
    setTimeout(open);
  };
  window.addEventListener("popstate", go);
  setTimeout(go, 400);
}

/** Sources: health, problems, collections and accounts. */
function sourcesSection(opts: { connected: string | null }): { el: HTMLElement; destroy: () => void } {
  const body = h("div", { class: "settings__body src" });
  const lede = h("p", { class: "settings__lede" }, LEDE.sources!);
  const addTop = h("button", { class: "btn btn--primary btn--sm src-add-top", type: "button" }, icons.plus(), "Add an account");
  addTop.addEventListener("click", () => addAccount());
  const el = sectionShell("sources", body, { lede, action: addTop });

  let state: ConnectorsState | null = null;
  let health: SourcesHealth | null = null;
  // Apps you've imported a file from (views/connect.ts).
  const files = fileImportsGroup();
  let destroyed = false;
  let showAll = false;
  let showAllProblems = false;
  let poll: ReturnType<typeof setTimeout> | undefined;
  /** Days since each collection last found something, once its history is in. */
  const quiet = new Map<string, number>();
  /** Problem cards on screen, by key, so a fixed one can fold away. */
  const cards = new Map<string, HTMLElement>();
  /** Fixes in flight (a sign-in leaving for the provider). */
  const busy = new Set<string>();
  // Detail sheets, topmost last (a collection can open one of its accounts on top).
  const sheets: Array<{ close: () => void; refresh: () => void }> = [];

  // ---------- Where things open ----------

  const reload = () => load({ sheets: true });

  const detailCtx: CollectionDetailContext = {
    state: () => state!,
    reload,
    closed: () => sheets.at(-1)?.close(),
    openAccount: (id) => open({ kind: "account", id }),
    openCollection: (id) => open({ kind: "collection", id }),
    openCollectionForm: (init) => openForm(init),
    fetchRunItems: (collectionId, runId) => fetchRunItems(collectionId, runId),
    // Called just after the collection sheet closes, so wait for that to settle.
    addAccount: (filter) => afterBack(() => addAccount(filter.recipe)),
    signIn: (id) => signIn(id),
  };

  type Sel = { kind: "account" | "collection"; id: string };

  function build(sel: Sel): DetailView | null {
    if (!state) return null;
    if (sel.kind === "account") {
      const c = state.connectors.find((x) => x.id === sel.id);
      return c ? accountDetail(c, detailCtx as DetailContext) : null;
    }
    const c = state.collections.find((x) => x.id === sel.id);
    return c ? collectionDetail(c, detailCtx) : null;
  }

  function open(sel: Sel) {
    let current = build(sel);
    if (!current) return;
    const holder = h("div", { class: "src-sheet" }, current.el);
    const entry = {
      close: () => sheet.close(),
      // A reload (a toggle, a check, a run finishing) re-renders the open sheet in place.
      refresh: () => {
        const next = build(sel);
        if (!next) return sheet.close();
        const scroller = holder.closest(".sheet__scroll");
        const top = scroller?.scrollTop ?? 0;
        current?.destroy();
        current = next;
        holder.replaceChildren(next.el);
        if (scroller) scroller.scrollTop = top;
      },
    };
    const sheet = openSheet({
      label: sel.kind === "account" ? "Account" : "Collection",
      body: holder,
      variant: "tall",
      onClose: () => {
        current?.destroy();
        current = null;
        const i = sheets.indexOf(entry);
        if (i >= 0) sheets.splice(i, 1);
      },
    });
    sheets.push(entry);
  }

  /** #/settings/sources?add=travel (Leave by's link, app/src/lib/sources-ask.ts): the directory, at that group, once. */
  function openAskedGroup() {
    const group = takeSourcesAsk();
    if (group && CONNECTOR_CATEGORIES.some((c) => c.id === group)) addAccount(undefined, group);
  }

  function addAccount(recipe?: RecipeId, category?: string) {
    if (!state) return;
    if (!state.setup.encryption) {
      showToast("Add the server setting at the top first", { icon: "close", timeoutMs: 5000 });
      return;
    }
    openAddAccount(state, () => void reload(), {
      recipe,
      category,
      connected: { reload, openCollection: (id) => open({ kind: "collection", id }), openCollectionForm: (init) => openForm(init) },
    });
  }

  /** The collection form, new (a recipe or the picker) or filled in. */
  function openForm(init: { recipe: RecipeId; connectorIds?: string[]; label?: string } | null) {
    if (!state) return;
    openCollectionForm(state, init, (saved) => void reload().then(() => saved && open({ kind: "collection", id: saved.id })), {
      addAccount: (filter) => afterBack(() => addAccount(filter.recipe)),
    });
  }

  async function signIn(id: string): Promise<void> {
    const c = state?.connectors.find((x) => x.id === id);
    if (!c) return;
    if ((await startSignIn(c)) === "done") await reload();
  }

  async function runFix(p: Problem, btn: HTMLButtonElement) {
    const fix = p.fix;
    if (!fix) return;
    if (fix.kind === "account") return open({ kind: "account", id: fix.connectorId });
    if (fix.kind === "collection") return open({ kind: "collection", id: fix.collectionId });
    if (fix.kind === "add") return addAccount(fix.recipe);
    if (fix.kind === "copy") {
      try {
        await navigator.clipboard.writeText(fix.text);
        showToast(`Copied ${fix.text}`, { icon: "check" });
      } catch {
        showToast(`Couldn't copy. The setting is ${fix.text}`, { icon: "close", timeoutMs: 6000 });
      }
      return;
    }
    // A sign-in leaves for the provider at once.
    busy.add(p.key);
    btn.disabled = true;
    btn.textContent = "Opening…";
    try {
      await signIn(fix.connectorId);
    } catch (err) {
      showToast(errorText(err, "Couldn't start the sign-in"), { icon: "close", timeoutMs: 6000 });
    } finally {
      busy.delete(p.key);
      if (btn.isConnected) {
        btn.disabled = false;
        btn.textContent = p.button ?? "";
      }
    }
  }

  // ---------- Pieces ----------

  const healthEl = h("div", { class: "src-health", role: "status" });
  const problemsEl = h("ul", { class: "src-problems", role: "list" });
  // One landmark for the problem cards, so a screen reader can jump straight to them.
  const needsEl = h("section", { class: "src-needs", "aria-label": "Needs you" }, problemsEl);
  /** What the status line last said, so a repaint with the same words isn't announced again. */
  let healthSaid = "";

  function paintHealth(hl: SourcesHealth | null, stale?: { at: number; line: string }) {
    const said = stale ? `stale:${stale.line}:${stale.at}` : hl ? `${hl.tone}:${hl.line}:${hl.sub}` : "";
    if (said === healthSaid && healthEl.childElementCount) return;
    healthSaid = said;
    healthEl.className = "src-health";
    if (stale) {
      healthEl.classList.add("src-health--stale");
      healthEl.replaceChildren(
        h("span", { class: "src-health__dot", "aria-hidden": "true" }),
        h("span", { class: "src-health__text" }, h("span", { class: "src-health__line" }, `${stale.line} at ${healthTime(stale.at)}`), h("span", { class: "src-health__sub" }, "Last known. Sources need a connection."))
      );
      return;
    }
    if (!hl || !hl.line) {
      healthEl.hidden = true;
      healthEl.replaceChildren();
      return;
    }
    healthEl.hidden = false;
    healthEl.classList.add(`src-health--${hl.tone}`);
    healthEl.replaceChildren(
      h("span", { class: "src-health__dot", "aria-hidden": "true" }),
      h("span", { class: "src-health__text" }, h("span", { class: "src-health__line" }, hl.line), hl.sub ? h("span", { class: "src-health__sub" }, hl.sub) : null)
    );
  }

  function problemLead(p: Problem): HTMLElement {
    if (p.connector) return connectorLogo(p.connector);
    if (p.recipe) return h("span", { class: "tile tile--sm src-tile" }, icons[RECIPE_ICON[p.recipe]]());
    return h("span", { class: "tile tile--sm src-tile" }, icons.key());
  }

  function problemCard(p: Problem): HTMLElement {
    const fix = p.fix;
    // A server setting: its name as a chip with Copy beside it, on a row of its own so it never breaks mid-word.
    if (fix?.kind === "copy") {
      const copy = h("button", { class: "btn btn--soft btn--sm src-problem__btn", type: "button", "aria-label": p.label }, icons.copy(), "Copy") as HTMLButtonElement;
      copy.addEventListener("click", () => void runFix(p, copy));
      return h(
        "li",
        { class: "src-problem src-problem--warn src-problem--setting", "data-key": p.key },
        h(
          "div",
          { class: "src-problem__inner" },
          problemLead(p),
          h("div", { class: "src-problem__body" }, h("p", { class: "src-problem__title" }, p.title), h("span", { class: "src-problem__line" }, p.line)),
          h("div", { class: "src-problem__setting" }, h("code", { class: "src-problem__code" }, fix.text), copy)
        )
      );
    }
    let btn: HTMLButtonElement | null = null;
    if (p.button && fix) {
      btn = h("button", { class: "btn btn--sm btn--primary src-problem__btn", type: "button", "aria-label": p.label }, p.button) as HTMLButtonElement;
      const b = btn;
      b.addEventListener("click", () => void runFix(p, b));
      if (busy.has(p.key)) {
        b.disabled = true;
        b.textContent = "Opening…";
      }
    }
    return h(
      "li",
      { class: `src-problem src-problem--${p.tone}`, "data-key": p.key },
      h("div", { class: "src-problem__inner" }, problemLead(p), h("div", { class: "src-problem__body" }, h("p", { class: "src-problem__title" }, p.title), h("span", { class: "src-problem__line" }, p.line)), btn)
    );
  }

  /** Keyed: new cards fade in, fixed ones fold up, then the health line changes. */
  function paintProblems(all: Problem[], after: () => void) {
    const folded = !showAllProblems && all.length > PROBLEM_FOLD + 1;
    const list = folded ? all.slice(0, PROBLEM_FOLD) : all;
    let tail: HTMLElement | null = null;
    if (folded) {
      const rest = all.slice(PROBLEM_FOLD);
      const warn = rest.filter((p) => p.tone === "warn").length;
      const b = h("button", { class: "src-problems__more", type: "button", "aria-expanded": "false" }, warn ? `${rest.length} more ${plural(rest.length, "needs", "need")} you` : `Show ${rest.length} more`);
      b.addEventListener("click", () => {
        showAllProblems = true;
        paint();
        problemsEl.querySelector<HTMLElement>(`[data-key="${CSS.escape(rest[0].key)}"] button`)?.focus();
      });
      tail = h("li", { class: "src-problems__tail" }, b);
    }
    const finish = () => {
      if (tail) problemsEl.append(tail);
      needsEl.hidden = problemsEl.hidden;
      after();
    };
    const keep = new Set(list.map((p) => p.key));
    const leaving = [...cards.entries()].filter(([k]) => !keep.has(k));
    const next = list.map((p) => {
      const card = problemCard(p);
      if (!cards.has(p.key) && cards.size) card.classList.add("is-new");
      return card;
    });
    cards.clear();
    list.forEach((p, i) => cards.set(p.key, next[i]));
    const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (!leaving.length) {
      problemsEl.replaceChildren(...next);
      problemsEl.hidden = !list.length;
      finish();
      return;
    }
    // Keep the fixed cards in place for a moment, folding up, then settle.
    const nodes: HTMLElement[] = [];
    const old = [...problemsEl.children] as HTMLElement[];
    for (const o of old) {
      const k = o.dataset.key;
      if (!k) continue; // the old "N more" line goes at once

      if (keep.has(k)) nodes.push(cards.get(k)!);
      else nodes.push(o);
    }
    for (const n of next) if (!nodes.includes(n)) nodes.push(n);
    problemsEl.replaceChildren(...nodes);
    problemsEl.hidden = false;
    for (const [, o] of leaving) {
      const inner = problemsEl.querySelector<HTMLElement>(`[data-key="${CSS.escape(o.dataset.key!)}"]`) ?? o;
      inner.style.height = `${inner.offsetHeight}px`;
      inner.classList.add(reduce ? "is-fading" : "is-leaving");
      requestAnimationFrame(() => (inner.style.height = "0px"));
    }
    setTimeout(() => {
      if (destroyed) return;
      problemsEl.replaceChildren(...next);
      problemsEl.hidden = !list.length;
      finish();
    }, 220);
  }

  function collectionRow(col: Collection): HTMLElement {
    const s = state!;
    const accounts = col.connector_ids.map((id) => s.connectors.find((c) => c.id === id)).filter((c): c is Connector => !!c);
    const names = accounts.map((c) => c.name);
    const title = collectionTitle(col);
    const active = col.schedule === "manual" || col.enabled;
    let word: HTMLElement;
    let meta = [whenPhrase(col), names.join(", ")].filter(Boolean).join(" · ");
    if (col.current_run) word = statusWord("running", col.current_run.status === "queued" ? "Starting" : "Running");
    else if (!active) word = statusWord("muted", "Paused");
    else if (!accounts.length) {
      word = statusWord("warn", "Set up");
      meta = "Needs an account to read from";
    } else if (accounts.some((c) => accountProblem(c) && accountProblem(c)!.kind !== "down") || (col.last_run?.status === "failed" && col.last_run.blocked_by.some((id) => s.connectors.find((c) => c.id === id)?.status !== "connected")))
      word = statusWord("warn", "Waiting");
    else if (col.last_run?.status === "failed") word = statusWord("warn", "Didn't run");
    else if (col.last_run?.finished_at ?? col.last_run_at) word = statusWord("good", agoShort((col.last_run?.finished_at ?? col.last_run_at)!));
    else word = statusWord("muted", "Not run yet");
    const days = quiet.get(col.id) ?? 0;
    const weeks = Math.floor(days / 7);
    const quietLine = active && weeks >= 2 && !col.current_run ? h("span", { class: "src-row__quiet" }, `Nothing new for ${weeks} ${plural(weeks, "week", "weeks")}`) : null;
    const b = h(
      "button",
      { class: `row src-row src-row--collection${active ? "" : " is-paused"}`, type: "button", "data-id": col.id },
      h("span", { class: "tile tile--sm src-tile" }, icons[RECIPE_ICON[col.recipe]]()),
      h("span", { class: "row__body" }, h("span", { class: "row__title" }, title), h("span", { class: "row__meta" }, meta), quietLine),
      h("span", { class: "row__trail" }, word, chevron())
    );
    b.addEventListener("click", () => open({ kind: "collection", id: col.id }));
    return b;
  }

  /** The recipe an unused account would start ("Use it"). */
  // Netflix is import-only: nothing to start on a schedule (lib/presets/netflix.ts).
  const recipeFor = (c: Connector): RecipeId | null => (c.provider === "custom" || c.provider === "netflix" || presetFor(c.provider).live ? null : presetFor(c.provider).recipes.find((r) => r !== "custom") ?? null);

  function accountRow(c: Connector): HTMLElement {
    const s = state!;
    const feeds = s.collections.filter((col) => col.connector_ids.includes(c.id));
    const problem = accountProblem(c);
    const recipe = recipeFor(c);
    const unused = !feeds.length;
    const useIt = unused && !problem && recipe ? h("button", { class: "src-use", type: "button", "aria-label": `Use ${c.name}: start ${RECIPES.find((r) => r.id === recipe)?.label.toLowerCase() ?? "a collection"}` }, "Use it") : null;
    useIt?.addEventListener("click", (e) => {
      e.stopPropagation();
      openForm({ recipe: recipe!, connectorIds: [c.id], label: c.account_label });
    });
    // Live times (lib/presets/flights.ts): read by Athena itself, never a collection.
    const meta = presetFor(c.provider).live?.meta ?? (c.provider === "netflix" ? "Viewing history, from a file" : feeds.length ? `Feeds ${feeds.map((col) => collectionTitle(col)).join(", ")}` : recipe || (isCustomServer(c.provider) && (c as { use_in_ask?: boolean }).use_in_ask !== true) ? "Not used yet" : "Ask can read it");
    const row = h(
      "div",
      { class: "src-row-wrap" },
      h(
        "button",
        { class: "row src-row src-row--account", type: "button", "data-id": c.id },
        connectorLogo(c),
        h("span", { class: "row__body" }, h("span", { class: "row__title" }, c.name), h("span", { class: "row__meta" }, meta)),
        h("span", { class: "row__trail" }, problem ? statusWord(problem.kind === "down" ? "muted" : "warn", problem.kind === "key" && presetFor(c.provider).username ? "New password needed" : (ACCOUNT_WORD[problem.kind] ?? "Needs you")) : null, useIt ? h("span", { class: "src-use-gap" }) : null, chevron())
      ),
      useIt
    );
    row.querySelector("button.src-row")!.addEventListener("click", () => open({ kind: "account", id: c.id }));
    return row;
  }

  function group(label: string, count: number | null, ...children: Array<HTMLElement | null>): HTMLElement {
    return h(
      "section",
      { class: "group src-group" },
      h("div", { class: "group__head" }, h("h3", { class: "group__label" }, label, count !== null ? h("span", { class: "src-group__count" }, ` · ${count}`) : null)),
      ...children
    );
  }

  function collectingGroup(s: ConnectorsState): HTMLElement {
    const start = h("button", { class: "src-more", type: "button" }, icons.plus(), "Start collecting");
    start.addEventListener("click", () => openForm(null));
    // Running first, then the ones that need you, then the rest; paused last.
    const rank = (c: Collection) => (c.current_run ? 0 : c.schedule !== "manual" && !c.enabled ? 3 : health?.problems.some((p) => p.key === `collection:${c.id}`) ? 1 : 2);
    const cols = [...s.collections].sort((a, b) => rank(a) - rank(b));
    if (!cols.length) {
      return group(
        "Collecting",
        null,
        h(
          "div",
          { class: "card src-card src-card--empty" },
          h("p", { class: "src-card__title" }, "Nothing collecting yet"),
          h("p", { class: "src-card__sub" }, "Pick what Athena should save from your accounts. The first run shows you what it finds."),
          start
        )
      );
    }
    return group("Collecting", null, h("div", { class: "card card--flush list src-list" }, ...cols.map(collectionRow), start));
  }

  function accountsGroup(s: ConnectorsState): HTMLElement {
    // Accounts that need you first, so the fold never hides one.
    const all = [...s.connectors].sort((a, b) => Number(!accountProblem(a)) - Number(!accountProblem(b)));
    const shown = showAll || all.length <= FOLD ? all : all.slice(0, FOLD);
    const more = all.length > FOLD ? h("button", { class: "src-more src-more--center", type: "button", "aria-expanded": String(showAll) }, showAll ? "Show fewer" : `Show all ${all.length} accounts`) : null;
    more?.addEventListener("click", () => {
      showAll = !showAll;
      paint();
      if (!showAll) el.querySelector<HTMLElement>(".src-group--accounts")?.scrollIntoView({ block: "nearest" });
    });
    const g = group("Accounts", all.length, h("div", { class: "card card--flush list src-list" }, ...shown.map(accountRow), more));
    g.classList.add("src-group--accounts");
    return g;
  }

  function foot(first = false): HTMLElement {
    return h("p", { class: "src-foot" }, icons.shield(), first ? "It only reads. Sign-ins are kept encrypted on Athena's server." : "Sign-ins are kept encrypted on Athena's server. This device never holds them.");
  }

  /** Before any account: starters by what you'd get. */
  function firstRun(s: ConnectorsState): HTMLElement[] {
    const ready = s.setup.encryption;
    const card = (st: (typeof SOURCE_STARTERS)[number]) => {
      const logos = CONNECTOR_PRESETS.filter((p) => p.id !== "custom" && p.recipes.includes(st.recipe) && (st.category ? p.category === st.category : p.category !== "health" && p.category !== "travel")).slice(0, 3);
      const b = h(
        "button",
        { class: "card src-starter", type: "button", disabled: !ready, "aria-label": `${st.title}: ${st.line}. Choose a service` },
        h("span", { class: "src-starter__body" }, h("span", { class: "src-starter__title" }, st.title), h("span", { class: "src-starter__line" }, st.line), h("span", { class: "src-starter__logos", "aria-hidden": "true" }, ...logos.map((p) => brandLogo(p.id, "sm")))),
        chevron()
      );
      b.addEventListener("click", () => addAccount(st.recipe, st.category));
      return b;
    };
    const browse = h("button", { class: "src-browse", type: "button", disabled: !ready }, "Browse all services");
    browse.addEventListener("click", () => addAccount());
    return [
      h("div", { class: "src-starters" }, ...SOURCE_STARTERS.map(card)),
      ready ? browse : h("p", { class: "src-note" }, "These work once that setting is added."),
    ];
  }

  // ---------- Paint ----------

  function paint() {
    if (!state) return;
    const s = state;
    const empty = !s.connectors.length && !s.collections.length;
    lede.textContent = empty ? FIRST_RUN_LEDE : LEDE.sources!;
    addTop.hidden = empty;
    const bottomAdd = h("button", { class: "btn btn--primary src-add", type: "button" }, icons.plus(), "Add an account");
    bottomAdd.addEventListener("click", () => addAccount());
    const nextHealth = health;
    // The line changes once a fixed card has folded away.
    const settled = () => paintHealth(nextHealth);
    if (!problemsEl.isConnected) settled();
    paintProblems(nextHealth?.problems ?? [], settled);

    body.classList.toggle("src--first", empty);
    body.replaceChildren(
      healthEl,
      needsEl,
      ...(empty ? firstRun(s) : [h("div", { class: "src-cols" }, collectingGroup(s), accountsGroup(s), files.el), h("div", { class: "settings__actions src-actions" }, bottomAdd)]),
      foot(empty)
    );
  }

  function paintOffline() {
    addTop.hidden = true;
    const last = sourcesStatus();
    const retry = h("button", { class: "btn btn--soft btn--sm", type: "button" }, icons.refresh(), "Try again");
    retry.addEventListener("click", () => void load({ sheets: false }));
    if (last?.line) paintHealth(null, { at: last.at, line: last.line });
    body.replaceChildren(
      ...(last?.line ? [healthEl] : []),
      h(
        "div",
        { class: "card empty src-empty" },
        h("span", { class: "tile" }, icons.wifiOff()),
        h("p", { class: "empty__title" }, "Sources need a connection"),
        h("p", { class: "empty__sub" }, "Sign-ins live on your server. This page fills in when you're back online."),
        retry
      ),
      foot()
    );
  }

  function paintError() {
    const retry = h("button", { class: "btn btn--primary btn--sm", type: "button" }, icons.refresh(), "Try again");
    retry.addEventListener("click", () => {
      retry.disabled = true;
      retry.lastChild!.textContent = "Trying…";
      void load({ sheets: false });
    });
    body.replaceChildren(
      h(
        "div",
        { class: "card empty src-empty" },
        h("span", { class: "tile" }, icons.plug()),
        h("p", { class: "empty__title" }, "Couldn't load your sources"),
        h("p", { class: "empty__sub" }, "Athena's server didn't answer. Try again in a moment."),
        retry
      )
    );
  }

  // ---------- Loading ----------

  /** Quiet collections ("Nothing new for 2 weeks"), from each one's history. Best effort. */
  async function loadQuiet(s: ConnectorsState) {
    const cols = s.collections.filter((c) => (c.schedule === "manual" || c.enabled) && c.connector_ids.length && c.last_run?.status === "succeeded" && !c.last_run.saved);
    for (const c of s.collections) if (!cols.includes(c)) quiet.delete(c.id);
    if (!cols.length) return;
    const results = await Promise.all(cols.map((c) => fetchRuns(c.id).then((runs) => [c.id, quietDays(runs as RunLike[])] as const, () => null)));
    if (destroyed) return;
    let changed = false;
    for (const r of results) {
      if (!r || quiet.get(r[0]) === r[1]) continue;
      quiet.set(r[0], r[1]);
      changed = true;
    }
    if (changed && state === s) paint();
  }

  async function load(o: { sheets: boolean }): Promise<void> {
    clearTimeout(poll);
    if (isSampleMode()) {
      addTop.hidden = true;
      body.replaceChildren(sampleNotice(), sampleMailGroup(), sampleImportsGroup());
      return;
    }
    if (!navigator.onLine) {
      markSourcesStale();
      addTop.hidden = true;
      paintOffline();
      return;
    }
    try {
      const next = await fetchConnectors();
      if (destroyed) return;
      if (!next || !Array.isArray(next.connectors) || !Array.isArray(next.collections) || !next.setup) throw new Error("Unexpected reply from /api/connectors");
      state = next;
      health = publishSources(next);
      paint();
      openAskedGroup();
      if (o.sheets) for (const sh of [...sheets]) sh.refresh();
      void loadQuiet(next);
      // Something running: look again shortly, so Running turns into what it saved.
      if (health.running.length) poll = setTimeout(() => void load({ sheets: false }), 5000);
    } catch (err) {
      if (destroyed) return;
      console.error("Athena: couldn't load sources", err);
      markSourcesStale();
      addTop.hidden = true;
      if (!navigator.onLine) paintOffline();
      else paintError();
    }
  }

  const onOnline = () => void load({ sheets: false });
  const onOffline = () => {
    markSourcesStale();
    if (!sheets.length) paintOffline();
  };
  window.addEventListener("online", onOnline);
  window.addEventListener("offline", onOffline);

  addTop.hidden = true;
  body.replaceChildren(
    h("div", { class: "src-health src-health--loading", "aria-hidden": "true" }, h("span", { class: "skeleton", style: "height:14px;width:42%" })),
    h(
      "div",
      { class: "card card--flush list" },
      ...[0, 1, 2].map(() => h("div", { class: "row" }, h("span", { class: "tile tile--sm skeleton" }), h("span", { class: "row__body" }, h("span", { class: "skeleton", style: "height:12px;width:45%" }), h("span", { class: "skeleton", style: "height:10px;width:30%;margin-top:var(--space-2xs-xs)" })), h("span", {})))
    )
  );
  void load({ sheets: false }).then(() => {
    // Back from a provider's sign-in: say so, and offer what to collect.
    if (!opts.connected || !state) return;
    if (!state.connectors.some((x) => x.id === opts.connected)) return;
    openConnected(state, opts.connected, { reload, openCollection: (id) => open({ kind: "collection", id }), openCollectionForm: (init) => openForm(init) });
  });

  return {
    el,
    destroy() {
      destroyed = true;
      clearTimeout(poll);
      window.removeEventListener("online", onOnline);
      window.removeEventListener("offline", onOffline);
      for (const sh of [...sheets].reverse()) sh.close();
    },
  };
}

/** One of the pages in Settings' "Your sources" and "Talk and capture" groups. */
export function connectorSection(id: ConnectorSection, opts: { connected: string | null; go: (section: ConnectorSection | "api-keys") => void }): { el: HTMLElement; destroy: () => void } {
  if (id === "sources") return sourcesSection(opts);
  if (isSampleMode()) return { el: sectionShell(id, h("div", { class: "settings__body" }, sampleNotice(id))), destroy: () => undefined };
  if (id === "voice") {
    const detail = voiceDetail({ changed: () => undefined });
    return { el: sectionShell(id, h("div", { class: "settings__body settings__voice" }, detail.el)), destroy: detail.destroy };
  }
  const manageKeys = () => opts.go("api-keys");
  const page = iphoneSection(shortcutPanel({ manageKeys }), () => healthShortcutPanel({ manageKeys }), () => habitShortcutPanel({ manageKeys }), () => savedShortcutPanel({ manageKeys }));
  return { el: sectionShell(id, h("div", { class: "settings__body" }, page.el), { lede: page.lede }), destroy: () => undefined };
}
