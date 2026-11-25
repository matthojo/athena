/**
 * One assignment (docs/team.md "Assignments"): #/team/assignment/<id>.
 *
 *   the row of tiles   the lineup in order, the working dot on the stage
 *                      that's running, a badge on one that waits
 *   what waits         the same question, approval or plan as Team chat
 *   the document       Download and Send to, once there is one
 *   the trail          each stage: its handoff, its questions (with
 *                      "Suggested, taken for you"), what changed, and
 *                      "Keep <Name> on the team" on a guest
 *   Stop               while it runs or waits
 *
 * It looks again when the assignment changes, and every few seconds while
 * a stage works.
 */
import "../styles/team-assign.css";
import "../styles/ask-plans.css";
import { h } from "../lib/dom";
import { icons } from "../components/icons";
import { showToast } from "../components/toast";
import { deleteAssignment, getAssignment, go, keepAssistant, onAssignmentsChange, patchAssignment, patchStage, stop, type Assignment } from "../db/assignments";
import { isSampleMode } from "../db/api";
import { renderAvatarTile, setAvatarMood } from "./avatar";
import { paintWho } from "./dot-colour";
import { clock, whenShort } from "./page-words";
import { assignmentLine, CHECKPOINT_WORD, guestLine, LAST_STAGE_NOTE, stageBadge, stageOf, stageStep } from "./assign-words";
import { answersEl, approvalCard, documentCard, handoffEl, planCard, planElsewhere, questionCard } from "./chat-posts";
import type { AssignmentStage } from "../../../lib/assignment-types";

const say = (e: unknown, fallback: string) => showToast(e instanceof Error && e.message && !/^\d{3} /.test(e.message) ? e.message : fallback, { icon: "refresh" });

/** The lineup as a row of tiles, in order. */
function tilesRow(a: Assignment): HTMLElement {
  return h(
    "ol",
    { class: "stages", "aria-label": "The lineup" },
    ...a.stages.map((s) => {
      const working = s.status === "running";
      const tile = renderAvatarTile(s.who.avatar, { size: 56, animate: false });
      if (working) setAvatarMood(tile, "thinking");
      const badge = stageBadge(s);
      const li = h(
        "li",
        { class: "stage-tile", "data-status": s.status, ...(working || s.status === "waiting" ? { "aria-current": "step" } : {}) },
        h("span", { class: "stage-tile__face" }, tile),
        h("span", { class: "stage-tile__name" }, s.who.name),
        h("span", { class: "stage-tile__sub" }, s.who.guest ? "Guest" : "On your team"),
        badge ? h("span", { class: "stage-tile__badge" }, working ? h("span", { class: "team-dot", "aria-hidden": "true" }) : null, badge) : h("span", { class: "stage-tile__badge stage-tile__badge--quiet" }, "Up next")
      );
      return paintWho(li, working ? s.who.avatar : null);
    })
  );
}

