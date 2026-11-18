/**
 * Team setup's last scene: the first day. The new assistant is on the team
 * and says so in its own words. A short list shows what it's doing now, and
 * each line is real: its skill being written (polled until it lands), when it
 * starts, and, if you ask, a first run you can watch. A scheduled assistant
 * offers "Run it now"; one that waits for something to arrive offers "Check
 * now", which looks over what's already there. Both are a run.
 *
 * Nothing here holds the assistant up: close the sheet at any time and the
 * work carries on (the server writes the skill after the add, and a run is a
 * run whether you watch it or not).
 */
import "../styles/team-pulse.css";
import { h } from "../lib/dom";
import { icons } from "../components/icons";
import { getAssistantSkill, listRuns, runNow, type TeamAssistant, type TeamRun } from "../db/team";
import { answersFor } from "./setup-questions";
import type { SetupDraft } from "./setup-draft";
import { alreadyThere, firstGo, startsLine, voice } from "./setup-voice";
import { paintWho } from "./dot-colour";

const SKILL_POLL_MS = 2000;
/** The server writes the skill in the background; past this, the list stops waiting and says where it'll be. */
const SKILL_GIVE_UP_MS = 45_000;
const RUN_POLL_MS = 1500;
const RUN_GIVE_UP_MS = 4 * 60_000;

export interface FirstDayHandlers {
  /** The character's mood follows the work. */
  mood: (m: "idle" | "happy" | "working") => void;
  /** It says something (a chat bubble under it). */
  say: (text: string) => void;
  /** "Say hello": open a chat with it. */
  hello: () => void;
}

const lcFirst = (t: string) => t.charAt(0).toLowerCase() + t.slice(1);

/** "working": a run going, with the team's working dot (styles/team-pulse.css), as on the Team page and the assistant's page. */
type ItemState = "done" | "doing" | "working" | "live" | "failed";

