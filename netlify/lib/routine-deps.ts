/**
 * A routine run's real dependencies (lib/routine-run.ts): Ask's one loop with
 * the connected accounts and the same mail, Slack and calendar ports as Ask,
 * proposing only. Kept here so lib/ stays free of the connector clients.
 */
import { runAsk } from "../../lib/answer";
import { saveAskThread } from "../../lib/ask-threads";
import type { RoutineRunDeps } from "../../lib/routine-run";
import { answerSources } from "./connectors/answer-sources";
import { calendarPort } from "./connectors/calendar-rsvp";
import { mailPort } from "./connectors/gmail-drafts";
import { slackPort } from "./connectors/slack-drafts";
import { schedulingPort } from "./connectors/calendar-scheduling";

export const routineDeps: RoutineRunDeps = {
  // long: the server's limits (10 model calls, 24 lookups, wrap-up at 60 s, stop at 120 s); the background function has 15 minutes.
  // plan "propose": every change is queued and kept as a plan; nothing is written (lib/ask-plans.ts). log false: nothing happened to log.
  ask: (question, { now, tz, routine_id, thread_id }) =>
    runAsk(question, { sources: answerSources, gmail: mailPort, slack: slackPort, calendar: calendarPort, scheduling: schedulingPort }, { now, tz, long: true, plan: "propose", log: false, routine_id, thread_id }),
  saveThread: (id, input) => saveAskThread(id, input),
};
