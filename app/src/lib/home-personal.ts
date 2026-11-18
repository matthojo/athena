/**
 * Home's personal half and Ask's examples, from the owner's profile and what
 * Athena has seen: who matters (a birthday soon, the last time you saw them
 * and where), one line on a goal from "This year's goals", and questions
 * built from the owner's own people and days. Pure and DOM-free, so it runs
 * under `npx tsx --test`. Loading lives in components/home-personal.ts.
 */

import { parsePeople, splitLines } from "./profile-catalogue";
import { placeWithArticle } from "../../../lib/day-words";

// ---------- dates ("YYYY-MM-DD", no time zones) ----------

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const DAY = 86_400_000;

const utc = (date: string) => Date.UTC(Number(date.slice(0, 4)), Number(date.slice(5, 7)) - 1, Number(date.slice(8, 10)));
const iso = (t: number) => new Date(t).toISOString().slice(0, 10);
export const addDays = (date: string, n: number) => iso(utc(date) + n * DAY);
export const daysBetween = (from: string, to: string) => Math.round((utc(to) - utc(from)) / DAY);
const weekday = (date: string) => WEEKDAYS[new Date(utc(date)).getUTCDay()];

/** "today", "yesterday", "on Wednesday" (this past week), "on 12 October", "on 12 October 2025". */
export function whenPast(date: string, today: string): string {
  const ago = daysBetween(date, today);
  if (ago <= 0) return "today";
  if (ago === 1) return "yesterday";
  if (ago < 7) return `on ${weekday(date)}`;
  const day = `${Number(date.slice(8, 10))} ${MONTHS[Number(date.slice(5, 7)) - 1]}`;
  return `on ${date.slice(0, 4) === today.slice(0, 4) ? day : `${day} ${date.slice(0, 4)}`}`;
}

/** Days until the next birthday from "YYYY-MM-DD" or "--MM-DD"; 29 February falls on the 28th in other years. null when unreadable. */
export function daysToBirthday(birthday: string | null | undefined, today: string): number | null {
  const m = /^(?:\d{4}|--)-?(\d{2})-(\d{2})$/.exec(birthday?.trim() ?? "");
  if (!m) return null;
  const on = (year: number) => {
    const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
    const md = m[1] === "02" && m[2] === "29" && !leap ? "02-28" : `${m[1]}-${m[2]}`;
    return `${year}-${md}`;
  };
  const year = Number(today.slice(0, 4));
  const next = on(year) >= today ? on(year) : on(year + 1);
  return daysBetween(today, next);
}

// ---------- the owner ----------

export interface OwnerFact {
  key: string;
  value: string;
}

/** The current value of a profile key, matched without case. */
export function profileValue(facts: OwnerFact[], key: string): string | null {
  const k = key.toLowerCase();
  const v = facts.find((f) => f.key.trim().toLowerCase() === k)?.value.trim();
  return v || null;
}

/** What the owner asked to be called, tidied; null without one. */
export function ownerName(facts: OwnerFact[]): string | null {
  const v = profileValue(facts, "Name")?.replace(/\s+/g, " ");
  return v && v.length <= 40 ? v : null;
}

/** "Mum", "Priya" from "Priya Shah", "Elena" from "Dr. Elena Osei". */
export function firstName(name: string): string {
  const n = name.trim();
  return /^(Mum|Dad|Mom|Mam|Gran|Grandma|Grandad|Nan)$/i.test(n) ? n : n.replace(/^(Dr|Mr|Mrs|Ms|Mx)\.?\s+/i, "").split(/\s+/)[0] ?? n;
}

/** The important people from the profile, in the owner's order: linked people with their id, typed names with none. */
export function importantPeople(facts: OwnerFact[]): Array<{ id: string | null; name: string }> {
  const v = profileValue(facts, "Important people");
  if (!v) return [];
  const seen = new Set<string>();
  return parsePeople(v)
    .map((p) => ({ id: p.id || null, name: p.name }))
    .filter((p) => p.name && !seen.has(p.id ?? p.name.toLowerCase()) && seen.add(p.id ?? p.name.toLowerCase()));
}

// ---------- when you last saw them ----------

/** A catch-up: a logged interaction (sample mode adds how and where) or a calendar event with them at a place. */
export interface SeenItem {
  date: string;
  people: Array<{ id: string; name: string }>;
  inPerson: boolean;
  /** "Lunch", "Video call", "Gallery". */
  how?: string;
  where?: string;
  summary?: string;
}

