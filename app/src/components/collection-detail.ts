/**
 * One collection: what it does, the one thing that needs you, and what it
 * saved, as a diary.
 *
 *  - Hero: the recipe, its title ("Email digest · personal") and the
 *    sentence ("Every morning at 07:15, reads Personal Gmail.").
 *  - A problem box when something needs you, worded as the fix
 *    ("Waiting on Personal Gmail · Sign in"). One at a time.
 *  - Run now, and an On switch. Manual collections have no switch.
 *  - "What it saved": runs grouped by day. Saved things open to links to
 *    what was saved (slice D's run items), and "See all in Notes".
 *  - A quiet footer: Edit · Settings and details · Delete.
 *
 * Built only with h() and text nodes.
 */

import { daysConvertCard } from "./days-convert";
import { isSampleMode } from "../db/api";
import { dayHref } from "../lib/day-link";
import "../styles/collections.css";
import { h } from "../lib/dom";
import { icons, type IconName } from "./icons";
import { showToast } from "./toast";
import { confirmDialog } from "./confirm";
import { connectorLogo } from "./brand-logo";
import { plural } from "../lib/format";
import { deleteCollection, fetchRuns, runCollection, saveCollection } from "../db/api";
import { errorText, eventsLeftToCalendar, RECIPE_ICON, serviceLabel } from "../lib/connectors-ui";
import { openCollectionForm } from "./collection-form";
import type { DetailContext, DetailView } from "./connector-detail";
import {
  accountProblem,
  andList,
  clock,
  clockAt,
  collectionTitle,
  fits,
  missedInARow,
  quietDays,
  recipeOf,
  runAt,
  runDay,
  runHeadline,
  scheduleSentence,
  servicesFor,
  whenPhrase,
  type CollectionLive,
  type RunItem,
  type RunLike,
  type RunWords,
} from "../lib/collection-words";
import type { Collection, Connector, RecipeId } from "../types";

/** What a collection's detail can ask of the page around it. Slice A passes the optional ones in. */
export interface CollectionDetailContext extends DetailContext {
  /** What a run saved (GET /collections/:id/runs/:run/items). Absent until slice D: links fall back to "See all in Notes". */
  fetchRunItems?: (collectionId: string, runId: string) => Promise<RunItem[]>;
  /** Open "Add an account", filtered to the services that feed a recipe. */
  addAccount?: (filter: { recipe: RecipeId }) => void;
  /** Start an account's sign-in straight away (leaves for the provider). */
  signIn?: (connectorId: string) => void | Promise<void>;
}

const present = (...xs: Array<HTMLElement | null>): HTMLElement[] => xs.filter((x): x is HTMLElement => !!x);

/** How many diary entries show before "Show older runs". */
const FIRST_ENTRIES = 6;

/** "Fri 6 Nov": a day's date in a run's list. */
const dayLabel = (date: string) => new Date(`${date}T12:00:00Z`).toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" });

const ITEM_ICON: Record<string, IconName> = {
  note: "note",
  day: "calendar",
  event: "calendar",
  person: "person",
  trip: "plane",
  purchase: "parcel",
};

