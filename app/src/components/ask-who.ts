/**
 * Who you're talking to, wherever Ask can be reached (docs/team.md,
 * Experience → Home, Ask): Athena's orb or an assistant's character, the
 * picker that switches between them (a sheet on a phone, a popover on a
 * wide screen), the lead an assistant's replies carry with its status pill,
 * and the "Checked with <Name>" chip on a reply that asked a teammate.
 *
 * Characters come from team/avatar.ts only; the team from db/team.ts.
 */
import "../styles/ask-team.css";
import { h } from "../lib/dom";
import { icons } from "./icons";
import { openSheet, type SheetHandle } from "./sheet";
import { renderAvatarTile } from "../team/avatar";
import { paintWho } from "../team/dot-colour";
import { listTeam, onTeamChange, type TeamAssistant, type TeamRun } from "../db/team";
import { ATHENA_STATUS, stepLine } from "../lib/who-status";
import { onTeamActivity, teamActivityNow } from "../lib/team-live";
import { liveRuns, workingWords } from "../lib/team-report";
// The Team page's status line, so a card, the picker and Ask's head say the same thing.
import { statusLine } from "../team/trigger-editor-words";
import type { AvatarSpec } from "../../../lib/team-types";

export interface Who {
  /** The assistant's id; null for Athena. */
  id: string | null;
  name: string;
  avatar: AvatarSpec | null;
  status: string;
  /** An assistant's job, in one sentence. */
  job?: string;
  /** From its personality: how Home's box says "give her a job". */
  pronoun?: "she" | "he" | "they";
  /** No longer on the team: kept by name and face from when it was (rememberWho). */
  gone?: boolean;
}

export const ATHENA: Who = { id: null, name: "Athena", avatar: null, status: ATHENA_STATUS };

export const whoOf = (a: TeamAssistant): Who => ({ id: a.id, name: a.name, avatar: a.avatar, status: statusLine(a), job: a.job, pronoun: a.personality?.pronoun });

/** "her", "him", "them": for "give her a job". */
export const objectOf = (who: Pick<Who, "pronoun">): string => (who.pronoun === "she" ? "her" : who.pronoun === "he" ? "him" : "them");

// ---------- the team, kept for this page ----------

let team: TeamAssistant[] | null = null;
let loading: Promise<TeamAssistant[]> | null = null;
onTeamChange(() => {
  team = null;
  loading = null;
});

/** The team as last loaded; offline or not yet set up, nobody (Athena is always there). */
export function loadTeam(): Promise<TeamAssistant[]> {
  if (team) return Promise.resolve(team);
  loading ??= listTeam().then(
    (list) => (rememberWho(list), (team = list)),
    () => {
      loading = null;
      return [];
    }
  );
  return loading;
}

/** Whether the team has loaded (an empty team counts); false offline or before the first load. */
export const teamLoaded = (): boolean => team !== null;

// ---------- who they were ----------

/** Name and face of each assistant this device has seen, so a conversation with one who has left still says who it was. */
const KNOWN = "athena.team.known";
type Known = Record<string, { name: string; avatar: AvatarSpec | null }>;
const readKnown = (): Known => {
  try {
    return JSON.parse(localStorage.getItem(KNOWN) ?? "{}") as Known;
  } catch {
    return {};
  }
};
/** Keep each assistant's name and face on this device (a few hundred bytes for a team of 12). */
function rememberWho(list: TeamAssistant[]): void {
  try {
    const known = readKnown();
    let changed = false;
    for (const a of list) {
      const was = known[a.id];
      if (was?.name === a.name && JSON.stringify(was.avatar) === JSON.stringify(a.avatar)) continue;
      known[a.id] = { name: a.name, avatar: a.avatar };
      changed = true;
    }
    if (changed) localStorage.setItem(KNOWN, JSON.stringify(known));
  } catch {
    /* Private mode: a gone assistant reads "An assistant". */
  }
}

/** The one with this id, if they're still on the team. Offline, the team didn't load: that says nothing about whether they're on it. */
export async function findWho(id: string | null | undefined): Promise<Who> {
  if (!id) return ATHENA;
  const list = await loadTeam();
  const a = list.find((x) => x.id === id);
  if (a) return whoOf(a);
  const was = readKnown()[id];
  if (!team) return { id, name: was?.name ?? "Assistant", avatar: was?.avatar ?? null, status: "Your team didn't load" };
  return { id, name: was?.name ?? "An assistant", avatar: was?.avatar ?? null, status: "No longer on your team", gone: true };
}

// ---------- marks ----------