export function firstDay(made: TeamAssistant, d: SetupDraft, on: FirstDayHandlers): { el: HTMLElement; stop: () => void } {
  let alive = true;
  const timers: number[] = [];
  const later = (fn: () => void, ms: number) => timers.push(window.setTimeout(() => alive && fn(), ms));

  function item(text: string, state: ItemState) {
    const mark = h("span", { class: "ts-day__mark", "aria-hidden": "true" });
    const label = h("span", { class: "ts-day__text" }, text);
    // A run going: the breathing dot in the new assistant's own colour.
    const row = paintWho(h("li", { class: "ts-day__item" }, mark, label), made.avatar);
    const set = (next: string, s: ItemState) => {
      label.textContent = next;
      row.dataset.state = s;
      mark.replaceChildren(s === "done" ? icons.check() : s === "failed" ? icons.close() : s === "working" ? h("span", { class: "team-dot" }) : "");
    };
    set(text, state);
    return { row, set };
  }

  const answered = answersFor(d.questions, d.answers).length > 0;
  const job = item("Read the job", "done");
  const notes = answered ? item("Noted your answers", "done") : null;
  const skill = item("Writing down how I work", "doing");
  const starts = item(startsLine(made.triggers), "live");
  const run = item("", "doing");
  run.row.hidden = true;
  const list = h("ol", { class: "ts-day__list", "aria-label": `${made.name}'s first day` }, job.row, ...(notes ? [notes.row] : []), skill.row, run.row, starts.row);

  const check = firstGo(made.triggers) === "check";
  const there = alreadyThere(made.triggers);
  const words = check
    ? { btn: "Check now", again: "Check again", say: "Let me see what's already there.", start: `Looking over ${there}`, working: `Looking over ${there}`, done: "Checked what's there", failed: "The check didn't finish", unstarted: "That check didn't start. Try again from its page.", nothing: `Nothing to do yet. I'll start ${lcFirst(startsLine(made.triggers).replace(/^Starts /, ""))}.` }
    : { btn: "Run it now", again: "Run again", say: "Starting now.", start: "Starting a first run", working: "Getting it done", done: "Finished a first run", failed: "The first run didn't finish", unstarted: "That run didn't start. Try again from its page.", nothing: "Done. Nothing needed doing this time." };
  const hintId = `ts-day-hint-${made.id}`;
  const runBtn = h(
    "button",
    { class: "btn btn--soft ts-day__btn", type: "button", ...(check ? { "aria-describedby": hintId } : {}) },
    check ? icons.search() : icons.play(),
    h("span", {}, words.btn)
  );
  const runLabel = runBtn.lastElementChild as HTMLElement;
  const helloBtn = h("button", { class: "btn btn--soft ts-day__btn", type: "button" }, icons.chat(), `Say hello`);
  helloBtn.addEventListener("click", on.hello);
  runBtn.addEventListener("click", () => void firstRun());

  const el = h(
    "section",
    { class: "ts-day" },
    h("p", { class: "ts-label ts-day__label" }, "First day"),
    list,
    h("div", { class: "ts-day__actions" }, runBtn, helloBtn),
    h("p", { class: "ts-fine ts-day__fine" }, ...(check ? [h("span", { id: hintId, class: "ts-day__hint" }, `Check now looks over ${there}.`), " "] : []), `All of this is on ${made.name}'s page.`)
  );

  // The skill: written by the server after the add. Tick it off when it's there.
  const skillStart = Date.now();
  const pollSkill = async () => {
    if (!alive) return;
    try {
      const info = await getAssistantSkill(made.id);
      if (!alive) return;
      if (info.skill) return skill.set("Wrote down how I work", "done");
    } catch {
      /* offline for a moment: try again */
    }
    if (Date.now() - skillStart > SKILL_GIVE_UP_MS) return skill.set("Still writing down how I work", "doing");
    later(() => void pollSkill(), SKILL_POLL_MS);
  };
  later(() => void pollSkill(), 900);

  const again = () => {
    runLabel.textContent = words.again;
    runBtn.disabled = false;
  };

  let goes = 0;
  async function firstRun() {
    if (goes++ === 1 && !check) Object.assign(words, { start: "Starting another run", done: "Finished another run", failed: "That run didn't finish" });
    runBtn.disabled = true;
    // Said once: after the first go, the hint has done its job.
    el.querySelector(".ts-day__hint")?.nextSibling?.remove();
    el.querySelector(".ts-day__hint")?.remove();
    runBtn.removeAttribute("aria-describedby");
    on.say(words.say);
    run.row.hidden = false;
    run.set(words.start, "working");
    on.mood("working");
    let r: TeamRun;
    try {
      r = await runNow(made.id);
    } catch {
      run.set(words.unstarted, "failed");
      on.mood("idle");
      again();
      return;
    }
    const started = Date.now();
    const poll = async () => {
      if (!alive) return;
      try {
        const now = (await listRuns(made.id)).find((x) => x.id === r.id);
        if (!alive) return;
        if (now?.status === "done") {
          run.set(words.done, "done");
          // It has run now: the schedule's next go isn't its first any more.
          starts.set(startsLine(made.triggers).replace(/^First run /, "Next run "), "live");
          on.mood("happy");
          on.say(now.summary?.trim() || words.nothing);
          later(() => on.mood("idle"), 1600);
          again();
          return;
        }
        if (now?.status === "failed") {
          run.set(words.failed, "failed");
          on.mood("idle");
          on.say("That didn't work. The details are on my page.");
          again();
          return;
        }
        run.set(now?.step?.trim() || (now?.status === "running" ? words.working : "About to start"), "working");
      } catch {
        /* keep watching */
      }
      if (Date.now() - started > RUN_GIVE_UP_MS) return run.set("Still working. It'll be on my page.", "doing");
      later(() => void poll(), RUN_POLL_MS);
    };
    later(() => void poll(), RUN_POLL_MS);
  }

  on.say(voice.firstDay(made.personality));
  return {
    el,
    stop: () => {
      alive = false;
      timers.forEach((t) => clearTimeout(t));
    },
  };
}
