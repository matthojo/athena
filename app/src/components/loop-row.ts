/**
 * One open loop: a check circle, the title, and a line saying who it's with
 * and when it's due. Ticking it plays the check, rests a moment, folds the
 * row away, then saves and offers Undo; the list it lives in repaints without
 * it. The same row (and motion) is used on To do, Home and a person's sheet. Decisions have no check — they're
 * a record, not something to close.
 */

import { h } from "../lib/dom";
import { icons } from "./icons";
import { showToast } from "./toast";
import { setCommitmentStatus } from "../db/memory";
import { COMMITMENT_META } from "../lib/memory-meta";
import { describeSource } from "../lib/sources";
import { contextTags } from "./todo-context-ui";
import { calendarDate, relativeTime } from "../lib/format";
import { daysBetween } from "../../../lib/dates";
import { localToday } from "../lib/time";
import { collapse, dur, expand, finishPlan, finishQueue, motionWait } from "../lib/finish-motion";
import { prefersReducedMotion } from "../lib/motion";
import { priorityMark } from "./todo-props";
import { PRIORITY_LABEL, stepProgress } from "../../../lib/todo-details";
import "../styles/todo-detail.css";
import type { Commitment } from "../types";

/**
 * To-dos coming back (Undo, or reopened from Done): whichever list shows one
 * next opens its row out rather than dropping it in. Cleared once it has
 * played, or after a couple of seconds if no list shows it.
 */
const restoring = new Set<string>();

function markRestoring(id: string) {
  restoring.add(id);
  setTimeout(() => restoring.delete(id), 2000);
}

/** Open a coming-back row out once it's on screen, unless its whole group is already opening. */
function openWhenShown(row: HTMLElement, id: string) {
  requestAnimationFrame(() => {
    if (!row.isConnected || !restoring.has(id)) return;
    restoring.delete(id);
    if (row.closest(".is-unfolding")) return;
    void expand(row);
  });
}

/** The group a row is the last one in (To do's "Today", "Next 7 days"…), if ticking it empties it. */
function emptiedGroup(row: HTMLElement): HTMLElement | null {
  const group = row.closest<HTMLElement>(".group");
  if (!group) return null;
  const others = [...group.querySelectorAll<HTMLElement>(".loop")].filter((r) => r !== row && r.dataset.folded === undefined);
  return others.length ? null : group;
}

const firstName = (name: string) => name.replace(/^(dr|mr|mrs|ms)\.?\s+/i, "").split(/\s+/)[0];

/** "Today", "Tomorrow", "Fri", "12 Dec"; "Yesterday" / "3 days late" once it's passed. */
export function dueLabel(due: string, today = localToday()): { text: string; tone: "late" | "soon" | "" } {
  const n = daysBetween(today, due);
  if (n < -1) return { text: `${-n} days late`, tone: "late" };
  if (n === -1) return { text: "Yesterday", tone: "late" };
  if (n === 0) return { text: "Today", tone: "soon" };
  if (n === 1) return { text: "Tomorrow", tone: "soon" };
  if (n < 7) return { text: new Intl.DateTimeFormat("en-GB", { weekday: "short", timeZone: "UTC" }).format(new Date(`${due}T12:00:00Z`)), tone: "" };
  return { text: calendarDate(due), tone: "" };
}

/** "For Priya" / "Waiting on Marcus" — or, on a person's own page, "For them" / "Waiting on them". */
export function loopRelation(c: Commitment, showPerson = true): string {
  const who = showPerson && c.person ? firstName(c.person.name) : "";
  switch (c.kind) {
    case "i_owe":
      return who ? `For ${who}` : showPerson ? "" : "For them";
    case "waiting_on":
      return who ? `Waiting on ${who}` : showPerson ? "Waiting on" : "Waiting on them";
    case "decision":
      return who ? `Decided with ${who}` : "Decision";
    default:
      return "";
  }
}

/** "2/5" with a filling ring, a link count, and a mark when there's a description. Null when there's nothing. */
function detailMarks(c: Commitment): HTMLElement | null {
  const items: HTMLElement[] = [];
  const p = stepProgress(c.steps);
  if (p.total) {
    const ring = h("span", { class: "loop__progress", "aria-hidden": "true" });
    ring.style.setProperty("--p", String(p.done / p.total));
    items.push(h("span", { class: "loop__mark-item", "data-complete": String(p.done === p.total), title: `${p.done} of ${p.total} steps done`, "aria-label": `${p.done} of ${p.total} steps done` }, ring, `${p.done}/${p.total}`));
  }
  const n = c.links?.length ?? 0;
  if (n) items.push(h("span", { class: "loop__mark-item", title: `${n} ${n === 1 ? "link" : "links"}`, "aria-label": `${n} ${n === 1 ? "link" : "links"}` }, icons.link(), n > 1 ? String(n) : null));
  if (c.notes?.trim()) items.push(h("span", { class: "loop__mark-item", title: "Has a description", "aria-label": "Has a description" }, icons.lines()));
  return items.length ? h("span", { class: "loop__marks" }, ...items) : null;
}

