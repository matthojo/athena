/**
 * "How <Name> works" on an assistant's page (docs/team.md, "Skills"): its own
 * skill as a plain summary and its first steps, with Edit opening the normal
 * skill editor (Settings → Skills).
 *
 * - Just added: the skill is still being written, so the section says so and
 *   looks again every few seconds until it's there.
 * - No skill (an older assistant, or one made from a routine): "Give <Name> a
 *   skill" asks setup's questions here, then Athena writes it.
 * - The job or instructions changed since it was written: "Update <Name>'s
 *   skill to match?" with a preview of what Athena would write now. Nothing
 *   changes unless the owner taps Update, so their own edits stay.
 */
import { h } from "../lib/dom";
import { icons } from "../components/icons";
import { showToast } from "../components/toast";
import { acceptSkillUpdate, getAssistantSkill, giveSkill, keepSkill, previewSkillUpdate, teamQuestions, type TeamAssistant, type TeamSkillInfo } from "../db/team";
import { renderAvatarTile } from "./avatar";
import { answersFor, questionsForm, type AnswerMap } from "./setup-questions";
import { pronouns } from "./detail-words";

/** How long after an assistant is added its skill may still be on its way. */
const WRITING_MS = 3 * 60_000;
const LOOK_AGAIN_MS = 3000;

const say = (e: unknown, fallback: string) => (e instanceof Error && e.message && !/fetch|network|Failed/i.test(e.message) ? e.message : fallback);