export interface LastSeen {
  date: string;
  inPerson: boolean;
  how?: string;
  where?: string;
  summary?: string;
}

/** Each person's latest time seen in person, else their latest call or catch-up, by id. */
export function lastSeenBy(items: SeenItem[]): Map<string, LastSeen> {
  const out = new Map<string, LastSeen>();
  const sorted = [...items].sort((a, b) => b.date.localeCompare(a.date));
  for (const s of sorted) {
    for (const p of s.people) {
      const prev = out.get(p.id);
      const next: LastSeen = { date: s.date, inPerson: s.inPerson, how: s.how, where: s.where, summary: s.summary };
      if (!prev || (s.inPerson && !prev.inPerson)) out.set(p.id, next);
      // Same day, same kind: keep the one that says where.
      else if (prev.date === s.date && prev.inPerson === s.inPerson && !prev.where && s.where) out.set(p.id, next);
    }
  }
  return out;
}

// ---------- your people ----------

export interface PersonNote {
  id: string | null;
  /** The name as the chip shows it. */
  name: string;
  /** The sentence around the chip: `${before}[name]${after}`. */
  before: string;
  after: string;
  /** A second, quieter line. */
  sub: string | null;
  /** A birthday within the week: the row gets the gift tile. */
  birthdaySoon: boolean;
  /** Days to their next birthday; null when it isn't known. */
  birthdayIn?: number | null;
}

/** "is today", "is tomorrow", "is on Friday", "is in 10 days". */
function birthdayPhrase(days: number, today: string): string {
  if (days === 0) return "is today";
  if (days === 1) return "is tomorrow";
  if (days < 7) return `is on ${weekday(addDays(today, days))}`;
  return `is in ${days} days`;
}

/** "Lunch at Dishoom, on Wednesday" / "A call, 12 October" for the quieter line. */
function seenShort(s: LastSeen, today: string): string {
  const when = whenPast(s.date, today).replace(/^on /, "");
  const what = s.how && !/^(In person|Caught up)$/i.test(s.how) ? s.how : s.inPerson ? "Saw them" : "Spoke";
  if (/^Saw them$/.test(what)) return s.where ? `Last seen at ${placeWithArticle(s.where)}, ${when}` : `Last seen ${when}`;
  if (/^Spoke$/.test(what)) return `Last spoke ${when}`;
  return `${what}${s.where ? ` at ${placeWithArticle(s.where)}` : ""}, ${when}`;
}

/**
 * Who gets a row in Home's Your people: the people who matter most whose
 * record has "Keep in touch" on. Family you see every day (keep in touch off)
 * would only ever read "Nothing logged with …", so they stay out; a name
 * with no record can't have it on either.
 */
export function keepingInTouch<T extends { id: string | null }>(people: T[], records: Array<{ id: string; keep_in_touch?: boolean | null }>): T[] {
  const on = new Set(records.filter((r) => r.keep_in_touch).map((r) => r.id));
  return people.filter((p) => p.id !== null && on.has(p.id));
}

/** At most this many days ahead counts as a birthday "soon" on Home. */
export const BIRTHDAY_SOON = 30;

/**
 * One row per important person. The sentence leads with a birthday in the
 * next month, else the last time you saw them ("You last saw Priya on
 * Wednesday, at Dishoom."). The quieter line has the other one.
 */
export function personNotes(
  people: Array<{ id: string | null; name: string }>,
  ctx: { today: string; birthdays: Map<string, string | null | undefined>; seen: Map<string, LastSeen> }
): PersonNote[] {
  const firsts = new Map<string, number>();
  for (const p of people) firsts.set(firstName(p.name), (firsts.get(firstName(p.name)) ?? 0) + 1);
  return people.map((p) => {
    const name = firsts.get(firstName(p.name)) === 1 ? firstName(p.name) : p.name;
    const days = p.id ? daysToBirthday(ctx.birthdays.get(p.id), ctx.today) : null;
    const seen = p.id ? ctx.seen.get(p.id) : undefined;
    const soon = days !== null && days <= BIRTHDAY_SOON;
    if (soon) {
      return { id: p.id, name, before: "", after: `'s birthday ${birthdayPhrase(days, ctx.today)}.`, sub: seen ? seenShort(seen, ctx.today) : null, birthdaySoon: days < 7, birthdayIn: days };
    }
    const later = days !== null && days <= 90 ? `Birthday in ${Math.round(days / 7)} weeks` : null;
    if (seen) {
      const when = whenPast(seen.date, ctx.today);
      const at = seen.where ? `, at ${placeWithArticle(seen.where)}` : "";
      return seen.inPerson
        ? { id: p.id, name, before: "You last saw ", after: ` ${when}${at}.`, sub: later, birthdaySoon: false }
        : { id: p.id, name, before: "You last spoke to ", after: ` ${when}.`, sub: later, birthdaySoon: false };
    }
    return { id: p.id, name, before: "Nothing logged with ", after: " yet.", sub: later ?? "A catch-up you log shows here", birthdaySoon: false };
  });
}

