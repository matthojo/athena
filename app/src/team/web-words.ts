/**
 * The words for an assistant looking things up online: a switch per
 * assistant, off by default, suggested at hiring when the job clearly needs
 * it. Pure, so they're tested (web-words.test.ts); the state lives in
 * web-access.ts.
 *
 * Every line names the assistant by its own pronoun, never "it" for one who
 * is "she".
 */
import type { Personality } from "../../../lib/team-types";
import { cap, pronouns } from "./detail-words";

/** The app-wide setting every assistant's switch follows (Settings → Ask). */
export const ASK_WEB_SETTING = { label: "Let Ask search the web", href: "#/settings/ask" } as const;

/**
 * The switch's name, on the page and at hiring. It governs only what the assistant does on its own: in a chat it
 * searches the way main Ask does, switch or not.
 */
export function webLabel(p: Pick<Personality, "pronoun">): string {
  return `Can look things up online on ${pronouns(p).their} own`;
}

/** A job about prices: what the line at hiring and the "needs it" line say it's for. */
export function isPriceJob(job: string): boolean {
  return /\b(price|prices|priced|pricing|deal|deals|cheap|cheaper|cheapest|discount|sale|sales|cost|costs|offer|offers|bargain)\b/i.test(job);
}

/**
 * What it may do online on its own, and what a search may carry (your country, city and time zone; the saved item's
 * title and link; shops and brands it has learned you use; the public subject of its job). Said without listing all
 * of it, and true to it.
 */
export function webDetail(p: Personality): string {
  const w = pronouns(p);
  const verb = (one: string, many: string) => (w.plural ? many : one);
  return `Searches the web and reads pages when ${w.they} ${verb("works", "work")} on ${w.their} own. A search can include where you live, what ${w.they}${verb("'s", "'re")} looking for and the shops ${w.they} ${verb("knows", "know")} you use. Nothing else about you.`;
}

/** Chats aren't governed by the switch: off never means never online. */
export function webChat(p: Personality): string {
  const w = pronouns(p);
  return `In a chat, ${w.they} ${w.plural ? "search" : "searches"} the way Ask does, with this on or off.`;
}

/** It follows the app-wide setting. */
export const WEB_FOLLOWS = `Only while “${ASK_WEB_SETTING.label}” is on in Settings.`;

/** The app-wide setting is off: said instead of a switch that can't do anything. */
export const WEB_BLOCKED = "Off for every assistant";

/** Why, and what happens when it's back on: one with its own switch on starts again; one with it off is yours to choose. */
export function webBlockedDetail(name: string, on: boolean): string {
  const why = `“${ASK_WEB_SETTING.label}” is off in Settings.`;
  return on ? `${why} ${name} will look things up once it's on.` : `${why} Turn it on there, then choose here whether ${name} can.`;
}

/** Its job needs the web and the switch is off: one quiet, honest line beside the switch. */
export function webNeededLine(name: string, job: string, p: Personality): string {
  const w = pronouns(p);
  return isPriceJob(job)
    ? `${name} needs this to check prices. Without it, ${w.their} runs only see what you've saved.`
    : `${name} needs this for the job. Without it, ${w.their} runs only see what's in Athena.`;
}

/** At hiring, the assistant's own words for the proposal, switched on or off. */
export function webTerm(job: string, on: boolean): string {
  if (!on) return "On my own, I'll stick to what's in Athena.";
  return isPriceJob(job) ? "I'll check prices online as I work." : "I'll look things up online as I work.";
}

/** At hiring, what it sees, in the first person. */
export const WEB_TERM_DETAIL = "A search can include where you live, what I'm looking for and the shops I know you use. Nothing else about you.";

/** At hiring, with the app-wide setting off: it says so, and what turning it on would do. */
export function webTermSettingOff(job: string): string {
  return isPriceJob(job) ? "I'd check prices online, but web search is off in Settings." : "I'd look things up online, but web search is off in Settings.";
}
export const WEB_TERM_SETTING_OFF_DETAIL = "Turn it on there and I'll start.";
