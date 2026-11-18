/**
 * Nudges Athena starts, as cards (lib/proactive/): a line on what it noticed,
 * one tap into Ask with it ready to talk about, "Why am I seeing this?" with
 * the plain evidence, and "Fewer like this" to mute the rule for 30 days.
 * A day plan's moves and a week plan's parts apply right from the card,
 * each with Undo. Nothing here sends anything to anyone.
 */
import "../styles/proactive.css";
import { h } from "../lib/dom";
import { icons } from "./icons";
import { openSheet } from "./sheet";
import { showToast } from "./toast";
import { openAskOnNudge } from "../lib/ask-nudge";
import { dismissNudge, fetchNudges, markNudgeApplied, muteRule, unmuteRule, type AppNudge, type NudgeAction } from "../db/nudges";
import { RULES } from "../lib/nudge-rules";
import { NO_DRIVE_TIME } from "../../../lib/proactive/types";
import { teamNudgeFrom, teamNudgeName } from "../lib/team-nudge";
import { renderAvatarTile } from "../team/avatar";
import { isSampleMode } from "../db/api";
import { sampleTeam } from "../db/sample-team";
import { listActivity, listTeam, onTeamChange } from "../db/team";
import { sampleTeamReports } from "../db/sample-team-reports";
import { teamReport } from "./team-report";
import type { IconName } from "./icons";

export { RULES };

/** A nudge's kind: its rule, or for a Team assistant's (rule 'team', which the rules list doesn't have) "From <Name>". */
function ruleOf(n: AppNudge): { name: string; icon: IconName } {
  // A teammate's card always says who it's from, whether or not the rules list has "team" yet.
  const name = teamNudgeName(n as unknown as { rule: string } & Record<string, unknown>);
  if (name) return { name: `From ${name}`, icon: "team" };
  const rule = RULES[n.rule] as { name: string; icon: IconName } | undefined;
  return rule ?? { name: "From your team", icon: "team" };
}

/** The tile leading a card: the assistant's avatar on a team nudge with one, else the rule's icon. */
function leadTile(n: AppNudge): HTMLElement {
  const from = teamNudgeFrom(n as unknown as { rule: string } & Record<string, unknown>);
  if (!from) return h("span", { class: "tile tile--sm", "aria-hidden": "true" }, icons[ruleOf(n).icon]());
  const t = renderAvatarTile(from.avatar, { size: 34 });
  t.classList.add("nudge-card__avatar");
  return t;
}

const tz = () => Intl.DateTimeFormat().resolvedOptions().timeZone;
const timeOf = (iso: string) => new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date(iso));

/** Ask, opened on this nudge: its context above a new conversation, its first reply ready in the box. */
export function askAbout(n: AppNudge): void {
  openAskOnNudge(n);
}

