/**
 * A message Athena wrote for you, in a sheet: an email, a text, a WhatsApp
 * or a Slack DM, switched with the row at the top. Who it's to, the subject
 * (email) and the words are all editable. Ask for another go ("Shorter",
 * "Warmer", "More formal", or say what to change), then take it out
 * yourself:
 *
 *  - Email: save it to Gmail or Outlook Drafts (accounts with drafts turned
 *    on, under Sources) or open it in your mail app.
 *  - Text: open Messages with it filled in (sms:).
 *  - WhatsApp: open WhatsApp with it filled in (wa.me).
 *  - Slack: copy it and open the DM.
 *  - Copy, everywhere.
 *
 * Athena never sends. Links are built on tap, so your edits go with them.
 *
 * Opened from a to-do's sheet (Draft a reply / Draft a message), a person's
 * page (Draft a message), Home's catch-ups, an Ask receipt (a draft that's
 * already written, maybe already saved), or another part of the app with
 * words of its own: openDraftSheet({ to, channel, subject?, body }).
 */

import { h } from "../lib/dom";
import { icons } from "./icons";
import { openSheet } from "./sheet";
import { showToast } from "./toast";
import { autoTextarea, choiceChips, field, input } from "./fields";
import { ApiError, composeDraft, fetchConnectors, isSampleMode, saveDraftToMail } from "../db/api";
import { canDraft } from "../../../lib/connector-presets";
import { diallingCode, mailtoLink, slackDmLink, smsLink, SLACK_OPEN, telegramLink, whatsappLink } from "../../../lib/draft-links";
import { DRAFT_CHANNEL_ORDER, draftChannels } from "./draft-settings";
import type { AssistantChange, Commitment, DraftAccount, DraftChannel, MessageDraft, PersonRef } from "../types";

const TWEAKS = ["Shorter", "Warmer", "More formal"];
const CHANNELS = DRAFT_CHANNEL_ORDER;
const LABEL: Record<DraftChannel, string> = { email: "Email", text: "Text", whatsapp: "WhatsApp", telegram: "Telegram", slack: "Slack" };
/** "Email to Priya", "Text to Mum". */
const NOUN: Record<DraftChannel, string> = { email: "Email", text: "Text", whatsapp: "WhatsApp", telegram: "Telegram message", slack: "Slack message" };
/** "an email", "a text": for "Writing it as …" and Ask's sample replies. */
const A_NOUN: Record<DraftChannel, string> = { email: "an email", text: "a text", whatsapp: "a WhatsApp", telegram: "a Telegram message", slack: "a Slack message" };
/** The app you press Send in. */
const APP: Record<DraftChannel, string> = { email: "your mail app", text: "Messages", whatsapp: "WhatsApp", telegram: "Telegram", slack: "Slack" };
const PROVIDER: Record<DraftAccount["provider"], string> = { gmail: "Gmail", "outlook-mail": "Outlook", fastmail: "Fastmail" };

const firstName = (name: string) => name.replace(/^(dr|mr|mrs|ms)\.?\s+/i, "").split(/\s+/)[0];
const errorText = (error: unknown, fallback: string) =>
  error instanceof ApiError && error.status === 429 ? "Netlify's AI limit for this minute was reached. Try again in a moment." : error instanceof Error ? error.message : fallback;
const country = () => diallingCode(typeof navigator === "undefined" ? undefined : navigator.language) ?? "44";

// ---------- Sample mode ----------

type SampleWords = [subject: string, middle: string, signOff: string];

