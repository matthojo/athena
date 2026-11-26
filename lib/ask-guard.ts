/**
 * What one Ask turn may change, given what it has read (docs: security/ai-and-ask,
 * "One loop: who can ask for a change").
 *
 * Ask is one loop now: the same model call that reads an email can also call
 * a tool that changes Athena. So the rule a prompt can only ask for is backed
 * here, in code the model can't talk its way past:
 *
 *  - Only the owner's own words ask for a change. Whether they did is read
 *    from their message alone (`askedFor`), never from what a tool returned.
 *  - Once a turn has read something other people wrote (an item from a
 *    connected account, a web page, a file, or a note Athena collected from
 *    email, a meeting or another account), a change the owner's message
 *    didn't plainly ask for is never made in that turn. It's kept as a plan
 *    for the owner to Go (lib/ask-plans.ts), so nothing happens without them.
 *  - Once anything read is flagged as an instruction (lib/jev.ts guardText),
 *    the write tools are taken away for the rest of the turn, and anything
 *    already queued waits for Go too.
 *  - A Team assistant's unattended run has no message from the owner. Its
 *    allowlist (what the owner ticked it may do alone) is their standing
 *    request: a change on it runs alone, whatever
 *    started the run or was read in it. A change not on it waits for Go. A
 *    flag still takes every write tool away, allowlisted or not. The guard
 *    is given the allowlist when the turn starts; nothing reads it from a
 *    tool result. A chat has none: the owner's own message decides.
 *  - Text Jev couldn't check (it's off, past its budget, slow or failing)
 *    is `unchecked`. In an unattended run, an allowlisted change queued after
 *    reading it waits for Go, as one would after a flag, but the write tools
 *    stay: nothing is known to be wrong. A chat goes on as before: the owner
 *    is there, a change their message didn't plainly ask for already waits
 *    once others' words are read, and one it did ask for is theirs.
 *
 * Erring here costs the owner one tap (a plan card with one step), never a
 * change they didn't ask for.
 */
/** The kinds of change an owner's words can ask for. */
export type Asked = "add" | "change" | "remove" | "link" | "send";

/** What other people wrote, read in this turn. */
export type ReadFrom = "account" | "web" | "file" | "collected";

/**
 * Was this note collected (from email, a meeting, another account) rather than written by the owner? Its
 * `source` says: the owner's own notes are `manual` (typed) or `app` (made in the app, or by Ask for them).
 * Anything else, and a note with no source at all, counts as other people's words.
 */
export const isCollected = (source: string | null | undefined): boolean => source !== "manual" && source !== "app";

const VERBS: Record<Asked, string> = {
  add: "add|set|put|pop|stick|save|keep|file|store|create|make|turn (?:this|that|it|these|those|them)(?: \\w+){0,3} into|convert|start|begin|note|jot|log|record|remember|track|import|remind|schedule|book|plan|set up|write down|new|duplicate|copy|buy|order|watchlist|queue",
  change:
    "update|change|edit|fix|correct|amend|rename|retitle|set|move|reschedule|push|postpone|bring forward|mark|tick|untick|check off|complete|finish|close|done|swap|replace|assign|reassign|rate|pause|resume|turn (?:on|off)|switch|tag|untag|fill in|fill out",
  remove: "archive|unarchive|restore|reopen|remove|delete|cancel|drop|clear|hide|forget|bin|get rid of",
  link: "link|unlink|connect|attach|relate",
  send: "draft|write|reply|respond|message|text|email|e-mail|slack|whatsapp|send|chase|nudge|rsvp|accept|decline|answer|invite|tell|ask|share",
};

/**
 * Where an instruction can start: the message's first words, or a new clause
 * ("…, and add a to-do", "… then remind me"). A verb in the middle of a
 * question ("what should I add to my list?") isn't one.
 */
const OPENS = String.raw`(?:^|[.,;:!?\n]\s*|\b(?:and|then|also|plus|but|so)\s+)(?:(?:and|then|also|so|ok|okay|yes|yeah|sure|great|thanks|now)[,\s]+)*(?:please\s+)?(?:(?:can|could|would|will)\s+you\s+|i(?:'d| would)\s+like\s+you\s+to\s+|i\s+(?:need|want)\s+you\s+to\s+|(?:don't|do not)\s+forget\s+to\s+|go\s+ahead\s+and\s+|let's\s+)?(?:please\s+)?(?:just\s+|also\s+|then\s+|quickly\s+)*`;

const asks = (verbs: string) => new RegExp(`${OPENS}(?:${verbs})\\b`, "i");
const ASKS: Array<[Asked, RegExp]> = (Object.keys(VERBS) as Asked[]).map((k) => [k, asks(VERBS[k])]);