/** "Why am I seeing this?": the evidence, then the way to see fewer. */
export function openWhy(n: AppNudge, opts: { onMuted?: () => void } = {}): void {
  const rule = ruleOf(n);
  const fewer = h("button", { class: "btn btn--soft", type: "button" }, "Fewer like this") as HTMLButtonElement;
  const ask = h("button", { class: "btn btn--primary", type: "button" }, n.thread_id ? "Open it" : "Ask about it");
  // Leave by on an estimate: the way to real journey times (Sources → Places and travel).
  const planner =
    n.rule === "leave_by" && n.why.some((l) => l.startsWith("This is an estimate")) ? h("a", { class: "acct-link", href: "#/settings/sources?add=travel" }, "Add a journey planner")
    : n.rule === "leave_by" && n.why.some((l) => l.startsWith(NO_DRIVE_TIME)) ? h("a", { class: "acct-link", href: "#/settings/sources?add=travel" }, "Add Google Maps")
    : null;
  const body = h(
    "div",
    { class: "why" },
    h("p", { class: "why__lede" }, n.rule === "routine" ? `${rule.name}. You asked for this on a schedule.` : n.rule === "team" ? `${rule.name}. You set up when it runs.` : n.rule === "watch_tonight" ? `${rule.name}. From your own watchlist, ranked against what you rate highly.` : n.rule === "car" ? `${rule.name}. From your car's government record, checked once a day.` : `${rule.name}. Athena noticed this in your own calendar, mail, to-dos, habits and health.`),
    h("ul", { class: "why__list" }, ...n.why.map((line) => h("li", {}, line))),
    h("p", { class: "why__note" }, "Only you see this. The notification on your lock screen leaves out what people wrote and anything about your health."),
    planner ? h("p", { class: "why__note" }, planner) : null,
    // Your own routine: paused or changed where it was set up, not muted from here.
    n.rule === "routine" || n.rule === "team" ? h("div", { class: "why__actions" }, ask) : h("div", { class: "why__actions" }, ask, fewer),
    h("p", { class: "form__hint" }, n.rule === "routine" || n.rule === "team" ? "Pause, change or remove it on the Team page." : "“Fewer like this” pauses these for 30 days. Settings → Notifications has a switch for each kind.")
  );
  const sheet = openSheet({ title: "Why am I seeing this?", label: "Why am I seeing this?", body });
  ask.addEventListener("click", () => {
    sheet.close();
    askAbout(n);
  });
  planner?.addEventListener("click", () => sheet.close());
  fewer.addEventListener("click", async () => {
    fewer.disabled = true;
    try {
      await muteRule(n.rule);
      sheet.close();
      opts.onMuted?.();
      showToast(`No ${rule.name.toLowerCase()} nudges for 30 days`, {
        icon: "bell",
        action: { label: "Undo", run: () => void unmuteRule(n.rule).then(() => opts.onMuted?.()) },
      });
    } catch {
      fewer.disabled = false;
      showToast("That didn't save. Check you're online.", { icon: "wifiOff" });
    }
  });
}

function actionEl(n: AppNudge, a: NudgeAction, i: number): HTMLElement {
  const slot = h("div", { class: "nudge-card__action" });
  const done = n.applied.includes(i);
  if (a.kind === "move") {
    const btn = h("button", { class: "btn btn--soft btn--sm", type: "button", "aria-label": `${a.label}: ${a.title}` }, icons.clock(), `${a.title}: ${a.label.toLowerCase()}`) as HTMLButtonElement;
    if (done) btn.replaceChildren(icons.check(), `${a.title} moved`), (btn.disabled = true);
    btn.addEventListener("click", async () => {
      btn.disabled = true;
      try {
        const [{ moveEvent }, { moveReceipt }] = await Promise.all([import("../db/scheduling"), import("./slot-card")]);
        const r = await moveEvent(a.event_id, a.start, a.end);
        // What Ask did keeps the move, with the move's own Undo.
        void markNudgeApplied(n.id, i, true, r.undo).catch(() => undefined);
        slot.replaceChildren(moveReceipt(r, tz()));
      } catch (e) {
        btn.disabled = false;
        showToast(e instanceof Error && e.message ? e.message : "Couldn't move it. Try again in a moment.", { icon: "calendar" });
      }
    });
    slot.append(btn);
    return slot;
  }
  // A week plan's part: give the to-do its day, with Undo putting the old one back.
  const label = h("span", { class: "nudge-card__part" }, h("span", { class: "nudge-card__part-day" }, a.label), h("span", { class: "nudge-card__part-title" }, a.title));
  const btn = h("button", { class: "btn btn--soft btn--sm", type: "button", "aria-label": `Apply: ${a.title} on ${a.label}` }, done ? "Undo" : "Apply") as HTMLButtonElement;
  let on = done;
  btn.addEventListener("click", async () => {
    btn.disabled = true;
    try {
      const { saveCommitment } = await import("../db/memory");
      await saveCommitment({ due_on: on ? a.was : a.due_on }, a.commitment_id);
      on = !on;
      await markNudgeApplied(n.id, i, on).catch(() => undefined);
      btn.textContent = on ? "Undo" : "Apply";
      slot.classList.toggle("is-applied", on);
    } catch {
      showToast("That didn't save. Check you're online.", { icon: "wifiOff" });
    }
    btn.disabled = false;
  });
  slot.classList.toggle("is-applied", done);
  slot.append(label, btn);
  return slot;
}

