/**
 * Team: #/team, #/team/<id> and #/team/new all land here,
 * with `param` null, an assistant's id, or "new".
 *
 *   #/team       walking past your assistants at work: one sentence on
 *                what's happening, anything waiting for you, each
 *                assistant's desk (what it's doing now, or what it did
 *                last), and the day's runs in order
 *   #/team/<id>  the assistant's own page (team/team-detail.ts)
 *   #/team/new   setup (team/setup.ts), a sheet over the page
 *   #/team/import  an older address for #/add (app/src/add/), where every
 *                shared item is previewed and added. A file dropped on the
 *                page goes there too, and so does setup's "Or import one
 *                someone shared".
 *
 * The page looks again while it's open (team/page-live.ts) and updates in
 * place, so focus, scroll and the characters' motion carry on undisturbed.
 */
import "../styles/team.css";
import { h } from "../lib/dom";
import { updateDot, UPDATE_WORDS } from "../community/status";
import { pageHead } from "../components/page-head";
import { icons } from "../components/icons";
import { showToast } from "../components/toast";
import { listActivity, listTeam, onTeamChange, runNow, type TeamAssistant, type TeamRun } from "../db/team";
import { onThreadsChange, requestOpen } from "../db/ask-threads";
import { MAX_ASSISTANTS, type AvatarSpec } from "../../../lib/team-types";
import { renderAvatarTile, setAvatarMood } from "../team/avatar";
import { paintWho } from "../team/dot-colour";
import { openSetup, EXAMPLES } from "../team/setup";
import { renderTeamDetail } from "../team/team-detail";
import { byDay, causeWords, clock, dayWords, deskFor, isLive, nextWords, nowWords, resultWords, sameDay, teamLede, whenShort, type Desk, type WaitsOf } from "../team/page-words";
import { keepLooking } from "../team/page-live";
import { cap, pronouns } from "../team/detail-words";
import { planCounts, waitsFrom } from "../team/page-pulse";
import { splitReport, waitsWords } from "../lib/team-report";
import { dismissRun, isDismissed, onDismissChange, undismissRun } from "../team/page-dismiss";
import type { ViewId } from "../components/nav";
import { renderTeamChat } from "../team/chat";
import { renderAssignment } from "../team/assignment-page";
import { openNewAssignment } from "../team/new-assignment";
import { watchWaiting } from "../team/waiting";
import { openAddWithFiles } from "../add/hold";

type Go = (view: ViewId, opts?: { noteId?: string | null }) => void;

export interface TeamViewContext {
  go: Go;
  /** null: the team; "new": setup; "import": add a shared assistant; otherwise an assistant's id. */
  param: string | null;
}

/** The character the empty page introduces: a sample, never saved. */
/** The empty state's character; team.css shrinks it to 112px on a phone. */
function helloFace(): HTMLElement {
  const t = renderAvatarTile(SAMPLE, { size: 160, animate: true });
  t.classList.add("team-hello__face");
  return t;
}

const SAMPLE: AvatarSpec = { v: 1, seed: "team-hello", species: "cat", fur: "snow", accent: "pink", eyes: "sparkle", mouth: "small-smile", outfit: "hoodie", outfitColor: "berry", accessories: ["headphones"] };

/** How many of the day's runs show before "Show earlier". */
const FEED_FIRST = 8;

// Where the page was opened from, so Back and closing setup return there
// instead of leaving the app when the page was opened from a link.
let pushedFromGrid = false;
let setupText: string | undefined;
let justAdded: string | null = null;

function toDetail(go: Go, id: string) {
  pushedFromGrid = true;
  history.pushState(history.state, "", `#/team/${encodeURIComponent(id)}`);
  go("team", { noteId: id });
}

function toSetup(go: Go, text?: string) {
  pushedFromGrid = true;
  setupText = text;
  history.pushState(history.state, "", "#/team/new");
  go("team", { noteId: "new" });
}

function backToGrid(go: Go) {
  if (pushedFromGrid && history.length > 1) {
    pushedFromGrid = false;
    history.back();
  } else go("team");
}

/** Add something someone shared: #/add previews it (app/src/add/), and links to its page once it's added. */
function openImport(_go: Go, files?: File[]) {
  openAddWithFiles(files ?? []);
}

