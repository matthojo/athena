/**
 * Reminders + the morning briefing: a Netlify Scheduled Function that runs
 * every 5 minutes (cron is UTC; "07:30" and "today" are in the owner's time
 * zone — the one their device last reported, settings.timezone — so the
 * briefing follows them when they travel and clock changes need no edits).
 *
 * Each run:
 *  1. From 07:30 local, once per day: writes the "Today, …" briefing note
 *     (type 'daily', source 'briefing') and pushes a digest linking to it.
 *     With AI configured the model writes it, in a background function
 *     (lib/briefing-run.ts); otherwise, or if that fails, the data briefing.
 *     Birthdays and all-day events appear in that digest on each of their
 *     remind_days_before days; so do to-dos due, life-admin renewals (on
 *     their remind days), quiet waiting-ons and the review inbox count.
 *  2. Timed events: one push 30 minutes before they start — with who it's
 *     with, when you last spoke and what's open between you. Bookings from
 *     trips get a push too, in the place's own time, with the seat and
 *     reference: a flight 3 hours before (time to leave for the airport), a
 *     train, a car pick-up or a show 30 minutes before. A train's push leads
 *     with its live status when National Rail has it ("07:10 to Bristol
 *     Temple Meads: 12 min late, platform 4", netlify/lib/live-travel.ts).
 *     The briefing lists this week's travel and today's deliveries (lib/trips.ts).
 *  3. Custom reminders ("remind me to …"): a push when each is due, then a
 *     one-off is marked done and a repeating one moves to its next time (same
 *     time of day in the owner's zone). Today's are also listed in the briefing.
 *  4. From the owner's evening time (21:00 unless they pick another), once a
 *     day: "How was today?" when today has no mood, line or journal yet, led
 *     by the day's best thing ("Saw Priya at Dishoom. How was it?"). It
 *     opens today with the mood picker ready. On unless the owner turns it off.
 *     With the evening check-in on (lib/checkin-push.ts) it's the reflection
 *     instead: it opens the evening check-in, and is skipped once that's done.
 *  4a. From the owner's morning time (07:00 unless they pick another), once a
 *     day, only with the morning check-in on: a push that opens it, unless
 *     it's done already.
 *  4b. Sunday from 18:00: one push for the weekly review. Its words are the
 *     Week in review's own headline (lib/week-push.ts), opening that page.
 *  4c. Regular payments (lib/recurring.ts): a push when one costs more than
 *     last time, or an expected one didn't come. Names only; under Reminders.
 *  5. Purchases delivered (or returned, refunded, cancelled) 30 days ago are
 *     archived, never deleted.
 *
 *  0b. Ask's routines (lib/routines.ts): each due slot is claimed once and run in
 *     netlify/functions/routine-run.ts; its nudge waits for quiet hours to end.
 *     First each routine becomes a Team assistant (lib/team-migrate.ts); once
 *     all have, routines stop running.
 *  0c. Team assistants: due schedule slots and new events become runs, each
 *     run in netlify/functions/team-run.ts (lib/team-triggers.ts, team-run.ts).
 *  0d. Flows: due schedule slots, "before an event" and "before a date"
 *     times and new events start runs (lib/flow-triggers.ts).
 *
 *  0. Athena speaks first (lib/proactive/), before the briefing: meeting prep 15 minutes before a
 *     meeting with people (in place of its 30-minute push), "how did it go?"
 *     after one, emails with no reply, leave by, a lighter day after a short
 *     night (carried in the morning briefing), a Sunday plan and drift. Each opens Ask on the nudge, has its own
 *     switch, a daily cap, working-hours quiet and "Fewer like this".
 *
 * Settings → Notifications switches each kind on or off and sets quiet hours
 * (lib/nudges.ts). In quiet hours nothing is sent: reminders wait and arrive
 * when they end, the morning briefing is written then, and an event's
 * 30-minute push is skipped.
 *
 * Idempotent: every send is guarded by a reminder_log key claimed first, so
 * overlapping or retried runs never notify twice. Without VAPID keys (the
 * environment's, or Athena's own, lib/push.ts) the briefing is still written
 * and pushes are skipped with a log line.
 *
 * Note: Netlify runs scheduled functions on published (production) deploys
 * only, not deploy previews.
 */
