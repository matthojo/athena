/**
 * Home's offer to set up the profile: shown while setup isn't finished
 * (completed_at is null) or the catalogue has moved on since (version <
 * PROFILE_SETUP_VERSION). "Set up" opens the wizard where it was left;
 * "Not now" counts as done ({ complete: true }) and Settings → About you
 * can run it again. In sample mode it also steps aside once the profile has
 * a name: the sample owner has told Athena about themselves already.
 */

import { h } from "../lib/dom";
import { icons } from "./icons";
import { showToast } from "./toast";
import { openProfileWizard } from "./profile-wizard";
import { changeSetup, loadProfile, loadSetup, onProfileChange } from "../db/profile";
import { isSampleMode } from "../db/api";
import { PROFILE_STEPS, setupDue } from "../lib/profile-catalogue";

/** Whether the sample profile has a Name. */
async function sampleHasName(): Promise<boolean> {
  try {
    const { sections } = await loadProfile();
    return sections.some((s) => s.fields.some((f) => f.key === "Name" && !!f.fact?.value.trim()));
  } catch {
    return false;
  }
}

export function profileSetupCard(): { el: HTMLElement; destroy: () => void } {
  const el = h("article", { class: "card briefing profile-card", hidden: true, "aria-labelledby": "profile-card-title" });
  let dead = false;

  async function paint() {
    let setup;
    try {
      setup = await loadSetup();
    } catch {
      return;
    }
    if (dead) return;
    el.hidden = !setupDue(setup) || (isSampleMode() && (await sampleHasName()));
    if (dead || el.hidden) return;
    const resumeAt = setup.step && setup.step !== "about" ? PROFILE_STEPS.find((s) => s.id === setup.step) : null;
    const start = h("button", { class: "btn btn--primary btn--sm", type: "button" }, resumeAt ? "Carry on" : "Set up");
    start.addEventListener("click", () => void openProfileWizard({ onDone: () => void paint() }));
    const later = h("button", { class: "icon-btn icon-btn--sm icon-btn--ghost", type: "button", "aria-label": "Not now" }, icons.close());
    later.addEventListener("click", async () => {
      el.hidden = true;
      try {
        await changeSetup({ complete: true });
        showToast("You can do this any time in Settings, under About you", { icon: "person", timeoutMs: 4000 });
      } catch (error) {
        el.hidden = false;
        showToast(error instanceof Error ? error.message : "Couldn't save that", { icon: "wifiOff" });
      }
    });
    el.replaceChildren(
      h("span", { class: "tile" }, icons.person()),
      h(
        "span",
        { class: "briefing__text" },
        h("span", { class: "briefing__title", id: "profile-card-title" }, resumeAt ? "Finish telling Athena about you" : "Tell Athena about you"),
        h("span", { class: "briefing__snippet profile-card__snippet" }, resumeAt ? `Pick up at ${resumeAt.title.toLowerCase()}` : "Four short steps, and you can skip any of them"),
        h("span", { class: "profile-card__actions" }, start)
      ),
      later
    );
  }

  void paint();
  const off = onProfileChange(() => void paint());
  return {
    el,
    destroy: () => {
      dead = true;
      off();
    },
  };
}