/** A run's conversation when it kept one, else the assistant's own page. */
function openRun(go: Go, r: TeamRun) {
  if (r.thread_id) {
    requestOpen(r.thread_id);
    location.hash = "#/ask";
  } else toDetail(go, r.assistant_id);
}

const BADGE: Partial<Record<Desk["state"], string>> = {
  working: "Working",
  queued: "Up next",
  waiting: "Needs your approval",
  failed: "Didn't finish",
  paused: "Paused",
};

/** Set text only when it changed, so nothing flickers and screen readers stay quiet. */
function text(el: HTMLElement, s: string) {
  if (el.textContent !== s) el.textContent = s;
}

// ---------- a desk: one assistant ----------

interface DeskEl {
  el: HTMLElement;
  update: (a: TeamAssistant, d: Desk, fresh: boolean) => void;
}

/** A desk's character: 72px, so its ears rise past the tile (the desk leaves room above). */
function deskFace(a: TeamAssistant): HTMLElement {
  const t = renderAvatarTile(a.avatar, { size: 72, animate: false });
  t.classList.add("desk__face");
  return t;
}

function desk(a0: TeamAssistant, go: Go): DeskEl {
  let spec = JSON.stringify(a0.avatar);
  let face = deskFace(a0);
  if (a0.id === justAdded) face.firstElementChild?.classList.add("kit-enter");
  const name = h("span", { class: "desk__name" });
  const badgeDot = h("span", { class: "team-dot", "aria-hidden": "true" });
  const badgeWord = h("span", {});
  const badge = h("span", { class: "desk__badge" }, badgeDot, badgeWord);
  const job = h("span", { class: "desk__job" });
  const meta = h("span", { class: "desk__meta" });
  const line = h("span", { class: "desk__line" });
  const cause = h("span", { class: "desk__cause" });
  const foot = h("span", { class: "desk__foot" });
  const panel = h("span", { class: "desk__now" }, meta, line, cause);
  let hasUpdate = false;
  const el = h(
    "button",
    { class: "desk", type: "button" },
    h("span", { class: "desk__head" }, face, h("span", { class: "desk__id" }, h("span", { class: "desk__title" }, name, updateDot("assistant", a0.id, () => (hasUpdate = true, el.setAttribute("aria-label", `${el.getAttribute("aria-label") ?? ""}. ${UPDATE_WORDS}`))), badge), job)),
    panel,
    foot
  );
  if (a0.id === justAdded) el.classList.add("is-new");
  el.addEventListener("click", () => toDetail(go, a0.id));

  function update(a: TeamAssistant, d: Desk, fresh: boolean) {
    const now = new Date();
    if (JSON.stringify(a.avatar) !== spec) {
      spec = JSON.stringify(a.avatar);
      const next = deskFace(a);
      face.replaceWith(next);
      face = next;
    }
    // Working: the thinking mood, with its slow tilt (still under reduced motion).
    const busy = d.state === "working";
    face.firstElementChild?.classList.toggle("kit-animate", busy);
    setAvatarMood(face, busy || d.state === "queued" ? "working" : "idle");
    el.dataset.state = d.state;
    text(name, a.name);
    text(badgeWord, BADGE[d.state] ?? "");
    badge.hidden = !BADGE[d.state];
    // Working: the breathing dot and the ring round the character, in its own colour.
    badgeDot.hidden = !busy;
    paintWho(el, a.avatar);
    text(job, a.job);
    job.title = a.job;

    let m: string;
    let l: string;
    let c: string | null = null;
    if (d.live) {
      m = d.live.status === "running" ? `Started ${clock(d.live.started_at)}` : "Up next";
      l = nowWords(d.live);
      c = causeWords(d.live, a);
    } else if (d.last) {
      const when = d.last.finished_at ?? d.last.started_at;
      const more = d.today.length > 1 ? ` · ${d.today.length} runs today` : "";
      m = `${sameDay(new Date(when), now) ? `Today at ${clock(when)}` : dayWords(when, now)}${more}`;
      l = resultWords(d.last);
      c = causeWords(d.last, a);
    } else {
      m = "Nothing yet";
      l = a.paused ? `${a.name} hasn't run yet.` : `${a.name} hasn't run yet. ${nextWords(a, now).replace(/^Runs/, `${cap(pronouns(a.personality).they)} ${pronouns(a.personality).plural ? "run" : "runs"}`).replace(/^Next run/, `${cap(pronouns(a.personality).their)} first run is`)}.`;
    }
    text(meta, m);
    if (line.textContent !== l) {
      line.textContent = l;
      if (fresh) {
        panel.classList.remove("is-fresh");
        void panel.offsetWidth;
        panel.classList.add("is-fresh");
      }
    }
    text(cause, c ?? "");
    cause.hidden = !c;
    text(foot, d.last || d.live || a.paused ? nextWords(a, now) : "");
    foot.hidden = !foot.textContent;
    el.setAttribute("aria-label", [a.name, BADGE[d.state], hasUpdate ? UPDATE_WORDS : null, a.job, m, l, c, foot.textContent].filter(Boolean).join(". ").replace(/\.\./g, "."));
  }

  return { el, update };
}

