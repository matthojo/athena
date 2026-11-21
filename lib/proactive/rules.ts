/**
 * The seven proactive rules. Each is a pure function from the owner's data
 * (ProactiveInput) to zero or more nudges; gate.ts decides which go out.
 * Pushes leave the device, so a title or body never carries health figures,
 * an email's words or where the owner has been: those stay in "Why am I
 * seeing this?", which only opens in the app.
 */
import { addDays, daysBetween, zonedParts, zonedToInstant } from "../dates";
import { carNudgeEnds, carNudgeKey, carNudgeStage } from "../car";
import { shortNightUnder } from "../briefing-writer";
import { NO_DRIVE_TIME, type InputEvent, type Nudge, type NudgeAction, type ProactiveInput, type RuleId, type SentThread, type TravelMode } from "./types";
import { clip, clock, dayMonth, duration, firstNameOf, hhmm, names, numberWord, onDay, weekdayOf } from "./words";

const MIN = 60_000;
const at = (iso: string) => Date.parse(iso);
const endOf = (e: InputEvent) => (e.ends_at ? at(e.ends_at) : at(e.starts_at) + 60 * MIN);
const localMinutes = (now: Date, tz: string) => {
  const p = zonedParts(now, tz);
  return p.hour * 60 + p.minute;
};
const withPeople = (e: InputEvent) => !e.backfilled && !e.solo && e.people.length > 0;
const dateOf = (iso: string, tz: string) => zonedParts(new Date(iso), tz).date;
/** The title already names everyone ("Mentoring with Priya"): the context needn't say it again. */
const named = (title: string, people: Array<{ name: string }>) => people.every((p) => title.toLowerCase().includes(firstNameOf(p.name).toLowerCase()));

// ---------- Meeting prep: about 15 minutes before a meeting with other people ----------

export const PREP_LEAD_MINUTES = 15;

export function meetingPrep(input: ProactiveInput): Nudge[] {
  const now = input.now.getTime();
  const out: Nudge[] = [];
  for (const e of input.events) {
    const start = at(e.starts_at);
    if (!withPeople(e) || now < start - PREP_LEAD_MINUTES * MIN || now >= start) continue;
    const ids = new Set(e.people.map((p) => p.id).filter(Boolean));
    const who = names(e.people.map((p) => p.name));
    const time = clock(e.starts_at, input.tz);
    const todos = input.todos.filter((t) => !t.backfilled && t.person_id && ids.has(t.person_id));
    const owe = todos.filter((t) => t.kind === "i_owe" || t.kind === "todo");
    const waiting = todos.filter((t) => t.kind === "waiting_on");
    const last = e.people.map((p) => p.last_summary).filter((s): s is { at: string; text: string } => !!s).sort((a, b) => at(b.at) - at(a.at))[0];
    const mail = e.people.flatMap((p) => (p.recent_mail ?? []).map((m) => ({ ...m, name: p.name }))).sort((a, b) => at(b.at) - at(a.at));

    const why = [`“${e.title}” starts at ${time} with ${e.people.map((p) => p.name).join(", ")}.`];
    if (last) why.push(`Last time (${dayMonth(dateOf(last.at, input.tz))}): ${clip(last.text, 140)}`);
    for (const n of (e.last_notes ?? []).slice(0, 2)) why.push(`Your note from ${dayMonth(dateOf(n.at, input.tz))}: “${clip(n.title, 80)}”.`);
    for (const m of mail.slice(0, 2)) why.push(`${m.channel === "email" ? "Email" : "Message"} with ${firstNameOf(m.name)} ${onDay(dateOf(m.at, input.tz), input.today)}: ${clip(m.text, 100)}`);
    for (const t of owe.slice(0, 3)) why.push(`Open to-do: ${clip(t.title, 90)}.`);
    for (const t of waiting.slice(0, 2)) why.push(`Waiting on ${firstNameOf(t.person_name ?? "them")}: ${clip(t.title, 90)}.`);

    // The push names counts, never what was said.
    const bits: string[] = [];
    if (owe.length) bits.push(`${owe.length} open to-do${owe.length === 1 ? "" : "s"}`);
    if (waiting.length) bits.push(`${waiting.length} you're waiting on`);
    if (mail.length) bits.push(`${mail.length} recent email${mail.length === 1 ? "" : "s"}`);
    const body = bits.length ? `${bits.join(", ")}. Tap for the notes from last time.` : last ? "Tap for what you agreed last time." : `Starts at ${time}. Tap to get ready.`;

    out.push({
      rule: "meeting_prep",
      key: `prep:${e.id}:${e.starts_at}`,
      title: `${time} with ${who}`,
      body: body.charAt(0).toUpperCase() + body.slice(1),
      why,
      context: `${e.title}, today at ${time}${named(e.title, e.people) ? "" : `, with ${who}`}.`,
      prompt: `What should I know before my ${time} with ${who}?`,
      about: [{ kind: "event", id: e.id, label: e.title }, ...e.people.flatMap((p) => (p.id ? [{ kind: "person" as const, id: p.id, label: p.name }] : []))],
      actions: [],
      expires_at: e.starts_at,
    });
  }
  return out;
}

