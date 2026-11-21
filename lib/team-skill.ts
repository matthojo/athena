/**
 * An assistant's own skill (docs/team.md, "Skills"): the SKILL.md Athena
 * writes for one Team assistant from its job, its instructions and the
 * owner's answers to a few setup questions. Pure and shared with the app:
 * the question and answer shapes, fitting a model's questions and skill to
 * the limits, the plain skill Athena writes when the model can't help, and
 * the fingerprints that tell whether the skill still matches the job, or the
 * owner has edited it. The model calls and saving are lib/team-skill-make.ts.
 */
import { checkDoc, descriptionProblem, nameProblem, SKILL_LIMITS, slugName, type SkillDoc } from "./skills";

export const MIN_QUESTIONS = 2;
export const MAX_QUESTIONS = 4;
export const MIN_CHOICES = 2;
export const MAX_CHOICES = 5;
export const MAX_QUESTION = 120;
export const MAX_CHOICE = 60;
export const MAX_ANSWER = 300;
export const MAX_SUMMARY = 400;

/** One setup question: tap a choice, or write something else. */
export interface TeamQuestion {
  id: string;
  question: string;
  choices: string[];
  allowOther: boolean;
}

/** What the owner answered: the question as asked, and their answer in their words. */
export interface TeamAnswer {
  question: string;
  answer: string;
}

/** Kept with the skill: what it was made from, so Athena can tell when the job has moved on or the owner has edited it. */
export interface TeamSkillMeta {
  /** skillBasis() of the job and instructions it matches. */
  basis: string;
  /** hashText() of the body as Athena wrote it. */
  made: string;
  /** One or two plain sentences for the assistant's page. */
  summary: string;
  answers: TeamAnswer[];
}

/** A skill Athena wrote (or would write), before it's saved. */
export interface TeamSkillDraft extends SkillDoc {
  summary: string;
}

const oneLine = (s: string) => s.replace(/\s+/g, " ").trim();
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s);

// ---------- questions ----------

/** The model's questions, made to fit: 2–4 of them, 2–5 short choices each, no repeats. Fewer than 2 good ones: none. Pure. */
// "Which shops should the assistant check?" → "Which shops should I check?": setup questions come from the assistant itself.
const ITSELF = /\b(should|can|could|will|would|must|shall|do|does|may)\s+(?:the|your|this)\s+assistant\b/gi;
const ITSELF_ELSE = /\b(?:the|your|this)\s+assistant\b/gi;

/** A question in the assistant's own voice: "the assistant" becomes "I" or "me". Pure. */
export function firstPerson(question: string): string {
  // Already the owner's "I" ("What should I tell the assistant?"): left as written.
  if (/\b(?:I|me|my)\b/.test(question)) return question;
  return question
    .replace(ITSELF, (_m, verb: string) => `${/^does$/i.test(verb) ? (verb[0] === "D" ? "Do" : "do") : verb} I`)
    .replace(/^(?:the|your|this)\s+assistant\b/i, "I")
    .replace(ITSELF_ELSE, "me");
}

export function fitQuestions(raw: unknown): TeamQuestion[] {
  const list = Array.isArray(raw) ? raw : [];
  const out: TeamQuestion[] = [];
  for (const q of list) {
    if (!q || typeof q !== "object") continue;
    const r = q as Record<string, unknown>;
    const question = typeof r.question === "string" ? firstPerson(oneLine(r.question)) : "";
    if (question.length < 5 || question.length > MAX_QUESTION || /<[^>]*>/.test(question)) continue;
    if (out.some((x) => x.question.toLowerCase() === question.toLowerCase())) continue;
    const choices = [...new Set((Array.isArray(r.choices) ? r.choices : []).filter((c): c is string => typeof c === "string").map(oneLine).filter((c) => c && c.length <= MAX_CHOICE && !/<[^>]*>/.test(c)))].slice(0, MAX_CHOICES);
    if (choices.length < MIN_CHOICES) continue;
    out.push({ id: `q${out.length + 1}`, question, choices, allowOther: r.allowOther !== false });
    if (out.length === MAX_QUESTIONS) break;
  }
  return out.length >= MIN_QUESTIONS ? out : [];
}

/** Answers as the app sends them: trimmed, cut to size, empty ones dropped, at most MAX_QUESTIONS. Pure. */
export function fitAnswers(raw: unknown): TeamAnswer[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((a) => ({ question: oneLine(String((a as TeamAnswer)?.question ?? "")).slice(0, MAX_QUESTION), answer: oneLine(String((a as TeamAnswer)?.answer ?? "")).slice(0, MAX_ANSWER) }))
    .filter((a) => a.question && a.answer)
    .slice(0, MAX_QUESTIONS);
}

// ---------- fingerprints ----------

