/**
 * Settings → Ask: skills, Ask on the web, and a way in to What Ask did
 * (lib/ask-activity.ts), every change Ask made, newest first, with Open and
 * Undo. Routines moved to Team (lib/team-migrate.ts).
 */
import "../styles/ask-plans.css";
import { h } from "../lib/dom";
import { icons } from "./icons";
import { showToast } from "./toast";
import { openItem } from "../lib/open-item";
import { requestOpen } from "../db/ask-threads";
import { askWebSetting } from "./ask-web-setting";
import { communitySetting } from "../community/setting";
import { fetchActivity, undoActivity, type ActivityEntry } from "../db/ask-plans";
import { flowRunHref, flowRunOf, flowSourceWords, isFlowActivity, type FlowActivityFields } from "../flows/activity";
import { clockTime } from "../lib/clock";

/** #/settings/ask: Skills and What Ask did one step in. Routines moved to Team. */
export function askSettingsSection(ctx: { open: (id: "ask-activity" | "skills") => void }): { el: HTMLElement; destroy: () => void } {
  const entry = h(
    "button",
    { class: "row", type: "button" },
    h("span", { class: "tile tile--sm" }, icons.restore()),
    h("span", { class: "row__body" }, h("span", { class: "row__title" }, "What Ask did"), h("span", { class: "row__meta" }, "Every change Ask made, newest first, with Undo")),
    h("span", { class: "row__trail" }, h("span", { class: "row__chevron", "aria-hidden": "true" }, icons.chevronRight()))
  );
  entry.addEventListener("click", () => ctx.open("ask-activity"));
  const skills = h(
    "button",
    { class: "row", type: "button" },
    h("span", { class: "tile tile--sm" }, icons.book()),
    h("span", { class: "row__body" }, h("span", { class: "row__title" }, "Skills"), h("span", { class: "row__meta" }, "Instructions for how Ask handles some kinds of request")),
    h("span", { class: "row__trail" }, h("span", { class: "row__chevron", "aria-hidden": "true" }, icons.chevronRight()))
  );
  skills.addEventListener("click", () => ctx.open("skills"));

  return {
    el: h(
      "section",
      { class: "settings__section settings__section--ask", "aria-labelledby": "settings-ask" },
      h("div", { class: "src-head" }, h("h2", { class: "settings__heading", id: "settings-ask" }, icons.sparkle(), "Ask")),
      h("p", { class: "settings__lede" }, "How Ask handles some kinds of request, and a record of every change it made. Questions that run on a schedule are on the ", h("a", { href: "#/team" }, "Team page"), "."),
      h(
        "div",
        { class: "settings__body" },
        h("div", { class: "card card--flush list settings__sub" }, skills),
        h("div", { class: "card settings__sub ask-web-card" }, askWebSetting()),
        h("div", { class: "card settings__sub ask-web-card" }, communitySetting()),
        h("div", { class: "card card--flush list settings__sub" }, entry)
      )
    ),
    destroy: () => undefined,
  };
}

// ---------- What Ask did ----------

// "flow": a plain flow's change (flows/activity.ts). It reads "Flow: <name>" and links to its run.
const SOURCE: Record<ActivityEntry["source"], string> = { ask: "Ask", plan: "A plan", routine: "A routine", nudge: "From Athena", team: "Your team", flow: "A flow" };

/** A flow's name from one of its runs, when the entry doesn't carry it. Flows load only when a flow's change is listed. */
let flowNames: Promise<Map<string, string>> | null = null;
async function flowNameForRun(runId: string): Promise<string | null> {
  const { getRun, listFlows } = await import("../db/flows");
  flowNames ??= listFlows().then((r) => new Map(r.flows.map((f) => [f.id, f.name])), () => ((flowNames = null), new Map()));
  const run = await getRun(runId).catch(() => null);
  return run ? ((await flowNames).get(run.flow_id) ?? null) : null;
}

/** Who made the change: a word, or for a flow its name and a link to the run. */
function sourceOf(e: ActivityEntry): Node {
  const f: FlowActivityFields = e;
  if (!isFlowActivity(f)) return document.createTextNode(SOURCE[e.source] ?? "Ask");
  const run = flowRunOf(f);
  const el = run ? h("a", { href: flowRunHref(run) }, flowSourceWords(f.flow_name)) : h("span", {}, flowSourceWords(f.flow_name));
  if (run && !f.flow_name?.trim()) void flowNameForRun(run).then((n) => n && (el.textContent = flowSourceWords(n)));
  return el;
}
const timeOf = (iso: string) => clockTime(iso);
function dayOf(iso: string): string {
  const d = new Date(iso);
  const today = new Date();
  const y = new Date(Date.now() - 86_400_000);
  if (d.toDateString() === today.toDateString()) return "Today";
  if (d.toDateString() === y.toDateString()) return "Yesterday";
  return new Intl.DateTimeFormat(undefined, { weekday: "long", day: "numeric", month: "long" }).format(d);
}

