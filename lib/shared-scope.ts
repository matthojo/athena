/**
 * The connected accounts one turn may open, when something someone else shared is in it (lib/shared-limits.ts,
 * SECURITY.md §10 "Items someone else shared"):
 *
 *  - an imported assistant's turn (a chat, a run, a flow's think step) starts limited to the accounts the owner
 *    ticked for it (lib/team-chat.ts);
 *  - an imported skill limits the turn from the moment it's in use: picked with "/", or loaded with use_skill or
 *    read_skill_file (lib/skills-ask.ts). Two limits together leave only the accounts both allow.
 *
 * Enforced in code, where the model's words can't change it: the accounts outside the limit aren't opened when it's
 * known before they open, their tools stop being offered, a call to one is refused, and the Session's mail, Slack and
 * calendar ports refuse any account outside it. Nothing here widens what a turn could reach without a limit.
 */
import type { OpenSources, SourcesPort } from "./answer";
import type { MailPort, SlackPort } from "./drafts";
import type { CalendarPort } from "./rsvp";
import type { SchedulingPort } from "./scheduling";

/** Who limited a turn, as the owner would name it: "Moss", "Gift prices". */
export class AccountScope {
  private allowed: Set<string> | null = null;
  private readonly by: string[] = [];

  constructor(start?: { ids: Iterable<string>; by: string } | null) {
    if (start) this.limit(start.ids, start.by);
  }

  /** Allow only these from here on (and only what was allowed before). */
  limit(ids: Iterable<string>, by: string): void {
    const next = new Set([...ids].map((id) => id.toLowerCase()));
    this.allowed = this.allowed ? new Set([...this.allowed].filter((id) => next.has(id))) : next;
    if (!this.by.includes(by)) this.by.push(by);
  }

  /** Is any limit on? */
  get active(): boolean {
    return this.allowed !== null;
  }

  /** The accounts still allowed; null with no limit. */
  get ids(): ReadonlySet<string> | null {
    return this.allowed;
  }

  /** May this account be opened? Always, with no limit; an account with no id never, with one. */
  has(id: string | null | undefined): boolean {
    if (!this.allowed) return true;
    return !!id && this.allowed.has(id.toLowerCase());
  }

  /** What a refused call answers the model. */
  refusal(account: string): string {
    const who = this.by.join(" and ");
    return `${account} is off for ${who || "this item"}: someone else shared it, and the owner hasn't ticked that account for it. Don't try it again; answer without it, and say the owner can tick the account on ${who ? `${who}'s` : "its"} page if they want it used.`;
  }
}

/** Refused before anything is reached. */
export class AccountOff extends Error {
  constructor(message = "That account is off for something someone else shared.") {
    super(message);
    this.name = "AccountOff";
  }
}

/**
 * The accounts port, limited: only allowed accounts are asked for (`only`), and anything else that comes back
 * anyway is closed off from the turn. With no limit it's the port as it was.
 */
export function scopedSources(port: SourcesPort, scope: AccountScope): SourcesPort {
  return {
    async open(opts): Promise<OpenSources> {
      if (!scope.active) return port.open(opts);
      const ids = scope.ids!;
      if (!ids.size) return { accounts: [], skipped: [], close: async () => undefined };
      const opened = await port.open({ ...opts, only: ids });
      return { ...opened, accounts: opened.accounts.filter((a) => scope.has(a.connector?.id)) };
    },
  };
}

/** The Session's ports to the owner's accounts (lib/assistant.ts). */
export interface AccountPorts {
  gmail?: MailPort;
  slack?: SlackPort;
  calendar?: CalendarPort;
  scheduling?: SchedulingPort;
}

/**
 * The ports, each refusing an account outside the limit at the moment it's called (a skill can limit a turn part
 * way through). Slack's port names no account: it's refused unless one of `slackIds()` is allowed.
 */
export function scopedPorts<T extends AccountPorts>(ports: T, scope: AccountScope, slackIds: () => Promise<string[]>): T {
  const check = (id: string) => {
    if (!scope.has(id)) throw new AccountOff();
  };
  const slackOk = async () => {
    if (!scope.active) return;
    if (!(await slackIds()).some((id) => scope.has(id))) throw new AccountOff();
  };
  const { gmail, slack, calendar, scheduling } = ports;
  return {
    ...ports,
    gmail: gmail && {
      readThread: async (id, thread) => (check(id), gmail.readThread(id, thread)),
      createDraft: async (id, draft) => (check(id), gmail.createDraft(id, draft)),
      ...(gmail.sentSamples ? { sentSamples: async (id: string, to: string | null) => (scope.has(id) ? gmail.sentSamples!(id, to) : []) } : {}),
    },
    slack: slack && {
      findMember: async (person) => (await slackOk(), slack.findMember(person)),
      ownMessages: async () => (scope.active && !(await slackIds()).some((id) => scope.has(id)) ? [] : slack.ownMessages()),
    },
    calendar: calendar && {
      respond: async (id, invite) => (check(id), calendar.respond(id, invite)),
    },
    scheduling: scheduling && {
      // A look at a calendar outside the limit finds nothing, so the accounts inside it still answer; a change is refused.
      events: async (id, from, to) => (scope.has(id) ? scheduling.events(id, from, to) : []),
      freeBusy: async (id, emails, from, to) => (scope.has(id) ? scheduling.freeBusy(id, emails, from, to) : []),
      move: async (id, req) => (check(id), scheduling.move(id, req)),
      calendars: async (id) => (scope.has(id) ? scheduling.calendars(id) : []),
      create: async (id, req) => (check(id), scheduling.create(id, req)),
      removeCreated: async (id, req) => (check(id), scheduling.removeCreated(id, req)),
    },
  };
}