export function skillSection(get: () => TeamAssistant, alive: () => boolean): { el: HTMLElement; reload: () => void } {
  const title = h("h2", { class: "td-sec__title" });
  const edit = h("button", { class: "btn btn--ghost btn--sm td-edit", type: "button", hidden: true }, icons.pen(), "Edit");
  const box = h("div", { class: "td-sec__body tds", "aria-live": "polite" }, h("p", { class: "td-empty" }, "Loading…"));
  const el = h("section", { class: "td-sec td-sec--skill" }, h("header", { class: "td-sec__head" }, title, edit), box);
  let info: TeamSkillInfo | null = null;
  let timer = 0;
  let asking = false;

  edit.addEventListener("click", () => {
    if (info?.skill) location.hash = `#/settings/skills/${encodeURIComponent(info.skill.id)}`;
  });

  const thinking = (line: string) => h("div", { class: "tds-thinking" }, renderAvatarTile(get().avatar, { size: 44, mood: "thinking", animate: true }), h("p", {}, line));

  function steps(gist: string[]): HTMLElement | null {
    return gist.length ? h("ol", { class: "tds-steps" }, ...gist.map((g) => h("li", {}, g))) : null;
  }

  function paint() {
    const a = get();
    title.textContent = `How ${a.name} works`;
    edit.setAttribute("aria-label", `Edit ${a.name}'s skill`);
    window.clearTimeout(timer);
    if (asking) return;
    const s = info?.skill;
    edit.hidden = !s;
    if (!s) {
      if (Date.now() - Date.parse(a.created_at) < WRITING_MS) {
        box.replaceChildren(thinking(`Athena is writing down how ${a.name} works…`));
        timer = window.setTimeout(load, LOOK_AGAIN_MS);
        return;
      }
      const give = h("button", { class: "btn btn--soft btn--sm", type: "button" }, icons.sparkle(), `Give ${a.name} a skill`);
      give.addEventListener("click", () => void ask());
      const p = pronouns(a.personality);
      box.replaceChildren(h("p", { class: "td-empty" }, `${a.name} works from ${p.their} job and instructions for now. Answer a few questions and Athena will write down how ${p.they} ${p.plural ? "do" : "does"} the job.`), give);
      return;
    }
    const parts: Array<Node | null> = [];
    if (info!.stale) parts.push(offer());
    if (s.summary && !info!.edited) parts.push(h("p", { class: "td-prose" }, s.summary));
    const list = steps(s.gist);
    // The summary says it in a sentence; the steps are there for when you want them.
    if (list && s.summary && !info!.edited) parts.push(h("details", { class: "tds-each" }, h("summary", {}, `See each step (${s.gist.length})`), list));
    else parts.push(list);
    parts.push(h("p", { class: "td-fine" }, info!.edited ? `You've edited this skill. Only ${a.name} uses it, on every chat and run.` : `Only ${a.name} uses this skill, on every chat and run.`));
    box.replaceChildren(...parts.filter((p): p is Node => !!p));
  }

  /** "Update <Name>'s skill to match?", with what Athena would write now. */
  function offer(): HTMLElement {
    const a = get();
    const body = h("div", { class: "tds-preview" }, thinking("Writing a new version…"));
    const keep = h("button", { class: "btn btn--ghost btn--sm", type: "button" }, "Keep as it is");
    const update = h("button", { class: "btn btn--primary btn--sm", type: "button", "aria-disabled": "true" }, "Update skill");
    const card = h(
      "div",
      { class: "tds-offer", role: "group", "aria-labelledby": "tds-offer-t" },
      h("p", { class: "tds-offer__title", id: "tds-offer-t" }, `Update ${a.name}'s skill to match?`),
      h("p", { class: "tds-offer__lede" }, `${a.name}'s job or instructions changed after this skill was written. Here's what Athena would write now.${info?.edited ? " Updating replaces your own edits." : ""}`),
      body,
      h("div", { class: "td-foot" }, keep, update)
    );
    let preview: Awaited<ReturnType<typeof previewSkillUpdate>> | null = null;
    void previewSkillUpdate(a.id).then(
      (p) => {
        if (!alive()) return;
        preview = p;
        update.setAttribute("aria-disabled", "false");
        body.replaceChildren(
          ...[p.summary ? h("p", { class: "td-prose" }, p.summary) : null, steps(p.gist), h("details", { class: "tds-all" }, h("summary", {}, "See all of it"), h("pre", { class: "tds-pre" }, p.body))].filter((x): x is HTMLElement => !!x)
        );
      },
      (e) => body.replaceChildren(h("p", { class: "td-empty" }, say(e, "Athena couldn't write a new version just now. Try again later.")))
    );
    keep.addEventListener("click", async () => {
      try {
        info = await keepSkill(a.id);
        paint();
      } catch (e) {
        showToast(say(e, "Couldn't save that. Try again."));
      }
    });
    update.addEventListener("click", async () => {
      if (!preview || update.getAttribute("aria-disabled") === "true") return;
      update.setAttribute("aria-disabled", "true");
      try {
        info = await acceptSkillUpdate(a.id, preview);
        paint();
        showToast(`Updated ${a.name}'s skill`);
      } catch (e) {
        update.setAttribute("aria-disabled", "false");
        showToast(say(e, "Couldn't update it. Try again."));
      }
    });
    return card;
  }

  /** "Give <Name> a skill": setup's questions, here, then Athena writes it. */
  async function ask() {
    const a = get();
    asking = true;
    edit.hidden = true;
    box.replaceChildren(thinking("Thinking about the job…"));
    const questions = await teamQuestions(a.job, { job: a.job, instructions: a.instructions }).catch(() => []);
    if (!alive()) return;
    let answers: AnswerMap = {};
    const skip = h("button", { class: "btn btn--ghost btn--sm", type: "button" }, questions.length ? "Skip questions" : "Cancel");
    const write = h("button", { class: "btn btn--primary btn--sm", type: "button" }, `Write ${a.name}'s skill`);
    const go = async (withAnswers: boolean) => {
      box.replaceChildren(thinking(`Writing down how ${a.name} works…`));
      try {
        info = await giveSkill(a.id, withAnswers ? answersFor(questions, answers) : []);
      } catch (e) {
        showToast(say(e, "Athena couldn't write it just now. Try again."));
      }
      asking = false;
      if (alive()) paint();
    };
    write.addEventListener("click", () => void go(true));
    skip.addEventListener("click", () => {
      if (questions.length) return void go(false);
      asking = false;
      paint();
    });
    box.replaceChildren(
      ...(questions.length ? [h("p", { class: "tds-lede" }, "Your answers shape how it does the job. Tap one, or write your own."), questionsForm(questions, answers, (m) => (answers = m))] : [h("p", { class: "tds-lede" }, `Athena will write it from ${a.name}'s job and instructions.`)]),
      h("div", { class: "td-foot" }, skip, write)
    );
    box.querySelector<HTMLElement>('[role="radio"]')?.focus({ preventScroll: true });
  }

  function load() {
    void getAssistantSkill(get().id).then(
      (i) => {
        if (!alive()) return;
        info = i;
        paint();
      },
      () => {
        if (alive() && !info) box.replaceChildren(h("p", { class: "td-empty" }, "This didn't load. Check you're online."));
      }
    );
  }

  title.textContent = `How ${get().name} works`;
  load();
  return { el, reload: load };
}
