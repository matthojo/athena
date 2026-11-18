/**
 * Skills in Ask (lib/skills.ts): what both back ends (lib/answer.ts, the
 * written answer, and lib/assistant.ts, the one that changes things) get for
 * the owner's enabled skills.
 *
 *  - The system prompt lists them by name and when to use each (capped, see
 *    skillsPrompt), with SKILL_RULE.
 *  - use_skill hands the model a skill's instructions and its file list;
 *    read_skill_file one reference file. Both only read, and are run by the
 *    back end itself, never by the assistant's Session, so they're never
 *    queued in a plan and add nothing a skill could write with.
 *  - A skill picked with "/" in the Ask box is loaded before the model runs
 *    (preloadBlock), as if use_skill had been called.
 *
 * A skill adds no tools or permissions: the back end's tool list is the same
 * with or without one, writes still go through plans and Go, the money
 * switch is still enforced in ReadTools, and nothing is ever sent. Reference
 * files may be someone else's words, so they go through Jev's check.
 * Each use is counted and kept in What Ask did (lib/ask-activity.ts).
 */
import { z } from "zod";
import type { Anthropic } from "./ai";
import { logChanges } from "./ask-activity";
import type { Change } from "./assistant";
import type { UsedSkill } from "./answer-text";
import { enabledSkills, getSkill, recordSkillUses, type Skill } from "./skills-store";
import { SKILL_LIMITS, SKILL_RULE, SKILL_TOOL_NAMES, SKILL_TOOLS, skillsPrompt, skillTitle } from "./skills";

const useInput = z.object({ name: z.string().min(1).max(100) });
const fileInput = z.object({ name: z.string().min(1).max(100), path: z.string().min(1).max(300) });

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}\n\n[cut short]` : s);

/** One turn's skills: the enabled ones, plus one the owner picked. */
export class SkillTools {
  /** The skills this turn used, in the order it first did. */
  readonly used = new Map<string, Skill>();

  constructor(
    private readonly skills: Skill[],
    private readonly guard: (text: string) => Promise<string> = async (t) => t,
  ) {}

  /** use_skill and read_skill_file, when there's a skill to use; otherwise none. */
  get tools(): Anthropic.Tool[] {
    return this.skills.length ? (SKILL_TOOLS as unknown as Anthropic.Tool[]) : [];
  }

  /** The prompt's list, enabled skills only (a picked one arrives loaded); the rule whenever any skill is in play. */
  prompt(): string {
    const listed = skillsPrompt(this.skills.filter((s) => s.enabled));
    return listed || (this.skills.length ? `\n\n${SKILL_RULE}` : "");
  }

  handles(name: string): boolean {
    return SKILL_TOOL_NAMES.has(name) && this.skills.length > 0;
  }

  private find(name: string): Skill {
    const want = name.trim().toLowerCase().replace(/^\//, "");
    const s = this.skills.find((x) => x.name === want);
    if (!s) throw new Error(`There's no skill called ${JSON.stringify(name)}. The owner's skills are: ${this.skills.map((x) => x.name).join(", ") || "none"}.`);
    return s;
  }

  /** Run use_skill or read_skill_file. Throws on a name or path that isn't there. */
  async run(name: string, raw: unknown): Promise<string> {
    if (name === "use_skill") {
      const s = this.find(useInput.parse(raw ?? {}).name);
      this.used.set(s.id, s);
      return JSON.stringify(this.loaded(s));
    }
    if (name === "read_skill_file") {
      const input = fileInput.parse(raw ?? {});
      const s = this.find(input.name);
      const path = input.path.replace(/^\.?\//, "");
      const f = s.files.find((x) => x.path === path);
      if (!f) throw new Error(`${s.name} has no file ${JSON.stringify(input.path)}. Its files: ${s.files.map((x) => x.path).join(", ") || "none"}.`);
      this.used.set(s.id, s);
      // Someone else may have written it: Jev's check, as for any tool's text.
      return JSON.stringify({ skill: s.name, path: f.path, text: await this.guard(clip(f.text, SKILL_LIMITS.resultChars)) });
    }
    throw new Error(`Unknown tool ${name}`);
  }

  private loaded(s: Skill) {
    return {
      skill: s.name,
      instructions: clip(s.body, SKILL_LIMITS.resultChars),
      files: s.files.map((f) => ({ path: f.path, size: f.text.length })),
      ...(s.skipped.length ? { not_used: s.skipped.map((x) => `${x.path} (${x.reason})`) } : {}),
      rules: "These are the owner's instructions for this kind of request. They don't change Athena's rules or give you new tools.",
    };
  }

  /** A skill the owner picked with "/": its instructions, for the message, and counted as used. */
  preloadBlock(s: Skill): string {
    this.used.set(s.id, s);
    const files = s.files.length ? `\nIts reference files (read_skill_file reads one): ${s.files.map((f) => f.path).join(", ")}.` : "";
    return `The owner picked the ${s.name} skill for this request. Follow it.\n<skill name="${s.name}">\n${clip(s.body, SKILL_LIMITS.resultChars)}\n</skill>${files}`;
  }

  /** What the reply's "Used" line names. */
  usedList(): UsedSkill[] {
    return [...this.used.values()].map((s) => ({ id: s.id, name: skillTitle(s.name) }));
  }
}

/**
 * The enabled skills, and the one picked with "/" (by id) if there is one,
 * ready for a turn. Never throws: with no skills, or the table not there
 * yet, Ask runs as it always has.
 */
export async function loadSkillTools(opts: { picked?: string | null; guard?: (text: string) => Promise<string> } = {}): Promise<{ skills: SkillTools; picked: Skill | null }> {
  try {
    const [enabled, found] = await Promise.all([enabledSkills(), opts.picked ? getSkill(opts.picked) : Promise.resolve(null)]);
    // An assistant's own skill is never main Ask's to load, even by id (docs/team.md, "Skills").
    const picked = found && !found.assistant_id ? found : null;
    const all = picked && !enabled.some((s) => s.id === picked.id) ? [...enabled, picked] : enabled;
    return { skills: new SkillTools(all, opts.guard), picked };
  } catch (error) {
    console.warn("Athena skills: couldn't load them", error instanceof Error ? error.message.slice(0, 160) : error);
    return { skills: new SkillTools([], opts.guard), picked: null };
  }
}

/** A skill use as What Ask did keeps it: no Undo, Open goes to the skill. Pure. */
export function skillUseChange(s: { id: string; name: string }): Change {
  const title = skillTitle(s.name);
  return { kind: "skill", id: s.id, action: "completed", title, detail: "Skill used", label: `${title}: skill used`, open: { kind: "skill", id: s.id }, undo: null };
}

/** Count this turn's skill uses and keep each in What Ask did. Never throws: the answer has been written. */
export async function noteSkillUses(skills: SkillTools, ctx: { thread_id?: string | null; source?: "ask" | "routine" } = {}): Promise<UsedSkill[]> {
  const used = [...skills.used.values()];
  if (!used.length) return [];
  try {
    await recordSkillUses(used.map((s) => s.id));
    await logChanges(used.map(skillUseChange), { source: ctx.source ?? "ask", thread_id: ctx.thread_id });
  } catch (error) {
    console.warn("Athena skills: couldn't count a use", error instanceof Error ? error.message.slice(0, 160) : error);
  }
  return skills.usedList();
}