/** The meetings meeting prep speaks for: the 30-minute push leaves these alone (netlify/functions/reminders.ts). */
export function preppedEventIds(input: Pick<ProactiveInput, "events">): Set<string> {
  return new Set(input.events.filter((e) => withPeople(e) || (!e.backfilled && e.solo === false)).map((e) => e.id));
}

// ---------- After a meeting: "How did the call with Priya go?" ----------

const CALL = /\b(call|zoom|meet|teams|hangout|video|phone|1:1|one-to-one)\b/i;

export function afterMeeting(input: ProactiveInput): Nudge[] {
  const now = input.now.getTime();
  const out: Nudge[] = [];
  for (const e of input.events) {
    const end = endOf(e);
    if (!withPeople(e) || now < end || now >= end + 60 * MIN) continue;
    const who = names(e.people.map((p) => p.name));
    const what = CALL.test(e.title) ? `the call with ${who}` : `your meeting with ${who}`;
    out.push({
      rule: "after_meeting",
      key: `after:${e.id}:${e.starts_at}`,
      title: `How did ${what} go?`,
      body: "Tell me in a line or two. I'll turn it into to-dos, a note or a draft for you to check.",
      why: [
        `“${e.title}” with ${e.people.map((p) => p.name).join(", ")} ended at ${clock(new Date(end).toISOString(), input.tz)}.`,
        "Nothing is sent: any email or message stays a draft until you send it.",
      ],
      context: `${e.title}, today at ${clock(e.starts_at, input.tz)}${named(e.title, e.people) ? "" : `, with ${who}`}.`,
      prompt: `Notes from ${what}: `,
      about: [{ kind: "event", id: e.id, label: e.title }, ...e.people.flatMap((p) => (p.id ? [{ kind: "person" as const, id: p.id, label: p.name }] : []))],
      actions: [],
      expires_at: new Date(end + 12 * 60 * MIN).toISOString(),
    });
  }
  return out;
}

// ---------- Awaiting reply: sent mail with a question, no answer after N working days ----------