/**
 * Athena's orb on a circle, or the assistant in its tile (the kit's frame), at this size. Decorative: the name is always beside it.
 * `thinking`: head tilted, eyes up, while it works. One who has left the team is drawn faded; one with no face kept, as a plain tile.
 */
export function whoMark(who: Pick<Who, "avatar" | "name"> & { id?: string | null; gone?: boolean }, size: number, opts: { thinking?: boolean } = {}): HTMLElement {
  let mark: HTMLElement;
  if (who.avatar) {
    mark = renderAvatarTile(who.avatar, { size, mood: opts.thinking ? "thinking" : "idle", animate: size >= 64 && !opts.thinking });
    mark.classList.add("who-mark", "who-mark--avatar");
  } else if (who.id) {
    // An assistant whose face isn't known here: never Athena's orb, which would say it's her.
    mark = h("span", { class: "kit-tile who-mark who-mark--blank", style: `--kit-px:${size}px;--kit-tint:var(--sunken)`, "aria-hidden": "true" }, icons.team());
  } else mark = h("span", { class: "who-mark", style: `--who-size:${size}px`, "aria-hidden": "true" }, h("span", { class: "orb", style: `--size:${size}px` }));
  if (who.gone) mark.classList.add("who-mark--gone");
  mark.classList.toggle("is-working", !!opts.thinking);
  // Its ring while it works, in the character's own colour.
  if (opts.thinking) paintWho(mark, who.avatar);
  return mark;
}

// ---------- the picker ----------

const wide = () => window.matchMedia("(min-width: 1024px)").matches;
let openPicker: { close: () => void } | null = null;

/**
 * Pick who to talk to. A sheet on a phone, a popover under `anchor` on a
 * wide screen. Picking the one already chosen just closes it.
 */
export function pickWho(opts: { anchor: HTMLElement; current: string | null; onPick: (who: Who) => void }): void {
  openPicker?.close();
  void Promise.all([loadTeam(), new Promise<TeamRun[]>((done) => {
    // What they're doing now, from the team's runs as last seen (lib/team-live.ts); the picker doesn't wait for a fresh look.
    const off = onTeamActivity((runs) => (done(runs), queueMicrotask(() => off())));
    setTimeout(() => done(teamActivityNow()), 400);
  })]).then(([list, runs]) => {
    const busy = new Map(liveRuns(runs).map((r) => [r.assistant_id, r]));
    const everyone = [ATHENA, ...list.map((a) => {
      const w = whoOf(a);
      const run = busy.get(a.id);
      return run ? { ...w, status: workingWords(a.name, run), working: true } : w;
    })];
    let close = () => {};
    const rows = everyone.map((who) => {
      const on = who.id === opts.current;
      const row = h(
        "button",
        { class: "who-row", type: "button", role: "menuitemradio", "aria-checked": String(on) },
        whoMark(who, 36, { thinking: "working" in who }),
        h("span", { class: "who-row__text" }, h("span", { class: "who-row__name" }, who.name), h("span", { class: "who-row__status", "data-working": "working" in who ? "" : undefined }, who.status)),
        on ? h("span", { class: "who-row__check" }, icons.check()) : null
      );
      row.addEventListener("click", () => {
        close();
        if (!on) opts.onPick(who);
      });
      return row;
    });
    const team = h("a", { class: "who-picker__team", href: "#/team" }, list.length ? "Your team" : "Add an assistant", icons.chevronRight());
    team.addEventListener("click", () => close());
    const body = h("div", { class: "who-picker", role: "menu", "aria-label": "Talk to" }, ...rows, team);

    if (!wide()) {
      let sheet: SheetHandle | null = openSheet({ label: "Talk to", title: "Talk to", body, onClose: () => ((sheet = null), (openPicker = null)) });
      close = () => sheet?.close();
      openPicker = { close };
      return;
    }
    const pop = h("div", { class: "menu who-pop", popover: "auto" }, body) as HTMLElement & { showPopover?: () => void; hidePopover?: () => void };
    document.body.append(pop);
    const r = opts.anchor.getBoundingClientRect();
    pop.style.top = `${Math.round(r.bottom + 6)}px`;
    pop.style.left = `${Math.round(Math.max(12, Math.min(r.left, window.innerWidth - 332)))}px`;
    pop.addEventListener("toggle", (e) => {
      if ((e as ToggleEvent).newState === "closed") {
        pop.remove();
        if (openPicker?.close === close) openPicker = null;
        opts.anchor.focus({ preventScroll: true });
      }
    });
    close = () => pop.hidePopover?.();
    openPicker = { close };
    pop.showPopover?.();
    (rows.find((r) => r.getAttribute("aria-checked") === "true") ?? rows[0])?.focus();
    // Arrow keys move between the rows.
    pop.addEventListener("keydown", (e) => {
      if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
      e.preventDefault();
      const i = rows.indexOf(document.activeElement as HTMLButtonElement);
      rows[(i + (e.key === "ArrowDown" ? 1 : rows.length - 1)) % rows.length]?.focus();
    });
  });
}