export function collectionDetail(input: Collection, ctx: CollectionDetailContext): DetailView {
  const col = input as CollectionLive;
  const state = ctx.state();
  const title = collectionTitle(col);
  const manual = col.schedule === "manual";
  const accounts = col.connector_ids.map((id) => state.connectors.find((c) => c.id === id)).filter((c): c is Connector => !!c);

  let runs: RunLike[] | null = null;
  let loadFailed = false;
  let showAll = false;
  let destroyed = false;
  let poll: ReturnType<typeof setTimeout> | undefined;
  /** The run Run now just started, until the list knows about it. */
  let started: RunLike | null = null;
  const open = new Set<string>();
  let openedFirst = false;

  // ---------- Where links go ----------

  /** Close this sheet, then follow a link once the sheet's history entry is gone. */
  function go(hash: string) {
    let went = false;
    const nav = () => {
      if (went) return;
      went = true;
      location.hash = hash;
    };
    window.addEventListener("popstate", () => setTimeout(nav, 0), {
      once: true,
    });
    setTimeout(nav, 450);
    ctx.closed();
  }
  const notesHref = `#/notes?source=${encodeURIComponent(col.source)}`;
  function link(text: string, hash: string, cls = "cl-link"): HTMLAnchorElement {
    const a = h("a", { class: cls, href: hash }, text) as HTMLAnchorElement;
    a.addEventListener("click", (e) => {
      e.preventDefault();
      go(hash);
    });
    return a;
  }

  // ---------- Running ----------

  const running = (): RunLike | null => {
    const fromList = runs?.find((r) => r.status === "queued" || r.status === "running") ?? null;
    if (fromList) return fromList;
    if (started) return started;
    const cur = col.current_run;
    return cur
      ? ({
          id: cur.id,
          collection_id: col.id,
          trigger: "schedule",
          status: cur.status,
          started_at: cur.started_at,
          finished_at: null,
          summary: "",
          error: "",
          stats: {},
          created_at: cur.started_at ?? new Date().toISOString(),
        } as RunLike)
      : null;
  };

  // ---------- Hero ----------

  const statusEl = h("p", { class: "cl-state", role: "status" });
  function paintStatus() {
    const r = running();
    statusEl.replaceChildren();
    statusEl.className = "cl-state";
    if (r) {
      statusEl.classList.add("cl-state--running");
      statusEl.append(h("span", { class: "cl-state__dot", "aria-hidden": "true" }), r.status === "queued" ? "Starting" : "Running now");
    } else if (!manual && !col.enabled) {
      statusEl.classList.add("cl-state--off");
      statusEl.append(h("span", { class: "cl-state__dot", "aria-hidden": "true" }), "Off. It won't run until you turn it on.");
    }
  }

  // ---------- The one problem ----------

  const problemSlot = h("div", { class: "cl-problem-slot" });
  // The Life log's old day notes, waiting to move into Days (days-convert.ts).
  const daysSlot = h("div", { class: "cl-problem-slot" });
  if (col.recipe === "life-log") void daysConvertCard({ sample: isSampleMode() }).then((card) => card && !destroyed && daysSlot.replaceChildren(card));

  function fixButton(c: Connector): HTMLButtonElement | null {
    // A server that's down has nothing to fix from here: Athena tries again on the next run.
    if (c.status === "error" && !/key|secret|expired|admin|consent/i.test(c.status_detail)) return null;
    const oauthBrowser = c.auth_type === "oauth" && c.oauth?.grant !== "client_credentials" && (c.status === "needs_auth" || c.status === "pending");
    const label = oauthBrowser ? "Sign in" : "Fix";
    const b = h(
      "button",
      {
        class: "btn btn--primary btn--sm cl-problem__btn",
        type: "button",
        "aria-label": `${label}: ${c.name}`,
      },
      label,
    ) as HTMLButtonElement;
    b.addEventListener("click", async () => {
      b.disabled = true;
      try {
        if (oauthBrowser && ctx.signIn) await ctx.signIn(c.id);
        else ctx.openAccount(c.id);
      } catch (err) {
        showToast(errorText(err, "Couldn't start the sign-in"), {
          icon: "close",
          timeoutMs: 6000,
        });
      } finally {
        b.disabled = false;
      }
    });
    return b;
  }

  function problemBox(head: string, sub: string, button: HTMLElement | null, tone: "warn" | "quiet" = "warn"): HTMLElement {
    return h(
      "div",
      {
        class: `cl-problem cl-problem--${tone}`,
        role: "group",
        "aria-label": head,
      },
      h("div", { class: "cl-problem__body" }, h("p", { class: "cl-problem__title" }, head), h("p", { class: "cl-problem__sub" }, sub)),
      button,
    );
  }

  function problem(): HTMLElement | null {
    const list = runs ?? [];
    const missed = missedInARow(list);
    const missedText = missed ? `Missed ${missed} ${plural(missed, "run", "runs")}. ` : "";

    // 1. Nothing to read: no accounts left, or none that feed it (F6).
    if (!accounts.length) {
      const fitting = state.connectors.filter((c) => c.status === "connected" && fits(c, col.recipe));
      if (fitting.length) {
        const b = h("button", { class: "btn btn--primary btn--sm cl-problem__btn", type: "button" }, "Choose");
        b.addEventListener("click", edit);
        return problemBox(`${title} has nothing to read`, `Choose an account for it, like ${fitting[0].name}.`, b);
      }
      const names = servicesFor(col.recipe).slice(0, 2);
      const b = ctx.addAccount
        ? (() => {
            const btn = h(
              "button",
              {
                class: "btn btn--primary btn--sm cl-problem__btn",
                type: "button",
              },
              "Add an account",
            );
            btn.addEventListener("click", () => {
              ctx.closed();
              ctx.addAccount!({ recipe: col.recipe });
            });
            return btn;
          })()
        : null;
      return problemBox(
        `${title} has nothing to read`,
        names.length ? `Connect a service it reads, like ${names.join(" or ")}.` : "Connect an account for it to read.",
        b,
      );
    }

    // A paused collection isn't a problem: it says it's off, and its account trouble waits until it's back on.
    if (!manual && !col.enabled) return null;

    // 2. An account stops it, or part of it.
    const lastBlocked = col.last_run?.blocked_by ?? [];
    const blocked = accounts.filter((c) => c.status !== "connected" || lastBlocked.includes(c.id));
    if (blocked.length) {
      const first = blocked[0];
      const all = blocked.length === accounts.length;
      const fixWord =
        first.status === "error"
          ? ""
          : first.auth_type === "oauth" && first.oauth?.grant !== "client_credentials"
            ? "Sign in to start again."
            : "Fix it to start again.";
      if (all) {
        const head = `Waiting on ${andList(blocked.map((c) => c.name))}`;
        const sub =
          first.status === "error" && !fixButton(first)
            ? `${accountProblem(first)}. Athena tries again on the next run.`
            : `${missedText || `${accountProblem(first)}. `}${fixWord}`;
        return problemBox(head, sub.trim(), fixButton(first));
      }
      const rest = accounts.filter((c) => !blocked.includes(c));
      return problemBox(`Skipping ${first.name}`, `${accountProblem(first)}, so it reads ${andList(rest.map((c) => c.name))} only.`, fixButton(first));
    }

    // 3. The last run failed for another reason.
    const latest = list.find((r) => r.status === "succeeded" || r.status === "failed");
    if (latest?.status === "failed") {
      return problemBox("It didn't run last time", `${runHeadline(latest, state.connectors).sub}.`, null);
    }

    // 4. Gone quiet (Readwise's "nothing in 45 days").
    const quiet = quietDays(list);
    if (quiet >= 14) {
      const weeks = Math.floor(quiet / 7);
      const b = h("button", { class: "btn btn--soft btn--sm cl-problem__btn", type: "button" }, "Edit");
      b.addEventListener("click", edit);
      return problemBox(`Nothing new in ${weeks} ${plural(weeks, "week", "weeks")}`, "Check it's reading the right account.", b, "quiet");
    }
    return null;
  }

  // ---------- Actions ----------

  const runBtn = h(
    "button",
    { class: "btn btn--soft cl-run", type: "button" },
    icons.refresh(),
    h("span", { class: "cl-run__label" }, "Run now"),
  ) as HTMLButtonElement;
  runBtn.addEventListener("click", runNow);

  const onSwitch = h("input", {
    type: "checkbox",
    role: "switch",
    class: "switch",
    id: `cl-on-${col.id}`,
  }) as HTMLInputElement;
  onSwitch.checked = col.enabled;
  onSwitch.setAttribute("aria-describedby", `cl-sentence-${col.id}`);
  onSwitch.addEventListener("change", async () => {
    const on = onSwitch.checked;
    onSwitch.disabled = true;
    try {
      await saveCollection({ enabled: on }, col.id);
      showToast(on ? `${title} is on` : `${title} is off`, { icon: "clock" });
      await ctx.reload();
    } catch (err) {
      onSwitch.checked = !on;
      showToast(errorText(err, "Couldn't change that"), { icon: "close" });
    } finally {
      onSwitch.disabled = false;
    }
  });
  const switchWrap = manual ? null : h("label", { class: "cl-on", for: onSwitch.id }, h("span", { class: "cl-on__label" }, "On"), onSwitch);

  function paintRun() {
    const r = running();
    runBtn.disabled = !!r;
    runBtn.classList.toggle("is-running", !!r);
    runBtn.querySelector(".cl-run__label")!.textContent = r ? "Running…" : "Run now";
  }

  async function runNow() {
    runBtn.disabled = true;
    try {
      const r = (await runCollection(col.id)) as RunLike;
      started = r;
      open.clear();
      openedFirst = false;
      paintAll();
      schedulePoll(true);
    } catch (err) {
      showToast(errorText(err, "Couldn't start it"), {
        icon: "close",
        timeoutMs: 6000,
      });
      runBtn.disabled = false;
    }
  }

  // ---------- The diary ----------

  const diary = h("div", { class: "cl-diary" });

  interface Entry {
    runs: RunLike[];
    words: RunWords;
  }

  /** Runs in order, newest first, with "Nothing new" streaks folded into one entry and repeated reasons said once. */
  function entries(list: RunLike[]): Array<{ day: string; items: Entry[] }> {
    const days: Array<{ day: string; items: Entry[] }> = [];
    let lastReason = "";
    for (const r of list) {
      const day = runDay(r);
      let bucket = days.at(-1);
      if (!bucket || bucket.day !== day) {
        bucket = { day, items: [] };
        days.push(bucket);
      }
      const words = runHeadline(r, state.connectors);
      const prev = bucket.items.at(-1);
      if (words.tone === "nothing" && prev?.words.tone === "nothing" && !words.sub && !prev.words.sub) {
        prev.runs.push(r);
        continue;
      }
      if (words.tone === "didnt") {
        if (words.sub === lastReason) words.sub = "Same reason";
        else lastReason = words.sub;
      } else lastReason = "";
      bucket.items.push({ runs: [r], words });
    }
    return days;
  }

  function itemsBlock(r: RunLike, saved: number): HTMLElement {
    const box = h("div", { class: "cl-items" });
    // Your work, counted saves no notes: what it counted is on the Work page.
    if (col.recipe === "work-sync") {
      box.append(link("See it on the Work page", "#/work", "cl-link cl-items__all"));
      return box;
    }
    // Home saves sealed days, not notes: they're on House and Money.
    if (col.recipe === "home") {
      const banks = ctx.state().connectors.some((c) => col.connector_ids.includes(c.id) && (c.provider === "monzo" || c.provider === "starling"));
      box.append(link("See it on House", "#/house", "cl-link cl-items__all"), banks ? link("See it in Money", "#/money", "cl-link cl-items__all") : "");
      return box;
    }
    // Calendar saves events, not notes: they're in Coming up on Home.
    const seeAll = () =>
      col.recipe === "calendar-sync" ? link("See what's coming up", "#/", "cl-link cl-items__all") : link(saved > 1 ? `See all ${saved} in Notes` : "See it in Notes", notesHref, "cl-link cl-items__all");
    if (!ctx.fetchRunItems) {
      box.append(seeAll());
      return box;
    }
    box.append(h("div", { class: "cl-items__loading" }, h("span", { class: "skeleton" }), h("span", { class: "skeleton" })));
    ctx
      .fetchRunItems(col.id, r.id)
      .then((items) => {
        if (destroyed) return;
        const shown = items.slice(0, 3);
        box.replaceChildren(
          ...shown.map((it) => {
            const hash = it.kind === "day" ? dayHref(it.record_id) : it.kind === "event" ? `#/events/${encodeURIComponent(it.record_id)}` : `#/notes/${encodeURIComponent(it.record_id)}`;
            const a = link("", hash, `cl-item${it.archived ? " cl-item--archived" : ""}`);
            // A day reads as its date, then its line.
            const title = it.kind === "day" ? [dayLabel(it.record_id), it.title].filter(Boolean).join(" · ") : it.title || "Untitled";
            a.append(h("span", { class: "cl-item__icon", "aria-hidden": "true" }, icons[ITEM_ICON[it.kind] ?? "note"]()), h("span", { class: "cl-item__title" }, title));
            if (it.archived) a.append(h("span", { class: "cl-item__tag" }, "Archived"));
            return a;
          }),
          ...(items.length && items.every((it) => it.kind === "day") ? [] : [seeAll()]),
        );
      })
      .catch(() => {
        if (!destroyed) box.replaceChildren(seeAll());
      });
    return box;
  }

  function entryEl(e: Entry): HTMLElement {
    const r = e.runs[0];
    const w = e.words;
    const multi = e.runs.length > 1;
    const head = [
      h("span", { class: "cl-entry__time" }, clockAt(runAt(r))),
      h("span", {
        class: `cl-entry__dot cl-entry__dot--${w.tone}`,
        "aria-hidden": "true",
      }),
      h(
        "span",
        { class: "cl-entry__body" },
        h("span", { class: "cl-entry__title" }, w.title),
        multi
          ? h("span", { class: "cl-entry__sub" }, `${e.runs.length} runs since ${clockAt(runAt(e.runs[e.runs.length - 1]))}`)
          : w.sub
            ? h("span", { class: "cl-entry__sub" }, w.sub)
            : null,
        r.trigger === "manual" && !multi && w.tone !== "running" ? h("span", { class: "cl-entry__by" }, "You ran it") : null,
      ),
    ];
    if (w.tone !== "saved") return h("div", { class: `cl-entry cl-entry--${w.tone}` }, ...head);

    // Saved things: tap through to what it saved.
    if (!openedFirst) {
      openedFirst = true;
      open.add(r.id);
    }
    const isOpen = open.has(r.id);
    const btn = h(
      "button",
      {
        class: "cl-entry__toggle",
        type: "button",
        "aria-expanded": String(isOpen),
      },
      ...head,
      h("span", { class: "cl-entry__chev", "aria-hidden": "true" }, icons.chevronDown()),
    );
    const wrap = h("div", { class: `cl-entry cl-entry--saved${isOpen ? " is-open" : ""}` }, btn, isOpen ? itemsBlock(r, w.saved) : null);
    btn.addEventListener("click", () => {
      if (open.has(r.id)) open.delete(r.id);
      else open.add(r.id);
      const now = open.has(r.id);
      btn.setAttribute("aria-expanded", String(now));
      wrap.classList.toggle("is-open", now);
      wrap.querySelector(".cl-items")?.remove();
      if (now) wrap.append(itemsBlock(r, w.saved));
    });
    return wrap;
  }

  function nextRunWords(): string {
    if (!col.next_run_at) return `Its first run is ${whenPhrase(col).toLowerCase()}.`;
    const d = new Date(col.next_run_at);
    const today = new Date();
    const tomorrow = new Date(today.getFullYear(), today.getMonth(), today.getDate() + 1);
    const sameDay = (a: Date, b: Date) => a.toDateString() === b.toDateString();
    const day = sameDay(d, today) ? "today" : sameDay(d, tomorrow) ? "tomorrow" : d.toLocaleDateString([], { weekday: "long" });
    return `Its first run is ${day} at ${clock(`${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`)}.`;
  }

  function paintDiary() {
    if (!runs) {
      diary.replaceChildren(
        h(
          "div",
          { class: "cl-entry cl-entry--loading", "aria-hidden": "true" },
          h("span", { class: "skeleton cl-skel-time" }),
          h("span", { class: "skeleton cl-skel-dot" }),
          h("span", { class: "skeleton cl-skel-line" }),
        ),
      );
      diary.setAttribute("aria-busy", "true");
      return;
    }
    diary.removeAttribute("aria-busy");
    const list: RunLike[] = [...runs];
    const r = running();
    if (r && !list.some((x) => x.id === r.id)) list.unshift(r);
    if (!list.length) {
      diary.replaceChildren(
        h(
          "div",
          { class: "cl-empty" },
          h("p", { class: "cl-empty__title" }, loadFailed ? "Couldn't load its history" : "Nothing yet"),
          h(
            "p",
            { class: "cl-empty__sub" },
            loadFailed
              ? "Check your connection. It's still collecting."
              : !accounts.length
                ? "It starts once it has an account to read."
                : manual
                ? "Tap Run now to see what it finds."
                : col.enabled
                  ? nextRunWords()
                  : "Turn it on, or tap Run now to try it once.",
          ),
        ),
      );
      return;
    }
    const days = entries(list);
    const out: HTMLElement[] = [];
    let count = 0;
    let hidden = 0;
    for (const d of days) {
      const items: HTMLElement[] = [];
      for (const e of d.items) {
        if (!showAll && count >= FIRST_ENTRIES) {
          hidden++;
          continue;
        }
        count++;
        items.push(entryEl(e));
      }
      if (items.length) out.push(h("section", { class: "cl-day" }, h("h4", { class: "cl-day__label" }, d.day), ...items));
    }
    if (hidden) {
      const more = h("button", { class: "cl-link cl-diary__more", type: "button" }, `Show ${hidden} older ${plural(hidden, "run", "runs")}`);
      more.addEventListener("click", () => {
        showAll = true;
        paintDiary();
      });
      out.push(more);
    }
    diary.replaceChildren(...out);
  }

  // ---------- Loading and polling ----------

  async function loadRuns(announce = false) {
    try {
      const next = (await fetchRuns(col.id)) as RunLike[];
      if (destroyed) return;
      runs = next;
      loadFailed = false;
      if (started && next.some((x) => x.id === started!.id)) started = null;
      const open = next.some((x) => x.status === "queued" || x.status === "running");
      paintAll();
      if (open) schedulePoll(announce);
      else if (announce && next[0]) {
        const w = runHeadline(next[0], state.connectors);
        showToast(
          w.tone === "saved" ? `${title}: ${w.title.toLowerCase()}` : w.tone === "nothing" ? `${title}: nothing new` : `${title} didn't run. ${w.sub}`,
          {
            icon: w.tone === "didnt" ? "close" : "check",
            timeoutMs: 5000,
          },
        );
        void ctx.reload();
      }
    } catch {
      if (destroyed) return;
      if (!runs) {
        runs = [];
        loadFailed = true;
        paintAll();
      }
      poll = setTimeout(() => void loadRuns(announce), 8000);
    }
  }
  function schedulePoll(announce: boolean) {
    clearTimeout(poll);
    poll = setTimeout(() => void loadRuns(announce), 4000);
  }

  // ---------- Settings and details ----------

  const detailsId = `cl-details-${col.id}`;
  const details = h("section", {
    class: "group cl-details",
    id: detailsId,
    hidden: true,
  });
  function paintDetails() {
    const fact = (label: string, value: string | HTMLElement) =>
      h("div", { class: "prop prop--fact" }, h("span", { class: "prop__label" }, label), h("span", { class: "prop__value" }, value));
    const backs: Record<number, string> = {
      12: "12 hours",
      24: "A day",
      36: "A day and a half",
      48: "2 days",
      72: "3 days",
      168: "A week",
    };
    details.replaceChildren(
      ...present(
        h("h3", { class: "group__label" }, "Reads from"),
        accounts.length
          ? h(
              "div",
              { class: "card card--flush list" },
              ...accounts.map((c) => {
                const bad = c.status !== "connected";
                const b = h(
                  "button",
                  { class: "row cl-acctrow", type: "button" },
                  connectorLogo(c, "sm"),
                  h(
                    "span",
                    { class: "row__body" },
                    h("span", { class: "row__title" }, c.name),
                    h("span", { class: `row__meta${bad ? " cl-warn-text" : ""}` }, bad ? accountProblem(c) : serviceLabel(c)),
                  ),
                  h("span", { class: "row__chevron", "aria-hidden": "true" }, icons.chevronRight()),
                );
                b.addEventListener("click", () => ctx.openAccount(c.id));
                return b;
              }),
            )
          : h("p", { class: "form__hint" }, "No accounts yet."),
        h("h3", { class: "group__label cl-details__gap" }, "Settings"),
        h(
          "div",
          { class: "card card--flush fields" },
          fact("When", whenPhrase(col)),
          // Your activity reads its accounts directly (media-sync.ts): no look-back.
          col.recipe === "work-sync" ? fact("How far back", "A year, the first time") : col.recipe === "home" ? fact("How far back", "Up to two years, a little each run") : col.recipe === "plays-watches" || col.recipe === "calendar-sync" ? null : fact("How far back", backs[col.lookback_hours] ?? `${col.lookback_hours} hours`),
          col.lookahead_days > 0
            ? fact("Upcoming events", eventsLeftToCalendar(col, ctx.state().collections, ctx.state().connectors) ? "Kept in step by Calendar" : `Next ${col.lookahead_days} days${col.event_push ? ", with reminders" : ""}`)
            : null,
          col.recipe === "calendar-meetings" ? fact("Quiet days", col.skip_quiet === false ? "Runs anyway" : "Skipped") : null,
          fact("Filed under", h("span", { class: "cl-mono" }, col.source)),
          fact(
            "Started",
            new Date(col.created_at).toLocaleDateString([], {
              day: "numeric",
              month: "short",
              year: "numeric",
            }),
          ),
        ),
        col.instructions.trim()
          ? h("h3", { class: "group__label cl-details__gap" }, col.recipe === "custom" ? "What to look for" : "Extra instructions")
          : null,
        col.instructions.trim() ? h("div", { class: "card cl-instructions-view" }, col.instructions.trim()) : null,
        col.recipe === "work-sync"
          ? h("p", { class: "cl-details__notes" }, link("Open the Work page", "#/work"))
          : col.recipe === "home"
            ? h("p", { class: "cl-details__notes" }, link("Open House", "#/house"), " · ", link("Open Money", "#/money"))
            : col.recipe === "calendar-sync"
              ? h("p", { class: "cl-details__notes" }, link("Open Coming up on Home", "#/"))
              : col.recipe === "plays-watches"
              ? null
              : h("p", { class: "cl-details__notes" }, link("Open everything it saved in Notes", notesHref)),
      ),
    );
  }

  // ---------- Edit, delete ----------

  function edit() {
    openCollectionForm(ctx.state(), col, () => void ctx.reload(), {
      addAccount: ctx.addAccount,
    });
  }

  async function remove() {
    const ok = await confirmDialog({
      title: `Delete ${title}?`,
      body: "It stops running and its history goes. Notes it saved stay in Athena.",
      confirmLabel: "Delete",
      danger: true,
    });
    if (!ok) return;
    try {
      await deleteCollection(col.id);
      showToast(`${title} deleted`, { icon: "trash" });
      ctx.closed();
      await ctx.reload();
    } catch (err) {
      showToast(errorText(err, "Couldn't delete it"), { icon: "close" });
    }
  }

  const footBtn = (text: string, run: () => void, cls = "") => {
    const b = h("button", { class: `cl-foot-link ${cls}`.trim(), type: "button" }, text);
    b.addEventListener("click", run);
    return b;
  };
  const detailsBtn = footBtn("Settings and details", () => {
    details.hidden = !details.hidden;
    detailsBtn.setAttribute("aria-expanded", String(!details.hidden));
    if (!details.hidden)
      details.scrollIntoView({
        behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth",
        block: "start",
      });
  });
  detailsBtn.setAttribute("aria-expanded", "false");
  detailsBtn.setAttribute("aria-controls", detailsId);

  // ---------- Layout ----------

  const el = h(
    "div",
    { class: "note profile cl-detail" },
    h(
      "header",
      { class: "cl-hero" },
      h("span", { class: `cl-tile cl-tile--lg cl-tile--${col.recipe}` }, icons[RECIPE_ICON[col.recipe]]()),
      h("h2", { class: "page-title cl-hero__title" }, title),
      h("p", { class: "cl-hero__sentence", id: `cl-sentence-${col.id}` }, scheduleSentence(col, state.connectors)),
      statusEl,
    ),
    problemSlot,
    daysSlot,
    // Nothing to read means nothing to run: the problem box above is the only way forward.
    accounts.length
      ? h(
          "div",
          {
            class: `cl-actions${manual ? " cl-actions--manual" : ""}`,
            role: "group",
            "aria-label": `${recipeOf(col.recipe).label} actions`,
          },
          runBtn,
          switchWrap,
        )
      : null,
    h("section", { class: "group" }, h("h3", { class: "group__label" }, "What it saved"), diary),
    details,
    h(
      "nav",
      { class: "cl-footer", "aria-label": "More" },
      footBtn("Edit", edit),
      h("span", { class: "cl-footer__sep", "aria-hidden": "true" }, "·"),
      detailsBtn,
      h("span", { class: "cl-footer__sep", "aria-hidden": "true" }, "·"),
      footBtn("Delete", () => void remove(), "cl-foot-link--danger"),
    ),
  );

  function paintAll() {
    paintStatus();
    paintRun();
    const p = problem();
    problemSlot.replaceChildren(...(p ? [p] : []));
    paintDiary();
  }

  paintDetails();
  paintAll();
  void loadRuns(!!col.current_run);

  return {
    el,
    id: col.id,
    destroy() {
      destroyed = true;
      clearTimeout(poll);
    },
  };
}
