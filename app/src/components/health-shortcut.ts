/**
 * Settings → From your iPhone, the Health tab: a Shortcut automation that
 * sends yesterday's sleep, steps, resting heart rate (and, if you like,
 * workouts) from Apple Health each morning, to POST /api/health/day. It
 * uses a capture key, the same kind Siri capture uses (lib/api-keys.ts).
 * Above the steps: the line the Life log gets, and whether a day has
 * arrived (GET /api/health/status, days only, never figures).
 *
 * iphoneSection() puts this beside the Siri steps (shortcut-panel.ts) under
 * a two-way switch.
 */

import { h } from "../lib/dom";
import { icons } from "./icons";
import { showToast } from "./toast";
import { copyText, freshKeyCard } from "./api-keys";
import { request } from "../db/api";
import { makeKey } from "./api-keys";
import "../styles/health-shortcut.css";
import { sparkline } from "./sparkline";

interface Series {
  points: Array<{ day: string; value: number }>;
}

/** 460 → "7h 40m". */
const hm = (m: number) => {
  const h = Math.floor(m / 60);
  const r = Math.round(m - h * 60);
  return h ? (r ? `${h}h ${r}m` : `${h}h`) : `${r}m`;
};
const thousands = (n: number) => Math.round(n).toLocaleString("en-GB");

interface HealthStatus {
  today: string;
  sources: Array<{ source: string; last_day: string }>;
  life_log: { id: string; name: string } | null;
}

/** "Thursday 6 November". */
function dayName(day: string): string {
  const [y, m, d] = day.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d, 12)).toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long", timeZone: "UTC" });
}

function addDays(day: string, n: number): string {
  const [y, m, d] = day.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + n, 12)).toISOString().slice(0, 10);
}

/** A value to type into the Shortcut, with a Copy button (shortcut-panel.ts has the same row). */
function copyLine(label: string, value: string, copyAs: string): HTMLElement {
  const btn = h("button", { class: "btn btn--soft btn--sm", type: "button", "aria-label": `Copy ${label.toLowerCase()}` }, "Copy");
  btn.addEventListener("click", () => void copyText(value, copyAs));
  return h("div", { class: "shortcut__value" }, h("span", { class: "shortcut__value-label" }, label), h("code", { class: "prop__mono shortcut__value-text" }, value), btn);
}

/** One JSON field to add in Get Contents of URL: its name to copy, its type in Shortcuts, and where its value comes from. */
function field(name: string, kind: "Number" | "Text", from: string): HTMLElement {
  const btn = h("button", { class: "hs-field__name", type: "button", "aria-label": `Copy ${name}` }, h("code", { class: "prop__mono" }, name), icons.copy());
  btn.addEventListener("click", () => void copyText(name, "Field name"));
  return h("li", { class: "hs-field" }, btn, h("span", { class: "hs-field__from" }, h("span", { class: "hs-field__kind" }, kind), " ", from));
}

/** A variable as Shortcuts draws it: a blue token in the Text action. */
const token = (name: string) => h("span", { class: "hs-token" }, name);

