/**
 * Whether an assistant may look things up online while it works, the app
 * side (owner, 16 Nov 2026: "a switch per assistant, off by default,
 * suggested at hiring when the job clearly needs it"; docs/team.md,
 * "Looking things up online").
 *
 * The contract is `web?: boolean` on `TeamAssistant`, on the input to
 * `createAssistant` and `updateAssistant`, and on `TeamDraft` (true when the
 * server thinks the job needs something online). A sibling session adds it
 * to lib/team-types.ts; until that lands, it's read and sent through the
 * small local types here, so nothing else has to change when it does.
 *
 * Every switch follows the app-wide "Let Ask search the web" (Settings →
 * Ask): while that's off, no assistant looks anything up, whatever its own
 * switch says.
 */
import { isSampleMode, loadAskWeb } from "../db/api";
import { SAMPLE_WEB_HINTS } from "../db/sample-team";
import type { TeamAssistant, TeamAssistantInput, TeamDraft } from "../../../lib/team-types";

/** The field the contract adds. Missing means off (older servers, older assistants). */
export interface WebFields {
  web?: boolean;
}
export type WebAssistant = TeamAssistant & WebFields;
export type WebInput = TeamAssistantInput & WebFields;
export type WebDraft = TeamDraft & WebFields;

/** Its switch: off unless the server says it's on. */
export const webOn = (a: TeamAssistant): boolean => (a as WebAssistant).web === true;

/** The draft thinks the job needs something online. */
export const draftWantsWeb = (d: TeamDraft): boolean => (d as WebDraft).web === true;

/** A patch that turns the switch on or off, typed for updateAssistant until the contract lands. */
export const webPatch = (on: boolean): TeamAssistantInput => ({ web: on }) as WebInput;

// ---------- "its job needs it" ----------

/**
 * Which assistants the server thought needed the web when they were hired
 * (`TeamDraft.web`), remembered on this device. The server keeps no hint of
 * its own yet (docs/team-notes/web-app.md, "For the integrator"), so an
 * assistant hired on another device has none here, and its page says nothing
 * about needing it.
 */
const HINTS = "athena.team.webHint";

function readHints(): Set<string> {
  try {
    const raw = JSON.parse(localStorage.getItem(HINTS) ?? "[]") as unknown;
    return new Set(Array.isArray(raw) ? raw.filter((x): x is string => typeof x === "string") : []);
  } catch {
    return new Set();
  }
}

/** Setup proposed the switch for this assistant (or didn't): kept so its page can say when it's off. */
export function rememberWebHint(id: string, needs: boolean): void {
  try {
    const hints = readHints();
    if (needs) hints.add(id);
    else hints.delete(id);
    localStorage.setItem(HINTS, JSON.stringify([...hints].slice(-24)));
  } catch {
    /* storage blocked: the page just won't say it */
  }
}

/** Its job needs the web: the server's hint at hiring, kept on this device (sample mode: Penny). */
export function needsWeb(a: Pick<TeamAssistant, "id">): boolean {
  if (isSampleMode() && SAMPLE_WEB_HINTS.has(a.id)) return true;
  return readHints().has(a.id);
}

// ---------- the app-wide setting ----------

let setting: Promise<boolean> | null = null;

/** "Let Ask search the web", read once per visit (on by default; a failed read counts as on, as the setting does). */
export function askWebOn(fresh = false): Promise<boolean> {
  if (fresh || !setting) setting = loadAskWeb().catch(() => true);
  return setting;
}