function activityRow(e: ActivityEntry, repaint: (next: ActivityEntry) => void): HTMLElement {
  const c = e.change;
  const meta = h("span", { class: "activity-row__meta" }, `${timeOf(e.at)} · `, sourceOf(e));
  if (e.thread_id) {
    const link = h("a", { href: "#/ask" }, "the conversation");
    link.addEventListener("click", () => requestOpen(e.thread_id!));
    meta.append(" · ", link);
  }
  const trail = h("span", { class: "activity-row__trail" });
  if (c.open && e.state !== "undone") {
    const open = h("button", { class: "btn btn--ghost btn--sm", type: "button", "aria-label": `Open ${c.title}` }, "Open");
    open.addEventListener("click", () => {
      const o = c.open!;
      // A routine is a Team assistant now (save_routine makes one): its page. Older entries' ids find nothing there.
      if (o.kind === "routine") location.hash = `#/team/${o.id}`;
      else if (o.kind === "skill") location.hash = `#/settings/skills/${o.id}`;
      else if ("id" in o) void openItem(o).then((ok) => ok || (location.hash = `#/${o.kind === "person" ? "people" : o.kind === "note" ? "notes" : o.kind}/${o.id}`));
    });
    trail.append(open);
  }
  if (e.state === "undone") trail.append(h("span", { class: "activity-state" }, icons.restore(), "Undone"));
  else if (e.state === "undo_failed") trail.append(h("span", { class: "activity-state activity-state--failed" }, "Couldn't undo"));
  else if (c.undo) {
    const undo = h("button", { class: "btn btn--soft btn--sm", type: "button", "aria-label": `Undo: ${c.label}` }, "Undo") as HTMLButtonElement;
    undo.addEventListener("click", async () => {
      undo.disabled = true;
      undo.textContent = "Undoing…";
      try {
        repaint(await undoActivity(e.id));
      } catch (error) {
        const status = (error as { status?: number }).status;
        if (status && status >= 400 && status < 500 && status !== 429) repaint({ ...e, state: "undo_failed" });
        else {
          undo.disabled = false;
          undo.textContent = "Undo";
          showToast("Couldn't undo that. Try again in a moment.", { icon: "restore" });
        }
      }
    });
    trail.append(undo);
  } else trail.append(h("span", { class: "activity-state" }, icons.check(), "Done"));
  return h(
    "div",
    { class: `activity-row${e.state === "undone" ? " is-undone" : ""}` },
    h("span", { class: "tile tile--sm", "aria-hidden": "true" }, icons[c.kind === "event" ? "calendar" : c.kind === "commitment" ? "loop" : c.kind === "draft" ? "mail" : c.kind === "person" ? "person" : c.kind === "reading" ? "bookmark" : c.kind === "routine" ? "refresh" : c.kind === "skill" ? "book" : c.kind === "price" || c.kind === "tracker" ? "tag" : c.kind === "reminder" ? "bell" : "note"]()),
    h("span", { class: "activity-row__body" }, h("span", { class: "activity-row__title" }, c.title), h("span", { class: "activity-row__detail" }, c.detail), meta),
    trail
  );
}

/** #/settings/ask-activity: every change, grouped by day, newest first. */
export function askActivitySection(): { el: HTMLElement; destroy: () => void } {
  const body = h("div", { class: "settings__body" }, h("p", { class: "settings__lede" }, "Loading…"));
  let entries: ActivityEntry[] = [];
  const paint = () => {
    if (!entries.length) return body.replaceChildren(h("p", { class: "settings__lede" }, "Nothing yet. When Ask changes something, from a reply, a plan, a routine or a card on Home, it's listed here with Undo."));
    const out: HTMLElement[] = [];
    let day = "";
    let card: HTMLElement | null = null;
    for (const e of entries) {
      const d = dayOf(e.at);
      if (d !== day) {
        day = d;
        out.push(h("h3", { class: "activity-day" }, d));
        card = h("div", { class: "card card--flush" });
        out.push(card);
      }
      card!.append(activityRow(e, (next) => {
        entries = entries.map((x) => (x.id === next.id ? next : x));
        paint();
      }));
    }
    body.replaceChildren(...out);
  };
  void fetchActivity().then(
    (got) => {
      entries = got;
      paint();
    },
    () => body.replaceChildren(h("p", { class: "settings__lede" }, "What Ask did needs a connection."))
  );
  return {
    el: h(
      "section",
      { class: "settings__section settings__section--ask-activity", "aria-labelledby": "settings-ask-activity" },
      h("div", { class: "src-head" }, h("h2", { class: "settings__heading", id: "settings-ask-activity" }, icons.restore(), "What Ask did")),
      h("p", { class: "settings__lede" }, "Every change Ask made, newest first. Undo works here the same as in the conversation."),
      body
    ),
    destroy: () => undefined,
  };
}