// ---------- an assistant's replies ----------

/**
 * The lead above an assistant's reply: its small avatar and, beside it, a
 * pill with its name. While it works the pill also shows the current step
 * ("Creating shopping list"), Muse-style.
 */
export function whoLead(who: Who): { el: HTMLElement; step: (text: string | null) => void } {
  const stepEl = h("span", { class: "who-pill__step", hidden: true });
  // The step card is hidden in an assistant's conversation (ask-team.css), so the pill says each step aloud.
  const pill = h("span", { class: "who-pill", role: "status", "aria-live": "polite" }, h("span", { class: "who-pill__name" }, who.name || "An assistant"), stepEl);
  let mark = whoMark(who, 28);
  const el = h("div", { class: "who-lead" }, mark, pill);
  let working = false;
  const step = (text: string | null) => {
    // Before its first step, a colleague says they've got it, rather than "Thinking".
    const line = stepLine(text === "Thinking" ? "On it" : text);
    stepEl.hidden = !line;
    pill.classList.toggle("is-working", !!line);
    if (working !== !!line) {
      working = !!line;
      const next = whoMark(who, 28, { thinking: working });
      mark.replaceWith(next);
      mark = next;
    }
    if (line && stepEl.textContent !== line) {
      stepEl.textContent = line;
      stepEl.classList.remove("is-new");
      void stepEl.offsetWidth;
      stepEl.classList.add("is-new");
    }
  };
  return { el, step };
}

/** A source Ask got by checking with a teammate (the check_with_assistant tool): kind "assistant". */
export interface TeammateSource {
  kind: string;
  /** The assistant's id. */
  id: string | null;
  /** Its name. */
  title: string;
  /** What it said. */
  detail?: string;
}

/**
 * The teammates a reply checked with: its sources of kind "assistant", each
 * given what that teammate said from the reply's `checked` list. The answer is
 * copied onto the source's `detail`, so a reopened conversation (which keeps
 * sources, not `checked`) still opens it. A `checked` entry with no source of
 * its own still gets a chip.
 */
export function teammateSources(
  sources: readonly { kind: string }[] | undefined,
  checked?: readonly { assistant_id: string; name: string; answer: string }[]
): TeammateSource[] {
  const out = (sources ?? []).filter((s) => s.kind === "assistant") as TeammateSource[];
  for (const c of checked ?? []) {
    const src = out.find((s) => s.id === c.assistant_id);
    if (src) {
      if (!src.detail?.trim() && c.answer) src.detail = c.answer;
    } else out.push({ kind: "assistant", id: c.assistant_id, title: c.name, detail: c.answer });
  }
  return out;
}

/** "Checked with Muse", with her mini avatar; tapping it opens what she said. */
export function checkedWith(src: TeammateSource): HTMLElement {
  const said = src.detail?.trim() || "";
  const label = h("span", { class: "checked-with__label" }, `Checked with ${src.title || "an assistant"}`);
  const mark = h("span", { class: "checked-with__mark" });
  const btn = h("button", { class: "checked-with__btn", type: "button", "aria-expanded": "false", disabled: !said }, mark, label, said ? icons.chevronDown() : null) as HTMLButtonElement;
  const words = h("p", { class: "checked-with__words" }, said);
  const panel = h("div", { class: "checked-with__said", hidden: true }, words);
  const el = h("div", { class: "checked-with", "data-id": src.id ?? "" }, btn, panel);
  void findWho(src.id).then((who) => {
    mark.replaceWith(whoMark({ ...who, name: src.title || who.name }, 18));
    // Still on the team: carry on with them directly, as you'd go and find a colleague Athena mentioned.
    if (!who.id || who.gone || !teamLoaded()) return;
    const talk = h("button", { class: "link-btn checked-with__talk", type: "button" }, `Talk to ${who.name}`, icons.arrowRight());
    talk.addEventListener("click", () => void import("../lib/open-ask").then(({ openAsk }) => openAsk({ assistantId: who.id })));
    panel.append(talk);
  });
  btn.addEventListener("click", () => {
    const open = btn.getAttribute("aria-expanded") !== "true";
    btn.setAttribute("aria-expanded", String(open));
    panel.hidden = !open;
  });
  return el;
}