import type { Config } from "@netlify/functions";
import { aiConfigured } from "../../lib/ai";
import { briefingState, claimKey, dbDeliverDeps, deliverBriefing, handOff, loadBriefingInput, meetingPeople, watchdogDue } from "../../lib/briefing-run";
import {
  advanceReminder,
  claimIndexedReminder,
  claimReminder,
  listEvents,
  notDeclined,
  listDueReminders,
  rekeyReminder,
  releaseReminder,
  reminderKeysWithPrefix,
  reminderTimeZone,
  type Reminder,
} from "../../lib/db";
import { listInteractions } from "../../lib/memory";
import { addDays, zonedParts, zonedToInstant, zonedToday } from "../../lib/dates";
import { runProactive } from "../../lib/proactive/run";
import { runCarSync } from "../lib/car-routes";
import { claimDueRoutines, deliverRoutines, handOffRoutine } from "../../lib/routine-run";
import { migrateRoutines } from "../../lib/team-migrate";
import { queueTeamRuns } from "../../lib/team-triggers";
import { runFlowTriggers } from "../../lib/flow-triggers-db";
import { deliverTeamNudges, failStaleRuns, handOffQueuedRuns, handOffTeamRun } from "../../lib/team-run";
import { pruneTeamEvents } from "../../lib/team-events";
import { sweepAssignments } from "../../lib/assignment-run";
import { deliverStopPushes } from "../../lib/assignment-push";
import "../lib/assignment-wiring";
import { sweepPosts } from "../../lib/team-posts";
import { loadSentMail } from "../lib/proactive/mail";
import { liveRoute } from "../lib/proactive/directions";
import {
  buildBriefing,
  dueTimedReminders,
  isBriefingTime,
  isWeeklyReviewTime,
  meetingContext,
} from "../../lib/briefing";
import { weekPushHeadline } from "../../lib/week-push";
import { loadNotificationPrefs, pushConfigured, sendToAll } from "../../lib/push";
import { LEGACY_PAYMENT_PREFIXES, dayKept, eveningPrompt, inQuietHours, isEveningTime, paymentNudges, rekeyLegacyPayment, type SeenToday } from "../../lib/nudges";
import { blindIndexes, currentKeyId } from "../../lib/data-box";
import { seenEvents } from "../../lib/week-review";
import { regularPayments } from "../../lib/money";
import { getDay } from "../../lib/days";
import { REPEAT_LABELS, describeWhen } from "../../lib/reminders";
import { archiveSettledPurchases, listBookingsStarting } from "../../lib/trips";
import { BOOKING_PUSH_LEAD_MINUTES, bookingPush } from "../../lib/trip-text";
import { trainPush } from "../../lib/live-travel-text";
import { trainStatus } from "../lib/live-travel";
import { flightStatus } from "../lib/live-flights";
import { flightPush } from "../../lib/flight-text";
import { eveningPlan, loadCheckinSettings, morningKey, morningPush, morningPushDue, reflectionPrompt, type LoadCheckin } from "../../lib/checkin-push";

import { loadCheckin } from "../../lib/checkins";
import { withSpendScope } from "../../lib/spend";

/** In-app route per kind (mirrors app/src/main.ts); projects have no page, so they open Reminders. */
const ROUTE: Record<string, string> = {
  note: "notes",
  person: "people",
  place: "places",
  organisation: "organisations",
  event: "events",
};

function reminderUrl(r: Reminder): string {
  const route = r.about_type ? ROUTE[r.about_type] : undefined;
  return route && r.about_id && r.about_title ? `/#/${route}/${r.about_id}` : "/#/reminders";
}

function reminderBody(r: Reminder, now: Date, tz: string): string {
  const late = now.getTime() - Date.parse(String(r.remind_at)) > 60 * 60_000;
  const parts = [r.about_title ?? "", r.repeat !== "none" ? REPEAT_LABELS[r.repeat] : "", late ? `Was due ${describeWhen(new Date(r.remind_at), now, tz)}` : ""];
  return parts.filter(Boolean).join(" · ") || "Reminder";
}