// ---------- a goal ----------

export interface GoalRecord {
  title: string;
  progress: number;
  status: string;
}

export interface GoalLine {
  title: string;
  text: string;
  /** 0 to 1 for the bar; null when there's nothing to measure. */
  ratio: number | null;
}

const NUMBERS: Record<string, number> = { a: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, ten: 10, twelve: 12, "a dozen": 12, twenty: 20 };
const num = (s: string) => (/^\d+$/.test(s) ? Number(s) : NUMBERS[s.toLowerCase()] ?? null);
const words = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, " ").split(/\s+/).filter((w) => w.length > 2 && !["the", "and", "for", "this", "year", "every"].includes(w));
const km = (n: number) => (Math.round(n * 10) / 10).toFixed(1).replace(/\.0$/, "");

/** The goals typed in the profile, one per line. */
export const profileGoals = (facts: OwnerFact[]) => splitLines(profileValue(facts, "Goals this year") ?? "");

/** What a goal asks for that Athena can measure: a distance to run, or a number of books. */
export function goalMeasure(goal: string): { kind: "run"; km: number } | { kind: "books"; count: number } | null {
  const g = goal.toLowerCase();
  if (/\bhalf[- ]marathon\b/.test(g)) return { kind: "run", km: 21.1 };
  if (/\bmarathon\b/.test(g)) return { kind: "run", km: 42.2 };
  const run = /\brun (?:a )?(\d+(?:\.\d+)?) ?k(?:m)?\b/.exec(g);
  if (run) return { kind: "run", km: Number(run[1]) };
  const books = /\bread (\d+|a dozen|[a-z]+) books?\b/.exec(g);
  const count = books ? num(books[1]) : null;
  if (count) return { kind: "books", count };
  return null;
}

/**
 * One line on the first profile goal Athena can say something about: the
 * longest run lately against a race distance, books finished this year, or
 * a goal in Goals with the same name. Without any, the first goal as it is.
 */
export function goalLine(goals: string[], ctx: { longestRunKm: number | null; booksThisYear: number | null; records: GoalRecord[] }): GoalLine | null {
  for (const title of goals) {
    const m = goalMeasure(title);
    if (m?.kind === "run" && ctx.longestRunKm) {
      return { title, text: `Longest run lately: ${km(ctx.longestRunKm)} km of ${km(m.km)} km`, ratio: Math.min(1, ctx.longestRunKm / m.km) };
    }
    if (m?.kind === "books" && ctx.booksThisYear !== null) {
      return { title, text: `${ctx.booksThisYear} of ${m.count} books so far this year`, ratio: Math.min(1, ctx.booksThisYear / m.count) };
    }
    // The same goal in Goals: the same name, or every word of one in the other ("Learn to cook five Sichuan dishes", "Cook five Sichuan dishes").
    const want = words(title);
    const within = (a: string[], b: string[]) => a.length >= 2 && a.every((w) => b.includes(w));
    const rec = ctx.records.find((r) => {
      const have = words(r.title);
      return r.status !== "dropped" && (r.title.trim().toLowerCase() === title.trim().toLowerCase() || within(want, have) || within(have, want));
    });
    if (rec) return { title, text: rec.status === "done" ? "Done" : `${Math.round(rec.progress)}% of the way`, ratio: Math.min(1, Math.max(0, rec.progress / 100)) };
  }
  return goals.length ? { title: goals[0], text: "One of this year's goals", ratio: null } : null;
}

// ---------- Ask's examples ----------

const NOT_TOPICS = new Set([...WEEKDAYS, ...MONTHS, "I", "I'm", "I'd", "I'll", "She", "He", "They", "She's", "He's", "They're", "We", "The", "A", "An", "It", "It's"]);