/** A short fingerprint of some text (FNV-1a, 32-bit, hex). Not for secrets: only "has this changed?". Pure. */
export function hashText(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

/** What a skill is written from, as a fingerprint: the job and instructions, spacing ignored. Pure. */
export function skillBasis(a: { job: string; instructions: string }): string {
  return hashText(`${oneLine(a.job)}\n${oneLine(a.instructions)}`);
}

/** The job or instructions have changed since the skill was written (or last kept). Pure. */
export function skillStale(meta: Pick<TeamSkillMeta, "basis"> | null | undefined, a: { job: string; instructions: string }): boolean {
  return !!meta && meta.basis !== skillBasis(a);
}

/** The owner has changed the skill's instructions since Athena wrote them. Pure. */
export function skillEdited(meta: Pick<TeamSkillMeta, "made"> | null | undefined, body: string): boolean {
  return !!meta && meta.made !== hashText(body.trim());
}

// ---------- the skill ----------

/** "Penny" + "Finds good prices for gift ideas" → "penny-finds-good-prices-for-gift-ideas", within the name rules. Pure. */
export function assistantSkillName(name: string, job: string): string {
  const both = slugName(`${name} ${job}`);
  const cut = both.length > 48 ? both.slice(0, 48).replace(/-[^-]*$/, "") : both;
  if (cut && !nameProblem(cut)) return cut;
  const own = slugName(name);
  return own && !nameProblem(`${own}-skill`) ? `${own}-skill` : "assistant-skill";
}

/** The description: who it's for. It isn't listed anywhere a model picks from, so it only has to be true. Pure. */
export function assistantSkillDescription(name: string, job: string): string {
  const d = `${name}'s own skill: how ${name} does its job (${oneLine(job).replace(/[.!]+$/, "")}). ${name} loads it on every chat and run.`.replace(/<[^>]*>/g, "");
  return d.slice(0, SKILL_LIMITS.description);
}

const lowerFirst = (s: string) => (/^[A-Z][a-z]/.test(s) ? s.charAt(0).toLowerCase() + s.slice(1) : s);

/** The plain skill, when the model can't write one: the job, the instructions and every answer, as steps. Pure. */
export function templateSkill(a: { name: string; job: string; instructions: string }, answers: TeamAnswer[]): TeamSkillDraft {
  const job = oneLine(a.job).replace(/[.!]+$/, "");
  const lines = [`# How ${a.name} works`, "", `${a.name}'s job: ${lowerFirst(job)}.`];
  if (a.instructions.trim()) lines.push("", "## The owner's instructions", "", a.instructions.trim());
  if (answers.length) lines.push("", "## What the owner told you at setup", "", ...answers.map((x) => `- ${x.question} ${x.answer}`));
  lines.push(
    "",
    "## Every time",
    "",
    "1. Start from what arrived, or what the owner asked.",
    `2. Look in Athena for what the job needs before you change anything.${answers.length ? " Keep to the owner's answers above." : ""}`,
    "3. Make only the changes the job needs. Anything you can't do alone waits for the owner's Go.",
    "4. Reply in one or two plain sentences: what you did, and what's waiting.",
  );
  const summary = clip(`${a.name} ${lowerFirst(job)}${answers.length ? ", keeping to what you told it at setup" : ""}.`, MAX_SUMMARY);
  const doc = checkDoc({ name: assistantSkillName(a.name, a.job), description: assistantSkillDescription(a.name, a.job), body: lines.join("\n"), extra: "" });
  return { ...doc, summary };
}

/** The model's skill, made to fit Claude's limits; the name and description are always Athena's own. Null when there's no usable body. Pure. */
export function fitTeamSkill(raw: unknown, a: { name: string; job: string }): TeamSkillDraft | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const body = typeof r.body === "string" ? r.body.replace(/\r\n?/g, "\n").trim().slice(0, SKILL_LIMITS.body) : "";
  if (body.length < 40) return null;
  const summary = typeof r.summary === "string" ? clip(oneLine(r.summary).replace(/<[^>]*>/g, ""), MAX_SUMMARY) : "";
  const name = assistantSkillName(a.name, a.job);
  const description = assistantSkillDescription(a.name, a.job);
  if (nameProblem(name) || descriptionProblem(description)) return null;
  try {
    return { ...checkDoc({ name, description, body, extra: "" }), summary: summary || clip(`${a.name} ${lowerFirst(oneLine(a.job))}.`, MAX_SUMMARY) };
  } catch {
    return null;
  }
}

/** The first few steps of a skill's instructions, as plain lines for the assistant's page. Pure. */
export function skillGist(body: string, n = 4): string[] {
  const out: string[] = [];
  for (const raw of body.split("\n")) {
    const m = /^\s*(?:\d+[.)]|[-*•])\s+(.+)$/.exec(raw);
    if (!m) continue;
    const line = oneLine(m[1].replace(/\*\*|__|`/g, "").replace(/\[([^\]]+)\]\([^)]*\)/g, "$1"));
    if (line) out.push(clip(line, 160));
    if (out.length === n) break;
  }
  return out;
}