export async function runReminders(now: Date = new Date(), origin: string | undefined = siteUrl(), checkins: LoadCheckin = loadCheckin): Promise<Record<string, unknown>> {
  // Read once per run. Lines repeating reminders up with it if it changed.
  const tz = await reminderTimeZone();
  const today = zonedToday(now, tz);
  const [canPush, prefs] = await Promise.all([pushConfigured(), loadNotificationPrefs()]);
  const quiet = inQuietHours(now, tz, prefs.quiet);
  const report: Record<string, unknown> = { today, tz, push: canPush, ...(quiet ? { quiet } : {}) };
  // Invites you declined get no briefing line and no push.
  const events = (await listEvents()).filter(notDeclined);

  // ---------- 0a. The car (lib/car-sync.ts): each vehicle read once a day, its Life admin renewals kept in step ----------
  // Before the nudges, so a renewed MOT is quiet in this same run.
  const cars = await runCarSync(today);
  if (cars) report.cars = cars;

  // ---------- 0. Athena speaks first (lib/proactive/): nudges that open Ask ----------
  // First, so a day plan made at the briefing's time is in that briefing (lib/proactive/briefing.ts).
  // Each rule has its own switch in Settings → Notifications; meeting prep speaks for
  // meetings with people, so their bare 30-minute push below is left out.
  let prepped = new Set<string>();
  try {
    const p = await runProactive(now, tz, { canPush, send: (m) => sendToAll(m), quiet: prefs.quiet, events, sent: () => sentMailHourly(now, tz), route: (from, to, at, key, mode) => liveRoute(from, to, at, key, { now }, mode) });
    prepped = new Set(p.prepped);
    if (p.made.length || Object.keys(p.held).length) report.proactive = { made: p.made, held: p.held };
  } catch (error) {
    console.error("Athena reminders: proactive nudges failed", error);
  }

  // ---------- 0b. Ask's routines (lib/routines.ts): each slot claimed once, run in a background function ----------
  // A run is kept as an Ask conversation; its nudge goes through the same gate (cap, quiet hours) and
  // waits in `pending` while it's quiet. Without AI there's nothing to answer with, so nothing is claimed.
  // Routines become Team assistants (0c): first each routine gets its assistant, then routines stop running.
  let routinesMoved = false;
  try {
    const moved = await migrateRoutines(now);
    routinesMoved = moved.done;
    if (moved.made || moved.failed) report.team_migration = moved;
  } catch (error) {
    console.error("Athena reminders: moving routines to Team failed", error);
  }
  try {
    const started: string[] = [];
    if (aiConfigured() && origin && !routinesMoved) {
      for (const { routine, slot } of await claimDueRoutines(now, tz)) {
        try {
          await handOffRoutine(origin, routine.id, slot);
          started.push(routine.id);
        } catch (error) {
          console.error("Athena reminders: couldn't start a routine", (error as Error).message?.slice(0, 120));
        }
      }
    }
    const delivered = await deliverRoutines(now, tz, { canPush, send: (m) => sendToAll(m), quiet: prefs.quiet });
    if (started.length || delivered.sent || delivered.held) report.routines = { started: started.length, ...delivered };
  } catch (error) {
    console.error("Athena reminders: routines failed", error);
  }

  // ---------- 0c. Team assistants (lib/team-triggers.ts, lib/team-run.ts) ----------
  // Due schedule slots and new events (each claimed once) become queued runs, each handed to the
  // team-run background function. A run still queued from before (a hand-off that failed, or a second
  // try) is handed off again. Nudges held for quiet hours are retried here; old events are pruned.
  try {
    const started: string[] = [];
    let retried = 0;
    if (aiConfigured() && origin) {
      const queued = await queueTeamRuns(now, tz);
      for (const run of queued) {
        try {
          await handOffTeamRun(origin, run.id);
          started.push(run.id);
        } catch (error) {
          // It stays queued: the next pass hands it off again, and failStaleRuns fails it after 10 minutes.
          console.error("Athena reminders: couldn't start a team run", (error as Error).message?.slice(0, 120));
        }
      }
      // Runs a hand-off missed (a save's at-once hand-off, or a pass's) and second tries.
      retried = await handOffQueuedRuns(origin, now, queued.map((r) => r.id));
    }
    const stale = await failStaleRuns(now);
    // Assignments (lib/assignment-run.ts): a stage whose plan has had its Go moves on; one whose run died is failed.
    const assignments = await sweepAssignments(now).catch(() => ({ moved: 0, failed: 0 }));
    if (assignments.moved || assignments.failed) report.assignments = assignments;
    const pruned = await pruneTeamEvents(now);
    // Team chat keeps a post outside an assignment for 90 days (lib/team-posts.ts).
    const swept = await sweepPosts(now).catch(() => 0);
    const delivered = await deliverTeamNudges(now, tz, { canPush, send: (m) => sendToAll(m), quiet: prefs.quiet });
    // An assignment that stopped for the owner: one push per stop, no card (lib/assignment-push.ts).
    const stops = await deliverStopPushes(now, tz, { canPush, send: (m) => sendToAll(m), quiet: prefs.quiet }).catch(() => ({ sent: 0, held: 0 }));
    if (stops.sent || stops.held) report.assignment_stops = stops;
    if (started.length || retried || stale || pruned || swept || delivered.sent || delivered.held) report.team = { started: started.length, handed_again: retried, stale, pruned, ...(swept ? { posts_swept: swept } : {}), ...delivered };
  } catch (error) {
    console.error("Athena reminders: team failed", error);
  }

  // ---------- 0d. Flows (lib/flow-triggers.ts): due schedule slots, "before" times and new events start runs ----------
  // Each fire and event is claimed once, apart from Team's claim. Nothing runs until the engine plugs in.
  try {
    const flows = await runFlowTriggers(now, tz);
    if (flows?.length) report.flows = { started: flows.length };
  } catch (error) {
    console.error("Athena reminders: flows failed", error);
  }

  // ---------- 1. Morning briefing ----------
  // In quiet hours the briefing waits for them to end, so its push lands when you're up.
  // With AI configured the model writes it in a background function (lib/briefing-run.ts);
  // the data briefing goes out here when it isn't, when that can't be started, or when
  // nothing has gone out WATCHDOG_MINUTES later. `briefing-sent:<day>` keeps it to one.
  if (isBriefingTime(now, tz) && !(canPush && prefs.briefing && quiet)) {
    const deps = dbDeliverDeps((m) => sendToAll(m));
    const sendData = async () => deliverBriefing(buildBriefing(await loadBriefingInput(now, tz, events)), { push: canPush && prefs.briefing }, deps);
    const key = claimKey(today);
    if (await claimReminder(key)) {
      try {
        if (aiConfigured() && origin) {
          try {
            await handOff(origin, today);
            report.briefing = "handed off";
          } catch (error) {
            console.error("Athena reminders: couldn't start the briefing writer", error);
            report.briefing = await sendData();
          }
        } else report.briefing = await sendData();
      } catch (error) {
        // Let the next run (5 minutes later) try again.
        await releaseReminder(key);
        throw error;
      }
    } else {
      const state = await briefingState(today);
      if (watchdogDue(state.handedOffAt, state.sent, now)) report.briefing = { fallback: await sendData() };
    }
  }

  // ---------- 2. Timed events, 30 minutes before ----------
  if (canPush && prefs.events && !quiet) {
    const sentTimed: string[] = [];
    for (const r of dueTimedReminders(events, now, tz)) {
      if (prepped.has(r.event.id)) continue;
      if (!(await claimReminder(r.key))) continue;
      try {
        // A meeting with people gets the context worth having walking in.
        const event = events.find((e) => e.id === r.event.id)!;
        const people = await meetingPeople(event).catch(() => []);
        await sendToAll({
          title: r.event.title,
          body: meetingContext(r.localTime, people, now),
          url: people.length === 1 ? `/#/people/${people[0].id}` : `/#/events/${r.event.id}`,
          tag: r.key,
        });
        sentTimed.push(r.key);
      } catch (error) {
        await releaseReminder(r.key);
        console.error("Athena reminders: timed push failed", error);
      }
    }
    report.timed = sentTimed;

    // ---------- 2b. Bookings: a flight 3 hours before; a train, a car pick-up or a show 30 minutes before ----------
    // Each kind's lead is BOOKING_PUSH_LEAD_MINUTES; a hotel gets no push.
    const sentBookings: string[] = [];
    const longestLead = Math.max(...Object.values(BOOKING_PUSH_LEAD_MINUTES).map((m) => m ?? 0));
    for (const b of await listBookingsStarting(now, new Date(now.getTime() + longestLead * 60_000))) {
      const lead = BOOKING_PUSH_LEAD_MINUTES[b.kind];
      if (lead === null || !b.starts_at || Date.parse(b.starts_at) >= now.getTime() + lead * 60_000) continue;
      const key = `booking:${b.id}:${b.starts_at}`;
      if (!(await claimReminder(key))) continue;
      try {
        // A train gets the departure board's word on it, a flight OpenSky's (netlify/lib/live-flights.ts);
        // with no answer in a few seconds, the push as before.
        const live = b.kind === "train" ? await trainStatus(b, { now }).catch(() => null) : null;
        const flying = b.kind === "flight" ? await flightStatus(b, { now }) : null;
        const { title, body } = b.kind === "train" ? trainPush(b, live, tz) : b.kind === "flight" ? flightPush(b, flying, tz) : bookingPush(b, tz);
        await sendToAll({ title, body, url: `/#/trips/${b.trip_id}`, tag: key });
        sentBookings.push(key);
      } catch (error) {
        await releaseReminder(key);
        console.error("Athena reminders: booking push failed", error);
      }
    }
    report.bookings = sentBookings;
  }

  // ---------- 3. Custom reminders, when due (in quiet hours they wait) ----------
  if (canPush && !quiet) {
    const sentCustom: string[] = [];
    for (const r of await listDueReminders(now)) {
      const key = `reminder:${r.id}:${new Date(r.remind_at).toISOString()}`;
      // Switched off: no push, but it still moves on as if it had been sent.
      if (prefs.reminders && (await claimReminder(key))) {
        try {
          await sendToAll({
            title: r.text,
            body: reminderBody(r, now, tz),
            url: reminderUrl(r),
            tag: key,
          });
          sentCustom.push(r.id);
        } catch (error) {
          await releaseReminder(key);
          console.error("Athena reminders: custom push failed", error);
          continue;
        }
      }
      // Claimed earlier (a run that sent but died before advancing) or just sent: move it on.
      await advanceReminder(r, now, tz);
    }
    report.custom = sentCustom;
  }

  // Read only when a check-in push could go out (lib/checkin-push.ts).
  const routines = canPush && !quiet && (prefs.morning || prefs.evening) ? await loadCheckinSettings() : null;

  // ---------- 4a. The morning check-in, once a day, only while the morning routine is on and it isn't done ----------
  if (canPush && routines?.morning.enabled) {
    const morning = await checkins(today, "morning").catch(() => null);
    if (morningPushDue({ now, tz, prefs, settings: routines, checkin: morning })) {
      const key = morningKey(today);
      if (await claimReminder(key)) {
        try {
          report.morning = await sendToAll(morningPush(today));
        } catch (error) {
          await releaseReminder(key);
          console.error("Athena reminders: morning check-in push failed", error);
        }
      }
    }
  }

  // ---------- 4. The evening Days prompt, once a day, only when today isn't kept yet ----------
  // With the evening routine on it's the reflection: it opens the check-in, and only a done check-in skips it.
  if (canPush && prefs.evening && !quiet && isEveningTime(now, tz, prefs.evening_at)) {
    const key = `evening:${today}`;
    // Health and places stay out of a push; mood, line and journal only answer "kept yet?".
    const day = await getDay(today, { tz, health: false, places: false });
    const reflecting = !!routines?.evening.enabled;
    const plan = eveningPlan(reflecting, reflecting ? await checkins(today, "evening").catch(() => null) : null, dayKept(day));
    if (plan === "kept" || plan === "done") report.evening = plan;
    else if (await claimReminder(key)) {
      try {
        // Who the owner saw today, by Week in review's rule (lib/week-review.ts): logged catch-ups (in person,
        // calls, other) and calendar events with a named person at a place. First names only reach the push
        // (lib/nudges.ts eveningLine), with the event's Library place; never the day's location history.
        const [logged, events] = await Promise.all([
          listInteractions({ since: zonedToInstant(today, "00:00", tz), until: zonedToInstant(addDays(today, 1), "00:00", tz), limit: 20 }).catch(() => []),
          seenEvents(today, today, tz).catch(() => []),
        ]);
        const seen: SeenToday[] = [
          ...events.flatMap((e) => e.people.map((p) => ({ name: p.name, in_person: true, place: e.place, how: e.title }))),
          ...logged.filter((i) => i.channel === "in_person" || i.channel === "call" || i.channel === "other").flatMap((i) => i.people.map((p) => ({ name: p.name, in_person: i.channel !== "call" }))),
        ];
        // The body leads with the day's best thing, never an undone habit (docs/notes/affection-2026-11.md, moment 1).
        report.evening = await sendToAll(plan === "reflection" ? reflectionPrompt(today, day, seen) : eveningPrompt(today, day, seen));
      } catch (error) {
        await releaseReminder(key);
        console.error("Athena reminders: evening push failed", error);
      }
    }
  }

  // ---------- 4b. Sunday from 18:00: the weekly review ----------
  // The push is the Week in review's own headline (lib/week-push.ts builds the page's
  // signals on the server, lib/week-headline.ts words them), so the push and the page
  // agree. It never counts what's still open or late: that lives in To do.
  if (canPush && prefs.weekly && !quiet && isWeeklyReviewTime(now, tz)) {
    const key = `week:${today}`;
    if (await claimReminder(key)) {
      try {
        const { text, monday } = await weekPushHeadline(today, tz);
        report.weekly = await sendToAll({
          title: "Your week, in review",
          body: text,
          // The week in review, the page this line heads.
          url: `/#/days/week/${monday}`,
          tag: key,
        });
      } catch (error) {
        await releaseReminder(key);
        console.error("Athena reminders: weekly review push failed", error);
      }
    }
  }

  // ---------- 4c. Regular payments: a price that went up, a payment that didn't come (lib/recurring.ts) ----------
  // Under the Reminders switch, from the briefing's time. Names only: the amounts stay on the Money page.
  // reminder_log is readable, so its key is a blind index of the merchant, never the name.
  await sealLegacyPaymentKeys();
  if (canPush && prefs.reminders && !quiet && isBriefingTime(now, tz)) {
    const sentMoney: string[] = [];
    const list = await regularPayments(today).then((r) => r.items, () => []);
    for (const n of paymentNudges(list, today, merchantIndexes)) {
      if (!(await claimIndexedReminder(n.tag, n.older))) continue;
      try {
        await sendToAll({ title: n.title, body: n.body, url: n.url, tag: n.tag });
        sentMoney.push(n.kind);
      } catch (error) {
        await releaseReminder(n.tag);
        console.error("Athena reminders: payment nudge failed", error);
      }
    }
    report.payments = sentMoney;
  }

  // ---------- 5. Purchases that arrived (or were returned) 30 days ago quietly leave ----------
  // Archived, never deleted: they're on the Archived page, and a later email brings one back.
  report.purchasesArchived = await archiveSettledPurchases(now);

  return report;
}