/** A thing worth asking about in a catch-up's summary: "the Northwind offer", else a name in it. null without one. */
export function topicOf(summary: string | undefined, names: string[] = []): string | null {
  if (!summary) return null;
  const skip = new Set([...names.flatMap((n) => n.split(/\s+/)), ...NOT_TOPICS]);
  const the = /\bthe ((?:[A-Z][\p{L}'’-]+ ?)+) ([a-z]{3,})\b/u.exec(summary);
  if (the && !the[1].trim().split(/\s+/).some((w) => skip.has(w))) return `the ${the[1].trim()} ${the[2]}`;
  // A capitalised word that doesn't start a sentence.
  for (const m of summary.matchAll(/(?<![.!?]\s|^)\b([A-Z][\p{L}'’-]{2,})/gu)) if (!skip.has(m[1])) return m[1];
  return null;
}

export interface AskPerson {
  name: string;
  /** From their latest catch-up's summary. */
  topic?: string | null;
  birthdayIn?: number | null;
}

/**
 * Up to four examples for Ask's empty state, in the owner's own terms: what
 * someone said, when you last saw someone, a recent day, and one thing to do
 * with a real person ("Remind me to get something for Mum's birthday").
 * `fixed` are questions with a written answer (sample mode); they fill in
 * after the owner's people.
 */
export function askExamples(input: { people: AskPerson[]; place?: string | null; fixed?: string[] }): { questions: string[]; instruction: string } {
  const people = input.people.filter((p) => p.name);
  const questions: string[] = [];
  const said = people.find((p) => p.topic);
  if (said) questions.push(`What did ${firstName(said.name)} say about ${said.topic}?`);
  questions.push(...(input.fixed ?? []));
  const other = people.find((p) => p !== said);
  if (other && questions.length < 2) questions.push(`When did I last see ${firstName(other.name)}?`);
  if (input.place && questions.length < 3) questions.push(`When was I last at ${input.place}?`);
  if (!input.fixed?.length) questions.push("What did I get up to last weekend?");

  const birthday = people.filter((p) => p.birthdayIn != null && p.birthdayIn <= BIRTHDAY_SOON).sort((a, b) => a.birthdayIn! - b.birthdayIn!)[0];
  const someone = birthday ?? people.find((p) => p !== said) ?? people[0];
  const instruction = birthday
    ? `Remind me to get something for ${firstName(birthday.name)}'s birthday`
    : someone
      ? `Remind me to ring ${firstName(someone.name)} on Sunday`
      : "Remind me to book the dentist next week";
  return { questions: [...new Set(questions)].slice(0, 3), instruction };
}

// ---------- thinking of them (a birthday sheet, and "again") ----------

/** A pronoun the owner recorded for someone (a fact "Pronouns: she/her"); null when they haven't. */
export interface Pronoun {
  /** "She", "He", "They". */
  subject: string;
  /** "her", "him", "them". */
  object: string;
}

const PRONOUNS: Record<string, Pronoun> = {
  she: { subject: "She", object: "her" },
  he: { subject: "He", object: "him" },
  they: { subject: "They", object: "them" },
};

/** From facts about the person: a "Pronouns" (or "Pronoun") fact that starts with she, he or they. */
export function recordedPronoun(facts: Array<{ key: string; value: string }>): Pronoun | null {
  const v = facts.find((f) => /^pronouns?$/i.test(f.key.trim()))?.value.trim().toLowerCase() ?? "";
  const m = /^(she|he|they)\b/.exec(v);
  return m ? PRONOUNS[m[1]] : null;
}

/** Catch-ups that read as a thing you did together: "lunch at Dishoom", "Third lunch with Priya". */
const TOGETHER = new Set(["lunch", "dinner", "breakfast", "brunch", "coffee", "drinks", "tea", "walk", "run", "swim"]);
const ORDINALS = ["", "", "Second", "Third", "Fourth", "Fifth", "Sixth", "Seventh", "Eighth", "Ninth", "Tenth"];

/** A catch-up is fresh enough for "again" for this many days. */
export const AGAIN_DAYS = 14;

const together = (how: string | undefined) => (how && TOGETHER.has(how.trim().toLowerCase()) ? how.trim().toLowerCase() : null);
const same = (a: string | undefined, b: string | undefined) => !!a && !!b && a.trim().toLowerCase() === b.trim().toLowerCase();

/** "A, B and C", or "A, B and 2 more" past three. */
function listOf(items: string[]): string {
  if (items.length <= 1) return items[0] ?? "";
  if (items.length > 3) return `${items.slice(0, 2).join(", ")} and ${items.length - 2} more`;
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

/**
 * The sentence in a catch-up's summary that holds its topic, about them:
 * "She's weighing the Northwind offer." It uses the pronoun the owner
 * recorded, else their name, and is cut after the topic when the sentence
 * runs on ("… and wants a second read"). When the sentence can't be put
 * that way, "You talked about the Northwind offer."
 */
export function topicSentence(summary: string, topic: string, name: string, pronoun: Pronoun | null): string {
  const sentence = summary.split(/(?<=[.!?])\s+/).find((s) => s.includes(topic));
  const fallback = `You talked about ${topic}.`;
  if (!sentence) return fallback;
  const at = sentence.indexOf(topic) + topic.length;
  const rest = sentence.slice(at);
  let s = /^(\s+(and|but|so)\b|,|;)/.test(rest) ? `${sentence.slice(0, at)}.` : /[.!?]$/.test(sentence) ? sentence : `${sentence}.`;
  const m = /^(She|He|They)(?:['’](s|re|ve|d|ll))?\b/.exec(s);
  if (!m) return s;
  const singular = pronoun && pronoun.subject !== "They" ? pronoun.subject : name;
  const tail = s.slice(m[0].length);
  if (m[1] === "They") {
    if (pronoun?.subject === "They") return s;
    // "They're weighing" → "Priya's weighing"; anything else would need its verb changed.
    if (m[2] === "re" || m[2] === "ve") s = `${singular}'s${tail}`;
    else return fallback;
  } else if (!m[2]) s = `${singular}${tail}`;
  else if (m[2] === "s") s = `${singular}'s${tail}`;
  else return fallback;
  return s;
}

export interface MomentPerson {
  id: string;
  name: string;
  /** "YYYY-MM-DD", or "--MM-DD" without a year. */
  birthday?: string | null;
}

export interface MomentCtx {
  today: string;
  /** Catch-ups (any people; only theirs are read). */
  seen: SeenItem[];
  /** Facts the owner wrote or accepted about them, newest first. */
  facts: Array<{ key: string; value: string }>;
  /** Unticked lines on their gift ideas lists. */
  gifts: string[];
  /** Other people's names, so a topic isn't someone's name. */
  names?: string[];
}

export interface PersonMoment {
  /** "Priya". */
  name: string;
  pronoun: Pronoun | null;
  birthday: { days: number; date: string; years: number | null; line: string } | null;
  /** "Last time: lunch at Dishoom on Monday. She's weighing the Northwind offer." */
  lastTime: string | null;
  /** "Gift ideas you saved: Château Musar 2017." */
  giftLine: string | null;
  gifts: string[];
  /** One thing the owner knows about them. */
  fact: { key: string; value: string } | null;
  /** "Third lunch with Priya at Dishoom this year." */
  again: string | null;
  /** The day before the birthday, for "Remind me Wednesday"; null on the day. */
  remind: { on: string; label: string; title: string } | null;
  /** "Write to her", "Write to Priya". */
  write: string;
}

/** "Priya turns 35 on Thursday." / "It's Priya's birthday tomorrow." */
function birthdayLine(name: string, days: number, years: number | null, today: string): string {
  const when = days === 0 ? "today" : days === 1 ? "tomorrow" : days === 7 ? "a week today" : `on ${weekday(addDays(today, days))}`;
  return years ? `${name} turns ${years} ${when}.` : `It's ${name}'s birthday ${when}.`;
}

/** "Last time: lunch at Dishoom on Monday." and what it was about. */
function lastTimeLine(s: LastSeen, name: string, pronoun: Pronoun | null, topic: string | null, today: string): string {
  const when = whenPast(s.date, today);
  const them = pronoun?.object ?? name;
  const what = together(s.how);
  const how = s.how?.trim().toLowerCase() ?? "";
  const line = what
    ? `Last time: ${what}${s.where ? ` at ${placeWithArticle(s.where)}` : ""} ${when}.`
    : !s.inPerson && /call$/.test(how)
      ? `Last time: a ${how} ${when}.`
      : s.inPerson
        ? `Last time: you saw ${them}${s.where ? ` at ${placeWithArticle(s.where)}` : ""} ${when}.`
        : `Last time: you spoke ${when}.`;
  return topic && s.summary ? `${line} ${topicSentence(s.summary, topic, name, pronoun)}` : line;
}

/**
 * What the owner might want in mind when thinking of someone: their
 * birthday, the last time you saw them and what it was about, gift ideas
 * saved for them, one thing you know, and an "again" line when the latest
 * catch-up repeats one from earlier this year ("Third lunch with Priya at
 * Dishoom this year."). Counts come only from the owner's own catch-ups.
 */
export function personMoment(person: MomentPerson, ctx: MomentCtx): PersonMoment {
  const name = firstName(person.name);
  const pronoun = recordedPronoun(ctx.facts);
  const mine = ctx.seen.filter((s) => s.date <= ctx.today && s.people.some((p) => p.id === person.id));

  const days = daysToBirthday(person.birthday, ctx.today);
  let birthday: PersonMoment["birthday"] = null;
  if (days !== null) {
    const date = addDays(ctx.today, days);
    const born = /^\d{4}/.test(person.birthday ?? "") ? Number(person.birthday!.slice(0, 4)) : null;
    const years = born ? Number(date.slice(0, 4)) - born : null;
    birthday = { days, date, years: years && years > 0 && years < 130 ? years : null, line: birthdayLine(name, days, years && years > 0 && years < 130 ? years : null, ctx.today) };
  }

  const last = lastSeenBy(mine).get(person.id);
  const topic = last?.summary ? topicOf(last.summary, [person.name, ...(ctx.names ?? [])]) : null;
  const lastTime = last ? lastTimeLine(last, name, pronoun, topic, ctx.today) : null;

  // "Again": the latest catch-up, if it was something you do together at a place, and how often this year.
  let again: string | null = null;
  const latest = [...mine].sort((a, b) => b.date.localeCompare(a.date))[0];
  const what = together(latest?.how);
  if (latest && what && latest.where && daysBetween(latest.date, ctx.today) <= AGAIN_DAYS) {
    const year = ctx.today.slice(0, 4);
    const times = new Set(mine.filter((s) => s.date.startsWith(year) && s.inPerson === latest.inPerson && same(s.how, latest.how) && same(s.where, latest.where)).map((s) => s.date));
    const ordinal = ORDINALS[times.size];
    if (ordinal) again = `${ordinal} ${what} with ${name} at ${placeWithArticle(latest.where)} this year.`;
  }

  const gifts = [...new Set(ctx.gifts.map((g) => g.trim()).filter(Boolean))];
  const fact = ctx.facts.find((f) => !/^(pronouns?|birthday|name)$/i.test(f.key.trim()) && f.value.trim()) ?? null;

  let remind: PersonMoment["remind"] = null;
  if (days !== null && days >= 1) {
    const on = addDays(ctx.today, days - 1);
    const label = days === 1 ? "Remind me today" : days === 2 ? "Remind me tomorrow" : `Remind me ${weekday(on)}`;
    remind = { on, label, title: `Get something for ${name}'s birthday` };
  }

  return {
    name,
    pronoun,
    birthday,
    lastTime,
    giftLine: gifts.length ? `Gift ideas you saved: ${listOf(gifts)}.` : null,
    gifts,
    fact: fact ? { key: fact.key.trim(), value: fact.value.trim() } : null,
    again,
    remind,
    write: `Write to ${pronoun?.object ?? name}`,
  };
}

/** The open lines on someone's gift ideas lists: notes about them (a link to them) with "gift" in the title. Ticked lines were given. */
export function giftIdeas(notes: Array<{ title: string; body: string; archived_at?: string | null }>, personId: string): string[] {
  const out: string[] = [];
  for (const n of notes) {
    if (n.archived_at || !/gift/i.test(n.title) || !n.body.includes(`athena://person/${personId}`)) continue;
    for (const line of n.body.split("\n")) {
      const m = /^\s*[-*] \[ \] (.+)$/.exec(line);
      if (!m) continue;
      const text = m[1].replace(/\[([^\]]*)\]\([^)]*\)/g, "$1").replace(/[*_`~]/g, "").replace(/\s+/g, " ").trim();
      if (text) out.push(text);
    }
  }
  return [...new Set(out)];
}

/** Whose birthday it is today, among the people Athena may mention: the ones who matter most, or you keep in touch with. */
export function birthdaysToday<P extends { id: string; name: string; birthday?: string | null; keep_in_touch?: boolean }>(
  people: P[],
  important: Set<string>,
  today: string
): P[] {
  return people.filter((p) => (important.has(p.id) || p.keep_in_touch) && daysToBirthday(p.birthday, today) === 0);
}
