/**
 * Start or edit a collection.
 *
 *  1. Pick a recipe: one line each, with the accounts ready for it, or the
 *     kind of account it needs.
 *  2. The form is a sentence, like a Shortcuts automation:
 *     "Every [morning] at [07:15], read [Personal Gmail] and file it under [personal]."
 *     Each blue word is a picker. Under it, what it saves and what it never
 *     does, then "More options" (how far back, upcoming events, extra
 *     instructions, name).
 *  3. "Start and run it now" saves it and runs it once.
 *
 * `init` is an existing collection (edit), a starting point from elsewhere
 * (`{ recipe, connectorIds?, label? }`, e.g. the connected sheet), or null
 * for the recipe picker.
 *
 * Built only with h() and text nodes.
 */

import "../styles/collections.css";
import { h } from "../lib/dom";
import { icons } from "./icons";
import { openSheet, type SheetHandle } from "./sheet";
import { showToast } from "./toast";
import { connectorLogo } from "./brand-logo";
import { runCollection, saveCollection } from "../db/api";
import { errorText, RECIPE_ICON, serviceLabel } from "../lib/connectors-ui";
import {
  accountProblem,
  andList,
  clock,
  collectionTitle,
  dayPart,
  fits,
  needsAccountLine,
  readyAccounts,
  recipeLine,
  recipeOf,
  servicesFor,
  timeFor,
  whatItSaves,
  whenPhrase,
  type DayPart,
} from "../lib/collection-words";
import { RECIPES, collectionSource } from "../../../lib/connector-presets";
import type { Collection, Connector, ConnectorsState, RecipeId } from "../types";

export type CollectionInit = Collection | { recipe: RecipeId; connectorIds?: string[]; label?: string };

export interface CollectionFormOptions {
  /** Open "Add an account", filtered to the services that feed a recipe. Slice A wires it in. */
  addAccount?: (filter: { recipe: RecipeId }) => void;
}

const isExisting = (init: CollectionInit | null): init is Collection => !!init && "id" in init;

let seq = 0;
const uid = (p: string) => `${p}-${++seq}`;

export function openCollectionForm(
  state: ConnectorsState,
  init: CollectionInit | null,
  done: (saved?: Collection) => void,
  opts: CollectionFormOptions = {},
): void {
  const body = h("div", { class: "cl" });
  const existing = isExisting(init) ? init : null;
  const title = existing ? `Edit ${collectionTitle(existing)}` : init ? recipeOf(init.recipe).label : "Start collecting";
  const sheet = openSheet({ label: title, title, body, variant: "tall" });
  if (init) showForm(sheet, body, state, init, done, opts, false);
  else showRecipes(sheet, body, state, done, opts);
}

// ---------- 1. Recipes ----------

function showRecipes(sheet: SheetHandle, body: HTMLElement, state: ConnectorsState, done: (saved?: Collection) => void, opts: CollectionFormOptions) {
  sheet.setTitle("Start collecting");
  sheet.setBack(null);

  const card = (id: RecipeId) => {
    const ready = readyAccounts(state.connectors, id);
    const broken = state.connectors.filter((c) => c.status !== "connected" && fits(c, id) && id !== "custom");
    let meta: HTMLElement | null;
    if (id === "custom") meta = h("span", { class: "cl-recipe__meta" }, "Works with any account");
    else if (ready.length) {
      const more = ready.length - 1;
      meta = h("span", { class: "cl-recipe__meta cl-recipe__meta--ready" }, icons.check(), `Ready: ${ready[0].name}${more ? ` and ${more} more` : ""}`);
    } else if (broken.length) meta = h("span", { class: "cl-recipe__meta cl-recipe__meta--warn" }, accountProblem(broken[0]));
    else meta = h("span", { class: "cl-recipe__meta" }, needsAccountLine(id) ?? "No service feeds it yet");

    const b = h(
      "button",
      { class: "cl-recipe", type: "button" },
      h("span", { class: `cl-tile cl-tile--${id}` }, icons[RECIPE_ICON[id]]()),
      h(
        "span",
        { class: "cl-recipe__body" },
        h("span", { class: "cl-recipe__name" }, recipeOf(id).label),
        h("span", { class: "cl-recipe__line" }, recipeLine(id)),
        meta,
      ),
      h("span", { class: "cl-recipe__chev", "aria-hidden": "true" }, icons.chevronRight()),
    );
    b.addEventListener("click", () => showForm(sheet, body, state, { recipe: id }, done, opts, true));
    return b;
  };

  body.replaceChildren(
    h("p", { class: "cl-lede" }, "What should Athena save for you? It reads your accounts and writes short notes. It never sends, edits or deletes."),
    h("div", { class: "cl-recipes" }, ...RECIPES.map((r) => card(r.id))),
  );
  body.closest(".sheet__scroll")?.scrollTo({ top: 0 });
}

