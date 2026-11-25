/**
 * Athena PWA entry point: connect vs. app shell, routing between Home /
 * Notes / Ask, the capture and note sheets, keyboard shortcuts, and driving
 * sync (on load and on reconnect — no Background Sync, which iOS Safari
 * doesn't reliably support).
 *
 * Routes live in the hash (#/notes?source=work-activity, #/notes/<id>,
 * #/ask, #/kind/<kind id>/<record id> for the owner's own kinds of record)
 * and are replaced, not pushed, on tab switches — tabs aren't a back stack.
 * Sheets push their own history entry so system back closes them.
 */

import { syncMoodStyle } from "./components/day-mood";
import { h, mount } from "./lib/dom";
import { askKeyAction, isJumpKey } from "./lib/ask-keys";
import { openAsk } from "./lib/open-ask";
import { dock, sidebar, viewLabel, type ViewId } from "./components/nav";
import { setPageSection } from "./lib/page-title";
import { isKindView, kindIdOf, kindView, parseCheckin, parseRoute, RECORD_VIEWS, routeHash, VIEW_FOR_KIND, type Route } from "./lib/routes";
import { noteSourcesAsk } from "./lib/sources-ask";
import { findCustomRecord, onKindsChange, primeKinds } from "./db/custom-kinds";
import { primeContexts } from "./db/todo-contexts";
import { groupLoops, loadCommitments, loadSuggestions, onMemoryChange, openLoops } from "./db/memory";
import { findRecord } from "./db/records";
import { markSourcesStale, statusButton, type StatusActions } from "./components/status";
import { mountToastStack, showToast } from "./components/toast";
import { renderConnect } from "./views/connect";
import { renderHome } from "./views/home";
import { exitSampleMode, fetchConnectors, hasToken, isSampleMode, saveTimeZone, setSampleMode, swapMasterForKey } from "./db/api";
import { deviceZone, localToday } from "./lib/time";
import { lifeLogDate } from "./components/day-words";
import { onSyncChange, runSync } from "./db/sync";
import { startLive } from "./live";
import { findNote, onNotes, onStatus, refreshNotes, refreshStatus, setSyncing } from "./db/data";
import { withTransition } from "./lib/motion";
import { setLinkData } from "./editor/link-data";
import { realLinkData } from "./editor/link-data-real";
import { watchStickyHeads } from "./lib/sticky-head";
import { followDayPart } from "./lib/format";
import { setAppOpenLink } from "./lib/app-links";
import type { AnyRecord, CustomRecord, EntityKind, Note, RecordKind } from "./types";

const root = document.getElementById("app")!;
const desktop = window.matchMedia("(min-width: 1024px)");
const coarse = window.matchMedia("(pointer: coarse)");

interface MountedView {
  el: HTMLElement;
  destroy: () => void;
  focusSearch?: () => void;
}

interface Chunk<T> {
  /** The module, once it has arrived; null before then. */
  now: () => T | null;
  load: () => Promise<T>;
}

/**
 * Code that loads on first use. Only Home and the app's chrome are in the
 * entry chunk, so the first screen paints sooner on a phone; every other view
 * and the note and record sheets are chunks of their own, fetched when first
 * needed and in the background once the first screen is up (see `prefetch`).
 * Once a chunk is here, `now()` hands its module straight back, so opening it
 * again is synchronous, exactly as a static import was.
 */
function chunk<T>(importer: () => Promise<T>): Chunk<T> {
  let mod: T | null = null;
  let pending: Promise<T> | null = null;
  return {
    now: () => mod,
    load: () =>
      (pending ??= importer().then(
        (m) => (mod = m),
        (err) => {
          pending = null; // offline before the chunk was cached: try again next time
          throw err;
        }
      )),
  };
}