/** "I finished The Bear", "I've booked the flights", "I owe Sam a call": the owner saying what happened is asking for it to be kept. */
const SAID = /(?:^|[.,;:!?\n]\s*|\b(?:and|then|also)\s+)i(?:'ve|\s+have)?\s+(?:just\s+)?(finished|watched|read|started|booked|ordered|bought|reserved|paid|cancelled|canceled|met|spoke|called|owe|promised)\b/i;
/** "Priya's moving to Lisbon", "Sam has a new job": a fact to keep about someone. */
const FACT = /^[\p{L}' -]{2,40}(?:'s| is| has| was)\s+(?:moving|moved|now|new|starting|started|leaving|left|got|getting|birthday|having|expecting)\b/iu;
/** "Every Friday at 4pm, tell me what slipped", "do this every Monday": a routine. */
const ROUTINE = /^(?:(?:please\s+)?(?:do|run|ask)\s+(?:this|that|it)\s+)?(?:every|each)\s+(?:day|morning|evening|weekday|week|monday|tuesday|wednesday|thursday|friday|saturday|sunday)s?\b/i;
/** "Lunch with Priya Thursday at 1": an event, given as the owner would write it in a diary. */
const EVENT = /^(?:lunch|dinner|breakfast|brunch|coffee|drinks|a?\s*call|meeting|catch[ -]?up|1:1)\s+with\s+\p{L}/iu;

/**
 * The changes the owner's own message plainly asks for. Read from their words
 * only: `text` is the message as typed (mentions as their labels), never
 * anything a tool returned or an earlier reply said.
 */
export function askedFor(text: string): Set<Asked> {
  const t = text.replace(/[‘’]/g, "'").trim();
  const out = new Set<Asked>();
  for (const [kind, re] of ASKS) if (re.test(t)) out.add(kind);
  if (SAID.test(t) || FACT.test(t)) {
    out.add("add");
    out.add("change");
  }
  if (ROUTINE.test(t) || EVENT.test(t)) out.add("add");
  return out;
}

/** What each write tool does, in the owner's terms. A tool not listed here is never "plainly asked for". */
const TOOL_ASKS: Record<string, Asked[]> = {
  add_person: ["add"],
  add_to_list: ["add"],
  add_todo: ["add"],
  add_reminder: ["add"],
  add_to_watch_read: ["add", "change"],
  add_field: ["add"],
  remember: ["add", "change"],
  log_catch_up: ["add"],
  make_kind: ["add"],
  duplicate_kind: ["add"],
  import_recipe: ["add"],
  save_recipe: ["add", "change"],
  file_saved_item: ["add"],
  // Tracking (lib/ask-tools.ts): "track the price", "note the price", "tell me when it's back in stock".
  track: ["add"],
  record_value: ["add", "change"],
  set_tracker_target: ["add", "change"],
  save_routine: ["add", "change"],
  create_event: ["add"],
  fill_template: ["add"],
  make_document: ["add"],
  // Assignments (lib/assignment-tools.ts): a lineup kept as a draft, and a waiting stage moved on. Neither is offered once a turn is flagged.
  start_assignment: ["add"],
  continue_assignment: ["change"],
  // Flows (lib/flow-draft-ask.ts): a flow drawn and kept paused for the owner to turn on. Not offered once a turn is flagged.
  propose_flow: ["add"],
  attach_file: ["add", "link"],
  make_image: ["add", "change"],
  // These make a new one or change one that's there.
  save_note: ["add", "change"],
  save_item: ["add", "change"],
  save_record: ["add", "change"],
  save_trip: ["add", "change"],
  save_booking: ["add", "change"],
  save_purchase: ["add", "change"],
  complete_todo: ["change"],
  // "Add a step to the passport one" adds to a to-do that's there.
  change_todo: ["change", "add"],
  change_reminder: ["change", "remove"],
  update_people: ["change"],
  update_watch_read: ["change"],
  update_kind: ["change"],
  set_field: ["change", "add"],
  change_field: ["change"],
  move_event: ["change"],
  link_records: ["link", "add"],
  archive_or_restore: ["remove"],
  // These only prepare a card the owner taps, and are listed for completeness.
  answer_invite: ["send"],
  draft_message: ["send"],
  draft_email: ["send"],
  send_note: ["send"],
  log_spending: ["add"],
  log_health: ["add"],
  log_day_entry: ["add"],
  log_meter_reading: ["add"],
};

/**
 * May this tool change something, in Athena or (after the owner's tap) outside it? These go when a turn is
 * flagged. A list, not a rule: a tool is a write tool because it's named above, and a test checks that every
 * tool of the Session's that isn't a plain lookup is (lib/ask-guard.test.ts).
 */
export const isWriteTool = (name: string): boolean => Object.hasOwn(TOOL_ASKS, name);

/** Did the owner's message plainly ask for what this tool does? */
export function plainlyAsked(asked: ReadonlySet<Asked>, tool: string): boolean {
  return (TOOL_ASKS[tool] ?? []).some((k) => asked.has(k));
}

/** Tools whose link Athena's server fetches: `track` once kept (a run opens it), `import_recipe` as it runs. */
const FETCHES_LINK = new Set(["track", "import_recipe"]);

/**
 * A change that always waits for the owner's Go, whatever the owner's message asked for and whatever an assistant's
 * allowlist says: a tool given a link the model chose that Athena's server will fetch (FETCHES_LINK; lib/run-links.ts).
 * A page is fetched before Athena sees what comes back, and its address can carry the owner's data out in its query,
 * so only the owner may approve it. A tracker on a saved item with no link of its own takes the item's link, which
 * is the owner's, and doesn't wait.
 */
export function needsOwnersGo(tool: string, input: unknown): boolean {
  if (!FETCHES_LINK.has(tool) || !input || typeof input !== "object") return false;
  const url = (input as { url?: unknown }).url;
  return typeof url === "string" && url.trim() !== "";
}

/**
 * Why a change is waiting for Go rather than made: the turn read other people's words first, something it read was
 * flagged, an unattended run read text Jev couldn't check, or it sets a link a model chose (needsOwnersGo).
 */
export type HeldWhy = "read" | "flagged" | "unchecked" | "link";

/** One turn's guard: what the owner asked for, what's been read, and whether anything read was flagged or unchecked. */
export class TurnGuard {
  /** What the owner's own message asks for. Fixed when the turn starts. */
  readonly asked: ReadonlySet<Asked>;
  /** What's been read so far that other people wrote. */
  readonly read = new Set<ReadFrom>();
  private raised = false;
  private doubted = false;
  /** Queued changes (by the stand-in id the plan gave them) that must wait for Go, and why. */
  private readonly held = new Map<string, HeldWhy>();

  /** An unattended run's allowlist: the owner's standing request. Empty in a chat. Fixed when the turn starts. */
  private readonly standing: ReadonlySet<string>;

  /**
   * `flaggedNow`: whether anything read so far was flagged (lib/answer.ts keeps that with its evidence).
   * `standing`: the assistant's allowlist, for an unattended Team run only.
   * `uncheckedNow`: whether anything read so far was text Jev couldn't check (kept with the evidence too).
   */
  constructor(
    ownerText: string,
    private readonly flaggedNow: () => boolean = () => false,
    standing: Iterable<string> = [],
    private readonly uncheckedNow: () => boolean = () => false,
  ) {
    this.asked = askedFor(ownerText);
    this.standing = new Set(standing);
  }

  /** Something read looks like an instruction. Once true it stays true for the turn. */
  get flagged(): boolean {
    if (!this.raised && this.flaggedNow()) this.raised = true;
    return this.raised;
  }

  /** Something read couldn't be checked by Jev. Once true it stays true for the turn. */
  get unchecked(): boolean {
    if (!this.doubted && this.uncheckedNow()) this.doubted = true;
    return this.doubted;
  }

  /** The turn has read something other people wrote. */
  sawOthers(from: ReadFrom): void {
    this.read.add(from);
  }

  /** Something read looks like an instruction: no more write tools this turn. */
  flag(): void {
    this.raised = true;
  }

  /** Something read couldn't be checked: an unattended run's allowlisted changes wait for Go from here. */
  uncheck(): void {
    this.doubted = true;
  }

  /** May the model still be offered, and call, this tool? */
  allows(tool: string): boolean {
    return !(this.flagged && isWriteTool(tool));
  }

  /**
   * A change is being queued now. Must it wait for the owner's Go? Decided at
   * this moment: a change queued before anything of other people's was read
   * can't have been caused by it. In an unattended run, a change on the
   * allowlist was asked for by the owner ahead of time, so reading other
   * people's words doesn't hold it; a flag does, and so does text Jev
   * couldn't check, since nobody knows whether it would have been flagged.
   */
  mustWait(tool: string): HeldWhy | null {
    if (this.flagged) return "flagged";
    if (this.standing.has(tool)) return this.unchecked ? "unchecked" : null;
    if (this.read.size && !plainlyAsked(this.asked, tool)) return "read";
    return null;
  }

  hold(standIn: string, why: HeldWhy): void {
    this.held.set(standIn, why);
  }

  /**
   * Why the queued changes wait for Go, if any of them must: a flag outranks the rest, then an allowlisted change
   * held for text that wasn't checked (the owner expected it to run alone), then a read, then a model's link.
   */
  why(standIns: readonly string[]): HeldWhy | null {
    if (this.flagged && standIns.length) return "flagged";
    const held = standIns.map((id) => this.held.get(id)).filter((w): w is HeldWhy => !!w);
    return held.includes("unchecked") ? "unchecked" : held.includes("read") ? "read" : held.length ? "link" : null;
  }
}