/** What sample mode's to-dos would say (db/sample-memory.ts), as Claude might write them, by email and as a short message. */
const SAMPLES: Record<string, { email: SampleWords; chat: string; usual: DraftChannel }> = {
  "Signed contract back from Marcus": {
    email: ["Contract", "Hope the week's going well. Have you had a chance to sign the contract? Send it back whenever it's ready and I'll get things moving.", "Thanks,"],
    chat: "Hi Marcus, any news on the contract? Send it back when it's signed and I'll get things moving.",
    usual: "email",
  },
  "Mum's photos from the weekend": {
    email: ["Weekend photos", "Lovely to see you at the weekend. Could you send me the photos when you get a minute? I'd love the ones from the garden.", "Thanks,"],
    chat: "Lovely seeing you at the weekend! Could you send me the photos when you get a minute? Especially the ones from the garden.",
    usual: "whatsapp",
  },
  "Intro Priya to the design agency": {
    email: ["Intro: the design agency", "As promised, here's the design agency I mentioned. [add their name and email] They did the onboarding work I showed you, and I think you'd get on well.", "Best,"],
    chat: "Hi Priya, here's the design agency I mentioned: [add their name and email]. They did the onboarding work I showed you. Happy to make the intro by email if that's easier.",
    usual: "slack",
  },
  "Read Elena's pricing memo and reply": {
    email: ["Your pricing memo", "Thanks for sending the pricing memo. I've read it and the tiers make sense to me. [add your thoughts on the enterprise tier]", "Best,"],
    chat: "Hi Elena, read the pricing memo. The tiers make sense to me. One question on enterprise: [add your question]",
    usual: "slack",
  },
};

/** Sample people's numbers and Slack, so every channel has somewhere to go. */
const SAMPLE_REACH = { phone: "+44 7700 900123", slack: "U04SAMPLE1" };

function shorten(text: string): string {
  return text.replace(/\s+[^.?!\]]+[.?!]$/, "");
}

/** Sample mode has no server: a believable draft from the to-do itself, on the channel asked for. */
function sampleDraft(opts: { c?: Commitment; person: PersonRef | null; channel?: DraftChannel; instruction?: string; sample?: SampleWords }): MessageDraft {
  const first = opts.person ? firstName(opts.person.name) : "there";
  const known = opts.c ? SAMPLES[opts.c.title] : undefined;
  // Their usual app when you use it; otherwise the first of yours that isn't Telegram (it can't pick the chat).
  const enabled = draftChannels();
  const channel = opts.channel ?? (known && enabled.includes(known.usual) ? known.usual : enabled.find((c) => c !== "telegram") ?? enabled[0]);
  const [subject, middle, signOff] = known?.email ?? opts.sample ?? [opts.c?.title ?? "Catching up", "Following up from our chat. [add the details]", "Best,"];
  // "Shorter" drops the last sentence; anything else keeps the words as they are.
  const cut = (s: string) => (opts.instruction === "Shorter" ? shorten(s) : s);
  const chat = known?.chat ?? `Hi ${first}, ${middle.charAt(0).toLowerCase()}${middle.slice(1)}`;
  const body = channel === "email" ? [`Hi ${first},`, cut(middle), signOff].join("\n\n") : cut(channel === "slack" ? chat : chat.replace(/^Hi \w+, /, (m) => (channel === "text" ? "" : m)).replace(/^./, (c) => c.toUpperCase()));
  return {
    channel,
    available: [channel, ...enabled.filter((c) => c !== channel)],
    enabled,
    to: opts.person ? [{ name: opts.person.name, email: `${first.toLowerCase()}@example.com` }] : [],
    subject: channel === "email" ? subject : "",
    body,
    phone: SAMPLE_REACH.phone,
    slack: SAMPLE_REACH.slack,
    reply: null,
    accounts: [
      { id: "sample-gmail", label: "Personal", provider: "gmail" },
      { id: "sample-outlook", label: "Work", provider: "outlook-mail" },
    ],
    can_enable_drafts: false,
    saved: null,
    flagged: false,
  };
}

/** "text Mum about…", "draft an email to Priya", "Slack Elena…": a drafting request in Ask, and the channel it names. */
export function draftRequestChannel(q: string): DraftChannel | null {
  const s = q.toLowerCase();
  if (!/\b(draft|write|text|message|whatsapp|telegram|slack|email|e-mail|reply|chase)\b/.test(s)) return null;
  if (/\bwhatsapp\b/.test(s)) return "whatsapp";
  if (/\btelegram\b/.test(s)) return "telegram";
  if (/\bslack\b/.test(s)) return "slack";
  if (/\btext\b|\bsms\b/.test(s)) return "text";
  if (/\be-?mail\b|\breply\b/.test(s)) return "email";
  return /\b(draft|write|chase|message)\b/.test(s) ? "email" : null;
}

