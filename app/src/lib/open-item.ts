/**
 * Open what an Ask receipt points at when it isn't a page of its own: a
 * reading item, goal, life admin item, trip or purchase opens in its sheet,
 * and a field change opens Settings on that kind's fields. (Notes, people,
 * places, organisations and events go through the app's openLink as before.)
 */

import { loadAssets, loadCommitments, loadGoals, loadReading } from "../db/memory";
import { openReadingSheet } from "../views/reading";
import { openGoalSheet } from "../views/goals";
import { openAssetSheet } from "../views/admin";
import { showToast } from "../components/toast";
import { rememberFieldsKind } from "./field-meta";

/** True when it was opened (or explained) here; false to fall through to openLink. */
export async function openItem(open: { kind: string; id: string }): Promise<boolean> {
  const gone = () => showToast("That isn't available. It may be archived", { icon: "archive" });
  switch (open.kind) {
    case "fields":
      rememberFieldsKind(open.id);
      location.hash = "#/settings/fields";
      return true;
    // Mentions (athena://saved|todo|watch/<id>, or their graph names commitment and reading): Saved has its own page; a to-do and a Watch & read title open in their sheets.
    case "saved":
      location.hash = `#/saved/${encodeURIComponent(open.id)}`;
      return true;
    // A recipe Ask found or imported (lib/recipes.ts) has its own page.
    case "recipe":
      location.hash = `#/recipes/${encodeURIComponent(open.id)}`;
      return true;
    case "todo":
    case "commitment": {
      const c = (await loadCommitments()).items.find((x) => x.id === open.id);
      if (c) (await import("../components/commitment-sheet")).openCommitmentSheet(c);
      else gone();
      return true;
    }
    case "watch":
    case "reading": {
      const r = (await loadReading()).items.find((x) => x.id === open.id);
      if (r) openReadingSheet(r);
      else gone();
      return true;
    }
    // The Work page, on the period Ask counted (lib/ask-tools.ts `work`).
    case "work":
      try {
        localStorage.setItem("athena.work.period", open.id);
      } catch {
        // Private mode: the page opens on this month.
      }
      location.hash = "#/work";
      return true;
    case "goal": {
      const g = (await loadGoals()).items.find((x) => x.id === open.id);
      if (g) openGoalSheet(g);
      else gone();
      return true;
    }
    case "asset": {
      const a = (await loadAssets()).items.find((x) => x.id === open.id);
      if (a) openAssetSheet(a);
      else gone();
      return true;
    }
    // Their pages load on their own, so their sheets do too. Each says so itself when it's archived.
    case "trip":
      await (await import("../views/trips")).openTripSheet(open.id);
      return true;
    case "purchase":
      await (await import("../views/purchases")).openPurchaseSheet(open.id);
      return true;
    default:
      return false;
  }
}
