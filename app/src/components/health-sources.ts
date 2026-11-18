/**
 * Settings → Health: which app each figure comes from (sleep, steps,
 * weight, workouts, food and drink, mind), among the ones Athena can read. One app per figure;
 * the server never adds two together, and rewrites the last 30 days' Life
 * log lines when a choice changes (lib/health.ts saveHealthPrefs).
 */

import { h } from "../lib/dom";
import { brandLogo } from "./brand-logo";
import { icons } from "./icons";
import { showToast } from "./toast";
import { loadHealthSources, saveHealthSources, SOURCE_NAMES, type HealthChoice, type HealthSource, type HealthSources } from "../db/health";
import "../styles/health.css";

const ROWS: Array<{ id: HealthChoice; label: string; hint: (s: HealthSources) => string | null }> = [
  { id: "sleep", label: "Sleep", hint: (s) => (s.prefs.sleep === "polar" ? "Polar doesn't share resting heart rate, so the next app fills it in." : "Resting heart rate comes from the same app.") },
  { id: "steps", label: "Steps", hint: () => null },
  { id: "weight", label: "Weight", hint: () => "Shows on days you weigh in." },
  {
    id: "workouts",
    label: "Workouts",
    hint: (s) => {
      const strava = s.connected.includes("strava") && s.prefs.workouts !== "strava" ? "Strava adds its names, climbs and routes." : "";
      const once = s.can_send.workouts.filter((x) => s.connected.includes(x)).length > 1 ? "Each workout counts once, even if two apps log it." : "";
      return [once, strava].filter(Boolean).join(" ") || null;
    },
  },
  { id: "nutrition", label: "Food and drink", hint: (s) => (s.prefs.nutrition === "oura" ? "Oura counts coffee and alcohol from your tags. Calories and water still come from Apple Health." : "Calories, water, coffee and drinks, from any food app that writes to Apple Health.") },
  { id: "mind", label: "Mind", hint: () => "Mindful minutes from meditation and breathing." },
];

const LOGO: Partial<Record<HealthSource, string>> = { strava: "strava", oura: "oura", withings: "withings", whoop: "whoop", polar: "polar" };

/** "Oura, Whoop or Polar". */
const orList = (names: string[]) => (names.length > 1 ? `${names.slice(0, -1).join(", ")} or ${names[names.length - 1]}` : names.join(""));

/** One app as a choice: its mark and name. */
function option(source: HealthSource, checked: boolean): HTMLButtonElement {
  const mark = LOGO[source] ? brandLogo(LOGO[source]!, "sm") : h("span", { class: "hsrc__apple", "aria-hidden": "true" }, icons.heart());
  return h("button", { class: "chip hsrc__chip", type: "button", role: "radio", "aria-checked": String(checked), "data-source": source }, mark, SOURCE_NAMES[source]) as HTMLButtonElement;
}

/** The four choices, saved as they're made. `openSources` leads to connecting an app. */
export function healthSourcesPanel(opts: { openSources: () => void; openIphone: () => void }): { el: HTMLElement; reload: () => Promise<void> } {
  const body = h("div", { class: "card card--flush hsrc", "aria-busy": "true" });
  let state: HealthSources | null = null;

  function paint() {
    if (!state) return;
    body.removeAttribute("aria-busy");
    const s = state;
    body.replaceChildren(
      ...ROWS.map((r) => {
        const choices = s.can_send[r.id].filter((src) => s.connected.includes(src));
        const current = choices.includes(s.prefs[r.id]) ? s.prefs[r.id] : choices[0];
        let control: HTMLElement;
        if (!choices.length) control = h("span", { class: "hsrc__none" }, r.id === "workouts" ? "Connect Strava or set up Apple Health" : r.id === "nutrition" || r.id === "mind" ? "Set up Apple Health or connect Oura" : `Connect ${orList(s.can_send[r.id].map((x) => SOURCE_NAMES[x]))}`);
        else if (choices.length === 1) control = h("span", { class: "hsrc__only" }, option(choices[0], true));
        else {
          control = h("span", { class: "chip-row chip-row--wrap hsrc__choices", role: "radiogroup", "aria-label": r.label }, ...choices.map((c) => option(c, c === current)));
          control.addEventListener("click", (e) => {
            const b = (e.target as HTMLElement).closest<HTMLButtonElement>("[data-source]");
            if (!b || b.getAttribute("aria-checked") === "true") return;
            void choose(r.id, b.dataset.source as HealthSource);
          });
        }
        const hint = choices.length ? r.hint(s) : null;
        return h("div", { class: "hsrc__row" }, h("div", { class: "hsrc__label" }, h("span", { class: "hsrc__name" }, r.label), hint ? h("span", { class: "hsrc__hint" }, hint) : null), control);
      })
    );
    if (s.connected.length < 2) {
      const connect = h("button", { class: "acct-link", type: "button" }, "Connect an app");
      connect.addEventListener("click", opts.openSources);
      const phone = h("button", { class: "acct-link", type: "button" }, "Set up Apple Health");
      phone.addEventListener("click", opts.openIphone);
      body.append(h("p", { class: "hsrc__foot" }, "Add another app to choose between them. ", s.connected.includes("apple_health") ? connect : phone));
    }
  }

  async function choose(id: HealthChoice, source: HealthSource) {
    if (!state) return;
    const before = state;
    state = { ...state, prefs: { ...state.prefs, [id]: source } };
    paint();
    try {
      state = await saveHealthSources({ [id]: source });
      paint();
      showToast(`${ROWS.find((r) => r.id === id)!.label} now comes from ${SOURCE_NAMES[source]}`, { icon: "check" });
    } catch (error) {
      state = before;
      paint();
      showToast(error instanceof Error ? error.message : "Couldn't save that", { icon: "wifiOff", timeoutMs: 4000 });
    }
  }

  async function reload() {
    try {
      state = await loadHealthSources();
      paint();
    } catch {
      body.removeAttribute("aria-busy");
      body.replaceChildren(h("p", { class: "hsrc__none hsrc__error" }, "Couldn't reach Athena. Try again when you're online."));
    }
  }
  void reload();
  return { el: body, reload };
}