const chunks = {
  // The note and record sheets open from Home, so they come first.
  noteDetail: chunk(() => import("./components/note-detail")),
  recordProfile: chunk(() => import("./components/record-profile")),
  customRecordProfile: chunk(() => import("./components/custom-record-profile")),
  customRecords: chunk(() => import("./views/custom-records")),
  notes: chunk(() => import("./views/notes")),
  records: chunk(() => import("./views/records")),
  ask: chunk(() => import("./views/ask")),
  library: chunk(() => import("./views/library")),
  jump: chunk(() => import("./components/jump")),
  week: chunk(() => import("./views/week")),
  loops: chunk(() => import("./views/loops")),
  review: chunk(() => import("./views/review")),
  reading: chunk(() => import("./views/reading")),
  // Music (with styles/music.css): top artists and albums, the timeline, recent days.
  music: chunk(() => import("./views/music")),
  // Work (with styles/work.css): what you closed, merged and reviewed, from the work sync.
  work: chunk(() => import("./views/work")),
  // Saved (with styles/saved.css): links, images, quotes and the share target's landing.
  saved: chunk(() => import("./views/saved")),
  team: chunk(() => import("./views/team")),
  // Flows (with styles/flows.css): the list, the editor and a run's page.
  flows: chunk(() => import("./views/flows")),
  // Community (with styles/community.css): the catalogue of shared assistants, skills and flows.
  community: chunk(() => import("./community/page")),
  // Add (app/src/add/): the preview every shared assistant, skill and flow goes through.
  add: chunk(() => import("./add/view")),
  // Recipes (with styles/recipes.css): the grid, a recipe, cook mode, the week plan and the grocery list.
  recipes: chunk(() => import("./views/recipes")),
  goals: chunk(() => import("./views/goals")),
  // The Library's Health page (with styles/health.css).
  health: chunk(() => import("./views/health")),
  // The Library's Habits and Money pages (with styles/life.css).
  habits: chunk(() => import("./views/habits")),
  money: chunk(() => import("./views/money")),
  // House (with styles/house.css): energy, its cost, household bills, house admin.
  house: chunk(() => import("./views/house")),
  // Days (with styles/days.css): the feed, a day, the calendar, recaps and search.
  days: chunk(() => import("./views/days")),
  admin: chunk(() => import("./views/admin")),
  archived: chunk(() => import("./views/archived")),
  settings: chunk(() => import("./views/settings")),
  // The Graph, with its renderer and d3-force.
  graph: chunk(() => import("./views/graph")),
  // Trips and Purchases (with styles/trips.css): also what Home's Coming up opens.
  trips: chunk(() => import("./views/trips")),
  purchases: chunk(() => import("./views/purchases")),
};

// Safari has no requestIdleCallback: wait a moment instead.
const whenIdle = (fn: () => void, wait = 1500) => (window.requestIdleCallback ? window.requestIdleCallback(fn, { timeout: wait * 2 }) : setTimeout(fn, wait));

/**
 * Once the first screen has painted and the device is idle, load the other
 * chunks one after another (warming the note editor first, as before), so
 * moving around stays instant. Offline they come from the service worker's
 * cache; any that aren't there yet are tried again once there's a connection.
 */
function prefetch(steps: (() => Promise<unknown>)[] = [() => chunks.noteDetail.load().then((m) => m.warmEditor()), ...Object.values(chunks).map((c) => c.load)]) {
  const failed: typeof steps = [];
  const next = () => {
    const step = steps.shift();
    if (step) {
      step()
        .catch(() => failed.push(step))
        .finally(() => whenIdle(next, 50));
    } else if (failed.length) {
      window.addEventListener("online", () => prefetch(failed), { once: true });
    }
  };
  whenIdle(next);
}

/**
 * A view from a chunk: rendered at once if the chunk is here, otherwise a
 * placeholder now, swapped for the view when its chunk arrives.
 */
function lazyView<T>(c: Chunk<T>, make: (m: T) => MountedView): MountedView {
  const ready = c.now();
  if (ready) return make(ready);
  const el = h("div", { class: "view", "aria-busy": "true" });
  let view: MountedView | null = null;
  let dead = false;
  const holder: MountedView = {
    el,
    destroy() {
      dead = true;
      view?.destroy();
    },
  };
  c.load()
    .then((m) => {
      if (dead) return;
      view = make(m);
      holder.focusSearch = view.focusSearch;
      el.replaceWith(view.el);
    })
    .catch(() => {
      el.removeAttribute("aria-busy");
      el.replaceChildren(
        h("div", { class: "empty" }, h("p", { class: "empty__title" }, "This page didn't load"), h("p", { class: "empty__sub" }, "It needs a connection the first time. Check you're online and try again."))
      );
    });
  return holder;
}

/** Run something from a chunk: at once if it's here, otherwise when it arrives. */
function withChunk<T>(c: Chunk<T>, run: (m: T) => void): void {
  const ready = c.now();
  if (ready) return run(ready);
  c.load().then(run, () => showToast("That didn't load. It needs a connection the first time", { icon: "wifiOff" }));
}