/** A merchant's blind indexes for reminder_log keys, the current data key's first; none without a data key. */
const merchantIndexes = (merchant: string): string[] => (currentKeyId() ? blindIndexes("other", `regular\u0000${merchant}`) : []);

/**
 * Payment nudges used to be claimed as "regular-up:<merchant>:<date>", the
 * merchant readable. Each such row is moved to the indexed key it would have
 * now (keeping when it was sent), so the name is gone and a nudge already
 * sent isn't sent again. One query that finds nothing once they're moved.
 */
export async function sealLegacyPaymentKeys(): Promise<void> {
  try {
    for (const key of await reminderKeysWithPrefix(LEGACY_PAYMENT_PREFIXES)) {
      const [next] = rekeyLegacyPayment(key, merchantIndexes);
      if (next) await rekeyReminder(key, next);
    }
  } catch (error) {
    console.error("Athena reminders: moving old payment keys failed", error);
  }
}

/** Sent mail for awaiting reply, read at most once an hour (each read opens every mailbox). */
async function sentMailHourly(now: Date, tz: string) {
  const { date, hour } = zonedParts(now, tz);
  if (!(await claimReminder(`reply-scan:${date}:${hour}`))) return [];
  return loadSentMail();
}

function siteUrl(): string | undefined {
  return (globalThis as { Netlify?: { env: { get(k: string): string | undefined } } }).Netlify?.env.get("URL") ?? process.env.URL;
}

const unscoped = async (_req: Request, context?: { site?: { url?: string } }) => {
  try {
    const report = await runReminders(new Date(), context?.site?.url || siteUrl());
    console.log("Athena reminders:", JSON.stringify(report));
  } catch (error) {
    console.error("Athena reminders failed:", error);
  }
};

// Every 5 minutes, so a custom reminder lands within 5 minutes of its time.
// AI spend: every model call in this function counts as background work for "reminders" (lib/spend.ts).
export default (...args: Parameters<typeof unscoped>) => withSpendScope({ area: "background", job: "reminders" }, () => unscoped(...args));

export const config: Config = { schedule: "*/5 * * * *" };
