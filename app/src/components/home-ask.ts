/**
 * Home's Ask box: "Ask Athena…" with a row
 * of avatar chips under it, Athena's orb first, then each assistant. Picking
 * a chip is choosing a colleague: the box takes their face, asks "Ask Moss,
 * or give her a job…", and a line under the chips says what they do, or
 * what they're doing right now ("Moss is checking prices"). A chip whose
 * assistant is on a job carries a small breathing dot. With no team yet, the
 * row is one quiet "Add an assistant".
 *
 * Sending is handing it over: their face travels from the box to Ask's head
 * (a shared view transition) and Ask opens with that conversation already
 * running (openAsk). Offline it goes the same way: Ask answers from what's
 * on the device, as it does when asked there.
 *
 * Above the box on a phone, a small Team button: the team's place now the
 * dock doesn't carry it. It carries the team's pulse, as the sidebar does
 * (team/page-pulse.ts): a soft dot while an assistant works and the count of
 * what waits for you. A wide screen has it in the sidebar, so the button is
 * hidden there (styles/home-ask.css) and doesn't watch.
 */
import "../styles/home-ask.css";
import { h } from "../lib/dom";
import { icons } from "./icons";
import { openAsk } from "../lib/open-ask";
import { onTeamChange, type TeamRun } from "../db/team";
import { onTeamActivity } from "../lib/team-live";
import { liveRuns, workingWords } from "../lib/team-report";
import type { TeamPulse } from "../team/page-pulse";
import { watchWaiting as watchTeamPulse } from "../team/waiting";
import { paintWho } from "../team/dot-colour";
import { ATHENA, loadTeam, objectOf, teamLoaded, whoMark, whoOf, type Who } from "./ask-who";

/** Who the box asks, for this visit: the last chip picked. */
let picked: string | null = null;

/** The Team button, aloud: "Team. Moss is working. 1 thing waits for you." */
export function teamLabel(p: TeamPulse): string {
  const n = p.working.length;
  const names = n > 1 ? `${p.working.slice(0, -1).join(", ")} and ${p.working[n - 1]}` : (p.working[0] ?? "");
  const working = n ? ` ${names} ${n === 1 ? "is" : "are"} working.` : "";
  const waiting = p.waiting ? ` ${p.waiting} ${p.waiting === 1 ? "thing waits" : "things wait"} for you.` : "";
  return `Team.${working}${waiting}`.replace(/^Team\.$/, "Team");
}

/** The box's words for who it asks. */
export const askPlaceholder = (who: Pick<Who, "id" | "name" | "pronoun">): string => (who.id ? `Ask ${who.name}, or give ${objectOf(who)} a job…` : `Ask ${who.name}…`);