/** The Health tab's content. */
export function healthShortcutPanel(opts: { manageKeys: () => void }): HTMLElement {
  const endpoint = `${location.origin}/api/health/day`;
  let fresh: string | null = null;
  let status: HealthStatus | null = null;
  let trend: { sleep: Series; steps: Series } | null = null;
  /** Whether the last two weeks from Apple Health came with stages: if not, the Shortcut predates them. */
  let hasStages = true;
  const root = h("div", { class: "shortcut hs" });

  async function load() {
    try {
      status = await request<HealthStatus>("/health/status");
      if (status.sources.length) {
        const from = addDays(status.today, -14);
        const [sleep, steps] = await Promise.all(
          (["sleep_minutes", "steps"] as const).map((f) => request<Series>(`/health/series?field=${f}&from=${from}&to=${status!.today}`))
        );
        trend = { sleep, steps };
        const apple = status.sources.find((x) => x.source === "apple_health");
        if (apple) {
          const days = await request<{ days: Array<{ sleep_stages?: unknown }> }>(`/health/days?from=${from}&to=${status.today}`).catch(() => null);
          hasStages = !days || days.days.some((d) => d.sleep_stages);
        }
      }
    } catch {
      status = null;
    }
    paint();
  }

  async function make(btn: HTMLButtonElement) {
    btn.disabled = true;
    try {
      fresh = (await makeKey("iPhone health", "capture")).token;
      paint();
    } catch (error) {
      btn.disabled = false;
      showToast(error instanceof Error ? error.message : "Couldn't make a key", { icon: "close", timeoutMs: 5000 });
    }
  }

  /** Yesterday (or today) has arrived from the Shortcut: the setup is done. */
  function working(): boolean {
    const last = status?.sources.find((s) => s.source === "apple_health")?.last_day ?? null;
    return !!status && !!last && last >= addDays(status.today, -1);
  }

  /** What the Life log gets, and whether it's arriving. */
  function preview(): HTMLElement {
    const last = status?.sources.find((s) => s.source === "apple_health")?.last_day ?? null;
    const yesterday = status ? addDays(status.today, -1) : null;
    let state: HTMLElement | null = null;
    if (status) {
      const ok = !!last && last >= (yesterday ?? "");
      const text = !last
        ? "Nothing has arrived yet"
        : last === status.today
          ? "Today's figures are in"
          : ok
            ? "Yesterday's figures are in"
            : `Last day in: ${dayName(last)}`;
      state = h(
        "p",
        { class: `hs-state${ok ? " hs-state--ok" : ""}`, role: "status" },
        ok ? icons.check() : icons.clock(),
        h("span", {}, text),
        !status.life_log && last ? h("span", { class: "hs-state__more" }, " · each day gets its own note") : null
      );
    }
    return h(
      "figure",
      { class: "card hs-preview" },
      h("figcaption", { class: "hs-preview__label" }, "On each of your days"),
      h(
        "div",
        { class: "hs-preview__note", "aria-label": "An example day" },
        h("p", { class: "hs-preview__day" }, yesterday ? dayName(yesterday) : "Thursday 6 November"),
        h("p", { class: "hs-preview__heading" }, "Health"),
        h("p", { class: "hs-preview__line" }, ...["7h 40m sleep", "9,200 steps", "5k run", "52 bpm resting"].flatMap((part, i) => [i ? " · " : "", h("span", { class: "hs-preview__part" }, part)]))
      ),
      state
    );
  }

  /** The last two weeks in words, each with its line. Only once something has arrived. */
  function lastTwoWeeks(): HTMLElement | null {
    if (!trend || (!trend.sleep.points.length && !trend.steps.points.length)) return null;
    const row = (label: string, s: Series, color: string, say: (avg: number) => string, fmt: (v: number) => string) => {
      if (!s.points.length) return null;
      const avg = s.points.reduce((n, p) => n + p.value, 0) / s.points.length;
      const points = s.points.map((p) => ({ value: p.value, recorded_at: `${p.day}T12:00:00Z` }));
      return h(
        "div",
        { class: "hs-trend" },
        h("p", { class: "hs-trend__label" }, label),
        h("p", { class: "hs-trend__value" }, say(avg)),
        h("div", { class: "hs-trend__chart" }, sparkline({ points, color, label: `${label}, last two weeks`, formatValue: fmt, height: 44 }))
      );
    };
    return h(
      "section",
      { class: "card hs-trends", "aria-label": "Your last two weeks" },
      h("p", { class: "hs-preview__label" }, "Your last two weeks"),
      working() ? preview().querySelector(".hs-state") : null,
      row("Sleep", trend.sleep, "var(--chart-1)", (a) => `${hm(a)} a night`, hm),
      row("Steps", trend.steps, "var(--chart-2)", (a) => `${thousands(a)} a day`, thousands),
      h("a", { class: "acct-link hs-trends__more", href: "#/health" }, "See weeks and months in Health")
    );
  }

  function steps(): HTMLElement {
    const step = (title: string, text: Array<Node | string>, extra: HTMLElement[] = []) =>
      h("li", { class: "shortcut__step hs-step" }, h("p", { class: "hs-step__title" }, title), h("p", {}, ...text), ...extra);
    const b = (s: string) => h("strong", {}, s);
    return h(
      "ol",
      { class: "card shortcut__steps hs-steps" },
      step("Make it run each morning", ["In the Shortcuts app, open ", b("Automation"), " and tap ", b("+"), ". Choose ", b("Time of Day"), ", set 8:00, ", b("Daily"), " and ", b("Run Immediately"), ", then tap ", b("New Blank Automation"), "."]),
      step("Find yesterday's figures", [
        "Add ",
        b("Find Health Samples"),
        " three times: ",
        b("Steps"),
        " and ",
        b("Resting Heart Rate"),
        " with Start Date is yesterday, and ",
        b("Sleep"),
        " with End Date is yesterday, so you get the night that ended that morning. For Steps, tap ",
        b("Show More"),
        " and set ",
        b("Group By"),
        " to ",
        b("Day"),
        ": Health then gives one total and doesn't count your watch and phone twice.",
      ]),
      step(
        "List the night's stages",
        ["Add ", b("Repeat with Each"), " for the Sleep samples. Inside it, add ", b("Text"), " with the Repeat Item's Value, Start Date and End Date, separated by commas. Then add ", b("Add to Variable"), " called Stages."],
        [
          h("p", { class: "hs-text", "aria-label": "The Text action: Value, Start Date, End Date" }, token("Value"), ",", token("Start Date"), ",", token("End Date")),
          h("p", { class: "shortcut__hint" }, "Each line reads like “Core,7 Nov 2026 at 01:05,7 Nov 2026 at 02:30”. Athena adds up the time in each stage. Where two samples overlap, it counts that time once."),
        ]
      ),
      step(
        "Send them to Athena",
        ["Add ", b("Get Contents of URL"), " after the repeat. Set the method to POST, add a header called Authorization, and set Request Body to JSON with these fields:"],
        [
          h("ul", { class: "hs-fields" }, field("steps", "Number", "Steps, grouped by day"), field("sleep_stages", "Text", "Stages, from step 3"), field("resting_hr", "Number", "Resting Heart Rate")),
          copyLine("URL", endpoint, "Address"),
          fresh ? copyLine("Authorization", `Bearer ${fresh}`, "Key") : h("p", { class: "shortcut__hint" }, "For Authorization, type “Bearer” and a space, then a capture key. Your Siri key works, or make one below."),
        ]
      ),
      step("Try it", ["Tap ", b("▶"), " to run it once. You should see “Saved health for ", yesterday(), ".”"])
    );
  }

  /** For a Shortcut set up before stages: the one change to make. */
  function upgrade(): HTMLElement {
    const show = h("button", { class: "btn btn--soft btn--sm hs-upgrade__go", type: "button" }, "Show step 3");
    show.addEventListener("click", () => {
      const setup = root.querySelector<HTMLDetailsElement>(".hs-setup");
      if (setup) setup.open = true;
      const step = root.querySelectorAll<HTMLElement>(".hs-step")[2];
      step?.scrollIntoView({ behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth", block: "start" });
      step?.classList.add("hs-step--flash");
      setTimeout(() => step?.classList.remove("hs-step--flash"), 1600);
    });
    return h(
      "p",
      { class: "card hs-upgrade", role: "note" },
      icons.sparkle(),
      h(
        "span",
        { class: "hs-upgrade__body" },
        h("span", {}, h("strong", {}, "Your Shortcut needs one change for sleep. "), "Add step 3, then in Get Contents of URL swap ", h("code", { class: "prop__mono" }, "sleep_minutes"), " for ", h("code", { class: "prop__mono" }, "sleep_stages"), ". Then Athena can show deep, core and REM sleep."),
        show
      )
    );
  }

  function yesterday(): string {
    return status ? dayName(addDays(status.today, -1)) : "yesterday";
  }

  /** Workouts are a few more actions, so they're folded away. */
  function workouts(): HTMLElement {
    const b = (s: string) => h("strong", {}, s);
    return h(
      "details",
      { class: "card hs-more" },
      h("summary", { class: "hs-more__summary" }, h("span", {}, "Add workouts too"), icons.chevronDown()),
      h(
        "div",
        { class: "hs-more__body" },
        h("p", {}, "If Strava has the same workout, you still get one line: Strava adds its name, climb and route."),
        h(
          "ol",
          { class: "hs-more__steps" },
          h("li", {}, "Add ", b("Find Health Samples"), " for ", b("Workouts"), ", Start Date is yesterday."),
          h("li", {}, "Add ", b("Repeat with Each"), ". Inside it, add a ", b("Dictionary"), " with type (the workout's type), minutes, distance_m and start (its Start Date, through ", b("Format Date"), " set to Custom, HH:mm), then ", b("Add to Variable"), " called Workouts."),
          h("li", {}, "In Get Contents of URL, add an Array field called ", h("code", { class: "prop__mono" }, "workouts"), " set to Workouts.")
        )
      )
    );
  }

  /**
   * Food, drink and mind: more actions again, folded. Every field goes as
   * Text so its unit comes too (water in L or ml, energy in kcal or kJ), and
   * samples go as they are: Athena adds them up and takes the latest time.
   * State of Mind only if the phone lists it (iOS 18).
   */
  function foodAndMind(): HTMLElement {
    const b = (s: string) => h("strong", {}, s);
    const code = (s: string) => h("code", { class: "prop__mono" }, s);
    return h(
      "details",
      { class: "card hs-more hs-food" },
      h("summary", { class: "hs-more__summary" }, h("span", {}, "Add food, drink and mind"), icons.chevronDown()),
      h(
        "div",
        { class: "hs-more__body" },
        h("p", {}, "MyFitnessPal, Cronometer, MacroFactor, Lose It!, Yazio, Headspace and Calm all write to Apple Health, so this brings them in too. Your Body block gets a Food and drink line, and mindful minutes show beside your mood."),
        h(
          "ol",
          { class: "hs-more__steps" },
          h("li", {}, "Add ", b("Find Health Samples"), " for each of ", b("Dietary Energy"), ", ", b("Protein"), ", ", b("Carbohydrates"), ", ", b("Total Fat"), ", ", b("Water"), ", ", b("Caffeine"), ", ", b("Alcoholic Beverages"), " and ", b("Mindful Minutes"), ", each with Start Date is yesterday. Leave Group By off: Athena adds the samples up."),
          h("li", {}, "In Get Contents of URL, add these as ", b("Text"), " fields, so each value keeps its unit:"),
        ),
        h(
          "ul",
          { class: "hs-fields" },
          field("kcal", "Text", "Dietary Energy"),
          field("last_meal", "Text", "Dietary Energy, then tap it and pick Start Date"),
          field("protein_g", "Text", "Protein"),
          field("carbs_g", "Text", "Carbohydrates"),
          field("fat_g", "Text", "Total Fat"),
          field("water_ml", "Text", "Water"),
          field("caffeine_mg", "Text", "Caffeine"),
          field("caffeine_times", "Text", "Caffeine, then tap it and pick Start Date"),
          field("alcohol_drinks", "Text", "Alcoholic Beverages"),
          field("mindful_minutes", "Text", "Mindful Minutes, then tap it and pick Duration")
        ),
        h("p", { class: "shortcut__hint" }, "From the times, Athena works out your last coffee, how much caffeine you had after 2pm, and when you last ate. If Alcoholic Beverages isn't in Find Health Samples' list, leave alcohol_drinks out: Oura's alcohol tags can send drinks instead."),
        h("p", { class: "hs-food__som" }, b("State of Mind, if you log it. "), "If ", b("State of Mind"), " is in Find Health Samples' list, find it with Start Date is yesterday, then add ", code("mood_valence"), " (its Valence) and ", code("mood_labels"), " (its Labels) as Text. If it isn't listed, skip this. A mood you set in Athena always comes first: State of Mind only fills a day you left blank, marked “from Health”.")
      )
    );
  }

  function paint() {
    const done = working();
    const trends = lastTwoWeeks();
    const makeBtn = h("button", { class: `btn ${fresh || done ? "btn--soft" : "btn--primary"}`, type: "button" }, icons.plus(), fresh ? "Make another key" : "Make a key") as HTMLButtonElement;
    makeBtn.addEventListener("click", () => void make(makeBtn));
    const manage = h("button", { class: "settings__link", type: "button" }, "API keys");
    manage.addEventListener("click", () => opts.manageKeys());
    const open = root.querySelector<HTMLDetailsElement>(".hs-more:not(.hs-setup):not(.hs-food)")?.open ?? false;
    const foodOpen = root.querySelector<HTMLDetailsElement>(".hs-food")?.open ?? false;
    const setupOpen = root.querySelector<HTMLDetailsElement>(".hs-setup")?.open ?? false;
    root.replaceChildren(
      ...[
        // Once days arrive, what came in leads and the setup folds away.
        done && trends ? null : preview(),
        trends,
        fresh ? freshKeyCard(fresh) : null,
        status?.sources.some((x) => x.source === "apple_health") && !hasStages ? upgrade() : null,
        done && !fresh
          ? h(
              "details",
              { class: "card hs-more hs-setup" },
              h("summary", { class: "hs-more__summary" }, h("span", {}, "Shortcut steps"), icons.chevronDown()),
              h("div", { class: "hs-setup__body" }, steps(), workouts(), foodAndMind())
            )
          : h("section", { class: "group" }, h("div", { class: "group__head" }, h("h2", { class: "group__label" }, "Set up the automation")), steps()),
        done && !fresh ? null : workouts(),
        done && !fresh ? null : foodAndMind(),
        h("div", { class: "shortcut__actions" }, makeBtn),
        h("p", { class: "shortcut__manage hs-manage" }, icons.shield(), h("span", {}, "Your figures are stored encrypted and only shown to you. See and remove keys in ", manage, ".")),
      ].filter((x): x is HTMLElement => !!x)
    );
    const more = root.querySelector<HTMLDetailsElement>(".hs-more:not(.hs-setup):not(.hs-food)");
    if (more) more.open = open;
    const food = root.querySelector<HTMLDetailsElement>(".hs-food");
    if (food) food.open = foodOpen;
    const setup = root.querySelector<HTMLDetailsElement>(".hs-setup");
    if (setup) setup.open = setupOpen;
  }

  paint();
  void load();
  return root;
}

/** The whole From your iPhone page: Siri and sharing, or Health. */
export function iphoneSection(siri: HTMLElement, health: () => HTMLElement, habits?: () => HTMLElement, save?: () => HTMLElement): { el: HTMLElement; lede: HTMLElement } {
  const LEDES = {
    siri: "Tell Siri, or share a link from any app, and Athena files it the way Ask does: a to-do, a reminder, a gift idea, a film to watch. It replies with what it did. If it isn't sure, it saves it to your notes to sort later.",
    save: "Share a page, a photo or some text to Athena from any app and it's kept in Saved, with a readable copy of the page and its picture. It shows on the day you saved it.",
    habits: "Say “Hey Siri, log a habit” and the habit's name, and Athena ticks it for today, or adds to its target. It works for the habits you made in Athena.",
    health: "Each morning your iPhone sends Athena yesterday's sleep, split into stages, plus steps and resting heart rate from Apple Health. Each day gets one line. If you like, it can send what you ate and drank and your mindful minutes too.",
  };
  type Tab = "siri" | "save" | "health" | "habits";
  const ids: Tab[] = ["siri", ...(save ? (["save"] as const) : []), "health", ...(habits ? (["habits"] as const) : [])];
  let tab: Tab = location.hash.includes("tab=health") ? "health" : habits && location.hash.includes("tab=habits") ? "habits" : save && location.hash.includes("tab=save") ? "save" : "siri";
  let saveEl: HTMLElement | null = null;
  let healthEl: HTMLElement | null = null;
  let habitsEl: HTMLElement | null = null;
  const TAB_LABEL: Record<Tab, string> = { siri: habits ? "Capture" : "Siri and sharing", save: "Save", health: "Health", habits: "Habits" };
  const lede = h("p", { class: "settings__lede" });
  const body = h("div", { class: "hs-tabpanel", role: "tabpanel" });
  const seg = h("div", { class: "seg hs-tabs", role: "tablist", "aria-label": "Shortcut" });
  const buttons = ids.map((id) => {
    const b = h("button", { class: "seg__item", type: "button", role: "tab", id: `hs-tab-${id}` }, TAB_LABEL[id]);
    b.addEventListener("click", () => {
      tab = id;
      paint();
    });
    return b;
  });
  seg.append(...buttons);
  function paint() {
    for (const b of buttons) {
      const on = b.id === `hs-tab-${tab}`;
      b.setAttribute("aria-selected", String(on));
      b.setAttribute("aria-checked", String(on));
      b.tabIndex = on ? 0 : -1;
    }
    body.setAttribute("aria-labelledby", `hs-tab-${tab}`);
    lede.textContent = LEDES[tab];
    body.replaceChildren(tab === "siri" ? siri : tab === "save" ? (saveEl ??= save!()) : tab === "health" ? (healthEl ??= health()) : (habitsEl ??= habits!()));
  }
  seg.addEventListener("keydown", (e) => {
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
    tab = ids[(ids.indexOf(tab) + (e.key === "ArrowRight" ? 1 : ids.length - 1)) % ids.length];
    paint();
    buttons.find((b) => b.id === `hs-tab-${tab}`)?.focus();
  });
  paint();
  return { el: h("div", { class: "hs-page" }, seg, body), lede };
}