/** A team run's title is "From <Name>", which the eyebrow already says: then its summary is the headline. */
const headline = (n: AppNudge, rule: { name: string }): string => (n.title === rule.name && n.body ? n.body : n.title);

/** One nudge as a card. Tapping it opens Ask on it. */
export function nudgeCard(n: AppNudge, opts: { onGone: () => void }): HTMLElement {
  const rule = ruleOf(n);
  const repeats = headline(n, rule) !== n.title;
  const open = h(
    "button",
    { class: "nudge-card__open", type: "button", "aria-label": `${repeats ? `${rule.name}: ${n.body}` : n.title}. ${n.thread_id ? "Open it" : "Ask about it"}` },
    leadTile(n),
    h(
      "span",
      { class: "nudge-card__text" },
      h("span", { class: "nudge-card__eyebrow" }, `${rule.name} · ${timeOf(n.created_at)}`),
      repeats ? null : h("span", { class: "nudge-card__title" }, n.title),
      h("span", { class: "nudge-card__body" }, n.body)
    )
  );
  open.addEventListener("click", () => askAbout(n));
  const why = h("button", { class: "btn btn--ghost btn--sm nudge-card__why", type: "button" }, "Why am I seeing this?");
  why.addEventListener("click", () => openWhy(n, { onMuted: opts.onGone }));
  const ask = h("button", { class: "btn btn--soft btn--sm", type: "button" }, n.thread_id ? "Open it" : "Ask about it", icons.arrowRight());
  ask.addEventListener("click", () => askAbout(n));
  const close = h("button", { class: "icon-btn icon-btn--sm icon-btn--ghost nudge-card__close", type: "button", "aria-label": `Dismiss: ${n.title}` }, icons.close());
  const card = h("article", { class: "card nudge-card", "data-rule": n.rule, "data-id": n.id }, open, close);
  close.addEventListener("click", () => {
    card.classList.add("is-leaving");
    void dismissNudge(n.id).catch(() => undefined);
    setTimeout(opts.onGone, window.matchMedia("(prefers-reduced-motion: reduce)").matches ? 0 : 180);
  });
  if (n.actions.length) card.append(h("div", { class: "nudge-card__actions" }, ...n.actions.map((a, i) => actionEl(n, a, i))));
  card.append(h("div", { class: "nudge-card__foot" }, ask, why));
  return card;
}

/**
 * A nudge as one short row (its tile, when and what, and dismiss), for the
 * ones after the first on Home. Tapping it opens the full card in its place,
 * with the rest of the story and anything it can do.
 */
function nudgeRow(n: AppNudge, opts: { onGone: () => void; onOpen: () => void }): HTMLElement {
  const rule = ruleOf(n);
  const open = h(
    "button",
    { class: "nudge-row__open", type: "button", "aria-expanded": "false", "aria-label": `${headline(n, rule)}. Show more` },
    leadTile(n),
    h(
      "span",
      { class: "nudge-card__text" },
      h("span", { class: "nudge-card__eyebrow" }, `${rule.name} · ${timeOf(n.created_at)}`),
      h("span", { class: "nudge-row__title" }, headline(n, rule))
    ),
    h("span", { class: "row__chevron", "aria-hidden": "true" }, icons.chevronDown())
  );
  open.addEventListener("click", opts.onOpen);
  const close = h("button", { class: "icon-btn icon-btn--sm icon-btn--ghost", type: "button", "aria-label": `Dismiss: ${n.title}` }, icons.close());
  const row = h("div", { class: "nudge-row", "data-rule": n.rule }, open, close);
  close.addEventListener("click", () => {
    row.classList.add("is-leaving");
    void dismissNudge(n.id).catch(() => undefined);
    setTimeout(opts.onGone, window.matchMedia("(prefers-reduced-motion: reduce)").matches ? 0 : 180);
  });
  return row;
}