const ASKS = /\?|\b(could you|can you|would you|will you|please|let me know|any update|thoughts on|when can|are you able|do you (?:have|know|think)|happy to|is it ok|okay to)\b/i;
const CLOSING = /\b(no need to reply|no reply needed|no rush|just fyi|for your info|thanks again|all sorted|that's all|no worries)\b/i;
const AUTOMATED_ADDRESS = /^(?:no-?reply|do-?not-?reply|notifications?|alerts?|mailer-daemon|postmaster|newsletter|news|updates|info|support|billing|receipts?|orders?|hello|team)@|@(?:[\w-]+\.)*(?:mailchimp|sendgrid|mailgun|intercom|zendesk|hubspot|substack|amazonses)\./i;
const BULK_LABELS = new Set(["CATEGORY_PROMOTIONS", "CATEGORY_SOCIAL", "CATEGORY_UPDATES", "CATEGORY_FORUMS", "SPAM", "TRASH"]);

/** Newsletters, automated mail and lists: nobody is waiting to hear from these. */
export function automatedThread(t: Pick<SentThread, "to" | "labels">): boolean {
  return AUTOMATED_ADDRESS.test(t.to.email) || t.labels.some((l) => BULK_LABELS.has(l));
}

/** Working days from `from` (exclusive) to `to` (inclusive). */
export function workingDaysBetween(from: string, to: string, days: number[]): number {
  let n = 0;
  for (let d = addDays(from, 1); d <= to; d = addDays(d, 1)) if (days.includes(new Date(`${d}T12:00:00Z`).getUTCDay())) n++;
  return n;
}

export function awaitingReply(input: ProactiveInput, replyDays: number): Nudge[] {
  const out: Nudge[] = [];
  const oldest = addDays(input.today, -14);
  for (const t of input.sent) {
    const sentOn = dateOf(t.sent_at, input.tz);
    if (t.backfilled || !t.unanswered || sentOn < oldest || automatedThread(t)) continue;
    if (input.closed.has(`thread:${t.id}`) || CLOSING.test(t.snippet) || !ASKS.test(`${t.subject} ${t.snippet}`)) continue;
    const waited = workingDaysBetween(sentOn, input.today, input.working.days);
    if (waited < replyDays) continue;
    const first = firstNameOf(t.to.name);
    const when = onDay(sentOn, input.today);
    out.push({
      rule: "awaiting_reply",
      key: `reply:${t.id}:${t.sent_at}`,
      title: `No reply from ${first} yet`,
      body: `You emailed ${first} ${when} and haven't heard back. Draft a nudge?`,
      why: [
        `You sent “${clip(t.subject || "(no subject)", 80)}” to ${t.to.name} (${t.to.email}) ${when === "today" || when === "yesterday" ? when : `${when}`}.`,
        `It asks something: “${clip(t.snippet, 120)}”`,
        `Nobody has replied in ${numberWord(waited)} working day${waited === 1 ? "" : "s"}. You chose ${numberWord(replyDays)} in Settings → Notifications.`,
        "Newsletters, automated mail and threads you've closed are left out.",
      ],
      context: `Your email to ${t.to.name}, “${clip(t.subject || "(no subject)", 80)}”, sent ${when}. No reply yet.`,
      prompt: `Draft a short, friendly follow-up to ${t.to.name} about “${clip(t.subject || "my last email", 80)}”, the email I sent ${when}.`,
      about: t.to.id ? [{ kind: "person", id: t.to.id, label: t.to.name }] : [],
      actions: [],
      expires_at: new Date(input.now.getTime() + 3 * 24 * 60 * MIN).toISOString(),
    });
  }
  return out;
}

// ---------- Leave by: the next event with a place, and the travel time to it ----------

/** Minutes to spare on top of the travel estimate. */
export const LEAVE_SPARE_MINUTES = 5;
/** Extra minutes when the owner's usual TfL lines are disrupted. */
export const DISRUPTION_MINUTES = 10;
/** How far ahead of leaving time the nudge comes. */
export const LEAVE_WARNING_MINUTES = 15;

export function leaveBy(input: ProactiveInput): Nudge[] {
  const now = input.now.getTime();
  const next = input.events
    .filter((e) => !e.backfilled && e.place && input.travel[e.id] && at(e.starts_at) > now && dateOf(e.starts_at, input.tz) === input.today)
    .sort((a, b) => at(a.starts_at) - at(b.starts_at))[0];
  if (!next) return [];
  const trip = input.travel[next.id]!;
  if (trip.source === "none") return driveWithoutTime(input, next);
  // A live planner already allows for delays; the estimate leaves earlier when the owner's usual lines are disrupted.
  const live = trip.source === "tfl" || trip.source === "google";
  const extra = !live && trip.mode === "transit" && trip.disruption ? DISRUPTION_MINUTES : 0;
  const leaveAt = at(next.starts_at) - (trip.minutes + LEAVE_SPARE_MINUTES + extra) * MIN;
  const until = leaveAt - now;
  if (until > LEAVE_WARNING_MINUTES * MIN || until < -5 * MIN) return [];
  const mins = Math.max(0, Math.round(until / (5 * MIN)) * 5);
  const time = clock(next.starts_at, input.tz);
  const how = HOW[trip.mode];
  return [
    {
      rule: "leave_by",
      key: `leave:${next.id}:${next.starts_at}`,
      // A drive says where and by when, like the drive with no time; the rest keep "for the 1pm".
      title:
        trip.mode === "drive"
          ? `${mins ? `Leave in ${mins} minutes` : "Time to leave"}: drive to ${clip(next.place!.name, 40)} by ${time}`
          : mins ? `Leave in ${mins} minutes for the ${time}` : `Time to leave for the ${time}`,
      body: `${clip(next.title, 60)} at ${next.place!.name}. About ${trip.minutes} minutes ${how}${extra ? `, plus ${extra} for delays on your usual lines` : ""}.`,
      why: [
        `“${next.title}” is at ${next.place!.name} at ${time}.`,
        live
          ? `${trip.source === "tfl" ? "TfL's Journey Planner" : "Google Maps"} gives ${trip.minutes} minutes ${how}${trip.mode === "drive" ? " in the traffic now" : ""} from ${trip.from}, arriving by ${time}. Athena adds ${LEAVE_SPARE_MINUTES} minutes to spare.`
          : `From ${trip.from}, Athena guesses ${trip.minutes} minutes ${how}, plus ${LEAVE_SPARE_MINUTES} minutes to spare.`,
        ...(trip.rechecked ? ["Athena asked Google Maps again for the traffic close to when you'd leave."] : []),
        ...(extra ? [`Your usual lines aren't running normally (${trip.disruption}), so Athena allows ${extra} minutes more.`] : []),
        ...(live ? [] : ["This is an estimate: Athena worked it out from the distance between the two places, without a journey planner. Check a map if the timing is tight, or add Google Maps or TfL in Sources, under Places and travel, for real journey times."]),
      ],
      context: `${next.title} at ${next.place!.name}, today at ${time}.`,
      prompt: `How do I get to ${next.place!.name} for ${time}?`,
      about: [{ kind: "event", id: next.id, label: next.title }],
      actions: [],
      expires_at: next.starts_at,
    },
  ];
}

const HOW: Record<TravelMode, string> = { transit: "by public transport", walk: "on foot", cycle: "by bike", drive: "by car" };
/** A drive with no drive time: said this long before the start. */
export const NO_TIME_LEAD_MINUTES = 60;

/** A drive Athena can't time (no Google Maps key): a heads-up an hour before, saying how to get real drive times. Never a public transport time instead. */
function driveWithoutTime(input: ProactiveInput, next: InputEvent): Nudge[] {
  const until = at(next.starts_at) - input.now.getTime();
  if (until > NO_TIME_LEAD_MINUTES * MIN || until < LEAVE_WARNING_MINUTES * MIN) return [];
  const time = clock(next.starts_at, input.tz);
  return [
    {
      rule: "leave_by",
      key: `leave:${next.id}:${next.starts_at}`,
      title: `Drive to ${clip(next.place!.name, 40)} by ${time}`,
      body: `${clip(next.title, 60)}. Athena can't time a drive without Google Maps, so allow for traffic.`,
      why: [
        `“${next.title}” is at ${next.place!.name} at ${time}, and you're going by car.`,
        `${NO_DRIVE_TIME} Athena only times a drive with Google Maps, which reads the traffic. Add a Google Maps key in Sources, under Places and travel.`,
      ],
      context: `${next.title} at ${next.place!.name}, today at ${time}, by car.`,
      prompt: `How long will it take to drive to ${next.place!.name} for ${time}?`,
      about: [{ kind: "event", id: next.id, label: next.title }],
      actions: [],
      expires_at: next.starts_at,
    },
  ];
}

// ---------- Day plan by energy: after a poor night, heavy work later and a quiet block kept ----------

/** From the briefing's time until late morning. */
const PLAN_FROM = 7 * 60 + 30;
const PLAN_UNTIL = 11 * 60;
const HEAVY_MINUTES = 45;

/** Last night was well below the owner's usual: sleep under their own short-night line, or recovery 15+ points under their median. */
export function poorNight(sleep: ProactiveInput["sleep"]): { why: string } | null {
  if (!sleep) return null;
  const under = shortNightUnder(sleep.nights);
  if (sleep.last_minutes && sleep.last_minutes > 0 && sleep.last_minutes < under) {
    return { why: `You slept ${duration(sleep.last_minutes)} last night. For you, a night under ${duration(under)} is a short one.` };
  }
  const rs = [...sleep.recoveries].filter((r) => r > 0).sort((a, b) => a - b);
  if (sleep.last_recovery != null && rs.length >= 7) {
    const median = rs[Math.floor(rs.length / 2)];
    if (sleep.last_recovery <= median - 15) return { why: `Your recovery is ${sleep.last_recovery} this morning. It's usually around ${median}.` };
  }
  return null;
}

/** The first free stretch of `mins` from 13:00 to the end of the working day, clear of every other event. */
function laterSlot(input: ProactiveInput, mins: number, skip: string): { start: string; end: string } | null {
  const dayEnd = zonedToInstant(input.today, input.working.end, input.tz).getTime();
  let t = Math.max(zonedToInstant(input.today, "13:00", input.tz).getTime(), zonedToInstant(input.today, input.working.start, input.tz).getTime());
  const busy = input.events.filter((e) => e.id !== skip && dateOf(e.starts_at, input.tz) === input.today).map((e) => [at(e.starts_at), endOf(e)] as const);
  while (t + mins * MIN <= dayEnd) {
    const clash = busy.find(([s, e]) => s < t + mins * MIN && e > t);
    if (!clash) return { start: new Date(t).toISOString(), end: new Date(t + mins * MIN).toISOString() };
    t = Math.ceil(clash[1] / (15 * MIN)) * 15 * MIN;
  }
  return null;
}

export function dayPlan(input: ProactiveInput): Nudge[] {
  const m = localMinutes(input.now, input.tz);
  if (m < PLAN_FROM || m >= PLAN_UNTIL) return [];
  const poor = poorNight(input.sleep);
  if (!poor) return [];
  const noon = zonedToInstant(input.today, "12:00", input.tz).getTime();
  const heavy = input.events.filter(
    (e) => !e.backfilled && e.solo && dateOf(e.starts_at, input.tz) === input.today && at(e.starts_at) > input.now.getTime() && at(e.starts_at) < noon && endOf(e) - at(e.starts_at) >= HEAVY_MINUTES * MIN,
  );
  const actions: Array<Extract<NudgeAction, { kind: "move" }>> = [];
  for (const e of heavy.slice(0, 2)) {
    const slot = laterSlot(input, Math.round((endOf(e) - at(e.starts_at)) / MIN), e.id);
    if (slot) actions.push({ kind: "move", label: `Move to ${hhmm(slot.start, input.tz)}`, event_id: e.id, title: e.title, from: e.starts_at, start: slot.start, end: slot.end });
  }
  const first = actions[0];
  const body = first ? `Your ${hhmm(first.from, input.tz)} “${clip(first.title, 40)}” could move to ${hhmm(first.start, input.tz)}. Tap to see the plan.` : "A lighter plan for today: keep the morning quiet and do the hard thinking later.";
  return [
    {
      rule: "day_plan",
      key: `dayplan:${input.today}`,
      title: "An easier start today?",
      body,
      why: [
        poor.why,
        heavy.length ? `This morning has ${numberWord(heavy.length)} long block${heavy.length === 1 ? "" : "s"} of your own work before noon.` : "Nothing heavy is on this morning, so there's nothing to move.",
        ...(first ? [`${hhmm(first.start, input.tz)} onwards is free, so the work can go there.`] : []),
        "Moves use your calendar, and each one has Undo.",
      ],
      context: "Last night was short for you, so this is a lighter plan for today.",
      prompt: "Help me plan a lighter day: heavy work after lunch, and keep an hour this morning quiet.",
      about: heavy.map((e) => ({ kind: "event" as const, id: e.id, label: e.title })),
      actions,
      expires_at: new Date(noon).toISOString(),
    },
  ];
}

// ---------- Weekly plan, Sunday evening ----------

export function weeklyPlan(input: ProactiveInput): Nudge[] {
  const dow = new Date(`${input.today}T12:00:00Z`).getUTCDay();
  const m = localMinutes(input.now, input.tz);
  if (dow !== 0 || m < 18 * 60 || m >= 22 * 60) return [];
  const monday = addDays(input.today, 1);
  const days = [0, 1, 2, 3, 4, 5, 6].map((i) => addDays(monday, i)).filter((d) => input.working.days.includes(new Date(`${d}T12:00:00Z`).getUTCDay()));
  if (!days.length) return [];
  // Meeting minutes per day, then each to-do goes to the day with the most room.
  const load = new Map(days.map((d) => [d, 0]));
  for (const e of input.events) {
    const d = dateOf(e.starts_at, input.tz);
    if (load.has(d) && !e.solo) load.set(d, load.get(d)! + Math.round((endOf(e) - at(e.starts_at)) / MIN));
  }
  const meetings = new Map(load);
  const last = days[days.length - 1];
  const open = input.todos.filter((t) => !t.backfilled && t.kind !== "waiting_on" && (!t.due_on || (t.due_on >= monday && t.due_on <= last))).slice(0, 6);
  if (!open.length) return [];
  const actions: NudgeAction[] = [];
  for (const t of open) {
    const day = t.due_on ?? [...load].sort((a, b) => a[1] - b[1] || a[0].localeCompare(b[0]))[0][0];
    load.set(day, (load.get(day) ?? 0) + 60);
    if (day !== t.due_on) actions.push({ kind: "plan_todo", label: weekdayOf(day), commitment_id: t.id, title: t.title, due_on: day, was: t.due_on });
  }
  if (!actions.length) return [];
  const lightest = [...meetings].sort((a, b) => a[1] - b[1]).slice(0, 2);
  const goals = input.goals.filter((g) => g.progress < 50).slice(0, 2);
  return [
    {
      rule: "weekly_plan",
      key: `weekplan:${monday}`,
      title: "A plan for next week",
      body: `${actions.length} to-do${actions.length === 1 ? "" : "s"} placed on your lighter days. Apply the ones you want.`,
      why: [
        `${lightest.map(([d, mins]) => `${weekdayOf(d)} has ${mins ? duration(mins) : "no time"} in meetings`).join(", ")}.`,
        `${numberWord(open.length).replace(/^./, (c) => c.toUpperCase())} open to-do${open.length === 1 ? "" : "s"} have no day yet or are due next week.`,
        ...goals.map((g) => `Your goal “${clip(g.title, 60)}” is at ${g.progress}%.`),
        "Nothing changes until you tap Apply, and each one can be put back.",
      ],
      context: `A proposed week from ${dayMonth(monday)}: your calendar, goals and to-dos.`,
      prompt: `Plan my week from ${dayMonth(monday)} around my meetings, to-dos${goals.length ? " and goals" : ""}.`,
      about: actions.map((a) => ({ kind: "commitment" as const, id: (a as { commitment_id: string }).commitment_id })),
      actions,
      expires_at: zonedToInstant(monday, "12:00", input.tz).toISOString(),
    },
  ];
}

// ---------- Drift: a habit missed on the same weekday three or more times running ----------

export const DRIFT_RUN = 3;
const PLACE_HABIT = /^(gym|pool|park|office|library|class|choir|club)$/i;

const EXERCISE = /\b(gym|run|running|swim|swimming|yoga|pilates|workout|exercise|cycle|cycling|bike|climb|climbing|row|rowing|spin|strength|weights|crossfit|hiit|walk)\b/i;

export function drift(input: ProactiveInput): Nudge[] {
  const out: Nudge[] = [];
  for (const h of input.habits) {
    // Health data: a workout logged on a day an exercise habit wasn't ticked means it wasn't skipped.
    const moved = EXERCISE.test(h.name);
    const marks = h.marks.map((m) => (!m.done && moved && (input.past?.[m.date]?.workouts.length ?? 0) > 0 ? { ...m, done: true } : m));
    if (!marks.some((m) => m.done)) continue; // never kept: not a habit that drifted
    const byDay = new Map<number, Array<{ date: string; done: boolean }>>();
    for (const m of marks) {
      if (m.date >= input.today) continue;
      const d = new Date(`${m.date}T12:00:00Z`).getUTCDay();
      byDay.set(d, [...(byDay.get(d) ?? []), m]);
    }
    for (const [, dayMarks] of byDay) {
      const sorted = [...dayMarks].sort((a, b) => b.date.localeCompare(a.date));
      let run = 0;
      while (run < sorted.length && !sorted[run].done) run++;
      // Only a run that's every week: no gaps between the missed days.
      const spaced = sorted.slice(0, run).every((m, i, xs) => i === 0 || addDays(m.date, 7) === xs[i - 1].date);
      if (run < DRIFT_RUN || !spaced) continue;
      const missed = sorted.slice(0, run).reverse();
      const day = weekdayOf(sorted[0].date);
      const name = h.name.trim();
      const said = PLACE_HABIT.test(name) ? `the ${name.toLowerCase()}` : name.charAt(0).toLowerCase() + name.slice(1);
      // Calendar: the same event on every missed day (or all but one) is the likely clash.
      const counts = new Map<string, { title: string; time: string; n: number }>();
      for (const m of missed) for (const e of new Set((input.past?.[m.date]?.events ?? []).map((x) => JSON.stringify(x)))) {
        const ev = JSON.parse(e) as { title: string; time: string };
        const c = counts.get(ev.title.toLowerCase()) ?? { ...ev, n: 0 };
        c.n++;
        counts.set(ev.title.toLowerCase(), c);
      }
      const clash = [...counts.values()].filter((c) => c.n >= Math.max(2, missed.length - 1)).sort((a, b) => b.n - a.n)[0];
      out.push({
        rule: "drift",
        key: `drift:${h.id}:${sorted[0].date}`,
        title: `${name} on ${day}s`,
        body: `You've skipped ${said} ${numberWord(run)} ${day}s running. Want to find it a better day?`,
        why: [
          `${name} was due on ${missed.map((m) => dayMonth(m.date)).join(", ")} and wasn't ticked${moved && input.past ? ", and no workout was logged" : ""}.`,
          ...(clash ? [`Your calendar had “${clash.title}” at ${clash.time} on ${clash.n === missed.length ? `each of those ${day}s` : `${numberWord(clash.n)} of them`}.`] : []),
          `Overall, it was ticked ${marks.filter((m) => m.done).length} of the ${marks.length} times it was due.`,
          ...(h.pattern ? [`From Patterns: ${h.pattern.replace(/\.?$/, ".")}`] : []),
          `Athena only mentions a pattern that has held at least ${numberWord(DRIFT_RUN)} times.`,
        ],
        context: `${name}: missed ${numberWord(run)} ${day}s in a row${clash ? `, each time with “${clash.title}” on` : ""}.`,
        prompt: clash
          ? `I keep missing ${said} on ${day}s, when “${clash.title}” is on. Which day would suit it better?`
          : `I keep missing ${said} on ${day}s. What else is on my ${day}s, and which day would suit it better?`,
        about: [{ kind: "habit", id: h.id }],
        actions: [],
        expires_at: new Date(input.now.getTime() + 2 * 24 * 60 * MIN).toISOString(),
      });
    }
  }
  return out;
}

/** Every rule's nudges (only live rules', when `live` is given), in the order the gate checks them (time-critical first). */
// ---------- Something to watch tonight (off by default) ----------

/** From 17:00 to 20:00 on an evening the calendar leaves clear after 19:00: one to three picks from the owner's own list. */
export function watchTonight(input: ProactiveInput): Nudge[] {
  const t = input.tonight;
  if (!t?.free || !t.picks.length) return [];
  const m = localMinutes(input.now, input.tz);
  if (m < 17 * 60 || m >= 20 * 60) return [];
  const titles = t.picks.map((p) => p.title);
  const list = titles.length === 1 ? titles[0] : `${titles.slice(0, -1).join(", ")} and ${titles[titles.length - 1]}`;
  return [
    {
      rule: "watch_tonight",
      key: `tonight:${input.today}`,
      title: "Something to watch tonight",
      body: `Your evening's clear. From your list: ${list}.`,
      why: ["Nothing is on your calendar after 19:00.", ...t.picks.map((p) => `${p.title}: ${p.why}`), "Every pick is one you added to your own list."],
      context: `Tonight's picks from your list: ${list}.`,
      prompt: "Which of these should I watch tonight?",
      about: [],
      actions: [],
      expires_at: zonedToInstant(input.today, "23:00", input.tz).toISOString(),
    },
  ];
}

// ---------- The car: MOT and tax, about 30 days and 7 days before (lib/car.ts) ----------

/** One nudge per date and stage. A renewed date is a new key, and the sync closes the old card (lib/car-sync.ts). */
export function carDue(input: ProactiveInput): Nudge[] {
  return (input.cars ?? []).flatMap((d) => {
    const stage = carNudgeStage(input.today, d.due);
    if (!stage) return [];
    const n = daysBetween(input.today, d.due);
    const when = n === 0 ? "today" : n === 1 ? "tomorrow" : `in ${n} days`;
    const on = n === 0 ? "today" : n === 1 ? "tomorrow" : `on ${dayMonth(d.due)}`;
    const mot = d.what === "mot";
    return [
      {
        rule: "car" as const,
        key: carNudgeKey(d, stage),
        title: mot ? `MOT runs out ${when}` : `Car tax due ${when}`,
        body: mot ? `${d.label}: the MOT ends ${on}. Book a test before then.` : `${d.label}: the tax is due ${on}. Renew it online before then.`,
        why: [
          `The government record for the ${d.label} says the ${mot ? "MOT ends" : "tax is due"} on ${dayMonth(d.due)}.`,
          "Athena checks it once a day. When it's renewed, the new date shows up and this goes quiet.",
          "You hear about it roughly 30 days before, and again in the last week.",
        ],
        context: `${d.label}: ${mot ? "MOT ends" : "tax due"} ${dayMonth(d.due)}.`,
        prompt: mot ? `Help me book an MOT for the ${d.label}` : `What do I need to renew the tax on the ${d.label}?`,
        about: [],
        actions: [],
        expires_at: zonedToInstant(carNudgeEnds(d.due, stage), "00:00", input.tz).toISOString(),
      },
    ];
  });
}

export function allNudges(input: ProactiveInput, opts: { replyDays: number; live?: (rule: RuleId) => boolean }): Nudge[] {
  const byRule: Record<RuleId, () => Nudge[]> = {
    leave_by: () => leaveBy(input),
    meeting_prep: () => meetingPrep(input),
    after_meeting: () => afterMeeting(input),
    day_plan: () => dayPlan(input),
    awaiting_reply: () => awaitingReply(input, opts.replyDays),
    weekly_plan: () => weeklyPlan(input),
    drift: () => drift(input),
    watch_tonight: () => watchTonight(input),
    car: () => carDue(input),
    // Routines come from their own runs (lib/routine-run.ts), through the same gate.
    routine: () => [],
    // Team assistants' runs come from lib/team-run.ts, through the same gate.
    team: () => [],
    // Plain flows' cards come from their runs (lib/flow-effects.ts), through the same gate.
    flow: () => [],
  };
  return (Object.entries(byRule) as Array<[RuleId, () => Nudge[]]>).flatMap(([rule, f]) => (opts.live && !opts.live(rule) ? [] : f()));
}