/**
 * Sample mode's Ask: a drafting request for one of the sample people gets
 * the receipt a real one would, opening a sample draft. Nothing is saved or
 * sent, and the reply says so.
 */
export function sampleDraftChange(q: string, people: PersonRef[]): { change: AssistantChange; text: string } | null {
  const channel = draftRequestChannel(q);
  if (!channel) return null;
  const words = new Set(q.toLowerCase().split(/[^\p{L}]+/u));
  const person = people.find((p) => words.has(firstName(p.name).toLowerCase()));
  if (!person) return null;
  const first = firstName(person.name);
  const about = q.replace(/^.*?\babout\b\s*/i, "").replace(/[.?!]+$/, "").trim();
  // The sample to-do for this person, when there is one, has its own words.
  const known = Object.keys(SAMPLES).find((t) => new RegExp(`\\b${first}\\b`, "i").test(t));
  const draft = sampleDraft({ c: known ? ({ title: known } as Commitment) : undefined, person, channel, sample: ["Catching up", about && about !== q ? `Quick one about ${about}. [add the details]` : "Following up from our chat. [add the details]", "Best,"] });
  const what = NOUN[channel];
  // An email by its subject; anything else by how it starts, as Ask's receipts do.
  const start = draft.body.replace(/\s+/g, " ").trim();
  const title = draft.subject || (start.length <= 60 ? start : `${start.slice(0, 60).replace(/\s+\S*$/, "")}…`);
  const detail = `${what} to ${first} · ready to send`;
  return {
    change: { kind: "draft", id: `sample-draft-${person.id}`, action: "created", title, detail, label: `${title}. ${detail}`, open: { kind: "draft", draft }, undo: null },
    text: `Here's ${channel === "email" ? "a draft email" : A_NOUN[channel]} to ${first}. Open it to check the words and send it yourself. In sample mode nothing is saved.`,
  };
}

// ---------- Opening it ----------

/** Who a ready-written draft is for: any of the ways to reach them, and their Athena id when there is one. */
export interface DraftRecipient {
  name?: string;
  email?: string;
  phone?: string;
  /** A Slack member ID (U…), "T…/U…" with the workspace, or a handle. */
  slack?: string;
  personId?: string;
}

/**
 * A draft that's already written, from another part of Athena ("Draft a
 * reply with these times"). Stable: other sessions call it. `to` is a
 * recipient, or one string (an email address, a phone number or a name).
 */
export interface ReadyDraft {
  to: DraftRecipient | string;
  channel: DraftChannel;
  subject?: string;
  body: string;
}

/** Athena writes it: for a to-do, or to a person about something. */
export interface DraftSheetOptions {
  commitment?: Commitment;
  person?: PersonRef | null;
  /** Already written (an Ask receipt). */
  draft?: MessageDraft;
  /** What it's for when it isn't a to-do, in the owner's words ("wish Priya a happy birthday for Thursday"). */
  about?: string;
  /** Unset: the one you usually use with them. */
  channel?: DraftChannel;
  /** What sample mode writes instead. */
  sample?: SampleWords;
}

const isReady = (o: DraftSheetOptions | ReadyDraft): o is ReadyDraft => typeof (o as ReadyDraft).body === "string" && "to" in o;

function recipientOf(to: ReadyDraft["to"]): DraftRecipient {
  if (typeof to !== "string") return to;
  const s = to.trim();
  if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s)) return { email: s };
  if (/^[+\d][\d\s().-]{6,}$/.test(s)) return { phone: s };
  return { name: s };
}

