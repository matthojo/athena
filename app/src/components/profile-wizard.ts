/**
 * The profile setup wizard: four steps (PROFILE_STEPS), each skippable, in a
 * tall sheet. It opens at the step it was left on (GET /api/profile/setup);
 * Next and Back save that step's answers and the position, Skip marks the
 * step skipped, and the last step finishes it. With no connection the
 * answers wait on this device (db/profile.ts) and the wizard says so.
 */

import { h } from "../lib/dom";
import { icons } from "./icons";
import { openSheet } from "./sheet";
import { showToast } from "./toast";
import { profileControl, profileQuestion, inputHint, type ProfileControl } from "./profile-inputs";
import { changeSetup, loadProfile, loadSetup, saveProfile, type ProfileEdit } from "../db/profile";
import { PROFILE_FIELDS, PROFILE_STEPS, type ProfileStepId } from "../lib/profile-catalogue";

/** A line under each step's title: what it's for. */
const STEP_LEDE: Record<ProfileStepId, string> = {
  about: "What to call you, where home is and who matters most. Pick people from People, or type a new name.",
  routines: "Your days and what you enjoy. Athena uses these for suggestions.",
  work: "So Athena can plan around your working week. Skip it if it doesn't fit.",
  help: "What you're working towards, and how you'd like Athena to help.",
};

export const QUEUED_NOTE = "Saved on this device. It goes to Athena when you're back online.";

let open = false;

