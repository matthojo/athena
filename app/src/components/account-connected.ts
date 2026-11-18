/**
 * Back from a sign-in (or a key that checked out): say the account is in,
 * and offer the collection that fits it, filled in, so connecting leads
 * straight to collecting. "Turn it on" saves it with the recipe's defaults
 * and runs it once; services that feed no recipe say Ask can use them.
 *
 * Built only with h() and text nodes.
 */

import "../styles/accounts.css";
import { h } from "../lib/dom";
import { icons } from "./icons";
import { openSheet } from "./sheet";
import { showToast } from "./toast";
import { connectorLogo } from "./brand-logo";
import { calendarsGroup } from "./calendar-picker";
import { historyRow, loadsHistory } from "./history-load";
import { runCollection, saveCollection } from "../db/api";
import { errorText } from "../lib/connectors-ui";
import { activityNoun, collectionTitle, fits, whatItSaves, whenPhrase } from "../lib/collection-words";
import { directApi, presetFor, RECIPES } from "../../../lib/connector-presets";
import type { Collection, ConnectorsState, RecipeId } from "../types";

export interface ConnectedContext {
  /** Reload Sources after something changed. */
  reload?: () => void | Promise<void>;
  /** Slice C's collection form, filled in. Without it, "Change the time…" isn't offered. */
  openCollectionForm?: (init: { recipe: RecipeId; connectorIds: string[]; label: string }) => void;
  /** Open a collection's detail. */
  openCollection?: (id: string) => void;
}

/**
 * Close a sheet, then open the next one. Closing goes back in history, and a
 * sheet opened before that back lands would be closed by it.
 */
export function closeThen(close: () => void, open: () => void): void {
  let ran = false;
  const go = () => {
    if (ran) return;
    ran = true;
    window.removeEventListener("popstate", go);
    setTimeout(open);
  };
  window.addEventListener("popstate", go);
  close();
  // No history entry to go back over (already gone): open anyway.
  setTimeout(go, 400);
}

/** The question the offer asks. */
const OFFER: Record<RecipeId, string> = {
  "calendar-meetings": "Keep notes on your meetings?",
  "email-digest": "Start an email digest?",
  "work-activity": "Keep track of your work?",
  "life-log": "Start a Life log?",
  "plays-watches": "Save your activity every hour?",
  "work-sync": "Count your work every hour?",
  home: "Read it every hour?",
  custom: "Start collecting?",
};

/** "Every morning at 7:15 AM", "Every 6 hours", "When you run it" (collection-words.ts says it the same way everywhere). */
function whenText(col: Pick<Collection, "schedule" | "run_at" | "every_hours">): string {
  return col.schedule === "manual" ? "When you run it" : whenPhrase(col);
}

/** "Email digest · work". */
const titleFor = (recipe: RecipeId, label: string) => collectionTitle({ recipe, name: "", label });

/** What it can't do, said for the kind of service. */
function cantDo(provider: string): string {
  const p = presetFor(provider);
  if (p.recipes.includes("email-digest")) return "It can't send or delete anything.";
  if (p.id === "icloud-contacts") return "It can't change your contacts.";
  if (p.recipes.includes("calendar-meetings") && p.category === "email-calendar") return "It can't change your calendar.";
  return "It can't change anything there.";
}

/** A check mark that draws itself in once. */
function tick(): SVGSVGElement {
  const ns = "http://www.w3.org/2000/svg";
  const s = document.createElementNS(ns, "svg");
  s.setAttribute("viewBox", "0 0 24 24");
  s.setAttribute("class", "acct-done__tick");
  s.setAttribute("aria-hidden", "true");
  const p = document.createElementNS(ns, "path");
  p.setAttribute("d", "M6.5 12.5l3.6 3.5 7.4-8");
  s.append(p);
  return s;
}

function savesList(recipe: RecipeId, own?: Array<{ title: string; sub: string }>): HTMLElement {
  const w = { ...whatItSaves(recipe), ...(own ? { saves: own } : {}) };
  const line = (l: { title: string; sub: string }) => h("span", { class: "acct-saves__text" }, h("span", { class: "acct-saves__title" }, l.title), l.sub ? h("span", { class: "acct-saves__sub" }, l.sub) : null);
  return h(
    "ul",
    { class: "acct-saves" },
    ...w.saves.map((l) => h("li", { class: "acct-saves__item" }, h("span", { class: "acct-saves__mark" }, icons.check()), line(l))),
    h("li", { class: "acct-saves__item acct-saves__item--never" }, h("span", { class: "acct-saves__mark" }, icons.close()), line(w.never))
  );
}