/** A ready-written draft as the sheet holds one. Accounts arrive afterwards (readyAccounts). */
function readyDraft(r: ReadyDraft): { draft: MessageDraft; person: PersonRef | null; name: string } {
  const to = recipientOf(r.to);
  const name = to.name ?? to.email ?? to.phone ?? "";
  const enabled = draftChannels();
  const can = CHANNELS.filter((c) => enabled.includes(c) && (c === "email" ? !!to.email : c === "slack" ? !!to.slack : c === "telegram" ? true : !!to.phone));
  return {
    name,
    person: to.personId ? { id: to.personId, name: to.name ?? name } : null,
    draft: {
      channel: r.channel,
      available: [r.channel, ...can.filter((c) => c !== r.channel)],
      enabled,
      to: to.email ? [{ name: to.name ?? to.email, email: to.email }] : [],
      subject: r.channel === "email" ? (r.subject ?? "") : "",
      body: r.body,
      phone: to.phone ?? null,
      slack: to.slack ?? null,
      reply: null,
      accounts: [],
      can_enable_drafts: false,
      saved: null,
      flagged: false,
    },
  };
}

/** The mail accounts a ready-written email can be saved to, and whether one could be turned on. */
async function readyAccounts(): Promise<{ accounts: DraftAccount[]; canEnable: boolean }> {
  if (isSampleMode()) return { accounts: sampleDraft({ person: null }).accounts, canEnable: false };
  const { connectors } = await fetchConnectors();
  const mail = connectors.filter((c) => (c.provider === "gmail" || c.provider === "outlook-mail" || c.provider === "fastmail") && c.status === "connected");
  return {
    accounts: mail.filter(canDraft).map((c) => ({ id: c.id, label: c.account_label ? `${c.account_label.charAt(0).toUpperCase()}${c.account_label.slice(1)}` : c.name, provider: c.provider as DraftAccount["provider"] })),
    canEnable: mail.some((c) => !canDraft(c)),
  };
}

/**
 * Open the sheet. Either Athena writes it (a to-do, a person and what it's
 * about, or an Ask receipt's draft), or it's handed over already written:
 * `openDraftSheet({ to, channel, subject?, body })`.
 */
