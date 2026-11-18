/**
 * A Team run's real dependencies (lib/team-run.ts), kept here so lib/ stays
 * free of the connector clients: runAssistantTurn (lib/team-chat.ts) with the
 * connector ports a run's tools need.
 */
import { runAssistantTurn } from "../../lib/team-chat";
import { asTrackerChecker } from "../../lib/trackers-store";
import type { TeamRunDeps } from "../../lib/team-run";
import { calendarPort } from "./connectors/calendar-rsvp";
import { mailPort } from "./connectors/gmail-drafts";
import { slackPort } from "./connectors/slack-drafts";
import { schedulingPort } from "./connectors/calendar-scheduling";

const ports = { gmail: mailPort, slack: slackPort, calendar: calendarPort, scheduling: schedulingPort };

export const teamRunDeps: TeamRunDeps = {
  // asTrackerChecker: a check the run keeps, or a tracker it starts, is that assistant's (lib/trackers-store.ts).
  turn: (assistantId, prompt, opts) => asTrackerChecker(assistantId, () => runAssistantTurn(assistantId, prompt, { ...ports, ...opts })),
};