/** Open the wizard at `step`, or where it was left. */
export async function openProfileWizard(opts: { step?: ProfileStepId; onDone?: () => void } = {}): Promise<void> {
  if (open) return;
  open = true;
  let setup;
  let values = new Map<string, string>();
  try {
    const [s, p] = await Promise.all([loadSetup(), loadProfile()]);
    setup = s;
    for (const sec of p.sections) for (const f of sec.fields) if (f.fact) values.set(f.key.toLowerCase(), f.fact.value);
  } catch (error) {
    open = false;
    showToast(error instanceof Error ? error.message : "Couldn't open setup", { icon: "wifiOff" });
    return;
  }

  let index = Math.max(0, PROFILE_STEPS.findIndex((s) => s.id === (opts.step ?? setup.step ?? "about")));
  let queued = false;
  let busy = false;
  let controls: Array<{ key: string; control: ProfileControl }> = [];

  const body = h("div", { class: "profile-wiz" });
  const sheet = openSheet({
    label: "Set up your profile",
    title: "About you",
    body,
    onClose: () => {
      open = false;
      opts.onDone?.();
    },
  });

  /** This step's answers that differ from what's saved. */
  function edits(): ProfileEdit[] {
    return controls
      .map(({ key, control }) => ({ key, value: control.value() }))
      .filter((e) => e.value !== (values.get(e.key.toLowerCase()) ?? "").trim());
  }

  async function save(change: Parameters<typeof changeSetup>[0], withAnswers: boolean): Promise<boolean> {
    if (busy) return false;
    busy = true;
    body.querySelectorAll<HTMLButtonElement>(".profile-wiz__foot button").forEach((b) => (b.disabled = true));
    try {
      const list = withAnswers ? edits() : [];
      const results = await Promise.all([list.length ? saveProfile(list) : Promise.resolve("saved" as const), changeSetup(change)]);
      for (const e of list) values.set(e.key.toLowerCase(), e.value);
      if (results.includes("queued")) queued = true;
      return true;
    } catch (error) {
      showToast(error instanceof Error ? error.message : "Couldn't save that", { icon: "wifiOff", timeoutMs: 4000 });
      body.querySelectorAll<HTMLButtonElement>(".profile-wiz__foot button").forEach((b) => (b.disabled = false));
      return false;
    } finally {
      busy = false;
    }
  }

  async function go(to: number, how: "next" | "back" | "skip") {
    const step = PROFILE_STEPS[index].id;
    const last = to >= PROFILE_STEPS.length;
    const change = {
      ...(how === "skip" ? { skip: step } : {}),
      ...(last ? { complete: true, step: null } : { step: PROFILE_STEPS[to].id }),
    };
    if (!(await save(change, how !== "skip"))) return;
    if (last) return finished();
    index = to;
    paint();
  }

  function paint() {
    const step = PROFILE_STEPS[index];
    sheet.setTitle("About you");
    sheet.setBack(index > 0 ? () => void go(index - 1, "back") : null);
    controls = PROFILE_FIELDS.filter((f) => f.step === step.id).map((f) => ({ key: f.key, control: profileControl(f, values.get(f.key.toLowerCase()) ?? "") }));
    const questions = controls.map(({ key, control }) => {
      const f = PROFILE_FIELDS.find((x) => x.key === key)!;
      return profileQuestion(f.label, control, f.input === "list" ? inputHint(f.input, f.hint) : null);
    });
    const isLast = index === PROFILE_STEPS.length - 1;
    const back = h("button", { class: "btn btn--ghost", type: "button", hidden: index === 0 }, "Back");
    back.addEventListener("click", () => void go(index - 1, "back"));
    const skip = h("button", { class: "btn btn--ghost", type: "button" }, isLast ? "Skip and finish" : "Skip");
    skip.addEventListener("click", () => void go(index + 1, "skip"));
    const next = h("button", { class: "btn btn--primary", type: "submit" }, isLast ? "Finish" : "Next", isLast ? icons.check() : icons.arrowRight());
    const form = h(
      "form",
      { class: "profile-wiz__form", novalidate: true },
      h(
        "div",
        { class: "profile-wiz__head" },
        h(
          "ol",
          { class: "profile-wiz__steps", "aria-label": `Step ${index + 1} of ${PROFILE_STEPS.length}` },
          ...PROFILE_STEPS.map((s, i) => h("li", { class: "profile-wiz__dot", "data-state": i < index ? "done" : i === index ? "now" : "todo", "aria-current": i === index ? "step" : undefined }, h("span", { class: "visually-hidden" }, s.title)))
        ),
        h("p", { class: "profile-wiz__count" }, `Step ${index + 1} of ${PROFILE_STEPS.length}`),
        h("h3", { class: "profile-wiz__title" }, step.title),
        h("p", { class: "profile-wiz__lede" }, STEP_LEDE[step.id])
      ),
      h("div", { class: "profile-wiz__questions" }, ...questions),
      queued ? h("p", { class: "settings__note profile-wiz__queued", role: "status" }, icons.cloud(), QUEUED_NOTE) : null,
      h("div", { class: "profile-wiz__foot" }, back, h("span", { class: "profile-wiz__spacer" }), skip, next)
    ) as HTMLFormElement;
    form.addEventListener("submit", (e) => {
      e.preventDefault();
      void go(index + 1, "next");
    });
    // Enter in a one-line answer moves to the next question, not on.
    form.addEventListener("keydown", (e) => {
      const t = e.target as HTMLElement;
      if (e.key !== "Enter" || !(t instanceof HTMLInputElement) || t.matches(".picker__input")) return;
      const inputs = [...form.querySelectorAll<HTMLInputElement>("input.field")];
      const at = inputs.indexOf(t);
      if (at >= 0 && at < inputs.length - 1) {
        e.preventDefault();
        inputs[at + 1].focus();
      }
    });
    body.replaceChildren(form);
    body.closest(".sheet__scroll")?.scrollTo({ top: 0 });
  }

  function finished() {
    sheet.setBack(null);
    const done = h("button", { class: "btn btn--primary btn--block", type: "button" }, "Done");
    done.addEventListener("click", () => sheet.close());
    body.replaceChildren(
      h(
        "div",
        { class: "profile-wiz__done" },
        h("span", { class: "tile" }, icons.check()),
        h("h3", { class: "profile-wiz__title" }, "That's you set up"),
        h("p", { class: "profile-wiz__lede" }, "Change any of it in Settings, under About you. Athena may suggest additions now and then. You'll find them in your Inbox."),
        queued ? h("p", { class: "settings__note profile-wiz__queued", role: "status" }, icons.cloud(), QUEUED_NOTE) : null,
        done
      )
    );
    showToast(queued ? "Saved on this device for now" : "Saved", { icon: queued ? "cloud" : "check" });
  }

  paint();
  // Opening it counts as starting: the next visit resumes here.
  if (setup.step !== PROFILE_STEPS[index].id) void changeSetup({ step: PROFILE_STEPS[index].id }).catch(() => undefined);
}