// ---------- waiting for you ----------

const reducedMotion = () => typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;

function waitingRow(a: TeamAssistant, d: Desk, go: Go): HTMLElement {
  const r = d.last!;
  const head = renderAvatarTile(a.avatar, { size: 36, animate: false });
  const failed = !d.asks;
  const when = whenShort(r.finished_at ?? r.started_at);
  const open = h(
    "button",
    { class: "wait__open", type: "button" },
    head,
    h(
      "span",
      { class: "wait__text" },
      h("span", { class: "wait__title" }, failed ? `${a.name} didn't finish` : `${a.name} needs your approval`),
      h("span", { class: "wait__sub" }, failed ? (r.error?.trim() ? `${r.error.trim().replace(/\.$/, "")}. ${when}.` : `${cap(pronouns(a.personality).their)} last run stopped partway. ${when}.`) : splitReport(resultWords(r)).said),
      failed ? null : h("span", { class: "wait__count" }, h("span", { class: "wait__pip", "aria-hidden": "true" }), waitsWords(d.waits))
    ),
    failed ? null : icons.chevronRight()
  );
  open.addEventListener("click", () => openRun(go, r));
  const row = h("li", { class: `wait${failed ? " wait--failed" : ""}`, "data-run": r.id }, open);
  if (!failed) return row;

  // A run that didn't finish: try it again, or dismiss it. Dismissed, it stays in the assistant's runs.
  const dismiss = h("button", { class: "btn btn--ghost btn--sm wait__dismiss", type: "button", "aria-label": `Dismiss: ${a.name} didn't finish` }, "Dismiss");
  const again = h("button", { class: "btn btn--soft btn--sm wait__again", type: "button" }, "Try again");
  dismiss.addEventListener("click", () => {
    const leave = () => {
      // Keep the keyboard in the list: the next row, else the one before, else the desks.
      const sib = (row.nextElementSibling ?? row.previousElementSibling)?.querySelector<HTMLElement>("button");
      const focusNext = row.contains(document.activeElement);
      dismissRun(r.id);
      if (focusNext) (sib ?? document.querySelector<HTMLElement>(".team .desk"))?.focus();
      showToast(`Dismissed. It stays in ${a.name}'s recent runs.`, {
        action: {
          label: "Undo",
          run: () => {
            undismissRun(r.id);
            document.querySelector<HTMLElement>(`.wait[data-run="${CSS.escape(r.id)}"] .wait__open`)?.focus();
          },
        },
      });
    };
    if (reducedMotion()) return leave();
    // The last one takes its heading with it.
    const box = row.parentElement?.children.length === 1 ? (row.closest<HTMLElement>(".team-waiting") ?? row) : row;
    box.style.height = `${box.offsetHeight}px`;
    void box.offsetHeight;
    box.classList.add("is-leaving");
    box.style.height = "0px";
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      leave();
    };
    box.addEventListener("transitionend", (e) => e.target === box && e.propertyName === "height" && finish());
    window.setTimeout(finish, 360);
  });
  again.addEventListener("click", async () => {
    if (again.getAttribute("aria-disabled")) return;
    again.setAttribute("aria-disabled", "true");
    try {
      await runNow(a.id);
      showToast(`${a.name} is on it`);
    } catch (e) {
      showToast(e instanceof Error && e.message ? e.message : "That didn't start. Try again.");
      again.removeAttribute("aria-disabled");
    }
  });
  row.append(h("span", { class: "wait__acts" }, dismiss, again));
  return row;
}