const openNoteSheet: typeof import("./components/note-detail").openNoteSheet = (note, opts) =>
  withChunk(chunks.noteDetail, (m) => m.openNoteSheet(note, opts));
const openRecordSheet: typeof import("./components/record-profile").openRecordSheet = (kind, rec, opts) =>
  withChunk(chunks.recordProfile, (m) => m.openRecordSheet(kind, rec, opts));
const openCustomRecordSheet: typeof import("./components/custom-record-profile").openCustomRecordSheet = (kindId, rec, opts) =>
  withChunk(chunks.customRecordProfile, (m) => m.openCustomRecordSheet(kindId, rec, opts));

function ensureAurora() {
  if (!document.querySelector(".aurora")) {
    document.body.append(h("div", { class: "aurora", "aria-hidden": "true" }, h("span", {}), h("span", {})));
  }
}

// Switches and checkboxes take focus too, but never bring up a keyboard.
const isTypingTarget = (t: EventTarget | null) =>
  t instanceof HTMLElement && (t.matches("input:not([type=checkbox], [type=radio], [type=range]), textarea, select") || t.isContentEditable);

function mountShell() {
  ensureAurora();
  const main = h("main", { class: "main", id: "main" });

  async function syncNow() {
    setSyncing();
    await runSync();
    await refreshNotes();
    showToast("Up to date", { icon: "check" });
  }

  /**
   * Sign out removes everything from this device (db/sign-out.ts), so changes
   * the server doesn't have yet would be lost: say so first, and offer to
   * send them.
   */
  let signingOut = false;
  async function signOut() {
    if (signingOut) return;
    const { unsentCount, sendUnsent, wipeDevice } = await import("./db/sign-out");
    const waiting = (n: number) => `${n} ${n === 1 ? "change hasn't" : "changes haven't"} been sent`;
    const unsent = await unsentCount().catch(() => 0);
    if (unsent) {
      // The dialog's checkbox is styled in attachments.css, which components/attachments brings with it; it may not have loaded yet.
      const [{ confirmChoice, confirmDialog }] = await Promise.all([import("./components/confirm"), import("./components/attachments").catch(() => undefined)]);
      const answer = await confirmChoice({
        title: `${waiting(unsent)} yet`,
        body: "Unsent changes are only on this device, and signing out removes everything Athena keeps here.",
        confirmLabel: "Send, then sign out",
        choice: { label: "Sign out without sending", detail: "Unsent changes will be lost.", confirmLabel: "Sign out anyway" },
        danger: false,
      });
      if (!answer) return;
      if (!answer.choice) {
        showToast("Sending your changes…", { icon: "cloud" });
        const left = await sendUnsent();
        if (left && !(await confirmDialog({ title: `${waiting(left)}`, body: "Athena couldn't take everything just now. Sign out anyway and what's left is lost, or cancel and try again when you're online.", confirmLabel: "Sign out anyway", danger: true }))) return;
      }
    }
    signingOut = true;
    await wipeDevice();
    location.assign("/logout");
  }

  const statusActions: StatusActions = {
    syncNow: () => void syncNow(),
    signOut: () => void signOut(),
    connect: exitSampleMode,
    open: (view) => go(view),
  };

  const statusBtn = statusButton(statusActions);
  const side = sidebar({ go, compose, jump }, statusActions);
  const nav = dock({ go, compose, jump });

  mount(root, h("div", { class: "shell" }, side.el, main, nav.el));
  root.append(mountToastStack());
  watchStickyHeads();

  // The owner's own kinds of record: their sections in the sidebar, kept current.
  void primeKinds();
  // To-do contexts, for To do's chips and the jump list.
  void primeContexts();

  let route = parseRoute(location.hash);
  let current: MountedView | null = null;

  function render(opts: { focusSearch?: boolean } = {}) {
    current?.destroy();
    main.dataset.view = route.view;
    nav.setActive(route.view);
    side.setActive(route.view);
    // The tab's title follows the page (lib/page-title.ts); an open note or record adds its own name.
    setPageSection(route.view, viewLabel(route.view));

    if (route.view === "library") {
      current = lazyView(chunks.library, ({ renderLibrary }) => renderLibrary({ go: (view, opts) => go(view, { noteId: opts?.noteId ?? null }) }));
    } else if (route.view === "home") {
      current = renderHome({
        openNote,
        openLink: (k, id) => void openLink(k, id),
        goNotes: (source) => go("notes", { source }),
        go: (view) => go(view),
        openTrip: (id) => openLogistics("trips", id),
        openPurchase: (id) => openLogistics("purchases", id),
        compose,
        statusEl: statusBtn.el,
      });
    } else if (route.view === "notes") {
      const { source, noteId } = route;
      current = lazyView(chunks.notes, ({ renderNotes }) =>
        renderNotes({
          source,
          noteId,
          focusSearch: !!opts.focusSearch,
          isDesktop: () => desktop.matches,
          openNote,
          openLink,
          compose,
          go: (view) => go(view),
          onSelectionChange(source, noteId) {
            route = { view: "notes", source, noteId };
            history.replaceState(history.state, "", routeHash(route));
            side.setActive("notes");
          },
        })
      );
    } else if (RECORD_VIEWS[route.view]) {
      const kind = RECORD_VIEWS[route.view]!;
      const recordId = route.noteId;
      current = lazyView(chunks.records, ({ renderRecords }) =>
        renderRecords({
          kind,
          recordId,
          isDesktop: () => desktop.matches,
          openRecord: (k, rec) => openRecord(k, rec),
          newRecord: (k) => openRecordSheet(k, null, { openLink }),
          openLink,
          go: (view) => go(view),
          onSelectionChange(id) {
            route = { ...route, noteId: id };
            history.replaceState(history.state, "", routeHash(route));
          },
        })
      );
    } else if (isKindView(route.view)) {
      const kindId = kindIdOf(route.view);
      const recordId = route.noteId;
      current = lazyView(chunks.customRecords, ({ renderCustomRecords }) =>
        renderCustomRecords({
          kindId,
          recordId,
          isDesktop: () => desktop.matches,
          openRecord: (rec) => openCustomRecord(rec),
          newRecord: (id) => openCustomRecordSheet(id, null, { openLink }),
          openLink,
          go: (view) => go(view),
          onSelectionChange(id) {
            route = { ...route, noteId: id };
            history.replaceState(history.state, "", routeHash(route));
          },
        })
      );
    } else if (route.view === "archived") {
      current = lazyView(chunks.archived, ({ renderArchived }) => renderArchived());
    } else if (route.view === "loops") {
      current = lazyView(chunks.loops, ({ renderLoops }) => renderLoops({ go: (view) => go(view) }));
    } else if (route.view === "review") {
      current = lazyView(chunks.review, ({ renderReview }) => renderReview());
    } else if (route.view === "week") {
      current = lazyView(chunks.week, ({ renderWeek }) => renderWeek({ openLink: (k, id) => void openLink(k, id), go: (view) => go(view) }));
    } else if (route.view === "admin") {
      current = lazyView(chunks.admin, ({ renderAdmin }) => renderAdmin({ go: (view) => go(view) }));
    } else if (route.view === "reading") {
      current = lazyView(chunks.reading, ({ renderReading }) => renderReading({ go: (view) => go(view) }));
    } else if (route.view === "team") {
      const param = route.noteId;
      current = lazyView(chunks.team, ({ renderTeam }) => renderTeam({ go: (view, opts) => go(view, opts), param }));
    } else if (route.view === "flows") {
      const param = route.noteId;
      current = lazyView(chunks.flows, ({ renderFlows }) => renderFlows({ go: (view, opts) => go(view, opts), param }));
    } else if (route.view === "community") {
      const query = route.source;
      current = lazyView(chunks.community, ({ renderCommunity }) => renderCommunity({ query, go: (view) => go(view) }));
    } else if (route.view === "add") {
      current = lazyView(chunks.add, ({ renderAdd }) => renderAdd({ go: (view, opts) => go(view, opts) }));
    } else if (route.view === "saved") {
      const itemId = route.noteId;
      current = lazyView(chunks.saved, ({ renderSaved }) => renderSaved({ go: (view, opts) => go(view, opts), itemId, isDesktop: () => desktop.matches }));
    } else if (route.view === "recipes") {
      const path = route.noteId;
      current = lazyView(chunks.recipes, ({ renderRecipes }) => renderRecipes({ go: (view, opts) => go(view, opts), path, isDesktop: () => desktop.matches }));
    } else if (route.view === "health") {
      current = lazyView(chunks.health, ({ renderHealth }) => renderHealth({ go: (view, opts) => go(view, opts) }));
    } else if (route.view === "habits") {
      current = lazyView(chunks.habits, ({ renderHabits }) => renderHabits({ go: (view) => go(view) }));
    } else if (route.view === "money") {
      current = lazyView(chunks.money, ({ renderMoney }) => renderMoney({ go: (view) => go(view) }));
    } else if (route.view === "music") {
      current = lazyView(chunks.music, ({ renderMusic }) => renderMusic({ go: (view) => go(view) }));
    } else if (route.view === "work") {
      current = lazyView(chunks.work, ({ renderWork }) => renderWork({ go: (view) => go(view) }));
    } else if (route.view === "house") {
      current = lazyView(chunks.house, ({ renderHouse }) => renderHouse({ go: (view) => go(view) }));
    } else if (route.view === "days") {
      const { noteId: path, source: query } = route;
      current = lazyView(chunks.days, ({ renderDays }) =>
        renderDays({ path, query, isDesktop: () => desktop.matches, go: (view, opts) => go(view, opts), openLink: (k, id) => void openLink(k, id) })
      );
    } else if (route.view === "goals") {
      current = lazyView(chunks.goals, ({ renderGoals }) => renderGoals({ go: (view) => go(view) }));
    } else if (route.view === "settings") {
      const section = route.noteId;
      const connected = route.source;
      route = { ...route, source: null };
      noteSourcesAsk(location.hash);
      // Tidy the address: a sign-in's ?connected=, or an old #/connectors link.
      if (location.hash !== routeHash(route)) history.replaceState(history.state, "", routeHash(route));
      current = lazyView(chunks.settings, ({ renderSettings }) => renderSettings({ go: (view, opts) => go(view, opts), section, connected, isDesktop: () => desktop.matches }));
    } else if (route.view === "graph") {
      const focusId = route.noteId;
      current = lazyView(chunks.graph, ({ renderGraph }) =>
        renderGraph({
          focusId,
          openLink: (k, id) => void openLink(k, id),
          go: (view) => go(view),
          onSelectionChange(id) {
            if (route.view !== "graph") return;
            route = { ...route, noteId: id };
            history.replaceState(history.state, "", routeHash(route));
          },
        })
      );
    } else if (route.view === "trips" || route.view === "purchases") {
      const view = route.view;
      const id = route.noteId;
      const selection = {
        isDesktop: () => desktop.matches,
        go: (v: ViewId) => go(v),
        onSelectionChange(next: string | null) {
          if (route.view !== view) return;
          route = { ...route, noteId: next };
          history.replaceState(history.state, "", routeHash(route));
        },
      };
      current =
        view === "trips"
          ? lazyView(chunks.trips, ({ renderTrips }) => renderTrips({ ...selection, tripId: id }))
          : lazyView(chunks.purchases, ({ renderPurchases }) => renderPurchases({ ...selection, purchaseId: id }));
    } else {
      // A nudge's push: Ask opens on it (lib/ask-nudge.ts), and the address goes back to #/ask.
      if (route.noteId) {
        const nudgeId = route.noteId;
        route = { ...route, noteId: null };
        history.replaceState(history.state, "", "#/ask");
        void import("./lib/ask-nudge").then(({ openAskFromNudge }) => openAskFromNudge(nudgeId));
      }
      current = lazyView(chunks.ask, ({ renderAsk }) => renderAsk({ openNote, openLink: (k, id) => void openLink(k, id) }));
    }
    mount(main, current.el);
  }

  /** A trip or purchase from Home's Coming up: the page's pane on desktop, a sheet on a phone. */
  function openLogistics(view: "trips" | "purchases", id: string) {
    if (desktop.matches) return go(view, { noteId: id });
    if (view === "trips") withChunk(chunks.trips, (m) => void m.openTripSheet(id));
    else withChunk(chunks.purchases, (m) => void m.openPurchaseSheet(id));
  }

  function go(view: ViewId, opts: { source?: string | null; noteId?: string | null; focusSearch?: boolean } = {}) {
    // Reminders lives in Settings now (the status menu and old links still ask for it by name).
    if (view === "reminders") return go("settings", { noteId: "reminders" });
    if (view === "notes" && route.view === "notes" && opts.focusSearch && opts.source === undefined && current?.focusSearch) {
      current.focusSearch();
      return;
    }
    const changed = view !== route.view;
    route = { view, source: opts.source ?? null, noteId: opts.noteId ?? null };
    history.replaceState(history.state, "", routeHash(route));
    withTransition(() => {
      render({ focusSearch: opts.focusSearch });
      if (changed) {
        window.scrollTo({ top: 0 });
        main.scrollTop = 0;
      }
    });
  }

  function openNote(note: Note) {
    // An old Life log note opens its day.
    const day = lifeLogDate(note, (iso) => localToday(new Date(iso)));
    if (day) {
      history.pushState(history.state, "", `#/days/${day}`);
      return go("days", { noteId: day });
    }
    if (desktop.matches) go("notes", { noteId: note.id });
    else openNoteSheet(note, { openLink });
  }

  /** Follow an athena:// link or a Linked/Backlinks chip. */
  async function openLink(kind: EntityKind, id: string) {
    // A chip for something in Saved, a to-do or a Watch & read title (lib/links.ts).
    if ((kind as string) === "saved" || (kind as string) === "todo" || (kind as string) === "watch") return void (await (await import("./lib/open-item")).openItem({ kind, id }));
    if (kind === "note") {
      const note = await findNote(id);
      if (note) openNote(note);
      else if (!navigator.onLine) showToast("That note isn't on this device yet. It'll open once you're back online", { icon: "note" });
      else showToast("That note isn't available. It may be archived", { icon: "note" });
      return;
    }
    if (kind === "project") {
      showToast("Projects don't have a page yet", { icon: "project" });
      return;
    }
    if (kind === "record") {
      const rec = await findCustomRecord(id);
      if (rec) openCustomRecord(rec);
      else showToast("That isn't available. It may be archived", { icon: "archive" });
      return;
    }
    if (desktop.matches) {
      go(VIEW_FOR_KIND[kind], { noteId: id });
      return;
    }
    const rec = await findRecord(kind, id);
    if (rec) openRecord(kind, rec);
    else showToast("That isn't available. It may be archived", { icon: "archive" });
  }

  setAppOpenLink((k, id) => void openLink(k, id));

  function openRecord(kind: RecordKind, rec: AnyRecord) {
    if (desktop.matches) go(VIEW_FOR_KIND[kind], { noteId: rec.id });
    else openRecordSheet(kind, rec, { openLink });
  }

  /** A record in one of the owner's own kinds: its kind's pane on desktop, a sheet on a phone. */
  function openCustomRecord(rec: CustomRecord) {
    if (desktop.matches) go(kindView(rec.kind_id), { noteId: rec.id });
    else openCustomRecordSheet(rec.kind_id, rec, { openLink });
  }

  /** ⌘K: open something by name, search notes for what was typed, ask about it, or go to a place. */
  function jump() {
    withChunk(chunks.jump, (m) =>
      m.openJump({
        go: (view, opts) => go(view, { noteId: opts?.noteId ?? null }),
        open: (kind, id) => void openLink(kind as EntityKind, id),
        searchNotes(q) {
          go("notes", { focusSearch: true });
          // The Notes search box takes the words as if typed there.
          requestAnimationFrame(() => {
            const box = main.querySelector<HTMLInputElement>('input[name="q"]');
            if (!box) return;
            box.value = q;
            box.dispatchEvent(new Event("input", { bubbles: true }));
          });
        },
        // "Ask about “…”": Ask, asking it straight away.
        ask: (q) => openAsk({ prompt: q, send: true }),
      })
    );
  }

  function compose() {
    openNoteSheet(null, { openLink });
  }

  /** A deep link (e.g. from a reminder) to a note or record opens it on mobile too. */
  function openDeepLink(r: Route) {
    if (desktop.matches || !r.noteId) return;
    if (r.view === "notes") void findNote(r.noteId).then((n) => n && openNote(n));
    const kind = RECORD_VIEWS[r.view];
    if (kind) void findRecord(kind, r.noteId).then((rec) => rec && openRecordSheet(kind, rec, { openLink }));
    if (isKindView(r.view)) void findCustomRecord(r.noteId).then((rec) => rec && openCustomRecordSheet(rec.kind_id, rec, { openLink }));
  }

  // #/checkin/<kind>[/<date>] (a check-in push): the check-in opens over the page, and the address goes back to the page's.
  function openCheckinLink(): boolean {
    const c = parseCheckin(location.hash);
    if (!c) return false;
    history.replaceState(history.state, "", routeHash(route));
    void import("./components/checkin-flow").then((m) => m.openCheckinFlow(c.kind, { date: c.date ?? undefined }));
    return true;
  }

  // #/notes?template=<id> (an added template's address, lib/community-api.ts): Notes, with that template's editor over it.
  function openTemplateLink(hash: string): void {
    const [path, qs] = hash.replace(/^#\/?/, "").split("?");
    const id = path.replace(/\/+$/, "") === "notes" ? new URLSearchParams(qs ?? "").get("template") : null;
    if (!id) return;
    if (location.hash !== routeHash(route)) history.replaceState(history.state, "", routeHash(route));
    void Promise.all([import("./components/templates"), import("./db/documents"), import("./components/toast")]).then(([t, d, toast]) =>
      d.loadTemplates().then(
        (all) => {
          const found = all.find((x) => x.id === id);
          if (found) t.openTemplateEditor(found);
          else toast.showToast("That template isn't there any more", { icon: "archive" });
        },
        () => toast.showToast("Templates need a connection. Try again when you're online.", { icon: "wifiOff" })
      )
    );
  }

  const firstHash = location.hash;
  render();
  openDeepLink(route);
  openCheckinLink();
  openTemplateLink(firstHash);

  // Fetch the other views' code (and warm the editor) once the first screen
  // has loaded, its pictures included, and the device is idle: started any
  // sooner, it competes with that screen's own data and artwork on a slow phone.
  const later = () => setTimeout(() => prefetch(), 2500);
  if (document.readyState === "complete") later();
  else window.addEventListener("load", later, { once: true });

  // Notifications set the app badge (sw.js); opening Athena clears it.
  const clearBadge = () => document.visibilityState === "visible" && void (navigator as Navigator & { clearAppBadge?: () => Promise<void> }).clearAppBadge?.().catch(() => undefined);
  clearBadge();
  document.addEventListener("visibilitychange", clearBadge);

  // A notification tapped while Athena is open changes the route in place (sw.js).
  navigator.serviceWorker?.addEventListener("message", (e) => {
    const data = e.data as { type?: string; url?: string } | null;
    if (data?.type === "athena:navigate" && data.url?.startsWith("/#/")) location.hash = data.url.slice(1);
  });
  desktop.addEventListener("change", () => render());

  // Back/forward that lands on a different route (not a sheet closing) should
  // move the view with the URL rather than leave the two disagreeing.
  window.addEventListener("popstate", () => {
    if ((history.state as { athenaSheet?: string } | null)?.athenaSheet) return;
    if (openCheckinLink()) return;
    const hash = location.hash;
    const next = parseRoute(hash);
    if (next.view === route.view && next.source === route.source && next.noteId === route.noteId) return openTemplateLink(hash);
    route = next;
    withTransition(() => render());
    openDeepLink(route);
    openTemplateLink(hash);
  });

  // ---------- Shared state -> chrome ----------
  onKindsChange((kindId) => {
    if (kindId !== null) return;
    side.setKinds();
  });
  onStatus((s) => {
    statusBtn.update(s);
    side.setStatus(s);
  });

  // Sidebar counts: open loops due today or overdue, and suggestions waiting for review.
  const refreshCounts = async () => {
    const [{ items }, { items: pending }] = await Promise.all([loadCommitments(), loadSuggestions()]);
    const g = groupLoops(openLoops(items));
    side.setCount("loops", g.overdue.length + g.today.length, "due today or overdue");
    side.setCount("review", pending.length, "in your inbox");
  };
  void refreshCounts();
  let countsTimer: ReturnType<typeof setTimeout> | undefined;
  onMemoryChange(() => {
    clearTimeout(countsTimer);
    countsTimer = setTimeout(() => void refreshCounts(), 200);
  });

  // ---------- Keyboard ----------
  window.addEventListener("keydown", (e) => {
    if (document.querySelector("dialog[open]")) return;
    // ⌘K: search or jump (lib/ask-keys.ts).
    if (isJumpKey(e)) {
      e.preventDefault();
      jump();
      return;
    }
    // ⌘J: Ask, from anywhere (lib/ask-keys.ts).
    if (askKeyAction(e, { onAsk: false, dialogOpen: false, inEditor: false, inComposer: false, composerEmpty: true, menuOpen: false, editing: false, canEdit: false }) === "open") {
      e.preventDefault();
      openAsk();
      return;
    }
    if (e.metaKey || e.ctrlKey || e.altKey || isTypingTarget(e.target)) return;
    if (e.key === "c") {
      e.preventDefault();
      compose();
    } else if (e.key === "/") {
      e.preventDefault();
      go("notes", { focusSearch: true });
    }
  });

  // ---------- Hide the dock while the on-screen keyboard is up ----------
  document.addEventListener("focusin", (e) => {
    if (coarse.matches && isTypingTarget(e.target) && main.contains(e.target as Node)) document.body.classList.add("typing");
  });
  document.addEventListener("focusout", () => {
    setTimeout(() => {
      if (!isTypingTarget(document.activeElement)) document.body.classList.remove("typing");
    }, 0);
  });

  // The Days mood style is the owner's on every device: take the server's once loaded.
  void syncMoodStyle();

  // ---------- Where am I? ----------
  // The server runs the 07:30 briefing and collections' "daily at" times in the
  // owner's zone; tell it when this device's zone changes (travel, a new device).
  const reportZone = () => {
    if (isSampleMode() || !navigator.onLine) return;
    const tz = deviceZone();
    let last: string | null = null;
    try {
      last = localStorage.getItem("athena.tz");
    } catch {
      // storage unavailable; just send it
    }
    if (last === tz) return;
    void saveTimeZone(tz)
      .then(() => {
        try {
          localStorage.setItem("athena.tz", tz);
        } catch {
          // fine
        }
      })
      .catch(() => undefined);
  };
  reportZone();
  document.addEventListener("visibilitychange", () => document.visibilityState === "visible" && reportZone());

  // ---------- Sources' health, for the status card and menu ----------
  // "2 things need you" shows outside Settings only there (not on Home).
  // Words come from lib/sources-health.ts, loaded after first paint.
  let sourcesCheckedAt = 0;
  const refreshSourcesHealth = () => {
    if (isSampleMode() || !hasToken()) return;
    if (!navigator.onLine) return markSourcesStale();
    if (Date.now() - sourcesCheckedAt < 5 * 60_000) return;
    sourcesCheckedAt = Date.now();
    void Promise.all([import("./lib/sources-health"), fetchConnectors()]).then(
      ([m, state]) => m.publishSources(state),
      () => markSourcesStale()
    );
  };
  setTimeout(refreshSourcesHealth, 1500);
  document.addEventListener("visibilitychange", () => document.visibilityState === "visible" && refreshSourcesHealth());
  window.addEventListener("online", () => {
    sourcesCheckedAt = 0;
    refreshSourcesHealth();
  });
  window.addEventListener("offline", () => markSourcesStale());

  // ---------- Sync ----------
  void refreshNotes();
  void runSync().then(refreshNotes);
  // Collections and agents write notes on the server while the app sits in
  // the background (an installed app can stay open for days): catch up on
  // the way back, at most once a minute.
  let notesFetchedAt = Date.now();
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState !== "visible" || Date.now() - notesFetchedAt < 60_000) return;
    notesFetchedAt = Date.now();
    void refreshNotes();
  });
  window.addEventListener("online", () => {
    showToast("Back online. Syncing now", { icon: "cloud" });
    void syncNow();
  });
  window.addEventListener("offline", () => void refreshStatus());
  // The live channel (live/index.ts): the server says when something changed elsewhere, and these same pulls run sooner.
  startLive({ notes: () => void refreshNotes(), sources: () => ((sourcesCheckedAt = 0), refreshSourcesHealth()) });

  let pendingRefresh: ReturnType<typeof setTimeout> | undefined;
  onSyncChange(() => {
    clearTimeout(pendingRefresh);
    pendingRefresh = setTimeout(() => void refreshNotes(), 120);
  });
}

function boot() {
  // The aurora follows the time of day (styles/tokens.css).
  followDayPart();
  // Rich links in notes draw from the data layer (db/rich-links.ts).
  setLinkData(realLinkData);
  // A reload can land on a history entry a sheet pushed before the page went
  // away; nothing is open now, so drop the marker.
  const state = history.state as { athenaSheet?: string } | null;
  if (state?.athenaSheet) history.replaceState({ ...state, athenaSheet: undefined }, "");

  if (!hasToken() && !isSampleMode()) {
    ensureAurora();
    mount(
      root,
      renderConnect((mode) => {
        if (mode === "sample") setSampleMode();
        mountShell();
      })
    );
    return;
  }
  // An install from before device keys still holds the master token: swap it for this device's key.
  void swapMasterForKey();
  mountShell();
}

boot();

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js").catch(() => {
      // Offline-first is a progressive enhancement; the app works without it.
    });
  });
}