// ---------- 2. The sentence ----------

/** A blue word that opens a native picker laid over it, so phones get their own wheel. */
function pick(text: HTMLElement, control: HTMLSelectElement | HTMLInputElement, cls = ""): HTMLElement {
  control.classList.add("cl-pick__native");
  return h("label", { class: `cl-pick ${cls}`.trim() }, text, h("span", { class: "cl-pick__caret", "aria-hidden": "true" }, icons.chevronDown()), control);
}

type When = DayPart | `h${number}` | "manual";
const HOURS = [1, 2, 3, 4, 6, 8, 12];

function showForm(
  sheet: SheetHandle,
  body: HTMLElement,
  state: ConnectorsState,
  init: CollectionInit,
  done: (saved?: Collection) => void,
  opts: CollectionFormOptions,
  fromPicker: boolean,
) {
  const existing = isExisting(init) ? init : null;
  const recipeId = init.recipe;
  const recipe = recipeOf(recipeId);
  sheet.setTitle(existing ? `Edit ${collectionTitle(existing)}` : recipe.label);
  sheet.setBack(fromPicker ? () => showRecipes(sheet, body, state, done, opts) : null);

  // ----- Accounts: fitting and connected first; the rest behind "Show other accounts". -----
  const fitting = state.connectors.filter((c) => fits(c, recipeId));
  const others = state.connectors.filter((c) => !fits(c, recipeId));
  const rank = (c: Connector) => (c.status === "connected" ? 0 : 1);
  fitting.sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name));
  others.sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name));
  const ready = readyAccounts(state.connectors, recipeId);

  const chosen = new Set<string>(
    existing
      ? existing.connector_ids
      : "connectorIds" in init && init.connectorIds?.length
        ? init.connectorIds
        : (() => {
            // One account to start with: a ready one no other collection of this recipe reads yet.
            const used = new Set(state.collections.filter((c) => c.recipe === recipeId).flatMap((c) => c.connector_ids));
            const first = ready.find((c) => !used.has(c.id)) ?? ready[0];
            return first ? [first.id] : [];
          })(),
  );
  const ordered = () => [...fitting, ...others].filter((c) => chosen.has(c.id));

  // ----- When -----
  let runAt = existing?.run_at?.slice(0, 5) ?? recipe.defaultTime;
  // Your activity, Your work, counted, Home and Calendar are hourly unless you say otherwise (media-sync.ts, work-sync.ts, home-run.ts, calendar-sync.ts).
  let when: When = existing?.schedule === "manual" ? "manual" : existing?.schedule === "hourly" ? `h${existing.every_hours ?? 6}` : !existing && (recipeId === "plays-watches" || recipeId === "work-sync" || recipeId === "home" || recipeId === "calendar-sync") ? "h1" : dayPart(runAt);
  const hoursList =
    existing?.schedule === "hourly" && existing.every_hours && !HOURS.includes(existing.every_hours)
      ? [...HOURS, existing.every_hours].sort((a, b) => a - b)
      : HOURS;

  const whenSelect = h(
    "select",
    { "aria-label": "How often" },
    h("optgroup", { label: "Once a day" }, ...(["morning", "afternoon", "evening", "night"] as DayPart[]).map((p) => h("option", { value: p }, `Every ${p}`))),
    h("optgroup", { label: "During the day" }, ...hoursList.map((n) => h("option", { value: `h${n}` }, n === 1 ? "Every hour" : `Every ${n} hours`))),
    h("option", { value: "manual" }, "Only when I run it"),
  ) as HTMLSelectElement;
  const whenText = h("span", { class: "cl-pick__text" });
  const timeInput = h("input", {
    type: "time",
    "aria-label": "At what time",
    step: "300",
  }) as HTMLInputElement;
  timeInput.value = runAt;
  const timeText = h("span", { class: "cl-pick__text" });
  const timePick = pick(timeText, timeInput, "cl-pick--time");
  // Desktop browsers don't open a time picker on click by themselves.
  timeInput.addEventListener("click", () => {
    try {
      timeInput.showPicker?.();
    } catch {
      /* not allowed here; typing still works */
    }
  });

  // ----- Accounts pill and panel -----
  const acctText = h("span", { class: "cl-pick__text" });
  const panelId = uid("cl-accounts");
  const acctPill = h(
    "button",
    {
      class: "cl-pick cl-pick--button",
      type: "button",
      "aria-expanded": "false",
      "aria-controls": panelId,
    },
    acctText,
    h("span", { class: "cl-pick__caret", "aria-hidden": "true" }, icons.chevronDown()),
  ) as HTMLButtonElement;

  // ----- Label -----
  const labelInput = h("input", {
    type: "text",
    "aria-label": "File it under",
    placeholder: "a label",
    autocomplete: "off",
    autocapitalize: "off",
    spellcheck: "false",
    maxlength: "30",
  }) as HTMLInputElement;
  const initialLabel = existing?.label ?? ("label" in init && init.label ? init.label : (ordered()[0]?.account_label ?? ""));
  labelInput.value = initialLabel;
  let labelTouched = !!existing || ("label" in init && !!init.label);
  const sizeLabel = () => labelInput.setAttribute("size", String(Math.max(3, (labelInput.value || labelInput.placeholder).length)));
  labelInput.addEventListener("input", () => {
    labelTouched = true;
    sizeLabel();
    paint();
  });
  sizeLabel();
  const labelPick = h("label", { class: "cl-pick cl-pick--input" }, labelInput);

  // Custom: what to look for is the heart of it, so it sits in the sentence card.
  const nameInput = h("input", {
    class: "prop__input",
    type: "text",
    autocomplete: "off",
    placeholder: "",
    maxlength: "60",
    autocapitalize: "words",
  }) as HTMLInputElement;
  nameInput.id = uid("cl-name");
  nameInput.value = existing?.name ?? "";
  let nameTouched = !!existing && existing.name !== defaultName(existing.recipe, existing.label);
  nameInput.addEventListener("input", () => {
    nameTouched = true;
    paint();
  });
  const instructions = h("textarea", {
    class: "cl-textarea",
    rows: recipeId === "custom" ? "4" : "3",
    placeholder:
      recipeId === "custom" ? "For example: each Friday's invoices, with who sent them and when they're due" : "For example: skip newsletters from shops",
  }) as HTMLTextAreaElement;
  instructions.id = uid("cl-instr");
  instructions.value = existing?.instructions ?? "";

  // Built once and shown or hidden, so a picker keeps focus while the sentence changes around it.
  const everyWord = h("span", {}, "Every ");
  const atWord = h("span", {}, " at ");
  const sentence = h(
    "div",
    { class: "cl-sentence", role: "group", "aria-label": "What it does" },
    h(
      "p",
      { class: "cl-sentence__line" },
      everyWord,
      pick(whenText, whenSelect, "cl-pick--when"),
      atWord,
      timePick,
      h("span", {}, ", read "),
      acctPill,
      h("span", {}, " and file it under "),
      labelPick,
      h("span", {}, "."),
    ),
  );
  const sentenceHint = h("p", { class: "cl-sentence__hint" });

  // ----- The account list -----
  let showOthers = others.some((c) => chosen.has(c.id));
  const panel = h("div", { class: "cl-accounts", id: panelId, hidden: true });
  function accountRow(c: Connector): HTMLElement {
    const box = h("input", {
      type: "checkbox",
      class: "cl-check",
      "aria-label": c.name,
    }) as HTMLInputElement;
    box.checked = chosen.has(c.id);
    box.addEventListener("change", () => {
      if (box.checked) chosen.add(c.id);
      else chosen.delete(c.id);
      if (!labelTouched) {
        labelInput.value = ordered()[0]?.account_label ?? "";
        sizeLabel();
      }
      error.textContent = "";
      paint();
    });
    const bad = c.status !== "connected";
    return h(
      "label",
      { class: `cl-account${bad ? " cl-account--warn" : ""}` },
      connectorLogo(c, "sm"),
      h(
        "span",
        { class: "cl-account__body" },
        h("span", { class: "cl-account__name" }, c.name),
        h(
          "span",
          { class: "cl-account__meta" },
          bad
            ? accountProblem(c)
                .replace(`${c.name}'s `, "")
                .replace(`${c.name} `, "")
                .replace(/^is /, "")
                .replace(/^./, (s) => s.toUpperCase())
            : [serviceLabel(c), c.account_label].filter(Boolean).join(" · "),
        ),
      ),
      box,
    );
  }
  function paintPanel() {
    const rows = [...fitting.map(accountRow)];
    const otherBtn =
      others.length && !showOthers
        ? (() => {
            const b = h("button", { class: "cl-link cl-accounts__more", type: "button" }, `Show other accounts (${others.length})`);
            b.addEventListener("click", () => {
              showOthers = true;
              paintPanel();
            });
            return b;
          })()
        : null;
    panel.replaceChildren(
      ...[
        rows.length ? h("div", { class: "cl-accounts__list" }, ...rows) : null,
        showOthers && others.length
          ? h(
              "div",
              { class: "cl-accounts__others" },
              h("p", { class: "cl-accounts__note" }, `These aren't usual for ${recipe.label}. It reads them if you choose them.`),
              h("div", { class: "cl-accounts__list" }, ...others.map(accountRow)),
            )
          : null,
        otherBtn,
      ].filter((x): x is HTMLDivElement | HTMLButtonElement => !!x),
    );
  }
  function setPanel(open: boolean) {
    panel.hidden = !open;
    acctPill.setAttribute("aria-expanded", String(open));
  }
  acctPill.addEventListener("click", () => setPanel(panel.hidden));

  // ----- No account fits (Life log with nothing connected yet) -----
  const needsBox = (() => {
    if (fitting.length || recipeId === "custom") return null;
    const names = servicesFor(recipeId);
    const shown = names.slice(0, 4);
    const more = names.length - shown.length;
    const add = opts.addAccount
      ? (() => {
          const b = h("button", { class: "btn btn--primary btn--sm", type: "button" }, icons.plus(), "Add an account");
          b.addEventListener("click", () => {
            sheet.close();
            opts.addAccount!({ recipe: recipeId });
          });
          return b;
        })()
      : null;
    return h(
      "div",
      { class: "cl-needs" },
      h("span", { class: "cl-needs__icon" }, icons.plug()),
      h(
        "div",
        { class: "cl-needs__body" },
        h("p", { class: "cl-needs__title" }, `${recipe.label} needs an account`),
        h(
          "p",
          { class: "cl-needs__sub" },
          names.length
            ? `It reads ${andList(more ? [...shown, `${more} more`] : shown)}. Connect one and it starts filling in.`
            : `No service feeds it yet. Once one does, you'll find it under Add an account.`,
        ),
        add,
      ),
    );
  })();

  // ----- What it saves -----
  const savesCard = h("div", { class: "card cl-saves" });
  function paintSaves() {
    const s = whatItSaves(recipeId, aheadDays);
    savesCard.replaceChildren(
      ...s.saves.map((l) =>
        h(
          "div",
          { class: "cl-saves__row" },
          h(
            "span",
            {
              class: "cl-saves__mark cl-saves__mark--yes",
              "aria-hidden": "true",
            },
            icons.check(),
          ),
          h("span", { class: "cl-saves__text" }, h("span", { class: "cl-saves__title" }, l.title), h("span", { class: "cl-saves__sub" }, l.sub)),
        ),
      ),
      h(
        "div",
        { class: "cl-saves__row cl-saves__row--never" },
        h("span", { class: "cl-saves__mark cl-saves__mark--no", "aria-hidden": "true" }, icons.close()),
        h("span", { class: "cl-saves__text" }, h("span", { class: "cl-saves__title" }, s.never.title), h("span", { class: "cl-saves__sub" }, s.never.sub)),
      ),
    );
  }

  // ----- More options -----
  const LOOKBACK: Array<[number, string]> = [
    [12, "12 hours"],
    [24, "A day"],
    [36, "A day and a half"],
    [48, "2 days"],
    [72, "3 days"],
    [168, "A week"],
  ];
  const lookbackNow = existing?.lookback_hours ?? 36;
  if (!LOOKBACK.some(([v]) => v === lookbackNow)) LOOKBACK.push([lookbackNow, `${lookbackNow} hours`]);
  const lookback = h(
    "select",
    { class: "prop__input prop__select" },
    ...LOOKBACK.sort((a, b) => a[0] - b[0]).map(([v, l]) => h("option", { value: String(v) }, l)),
  ) as HTMLSelectElement;
  lookback.id = uid("cl-back");
  lookback.value = String(lookbackNow);

  // Calendar is only the upcoming events (calendar-sync.ts): no look-back, no instructions, and never off.
  const calendarOnly = recipeId === "calendar-sync";
  const syncsEvents = recipeId === "calendar-meetings" || recipeId === "custom" || calendarOnly;
  let aheadDays = existing ? existing.lookahead_days : recipeId === "calendar-meetings" || calendarOnly ? 14 : 0;
  const AHEAD: Array<[number, string]> = [
    ...(calendarOnly ? [] : ([[0, "Off"]] as Array<[number, string]>)),
    [7, "Next 7 days"],
    [14, "Next 14 days"],
    [30, "Next 30 days"],
  ];
  if (!AHEAD.some(([d]) => d === aheadDays)) AHEAD.push([aheadDays, `Next ${aheadDays} days`]);
  const ahead = h("select", { class: "prop__input prop__select" }, ...AHEAD.map(([d, l]) => h("option", { value: String(d) }, l))) as HTMLSelectElement;
  ahead.id = uid("cl-ahead");
  ahead.value = String(aheadDays);
  const remind = h("input", {
    type: "checkbox",
    role: "switch",
    class: "switch",
    "aria-label": "Remind me 30 minutes before each event",
  }) as HTMLInputElement;
  remind.checked = existing?.event_push ?? false;
  const remindRow = h(
    "div",
    { class: "prop prop--fact" },
    h("span", { class: "prop__label" }, "Remind me"),
    h("span", { class: "prop__value prop__value--control" }, h("span", { class: "row__meta" }, "30 min before each"), remind),
  );
  ahead.addEventListener("change", () => {
    aheadDays = Number(ahead.value);
    remindRow.hidden = aheadDays === 0;
    paintSaves();
  });
  remindRow.hidden = aheadDays === 0;

  // Calendar collections: skip a run when nothing happened or changed since the last one (precheck.ts). On by default.
  const quietFits = recipeId === "calendar-meetings";
  const skipQuiet = h("input", { type: "checkbox", role: "switch", class: "switch", "aria-label": "Skip days with nothing new" }) as HTMLInputElement;
  skipQuiet.checked = existing?.skip_quiet ?? true;
  const quietRow = h(
    "div",
    { class: "prop prop--fact" },
    h("span", { class: "prop__label" }, "Quiet days"),
    h("span", { class: "prop__value prop__value--control" }, h("span", { class: "row__meta" }, "Skip days with nothing new"), skipQuiet),
  );

  const row = (label: string, control: HTMLElement) =>
    h("div", { class: "prop" }, h("label", { class: "prop__label", for: control.id }, label), h("span", { class: "prop__control" }, control));
  const more = h(
    "details",
    { class: "cl-more" },
    h(
      "summary",
      { class: "cl-more__summary" },
      h("span", { class: "cl-more__title" }, "More options"),
      h("span", { class: "cl-more__sub" }, moreSummary()),
      h("span", { class: "cl-more__chev", "aria-hidden": "true" }, icons.chevronDown()),
    ),
    h(
      "div",
      { class: "cl-more__body" },
      calendarOnly ? null : h("div", { class: "card card--flush fields" }, row("How far back", lookback)),
      calendarOnly
        ? null
        : h(
            "p",
            { class: "form__hint" },
            "Runs overlap a little, so nothing is missed or saved twice.",
          ),
      syncsEvents ? h("div", { class: "card card--flush fields" }, row("Upcoming events", ahead), remindRow) : null,
      syncsEvents
        ? h(
            "p",
            { class: "form__hint" },
            calendarOnly
              ? "Adds what's coming up to Coming up and your morning briefing. Moved events update and cancelled ones disappear. Athena reads your calendar itself: none of it goes to the AI."
              : "Adds what's coming up to Coming up and your morning briefing. Moved events update and cancelled ones disappear.",
          )
        : null,
      quietFits ? h("div", { class: "card card--flush fields" }, quietRow) : null,
      quietFits ? h("p", { class: "form__hint" }, "Athena looks first and only starts when there's a meeting or a change to save.") : null,
      recipeId === "custom" || calendarOnly
        ? null
        : h("div", { class: "cl-field" }, h("label", { class: "cl-field__label", for: instructions.id }, "Extra instructions"), instructions),
      recipeId === "custom" ? null : h("div", { class: "card card--flush fields" }, row("Name", nameInput)),
    ),
  );
  function moreSummary(): string {
    return recipeId === "custom"
      ? "How far back"
      : calendarOnly
        ? "Upcoming events, name"
        : syncsEvents
        ? `How far back, upcoming events, ${quietFits ? "quiet days, " : ""}extra instructions, name`
        : "How far back, extra instructions, name";
  }

  // ----- Submit -----
  const error = h("p", { class: "form__error", role: "alert" });
  const submit = h(
    "button",
    { class: "btn btn--primary btn--block cl-submit", type: "submit" },
    existing ? "Save changes" : "Start and run it now",
  ) as HTMLButtonElement;
  const foot = h("p", { class: "cl-foot" });

  function label(): string {
    return labelInput.value.trim().toLowerCase();
  }
  function payloadName(): string {
    return nameInput.value.trim() || defaultName(recipeId, label());
  }

  function paint() {
    // Sentence words
    const w = when;
    whenSelect.value = w;
    if (w === "manual") whenText.textContent = "Only when I run it";
    else if (w.startsWith("h")) {
      const n = Number(w.slice(1));
      whenText.textContent = n === 1 ? "hour" : `${n} hours`;
    } else whenText.textContent = w;
    timeText.textContent = clock(runAt);
    const acc = ordered();
    acctText.textContent = acc.length
      ? acc.length === 1
        ? acc[0].name
        : acc.length === 2
          ? `${acc[0].name} and ${acc[1].name}`
          : `${acc[0].name} and ${acc.length - 1} more`
      : "choose an account";
    acctPill.classList.toggle("cl-pick--empty", !acc.length);
    const brokenChosen = acc.filter((c) => c.status !== "connected");
    acctPill.classList.toggle("cl-pick--warn", brokenChosen.length > 0);

    everyWord.hidden = w === "manual";
    atWord.hidden = timePick.hidden = w === "manual" || w.startsWith("h");
    sentenceHint.textContent =
      brokenChosen.length > 0
        ? `${accountProblem(brokenChosen[0])}. It's skipped until you fix that.`
        : w === "manual"
          ? "It runs only when you tap Run now."
          : "Times follow you when you travel.";
    sentenceHint.classList.toggle("cl-sentence__hint--warn", brokenChosen.length > 0);

    // Name and filing
    if (!nameTouched) nameInput.value = "";
    nameInput.placeholder = defaultName(recipeId, label());
    const source = collectionSource(recipeId, payloadName(), label());
    if (existing && existing.source !== source) {
      foot.textContent = `New notes go under “${source}”. Ones it already saved stay under “${existing.source}”.`;
    } else
      foot.textContent = existing
        ? ""
        : when === "manual"
          ? "The first run takes a minute or two. You'll see what it saved here."
          : `The first run takes a minute or two. After that it runs ${whenPhrase(schedulePayload())
              .replace(/^Every/, "every")
              .replace(/^Once/, "once")}.`;

    const blocked = (!fitting.length && !others.length) || (!!needsBox && !acc.length);
    submit.disabled = blocked;
    if (blocked && !existing) foot.textContent = "Connect an account first, then start it here.";
  }

  whenSelect.addEventListener("change", () => {
    when = whenSelect.value as When;
    if (!when.startsWith("h") && when !== "manual") runAt = timeFor(when as DayPart, runAt, recipe.defaultTime);
    timeInput.value = runAt;
    paint();
  });
  timeInput.addEventListener("input", () => {
    if (!timeInput.value) return;
    runAt = timeInput.value.slice(0, 5);
    when = dayPart(runAt);
    paint();
  });

  function schedulePayload(): Pick<Collection, "schedule" | "run_at" | "every_hours"> {
    if (when === "manual") return { schedule: "manual", run_at: null, every_hours: null };
    if (when.startsWith("h"))
      return {
        schedule: "hourly",
        run_at: null,
        every_hours: Number(when.slice(1)),
      };
    return { schedule: "daily", run_at: runAt, every_hours: null };
  }

  const form = h(
    "form",
    { class: "cl-form", novalidate: true },
    fromPicker || existing
      ? null
      : h(
          "div",
          { class: "cl-formhead" },
          h("span", { class: `cl-tile cl-tile--${recipeId}` }, icons[RECIPE_ICON[recipeId]]()),
          h("p", { class: "cl-formhead__line" }, recipeLine(recipeId)),
        ),
    needsBox,
    h("div", { class: "card cl-sentence-card" }, sentence, panel, sentenceHint),
    recipeId === "custom"
      ? h(
          "section",
          { class: "group" },
          h("label", { class: "group__label", for: instructions.id }, "What to look for"),
          h("div", { class: "card cl-instructions" }, instructions),
          h("div", { class: "card card--flush fields" }, row("Name", nameInput)),
        )
      : null,
    h("section", { class: "group" }, h("h3", { class: "group__label" }, "What it saves"), savesCard),
    more,
    error,
    submit,
    foot,
  );

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    error.textContent = "";
    const ids = ordered().map((c) => c.id);
    if (!ids.length) {
      setPanel(true);
      error.textContent = "Choose an account for it to read.";
      return;
    }
    if (recipeId === "custom" && !instructions.value.trim()) {
      instructions.focus();
      error.textContent = "Say what it should look for.";
      return;
    }
    submit.disabled = true;
    submit.textContent = existing ? "Saving…" : "Starting…";
    try {
      const saved = await saveCollection(
        {
          name: payloadName(),
          recipe: recipeId,
          connector_ids: ids,
          label: label(),
          ...schedulePayload(),
          lookback_hours: Number(lookback.value),
          lookahead_days: syncsEvents ? aheadDays : 0,
          event_push: syncsEvents && aheadDays > 0 && remind.checked,
          ...(quietFits ? { skip_quiet: skipQuiet.checked } : {}),
          instructions: instructions.value.trim(),
          // A new collection starts on; editing leaves the switch where it was.
          ...(existing ? {} : { enabled: true }),
        },
        existing?.id,
      );
      let started = false;
      if (!existing) {
        try {
          await runCollection(saved.id);
          started = true;
        } catch (err) {
          console.info("Athena: first run didn't start", err);
        }
      }
      sheet.close();
      const t = collectionTitle(saved);
      showToast(existing ? "Saved" : started ? `${t} is running` : `${t} is on. Its first run is ${whenPhrase(saved).toLowerCase()}`, {
        icon: existing ? "check" : "clock",
        timeoutMs: 5000,
      });
      done(saved);
    } catch (err) {
      error.textContent = errorText(err, "Couldn't save it. Check your connection and try again.");
      submit.disabled = false;
      submit.textContent = existing ? "Save changes" : "Start and run it now";
    }
  });

  paintPanel();
  // Nothing chosen yet but there's something to choose: show the list straight away.
  if (!chosen.size && (fitting.length || others.length) && !needsBox) setPanel(true);
  paintSaves();
  paint();
  body.replaceChildren(form);
  body.closest(".sheet__scroll")?.scrollTo({ top: 0 });
}

/** "Email digest · personal"; a custom collection with no name yet is "My collection". */
function defaultName(recipe: RecipeId, label: string): string {
  if (recipe === "custom") return label ? `My collection · ${label}` : "My collection";
  return collectionTitle({ recipe, name: "", label });
}