/**
 * Home's "For you": the team's word first (components/team-report.ts: who's
 * on a job, and each assistant's latest report, one row each), then today's
 * live nudges from Athena, newest first. The newest of those is a full card;
 * the rest are short rows in one card beneath it, so on a phone the day
 * itself still starts on the first screen. Hidden when there's nothing.
 */
export function nudgeCards(): { el: HTMLElement; refresh: () => Promise<void>; destroy: () => void } {
  const list = h("div", { class: "nudge-cards__list" });
  /** Rows opened into full cards; they stay open until Home is next drawn. */
  const opened = new Set<string>();
  let athena: AppNudge[] = [];
  let teamShown = false;
  const show = () => (el.hidden = !teamShown && !athena.length);
  const team = teamReport({ onShown: (on) => ((teamShown = on), show()), onGone: () => void refresh() });
  const el = h("section", { class: "nudge-cards", "aria-labelledby": "home-nudges", hidden: true }, h("div", { class: "section-head" }, h("h2", { id: "home-nudges" }, "For you")), team.el, list);
  async function refresh() {
    let nudges: AppNudge[];
    try {
      nudges = await fetchNudges();
    } catch {
      return;
    }
    const isTeam = (n: AppNudge) => n.rule === ("team" as AppNudge["rule"]);
    const reports = isSampleMode() ? await sampleTeamReports(await listTeam().catch(() => sampleTeam()), await listActivity(50).catch(() => [])) : nudges.filter(isTeam);
    athena = nudges.filter((n) => !isTeam(n)).slice(0, 3);
    teamShown = await team.set(reports);
    show();
    paint(athena);
  }
  function paint(shown: AppNudge[]) {
    const onGone = () => void refresh();
    const full = shown.filter((n, i) => i === 0 || opened.has(n.id));
    const rows = shown.filter((n, i) => i > 0 && !opened.has(n.id));
    const open = (n: AppNudge) => () => {
      opened.add(n.id);
      paint(shown);
      list.querySelector<HTMLElement>(`.nudge-card[data-id="${CSS.escape(n.id)}"] .nudge-card__open`)?.focus();
    };
    list.hidden = !shown.length;
    list.replaceChildren(
      ...full.map((n) => nudgeCard(n, { onGone })),
      ...(rows.length ? [h("div", { class: "card card--flush nudge-rows" }, ...rows.map((n) => nudgeRow(n, { onGone, onOpen: open(n) })))] : [])
    );
  }
  void refresh();
  // An assistant added, paused or removed: its report comes or goes.
  const offTeam = onTeamChange(() => void refresh());
  return { el, refresh, destroy: () => (team.destroy(), offTeam()) };
}

/** The seed card's mark: the assistant in its tile on a team nudge, else Athena's orb. */
function seedMark(n: AppNudge | undefined): HTMLElement {
  const from = n ? teamNudgeFrom(n as unknown as { rule: string } & Record<string, unknown>) : null;
  if (!from) return h("span", { class: "orb", "aria-hidden": "true" });
  const t = renderAvatarTile(from.avatar, { size: 20 });
  t.classList.add("ask-nudge__who");
  return t;
}

/**
 * What Ask shows above a conversation opened on a nudge: what it's about,
 * and "Why am I seeing this?". The first reply waits in the box.
 */
export function askSeedCard(seed: { context: string; nudge?: AppNudge }): HTMLElement {
  const n = seed.nudge;
  const card = h(
    "aside",
    { class: "ask-nudge", "aria-label": "What this is about" },
    h("p", { class: "ask-nudge__head" }, seedMark(n), n ? (n.rule === ("team" as AppNudge["rule"]) ? ruleOf(n).name : `${ruleOf(n).name}, from Athena`) : "From Athena"),
    ...(n ? [h("p", { class: "ask-nudge__title" }, n.title)] : []),
    h("p", { class: "ask-nudge__context" }, seed.context)
  );
  if (n) {
    const why = h("button", { class: "btn btn--ghost btn--sm ask-nudge__why", type: "button" }, "Why am I seeing this?");
    why.addEventListener("click", () => openWhy(n));
    card.append(why);
  }
  return card;
}