// ---------- the day ----------

function dayRun(r: TeamRun, a: TeamAssistant | undefined, go: Go, fresh: boolean, waitsOf: WaitsOf): HTMLElement {
  const live = isLive(r);
  const head = a ? renderAvatarTile(a.avatar, { size: 28, animate: false }) : h("span", { class: "kit-tile", style: "--kit-px:28px;--kit-tint:var(--sunken)", "aria-hidden": "true" });
  head.classList.add("run__face");
  const cause = causeWords(r, a);
  const body = h(
    "span",
    { class: "run__body" },
    h("span", { class: "run__top" }, h("span", { class: "run__who" }, a?.name ?? "An assistant"), h("span", { class: "run__when" }, r.status === "running" ? h("span", { class: "team-dot", "aria-hidden": "true" }) : null, live ? (r.status === "running" ? "Now" : "Up next") : clock(r.finished_at ?? r.started_at))),
    h("span", { class: "run__text" }, live ? nowWords(r) : resultWords(r)),
    !live && waitsOf(r) > 0 ? h("span", { class: "wait__count run__waits" }, h("span", { class: "wait__pip", "aria-hidden": "true" }), waitsWords(waitsOf(r))) : null,
    cause ? h("span", { class: "run__cause" }, cause) : null
  );
  const b = h(
    "button",
    { class: "run__open", type: "button" },
    head,
    body
  );
  b.addEventListener("click", () => openRun(go, r));
  const status = live ? "live" : r.status === "failed" ? "failed" : waitsOf(r) > 0 ? "waiting" : "done";
  // A run going now: its dot in the character's own colour.
  return paintWho(h("li", { class: `run${fresh ? " is-fresh" : ""}`, "data-status": status }, b), a && r.status === "running" ? a.avatar : null);
}

// ---------- the empty team ----------

/** The empty page's example: one assistant's day, at times written the way the device writes them. */
const SAMPLE_DAY: Array<[number, number, string]> = [
  [9, 40, "Added a to-do: Fix the sync banner on iPad."],
  [11, 15, "Asked you before setting Friday as a due date."],
  [16, 30, "Skipped an issue already on your list."],
];

function sampleDay(): HTMLElement {
  const today = new Date();
  const at = (hh: number, mm: number) => new Date(today.getFullYear(), today.getMonth(), today.getDate(), hh, mm).toISOString();
  return h(
    "figure",
    { class: "team-hello__day", "aria-label": "Example: one assistant's day" },
    h("figcaption", { class: "team-hello__day-head" }, h("span", { class: "team-hello__tag" }, "Example"), "One assistant's day"),
    h(
      "ol",
      { class: "team-hello__day-list" },
      ...SAMPLE_DAY.map(([hh, mm, words], i) => h("li", { class: "team-hello__day-item", style: `--i:${i}` }, h("time", { class: "team-hello__day-time" }, clock(at(hh, mm))), h("span", {}, words)))
    )
  );
}

/** No assistants yet: a sample character says what one is for, and an example shows a day of one at work. */
function hello(go: Go): HTMLElement {
  const start = h("button", { class: "btn btn--primary team-hello__go", type: "button" }, icons.plus(), "Make your first assistant");
  start.addEventListener("click", () => toSetup(go));
  const shared = h("button", { class: "link-btn", type: "button" }, "Or import an assistant someone shared");
  shared.addEventListener("click", () => openImport(go));
  const ideas = EXAMPLES.map((ex) => {
    const c = h("button", { class: "team-hello__idea", type: "button" }, h("span", {}, ex), icons.arrowRight());
    c.addEventListener("click", () => toSetup(go, ex));
    return c;
  });
  return h(
    "div",
    { class: "team-hello" },
    h(
      "div",
      { class: "team-hello__figure" },
      helloFace(),
      h("p", { class: "team-hello__bubble" }, "Hi! Give me one job and I'll take care of it, every time.")
    ),
    h(
      "div",
      { class: "team-hello__text" },
      h("h2", { class: "team-hello__title" }, "Build a small team"),
      h("p", { class: "team-hello__sub" }, "Each assistant does one job in the background. Before it changes anything, it asks you, unless you've said it can go ahead."),
      sampleDay(),
      start,
      h("p", { class: "team-hello__label" }, "Or start from an idea"),
      h("div", { class: "team-hello__ideas" }, ...ideas),
      shared
    )
  );
}