export function openDraftSheet(opts: DraftSheetOptions | ReadyDraft): void {
  const ready = isReady(opts) ? readyDraft(opts) : null;
  const o: DraftSheetOptions = ready ? { draft: ready.draft, person: ready.person } : (opts as DraftSheetOptions);
  const person = o.person ?? o.commitment?.person ?? null;
  const who = person?.name ?? ready?.name ?? o.draft?.to[0]?.name ?? "";
  /** One draft per channel, so switching back keeps your edits. */
  const drafts: Partial<Record<DraftChannel, MessageDraft>> = {};
  let channel: DraftChannel = o.draft?.channel ?? o.channel ?? "email";
  let draft: MessageDraft | null = o.draft ?? null;
  if (draft) drafts[channel] = draft;
  let failed: string | null = null;
  let busy = false;

  const root = h("div", { class: "draft" });
  const titleFor = (ch: DraftChannel) => (who ? `${NOUN[ch]} to ${firstName(who)}` : `${NOUN[ch]} draft`);
  const sheet = openSheet({ label: who ? `Message to ${who}` : "Message draft", title: titleFor(channel), body: root });

  const toInput = input("text", "", { placeholder: "Add an email address", autocomplete: "off", inputmode: "email", spellcheck: false });
  const phoneInput = input("tel", "", { placeholder: "Add their number", autocomplete: "off", inputmode: "tel" });
  const slackInput = input("text", "", { placeholder: "Their Slack member ID", autocomplete: "off", spellcheck: false });
  const subjectInput = input("text", "", { placeholder: "Subject", autocomplete: "off" });
  const bodyInput = autoTextarea("", { name: "body", "aria-label": "Message" }, 120);
  bodyInput.classList.add("draft__body");
  const paper = h("div", { class: "card draft__paper" }, bodyInput);
  const recipients = () => toInput.value.split(/[\s,;]+/).filter(Boolean);
  const words = () => bodyInput.value;

  /** The apps you use (Settings → Drafts), and whichever this one is on even if it's off. */
  const apps = () => {
    const on = draft?.enabled ?? o.draft?.enabled ?? draftChannels();
    return CHANNELS.filter((c) => on.includes(c) || c === channel);
  };
  let shown = "";
  let switcher = makeSwitcher();
  function makeSwitcher() {
    const list = apps();
    shown = list.join();
    const made = choiceChips<DraftChannel>("Send it by", list.map((c) => ({ value: c, label: LABEL[c] })), channel, (next) => void switchTo(next));
    // A segmented control, not chips: equal parts across the sheet.
    made.el.className = "seg draft__channels";
    for (const b of made.el.children) b.className = "seg__item";
    return made;
  }
  /** The switcher, rebuilt when the apps change; none when there's only one. */
  function channelRow(): HTMLElement | null {
    if (apps().join() !== shown) switcher = makeSwitcher();
    return apps().length > 1 ? switcher.el : null;
  }

  /** Whoever you're writing to, as you've typed it, kept across channels. */
  function fill(d: MessageDraft) {
    if (d.to.length || !toInput.value) toInput.value = d.to.map((t) => t.email).join(", ");
    if (d.phone && !phoneInput.value) phoneInput.value = d.phone;
    if (d.slack && !slackInput.value) slackInput.value = d.slack;
    subjectInput.value = d.subject;
    bodyInput.value = d.body;
    bodyInput.dispatchEvent(new Event("input"));
    // Once it's in Drafts, that copy is the one to edit.
    for (const el of [toInput, subjectInput, bodyInput]) el.readOnly = !!d.saved;
  }

  /** Keep what's on screen in this channel's draft before leaving it. */
  function keep() {
    if (!draft || draft.saved) return;
    draft.subject = subjectInput.value;
    draft.body = bodyInput.value;
  }

  async function compose(extra: { channel?: DraftChannel; instruction?: string; previous?: { subject: string; body: string; channel?: DraftChannel } } = {}): Promise<MessageDraft> {
    if (isSampleMode()) {
      await new Promise((r) => setTimeout(r, 900));
      return sampleDraft({ c: o.commitment, person, channel: extra.channel, instruction: extra.instruction, sample: o.sample });
    }
    return composeDraft({
      commitment_id: o.commitment?.id,
      person_id: o.commitment ? undefined : person?.id,
      recipient_name: person ? undefined : who || undefined,
      about: o.commitment ? undefined : o.about,
      ...extra,
    });
  }

  async function first() {
    failed = null;
    draft = null;
    paint();
    try {
      draft = await compose(o.channel ? { channel: o.channel } : {});
      channel = draft.channel;
      drafts[channel] = draft;
      switcher.set(channel);
      sheet.setTitle(titleFor(channel));
      fill(draft);
    } catch (error) {
      failed = errorText(error, "Couldn't write it");
    }
    paint();
  }

  /** Another channel: the draft you had there, or the same words rewritten for it. */
  async function switchTo(next: DraftChannel) {
    if (busy || next === channel) return switcher.set(channel);
    keep();
    const from = draft;
    const prevChannel = channel;
    channel = next;
    sheet.setTitle(titleFor(next));
    if (drafts[next]) {
      draft = drafts[next]!;
      fill(draft);
      paint();
      return;
    }
    if (!from) return void first();
    busy = true;
    paper.classList.add("is-busy");
    // Nothing to send yet on the new channel: its buttons wait for the words.
    draft = null;
    paintBusy(from, next);
    try {
      const made = await compose({ channel: next, previous: { subject: from.subject, body: from.body, channel: prevChannel } });
      draft = { ...made, to: made.to.length ? made.to : from.to, phone: made.phone ?? from.phone, slack: made.slack ?? from.slack };
      drafts[next] = draft;
      fill(draft);
    } catch (error) {
      showToast(errorText(error, `Couldn't write the ${NOUN[next].toLowerCase()}`), { icon: "close", timeoutMs: 5000 });
      channel = prevChannel;
      draft = from;
      switcher.set(prevChannel);
      sheet.setTitle(titleFor(prevChannel));
      fill(from);
    } finally {
      busy = false;
      paper.classList.remove("is-busy");
    }
    paint();
  }

  async function rewrite(instruction: string, chip?: HTMLElement) {
    if (!draft || busy) return;
    busy = true;
    paper.classList.add("is-busy");
    chip?.setAttribute("aria-busy", "true");
    try {
      const next = await compose({ channel, instruction, previous: { subject: subjectInput.value, body: bodyInput.value, channel } });
      // Your recipients and subject stand; the words are new.
      draft = { ...next, channel, to: draft.to, phone: draft.phone, slack: draft.slack, reply: draft.reply, subject: subjectInput.value || next.subject };
      drafts[channel] = draft;
      bodyInput.value = next.body;
      bodyInput.dispatchEvent(new Event("input"));
    } catch (error) {
      showToast(errorText(error, "Couldn't rewrite it"), { icon: "close", timeoutMs: 5000 });
    } finally {
      busy = false;
      paper.classList.remove("is-busy");
      chip?.removeAttribute("aria-busy");
    }
  }

  async function save(account: DraftAccount, btn: HTMLButtonElement) {
    if (!draft || busy) return;
    busy = true;
    btn.disabled = true;
    btn.replaceChildren(icons.mail(), "Saving…");
    const where = PROVIDER[account.provider];
    try {
      draft.saved = isSampleMode()
        ? { connector_id: account.id, account: account.label, url: null, provider: account.provider }
        : await saveDraftToMail({ connector_id: account.id, to: recipients(), subject: subjectInput.value, body: bodyInput.value, reply: draft.reply });
      draft.saved.provider ??= account.provider;
      draft.to = recipients().map((email) => ({ name: email, email }));
      draft.subject = subjectInput.value;
      draft.body = bodyInput.value;
      fill(draft);
      showToast(isSampleMode() ? "Sample mode: nothing was saved" : `Saved to ${where} Drafts`, { icon: "mail" });
    } catch (error) {
      showToast(errorText(error, `Couldn't save it to ${where}`), { icon: "close", timeoutMs: 6000 });
    } finally {
      busy = false;
    }
    paint();
  }

  async function copy(toast = "Copied") {
    try {
      await navigator.clipboard.writeText(words());
      showToast(toast, { icon: "check" });
    } catch {
      showToast("Couldn't copy it", { icon: "close" });
    }
  }

  function tweaks(): HTMLElement {
    const askInput = input("text", "", { placeholder: "What should change?", autocomplete: "off", "aria-label": "What should change?" });
    const ask = h("form", { class: "draft__ask", hidden: true }, askInput, h("button", { class: "btn btn--soft btn--sm", type: "submit" }, icons.refresh(), "Rewrite"));
    ask.addEventListener("submit", (e) => {
      e.preventDefault();
      const v = askInput.value.trim();
      if (!v) return askInput.focus();
      askInput.value = "";
      ask.hidden = true;
      void rewrite(v);
    });
    const chip = (label: string, run: (b: HTMLButtonElement) => void, icon?: SVGElement) => {
      const b = h("button", { class: "chip chip--sm", type: "button" }, icon ?? null, label) as HTMLButtonElement;
      b.addEventListener("click", () => run(b));
      return b;
    };
    return h(
      "div",
      { class: "draft__tweaks" },
      h(
        "div",
        { class: "chip-row chip-row--wrap", role: "group", "aria-label": "Rewrite it" },
        ...TWEAKS.map((t) => chip(t, (b) => void rewrite(t, b))),
        chip(
          "Something else",
          () => {
            ask.hidden = !ask.hidden;
            if (!ask.hidden) askInput.focus();
          },
          icons.pen()
        )
      ),
      ask
    );
  }

  const copyButton = () => {
    const b = h("button", { class: "btn btn--ghost", type: "button" }, icons.copy(), "Copy") as HTMLButtonElement;
    b.addEventListener("click", () => void copy());
    return b;
  };
  /** A link out, its address built on tap from what's on screen now. */
  const linkOut = (icon: SVGElement, label: string, build: () => string, opts: { primary?: boolean; newTab?: boolean; before?: () => void } = {}) => {
    const a = h("a", { class: `btn ${opts.primary === false ? "btn--soft" : "btn--primary"}`, href: build(), ...(opts.newTab ? { target: "_blank", rel: "noopener noreferrer" } : {}) }, icon, label) as HTMLAnchorElement;
    a.addEventListener("click", () => {
      opts.before?.();
      a.href = build();
    });
    return a;
  };

  function emailActions(d: MessageDraft): HTMLElement {
    if (d.saved) {
      const where = PROVIDER[d.saved.provider ?? "gmail"];
      const fallback = d.saved.provider === "outlook-mail" ? "https://outlook.office.com/mail/drafts" : d.saved.provider === "fastmail" ? "https://app.fastmail.com/mail/Drafts/" : "https://mail.google.com/mail/#drafts";
      const open = h("a", { class: "btn btn--primary", href: d.saved.url ?? fallback, target: "_blank", rel: "noopener noreferrer" }, icons.mail(), `Open in ${where}`);
      return h("div", { class: "draft__actions" }, copyButton(), open);
    }
    const mail = linkOut(icons.mail(), "Open in Mail", () => mailtoLink(recipients(), subjectInput.value, words()), { primary: !d.accounts.length });
    if (!d.accounts.length) return h("div", { class: "draft__actions" }, copyButton(), mail);
    const saveBtn = h("button", { class: "btn btn--primary", type: "button" }) as HTMLButtonElement;
    const label = (a: DraftAccount) => saveBtn.replaceChildren(icons.mail(), `Save to ${PROVIDER[a.provider]} Drafts`);
    const byId = (id: string) => d.accounts.find((a) => a.id === id) ?? d.accounts[0];
    const from = d.accounts.length > 1 ? choiceChips("From", d.accounts.map((a) => ({ value: a.id, label: a.label })), d.accounts[0].id, (id) => label(byId(id))) : null;
    label(d.accounts[0]);
    saveBtn.addEventListener("click", () => void save(byId(from?.value() ?? d.accounts[0].id), saveBtn));
    return h(
      "div",
      { class: "draft__out" },
      from ? h("div", { class: "draft__from" }, h("span", { class: "draft__from-label" }, "From"), from.el) : null,
      h("div", { class: "draft__actions" }, copyButton(), mail, saveBtn)
    );
  }

  function actions(d: MessageDraft): HTMLElement {
    switch (d.channel) {
      case "email":
        return emailActions(d);
      case "text":
        return h("div", { class: "draft__actions" }, copyButton(), linkOut(icons.chat(), "Open in Messages", () => smsLink(phoneInput.value, words(), country())));
      case "whatsapp":
        return h("div", { class: "draft__actions" }, copyButton(), linkOut(icons.chat(), "Open WhatsApp", () => whatsappLink(phoneInput.value, words(), country()), { newTab: true }));
      case "telegram":
        return h("div", { class: "draft__actions" }, copyButton(), linkOut(icons.send(), "Open Telegram", () => telegramLink(words()), { newTab: true }));
      case "slack": {
        // Slack links can't carry the words, so they're copied on the way.
        const dm = () => slackDmLink(slackInput.value);
        return h("div", { class: "draft__actions" }, copyButton(), linkOut(icons.chat(), "Open Slack", () => dm() ?? SLACK_OPEN, { before: () => void copy("Copied. Paste it in Slack") }));
      }
    }
  }

  /** Who it's to, per channel: addresses, a number, a Slack member. */
  function recipientFields(ch: DraftChannel): HTMLElement | null {
    // Telegram's share picker chooses the chat.
    if (ch === "telegram") return null;
    if (ch === "email") return h("div", { class: "card card--flush fields" }, field("To", toInput), field("Subject", subjectInput));
    if (ch === "slack") return h("div", { class: "card card--flush fields" }, field("To", slackInput));
    return h("div", { class: "card card--flush fields" }, field("To", phoneInput));
  }

  function note(d: MessageDraft): HTMLElement | null {
    if (d.saved) return null;
    if (d.channel === "email") {
      const enable = () => {
        const link = h("a", { href: "#/settings/accounts" }, "Turn on drafts for Gmail or Outlook");
        link.addEventListener("click", () => sheet.close());
        return h("span", {}, link, " to save straight into your Drafts.");
      };
      return h("p", { class: "draft__note" }, "Athena never sends email. ", !d.accounts.length && d.can_enable_drafts ? enable() : "You check it and send it yourself.");
    }
    const tail =
      d.channel === "slack" && !slackDmLink(slackInput.value) ? " Add their member ID to open the chat with them." : d.channel === "telegram" ? " You pick the chat there." : "";
    return h("p", { class: "draft__note" }, `Athena never sends. You press Send in ${APP[d.channel]}.${tail}`);
  }

  /** Writing it for another channel: the old words stay, faded, under the new fields. */
  function paintBusy(from: MessageDraft, next: DraftChannel) {
    const caption = h("p", { class: "draft__caption", role: "status" }, icons.sparkle(), `Writing it as ${A_NOUN[next]}…`);
    bodyInput.value = from.body;
    root.replaceChildren(...[channelRow(), recipientFields(next), paper, caption].filter((x): x is HTMLElement => !!x));
  }

  function paint() {
    if (failed) {
      const retry = h("button", { class: "btn btn--soft", type: "button" }, icons.refresh(), "Try again");
      retry.addEventListener("click", () => void first());
      root.replaceChildren(h("div", { class: "card empty empty--compact" }, h("p", { class: "empty__title" }, "Athena couldn't write it"), h("p", { class: "empty__sub" }, failed), retry));
      return;
    }
    if (!draft) {
      const caption = h("span", {}, "Writing it from your notes…");
      setTimeout(() => (caption.textContent = "Still writing…"), 8000);
      root.replaceChildren(
        h(
          "div",
          { class: "draft__loading", role: "status" },
          h("div", { class: "card draft__paper" }, ...[92, 100, 84, 96, 40].map((w) => h("span", { class: "skeleton draft__line", style: `width:${w}%` }))),
          h("p", { class: "draft__caption" }, icons.sparkle(), caption)
        )
      );
      return;
    }
    const d = draft;
    const parts: Array<HTMLElement | null> = [
      d.saved ? null : channelRow(),
      d.flagged
        ? h(
            "div",
            { class: "conn-callout" },
            h("span", { class: "conn-callout__icon" }, icons.shield()),
            h(
              "div",
              { class: "conn-callout__body" },
              h("p", { class: "conn-callout__title" }, "Read this one carefully"),
              h("p", { class: "conn-callout__sub" }, "The email it answers looked like it was trying to give Athena instructions.")
            )
          )
        : null,
      recipientFields(d.channel),
      paper,
      d.saved ? h("p", { class: "draft__saved" }, icons.check(), `In your ${PROVIDER[d.saved.provider ?? "gmail"]} Drafts. Check it there and send it when you're ready.`) : tweaks(),
      actions(d),
      note(d),
    ];
    root.replaceChildren(...parts.filter((p): p is HTMLElement => !!p));
    // Its height can only be measured once it's on the page.
    requestAnimationFrame(() => bodyInput.dispatchEvent(new Event("input")));
  }

  if (draft) fill(draft);
  paint();
  if (!draft) void first();
  // A ready-written email learns which accounts it can be saved to.
  if (ready) {
    void readyAccounts()
      .then(({ accounts, canEnable }) => {
        ready.draft.accounts = accounts;
        ready.draft.can_enable_drafts = canEnable;
        if (draft === ready.draft) paint();
      })
      .catch(() => undefined);
  }
}