export function homeAsk(): { el: HTMLElement; destroy: () => void } {
  let people: Who[] = [ATHENA];
  let who: Who = ATHENA;
  /** Each assistant's newest run still going, by id. */
  let busy = new Map<string, TeamRun>();

  const markSlot = h("span", { class: "home-ask__mark" }, whoMark(ATHENA, 28));
  const field = h("input", {
    class: "home-ask__field",
    type: "text",
    name: "ask",
    autocomplete: "off",
    enterkeyhint: "send",
    placeholder: "Ask Athena…",
    "aria-label": "Ask Athena",
  }) as HTMLInputElement;
  const send = h("button", { class: "send-btn home-ask__send", type: "submit", "aria-label": "Ask", disabled: true }, icons.arrowUp()) as HTMLButtonElement;
  const chips = h("div", { class: "home-ask__who", role: "radiogroup", "aria-label": "Who to ask", hidden: true });
  // No team yet: one quiet way to start one, where the chips would be.
  const hire = h("a", { class: "home-ask__chip home-ask__hire", href: "#/team/new", hidden: true }, h("span", { class: "home-ask__hire-mark", "aria-hidden": "true" }, icons.plus()), h("span", {}, "Add an assistant"));
  const chipsWrap = h("div", { class: "home-ask__who-wrap" }, chips, hire);
  const about = h("p", { class: "home-ask__about", hidden: true, "aria-live": "polite" });
  // The Team button keeps the sidebar's pulse (team/page-pulse.ts): a soft dot while someone works, and the count of what waits for you.
  // The whole team's, so it stays the accent; an assistant's own dot takes its colour.
  const teamDot = h("span", { class: "team-dot home-ask__team-dot", "aria-hidden": "true", hidden: true });
  // What waits is said once, in "Waiting for you" below (components/home-waiting.ts): this pill keeps only the working dot.
  const team = h("a", { class: "home-ask__team", href: "#/team", "aria-label": "Team" }, icons.team(), h("span", {}, "Team"), teamDot, icons.chevronRight());
  const paintPulse = (p: TeamPulse) => {
    const n = p.working.length;
    teamDot.hidden = !n;
    team.classList.toggle("is-working", !!n);
    // The sidebar's words, for a long press and for screen readers.
    team.title = n ? `${p.working.join(", ")} ${n === 1 ? "is" : "are"} working` : "";
    team.setAttribute("aria-label", teamLabel(p));
  };
  // Only where the button shows: a wide screen has the sidebar's own.
  const phone = window.matchMedia("(max-width: 1023px)");
  let stopPulse: (() => void) | null = null;
  const watchPulse = () => {
    if (phone.matches && !stopPulse) stopPulse = watchTeamPulse(paintPulse);
    else if (!phone.matches && stopPulse) {
      stopPulse();
      stopPulse = null;
    }
  };
  phone.addEventListener("change", watchPulse);
  watchPulse();
  const box = h("div", { class: "home-ask__box" }, markSlot, field, send);
  // Flows, beside Team: a pill of the same make.
  const flows = h("a", { class: "home-ask__team home-ask__flows", href: "#/flows", "aria-label": "Flows" }, icons.flow(), h("span", {}, "Flows"), icons.chevronRight());
  const el = h("form", { class: "home-ask", role: "search", "aria-label": "Ask" }, h("div", { class: "home-ask__head" }, flows, team), box, chipsWrap, about);

  /** The line under the chips: what the chosen one is doing, else what they're for. Athena's says nothing; the box does. */
  const paintAbout = () => {
    const run = who.id ? busy.get(who.id) : undefined;
    const line = !who.id ? "" : run ? workingWords(who.name, run) : (who.job ?? "");
    about.hidden = !line;
    about.classList.toggle("is-working", !!run);
    paintWho(about, run ? who.avatar : null);
    if (about.textContent !== line || !!run !== !!about.querySelector(".team-dot")) {
      if (run) about.replaceChildren(h("span", { class: "team-dot home-ask__about-dot", "aria-hidden": "true" }), line);
      else about.textContent = line;
    }
  };

  /** Whether the chips run past the edge, each way: the edge fades there. */
  const paintEdges = () => {
    const more = chips.scrollWidth - chips.clientWidth > 2;
    chipsWrap.classList.toggle("has-more-end", more && chips.scrollLeft + chips.clientWidth < chips.scrollWidth - 2);
    chipsWrap.classList.toggle("has-more-start", more && chips.scrollLeft > 2);
  };
  chips.addEventListener("scroll", paintEdges, { passive: true });

  const paint = () => {
    markSlot.replaceChildren(whoMark(who, 28));
    const ph = askPlaceholder(who);
    field.placeholder = ph;
    field.setAttribute("aria-label", ph.replace("…", ""));
    chips.hidden = people.length < 2;
    hire.hidden = people.length > 1 || !teamLoaded();
    chips.replaceChildren(
      ...people.map((p) => {
        const on = p.id === who.id;
        const working = !!p.id && busy.has(p.id);
        const chip = h(
          "button",
          { class: "home-ask__chip", type: "button", role: "radio", "aria-checked": String(on), tabindex: on ? "0" : "-1", "aria-label": working ? `${p.name}, working` : p.name },
          paintWho(h("span", { class: "home-ask__chip-mark" }, whoMark(p, 24), working ? h("span", { class: "team-dot home-ask__busy", "aria-hidden": "true" }) : null), working ? p.avatar : null),
          h("span", {}, p.name)
        );
        chip.addEventListener("click", () => choose(p, true));
        return chip;
      })
    );
    paintAbout();
    requestAnimationFrame(paintEdges);
  };

  const choose = (p: Who, focusField = false) => {
    who = p;
    picked = p.id;
    paint();
    // The chosen chip comes fully into view when the row scrolls.
    chips.querySelector<HTMLElement>('[aria-checked="true"]')?.scrollIntoView({ block: "nearest", inline: "nearest", behavior: "smooth" });
    if (focusField) field.focus({ preventScroll: true });
  };

  // Arrow keys move along the chips, as a radio group does.
  chips.addEventListener("keydown", (e) => {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(e.key)) return;
    e.preventDefault();
    const i = people.findIndex((p) => p.id === who.id);
    const n = people.length;
    const next = e.key === "Home" ? 0 : e.key === "End" ? n - 1 : (i + (e.key === "ArrowRight" ? 1 : n - 1)) % n;
    choose(people[next]);
    chips.querySelector<HTMLElement>('[aria-checked="true"]')?.focus();
  });

  field.addEventListener("input", () => (send.disabled = !field.value.trim()));
  el.addEventListener("submit", (e) => {
    e.preventDefault();
    const prompt = field.value.trim();
    if (!prompt) return;
    field.value = "";
    send.disabled = true;
    field.blur();
    // Their face is the one that greets you in Ask: it carries across (styles/home-ask.css, ask-team.css).
    if (who.id) {
      markSlot.classList.add("is-handing");
      // Only for this one change of page: two faces with the same name would stop the next transition.
      setTimeout(() => markSlot.classList.remove("is-handing"), 1000);
    }
    openAsk({ prompt, send: true, assistantId: who.id });
  });

  const load = () =>
    void loadTeam().then((list) => {
      people = [ATHENA, ...list.filter((a) => !a.paused).map(whoOf)];
      who = people.find((p) => p.id === picked) ?? ATHENA;
      paint();
    });
  load();
  const off = onTeamChange(load);
  const offRuns = onTeamActivity((runs) => {
    const next = new Map(liveRuns(runs).map((r) => [r.assistant_id, r]));
    const same = next.size === busy.size && [...next].every(([id, r]) => busy.get(id)?.status === r.status && busy.get(id)?.step === r.step);
    busy = next;
    if (!same) paint();
  });
  paint();

  return {
    el,
    destroy: () => {
      off();
      offRuns();
      phone.removeEventListener("change", watchPulse);
      stopPulse?.();
    },
  };
}