// ---------- the page ----------

/**
 * Setup went on to the new assistant's first day (team/setup-first-day.ts),
 * which already says it joined: its day scene is in the setup sheet. Setup's
 * own markup is the only signal; nothing new is agreed with it.
 */
function metFirstDay(): boolean {
  return !!document.querySelector(".team-setup-sheet .ts-step--day");
}

function renderPage(ctx: TeamViewContext): { el: HTMLElement; destroy: () => void } {
  const count = h("span", { class: "page-count" });
  const lede = h("p", { class: "page-lede team-lede", "aria-live": "off" });
  const add = h("button", { class: "btn btn--soft btn--sm team-add", type: "button" }, icons.plus(), h("span", { class: "team-add__long" }, "New assistant"), h("span", { class: "team-add__short" }, "New"));
  add.addEventListener("click", () => {
    if (team.length >= MAX_ASSISTANTS) showToast(`A team has ${MAX_ASSISTANTS} assistants at most. Remove one to make room.`);
    else toSetup(ctx.go);
  });
  const said = h("p", { class: "visually-hidden", "aria-live": "polite" });
  // Team chat, with the one count of what waits, and New assignment.
  const chatCount = h("span", { class: "team-entry__count", hidden: true });
  const chat = h("a", { class: "btn btn--soft btn--sm", href: "#/team/chat" }, icons.chat(), "Team chat", chatCount);
  const assign = h("button", { class: "btn btn--soft btn--sm", type: "button" }, icons.plus(), "New assignment");
  assign.addEventListener("click", () => openNewAssignment());
  const offWaiting = watchWaiting((p) => {
    chatCount.hidden = !p.waiting;
    chatCount.textContent = p.waiting ? String(p.waiting) : "";
    chat.setAttribute("aria-label", p.waiting ? `Team chat. ${p.waiting === 1 ? "1 thing waits" : `${p.waiting} things wait`} for you.` : "Team chat");
  });

  const waitList = h("ul", { class: "wait-list" });
  const waiting = h("section", { class: "team-waiting", "aria-labelledby": "team-waiting-h", hidden: true }, h("div", { class: "section-head" }, h("h2", { id: "team-waiting-h" }, "Waiting for you")), waitList);
  const grid = h("div", { class: "desks" });
  const desks = h("section", { class: "team-desks", "aria-label": "Your assistants" }, grid);
  const dayList = h("div", { class: "team-feed" });
  const more = h("button", { class: "link-btn team-feed__more", type: "button", hidden: true }, "Show earlier");
  const day = h("section", { class: "team-day", "aria-labelledby": "team-day-h" }, h("div", { class: "section-head" }, h("h2", { id: "team-day-h" }, "Recent runs")), dayList, more);
  const layout = h("div", { class: "team-layout" }, h("div", { class: "team-main" }, waiting, desks), day);
  const body = h("div", { class: "team-body", "aria-busy": "true" });
  const el = h("div", { class: "view team" }, pageHead({ title: "Team", count, lede, actions: [add], below: [h("div", { class: "team-entry" }, chat, assign)] }), body, said);
  // A shared assistant's zip, assistant.json or folder dropped on the page: the import sheet, with it read.
  const hasFiles = (e: DragEvent) => !!e.dataTransfer && [...e.dataTransfer.types].includes("Files");
  el.addEventListener("dragover", (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    el.classList.add("team-drop");
  });
  el.addEventListener("dragleave", (e) => {
    if (e.target === el) el.classList.remove("team-drop");
  });
  el.addEventListener("drop", (e) => {
    el.classList.remove("team-drop");
    const files = [...(e.dataTransfer?.files ?? [])];
    if (!files.length) return;
    e.preventDefault();
    openImport(ctx.go, files);
  });

  let alive = true;
  let team: TeamAssistant[] = [];
  let runs: TeamRun[] = [];
  let setupOpen = false;
  let painted = false;
  let showAll = false;
  const deskEls = new Map<string, DeskEl>();
  /** Each run's status at the last look, to tell what's new. */
  let seen = new Map<string, string>();
  let feedKey = "";
  let waitKey = "";

  more.addEventListener("click", () => {
    showAll = true;
    feedKey = "";
    paint(new Set());
  });

  /** This device's conversations that may still hold a plan, by run id (team/page-pulse.ts). */
  let plans = new Map<string, readonly unknown[]>();

  function deskOf(a: TeamAssistant): Desk {
    return deskFor(a, runs, new Date(), waitsFrom(plans), (r) => isDismissed(r.id));
  }

  function paint(fresh: Set<string>) {
    body.removeAttribute("aria-busy");
    count.textContent = team.length ? String(team.length) : "";
    add.hidden = !team.length;
    if (!team.length) {
      lede.hidden = true;
      deskEls.clear();
      body.replaceChildren(hello(ctx.go));
      painted = false;
      return;
    }
    if (!painted) {
      body.replaceChildren(layout);
      painted = true;
    }
    lede.hidden = false;
    add.toggleAttribute("aria-disabled", team.length >= MAX_ASSISTANTS);
    add.title = team.length >= MAX_ASSISTANTS ? `A team has ${MAX_ASSISTANTS} assistants at most` : "";

    const all = new Map(team.map((a) => [a.id, deskOf(a)]));
    text(lede, teamLede(team, all));

    // The desks, in the owner's order: they don't move as runs start and stop.
    const order: HTMLElement[] = [];
    for (const a of team) {
      let d = deskEls.get(a.id);
      if (!d) deskEls.set(a.id, (d = desk(a, ctx.go)));
      d.update(a, all.get(a.id)!, fresh.size > 0);
      order.push(d.el);
    }
    for (const id of [...deskEls.keys()]) if (!team.some((a) => a.id === id)) deskEls.delete(id);
    if (order.length !== grid.children.length || order.some((n, i) => grid.children[i] !== n)) grid.replaceChildren(...order);

    // Waiting for you: a plan for Go, or a run that didn't finish.
    const waits = team.filter((a) => all.get(a.id)!.asks || all.get(a.id)!.state === "failed");
    const wk = waits.map((a) => `${a.id}:${all.get(a.id)!.last?.id}:${all.get(a.id)!.state}:${all.get(a.id)!.waits}`).join("|");
    if (wk !== waitKey) {
      waitKey = wk;
      waitList.replaceChildren(...waits.map((a) => waitingRow(a, all.get(a.id)!, ctx.go)));
      waiting.hidden = !waits.length;
      waiting.classList.remove("is-leaving");
      waiting.style.height = "";
    }

    // The day: live runs first, then finished ones, newest first.
    const byId = new Map(team.map((a) => [a.id, a]));
    const shown = runs.filter((r) => byId.has(r.assistant_id) && !(r.status === "failed" && /^paused\b/i.test(r.error ?? "")));
    const ordered = [...shown.filter(isLive), ...shown.filter((r) => !isLive(r))];
    const today = ordered.filter((r) => isLive(r) || sameDay(new Date(r.finished_at ?? r.started_at), new Date()));
    const limit = showAll ? ordered.length : Math.max(FEED_FIRST, today.length);
    const list = ordered.slice(0, limit);
    const waitsOf = waitsFrom(plans);
    const fk = list.map((r) => `${r.id}:${r.status}:${r.step ?? ""}:${r.summary ?? ""}:${waitsOf(r)}`).join("|");
    if (fk !== feedKey) {
      feedKey = fk;
      const groups = byDay(list);
      if (!today.length) groups.unshift(["Today", []]);
      dayList.replaceChildren(
        ...groups.map(([label, rs]) =>
          h(
            "div",
            { class: "team-feed__group" },
            h("h3", { class: "team-feed__label" }, label),
            rs.length ? h("ul", { class: "team-feed__runs" }, ...rs.map((r) => dayRun(r, byId.get(r.assistant_id), ctx.go, fresh.has(r.id), waitsOf))) : h("p", { class: "team-feed__quiet" }, "Nothing yet today.")
          )
        )
      );
    }
    more.hidden = showAll || ordered.length <= limit;
  }

  /** #/team/import: an older address for #/add, which also takes a file shared to the installed app. */
  function maybeImport() {
    if (ctx.param !== "import" || setupOpen) return;
    setupOpen = true;
    location.replace("#/add");
  }

  function maybeSetup() {
    if (ctx.param !== "new" || setupOpen) return;
    setupOpen = true;
    const words = setupText;
    setupText = undefined;
    let made: TeamAssistant | null = null;
    let metOnFirstDay = false;
    openSetup({
      taken: team.map((a) => a.name),
      count: team.length,
      text: words,
      onAdded: (a) => {
        made = a;
        justAdded = a.id;
        window.setTimeout(() => (justAdded = null), 3000);
        // Setup may go on to the assistant's first day, which already says it joined.
        // A frame after the add, its day scene is on screen if it did: no toast then.
        requestAnimationFrame(() => (metOnFirstDay = metFirstDay()));
      },
      onClose: () => {
        if (made && !metOnFirstDay) showToast(`${made.name} joined your team`);
        backToGrid(ctx.go);
      },
      onImport: () => openImport(ctx.go),
    });
  }

  /** What changed since the last look, said once for screen readers, and marked fresh on screen. */
  function news(): Set<string> {
    const fresh = new Set<string>();
    const lines: string[] = [];
    const first = seen.size === 0;
    const next = new Map<string, string>();
    for (const r of runs) {
      next.set(r.id, r.status);
      const was = seen.get(r.id);
      if (first || was === r.status) continue;
      fresh.add(r.id);
      const who = team.find((a) => a.id === r.assistant_id)?.name;
      if (!who) continue;
      if (r.status === "running" && was !== "running") lines.push(`${who} started: ${nowWords(r)}.`);
      else if (r.status === "done" || r.status === "failed") lines.push(`${who}: ${resultWords(r)}`);
    }
    seen = next;
    if (lines.length) said.textContent = lines.join(" ");
    return fresh;
  }

  async function look(): Promise<boolean> {
    const [t, r] = await Promise.all([listTeam(), listActivity(50).catch(() => runs)]);
    if (!alive) return false;
    team = t;
    runs = r;
    plans = await planCounts(runs);
    if (!alive) return false;
    paint(news());
    maybeSetup();
    maybeImport();
    return runs.some(isLive);
  }

  const live = keepLooking({
    look: async () => {
      try {
        return await look();
      } catch (e) {
        if (alive && !painted && !team.length) body.replaceChildren(h("div", { class: "empty" }, h("p", { class: "empty__title" }, "Your team didn't load"), h("p", { class: "empty__sub" }, "Check you're online and try again.")));
        throw e;
      }
    },
  });
  const off = onTeamChange(() => live.now());
  // A Go in Ask lowers what waits: read the conversations again and redraw.
  const offThreads = onThreadsChange(() => {
    if (!alive || !painted) return;
    void planCounts(runs).then((p) => {
      if (!alive) return;
      plans = p;
      paint(new Set());
    });
  });
  // A dismissal changes only what's drawn: no need to ask the server again.
  const offDismiss = onDismissChange(() => alive && painted && paint(new Set()));
  return {
    el,
    destroy() {
      alive = false;
      live.stop();
      off();
      offDismiss();
      offThreads();
      offWaiting();
    },
  };
}

export function renderTeam(ctx: TeamViewContext): { el: HTMLElement; destroy: () => void } {
  // #/team/chat, #/team/chat/<post id>: Team chat, at a post. #/team/assignment/<id>: one assignment.
  if (ctx.param === "chat" || ctx.param?.startsWith("chat/")) return renderTeamChat({ postId: Number(ctx.param.split("/")[1]) || null });
  if (ctx.param?.startsWith("assignment/")) return renderAssignment({ id: ctx.param.slice("assignment/".length) });
  if (ctx.param && ctx.param !== "new" && ctx.param !== "import") return renderTeamDetail({ id: ctx.param, back: () => backToGrid(ctx.go) });
  return renderPage(ctx);
}
