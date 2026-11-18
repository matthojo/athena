/**
 * The headline lives in lib/week-headline.ts now, so the Sunday push
 * (netlify/functions/reminders.ts §4b) builds the same line on the server.
 * Re-exported here so the app's imports stay as they were.
 */
export * from "../../../lib/week-headline";