export function renderAssignment(ctx: { id: string }): { el: HTMLElement; destroy: () => void } {
  let alive = true;
  let timer = 0;
  let key = "";
  const back = h("a", { class: "ta-back", href: "#/team/chat" }, icons.back(), h("span", {}, "Team chat"));
  const body = h("div", { class: "asg__body", "aria-busy": "true" });
  const said = h("p", { class: "visually-hidden", "aria-live": "polite" });
  const el = h("div", { class: "view asg" }, h("div", { class: "ta-top" }, back), body, said);

  function stageTrail(a: Assignment, s: AssignmentStage): HTMLElement {
    const last = s.position === a.stages.length - 1;
    const p = h("div", { class: "trail__body" });
    const from = s.sent_back_from != null ? a.stages[s.sent_back_from] : null;
    if (from) p.append(h("p", { class: "trail__back" }, `Sent back${from.id === s.id ? "" : ` from ${from.who.name}`}${s.note ? `: “${s.note}”` : "."}`));
    if (s.status === "running") p.append(h("p", { class: "trail__now" }, h("span", { class: "team-dot", "aria-hidden": "true" }), stageStep(s)));
    if (s.answers.length) p.append(answersEl(s.answers));
    if (s.handoff) {
      const hd = handoffEl(s.handoff);
      if (hd) p.append(hd);
    }
    if (s.status === "failed") p.append(h("p", { class: "trail__failed" }, `${s.who.name} didn't finish this stage.`));
    // Go tries that stage again (POST /:id/go), as its post in Team chat says.
    if (s.status === "failed" && a.status === "failed") {
      const again = h("button", { class: "btn btn--primary btn--sm trail__keep", type: "button", "aria-label": `Approve: try ${s.who.name}'s stage again` }, "Approve") as HTMLButtonElement;
      again.addEventListener("click", () => {
        if (again.disabled) return;
        again.disabled = true;
        void go(a.id).catch((e) => ((again.disabled = false), say(e, "That didn't start. Try again in a moment.")));
      });
      p.append(again);
    }
    // A stage that hasn't run: whether it stops for approval can still change.
    if (s.status === "pending" && (a.status === "running" || a.status === "waiting")) {
      if (last) p.append(h("p", { class: "trail__quiet" }, LAST_STAGE_NOTE));
      else {
        const b = h("button", { class: "lineup__check", type: "button", "aria-pressed": String(s.checkpoint === "approve"), "aria-label": `After ${s.who.name}: ${CHECKPOINT_WORD[s.checkpoint]}` }, h("span", { class: "lineup__check-mark", "aria-hidden": "true" }), CHECKPOINT_WORD[s.checkpoint]);
        b.addEventListener("click", () => void patchStage(a.id, s.position, { checkpoint: s.checkpoint === "approve" ? "auto" : "approve" }).catch((e) => say(e, "That didn't save. Try again in a moment.")));
        p.append(b);
      }
    }
    if (s.who.guest && s.status !== "pending" && s.status !== "skipped") {
      const keep = h("button", { class: "btn btn--soft btn--sm trail__keep", type: "button" }, `Keep ${s.who.name} on the team`) as HTMLButtonElement;
      const full = h("p", { class: "trail__full", role: "alert", hidden: true });
      keep.addEventListener("click", async () => {
        if (keep.getAttribute("aria-busy")) return;
        keep.setAttribute("aria-busy", "true");
        full.hidden = true;
        try {
          const kept = await keepAssistant(s.who.id);
          showToast(`${kept.name} joined your team. Add when ${kept.name} runs on this page.`);
          location.hash = `#/team/${encodeURIComponent(kept.id)}`;
        } catch (e) {
          // The team is full (409): the server's words stay on the page, by the button.
          if ((e as { status?: number }).status === 409 && e instanceof Error) {
            full.textContent = e.message;
            full.hidden = false;
          } else say(e, `${s.who.name} couldn't be kept. Try again in a moment.`);
          keep.removeAttribute("aria-busy");
        }
      });
      p.append(keep, full);
    }
    const when = s.finished_at ? `Finished ${whenShort(s.finished_at)}` : s.started_at ? `Started ${clock(s.started_at)}` : "";
    const badge = stageBadge(s);
    return paintWho(
      h(
        "li",
        { class: "trail__stage", "data-status": s.status },
        renderAvatarTile(s.who.avatar, { size: 36, animate: false }),
        h(
          "div",
          { class: "trail__main" },
          h("div", { class: "trail__head" }, h("span", { class: "who-words" }, h("span", { class: "who-words__name" }, s.who.name), h("span", { class: "who-words__sub" }, guestLine(s.who))), badge ? h("span", { class: "trail__badge" }, badge) : null),
          h("p", { class: "trail__task" }, s.task),
          when ? h("p", { class: "trail__when" }, `${stageOf(a, s)} · ${when}`) : h("p", { class: "trail__when" }, stageOf(a, s)),
          p
        )
      ),
      s.status === "running" ? s.who.avatar : null
    );
  }

  function paint(a: Assignment) {
    const active = a.status === "running" || a.status === "waiting";
    const waiting = a.stages.find((s) => s.status === "waiting");
    const stopBtn = h("button", { class: "btn btn--soft btn--sm", type: "button" }, icons.stop(), "Stop") as HTMLButtonElement;
    stopBtn.addEventListener("click", async () => {
      if (stopBtn.getAttribute("aria-busy")) return;
      stopBtn.setAttribute("aria-busy", "true");
      try {
        await stop(a.id);
        showToast("Stopped. What was done so far is kept.");
      } catch (e) {
        say(e, "It didn't stop. Try again in a moment.");
        stopBtn.removeAttribute("aria-busy");
      }
    });
    // Remove takes two taps: the first asks.
    const remove = h("button", { class: "btn btn--ghost btn--sm", type: "button" }, "Remove") as HTMLButtonElement;
    let sure = 0;
    remove.addEventListener("click", async () => {
      if (!sure) {
        remove.textContent = "Remove for good?";
        sure = window.setTimeout(() => ((sure = 0), (remove.textContent = "Remove")), 4000);
        return;
      }
      window.clearTimeout(sure);
      try {
        await deleteAssignment(a.id);
        showToast("Removed, with its guests and its posts.");
        location.hash = "#/team/chat";
      } catch (e) {
        say(e, "It couldn't be removed. Try again in a moment.");
      }
    });

    // What waits: the same card as in Team chat.
    const wait = h("div", { class: "asg__wait" });
    if (waiting?.waits_for === "answer" && waiting.questions.length) wait.append(questionCard(a.id, waiting.questions, waiting.who));
    else if (waiting?.waits_for === "approval") wait.append(approvalCard(a, waiting));
    else if (waiting?.waits_for === "go") {
      const slot = h("div", {});
      wait.append(slot);
      void (waiting.thread_id ? planCard(waiting.thread_id, waiting.who.name) : Promise.resolve(null)).then((card) => slot.replaceChildren(card ?? planElsewhere(waiting.thread_id, waiting.who.name)));
    }

    const take = a.suggestions === "take";
    const sugg = h("button", { class: "lineup__check", type: "button", "aria-pressed": String(take) }, h("span", { class: "lineup__check-mark", "aria-hidden": "true" }), take ? "Questions take the suggested answer" : "Questions come to you");
    sugg.addEventListener("click", () => void patchAssignment(a.id, { suggestions: take ? "ask" : "take" }).catch((e) => say(e, "That didn't save. Try again in a moment.")));

    body.removeAttribute("aria-busy");
    const parts: Array<HTMLElement | null> = [
      h(
        "header",
        { class: "asg__head" },
        h("div", { class: "asg__title-row" }, h("h1", { class: "page-title asg__title" }, a.title), active ? stopBtn : remove),
        h("p", { class: "asg__status", "data-status": a.status }, a.status === "running" ? h("span", { class: "team-dot", "aria-hidden": "true" }) : null, assignmentLine(a)),
        h("p", { class: "asg__brief" }, a.brief)
      ),
      tilesRow(a),
      wait.childElementCount ? wait : null,
      a.status === "done" || a.documents.length ? documentCard(a.title, a.note_id, a.documents, { openNote: !isSampleMode() }) : null,
      active ? h("div", { class: "asg__set" }, sugg, take ? h("span", { class: "asg__set-note" }, "A change still waits for your approval.") : null) : null,
      h("section", { class: "trail", "aria-labelledby": "asg-trail-h" }, h("div", { class: "section-head" }, h("h2", { id: "asg-trail-h" }, "The trail")), h("ol", { class: "trail__list" }, ...a.stages.map((s) => stageTrail(a, s)))),
    ];
    body.replaceChildren(...parts.filter((x): x is HTMLElement => !!x));
  }

  async function look() {
    window.clearTimeout(timer);
    const a = await getAssignment(ctx.id);
    if (!alive) return;
    if (!a) {
      body.removeAttribute("aria-busy");
      body.replaceChildren(h("div", { class: "empty" }, h("p", { class: "empty__title" }, "That assignment isn't here"), h("p", { class: "empty__sub" }, "It may have been removed."), h("a", { class: "btn btn--soft", href: "#/team/chat" }, "Open Team chat")));
      return;
    }
    // Redraw only when something changed, so a half-picked answer and the focus stay put. A step alone changes one line.
    const k = JSON.stringify([a.status, a.suggestions, a.sent_back, a.documents.length, a.stages.map((s) => [s.status, s.waits_for, s.checkpoint, s.waiting, s.who.guest, s.answers.length, !!s.handoff])]);
    if (k !== key) {
      const was = key;
      key = k;
      paint(a);
      if (was) said.textContent = assignmentLine(a);
    } else {
      const now = body.querySelector<HTMLElement>(".trail__now");
      const s = a.stages.find((x) => x.status === "running");
      if (now && s && now.lastChild?.textContent !== stageStep(s)) now.lastChild!.textContent = stageStep(s);
    }
    if (a.status === "running" && document.visibilityState !== "hidden") timer = window.setTimeout(() => void look().catch(() => undefined), 2500);
  }

  const off = onAssignmentsChange(() => void look().catch(() => undefined));
  const onVisible = () => document.visibilityState !== "hidden" && void look().catch(() => undefined);
  document.addEventListener("visibilitychange", onVisible);
  void look().catch(() => {
    if (!alive) return;
    body.removeAttribute("aria-busy");
    body.replaceChildren(h("div", { class: "empty" }, h("p", { class: "empty__title" }, "This assignment didn't load"), h("p", { class: "empty__sub" }, "Check you're online and try again.")));
  });

  return {
    el,
    destroy() {
      alive = false;
      window.clearTimeout(timer);
      off();
      document.removeEventListener("visibilitychange", onVisible);
    },
  };
}