export function openConnected(state: ConnectorsState, connectorId: string, ctx: ConnectedContext = {}): void {
  const offered = state.connectors.find((x) => x.id === connectorId);
  /** Accounts Athena can read by itself: Your activity beside the main offer, every hour with no Claude (media-sync.ts). */
  const playsWatchesOffer = (lead = false): HTMLElement | null => {
    if (!offered || !fits(offered, "plays-watches")) return null;
    const mine = state.collections.filter((col) => col.recipe === "plays-watches");
    const reads = mine.find((col) => col.connector_ids.includes(offered.id));
    const title = (col: Pick<Collection, "label">) => titleFor("plays-watches", col.label);
    if (reads) return h("section", { class: "acct-offer acct-offer--quiet" }, h("p", { class: "acct-offer__title" }, `${title(reads)} reads it`), h("p", { class: "acct-offer__sentence" }, `It reads ${activityNoun(offered.provider)} into your days every hour.`));
    const into = mine[0] ?? null;
    const go = h("button", { class: `btn ${lead ? "btn--primary" : "btn--soft"} btn--block`, type: "button" }, into ? "Add it" : "Turn it on") as HTMLButtonElement;
    const box = h(
      "section",
      { class: "acct-offer", "aria-labelledby": "acct-pw-title" },
      h("p", { class: "acct-offer__title", id: "acct-pw-title" }, into ? `Add it to ${title(into)}?` : OFFER["plays-watches"]),
      h("p", { class: "acct-offer__sentence" }, `Athena reads ${activityNoun(offered.provider)} on ${offered.name} straight into your days.`),
      go
    );
    go.addEventListener("click", async () => {
      go.disabled = true;
      try {
        const col = into
          ? await saveCollection({ connector_ids: [...into.connector_ids, offered.id] }, into.id)
          : await saveCollection({ name: titleFor("plays-watches", offered.account_label), recipe: "plays-watches", connector_ids: [offered.id], label: offered.account_label, schedule: "hourly", run_at: null, every_hours: 1, lookback_hours: 24, lookahead_days: 0, event_push: false, instructions: "" });
        await runCollection(col.id).catch(() => undefined);
        void ctx.reload?.();
        box.replaceChildren(h("p", { class: "acct-offer__title" }, `${title(col)} is on`), h("p", { class: "acct-offer__sentence" }, "The first check has started."));
        box.classList.add("acct-offer--on");
      } catch (err) {
        go.disabled = false;
        showToast(errorText(err, "Couldn't turn it on"), { icon: "close", timeoutMs: 6000 });
      }
    });
    return box;
  };
  /** Linear and GitHub: Your work, counted beside the main offer, every hour with no model (work-sync.ts). */
  const workSyncOffer = (): HTMLElement | null => {
    if (!offered || !presetFor(offered.provider).recipes.includes("work-sync")) return null;
    const mine = state.collections.filter((col) => col.recipe === "work-sync");
    const reads = mine.find((col) => col.connector_ids.includes(offered.id));
    const title = (col: Pick<Collection, "label">) => titleFor("work-sync", col.label);
    if (reads) return h("section", { class: "acct-offer acct-offer--quiet" }, h("p", { class: "acct-offer__title" }, `${title(reads)} reads it`), h("p", { class: "acct-offer__sentence" }, "Your issues and pull requests are counted every hour, on the Work page."));
    const into = mine[0] ?? null;
    const go = h("button", { class: "btn btn--soft btn--block", type: "button" }, into ? "Add it" : "Turn it on") as HTMLButtonElement;
    const box = h(
      "section",
      { class: "acct-offer", "aria-labelledby": "acct-ws-title" },
      h("p", { class: "acct-offer__title", id: "acct-ws-title" }, into ? `Add it to ${title(into)}?` : OFFER["work-sync"]),
      h("p", { class: "acct-offer__sentence" }, `Athena counts ${offered.provider === "github" ? "the pull requests you opened, merged and reviewed" : "the issues you closed"} on ${offered.name} for the Work page. Only your own work is kept.`),
      go
    );
    go.addEventListener("click", async () => {
      go.disabled = true;
      try {
        const col = into
          ? await saveCollection({ connector_ids: [...into.connector_ids, offered.id] }, into.id)
          : await saveCollection({ name: titleFor("work-sync", offered.account_label), recipe: "work-sync", connector_ids: [offered.id], label: offered.account_label, schedule: "hourly", run_at: null, every_hours: 1, lookback_hours: 24, lookahead_days: 0, event_push: false, instructions: "" });
        await runCollection(col.id).catch(() => undefined);
        void ctx.reload?.();
        box.replaceChildren(h("p", { class: "acct-offer__title" }, `${title(col)} is on`), h("p", { class: "acct-offer__sentence" }, "The first count has started. It reads back a year."), h("a", { class: "acct-link", href: "#/work" }, "Open the Work page"));
        box.classList.add("acct-offer--on");
      } catch (err) {
        go.disabled = false;
        showToast(errorText(err, "Couldn't turn it on"), { icon: "close", timeoutMs: 6000 });
      }
    });
    return box;
  };
  const c = state.connectors.find((x) => x.id === connectorId);
  if (!c) return;
  const preset = presetFor(c.provider);
  const recipeId = preset.recipes.find((r) => r !== "custom") ?? null;
  const recipe = recipeId ? RECIPES.find((r) => r.id === recipeId) ?? null : null;
  const sameKind = recipeId ? state.collections.filter((col) => col.recipe === recipeId) : [];
  const already = sameKind.find((col) => col.connector_ids.includes(c.id));
  // A collection for the same label already: add this account to it rather than start a second one. There's one Home, whatever the label.
  const twin = already ? null : (recipeId === "home" ? sameKind[0] : sameKind.find((col) => col.label.toLowerCase() === c.account_label.toLowerCase())) ?? null;
  // Home runs every hour, with no model (home-run.ts); the rest at the recipe's time each day.
  const hourly = recipeId === "home";
  const firstWhen = { schedule: hourly ? ("hourly" as const) : ("daily" as const), run_at: hourly ? null : recipe?.defaultTime ?? null, every_hours: hourly ? 1 : null };
  const other = already || twin ? null : sameKind[0] ?? null;

  const body = h("div", { class: "acct-done" });
  const sheet = openSheet({ label: `${c.name} is connected`, body });
  let changed = false;
  const finish = () => {
    sheet.close();
    if (changed) void ctx.reload?.();
  };

  const hero = h(
    "header",
    { class: "acct-done__hero" },
    h("div", { class: "acct-done__logo" }, connectorLogo(c, "lg"), h("span", { class: "acct-done__badge" }, tick())),
    h("h2", { class: "acct-done__title" }, `${c.name} is connected`),
    h("p", { class: "acct-done__sub" }, `Athena can read it. ${cantDo(c.provider)}`)
  );

  // An account with history: Athena is loading it already (components/history-load.ts).
  const history = loadsHistory(c.provider) ? h("div", { class: "card card--flush list hist-card" }, historyRow(c)) : null;
  const notNow = h("button", { class: "btn btn--ghost btn--block", type: "button" }, recipeId && !already && !(preset.id === "icloud-contacts" && !twin) ? "Not now" : "Done");
  notNow.addEventListener("click", finish);
  const live = h("p", { class: "visually-hidden", role: "status" });

  /** The offer swaps for this once it's on. */
  function turnedOn(col: Pick<Collection, "id" | "recipe" | "label">, added: boolean) {
    changed = true;
    const done = h("button", { class: "btn btn--primary btn--block", type: "button" }, "Done");
    done.addEventListener("click", finish);
    const see = ctx.openCollection ? h("button", { class: "acct-link", type: "button" }, "See it") : null;
    see?.addEventListener("click", () => closeThen(finish, () => ctx.openCollection!(col.id)));
    const title = titleFor(col.recipe, col.label);
    offer.replaceWith(
      h(
        "section",
        { class: "acct-offer acct-offer--on" },
        h("p", { class: "acct-offer__title" }, added ? `Added to ${title}` : `${title} is on`),
        h("p", { class: "acct-offer__sentence" }, `The first run has started. It usually takes a minute or two, and what it saves turns up in ${preset.savesTo ?? "Notes"}.`),
        see
      )
    );
    notNow.replaceWith(done);
    live.textContent = added ? `Added to ${title}. The first run has started.` : `${title} is on. The first run has started.`;
    done.focus();
  }

  async function run(btn: HTMLButtonElement, work: () => Promise<Collection>, added: boolean) {
    btn.disabled = true;
    const was = btn.textContent;
    btn.textContent = added ? "Adding…" : "Turning on…";
    try {
      const col = await work();
      // Saved either way; a run that can't start (already running, no AI yet) shouldn't undo that.
      await runCollection(col.id).catch((err) => showToast(errorText(err, "It's on, but the first run didn't start"), { icon: "clock", timeoutMs: 6000 }));
      turnedOn(col, added);
    } catch (err) {
      btn.disabled = false;
      btn.textContent = was;
      showToast(errorText(err, "Couldn't turn it on"), { icon: "close", timeoutMs: 6000 });
    }
  }

  let offer: HTMLElement;
  // Netflix: nothing to read on a schedule; what you watched comes from its file (netflix-import.ts).
  if (preset.id === "netflix") {
    hero.querySelector(".acct-done__title")!.textContent = `${c.name} is added`;
    hero.querySelector(".acct-done__sub")!.textContent = "What you've watched comes from a file you download from Netflix.";
    const go = h("button", { class: "btn btn--primary btn--block", type: "button" }, "Import it now") as HTMLButtonElement;
    go.addEventListener("click", () => closeThen(sheet.close, () => void import("./netflix-import").then((m) => m.openNetflixImport(c, () => void ctx.reload?.()))));
    notNow.textContent = "Later";
    offer = h(
      "section",
      { class: "acct-offer", "aria-labelledby": "acct-offer-title" },
      h("p", { class: "acct-offer__title", id: "acct-offer-title" }, "Import your viewing history?"),
      h("p", { class: "acct-offer__sentence" }, "It takes a few minutes. Each film and episode goes on the day you watched it, on your days and in Watch & read."),
      go
    );
    body.append(hero, offer, notNow, live);
    return;
  }
  // Live flight times (lib/presets/flights.ts): nothing to collect; Athena asks it on the day you fly.
  if (preset.live) {
    offer = h("section", { class: "acct-offer acct-offer--quiet" }, h("p", { class: "acct-offer__title" }, preset.live.added.title), h("p", { class: "acct-offer__sentence" }, preset.live.added.sentence));
    body.append(hero, offer, notNow, live);
    return;
  }
  // A service Your activity reads (media-sync.ts): that offer leads. The Life log only writes each day's line from Days, whichever accounts it has,
  // so it's offered (quietly) only when there's no Life log yet.
  if (fits(c, "plays-watches") && recipeId === "life-log" && recipe) {
    const lead = playsWatchesOffer(true);
    const lifeLogs = state.collections.filter((col) => col.recipe === "life-log");
    let lineOffer: HTMLElement | null = null;
    if (!lifeLogs.length) {
      const add = h("button", { class: "btn btn--soft btn--block", type: "button" }, "Add it") as HTMLButtonElement;
      lineOffer = h(
        "section",
        { class: "acct-offer acct-offer--quiet", "aria-labelledby": "acct-line-title" },
        h("p", { class: "acct-offer__title", id: "acct-line-title" }, "Add a line for each day?"),
        h("p", { class: "acct-offer__sentence" }, `${whenPhrase({ schedule: "daily", run_at: recipe.defaultTime, every_hours: null })}, the Agent writes one line for each day from what's in your days.`),
        add
      );
      offer = lineOffer;
      add.addEventListener("click", () =>
        void run(add, () => saveCollection({ name: titleFor("life-log", c.account_label), recipe: "life-log", connector_ids: [c.id], label: c.account_label, schedule: "daily", run_at: recipe.defaultTime, every_hours: null, lookback_hours: 36, lookahead_days: 0, event_push: false, instructions: "" }), false)
      );
    }
    if (lead && !lineOffer) notNow.textContent = "Done";
    body.append(hero, history ?? "", lead ?? "", lineOffer ?? "", notNow, live);
    return;
  }
  // Contacts only adds to a Meetings collection that's already there: on its own it has no meetings to read.
  const contactsAlone = preset.id === "icloud-contacts" && !twin && !already;
  if (!recipeId || !recipe || contactsAlone) {
    offer = h("section", { class: "acct-offer acct-offer--quiet" }, h("p", { class: "acct-offer__title" }, "Ask can use it now"), h("p", { class: "acct-offer__sentence" }, preset.id === "icloud-contacts" ? "Try asking for someone's number or birthday." : `Try asking what's new in ${preset.id === "custom" ? c.name : preset.label}.`));
  } else if (already) {
    offer = h("section", { class: "acct-offer acct-offer--quiet" }, h("p", { class: "acct-offer__title" }, `${titleFor(already.recipe, already.label)} reads it`), h("p", { class: "acct-offer__sentence" }, "Nothing else to do. It's picked up on the next run."));
  } else if (twin) {
    const add = h("button", { class: "btn btn--primary btn--block", type: "button" }, "Add it") as HTMLButtonElement;
    add.addEventListener("click", () => void run(add, () => saveCollection({ connector_ids: [...twin.connector_ids, c.id] }, twin.id), true));
    offer = h(
      "section",
      { class: "acct-offer", "aria-labelledby": "acct-offer-title" },
      h("p", { class: "acct-offer__title", id: "acct-offer-title" }, `Add it to ${titleFor(twin.recipe, twin.label)}?`),
      preset.id === "icloud-contacts"
        ? h("p", { class: "acct-offer__sentence" }, `${whenText(twin)}, it'll look up who was there in ${c.name} and add their phone, birthday and company to People.`)
        : h("p", { class: "acct-offer__sentence" }, `${whenText(twin)}, it'll read ${c.name} too, and save:`),
      preset.id === "icloud-contacts" ? null : savesList(recipeId, preset.saves),
      add
    );
  } else {
    const label = c.account_label;
    const on = h("button", { class: "btn btn--primary btn--block", type: "button" }, "Turn it on") as HTMLButtonElement;
    on.addEventListener("click", () =>
      void run(
        on,
        () =>
          saveCollection({
            name: titleFor(recipeId, hourly ? "" : label),
            recipe: recipeId,
            connector_ids: [c.id],
            label: hourly ? "" : label,
            ...firstWhen,
            lookback_hours: hourly ? 24 : 36,
            lookahead_days: recipeId === "calendar-meetings" ? 14 : 0,
            event_push: false,
            instructions: "",
          }),
        false
      )
    );
    const change = ctx.openCollectionForm ? h("button", { class: "acct-link", type: "button" }, "Change the time or what it saves") : null;
    change?.addEventListener("click", () => closeThen(sheet.close, () => ctx.openCollectionForm!({ recipe: recipeId, connectorIds: [c.id], label })));
    const addOther = other ? h("button", { class: "acct-link", type: "button" }, `Or add it to ${titleFor(other.recipe, other.label)}`) : null;
    addOther?.addEventListener("click", () => void run(addOther as HTMLButtonElement, () => saveCollection({ connector_ids: [...other!.connector_ids, c.id] }, other!.id), true));
    offer = h(
      "section",
      { class: "acct-offer", "aria-labelledby": "acct-offer-title" },
      h("p", { class: "acct-offer__title", id: "acct-offer-title" }, OFFER[recipeId]),
      h("p", { class: "acct-offer__sentence" }, `${whenPhrase(firstWhen)}, Athena reads ${c.name} and saves:`),
      savesList(recipeId, preset.saves),
      on,
      change || addOther ? h("div", { class: "acct-offer__links" }, change, addOther) : null
    );
  }

  // iCloud Calendar: choose the calendars before turning anything on (iCloud has no single main one).
  body.append(hero, history ?? "", ["google-calendar", "outlook-calendar", "icloud-calendar"].includes(c.provider) && directApi(c) ? calendarsGroup(c, { onSaved: () => (changed = true) }) : "", offer, playsWatchesOffer() ?? "", workSyncOffer() ?? "", notNow, live);
}