export function loopRow(c: Commitment, opts: { onOpen: (c: Commitment) => void; showPerson?: boolean; today?: string; hideContext?: "area" | "where" }): HTMLElement {
  const done = c.status === "done";
  const decision = c.kind === "decision";
  const relation = loopRelation(c, opts.showPerson ?? true);
  const meta: Node[] = [];
  // A decision's flag already leads the row; its relation line needs no icon.
  if (relation) meta.push(h("span", { class: "loop__rel", "data-kind": c.kind }, decision ? null : icons[COMMITMENT_META[c.kind].icon](), relation));
  if (done && c.done_at && !decision) meta.push(h("span", { class: "loop__due" }, `Done ${relativeTime(c.done_at)}`));
  else if (c.due_on && !decision) {
    const due = dueLabel(c.due_on, opts.today);
    meta.push(h("span", { class: "loop__due", "data-tone": due.tone || undefined }, due.tone === "late" ? icons.clock() : null, due.text));
  }
  // What it carries: its steps (with a ring that fills as they're ticked), links and a description.
  if (!decision && !done) {
    const marks = detailMarks(c);
    if (marks) meta.push(marks);
  }
  // Its area and where/how: quiet, after the date. Hidden on a decision.
  if (!decision) meta.push(...contextTags(c).filter((t) => t.dataset.kind !== opts.hideContext));
  if (c.source && c.source !== "manual") {
    const src = describeSource(c.source);
    const sparkle = h("span", { class: "loop__source", title: `Added by ${src.name}`, "aria-label": `Added by ${src.name}` }, icons.sparkle());
    // The sparkle travels with whatever is before it, so a narrow row never wraps it onto a line of its own.
    const last = meta.pop();
    meta.push(last ? h("span", { class: "loop__tail" }, last, sparkle) : sparkle);
  }

  // A priority leads the title, so the urgent ones stand out in the list.
  const prio = !decision && !done && c.priority ? h("span", { class: "loop__prio", "data-priority": String(c.priority), title: `${PRIORITY_LABEL[c.priority]} priority`, role: "img", "aria-label": `${PRIORITY_LABEL[c.priority]} priority` }, priorityMark(c.priority)) : null;
  const body = h(
    "button",
    { class: "loop__body", type: "button" },
    h("span", { class: "loop__title" }, prio, c.title),
    meta.length ? h("span", { class: "loop__meta" }, ...meta) : null
  );
  body.addEventListener("click", () => opts.onOpen(c));

  const row = h("div", { class: "loop", "data-kind": c.kind, "data-state": done ? "done" : "open", "data-flip": `loop:${c.id}` });
  if (decision) {
    row.append(h("span", { class: "loop__mark", "aria-hidden": "true" }, icons.flag()), body);
    return row;
  }

  const check = h(
    "button",
    { class: "loop__check", type: "button", role: "checkbox", "aria-checked": String(done), "aria-label": done ? `Reopen “${c.title}”` : `Mark “${c.title}” done` },
    h("span", { class: "loop__ring", "aria-hidden": "true" }, icons.check())
  ) as HTMLButtonElement;
  // Tick: the check lands, the row rests ticked for a moment (a second tap
  // there takes it back), then folds away and the rows below slide up. An
  // emptied group's heading folds after it. Only then is it saved, so the
  // list's repaint has nothing left to jump. Undo opens it back out.
  // If the page is hidden or closed while it waits, it saves at once
  // (lib/finish-motion.ts, finishQueue) and skips the rest of the motion.
  let pending: number | undefined;
  let state: "rest" | "holding" | "folding" = "rest";
  let committed = false;
  let unqueue: (() => void) | null = null;
  let group: HTMLElement | null = null;
  const show = (s: "done" | "open") => {
    row.dataset.state = s;
    check.setAttribute("aria-checked", String(s === "done"));
  };
  check.addEventListener("click", () => {
    if (state === "folding") return;
    if (state === "holding") {
      clearTimeout(pending);
      unqueue?.();
      unqueue = null;
      state = "rest";
      row.classList.remove("is-ticked");
      show(done ? "done" : "open");
      return;
    }
    const next = done ? "open" : "done";
    state = "holding";
    show(next);
    if (next === "done") {
      row.classList.remove("is-ticked");
      void row.offsetWidth;
      row.classList.add("is-ticked");
    }
    unqueue = finishQueue().add(() => {
      clearTimeout(pending);
      void commit(next);
    });
    // Reopening a done one doesn't need the pause: it's going back to work.
    const plan = finishPlan({ fast: dur("--dur-fast"), hold: next === "done" ? dur("--dur-hold") : dur("--dur-fast"), base: dur("--dur-base"), lastInGroup: false, reduced: prefersReducedMotion() });
    pending = window.setTimeout(() => void finish(next), plan.collapseAt);
  });

  async function finish(next: "done" | "open") {
    state = "folding";
    check.disabled = true;
    group = emptiedGroup(row);
    const g = group;
    const folding = row.isConnected ? collapse(row) : Promise.resolve();
    // The group heading goes after the row, starting halfway through its fold.
    const groupFold = g ? motionWait(prefersReducedMotion() ? 0 : dur("--dur-base") / 2).then(() => collapse(g)) : Promise.resolve();
    await Promise.all([folding, groupFold]);
    await commit(next);
  }

  /** Save the tick, once: after the fold, or straight away if the page is hidden first. */
  async function commit(next: "done" | "open") {
    if (committed) return;
    committed = true;
    unqueue?.();
    unqueue = null;
    try {
      if (next === "open") markRestoring(c.id);
      await setCommitmentStatus(c, next);
      if (next === "done") {
        showToast(`Done: ${c.title}`, {
          icon: "check",
          action: {
            label: "Undo",
            run: () => {
              markRestoring(c.id);
              void setCommitmentStatus(c, "open").catch(() => showToast("Couldn't undo", { icon: "wifiOff" }));
            },
          },
        });
      }
    } catch (error) {
      // Not saved: open it back out as it was.
      committed = false;
      state = "rest";
      row.classList.remove("is-ticked");
      show(done ? "done" : "open");
      check.disabled = false;
      if (group) void expand(group);
      if (row.dataset.folded !== undefined) void expand(row);
      showToast(error instanceof Error ? error.message : "Couldn't save", { icon: "wifiOff", timeoutMs: 4000 });
    }
  }
  row.append(check, body);
  if (restoring.has(c.id) && !done) openWhenShown(row, c.id);
  return row;
}
